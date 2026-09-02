// tests/hosted/target-identity.test.ts
// TRAIN 5B — Phase 7 and most of Phase 12.
//
// Every test here is an ATTACK. The happy path gets one case; the other
// twenty-odd are attempts to make a production connection pass as staging, and
// each one must fail CLOSED with a named code rather than a boolean.

import { describe, expect, it } from 'vitest'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  productionDenylistStatus,
  projectRefFromHost,
  redactForHostedLog,
  verifyStagingTarget,
  type HostedTargetInput,
} from '@/db/hosted/target-identity'

// THE REAL STAGING REF, not a placeholder.
//
// `verifyStagingTarget` is now PINNED to KNOWN_STAGING_PROJECT_REF: a
// syntactically valid ref for some OTHER project is refused, which is audit
// requirement 14. A fixture using a made-up ref would exercise only the
// refusal, so every positive path here would have stopped meaning anything.
const REF = 'bvyzblhqymxruxdguaee'
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

  // TRAIN 5C1 — P5 CLOSED. This test asserted the list was EMPTY for three
  // trains, deliberately, so that filling it would be an act with a failing test
  // behind it rather than something nobody noticed. The operator filled it from
  // the Supabase dashboard on 2026-08-07 and the assertion inverts.
  it('carries the production project ref, and it is well formed', () => {
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).toEqual(['ctaxtgujyyprgynmnvtq'])
    for (const ref of KNOWN_PRODUCTION_IDENTIFIERS.projectRefs) {
      expect(ref, 'a malformed entry never matches and is an absent veto').toMatch(/^[a-z]{20}$/)
    }
  })

  it('does NOT carry the staging ref, and the two are different projects', () => {
    // Putting the target in its own veto would refuse every provisioning
    // forever. This is the assertion that catches a paste of the wrong ref into
    // the right list — the concrete form of "no lo confundas con staging".
    expect(KNOWN_STAGING_PROJECT_REF).toBe('bvyzblhqymxruxdguaee')
    expect(KNOWN_STAGING_PROJECT_REF).toMatch(/^[a-z]{20}$/)
    expect(KNOWN_STAGING_PROJECT_REF).not.toBe(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0])
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain(KNOWN_STAGING_PROJECT_REF)
  })

  it('REFUSES the real production ref, with every other signal agreeing', () => {
    const prod = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'staging',
      declaredProjectRef: prod,
      connectionHost: `db.${prod}.supabase.co`,
      sentinel: { environment: 'staging', projectRef: prod },
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('ACCEPTS the real staging ref on all three positive signals', () => {
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'staging',
      declaredProjectRef: KNOWN_STAGING_PROJECT_REF,
      connectionHost: `db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`,
      sentinel: { environment: 'staging', projectRef: KNOWN_STAGING_PROJECT_REF },
    })
    expect(verdict.ok, verdict.ok ? '' : `${verdict.code}: ${verdict.message}`).toBe(true)
    if (verdict.ok) {
      expect(verdict.projectRef).toBe(KNOWN_STAGING_PROJECT_REF)
      expect(verdict.signals).toEqual([
        'declared-environment',
        'host-derived-project-ref',
        'in-database-sentinel',
      ])
      expect(verdict.sentinelDeferred).toBe(false)
    }
  })

  it('the veto now LOADS, so an apply is no longer refused for an empty denylist', () => {
    expect(productionDenylistStatus().loaded).toBe(true)
    expect(productionDenylistStatus().detail).toContain('1 production project ref')
  })

  it('still refuses the production ref if it arrives only through the SENTINEL', () => {
    const prod = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]
    const verdict = verifyStagingTarget({
      declaredEnvironment: 'staging',
      declaredProjectRef: KNOWN_STAGING_PROJECT_REF,
      connectionHost: `db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`,
      sentinel: { environment: 'staging', projectRef: prod },
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
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
      'failed against postgresql://uellix_migrator:not-a-real-password@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
    )

    expect(line).not.toContain('not-a-real-password')
    expect(line).not.toContain('uellix_migrator:')
    expect(line).not.toContain('postgresql://')
  })

  it('keeps the project ref, which is public in every URL the project serves', () => {
    const line = redactForHostedLog(`applying to db.${REF}.supabase.co`)
    expect(line).toContain(REF)
  })

  it('removes anything shaped like a JWT or an API key', () => {
    const line = redactForHostedLog(
      'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc and key sbp_notARealPersonalAccessToken00',
    )

    expect(line).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(line).not.toContain('sbp_notARealPersonalAccessToken00')
    expect(line).toContain('[redacted]')
  })

  it('removes a current-format Supabase secret key, not only the legacy sbp_ one', () => {
    // secret-scan-ok: synthetic key, this suite feeds it to the redactor on purpose
    const secret = 'sb_secret_AbCdEfGhIjKlMnOpQrStUvWx'
    const line = redactForHostedLog(`key ${secret} and sb_publishable_0123456789abcdefghij`)

    expect(line).not.toContain(secret)
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
