// lib/stella/observability.ts
// WS3b U3: Stella failure observability. Before this module existed, Gemini
// failures never reached Sentry — every action swallowed errors into typed
// results and the only trace was a console.error inside the adapter.
//
// PRIVACY CONTRACT: nothing that flows through here may contain prompt text,
// project context, model responses or PII. Callers pass ids/codes/sizes only
// (enforced by StellaObservabilityMeta's scalar type). The structured
// console.error deliberately logs the error NAME, never its message — Gemini
// error messages can echo request fragments. Sentry receives a SANITIZED
// clone of the error (same name, message truncated to MAX_SENTRY_MESSAGE_CHARS,
// stack frames preserved but the raw message header rebuilt), scoped by tags
// and a stable fingerprint per (role, error_code); the original message length
// is attached as a scalar extra for diagnostics.

import * as Sentry from '@sentry/nextjs'

import { redactSecrets } from '@/lib/security/redact-secrets'

export type StellaFailureCode =
  | 'GEMINI_ERROR'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

/** Scalar-only metadata: ids, codes, counts, sizes. Never free text. */
export type StellaObservabilityMeta = Record<string, string | number | boolean | null | undefined>

// Long messages are the leak vector: a Gemini/provider error that echoes the
// request body is arbitrarily long, while legitimate error messages ("API
// failure", HTTP status lines, timeout notices) fit comfortably under this.
const MAX_SENTRY_MESSAGE_CHARS = 200

/**
 * Clone an Error for Sentry with a REDACTED, truncated message and a stack
 * whose header line is rebuilt from it (V8 stacks embed the FULL message in
 * their first line — copying the stack verbatim would undo the truncation).
 *
 * F-GB-02: redaction happens BEFORE truncation, and it is the part that was
 * missing. Truncation only defends against a message long enough to be an
 * echoed request body; a 39-character Gemini key inside
 * `Gemini 403: API key AIza… is blocked` sits at offset 20 and sailed through
 * the 200-char window untouched. Order matters the other way too: redacting
 * first means a credential straddling the cut is removed as a whole value
 * rather than left as a truncated fragment.
 *
 * This is now the SECOND of two defenses — `beforeSend` scrubs the assembled
 * event as well. Both are kept: this one also shapes the message length, and a
 * boundary that depends on exactly one hook being registered is a boundary one
 * config edit away from being gone.
 */
function sanitizeErrorForSentry(error: Error): Error {
  const redacted = redactSecrets(error.message)
  const truncated = redacted.slice(0, MAX_SENTRY_MESSAGE_CHARS)
  const clone = new Error(truncated)
  clone.name = error.name
  if (error.stack) {
    const frames = error.stack.split('\n').filter((line) => /^\s+at /.test(line))
    clone.stack = `${error.name}: ${truncated}\n${frames.join('\n')}`
  }
  return clone
}

/**
 * Report a Stella pipeline failure to Sentry + structured server log.
 * Never throws — observability must not alter the action's control flow.
 */
export function reportStellaFailure(
  role: string,
  errorCode: StellaFailureCode,
  error: unknown,
  meta?: StellaObservabilityMeta,
): void {
  const safeError = error instanceof Error ? error : new Error(`[stella] non-Error failure (${typeof error})`)
  const sanitized = sanitizeErrorForSentry(safeError)

  try {
    Sentry.captureException(sanitized, {
      tags: { stella_role: role, error_code: errorCode },
      // Stable grouping per (role, code) — a burst of Gemini 403s groups into
      // one issue instead of one issue per stack line.
      fingerprint: ['stella', role, errorCode],
      extra: { ...meta, originalMessageLength: safeError.message.length },
    })
  } catch {
    // Sentry unavailable/misconfigured — fall through to the console log.
  }

  // Structured log: codes and scalar meta only; error NAME, never message.
  console.error('[stella] failure', {
    role,
    errorCode,
    errorName: safeError.name,
    ...meta,
  })
}
