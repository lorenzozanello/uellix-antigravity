'use server'
// app/actions/stella/advisor.ts
// Sprint 9C-1: Stella Advisor server action
// Security: feature-flagged, auth-gated, metadata-only context, no DB writes, no secret logging

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildAdvisorContext, StellaBuildContextError } from '@/lib/stella/context/build-advisor-context'
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from '@/lib/stella/prompts/advisor-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { AdvisorOutputSchema } from '@/lib/stella/schemas/advisor-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'

export type StellaAdvisorErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN_ERROR'

export type StellaAdvisorResult =
  | { ok: true; data: AdvisorOutput }
  | { ok: false; error: StellaAdvisorErrorCode; message: string }

export async function getStellaAdvisor(
  projectId: string,
  step: string
): Promise<StellaAdvisorResult> {
  // Feature flag gate — all flags default to false
  if (!stellaConfig.isEnabled || !stellaConfig.isAdvisorEnabled || !stellaState.canUseStella) {
    return {
      ok: false,
      error: 'DISABLED',
      message: 'Stella Advisor is not enabled.',
    }
  }

  // Auth + org context — redirects if unauthenticated
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return {
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'Authentication required.',
    }
  }

  // Build project context (validates project ownership, metadata only)
  try {
    const context = await buildAdvisorContext(projectId, ctx.organization.id, step)

    // Build prompts from existing builders
    const systemPrompt = buildAdvisorSystemPrompt(step)
    const userMessage = buildAdvisorUserMessage(step, context)

    // Generate via Gemini adapter (real or mock in tests)
    const adapter = getGeminiAdapter()
    const response = await adapter.generate({
      role: 'advisor',
      systemPrompt,
      userMessage,
    })

    // Parse and validate output — throws StellaParseError on invalid JSON or schema mismatch
    const data = await adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)

    return { ok: true, data }
  } catch (error) {
    if (error instanceof StellaBuildContextError) {
      if (error.code === 'UNSUPPORTED_STEP') {
        return { ok: false, error: 'UNSUPPORTED_STEP', message: error.message }
      }
      if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') {
        return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
      }
    }

    if (error instanceof StellaTimeoutError) {
      return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
    }

    if (error instanceof StellaParseError) {
      return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
    }

    if (error instanceof StellaGeminiError) {
      return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
    }

    return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
  }
}
