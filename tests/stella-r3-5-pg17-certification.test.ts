import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertR3_5Pg17CertificationImageId,
  assertR3_5Pg17CertificationSourceHashes,
  collectR3_5Pg17CertificationSourceHashes,
  R3_5_PG17_CERTIFICATION_CONTAINER,
  R3_5_PG17_CERTIFICATION_IMAGE,
  R3_5_PG17_CERTIFICATION_IMAGE_ID,
  R3_5_PG17_CERTIFICATION_PACKAGE_HASHES,
  R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY,
  R3_5_PG17_CERTIFICATION_PHASES,
} from '@/db/r3-5-pg17-certification-inputs'
import { R3_4_LOCAL_PHASES } from '@/db/r3-4-governed-runner'
import * as executor from '@/scripts/stella-r3-5-pg17-certify'

const ROOT = path.resolve(process.cwd())

const EXPECTED_HASHES = {
  'stella_0002_interactions_hardening.sql': 'cbf860b12d3f32205f2e0efba7c3c1c2d9a4658bafc3ab7949d2de4089e9ec9e',
  'stella_0002b_append_only_truncate_hardening.sql': '3fda2dfd117616e09b86da45b75e6f070bcc7a857e5a1c2da752670a83ac47b5',
  'stella_0001_role_topology_bootstrap.sql': '9f21955e505e5c2a5212fabcb683f7e1e514c6665fbc8726041a1cc631e4f7b3',
  // Repinned MSC-07B.8-R9T alongside db/r3-5-pg17-certification-inputs.ts —
  // see its comment for why: the same-session probe doctrine replaced the
  // handwritten-literal INSERT-policy verifier at 1 site here and 2 in
  // stella_0004; CREATE POLICY authority is unchanged.
  'stella_0003_suggestion_decisions.sql': '33bed52967ecdd0f92bc8d5bc804136c709a5485e463167d6597fcd3602e088e',
  // Repinned MSC-07B.8-R10J: the ENTRY EXECUTE guard no longer requires
  // `service_role` already absent (substrate-granted from birth, never
  // revoked before this script — MSC-07B.8-R10I); new governed section
  // 5a-bis explicitly REVOKEs EXECUTE on the eight canonical functions
  // FROM service_role; postcondition 9.10 is unchanged and still requires
  // PUBLIC, anon and service_role all absent at the end.
  'stella_0004_role_separation.sql': '28646bff5f068b7b6676d9c03ddcd69c4d248869549425497c6514459e7d7b5a',
  'stella_0001_role_topology_bootstrap_rollback.sql': '7db648d44a93abd3bfe545b7301b436303a51d07148c69e07b1c8b1f35154f96',
  'stella_0004_rollback.sql': '22afa4cfddfe407abc6171b452659bf56d2a833663a818bfd55c6fab002f7cb6',
} as const

function readPrepared(file: string): string {
  return readFileSync(path.join(ROOT, 'db', 'prepared', file), 'utf8')
}

function readHarnessSource(): string {
  return readFileSync(path.join(ROOT, 'scripts', 'stella-r3-5-pg17-certify.ts'), 'utf8')
}

/**
 * Extracts one top-level `function <name>(...) { ... }` body by counting
 * braces, so a nested `if`/`DO $$` block's own `}` cannot truncate the match
 * early.
 *
 * MSC-07B.8-R10O hardening: the previous implementation located the function
 * with a bare `source.indexOf('function name(')`, which is satisfiable by a
 * commented-out decoy definition, a string literal containing a fake body,
 * or (picking the FIRST match) any earlier duplicate — silently binding a
 * source-based test to the wrong text instead of the real implementation.
 * This version requires the declaration keyword to actually start its own
 * source line (only leading whitespace before `function`/`export function`),
 * which a `//` line comment, a ` * ` doc-comment line, or a string/template
 * literal continuation can never do since none of those lines begin with
 * `function`/`export function` in this codebase's style — and then requires
 * EXACTLY ONE such anchored declaration in the whole file. Zero or more than
 * one is treated as ambiguous and fails closed (throws) rather than
 * guessing, so a duplicate/decoy definition can never be silently preferred
 * over — or silently substituted for — the real one.
 */
function extractFunctionSource(source: string, functionName: string): string {
  const declarationPattern = new RegExp(`^[ \\t]*(?:export\\s+)?function\\s+${functionName}\\s*\\(`, 'gm')
  const matches = Array.from(source.matchAll(declarationPattern))
  if (matches.length === 0) {
    throw new Error(`extractFunctionSource: no top-level declaration of ${functionName} found (fails closed)`)
  }
  if (matches.length > 1) {
    throw new Error(
      `extractFunctionSource: ${matches.length} top-level declarations of ${functionName} found — ambiguous, refusing to guess (fails closed)`,
    )
  }
  const match = matches[0]
  if (match === undefined || match.index === undefined) {
    throw new Error(`extractFunctionSource: internal match failure for ${functionName}`)
  }
  const start = match.index
  const bodyStart = source.indexOf('{', start)
  if (bodyStart < 0) {
    throw new Error(`extractFunctionSource: ${functionName} declaration has no opening brace (fails closed)`)
  }
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`extractFunctionSource: ${functionName} body never closes (fails closed)`)
}

/**
 * Realistic PG17 stderr fixture builder for H-02's ADMIN OPTION witness
 * (MSC-07B.8-R10M/R10N-X live wording): an ERROR line naming the denied
 * GRANT, followed by a DETAIL line explaining the missing ADMIN option.
 * Options let individual tests exercise psql line-number prefixes, a
 * harmless leading NOTICE, and CRLF line endings without duplicating the
 * two-line text at every call site.
 */
function pg17AdminOptionRefusalStderr(
  options: { readonly psqlPrefix?: boolean; readonly notice?: boolean; readonly crlf?: boolean } = {},
): string {
  const lines: string[] = []
  if (options.notice) lines.push('NOTICE:  some harmless notice unrelated to this refusal')
  const errorPrefix = options.psqlPrefix ? 'psql:<stdin>:12: ' : ''
  lines.push(`${errorPrefix}ERROR:  permission denied to grant role "uellix_owner"`)
  lines.push('DETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.')
  const text = lines.join('\n')
  return options.crlf ? text.replace(/\n/g, '\r\n') : text
}

/** The stale pre-PG16 single-line wording this harness's matcher previously (incorrectly) required — used only as a negative control proving the new matcher does NOT accept it alone. */
const PRE_PG16_ADMIN_OPTION_WORDING = 'ERROR:  must have admin option on role "uellix_owner"'

