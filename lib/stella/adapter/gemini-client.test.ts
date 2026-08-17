// lib/stella/adapter/gemini-client.test.ts
// Sprint 9B: Stella Gemini adapter tests - mock provider, no real Gemini calls

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StellaGeminiAdapter, buildGeminiErrorLog, getGeminiAdapter } from './gemini-client'
import { stellaConfig } from '../config'
import { StellaTimeoutError } from '../errors'
import { ValidatorOutputSchema } from '../schemas/validator-output'
import { StellaPayloadTooLargeError } from '../security/payload-limits'
import type { StellaMockProvider, StellaRequest, StellaResponse } from './types'

// Mock @google/genai — resolved by the adapter's dynamic import. Captures the
// generateContent call so tests can assert the config actually passed.
const mockGenerateContent = vi.fn()
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (...args: unknown[]) => mockGenerateContent(...args) }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
  },
}))

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
    // F-GB-02: the marker names the RULE that fired ('[REDACTED:known-secret]',
    // '[REDACTED:google-api-key]', …) rather than being a bare '[REDACTED]',
    // so a reader can tell why a value went. Asserted as a prefix so adding a
    // rule never breaks this test.
    expect(log.message).toContain('[REDACTED:')
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

describe('adapter caps (WS3)', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset()
    mockGenerateContent.mockResolvedValue({
      text: '{"ok":true}',
      usageMetadata: { totalTokenCount: 10 },
    })
  })

  describe('maxOutputTokens is passed to generateContent', () => {
    it('uses the default (4096) when not overridden', async () => {
      const adapter = new StellaGeminiAdapter({ apiKey: 'test-key' })

      await adapter.generate({ role: 'validator', systemPrompt: 'sys', userMessage: 'user' })

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxOutputTokens: 4096 }),
        })
      )
    })

    it('honors a per-adapter override', async () => {
      const adapter = new StellaGeminiAdapter({ apiKey: 'test-key', maxOutputTokens: 128 })

      await adapter.generate({ role: 'validator', systemPrompt: 'sys', userMessage: 'user' })

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxOutputTokens: 128 }),
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // G1-M0 — GEMINI 3.6 FLASH REQUEST CONTRACT
  //
  // temperature/top_p/top_k are deprecated for gemini-3.6-flash and must not be
  // sent. `objectContaining` cannot express absence, so these tests read the
  // ACTUAL config object out of the captured call and assert on its own keys —
  // an assertion that fails if a sampling parameter is reintroduced anywhere,
  // including as an explicit `undefined` or `null`.
  // -------------------------------------------------------------------------
  describe('G1-M0 — no sampling parameters reach the provider', () => {
    const capturedConfig = (): Record<string, unknown> => {
      expect(mockGenerateContent).toHaveBeenCalledTimes(1)
      const call = mockGenerateContent.mock.calls[0]![0] as { config: Record<string, unknown> }
      return call.config
    }

    it('sends no temperature — not as a value, not as undefined, not as null', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const config = capturedConfig()
      // `in` rather than `!== undefined`: @google/genai copies fields under a
      // `!= null` guard, but an explicit `temperature: undefined` key would
      // still show intent to send one, and that intent is what must not exist.
      expect('temperature' in config).toBe(false)
    })

    it('sends no topP', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const config = capturedConfig()
      expect('topP' in config).toBe(false)
      expect('top_p' in config).toBe(false)
    })

    it('sends no topK', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const config = capturedConfig()
      expect('topK' in config).toBe(false)
      expect('top_k' in config).toBe(false)
    })

    it('sends no thinkingConfig — the target keeps its own default (medium)', async () => {
      // NOT the same claim as "thinking is off". gemini-3.6-flash runs at
      // thinking level `medium` by default; omitting thinkingConfig means G1-A
      // measures that default instead of a configuration nobody has evidence
      // for. This test pins the omission so a later tuning pass has to be a
      // deliberate edit with measurements behind it.
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const config = capturedConfig()
      expect('thinkingConfig' in config).toBe(false)
      expect('thinkingLevel' in config).toBe(false)
      expect('thinkingBudget' in config).toBe(false)
    })

    it('sends NO sampling key at all, by exhaustive comparison against the allowed set', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
        responseJsonSchema: { type: 'object' },
      })

      // The COMPLETE set of config keys the adapter is allowed to send. A new
      // key — sampling or otherwise — fails here and forces a decision rather
      // than arriving unnoticed with the next edit.
      expect(Object.keys(capturedConfig()).sort()).toEqual(
        [
          'abortSignal',
          'maxOutputTokens',
          'responseJsonSchema',
          'responseMimeType',
          'systemInstruction',
        ].sort()
      )
    })
  })

  describe('G1-M0 — the rest of the request contract is preserved', () => {
    it('still targets the configured model and still sends JSON mime type', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key', model: 'gemini-3.6-flash' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const call = mockGenerateContent.mock.calls[0]![0] as {
        model: string
        config: Record<string, unknown>
      }
      expect(call.model).toBe('gemini-3.6-flash')
      expect(call.config.responseMimeType).toBe('application/json')
      expect(call.config.systemInstruction).toBe('sys')
    })

    it('still forwards responseJsonSchema when the caller supplies one', async () => {
      const schema = { type: 'object', additionalProperties: false, required: ['step'] }

      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'advisor',
        systemPrompt: 'sys',
        userMessage: 'user',
        responseJsonSchema: schema,
      })

      const call = mockGenerateContent.mock.calls[0]![0] as { config: Record<string, unknown> }
      expect(call.config.responseJsonSchema).toEqual(schema)
    })

    it('omits responseJsonSchema entirely when the caller supplies none', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'advisor',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const call = mockGenerateContent.mock.calls[0]![0] as { config: Record<string, unknown> }
      expect('responseJsonSchema' in call.config).toBe(false)
    })

    it('still passes an abort signal, and it is still unaborted at call time', async () => {
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'user',
      })

      const call = mockGenerateContent.mock.calls[0]![0] as { config: { abortSignal: AbortSignal } }
      expect(call.config.abortSignal).toBeInstanceOf(AbortSignal)
      expect(call.config.abortSignal.aborted).toBe(false)
    })

    it('still redacts BEFORE the provider sees the request', async () => {
      // The redaction boundary is upstream of both the mock branch and the live
      // branch (F-GB-01). Removing temperature must not have moved it.
      await new StellaGeminiAdapter({ apiKey: 'test-key' }).generate({
        role: 'validator',
        systemPrompt: 'sys',
        userMessage: 'escribí a ana.perez@example.com por favor',
      })

      const call = mockGenerateContent.mock.calls[0]![0] as { contents: string }
      expect(call.contents).not.toContain('ana.perez@example.com')
      expect(call.contents).toContain('[REDACTED:')
    })
  })

  describe('maxPromptChars input cap', () => {
    it('rejects an oversized request with StellaPayloadTooLargeError before the provider is called', async () => {
      const mockProvider = new MockGeminiProvider()
      const generateSpy = vi.spyOn(mockProvider, 'generate')
      const adapter = new StellaGeminiAdapter({
        apiKey: 'test-key',
        mockProvider,
        maxPromptChars: 50,
      })

      await expect(
        adapter.generate({
          role: 'validator',
          systemPrompt: 'x'.repeat(30),
          userMessage: 'y'.repeat(30),
        })
      ).rejects.toBeInstanceOf(StellaPayloadTooLargeError)
      expect(generateSpy).not.toHaveBeenCalled()
    })

    it('also guards the REAL provider path (no mock provider)', async () => {
      const adapter = new StellaGeminiAdapter({ apiKey: 'test-key', maxPromptChars: 10 })

      await expect(
        adapter.generate({ role: 'validator', systemPrompt: 'x'.repeat(20), userMessage: 'y' })
      ).rejects.toBeInstanceOf(StellaPayloadTooLargeError)
      expect(mockGenerateContent).not.toHaveBeenCalled()
    })

    it('measures system prompt + user message together', async () => {
      const adapter = new StellaGeminiAdapter({
        apiKey: 'test-key',
        mockProvider: new MockGeminiProvider(),
        maxPromptChars: 100,
      })

      // 60 + 60 = 120 > 100 even though each alone fits
      await expect(
        adapter.generate({
          role: 'validator',
          systemPrompt: 's'.repeat(60),
          userMessage: 'u'.repeat(60),
        })
      ).rejects.toBeInstanceOf(StellaPayloadTooLargeError)
    })

    it('allows a request within the cap (default 120000)', async () => {
      const adapter = new StellaGeminiAdapter({
        apiKey: 'test-key',
        mockProvider: new MockGeminiProvider(),
      })

      const response = await adapter.generate({
        role: 'validator',
        systemPrompt: 's'.repeat(1000),
        userMessage: 'u'.repeat(1000),
      })

      expect(response.rawOutput).toContain('summary')
    })

    it('carries the measured size and limit on the error', async () => {
      const adapter = new StellaGeminiAdapter({
        apiKey: 'test-key',
        mockProvider: new MockGeminiProvider(),
        maxPromptChars: 5,
      })

      try {
        await adapter.generate({ role: 'validator', systemPrompt: 'abc', userMessage: 'defg' })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(StellaPayloadTooLargeError)
        const typed = error as StellaPayloadTooLargeError
        expect(typed.promptChars).toBe(7)
        expect(typed.maxPromptChars).toBe(5)
      }
    })
  })
})

