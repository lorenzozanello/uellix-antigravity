// tests/database-supavisor-qualified-role.test.ts
//
// SYS-02 — A SUPAVISOR QUALIFIED LOGIN ROLE IS TWO IDENTITIES, NOT ONE.
//
// ---------------------------------------------------------------------------
// THE BLOCKER THIS SUITE CLOSES
// ---------------------------------------------------------------------------
// Through the shared Supavisor pooler the runtime authenticates as
// `uellix_app.<project-ref>`: ONE userinfo field carrying a ROLE and a PROJECT.
// The repository only ever modelled two shapes — a bare role (`uellix_app`,
// direct connection) and the operator's pooler login (`postgres.<ref>`) — so
// the runtime form was refused twice over, at two layers, for two different
// reasons:
//
//   resolveForRole            read the WHOLE string as a role name
//                             → DB_CAPABILITY_URL_WRONG_ROLE
//   deriveTargetProjectIdentity  read NO project out of it, because the
//                             qualifier was not `postgres`
//                             → HOSTED_TARGET_POOLER_USER_MISSING
//                             → DB_RUNTIME_PROJECT_UNPINNED
//
// Both were the same wrong premise applied twice. The fix splits the username
// into its two identities and validates each in the layer that can actually
// judge it — the role against the capability's expected role, the project
// against SYS-02's environment pin — so neither substitutes for the other.
//
// ---------------------------------------------------------------------------
// WHAT MUST NOT HAVE WIDENED
// ---------------------------------------------------------------------------
// The operator provisioning chain's pooler contract is `postgres.<ref>` and
// five call sites depend on it. This suite asserts it is UNCHANGED: the general
// parser is new, `projectRefFromPoolerUser` still refuses `uellix_app.<ref>`,
// and the production veto is byte-identical.
//
// ---------------------------------------------------------------------------
// EVERYTHING HERE IS OFFLINE
// ---------------------------------------------------------------------------
// Every call is pure parsing. No socket is opened, no hostname is resolved, and
// every password below is a placeholder that is never dialled.

import { describe, it, expect } from 'vitest'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  OPERATOR_POOLER_ROLE,
  deriveConnectionIdentity,
  parseQualifiedPoolerUser,
  productionDenylistStatus,
  projectRefFromPoolerUser,
  verifyStagingTarget,
} from '@/db/hosted/target-identity'
import { classifyDatabaseTarget } from '@/db/safety/database-target'
import { deriveTargetProjectIdentity } from '@/db/safety/runtime-project-pins'
import {
  assertDatabaseOperationAllowed,
  DatabaseSafetyError,
} from '@/db/safety/database-access'
import {
  CapabilityDatabaseUrlError,
  MIGRATOR_DATABASE_URL_ENV_VAR,
  RUNTIME_DATABASE_URL_ENV_VAR,
  resolveMigratorDatabaseUrl,
  resolveRuntimeDatabaseUrl,
} from '@/db/safety/resolve-capability-database-url'
import {
  MIGRATOR_DATABASE_ROLE,
  RUNTIME_DATABASE_ROLE,
  WRITER_DATABASE_ROLE,
} from '@/db/safety/database-role'
import {
  SupabaseProjectCoherenceError,
  assertSupabaseProjectCoherence,
} from '@/lib/supabase/project-coherence'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

// Imported, never retyped: a suite that hardcodes a ref can drift from the
// registry it exists to protect, and a 20-character typo survives review.
const STAGING = KNOWN_STAGING_PROJECT_REF
const PRODUCTION = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]

/** Placeholder. Never dialled: every URL below is parsed and then discarded. */
const PW = 'not-a-real-password'

/** The regional Supavisor host — shared by EVERY project in the region. */
const POOLER_HOST = 'aws-0-us-east-2.pooler.supabase.com'

const TRANSACTION_PORT = 6543
const SESSION_PORT = 5432

