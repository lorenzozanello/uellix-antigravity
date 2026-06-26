// lib/stella/index.ts
// Sprint 9B: Stella public API exports

// Configuration
export { stellaConfig, stellaState } from './config'

// Errors
export {
  StellaError,
  StellaDisabledError,
  StellaMissingApiKeyError,
  StellaParseError,
  StellaTimeoutError,
  StellaRateLimitError,
  StellaGeminiError,
} from './errors'

// Adapter
export { StellaGeminiAdapter, getGeminiAdapter, resetGeminiAdapter } from './adapter/gemini-client'
export type { StellaRole, StellaRequest, StellaResponse, StellaMockProvider, StellaAdapterConfig } from './adapter/types'

// Schemas
export {
  AdvisorOutputSchema,
  type AdvisorOutput,
  ValidatorOutputSchema,
  type ValidatorOutput,
  ComposerOutputSchema,
  type ComposerOutput,
} from './schemas'

// Prompts
export {
  SHARED_GUARDRAILS,
  buildAdvisorSystemPrompt,
  buildAdvisorUserMessage,
  buildValidatorSystemPrompt,
  buildValidatorUserMessage,
  buildComposerSystemPrompt,
  buildComposerUserMessage,
} from './prompts'

// Context
export type { StellaProjectContext, OutcomeRef, IndicatorRef, EvidenceMeta, ProxyRef, FilterRef, CalculationSnapshot, SectionRef } from './context/types'
export { sanitizeString, sanitizeNarrative, sanitizeOutcome, markAsData, hasForbiddenPattern } from './context/sanitize'

// Fallbacks
export {
  ADVISOR_FALLBACK,
  VALIDATOR_FALLBACK,
  COMPOSER_FALLBACK,
  UNAVAILABLE_MESSAGE,
} from './fallbacks'
