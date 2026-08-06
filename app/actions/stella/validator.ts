'use server'
// app/actions/stella/validator.ts
// Sprint 9D-2: Stella Validator server action
// Validates SROI analysis at Calculation step. Read-only. Audit-logged.
// Security: feature-flagged, auth-gated, rate-limited, metadata-only context,
//           no pipeline writes, no certification claims, requires_human_review always true.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildValidatorContext, StellaBuildValidatorContextError } from '@/lib/stella/context/build-validator-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { buildValidatorSystemPrompt, buildValidatorUserMessage } from '@/lib/stella/prompts/validator-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ValidatorOutputSchema } from '@/lib/stella/schemas/validator-output'
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
import type { ValidatorOutput } from '@/lib/stella/schemas/validator-output'

/**
 * TRAIN 4.3 — the category, as a module constant.
 *
 * The validator acts as exactly one capability, so there is no category
 * parameter anywhere in this file and nothing for a caller to choose. That is
 * strictly stronger than validating an inbound value: there is no inbound
 * value.
 */
const VALIDATOR_CATEGORY = 'validator' as const

export type StellaValidatorErrorCode =
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
  /**
   * TRAIN 4.3. Retained, and no longer reachable from this action.
   *
   * It used to mean "the `db.insert(stellaInteractions)` threw after the model
   * answered", which was a real and awkward state: the provider had been paid
   * for and the audit row was missing. The row is now filed by
   * `complete_operation_ticket` in the SAME transaction that charges, so
   * "charged but unaudited" is no longer representable — a settlement failure
   * is `UNKNOWN_ERROR` (answer withheld, charge unknown) and a settled
   * duplicate is `ALREADY_COMPLETED_RESULT_UNAVAILABLE`.
   *
   * Kept in the union rather than removed because `components/stella/error-messages.ts`
   * still renders it and a client compiled against an older build may still be
   * switching on it.
   */
  | 'AUDIT_ERROR'
  /**
   * TRAIN 4.3. This operation already ran and was already charged, and the
   * answer it paid for is not recoverable. NOT retryable — the notice renders
   * without a "Reintentar" affordance, because retrying would mint a new ticket
   * and charge a second unit for an answer the reviewer has already paid for.
   */
  | 'ALREADY_COMPLETED_RESULT_UNAVAILABLE'
  | 'UNKNOWN_ERROR'

export type StellaValidatorResult =
  | { ok: true; data: ValidatorOutput }
  | { ok: false; error: StellaValidatorErrorCode; message: string }

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

function buildRiskFlags(output: ValidatorOutput): string[] {
  const flags: string[] = []
  if (output.evidence_gaps.length > 0) flags.push('evidence_gap')
  if (output.proxy_risks.length > 0) flags.push('proxy_risk')
  if (output.attribution_risks.length > 0) flags.push('attribution_risk')
  if (output.claim_risks.length > 0) flags.push('claim_risk')
  return flags
}

/**
 * Mint one operation ticket for one validator run.
 *
 * The category is this module's constant; the project is the caller's argument
 * and is re-verified against the session's organization inside SQL. See
 * `lib/stella/operation-ticket/issue-governed-ticket.ts` for the full list of
 * what a client cannot send.
 *
 * THE FLAG IS CHECKED HERE, FIRST. With it false this returns before
 * authenticating, before opening a database context, before minting anything
 * and before emitting a single event — which is what makes the code path safe
 * to ship dark.
 */
export async function issueStellaValidatorTicket(
  projectId: string
): Promise<StellaTicketIssueResult> {
  if (!stellaConfig.isEnabled || !stellaConfig.isValidatorEnabled || !stellaState.canUseStella) {
    return { status: 'disabled' }
  }
  return issueGovernedStellaTicket(projectId, VALIDATOR_CATEGORY)
}

/**
 * Run one validator operation under `ticket`.
 *
 * `ticket` is a THIRD PARAMETER, never a field of a request object, for the
 * reason `components/stella/grounded-query.ts` states at length: the functional
 * arguments are what the reviewer asked for and the ticket is a credential, and
 * as separate parameters neither has anywhere to put the other.
 */
