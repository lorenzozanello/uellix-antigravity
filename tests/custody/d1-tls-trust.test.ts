// tests/custody/d1-tls-trust.test.ts
//
// OT-18 / OT-19 ON REAL TLS (owner decision TLS_TRUST_POLICY =
// VERIFY_FULL_PINNED_CA; manifest amendment v1.0.2 R3-P-TLS, R3-N-TLS-*,
// R3-M-TLS-*). The trust text both tool templates render is evaluated as is
// and handed to the REAL postgres.js, against a fake PostgreSQL on loopback
// that asks for a cleartext password after TLS (the impostor move the
// recertification of fa43b396 measured against ssl 'require').

import { describe, expect, it } from 'vitest'

import { TLS_SCENARIOS, expectedOutcome, runTlsTrustScenario, tlsOutcomeReasons, trustPreflightRefusal, type TlsScenario } from '@/scripts/custody/d1-tls-trust-harness'
import type { TrustVariant } from './support/tool-trust-snippet'

const ROOT = process.cwd()

describe('R3-P-TLS / R3-N-TLS: the conforming trust text, scenario by scenario', () => {
  it.each(TLS_SCENARIOS)('%s', async (scenario) => {
    const o = await runTlsTrustScenario(ROOT, 'CONFORMING', scenario)
    expect(tlsOutcomeReasons(o), JSON.stringify(o)).toEqual([])
    expect(o.outcome).toBe(expectedOutcome(scenario))
  })
  it('the refusals name their cause, and TLS rejections are the certificate errors', async () => {
    expect((await runTlsTrustScenario(ROOT, 'CONFORMING', 'CA_MISSING')).code).toBe('CA_FILE_MISSING')
    expect((await runTlsTrustScenario(ROOT, 'CONFORMING', 'CA_MODIFIED')).code).toBe('CA_PIN_MISMATCH')
    expect((await runTlsTrustScenario(ROOT, 'CONFORMING', 'AMBIENT_ENV')).code).toBe('AMBIENT_ENVIRONMENT')
    expect((await runTlsTrustScenario(ROOT, 'CONFORMING', 'WRONG_HOSTNAME')).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    expect((await runTlsTrustScenario(ROOT, 'CONFORMING', 'EXPIRED')).code).toBe('CERT_HAS_EXPIRED')
  })
})

describe('R3-M-TLS: each variant that breaks one guarantee is caught on real TLS', () => {
  // [variant, the scenario where it misbehaves, what goes wrong]
  const cases: Array<[TrustVariant, TlsScenario, RegExp]> = [
    // The recertification's finding: 'require' encrypts but authenticates nobody -> an impostor harvests the password.
    ['TLS_REQUIRE', 'WRONG_CA', /REACHED, expected REJECTED|password reached an unauthenticated server/],
    ['TLS_NO_VERIFY', 'WRONG_CA', /REACHED, expected REJECTED/],
    ['TLS_NO_VERIFY', 'EXPIRED', /REACHED, expected REJECTED/],
    ['TLS_NO_HOSTNAME', 'WRONG_HOSTNAME', /REACHED, expected REJECTED/],
    // Without `ca` the system store decides: the pinned project CA is not what anchors the session.
    ['TLS_SYSTEM_TRUST', 'PERMITTED', /REJECTED, expected REACHED|anchor is not the pinned CA/],
    ['NO_CA_PIN_CHECK', 'CA_MODIFIED', /expected REFUSED/],
    ['NO_AMBIENT_ENV_CHECK', 'AMBIENT_ENV', /expected REFUSED/],
  ]
  it.each(cases)('%s under %s', async (variant, scenario, why) => {
    const o = await runTlsTrustScenario(ROOT, variant, scenario)
    expect(tlsOutcomeReasons(o).join(' | ')).toMatch(why)
  })
  it('the impostor measurement itself: under ssl require the cleartext password reaches a server holding no pinned certificate', async () => {
    const o = await runTlsTrustScenario(ROOT, 'TLS_REQUIRE', 'WRONG_CA')
    expect(o.server.passwordsReceived).toBe(1)
    const c = await runTlsTrustScenario(ROOT, 'CONFORMING', 'WRONG_CA')
    expect(c.server.passwordsReceived).toBe(0)
  })
})

describe('R4-N-O456: every OT-19 alternative refuses ALONE, in upper and in lower case', () => {
  // Each name is one alternative of the pattern (and several shapes of the PG* one), so a regex that loses the
  // i flag, narrows PG* or drops one alternative lets at least one of these through.
  const NAMES = [
    'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGOPTIONS', 'PGSERVICE', 'PGSSLMODE', 'PGAPPNAME', 'PGTARGETSESSIONATTRS', 'PGCONNECT_TIMEOUT', 'PG2',
    'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF', 'OPENSSL_MODULES',
  ]
  it.each(NAMES.flatMap((n) => [[n], [n.toLowerCase()]]))('%s', (name) => {
    expect(trustPreflightRefusal('CONFORMING', { PATH: '/bin', [name]: 'hostile' })).toBe('AMBIENT_ENVIRONMENT')
  })
  it('and nothing else is refused (the control passes with only the allowlisted variables)', () => {
    expect(trustPreflightRefusal('CONFORMING', { PATH: '/bin', SystemRoot: 'C:/Windows', TEMP: '/t', MY_PGHOST: 'x', NODEPATH: 'x' })).toBeNull()
  })
})
