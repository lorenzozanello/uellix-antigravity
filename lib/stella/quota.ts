// lib/stella/quota.ts
// Org-level monthly quota on Stella usage. No payment gateway — quotas are
// assigned manually by a super_admin via /admin/services. Every organization
// defaults to quota 0 (blocked) until explicitly assigned.
//
// ---------------------------------------------------------------------------
// TRAIN 4.3 — `checkStellaQuota` IS GONE, AND ITS REMOVAL IS THE POINT OF R1
// ---------------------------------------------------------------------------
// It used to be the authorization every Stella action ran before calling the
// provider: read the organization's cap, count `stella_interactions` rows of
// the current UTC month, compare. Three defects in one shape, and they are the
// same defect seen three ways:
//
//   NO LOCK           two actions could both read "one unit left" and both file
//                     a row. The organization sold a unit it did not have.
//   NO RESERVATIONS   it counted CHARGED rows only, so it could not see a live
//                     grounded reservation and would spend the unit that
//                     reservation was holding. The reservation's own `complete`
//                     was then refused on work that had already run — R1.
//   ADVISORY ONLY     the write it authorized was a direct INSERT by
//                     `uellix_app`, so the arithmetic was a correct calculation
//                     in front of a door anyone could walk around — R6-INT.
//
// The canonical arithmetic now lives in ONE place, `uellix_stella.stella_capacity`
// (prepared stella_0016), and the only thing that DECIDES on it is
// `bind_operation_ticket`, which takes the per-organization advisory lock first
// and reserves in the same statement. Nothing in `app/actions/**` reads a quota
// to authorize anything any more; a second, weaker number would only be two
// answers that can disagree, and the losing one is the one a reviewer is shown.
//
// `readStellaCapacity` below is what remains: an INFORMATIONAL reader for
// display surfaces. It authorizes nothing, and it is reservation-aware, so a
// screen built on it and a refusal produced by `bind` cannot tell a user two
// different stories.

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * The canonical capacity of one organization, as `uellix_stella.stella_capacity`
 * reports it.
 *
 * `limit === null` means no cap is assigned or enforced, and then `available`
 * is null too: "unlimited" and "a lot" are different states and collapsing them
 * into a large number loses the distinction a display needs.
 */
export interface StellaCapacity {
  readonly limit: number | null
  /** Charged rows of the current UTC month, organization-wide, all categories. */
  readonly consumed: number
  /** LIVE reservations — across actors, across projects, across categories. */
  readonly reserved: number
  readonly available: number | null
}

export function startOfCurrentUtcMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/**
 * Read an organization's Stella capacity. INFORMATIONAL ONLY.
 *
 * NEVER USE THIS TO AUTHORIZE AN OPERATION. It takes no lock — deliberately,
 * because it decides nothing — so its answer can be overtaken between the read
 * and any action taken on it. That is exactly the race that made
 * `checkStellaQuota` unsafe, and the reason a caller that is about to DECIDE
 * must go through `bind_operation_ticket` instead, which locks and reserves in
 * one statement.
 *
 * Returns `null` when the capacity cannot be read (no such organization, the
 * caller is out of scope, the package is not applied). A display shows nothing
 * rather than a zero it cannot justify.
 */
export async function readStellaCapacity(organizationId: string): Promise<StellaCapacity | null> {
  try {
    const rows = await db.execute(sql`
      SELECT limit_units, consumed, reserved, available
      FROM uellix_stella.stella_capacity(${organizationId}::uuid, NULL::char(64))
    `)
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    if (!row) return null
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
    return {
      limit: num(row.limit_units),
      consumed: num(row.consumed) ?? 0,
      reserved: num(row.reserved) ?? 0,
      available: num(row.available),
    }
  } catch {
    return null
  }
}

/** First day of next UTC month, ISO string — for user-facing "resets on" messages. */
export function nextQuotaResetIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString()
}

/** Formats an ISO-8601 string as human-readable Spanish (es-MX), e.g. "1 de agosto de 2026". */
export function formatQuotaResetDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
