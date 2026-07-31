// lib/stella/advisor/run-contextual-advisor.ts
// Pure contextual advisor pipeline: build request, call the injected adapter, decode.
//
// This module performs NO authorization, NO feature-flag check, NO quota or
// rate-limit enforcement, and NO audit logging — it trusts nothing about the
// caller's identity or authority. It is not a server action and must never be
// exported from a 'use server' module without an authorizing wrapper in front
// of it. The only authorized entry point is getStellaContextualAdvisor in
// app/actions/stella/advisor.ts, which builds `context` itself from a
// server-derived organizationId and a project-ownership check before this
// function ever runs.

import type { AdvisorPipelineStep } from './steps'
import type { ContextualAdvisorContext } from '../context/types'
import type { AdvisorContextualOutput } from '../schemas/advisor-contextual-output'
import { buildContextualAdvisorRequest } from '../context/build-contextual-advisor-request'
import { buildAdvisorContextualUserMessage } from '../prompts/advisor-contextual-system'
import { decodeProviderSourceRefIndexes, ProviderSourceRefIndexesError } from '../context/decode-provider-source-ref-indexes'
import { ContextualSourceFieldsValidationError } from '../context/validate-contextual-source-fields'
import { ContextualIndexTokenLeakError } from '../context/validate-no-index-reference-tokens'
import { buildContextualAdvisorFallback } from '../fallbacks'
import { StellaTimeoutError, StellaGeminiError } from '../errors'
import type { StellaGeminiAdapter } from '../adapter/gemini-client'

export type RunContextualAdvisorResult =
  | { ok: true; data: AdvisorContextualOutput; modelUsed: string; tokensUsed?: number; fallbackUsed?: true }
  | { ok: false; error: 'PARSE_ERROR' | 'GEMINI_ERROR' | 'TIMEOUT'; message: string }

/**
 * U8: citation-level failures are the only PARSE-level failures answered with
 * the safe contextual fallback. In these cases the provider produced a
 * structurally valid response whose citations we refuse to trust — the whole
 * response is discarded and replaced by a claim-free fallback. Structural or
 * schema failures (ProviderOutputContractError, InternalSchemaValidationError,
 * invalid JSON) are ambiguous about what the provider meant, so they stay
 * fail-closed as PARSE_ERROR.
 */
function isCitationLevelFailure(error: unknown): boolean {
  return (
    error instanceof ProviderSourceRefIndexesError ||
    error instanceof ContextualSourceFieldsValidationError ||
    error instanceof ContextualIndexTokenLeakError
  )
}

export async function runContextualAdvisor(
  step: AdvisorPipelineStep,
  context: ContextualAdvisorContext,
  adapter: StellaGeminiAdapter,
): Promise<RunContextualAdvisorResult> {
  try {
    const request = buildContextualAdvisorRequest(step, context)
    const response = await adapter.generate({
      role: 'advisor',
      systemPrompt: request.systemPrompt,
      userMessage: buildAdvisorContextualUserMessage(step, request.serializedContext),
      responseJsonSchema: request.responseJsonSchema,
    })
    const raw: unknown = JSON.parse(response.rawOutput)
    try {
      const data = decodeProviderSourceRefIndexes(raw, request.canonicalSourceFieldPaths, step)
      return { ok: true, data, modelUsed: response.modelUsed, tokensUsed: response.tokensUsed }
    } catch (decodeError) {
      if (isCitationLevelFailure(decodeError)) {
        return {
          ok: true,
          data: buildContextualAdvisorFallback(step),
          modelUsed: response.modelUsed,
          tokensUsed: response.tokensUsed,
          fallbackUsed: true,
        }
      }
      throw decodeError
    }
  } catch (error) {
    if (error instanceof StellaTimeoutError) return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
    if (error instanceof StellaGeminiError) return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
    return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
  }
}
