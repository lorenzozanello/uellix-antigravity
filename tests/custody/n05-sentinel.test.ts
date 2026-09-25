// tests/custody/n05-sentinel.test.ts
//
// SENTINEL CONFORMANCE, AND THE POSITIVE EXERCISE OF THE REPOSITORY SECRET
// SCANNER AGAINST IT.
//
// The N05 test manifest's NN11 requires the scanner to be shown FIRING on a
// correctly shaped sentinel, not merely shown passing on a clean write set:
// without the first half, ES-5's claim is an inference about a regular
// expression rather than a measured fact. Its paired mutant NM12 is a sentinel
// carrying a fixture marker in its own body, which the scanner suppresses —
// and the manifest is explicit that the RED must be attributed to the sentinel
// and not to the scanner.
//
// Both are exercised here, in memory, against the scanner's own exported
// `scanText`. No sentinel is written to disk by this file and none appears in
// its source.

import { describe, expect, it } from 'vitest'

import { scanText, isUnmistakablePlaceholder } from '@/scripts/scan-secrets'
import {
  AUDITOR_ENV_VAR_NAME,
  SENTINEL_TARGET_PREFIX,
  describeSentinelConformance,
  generateSentinel,
} from '@/scripts/custody/n05-sentinel'

describe('the sentinel conforms to SP-1 and SP-4', () => {
  it('is shaped like the real value: a connection string carrying userinfo', () => {
    const s = generateSentinel()
    const c = describeSentinelConformance(s.value.toString('utf8'))
    s.value.fill(0)
    expect(c.dsnShaped).toBe(true)
    expect(c.carriesUserinfo).toBe(true)
  })

  it('has a password the scanner will not suppress', () => {
    const s = generateSentinel()
    const c = describeSentinelConformance(s.value.toString('utf8'))
    s.value.fill(0)
    expect(c.passwordAtLeastSixChars).toBe(true)
    expect(c.passwordCarriesNoFixtureMarker).toBe(true)
  })

  it('points at a host that can never resolve', () => {
    const s = generateSentinel()
    const c = describeSentinelConformance(s.value.toString('utf8'))
    s.value.fill(0)
    expect(c.hostIsUnresolvable).toBe(true)
  })

  it('is freshly generated per call, so a later match cannot be a stale leak', () => {
    const a = generateSentinel()
    const b = generateSentinel()
    expect(a.value.equals(b.value)).toBe(false)
    expect(a.target).not.toBe(b.target)
    a.value.fill(0)
    b.value.fill(0)
  })

  it('lives under the reserved target prefix, which bounds what a sweep may delete', () => {
    const s = generateSentinel()
    s.value.fill(0)
    expect(s.target.startsWith(SENTINEL_TARGET_PREFIX)).toBe(true)
  })

  it('declares the role the real consumer requires, so the real consumer accepts it', () => {
    const s = generateSentinel()
    s.value.fill(0)
    expect(s.username).toBe('uellix_auditor')
  })
})

describe('NN11: the repository secret scanner FIRES on the sentinel', () => {
  it('reports a PG_DSN_EMBEDDED_PASSWORD finding', () => {
    const s = generateSentinel()
    const findings = scanText(s.value.toString('utf8'), 'in-memory-sentinel-probe')
    s.value.fill(0)
    expect(findings.map((f) => f.kind)).toContain('PG_DSN_EMBEDDED_PASSWORD')
  })

  it('reports it over a hundred independently generated sentinels', () => {
    // A single draw could pass by luck. The generator rejects a password the
    // scanner would suppress, and this is the control that proves the
    // rejection loop is doing something rather than decorating the function.
    for (let i = 0; i < 100; i += 1) {
      const s = generateSentinel()
      const findings = scanText(s.value.toString('utf8'), 'probe')
      s.value.fill(0)
      expect(findings.length).toBeGreaterThan(0)
    }
  })

  it('never reports the value itself, only a fingerprint and a shape', () => {
    const s = generateSentinel()
    const raw = s.value.toString('utf8')
    const findings = scanText(raw, 'probe')
    s.value.fill(0)
    for (const f of findings) {
      expect(JSON.stringify(f)).not.toContain(raw)
    }
  })
})

describe('NM12: a fixture marker in the password makes the sentinel invisible', () => {
  // The mutant, reproduced so the failure mode is documented as a measured
  // fact. The RED belongs to the SENTINEL, not to the scanner: the scanner is
  // working exactly as written, and the sentinel has quietly stopped being a
  // faithful stand-in for the value it represents.
  it.each(['not-a-real', 'placeholder', 'example', 'sample', 'fake', 'synthetic', 'dummy', 'fixture', 'redacted'])(
    'a password containing %s is suppressed and the scanner reports nothing',
    (marker) => {
      // The password is the loop variable plus filler. Hardcoding a second,
      // literal marker to satisfy the scanner would make every iteration carry
      // the same one, and the test would stop proving that EACH of the nine
      // suppresses independently. The scanner cannot see through the
      // interpolation, so the exact bytes are load-bearing and the line is
      // annotated instead. The annotation covers only itself and the line
      // below, which is why it sits directly above the literal.
      // secret-scan-ok: marker is the loop variable; a literal one would collapse the nine cases into one
      const mutant = `postgresql://uellix_auditor:${marker}Abcdef123@n05-sentinel.invalid:5432/n05_sentinel`
      expect(isUnmistakablePlaceholder(`${marker}Abcdef123`)).toBe(true)
      expect(scanText(mutant, 'probe').map((f) => f.kind)).not.toContain(
        'PG_DSN_EMBEDDED_PASSWORD'
      )
    }
  )

  it('a password under six characters is suppressed too', () => {
    const mutant = 'postgresql://uellix_auditor:Ab3z@n05-sentinel.invalid:5432/n05_sentinel'
    expect(scanText(mutant, 'probe').map((f) => f.kind)).not.toContain('PG_DSN_EMBEDDED_PASSWORD')
  })

  it('the conformance predicate is capable of returning false, on each property', () => {
    // A predicate exercised only where it is expected to pass has proven
    // nothing about itself — RC-6's lesson, applied to the checker rather than
    // to the check.
    const notDsn = describeSentinelConformance('this is not a connection string')
    expect(notDsn.dsnShaped).toBe(false)
    expect(notDsn.carriesUserinfo).toBe(false)
    expect(notDsn.passwordAtLeastSixChars).toBe(false)
    expect(notDsn.passwordCarriesNoFixtureMarker).toBe(false)
    expect(notDsn.hostIsUnresolvable).toBe(false)

    const resolvableHost = describeSentinelConformance(
      'postgresql://uellix_auditor:not-a-real-password@db.example.com:5432/x'
    )
    expect(resolvableHost.dsnShaped).toBe(true)
    expect(resolvableHost.hostIsUnresolvable).toBe(false)

    const markedPassword = describeSentinelConformance(
      'postgresql://uellix_auditor:dummyAbcdef@n05-sentinel.invalid:5432/x'
    )
    expect(markedPassword.passwordCarriesNoFixtureMarker).toBe(false)
  })
})

describe('the delivery target name is the real one', () => {
  it('matches the variable the auditor consumer reads', () => {
    // ES-3 measured that this is the one and only delivery target. A
    // demonstration against any other name would prove delivery into a
    // variable nothing consults.
    expect(AUDITOR_ENV_VAR_NAME).toBe('UELLIX_AUDITOR_DATABASE_URL')
  })
})
