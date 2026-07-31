'use server'
// app/actions/stella/advisor.ts
// Sprint 9C-1: Stella Advisor server action
// Security: feature-flagged, auth-gated, metadata-only context, audit-logged, no secret logging

import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildAdvisorContext, StellaBuildContextError } from '@/lib/stella/context/build-advisor-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage, resolveAdvisorStep } from '@/lib/stella/prompts/advisor-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { AdvisorOutputSchema } from '@/lib/stella/schemas/advisor-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { StellaPayloadTooLargeError } from '@/lib/stella/security/payload-limits'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import { runContextualAdvisor } from '@/lib/stella/advisor/run-contextual-advisor'

export type StellaAdvisorErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'PAYLOAD_TOO_LARGE'
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
  | { ok: false; error: StellaAdvisorErrorCode; message: string }

/**
 * Authorized contextual advisor path. Applies the exact same feature-flag,
 * auth, quota, project-ownership, rate-limit and audit guards as
 * getStellaAdvisor below, then hands off to the pure runContextualAdvisor
 * pipeline. organizationId always comes from the authenticated session
 * (requireOrganizationAccess), never from the caller — a caller can only
 * name a projectId, and buildAdvisorContext rejects it if it does not
 * belong to that session's organization.
 */
export async function getStellaContextualAdvisor(
  projectId: string,
  step: AdvisorPipelineStep,
): Promise<StellaContextualAdvisorResult> {
  // Feature flag gate — all flags default to false
  if (!stellaConfig.isEnabled || !stellaConfig.isAdvisorEnabled || !stellaState.canUseStella) {
    return { ok: false, error: 'DISABLED', message: 'Stella Advisor is not enabled.' }
  }

  // Auth + org context — redirects if unauthenticated
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  // Role gate — set inclusion (reviewer allowed, viewer denied); viewers never trigger AI calls.
  if (!canUseStella(ctx.membership.role)) {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  // Quota check — enforced per org, per calendar month, DB-backed.
  const quotaCheck = await checkStellaQuota(ctx.organization.id)
  if (!quotaCheck.allowed) {
    const message =
      quotaCheck.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }

  try {
    // Project ownership check happens inside buildAdvisorContext — throws
    // UNAUTHORIZED if projectId does not belong to ctx.organization.id.
    const context = await buildAdvisorContext(projectId, ctx.organization.id, step)
    const contextHash = buildContextHash(context)

    // Consume after context validation and immediately before the model attempt.
    const rateLimit = await consumeStellaRateLimit(ctx.organization.id)
    if (!rateLimit.allowed) {
      return rateLimit.reason === 'unavailable'
        ? { ok: false, error: 'RATE_LIMIT_UNAVAILABLE', message: 'Stella rate limit service is temporarily unavailable.' }
        : { ok: false, error: 'RATE_LIMITED', message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.` }
    }

    const result = await runContextualAdvisor(step, context, getGeminiAdapter())
    if (!result.ok) return result

    // Audit insert — required for compliance and for quota measurement;
    // surface failure rather than swallow (mirrors getStellaAdvisor below).
    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: 'advisor',
        pipelineStep: step,
        contextHash,
        responseJson: result.data as unknown,
        modelUsed: result.modelUsed,
        tokensUsed: result.tokensUsed,
      })
    } catch {
      return { ok: false, error: 'AUDIT_ERROR', message: 'Failed to record Stella interaction. Please try again.' }
    }

    return { ok: true, data: result.data }
  } catch (error) {
    if (error instanceof StellaBuildContextError) {
      if (error.code === 'UNSUPPORTED_STEP') return { ok: false, error: 'UNSUPPORTED_STEP', message: error.message }
      if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
    }
    if (error instanceof StellaPayloadTooLargeError) {
      return { ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.' }
    }
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
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

  // Step allowlist — reject out-of-vocabulary steps before any resource is
  // consumed. An unknown step can never reach the system prompt tier.
  if (!resolveAdvisorStep(step)) {
    return { ok: false, error: 'UNSUPPORTED_STEP', message: 'Unsupported advisor step.' }
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

  // Role gate — set inclusion (reviewer allowed, viewer denied); viewers never trigger AI calls.
  if (!canUseStella(ctx.membership.role)) {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
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

    if (error instanceof StellaPayloadTooLargeError) {
      return { ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.' }
    }

    return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
  }
}
