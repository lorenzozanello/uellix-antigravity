// lib/stella/observability.ts
// WS3b U3: Stella failure observability. Before this module existed, Gemini
// failures never reached Sentry — every action swallowed errors into typed
// results and the only trace was a console.error inside the adapter.
//
// PRIVACY CONTRACT: nothing that flows through here may contain prompt text,
// project context, model responses or PII. Callers pass ids/codes/sizes only
// (enforced by StellaObservabilityMeta's scalar type). The structured
// console.error deliberately logs the error NAME, never its message — Gemini
// error messages can echo request fragments. Sentry receives the original
// error object (captureException) for stack/context, scoped by tags and a
// stable fingerprint per (role, error_code).

import * as Sentry from '@sentry/nextjs'

export type StellaFailureCode =
  | 'GEMINI_ERROR'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

/** Scalar-only metadata: ids, codes, counts, sizes. Never free text. */
export type StellaObservabilityMeta = Record<string, string | number | boolean | null | undefined>

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

  try {
    Sentry.captureException(safeError, {
      tags: { stella_role: role, error_code: errorCode },
      // Stable grouping per (role, code) — a burst of Gemini 403s groups into
      // one issue instead of one issue per stack line.
      fingerprint: ['stella', role, errorCode],
      extra: meta,
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
