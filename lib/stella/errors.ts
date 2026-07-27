// lib/stella/errors.ts
// Sprint 9B: Stella error types

export class StellaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StellaError'
  }
}

export class StellaDisabledError extends StellaError {
  constructor() {
    super('Stella is disabled')
    this.name = 'StellaDisabledError'
  }
}

export class StellaMissingApiKeyError extends StellaError {
  constructor() {
    super('Stella enabled but GEMINI_API_KEY is missing')
    this.name = 'StellaMissingApiKeyError'
  }
}

export class StellaParseError extends StellaError {
  constructor(message: string) {
    super(`Failed to parse Stella response: ${message}`)
    this.name = 'StellaParseError'
  }
}

export class StellaTimeoutError extends StellaError {
  constructor() {
    super('Stella request timeout')
    this.name = 'StellaTimeoutError'
  }
}

export class StellaRateLimitError extends StellaError {
  constructor() {
    super('Stella rate limit exceeded for organization')
    this.name = 'StellaRateLimitError'
  }
}

export class StellaGeminiError extends StellaError {
  constructor(message: string) {
    super(`Gemini API error: ${message}`)
    this.name = 'StellaGeminiError'
  }
}

// Etapa A1 (STL-A1-007) — thrown by assertContextHasNoForbiddenData() when the
// context built for a Stella call violates a hardcoded safety invariant
// (e.g. a proxy financial value slipped through). This is a deterministic,
// code-level check — it never depends on the model's behavior.
//
// Etapa A2.3 (STL-A23-006, DR-002/DR-003): `code` is optional and additive —
// existing throw sites that only pass a message keep working unchanged. New
// sensitive-population blocks (see sensitive-population.ts) set `code` so the
// 4 Stella actions can map it to a distinct, non-leaky error code without
// parsing the message string.
export class StellaContextGuardrailError extends StellaError {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'StellaContextGuardrailError'
    this.code = code
  }
}