/** The exact DSN shape the Preview runtime cutover needs. */
const poolerUrl = (user: string, port = TRANSACTION_PORT, query = '') =>
  `postgresql://${user}:${PW}@${POOLER_HOST}:${port}/postgres${query}`

const directUrl = (ref: string, user: string = RUNTIME_DATABASE_ROLE) =>
  `postgresql://${user}:${PW}@db.${ref}.supabase.co:5432/postgres`

const identityOf = (url: string) => classifyDatabaseTarget(url).provenIdentity

const codeOf = (run: () => unknown): string | null => {
  try {
    run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'THREW_WITHOUT_CODE'
  }
}

const runtimeGuard = (
  url: string,
  environment: 'development' | 'test' | 'ci' | 'staging' | 'production'
) => assertDatabaseOperationAllowed({ url, capability: 'app_runtime', environment, env: {} })

/* -------------------------------------------------------------------------- */
/* 1. The parser — two identities out of one string, strictly                 */
/* -------------------------------------------------------------------------- */

describe('parseQualifiedPoolerUser — the shape contract', () => {
  it('splits the runtime login role into its role and its project', () => {
    expect(parseQualifiedPoolerUser(`${RUNTIME_DATABASE_ROLE}.${STAGING}`)).toEqual({
      databaseRole: RUNTIME_DATABASE_ROLE,
      projectRef: STAGING,
    })
  })

  it('treats the operator login role as the same shape, not a special case', () => {
    // `postgres` is one role among many. Modelling it as THE pooler form is
    // exactly what made the runtime form unreadable.
    expect(parseQualifiedPoolerUser(`${OPERATOR_POOLER_ROLE}.${STAGING}`)).toEqual({
      databaseRole: OPERATOR_POOLER_ROLE,
      projectRef: STAGING,
    })
  })

  it('returns the ref VERBATIM rather than a prefix or a slice of the input', () => {
    // Guards against a `startsWith`/`slice` implementation that would accept a
    // longer string and silently truncate it to something that looks valid.
    const parsed = parseQualifiedPoolerUser(`${RUNTIME_DATABASE_ROLE}.${STAGING}`)
    expect(parsed?.projectRef).toHaveLength(20)
    expect(parsed?.projectRef).toBe(STAGING)
    expect(parsed?.databaseRole).not.toContain('.')
  })

  // D — malformed qualified usernames. Every one of these is a string that
  // RESEMBLES a qualified role, which is the only interesting kind of input:
  // a parser that fails closed on obvious garbage but mines a ref out of a
  // near-miss has not fixed anything.
  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    [RUNTIME_DATABASE_ROLE, 'bare role — names no project at all'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING}.extra`, 'three segments'],
    [`${RUNTIME_DATABASE_ROLE}..${STAGING}`, 'empty middle segment'],
    [`${RUNTIME_DATABASE_ROLE}.`, 'empty project half'],
    [`.${STAGING}`, 'empty role half'],
    ['.', 'both halves empty'],
    [`${RUNTIME_DATABASE_ROLE}.INVALID`, 'project half is not a ref'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING.slice(0, 19)}`, 'ref one character short'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING}x`, 'ref one character long'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING.toUpperCase()}`, 'ref upper case'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING.slice(0, 19)}1`, 'digit inside the ref'],
    [`${RUNTIME_DATABASE_ROLE.toUpperCase()}.${STAGING}`, 'role case is NOT folded'],
    [`uellix-app.${STAGING}`, 'hyphen in the role'],
    [`-uellix_app.${STAGING}`, 'role starts with a hyphen'],
    [`9uellix_app.${STAGING}`, 'role starts with a digit'],
    [`${'u'.repeat(64)}.${STAGING}`, 'role longer than NAMEDATALEN-1'],
  ]

  it.each(REFUSED)('refuses %j — %s', (candidate) => {
    expect(parseQualifiedPoolerUser(candidate)).toBeNull()
  })

  // Anything that could be a pasted credential is refused OUTRIGHT rather than
  // parsed around, so a full DSN is rejected instead of being mined for a ref.
  const CREDENTIAL_SHAPED: readonly string[] = [
    `${RUNTIME_DATABASE_ROLE}:${PW}.${STAGING}`,
    `${RUNTIME_DATABASE_ROLE}.${STAGING}@${POOLER_HOST}`,
    `postgresql://${RUNTIME_DATABASE_ROLE}.${STAGING}:${PW}@${POOLER_HOST}/postgres`,
    `${RUNTIME_DATABASE_ROLE} .${STAGING}`,
    `${RUNTIME_DATABASE_ROLE}.${STAGING}/postgres`,
    `${RUNTIME_DATABASE_ROLE}.${STAGING}\tx`,
  ]

  it.each(CREDENTIAL_SHAPED)('refuses the credential-shaped %j', (candidate) => {
    expect(parseQualifiedPoolerUser(candidate)).toBeNull()
  })

  it('refuses a percent-encoded separator rather than decoding it itself', () => {
    // Decoding is the CALLER's job and it must happen once, where the driver
    // does it. A parser that decoded too would disagree with a caller that
    // already had.
    expect(parseQualifiedPoolerUser(`${RUNTIME_DATABASE_ROLE}%2E${STAGING}`)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* 2. The operator contract is UNCHANGED — nothing widened by accident        */
/* -------------------------------------------------------------------------- */

describe('the hosted operator pooler contract did not widen', () => {
  it('still refuses a runtime login role where the operator chain reads one', () => {
    // Five operator-facing call sites depend on `postgres.<ref>`. Widening this
    // would have widened the provisioning chain to accept login roles the
    // runbook never authorised.
    expect(projectRefFromPoolerUser(`${RUNTIME_DATABASE_ROLE}.${STAGING}`)).toBeNull()
    expect(projectRefFromPoolerUser(`${MIGRATOR_DATABASE_ROLE}.${STAGING}`)).toBeNull()
    expect(projectRefFromPoolerUser(`${WRITER_DATABASE_ROLE}.${STAGING}`)).toBeNull()
  })

  it('still accepts the operator login role, and still folds its case', () => {
    expect(projectRefFromPoolerUser(`${OPERATOR_POOLER_ROLE}.${STAGING}`)).toBe(STAGING)
    // Case folding is this function's historical tolerance of what an operator
    // pastes out of the dashboard. The general parser deliberately does not
    // fold; the two differ here and only here.
    expect(projectRefFromPoolerUser(`POSTGRES.${STAGING.toUpperCase()}`)).toBe(STAGING)
    expect(projectRefFromPoolerUser(`  postgres.${STAGING}  `)).toBe(STAGING)
  })

  // The exact table the pre-change implementation satisfied. Expressed as data
  // so the refactor that made this function the narrow case of a general parser
  // is proven behaviour-preserving rather than assumed to be.
  const OPERATOR_TABLE: ReadonlyArray<readonly [string, string | null]> = [
    [`postgres.${STAGING}`, STAGING],
    [`postgres.${PRODUCTION}`, PRODUCTION],
    ['postgres', null],
    ['', null],
    [`postgres.${STAGING}.extra`, null],
    [`postgres..${STAGING}`, null],
    ['postgres.INVALID', null],
    [`postgres.${STAGING.slice(0, 19)}`, null],
    [`postgres_x.${STAGING}`, null],
    [`postgresql://postgres.${STAGING}:${PW}@${POOLER_HOST}/postgres`, null],
    [`postgres.${STAGING}@${POOLER_HOST}`, null],
    [`postgres .${STAGING}`, null],
  ]

  it.each(OPERATOR_TABLE)('projectRefFromPoolerUser(%j) === %j', (input, expected) => {
    expect(projectRefFromPoolerUser(input)).toBe(expected)
  })

  it('still refuses a qualified runtime role supplied to deriveConnectionIdentity', () => {
    const verdict = deriveConnectionIdentity({
      connectionHost: POOLER_HOST,
      poolerUser: `${RUNTIME_DATABASE_ROLE}.${STAGING}`,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.code).toBe('HOSTED_TARGET_POOLER_USER_INVALID')
  })

  it('still refuses a qualified runtime role in the staging provisioning gate', () => {
    // The provisioning chain is not part of this change and must not have moved.
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'staging',
      declaredProjectRef: STAGING,
      connectionHost: POOLER_HOST,
      poolerUser: `${RUNTIME_DATABASE_ROLE}.${STAGING}`,
      connectionPort: SESSION_PORT,
      sentinel: { environment: 'staging', projectRef: STAGING },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.code).toBe('HOSTED_TARGET_POOLER_USER_INVALID')
  })
})

/* -------------------------------------------------------------------------- */
/* 3. The capability layer — the ROLE half                                    */
/* -------------------------------------------------------------------------- */

describe('resolveRuntimeDatabaseUrl — the role half of a qualified username', () => {
  // A — the case the cutover blocked on.
  it('accepts the qualified runtime role and reports the role the server will see', () => {
    const resolved = resolveRuntimeDatabaseUrl({
      [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`),
    })
    // The pooler consumes the qualifier for routing and authenticates as the
    // role half, so THAT is what this field must report.
    expect(resolved.declaredRole).toBe(RUNTIME_DATABASE_ROLE)
    expect(resolved.url).toContain(POOLER_HOST)
  })

  // F — the pre-existing direct form is untouched.
  it('still accepts the direct-connection bare role', () => {
    const resolved = resolveRuntimeDatabaseUrl({
      [RUNTIME_DATABASE_URL_ENV_VAR]: directUrl(STAGING),
    })
    expect(resolved.declaredRole).toBe(RUNTIME_DATABASE_ROLE)
  })

  // C — a qualified username whose ROLE half is wrong.
  it('refuses the operator role qualified with the right project', () => {
    const code = codeOf(() =>
      resolveRuntimeDatabaseUrl({
        [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${OPERATOR_POOLER_ROLE}.${STAGING}`),
      })
    )
    expect(code).toBe('DB_CAPABILITY_URL_WRONG_ROLE')
  })

  it('names the ROLE half, not the whole username, when it refuses', () => {
    // The diagnostic has to be actionable: "postgres is not uellix_app" is the
    // fact; "postgres.<ref> is not uellix_app" is the bug that was just fixed
    // wearing an error message.
    try {
      resolveRuntimeDatabaseUrl({
        [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${OPERATOR_POOLER_ROLE}.${STAGING}`),
      })
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityDatabaseUrlError)
      const { message } = error as CapabilityDatabaseUrlError
      expect(message).toContain(`declares role "${OPERATOR_POOLER_ROLE}"`)
      expect(message).not.toContain(STAGING)
      // And never the credential, redacted or otherwise.
      expect(message).not.toContain(PW)
      expect(message).not.toContain('postgresql://')
    }
  })

  it('refuses another product role qualified with the right project', () => {
    const code = codeOf(() =>
      resolveRuntimeDatabaseUrl({
        [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${WRITER_DATABASE_ROLE}.${STAGING}`),
      })
    )
    expect(code).toBe('DB_CAPABILITY_URL_WRONG_ROLE')
  })

  // D — a malformed qualifier must be compared LITERALLY and lose, never be
  // mined for a role name that happens to match.
  const MALFORMED_URLS: ReadonlyArray<readonly [string, string]> = [
    [`${RUNTIME_DATABASE_ROLE}.${STAGING}.extra`, 'three segments'],
    [`${RUNTIME_DATABASE_ROLE}..${STAGING}`, 'empty middle segment'],
    [`${RUNTIME_DATABASE_ROLE}.INVALID`, 'project half is not a ref'],
    [`${RUNTIME_DATABASE_ROLE}.`, 'empty project half'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING.toUpperCase()}`, 'ref upper case'],
    [`${RUNTIME_DATABASE_ROLE}.${STAGING}x`, 'ref one character long'],
  ]

  it.each(MALFORMED_URLS)('refuses %j — %s', (user) => {
    expect(codeOf(() => resolveRuntimeDatabaseUrl({ [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(user) }))).toBe(
      'DB_CAPABILITY_URL_WRONG_ROLE'
    )
  })

  it('reads a percent-encoded separator the way the driver will', () => {
    // postgres-js runs decodeURIComponent over the username, so a guard reading
    // the RAW value would validate a different string than the one that
    // authenticates.
    const resolved = resolveRuntimeDatabaseUrl({
      [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${RUNTIME_DATABASE_ROLE}%2E${STAGING}`),
    })
    expect(resolved.declaredRole).toBe(RUNTIME_DATABASE_ROLE)
  })

  it('does not let the project half satisfy ANOTHER capability role check', () => {
    // The migrator variable holding a runtime-qualified URL is a real
    // misconfiguration; the qualifier must not make it look right.
    expect(
      codeOf(() =>
        resolveMigratorDatabaseUrl({
          [MIGRATOR_DATABASE_URL_ENV_VAR]: poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`),
        })
      )
    ).toBe('DB_CAPABILITY_URL_WRONG_ROLE')

    const migrator = resolveMigratorDatabaseUrl({
      [MIGRATOR_DATABASE_URL_ENV_VAR]: poolerUrl(`${MIGRATOR_DATABASE_ROLE}.${STAGING}`, SESSION_PORT),
    })
    expect(migrator.declaredRole).toBe(MIGRATOR_DATABASE_ROLE)
  })

  it('accepting the role half is NOT accepting the project — that is SYS-02', () => {
    // This layer knows nothing about environments, so it cannot judge a
    // project and must not pretend to. The refusal for a production ref comes
    // from the pin, and section 5 proves it does.
    const resolved = resolveRuntimeDatabaseUrl({
      [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`),
    })
    expect(resolved.declaredRole).toBe(RUNTIME_DATABASE_ROLE)
  })
})

