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

// Singleton instance (dev/test only - production should create per-org instance)
let adapterInstance: StellaGeminiAdapter | null = null

export function getGeminiAdapter(config?: Partial<StellaAdapterConfig>): StellaGeminiAdapter {
  if (!adapterInstance) {
    adapterInstance = new StellaGeminiAdapter(config)
  }
  return adapterInstance
}

export function resetGeminiAdapter(): void {
  adapterInstance = null
}
