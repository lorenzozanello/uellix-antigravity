import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  'stella_0002_interactions_hardening.sql': 'bdf5f8dc925b3ed5643262f83efc52ea2d11233f5fae05f1e948b8cf424858cd',
  'stella_0002b_append_only_truncate_hardening.sql': '781e8b58fe2f512c4214016421199c853f9ed840fde0f27f701ddf247aace550',
  'stella_0001_role_topology_bootstrap.sql': '3f7fcfe862fb689d2b2ff96d8c7ae4a75fc7304df825eac1cbf813ee13d3512b',
  'stella_0003_suggestion_decisions.sql': '353925466c7c88210d5cae0705450af6aae7d582227d28c8f0aa63874c3af974',
  'stella_0004_role_separation.sql': '3436925c44f3e5185391ba975b9c60d743df3ce33d5efcb4e531ced4f07285cd',
  'stella_0001_role_topology_bootstrap_rollback.sql': 'f2c3b59e2e37515ad85ee7f93f8ada8e34666a363c40746b2624a11f5ede7e9e',
  'stella_0004_rollback.sql': '22afa4cfddfe407abc6171b452659bf56d2a833663a818bfd55c6fab002f7cb6',
} as const

function readPrepared(file: string): string {
  return readFileSync(path.join(ROOT, 'db', 'prepared', file), 'utf8')
}

function readHarnessSource(): string {
  return readFileSync(path.join(ROOT, 'scripts', 'stella-r3-5-pg17-certify.ts'), 'utf8')
}

/** Extracts one top-level `function <name>(...) { ... }` body by counting braces, so a nested `if`/`DO $$` block's own `}` cannot truncate the match early. */
function extractFunctionSource(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}(`)
  if (start < 0) return ''
  const bodyStart = source.indexOf('{', start)
  if (bodyStart < 0) return ''
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

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

  it('pins the image and every R8 package or rollback byte before Docker can be used', () => {
    expect(R3_5_PG17_CERTIFICATION_IMAGE).toBe('public.ecr.aws/supabase/postgres:17.6.1.143')
    expect(R3_5_PG17_CERTIFICATION_IMAGE_ID).toBe(
      'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453',
    )
    expect(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES).toEqual(EXPECTED_HASHES)

    const observed = collectR3_5Pg17CertificationSourceHashes()
    expect(observed).toEqual(EXPECTED_HASHES)
    expect(() => assertR3_5Pg17CertificationSourceHashes(observed)).not.toThrow()
    expect(() => assertR3_5Pg17CertificationSourceHashes({
      ...observed,
      'stella_0004_role_separation.sql': '0'.repeat(64),
    })).toThrow(/sha-?256 mismatch/i)
    expect(() => assertR3_5Pg17CertificationImageId('sha256:wrong')).toThrow(/image id mismatch/i)

    for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
      const actual = createHash('sha256')
        .update(readFileSync(path.join(ROOT, 'db', 'prepared', file)))
        .digest('hex')
      expect(actual, file).toBe(expected)
    }
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
      'R3_5_PG17_CERTIFICATION_MATRIX_STEPS',
      'R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX',
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
      'R3_5_PG17_CERTIFICATION_MATRIX_STEPS',
      'R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX',
      'describeR3_5Pg17CertificationPlan',
      'parseR3_5Pg17CertificationArguments',
    ])
  })
})
