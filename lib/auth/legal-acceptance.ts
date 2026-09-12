// lib/auth/legal-acceptance.ts
//
// CL-1 (docs/ops/compliance/CUSTOMER_LIFECYCLE_CL1_EXECUTION_AUTHORITY_v1.0.0.json,
// HPO-ODS-W2-28) — the L0 account-class legal-acceptance substrate.
//
// THE ONE MODULE THAT DERIVES ACCEPTANCE CURRENCY
// (S-AO-PREDICATE-CARDINALITY). Every other reader consumes the boolean
// propagated onto RequestPrincipal.accountAcceptanceCurrent
// (lib/auth/database-context.ts) — never re-derive it, and never extend
// lib/auth/email-verification.ts to do this instead: that module is a frozen
// Packet B surface and CL-1 has no authority to redesign it
// (B0_PRESERVATION.FORBIDDEN).
//
// THE CLOSED REQUIRED SET is fixed by ratification (HPO-A.1), not by the
// registry. It is a constant, and encoding a ratified constant here is
// faithful, not brittle — a new required instrument class is a new
// ratification, and a code change is the correct consequence of that.
//
// THE CURRENCY PREDICATE (REACCEPTANCE.R2_CORRECTION_EFFECTIVE_AT):
//   current(P, K, t) := EXISTS an accepted version v_a of K such that
//   NOT EXISTS a version v_r of K with v_r > v_a, v_r.reaccept_required,
//   and v_r already in effect at t (effective_at IS NULL OR effective_at <= t).
// L0 passes only if this holds for EVERY key in the closed required set —
// which is also what makes an empty or partial registry fail closed: with no
// published version of a required key, no accepted row can exist, so the
// EXISTS clause fails and the conjunct is FALSE (P-AO-15, N-AO-37).
//
// ONE SET-RETURNING QUERY, not a loop over instruments
// (ENFORCEMENT_TOPOLOGY.L0_ATTACHMENT.consequence_for_the_read) — the whole
// conjunction is evaluated by a single round trip.

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * The closed set of ACCOUNT-class instrument keys product access requires
 * (HPO-A.1: Terms AND Privacy). Fixed by ratification, not derived from the
 * registry — see REACCEPTANCE.MULTI_INSTRUMENT_CONJUNCTION.THE_CLOSED_REQUIRED_SET.
 * A third required key is a new owner ratification, not a registry insert.
 */
export const ACCOUNT_REQUIRED_INSTRUMENT_KEYS = ['terms_of_service', 'privacy_policy'] as const

/**
 * Where an accepted-but-currently-refused subject is sent, and the only page
 * that renders for one. Outside every one of K3..K7, exactly like
 * VERIFY_EMAIL_PATH — a subject who fails this gate must still be able to
 * reach the act that discharges it (ENFORCEMENT_TOPOLOGY.L0_ATTACHMENT.
 * explicitly_not_gated_by_L0.the_acceptance_destination_itself).
 */
export const ACCEPT_LEGAL_PATH = '/accept-legal'

/**
 * Whether `userId` is CURRENT on every ACCOUNT-class instrument in the closed
 * required set, evaluated at the current instant.
 *
 * Must run inside an already-open database identity context (the same
 * unscoped context `readPrincipalUnderOpenContext` opens) so the read is
 * RLS-scoped to the caller — never given a foreign userId to evaluate on
 * someone else's behalf.
 *
 * FAIL-CLOSED, DELIBERATELY UNCAUGHT (FAIL_CLOSED.FC_6): a query failure
 * (RLS refusal, missing relation, connection error) must surface as a thrown
 * error, never be caught and converted into `true`. Callers that need this to
 * gate a request already run inside a context whose own failure handling is
 * fail-closed; swallowing the error here would be the single most effective
 * way to defeat this entire model, and it would be invisible in every
 * positive test.
 */
export async function deriveAccountAcceptanceCurrent(userId: string): Promise<boolean> {
  const requiredKeys = sql.join(
    ACCOUNT_REQUIRED_INSTRUMENT_KEYS.map((key) => sql`(${key}::varchar)`),
    sql`, `
  )

  const rows = await db.execute(sql`
    SELECT NOT EXISTS (
      SELECT 1
      FROM (VALUES ${requiredKeys}) AS required(instrument_key)
      WHERE NOT EXISTS (
        SELECT 1
        FROM legal_instrument_versions v
        JOIN account_legal_acceptances a
          ON a.instrument_version_id = v.id
          AND a.user_id = ${userId}::uuid
        WHERE v.instrument_key = required.instrument_key
          AND NOT EXISTS (
            SELECT 1
            FROM legal_instrument_versions v2
            WHERE v2.instrument_key = v.instrument_key
              AND v2.version > v.version
              AND v2.reaccept_required = true
              AND (v2.effective_at IS NULL OR v2.effective_at <= now())
          )
      )
    ) AS all_current
  `)

  const row = (Array.isArray(rows) ? rows[0] : undefined) as { all_current: boolean } | undefined
  if (!row) {
    throw new Error('deriveAccountAcceptanceCurrent: the currency query returned no row.')
  }
  return row.all_current === true
}

/** One version the subject is being asked to accept, resolved for display. */
export interface RequiredInstrumentForDisplay {
  readonly instrumentKey: string
  readonly instrumentVersionId: string
  readonly version: number
  readonly locale: string
  readonly contentDigest: string
}

/**
 * The currently applicable version of every required key the subject has NOT
 * yet accepted, for rendering the acceptance page. A required key with no
 * currently applicable published version is OMITTED here — the caller must
 * treat that as EMPTY_INSTRUMENT_REGISTRY (fail closed, refuse, never a
 * partial accept) rather than rendering a partial form.
 *
 * "Currently applicable": the greatest published version of the key that is
 * already in effect (effective_at IS NULL OR effective_at <= now()).
 */
export async function loadRequiredInstrumentsPendingAcceptance(
  userId: string
): Promise<RequiredInstrumentForDisplay[]> {
  const requiredKeys = sql.join(
    ACCOUNT_REQUIRED_INSTRUMENT_KEYS.map((key) => sql`(${key}::varchar)`),
    sql`, `
  )

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (required.instrument_key)
      required.instrument_key,
      v.id AS instrument_version_id,
      v.version,
      v.locale,
      v.content_digest
    FROM (VALUES ${requiredKeys}) AS required(instrument_key)
    JOIN legal_instrument_versions v ON v.instrument_key = required.instrument_key
    WHERE (v.effective_at IS NULL OR v.effective_at <= now())
      AND NOT EXISTS (
        SELECT 1 FROM account_legal_acceptances a
        WHERE a.instrument_version_id = v.id AND a.user_id = ${userId}::uuid
      )
    ORDER BY required.instrument_key, v.version DESC
  `)

  return (rows as unknown as Array<{
    instrument_key: string
    instrument_version_id: string
    version: number
    locale: string
    content_digest: string
  }>).map((r) => ({
    instrumentKey: r.instrument_key,
    instrumentVersionId: r.instrument_version_id,
    version: r.version,
    locale: r.locale,
    contentDigest: r.content_digest,
  }))
}
