// lib/stella/config.ts
// Sprint 9B: Stella configuration from environment variables
// Server-only module. Never expose GEMINI_API_KEY to client.

function envPositiveInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * G1-M0 — THE ONE PLACE STELLA'S MODEL TARGET IS DECIDED.
 *
 * Exported as a named constant, not left as an inline literal, because the
 * real-provider eval runner used to re-state the same default three times
 * (tests/eval/stella-contextual-real/run.ts). Three literals are three chances
 * for the harness to certify a model production does not use — which is the
 * exact failure a certification gate exists to prevent. Everything that needs
 * the target now reads it from here or from `stellaConfig.geminiModel`.
 *
 * MODEL HISTORY, kept because each retirement was discovered the hard way:
 *   gemini-2.0-flash  retired by Google; returned 404 NOT_FOUND as of 2026-07.
 *   gemini-2.5-flash  shutdown announced for 2026-10-16.
 *   gemini-3.6-flash  current target: GA/stable, supports structured outputs.
 *
 * Overridable via GEMINI_MODEL. `tModel` in @google/genai applies no model
 * allowlist (it only rejects non-strings and `..`/`?`/`&`), so a new id needs
 * no SDK change — but it also means a typo reaches Google as a 404 rather than
 * failing locally.
 */
export const STELLA_DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash'

export const stellaConfig = {
  // API Key: read from environment, never log or expose
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',

  // Model: see STELLA_DEFAULT_GEMINI_MODEL above.
  geminiModel: process.env.GEMINI_MODEL ?? STELLA_DEFAULT_GEMINI_MODEL,

  // Feature flags: all default to false in MVP
  // Enabled only if explicitly set to 'true' (string)
  isEnabled: process.env.STELLA_ENABLED === 'true',
  isAdvisorEnabled: process.env.STELLA_ADVISOR_ENABLED === 'true',
  // G1-B PRECONDITIONS — THE LEGACY STEP ADVISOR HAS ITS OWN SWITCH.
  //
  // `getStellaAdvisor` (app/actions/stella/advisor.ts) and
  // `getStellaContextualAdvisor` are two advisor surfaces with materially
  // different governance: only the contextual one sends a provider-side
  // `responseJsonSchema`, validates against a `.strict()` Zod contract, carries
  // a validated citation catalog and pins `requiresHumanReview: true`. Until
  // this flag existed both were opened by `STELLA_ADVISOR_ENABLED`, so turning
  // Stella's advisor on in Preview also opened the weaker one.
  //
  // DEFAULT FALSE, and it stays false: the legacy panel is unmounted from every
  // pipeline page and the action survives only as the advisor category's
  // representative in the governed multi-category quota harness. See
  // app/actions/stella/__tests__/legacy-advisor-disposition.test.ts.
  isLegacyAdvisorEnabled: process.env.STELLA_LEGACY_ADVISOR_ENABLED === 'true',
  isValidatorEnabled: process.env.STELLA_VALIDATOR_ENABLED === 'true',
  isComposerEnabled: process.env.STELLA_COMPOSER_ENABLED === 'true',
  // Fase 5b reviewer roles — default false, enabled per-role via env vars.
  isProxyReviewerEnabled: process.env.STELLA_PROXY_REVIEWER_ENABLED === 'true',
  isEvidenceReviewerEnabled: process.env.STELLA_EVIDENCE_REVIEWER_ENABLED === 'true',
  isAuditAssistantEnabled: process.env.STELLA_AUDIT_ASSISTANT_ENABLED === 'true',
  // WS3b: suggestion-decision persistence — DORMANT by default. Must stay
  // false until gate G2 applies db/prepared/stella_0003_suggestion_decisions.sql
  // (the table does not exist before that). See app/actions/stella/decisions.ts.
  isDecisionsPersistenceEnabled: process.env.STELLA_DECISIONS_PERSISTENCE_ENABLED === 'true',
  // TRAIN 3 — grounded query runtime (PRODUCT-002). DORMANT by default.
  //
  // The reason it is dormant CHANGED, and the old one is no longer true.
  // Until the governed chain was installed, grounding_0002 and grounding_0003
  // were applied to no database and the persisted GroundingChunkRepository had
  // nothing to read. As of 06041e1 the chain T1->T9 is 9/9 INSTALLED in
  // staging, measured remotely, so the READ side has a real surface.
  //
  // What keeps the flag false is now the WRITE side: no application code path
  // calls `ingestEvidenceDocument`, so a staging project has no evidence chunks
  // to ground an answer in. See the audit's G-01.
  //
  // The flag is checked FIRST in the server action, before auth, quota, any
  // connection and any observability event — see
  // app/actions/stella/grounded-query.ts.
  isGroundedQueryEnabled: process.env.STELLA_GROUNDED_QUERY_ENABLED === 'true',

  // Request timeout (ms)
  requestTimeoutMs: 15000,

  // WS3 adapter caps — deterministic, bounded model calls.
  // Max output tokens per generation (default 4096).
  maxOutputTokens: envPositiveInt('STELLA_MAX_OUTPUT_TOKENS', 4096),
  //
  // G1-M0 — NO SAMPLING PARAMETERS. There is deliberately no `temperature`,
  // no `topP` and no `topK` here, and `STELLA_TEMPERATURE` is no longer read.
  //
  // temperature/top_p/top_k are deprecated for Gemini 3.6 Flash and must not be
  // sent. The knob was REMOVED rather than left unwired: an env var that still
  // parses, still validates its range and then changes nothing is worse than an
  // absent one — it invites an operator to "lower the temperature" during an
  // incident and conclude the model ignored them.
  //
  // Output stability now rests entirely on the deterministic tier: the system
  // prompt and step contracts, the provider-side responseJsonSchema, the strict
  // Zod schemas, the citation-catalog validators and the guardrails. That is
  // where it always actually rested — temperature 0.2 narrowed variance, it
  // never constrained a claim.
  //
  // Aggregate input cap: serialized system prompt + user message chars.
  maxPromptChars: envPositiveInt('STELLA_MAX_PROMPT_CHARS', 120000),

  // Rate limit per org per hour (configurable)
  rateLimitPerHour: parseInt(process.env.STELLA_RATE_LIMIT_PER_HOUR ?? '100', 10),
} as const

// Computed flags
//
// G1-B PRECONDITIONS — `.trim()`, and it is not cosmetic.
//
// This used to read `geminiApiKey.length > 0` while
// `lib/stella/capability-readiness.ts` read `geminiApiKey.trim() === ''`. A key
// set to whitespace — a mis-pasted secret, a trailing newline in a Vercel value
// — was therefore PRESENT to the six action gates (which decide whether to
// proceed) and ABSENT to the readiness table (which only reports). The action
// won: the run continued, minted a ticket, RESERVED a quota unit, and handed
// "   " to Google as an API key. The failure arrived as a provider 4xx after
// the reservation instead of as a refusal before it.
export const stellaState = {
  canUseStella: stellaConfig.isEnabled && stellaConfig.geminiApiKey.trim().length > 0,
  missingApiKey: stellaConfig.isEnabled && stellaConfig.geminiApiKey.trim().length === 0,
} as const
