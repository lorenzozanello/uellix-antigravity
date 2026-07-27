'use server'
// app/actions/stella/composer.ts
// Stella Composer server action — drafts one report section at a time.
// Security: feature-flagged, auth-gated, quota-enforced, rate-limited,
// metadata-only context, no automatic saves (draft returned to UI only).

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { getStellaConsentStatus } from '@/lib/stella/consent/consent-status'
import { buildComposerContext, StellaBuildComposerContextError } from '@/lib/stella/context/build-composer-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { assertContextHasNoForbiddenData } from '@/lib/stella/context/context-guardrails'
import { buildComposerSystemPrompt, buildComposerUserMessage } from '@/lib/stella/prompts/composer-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ComposerOutputSchema } from '@/lib/stella/schemas/composer-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError, StellaContextGuardrailError } from '@/lib/stella/errors'
import { SENSITIVE_DATA_BLOCK_MESSAGES } from '@/lib/stella/context/sensitive-population'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { recordStellaInteraction } from '@/lib/stella/audit-log'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

export type StellaComposerErrorCode =
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

export type StellaComposerResult =
  | { ok: true; data: ComposerOutput }
  | { ok: false; error: StellaComposerErrorCode; message: string }

export async function getStellaComposer(
  projectId: string,
  reportId: string,
  // sectionId identifies which report section the UI is drafting (matches the
  // call signature the Composer panel will use in a later task). It is not
  // referenced below — buildComposerContext already verifies report-level
  // ownership, and all sections of a given report belong to the same
  // verified project/org, so no separate per-section check is needed here.
  // Mirrors how build-advisor-context.ts's now-unused `step` param is kept
  // and documented rather than renamed/removed.
  sectionId: string,
  sectionType: string
): Promise<StellaComposerResult> {
  // Feature flag gate — all flags default to false
  if (!stellaConfig.isEnabled || !stellaConfig.isComposerEnabled || !stellaState.canUseStella) {
    return { ok: false, error: 'DISABLED', message: 'Stella Composer is not enabled.' }
  }

  // Auth + org context
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  // Etapa A2.1 (STL-A21-008, DR-005) — see advisor.ts for the rationale.
  const consentStatus = await getStellaConsentStatus(ctx.organization.id)
  if (consentStatus.status !== 'valid') {
    const consentErrorByStatus: Record<'missing' | 'revoked' | 'outdated', StellaComposerErrorCode> = {
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

  try {
    // Build context — validates project + report ownership before consuming rate limit
    const context = await buildComposerContext(projectId, ctx.organization.id, reportId)

    // Etapa A1 (STL-A1-008) — see advisor.ts for the rationale.
    await assertContextHasNoForbiddenData(context)

    // Consume after context validation and immediately before the model attempt.
    const rateLimit = await consumeStellaRateLimit(ctx.organization.id)
    if (!rateLimit.allowed) {
      return rateLimit.reason === 'unavailable'
        ? { ok: false, error: 'RATE_LIMIT_UNAVAILABLE', message: 'Stella rate limit service is temporarily unavailable.' }
        : { ok: false, error: 'RATE_LIMITED', message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.` }
    }

    // Build prompts
    const systemPrompt = buildComposerSystemPrompt(sectionType)
    const userMessage = buildComposerUserMessage(sectionType, context)
    const contextHash = buildContextHash(context)

    // Generate via Gemini adapter (real or mock in tests)
    const adapter = getGeminiAdapter()
    const response = await adapter.generate({
      role: 'composer',
      systemPrompt,
      userMessage,
      contextHash,
    })

    // Parse and validate output — throws StellaParseError on invalid JSON or schema mismatch
    const data = await adapter.parseResponse(response.rawOutput, ComposerOutputSchema)

    // Audit insert — required for compliance; surface failure rather than
    // swallow. Central recorder (Etapa A1, STL-A1-006).
    try {
      await recordStellaInteraction({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        role: 'composer',
        pipelineStep: sectionType,
        context,
        contextHash,
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
      })
    } catch {
      return { ok: false, error: 'AUDIT_ERROR', message: 'Failed to record Stella interaction. Please try again.' }
    }

    return { ok: true, data }
  } catch (error) {
    if (error instanceof StellaBuildComposerContextError) {
      return { ok: false, error: 'UNAUTHORIZED', message: 'Report or project access denied.' }
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