export async function getStellaValidator(
  projectId: string,
  step: string,
  ticket: string
): Promise<StellaValidatorResult> {
  // Feature flag gate — all flags default to false
  if (!stellaConfig.isEnabled || !stellaConfig.isValidatorEnabled || !stellaState.canUseStella) {
    return { ok: false, error: 'DISABLED', message: 'Stella Validator is not enabled.' }
  }

  // Auth + org context
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
      afterJson: { stellaRole: 'validator', reason: 'ROLE_DENIED', membershipRole: ctx.membership.role },
    })
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  // ---------------------------------------------------------------------
  // NO `checkStellaQuota` HERE — TRAIN 4.3 REMOVED IT, AND ITS REMOVAL IS THE
  // POINT OF R6-INT.
  // ---------------------------------------------------------------------
  // What used to sit here was an UNLOCKED count of `stella_interactions` rows,
  // followed later by a direct `db.insert` of one more. Three defects in one
  // shape: the count took no lock, so two siblings could both read "one unit
  // left"; it could not see a LIVE RESERVATION, so it would spend the unit a
  // bound grounded ticket was holding (R1); and the write it authorized was a
  // direct INSERT, so the arithmetic was advisory (R6-INT).
  //
  // `bind_operation_ticket` inside `runGovernedStellaOperation` performs the
  // canonical check — `Consumed + LiveReserved <= Limit` — under the SAME
  // per-organization advisory lock the charge takes. Keeping a second, weaker
  // number would only mean two answers that can disagree, and the losing one is
  // the one the reviewer is shown.

  // The context fingerprint, captured here so the metadata-only audit entry
  // below can carry it. It is NOT the ticket's bind digest: see
  // `lib/stella/operation-ticket/operation-request-hash.ts` for why a digest of
  // live project state cannot be what a retry is matched on.
  let contextHash: string | null = null
  let sensitive: { detected: boolean; categories: string[] } = { detected: false, categories: [] }

  const outcome = await runGovernedStellaOperation<ValidatorOutput, StellaValidatorResult>({
    category: VALIDATOR_CATEGORY,
    organizationId: ctx.organization.id,
    projectId,
    ticket,
    // The functional arguments, in a fixed order this action chooses. A retry
    // of the same run canonicalizes identically; a different step is a
    // different request and `U0107` refuses to reuse the ticket for it.
    requestParts: [step],
    execute: async () => {
      try {
        // Build context — validates project ownership + step support.
        const context = await withOrganizationDatabaseContext(() =>
          buildValidatorContext(projectId, ctx.organization.id, step)
        )
        contextHash = buildContextHash(context)
        sensitive = {
          detected: context.sensitivePopulations?.detected ?? false,
          categories: context.sensitivePopulations?.categories ?? [],
        }

        const systemPrompt = buildValidatorSystemPrompt()
        const userMessage = buildValidatorUserMessage(context)

        const adapter = getGeminiAdapter()
        const response = await adapter.generate({
          role: 'validator',
          systemPrompt,
          userMessage,
          contextHash,
        })

        // Throws StellaParseError on invalid JSON or schema mismatch.
        const data = await adapter.parseResponse(response.rawOutput, ValidatorOutputSchema)

        return {
          ok: true,
          data,
          pipelineStep: 'Calculation',
          modelUsed: response.modelUsed,
          tokensUsed: response.tokensUsed ?? null,
        }
      } catch (error) {
        // Every failure of the work is reported to the driver as a RELEASE, so
        // the reservation is handed back and nothing is charged. The action's
        // own twelve-code taxonomy rides along untouched — the driver never
        // learns it.
        return {
          ok: false,
          failure: validatorExecutionFailure(error, projectId),
          abortReason: 'execution_failed',
        }
      }
    },
  })

  switch (outcome.kind) {
    case 'completed':
      // The unit is charged and the row is filed. Only now is the answer
      // returnable — and the audit entry below is metadata only, fire-and-forget,
      // exactly as it was before: a trail failure must never change what the
      // reviewer sees.
      await logStellaAudit({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_INVOKED,
        afterJson: {
          stellaRole: VALIDATOR_CATEGORY,
          pipelineStep: 'Calculation',
          // TRAIN 4.3: the context fingerprint moved HERE. The ledger's
          // `context_hash` now holds the REQUEST digest, because
          // `complete_operation_ticket` files the digest the ticket was bound to
          // and nothing the caller supplies can move it. Declared in
          // docs/ops/contracts/CONTRACT_LEDGER.md.
          contextHash,
          riskLevel: outcome.data.risk_level,
          riskFlags: buildRiskFlags(outcome.data),
          // RK-08: metadata only — flags that the heightened-care notice applied.
          sensitivePopulations: sensitive.detected,
          sensitivePopulationCategories: sensitive.categories,
          quotaLedger: GOVERNED_QUOTA_LEDGER,
        },
      })
      return { ok: true, data: outcome.data }

    case 'quota_exceeded': {
      // Refused BEFORE the provider was called. There is no work to give away.
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
        afterJson: { stellaRole: VALIDATOR_CATEGORY, reason: 'QUOTA_EXCEEDED', quotaReason: outcome.reason },
      })
      return { ok: false, error: 'QUOTA_EXCEEDED', message }
    }

    case 'quota_refused_after_execution':
      // Fail-closed remnant of R1 — unreachable against the healthy chain. The
      // computed answer is DISCARDED rather than given away uncharged.
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
      // The charge may or may not have landed, so the answer is withheld.
      return { ok: false, error: 'UNKNOWN_ERROR', message: 'Stella no pudo completar la operación.' }

    case 'execution_failed':
      return outcome.failure
  }
}

/**
 * The quota provenance recorded on every charged validator run.
 *
 * Square brackets, not parentheses, and that is not a style choice: the
 * cross-workstream suite asserts no action module INVOKES the ledger function
 * directly, matching the schema-qualified name followed by an open paren. An
 * audit label written with parentheses would trip that check while invoking
 * nothing.
 */
const GOVERNED_QUOTA_LEDGER =
  'charged via uellix_stella_ops.complete_operation_ticket -> uellix_stella.settle_reserved_quota [R6-INT closed, prepared stella_0017; reservation-aware, prepared stella_0016 / R1]'

/** The action's own error taxonomy, unchanged — only its call site moved. */
function validatorExecutionFailure(error: unknown, projectId: string): StellaValidatorResult {
  if (error instanceof StellaBuildValidatorContextError) {
    if (error.code === 'UNSUPPORTED_STEP') {
      return { ok: false, error: 'UNSUPPORTED_STEP', message: error.message }
    }
    return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
  }

  if (error instanceof StellaTimeoutError) {
    reportStellaFailure('validator', 'TIMEOUT', error, { projectId })
    return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
  }

  if (error instanceof StellaParseError) {
    reportStellaFailure('validator', 'PARSE_ERROR', error, { projectId })
    return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
  }

  if (error instanceof StellaGeminiError) {
    reportStellaFailure('validator', 'GEMINI_ERROR', error, { projectId })
    return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
  }

  if (error instanceof StellaPayloadTooLargeError) {
    return {
      ok: false,
      error: 'PAYLOAD_TOO_LARGE',
      message:
        'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.',
    }
  }

  reportStellaFailure('validator', 'UNKNOWN_ERROR', error, { projectId })
  return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
}
