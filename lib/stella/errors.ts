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
