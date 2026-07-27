// lib/stella/pilot/mock-provider.ts
// Etapa B0 (modo piloto restringido) — a deterministic, clearly-labeled
// synthetic provider used when `providerMode === 'mock'`. Lets the FULL
// pilot request path (access → consent → quota → guardrail → rate-limit →
// "provider" → parse → audit) run end-to-end in a real deployment without
// ever touching real Gemini — useful for exercising the pipeline safely
// before committing to paid calls. Distinct from the per-test mocks in
// __tests__ files: this one is a real, importable runtime implementation.

import type { StellaRequest, StellaResponse, StellaMockProvider } from '../adapter/types'
import { StellaTimeoutError, StellaGeminiError } from '../errors'

const ADVISOR_MOCK_OUTPUT = {
  step: 'pilot-mock',
  what_to_do: '[RESPUESTA SINTÉTICA DE PILOTO] Define con claridad el objetivo metodológico de este paso antes de continuar.',
  why_it_matters: '[RESPUESTA SINTÉTICA DE PILOTO] Un paso bien fundamentado sostiene el rigor del análisis SROI completo.',
  how_to_do_it: '[RESPUESTA SINTÉTICA DE PILOTO] Documenta supuestos, fuentes y alcance de forma explícita.',
  common_mistakes: ['[SINTÉTICO] Omitir el alcance del análisis', '[SINTÉTICO] No documentar los supuestos'],
  suggested_next_actions: ['[SINTÉTICO] Revisar la documentación del paso siguiente', '[SINTÉTICO] Validar con el equipo del proyecto'],
}

/**
 * Every scenario this mock can simulate, so the pilot pipeline's error
 * handling (advisor.ts's existing StellaTimeoutError/StellaGeminiError/
 * StellaParseError catches) can be exercised end-to-end WITHOUT a real
 * Gemini call. 'success' is the only scenario used in production wiring
 * (getStellaAdvisor's `new StellaPilotMockProvider()`, no args); the rest
 * exist for tests.
 */
export type StellaPilotMockScenario =
  | 'success'
  | 'timeout'
  | 'provider_error'
  | 'invalid_response'
  | 'token_overflow'
  | 'cancelled'

export interface StellaPilotMockProviderOptions {
  scenario?: StellaPilotMockScenario
}

/**
 * Returns a fixed, clearly-labeled synthetic response regardless of the
 * request content — this is NOT a quality simulation of the real model, it
 * only proves the pipeline's plumbing (access control, guardrails, audit,
 * parsing) works end-to-end without spending a real paid-tier call.
 */
export class StellaPilotMockProvider implements StellaMockProvider {
  private readonly scenario: StellaPilotMockScenario

  constructor(options: StellaPilotMockProviderOptions = {}) {
    this.scenario = options.scenario ?? 'success'
  }

  async generate(request: StellaRequest): Promise<StellaResponse> {
    switch (this.scenario) {
      case 'timeout':
        // Mirrors StellaGeminiAdapter's own AbortController timeout path —
        // the caller (advisor.ts) already maps StellaTimeoutError to its
        // 'TIMEOUT' error code, so no new handling is needed there.
        throw new StellaTimeoutError()

      case 'provider_error':
        throw new StellaGeminiError('[stella-pilot-mock] simulated provider error')

      case 'token_overflow':
        // No dedicated error class exists for this in lib/stella/errors.ts —
        // documented as a StellaGeminiError with a distinguishing message,
        // since a real over-limit request would surface as a provider-side
        // rejection, not a parse or timeout failure.
        throw new StellaGeminiError('[stella-pilot-mock] simulated token overflow: request exceeds the model context limit')

      case 'cancelled':
        // No standalone cancellation plumbing exists in the adapter (no
        // AbortSignal on StellaRequest) — the real adapter's own abort path
        // (gemini-client.ts) also resolves to StellaTimeoutError, so this
        // scenario is kept distinct only at the test/scenario-name level.
        throw new StellaTimeoutError()

      case 'invalid_response': {
        // Syntactically valid JSON that does NOT satisfy AdvisorOutputSchema
        // — proves adapter.parseResponse()'s existing schema validation
        // fails closed to StellaParseError instead of silently coercing.
        const rawOutput = JSON.stringify({ step: request.role, unexpected_shape: true })
        return {
          role: request.role,
          rawOutput,
          parsedOutput: null,
          modelUsed: 'stella-pilot-mock',
          tokensUsed: 0,
          timestamp: new Date(),
        }
      }

      case 'success':
      default: {
        const rawOutput = JSON.stringify({ ...ADVISOR_MOCK_OUTPUT, step: request.role })
        return {
          role: request.role,
          rawOutput,
          parsedOutput: null,
          modelUsed: 'stella-pilot-mock',
          tokensUsed: 0,
          timestamp: new Date(),
        }
      }
    }
  }
}
