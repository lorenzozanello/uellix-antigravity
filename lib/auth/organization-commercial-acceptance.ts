// lib/auth/organization-commercial-acceptance.ts
//
// L1 (docs/ops/compliance/CUSTOMER_LIFECYCLE_L1_EXECUTION_AUTHORITY_v1.0.0.json,
// HPO-ODS-W2-29) — the ORGANIZATION_COMMERCIAL_ACCEPTANCE substrate's read
// model: the currency predicate, the presentation resolver, and the refusal
// destination.
//
// A NEW MODULE, NOT A WIDENING OF lib/auth/legal-acceptance.ts
// (SUBMISSION_BINDING.NO_WIDENING_OF_THE_L0_RESOLVER, binding). That module
// is the ACCOUNT-class (L0) resolver and stays account-specific. Adding an
// optional organizationId parameter to it would remove duplication and leave
// every L0 control green — which is exactly what makes it tempting — while
// recreating at the QUERY layer the polymorphism I-X-2 rejects at the SCHEMA
// layer, where the database cannot refuse it. Two relations, two accepting
// principals, two uniqueness rules, two resolvers. Editing the L0 derivation
// to serve L1 is scope expansion and a STOP.
//
// THE CLOSED REQUIRED SET is fixed by ratification (HPO-A.1/.2/.3), not by
// the registry — exactly as on the account side. Its CARDINALITY IS ONE and
// its class is ORGANIZATION. That is what makes an EMPTY or PARTIAL registry
// FAIL CLOSED rather than pass vacuously: the conjunction runs over the
// CLOSED REQUIRED set, never over "whatever keys the registry happens to
// contain", so a required key with no currently applicable published version
// contributes a FALSE conjunct and the gate refuses (P-AO-15, N-AO-37).
//
// THE INSTRUMENT KEY IS NOT INVENTED HERE. `commercial_terms` is the key the
// repository already uses for the ORGANIZATION-class instrument: it is
// seeded as ('commercial_terms', 'ORGANIZATION') in
// tests/postgres/legal-acceptance-fixtures.ts, where CL-1 introduced it to
// drive its own I-T3-5 class-guard negative control. Adopting it CONSUMES an
// existing repository fact rather than authoring a parallel one, and a sweep
// at this head finds it in no ACCOUNT-class position and in no required-set
// constant. The literal was IMPLEMENTATION_DEFINED and is allocated here.

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { contentMatchesDigest } from './legal-acceptance'

/**
 * The closed set of ORGANIZATION-class instrument keys an organization must
 * be current on before ENT is even asked. Cardinality ONE, by ratification.
 * A second required key is a new owner ratification, not a registry insert.
 */
export const ORGANIZATION_REQUIRED_INSTRUMENT_KEYS = ['commercial_terms'] as const

/**
 * Where an organization_admin standing in front of an undischarged L1 is
 * sent, and the only page that renders for one.
 *
 * A NEW named constant exported from ONE module, DISTINCT from
 * ACCEPT_LEGAL_PATH (lib/auth/legal-acceptance.ts:51) and from
 * VERIFY_EMAIL_PATH (lib/auth/email-verification.ts:12) — binding, per
 * ATTACHMENT_TOPOLOGY.REFUSAL_DESTINATION. The two gates have DIFFERENT
 * accepting principals and different affordances, so a shared destination
 * would present the wrong instrument to the wrong actor. The literal string
 * itself is IMPLEMENTATION_DEFINED (RAT-AO-01 authorizes no specific route);
 * a collision sweep at this head returns zero hits for it.
 *
 * It sits under app/(public)/, OUTSIDE every enforcement point — the same
 * reason /verify-email and /accept-legal do. A destination inside a route
 * group that calls requireOrganizationAccess() would redirect the subject
 * who fails L1 straight back to itself.
 */
export const ACCEPT_COMMERCIAL_TERMS_PATH = '/accept-commercial-terms'

/**
 * Whether `organizationId` is CURRENT on every ORGANIZATION-class instrument
 * in the closed required set, evaluated at the current instant.
 *
 * THE CURRENCY PREDICATE, identical in SHAPE to the account-class one and
 * deliberately re-derived rather than shared:
 *   current(O, K, t) := EXISTS an accepted version v_a of K for organization
 *   O such that NOT EXISTS a version v_r of K with v_r > v_a,
 *   v_r.reaccept_required, and v_r already in effect at t.
 *
 * IT DOES NOT JOIN BACK TO THE CURRENT MEMBERSHIP (I-T4-7,
 * HISTORY-former-admin-passes). An acceptance validly written by an
 * organization_admin who has since lost the role, changed role or left the
 * organization REMAINS VALID: `accepted_by_role` is a write-time snapshot and
 * the acceptance is evidence of a PAST act. Re-verifying it against the
 * CURRENT membership would look like defensive rigour and would silently
 * un-accept an organization whenever its founding administrator left — an
 * ordinary event, not a legal one (mutation MUT-L1-recompute-role-from-
 * current-membership).
 *
 * IT READS NO CommercialAccount STATE AT ALL. Acceptance is recorded PER
 * ORGANIZATION; one CommercialAccount may govern several organizations, and
 * inheriting an acceptance across them would give an organization that never
 * accepted anything a passing L1 (I-T4-8, CA-08, N-AO-12). A manual
 * commercial activation state — ACTIVE_WITHOUT_STRIPE or any successor — is
 * likewise NOT acceptance evidence and appears nowhere in this predicate
 * (RAT-AO-02 AO2_C3, N-AO-28).
 *
 * Must run inside an already-open ORGANIZATION-SCOPED database identity
 * context, so the read is RLS-scoped to the caller's own organization.
 *
 * FAIL-CLOSED, DELIBERATELY UNCAUGHT (FAIL_CLOSED.FC_6): a query failure —
 * RLS refusal, missing relation, connection error — must surface as a thrown
 * error, NEVER be caught and converted into `true`. A permissive catch here
 * is the single most effective way to defeat this entire model and it is
 * invisible to every positive test, which is why the twin-oracle requirement
 * runs this exact exported function against a real connection.
 */
