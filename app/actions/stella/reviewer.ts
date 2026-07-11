'use server'
// app/actions/stella/reviewer.ts
// Fase 5b — parameterized server action for the reviewer roles (proxy_reviewer,
// evidence_reviewer, audit_assistant). Read-only, feature-flagged per role,
// auth-gated, rate-limited, quota-checked, metadata-only context, audit-logged.
// The AI never writes to the pipeline and requires_human_review is always true.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildReviewerContext, StellaBuildReviewerContextError } from '@/lib/stella/context/build-reviewer-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import {
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
  REVIEWER_ROLE_CONFIG,
  type ReviewerRole,
} from '@/lib/stella/prompts/reviewer-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ReviewerOutputSchema, type ReviewerOutput } from '@/lib/stella/schemas/reviewer-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { checkStellaRateLimit, recordStellaRequest } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'

export type StellaReviewerErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

export type StellaReviewerResult =
  | { ok: true; data: ReviewerOutput }
  | { ok: false; error: StellaReviewerErrorCode; message: string }

function roleEnabled(role: ReviewerRole): boolean {
  switch (role) {
    case 'proxy_reviewer':
      return stellaConfig.isProxyReviewerEnabled
    case 'evidence_reviewer':
      return stellaConfig.isEvidenceReviewerEnabled
    case 'audit_assistant':
      return stellaConfig.isAuditAssistantEnabled
  }
}

export async function getStellaReviewer(
  projectId: string,
  role: ReviewerRole
): Promise<StellaReviewerResult> {
  // Feature flag gate — global + per-role, all default false.
  if (!stellaConfig.isEnabled || !roleEnabled(role) || !stellaState.canUseStella) {
    return { ok: false, error: 'DISABLED', message: 'Stella review role is not enabled.' }
  }

  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const rateLimit = checkStellaRateLimit(ctx.organization.id)
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: 'RATE_LIMITED',
      message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.`,
    }
  }

  const quotaCheck = await checkStellaQuota(ctx.organization.id)
  if (!quotaCheck.allowed) {
    const message =
      quotaCheck.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }

  try {
    const context = await buildReviewerContext(projectId, ctx.organization.id)

    // Record after context built — prevents gaming via repeated context errors.
    recordStellaRequest(ctx.organization.id)

    const systemPrompt = buildReviewerSystemPrompt(role)
    const userMessage = buildReviewerUserMessage(role, context)
    const contextHash = buildContextHash(context)

    const adapter = getGeminiAdapter()
    const response = await adapter.generate({ role, systemPrompt, userMessage, contextHash })

    const data = await adapter.parseResponse(response.rawOutput, ReviewerOutputSchema)

    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: role,
        pipelineStep: REVIEWER_ROLE_CONFIG[role].pipelineStep,
        contextHash,
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
        riskLevel: data.risk_level,
        riskFlags: data.findings.length > 0 ? ['finding'] : [],
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
    if (error instanceof StellaBuildReviewerContextError) {
      return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
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
