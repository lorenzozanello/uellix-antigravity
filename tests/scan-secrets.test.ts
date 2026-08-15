// tests/scan-secrets.test.ts
//
// The gate added after the 2026-08-15 credential incident, under attack.
//
// A secret scanner fails in two directions and only one of them is loud. If it
// misses a real credential nothing happens — which is precisely what happened
// between `782ac5f` and the rotation six weeks later. If it flags the hostile
// DSNs that `db/safety/` exists to classify, it gets switched off inside a week
// and then misses the real one anyway. So the cases below come in pairs: the
// production-shaped literal MUST be caught, and its fixture-shaped twin MUST
// NOT be, and the difference between them has to be the host and nothing else.
//
// The literals here are synthetic. The one real identifier is the Production
// project ref, which is read from `KNOWN_PRODUCTION_IDENTIFIERS` rather than
// retyped: a ref is public (it appears in every URL the project serves), and a
// test that hardcodes its own copy stops testing the list it is meant to guard.

import { describe, expect, it } from 'vitest'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
} from '@/db/hosted/target-identity'
import {
  assertAllowlistIsSynthetic,
  isSyntheticHost,
  scanText,
} from '@/scripts/scan-secrets'

/** Not a credential: 16 chars of keyboard mash, never issued anywhere. */
const FAKE_PASSWORD = 'Zq7pLm2xVn4tRb8w'
const PROD_REF = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!
const PROD_HOST = `db.${PROD_REF}.supabase.co`