/* -------------------------------------------------------------------------- */
/* 4. SYS-02 — the PROJECT half, and every source that names one              */
/* -------------------------------------------------------------------------- */

describe('deriveTargetProjectIdentity — the qualified role as an identity source', () => {
  // A — transaction pooler, the mode the runtime actually uses.
  it('proves the project from a qualified runtime role on the transaction pooler', () => {
    const identity = identityOf(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`, TRANSACTION_PORT))
    expect(identity.proven).toBe(true)
    expect(identity.proven && identity.projectRef).toBe(STAGING)
    expect(identity.proven && identity.mechanism).toBe('supavisor-qualified-role')
  })

  it('proves it on the session pooler too — the port is not an identity signal', () => {
    const identity = identityOf(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`, SESSION_PORT))
    expect(identity.proven && identity.mechanism).toBe('supavisor-qualified-role')
  })

  // B — the derivation is NEUTRAL about which project is wanted. It proves what
  // the connection names; the pin judges it. Section 5 proves the refusal.
  it('proves a production ref just as readily — judging it is the pin\'s job', () => {
    const identity = identityOf(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`))
    expect(identity.proven && identity.projectRef).toBe(PRODUCTION)
  })

  // G — the pre-existing mechanisms are untouched.
  it('still derives the operator pooler role as session-pooler', () => {
    const identity = identityOf(poolerUrl(`${OPERATOR_POOLER_ROLE}.${STAGING}`, SESSION_PORT))
    expect(identity.proven && identity.mechanism).toBe('session-pooler')
    expect(identity.proven && identity.projectRef).toBe(STAGING)
  })

  it('still derives a direct host as direct-db', () => {
    const identity = identityOf(directUrl(STAGING))
    expect(identity.proven && identity.mechanism).toBe('direct-db')
    expect(identity.proven && identity.corroboratedBy).toEqual(['connection host'])
  })

  it('still proves nothing from a bare role on the shared pooler', () => {
    // The host is regional and the username names no project, so there is
    // simply no evidence. "Cannot be compared" must never resolve to "allowed".
    const identity = identityOf(poolerUrl(RUNTIME_DATABASE_ROLE))
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('HOSTED_TARGET_POOLER_USER_MISSING')
  })

  it('refuses a qualified role on a host that is not a Supabase pooler', () => {
    // Without this gate, `<role>.<ref>@anything` would "prove" a project — the
    // substring-matching failure the module exists to avoid.
    const identity = deriveTargetProjectIdentity({
      host: 'evil.example.com',
      username: `${RUNTIME_DATABASE_ROLE}.${STAGING}`,
    })
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('HOSTED_TARGET_HOST_NOT_SUPABASE')
  })

  it('refuses a qualified role on a pooler-LOOKALIKE host', () => {
    const identity = deriveTargetProjectIdentity({
      host: 'aws-0-us-east-2.pooler.supabase.com.evil.example.com',
      username: `${RUNTIME_DATABASE_ROLE}.${STAGING}`,
    })
    expect(identity.proven).toBe(false)
  })

  it('reads a percent-encoded separator the way the driver will', () => {
    const identity = identityOf(poolerUrl(`${RUNTIME_DATABASE_ROLE}%2E${STAGING}`))
    expect(identity.proven && identity.projectRef).toBe(STAGING)
  })
})

/* -------------------------------------------------------------------------- */
/* 5. Multiple project signals — agreement passes, contradiction fails closed  */
/* -------------------------------------------------------------------------- */

describe('two sources that name a project must name the SAME one', () => {
  // E — the case the mission names explicitly.
  it('refuses a qualified role contradicted by the routing parameter', () => {
    const identity = identityOf(
      poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`, TRANSACTION_PORT, `?options=reference%3D${PRODUCTION}`)
    )
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('IDENTITY_CONTRADICTION')
  })

  it('refuses the contradiction in the other direction too', () => {
    const identity = identityOf(
      poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`, TRANSACTION_PORT, `?options=reference%3D${STAGING}`)
    )
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('IDENTITY_CONTRADICTION')
  })

  it('accepts them when they agree, and counts BOTH as corroboration', () => {
    const identity = identityOf(
      poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`, TRANSACTION_PORT, `?options=reference%3D${STAGING}`)
    )
    expect(identity.proven && identity.projectRef).toBe(STAGING)
    expect(identity.proven && identity.corroboratedBy).toEqual([
      'supavisor qualified login role',
      'supavisor reference parameter',
    ])
  })

  it('refuses a qualified role contradicted by a ref-bearing host', () => {
    // A direct host names the project, and a qualified username alongside it is
    // a SECOND source. Disagreement is a contradiction, never a choice.
    const identity = identityOf(directUrl(STAGING, `${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`))
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('IDENTITY_CONTRADICTION')
  })

  it('counts an agreeing qualified role on a direct host as corroboration', () => {
    const identity = identityOf(directUrl(STAGING, `${RUNTIME_DATABASE_ROLE}.${STAGING}`))
    expect(identity.proven && identity.projectRef).toBe(STAGING)
    expect(identity.proven && identity.corroboratedBy).toEqual([
      'connection host',
      'supavisor qualified login role',
    ])
  })

  it('still refuses a repeated options key before trusting ANY source', () => {
    // The guard reads the first value and the driver reads the last. Refusing
    // the ambiguity is stable; emulating the driver is not.
    const identity = identityOf(
      poolerUrl(
        `${RUNTIME_DATABASE_ROLE}.${STAGING}`,
        TRANSACTION_PORT,
        `?options=reference%3D${STAGING}&options=reference%3D${PRODUCTION}`
      )
    )
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('AMBIGUOUS_OPTIONS_PARAMETER')
  })

  it('refuses a repeated options key even when the two agree with each other', () => {
    const identity = identityOf(
      poolerUrl(
        `${RUNTIME_DATABASE_ROLE}.${STAGING}`,
        TRANSACTION_PORT,
        `?options=reference%3D${STAGING}&options=reference%3D${STAGING}`
      )
    )
    expect(identity.proven).toBe(false)
    expect(!identity.proven && identity.code).toBe('AMBIGUOUS_OPTIONS_PARAMETER')
  })
})

