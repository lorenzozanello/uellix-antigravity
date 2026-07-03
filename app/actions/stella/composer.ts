'use server'
// app/actions/stella/composer.ts
// Stella Composer server action — drafts one report section at a time.
// Security: feature-flagged, auth-gated, quota-enforced, rate-limited,
// metadata-only context, no automatic saves (draft returned to UI only).

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildComposerContext, StellaBuildComposerContextError } from '@/lib/stella/context/build-composer-context'
import { buildComposerSystemPrompt, buildComposerUserMessage } from '@/lib/stella/prompts/composer-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ComposerOutputSchema } from '@/lib/stella/schemas/composer-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { checkStellaRateLimit, recordStellaRequest } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

export type StellaComposerErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
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

  // Rate limit check — enforced per org, per hour, in-memory
  const rateLimit = checkStellaRateLimit(ctx.organization.id)
  if (!rateLimit.allowed) {
    return { ok: false, error: 'RATE_LIMITED', message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.` }
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

    // Record after context built — prevents gaming via repeated context errors,
    // allows retries on Gemini/parse failures
    recordStellaRequest(ctx.organization.id)

    // Build prompts
    const systemPrompt = buildComposerSystemPrompt(sectionType)
    const userMessage = buildComposerUserMessage(sectionType, context)

    // Generate via Gemini adapter (real or mock in tests)
    const adapter = getGeminiAdapter()
    const response = await adapter.generate({
      role: 'composer',
      systemPrompt,
      userMessage,
    })

    // Parse and validate output — throws StellaParseError on invalid JSON or schema mismatch
    const data = await adapter.parseResponse(response.rawOutput, ComposerOutputSchema)

    // Audit insert — required for compliance; surface failure rather than swallow
    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: 'composer',
        pipelineStep: sectionType,
        contextHash: '',
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
