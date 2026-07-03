// lib/stella/config.ts
// Sprint 9B: Stella configuration from environment variables
// Server-only module. Never expose GEMINI_API_KEY to client.

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

  // Request timeout (ms)
  requestTimeoutMs: 15000,

  // Rate limit per org per hour (configurable)
  rateLimitPerHour: parseInt(process.env.STELLA_RATE_LIMIT_PER_HOUR ?? '100', 10),
} as const

// Computed flags
export const stellaState = {
  canUseStella: stellaConfig.isEnabled && stellaConfig.geminiApiKey.length > 0,
  missingApiKey: stellaConfig.isEnabled && !stellaConfig.geminiApiKey,
} as const
