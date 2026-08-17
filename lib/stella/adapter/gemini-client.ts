// lib/stella/adapter/gemini-client.ts
// Sprint 9B: Stella Gemini adapter - server-only, request/response, no streaming
// Dynamic import of @google/genai ensures this stays server-side only (never bundled client)

import { redactSecrets } from '@/lib/security/redact-secrets'
import { stellaConfig } from '../config'
import { StellaParseError, StellaGeminiError, StellaTimeoutError } from '../errors'
import { assertPromptWithinLimit } from '../security/payload-limits'
import { redactProviderRequest } from '../security/redact-model-bound'
import type { StellaRequest, StellaResponse, StellaMockProvider, StellaAdapterConfig } from './types'

export class StellaGeminiAdapter {
  private config: StellaAdapterConfig
  private mockProvider?: StellaMockProvider

  constructor(config?: Partial<StellaAdapterConfig>) {
    this.config = {
      apiKey: config?.apiKey || stellaConfig.geminiApiKey,
      model: config?.model || stellaConfig.geminiModel,
      timeoutMs: config?.timeoutMs || stellaConfig.requestTimeoutMs,
      maxOutputTokens: config?.maxOutputTokens ?? stellaConfig.maxOutputTokens,
      maxPromptChars: config?.maxPromptChars ?? stellaConfig.maxPromptChars,
      mockProvider: config?.mockProvider,
    }

    if (config?.mockProvider) {
      this.mockProvider = config.mockProvider
    }
  }

  /**
   * Generate response using Gemini API or mock provider.
   * Returns raw string output — caller is responsible for parsing and validation.
   */
  async generate(request: StellaRequest): Promise<StellaResponse> {
    // Central input cap — enforced BEFORE any provider (mock or real) so an
    // oversized payload can never reach the model or count against quota.
    assertPromptWithinLimit(request, this.config.maxPromptChars)

    // F-GB-01: THE MODEL BOUNDARY.
    //
    // Every path to a provider — the four Stella server actions, the
    // contextual advisor pipeline and the offline eval harness — reaches the
    // network through this method, so this is the one place where "no personal
    // data and no credential leaves the application" can be stated as a fact
    // about the system rather than as a rule each caller has to remember.
    //
    // It sits AHEAD of the mockProvider branch deliberately. A test provider
    // must observe exactly the bytes Google would observe; if this moved below
    // the branch, every redaction assertion written against a mock would go
    // quietly vacuous while the live path leaked.
    const safeRequest = redactProviderRequest(request)

    // A redaction token can be longer than the value it replaced, so the cap
    // is re-checked against what actually egresses rather than only against
    // what the caller submitted.
    assertPromptWithinLimit(safeRequest, this.config.maxPromptChars)

    // Tests inject a mock provider — no real Gemini calls ever happen in tests
    if (this.mockProvider) {
      return this.mockProvider.generate(safeRequest)
    }

    if (!this.config.apiKey) {
      throw new Error('GEMINI_API_KEY is required but not configured')
    }

    return this.generateWithTimeout(safeRequest, this.config.timeoutMs)
  }

  private async generateWithTimeout(request: StellaRequest, timeoutMs: number): Promise<StellaResponse> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      // Dynamic import keeps @google/genai out of the client bundle
      const { GoogleGenAI } = await import('@google/genai')
      const ai = new GoogleGenAI({ apiKey: this.config.apiKey })

      // G1-M0: NO SAMPLING PARAMETERS IN THIS OBJECT.
      //
      // `temperature` used to sit between maxOutputTokens and the schema. It is
      // gone, and `topP`/`topK` were never here. temperature/top_p/top_k are
      // deprecated for Gemini 3.6 Flash and must be omitted from the request —
      // omitted, not sent as null: @google/genai copies these fields under a
      // `!= null` guard (dist/index.mjs, tGenerateContentConfig), so an absent
      // key produces no key in the wire body, while an explicit null would.
      //
      // What remains is the whole determinism contract, and it is structural
      // rather than statistical: the trusted system instruction, a JSON-only
      // response type, a bounded output, the provider-side JSON schema when the
      // caller supplies one, and the abort signal.
      //
      // ─────────────────────────────────────────────────────────────────────
      // THINKING: NO `thinkingConfig`, AND THAT IS A MEASUREMENT DECISION.
      //
      // gemini-3.6-flash runs at thinking level `medium` BY DEFAULT. This is the
      // model's stated contract, not a possibility — so the absence of
      // `thinkingConfig` here does not mean "no thinking", it means "the target's
      // own default, unmodified".
      //
      // It is left unset ON PURPOSE for G1-A: the first real canary must measure
      // the natural behaviour of the stable target before anyone tunes it.
      // Setting `minimal`/`low`/`high` now would mean certifying a configuration
      // nobody has evidence about, which is the failure this gate exists to
      // avoid.
      //
      // TWO CONSEQUENCES G1-A MUST OBSERVE, because both are real and neither is
      // visible from here:
      //   * thinking tokens count toward `maxOutputTokens` (4096), so a
      //     thinking-heavy response can truncate the JSON. That path fails
      //     CLOSED — empty or unparseable text becomes StellaParseError, the
      //     ticket aborts and nothing is charged — but it fails.
      //   * thinking tokens are BILLED AS OUTPUT (lib/stella/cost-model.ts,
      //     assumption 4), so they are the expensive direction.
      //
      // Tuning `thinkingConfig` is a post-G1-A decision, taken against measured
      // thoughtsTokenCount / finish reasons — never as a guess.
      // ─────────────────────────────────────────────────────────────────────
      const response = await ai.models.generateContent({
        model: this.config.model,
        contents: request.userMessage,
        config: {
          systemInstruction: request.systemPrompt,
          responseMimeType: 'application/json',
          maxOutputTokens: this.config.maxOutputTokens,
          ...(request.responseJsonSchema ? { responseJsonSchema: request.responseJsonSchema } : {}),
          abortSignal: controller.signal,
        },
      })

