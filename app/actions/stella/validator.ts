'use server'
// app/actions/stella/validator.ts
// Sprint 9D-2: Stella Validator server action
// Validates SROI analysis at Calculation step. Read-only. Audit-logged.
// Security: feature-flagged, auth-gated, rate-limited, metadata-only context,
//           no pipeline writes, no certification claims, requires_human_review always true.

import { createHash } from 'crypto'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildValidatorContext, StellaBuildValidatorContextError } from '@/lib/stella/context/build-validator-context'
import { buildValidatorSystemPrompt, buildValidatorUserMessage } from '@/lib/stella/prompts/validator-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ValidatorOutputSchema } from '@/lib/stella/schemas/validator-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { checkStellaRateLimit, recordStellaRequest } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import type { ValidatorOutput } from '@/lib/stella/schemas/validator-output'
import type { StellaProjectContext } from '@/lib/stella/context/types'

export type StellaValidatorErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

export type StellaValidatorResult =
  | { ok: true; data: ValidatorOutput }
  | { ok: false; error: StellaValidatorErrorCode; message: string }

function buildContextHash(context: StellaProjectContext): string {
  // Privacy-safe stable subset — no PII, no file paths, no financial details
  const input = JSON.stringify({
    projectId: context.projectId,
    organizationId: context.organizationId,
    outcomesCount: context.outcomesSnapshot.length,
    indicatorsCount: context.indicatorsSnapshot.length,
    evidenceCount: context.evidenceTotal,
    proxiesCount: context.proxySummary.length,
    hasCalculation: context.calculationSnapshot !== null,
    sroiRatio: context.calculationSnapshot?.sroiRatio ?? null,
  })
  return createHash('sha256').update(input).digest('hex').slice(0, 64)
}

function buildRiskFlags(output: ValidatorOutput): string[] {
  const flags: string[] = []
  if (output.evidence_gaps.length > 0) flags.push('evidence_gap')
  if (output.proxy_risks.length > 0) flags.push('proxy_risk')
  if (output.attribution_risks.length > 0) flags.push('attribution_risk')
  if (output.claim_risks.length > 0) flags.push('claim_risk')
  return flags
}

export async function getStellaValidator(
  projectId: string,
  step: string
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

  // Rate limit check — enforced per org, per hour, in-memory
  const rateLimit = checkStellaRateLimit(ctx.organization.id)
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: 'RATE_LIMITED',
      message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.`,
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
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${nextQuotaResetIso()}.`
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }

  try {
    // Build context — validates project ownership + step support before consuming rate limit
    const context = await buildValidatorContext(projectId, ctx.organization.id, step)

    // Record after context built — prevents gaming via repeated context errors,
    // allows retries on Gemini/parse failures
    recordStellaRequest(ctx.organization.id)

    // Build prompts
    const systemPrompt = buildValidatorSystemPrompt()
    const userMessage = buildValidatorUserMessage(context)
    const contextHash = buildContextHash(context)

    // Generate via Gemini adapter (real or mock in tests)
    const adapter = getGeminiAdapter()
    const response = await adapter.generate({
      role: 'validator',
      systemPrompt,
      userMessage,
      contextHash,
    })

    // Parse and validate output — throws StellaParseError on invalid JSON or schema mismatch
    const data = await adapter.parseResponse(response.rawOutput, ValidatorOutputSchema)

    // Audit insert — required for compliance; surface failure rather than swallow
    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: 'validator',
        pipelineStep: 'Calculation',
        contextHash,
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
        riskLevel: data.risk_level,
        riskFlags: buildRiskFlags(data),
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
    if (error instanceof StellaBuildValidatorContextError) {
      if (error.code === 'UNSUPPORTED_STEP') {
        return { ok: false, error: 'UNSUPPORTED_STEP', message: error.message }
      }
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
