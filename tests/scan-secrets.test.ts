// tests/scan-secrets.test.ts
//
// The gate added after the 2026-08-15 credential incident, under attack.
//
// A secret scanner fails in two directions and only one of them is loud. If it
// misses a real credential nothing happens — which is precisely what happened
// between `782ac5f` and the rotation six weeks later. If it flags the DSNs a
// repository legitimately keeps — in runbooks, in `.env` templates, in tests —
// it gets switched off inside a week and then misses the real one anyway.
//
// The first version resolved that tension on the HOSTNAME, and this suite
// asserted it: "the difference between them has to be the host and nothing
// else". Independent review showed that was backwards — it let the public half
// of a credential vouch for the secret half, so sanitising a leaked DSN's
// hostname while keeping its password produced a clean scan. The cases below
// now pin the opposite rule: the CREDENTIAL decides, the host only describes.
//
// The literals here are synthetic. Two conventions keep this file honest
// against its own gate, which no longer exempts it:
//
//   - every DSN password is interpolated, so the SOURCE carries `${...}` and
//     only the RUNTIME string carries something credential-shaped;
//   - the Supabase token fixtures are BUILT rather than written, so this file
//     never contains a literal that GitHub Push Protection would flag — the
//     rejection that prompted the detector in the first place.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  assertAllowlistIsSynthetic,
  isSyntheticHost,
  isUnmistakablePlaceholder,
  scanText,
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
} from '@/scripts/scan-secrets'

/** Not a credential: 16 chars of keyboard mash, never issued anywhere. */
const FAKE_PASSWORD = 'Zq7pLm2xVn4tRb8w'
/** A second one, for the "different values fingerprint differently" case. */
const OTHER_PASSWORD = 'Rk4mDx9wTb2nQz6v'
const PROD_REF = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!
const PROD_HOST = `db.${PROD_REF}.supabase.co`

/**
 * A Supabase personal access token's exact shape — `sbp_` and forty hex —-
 * assembled at runtime.
 *
 * Written out as one literal this file would be unpushable: GH013 is what
 * started this. Assembling it proves the detector fires on the shape without
 * ever placing the shape in a blob.
 */
const PAT_BODY = `${'0123456789abcdef'.repeat(2)}01234567`
const PAT_SHAPED = `sbp_${PAT_BODY}`

describe('scanText — a DSN whose password is real-looking', () => {
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
    const findings = scanText(
      `postgres://admin:${FAKE_PASSWORD}@db.some-vendor-we-never-heard-of.io:5432/app`,
      'docs/whatever.md'
    )

    expect(findings).toHaveLength(1)
  })
})

describe('scanText — the hostname describes, it does not decide', () => {
  // The Fable H2 finding, as regression cases. Every one of these passed
  // silently under the first design: a real password kept its entropy while
  // the host was sanitised into something that cannot resolve.
  const cloaked: readonly (readonly [string, string])[] = [
    ['loopback', `postgresql://uellix_app:${FAKE_PASSWORD}@127.0.0.1:54322/postgres`],
    ['localhost', `postgresql://uellix_app:${FAKE_PASSWORD}@localhost:5432/postgres`],
    ['an RFC 2606 name', `postgresql://admin:${FAKE_PASSWORD}@db.example.com:5432/postgres`],
    ['a listed synthetic ref', `postgresql://postgres:${FAKE_PASSWORD}@db.x.supabase.co:5432/postgres`],
    ['a single-label stub', `postgresql://postgres:${FAKE_PASSWORD}@h:5432/postgres`],
    // The nastiest of them: the REAL production host, cloaked by a reserved suffix.
    ['the real ref under a reserved suffix', `postgresql://postgres:${FAKE_PASSWORD}@${PROD_HOST}.example:5432/postgres`],
  ]

  for (const [label, dsn] of cloaked) {
    it(`still reports a real-looking password on ${label}`, () => {
      expect(scanText(dsn, 'tests/whatever.test.ts')).toHaveLength(1)
    })
  }

  it('labels the unreachable host without excusing it', () => {
    const [finding] = scanText(
      `postgresql://postgres:${FAKE_PASSWORD}@db.x.supabase.co:5432/postgres`,
      'f.ts'
    )

    expect(finding!.context).toContain('host cannot resolve')
  })
})

describe('scanText — what a fixture must now look like', () => {
  const quiet: readonly (readonly [string, string])[] = [
    // The credential says what it is, so the host is irrelevant — including
    // when the host is Production itself.
    ['a marker in the password', `postgresql://uellix_app:not-a-real-password@${PROD_HOST}:5432/postgres`],
    ['a bracketed placeholder', `postgresql://postgres:[YOUR-PASSWORD]@${PROD_HOST}:5432/postgres`],
    ['an unexpanded template', 'postgresql://uellix_app:${DB_PASSWORD}@db.example.com:5432/postgres'],
    ['a value too short to be a secret', 'postgresql://uellix_app:pw@127.0.0.1:54322/postgres'],
  ]

  for (const [label, dsn] of quiet) {
    it(`stays quiet about ${label}`, () => {
      expect(scanText(dsn, 'tests/whatever.test.ts')).toEqual([])
    })
  }

  it('separates fixture from real by the CREDENTIAL, the host held constant', () => {
    const host = `${PROD_HOST}:5432/postgres`

    expect(scanText(`postgresql://postgres:not-a-real-password@${host}`, 'f.ts')).toEqual([])
    expect(scanText(`postgresql://postgres:${FAKE_PASSWORD}@${host}`, 'f.ts')).toHaveLength(1)
  })

  it('recognises a marker anywhere in the value, and nothing else', () => {
    expect(isUnmistakablePlaceholder('not-a-real-password')).toBe(true)
    expect(isUnmistakablePlaceholder('placeholder-value-here')).toBe(true)
    expect(isUnmistakablePlaceholder('${SOME_TEMPLATE}')).toBe(true)
    expect(isUnmistakablePlaceholder(FAKE_PASSWORD)).toBe(false)
    expect(isUnmistakablePlaceholder(PAT_SHAPED)).toBe(false)
  })
})