/* -------------------------------------------------------------------------- */
/* 6. The full guard — SYS-02 target identity end to end                      */
/* -------------------------------------------------------------------------- */

describe('app_runtime — the qualified pooler DSN against the environment pin', () => {
  // A + I — the mechanism the cutover needs, authorised.
  it('allows the qualified staging DSN in staging', () => {
    const url = poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`)
    const decision = runtimeGuard(url, 'staging')
    expect(decision.targetKind).toBe('managed_remote')
    expect(decision.environment).toBe('staging')
    // The decision deliberately carries no identity — the audit line is what a
    // run report captures, and it must name neither the project nor the host.
    expect(decision.auditLine).not.toContain(STAGING)
    expect(decision.redactedHost).toBe('***.supabase.com')
    // Identity is proven on the same parse the guard used.
    expect(classifyDatabaseTarget(url).provenIdentity.proven).toBe(true)
  })

  // B — same role, production ref, staging expected.
  it('refuses the SAME role qualified with the production project', () => {
    const code = codeOf(() => runtimeGuard(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`), 'staging'))
    expect(code).toBe('DB_RUNTIME_PROJECT_MISMATCH')
  })

  it('refuses the staging project where production is pinned', () => {
    // Symmetric on purpose: the pin is a positive identity in BOTH directions,
    // not a one-way denylist that only protects production.
    const code = codeOf(() => runtimeGuard(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`), 'production'))
    expect(code).toBe('DB_RUNTIME_PROJECT_MISMATCH')
  })

  it('refuses a bare role on the pooler — unprovable is not allowed', () => {
    const code = codeOf(() => runtimeGuard(poolerUrl(RUNTIME_DATABASE_ROLE), 'staging'))
    expect(code).toBe('DB_RUNTIME_PROJECT_UNPINNED')
  })

  it('refuses contradicting project signals', () => {
    const code = codeOf(() =>
      runtimeGuard(
        poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`, TRANSACTION_PORT, `?options=reference%3D${PRODUCTION}`),
        'staging'
      )
    )
    expect(code).toBe('DB_RUNTIME_PROJECT_UNPINNED')
  })

  it('refuses the qualified DSN in every environment with no hosted project', () => {
    for (const environment of ['development', 'test', 'ci'] as const) {
      expect(codeOf(() => runtimeGuard(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`), environment))).toBe(
        'DB_RUNTIME_REMOTE_NOT_ALLOWED'
      )
    }
  })

  it('never prints the ref, the host or the credential when it refuses', () => {
    try {
      runtimeGuard(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`), 'staging')
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseSafetyError)
      const { message } = error as DatabaseSafetyError
      expect(message).not.toContain(PRODUCTION)
      expect(message).not.toContain(STAGING)
      expect(message).not.toContain(PW)
      expect(message).not.toContain(POOLER_HOST)
    }
  })

  // The literal journey the Preview cutover performs: read the variable,
  // resolve the role, classify the target, authorise it.
  it('completes the whole cutover path for the real staging DSN', () => {
    const env = { [RUNTIME_DATABASE_URL_ENV_VAR]: poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`) }
    const resolved = resolveRuntimeDatabaseUrl(env)
    expect(resolved.declaredRole).toBe(RUNTIME_DATABASE_ROLE)

    const decision = assertDatabaseOperationAllowed({
      url: resolved.url,
      capability: 'app_runtime',
      environment: 'staging',
      env: {},
    })
    expect(decision.targetKind).toBe('managed_remote')

    const identity = classifyDatabaseTarget(resolved.url).provenIdentity
    expect(identity.proven && identity.projectRef).toBe(STAGING)
    expect(identity.proven && identity.mechanism).toBe('supavisor-qualified-role')
  })
})

/* -------------------------------------------------------------------------- */
/* 7. H — the production denylist is untouched                                */
/* -------------------------------------------------------------------------- */

describe('the production veto did not move', () => {
  it('is still loaded, with the same refs and hosts', () => {
    expect(productionDenylistStatus().loaded).toBe(true)
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).toEqual([PRODUCTION])
    expect(KNOWN_PRODUCTION_IDENTIFIERS.hosts).toEqual([
      'uellix-antigravity.vercel.app',
      'app.uellix.com',
      'uellix.com',
    ])
  })

  it('still keeps the staging target out of its own veto', () => {
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain(STAGING)
  })

  it('still vetoes a production ref declared to the provisioning gate', () => {
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'staging',
      declaredProjectRef: PRODUCTION,
      connectionHost: `db.${PRODUCTION}.supabase.co`,
      connectionPort: SESSION_PORT,
      sentinel: { environment: 'staging', projectRef: PRODUCTION },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('still vetoes a production login role that contradicts a staging declaration', () => {
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'staging',
      declaredProjectRef: STAGING,
      connectionHost: POOLER_HOST,
      poolerUser: `${OPERATOR_POOLER_ROLE}.${PRODUCTION}`,
      connectionPort: SESSION_PORT,
      sentinel: { environment: 'staging', projectRef: STAGING },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })
})

/* -------------------------------------------------------------------------- */
/* 8. J — SYS-03 Auth/Postgres coherence, no regression                       */
/* -------------------------------------------------------------------------- */

describe('SYS-03 — Auth and Postgres still have to name one project', () => {
  const authUrl = (ref: string) => `https://${ref}.supabase.co`

  const coherence = (dbUrl: string, authRef: string, environment = 'staging') =>
    assertSupabaseProjectCoherence({
      env: { UELLIX_APP_ENV: environment, [RUNTIME_DATABASE_URL_ENV_VAR]: dbUrl },
      authUrl: authUrl(authRef),
    })

  it('agrees when Auth and a qualified pooler DSN name the same project', () => {
    // Before the fix this refused: SYS-03 resolves the runtime URL first, so a
    // qualified username failed at the role check and the database identity
    // came back unproven.
    const decision = coherence(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${STAGING}`), STAGING)
    expect(decision.projectRef).toBe(STAGING)
    expect(decision.environment).toBe('staging')
  })

  it('refuses when the qualified DSN names a different project than Auth', () => {
    expect(codeOf(() => coherence(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`), STAGING))).toBe(
      'SUPABASE_DB_PROJECT_MISMATCH'
    )
  })

  it('refuses when the qualified DSN proves nothing', () => {
    expect(codeOf(() => coherence(poolerUrl(RUNTIME_DATABASE_ROLE), STAGING))).toBe(
      'SUPABASE_DB_IDENTITY_UNPROVEN'
    )
  })

  it('still agrees for the direct-connection form', () => {
    const decision = coherence(directUrl(STAGING), STAGING)
    expect(decision.projectRef).toBe(STAGING)
  })

  it('still refuses when Auth names the project the database does not', () => {
    const error = codeOf(() => coherence(directUrl(STAGING), PRODUCTION))
    expect(error).toBe('SUPABASE_AUTH_PROJECT_MISMATCH')
  })

  it('throws the coherence error type, not a raw resolver error', () => {
    // A misconfiguration must surface as one vetted refusal, never as an
    // internal error whose message this module has not seen.
    try {
      coherence(poolerUrl(`${RUNTIME_DATABASE_ROLE}.${PRODUCTION}`), STAGING)
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(SupabaseProjectCoherenceError)
    }
  })
})