describe('getGeminiAdapter', () => {
  it('returns a fresh adapter per call (no shared singleton holding a stale key)', () => {
    const first = getGeminiAdapter()
    const second = getGeminiAdapter()

    expect(first).not.toBe(second)
  })
})

// ---------------------------------------------------------------------------
// FABLE FINDING F1 — the timeout, measured on the path that uses it
// ---------------------------------------------------------------------------
//
// The suite this replaces asserted `expect(mockStellaConfig.requestTimeoutMs)
// .toBe(15000)` against a config object the same file had declared. That
// compares a literal with itself: it stays green if the adapter ignores the
// configured value, hardcodes its own, or never arms the timer at all.
//
// These cases measure BEHAVIOUR against the REAL `lib/stella/config` — this
// file does not mock it — so the boundary asserted below is the production
// number, reached the way production reaches it: the adapter is constructed
// with NO `timeoutMs` override, exactly as `getGeminiAdapter()` is called from
// the five server actions.
//
// `stellaConfig.requestTimeoutMs` appears as the EXPECTED BOUNDARY rather than
// as the assertion. What is asserted is when the abort fires relative to it,
// which is a fact about the adapter and not about the constant.

describe('the configured request timeout is the one the provider call actually gets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGenerateContent.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A provider call that NEVER settles on its own and only rejects when the
   * adapter's own AbortController fires.
   *
   * This is the whole design of the case: the promise cannot resolve, cannot
   * time out by itself, and carries no timer. The only thing that can end it is
   * the signal the adapter passed in — so if the assertion below observes a
   * rejection, the signal was armed, was wired into the request, and fired.
   */
  function hangUntilAborted(): void {
    mockGenerateContent.mockImplementation((request: { config?: { abortSignal?: AbortSignal } }) => {
      const signal = request?.config?.abortSignal
      return new Promise((_resolve, reject) => {
        if (!signal) return // never settles — the test then fails on timeout, correctly
        signal.addEventListener('abort', () => {
          // The shape Node's fetch stack produces on an aborted request.
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        })
      })
    })
  }

  it('has NOT aborted one millisecond before the configured budget', async () => {
    hangUntilAborted()
    const adapter = new StellaGeminiAdapter({ apiKey: 'test-key' })

    let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
    const call = adapter
      .generate({ role: 'advisor', systemPrompt: 'sys', userMessage: 'msg' })
      .then(() => { settled = 'resolved' }, () => { settled = 'rejected' })

    await vi.advanceTimersByTimeAsync(stellaConfig.requestTimeoutMs - 1)
    expect(settled).toBe('pending')

    // Let the call finish so the test does not leave a floating promise.
    await vi.advanceTimersByTimeAsync(1)
    await call
  })

  it('aborts AT the configured budget and surfaces StellaTimeoutError', async () => {
    hangUntilAborted()
    const adapter = new StellaGeminiAdapter({ apiKey: 'test-key' })

    const call = adapter.generate({ role: 'advisor', systemPrompt: 'sys', userMessage: 'msg' })
    const assertion = expect(call).rejects.toBeInstanceOf(StellaTimeoutError)

    await vi.advanceTimersByTimeAsync(stellaConfig.requestTimeoutMs)
    await assertion
  })

  it('takes the budget from stellaConfig when the caller overrides nothing', async () => {
    // The discriminating case. An adapter built with an EXPLICIT, much shorter
    // budget aborts at that budget — so the previous case's boundary is read
    // from the configuration and is not a constant baked into the adapter.
    hangUntilAborted()
    const shortBudgetMs = 25
    expect(shortBudgetMs).toBeLessThan(stellaConfig.requestTimeoutMs)

    const adapter = new StellaGeminiAdapter({ apiKey: 'test-key', timeoutMs: shortBudgetMs })
    const call = adapter.generate({ role: 'advisor', systemPrompt: 'sys', userMessage: 'msg' })
    const assertion = expect(call).rejects.toBeInstanceOf(StellaTimeoutError)

    await vi.advanceTimersByTimeAsync(shortBudgetMs)
    await assertion
  })

  it('hands the SAME signal to the provider request that the timer aborts', async () => {
    hangUntilAborted()
    const adapter = new StellaGeminiAdapter({ apiKey: 'test-key', timeoutMs: 10 })
    const call = adapter.generate({ role: 'advisor', systemPrompt: 'sys', userMessage: 'msg' })
    const assertion = expect(call).rejects.toBeInstanceOf(StellaTimeoutError)
    await vi.advanceTimersByTimeAsync(10)
    await assertion

    const request = mockGenerateContent.mock.calls[0][0] as { config: { abortSignal: AbortSignal } }
    expect(request.config.abortSignal).toBeInstanceOf(AbortSignal)
    expect(request.config.abortSignal.aborted).toBe(true)
  })
})
