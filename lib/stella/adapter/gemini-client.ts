// lib/stella/adapter/gemini-client.ts
// Sprint 9B: Stella Gemini adapter - server-only, request/response, no streaming
// Dynamic import of @google/genai ensures this stays server-side only (never bundled client)

import { stellaConfig } from '../config'
import { StellaParseError, StellaGeminiError, StellaTimeoutError } from '../errors'
import type { StellaRequest, StellaResponse, StellaMockProvider, StellaAdapterConfig } from './types'

export class StellaGeminiAdapter {
  private config: StellaAdapterConfig
  private mockProvider?: StellaMockProvider

  constructor(config?: Partial<StellaAdapterConfig>) {
    this.config = {
      apiKey: config?.apiKey || stellaConfig.geminiApiKey,
      model: config?.model || stellaConfig.geminiModel,
      timeoutMs: config?.timeoutMs || stellaConfig.requestTimeoutMs,
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
    // Tests inject a mock provider — no real Gemini calls ever happen in tests
    if (this.mockProvider) {
      return this.mockProvider.generate(request)
    }

    if (!this.config.apiKey) {
      throw new Error('GEMINI_API_KEY is required but not configured')
    }

    return this.generateWithTimeout(request, this.config.timeoutMs)
  }

  private async generateWithTimeout(request: StellaRequest, timeoutMs: number): Promise<StellaResponse> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      // Dynamic import keeps @google/genai out of the client bundle
      const { GoogleGenAI } = await import('@google/genai')
      const ai = new GoogleGenAI({ apiKey: this.config.apiKey })

      const response = await ai.models.generateContent({
        model: this.config.model,
        contents: request.userMessage,
        config: {
          systemInstruction: request.systemPrompt,
          responseMimeType: 'application/json',
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
      throw new StellaGeminiError(error instanceof Error ? error.message : String(error))
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
 * server-side logging. Redacts the API key so it never lands in logs.
 */
export function buildGeminiErrorLog(
  error: unknown,
  apiKey: string
): { status?: number; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = apiKey ? rawMessage.split(apiKey).join('[REDACTED]') : rawMessage

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
