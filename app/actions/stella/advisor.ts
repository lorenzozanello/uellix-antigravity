'use server'
// app/actions/stella/advisor.ts
// Sprint 9C-1: Stella Advisor server action
// Security: feature-flagged, auth-gated, metadata-only context, audit-logged, no secret logging

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildAdvisorContext, StellaBuildContextError } from '@/lib/stella/context/build-advisor-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from '@/lib/stella/prompts/advisor-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { AdvisorOutputSchema } from '@/lib/stella/schemas/advisor-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'
import type { ContextualAdvisorContext } from '@/lib/stella/context/types'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import { buildAdvisorContextualUserMessage } from '@/lib/stella/prompts/advisor-contextual-system'
import { decodeProviderSourceRefIndexes } from '@/lib/stella/context/decode-provider-source-ref-indexes'
import type { StellaGeminiAdapter } from '@/lib/stella/adapter/gemini-client'

export type StellaAdvisorErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

export type StellaAdvisorResult =
  | { ok: true; data: AdvisorOutput }
  | { ok: false; error: StellaAdvisorErrorCode; message: string }

export type StellaContextualAdvisorResult =
  | { ok: true; data: AdvisorContextualOutput }
  | { ok: false; error: 'PARSE_ERROR' | 'GEMINI_ERROR' | 'TIMEOUT'; message: string }

/** Controlled contextual path: accepts already-built context and leaves the generic action unchanged. */
export async function getStellaContextualAdvisor(
  step: AdvisorPipelineStep,
  context: ContextualAdvisorContext,
  adapter: StellaGeminiAdapter = getGeminiAdapter(),
): Promise<StellaContextualAdvisorResult> {
  try {
    const request = buildContextualAdvisorRequest(step, context)
    const response = await adapter.generate({ role: 'advisor', systemPrompt: request.systemPrompt, userMessage: buildAdvisorContextualUserMessage(step, request.serializedContext), responseJsonSchema: request.responseJsonSchema })
    const raw: unknown = JSON.parse(response.rawOutput)
    return { ok: true, data: decodeProviderSourceRefIndexes(raw, request.canonicalSourceFieldPaths, step) }
  } catch (error) {
    if (error instanceof StellaTimeoutError) return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
    if (error instanceof StellaGeminiError) return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
    return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
  }
}

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

  // Quota check — enforced per org, per calendar month, DB-backed.
  // Every org defaults to quota 0 (blocked) until a super_admin assigns one.
  // Note: this check and the later audit insert (stella_interactions row)
  // are not transactionally consistent — a request that straddles a UTC
  // month rollover between this check and the insert could be counted
  // against the new month instead of the one it was checked against. This
  // is a narrow, low-severity race (sub-second window, once a month) and
  // an accepted tradeoff, not a bug.
  const quotaCheck = await checkStellaQuota(ctx.organization.id)
  if (!quotaCheck.allowed) {
    const message =
      quotaCheck.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }

  // Build project context (validates project ownership, metadata only)
  try {
    const context = await buildAdvisorContext(projectId, ctx.organization.id, step)

    // Consume after context validation and immediately before the model attempt.
    const rateLimit = await consumeStellaRateLimit(ctx.organization.id)
    if (!rateLimit.allowed) {
      return rateLimit.reason === 'unavailable'
        ? {
            ok: false,
            error: 'RATE_LIMIT_UNAVAILABLE',
            message: 'Stella rate limit service is temporarily unavailable.',
          }
        : {
            ok: false,
            error: 'RATE_LIMITED',
            message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.`,
          }
    }

    // Build prompts from existing builders
    const systemPrompt = buildAdvisorSystemPrompt(step)
    const userMessage = buildAdvisorUserMessage(step, context)
    const contextHash = buildContextHash(context)

    // Generate via Gemini adapter (real or mock in tests)
    const adapter = getGeminiAdapter()
    const response = await adapter.generate({
      role: 'advisor',
      systemPrompt,
      userMessage,
      contextHash,
    })

    // Parse and validate output — throws StellaParseError on invalid JSON or schema mismatch
    const data = await adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)

    // Audit insert — required for compliance and for quota measurement;
    // surface failure rather than swallow (mirrors validator.ts).
    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: 'advisor',
        pipelineStep: step,
        contextHash,
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
      })
    } catch {
      return {
        ok: false,
        error: 'AUDIT_ERROR',
        message: 'Failed to record Stella interaction. Please try again.',
      }
    }

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
