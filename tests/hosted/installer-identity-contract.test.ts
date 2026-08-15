// tests/hosted/installer-identity-contract.test.ts
// COMMIT 5.6 — the execution identity of the governed chain, as a contract
// rather than as a sentence in a runbook.
//
// ---------------------------------------------------------------------------
// THE FINDING
// ---------------------------------------------------------------------------
// T1 died in staging a second time, and not from artefact selection: the plan
// named the governed file, `artefact:verify` passed, and psql still returned
//
//   ERROR:  permission denied to set role "uellix_cap_grounding"
//
// from a connection measured at `session_user = current_user = postgres`.
//
// Every gate that existed passed because every gate that existed measured the
// TARGET. `validateHostedPrechainAuthorityContract` asks whether
// `uellix_migrator` exists, can log in, holds CREATEROLE and can become the
// owner — and on the failed attempt all four were true. Nothing had ever asked
// who was holding the connection.
//
// ---------------------------------------------------------------------------
// WHAT IS PINNED HERE
// ---------------------------------------------------------------------------
// 1. There is ONE installer contract and the verifier reads it, rather than a
//    fourth transcription of the string `uellix_migrator`.
// 2. The bytes on disk agree with it — the assertion is made against the
//    governed artefacts themselves, not against the generator that wrote them.
// 3. The probe is read-only, and the guard writes nothing either.
// 4. There is no route — flag, env var, or CLI path — that reaches a governed
//    chain write without it.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import {
  BOOTSTRAP_ADMIN_LOGIN,
  CERTIFIED_CHAIN_INSTALLER,
  CERTIFIED_CHAIN_OWNER,
  INSTALLER_IDENTITY_SCHEMA,
  InstallerIdentityRefusal,
  buildInstallerIdentityGuardSql,
  buildInstallerIdentitySql,
  parseInstallerIdentity,
  verifyInstallerIdentity,
  type ObservedInstallerIdentity,
} from '@/db/hosted/authority/certification/installer-identity'
import { HOSTED_INSTALLER, OWNER } from '@/db/hosted/authority/certification/prechain-authority-gate'
import { GOVERNED_INSTALLER } from '@/db/hosted/authority/governed-generator'
import { AUTHORITY_ROLE_REGISTRY } from '@/db/hosted/authority/role-registry'
import { gateInstallerIdentity } from '@/db/hosted/chain-operator'

const ROOT = process.cwd()
const A = 'att_' + 'a'.repeat(32)
const GOVERNED_DIR = 'db/prepared/hosted/governed'

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

const CERTIFIED: ObservedInstallerIdentity = {
  sessionUser: CERTIFIED_CHAIN_INSTALLER,
  currentUser: CERTIFIED_CHAIN_INSTALLER,
  canLogin: true,
  createRole: true,
  isSuper: false,
  canSetOwner: true,
}

const doc = (over: Partial<ObservedInstallerIdentity> = {}, attemptId = A): string =>
  JSON.stringify({
    schema: INSTALLER_IDENTITY_SCHEMA,
    attemptId,
    identity: { ...CERTIFIED, ...over },
  })

/* -------------------------------------------------------------------------- */
/* One contract, not four spellings                                            */
/* -------------------------------------------------------------------------- */

