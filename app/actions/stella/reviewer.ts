'use server'
// app/actions/stella/reviewer.ts
// Fase 5b — parameterized server action for the reviewer roles (proxy_reviewer,
// evidence_reviewer, audit_assistant). Read-only, feature-flagged per role,
// auth-gated, rate-limited, quota-checked, metadata-only context, audit-logged.
// The AI never writes to the pipeline and requires_human_review is always true.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { getStellaConsentStatus } from '@/lib/stella/consent/consent-status'
import { buildReviewerContext, StellaBuildReviewerContextError } from '@/lib/stella/context/build-reviewer-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { assertContextHasNoForbiddenData } from '@/lib/stella/context/context-guardrails'
import {
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
  REVIEWER_ROLE_CONFIG,
  type ReviewerRole,
} from '@/lib/stella/prompts/reviewer-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ReviewerOutputSchema, type ReviewerOutput } from '@/lib/stella/schemas/reviewer-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError, StellaContextGuardrailError } from '@/lib/stella/errors'
import { SENSITIVE_DATA_BLOCK_MESSAGES } from '@/lib/stella/context/sensitive-population'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { recordStellaInteraction } from '@/lib/stella/audit-log'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type StellaReviewerErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_REVOKED'
  | 'CONSENT_OUTDATED'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'CONTEXT_GUARDRAIL_FAILED'
  | 'SENSITIVE_INDIVIDUAL_DATA_BLOCKED'
  | 'SENSITIVE_GROUP_SIZE_REQUIRED'
  | 'SENSITIVE_GROUP_TOO_SMALL'
  | 'SENSITIVE_REIDENTIFICATION_RISK'
  | 'SENSITIVE_FREE_TEXT_BLOCKED'
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

  // Etapa A2.1 (STL-A21-008, DR-005) — see advisor.ts for the rationale.
  const consentStatus = await getStellaConsentStatus(ctx.organization.id)
  if (consentStatus.status !== 'valid') {
    const consentErrorByStatus: Record<'missing' | 'revoked' | 'outdated', StellaReviewerErrorCode> = {
      missing: 'CONSENT_REQUIRED',
      revoked: 'CONSENT_REVOKED',
      outdated: 'CONSENT_OUTDATED',
    }
    return {
      ok: false,
      error: consentErrorByStatus[consentStatus.status],
      message: "An organization admin must review and accept Stella's current AI terms and data policy before it can be used.",
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

    // Etapa A1 (STL-A1-008) — see advisor.ts for the rationale.
    await assertContextHasNoForbiddenData(context)

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

    const systemPrompt = buildReviewerSystemPrompt(role)
    const userMessage = buildReviewerUserMessage(role, context)
    const contextHash = buildContextHash(context)

    const adapter = getGeminiAdapter()
    const response = await adapter.generate({ role, systemPrompt, userMessage, contextHash })

    const data = await adapter.parseResponse(response.rawOutput, ReviewerOutputSchema)

    // Central recorder (Etapa A1, STL-A1-006).
    try {
      await recordStellaInteraction({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        role,
        pipelineStep: REVIEWER_ROLE_CONFIG[role].pipelineStep,
        context,
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
    if (error instanceof StellaContextGuardrailError) {
      // Etapa A2.3 (STL-A23-007, DR-002/DR-003) — see advisor.ts for the rationale.
      if (error.code && error.code in SENSITIVE_DATA_BLOCK_MESSAGES) {
        const reasonCode = error.code as keyof typeof SENSITIVE_DATA_BLOCK_MESSAGES
        try {
          await logAuditAction({
            organizationId: ctx.organization.id,
            projectId,
            actorUserId: ctx.user.id,
            entityType: 'stella_interaction',
            entityId: projectId,
            action: AUDIT_ACTIONS.STELLA_SENSITIVE_DATA_BLOCKED,
            reason: reasonCode,
          })
        } catch {
          // Audit logging must never mask the original block.
        }
        return { ok: false, error: reasonCode, message: SENSITIVE_DATA_BLOCK_MESSAGES[reasonCode] }
      }

      return { ok: false, error: 'CONTEXT_GUARDRAIL_FAILED', message: 'Stella context failed a safety check.' }
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
