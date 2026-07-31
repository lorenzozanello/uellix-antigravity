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
 * Clone an Error for Sentry with a truncated message and a stack whose header
 * line is rebuilt from the truncated message (V8 stacks embed the FULL message
 * in their first line — copying the stack verbatim would undo the truncation).
 */
function sanitizeErrorForSentry(error: Error): Error {
  const truncated = error.message.slice(0, MAX_SENTRY_MESSAGE_CHARS)
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
