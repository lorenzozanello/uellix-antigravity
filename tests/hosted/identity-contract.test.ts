// tests/hosted/identity-contract.test.ts
// TRAIN 5C2 — the fourteen attacks the independent audit required, against ONE
// identity contract with two derivation mechanisms.
//
// ---------------------------------------------------------------------------
// WHAT THE AUDIT FOUND
// ---------------------------------------------------------------------------
// The apply gate corroborated the target through the Session Pooler login role
// and declared PASS, while `verifyStagingTarget` — the check the runner uses to
// plan PHASE_BASELINE — refused a pooler host outright:
//
//     planProvisioningPhase(aws-0-us-east-2.pooler.supabase.com)
//       → REFUSED HOSTED_TARGET_HOST_NOT_SUPABASE
//     planProvisioningPhase(db.<ref>.supabase.co)
//       → PLAN OK, 51 steps
//
// Two identity contracts inside one decision, and the refusal landed on the
// connection every Class-C measurement was actually taken over. Fail-closed, and
// still wrong: an authorisation nobody can act on is not an authorisation.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE MUST NOT BE ALLOWED TO BECOME
// ---------------------------------------------------------------------------
// A test suite that proves the pooler is ACCEPTED. The dangerous version of this
// change is "accept anything ending in pooler.supabase.com" — that hostname is
// regional and shared, so accepting it alone would corroborate nothing at all.
// Every positive case below is paired with the refusal it is the negation of.

import { describe, expect, it } from 'vitest'

import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  SESSION_POOLER_PORT,
  TRANSACTION_POOLER_PORT,
  deriveConnectionIdentity,
  projectRefFromPoolerUser,
  verifyStagingTarget,
  type HostedTargetInput,
} from '@/db/hosted/target-identity'

const STAGING = KNOWN_STAGING_PROJECT_REF
const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]
const UNKNOWN = 'zzzzzzzzzzzzzzzzzzzz'
const POOLER = 'aws-0-us-east-2.pooler.supabase.com'

/** The sentinel is deferred; PHASE_BASELINE is the phase this contract serves. */
const target = (over: Partial<HostedTargetInput> = {}): HostedTargetInput => ({
  declaredEnvironment: 'staging',
  declaredProjectRef: STAGING,
  connectionHost: POOLER,
  poolerUser: `postgres.${STAGING}`,
  sentinel: null,
  ...over,
})

const verify = (over: Partial<HostedTargetInput> = {}) =>
  verifyStagingTarget(target(over), KNOWN_PRODUCTION_IDENTIFIERS, 'deferred-until-bootstrap')

const codeOf = (v: ReturnType<typeof verify>) => (v.ok ? 'ACCEPT' : v.code)

