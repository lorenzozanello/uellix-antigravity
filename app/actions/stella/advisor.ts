'use server'
// app/actions/stella/advisor.ts
// Sprint 9C-1: Stella Advisor server action
// Security: feature-flagged, auth-gated, metadata-only context, audit-logged, no secret logging

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { getStellaConsentStatus } from '@/lib/stella/consent/consent-status'
import { buildAdvisorContext, StellaBuildContextError } from '@/lib/stella/context/build-advisor-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { assertContextHasNoForbiddenData } from '@/lib/stella/context/context-guardrails'
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from '@/lib/stella/prompts/advisor-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { AdvisorOutputSchema } from '@/lib/stella/schemas/advisor-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError, StellaContextGuardrailError } from '@/lib/stella/errors'
import { SENSITIVE_DATA_BLOCK_MESSAGES } from '@/lib/stella/context/sensitive-population'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { recordStellaInteraction } from '@/lib/stella/audit-log'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { getStellaPilotAccess, type StellaPilotAccessDecision } from '@/lib/stella/pilot/access'
import { StellaPilotMockProvider } from '@/lib/stella/pilot/mock-provider'
import { getStellaPilotConfig } from '@/lib/stella/pilot/config'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'

export type StellaAdvisorErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'PILOT_DISABLED'
  | 'PILOT_KILL_SWITCH_ACTIVE'
  | 'PILOT_ORGANIZATION_NOT_ALLOWED'
  | 'PILOT_USER_NOT_ALLOWED'
  | 'PILOT_MEMBERSHIP_INACTIVE'
  | 'PILOT_ROLE_NOT_ALLOWED'
  | 'PILOT_CONFIRMATION_REQUIRED'
  | 'PILOT_CONFIRMATION_OUTDATED'
  | 'PILOT_CONSENT_REQUIRED'
  | 'PILOT_PAID_PROVIDER_NOT_CONFIRMED'
  | 'PILOT_PROVIDER_NOT_READY'
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

