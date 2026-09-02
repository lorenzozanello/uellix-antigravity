// lib/pipeline/decimal-config.ts
// Deterministic Decimal configuration for the SROI pipeline.
//
// decimal.js keeps its precision/rounding as *library-wide mutable defaults*.
// Nothing in the pipeline ever called `Decimal.set`, so the audit-critical
// engine silently depended on (a) the library defaults not changing between
// versions and (b) no other module in the process mutating them. This module
// pins the configuration EXPLICITLY to the values the engine has always run
// with (the decimal.js defaults) so results are reproducible by construction.
//
// IMPORTANT: the values below are intentionally identical to the decimal.js
// defaults — applying this configuration MUST NOT change numeric behavior.
// It only makes the previously-implicit contract explicit and re-assertable.
import Decimal from 'decimal.js'

/** Significant digits carried by every intermediate result (decimal.js default). */
export const DECIMAL_PRECISION = 20
/** Rounding mode for all arithmetic and toFixed calls (decimal.js default). */
export const DECIMAL_ROUNDING = Decimal.ROUND_HALF_UP
/** Exponent below which toString() switches to exponential notation (default). */
export const DECIMAL_TO_EXP_NEG = -7
/** Exponent at/above which toString() switches to exponential notation (default). */
export const DECIMAL_TO_EXP_POS = 21

/**
 * (Re-)applies the pinned configuration to the shared Decimal constructor.
 * Idempotent; exported so tests can perturb the global config and assert that
 * re-applying restores the pinned values.
 */
export function applyDecimalConfig(): void {
  Decimal.set({
    precision: DECIMAL_PRECISION,
    rounding: DECIMAL_ROUNDING,
    toExpNeg: DECIMAL_TO_EXP_NEG,
    toExpPos: DECIMAL_TO_EXP_POS,
  })
}

// Applied at import time: every pipeline module imports this file first, so
// any Decimal created afterwards uses the pinned configuration.
applyDecimalConfig()
