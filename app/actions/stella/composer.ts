'use server'
// app/actions/stella/composer.ts
// Stella Composer server action — drafts one report section at a time.
// Security: feature-flagged, auth-gated, quota-enforced, rate-limited,
// metadata-only context, no automatic saves (draft returned to UI only).

import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildComposerContext, StellaBuildComposerContextError } from '@/lib/stella/context/build-composer-context'
import { buildContextHash } from '@/lib/stella/context/build-context-hash'
import { buildComposerSystemPrompt, buildComposerUserMessage } from '@/lib/stella/prompts/composer-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ComposerOutputSchema } from '@/lib/stella/schemas/composer-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { StellaPayloadTooLargeError } from '@/lib/stella/security/payload-limits'
import {
  validateComposerNumbers,
  validateComposerReferences,
  authorizedNumbersFromSnapshot,
} from '@/lib/stella/schemas/composer-numeric-guard'
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
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

/** TRAIN 4.3 — the category, as a module constant. No caller can choose it. */
const COMPOSER_CATEGORY = 'composer' as const

/** Square brackets, not parentheses — see the identical constant in validator.ts. */
const GOVERNED_QUOTA_LEDGER =
  'charged via uellix_stella_ops.complete_operation_ticket -> uellix_stella.settle_reserved_quota [R6-INT closed, prepared stella_0017; reservation-aware, prepared stella_0016 / R1]'

export type StellaComposerErrorCode =
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

export type StellaComposerResult =
  | { ok: true; data: ComposerOutput }
  | { ok: false; error: StellaComposerErrorCode; message: string }

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

export async function issueStellaComposerTicket(
  projectId: string
): Promise<StellaTicketIssueResult> {
  // FLAG FIRST — zero auth, zero DB, zero ticket, zero observability when off.
  if (!stellaConfig.isEnabled || !stellaConfig.isComposerEnabled || !stellaState.canUseStella) {
    return { status: 'disabled' }
  }
  return issueGovernedStellaTicket(projectId, COMPOSER_CATEGORY)
}

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
  sectionType: string,
  ticket: string
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

  // Role gate — set inclusion (reviewer allowed, viewer denied); viewers never trigger AI calls.
  if (!canUseStella(ctx.membership.role)) {
    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: projectId,
      action: AUDIT_ACTIONS.STELLA_DENIED,
      afterJson: { stellaRole: 'composer', reason: 'ROLE_DENIED', membershipRole: ctx.membership.role },
    })
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  // NO `checkStellaQuota` — see validator.ts. `bind` is the only quota check.

  let contextHash: string | null = null
  let sensitive: { detected: boolean; categories: string[] } = { detected: false, categories: [] }

  const outcome = await runGovernedStellaOperation<ComposerOutput, StellaComposerResult>({
    category: COMPOSER_CATEGORY,
    organizationId: ctx.organization.id,
    projectId,
    ticket,
    // `sectionId` IS in the digest even though the body never reads it. Two
    // sections of one report with the same `sectionType` are two different
    // drafts, and omitting the id would let a ticket minted for one settle the
    // other — one operation delivering another's text. The parameter was
    // documented as unused; it is no longer unused.
    requestParts: [reportId, sectionId, sectionType],
    execute: async () => {
      try {
        // Build context — validates project + report ownership.
        const context = await withOrganizationDatabaseContext(() =>
          buildComposerContext(projectId, ctx.organization.id, reportId)
        )
        contextHash = buildContextHash(context)
        sensitive = {
          detected: context.sensitivePopulations?.detected ?? false,
          categories: context.sensitivePopulations?.categories ?? [],
        }

        const systemPrompt = buildComposerSystemPrompt(sectionType)
        const userMessage = buildComposerUserMessage(sectionType, context)

        const adapter = getGeminiAdapter()
        const response = await adapter.generate({
          role: 'composer',
          systemPrompt,
          userMessage,
          contextHash,
        })

        const data = await adapter.parseResponse(response.rawOutput, ComposerOutputSchema)

        // Numeric + reference integrity guard (WS4): every figure and cited id
        // in the draft must trace back to the context; hallucinations fail
        // closed. THIS RUNS BEFORE `complete`, so a rejected draft is never
        // charged — which it was not before either, but only because the
        // `db.insert` happened to sit after it. Now it is structural: the
        // driver charges nothing on an `ok: false` execution.
        const referenceCheck = validateComposerReferences(data, context)
        const numberCheck = context.calculationSnapshot
          ? validateComposerNumbers(
              data,
              authorizedNumbersFromSnapshot(context.calculationSnapshot, [
                ...context.filterSetsSummary.flatMap((f) => [
                  f.deadweightPct,
                  f.attributionPct,
                  f.displacementPct,
                  f.dropoffPct,
                  f.durationYears,
                ]).filter((v): v is number => v !== undefined),
                context.stakeholderCount,
                context.evidenceTotal,
                ...(context.readinessScore !== undefined && context.readinessScore !== null
                  ? [context.readinessScore]
                  : []),
              ]),
            )
          : { ok: true as const, violations: [] }

        if (!referenceCheck.ok || !numberCheck.ok) {
          console.error('[stella] Composer integrity guard rejected draft:', {
            referenceViolations: referenceCheck.violations,
            numericViolations: numberCheck.violations,
          })
          // Audit trail: violation COUNTS only — never the violating text/figures.
          await logStellaAudit({
            organizationId: ctx.organization.id,
            actorUserId: ctx.user.id,
            entityType: 'project',
            entityId: projectId,
            action: AUDIT_ACTIONS.STELLA_INTEGRITY_REJECTED,
            afterJson: {
              stellaRole: COMPOSER_CATEGORY,
              referenceViolationCount: referenceCheck.violations.length,
              numericViolationCount: numberCheck.violations.length,
            },
          })
          return {
            ok: false,
            failure: {
              ok: false,
              error: 'PARSE_ERROR',
              message: 'Stella generó cifras o referencias no verificables. Intentá de nuevo.',
            },
            // `no_result`: the model answered and the draft was refused. The
            // operation ran; it produced nothing usable.
            abortReason: 'no_result',
          }
        }

        return {
          ok: true,
          data,
          pipelineStep: sectionType,
          modelUsed: response.modelUsed,
          tokensUsed: response.tokensUsed ?? null,
        }
      } catch (error) {
        return {
          ok: false,
          failure: composerExecutionFailure(error, projectId, reportId),
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
          stellaRole: COMPOSER_CATEGORY,
          pipelineStep: sectionType,
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
        afterJson: { stellaRole: COMPOSER_CATEGORY, reason: 'QUOTA_EXCEEDED', quotaReason: outcome.reason },
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

/** The composer's own error taxonomy, unchanged — only its call site moved. */
function composerExecutionFailure(
  error: unknown,
  projectId: string,
  reportId: string
): StellaComposerResult {
  if (error instanceof StellaBuildComposerContextError) {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Report or project access denied.' }
  }

  if (error instanceof StellaTimeoutError) {
    reportStellaFailure('composer', 'TIMEOUT', error, { projectId, reportId })
    return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
  }

  if (error instanceof StellaParseError) {
    reportStellaFailure('composer', 'PARSE_ERROR', error, { projectId, reportId })
    return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
  }

  if (error instanceof StellaGeminiError) {
    reportStellaFailure('composer', 'GEMINI_ERROR', error, { projectId, reportId })
    return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
  }

  if (error instanceof StellaPayloadTooLargeError) {
    return { ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo.' }
  }

  reportStellaFailure('composer', 'UNKNOWN_ERROR', error, { projectId, reportId })
  return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
}