/** Every non-ALLOWED pilot decision maps 1:1 to its own StellaAdvisorErrorCode — the message always comes from getStellaPilotAccess() itself (never re-authored here), so there is exactly one place that can leak (or not leak) pilot state. */
const PILOT_DECISION_ERROR_CODE: Record<Exclude<StellaPilotAccessDecision, 'PILOT_ALLOWED'>, StellaAdvisorErrorCode> = {
  PILOT_DISABLED: 'PILOT_DISABLED',
  PILOT_KILL_SWITCH_ACTIVE: 'PILOT_KILL_SWITCH_ACTIVE',
  PILOT_ORGANIZATION_NOT_ALLOWED: 'PILOT_ORGANIZATION_NOT_ALLOWED',
  PILOT_USER_NOT_ALLOWED: 'PILOT_USER_NOT_ALLOWED',
  PILOT_MEMBERSHIP_INACTIVE: 'PILOT_MEMBERSHIP_INACTIVE',
  PILOT_ROLE_NOT_ALLOWED: 'PILOT_ROLE_NOT_ALLOWED',
  PILOT_CONFIRMATION_REQUIRED: 'PILOT_CONFIRMATION_REQUIRED',
  PILOT_CONFIRMATION_OUTDATED: 'PILOT_CONFIRMATION_OUTDATED',
  PILOT_CONSENT_REQUIRED: 'PILOT_CONSENT_REQUIRED',
  PILOT_PAID_PROVIDER_NOT_CONFIRMED: 'PILOT_PAID_PROVIDER_NOT_CONFIRMED',
  PILOT_PROVIDER_NOT_READY: 'PILOT_PROVIDER_NOT_READY',
}

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

  // Etapa B0 (modo piloto restringido, decisión del propietario 2026-07-26):
  // mandatory pilot gate — runs BEFORE consent/quota/rate-limit/model and
  // BEFORE this function's own (unchanged, still-tested) DR-005 check below.
  // getStellaPilotAccess() already re-checks DR-005 consent internally
  // (harmless overlap with the check further down — same underlying data,
  // one extra read, zero behavior change for the pre-existing tested path).
  // A pilot rejection returns here, before ANY quota/rate-limit consumption
  // and before the provider (real or mock) is ever selected.
  const pilotAccess = await getStellaPilotAccess({
    organizationId: ctx.organization.id,
    userId: ctx.user.id,
    membershipRole: ctx.membership.role,
    membershipStatus: ctx.membership.status,
    stellaRole: 'advisor',
  })
  if (pilotAccess.decision !== 'PILOT_ALLOWED') {
    return { ok: false, error: PILOT_DECISION_ERROR_CODE[pilotAccess.decision], message: pilotAccess.message }
  }

  // Etapa A2.1 (STL-A21-008, DR-005): organizational consent gate. Runs
  // BEFORE quota/rate-limit/model — independent of feature flags, quota,
  // plan, and rate limiting, per the approved decision. Fail-closed:
  // getStellaConsentStatus() itself never throws (see consent-status.ts).
  const consentStatus = await getStellaConsentStatus(ctx.organization.id)
  if (consentStatus.status !== 'valid') {
    const consentErrorByStatus: Record<'missing' | 'revoked' | 'outdated', StellaAdvisorErrorCode> = {
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

  // Build project context (validates project ownership, metadata only)
  try {
    const context = await buildAdvisorContext(projectId, ctx.organization.id, step)

    // Etapa A1 (STL-A1-008) — deterministic safety check on the context
    // object itself, before it can reach a prompt. Does not depend on the
    // model's behavior; see lib/stella/context/context-guardrails.ts.
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

    // Build prompts from existing builders
    const systemPrompt = buildAdvisorSystemPrompt(step)
    const userMessage = buildAdvisorUserMessage(step, context)
    const contextHash = buildContextHash(context)

    // Etapa B0: `pilotAccess` already confirmed providerMode is either
    // 'mock' or 'paid_gemini' (never 'disabled' — see getStellaPilotAccess
    // step 12). 'mock' selects the pilot's OWN synthetic provider (never
    // real Gemini, regardless of GEMINI_API_KEY); 'paid_gemini' uses the
    // real adapter, which by this point is only reachable because
    // STELLA_PILOT_PAID_GEMINI_CONFIRMED was explicitly true.
    const pilotProviderMode = getStellaPilotConfig().providerMode
    const adapter = pilotProviderMode === 'mock' ? getGeminiAdapter({ mockProvider: new StellaPilotMockProvider() }) : getGeminiAdapter()
    const response = await adapter.generate({
      role: 'advisor',
      systemPrompt,
      userMessage,
      contextHash,
    })

    // Parse and validate output — throws StellaParseError on invalid JSON or schema mismatch
    const data = await adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)

    // Audit insert — required for compliance and for quota measurement;
    // surface failure rather than swallow (mirrors validator.ts). Goes
    // through the central recorder (Etapa A1, STL-A1-006) so prompt version,
    // context schema version and the context manifest are always attached.
    try {
      await recordStellaInteraction({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        role: 'advisor',
        pipelineStep: step,
        context,
        contextHash,
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
      })
    } catch (auditError) {
      // The client only ever sees the generic AUDIT_ERROR/message below — but
      // this must never be the ONLY trace of the failure. Structural DB
      // errors (column length, type, constraint violations) never embed the
      // offending value in `code`/`message` (verified for the varchar-length
      // case this code exists to guard against — see
      // STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md#0.5); logging
      // them is safe. This intentionally does NOT log `context`, `data`, or
      // any other field that could carry project content.
      const code = (auditError as { code?: unknown } | null)?.code
      console.error('[stella] recordStellaInteraction failed:', {
        code: typeof code === 'string' ? code : undefined,
        message: auditError instanceof Error ? auditError.message : String(auditError),
      })
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

    if (error instanceof StellaContextGuardrailError) {
      // Etapa A2.3 (STL-A23-007, DR-002/DR-003): sensitive-population blocks
      // carry a distinct, fixed reason code — map it to its own error code
      // and a non-leaky message instead of the generic guardrail message,
      // and record a content-free audit entry (reason code only, never text).
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

      // Message intentionally generic — never surface which invariant
      // tripped or any context content to the client.
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
