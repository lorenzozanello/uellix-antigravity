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

import { createHash } from 'node:crypto'
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

/** `'sha256:' + hex` over the exact bytes, matching content_digest's format. */
export function computeSelfDescribingDigest(bytes: string): string {
  return 'sha256:' + createHash('sha256').update(bytes, 'utf8').digest('hex')
}

/**
 * Whether `bytes` are verifiably the content `digest` identifies. Recomputed
 * every time content is about to be shown — never trusted from the row alone
 * — so a version whose retained bytes were tampered with, or corrupted, or
 * simply never written, is detected here rather than silently rendered.
 */
export function contentMatchesDigest(bytes: string, digest: string): boolean {
  return computeSelfDescribingDigest(bytes) === digest
}

/**
 * One version the subject is being asked to accept, resolved for display.
 * `content` is the EXACT retained bytes, already re-verified against
 * `contentDigest` — this is what CL1-S4/S5 requires be shown: not a route
 * name that happens to correspond, but content whose cryptographic identity
 * IS the digest the acceptance will snapshot.
 */
export interface RequiredInstrumentForDisplay {
  readonly instrumentKey: string
  readonly instrumentVersionId: string
  readonly version: number
  readonly locale: string
  readonly contentDigest: string
  readonly content: string
}

/**
 * The currently applicable version of every required key the subject has NOT
 * yet accepted, for rendering the acceptance page. A required key is OMITTED
 * here — never partially rendered — when it has no currently applicable
 * published version, OR when that version's retained content is absent, OR
 * when the retained bytes fail digest re-verification. All three are the
 * SAME fail-closed outcome from the caller's perspective: nothing provably
 * bound to that key can be shown, so nothing is offered for accept
 * (EMPTY_INSTRUMENT_REGISTRY treats a key with no presentable content
 * exactly like a key with no published version at all).
 *
 * "Currently applicable": the greatest published version of the key that is
 * already in effect (effective_at IS NULL OR effective_at <= now()) AND that
 * THIS subject has not already accepted by its exact instrumentVersionId.
 *
 * D-5 CORRECTION (independent-certification remediation): an earlier version
 * of this comment said "the greatest ... version ... in effect", full stop —
 * true only for a subject who has accepted nothing. The exclusion is scoped
 * to the SPECIFIC accepted row, not to "any version at or above what the
 * subject needs": a subject who accepted version N sees version N+2 offered
 * here the moment it publishes, even though N was, at the time, the greatest
 * in-effect version and satisfied deriveAccountAcceptanceCurrent. This is
 * harmless in the real application flow — app/(public)/accept-legal/page.tsx
 * never calls this resolver for a subject whose accountAcceptanceCurrent is
 * already true, it redirects away first — but the resolver itself, read on
 * its own, offers "the greatest in-effect version I have not personally
 * accepted", not "the greatest in-effect version, if I'm not current on it".
 * Proven directly against a real accepted-but-superseded fixture in
 * tests/postgres/legal-acceptance-real-derivation.pg.test.ts.
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
      v.content_digest,
      v.content_bytes
    FROM (VALUES ${requiredKeys}) AS required(instrument_key)
    JOIN legal_instrument_versions v ON v.instrument_key = required.instrument_key
    WHERE (v.effective_at IS NULL OR v.effective_at <= now())
      AND NOT EXISTS (
        SELECT 1 FROM account_legal_acceptances a
        WHERE a.instrument_version_id = v.id AND a.user_id = ${userId}::uuid
      )
    -- D-6 CORRECTION (independent-certification remediation): the unique
    -- index on (instrument_key, version, locale) permits two rows with the
    -- SAME key and version in DIFFERENT locales, which ORDER BY ... v.version
    -- DESC alone does not disambiguate for DISTINCT ON — PostgreSQL's own
    -- documentation is explicit that which row survives a tie is otherwise
    -- unspecified. Ordering by v.id ASC is a purely mechanical, content-free
    -- tie-break (a UUID carries no locale preference) chosen ONLY to make the result
    -- deterministic and reproducible across runs — it is NOT a decision about
    -- which locale a multi-locale version should display, which remains an
    -- open product question this remediation has no authority to settle.
    ORDER BY required.instrument_key, v.version DESC, v.id ASC
  `)

  const candidates = rows as unknown as Array<{
    instrument_key: string
    instrument_version_id: string
    version: number
    locale: string
    content_digest: string
    content_bytes: string | null
  }>

  const presentable: RequiredInstrumentForDisplay[] = []
  for (const r of candidates) {
    // No fallback to an older version: an unpresentable LATEST version means
    // this key is not offerable, full stop — never a silently-stale accept.
    if (r.content_bytes === null) continue
    if (!contentMatchesDigest(r.content_bytes, r.content_digest)) continue
    presentable.push({
      instrumentKey: r.instrument_key,
      instrumentVersionId: r.instrument_version_id,
      version: r.version,
      locale: r.locale,
      contentDigest: r.content_digest,
      content: r.content_bytes,
    })
  }
  return presentable
}