describe('the installer identity is a single contract', () => {
  it('is derived from the authority role registry, which declares exactly one', () => {
    const installers = AUTHORITY_ROLE_REGISTRY.filter((r) => r.kind === 'installer')
    expect(installers).toHaveLength(1)
    expect(CERTIFIED_CHAIN_INSTALLER).toBe(installers[0]?.id)
  })

  it('agrees with the constant the generator wrote the bytes with', () => {
    // GOVERNED_INSTALLER is what `pnpm authority:generate` interpolated into
    // every `GRANT ... TO <installer>`. If the verifier's expectation ever
    // drifted from it, the gate would pass while the artefact named somebody
    // else — a fail-OPEN, and the worst possible direction for this defect.
    expect(CERTIFIED_CHAIN_INSTALLER).toBe(GOVERNED_INSTALLER)
    expect(CERTIFIED_CHAIN_INSTALLER).toBe(HOSTED_INSTALLER)
    expect(CERTIFIED_CHAIN_OWNER).toBe(OWNER)
  })

  it('names a principal that is NOT the bootstrap administrative login', () => {
    // The distinction is the whole incident. `postgres` is correct for
    // PHASE_BASELINE and for stella_hosted_0002 — both run before the installer
    // holds anything — and wrong for T1..T9.
    expect(CERTIFIED_CHAIN_INSTALLER).not.toBe(BOOTSTRAP_ADMIN_LOGIN)
  })

  it('matches the bytes on disk in every governed package', () => {
    // Asserted against the ARTEFACTS, not against the generator. The generator
    // and the gate could agree with each other and both disagree with what was
    // pinned and reviewed; only the files can settle that.
    const files = readdirSync(path.join(ROOT, GOVERNED_DIR)).filter((f) =>
      f.endsWith('.governed.sql'),
    )
    // ELEVEN since M-2. The identity contract is per-artefact, so a new chain
    // member simply has to satisfy it like the other ten.
    expect(files.length).toBe(11)

    // M-2. A package whose ONLY authority window is OWNER class grants nothing,
    // and that is the contract holding rather than being skipped: a temporary
    // membership is needed to reach a CAPABILITY role, which exists precisely
    // so it has ZERO members. `uellix_owner` is different — the installer's
    // right to SET ROLE to it is a PRECONDITION, asserted by
    // uellix_bootstrap.assert_hosted_capabilities() (C2) before the package
    // runs, so a package that emits `GRANT uellix_owner TO uellix_migrator`
    // would be granting itself something it was required to already have.
    //
    // stella_0019 is the first such package: it republishes one baseline
    // function that uellix_owner already owns. Declared by name, so a package
    // that stops opening a window by ACCIDENT still fails here.
    const OWNER_WINDOW_ONLY = ['stella_0019_storage_write_roles.governed.sql']

    for (const file of files) {
      const sql = read(`${GOVERNED_DIR}/${file}`)
      const grants = [...sql.matchAll(/^GRANT \S+ TO (\S+) WITH INHERIT FALSE, SET TRUE;$/gm)]

      // Every temporary elevation names the installer or the owner, and nothing
      // else. A grant to a third role would be an execution path this gate does
      // not describe. Checked for EVERY package, including the owner-only one:
      // its grant count is zero, so the loop is vacuous and the next assertion
      // is what carries the weight.
      for (const [, grantee] of grants) {
        expect([CERTIFIED_CHAIN_INSTALLER, CERTIFIED_CHAIN_OWNER]).toContain(grantee)
      }

      if (OWNER_WINDOW_ONLY.includes(file)) {
        expect(grants, `${file} is declared owner-window-only and must grant nothing`).toEqual([])
        // What it must do instead: reach the owner by SET ROLE, and give it back.
        expect(sql, `${file} does not open an owner window`).toMatch(
          new RegExp(`^SET ROLE ${CERTIFIED_CHAIN_OWNER};$`, 'm'),
        )
        expect(sql, `${file} does not close its owner window`).toMatch(/^RESET ROLE;$/m)
        continue
      }

      expect(grants.length, `${file} opens no elevation window`).toBeGreaterThan(0)
      // And at least one names the installer, which is why the session must BE
      // it: `GRANT <cap> TO <installer> ...` followed by `SET ROLE <cap>`.
      expect(
        grants.some(([, g]) => g === CERTIFIED_CHAIN_INSTALLER),
        `${file} never names ${CERTIFIED_CHAIN_INSTALLER}`,
      ).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The verifier                                                                */
/* -------------------------------------------------------------------------- */

describe('verifyInstallerIdentity', () => {
  it('accepts the certified installer and finds nothing', () => {
    expect(verifyInstallerIdentity(CERTIFIED)).toEqual([])
  })

  it('refuses postgres, and says which mistake was made', () => {
    const findings = verifyInstallerIdentity({ ...CERTIFIED, sessionUser: 'postgres', currentUser: 'postgres' })
    expect(findings.map((f) => f.code)).toEqual(['INSTALLER_IDENTITY_WRONG_PRINCIPAL'])
    expect(findings[0]?.detail).toContain('BOOTSTRAP/ADMIN identity')
    expect(findings[0]?.detail).toContain('permission denied to set role')
  })

  it('refuses a granted-membership workaround explicitly', () => {
    // The hypothesis the incident report told us to default against: give
    // postgres the memberships and let it apply the chain. The packages would
    // still hand the SET option to the installer by name, and the end-state
    // membership the chain postconditions pin would not be the one produced.
    const findings = verifyInstallerIdentity({ ...CERTIFIED, sessionUser: 'postgres', currentUser: 'postgres' })
    expect(findings[0]?.detail).toContain('does not help')
  })

  it('refuses a session that assumed the installer rather than connecting as it', () => {
    const findings = verifyInstallerIdentity({ ...CERTIFIED, sessionUser: 'postgres' })
    expect(findings.map((f) => f.code)).toEqual([
      'INSTALLER_IDENTITY_WRONG_PRINCIPAL',
      'INSTALLER_IDENTITY_ROLE_ASSUMED',
    ])
    expect(findings[1]?.detail).toContain('RESET ROLE')
  })

  it('refuses the installer that has assumed something else', () => {
    const findings = verifyInstallerIdentity({ ...CERTIFIED, currentUser: 'uellix_owner' })
    expect(findings.map((f) => f.code)).toEqual(['INSTALLER_IDENTITY_ROLE_ASSUMED'])
  })

  it('does not report attribute defects of a principal that is already wrong', () => {
    // A refusal reading "postgres lacks CREATEROLE" would send an operator to
    // widen an identity that must not be widened at all.
    const findings = verifyInstallerIdentity({
      ...CERTIFIED,
      sessionUser: 'postgres',
      currentUser: 'postgres',
      createRole: false,
      canSetOwner: false,
    })
    expect(findings.map((f) => f.code)).toEqual(['INSTALLER_IDENTITY_WRONG_PRINCIPAL'])
  })

  it('refuses exactly the four attributes the execution contract depends on', () => {
    expect(verifyInstallerIdentity({ ...CERTIFIED, canLogin: false }).map((f) => f.code)).toEqual([
      'INSTALLER_IDENTITY_NOT_LOGIN',
    ])
    expect(verifyInstallerIdentity({ ...CERTIFIED, createRole: false }).map((f) => f.code)).toEqual([
      'INSTALLER_IDENTITY_CANNOT_CREATE_ROLE',
    ])
    expect(verifyInstallerIdentity({ ...CERTIFIED, canSetOwner: false }).map((f) => f.code)).toEqual([
      'INSTALLER_IDENTITY_CANNOT_BECOME_OWNER',
    ])
    expect(verifyInstallerIdentity({ ...CERTIFIED, isSuper: true }).map((f) => f.code)).toEqual([
      'INSTALLER_IDENTITY_WIDENED',
    ])
  })

  it('reports every reason at once rather than one per round trip', () => {
    const findings = verifyInstallerIdentity({
      ...CERTIFIED,
      createRole: false,
      canSetOwner: false,
    })
    expect(findings).toHaveLength(2)
  })
})

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

describe('parseInstallerIdentity refuses rather than coerces', () => {
  const refusal = (raw: string | null, attemptId = A): string => {
    try {
      parseInstallerIdentity(raw, attemptId)
    } catch (error) {
      if (error instanceof InstallerIdentityRefusal) return error.code
      throw error
    }
    throw new Error('the document was accepted')
  }

  it('refuses an absent document instead of treating it as a clean session', () => {
    expect(refusal(null)).toBe('INSTALLER_IDENTITY_REQUIRED')
    expect(refusal('   ')).toBe('INSTALLER_IDENTITY_REQUIRED')
  })

  it('refuses a document for another attempt', () => {
    expect(refusal(doc({}, 'att_' + 'c'.repeat(32)))).toBe('INSTALLER_IDENTITY_ATTEMPT_MISMATCH')
  })

  it('refuses a foreign schema', () => {
    const foreign = JSON.stringify({ schema: 'something/1', attemptId: A, identity: CERTIFIED })
    expect(refusal(foreign)).toBe('INSTALLER_IDENTITY_MALFORMED')
  })

  it('refuses a missing boolean instead of reading it as false', () => {
    const rest: Record<string, unknown> = { ...CERTIFIED }
    delete rest.createRole
    const partial = JSON.stringify({ schema: INSTALLER_IDENTITY_SCHEMA, attemptId: A, identity: rest })
    expect(refusal(partial)).toBe('INSTALLER_IDENTITY_MALFORMED')
  })

  it('refuses an empty principal instead of refusing with a message naming nobody', () => {
    const blank = JSON.stringify({
      schema: INSTALLER_IDENTITY_SCHEMA,
      attemptId: A,
      identity: { ...CERTIFIED, sessionUser: '' },
    })
    expect(refusal(blank)).toBe('INSTALLER_IDENTITY_MALFORMED')
  })

  it('accepts the shape the probe emits', () => {
    const parsed = parseInstallerIdentity(doc(), A)
    expect(parsed.identity.sessionUser).toBe(CERTIFIED_CHAIN_INSTALLER)
    expect(parsed.attemptId).toBe(A)
  })
})

/* -------------------------------------------------------------------------- */
/* The probe and the guard write nothing                                       */
/* -------------------------------------------------------------------------- */

const MUTATION = /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT)\b/i
const ROLE_SWITCH = /\bSET\s+(LOCAL\s+)?ROLE\b/i

/**
 * The EXECUTABLE SQL, with comments and string literals removed.
 *
 * Necessary rather than fussy: the guard's whole payload is a `RAISE EXCEPTION`
 * whose message quotes `GRANT ... TO <installer>` and `SET ROLE <capability>`,
 * because telling the operator what the packages actually do is the difference
 * between a useful refusal and a code. A naive scan reads those quoted words as
 * statements and reports a read-only guard as mutating.
 */
function executableSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

describe('the identity probe is read-only and attempt-bound', () => {
  const sql = buildInstallerIdentitySql(A)

  it('mutates nothing', () => {
    expect(executableSql(sql)).not.toMatch(MUTATION)
    expect(executableSql(sql)).not.toMatch(ROLE_SWITCH)
  })

  it('pins its search_path and reads the catalog qualified', () => {
    expect(sql.startsWith("SET search_path = '';")).toBe(true)
    expect(sql).toContain('pg_catalog.pg_roles')
    expect(sql).toContain('pg_catalog.pg_has_role')
  })

  it('leaves session_user and current_user unqualified, because they are keywords', () => {
    // `pg_catalog.session_user` is a syntax error: these are SQL-standard
    // keywords the grammar resolves, not catalog functions. Being keywords is
    // also why the empty search_path above does not break them.
    expect(sql).not.toMatch(/pg_catalog\.(session|current)_user/)
    expect(sql).toMatch(/'sessionUser', session_user/)
    expect(sql).toMatch(/'currentUser', current_user/)
  })

  it('compiles the attempt in as a literal so the server echoes it', () => {
    expect(sql).toContain(`'${A}'`)
    expect(() => buildInstallerIdentitySql('att_short')).toThrow(InstallerIdentityRefusal)
    expect(() => buildInstallerIdentitySql("att_'; DROP")).toThrow(InstallerIdentityRefusal)
  })

  it('resolves the owner through pg_roles instead of naming it to pg_has_role', () => {
    // Measured on public.ecr.aws/supabase/postgres:17.6.1.143: the NAME
    // overload of pg_has_role RAISES for a role that does not exist, and
    // COALESCE does not catch an exception — it only replaces NULL. A probe
    // that dies instead of reporting `canSetOwner: false` hands the operator a
    // raw SQL error at the one moment they need a verdict.
    expect(sql).toMatch(/pg_catalog\.pg_has_role\(current_user, r\.oid, 'SET'\)/)
    expect(sql).not.toMatch(
      new RegExp(`pg_has_role\\(current_user, '${CERTIFIED_CHAIN_OWNER}'`),
    )
  })

  it('asks about the SESSION, not about the role by name', () => {
    // The distinction that would have caught the incident: asking
    // `rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator'` answers a
    // question that was already TRUE while T1 was dying.
    expect(sql).toContain('WHERE r.rolname = current_user')
    expect(sql).not.toContain(`WHERE r.rolname = '${CERTIFIED_CHAIN_INSTALLER}'`)
  })
})

describe('the write-time guard', () => {
  const guard = buildInstallerIdentityGuardSql(A)

  it('refuses the wrong principal and repairs nothing', () => {
    expect(guard).toContain('RAISE EXCEPTION')
    expect(guard).toContain(`<> '${CERTIFIED_CHAIN_INSTALLER}'`)
    expect(executableSql(guard)).not.toMatch(MUTATION)
    expect(executableSql(guard)).not.toMatch(ROLE_SWITCH)
  })

  it('says GRANT and SET ROLE only inside the message it raises', () => {
    // The guard is allowed to quote what the packages do — that is what makes
    // the refusal actionable — and is not allowed to do any of it. Both halves
    // are asserted, so a future edit that promotes the quotation to a statement
    // fails here rather than in staging.
    expect(guard).toMatch(/GRANT <capability> TO/)
    expect(executableSql(guard)).not.toMatch(/\bGRANT\b/i)
  })

  it('checks BOTH session_user and current_user', () => {
    // Checking only current_user would accept a `SET ROLE` that the packages'
    // own `RESET ROLE` statements would undo mid-transaction.
    expect(guard).toContain('session_user <>')
    expect(guard).toContain('current_user <>')
  })

  it('refuses to be built for a malformed attempt', () => {
    expect(() => buildInstallerIdentityGuardSql('nope')).toThrow(InstallerIdentityRefusal)
  })
})

/* -------------------------------------------------------------------------- */
/* No route reaches a governed write without it                                */
/* -------------------------------------------------------------------------- */

describe('there is no way around the identity gate', () => {
  const CHAIN_SHELL = read('scripts/chain-attempt.ts')
  const IDENTITY_SHELL = read('scripts/verify-installer-identity.ts')
  const MODULE = read('db/hosted/authority/certification/installer-identity.ts')

  it('offers no flag that declares the identity instead of measuring it', () => {
    // The same rule `--remediation-installed` is refused under: the state of
    // the session is not something the operator is asked to assert.
    for (const shell of [CHAIN_SHELL, IDENTITY_SHELL]) {
      expect(shell).not.toMatch(/--skip-identity|--no-identity|--installer=|--identity-ok|--force/)
    }
  })

  it('reads no environment variable and opens no connection', () => {
    for (const source of [CHAIN_SHELL, IDENTITY_SHELL, MODULE]) {
      expect(source).not.toMatch(/process\.env/)
      expect(source).not.toMatch(/\b(pg|postgres|Client|Pool)\b\s*\(/)
      expect(source).not.toMatch(/child_process|execSync|spawnSync/)
    }
  })

  it('never prints a connection string', () => {
    for (const source of [CHAIN_SHELL, IDENTITY_SHELL]) {
      expect(source).not.toMatch(/postgres(ql)?:\/\//)
    }
  })

  it('routes the plan through the gate rather than around it', () => {
    expect(CHAIN_SHELL).toContain('--installer-identity=')
    expect(CHAIN_SHELL).toContain('identityRaw')
    // And never reconstructs an authorization itself.
    expect(CHAIN_SHELL).not.toMatch(/gateInstallerIdentity\s*\(/)
  })

  it('emits the probe and the guard when an attempt is opened', () => {
    expect(CHAIN_SHELL).toContain('buildInstallerIdentitySql')
    expect(CHAIN_SHELL).toContain('buildInstallerIdentityGuardSql')
  })

  it('puts the guard into the psql command it prints', () => {
    // Defence in depth for the window between the plan and the keystroke. The
    // command the operator pastes carries the check with it.
    expect(CHAIN_SHELL).toMatch(/psql -1 -v ON_ERROR_STOP=1 -f \$\{IDENTITY_GUARD_OUT\} -f/)
    expect(CHAIN_SHELL).toContain('pnpm identity:verify')
  })

  it('the CLI authorises nothing', () => {
    expect(IDENTITY_SHELL).not.toMatch(/AUTHORISED|AUTHORIZED/)
    expect(IDENTITY_SHELL).not.toMatch(/appendFileSync|writeFileSync/)
    expect(IDENTITY_SHELL).not.toContain('ATTEMPT_LEDGER')
  })

  it('the gate itself refuses an absent measurement', () => {
    const verdict = gateInstallerIdentity({ attemptId: A })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('an unmeasured session passed the gate')
    expect(verdict.code).toBe('INSTALLER_IDENTITY_REQUIRED')
  })

  it('the gate accepts only the certified installer', () => {
    expect(gateInstallerIdentity({ attemptId: A, identityRaw: doc() }).ok).toBe(true)
    expect(
      gateInstallerIdentity({
        attemptId: A,
        identityRaw: doc({ sessionUser: 'postgres', currentUser: 'postgres' }),
      }).ok,
    ).toBe(false)
  })
})
