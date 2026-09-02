// lib/security/redact-secrets.ts
//
// Pure, deterministic credential redaction for text that is about to LEAVE the
// trusted application boundary — a model provider request, a Sentry event, a
// server log line.
//
// No imports, no side effects, no I/O. It has to be callable from the edge
// runtime (`sentry.edge.config.ts`), from a Server Action, and from a unit
// test, so it may not depend on anything.
//
// ---------------------------------------------------------------------------
// WHY PATTERN-CLASS AND NOT KNOWN-VALUE MATCHING
// ---------------------------------------------------------------------------
// The adapter already knew how to hide ONE secret: `buildGeminiErrorLog` split
// the message on `this.config.apiKey`. That defends against exactly the value
// the process happens to be holding, and against nothing else — a Postgres DSN
// echoed by a driver error, a bearer token in a provider's 401 body, a session
// cookie in a captured request header all walked straight past it. Worse, it
// degrades silently: when `apiKey` is the empty string (the mock-provider and
// test configuration) the expression `apiKey ? redact : raw` forwards the raw
// message.
//
// So the verdict here is taken on the SHAPE of the value, in the same spirit as
// `scripts/scan-secrets.ts`. `knownSecrets` remains available as a belt on top
// of the braces, never as the mechanism.
//
// ---------------------------------------------------------------------------
// OVER-REDACTION IS THE SAFE DIRECTION
// ---------------------------------------------------------------------------
// Every rule here is allowed to be greedy. A false positive costs a reviewer
// one confusing `[REDACTED:*]` token in a Sentry issue; a false negative costs
// a live credential in a third party's logs. Where the two trade off, this file
// chooses the token.
//
// IDEMPOTENCY is a hard requirement, not a nicety: the model boundary and the
// telemetry boundary both run this, and prompts already sanitized upstream get
// a second pass. Every replacement token is bracketed (`[REDACTED:kind]`), and
// `[` is excluded from every value character class below, so a redacted string
// is a fixed point. `redact-secrets.test.ts` pins that.

export interface SecretRedactionRule {
  readonly kind: string
  readonly pattern: RegExp
  readonly replace: string | ((...match: string[]) => string)
}

const token = (kind: string): string => `[REDACTED:${kind}]`

/**
 * Characters a credential value may contain. `[` and `]` are deliberately
 * excluded so an already-emitted `[REDACTED:*]` token can never be re-consumed
 * as the value of a following rule.
 */
const VALUE_CHARS = 'A-Za-z0-9._~+/=:@%-'

/**
 * Ordered. Structural rules (a whole assignment, a whole header) run BEFORE
 * bare-token rules, so `DATABASE_URL=postgres://u:p@h/db` loses the entire
 * value rather than only the password — the surrounding key already told the
 * reader what kind of thing it was.
 */
