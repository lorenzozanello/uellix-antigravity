// tests/hosted/target-identity.test.ts
// TRAIN 5B — Phase 7 and most of Phase 12.
//
// Every test here is an ATTACK. The happy path gets one case; the other
// twenty-odd are attempts to make a production connection pass as staging, and
// each one must fail CLOSED with a named code rather than a boolean.

import { describe, expect, it } from 'vitest'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  projectRefFromHost,
  redactForHostedLog,
  verifyStagingTarget,
  type HostedTargetInput,
} from '@/db/hosted/target-identity'

const REF = 'abcdefghijklmnopqrst'
const OTHER_REF = 'zyxwvutsrqponmlkjihg'

function validInput(overrides: Partial<HostedTargetInput> = {}): HostedTargetInput {
  return {
    declaredEnvironment: 'staging',
    declaredProjectRef: REF,
    connectionHost: `db.${REF}.supabase.co`,
    sentinel: { environment: 'staging', projectRef: REF },
    ...overrides,
  }
}

describe('verifyStagingTarget — the one accepting case', () => {
  it('accepts when all three independent signals agree', () => {
    const verdict = verifyStagingTarget(validInput())

    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.projectRef).toBe(REF)
      expect(verdict.signals).toEqual([
        'declared-environment',
        'host-derived-project-ref',
        'in-database-sentinel',
      ])
    }
  })
})

