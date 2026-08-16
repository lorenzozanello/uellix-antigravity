// lib/security/sanitize-sentry-event.ts
//
// F-GB-02. The FINAL scrub every telemetry event passes through before it
// leaves the process.
//
// ---------------------------------------------------------------------------
// WHAT WAS WRONG
// ---------------------------------------------------------------------------
// `reportStellaFailure` was careful — it cloned the error, truncated the
// message to 200 characters and rebuilt the stack header so the full message
// could not survive in it. Careful, and not sufficient, for two independent
// reasons:
//
//   1. TRUNCATION IS NOT REDACTION. A Gemini API key is 39 characters. In
//      `Gemini 403: API key AIza… is blocked` it sits at offset 20 — comfortably
//      inside the window — and travelled to Sentry intact. Truncation only
//      defends against a message long enough to be an echoed request body; it
//      does nothing about a short message that simply contains the credential.
//
//   2. IT WAS ONE CAPTURE PATH OUT OF SEVERAL. `instrumentation.ts` exports
//      `onRequestError = Sentry.captureRequestError`, so every uncaught error
//      from a Server Action or route handler went to Sentry having passed
//      through no Stella code at all — untruncated and unredacted, with the
//      captured request's headers attached. A per-call-site sanitizer cannot
//      cover a path that does not call it.
//
// So the scrub belongs at the SDK's own egress hook, where the event exists in
// its final form and no capture path can route around it. `beforeSend` is that
// hook; `beforeSendTransaction` is its twin for the transaction envelope,
// which carries span descriptions and therefore URLs.
//
// ---------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------
// A sanitizer that throws is worse than no sanitizer, because the SDK's
// recovery is to send something. Every layer here is wrapped: `deepRedact`
// tokenises a leaf whose transform threw and keeps walking, and the top level
// falls back to `minimalEvent`, which carries the ALERT (so on-call still
// learns something broke) and none of the CONTENT.

import { deepRedact } from './deep-redact'
import { redactSecrets } from './redact-secrets'
import { redactPii } from '@/lib/stella/security/redact-pii'

/**
 * Field names whose VALUE is secret regardless of what it looks like.
 *
 * Pattern matching alone is not enough here: an opaque session identifier is
 * high-entropy base62 with no recognisable prefix, indistinguishable from a
 * request id. What marks it is the name of the field carrying it, so the name
 * is what this rule reads. Applied at every depth, so it covers
 * `request.headers.authorization`, `contexts.foo.apiKey` and `extra.password`
 * with one rule.
 */
const SENSITIVE_KEY =
  /^(?:authorization|proxy-authorization|cookies?|set-cookie|x-api-key|api[-_]?key|x-goog-api-key|x-auth-token|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?(?:id|token)|passwo?rd|passwd|pwd|contrase(?:n|ñ)a|clave|client[-_]?secret|secret|private[-_]?key|database[-_]?url|connection[-_]?string|dsn|credentials?|token)$/i

const SENSITIVE_KEY_TOKEN = '[REDACTED:sensitive-key]'

/** Applied to every string leaf of an event: credentials first, then PII. */
export function sanitizeTelemetryText(text: string): string {
  if (!text) return ''
  return redactPii(redactSecrets(text)).text
}

function redactKey(key: string): string | null {
  return SENSITIVE_KEY.test(key) ? SENSITIVE_KEY_TOKEN : null
}

/**
 * Read a property for the fallback path without trusting it.
 *
 * Three ways this refuses to be a hole: a hostile getter cannot throw out of
 * it, a string value is still scrubbed (the fallback runs precisely when the
 * normal scrub did not, so nothing here may be assumed clean), and anything
 * that is neither a string nor a scalar is dropped rather than carried.
 */
function safeRead(source: unknown, key: string): unknown {
  try {
    const value = (source as Record<string, unknown> | null)?.[key]
    if (typeof value === 'string') return sanitizeTelemetryText(value)
    if (value === null || ['number', 'boolean', 'undefined'].includes(typeof value)) return value
    return undefined
  } catch {
    return undefined
  }
}

/**
 * What is sent when sanitization itself fails: the fact of an error, and
 * nothing that could carry content. Only scalars whose provenance is
 * configuration (environment, release) or the SDK (event_id, timestamp) are
 * carried across.
 */
function minimalEvent(event: unknown): Record<string, unknown> {
  return {
    event_id: safeRead(event, 'event_id'),
    timestamp: safeRead(event, 'timestamp'),
    platform: safeRead(event, 'platform'),
    level: safeRead(event, 'level') ?? 'error',
    environment: safeRead(event, 'environment'),
    release: safeRead(event, 'release'),
    message: '[REDACTED:telemetry-sanitizer-failed]',
    tags: { redaction: 'failed_closed' },
  }
}

/**
 * Deep-scrub a Sentry event.
 *
 * Structure-preserving, so grouping still works: `exception.values[].type`
 * (the error class), `fingerprint` and the tag KEYS are untouched — none of
 * them match a credential or PII shape. What changes is the content of
 * `message`, exception values, stack-frame strings, breadcrumbs, request
 * headers/URL/data, contexts, extra and user.
 *
 * Generic over the event shape so the Sentry SDK's own types flow through
 * without this module having to depend on them (it is imported by the edge
 * runtime config, where the dependency surface should stay at zero).
 */
export function sanitizeSentryEvent<E>(event: E): E {
  try {
    const sanitized = deepRedact(event, { transform: sanitizeTelemetryText, redactKey })
    // `deepRedact` degrades a node it cannot process to a TOKEN rather than
    // throwing — which is right for a leaf, and wrong for the root: a hostile
    // getter on the top-level object would otherwise leave `sanitized` as the
    // bare string '[REDACTED:error]', and handing the SDK a string where it
    // expects an event is its own failure mode. Checking the result is what
    // makes this fallback REACHABLE; without it the catch below was dead code
    // that no test could reach and no mutation could be caught in.
    if (sanitized !== null && typeof sanitized === 'object') return sanitized
  } catch {
    // fall through to the same fallback — one exit, so there is one line to
    // get wrong and one line the mutation suite has to kill.
  }
  return minimalEvent(event) as E
}

/**
 * `beforeSend` / `beforeSendTransaction` in the shape the SDK expects.
 *
 * Registered identically on all three runtimes. Keeping one function rather
 * than three near-copies is the point: a divergence between the server and the
 * edge hook is exactly the kind of gap that gets shipped, and
 * `tests/sentry-telemetry-boundary.test.ts` asserts all three are wired to
 * this same core.
 */
export function sentryBeforeSend<E>(event: E): E {
  return sanitizeSentryEvent(event)
}
