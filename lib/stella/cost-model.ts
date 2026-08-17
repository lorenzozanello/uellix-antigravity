// lib/stella/cost-model.ts
// Pure, dependency-free USD cost ESTIMATION for Stella (Gemini) token usage.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT ASSUMPTIONS — read before trusting any number this module produces.
//
// 1. Model prices are Gemini API PAID tier, per direction, per 1M tokens:
//
//      gemini-3.6-flash  input USD 1.50 / output USD 7.50   verified 2026-08-17
//        (Standard paid tier. THE OUTPUT PRICE INCLUDES THINKING TOKENS — see
//         assumption 4, which is why that is not an academic detail.)
//      gemini-2.5-flash  input USD 0.30 / output USD 2.50   verified 2026-07-31
//        (retained because stella_interactions rows written before G1-M0 carry
//         `model_used = 'gemini-2.5-flash'`, and the admin table still prices
//         them; historical rows must not be repriced at today's rates.)
//
//    `asOfDate` is the last date the table AS A WHOLE was checked; the per-row
//    dates above are the provenance of each individual price.
//    Prices change; recalibrate against a real Gemini billing export (gate G9,
//    docs/ops/gates/G9_PACKAGE.md) before using this for anything commercial.
//
// 2. BLENDED INPUT/OUTPUT HEURISTIC — THE BIG LIMITATION, STATED LOUDLY:
//    stella_interactions stores ONLY `tokens_used` (a single total per
//    interaction). The input/output split is NOT recorded anywhere, and input
//    and output tokens have very different prices (5x for 3.6-flash, ~8x for
//    2.5-flash). This module therefore assumes a fixed share of every total is
//    input (`assumedInputShare`, default 0.80 — Stella calls are context-heavy:
//    large system prompt + project context vs. a bounded 4096-token output).
//    The result is an ORDER-OF-MAGNITUDE estimate, not an invoice. Acceptance
//    criterion for trusting it: within ±30% of observed Gemini billing for two
//    consecutive weeks (G9).
//
//    The blend is forced by what the LEDGER records, not by the price structure:
//    the table below carries real, separate input and output prices, and no
//    blended constant is ever stored.
//
// 3. Unknown models fall back to the default model's pricing (fail-visible in
//    code review, never throws at render time in the admin table). Now that the
//    default is the model production actually calls, the DIRECTION of that error
//    is conservative: an unrecognised legacy id (e.g. the long-retired
//    gemini-2.0-flash) is priced at current, higher rates, so the estimate
//    overstates rather than understates. A silent zero would have been the
//    dangerous shape; this is not that.
//
// 4. THINKING TOKENS ARE BILLED AS OUTPUT, and gemini-3.6-flash runs at
//    thinking level `medium` BY DEFAULT — the adapter deliberately sends no
//    thinkingConfig (see lib/stella/adapter/gemini-client.ts). So `tokens_used`
//    for a 3.6-flash interaction INCLUDES thinking tokens, those tokens are
//    priced at the USD 7.50 output rate, and `assumedInputShare = 0.80` —
//    calibrated when output was a bounded 4096-token JSON document and nothing
//    else — is the assumption most likely to be wrong for this model, in the
//    direction of UNDERSTATING cost. G1-A measures the real split; G9
//    recalibrates the share against billing.
//
// Purity contract: no imports, no I/O, no Date.now — safe for client, server
// and tests alike. In particular this module does NOT import
// STELLA_DEFAULT_GEMINI_MODEL from lib/stella/config.ts: that module reads
// process.env at load time, and importing it here would drag environment reads
// into a module the admin UI treats as pure. `defaultModel` below is therefore a
// literal that must EQUAL the runtime target, and the two are kept in agreement
// by assertion rather than by import — see tests/stella-cost-model.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const COST_MODEL_ASSUMPTIONS = {
  /** Date the price table as a whole was last checked against the source. */
  asOfDate: '2026-08-17',
  source:
    'https://ai.google.dev/gemini-api/docs/pricing — Gemini API paid tier; gemini-3.6-flash retrieved 2026-08-17, gemini-2.5-flash retrieved 2026-07-31',
  /**
   * G1-M0: must equal STELLA_DEFAULT_GEMINI_MODEL (lib/stella/config.ts).
   * Asserted in tests, not imported — see the purity note above.
   */
  defaultModel: 'gemini-3.6-flash',
  /**
   * USD per 1,000,000 tokens, split by direction. Output prices INCLUDE
   * thinking tokens (assumption 4).
   */
  pricesUsdPerMillionTokens: {
    'gemini-3.6-flash': { input: 1.5, output: 7.5 },
    // Historical: priced only so pre-G1-M0 ledger rows render correctly.
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
