// lib/stella/config.ts
// Sprint 9B: Stella configuration from environment variables
// Server-only module. Never expose GEMINI_API_KEY to client.

function envPositiveInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envTemperature(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] ?? '')
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback
}

export const stellaConfig = {
  // API Key: read from environment, never log or expose
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',

  // Model: default to gemini-2.5-flash, override via GEMINI_MODEL env var
  // Note: gemini-2.0-flash was retired by Google (returns 404 NOT_FOUND as of 2026-07).
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',

  // Feature flags: all default to false in MVP
  // Enabled only if explicitly set to 'true' (string)
  isEnabled: process.env.STELLA_ENABLED === 'true',
  isAdvisorEnabled: process.env.STELLA_ADVISOR_ENABLED === 'true',
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
  // TRAIN 3 — grounded query runtime (PRODUCT-002). DORMANT by default and
  // required to stay false: db/prepared/grounding_0002 and grounding_0003 are
  // applied to no database, so the persisted GroundingChunkRepository has
  // nothing to read. The flag is checked FIRST in the server action, before
  // auth, quota, any connection and any observability event — see
  // app/actions/stella/grounded-query.ts.
  isGroundedQueryEnabled: process.env.STELLA_GROUNDED_QUERY_ENABLED === 'true',

  // Request timeout (ms)
  requestTimeoutMs: 15000,

  // WS3 adapter caps — deterministic, bounded model calls.
  // Max output tokens per generation (default 4096).
  maxOutputTokens: envPositiveInt('STELLA_MAX_OUTPUT_TOKENS', 4096),
  // Sampling temperature (default 0.2 — low variance for audit-adjacent output).
  temperature: envTemperature('STELLA_TEMPERATURE', 0.2),
  // Aggregate input cap: serialized system prompt + user message chars.
  maxPromptChars: envPositiveInt('STELLA_MAX_PROMPT_CHARS', 120000),

  // Rate limit per org per hour (configurable)
  rateLimitPerHour: parseInt(process.env.STELLA_RATE_LIMIT_PER_HOUR ?? '100', 10),
} as const

// Computed flags
export const stellaState = {
  canUseStella: stellaConfig.isEnabled && stellaConfig.geminiApiKey.length > 0,
  missingApiKey: stellaConfig.isEnabled && !stellaConfig.geminiApiKey,
} as const