export async function deriveOrganizationAcceptanceCurrent(organizationId: string): Promise<boolean> {
  const requiredKeys = sql.join(
    ORGANIZATION_REQUIRED_INSTRUMENT_KEYS.map((key) => sql`(${key}::varchar)`),
    sql`, `
  )

  const rows = await db.execute(sql`
    SELECT NOT EXISTS (
      SELECT 1
      FROM (VALUES ${requiredKeys}) AS required(instrument_key)
      WHERE NOT EXISTS (
        SELECT 1
        FROM legal_instrument_versions v
        JOIN organization_commercial_acceptances a
          ON a.instrument_version_id = v.id
          AND a.organization_id = ${organizationId}::uuid
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
    throw new Error('deriveOrganizationAcceptanceCurrent: the currency query returned no row.')
  }
  return row.all_current === true
}

/**
 * One ORGANIZATION-class version the organization is being asked to accept,
 * resolved for display. `content` is the EXACT retained bytes, already
 * re-verified against `contentDigest`.
 */
export interface RequiredOrganizationInstrumentForDisplay {
  readonly instrumentKey: string
  readonly instrumentVersionId: string
  readonly version: number
  readonly locale: string
  readonly contentDigest: string
  readonly content: string
}

/**
 * The currently applicable version of every required ORGANIZATION-class key
 * this organization has NOT yet accepted — the server-derived PENDING SET.
 *
 * This function is BOTH the presentation resolver AND the submission
 * validator: the acceptance action re-invokes it at submission time and
 * refuses any identifier that is not in the freshly derived result. That is
 * what makes a stale, superseded, already-accepted, not-yet-effective,
 * non-required, ACCOUNT-class, other-organization or plain forged identifier
 * all refuse IDENTICALLY — none of them can appear here, and the caller
 * cannot tell which reason applied (SUBMISSION_BINDING
 * .REFUSED_IDENTICALLY_AND_WITHOUT_AN_ORACLE, REFUSAL-no-oracle).
 *
 * "Currently applicable": the greatest published version of the key that is
 * already in effect (effective_at IS NULL OR effective_at <= now()) AND that
 * THIS ORGANIZATION has not already accepted by its exact
 * instrumentVersionId.
 *
 * FAIL CLOSED ON UNPRESENTABLE, WITH NO FALLBACK TO AN OLDER VERSION
 * (PRESENTATION_BINDING.FAIL_CLOSED_ON_UNPRESENTABLE, binding). A required
 * key is OMITTED — never partially rendered, and never satisfied by an older
 * presentable edition — when it has no currently applicable published
 * version, OR its retained content is absent, OR the retained bytes fail
 * digest re-verification. Falling back would obtain an acceptance of bytes
 * that are NOT the ones currently required: evidence that looks valid and is
 * not (mutation MUT-L1-fallback-to-older-presentable-version).
 *
 * THE APPLICABLE VERSION IS RESOLVED FROM THE LIVE REGISTRY, never pinned in
 * application code or in a constant (M-AO-4). Only the closed required KEY
 * SET is a constant; which VERSION of a key applies is always a query.
 *
 * Must run inside an already-open ORGANIZATION-SCOPED database identity
 * context. Uncaught, for the same fail-closed reason as the predicate above.
 */
export async function loadRequiredOrganizationInstrumentsPendingAcceptance(
  organizationId: string
): Promise<RequiredOrganizationInstrumentForDisplay[]> {
  const requiredKeys = sql.join(
    ORGANIZATION_REQUIRED_INSTRUMENT_KEYS.map((key) => sql`(${key}::varchar)`),
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
        SELECT 1 FROM organization_commercial_acceptances a
        WHERE a.instrument_version_id = v.id AND a.organization_id = ${organizationId}::uuid
      )
    -- The unique index on (instrument_key, version, locale) permits two rows
    -- with the SAME key and version in DIFFERENT locales, which ORDER BY
    -- v.version DESC alone does not disambiguate for DISTINCT ON. Ordering by
    -- v.id ASC is a purely mechanical, content-free tie-break chosen ONLY for
    -- determinism — carried from the L0 resolver's D-6 correction, and NOT a
    -- decision about which locale a multi-locale version should display,
    -- which remains an open product question neither lane settles.
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

  const presentable: RequiredOrganizationInstrumentForDisplay[] = []
  for (const r of candidates) {
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
