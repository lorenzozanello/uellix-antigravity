'use server'
// app/actions/stella/reviewer.ts
// Fase 5b — parameterized server action for the reviewer roles (proxy_reviewer,
// evidence_reviewer, audit_assistant). Read-only, feature-flagged per role,
// auth-gated, rate-limited, quota-checked, metadata-only context, audit-logged.
// The AI never writes to the pipeline and requires_human_review is always true.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
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
import { StellaPayloadTooLargeError } from '@/lib/stella/security/payload-limits'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import { logAuditAction, AUDIT_ACTIONS, type AuditLogEntry } from '@/lib/audit/logger'
import { reportStellaFailure } from '@/lib/stella/observability'

export type StellaReviewerErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'PAYLOAD_TOO_LARGE'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

export type StellaReviewerResult =
  | { ok: true; data: ReviewerOutput }
  | { ok: false; error: StellaReviewerErrorCode; message: string }

// Fire-and-forget audit trail write (WS3b): an audit_logs failure must NEVER
// change the user-facing result of a Stella call. Payloads are metadata-only
// (ids/codes/counts) — never prompt, context or model response content.
async function logStellaAudit(entry: AuditLogEntry): Promise<void> {
  try {
    await logAuditAction(entry)
  } catch (error) {
    console.error('[stella-audit] audit write failed:', error instanceof Error ? error.name : 'unknown')
  }
}

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

  // Role gate — set inclusion (reviewer allowed, viewer denied); viewers never trigger AI calls.
  if (!canUseStella(ctx.membership.role)) {
    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: projectId,
      action: AUDIT_ACTIONS.STELLA_DENIED,
      afterJson: { stellaRole: role, reason: 'ROLE_DENIED', membershipRole: ctx.membership.role },
    })
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  const quotaCheck = await checkStellaQuota(ctx.organization.id)
  if (!quotaCheck.allowed) {
    const message =
      quotaCheck.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: projectId,
      action: AUDIT_ACTIONS.STELLA_DENIED,
      afterJson: { stellaRole: role, reason: 'QUOTA_EXCEEDED', quotaReason: quotaCheck.reason ?? null },
    })
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }

  try {
    const context = await buildReviewerContext(projectId, ctx.organization.id)

    // Consume after context validation and immediately before the model attempt.
    const rateLimit = await consumeStellaRateLimit(ctx.organization.id)
    if (!rateLimit.allowed) {
      await logStellaAudit({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_DENIED,
        afterJson: {
          stellaRole: role,
          reason: rateLimit.reason === 'unavailable' ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED',
        },
      })
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
    } catch (insertError) {
      reportStellaFailure(role, 'AUDIT_ERROR', insertError, { projectId })
      return {
        ok: false,
        error: 'AUDIT_ERROR',
        message: 'Failed to record Stella interaction. Please try again.',
      }
    }

    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: projectId,
      action: AUDIT_ACTIONS.STELLA_INVOKED,
      afterJson: {
        stellaRole: role,
        pipelineStep: REVIEWER_ROLE_CONFIG[role].pipelineStep,
        tokensUsed: response.tokensUsed ?? null,
      },
    })

    return { ok: true, data }
  } catch (error) {
    if (error instanceof StellaBuildReviewerContextError) {
      return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
    }
    if (error instanceof StellaTimeoutError) {
      reportStellaFailure(role, 'TIMEOUT', error, { projectId })
      return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
    }
    if (error instanceof StellaParseError) {
      reportStellaFailure(role, 'PARSE_ERROR', error, { projectId })
      return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
    }
    if (error instanceof StellaGeminiError) {
      reportStellaFailure(role, 'GEMINI_ERROR', error, { projectId })
      return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
    }
    if (error instanceof StellaPayloadTooLargeError) {
      return { ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.' }
    }
    reportStellaFailure(role, 'UNKNOWN_ERROR', error, { projectId })
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
  }
}