describe('scanText — a DSN aimed at real infrastructure', () => {
  it('catches the exact shape that leaked on 2026-07-06', () => {
    const findings = scanText(
      `- \`.env\` contains: \`postgres://postgres:${FAKE_PASSWORD}@${PROD_HOST}\``,
      'docs/whatever.md'
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('PG_DSN_EMBEDDED_PASSWORD')
    expect(findings[0]!.line).toBe(1)
  })

  it('catches it on the Session Pooler host too, which carries no project ref', () => {
    const findings = scanText(
      `DATABASE_URL=postgresql://postgres.${PROD_REF}:${FAKE_PASSWORD}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
      '.env.example'
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('PG_DSN_EMBEDDED_PASSWORD')
  })

  it('catches a DSN aimed at the staging project, which is not exempt either', () => {
    const findings = scanText(
      `postgres://uellix_migrator:${FAKE_PASSWORD}@db.${KNOWN_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
      'docs/ops/notes.md'
    )

    expect(findings).toHaveLength(1)
  })

  it('reports an unrecognised host rather than waving it through', () => {
    // The 2026-07-06 host was unrecognised by everything in the repository at
    // the time. A gate that fails open on the unfamiliar would have said nothing.
    const findings = scanText(
      `postgres://admin:${FAKE_PASSWORD}@db.some-vendor-we-never-heard-of.io:5432/app`,
      'docs/whatever.md'
    )

    expect(findings).toHaveLength(1)
  })
})

describe('scanText — the fixtures this repository keeps on purpose', () => {
  const fixtures: readonly [string, string][] = [
    ['loopback', `postgresql://uellix_app:${FAKE_PASSWORD}@127.0.0.1:54322/postgres`],
    ['localhost', `postgresql://uellix_app:${FAKE_PASSWORD}@localhost:5432/postgres`],
    ['RFC 2606 name', `postgresql://admin:${FAKE_PASSWORD}@db.example.com:5432/postgres`],
    ['hostile failover list', `postgresql://127.0.0.1:${FAKE_PASSWORD}@evil.example.com,127.0.0.1/postgres`],
    ['unexpanded template', 'postgresql://uellix_app:pw@127.0.0.1:${LOCAL_DB_PORT}/postgres'],
    ['synthetic supabase ref', `postgresql://postgres:${FAKE_PASSWORD}@db.x.supabase.co:5432/postgres`],
    ['single-label stub host', `postgresql://postgres:${FAKE_PASSWORD}@h:5432/postgres`],
    ['placeholder password', `postgresql://postgres:[YOUR-PASSWORD]@${PROD_HOST}:5432/postgres`],
  ]

  for (const [name, dsn] of fixtures) {
    it(`stays quiet about a ${name}`, () => {
      expect(scanText(dsn, 'tests/whatever.test.ts')).toEqual([])
    })
  }

  it('separates fixture from real by the HOST alone', () => {
    // Same user, same password, same everything but the host.
    const fixture = `postgresql://postgres:${FAKE_PASSWORD}@db.x.supabase.co:5432/postgres`
    const real = `postgresql://postgres:${FAKE_PASSWORD}@${PROD_HOST}:5432/postgres`

    expect(scanText(fixture, 'f.ts')).toEqual([])
    expect(scanText(real, 'f.ts')).toHaveLength(1)
  })
})

describe('scanText — the output must not become a second copy of the secret', () => {
  it('never emits the value, in any field of the finding', () => {
    const findings = scanText(
      `postgres://postgres:${FAKE_PASSWORD}@${PROD_HOST}`,
      'docs/whatever.md'
    )
    const serialised = JSON.stringify(findings)

    expect(findings).toHaveLength(1)
    expect(serialised).not.toContain(FAKE_PASSWORD)
    // Nor any run long enough to be worth guessing from.
    for (let i = 0; i + 6 <= FAKE_PASSWORD.length; i += 1) {
      expect(serialised).not.toContain(FAKE_PASSWORD.slice(i, i + 6))
    }
  })

  it('keeps the non-secret context, which is what makes the failure actionable', () => {
    const findings = scanText(
      `postgres://postgres:${FAKE_PASSWORD}@${PROD_HOST}`,
      'docs/whatever.md'
    )

    expect(findings[0]!.context).toContain(PROD_HOST)
    expect(findings[0]!.context).toContain('user=postgres')
  })

  it('fingerprints identically for identical values and differently otherwise', () => {
    const one = scanText(`postgres://a:${FAKE_PASSWORD}@${PROD_HOST}`, 'x.md')[0]!
    const two = scanText(`postgres://b:${FAKE_PASSWORD}@${PROD_HOST}`, 'y.md')[0]!
    const other = scanText(`postgres://a:Different0Value9@${PROD_HOST}`, 'x.md')[0]!

    expect(one.fingerprint).toHaveLength(12)
    expect(one.fingerprint).toBe(two.fingerprint)
    expect(one.fingerprint).not.toBe(other.fingerprint)
  })
})

describe('scanText — the other credential kinds', () => {
  it('catches a Google API key', () => {
    const findings = scanText(`GEMINI_API_KEY=AIza${'B'.repeat(35)}`, '.env.example')
    expect(findings.map((f) => f.kind)).toEqual(['GOOGLE_API_KEY'])
  })

  it('catches a current-format Supabase secret key', () => {
    const findings = scanText(`key sb_secret_${'c'.repeat(24)}`, 'docs/x.md')
    expect(findings.map((f) => f.kind)).toEqual(['SUPABASE_SECRET_KEY'])
  })

  it('catches a private key block', () => {
    const findings = scanText('-----BEGIN RSA PRIVATE KEY-----', 'docs/x.md')
    expect(findings.map((f) => f.kind)).toEqual(['PRIVATE_KEY_BLOCK'])
  })

  it('ignores a publishable key, which is public by design', () => {
    expect(scanText(`sb_publishable_${'0'.repeat(20)}`, 'docs/x.md')).toEqual([])
  })
})

describe('the secret-scan-ok annotation', () => {
  const line = `key sb_secret_${'d'.repeat(24)}`

  it('suppresses on the same line when a reason is given', () => {
    expect(scanText(`${line} // secret-scan-ok: fixture for the redactor`, 'f.ts')).toEqual([])
  })

  it('suppresses on the line immediately above', () => {
    expect(scanText(`// secret-scan-ok: fixture\n${line}`, 'f.ts')).toEqual([])
  })

  it('does NOT suppress without a reason', () => {
    expect(scanText(`${line} // secret-scan-ok:`, 'f.ts')).toHaveLength(1)
  })

  it('does NOT reach two lines down, so a suppression cannot drift', () => {
    expect(scanText(`// secret-scan-ok: fixture\n\n${line}`, 'f.ts')).toHaveLength(1)
  })
})

describe('assertAllowlistIsSynthetic — the guard on the guard', () => {
  it('passes for the allowlist as committed', () => {
    expect(() => assertAllowlistIsSynthetic()).not.toThrow()
  })

  it('rejects every real project ref as a synthetic host', () => {
    for (const ref of KNOWN_PRODUCTION_IDENTIFIERS.projectRefs) {
      expect(isSyntheticHost(`db.${ref}.supabase.co`)).toBe(false)
    }
    expect(isSyntheticHost(`db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`)).toBe(false)
  })

  it('rejects every known production host', () => {
    for (const host of KNOWN_PRODUCTION_IDENTIFIERS.hosts) {
      expect(isSyntheticHost(host)).toBe(false)
    }
  })

  it('does not accept a lookalike of a reserved name', () => {
    // The bug class `ci-assert-local-targets.ts` was written to remove: a
    // substring check accepts an attacker-controlled host that merely contains
    // a reserved one.
    expect(isSyntheticHost('db.example.com.attacker.io')).toBe(false)
    expect(isSyntheticHost('localhost.attacker.example.io')).toBe(false)
  })
})
