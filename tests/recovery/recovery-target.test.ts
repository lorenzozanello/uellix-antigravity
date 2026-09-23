// @vitest-environment node
// tests/recovery/recovery-target.test.ts — OR-P4, OR-N13 (production ref as
// target -> RED), OR-N14 (display name as identity -> RED).
//
// Every input here is SYNTHETIC and STRUCTURAL: nothing opens a connection. The
// production and staging refs are the repository's own pins
// (db/hosted/target-identity.ts); they are public in every URL their projects serve.

import { describe, expect, it } from 'vitest'

import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '../../db/hosted/target-identity'
import { hostedStagingIdentity } from '../../scripts/recovery/recovery-target'

const PROD = 'ctaxtgujyyprgynmnvtq'
const STAGING = KNOWN_STAGING_PROJECT_REF

const good = {
  declaredEnvironment: 'staging',
  declaredProjectRef: STAGING,
  connectionHost: `db.${STAGING}.supabase.co`,
  sentinel: { environment: 'staging', projectRef: STAGING },
}

describe('HOSTED_STAGING identity is derived only through verifyStagingTarget', () => {
  it('guards: the production pin is loaded and the staging pin is not vetoed', () => {
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).toContain(PROD)
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain(STAGING)
  })

  it('OR-P4: a structurally consistent staging selector yields the derived ref and all three signals', () => {
    const v = hostedStagingIdentity(good)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.identity).toEqual({
      identityClass: 'HOSTED_STAGING',
      projectRef: STAGING,
      signals: ['declared-environment', 'host-derived-project-ref', 'in-database-sentinel'],
      sentinelDeferred: false,
    })
  })

  it.each([
    ['declared ref', { ...good, declaredProjectRef: PROD }],
    ['host', { ...good, connectionHost: `db.${PROD}.supabase.co` }],
    ['pooler user', { ...good, connectionHost: 'aws-0-eu-west-1.pooler.supabase.com', connectionPort: 5432, poolerUser: `postgres.${PROD}` }],
    ['sentinel', { ...good, sentinel: { environment: 'staging', projectRef: PROD } }],
  ])('OR-N13: the production ref named by the %s is refused AS production', (_label, selector) => {
    const v = hostedStagingIdentity(selector)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe('RECOVERY_TARGET_IDENTITY_REFUSED')
    expect(v.identityCode).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('OR-N13: production is refused as production even when the selector ALSO carries a display name', () => {
    const v = hostedStagingIdentity({ ...good, declaredProjectRef: PROD, displayName: 'uellix-staging' })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.identityCode).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it.each([['displayName'], ['projectName'], ['name'], ['label'], ['Title'], ['slug']])(
    'OR-N14: a selector carrying %s is refused even when every structural signal is valid',
    (key) => {
      const v = hostedStagingIdentity({ ...good, [key]: 'Uellix Staging' })
      expect(v.ok).toBe(false)
      if (v.ok) return
      expect(v.code).toBe('RECOVERY_TARGET_SELECTED_BY_NAME')
    },
  )

  it.each([['uellix-staging'], ['Uellix Staging'], ['UELLIX-STAGING']])('OR-N14: the provider display name %j in the ref field is not an identifier', (name) => {
    const v = hostedStagingIdentity({ ...good, declaredProjectRef: name })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe('RECOVERY_TARGET_IDENTITY_REFUSED')
    expect(['HOSTED_TARGET_PROJECT_REF_INVALID', 'HOSTED_TARGET_PROJECT_REF_MISMATCH']).toContain(v.identityCode)
  })

  it('refuses unknown selector keys and non-objects', () => {
    expect(hostedStagingIdentity({ ...good, url: 'x' })).toMatchObject({ ok: false, code: 'RECOVERY_TARGET_UNKNOWN_SELECTOR_KEY' })
    expect(hostedStagingIdentity('bvyzblhqymxruxdguaee')).toMatchObject({ ok: false, code: 'RECOVERY_TARGET_SELECTOR_NOT_AN_OBJECT' })
  })

  it('a consistent identity for another project is still refused (the pin)', () => {
    const other = 'abcdefghijklmnopqrst'
    const v = hostedStagingIdentity({ ...good, declaredProjectRef: other, connectionHost: `db.${other}.supabase.co`, sentinel: { environment: 'staging', projectRef: other } })
    expect(v).toMatchObject({ ok: false, identityCode: 'HOSTED_TARGET_NOT_EXPECTED_PROJECT' })
  })
})
