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
import { nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { logAuditAction, AUDIT_ACTIONS, type AuditLogEntry } from '@/lib/audit/logger'
import { reportStellaFailure } from '@/lib/stella/observability'
import {
  governedRejectionPresentation,
  runGovernedStellaOperation,
} from '@/lib/stella/operation-ticket/governed-operation'
import { issueGovernedStellaTicket } from '@/lib/stella/operation-ticket/issue-governed-ticket'
import type { StellaTicketIssueResult } from '@/components/stella/operation-ticket'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import { runContextualAdvisor } from '@/lib/stella/advisor/run-contextual-advisor'
// App-layer only: lib/stella must never import the calculation engine
// (anti-regression enforced); the action injects the readiness verdict.
import { getSroiCalculationReadiness } from '@/lib/pipeline/sroi-calculation'

/**
 * TRAIN 4.3 — the category, as a module constant.
 *
 * BOTH advisor entry points charge under it. That is not a simplification: the
 * contextual advisor and the step advisor are two prompt strategies for one
 * capability, they draw on the same organization pool, and `stella_interactions`
 * has always recorded both as `stella_role = 'advisor'`. Giving them separate
 * categories would create a second pool for one product surface.
 *
 * They are still SEPARATE OPERATIONS: each mints its own ticket, so a
 * contextual run and a step run are two units, and a ticket minted for one
 * cannot settle the other — `requestParts` differ, so the bind digest differs
 * and `U0107` refuses the substitution.
 */
const ADVISOR_CATEGORY = 'advisor' as const

/**
 * The quota provenance recorded on every charged advisor run. Square brackets,
 * not parentheses — see the identical constant in validator.ts.
 */
const GOVERNED_QUOTA_LEDGER =
  'charged via uellix_stella_ops.complete_operation_ticket -> uellix_stella.settle_reserved_quota [R6-INT closed, prepared stella_0017; reservation-aware, prepared stella_0016 / R1]'

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
  /** TRAIN 4.3 — retained, no longer reachable. See validator.ts for why. */
  | 'AUDIT_ERROR'
  /** TRAIN 4.3 — already charged, answer not recoverable. NOT retryable. */
  | 'ALREADY_COMPLETED_RESULT_UNAVAILABLE'
  | 'UNKNOWN_ERROR'

export type StellaAdvisorResult =
  | { ok: true; data: AdvisorOutput }
  | { ok: false; error: StellaAdvisorErrorCode; message: string }

export type StellaContextualAdvisorResult =
  | { ok: true; data: AdvisorContextualOutput }
  | { ok: false; error: StellaAdvisorErrorCode; message: string }

// Fire-and-forget audit trail write (WS3b): an audit_logs failure must NEVER
// change the user-facing result of a Stella call. Payloads are metadata-only
// (ids/codes/counts) — never prompt, context or model response content.
async function logStellaAudit(entry: AuditLogEntry): Promise<void> {
  try {
    // Its own short transaction. Denial paths reach this with no context open,
    // and the success path reaches it after the model call has already
    // returned — either way the audit write must never share a transaction
    // with the seconds-long provider round trip.
    await withOrganizationDatabaseContext(() => logAuditAction(entry))
  } catch (error) {
    console.error('[stella-audit] audit write failed:', error instanceof Error ? error.name : 'unknown')
  }
}

/**
 * Authorized contextual advisor path. Applies the exact same feature-flag,
 * auth, quota, project-ownership, rate-limit and audit guards as
 * getStellaAdvisor below, then hands off to the pure runContextualAdvisor
 * pipeline. organizationId always comes from the authenticated session
 * (requireOrganizationAccess), never from the caller — a caller can only
 * name a projectId, and buildAdvisorContext rejects it if it does not
 * belong to that session's organization.
 */
export async function issueStellaAdvisorTicket(
  projectId: string
): Promise<StellaTicketIssueResult> {
  // FLAG FIRST — zero auth, zero DB, zero ticket, zero observability when off.
  if (!stellaConfig.isEnabled || !stellaConfig.isAdvisorEnabled || !stellaState.canUseStella) {
    return { status: 'disabled' }
  }
  return issueGovernedStellaTicket(projectId, ADVISOR_CATEGORY)
}

export async function getStellaContextualAdvisor(
  projectId: string,
  step: AdvisorPipelineStep,
  ticket: string,
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
    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: projectId,
      action: AUDIT_ACTIONS.STELLA_DENIED,
      afterJson: { stellaRole: 'advisor', reason: 'ROLE_DENIED', membershipRole: ctx.membership.role },
    })
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  // NO `checkStellaQuota` — see validator.ts for the full statement of why an
  // unlocked, reservation-blind count next to a direct INSERT was R1 and
  // R6-INT in one shape. `bind` performs the canonical check under the same
  // advisory lock the charge takes.

  let contextHash: string | null = null
  let sensitive: { detected: boolean; categories: string[] } = { detected: false, categories: [] }
  let stepMismatch = false

  const outcome = await runGovernedStellaOperation<AdvisorContextualOutput, StellaContextualAdvisorResult>({
    category: ADVISOR_CATEGORY,
    organizationId: ctx.organization.id,
    projectId,
    ticket,
    // `'contextual'` DISCRIMINATES the two advisor strategies. Without it a
    // ticket minted for the step advisor at the same step would produce the
    // same digest and could settle a contextual run — one operation delivering
    // the other's answer. The literal is this module's, never the caller's.
    requestParts: ['contextual', step],
    execute: async () => {
      try {
        // Live calculation readiness from the deterministic engine (app layer —
        // lib/stella never imports it). Best-effort: on any failure we fall back
        // to the derived-from-persisted summary inside buildAdvisorContext.
        let liveReadiness: { ready: boolean; blockingReasons: string[]; warnings: string[] } | undefined
        try {
          const r = await withOrganizationDatabaseContext(() =>
            getSroiCalculationReadiness(projectId)
          )
          liveReadiness = {
            ready: r.canCalculate,
            blockingReasons: r.blockingReasons,
            warnings: r.issues.filter((i) => i.type === 'warning').map((i) => i.message),
          }
        } catch {
          liveReadiness = undefined
        }

        // Project ownership check happens inside buildAdvisorContext — throws
        // UNAUTHORIZED if projectId does not belong to ctx.organization.id.
        const context = liveReadiness
          ? await withOrganizationDatabaseContext(() =>
              buildAdvisorContext(projectId, ctx.organization.id, step, {
                calculationReadiness: liveReadiness,
              })
            )
          : await withOrganizationDatabaseContext(() =>
              buildAdvisorContext(projectId, ctx.organization.id, step)
            )
        contextHash = buildContextHash(context)
        sensitive = {
          detected: context.sensitivePopulations?.detected ?? false,
          categories: context.sensitivePopulations?.categories ?? [],
        }

        const result = await runContextualAdvisor(step, context, getGeminiAdapter())

        // RK-19: provider step drift is canonicalized inside the pipeline, but
        // it must be observable — warn (metadata only: the trusted step name)
        // and tag the audit entry below.
        if (result.ok && result.stepMismatch) {
          console.warn('[stella] provider step mismatch', { step })
          stepMismatch = true
        }

        if (!result.ok) {
          // Model-path failure surfaced as a typed result — report to Sentry
          // with codes/ids only (the typed messages are static, never prompt
          // echoes).
          if (result.error === 'GEMINI_ERROR' || result.error === 'TIMEOUT' || result.error === 'PARSE_ERROR') {
            reportStellaFailure('advisor', result.error, new Error(`contextual advisor ${result.error}`), {
              projectId,
              step,
              contextual: true,
            })
          }
          // `no_result`, not `execution_failed`: the pipeline RAN and returned a
          // typed refusal. Both release the unit and charge nothing; the
          // distinction is for an operator reading `operation_tickets`.
          return { ok: false, failure: result, abortReason: 'no_result' }
        }

        return {
          ok: true,
          data: result.data,
          pipelineStep: step,
          modelUsed: result.modelUsed ?? null,
          tokensUsed: result.tokensUsed ?? null,
        }
      } catch (error) {
        return {
          ok: false,
          failure: contextualAdvisorExecutionFailure(error, projectId, step),
          abortReason: 'execution_failed',
        }
      }
    },
  })

  switch (outcome.kind) {
    case 'completed':
      await logStellaAudit({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_INVOKED,
        afterJson: {
          stellaRole: ADVISOR_CATEGORY,
          pipelineStep: step,
          contextHash,
          sensitivePopulations: sensitive.detected,
          sensitivePopulationCategories: sensitive.categories,
          // RK-19: only present when the provider answered a different step.
          ...(stepMismatch ? { stepMismatch: true } : {}),
          quotaLedger: GOVERNED_QUOTA_LEDGER,
        },
      })
      return { ok: true, data: outcome.data }

    case 'quota_exceeded': {
      const message =
        outcome.reason === 'no_quota'
          ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
          : `Alcanzaste el límite mensual de ${outcome.quota ?? 0} consultas a Stella (usadas: ${outcome.used ?? 0}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
      await logStellaAudit({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_DENIED,
        afterJson: { stellaRole: ADVISOR_CATEGORY, reason: 'QUOTA_EXCEEDED', quotaReason: outcome.reason },
      })
      return { ok: false, error: 'QUOTA_EXCEEDED', message }
    }

    case 'quota_refused_after_execution':
      return {
        ok: false,
        error: 'QUOTA_EXCEEDED',
        message: `Alcanzaste el límite mensual de ${outcome.quota ?? 0} consultas a Stella (usadas: ${outcome.used ?? 0}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`,
      }

    case 'already_completed':
      return {
        ok: false,
        error: 'ALREADY_COMPLETED_RESULT_UNAVAILABLE',
        message:
          'Esta operación ya se ejecutó y se contabilizó en tu cuota, pero la respuesta no pudo entregarse y no se conserva.',
      }

    case 'rejected': {
      const presentation = governedRejectionPresentation(outcome.reason)
      return { ok: false, error: presentation.code, message: presentation.message }
    }

    case 'settlement_failed':
      return { ok: false, error: 'UNKNOWN_ERROR', message: 'Stella no pudo completar la operación.' }

    case 'execution_failed':
      return outcome.failure
  }
}

/** The contextual path's own error taxonomy, unchanged — only its call site moved. */
function contextualAdvisorExecutionFailure(
  error: unknown,
  projectId: string,
  step: AdvisorPipelineStep,
): StellaContextualAdvisorResult {
  if (error instanceof StellaBuildContextError) {
    if (error.code === 'UNSUPPORTED_STEP') return { ok: false, error: 'UNSUPPORTED_STEP', message: error.message }
    if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
  }
  if (error instanceof StellaPayloadTooLargeError) {
    return { ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.' }
  }
  reportStellaFailure('advisor', 'UNKNOWN_ERROR', error, { projectId, step, contextual: true })
  return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
}

export async function getStellaAdvisor(
  projectId: string,
  step: string,
  ticket: string
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
    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: projectId,
      action: AUDIT_ACTIONS.STELLA_DENIED,
      afterJson: { stellaRole: 'advisor', reason: 'ROLE_DENIED', membershipRole: ctx.membership.role },
    })
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  // NO `checkStellaQuota` — see validator.ts. `bind` is the only quota check.

  let contextHash: string | null = null
  let sensitive: { detected: boolean; categories: string[] } = { detected: false, categories: [] }

  const outcome = await runGovernedStellaOperation<AdvisorOutput, StellaAdvisorResult>({
    category: ADVISOR_CATEGORY,
    organizationId: ctx.organization.id,
    projectId,
    ticket,
    // `'step'` mirrors `'contextual'` above: two strategies of one capability
    // must produce different digests for the same pipeline step.
    requestParts: ['step', step],
    execute: async () => {
      try {
        // Build project context (validates project ownership, metadata only)
        const context = await withOrganizationDatabaseContext(() =>
          buildAdvisorContext(projectId, ctx.organization.id, step)
        )
        contextHash = buildContextHash(context)
        sensitive = {
          detected: context.sensitivePopulations?.detected ?? false,
          categories: context.sensitivePopulations?.categories ?? [],
        }

        const systemPrompt = buildAdvisorSystemPrompt(step)
        const userMessage = buildAdvisorUserMessage(step, context)

        const adapter = getGeminiAdapter()
        const response = await adapter.generate({
          role: 'advisor',
          systemPrompt,
          userMessage,
          contextHash,
        })

        const data = await adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)

        return {
          ok: true,
          data,
          pipelineStep: step,
          modelUsed: response.modelUsed,
          tokensUsed: response.tokensUsed ?? null,
        }
      } catch (error) {
        return {
          ok: false,
          failure: advisorExecutionFailure(error, projectId),
          abortReason: 'execution_failed',
        }
      }
    },
  })

  switch (outcome.kind) {
    case 'completed':
      await logStellaAudit({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_INVOKED,
        afterJson: {
          stellaRole: ADVISOR_CATEGORY,
          pipelineStep: step,
          contextHash,
          sensitivePopulations: sensitive.detected,
          sensitivePopulationCategories: sensitive.categories,
          quotaLedger: GOVERNED_QUOTA_LEDGER,
        },
      })
      return { ok: true, data: outcome.data }

    case 'quota_exceeded': {
      const message =
        outcome.reason === 'no_quota'
          ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
          : `Alcanzaste el límite mensual de ${outcome.quota ?? 0} consultas a Stella (usadas: ${outcome.used ?? 0}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
      await logStellaAudit({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_DENIED,
        afterJson: { stellaRole: ADVISOR_CATEGORY, reason: 'QUOTA_EXCEEDED', quotaReason: outcome.reason },
      })
      return { ok: false, error: 'QUOTA_EXCEEDED', message }
    }

    case 'quota_refused_after_execution':
      return {
        ok: false,
        error: 'QUOTA_EXCEEDED',
        message: `Alcanzaste el límite mensual de ${outcome.quota ?? 0} consultas a Stella (usadas: ${outcome.used ?? 0}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`,
      }

    case 'already_completed':
      return {
        ok: false,
        error: 'ALREADY_COMPLETED_RESULT_UNAVAILABLE',
        message:
          'Esta operación ya se ejecutó y se contabilizó en tu cuota, pero la respuesta no pudo entregarse y no se conserva.',
      }

    case 'rejected': {
      const presentation = governedRejectionPresentation(outcome.reason)
      return { ok: false, error: presentation.code, message: presentation.message }
    }

    case 'settlement_failed':
      return { ok: false, error: 'UNKNOWN_ERROR', message: 'Stella no pudo completar la operación.' }

    case 'execution_failed':
      return outcome.failure
  }
}

/** The step advisor's own error taxonomy, unchanged — only its call site moved. */
function advisorExecutionFailure(error: unknown, projectId: string): StellaAdvisorResult {
  if (error instanceof StellaBuildContextError) {
    if (error.code === 'UNSUPPORTED_STEP') {
      return { ok: false, error: 'UNSUPPORTED_STEP', message: error.message }
    }
    if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') {
      return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
    }
  }

  if (error instanceof StellaTimeoutError) {
    reportStellaFailure('advisor', 'TIMEOUT', error, { projectId })
    return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
  }

  if (error instanceof StellaParseError) {
    reportStellaFailure('advisor', 'PARSE_ERROR', error, { projectId })
    return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
  }

  if (error instanceof StellaGeminiError) {
    reportStellaFailure('advisor', 'GEMINI_ERROR', error, { projectId })
    return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
  }

  if (error instanceof StellaPayloadTooLargeError) {
    return { ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.' }
  }

  reportStellaFailure('advisor', 'UNKNOWN_ERROR', error, { projectId })
  return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
}
