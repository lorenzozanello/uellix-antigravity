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
import { nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { logAuditAction, AUDIT_ACTIONS, type AuditLogEntry } from '@/lib/audit/logger'
import { reportStellaFailure } from '@/lib/stella/observability'
import {
  governedRejectionPresentation,
  runGovernedStellaOperation,
} from '@/lib/stella/operation-ticket/governed-operation'
import { issueGovernedStellaTicket } from '@/lib/stella/operation-ticket/issue-governed-ticket'
import {
  STELLA_REVIEWER_CATEGORIES,
  resolveIssuableCategory,
  type StellaReviewerCategory,
} from '@/lib/stella/operation-ticket/categories'
import type { StellaTicketIssueResult } from '@/components/stella/operation-ticket'

/** Square brackets, not parentheses — see the identical constant in validator.ts. */
const GOVERNED_QUOTA_LEDGER =
  'charged via uellix_stella_ops.complete_operation_ticket -> uellix_stella.settle_reserved_quota [R6-INT closed, prepared stella_0017; reservation-aware, prepared stella_0016 / R1]'

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
  /** TRAIN 4.3 — retained, no longer reachable. See validator.ts for why. */
  | 'AUDIT_ERROR'
  /** TRAIN 4.3 — already charged, answer not recoverable. NOT retryable. */
  | 'ALREADY_COMPLETED_RESULT_UNAVAILABLE'
  | 'UNKNOWN_ERROR'

export type StellaReviewerResult =
  | { ok: true; data: ReviewerOutput }
  | { ok: false; error: StellaReviewerErrorCode; message: string }

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

/**
 * The reviewer categories this deployment may issue RIGHT NOW.
 *
 * FASE 7's "deriva la categoría de un permiso o modo autorizado". The set is
 * not the vocabulary — it is the vocabulary intersected with the per-role
 * feature flags, all of which default to false. So a correctly spelled category
 * whose role is dark is refused exactly as an invented one is, and the refusal
 * is indistinguishable from outside: both return `UNAUTHORIZED`, neither says
 * which of the two it was.
 *
 * That indistinguishability is the point. A caller that could tell "not a real
 * category" from "a real category you cannot use here" would have a probe for
 * this organization's feature-flag configuration.
 */
function enabledReviewerCategories(): readonly StellaReviewerCategory[] {
  return STELLA_REVIEWER_CATEGORIES.filter((category) => roleEnabled(category))
}

/**
 * Mint one operation ticket for one reviewer run.
 *
 * THE ONLY ISSUANCE SURFACE IN THE PRODUCT THAT TAKES A CATEGORY, and therefore
 * the only one where "the client cannot choose its category" is enforced by a
 * check rather than by the absence of a parameter. The check is
 * `resolveIssuableCategory` against `enabledReviewerCategories()`, and what it
 * returns — not what arrived — is what reaches SQL.
 *
 * A THIRD PARTY CANNOT WIDEN IT. `resolveIssuableCategory` is generic over the
 * ALLOWED array, so passing `STELLA_TICKET_CATEGORIES` here would be a type
 * error at the call to `issueGovernedStellaTicket`… no: it would typecheck.
 * What stops it is that the allowed set is computed HERE from three flags and
 * is not a parameter of this function, so no caller can supply a wider one.
 */
export async function issueStellaReviewerTicket(
  projectId: string,
  role: string
): Promise<StellaTicketIssueResult> {
  // FLAG FIRST — the global one. The per-role flag is enforced by the allowed
  // set below, which is empty when all three are off.
  if (!stellaConfig.isEnabled || !stellaState.canUseStella) {
    return { status: 'disabled' }
  }

  const category = resolveIssuableCategory(role, enabledReviewerCategories())
  if (category === null) {
    // Not a member of the vocabulary, or a member whose role is dark. Reported
    // as `disabled` rather than as an error when NO reviewer role is on at all,
    // so a fully dark deployment presents the same inert state every other
    // Stella surface does; otherwise `UNAUTHORIZED`, which is what a caller
    // naming a role it may not use should get.
    return enabledReviewerCategories().length === 0
      ? { status: 'disabled' }
      : { status: 'error', code: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  return issueGovernedStellaTicket(projectId, category)
}

export async function getStellaReviewer(
  projectId: string,
  role: ReviewerRole,
  ticket: string
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

  // NO `checkStellaQuota` — see validator.ts. `bind` is the only quota check.
  //
  // AND NO CATEGORY IS TAKEN FROM `role` HERE. `role` selects the prompt, the
  // context slice and the pipeline step; the CATEGORY the unit is charged
  // under comes from the TICKET, and the driver refuses to proceed unless the
  // ticket's own category equals the one this run is executing as. A ticket
  // minted for `proxy_reviewer` presented to an `evidence_reviewer` run is
  // `category_mismatch`, aborted, charged nothing.

  let contextHash: string | null = null
  let sensitive: { detected: boolean; categories: string[] } = { detected: false, categories: [] }
  const pipelineStep = REVIEWER_ROLE_CONFIG[role].pipelineStep

  const outcome = await runGovernedStellaOperation<ReviewerOutput, StellaReviewerResult>({
    // Narrowed by the compiler, not asserted: `ReviewerRole` and
    // `StellaReviewerCategory` are the same three literals, and
    // `tests/cross-workstream/governed-consumption.test.ts` pins that they stay
    // the same three.
    category: role,
    organizationId: ctx.organization.id,
    projectId,
    ticket,
    requestParts: [role],
    execute: async () => {
      try {
        // Per-role minimization (WS6): each reviewer role receives only its own
        // enrichment slice; omitting the role would return the superset.
        const context = await withOrganizationDatabaseContext(() =>
          buildReviewerContext(projectId, ctx.organization.id, role)
        )
        contextHash = buildContextHash(context)
        sensitive = {
          detected: context.sensitivePopulations?.detected ?? false,
          categories: context.sensitivePopulations?.categories ?? [],
        }

        const systemPrompt = buildReviewerSystemPrompt(role)
        const userMessage = buildReviewerUserMessage(role, context)

        const adapter = getGeminiAdapter()
        const response = await adapter.generate({ role, systemPrompt, userMessage, contextHash })

        const data = await adapter.parseResponse(response.rawOutput, ReviewerOutputSchema)

        return {
          ok: true,
          data,
          pipelineStep,
          modelUsed: response.modelUsed,
          tokensUsed: response.tokensUsed ?? null,
        }
      } catch (error) {
        return {
          ok: false,
          failure: reviewerExecutionFailure(error, projectId, role),
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
          stellaRole: role,
          pipelineStep,
          contextHash,
          riskLevel: outcome.data.risk_level,
          riskFlags: outcome.data.findings.length > 0 ? ['finding'] : [],
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
        afterJson: { stellaRole: role, reason: 'QUOTA_EXCEEDED', quotaReason: outcome.reason },
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

/** The reviewer's own error taxonomy, unchanged — only its call site moved. */
function reviewerExecutionFailure(
  error: unknown,
  projectId: string,
  role: ReviewerRole
): StellaReviewerResult {
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