describe('verifyStagingTarget — environment', () => {
  it.each([
    ['production', 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'],
    ['Staging', 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'],
    ['staging ', 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'],
    ['', 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'],
    ['prod', 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'],
  ])('refuses declaredEnvironment=%o', (env, code) => {
    const verdict = verifyStagingTarget(validInput({ declaredEnvironment: env }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe(code)
  })
})

describe('verifyStagingTarget — project ref', () => {
  it('refuses a malformed ref rather than trusting the operator typed it right', () => {
    const verdict = verifyStagingTarget(validInput({ declaredProjectRef: 'too-short' }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_PROJECT_REF_INVALID')
  })

  it('refuses when the host names a DIFFERENT project than the operator declared', () => {
    const verdict = verifyStagingTarget(
      validInput({ connectionHost: `db.${OTHER_REF}.supabase.co` }),
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_PROJECT_REF_MISMATCH')
  })

  it('refuses a host it cannot derive a ref from — an unparseable host is an ambiguous target', () => {
    const verdict = verifyStagingTarget(validInput({ connectionHost: 'db.example.com' }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_HOST_NOT_SUPABASE')
  })

  it('refuses a loopback host — this runner is for hosted targets, and local has its own path', () => {
    const verdict = verifyStagingTarget(validInput({ connectionHost: '127.0.0.1' }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_HOST_NOT_SUPABASE')
  })
})

describe('verifyStagingTarget — the in-database sentinel', () => {
  it('refuses when the sentinel is absent — a connection string can be pasted from the wrong tab', () => {
    const verdict = verifyStagingTarget(validInput({ sentinel: null }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_SENTINEL_MISSING')
  })

  it('refuses when the sentinel names a different project than the host does', () => {
    const verdict = verifyStagingTarget(
      validInput({ sentinel: { environment: 'staging', projectRef: OTHER_REF } }),
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_SENTINEL_MISMATCH')
  })

  it('refuses when the sentinel itself says production, however the operator declared it', () => {
    const verdict = verifyStagingTarget(
      validInput({ sentinel: { environment: 'production', projectRef: REF } }),
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_SENTINEL_NOT_STAGING')
  })
})

describe('verifyStagingTarget — explicit production rejection', () => {
  it('refuses a ref on the known-production list even when every other signal is forged', () => {
    const prodRef = 'pppppppppppppppppppp'
    const verdict = verifyStagingTarget(
      {
        declaredEnvironment: 'staging',
        declaredProjectRef: prodRef,
        connectionHost: `db.${prodRef}.supabase.co`,
        sentinel: { environment: 'staging', projectRef: prodRef },
      },
      { hosts: [], projectRefs: [prodRef] },
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('refuses a SENTINEL naming a production ref, even when the declaration names another', () => {
    const prodRef = 'pppppppppppppppppppp'
    const verdict = verifyStagingTarget(validInput({ sentinel: { environment: 'staging', projectRef: prodRef } }), {
      hosts: [],
      projectRefs: [prodRef],
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('ships with an EMPTY projectRefs list, and that is a provisioning requirement, not an oversight', () => {
    // The production Supabase project ref is not in the repository — Train 5A
    // searched for it and found nothing. An empty list removes a VETO; it never
    // removes a gate, because the three positive signals are required anyway.
    // This test exists so that filling the list is a deliberate act with a
    // failing test behind it, rather than something nobody notices is missing.
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).toEqual([])
  })

  it('refuses a host on the known-production list', () => {
    const verdict = verifyStagingTarget(
      validInput({ connectionHost: KNOWN_PRODUCTION_IDENTIFIERS.hosts[0] }),
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('checks production BEFORE anything else — a forged sentinel must not get a softer code', () => {
    const prodHost = KNOWN_PRODUCTION_IDENTIFIERS.hosts[0]
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'production',
      declaredProjectRef: 'nope',
      connectionHost: prodHost,
      sentinel: null,
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('ships with the production Vercel origin already listed — Train 5A found it in lib/site.ts', () => {
    expect(KNOWN_PRODUCTION_IDENTIFIERS.hosts).toContain('uellix-antigravity.vercel.app')
  })
})

describe('projectRefFromHost', () => {
  it.each([
    [`db.${REF}.supabase.co`, REF],
    [`aws-0-us-east-1.pooler.supabase.com`, null],
    [`${REF}.supabase.co`, REF],
    ['localhost', null],
    ['', null],
  ])('%s -> %s', (host, expected) => {
    expect(projectRefFromHost(host)).toBe(expected)
  })
})

describe('redactForHostedLog — no refusal may leak a credential', () => {
  it('removes a whole connection string', () => {
    const line = redactForHostedLog(
      'failed against postgresql://uellix_migrator:hunter2@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
    )

    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('uellix_migrator:')
    expect(line).not.toContain('postgresql://')
  })

  it('keeps the project ref, which is public in every URL the project serves', () => {
    const line = redactForHostedLog(`applying to db.${REF}.supabase.co`)
    expect(line).toContain(REF)
  })

  it('removes anything shaped like a JWT or an API key', () => {
    const line = redactForHostedLog(
      'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc and key sbp_0123456789abcdef0123456789abcdef01234567',
    )

    expect(line).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(line).not.toContain('sbp_0123456789abcdef0123456789abcdef01234567')
    expect(line).toContain('[redacted]')
  })

  it('removes a current-format Supabase secret key, not only the legacy sbp_ one', () => {
    const line = redactForHostedLog('key sb_secret_AbCdEfGhIjKlMnOpQrStUvWx and sb_publishable_0123456789abcdefghij')

    expect(line).not.toContain('sb_secret_AbCdEfGhIjKlMnOpQrStUvWx')
    expect(line).not.toContain('sb_publishable_0123456789abcdefghij')
  })

  it('removes a libpq keyword/value DSN password, which carries no :// to match on', () => {
    const line = redactForHostedLog('host=db.x.supabase.co user=uellix_migrator password=hunter2 sslmode=require')

    expect(line).not.toContain('hunter2')
  })

  it('BOUNDS the echo of an operator value — a whole mispasted DSN must not be quoted back', () => {
    const dsn = 'host=db.abcdefghijklmnopqrst.supabase.co user=uellix_migrator password=hunter2 sslmode=require'
    const verdict = verifyStagingTarget(validInput({ declaredEnvironment: dsn }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.message).not.toContain('hunter2')
      expect(verdict.message).toContain('truncated')
    }
  })

  it('is applied to every refusal message this module produces', () => {
    const verdict = verifyStagingTarget(
      validInput({ connectionHost: 'postgresql://u:p@db.example.com/postgres' }),
    )

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.message).not.toContain('u:p')
      expect(verdict.message).not.toContain('postgresql://')
    }
  })
})