      const rawOutput = response.text ?? ''
      if (!rawOutput) {
        throw new StellaParseError('Gemini returned an empty response')
      }

      return {
        role: request.role,
        rawOutput,
        parsedOutput: null,
        modelUsed: this.config.model,
        tokensUsed: response.usageMetadata?.totalTokenCount,
        timestamp: new Date(),
      }
    } catch (error) {
      if (error instanceof StellaParseError) throw error
      if (error instanceof StellaGeminiError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new StellaTimeoutError()
      }
      // AbortError may also surface as a plain Error with name 'AbortError'
      if (error instanceof Error && error.name === 'AbortError') {
        throw new StellaTimeoutError()
      }
      // Surface the real Gemini failure (status + message, key redacted) to the
      // server logs. The user only ever sees a generic GEMINI_ERROR, so without
      // this line a blocked/leaked key or 4xx from Google is invisible in Vercel.
      console.error('[stella] Gemini API call failed:', {
        role: request.role,
        ...buildGeminiErrorLog(error, this.config.apiKey),
      })
      // F-GB-02: the message is redacted at CONSTRUCTION, not at each of the
      // places that later read it. A provider error routinely echoes the
      // failing request — the key in the query string of a 403, a bearer token
      // from a proxy, the request body on a 400 — and this object then travels
      // to `reportStellaFailure` (Sentry) and into server logs. Redacting here
      // means every downstream consumer inherits it, including ones written
      // after this line.
      throw new StellaGeminiError(
        redactSecrets(error instanceof Error ? error.message : String(error), [this.config.apiKey])
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Validate and parse response JSON using caller's schema
   * This ensures type safety and prevents hallucination
   */
  async parseResponse<T>(rawOutput: string, schema: { parse: (data: unknown) => T }): Promise<T> {
    try {
      const parsed = JSON.parse(rawOutput)
      return schema.parse(parsed) // Zod validation
    } catch (error) {
      throw new StellaParseError(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Check if adapter is ready to use
   */
  isReady(): boolean {
    return !!this.config.apiKey || !!this.mockProvider
  }
}

/**
 * Extract a safe, structured summary of a Gemini/@google/genai error for
 * server-side logging.
 *
 * F-GB-02: this used to redact by splitting the message on the CONFIGURED key
 * — `apiKey ? rawMessage.split(apiKey).join('[REDACTED]') : rawMessage`. Two
 * holes, both load-bearing:
 *
 *   1. It defended against exactly one value. A Postgres DSN echoed by a
 *      driver, a bearer token in a proxy's 401, a session cookie in a captured
 *      header all passed through untouched.
 *   2. When `apiKey` is the empty string — the mock-provider and test
 *      configuration, and any misconfigured deployment — the ternary forwards
 *      the RAW message. The redaction disappeared exactly when the
 *      configuration was already wrong.
 *
 * Now the pattern rules decide, and the configured key is passed as one more
 * known value on top of them rather than as the mechanism.
 */
export function buildGeminiErrorLog(
  error: unknown,
  apiKey: string
): { status?: number; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = redactSecrets(rawMessage, [apiKey])

  const statusValue = (error as { status?: unknown } | null)?.status
  const status = typeof statusValue === 'number' ? statusValue : undefined

  return status === undefined ? { message } : { status, message }
}

// Construct a fresh adapter per call. Adapters are cheap (they only hold config;
// the real GoogleGenAI client is created per request inside generateWithTimeout).
// A module-level singleton in a warm serverless instance could otherwise pin a
// stale API key after a rotation until the next cold start.
export function getGeminiAdapter(config?: Partial<StellaAdapterConfig>): StellaGeminiAdapter {
  return new StellaGeminiAdapter(config)
}