const RULES: readonly SecretRedactionRule[] = [
  // -------------------------------------------------------------------------
  // Structural: the key names the secret
  // -------------------------------------------------------------------------
  {
    // A PEM block, header to end-of-block — or, if the block was truncated,
    // to the enclosing quote. The body class is `[^"]` rather than `[\s\S]`
    // so a header-without-footer inside a JSON string value stops at the
    // closing quote instead of consuming the rest of the document. A PEM body
    // is base64 and newlines; it never contains a quote.
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[^"]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|$)/g,
    replace: token('private-key'),
  },
  {
    // Authorization / Proxy-Authorization, header or object-literal form,
    // with or without a scheme word.
    kind: 'authorization',
    pattern: new RegExp(
      `\\b(proxy-)?authorization\\s*[:=]\\s*["']?(?:bearer|basic|digest|token)?\\s*[${VALUE_CHARS}]{8,}`,
      'gi'
    ),
    replace: token('authorization'),
  },
  {
    kind: 'bearer-token',
    pattern: new RegExp(`\\b(?:bearer|basic)\\s+[${VALUE_CHARS}]{8,}`, 'gi'),
    replace: token('bearer-token'),
  },
  {
    // Cookie / Set-Cookie: the whole value, to end of line OR to the
    // enclosing quote — see the private-key rule above for why the quote
    // matters. A cookie header value never contains one.
    kind: 'cookie',
    pattern: /\b(?:set-)?cookie\s*[:=]\s*["']?[^\n\r"']{4,}/gi,
    replace: token('cookie'),
  },
  {
    // API-key headers and fields: x-api-key, api_key, apiKey, x-goog-api-key.
    kind: 'api-key-field',
    pattern: new RegExp(`\\b(?:x-)?(?:goog-)?api[_-]?key\\s*[:=]\\s*["']?[${VALUE_CHARS}]{6,}`, 'gi'),
    replace: token('api-key-field'),
  },
  {
    // SCREAMING_SNAKE env assignment whose NAME announces a credential.
    // DATABASE_URL is named explicitly; a bare `*_URL` is not, because most
    // URLs in this codebase are public site origins.
    kind: 'env-assignment',
    pattern: new RegExp(
      `\\b(?:DATABASE_URL|[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|KEY|DSN|CREDENTIALS?))\\s*=\\s*["']?[${VALUE_CHARS}]{6,}`,
      'g'
    ),
    replace: token('env-assignment'),
  },
  {
    // A password field in prose or a serialized object, ES + EN.
    kind: 'password-field',
    pattern: new RegExp(
      `\\b(?:password|passwd|pwd|contrase[nñ]a|clave)\\s*[:=]\\s*["']?[${VALUE_CHARS}]{4,}`,
      'gi'
    ),
    replace: token('password-field'),
  },
  {
    // Secret carried in a query string. The PARAMETER NAME is preserved so a
    // reader can still tell which call failed.
    //
    // `[` is excluded from the value class as well as `]`. With only `]`
    // excluded this rule was NOT idempotent: on a second pass it re-consumed
    // its own `[REDACTED:query-secret` prefix and emitted a doubled bracket.
    // Both boundaries run this over text the other may already have scrubbed,
    // so "redacting twice equals redacting once" is a property, not a
    // preference — `redact-secrets.test.ts` pins it.
    kind: 'query-secret',
    pattern:
      /([?&](?:key|api_?key|access_?token|refresh_?token|id_?token|token|secret|password|signature|sig|auth|session)=)[^&\s"'#[\]]+/gi,
    replace: (_match, prefix: string) => `${prefix}${token('query-secret')}`,
  },
  {
    // A DSN with an embedded password: redact the PASSWORD component only.
    // The host is not the secret (see scan-secrets.ts, "what decides and what
    // only describes") and keeping it is what makes the error triageable.
    kind: 'dsn-password',
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|https?):\/\/[^\s:@/'"`[\]]+:)[^\s@/'"`[\]]+@/gi,
    replace: (_match, prefix: string) => `${prefix}${token('dsn-password')}@`,
  },

  // -------------------------------------------------------------------------
  // Bare tokens: the value announces itself, no key required
  // -------------------------------------------------------------------------
  {
    // Google / Gemini. `{35,}` rather than the scanner's `{35}\b` because a
    // redactor should swallow a longer run, not decline to match it.
    kind: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35,}/g,
    replace: token('google-api-key'),
  },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: token('jwt') },
  { kind: 'supabase-secret-key', pattern: /\bsb_secret_[A-Za-z0-9_-]{10,}/g, replace: token('supabase-secret-key') },
  { kind: 'supabase-pat', pattern: /\bsbp_[A-Za-z0-9_-]{20,}/g, replace: token('supabase-pat') },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: token('stripe-key') },
  { kind: 'webhook-secret', pattern: /\bwhsec_[A-Za-z0-9_-]{10,}/g, replace: token('webhook-secret') },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: token('openai-key') },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: token('github-token') },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: token('aws-access-key-id') },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: token('slack-token') },
]

/** Escape a literal for safe interpolation into a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Redact credential material from free text.
 *
 * @param text          the value to scrub
 * @param knownSecrets  exact values the caller happens to hold (e.g. the
 *                      configured API key). Belt on top of the braces: the
 *                      pattern rules are the mechanism, this is redundancy.
 *                      Values shorter than 8 chars are ignored — redacting a
 *                      4-character "secret" would shred ordinary prose.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  if (!text) return ''

  let result = text
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (...args) =>
      typeof rule.replace === 'function' ? rule.replace(...(args as string[])) : rule.replace
    )
  }

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), token('known-secret'))
  }

  return result
}

/**
 * True when `text` still carries something credential-shaped. Used by the
 * suites as an independent oracle, so a test cannot pass merely because it
 * asserted against the same regex the implementation used.
 */
export function containsSecretMaterial(text: string): boolean {
  return RULES.some((rule) => {
    rule.pattern.lastIndex = 0
    return rule.pattern.test(text)
  })
}

/** Rule kinds, for tests and for documentation. */
export const SECRET_REDACTION_KINDS: readonly string[] = RULES.map((rule) => rule.kind)