describe('scanText — Supabase personal access tokens, the GH013 parity gap', () => {
  it('refuses an unannotated token in TypeScript', () => {
    const findings = scanText(`const token = '${PAT_SHAPED}'`, 'lib/supabase/admin.ts')

    expect(findings.map((f) => f.kind)).toEqual(['SUPABASE_PERSONAL_ACCESS_TOKEN'])
  })

  it('refuses one in Markdown', () => {
    const findings = scanText(`Run it with \`${PAT_SHAPED}\`.`, 'docs/ops/runbook.md')

    expect(findings.map((f) => f.kind)).toEqual(['SUPABASE_PERSONAL_ACCESS_TOKEN'])
  })

  it('refuses one in env syntax', () => {
    const findings = scanText(`SUPABASE_ACCESS_TOKEN=${PAT_SHAPED}`, '.env.example')

    expect(findings.map((f) => f.kind)).toEqual(['SUPABASE_PERSONAL_ACCESS_TOKEN'])
  })

  it('refuses a truncated copy, which GitHub’s stricter 40-hex shape would miss', () => {
    const truncated = PAT_SHAPED.slice(0, 4 + 24)

    expect(scanText(`key ${truncated}`, 'docs/x.md')).toHaveLength(1)
  })

  it('permits a deliberate fixture carrying a reason', () => {
    const line = `const token = '${PAT_SHAPED}' // secret-scan-ok: synthetic, feeds the redactor`

    expect(scanText(line, 'tests/some-suite.test.ts')).toEqual([])
  })

  it('does NOT permit one whose annotation carries no reason', () => {
    const line = `const token = '${PAT_SHAPED}' // secret-scan-ok:`

    expect(scanText(line, 'tests/some-suite.test.ts')).toHaveLength(1)
  })

  it('permits a placeholder-bodied token, the shape a fixture should use instead', () => {
    expect(scanText("const token = 'sbp_notARealPersonalAccessToken00'", 'f.ts')).toEqual([])
  })

  it('does not exempt a path merely for being a test', () => {
    // The rule the GH013 rejection turned on: the flagged literals were in a
    // test file, and a directory-wide exemption would have hidden them.
    expect(scanText(`const t = '${PAT_SHAPED}'`, 'tests/hosted/target-identity.test.ts')).toHaveLength(1)
  })

  it('never emits the candidate token, in any field of the finding', () => {
    const findings = scanText(`key ${PAT_SHAPED}`, 'docs/whatever.md')
    const serialised = JSON.stringify(findings)

    expect(findings).toHaveLength(1)
    expect(serialised).not.toContain(PAT_SHAPED)
    expect(serialised).not.toContain(PAT_BODY)
    for (let i = 0; i + 8 <= PAT_BODY.length; i += 1) {
      expect(serialised).not.toContain(PAT_BODY.slice(i, i + 8))
    }
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
    const other = scanText(`postgres://a:${OTHER_PASSWORD}@${PROD_HOST}`, 'x.md')[0]!

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
    // secret-scan-ok: the PEM header itself, which this assertion is about
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

  it('never labels a real project ref as unreachable', () => {
    for (const ref of KNOWN_PRODUCTION_IDENTIFIERS.projectRefs) {
      expect(isSyntheticHost(`db.${ref}.supabase.co`)).toBe(false)
    }
    expect(isSyntheticHost(`db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`)).toBe(false)
  })

  it('never labels a known production host as unreachable', () => {
    for (const host of KNOWN_PRODUCTION_IDENTIFIERS.hosts) {
      expect(isSyntheticHost(host)).toBe(false)
    }
  })

  it('does not accept a lookalike of a reserved name', () => {
    expect(isSyntheticHost('db.example.com.attacker.io')).toBe(false)
    expect(isSyntheticHost('localhost.attacker.example.io')).toBe(false)
  })
})

describe('the gate as CI runs it', () => {
  const ROOT = process.cwd()
  const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const SCANNER = path.join(ROOT, 'scripts', 'scan-secrets.ts')

  const runIn = (cwd: string, args: readonly string[] = []) =>
    spawnSync(process.execPath, [TSX_CLI, SCANNER, ...args], { cwd, encoding: 'utf8' })

  it('refuses a STAGED delta carrying a token, exit 1, without printing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uellix-secret-scan-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      writeFileSync(path.join(dir, 'leak.ts'), `export const token = '${PAT_SHAPED}'\n`)
      execFileSync('git', ['add', '.'], { cwd: dir })

      const result = runIn(dir, ['--staged'])
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

      expect(result.status).toBe(1)
      expect(output).toContain('SUPABASE_PERSONAL_ACCESS_TOKEN')
      expect(output).toContain('STAGED_DELTA')
      expect(output).not.toContain(PAT_SHAPED)
      expect(output).not.toContain(PAT_BODY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes over this repository — the assertion CI actually makes', () => {
    const result = runIn(ROOT)

    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(
      'no credential material found'
    )
    expect(result.status).toBe(0)
  })
})
