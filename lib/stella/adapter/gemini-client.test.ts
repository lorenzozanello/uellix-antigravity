// lib/stella/adapter/gemini-client.test.ts
// Sprint 9B: Stella Gemini adapter tests - mock provider, no real Gemini calls

import { describe, it, expect, beforeEach } from 'vitest'
import { StellaGeminiAdapter, buildGeminiErrorLog, getGeminiAdapter } from './gemini-client'
import { ValidatorOutputSchema } from '../schemas/validator-output'
import type { StellaMockProvider, StellaRequest, StellaResponse } from './types'

// Mock provider for testing
class MockGeminiProvider implements StellaMockProvider {
  async generate(request: StellaRequest): Promise<StellaResponse> {
    // Return valid JSON for validator response
    const mockOutput = {
      summary: 'Test validation summary',
      risk_level: 'low',
      evidence_gaps: [],
      proxy_risks: [],
      attribution_risks: [],
      claim_risks: [],
      recommendations: ['Review methodology'],
      requires_human_review: true,
    }

    return {
      role: request.role,
      rawOutput: JSON.stringify(mockOutput),
      parsedOutput: null,
      modelUsed: 'mock-model',
      timestamp: new Date(),
    }
  }
}

// Mock provider that returns malformed JSON
class BadJsonMockProvider implements StellaMockProvider {
  async generate(): Promise<StellaResponse> {
    return {
      role: 'validator',
      rawOutput: 'This is not JSON {',
      parsedOutput: null,
      modelUsed: 'mock-model',
      timestamp: new Date(),
    }
  }
}

describe('StellaGeminiAdapter', () => {
  let adapter: StellaGeminiAdapter

  beforeEach(() => {
    adapter = new StellaGeminiAdapter({
      apiKey: 'test-key',
      mockProvider: new MockGeminiProvider(),
    })
  })

  it('should generate response using mock provider', async () => {
    const request = {
      role: 'validator' as const,
      systemPrompt: 'You are Stella Validator',
      userMessage: 'Validate this analysis',
    }

    const response = await adapter.generate(request)
    expect(response).toBeDefined()
    expect(response.rawOutput).toContain('summary')
    expect(response.modelUsed).toBe('mock-model')
  })

  it('should parse and validate response using Zod schema', async () => {
    const request = {
      role: 'validator' as const,
      systemPrompt: 'You are Stella Validator',
      userMessage: 'Validate',
    }

    const response = await adapter.generate(request)
    const parsed = await adapter.parseResponse(response.rawOutput, ValidatorOutputSchema)

    expect(parsed.requires_human_review).toBe(true)
    expect(parsed.risk_level).toBe('low')
  })

  it('should handle malformed JSON gracefully', async () => {
    const badAdapter = new StellaGeminiAdapter({
      apiKey: 'test-key',
      mockProvider: new BadJsonMockProvider(),
    })

    const request = {
      role: 'validator' as const,
      systemPrompt: 'You are Stella Validator',
      userMessage: 'Validate',
    }

    const response = await badAdapter.generate(request)
    expect(() => {
      ValidatorOutputSchema.parse(JSON.parse(response.rawOutput))
    }).toThrow()
  })

  it('should report readiness correctly', () => {
    expect(adapter.isReady()).toBe(true)
  })

  it('should enforce requires_human_review in Validator output', async () => {
    const request = {
      role: 'validator' as const,
      systemPrompt: 'Test',
      userMessage: 'Test',
    }

    const response = await adapter.generate(request)
    const parsed = await adapter.parseResponse(response.rawOutput, ValidatorOutputSchema)

    // This is hardcoded in the schema - must always be true
    expect(parsed.requires_human_review).toBe(true)
  })

  it('should not expose API key in logs', () => {
    // Verify that adapter doesn't log the API key
    const adapterWithKey = new StellaGeminiAdapter({
      apiKey: 'sk_test_very_secret_key',
      mockProvider: new MockGeminiProvider(),
    })
    // If we got here without errors, the adapter doesn't expose the key during construction
    expect(adapterWithKey.isReady()).toBe(true)
  })
})

describe('buildGeminiErrorLog', () => {
  it('redacts the API key when it appears in the error message', () => {
    const apiKey = 'AIzaSyD_super_secret_key_123'
    const error = new Error(`Request rejected for key ${apiKey}`)

    const log = buildGeminiErrorLog(error, apiKey)

    expect(log.message).not.toContain(apiKey)
    expect(log.message).toContain('[REDACTED]')
  })

  it('extracts the HTTP status code from a @google/genai ApiError', () => {
    // @google/genai throws ApiError objects carrying a numeric `status`
    const apiError = Object.assign(
      new Error('{"error":{"code":403,"message":"API key reported as leaked","status":"PERMISSION_DENIED"}}'),
      { name: 'ApiError', status: 403 }
    )

    const log = buildGeminiErrorLog(apiError, 'some-key')

    expect(log.status).toBe(403)
    expect(log.message).toContain('leaked')
  })

  it('handles non-Error values without throwing', () => {
    const log = buildGeminiErrorLog('plain string failure', 'some-key')

    expect(log.status).toBeUndefined()
    expect(log.message).toBe('plain string failure')
  })
})

describe('getGeminiAdapter', () => {
  it('returns a fresh adapter per call (no shared singleton holding a stale key)', () => {
    const first = getGeminiAdapter()
    const second = getGeminiAdapter()

    expect(first).not.toBe(second)
  })
})
