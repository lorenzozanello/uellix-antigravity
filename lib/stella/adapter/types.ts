// lib/stella/adapter/types.ts
// Sprint 9B: Stella adapter types

export type StellaRole =
  | 'advisor'
  | 'validator'
  | 'composer'
  // Fase 5b reviewer roles
  | 'proxy_reviewer'
  | 'evidence_reviewer'
  | 'audit_assistant'

export interface StellaRequest {
  role: StellaRole
  systemPrompt: string
  userMessage: string
  contextHash?: string // SHA-256 of context for audit trail
  responseJsonSchema?: Record<string, unknown>
}

/**
 * H2 — NUMERIC AND STRUCTURAL PROVIDER METADATA. NOTHING ELSE.
 *
 * Purely ADDITIVE observability: nothing in the product reads this, no request
 * byte changes because of it, and every field is optional because the provider
 * may omit any of them. It exists so the G1-A evidence package can state the
 * Gemini 3.6 thinking/latency contract as measurement rather than as belief.
 *
 * Property names are taken from the INSTALLED @google/genai 2.10.0 type
 * declarations, not from memory:
 *   GenerateContentResponse.modelVersion / .responseId / .usageMetadata
 *   GenerateContentResponse.candidates[0].finishReason  (enum FinishReason)
 *   GenerateContentResponseUsageMetadata.promptTokenCount /
 *     .candidatesTokenCount / .thoughtsTokenCount / .totalTokenCount /
 *     .cachedContentTokenCount
 *
 * WHAT MUST NEVER APPEAR HERE, because this object is persisted to an evidence
 * artifact a human will read and share: chain of thought or thought text, the
 * API key, authorization headers, any HTTP header, prompt or context text, or
 * the response body. Counts, ids, an enum and a timestamp — nothing that can
 * carry a payload.
 */
export interface StellaProviderUsage {
  readonly promptTokenCount?: number
  readonly candidatesTokenCount?: number
  /** Thinking tokens. gemini-3.6-flash thinks at level `medium` by default. */
  readonly thoughtsTokenCount?: number
  readonly totalTokenCount?: number
  readonly cachedContentTokenCount?: number
}

export interface StellaProviderMetadata {
  /** Provider-reported model id, which may differ from the one requested. */
  readonly modelVersion?: string
  readonly responseId?: string
  /** FinishReason enum value, e.g. 'STOP' or 'MAX_TOKENS'. */
  readonly finishReason?: string
  readonly usage: StellaProviderUsage
  /**
   * EXPLICIT AVAILABILITY, so an absent metric is never read as a zero.
   * `false` means the provider returned no usageMetadata at all — a different
   * fact from "it returned zero tokens", and the distinction decides whether a
   * missing thoughtsTokenCount means "no thinking" or "not reported".
   */
  readonly usageAvailable: boolean
}

export interface StellaResponse {
  role: StellaRole
  rawOutput: string // Raw JSON from Gemini
  parsedOutput: unknown // Validated by caller's schema
  modelUsed: string
  tokensUsed?: number
  timestamp: Date
  /** H2: absent on the mock-provider path; present on the live path. */
  providerMetadata?: StellaProviderMetadata
}

export interface StellaMockProvider {
  // For testing: mock provider that returns predictable responses
  generate(request: StellaRequest): Promise<StellaResponse>
}

export interface StellaAdapterConfig {
  apiKey: string
  model: string
  timeoutMs: number
  // WS3 adapter caps
  maxOutputTokens: number
  // G1-M0: no `temperature`, no `topP`, no `topK`. These are deprecated for
  // Gemini 3.6 Flash and must not be sent. Removed from the TYPE, not just from
  // the request, so a caller that tries to pass one fails to compile instead of
  // having it silently dropped. See lib/stella/config.ts.
  maxPromptChars: number
  mockProvider?: StellaMockProvider // For testing
}