describe('the fourteen mandated attacks', () => {
  it('1. session pooler + correct staging login role → ACCEPT', () => {
    const v = verify()
    expect(codeOf(v)).toBe('ACCEPT')
    if (v.ok) expect(v.projectRef).toBe(STAGING)
  })

  it('2. session pooler + PRODUCTION login role → REFUSED, and by the veto', () => {
    expect(codeOf(verify({ declaredProjectRef: PROD, poolerUser: `postgres.${PROD}` }))).toBe(
      'HOSTED_TARGET_IS_PRODUCTION',
    )
  })

  it('3. session pooler + malformed login role → REFUSED', () => {
    for (const bad of [`postgres.${STAGING.slice(0, 19)}`, 'postgres', 'postgres.', `supabase.${STAGING}`]) {
      expect(codeOf(verify({ poolerUser: bad })), bad).toBe('HOSTED_TARGET_POOLER_USER_INVALID')
    }
  })

  it('4. session pooler + NO login role → REFUSED, never accepted on the hostname alone', () => {
    expect(codeOf(verify({ poolerUser: null }))).toBe('HOSTED_TARGET_POOLER_USER_MISSING')
    expect(codeOf(verify({ poolerUser: '   ' }))).toBe('HOSTED_TARGET_POOLER_USER_MISSING')
  })

  // THE ATTACK THE WHOLE DESIGN TURNS ON: no acceptance by DNS suffix.
  it('5. lookalike pooler hostnames → REFUSED', () => {
    for (const host of [
      `${POOLER}.evil.net`,
      'evil.pooler.supabase.com',
      'aws-0-us-east-2.pooler.supabase.com.attacker.io',
      'pooler.supabase.com',
      'aws-0-us-east-2.pooler.supabase.co',
      'aws-0-us-east-2-pooler.supabase.com',
    ]) {
      expect(codeOf(verify({ connectionHost: host })), host).toBe('HOSTED_TARGET_HOST_NOT_SUPABASE')
    }
  })

  it('6. transaction-mode pooler port → REFUSED; session-mode port → ACCEPT', () => {
    expect(codeOf(verify({ connectionPort: TRANSACTION_POOLER_PORT }))).toBe(
      'HOSTED_TARGET_POOLER_TRANSACTION_MODE',
    )
    expect(codeOf(verify({ connectionPort: SESSION_POOLER_PORT }))).toBe('ACCEPT')
    expect(codeOf(verify({ connectionPort: 1234 }))).toBe('HOSTED_TARGET_POOLER_PORT_UNKNOWN')
  })

  it('7. direct staging host → ACCEPT', () => {
    expect(codeOf(verify({ connectionHost: `db.${STAGING}.supabase.co`, poolerUser: null }))).toBe('ACCEPT')
    expect(codeOf(verify({ connectionHost: `${STAGING}.supabase.co`, poolerUser: null }))).toBe('ACCEPT')
  })

  it('8. direct PRODUCTION host → REFUSED', () => {
    expect(
      codeOf(
        verify({ declaredProjectRef: PROD, connectionHost: `db.${PROD}.supabase.co`, poolerUser: null }),
      ),
    ).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('9. direct host contradicted by a login role → REFUSED, never silently preferred', () => {
    expect(
      codeOf(verify({ connectionHost: `db.${STAGING}.supabase.co`, poolerUser: `postgres.${UNKNOWN}` })),
    ).toBe('HOSTED_TARGET_IDENTITY_CONTRADICTION')
  })

  it('10. pooler login role contradicted by the declared ref → REFUSED', () => {
    expect(codeOf(verify({ declaredProjectRef: UNKNOWN }))).toBe('HOSTED_TARGET_PROJECT_REF_MISMATCH')
  })

  it('11. a DSN pasted where a username belongs → REFUSED', () => {
    for (const dsn of [
      `postgresql://postgres.${STAGING}:pw@${POOLER}:5432/postgres`,
      `postgres://postgres.${STAGING}@${POOLER}`,
      `host=${POOLER} user=postgres.${STAGING} password=hunter2`,
    ]) {
      expect(codeOf(verify({ poolerUser: dsn })), dsn).toBe('HOSTED_TARGET_POOLER_USER_INVALID')
    }
  })

  it('12. credential characters in the login role → REFUSED', () => {
    for (const bad of [
      `postgres.${STAGING}:hunter2`,
      `postgres.${STAGING}@host`,
      `postgres.${STAGING}/db`,
      `postgres.${STAGING} extra`,
    ]) {
      expect(codeOf(verify({ poolerUser: bad })), bad).toBe('HOSTED_TARGET_POOLER_USER_INVALID')
    }
  })

  // THE VETO OUTRANKS EVERYTHING, including a set of fields that is internally
  // perfect. Three agreeing signals are a reason to proceed; a production
  // identifier is a reason to stop.
  it('13. the production denylist wins over otherwise-flawless fields', () => {
    expect(
      codeOf(
        verify({
          declaredProjectRef: PROD,
          connectionHost: `db.${PROD}.supabase.co`,
          poolerUser: `postgres.${PROD}`,
          connectionPort: SESSION_POOLER_PORT,
          sentinel: { environment: 'staging', projectRef: PROD },
        }),
      ),
    ).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('14. an unknown but syntactically valid ref → REFUSED', () => {
    expect(codeOf(verify({ declaredProjectRef: UNKNOWN, poolerUser: `postgres.${UNKNOWN}` }))).toBe(
      'HOSTED_TARGET_NOT_EXPECTED_PROJECT',
    )
    expect(
      codeOf(
        verify({
          declaredProjectRef: UNKNOWN,
          connectionHost: `db.${UNKNOWN}.supabase.co`,
          poolerUser: null,
        }),
      ),
    ).toBe('HOSTED_TARGET_NOT_EXPECTED_PROJECT')
  })
})

describe('one contract, two mechanisms — the derivation itself', () => {
  it('names the mechanism and the sources that corroborated', () => {
    const pooler = deriveConnectionIdentity({ connectionHost: POOLER, poolerUser: `postgres.${STAGING}` })
    expect(pooler.ok && pooler.mechanism).toBe('session-pooler')
    expect(pooler.ok && pooler.corroboratedBy).toEqual(['pooler login role'])

    const direct = deriveConnectionIdentity({ connectionHost: `db.${STAGING}.supabase.co` })
    expect(direct.ok && direct.mechanism).toBe('direct-db')

    // Both sources present and agreeing is stronger, and says so.
    const both = deriveConnectionIdentity({
      connectionHost: `db.${STAGING}.supabase.co`,
      poolerUser: `postgres.${STAGING}`,
    })
    expect(both.ok && both.corroboratedBy).toEqual(['connection host', 'pooler login role'])
  })

  it('never derives a ref from a pooler hostname alone', () => {
    const v = deriveConnectionIdentity({ connectionHost: POOLER })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('HOSTED_TARGET_POOLER_USER_MISSING')
  })

  it('parses only the exact postgres.<ref> shape', () => {
    expect(projectRefFromPoolerUser(`postgres.${STAGING}`)).toBe(STAGING)
    expect(projectRefFromPoolerUser(`postgres.${STAGING}.extra`)).toBeNull()
    expect(projectRefFromPoolerUser('')).toBeNull()
  })

  it('pins to the one project, and the pin is injectable so it is falsifiable', () => {
    const otherProject = verifyStagingTarget(
      target({ declaredProjectRef: UNKNOWN, poolerUser: `postgres.${UNKNOWN}` }),
      KNOWN_PRODUCTION_IDENTIFIERS,
      'deferred-until-bootstrap',
      UNKNOWN,
    )
    expect(otherProject.ok, 'an injected pin must be able to accept its own project').toBe(true)
    // …and the DEFAULT pin is the real staging project, which is what production
    // callers get without asking.
    expect(codeOf(verify({ declaredProjectRef: UNKNOWN, poolerUser: `postgres.${UNKNOWN}` }))).toBe(
      'HOSTED_TARGET_NOT_EXPECTED_PROJECT',
    )
  })
})
