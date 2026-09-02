// lib/security/__tests__/redact-secrets.test.ts
//
// F-GB-02, Phase H: the credential corpus.
//
// Every fixture is synthetic and lives in tests/fixtures/synthetic-credentials.ts
// — see that file for how a credential-SHAPED literal stays green under
// `pnpm secrets:scan` without the gate being weakened to accommodate it.

import { describe, it, expect } from 'vitest'
import { redactSecrets, containsSecretMaterial, SECRET_REDACTION_KINDS } from '../redact-secrets'
import {
  SYNTHETIC_GEMINI_KEY,
  SYNTHETIC_SUPABASE_PAT,
  SYNTHETIC_SUPABASE_SECRET,
  SYNTHETIC_OPENAI_KEY,
  SYNTHETIC_JWT,
  SYNTHETIC_PG_DSN,
  SYNTHETIC_PG_PASSWORD,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_WEBHOOK_SECRET,
  SYNTHETIC_COOKIE_VALUE,
  SYNTHETIC_URL_WITH_QUERY_TOKEN,
} from '@/tests/fixtures/synthetic-credentials'

describe('redactSecrets — bare token shapes', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['Google/Gemini API key', SYNTHETIC_GEMINI_KEY],
    ['Supabase personal access token', SYNTHETIC_SUPABASE_PAT],
    ['Supabase secret key', SYNTHETIC_SUPABASE_SECRET],
    ['OpenAI-style key', SYNTHETIC_OPENAI_KEY],
    ['JWT', SYNTHETIC_JWT],
    ['webhook signing secret', SYNTHETIC_WEBHOOK_SECRET],
  ]

  for (const [label, secret] of cases) {
    it(`redacts a ${label} embedded in prose`, () => {
      const out = redactSecrets(`El proveedor respondió 403 con ${secret} en el cuerpo.`)
      expect(out).not.toContain(secret)
      expect(out).toContain('[REDACTED:')
      // Surrounding prose survives — a redactor that eats the sentence makes
      // the log useless and gets turned off.
      expect(out).toContain('El proveedor respondió 403')
    })
  }
})

describe('redactSecrets — structural forms', () => {
  it('redacts the password of a Postgres DSN, keeping the host for triage', () => {
    const out = redactSecrets(`connection failed: ${SYNTHETIC_PG_DSN}`)
    expect(out).not.toContain(SYNTHETIC_PG_PASSWORD)
    // The host is not the secret (scan-secrets.ts doctrine) and is what makes
    // the failure diagnosable.
    expect(out).toContain('db.ejemplo-remoto.supabase.co')
    expect(out).toContain('[REDACTED:dsn-password]')
  })

  it('redacts an Authorization header value', () => {
    const out = redactSecrets(`Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}`)
    expect(out).not.toContain(SYNTHETIC_BEARER_TOKEN)
  })

  it('redacts a bare Bearer token without the header name', () => {
    const out = redactSecrets(`retry with Bearer ${SYNTHETIC_BEARER_TOKEN} next time`)
    expect(out).not.toContain(SYNTHETIC_BEARER_TOKEN)
  })

  it('redacts a cookie header', () => {
    const out = redactSecrets(`Cookie: ${SYNTHETIC_COOKIE_VALUE}`)
    expect(out).not.toContain('placeholder-not-a-real-session-value')
  })

  it('redacts a query-string secret but keeps the parameter name', () => {
    const out = redactSecrets(`GET ${SYNTHETIC_URL_WITH_QUERY_TOKEN}`)
    expect(out).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(out).toContain('key=[REDACTED:query-secret]')
    // The rest of the URL survives: knowing WHICH endpoint 403'd is the point.
    expect(out).toContain('api.ejemplo.test/v1/generate')
  })

  it('redacts an environment-variable dump', () => {
    const dump = [
      `GEMINI_API_KEY=${SYNTHETIC_GEMINI_KEY}`,
      `DATABASE_URL=${SYNTHETIC_PG_DSN}`,
      `SUPABASE_SERVICE_ROLE_KEY=${SYNTHETIC_JWT}`,
      'NEXT_PUBLIC_SITE_URL=https://app.ejemplo.test',
    ].join('\n')

    const out = redactSecrets(dump)
    expect(out).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(out).not.toContain(SYNTHETIC_PG_PASSWORD)
    expect(out).not.toContain(SYNTHETIC_JWT)
    // A public origin is not a credential and must survive: over-redacting
    // configuration makes the dump unreadable for no security gain.
    expect(out).toContain('https://app.ejemplo.test')
  })

  // The three literals below are PEM HEADERS, not keys — the bodies are the
  // base64 of the word "synthetic". `scan-secrets.ts` gives the PEM detector
  // no placeholder path on purpose ("a PEM header is never fixture material by
  // virtue of its own contents, so this one is annotation-gated or nothing"),
  // so the sanctioned escape hatch is used, with the reason it requires. The
  // detector is unchanged: the brief forbids weakening the gate to fit a test.
  it('redacts a PEM private key block', () => {
    // secret-scan-ok: PEM header with a base64("synthetic") body; the exact bytes are the input to the redactor under test
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nc3ludGhldGljCg==\n-----END RSA PRIVATE KEY-----'
    const out = redactSecrets(pem)
    expect(out).toBe('[REDACTED:private-key]')
  })

  it('redacts a PEM block that was truncated before its END marker', () => {
    // secret-scan-ok: truncated PEM header, no key material; pins the quote-bounded fallback branch
    const out = redactSecrets('-----BEGIN PRIVATE KEY-----\nc3ludGhldGlj')
    expect(out).not.toContain('c3ludGhldGlj')
  })
})