describe('MSC-07B R3.6 closed PG17 certification profile', () => {
  it('derives its fixed R8 prefix from the sole R3.4 package-order authority', () => {
    expect(R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY).toBe(R3_4_LOCAL_PHASES)
    expect(R3_5_PG17_CERTIFICATION_PHASES).toEqual(
      R3_4_LOCAL_PHASES.slice(0, R3_4_LOCAL_PHASES.findIndex((phase) => phase.file === 'stella_0004_role_separation.sql') + 1),
    )
    expect(R3_5_PG17_CERTIFICATION_PHASES.map((phase) => [phase.file, phase.identity])).toEqual([
      ['stella_0002_interactions_hardening.sql', 'admin'],
      ['stella_0002b_append_only_truncate_hardening.sql', 'admin'],
      ['stella_0001_role_topology_bootstrap.sql', 'admin'],
      ['stella_0003_suggestion_decisions.sql', 'migrator'],
      ['stella_0004_role_separation.sql', 'admin'],
    ])
    expect(Object.isFrozen(R3_5_PG17_CERTIFICATION_PHASES)).toBe(true)
  })

  // The one file the P1A successor contract authorizes to diverge from the
  // historical pin. Its bytes are a DISTINCT, successor object — see
  // classifyR3_5CertificationAgainstCurrentHead below — never claimed
  // parity with, and never used to repin, the historical constant.
  const R3_5_SUPERSEDED_FILE = 'stella_0001_role_topology_bootstrap.sql' as const
  const R3_5_KNOWN_SUCCESSOR_HASH = 'e50fe2e404c06ca181c2f517d8dfa9c2bc2f9a35def4856dedb48d6d481fcd35'

  it('pins the image and every R8 package or rollback byte before Docker can be used', () => {
    expect(R3_5_PG17_CERTIFICATION_IMAGE).toBe('public.ecr.aws/supabase/postgres:17.6.1.143')
    expect(R3_5_PG17_CERTIFICATION_IMAGE_ID).toBe(
      'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453',
    )
    // The HISTORICAL constant is unchanged and byte-correct — this is a
    // self-check on db/r3-5-pg17-certification-inputs.ts, never repinned.
    expect(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES).toEqual(EXPECTED_HASHES)

    const observed = collectR3_5Pg17CertificationSourceHashes()
    // CURRENT observed bytes diverge from the historical pin at EXACTLY the
    // one file the P1A successor contract authorizes — nowhere else. This is
    // the measured hazard SUPERSEDED classification exists to handle.
    expect(observed).not.toEqual(EXPECTED_HASHES)
    expect(observed[R3_5_SUPERSEDED_FILE]).toBe(R3_5_KNOWN_SUCCESSOR_HASH)
    expect({ ...observed, [R3_5_SUPERSEDED_FILE]: EXPECTED_HASHES[R3_5_SUPERSEDED_FILE] }).toEqual(EXPECTED_HASHES)

    // assertR3_5Pg17CertificationSourceHashes itself is UNWEAKENED: it still
    // throws on the current (diverged) observed hashes...
    expect(() => assertR3_5Pg17CertificationSourceHashes(observed)).toThrow(/sha-?256 mismatch/i)
    // ...and still passes for hashes that genuinely match the historical pin.
    expect(() => assertR3_5Pg17CertificationSourceHashes(EXPECTED_HASHES)).not.toThrow()
    expect(() => assertR3_5Pg17CertificationSourceHashes({
      ...EXPECTED_HASHES,
      'stella_0004_role_separation.sql': '0'.repeat(64),
    })).toThrow(/sha-?256 mismatch/i)
    expect(() => assertR3_5Pg17CertificationImageId('sha256:wrong')).toThrow(/image id mismatch/i)

    for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
      if (file === R3_5_SUPERSEDED_FILE) continue
      const actual = createHash('sha256')
        .update(readFileSync(path.join(ROOT, 'db', 'prepared', file)))
        .digest('hex')
      expect(actual, file).toBe(expected)
    }
  })

  it('SUPERSEDED: classifies current HEAD distinctly from PASS and from an ordinary integrity failure', () => {
    const classification = executor.classifyR3_5CertificationAgainstCurrentHead()
    expect(classification.status).toBe('SUPERSEDED')
    expect(classification.divergedFiles).toEqual([R3_5_SUPERSEDED_FILE])

    // executeFixedCertification classifies BEFORE delegating into
    // loadVerifiedR3Sources — the SUPERSEDED error is thrown directly by the
    // classification, never by the historical mismatch assertion, and never
    // by db/r3-5-pg17-certification-inputs.ts (byte-immutable, untouched).
    expect(
      () => new executor.R3_5CertificationSupersededError(classification.divergedFiles),
    ).not.toThrow()
    const error = new executor.R3_5CertificationSupersededError(classification.divergedFiles)
    expect(error.name).toBe('R3_5CertificationSupersededError')
    expect(error.message).toMatch(/SUPERSEDED/)
    expect(error.message).toMatch(/NOT a certification PASS/)
    expect(error.message).not.toMatch(/parity/i)
  })

  // Three-way classifier, every branch exercised against an OBSERVED hash
  // set the test controls — no prepared file and no historical input is
  // touched. The pure function is the same one the current-HEAD wrapper
  // delegates to.
  describe('R3.5 three-way classifier — CURRENT / SUPERSEDED / MISMATCH, each branch non-vacuous', () => {
    const SECOND_FILE = 'stella_0004_role_separation.sql' as const

    it('CURRENT: hashes identical to the historical pin (no divergence) classify CURRENT with zero diverged files', () => {
      const c = executor.classifyR3_5CertificationHashes(EXPECTED_HASHES)
      expect(c.status).toBe('CURRENT')
      expect(c.divergedFiles).toEqual([])
    })

    it('SUPERSEDED: ONLY the exact authorized stella_0001 successor hash, and nothing else, classifies SUPERSEDED', () => {
      const c = executor.classifyR3_5CertificationHashes({ ...EXPECTED_HASHES, [R3_5_SUPERSEDED_FILE]: R3_5_KNOWN_SUCCESSOR_HASH })
      expect(c.status).toBe('SUPERSEDED')
      expect(c.divergedFiles).toEqual([R3_5_SUPERSEDED_FILE])
    })

    it('MISMATCH (mutation control): the authorized divergence PLUS a second package drift is NOT SUPERSEDED — it is an ordinary integrity failure', () => {
      const c = executor.classifyR3_5CertificationHashes({
        ...EXPECTED_HASHES,
        [R3_5_SUPERSEDED_FILE]: R3_5_KNOWN_SUCCESSOR_HASH,
        [SECOND_FILE]: '0'.repeat(64),
      })
      expect(c.status).toBe('MISMATCH')
      expect(c.divergedFiles).toHaveLength(2)
      expect(c.divergedFiles).toContain(R3_5_SUPERSEDED_FILE)
      expect(c.divergedFiles).toContain(SECOND_FILE)
    })

    it('MISMATCH: stella_0001 at an UNRECOGNIZED hash (not the known successor) is NOT SUPERSEDED — no broad catch', () => {
      const c = executor.classifyR3_5CertificationHashes({ ...EXPECTED_HASHES, [R3_5_SUPERSEDED_FILE]: 'f'.repeat(64) })
      expect(c.status).toBe('MISMATCH')
      expect(c.divergedFiles).toEqual([R3_5_SUPERSEDED_FILE])
    })

    it('MISMATCH: a single non-stella_0001 drift alone is NOT SUPERSEDED', () => {
      const c = executor.classifyR3_5CertificationHashes({ ...EXPECTED_HASHES, [SECOND_FILE]: '1'.repeat(64) })
      expect(c.status).toBe('MISMATCH')
      expect(c.divergedFiles).toEqual([SECOND_FILE])
    })

    it('harness binding: executeFixedCertification special-cases ONLY SUPERSEDED; CURRENT and MISMATCH both fall through to the unweakened historical assertion', () => {
      const src = readHarnessSource()
      const fn = src.slice(src.indexOf('function executeFixedCertification('))
      const head = fn.slice(0, fn.indexOf('const sources = loadVerifiedR3Sources()'))
      expect(head).toMatch(/classification\.status === 'SUPERSEDED'/)
      expect(head).not.toMatch(/status === 'MISMATCH'/)
      expect(head).not.toMatch(/status === 'CURRENT'/)
      // The wrapper is a thin delegation — one classifier, no second logic path.
      expect(src).toMatch(/return classifyR3_5CertificationHashes\(collectR3_5Pg17CertificationSourceHashes\(\)\)/)
    })
  })

  it('SUPERSEDED classification does not mutate or read db/r3-5-pg17-certification-inputs.ts differently — it stays byte-immutable', () => {
    const beforeHashes = { ...R3_5_PG17_CERTIFICATION_PACKAGE_HASHES }
    executor.classifyR3_5CertificationAgainstCurrentHead()
    expect(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES).toEqual(beforeHashes)
    expect(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES[R3_5_SUPERSEDED_FILE]).toBe(EXPECTED_HASHES[R3_5_SUPERSEDED_FILE])
  })

  it('rejects every caller attempt to select SQL, packages, Docker, a database target, a role, or a phase', () => {
    expect(executor.parseR3_5Pg17CertificationArguments([])).toBeUndefined()

    const attacks = [
      ['--sql=SELECT 1'],
      ['--file=stella_0003_suggestion_decisions.sql'],
      ['--package=stella_0004_role_separation.sql'],
      ['--phase=decision-migrator'],
      ['--phase=0001'],
      ['--container=other-container'],
      ['--image=postgres:latest'],
      ['--database-url=postgresql://example.invalid/db'],
      ['--host=127.0.0.1'],
      ['--port=5432'],
      ['--network=bridge'],
      ['--publish=5432:5432'],
      ['--mount=type=bind,source=.,target=/repo'],
      ['--volume=/var/run/docker.sock:/var/run/docker.sock'],
      ['--role=supabase_admin'],
      ['--identity=supabase_admin'],
      ['--superuser'],
      ['--rollback-confirmation=rollback-0004:postgres'],
      ['../db/prepared/stella_0003_suggestion_decisions.sql'],
    ]

    for (const args of attacks) {
      expect(() => executor.parseR3_5Pg17CertificationArguments(args), args.join(' ')).toThrow(/does not accept arguments/i)
    }
  })

  it('registers exactly one fixed, argument-free package command', () => {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts['certify:stella:r3-5:pg17']).toBe('tsx scripts/stella-r3-5-pg17-certify.ts')
  })

  it('builds one fixed, network-isolated container plan with private container-local psql transport', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()
    const flattenedDocker = plan.docker.commands.flatMap((command) => command.args)

    expect(plan.container.name).toBe(R3_5_PG17_CERTIFICATION_CONTAINER)
    expect(plan.container.image).toBe(R3_5_PG17_CERTIFICATION_IMAGE)
    expect(plan.docker.commands.filter((command) => command.kind === 'create')).toHaveLength(1)
    expect(plan.docker.commands.find((command) => command.kind === 'create')?.args).toEqual(expect.arrayContaining([
      'run', '-d', '--name', R3_5_PG17_CERTIFICATION_CONTAINER, '--network', 'none', '--pull', 'never',
      R3_5_PG17_CERTIFICATION_IMAGE,
    ]))
    expect(plan.docker.commands.find((command) => command.kind === 'image-inspect')?.args).toEqual([
      'image', 'inspect', '--format', '{{.Id}}', R3_5_PG17_CERTIFICATION_IMAGE,
    ])
    expect(flattenedDocker).not.toContain('-p')
    expect(flattenedDocker).not.toContain('--publish')
    expect(flattenedDocker).not.toContain('--mount')
    expect(flattenedDocker).not.toContain('--volume')
    expect(flattenedDocker).not.toContain('-v')
    expect(flattenedDocker.join(' ')).not.toMatch(/docker\.sock|host\.docker\.internal|localhost|postgresql:\/\//i)
    expect(flattenedDocker).not.toContain('prune')
    expect(flattenedDocker).not.toContain('rmi')
    expect(plan.docker.commands.some((command) =>
      command.args[0] === 'image' && (command.args.includes('rm') || command.args.includes('prune')),
    )).toBe(false)
    expect(plan.docker.commands.filter((command) => command.kind === 'cleanup-remove')).toEqual([
      expect.objectContaining({ args: ['container', 'rm', '-f', R3_5_PG17_CERTIFICATION_CONTAINER] }),
    ])
    expect(plan.docker.commands.find((command) => command.kind === 'cleanup-owner-check')?.args).toEqual(expect.arrayContaining([
      'container', 'inspect', R3_5_PG17_CERTIFICATION_CONTAINER,
    ]))
    expect(plan.transport).toEqual({
      kind: 'private-container-local-psql',
      adminSession: 'postgres',
      migratorSession: 'uellix_migrator',
      migratorCurrentUser: 'uellix_owner',
      migratorRoleStatement: 'SET LOCAL ROLE uellix_owner;',
      transactionPerPhase: true,
      hostTcpFallback: false,
    })
  })

  it('applies the storage shim as the image superuser over the container-local socket, using the same closed transport as every other superuser phase', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()
    const shim = plan.storageShimTransport

    // Storage shim uses supabase_admin, distinct from the Stella-phase installer identity.
    expect(shim.role).toBe('supabase_admin')
    expect(shim.role).not.toBe(plan.transport.adminSession)
    expect(plan.transport.adminSession).toBe('postgres')

    // No -h anywhere in the shim's argv (container-local Unix socket only).
    expect(shim.args).not.toContain('-h')
    expect(shim.args.join(' ')).not.toMatch(/127\.0\.0\.1|host\.docker\.internal|postgresql:\/\//i)

    // No password requirement — no PGPASSWORD/-e in argv, and declared as such.
    expect(shim.passwordRequired).toBe(false)
    expect(shim.args).not.toContain('-e')
    expect(shim.args.join(' ')).not.toMatch(/PGPASSWORD/)
    expect(shim.hostTcpFallback).toBe(false)

    // `docker exec`, never `run`; no run-only port/mount/network surface.
    expect(shim.args[0]).toBe('exec')
    expect(shim.args).not.toContain('-p')
    expect(shim.args).not.toContain('--publish')
    expect(shim.args).not.toContain('--mount')
    expect(shim.args).not.toContain('--volume')
    expect(shim.args).not.toContain('--network')
    expect(shim.args[shim.args.indexOf('-v') + 1]).toBe('ON_ERROR_STOP=1')
    expect(shim.args).toContain(R3_5_PG17_CERTIFICATION_CONTAINER)

    // Not part of the module's exported surface — no caller can reach the shim helper directly.
    expect(Object.keys(executor)).not.toContain('applyLabSuperuserStorageShim')

    // The storage shim's transport IS the general superuser transport (same fixed argv), not a
    // second, independently-drifting definition.
    expect(shim.args).toEqual(plan.superuserTransport.args)
  })

  it('runs every superuser-required phase through one fixed, closed, no-TCP, no-password transport with no caller-reachable generic executor', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()
    const st = plan.superuserTransport

    expect(st.kind).toBe('container-local-superuser-psql')
    expect(st.role).toBe('supabase_admin')
    expect(st.args).not.toContain('-h')
    expect(st.args.join(' ')).not.toMatch(/127\.0\.0\.1|host\.docker\.internal|postgresql:\/\//i)
    expect(st.passwordRequired).toBe(false)
    expect(st.args).not.toContain('-e')
    expect(st.args.join(' ')).not.toMatch(/PGPASSWORD/)
    expect(st.hostTcpFallback).toBe(false)
    expect(st.args[0]).toBe('exec')
    expect(st.args).not.toContain('-p')
    expect(st.args).not.toContain('--publish')
    expect(st.args).not.toContain('--mount')
    expect(st.args).not.toContain('--volume')
    expect(st.args).not.toContain('--network')

    // Exactly the closed export surface — no generic SQL/role/container executor is reachable.
    expect(Object.keys(executor).sort()).toEqual([
      'R3_5CertificationSupersededError',
      'R3_5_PG17_CERTIFICATION_MATRIX_STEPS',
      'R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX',
      'assertCertifiedSubstratePreflightObserved',
      'assertPsqlRefusedWithReason',
      'certifiedSubstratePreflightQuery',
      'classifyR3_5CertificationAgainstCurrentHead',
      'classifyR3_5CertificationHashes',
      'describeR3_5Pg17CertificationPlan',
      'parseR3_5Pg17CertificationArguments',
    ])
  })

  it('fails closed before any package executes unless the live substrate is the exact certified OID-10 identity — harness-layer binding only', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()

    expect(plan.substratePreflight).toEqual({
      oid: 10,
      expectedRoleName: 'supabase_admin',
      expectedRolsuper: true,
      installerRole: 'postgres',
      installerExpectedRolsuper: false,
      installerExpectedRolcreaterole: true,
    })

    // Regression guard: this must never become the source verifyExactMembershipsAndGrantor
    // (package grantor authority) reads from — that stays the fixed OID 10 unconditionally.
    const src = readHarnessSource()
    const preflightFn = extractFunctionSource(src, 'verifyCertifiedSubstratePreflight')
    const grantorFn = extractFunctionSource(src, 'verifyExactMembershipsAndGrantor')
    expect(preflightFn.length).toBeGreaterThan(0)
    expect(grantorFn.length).toBeGreaterThan(0)
    expect(grantorFn).not.toMatch(/CERTIFIED_SUBSTRATE_OID10_ROLE_NAME/)
  })

  describe('certified substrate preflight — bound to the executable query and parser, not just the declarative plan', () => {
    const EXPECTED = { oid10RoleName: 'supabase_admin', installerRole: 'postgres' }
    const CERTIFIED_OBSERVED = ['supabase_admin', '1', '0', '1'].join('|')

    function assertObserved(observed: string): void {
      executor.assertCertifiedSubstratePreflightObserved(observed, EXPECTED)
    }

    it('accepts exactly the certified substrate facts', () => {
      expect(() => assertObserved(CERTIFIED_OBSERVED)).not.toThrow()
    })

    it('rejects the historical live-failure shape: PostgreSQL boolean::text emits true/false, not the query’s expected representation', () => {
      // This is the exact defect from the R8P live run: the query cast rolsuper/rolcreaterole
      // with `::text`, which PostgreSQL renders as 'true'/'false' — not 't'/'f' and not this
      // harness's '1'/'0' contract. Every one of these three columns must reject that spelling.
      expect(() => assertObserved(['supabase_admin', 'true', 'false', 'true'].join('|'))).toThrow(
        /certified substrate preflight/,
      )
    })

    it('rejects the t/f short form too — the contract is exactly 1/0, not any boolean spelling', () => {
      expect(() => assertObserved(['supabase_admin', 't', 'f', 't'].join('|'))).toThrow(
        /certified substrate preflight/,
      )
    })

    it('rejects OID 10 rolsuper=false', () => {
      expect(() => assertObserved(['supabase_admin', '0', '0', '1'].join('|'))).toThrow(/OID 10/)
    })

    it('rejects installer (postgres) rolsuper=true', () => {
      expect(() => assertObserved(['supabase_admin', '1', '1', '1'].join('|'))).toThrow(
        /non-superuser CREATEROLE role/,
      )
    })

    it('rejects installer (postgres) rolcreaterole=false', () => {
      expect(() => assertObserved(['supabase_admin', '1', '0', '0'].join('|'))).toThrow(
        /non-superuser CREATEROLE role/,
      )
    })

    it('rejects the wrong OID 10 role name even when every boolean is certified-shaped', () => {
      expect(() => assertObserved(['postgres', '1', '0', '1'].join('|'))).toThrow(/OID 10/)
    })

    it('rejects a missing OID 10 row (empty scalar, as psql emits for an all-NULL concatenation)', () => {
      expect(() => assertObserved('')).toThrow(/exactly 4 pipe-delimited fields/)
    })

    it('rejects a missing installer row (short, pipe-delimited but incomplete)', () => {
      expect(() => assertObserved(['supabase_admin', '1'].join('|'))).toThrow(
        /exactly 4 pipe-delimited fields/,
      )
    })

    it('rejects malformed preflight output that is not pipe-delimited at all', () => {
      expect(() => assertObserved('ERROR: relation "pg_roles" does not exist')).toThrow(
        /exactly 4 pipe-delimited fields/,
      )
    })

    // F-01 regression: MSC-07B.8-R8R found that `observed.split('|')` destructured into exactly
    // four bindings without checking length, so an observation with extra fields was silently
    // truncated instead of rejected. These cases pin exact-cardinality enforcement directly
    // against the production assertion function — not a reimplementation of the parser.
    describe('F-01: exact four-field cardinality (MSC-07B.8-R8R)', () => {
      it('rejects an extra trailing field', () => {
        expect(() => assertObserved('supabase_admin|1|0|1|EXTRA')).toThrow(
          /exactly 4 pipe-delimited fields/,
        )
      })

      it('rejects an extra leading field', () => {
        expect(() => assertObserved('EXTRA|supabase_admin|1|0|1')).toThrow(
          /exactly 4 pipe-delimited fields/,
        )
      })

      it('rejects a short observation missing the trailing field', () => {
        expect(() => assertObserved('supabase_admin|1|0')).toThrow(
          /exactly 4 pipe-delimited fields/,
        )
      })

      it('rejects multiple extra fields', () => {
        expect(() => assertObserved('supabase_admin|1|0|1|0|1')).toThrow(
          /exactly 4 pipe-delimited fields/,
        )
      })

      it('rejects empty output', () => {
        expect(() => assertObserved('')).toThrow(/exactly 4 pipe-delimited fields/)
      })

      it('rejects an extra row glued on via an embedded newline, even when it would otherwise split into exactly 4 fields', () => {
        expect(() => assertObserved('supabase_admin|1|0|1\nsupabase_admin|1|0|1')).toThrow(
          /embedded newline/,
        )
        expect(() => assertObserved('supabase_admin|1|0|1\r\nsupabase_admin|1|0|1')).toThrow(
          /embedded newline/,
        )
      })

      it('rejects a delimiter embedded inside a role-name-shaped field, which would otherwise pass as certified-looking values shifted into the wrong slots', () => {
        expect(() => assertObserved('sup|abase_admin|1|0|1')).toThrow(
          /exactly 4 pipe-delimited fields/,
        )
      })

      it('does not silently truncate: the exact certified 4-field observation still passes', () => {
        expect(() => assertObserved(CERTIFIED_OBSERVED)).not.toThrow()
      })
    })

    it('the query text itself controls the boolean representation with CASE WHEN, never a bare ::text cast — the exact class of bug this regression closes', () => {
      const sql = executor.certifiedSubstratePreflightQuery('postgres')
      expect(sql).not.toMatch(/::text/)
      expect(sql).toMatch(/CASE WHEN rolsuper THEN '1' ELSE '0' END/)
      expect(sql).toMatch(/CASE WHEN rolcreaterole THEN '1' ELSE '0' END/)
      // Exactly four pipe-joined columns (three CASE-guarded booleans plus the role name),
      // in the order the parser destructures them: rolname, OID-10 rolsuper, installer
      // rolsuper, installer rolcreaterole.
      expect(sql.match(/FROM pg_roles/g)).toHaveLength(4)
      expect(sql.match(/CASE WHEN/g)).toHaveLength(3)
      const oid10RolsuperIndex = sql.indexOf('WHERE oid = 10', sql.indexOf('CASE WHEN rolsuper'))
      const installerRolsuperIndex = sql.indexOf("WHERE rolname = 'postgres'")
      const installerRolcreateroleIndex = sql.indexOf('rolcreaterole')
      expect(oid10RolsuperIndex).toBeGreaterThan(0)
      expect(installerRolsuperIndex).toBeGreaterThan(oid10RolsuperIndex)
      expect(installerRolcreateroleIndex).toBeGreaterThan(installerRolsuperIndex)
    })

    it('the declarative plan and the executable predicate agree on every certified fact — a drifted declaration cannot go undetected', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan().substratePreflight

      // Re-derive the exact observed line the plan's OWN declared facts would produce on a
      // live substrate, then run it through the SAME assertion function production calls.
      // If someone edits the declarative plan (e.g. flips expectedRolsuper to false) without
      // also updating the executable predicate, this test fails — the two cannot silently
      // diverge the way plan.substratePreflight vs. the ::text bug once did.
      const trueFalse = (value: boolean) => (value ? '1' : '0')
      const observedFromPlan = [
        plan.expectedRoleName,
        trueFalse(plan.expectedRolsuper),
        trueFalse(plan.installerExpectedRolsuper),
        trueFalse(plan.installerExpectedRolcreaterole),
      ].join('|')
      expect(observedFromPlan).toBe(CERTIFIED_OBSERVED)
      expect(() =>
        executor.assertCertifiedSubstratePreflightObserved(observedFromPlan, {
          oid10RoleName: plan.expectedRoleName,
          installerRole: plan.installerRole,
        }),
      ).not.toThrow()

      // And the inverse of each plan fact must be rejected by the same predicate.
      expect(() =>
        executor.assertCertifiedSubstratePreflightObserved(
          [plan.expectedRoleName, trueFalse(!plan.expectedRolsuper), trueFalse(plan.installerExpectedRolsuper), trueFalse(plan.installerExpectedRolcreaterole)].join('|'),
          { oid10RoleName: plan.expectedRoleName, installerRole: plan.installerRole },
        ),
      ).toThrow()
      expect(() =>
        executor.assertCertifiedSubstratePreflightObserved(
          [plan.expectedRoleName, trueFalse(plan.expectedRolsuper), trueFalse(!plan.installerExpectedRolsuper), trueFalse(plan.installerExpectedRolcreaterole)].join('|'),
          { oid10RoleName: plan.expectedRoleName, installerRole: plan.installerRole },
        ),
      ).toThrow()
      expect(() =>
        executor.assertCertifiedSubstratePreflightObserved(
          [plan.expectedRoleName, trueFalse(plan.expectedRolsuper), trueFalse(plan.installerExpectedRolsuper), trueFalse(!plan.installerExpectedRolcreaterole)].join('|'),
          { oid10RoleName: plan.expectedRoleName, installerRole: plan.installerRole },
        ),
      ).toThrow()
    })
  })

  it('states an exact, closed per-phase identity contract — no abstract "admin" identity anywhere in it', () => {
    const matrix = executor.R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX

    expect(matrix.map((row) => row.phaseId)).toEqual([
      'STORAGE_SHIM',
      'BASELINE_50',
      '0002',
      '0002B',
      '0001',
      '0003',
      '0004',
      '0004_ROLLBACK',
      '0001_ROLLBACK_DEPENDENCY_NEGATIVE',
    ])

    const byId = Object.fromEntries(matrix.map((row) => [row.phaseId, row])) as Record<string, (typeof matrix)[number]>

    for (const phaseId of ['STORAGE_SHIM', '0001', '0004']) {
      expect(byId[phaseId]).toMatchObject({
        identity: 'supabase_admin',
        transport: 'CONTAINER_LOCAL_SOCKET',
        superuserRequired: true,
        rollbackConfirmationRequired: false,
      })
    }
    for (const phaseId of ['BASELINE_50', '0002', '0002B']) {
      expect(byId[phaseId]).toMatchObject({
        identity: 'postgres',
        transport: 'EXISTING_INSTALLER_TRANSPORT',
        superuserRequired: false,
        rollbackConfirmationRequired: false,
      })
    }
    expect(byId['0003']).toMatchObject({
      identity: 'uellix_migrator',
      transport: 'EXISTING_INSTALLER_TRANSPORT',
      superuserRequired: false,
      rollbackConfirmationRequired: false,
    })
    for (const phaseId of ['0004_ROLLBACK', '0001_ROLLBACK_DEPENDENCY_NEGATIVE']) {
      expect(byId[phaseId]).toMatchObject({
        identity: 'supabase_admin',
        transport: 'CONTAINER_LOCAL_SOCKET',
        superuserRequired: true,
        rollbackConfirmationRequired: true,
      })
    }

    // No caller can alter this matrix.
    expect(Object.isFrozen(matrix)).toBe(true)
    for (const row of matrix) expect(Object.isFrozen(row)).toBe(true)
    expect(() => (matrix as unknown[]).push({})).toThrow()
    expect(() => {
      ;(byId.STORAGE_SHIM as { identity: string }).identity = 'postgres'
    }).toThrow()
  })

  it('derives phaseTransactions from the same closed superuser-file set the live executor dispatches on — 0001/0004 now run as supabase_admin, 0002/0002b/0003 unchanged', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()

    expect(plan.phaseTransactions).toEqual([
      ['stella_0002_interactions_hardening.sql', 'postgres', 'postgres', null, 'EXISTING_INSTALLER_TRANSPORT'],
      ['stella_0002b_append_only_truncate_hardening.sql', 'postgres', 'postgres', null, 'EXISTING_INSTALLER_TRANSPORT'],
      ['stella_0001_role_topology_bootstrap.sql', 'supabase_admin', 'supabase_admin', null, 'CONTAINER_LOCAL_SOCKET'],
      ['stella_0003_suggestion_decisions.sql', 'uellix_migrator', 'uellix_owner', 'SET LOCAL ROLE uellix_owner;', 'EXISTING_INSTALLER_TRANSPORT'],
      ['stella_0004_role_separation.sql', 'supabase_admin', 'supabase_admin', null, 'CONTAINER_LOCAL_SOCKET'],
    ])

    // Every row in phaseTransactions must be consistent with the phase identity matrix.
    const matrixByFileSuffix = new Map(
      executor.R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX.map((row) => [row.phaseId, row]),
    )
    const fileToPhaseId: Record<string, string> = {
      'stella_0002_interactions_hardening.sql': '0002',
      'stella_0002b_append_only_truncate_hardening.sql': '0002B',
      'stella_0001_role_topology_bootstrap.sql': '0001',
      'stella_0003_suggestion_decisions.sql': '0003',
      'stella_0004_role_separation.sql': '0004',
    }
    for (const [file, session] of plan.phaseTransactions) {
      const row = matrixByFileSuffix.get(fileToPhaseId[file] as never)
      expect(row, file).toBeDefined()
      expect(session).toBe(row!.identity)
    }
  })

  it('binds both governed rollback phases to the exact, non-caller-selectable, transaction-local confirmation contract read from the frozen packages', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()
    const rollback0004 = readPrepared('stella_0004_rollback.sql')
    const rollback0001 = readPrepared('stella_0001_role_topology_bootstrap_rollback.sql')

    expect(rollback0004).toMatch(/current_setting\('uellix\.rollback_confirmation', true\)/)
    expect(rollback0001).toMatch(/current_setting\('uellix\.rollback_confirmation', true\)/)

    const c4 = plan.rollbackContracts['0004_rollback']
    expect(c4.role).toBe('supabase_admin')
    expect(c4.transport).toBe('CONTAINER_LOCAL_SOCKET')
    expect(c4.confirmationSetting).toBe('uellix.rollback_confirmation')
    expect(c4.transactionLocal).toBe(true)
    expect(c4.callerSelectableConfirmationText).toBe(false)
    expect(c4.confirmationValueExpression).toBe("'rollback-0004:' || current_database()")
    expect(rollback0004.replace(/\s+/g, '')).toMatch(/'rollback-0004:'\|\|current_database\(\)/)

    const c1 = plan.rollbackContracts['0001_rollback_dependency_negative']
    expect(c1.role).toBe('supabase_admin')
    expect(c1.transport).toBe('CONTAINER_LOCAL_SOCKET')
    expect(c1.confirmationSetting).toBe('uellix.rollback_confirmation')
    expect(c1.transactionLocal).toBe(true)
    expect(c1.callerSelectableConfirmationText).toBe(false)
    expect(c1.confirmationValueExpression).toBe("'rollback-0001:' || current_database()")
    expect(c1.genericFailureAccepted).toBe(false)
    expect(rollback0001.replace(/\s+/g, '')).toMatch(/'rollback-0001:'\|\|current_database\(\)/)
  })

  it('targets the exact, stable dependency-guard failure text raised by the frozen stella_0001 rollback package — never a generic non-zero exit', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()
    const rollback0001 = readPrepared('stella_0001_role_topology_bootstrap_rollback.sql')
    const pattern = new RegExp(plan.rollbackContracts['0001_rollback_dependency_negative'].expectedFailurePattern)

    // The pattern must actually be present in the frozen package's RAISE EXCEPTION text.
    expect(pattern.test(rollback0001)).toBe(true)
    expect(rollback0001).toMatch(
      /RAISE EXCEPTION 'stella_0001 rollback REFUSED: surviving relation\(s\) depend on governed ownership: %'/,
    )

    // The pattern must NOT accept an unrelated / generic psql failure as a pass.
    expect(pattern.test('psql:<stdin>:1: ERROR:  syntax error at or near "SELECT"')).toBe(false)
    expect(pattern.test('ERROR:  permission denied for schema public')).toBe(false)
    expect(pattern.test('stella_0001 rollback REFUSED: governed role(s) already absent: uellix_owner')).toBe(false)

    expect(plan.rollbackContracts['0001_rollback_dependency_negative'].genericFailureAccepted).toBe(false)
  })

  it('compares grantor authority by the fixed bootstrap-superuser OID 10 in the live verifier, never by a resolved role name', () => {
    const src = readHarnessSource()
    const fn = extractFunctionSource(src, 'verifyExactMembershipsAndGrantor')
    expect(fn.length).toBeGreaterThan(0)

    // The pass/fail comparison query is the part before the diagnostic-only branch — `grantor_name`
    // is deliberately allowed in the diagnostic string_agg below that (display only, never compared).
    const comparisonQuery = fn.slice(0, fn.indexOf("if (exactRows !== 't')"))

    expect(comparisonQuery).toMatch(/expected\(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option\)/)
    expect(comparisonQuery).toMatch(/\('uellix_migrator', 'uellix_owner', 10::oid, false, true, false\)/)
    expect(comparisonQuery).toMatch(/\('uellix_app', 'uellix_writer', 10::oid, true, false, false\)/)
    expect(comparisonQuery).toMatch(/\('postgres', 'uellix_writer', 10::oid, true, false, false\)/)
    expect(comparisonQuery).toMatch(/a\.grantor AS grantor_oid/)

    // Regression guard: the defect this replaces compared grantor by the literal role name 'postgres'.
    expect(comparisonQuery).not.toMatch(/grantor_name/)
    expect(comparisonQuery).not.toMatch(/'postgres',\s*false,\s*true,\s*false/)
    expect(comparisonQuery).not.toMatch(/'postgres',\s*true,\s*false,\s*false\)\s*,?\s*$/m)
  })

  it('routes 0003 exclusively through the migrator/SET LOCAL ROLE transport — never the superuser transport', () => {
    const row = executor.R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX.find((r) => r.phaseId === '0003')
    expect(row?.identity).toBe('uellix_migrator')
    expect(row?.transport).toBe('EXISTING_INSTALLER_TRANSPORT')
    expect(row?.superuserRequired).toBe(false)

    const plan = executor.describeR3_5Pg17CertificationPlan()
    const decisionRow = plan.phaseTransactions.find(([file]) => file === 'stella_0003_suggestion_decisions.sql')
    expect(decisionRow).toEqual([
      'stella_0003_suggestion_decisions.sql',
      'uellix_migrator',
      'uellix_owner',
      'SET LOCAL ROLE uellix_owner;',
      'EXISTING_INSTALLER_TRANSPORT',
    ])
  })

  it('preserves the postgres installer SET ROLE owner negative control', () => {
    expect(readHarnessSource()).toMatch(/admin SET ROLE owner negative attack/)
  })

  it('contains the whole fixed R8 matrix, now including the certified-substrate preflight step, and exposes exactly its closed static surface', () => {
    expect(executor.R3_5_PG17_CERTIFICATION_MATRIX_STEPS).toEqual([
      'certified-substrate-preflight',
      'pg17-supabase-surface',
      'storage-shim',
      'baseline-50',
      'stella-0001-topology',
      'stella-0003-migrator-owner',
      'stella-0004-separation',
      'exact-memberships-and-grantor',
      'set-and-admin-negative-attacks',
      'rls',
      'append-only',
      'idempotence',
      'atomicity',
      'stella-0004-rollback',
      'stella-0001-rollback',
      'cleanup',
    ])
    expect(Object.keys(executor).sort()).toEqual([
      'R3_5CertificationSupersededError',
      'R3_5_PG17_CERTIFICATION_MATRIX_STEPS',
      'R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX',
      'assertCertifiedSubstratePreflightObserved',
      'assertPsqlRefusedWithReason',
      'certifiedSubstratePreflightQuery',
      'classifyR3_5CertificationAgainstCurrentHead',
      'classifyR3_5CertificationHashes',
      'describeR3_5Pg17CertificationPlan',
      'parseR3_5Pg17CertificationArguments',
    ])
  })

  describe('atomicity witness — the injected 0003 failure must be reason-specific, never a generic non-zero exit (MSC-07B.8-R9E)', () => {
    function dockerResult(status: number, stderr: string) {
      return { status, stdout: '', stderr }
    }

    it('declares the exact injected-failure contract, sourced from the same regex the live executor enforces', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const contract = plan.atomicityContract

      expect(contract.injectedStatement).toBe('SELECT 1 / 0;')
      expect(contract.genericFailureAccepted).toBe(false)
      expect(contract.expectedFailureSqlstate).toBe('22012')

      const pattern = new RegExp(contract.expectedFailurePattern)
      // Narrow, stable matcher — not a bare "ERROR" / non-zero-exit catch-all.
      expect(contract.expectedFailurePattern).not.toBe('ERROR')
      expect(contract.expectedFailurePattern.length).toBeGreaterThan('ERROR'.length)
      expect(pattern.test('psql:<stdin>:405: ERROR:  division by zero')).toBe(true)
    })

    it('verifyAtomicity no longer relies on the generic refusal helper for the injected 0003 failure — it requires the reason-specific one (T1, T8)', () => {
      const src = readHarnessSource()
      const fn = extractFunctionSource(src, 'verifyAtomicity')
      expect(fn.length).toBeGreaterThan(0)

      // T8: reuses the canonical reason-aware helper already used by the 0001 rollback
      // dependency guard — no duplicate refusal helper was introduced for this.
      expect(fn).toMatch(/assertPsqlRefusedWithReason\(/)
      // T1: the plain, reason-blind refusal check is gone from this function.
      expect(fn).not.toMatch(/assertPsqlRefused\(/)
      // T2: the reason is pinned via the named pattern, not inlined or invented ad hoc.
      expect(fn).toMatch(/ATOMICITY_INJECTED_FAILURE_PATTERN/)

      // T7: the table-absence rollback proof remains, and remains AFTER the
      // reason-specific refusal — this is not a replacement for atomicity, only an addition.
      const refusalIndex = fn.indexOf('assertPsqlRefusedWithReason(')
      const rollbackIndex = fn.indexOf("to_regclass('public.stella_suggestion_decisions')")
      expect(refusalIndex).toBeGreaterThan(-1)
      expect(rollbackIndex).toBeGreaterThan(refusalIndex)

      // T9: the injected statement and the real decisionSource concatenation are unchanged —
      // this remediation only changes how the refusal is *verified*, not what runs.
      expect(fn).toMatch(/\$\{decisionSource\}\\nSELECT 1 \/ 0;/)
    })

    it('only one production assertion function implements reason-matching — no parallel test-only parser was introduced, and the reason-blind helper is gone (MSC-07B.8-R9O)', () => {
      const src = readHarnessSource()
      const definedFunctionNames = Array.from(src.matchAll(/^(?:export )?function (\w+)\(/gm)).map((m) => m[1])
      const refusalHelpers = definedFunctionNames.filter((name) => /Refus/i.test(name))
      // R9O removed the last three call sites of the reason-blind assertPsqlRefused (the two
      // uellix_app negatives, the admin negative, and the append-only witness), leaving it
      // unused — so it was deleted rather than left as dead code.
      expect(refusalHelpers.sort()).toEqual(['assertPsqlRefusedWithReason'])
      expect(src).not.toMatch(/function assertPsqlRefused\(/)
    })

    describe('reason-specific refusal matcher, exercised against the real exported production assertion with in-memory simulated process results', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.atomicityContract.expectedFailurePattern)

      function assertAtomicityWitness(result: { status: number; stdout: string; stderr: string }) {
        executor.assertPsqlRefusedWithReason(result, '0003 injected failure', pattern)
      }

      it('CASE 1 — accepts a refusal for the exact injected division-by-zero reason', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(1, 'psql:<stdin>:406: ERROR:  division by zero')),
        ).not.toThrow()
      })

      it('CASE 2 — rejects the historical R8Y false-green: permission denied for table organizations (42501)', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(1, 'psql:<stdin>:405: ERROR:  permission denied for table organizations')),
        ).toThrow(/expected dependency-guard reason|not for the expected/i)
      })

      it('CASE 3 — rejects a missing-relation failure', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(1, 'psql:<stdin>:12: ERROR:  relation "does_not_exist" does not exist')),
        ).toThrow()
      })

      it('CASE 4 — rejects a syntax-error failure', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(1, 'psql:<stdin>:1: ERROR:  syntax error at or near "SELECT"')),
        ).toThrow()
      })

      it('CASE 4b — rejects an RLS-policy refusal', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(1, 'ERROR:  new row violates row-level security policy for table "stella_suggestion_decisions"')),
        ).toThrow()
      })

      it('CASE 4c — rejects an ownership/grant refusal', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(1, 'ERROR:  must be owner of table stella_suggestion_decisions')),
        ).toThrow()
      })

      it('CASE 5 — rejects a zero (successful) exit even if stderr happens to contain the reason text', () => {
        expect(() =>
          assertAtomicityWitness(dockerResult(0, 'division by zero')),
        ).toThrow(/expected PostgreSQL refusal/i)
      })

      it('CASE 6 — rejects a non-zero exit with empty stderr', () => {
        expect(() => assertAtomicityWitness(dockerResult(1, ''))).toThrow()
      })

      it('rejects a bare "ERROR" match attempt and a merely-broad regex — the contract itself is narrow, not just this one instance', () => {
        expect(() => assertAtomicityWitness(dockerResult(1, 'ERROR:  something else entirely'))).toThrow()
        expect(/^ERROR$/.test(plan.atomicityContract.expectedFailurePattern)).toBe(false)
      })

      it('regression (Part J): the exact R8Y 42501 failure text is rejected, and the deliberate 22012 injected failure is accepted', () => {
        const r8y = dockerResult(1, 'psql:<stdin>:405:\nERROR: permission denied for table organizations')
        expect(() => assertAtomicityWitness(r8y)).toThrow()

        const injected = dockerResult(1, 'psql:<stdin>:406: ERROR:  division by zero')
        expect(() => assertAtomicityWitness(injected)).not.toThrow()
      })
    })
  })

  /** Every `.sql` file under `dir`, recursively — used to prove the absence of an inbound FK, not just its absence from one hand-picked file. */
  function collectSqlFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) files.push(...collectSqlFiles(full))
      else if (entry.isFile() && entry.name.endsWith('.sql')) files.push(full)
    }
    return files
  }

  describe('H-01: append-only TRUNCATE witness — reason-aware, non-shadowed target (MSC-07B.8-R9O)', () => {
    it('H01-T1/T2/T3: the old shadowed stella_interactions witness is gone; the new witness targets audit_logs as uellix_migrator/SET LOCAL ROLE uellix_owner', () => {
      const src = readHarnessSource()
      const fn = extractFunctionSource(src, 'verifyAppendOnly')
      expect(fn.length).toBeGreaterThan(0)

      // T1: old shadowed target/executor gone.
      expect(fn).not.toMatch(/stella_interactions/)
      expect(fn).not.toMatch(/runContainerPsql\(\s*ADMIN_ROLE/)

      // T2/T3: exact selected target and executor.
      expect(fn).toMatch(/APPEND_ONLY_TRUNCATE_WITNESS_TARGET/)
      expect(fn).toMatch(/MIGRATOR_ROLE/)
      expect(fn).toMatch(/migratorIdentitySql\(/)

      const plan = executor.describeR3_5Pg17CertificationPlan()
      expect(plan.appendOnlyContract.target).toBe('public.audit_logs')
      expect(plan.appendOnlyContract.executor).toBe('uellix_migrator')
      expect(plan.appendOnlyContract.effectiveRole).toBe('uellix_owner')
      expect(plan.appendOnlyContract.roleStatement).toBe('SET LOCAL ROLE uellix_owner;')
      expect(plan.appendOnlyContract.statement).toBe('TRUNCATE TABLE public.audit_logs;')
      expect(plan.appendOnlyContract.genericFailureAccepted).toBe(false)
    })

    it('H01-T4: the witness requires the exact trigger-function reason pattern, read from public.uellix_forbid_mutation()\'s own RAISE EXCEPTION text', () => {
      const immutability = readFileSync(path.join(ROOT, 'db', 'migrations', '0030_immutability.sql'), 'utf8')
      expect(immutability).toMatch(/RAISE EXCEPTION 'append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME/)

      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.appendOnlyContract.expectedFailurePattern)
      expect(pattern.test('psql:<stdin>:12: ERROR:  append-only: TRUNCATE on audit_logs is not permitted')).toBe(true)
      // Narrow, not a bare "ERROR" / "append-only" catch-all.
      expect(plan.appendOnlyContract.expectedFailurePattern).not.toBe('ERROR')
      expect(plan.appendOnlyContract.expectedFailurePattern).not.toBe('append-only')
    })

    it('H01-T5: no table anywhere under db/ holds a foreign key referencing audit_logs — the FK shadow this remediation exists to avoid (and stella_suggestion_decisions DOES reference the old, shadowed target)', () => {
      const fkReferencesAuditLogs = /REFERENCES\s+(?:public\.)?audit_logs\s*\(/i
      const sqlFiles = collectSqlFiles(path.join(ROOT, 'db'))
      expect(sqlFiles.length).toBeGreaterThan(50)

      const offenders = sqlFiles.filter((file) => fkReferencesAuditLogs.test(readFileSync(file, 'utf8')))
      expect(offenders).toEqual([])

      // Regression control: prove this scan actually finds a real FK when one exists, by
      // confirming it against the DOCUMENTED shadow on the OLD target.
      const decisions = readPrepared('stella_0003_suggestion_decisions.sql')
      expect(decisions).toMatch(/REFERENCES public\.stella_interactions\(id\)/)
      expect(/REFERENCES\s+(?:public\.)?stella_interactions\s*\(/i.test(decisions)).toBe(true)
    })

    it('H01-T6/T7/T8: an ACL, FK, or connection-failure refusal cannot satisfy the witness', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.appendOnlyContract.expectedFailurePattern)

      // T6: generic ACL "permission denied"
      expect(pattern.test('ERROR:  permission denied for table audit_logs')).toBe(false)
      // T5 (FK): the exact shadow the old stella_interactions target suffered from.
      expect(pattern.test('ERROR:  cannot truncate a table referenced in a foreign key constraint')).toBe(false)
      // T7: connection failure
      expect(pattern.test('psql: error: connection to server was lost')).toBe(false)
      expect(pattern.test('psql: error: connection refused')).toBe(false)
    })

    it('H01-T8b/T9: a syntax error cannot pass, but the exact intended trigger error does', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.appendOnlyContract.expectedFailurePattern)

      expect(pattern.test('psql:<stdin>:1: ERROR:  syntax error at or near "TRUNCATE"')).toBe(false)
      expect(pattern.test('ERROR:  relation "does_not_exist" does not exist')).toBe(false)
      expect(pattern.test('psql:<stdin>:9: ERROR:  append-only: TRUNCATE on audit_logs is not permitted')).toBe(true)
    })

    it('H01-T9b: a wrong-table or wrong-operation trigger reason (same function, different call site) does not satisfy this witness', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.appendOnlyContract.expectedFailurePattern)

      // Same message shape, wrong table — must not be confused with a different protected table.
      expect(pattern.test('ERROR:  append-only: TRUNCATE on stella_interactions is not permitted')).toBe(false)
      expect(pattern.test('ERROR:  append-only: TRUNCATE on sroi_calculation_runs is not permitted')).toBe(false)
      // Same table, wrong operation — must not be confused with the row-level UPDATE/DELETE trigger.
      expect(pattern.test('ERROR:  append-only: UPDATE on audit_logs is not permitted')).toBe(false)
      expect(pattern.test('ERROR:  append-only: DELETE on audit_logs is not permitted')).toBe(false)
    })

    it('H01-T10: broadening the matcher to a bare "ERROR" or "append-only" would defeat the whole point — the contract must never regress to that', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      expect(/^ERROR$/.test(plan.appendOnlyContract.expectedFailurePattern)).toBe(false)
      expect(/^append-only$/.test(plan.appendOnlyContract.expectedFailurePattern)).toBe(false)
      expect(plan.appendOnlyContract.expectedFailurePattern).toContain('audit_logs')
      expect(plan.appendOnlyContract.expectedFailurePattern).toContain('TRUNCATE')
    })
  })

  describe('H-02: uellix_app positive session control + reason-aware SET ROLE / ADMIN OPTION negatives (MSC-07B.8-R9O)', () => {
    it('H02-T1: a positive uellix_app identity control exists and runs before both app negatives', () => {
      const src = readHarnessSource()
      const orderIndex = (needle: string) => src.indexOf(needle)

      const executeFn = extractFunctionSource(src, 'executeFixedCertification')
      const positiveCall = orderIndex('verifyAppPositiveIdentityControl(appPassword)')
      const setRoleCall = orderIndex('verifyAppSetRoleNegative(appPassword)')
      const adminOptionCall = orderIndex('verifyAppAdminOptionNegative(appPassword)')

      expect(executeFn).toMatch(/verifyAppPositiveIdentityControl\(appPassword\)/)
      expect(positiveCall).toBeGreaterThan(-1)
      expect(setRoleCall).toBeGreaterThan(positiveCall)
      expect(adminOptionCall).toBeGreaterThan(positiveCall)
    })

    it('H02-T2/T3: the positive control requires psql exit success AND the exact uellix_app identity — declared via the plan contract', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      expect(plan.appPositiveIdentityControl.role).toBe('uellix_app')
      expect(plan.appPositiveIdentityControl.query).toBe('SELECT current_user;')
      expect(plan.appPositiveIdentityControl.expectedIdentity).toBe('uellix_app')

      const fn = extractFunctionSource(readHarnessSource(), 'verifyAppPositiveIdentityControl')
      expect(fn).toMatch(/scalarQuery\(/)
      expect(fn).toMatch(/APP_ROLE/)
      expect(fn).toMatch(/observed !== APP_ROLE/)
    })

    it('H02-T4/T5: the positive control does not merely check exit success — it compares the observed identity exactly', () => {
      // scalarQuery (which the positive control calls) itself throws on any non-zero exit
      // (auth failure, connection failure) via assertPsqlSuccess before the identity comparison
      // ever runs, and the comparison is a strict `!==`, not a substring/includes check — so
      // neither an auth failure nor a wrong current_user (e.g. "postgres") can satisfy it.
      const fn = extractFunctionSource(readHarnessSource(), 'verifyAppPositiveIdentityControl')
      expect(fn).not.toMatch(/\.includes\(/)
      expect(fn).not.toMatch(/status\s*===\s*0/)
      const scalarQueryFn = extractFunctionSource(readHarnessSource(), 'scalarQuery')
      expect(scalarQueryFn).toMatch(/assertPsqlSuccess\(/)
    })

    it('H02-T6/T7/T8/T9: app SET ROLE negative accepts only the exact SET ROLE authority-denial text', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.negativeAuthorityContracts.appSetRoleOwner.expectedFailurePattern)

      expect(plan.negativeAuthorityContracts.appSetRoleOwner.role).toBe('uellix_app')
      expect(plan.negativeAuthorityContracts.appSetRoleOwner.statement).toBe('SET ROLE uellix_owner;')
      expect(plan.negativeAuthorityContracts.appSetRoleOwner.genericFailureAccepted).toBe(false)

      // T6: the correct reason passes.
      expect(pattern.test('ERROR:  permission denied to set role "uellix_owner"')).toBe(true)
      // T7: generic nonzero / unrelated permission error cannot pass.
      expect(pattern.test('ERROR:  permission denied for table audit_logs')).toBe(false)
      expect(pattern.test('ERROR:  syntax error at or near "SET"')).toBe(false)
      // T8: connection failure cannot pass.
      expect(pattern.test('psql: error: connection to server was lost')).toBe(false)
      // T9: unrelated permission failure / wrong role name cannot pass.
      expect(pattern.test('ERROR:  permission denied to set role "uellix_writer"')).toBe(false)
      expect(pattern.test('ERROR:  role "uellix_owner" does not exist')).toBe(false)
      expect(pattern.test('psql: error: password authentication failed for user "uellix_app"')).toBe(false)
    })

    it('H02-T10/T11/T12: app ADMIN OPTION negative accepts only the exact admin-option authority-denial text', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.negativeAuthorityContracts.appAdminOptionOwner.expectedFailurePattern)

      expect(plan.negativeAuthorityContracts.appAdminOptionOwner.role).toBe('uellix_app')
      expect(plan.negativeAuthorityContracts.appAdminOptionOwner.statement).toBe(
        'GRANT uellix_owner TO uellix_app WITH ADMIN OPTION;',
      )

      // T10: correct reason passes — the live PG17 two-line ERROR+DETAIL wording
      // (MSC-07B.8-R10M/R10N-X), not the stale pre-PG16 single-line text.
      expect(pattern.test(pg17AdminOptionRefusalStderr())).toBe(true)
      expect(pattern.test(pg17AdminOptionRefusalStderr({ psqlPrefix: true }))).toBe(true)
      expect(pattern.test(pg17AdminOptionRefusalStderr({ notice: true }))).toBe(true)
      expect(pattern.test(pg17AdminOptionRefusalStderr({ crlf: true }))).toBe(true)
      // The stale pre-PG16 single-line wording alone must NOT satisfy the PG17 matcher.
      expect(pattern.test(PRE_PG16_ADMIN_OPTION_WORDING)).toBe(false)
      // T11: generic nonzero cannot pass.
      expect(pattern.test('ERROR:  permission denied for table audit_logs')).toBe(false)
      // T12: wrong-authority error (SET ROLE text, not GRANT/ADMIN OPTION text) cannot pass.
      expect(pattern.test('ERROR:  permission denied to set role "uellix_owner"')).toBe(false)
      expect(pattern.test('ERROR:  role "uellix_app" is not permitted to log in')).toBe(false)
    })

    it('no credential value is ever logged, printed, or embedded in the positive control or either negative', () => {
      const src = readHarnessSource()
      const positiveFn = extractFunctionSource(src, 'verifyAppPositiveIdentityControl')
      const setRoleFn = extractFunctionSource(src, 'verifyAppSetRoleNegative')
      const adminOptionFn = extractFunctionSource(src, 'verifyAppAdminOptionNegative')
      for (const fn of [positiveFn, setRoleFn, adminOptionFn]) {
        expect(fn).not.toMatch(/console\.(log|error|warn|info)/)
        expect(fn).not.toMatch(/DATABASE_URL|postgresql:\/\//)
      }
    })
  })

  describe('M-01: admin/postgres SET ROLE owner negative — reason-aware, resolved (not assumed) identity (MSC-07B.8-R9O)', () => {
    it('M01-T1/T2: the exact negative statement and executor identity are pinned — resolved from ADMIN_ROLE, never an assumed abstract "admin"', () => {
      const fn = extractFunctionSource(readHarnessSource(), 'verifyAdminSetRoleNegative')
      expect(fn.length).toBeGreaterThan(0)
      expect(fn).toMatch(/runContainerPsql\(ADMIN_ROLE, postgresPassword, `SET ROLE \$\{OWNER_ROLE\};`\)/)

      const plan = executor.describeR3_5Pg17CertificationPlan()
      expect(plan.negativeAuthorityContracts.adminSetRoleOwner.role).toBe('postgres')
      expect(plan.negativeAuthorityContracts.adminSetRoleOwner.statement).toBe('SET ROLE uellix_owner;')
      // ADMIN_ROLE ('postgres') is confirmed non-superuser and not a member of uellix_owner by
      // the substrate preflight and the exact membership matrix elsewhere in this file — so the
      // resolved executor is legitimately expected to be refused (not an inconsistent assumption).
      expect(plan.substratePreflight.installerExpectedRolsuper).toBe(false)
    })

    it('M01-T3: the expected authority-refusal reason is pinned to PostgreSQL\'s own fixed SET ROLE message', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      expect(plan.negativeAuthorityContracts.adminSetRoleOwner.expectedFailurePattern).toBe(
        plan.negativeAuthorityContracts.appSetRoleOwner.expectedFailurePattern,
      )
      expect(plan.negativeAuthorityContracts.adminSetRoleOwner.genericFailureAccepted).toBe(false)
    })

    it('M01-T4/T5/T6: generic nonzero, connection/auth failure, and unrelated permission errors are all rejected', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.negativeAuthorityContracts.adminSetRoleOwner.expectedFailurePattern)

      expect(pattern.test('ERROR:  permission denied for table audit_logs')).toBe(false)
      expect(pattern.test('psql: error: connection refused')).toBe(false)
      expect(pattern.test('psql: error: password authentication failed for user "postgres"')).toBe(false)
      expect(pattern.test('ERROR:  role "uellix_owner" does not exist')).toBe(false)
    })

    it('M01-T7: the correct reason is accepted', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.negativeAuthorityContracts.adminSetRoleOwner.expectedFailurePattern)
      expect(pattern.test('ERROR:  permission denied to set role "uellix_owner"')).toBe(true)
    })
  })

  describe('Helper behavior matrix — every reason-aware witness touched by R9O accepts only its own exact reason, exercised against the real exported production assertion (Section T)', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()

    const witnesses: Array<{ readonly name: string; readonly pattern: RegExp; readonly acceptedText: string }> = [
      {
        name: 'append-only TRUNCATE (H-01)',
        pattern: new RegExp(plan.appendOnlyContract.expectedFailurePattern),
        acceptedText: 'ERROR:  append-only: TRUNCATE on audit_logs is not permitted',
      },
      {
        name: 'app SET ROLE (H-02)',
        pattern: new RegExp(plan.negativeAuthorityContracts.appSetRoleOwner.expectedFailurePattern),
        acceptedText: 'ERROR:  permission denied to set role "uellix_owner"',
      },
      {
        name: 'app ADMIN OPTION (H-02)',
        pattern: new RegExp(plan.negativeAuthorityContracts.appAdminOptionOwner.expectedFailurePattern),
        acceptedText: pg17AdminOptionRefusalStderr(),
      },
      {
        name: 'admin SET ROLE (M-01)',
        pattern: new RegExp(plan.negativeAuthorityContracts.adminSetRoleOwner.expectedFailurePattern),
        acceptedText: 'ERROR:  permission denied to set role "uellix_owner"',
      },
    ]

    const attackShapes: Array<{ readonly label: string; readonly status: number; readonly stderr: string; readonly acceptedOnly: boolean }> = [
      { label: 'exit 0 + expected text (never a pass, even if stderr happens to contain it)', status: 0, stderr: '', acceptedOnly: false },
      { label: 'exit nonzero + wrong text', status: 1, stderr: 'ERROR:  something else entirely', acceptedOnly: false },
      { label: 'exit nonzero + empty stderr', status: 1, stderr: '', acceptedOnly: false },
      { label: 'connection refused', status: 1, stderr: 'psql: error: connection to server at "127.0.0.1" failed: Connection refused', acceptedOnly: false },
      { label: 'authentication failed', status: 1, stderr: 'psql: error: connection to server failed: FATAL:  password authentication failed for user "x"', acceptedOnly: false },
      { label: 'syntax error', status: 1, stderr: 'ERROR:  syntax error at or near "SELECT"', acceptedOnly: false },
      { label: 'missing relation', status: 1, stderr: 'ERROR:  relation "does_not_exist" does not exist', acceptedOnly: false },
      { label: 'missing role', status: 1, stderr: 'ERROR:  role "uellix_ghost" does not exist', acceptedOnly: false },
      { label: 'generic permission denied', status: 1, stderr: 'ERROR:  permission denied for table audit_logs', acceptedOnly: false },
    ]

    for (const witness of witnesses) {
      describe(witness.name, () => {
        it('accepts exactly its own reason', () => {
          expect(() =>
            executor.assertPsqlRefusedWithReason({ status: 1, stdout: '', stderr: witness.acceptedText }, witness.name, witness.pattern),
          ).not.toThrow()
        })

        for (const attack of attackShapes) {
          it(`rejects: ${attack.label}`, () => {
            expect(() =>
              executor.assertPsqlRefusedWithReason(
                { status: attack.status, stdout: '', stderr: attack.stderr },
                witness.name,
                witness.pattern,
              ),
            ).toThrow()
          })
        }
      })
    }
  })

  describe('HIGH-2 atomicity witness is unregressed by the R9O harness remediation', () => {
    it('the atomicity contract and pattern are unchanged from before this remediation', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      expect(plan.atomicityContract.injectedStatement).toBe('SELECT 1 / 0;')
      expect(plan.atomicityContract.expectedFailureSqlstate).toBe('22012')
      expect(plan.atomicityContract.expectedFailurePattern).toBe('division by zero')
      expect(plan.atomicityContract.genericFailureAccepted).toBe(false)
    })
  })

  describe('transport, phase order, and package freeze non-regression (MSC-07B.8-R9O Sections N/O/Y)', () => {
    it('no Docker invocation mechanism, credential handling, or phase order changed — only assertion/target logic', () => {
      const src = readHarnessSource()
      // The three remediated call sites still use runContainerPsql / runSuperuserPsql — no new
      // transport function, no shell interpolation of a password into a command string.
      expect(src).toMatch(/function runContainerPsql\(/)
      expect(src).toMatch(/function runSuperuserPsql\(/)
      expect(src).not.toMatch(/execSync\(/) // only execFileSync is used anywhere in this file
      expect(src.match(/function runDocker\(/g)).toHaveLength(1)
    })

    it('R3_5_PG17_CERTIFICATION_MATRIX_STEPS order is unchanged', () => {
      expect(executor.R3_5_PG17_CERTIFICATION_MATRIX_STEPS).toEqual([
        'certified-substrate-preflight',
        'pg17-supabase-surface',
        'storage-shim',
        'baseline-50',
        'stella-0001-topology',
        'stella-0003-migrator-owner',
        'stella-0004-separation',
        'exact-memberships-and-grantor',
        'set-and-admin-negative-attacks',
        'rls',
        'append-only',
        'idempotence',
        'atomicity',
        'stella-0004-rollback',
        'stella-0001-rollback',
        'cleanup',
      ])
    })

    it('the seven governed SQL package hashes are unchanged by this harness-only remediation', () => {
      // stella_0001_role_topology_bootstrap.sql is excluded here: its bytes
      // changed under the SEPARATE, authorized P1A successor contract — see
      // R3_5_SUPERSEDED_FILE above — not by this harness-only remediation,
      // which this test's title and the other six packages still hold to
      // exactly.
      for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
        if (file === R3_5_SUPERSEDED_FILE) continue
        const actual = createHash('sha256').update(readFileSync(path.join(ROOT, 'db', 'prepared', file))).digest('hex')
        expect(actual, file).toBe(expected)
      }
    })
  })

  describe('MSC-07B.8-R10O: PG17 H02 ADMIN matcher — reason-aware, adversarially sound; downstream call-order/body bindings hardened', () => {
    it('the ADMIN OPTION pattern binds both the ERROR denial and the DETAIL reason, spanning a newline, never the stale pre-PG16 single-line wording', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const source = plan.negativeAuthorityContracts.appAdminOptionOwner.expectedFailurePattern
      expect(source).toContain('permission denied to grant role "uellix_owner"')
      expect(source).toContain('Only roles with the ADMIN option on role "uellix_owner" may grant this role')
      expect(source).toContain('[\\s\\S]*')
      expect(source).not.toBe('must have admin option on role "uellix_owner"')
    })

    describe('Section H/V: negative + positive matcher matrix — >=32 DB-free cases against the actual candidate matcher', () => {
      const plan = executor.describeR3_5Pg17CertificationPlan()
      const pattern = new RegExp(plan.negativeAuthorityContracts.appAdminOptionOwner.expectedFailurePattern)

      const negativeCases: ReadonlyArray<readonly [string, string]> = [
        ['1. old pre-PG16 wording only', PRE_PG16_ADMIN_OPTION_WORDING],
        [
          '2. wrong target role: uellix_writer',
          'ERROR:  permission denied to grant role "uellix_writer"\nDETAIL:  Only roles with the ADMIN option on role "uellix_writer" may grant this role.',
        ],
        [
          '3. wrong target role: uellix_app',
          'ERROR:  permission denied to grant role "uellix_app"\nDETAIL:  Only roles with the ADMIN option on role "uellix_app" may grant this role.',
        ],
        ['4. ERROR line only, missing DETAIL', 'ERROR:  permission denied to grant role "uellix_owner"'],
        [
          '5. DETAIL line only, missing ERROR',
          'DETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
        ],
        ['6. generic permission denied', 'ERROR:  permission denied'],
        ['7. SET ROLE denial', 'ERROR:  permission denied to set role "uellix_owner"'],
        [
          '8. CREATEROLE variant DETAIL',
          'ERROR:  permission denied to grant role "uellix_owner"\nDETAIL:  Only roles with the CREATEROLE attribute may grant this role.',
        ],
        ['9. permission denied to relation', 'ERROR:  permission denied for relation audit_logs'],
        ['10. permission denied to function', 'ERROR:  permission denied for function uellix_forbid_mutation'],
        ['11. permission denied to schema', 'ERROR:  permission denied for schema public'],
        ['12. syntax error', 'ERROR:  syntax error at or near "GRANT"'],
        ['13. role does not exist', 'ERROR:  role "uellix_owner" does not exist'],
        ['14. database does not exist', 'psql: error: FATAL:  database "postgres" does not exist'],
        ['15. connection refused', 'psql: error: connection to server at "127.0.0.1" failed: Connection refused'],
        [
          '16. authentication failure',
          'psql: error: connection to server failed: FATAL:  password authentication failed for user "uellix_app"',
        ],
        ['17. timeout', 'psql: error: connection to server timed out'],
        ['18. successful GRANT output', 'GRANT ROLE'],
        ['19. uellix_owner text with no ADMIN OPTION reason', 'ERROR:  role "uellix_owner" is reserved'],
        [
          '20. ADMIN OPTION over another role (uellix_auditor)',
          'ERROR:  permission denied to grant role "uellix_auditor"\nDETAIL:  Only roles with the ADMIN option on role "uellix_auditor" may grant this role.',
        ],
      ]

      it.each(negativeCases as unknown as [string, string][])('rejects: %s', (_label, text) => {
        expect(pattern.test(text)).toBe(false)
      })

      const positiveControls: ReadonlyArray<readonly [string, string]> = [
        ['exact R10M live stderr', pg17AdminOptionRefusalStderr()],
        ['with psql line-number prefix noise', pg17AdminOptionRefusalStderr({ psqlPrefix: true })],
        ['CRLF line endings', pg17AdminOptionRefusalStderr({ crlf: true })],
        ['harmless NOTICE before ERROR', pg17AdminOptionRefusalStderr({ notice: true })],
      ]

      it.each(positiveControls as unknown as [string, string][])('accepts: %s', (_label, text) => {
        expect(pattern.test(text)).toBe(true)
      })

      const extraCases: ReadonlyArray<{ readonly label: string; readonly text: string; readonly expected: boolean }> = [
        {
          label: 'DETAIL appears before ERROR (reversed order) must NOT match',
          text:
            'DETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.\nERROR:  permission denied to grant role "uellix_owner"',
          expected: false,
        },
        {
          label: 'multiple blank lines between ERROR and DETAIL still matches',
          text: 'ERROR:  permission denied to grant role "uellix_owner"\n\n\n\nDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
          expected: true,
        },
        {
          label: 'extra tabs/whitespace around DETAIL still matches',
          text: 'ERROR:  permission denied to grant role "uellix_owner"\n\t\tDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
          expected: true,
        },
        {
          label: 'lowercase error/detail prefixes still match (prefixes are not part of the bound anchors)',
          text: 'error:  permission denied to grant role "uellix_owner"\ndetail:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
          expected: true,
        },
        {
          label: 'garbled/ANSI noise prefix before ERROR still matches',
          text: '[31mnoise[0m\nERROR:  permission denied to grant role "uellix_owner"\nDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
          expected: true,
        },
        {
          label: 'large volume of unrelated noise between ERROR and DETAIL still matches',
          text: `ERROR:  permission denied to grant role "uellix_owner"\n${'x'.repeat(2000)}\nDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.`,
          expected: true,
        },
        {
          label: 'DETAIL names the wrong role while ERROR is correct (mixed) must NOT match',
          text: 'ERROR:  permission denied to grant role "uellix_owner"\nDETAIL:  Only roles with the ADMIN option on role "uellix_writer" may grant this role.',
          expected: false,
        },
        {
          label: 'ERROR names the wrong role while DETAIL is correct (mixed) must NOT match',
          text: 'ERROR:  permission denied to grant role "uellix_writer"\nDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
          expected: false,
        },
        {
          label: 'DETAIL truncated before "may grant this role" must NOT match',
          text: 'ERROR:  permission denied to grant role "uellix_owner"\nDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may gr',
          expected: false,
        },
        {
          label: 'ERROR truncated before the closing quote of the role name must NOT match',
          text: 'ERROR:  permission denied to grant role "uellix_own\nDETAIL:  Only roles with the ADMIN option on role "uellix_owner" may grant this role.',
          expected: false,
        },
      ]

      for (const c of extraCases) {
        it(`${c.expected ? 'accepts' : 'rejects'}: ${c.label}`, () => {
          expect(pattern.test(c.text)).toBe(c.expected)
        })
      }

      it('summary: zero false positives across the negative matrix, zero false negatives across the positive/extra matrix', () => {
        const falsePositives = negativeCases.filter(([, text]) => pattern.test(text)).length
        const falseNegatives =
          positiveControls.filter(([, text]) => !pattern.test(text)).length +
          extraCases.filter((c) => c.expected !== pattern.test(c.text)).length
        expect(falsePositives).toBe(0)
        expect(falseNegatives).toBe(0)
        expect(negativeCases.length + positiveControls.length + extraCases.length).toBeGreaterThanOrEqual(32)
      })
    })

    describe('Section I: reason-awareness bindings — each witness passes its OWN named pattern constant to assertPsqlRefusedWithReason', () => {
      const src = readHarnessSource()

      const bindings: ReadonlyArray<{ readonly fnName: string; readonly patternConstant: string }> = [
        { fnName: 'verifyAppSetRoleNegative', patternConstant: 'SET_ROLE_OWNER_DENIED_PATTERN' },
        { fnName: 'verifyAppAdminOptionNegative', patternConstant: 'ADMIN_OPTION_OWNER_DENIED_PATTERN' },
        { fnName: 'verifyAdminSetRoleNegative', patternConstant: 'SET_ROLE_OWNER_DENIED_PATTERN' },
        { fnName: 'verifyAppendOnly', patternConstant: 'APPEND_ONLY_TRUNCATE_WITNESS_REASON_PATTERN' },
        { fnName: 'verifyAtomicity', patternConstant: 'ATOMICITY_INJECTED_FAILURE_PATTERN' },
      ]

      for (const { fnName, patternConstant } of bindings) {
        it(`${fnName} calls assertPsqlRefusedWithReason with the named ${patternConstant} constant — never a local shadow, inline literal, or generic check`, () => {
          const fn = extractFunctionSource(src, fnName)
          expect(fn).toMatch(/assertPsqlRefusedWithReason\(/)
          expect(fn).toContain(patternConstant)
          expect(fn).not.toMatch(new RegExp(`const ${patternConstant}\\s*=`))
          expect(fn).not.toMatch(/status\s*!==\s*0/)
        })
      }

      it('M01 and H02 SET ROLE witnesses deliberately share the SAME pattern object (M-01 is not a re-derivation)', () => {
        const setRoleFn = extractFunctionSource(src, 'verifyAppSetRoleNegative')
        const adminSetRoleFn = extractFunctionSource(src, 'verifyAdminSetRoleNegative')
        expect(setRoleFn).toContain('SET_ROLE_OWNER_DENIED_PATTERN')
        expect(adminSetRoleFn).toContain('SET_ROLE_OWNER_DENIED_PATTERN')
      })
    })

    describe('Section J: extractFunctionSource fails closed against comment/string decoys, duplicates, and ambiguous matches', () => {
      it('COMMENT_FUNCTION_DECOY_REJECTED: commented-out decoy definitions preceding the real one do not shadow it', () => {
        const decoySource = [
          '// function verifyRls(postgresPassword) { return "decoy" }',
          '/**',
          ' * function verifyRls(postgresPassword) { return "decoy2" }',
          ' */',
          'function verifyRls(postgresPassword) {',
          '  return "real"',
          '}',
        ].join('\n')
        expect(extractFunctionSource(decoySource, 'verifyRls')).toContain('return "real"')
      })

      it('STRING_FUNCTION_DECOY_REJECTED: a template-literal line containing a fake body is not silently preferred — it is treated as an ambiguous second match and fails closed', () => {
        const decoySource = [
          'const decoy = `',
          'function verifyRls(postgresPassword) { return "decoy" }',
          '`',
          'function verifyRls(postgresPassword) {',
          '  return "real"',
          '}',
        ].join('\n')
        expect(() => extractFunctionSource(decoySource, 'verifyRls')).toThrow(/ambiguous/i)
      })

      it('DUPLICATE_FUNCTION_SOURCE_DETECTED: two genuine top-level declarations of the same name are refused rather than silently picking the first', () => {
        const duplicateSource = [
          'function verifyRls(postgresPassword) {',
          '  return "first"',
          '}',
          'function verifyRls(postgresPassword) {',
          '  return "second"',
          '}',
        ].join('\n')
        expect(() => extractFunctionSource(duplicateSource, 'verifyRls')).toThrow(/ambiguous/i)
      })

      it('SOURCE_EXTRACTION_FAILS_CLOSED: a missing declaration throws rather than returning an empty string a caller could mistake for "found, but empty"', () => {
        expect(() => extractFunctionSource('const x = 1;', 'verifyRls')).toThrow(/no top-level declaration/i)
      })

      it('AMBIGUOUS_INDEXOF_REMOVED_OR_GUARDED: extraction against the real harness source is unambiguous for every function this suite binds', () => {
        const src = readHarnessSource()
        const names = [
          'verifyRls',
          'verifyIdempotence',
          'verifyRollbacks',
          'verifyAppendOnly',
          'verifyAtomicity',
          'verifyAppSetRoleNegative',
          'verifyAppAdminOptionNegative',
          'verifyAdminSetRoleNegative',
          'executeFixedCertification',
          'applyR3CertificationPhases',
          'applyCertificationPhase',
        ]
        for (const name of names) {
          expect(() => extractFunctionSource(src, name), name).not.toThrow()
        }
      })
    })

    describe('Section K: executeFixedCertification call order is source-bound end-to-end', () => {
      const REQUIRED_ORDER: readonly string[] = [
        'verifyCertifiedSubstratePreflight(',
        'verifyPg17SupabaseSurface(',
        'applyLabSuperuserStorageShim(',
        'applyBaseline(',
        'applyCertificationPhase(firstAdmin',
        'applyCertificationPhase(secondAdmin',
        'applyCertificationPhase(topology',
        'provisionFixedLogin(MIGRATOR_ROLE',
        'provisionFixedLogin(APP_ROLE',
        'verifyAtomicity(',
        'applyCertificationPhase(decision',
        'applyCertificationPhase(separation',
        'verifyExactMembershipsAndGrantor(',
        'verifyAppPositiveIdentityControl(',
        'verifyAppSetRoleNegative(',
        'verifyAppAdminOptionNegative(',
        'verifyAdminSetRoleNegative(',
        'verifyRls(',
        'verifyAppendOnly(',
        'verifyIdempotence(',
        'verifyRollbacks(',
      ]

      function orderedIndices(text: string, markers: readonly string[]): number[] {
        const indices: number[] = []
        let cursor = 0
        for (const marker of markers) {
          const idx = text.indexOf(marker, cursor)
          if (idx < 0) throw new Error(`missing required call in order: ${marker}`)
          indices.push(idx)
          cursor = idx + marker.length
        }
        return indices
      }

      it('the real executeFixedCertification body contains every required call, strictly in the specified order', () => {
        const fn = extractFunctionSource(readHarnessSource(), 'executeFixedCertification')
        const indices = orderedIndices(fn, REQUIRED_ORDER)
        expect(indices).toHaveLength(REQUIRED_ORDER.length)
        for (let i = 1; i < indices.length; i += 1) {
          expect(indices[i]).toBeGreaterThan(indices[i - 1] as number)
        }
      })

      it('cleanup runs inside a finally block, guarded on `created`, after every required call above', () => {
        const fn = extractFunctionSource(readHarnessSource(), 'executeFixedCertification')
        const finallyIndex = fn.indexOf('} finally {')
        expect(finallyIndex).toBeGreaterThan(-1)
        expect(fn.slice(finallyIndex)).toMatch(/if \(created\) cleanupOwnedCertificationContainer\(\)/)
        const indices = orderedIndices(fn, REQUIRED_ORDER)
        expect(finallyIndex).toBeGreaterThan(indices.at(-1) as number)
      })

      describe('adversarial (A01-A10, A17-A20, A28-A34): orderedIndices() correctly refuses common mutations of the real body', () => {
        const REAL_BODY = extractFunctionSource(readHarnessSource(), 'executeFixedCertification')

        it('A01-A06: deleting any single required call is detected', () => {
          for (const marker of [
            'verifyAppAdminOptionNegative(',
            'verifyAdminSetRoleNegative(',
            'verifyRls(',
            'verifyAppendOnly(',
            'verifyIdempotence(',
            'verifyRollbacks(',
          ]) {
            const mutated = REAL_BODY.replace(marker, '/* removed */')
            expect(mutated, marker).not.toBe(REAL_BODY)
            expect(() => orderedIndices(mutated, REQUIRED_ORDER), marker).toThrow()
          }
        })

        it('A07-A09: reordering two required calls is detected', () => {
          const mutated = REAL_BODY
            .replace('verifyRls(postgresPassword)', '__RLS_PLACEHOLDER__')
            .replace('verifyAppendOnly(migratorPassword)', 'verifyRls(postgresPassword)')
            .replace('__RLS_PLACEHOLDER__', 'verifyAppendOnly(migratorPassword)')
          expect(mutated).not.toBe(REAL_BODY)
          expect(() => orderedIndices(mutated, REQUIRED_ORDER)).toThrow()
        })

        it('A17-A20: replacing a required call with a generic status check is detected (the required marker text disappears)', () => {
          const mutated = REAL_BODY.replace('verifyAppAdminOptionNegative(appPassword)', 'if (status !== 0) throw new Error()')
          expect(mutated).not.toBe(REAL_BODY)
          expect(() => orderedIndices(mutated, REQUIRED_ORDER)).toThrow()
        })
      })
    })

    describe('Section L: verifyRls body binding — frozen current semantics', () => {
      it('targets the exact catalog expression, compares the scalar strictly to the \'t\' literal, and never accepts \'true\' or a bare truthy check', () => {
        const fn = extractFunctionSource(readHarnessSource(), 'verifyRls')
        expect(fn).toMatch(/relrowsecurity FROM pg_class WHERE oid = 'public\.stella_suggestion_decisions'::regclass/)
        expect(fn).toMatch(/rls !== 't'/)
        expect(fn).not.toMatch(/'true'/)
        expect(fn).not.toMatch(/if \(rls\)/)
        expect(fn).not.toMatch(/Boolean\(rls\)/)
        expect(fn).toMatch(/scalarAdminQuery\(/)
        expect(fn).toMatch(/throw new Error/)
      })

      it('adversarial (A25-A27): a mutant accepting \'true\' instead of \'t\', or dropping the failure branch, diverges from this exact binding', () => {
        const real = extractFunctionSource(readHarnessSource(), 'verifyRls')

        const trueLiteralMutant = real.replace("rls !== 't'", "rls !== 'true'")
        expect(trueLiteralMutant).not.toBe(real)
        expect(trueLiteralMutant).not.toMatch(/rls !== 't'/)

        const droppedFailureMutant = real.replace(/if \(rls !== 't'\) throw new Error\(`\$\{MATRIX_ERROR\} at decision RLS`\)/, '/* dropped */')
        expect(droppedFailureMutant).not.toBe(real)
        expect(droppedFailureMutant).not.toMatch(/throw new Error/)
      })
    })

    describe('Section M: verifyIdempotence dispatches the exact five governed reapply phases, in order, through the single dispatcher', () => {
      it('verifyIdempotence delegates to applyR3CertificationPhases with the same arguments it received — no independent reapply path', () => {
        const fn = extractFunctionSource(readHarnessSource(), 'verifyIdempotence')
        expect(fn).toMatch(/applyR3CertificationPhases\(sources, postgresPassword, migratorPassword\)/)
      })

      it('applyR3CertificationPhases iterates R3_5_PG17_CERTIFICATION_PHASES through the single applyCertificationPhase dispatcher — no phase-specific shortcut', () => {
        const fn = extractFunctionSource(readHarnessSource(), 'applyR3CertificationPhases')
        expect(fn).toMatch(/for \(const phase of R3_5_PG17_CERTIFICATION_PHASES\)/)
        expect(fn).toMatch(/applyCertificationPhase\(phase, sources, postgresPassword, migratorPassword\)/)
      })

      it('the five governed phases are exactly 0002, 0002b, 0001, 0003, 0004 in that order', () => {
        expect(R3_5_PG17_CERTIFICATION_PHASES.map((phase) => phase.file)).toEqual([
          'stella_0002_interactions_hardening.sql',
          'stella_0002b_append_only_truncate_hardening.sql',
          'stella_0001_role_topology_bootstrap.sql',
          'stella_0003_suggestion_decisions.sql',
          'stella_0004_role_separation.sql',
        ])
      })

      it('adversarial (A28-A34): omitting a phase, or duplicating one while dropping another, is detectable against this exact five-file list', () => {
        const files = R3_5_PG17_CERTIFICATION_PHASES.map((phase) => phase.file)
        const omittedOne = files.filter((f) => f !== 'stella_0004_role_separation.sql')
        expect(omittedOne).toHaveLength(4)

        const duplicatedWhileOmitting = [files[0], files[0], files[2], files[3]]
        expect(new Set(duplicatedWhileOmitting).size).toBeLessThan(files.length)
        expect(duplicatedWhileOmitting).not.toContain('stella_0004_role_separation.sql')

        const identityMatrix = executor.R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX
        const topologyRow = identityMatrix.find((row) => row.phaseId === '0001')
        expect(topologyRow?.transport).toBe('CONTAINER_LOCAL_SOCKET')
      })
    })

    describe('Section N: verifyRollbacks body/sequence binding — 0004 rollback -> 0004 reapply -> 0001 rollback REQUIRED refusal', () => {
      const REAL = extractFunctionSource(readHarnessSource(), 'verifyRollbacks')

      it('the required calls appear, strictly in order, using the frozen GUC tokens and the named dependency-guard pattern, with no swallowed refusal', () => {
        const rollback0004Index = REAL.indexOf('stella_0004_rollback.sql')
        const reapplyIndex = REAL.indexOf('stella_0004_role_separation.sql')
        const refusalIndex = REAL.indexOf('assertPsqlRefusedWithReason(')
        const rollback0001Index = REAL.indexOf('stella_0001_role_topology_bootstrap_rollback.sql')
        const guardPatternIndex = REAL.indexOf('DEPENDENCY_GUARD_FAILURE_PATTERN')

        expect(rollback0004Index).toBeGreaterThan(-1)
        expect(reapplyIndex).toBeGreaterThan(rollback0004Index)
        expect(refusalIndex).toBeGreaterThan(reapplyIndex)
        expect(rollback0001Index).toBeGreaterThan(reapplyIndex)
        expect(guardPatternIndex).toBeGreaterThan(refusalIndex)

        expect(REAL).toMatch(/'rollback-0004'/)
        expect(REAL).toMatch(/'rollback-0001'/)
        expect(REAL).not.toMatch(/try\s*{/)
        expect(REAL).not.toMatch(/\.catch\(/)
      })

      it('adversarial (A35-A40): removing the 0004 rollback call, the reapply call, or the dependency-guard pattern is detectable against the real body', () => {
        const removedRollback0004 = REAL.replace(/applySuperuserRollbackPhase\([^\n]*\n/, '')
        expect(removedRollback0004).not.toBe(REAL)
        expect(removedRollback0004).not.toMatch(/stella_0004_rollback\.sql/)

        const removedReapply = REAL.replace(/applySuperuserPhase\([^\n]*\n/, '')
        expect(removedReapply).not.toBe(REAL)
        expect(removedReapply).not.toMatch(/stella_0004_role_separation\.sql.*rollback reapply/)

        const removedGuardPattern = REAL.replace('DEPENDENCY_GUARD_FAILURE_PATTERN', '/* removed */')
        expect(removedGuardPattern).not.toBe(REAL)
        expect(removedGuardPattern).not.toMatch(/DEPENDENCY_GUARD_FAILURE_PATTERN/)

        const removedRefusalWrapper = REAL.replace(/assertPsqlRefusedWithReason\(\r?\n/, '')
        expect(removedRefusalWrapper).not.toBe(REAL)
      })
    })

    describe('Section O: rollback SQL static binding (TEST ONLY) — owner-restore sets and postconditions derived from the governed source', () => {
      const rollback0004 = readPrepared('stella_0004_rollback.sql')
      const rollback0001 = readPrepared('stella_0001_role_topology_bootstrap_rollback.sql')

      function extractOwnerRestoreTargets(sql: string, kind: 'TABLE' | 'FUNCTION'): string[] {
        const pattern =
          kind === 'TABLE'
            ? /ALTER TABLE public\.(\w+) OWNER TO postgres;/g
            : /ALTER FUNCTION public\.([\w.]+\([^)]*\)) OWNER TO postgres;/g
        return Array.from(sql.matchAll(pattern)).map((m) => m[1] as string)
      }

      it('restores exactly the 38 governed tables and 8 governed functions to postgres ownership, bound bidirectionally against the governed source', () => {
        const tables = extractOwnerRestoreTargets(rollback0004, 'TABLE')
        const functions = extractOwnerRestoreTargets(rollback0004, 'FUNCTION')

        expect(tables).toHaveLength(38)
        expect(functions).toHaveLength(8)
        expect(new Set(tables).size).toBe(38)
        expect(new Set(functions).size).toBe(8)

        expect(rollback0004).toMatch(/relkind IN \('r','p'\)\) <> 38/)
        expect(rollback0004).toMatch(/proowner <> 'postgres'::regrole/)
      })

      it('§5 required postconditions remain present: role topology intact, all tables/functions back to postgres, structural 38/105/10 fingerprint unbroken', () => {
        expect(rollback0004).toMatch(/uellix_app, uellix_auditor, uellix_migrator, uellix_owner, uellix_writer/)
        expect(rollback0004).toMatch(/table\(s\) not returned to postgres/)
        expect(rollback0004).toMatch(/function\(s\) not returned to postgres/)
        expect(rollback0004).toMatch(/structural drift — post-0003 38\/105\/10 fingerprint broken/)
      })

      it('adversarial (A41-A44): a rollback fixture that silently drops or adds a restore target diverges from the derived count this binding enforces', () => {
        const tables = extractOwnerRestoreTargets(rollback0004, 'TABLE')
        expect(tables.slice(0, -1)).toHaveLength(37)
        expect([...tables, 'a_39th_table']).toHaveLength(39)

        const functions = extractOwnerRestoreTargets(rollback0004, 'FUNCTION')
        expect(functions.slice(0, -1)).toHaveLength(7)
        expect([...functions, 'a_9th_function()']).toHaveLength(9)
      })

      it('binds the 0001 rollback dependency-guard predicate to the actual five governed role casts in its relation-ownership scan, not merely the canonical error text', () => {
        const guardBlock = rollback0001.slice(
          rollback0001.indexOf('-- Ownership is never guessed or reassigned'),
          rollback0001.indexOf(
            "RAISE EXCEPTION 'stella_0001 rollback REFUSED: surviving relation(s) depend on governed ownership",
          ),
        )
        expect(guardBlock.length).toBeGreaterThan(0)
        for (const role of ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor']) {
          expect(guardBlock).toContain(`'${role}'::regrole`)
        }
        expect(guardBlock).toMatch(/c\.relowner IN \(/)
      })

      it('adversarial (A45-A46): stubbing the guard predicate to always-true, or removing one of the three IN(...) role-scans, is detectable', () => {
        const stubbed = rollback0001.replace(/c\.relowner IN \([^)]*\)/, 'TRUE')
        expect(stubbed).not.toBe(rollback0001)
        expect(stubbed).not.toContain("c.relowner IN ('uellix_owner'::regrole")

        const predicateMarkers = ['c.relowner IN (', 'p.proowner IN (', 'n.nspowner IN (']
        expect(predicateMarkers.filter((m) => rollback0001.includes(m))).toHaveLength(3)
        const withOneRemoved = rollback0001.split('n.nspowner IN (').join('/* removed */')
        expect(predicateMarkers.filter((m) => withOneRemoved.includes(m))).toHaveLength(2)
      })
    })

    describe('Section P: do-not-reopen regression bindings — this two-file batch cannot alter any frozen SQL byte', () => {
      it('0003, 0004, and the 0004 rollback package bytes are unchanged by this harness-only remediation', () => {
        for (const file of [
          'stella_0003_suggestion_decisions.sql',
          'stella_0004_role_separation.sql',
          'stella_0004_rollback.sql',
        ] as const) {
          const actual = createHash('sha256').update(readFileSync(path.join(ROOT, 'db', 'prepared', file))).digest('hex')
          expect(actual, file).toBe(EXPECTED_HASHES[file])
        }
      })
    })

    describe('Section W: coordinated-mutation and anchor-laundering controls (A47-A48)', () => {
      it('A47: the tested pattern is derived live from the executor\'s own exported plan, never a hardcoded duplicate that could silently drift from a coordinated source+test mutation', () => {
        const plan = executor.describeR3_5Pg17CertificationPlan()
        const liveSource = readHarnessSource()
        const declared = liveSource.match(
          /const ADMIN_OPTION_OWNER_DENIED_PATTERN =[\s\S]*?(\/permission denied[\s\S]*?may grant this role\/)/,
        )
        expect(declared).not.toBeNull()
        const constantRegexSource = (declared as RegExpMatchArray)[1]!.slice(1, -1)
        expect(plan.negativeAuthorityContracts.appAdminOptionOwner.expectedFailurePattern).toBe(constantRegexSource)
      })

      it('A48: anchor bindings are verified against the executable regex object\'s actual matching behavior, not a text search for anchor substrings anywhere in the file — a decoy comment elsewhere cannot influence this', () => {
        const plan = executor.describeR3_5Pg17CertificationPlan()
        const pattern = new RegExp(plan.negativeAuthorityContracts.appAdminOptionOwner.expectedFailurePattern)
        expect(pattern.test('ERROR:  connection refused')).toBe(false)
        expect(pattern.source).toContain('permission denied to grant role "uellix_owner"')
        expect(pattern.source).toContain('Only roles with the ADMIN option on role "uellix_owner" may grant this role')
      })
    })
  })
})
