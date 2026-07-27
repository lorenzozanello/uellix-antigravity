// lib/stella/retention/eligibility.ts
// Etapa A2.4 (DR-004 aprobado) — pure, fail-closed decision of whether a
// single stella_interactions row's response_json is eligible for redaction
// right now. No DB access, no side effects, injectable clock (`now`) so
// tests never depend on wall-clock time. Only `interaction_response_content`
// is a supported category — see lib/stella/retention/policy.ts's header for
// why the other 5 categories have no executable purge path in this stage.

import { CURRENT_STELLA_RETENTION_POLICY, isValidResponseRetentionMonths, type StellaRetentionCategory, type StellaRetentionPolicy } from './policy'

export type RetentionEligibilityReason =
  | 'not_expired'
  | 'expired'
  | 'active_hold'
  | 'already_purged'
  | 'unsupported_category'
  | 'missing_policy'
  | 'invalid_timestamp'

export interface RetentionEligibilityResult {
  eligible: boolean
  reason: RetentionEligibilityReason
  expiresAt?: Date
}

export interface RetentionEligibilityInput {
  category: StellaRetentionCategory
  createdAt: Date
  /** Non-null once a prior run already redacted this row. */
  purgedAt: Date | null
  /** Org-level override (stella_retention_settings.responseRetentionMonths), if configured. */
  organizationRetentionMonths?: number
  /** Defaults to CURRENT_STELLA_RETENTION_POLICY — tests inject a fixture without ever mutating the real constant. */
  currentPolicy?: StellaRetentionPolicy
  holdStatus: 'none' | 'active'
  /** Injectable clock — defaults to `new Date()`. */
  now?: Date
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

/**
 * Adds calendar months in UTC. Known, documented limitation: day-of-month
 * overflow at month boundaries (e.g. Jan 31 + 1 month) follows JS Date's
 * native rollover (-> early March), which skews a handful of days LATER,
 * never earlier — the safe direction for a retention floor (over-retaining
 * by a few days is an acceptable, documented drift; under-retaining would
 * not be). Not a substitute for exact calendar-month arithmetic if that is
 * ever required by a future legal review (A3).
 */
function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime())
  result.setUTCMonth(result.getUTCMonth() + months)
  return result
}

/**
 * The cutoff a purge run's SQL query filters against: any row with
 * `createdAt <= cutoff` has had at least `months` elapse since creation, as
 * of `now`. Exported so the purge engine's SQL-level filter and this
 * module's per-row eligibility check use the EXACT same month arithmetic —
 * never two subtly different implementations that could disagree at a
 * boundary.
 */
export function computeRetentionCutoff(months: number, now: Date = new Date()): Date {
  return addMonthsUtc(now, -months)
}

export function evaluateRetentionEligibility(input: RetentionEligibilityInput): RetentionEligibilityResult {
  const policy = input.currentPolicy ?? CURRENT_STELLA_RETENTION_POLICY
  const now = input.now ?? new Date()

  if (input.category !== 'interaction_response_content') {
    return { eligible: false, reason: 'unsupported_category' }
  }

  if (!isValidDate(input.createdAt) || !isValidDate(now)) {
    return { eligible: false, reason: 'invalid_timestamp' }
  }

  if (input.purgedAt !== null) {
    if (!isValidDate(input.purgedAt)) return { eligible: false, reason: 'invalid_timestamp' }
    return { eligible: false, reason: 'already_purged' }
  }

  const months = input.organizationRetentionMonths ?? policy.defaultResponseRetentionMonths
  if (!isValidResponseRetentionMonths(months, policy)) {
    return { eligible: false, reason: 'missing_policy' }
  }

  const expiresAt = addMonthsUtc(input.createdAt, months)

  if (now.getTime() < expiresAt.getTime()) {
    return { eligible: false, reason: 'not_expired', expiresAt }
  }

  if (input.holdStatus === 'active') {
    return { eligible: false, reason: 'active_hold', expiresAt }
  }

  return { eligible: true, reason: 'expired', expiresAt }
}