describe('redactSecrets — knownSecrets is a belt, not the mechanism', () => {
  it('redacts an exact configured value with no recognisable shape', () => {
    const opaque = 'zzzz-opaque-operator-value-0000'
    const out = redactSecrets(`falló con ${opaque}`, [opaque])
    expect(out).not.toContain(opaque)
    expect(out).toContain('[REDACTED:known-secret]')
  })

  it('ignores empty and very short knownSecrets instead of shredding prose', () => {
    // The pre-fix `apiKey ? split : raw` shape meant an unset key disabled
    // redaction entirely. Here an unset key is simply ignored, and the pattern
    // rules still fire.
    const out = redactSecrets(`clave ${SYNTHETIC_GEMINI_KEY} presente`, ['', 'abc'])
    expect(out).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(out).toContain('presente')
  })
})

describe('redactSecrets — properties the boundaries depend on', () => {
  it('is idempotent: redacting twice equals redacting once', () => {
    const input = [
      `key ${SYNTHETIC_GEMINI_KEY}`,
      `Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}`,
      `DATABASE_URL=${SYNTHETIC_PG_DSN}`,
      `jwt ${SYNTHETIC_JWT}`,
      `Cookie: ${SYNTHETIC_COOKIE_VALUE}`,
      SYNTHETIC_URL_WITH_QUERY_TOKEN,
    ].join('\n')

    const once = redactSecrets(input)
    expect(redactSecrets(once)).toBe(once)
  })

  it('never runs past a quote — safe over serialized JSON', () => {
    // THE SILENT FAILURE THIS GUARDS. A rule bounded only by whitespace eats
    // the closing quote and the following keys; the result still parses, with
    // a key deleted. At the model boundary that reshapes the payload out from
    // under the citation catalog.
    const payload = {
      a: `Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}`,
      b: `Cookie: ${SYNTHETIC_COOKIE_VALUE}`,
      c: SYNTHETIC_PG_DSN,
      // secret-scan-ok: PEM header only, no key material; proves the rule stops at the closing quote
      d: '-----BEGIN PRIVATE KEY-----truncado',
      e: 'valor siguiente',
      f: 42,
    }
    const out = redactSecrets(JSON.stringify(payload))

    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(parsed.e).toBe('valor siguiente')
    expect(parsed.f).toBe(42)
    expect(out).not.toContain(SYNTHETIC_BEARER_TOKEN)
    expect(out).not.toContain(SYNTHETIC_PG_PASSWORD)
  })

  it('leaves ordinary project prose untouched', () => {
    const prose =
      'El proyecto atendió 3.500 beneficiarios en 2026 con una inversión de $450.000.000 COP y un SROI de 2,4.'
    expect(redactSecrets(prose)).toBe(prose)
  })

  it('returns empty string for empty input and never throws on odd input', () => {
    expect(redactSecrets('')).toBe('')
    expect(() => redactSecrets('a'.repeat(50_000))).not.toThrow()
  })
})

describe('containsSecretMaterial — the independent oracle', () => {
  it('detects each synthetic shape and clears the redacted output', () => {
    for (const secret of [
      SYNTHETIC_GEMINI_KEY,
      SYNTHETIC_SUPABASE_PAT,
      SYNTHETIC_JWT,
      SYNTHETIC_OPENAI_KEY,
      SYNTHETIC_WEBHOOK_SECRET,
    ]) {
      expect(containsSecretMaterial(secret), `undetected: ${secret.slice(0, 8)}…`).toBe(true)
      expect(containsSecretMaterial(redactSecrets(secret))).toBe(false)
    }
  })

  it('is stable across repeated calls (global regex lastIndex is reset)', () => {
    expect(containsSecretMaterial(SYNTHETIC_GEMINI_KEY)).toBe(true)
    expect(containsSecretMaterial(SYNTHETIC_GEMINI_KEY)).toBe(true)
  })

  it('exposes a non-trivial rule set', () => {
    expect(SECRET_REDACTION_KINDS.length).toBeGreaterThanOrEqual(15)
    expect(new Set(SECRET_REDACTION_KINDS).size).toBe(SECRET_REDACTION_KINDS.length)
  })
})
