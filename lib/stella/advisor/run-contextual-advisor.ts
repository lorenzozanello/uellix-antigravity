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
import { decodeProviderSourceRefIndexes } from '../context/decode-provider-source-ref-indexes'
import { StellaTimeoutError, StellaGeminiError } from '../errors'
import type { StellaGeminiAdapter } from '../adapter/gemini-client'

export type RunContextualAdvisorResult =
  | { ok: true; data: AdvisorContextualOutput; modelUsed: string; tokensUsed?: number }
  | { ok: false; error: 'PARSE_ERROR' | 'GEMINI_ERROR' | 'TIMEOUT'; message: string }

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
    const data = decodeProviderSourceRefIndexes(raw, request.canonicalSourceFieldPaths, step)
    return { ok: true, data, modelUsed: response.modelUsed, tokensUsed: response.tokensUsed }
  } catch (error) {
    if (error instanceof StellaTimeoutError) return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
    if (error instanceof StellaGeminiError) return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
    return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
  }
}
