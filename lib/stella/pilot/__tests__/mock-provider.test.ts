// lib/stella/pilot/__tests__/mock-provider.test.ts
// Etapa B0 (modo piloto restringido) — proves every simulated failure mode
// surfaces through the SAME error classes advisor.ts already handles, so no
// new error-handling branch is needed there to support the pilot's mock
// provider.

import { describe, it, expect } from 'vitest'
import { StellaPilotMockProvider } from '../mock-provider'
import { StellaGeminiAdapter } from '../../adapter/gemini-client'
import { AdvisorOutputSchema } from '../../schemas/advisor-output'
import { StellaTimeoutError, StellaGeminiError, StellaParseError } from '../../errors'

const REQUEST = { role: 'advisor' as const, systemPrompt: 'sys', userMessage: 'user' }

describe('StellaPilotMockProvider', () => {
  it('defaults to the "success" scenario and returns a clearly-labeled synthetic response', async () => {
    const provider = new StellaPilotMockProvider()
    const result = await provider.generate(REQUEST)
    expect(result.modelUsed).toBe('stella-pilot-mock')
    expect(result.tokensUsed).toBe(0)
    expect(result.rawOutput).toContain('SINTÉTICO')
  })

  it('"success" output parses cleanly against AdvisorOutputSchema via the real adapter', async () => {
    const provider = new StellaPilotMockProvider({ scenario: 'success' })
    const adapter = new StellaGeminiAdapter({ mockProvider: provider })
    const response = await adapter.generate(REQUEST)
    const parsed = await adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)
    expect(parsed.what_to_do).toContain('SINTÉTICA')
  })

  it('"timeout" throws StellaTimeoutError — the same class advisor.ts already maps to its TIMEOUT error code', async () => {
    const provider = new StellaPilotMockProvider({ scenario: 'timeout' })
    await expect(provider.generate(REQUEST)).rejects.toBeInstanceOf(StellaTimeoutError)
  })

  it('"provider_error" throws StellaGeminiError', async () => {
    const provider = new StellaPilotMockProvider({ scenario: 'provider_error' })
    await expect(provider.generate(REQUEST)).rejects.toBeInstanceOf(StellaGeminiError)
  })

  it('"token_overflow" throws StellaGeminiError with a distinguishing message (no dedicated error class exists)', async () => {
    const provider = new StellaPilotMockProvider({ scenario: 'token_overflow' })
    await expect(provider.generate(REQUEST)).rejects.toThrow(/token overflow/i)
  })

  it('"cancelled" throws StellaTimeoutError — mirrors the real adapter\'s own abort path, which has no separate cancellation error class', async () => {
    const provider = new StellaPilotMockProvider({ scenario: 'cancelled' })
    await expect(provider.generate(REQUEST)).rejects.toBeInstanceOf(StellaTimeoutError)
  })

  it('"invalid_response" resolves (does not throw) but its rawOutput fails AdvisorOutputSchema validation with StellaParseError', async () => {
    const provider = new StellaPilotMockProvider({ scenario: 'invalid_response' })
    const adapter = new StellaGeminiAdapter({ mockProvider: provider })
    const response = await adapter.generate(REQUEST)
    expect(response.rawOutput).toBeTruthy()
    await expect(adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)).rejects.toBeInstanceOf(StellaParseError)
  })

  it('an unset scenario is equivalent to "success" (safe default)', async () => {
    const provider = new StellaPilotMockProvider({})
    const result = await provider.generate(REQUEST)
    expect(result.rawOutput).toContain('SINTÉTICO')
  })
})
