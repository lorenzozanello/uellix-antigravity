// lib/stella/cost-model.ts
// Pure, dependency-free USD cost ESTIMATION for Stella (Gemini) token usage.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT ASSUMPTIONS — read before trusting any number this module produces.
//
// 1. Model: production Stella uses `gemini-2.5-flash` (lib/stella/config.ts
//    default; overridable via GEMINI_MODEL). Pricing below is for the Gemini
//    API PAID tier as published at https://ai.google.dev/gemini-api/docs/pricing
//    as of 2026-07-31 (see COST_MODEL_ASSUMPTIONS.asOfDate):
//      gemini-2.5-flash — input USD 0.30 / 1M tokens (text), output USD 2.50 /
//      1M tokens (thinking tokens billed as output).
//    Prices change; recalibrate against a real Gemini billing export (gate G9,
//    docs/ops/gates/G9_PACKAGE.md) before using this for anything commercial.
//
// 2. BLENDED INPUT/OUTPUT HEURISTIC — THE BIG LIMITATION, STATED LOUDLY:
//    stella_interactions stores ONLY `tokens_used` (a single total per
//    interaction). The input/output split is NOT recorded anywhere, and input
//    and output tokens have very different prices (~8x for 2.5-flash). This
//    module therefore assumes a fixed share of every total is input
//    (`assumedInputShare`, default 0.80 — Stella calls are context-heavy:
//    large system prompt + project context vs. a bounded 4096-token output).
//    The result is an ORDER-OF-MAGNITUDE estimate, not an invoice. Acceptance
//    criterion for trusting it: within ±30% of observed Gemini billing for two
//    consecutive weeks (G9).
//
// 3. Unknown models fall back to the default model's pricing (fail-visible in
//    code review, never throws at render time in the admin table).
//
// Purity contract: no imports, no I/O, no Date.now — safe for client, server
// and tests alike.
// ─────────────────────────────────────────────────────────────────────────────

export const COST_MODEL_ASSUMPTIONS = {
  /** Date the price constants below were last checked against the source. */
  asOfDate: '2026-07-31',
  source:
    'https://ai.google.dev/gemini-api/docs/pricing — Gemini API paid tier, retrieved 2026-07-31',
  defaultModel: 'gemini-2.5-flash',
  /** USD per 1,000,000 tokens, split by direction. */
  pricesUsdPerMillionTokens: {
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  } as Record<string, { input: number; output: number }>,
  /**
   * Assumed fraction of every stored total that was INPUT tokens. Heuristic —
   * see assumption 2 above. Recalibrate in G9.
   */
  assumedInputShare: 0.8,
  limitation:
    'stella_interactions stores only tokens_used (total per interaction); the input/output split is not recorded, so costs are estimated with a fixed blended heuristic and must be treated as approximate until calibrated against real Gemini billing (G9).',
} as const

/**
 * Blended USD price per 1M tokens for a model, weighting input/output prices
 * by the assumed input share. Unknown or missing model → default model.
 */
export function blendedUsdPerMillionTokens(model?: string): number {
  const prices =
    COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens[model ?? COST_MODEL_ASSUMPTIONS.defaultModel] ??
    COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens[COST_MODEL_ASSUMPTIONS.defaultModel]
  const share = COST_MODEL_ASSUMPTIONS.assumedInputShare
  return prices.input * share + prices.output * (1 - share)
}

/**
 * Estimated USD cost for `totalTokens` tokens of combined (input+output)
 * usage. Defensive: zero, negative or non-finite inputs return 0 — the admin
 * table must never render NaN.
 */
export function estimateCostUsd(totalTokens: number, model?: string): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0
  return (totalTokens / 1_000_000) * blendedUsdPerMillionTokens(model)
}
