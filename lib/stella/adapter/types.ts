// lib/stella/adapter/types.ts
// Sprint 9B: Stella adapter types

export type StellaRole = 'advisor' | 'validator' | 'composer'

export interface StellaRequest {
  role: StellaRole
  systemPrompt: string
  userMessage: string
  contextHash?: string // SHA-256 of context for audit trail
}

export interface StellaResponse {
  role: StellaRole
  rawOutput: string // Raw JSON from Gemini
  parsedOutput: unknown // Validated by caller's schema
  modelUsed: string
  tokensUsed?: number
  timestamp: Date
}

export interface StellaMockProvider {
  // For testing: mock provider that returns predictable responses
  generate(request: StellaRequest): Promise<StellaResponse>
}

export interface StellaAdapterConfig {
  apiKey: string
  model: string
  timeoutMs: number
  mockProvider?: StellaMockProvider // For testing
}
