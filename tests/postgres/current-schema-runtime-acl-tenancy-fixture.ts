/**
 * The governed two-subject fixture for PG-06 and PG-17.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT. It seeds BUSINESS ROWS
 * administratively — organisations, users, memberships, projects and the
 * parents the eighteen readable relations need — so that the operations under
 * test have something real to read and write. It issues NO GRANT, alters NO
 * role, creates NO policy and changes NO privilege. The parent authority's
 * SECTION_13 PROHIBITED_IN_THE_SUBSTRATE forbids exactly those, and names the
 * existing account_legal_acceptances harness (which grants USAGE ON SCHEMA auth
 * to uellix_writer) as the shape that is NOT admissible. Nothing of that shape
 * appears here: the runtime's reach is whatever stella_0021 and the governed
 * chain give it, and if that is not enough the test goes RED.
 *
 * THE THREE SUBJECTS, and why there are three rather than two:
 *
 *   ORG_A / USER_A     the primary tenant subject
 *   ORG_B / USER_B     the sibling tenant subject
 *   USER_A2            a SECOND user inside ORG_A
 *
 * USER_A2 exists because of the amendment's MANDATORY_ATTRIBUTION_GUARD
 * (SECTION_A4). account_legal_acceptances has no organization_id; its only
 * isolation is `user_id = auth.uid()`. If its two subjects sat in different
 * organisations, a green result would be equally explainable by an
 * organisation boundary, and the control would be proving something other than
 * what it claims. USER_A and USER_A2 are co-members of ORG_A, so the
 * organisation explanation is removed and the user predicate has to carry the
 * result on its own.
 *
 * Authority: CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_AMENDMENT_v1.0.1
 * SECTION_A4 (PG-17A), SECTION_A5 (PG-17B); parent SECTION_14 PG-06.
 */

import type { AclCluster } from './current-schema-runtime-acl-harness'

/* -------------------------------------------------------------------------- */
/* Subjects and fixture identifiers                                           */
/* -------------------------------------------------------------------------- */

export const ORG_A = '1a000000-0000-4000-8000-00000000000a'
export const ORG_B = '1b000000-0000-4000-8000-00000000000b'
export const USER_A = 'aa000000-0000-4000-8000-00000000000a'
export const USER_B = 'bb000000-0000-4000-8000-00000000000b'
/** A SECOND member of ORG_A — the attribution guard for the user arm. */
export const USER_A2 = 'aa000000-0000-4000-8000-00000000002a'

/** Per-organisation parent rows, addressed deterministically. */
export const IDS = {
  [ORG_A]: {
    org: ORG_A,
    user: USER_A,
    project: 'c0000000-0000-4000-8000-00000000000a',
    stakeholder: 'c1000000-0000-4000-8000-00000000000a',
    outcome: 'c2000000-0000-4000-8000-00000000000a',
    evidence: 'c3000000-0000-4000-8000-00000000000a',
    source: 'c4000000-0000-4000-8000-00000000000a',
    proxy: 'c5000000-0000-4000-8000-00000000000a',
    run: 'c6000000-0000-4000-8000-00000000000a',
    assumption: 'c7000000-0000-4000-8000-00000000000a',
    evidenceVersion: 'c8000000-0000-4000-8000-00000000000a',
    run2: 'ca000000-0000-4000-8000-00000000000a',
  },
  [ORG_B]: {
    org: ORG_B,
    user: USER_B,
    project: 'd0000000-0000-4000-8000-00000000000b',
    stakeholder: 'd1000000-0000-4000-8000-00000000000b',
    outcome: 'd2000000-0000-4000-8000-00000000000b',
    evidence: 'd3000000-0000-4000-8000-00000000000b',
    source: 'd4000000-0000-4000-8000-00000000000b',
    proxy: 'd5000000-0000-4000-8000-00000000000b',
    run: 'd6000000-0000-4000-8000-00000000000b',
    assumption: 'd7000000-0000-4000-8000-00000000000b',
    evidenceVersion: 'd8000000-0000-4000-8000-00000000000b',
    run2: 'da000000-0000-4000-8000-00000000000b',
  },
} as const

/** The global legal instrument the two acceptance relations hang off. */
export const INSTRUMENT_KEY_ACCOUNT = 'PG17_ACCOUNT_TERMS'
export const INSTRUMENT_KEY_ORG = 'PG17_ORG_TERMS'
export const INSTRUMENT_VERSION_ACCOUNT = 'e0000000-0000-4000-8000-000000000001'
export const INSTRUMENT_VERSION_ORG = 'e0000000-0000-4000-8000-000000000002'
/** The approved GLOBAL financial_proxy_versions row — PG-17B's row class. */
export const GLOBAL_PROXY_VERSION = 'e0000000-0000-4000-8000-000000000003'
export const GLOBAL_PROXY = 'e0000000-0000-4000-8000-000000000004'
export const GLOBAL_SOURCE = 'e0000000-0000-4000-8000-000000000005'
/** Second versions, so PG-06's INSERTs do not collide with PG-17's rows. */
export const INSTRUMENT_VERSION_ACCOUNT_2 = 'e0000000-0000-4000-8000-000000000006'
export const INSTRUMENT_VERSION_ORG_2 = 'e0000000-0000-4000-8000-000000000007'
/** The digest every acceptance must mirror from its referenced version. */
export const VERSION_DIGEST = `sha256:${'a'.repeat(64)}`

const DIGEST = `sha256:${'a'.repeat(64)}`

/* -------------------------------------------------------------------------- */
/* The census, derived from the frozen classes                                */
/* -------------------------------------------------------------------------- */

/** Parent SECTION_2 APPEND_ONLY — 8. */
export const APPEND_ONLY = [
  'account_legal_acceptances', 'assumption_object_links', 'domain_object_versions',
  'evidence_sufficiency_determinations', 'evidence_tombstones',
  'organization_commercial_acceptances', 'readiness_assessments', 'sensitivity_scenarios',
] as const

/** Parent SECTION_2 OPERATIONAL_INSERT_UPDATE — 6. */
export const OPERATIONAL_IU = [
  'counterfactual_assessments', 'evidence_versions', 'financial_proxy_versions',
  'methodological_assumptions', 'outcome_monetization_dispositions', 'sensitivity_candidates',
] as const

/** Parent SECTION_2 READ_ONLY — 4. Amendment SECTION_A2 PLATFORM_GLOBAL. */
export const PLATFORM_GLOBAL = [
  'governed_model_registry', 'legal_instrument_versions', 'legal_instruments',
  'proxy_material_fields_registry',
] as const

/** PG-06 censuses, derived from the classes and never from a successful run. */
export const INSERT_CENSUS = [...APPEND_ONLY, ...OPERATIONAL_IU]
export const UPDATE_CENSUS = [...OPERATIONAL_IU]
export const SELECT_CENSUS = [...APPEND_ONLY, ...OPERATIONAL_IU, ...PLATFORM_GLOBAL]

/** Amendment SECTION_A2: the 13 relations whose policy reads organization_id. */
export const ORG_SCOPED = [
  'assumption_object_links', 'domain_object_versions', 'evidence_sufficiency_determinations',
  'evidence_tombstones', 'organization_commercial_acceptances', 'readiness_assessments',
  'sensitivity_scenarios', 'counterfactual_assessments', 'evidence_versions',
  'financial_proxy_versions', 'methodological_assumptions',
  'outcome_monetization_dispositions', 'sensitivity_candidates',
] as const

/** Amendment SECTION_A2: the one relation whose policy reads user_id. */
export const USER_SCOPED = 'account_legal_acceptances'

/**
 * Every two-sided relation carries its sentinel in its own PRIMARY KEY.
 *
 * AN EARLIER DRAFT PUT THE SENTINEL IN A TEXT COLUMN and it was wrong twice
 * over. `assumption_object_links.affected_object_type` is CHECK-constrained to
 * a four-value vocabulary, and `readiness_assessments.readiness_model_version`
 * is varchar(20) — a marker cannot live in either without either violating the
 * constraint or being truncated into something another row could collide with.
 * MEASURED: all fourteen relations carry `id uuid PRIMARY KEY`, so the row's
 * own identity is both available everywhere and immune to any CHECK. It is also
 * the STRONGER assertion the amendment asks for
 * (ROW_IDENTITY_IS_ASSERTED_NOT_ROW_COUNT): a primary key cannot be duplicated
 * by accident the way a text marker can.
 */
export const TWO_SIDED = [...ORG_SCOPED, USER_SCOPED] as const

/** A deterministic, per-(subject, relation) primary key. */
export function sentinelFor(subject: string, relation: string): string {
  const idx = TWO_SIDED.indexOf(relation as (typeof TWO_SIDED)[number])
  if (idx < 0) throw new Error(`${relation} is not a two-sided relation`)
  // Subject nibble: ORG_A/USER_A -> a, ORG_B -> b, USER_A2 -> 2. Encoded in the
  // uuid so a leaked row names its own owner when a failure prints it.
  const tag = subject === ORG_B || subject === USER_B ? 'b' : subject === USER_A2 ? '2' : 'a'
  const n = (idx + 1).toString(16).padStart(2, '0')
  return `5e000000-0000-4000-8000-0000000${tag}00${n}`
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

/** Subjects, memberships and the per-organisation parent rows. */
export function seedSubjects(c: AclCluster): void {
  c.fixture(`
    INSERT INTO auth.users (id, email) VALUES
      ('${USER_A}','a@pg17.invalid'), ('${USER_B}','b@pg17.invalid'), ('${USER_A2}','a2@pg17.invalid')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.users (id, email) VALUES
      ('${USER_A}','a@pg17.invalid'), ('${USER_B}','b@pg17.invalid'), ('${USER_A2}','a2@pg17.invalid')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES
      ('${ORG_A}','PG17 Org A','pg17-org-a'), ('${ORG_B}','PG17 Org B','pg17-org-b')
      ON CONFLICT (id) DO NOTHING;
    -- organization_admin is the role every INSERT policy under test admits.
    INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
      ('${ORG_A}','${USER_A}','organization_admin','active'),
      ('${ORG_B}','${USER_B}','organization_admin','active'),
      ('${ORG_A}','${USER_A2}','organization_admin','active')
      ON CONFLICT DO NOTHING;
  `)

  for (const key of [ORG_A, ORG_B] as const) {
    const f = IDS[key]
    c.fixture(`
      INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
        ('${f.project}','${f.org}','PG17 Project','${f.user}') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.stakeholder_groups (id, project_id, name) VALUES
        ('${f.stakeholder}','${f.project}','PG17 Stakeholders') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.outcomes (id, project_id, stakeholder_group_id, title, created_by) VALUES
        ('${f.outcome}','${f.project}','${f.stakeholder}','PG17 Outcome','${f.user}') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, created_by) VALUES
        ('${f.evidence}','${f.project}','${f.org}','text','PG17 Evidence','${f.user}') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.proxy_sources (id, organization_id, name, created_by) VALUES
        ('${f.source}','${f.org}','PG17 Source','${f.user}') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.financial_proxies (id, organization_id, source_id, name, created_by) VALUES
        ('${f.proxy}','${f.org}','${f.source}','PG17 Proxy','${f.user}') ON CONFLICT (id) DO NOTHING;
      -- status is supplied explicitly: db/migrations/0009 gives the column
      -- DEFAULT 'completed' and 0010 later replaced the CHECK with
      -- IN ('calculated','failed','pending') without updating the default, so
      -- an INSERT that omits it fails 23514. Recorded as migration debt; not
      -- repaired by this lane.
      -- version is supplied explicitly and DIFFERS between the two runs:
      -- uq_sroi_run_project_version is UNIQUE on (project_id, version) and the
      -- column defaults to 1, so two runs of one project collide unless the
      -- second names its own version.
      INSERT INTO public.sroi_calculation_runs
        (id, project_id, organization_id, calculated_by, status, version, methodology_version, snapshot_json) VALUES
        ('${f.run}','${f.project}','${f.org}','${f.user}','calculated',1,'1.0.0','{"discountRatePct":"3.5"}'::jsonb),
        ('${f.run2}','${f.project}','${f.org}','${f.user}','calculated',2,'1.0.0','{"discountRatePct":"4.5"}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
    `)
  }

  // The global legal instruments. PG-17B B1 requires the two legal relations to
  // be NON-EMPTY before any visibility assertion runs: on a bare baseline they
  // are empty, and "A and B see the same rows" is trivially true of nothing.
  c.fixture(`
    INSERT INTO public.legal_instruments (instrument_key, instrument_class) VALUES
      ('${INSTRUMENT_KEY_ACCOUNT}','ACCOUNT'), ('${INSTRUMENT_KEY_ORG}','ORGANIZATION')
      ON CONFLICT (instrument_key) DO NOTHING;
    INSERT INTO public.legal_instrument_versions
      (id, instrument_key, version, locale, content_digest, reaccept_required, published_by) VALUES
      ('${INSTRUMENT_VERSION_ACCOUNT}','${INSTRUMENT_KEY_ACCOUNT}',1,'en','${DIGEST}',false,'${USER_A}'),
      ('${INSTRUMENT_VERSION_ORG}','${INSTRUMENT_KEY_ORG}',1,'en','${DIGEST}',false,'${USER_A}'),
      ('${INSTRUMENT_VERSION_ACCOUNT_2}','${INSTRUMENT_KEY_ACCOUNT}',2,'en','${DIGEST}',false,'${USER_A}'),
      ('${INSTRUMENT_VERSION_ORG_2}','${INSTRUMENT_KEY_ORG}',2,'en','${DIGEST}',false,'${USER_A}')
      ON CONFLICT (id) DO NOTHING;
    -- The APPROVED GLOBAL row class of financial_proxy_versions: PG-17B's fifth
    -- covered surface. organization_id IS NULL and review_status = 'approved'
    -- is the exact predicate of the policy's first disjunct.
    INSERT INTO public.proxy_sources (id, organization_id, name, created_by) VALUES
      ('${GLOBAL_SOURCE}', NULL, 'PG17 Global Source','${USER_A}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.financial_proxies (id, organization_id, source_id, name, created_by) VALUES
      ('${GLOBAL_PROXY}', NULL, '${GLOBAL_SOURCE}', 'PG17 Global Proxy','${USER_A}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.financial_proxy_versions
      (id, organization_id, financial_proxy_id, ordinal, source_id, review_status, relevance_justification, created_by) VALUES
      ('${GLOBAL_PROXY_VERSION}', NULL, '${GLOBAL_PROXY}', 1, '${GLOBAL_SOURCE}', 'approved',
       'PG17-GLOBAL-financial_proxy_versions','${USER_A}')
      ON CONFLICT (id) DO NOTHING;
  `)
}

/**
 * One sentinel-bearing row per subject on each of the 14 two-sided relations.
 *
 * Written administratively so PG-17A measures VISIBILITY rather than write
 * capability — PG-06 is the family that proves the runtime can write. Every row
 * is otherwise exactly what the product would produce.
 */
export function seedTenantSentinels(c: AclCluster): void {
  for (const key of [ORG_A, ORG_B] as const) {
    const f = IDS[key]
    const s = (rel: string) => sentinelFor(f.org, rel)
    // SEEDED WITH THE SUBJECT'S IDENTITY, because several of these relations
    // carry BEFORE INSERT triggers comparing a column to auth.uid() — e.g.
    // organization_commercial_acceptances refuses with "accepted_by_user_id
    // must be the acting subject (I-T4-6)". In a claim-free admin session
    // auth.uid() is NULL and the row cannot be written at all.
    c.fixtureAs(f.user, `
      INSERT INTO public.methodological_assumptions
        (id, organization_id, project_id, formulation, rationale, basis_type, materiality_flag, created_by) VALUES
        ('${s('methodological_assumptions')}','${f.org}','${f.project}','PG17 formulation','r','derived','material','${f.user}');
      INSERT INTO public.assumption_object_links
        (id, organization_id, assumption_id, affected_object_type, affected_object_id, created_by) VALUES
        ('${s('assumption_object_links')}','${f.org}','${s('methodological_assumptions')}','outcome','${f.outcome}','${f.user}');
      INSERT INTO public.domain_object_versions
        (id, organization_id, object_type, object_id, ordinal, payload_json, content_hash, created_by) VALUES
        ('${s('domain_object_versions')}','${f.org}','outcome','${f.outcome}',1,'{}'::jsonb,'${'b'.repeat(64)}','${f.user}');
      -- calculation_run_id is NOT NULL and is NOT in this relation's CREATE
      -- TABLE: a later migration added it with ALTER TABLE ADD COLUMN. Measured
      -- from information_schema on the built substrate, because a static scan
      -- of CREATE TABLE blocks cannot see a column added afterwards.
      INSERT INTO public.evidence_sufficiency_determinations
        (id, organization_id, project_id, outcome_id, calculation_run_id, ordinal, determination, rationale, actor_user_id) VALUES
        ('${s('evidence_sufficiency_determinations')}','${f.org}','${f.project}','${f.outcome}','${f.run}',1,'sufficient','PG17 rationale','${f.user}');
      INSERT INTO public.evidence_versions
        (id, organization_id, evidence_id, ordinal, content, review_status, created_by) VALUES
        ('${s('evidence_versions')}','${f.org}','${f.evidence}',1,'PG17 content','draft','${f.user}');
      INSERT INTO public.evidence_tombstones
        (id, organization_id, evidence_id, evidence_version_id, erasure_state, erasure_reason, rationale, actor_user_id) VALUES
        ('${s('evidence_tombstones')}','${f.org}','${f.evidence}','${s('evidence_versions')}','erasure_complete','retention_policy','PG17 rationale','${f.user}');
      INSERT INTO public.organization_commercial_acceptances
        (id, organization_id, instrument_key, instrument_version_id, content_digest, accepted_by_user_id, accepted_by_role) VALUES
        ('${s('organization_commercial_acceptances')}','${f.org}','${INSTRUMENT_KEY_ORG}','${INSTRUMENT_VERSION_ORG}','${DIGEST}','${f.user}','organization_admin');
      INSERT INTO public.readiness_assessments
        (id, organization_id, project_id, calculation_run_id, readiness_model_version, global_score, band, dimension_scores, criteria_detail, created_by) VALUES
        ('${s('readiness_assessments')}','${f.org}','${f.project}','${f.run}','1.0.0',50.00,'partial_preparation','{}'::jsonb,'{}'::jsonb,'${f.user}');
      INSERT INTO public.sensitivity_scenarios
        (id, organization_id, project_id, calculation_run_id, scenario_kind, candidate_ids, modified_inputs, reason,
         sensitivity_model_version, calculation_engine_version, result_json, base_result_json, selected_by, created_by) VALUES
        ('${s('sensitivity_scenarios')}','${f.org}','${f.project}','${f.run}','one_at_a_time','[]'::jsonb,'[]'::jsonb,'PG17 reason',
         '1.0.0','1.0.0','{}'::jsonb,'{}'::jsonb,'${f.user}','${f.user}');
      INSERT INTO public.counterfactual_assessments
        (id, organization_id, outcome_id, calculation_run_id, baseline_availability, basis_kind, deadweight_support_state, rationale, created_by) VALUES
        ('${s('counterfactual_assessments')}','${f.org}','${f.outcome}','${f.run}','not_available','documented_assumption','unknown_or_insufficient','PG17 rationale','${f.user}');
      INSERT INTO public.outcome_monetization_dispositions
        (id, organization_id, outcome_id, calculation_run_id, disposition, reason, justification, created_by) VALUES
        ('${s('outcome_monetization_dispositions')}','${f.org}','${f.outcome}','${f.run}','not_monetized','no_defensible_proxy','PG17 justification','${f.user}');
      INSERT INTO public.sensitivity_candidates
        (id, organization_id, project_id, calculation_run_id, candidate_key, candidate_kind, input_reference, sensitivity_model_version, created_by) VALUES
        ('${s('sensitivity_candidates')}','${f.org}','${f.project}','${f.run}','pg17_candidate','other_quantitative_input','{}'::jsonb,'1.0.0','${f.user}');
      -- TENANT rows of financial_proxy_versions MUST carry organization_id IS
      -- NOT NULL (amendment FINANCIAL_PROXY_VERSIONS_FIXTURE_CONSTRAINT): a
      -- NULL-org row falls into the approved-global class, is visible to both
      -- organisations by design, and would make the isolation assertion RED
      -- against a correct implementation.
      INSERT INTO public.financial_proxy_versions
        (id, organization_id, financial_proxy_id, ordinal, source_id, review_status, relevance_justification, created_by) VALUES
        ('${s('financial_proxy_versions')}','${f.org}','${f.proxy}',1,'${f.source}','draft','PG17 tenant row','${f.user}');
    `)
  }

  // The USER arm: two acceptance rows for two users of the SAME organisation.
  // Each is written under ITS OWN subject, because the relation's guard ties
  // user_id to the acting identity — which is precisely the predicate PG-17A's
  // user arm then measures.
  for (const subject of [USER_A, USER_A2]) {
    c.fixtureAs(subject, `
      INSERT INTO public.account_legal_acceptances (id, user_id, instrument_version_id, content_digest) VALUES
        ('${sentinelFor(subject, 'account_legal_acceptances')}','${subject}','${INSTRUMENT_VERSION_ACCOUNT}','${DIGEST}');
    `)
  }
}

/* -------------------------------------------------------------------------- */
/* The PG-17A / PG-17B arm predicates — SHARED, and shared on purpose          */
/* -------------------------------------------------------------------------- */

/**
 * Each function below IS the predicate of exactly one amended PG-17 control.
 * Both the positive control in current-schema-runtime-acl-rls.pg.test.ts and
 * the falsification of that same control in
 * current-schema-runtime-acl-rls-mutations.pg.test.ts call it — the same
 * function, not two statements of the same idea.
 *
 * WHY SHARED RATHER THAN RE-EXPRESSED IN THE BATTERY. A mutation arm that
 * re-states its control's predicate proves only that THE COPY goes red. Copy
 * and control then drift apart on the next edit, and the battery can stay green
 * while falsifying a version of the control that no longer exists — the
 * "GREEN misread as robustness" failure the manifest's
 * ANCHOR_UNIQUENESS_REQUIREMENT names, displaced one level up from the anchor
 * to the predicate. Anchor uniqueness stops the battery mutating the wrong
 * SITE; this stops it measuring the wrong CONTROL.
 *
 * CONVENTION: each returns the failures it found. EMPTY means the arm HOLDS. A
 * caller asserts toEqual([]) for the positive control and not.toEqual([]) for
 * its falsification, so the two directions are the two truth values of one
 * expression rather than two expressions that merely agree today.
 */

/** The primary keys a subject can SEE on a relation. Row IDENTITY, not count. */
export function visibleIds(
  c: AclCluster,
  subject: string,
  relation: string,
): { rows: string[]; sqlstate: string | null } {
  const r = c.identityQuery({ sub: subject }, `SELECT id::text FROM public.${relation}`)
  return { rows: r.rows.map((x) => x[0]), sqlstate: r.sqlstate }
}

/**
 * PG-17A-P-1 / PG-17A-N-1 for ONE direction of the organisation arm.
 *
 * OWN_ROW_PRESENT is checked alongside SIBLING_ROW_ABSENT and is not
 * decoration: without it an EMPTY result satisfies "the sibling is absent",
 * and the arm would pass against a policy that refuses everything.
 */
export function orgArmFailures(
  c: AclCluster,
  subject: string,
  ownOrg: string,
  siblingOrg: string,
): string[] {
  const failures: string[] = []
  for (const relation of ORG_SCOPED) {
    const seen = visibleIds(c, subject, relation)
    if (seen.sqlstate !== null) { failures.push(`${relation}: ${seen.sqlstate}`); continue }
    if (!seen.rows.includes(sentinelFor(ownOrg, relation))) {
      failures.push(`${relation}: ${ownOrg} own sentinel is NOT visible (${seen.rows.length} rows)`)
    }
    if (seen.rows.includes(sentinelFor(siblingOrg, relation))) {
      failures.push(`${relation}: ${siblingOrg} sentinel LEAKED to ${ownOrg}`)
    }
  }
  return failures
}

/**
 * PG-17A-P-2 / PG-17A-N-2 — the user arm, WITH its attribution guard.
 *
 * The co-membership check is part of the predicate rather than a separate
 * setup assertion, because it is what makes the isolation result attributable
 * to user_id = auth.uid() rather than to an organisation boundary. M-PG17-02
 * removes exactly that co-membership, so it must be this function that
 * notices — a guard living outside the predicate would leave the mutation
 * with nothing to turn red.
 */
export function userArmFailures(c: AclCluster): string[] {
  const failures: string[] = []

  const orgs = c.query(
    `SELECT DISTINCT organization_id FROM public.organization_members
     WHERE user_id IN ('${USER_A}','${USER_A2}')`,
  )
  if (JSON.stringify(orgs) !== JSON.stringify([[ORG_A]])) {
    failures.push(
      `ATTRIBUTION GUARD: the two subjects are not co-members of exactly one organisation ` +
      `(${JSON.stringify(orgs)}) — a green isolation result would be equally explainable by ` +
      `the organisation boundary instead of by user_id`,
    )
  }

  for (const [self, other] of [[USER_A, USER_A2], [USER_A2, USER_A]]) {
    const seen = visibleIds(c, self, USER_SCOPED)
    if (seen.sqlstate !== null) { failures.push(`${USER_SCOPED} as ${self}: ${seen.sqlstate}`); continue }
    if (!seen.rows.includes(sentinelFor(self, USER_SCOPED))) {
      failures.push(`${USER_SCOPED}: ${self} cannot see its OWN acceptance (${seen.rows.length} rows)`)
    }
    if (seen.rows.includes(sentinelFor(other, USER_SCOPED))) {
      failures.push(`${USER_SCOPED}: the acceptance of ${other} LEAKED to ${self}`)
    }
  }
  return failures
}

/** PG-17B-P-1 — a governed global row ACTUALLY EXISTS on each covered surface. */
export function globalExistenceFailures(c: AclCluster): string[] {
  const failures: string[] = []
  for (const relation of PLATFORM_GLOBAL) {
    const n = Number(c.scalar(`SELECT count(*) FROM public.${relation}`) ?? '0')
    if (n === 0) failures.push(`${relation}: EMPTY — every downstream visibility claim would be vacuous`)
  }
  const approved = c.scalar(
    `SELECT count(*) FROM public.financial_proxy_versions
     WHERE organization_id IS NULL AND review_status = 'approved'`,
  )
  if (approved !== '1') {
    failures.push(`financial_proxy_versions: approved-global rows = ${approved}, want exactly 1`)
  }
  return failures
}

/**
 * PG-17B-P-2 / PG-17B-P-3 — two identities in DIFFERENT organisations see the
 * SAME governed set, and the approved global proxy version is visible to both.
 *
 * Cross-identity IDENTITY of the result set is the correct property here;
 * demanding cross-identity DIFFERENCE was the parent's defect.
 */
export function globalSetEqualityFailures(c: AclCluster): string[] {
  const failures: string[] = []
  for (const relation of PLATFORM_GLOBAL) {
    const key = relation === 'legal_instruments' ? 'instrument_key' : 'id'
    const a = c.identityQuery({ sub: USER_A }, `SELECT ${key}::text FROM public.${relation} ORDER BY 1`)
    const b = c.identityQuery({ sub: USER_B }, `SELECT ${key}::text FROM public.${relation} ORDER BY 1`)
    if (a.sqlstate !== null || b.sqlstate !== null) {
      failures.push(`${relation}: sqlstate a=${a.sqlstate} b=${b.sqlstate}`); continue
    }
    if (a.rows.length === 0) {
      failures.push(`${relation}: identity A saw NOTHING — set equality would be vacuous`); continue
    }
    if (JSON.stringify(a.rows) !== JSON.stringify(b.rows)) {
      failures.push(`${relation}: the two identities see DIFFERENT sets (${a.rows.length} vs ${b.rows.length})`)
    }
  }
  const q = `SELECT id::text FROM public.financial_proxy_versions WHERE id = '${GLOBAL_PROXY_VERSION}'`
  for (const [who, subject] of [['A', USER_A], ['B', USER_B]]) {
    const rows = c.identityQuery({ sub: subject }, q).rows
    if (JSON.stringify(rows) !== JSON.stringify([[GLOBAL_PROXY_VERSION]])) {
      failures.push(`financial_proxy_versions approved-global row not visible to identity ${who}`)
    }
  }
  return failures
}

/** PG-17B-N-1 — an identity-free context returns ZERO ROWS and NO SQLSTATE. */
export function identityFreeFailures(c: AclCluster): string[] {
  const failures: string[] = []
  for (const relation of [...PLATFORM_GLOBAL, 'financial_proxy_versions']) {
    const r = c.identityQuery(null, `SELECT count(*)::text FROM public.${relation}`)
    if (r.sqlstate !== null) {
      failures.push(
        `${relation}: ERRORED (${r.sqlstate}) instead of refusing — a different failure with a different cause`,
      )
      continue
    }
    if (r.rows[0]?.[0] !== '0') failures.push(`${relation}: returned ${r.rows[0]?.[0]} rows without an identity`)
  }
  return failures
}

/** PG-17B-N-2 — the CATALOG holds no INSERT/UPDATE/DELETE, per verb per relation. */
export function globalWriteCatalogFailures(c: AclCluster): string[] {
  return c.query(
    `SELECT c.relname || '.' || p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) p(priv)
     WHERE n.nspname='public' AND c.relname IN (${PLATFORM_GLOBAL.map((r) => `'${r}'`).join(',')})
       AND has_table_privilege('uellix_app', c.oid, p.priv)`,
  ).map((row) => `${row[0]}: the catalog says the privilege is HELD`)
}

/** The live write attempted by PG-17B-N-3, one statement per relation and verb. */
export const GLOBAL_WRITE_PROBES: Record<string, Record<string, string>> = {
  governed_model_registry: {
    INSERT: `INSERT INTO public.governed_model_registry (model_id, version, definition_hash) VALUES ('pg17b','9','${'d'.repeat(64)}')`,
    UPDATE: `UPDATE public.governed_model_registry SET version = '9'`,
    DELETE: `DELETE FROM public.governed_model_registry`,
  },
  proxy_material_fields_registry: {
    INSERT: `INSERT INTO public.proxy_material_fields_registry (registry_version, table_name, field_name, category) VALUES ('9','t','f','c')`,
    UPDATE: `UPDATE public.proxy_material_fields_registry SET category = 'x'`,
    DELETE: `DELETE FROM public.proxy_material_fields_registry`,
  },
  legal_instruments: {
    INSERT: `INSERT INTO public.legal_instruments (instrument_key, instrument_class) VALUES ('pg17b','ACCOUNT')`,
    UPDATE: `UPDATE public.legal_instruments SET instrument_class = 'ACCOUNT'`,
    DELETE: `DELETE FROM public.legal_instruments`,
  },
  legal_instrument_versions: {
    INSERT: `INSERT INTO public.legal_instrument_versions (instrument_key, version, locale, content_digest, reaccept_required, published_by) VALUES ('pg17b',9,'en','sha256:${'e'.repeat(64)}',false,'${USER_A}')`,
    UPDATE: `UPDATE public.legal_instrument_versions SET locale = 'xx'`,
    DELETE: `DELETE FROM public.legal_instrument_versions`,
  },
}

/**
 * PG-17B-N-3 — a LIVE mutation of each of the four is refused, and the refusal
 * is ATTRIBUTED to the privilege layer by pairing it with the catalog
 * predicate for the same relation and verb. 42501 alone does not attribute: an
 * RLS WITH CHECK violation raises it too, and runs BEFORE NOT NULL and FK.
 */
export function globalWriteLiveFailures(c: AclCluster): string[] {
  const failures: string[] = []
  for (const relation of PLATFORM_GLOBAL) {
    for (const verb of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const live = c.identityQuery({ sub: USER_A }, GLOBAL_WRITE_PROBES[relation][verb]).sqlstate
      const catalogSaysAbsent = !c.bool(
        `SELECT has_table_privilege('uellix_app','public.${relation}','${verb}')`,
      )
      if (live === null) failures.push(`${relation}.${verb}: the live mutation SUCCEEDED`)
      if (!catalogSaysAbsent) failures.push(`${relation}.${verb}: the catalog says the privilege is HELD`)
      if (live !== null && live !== '42501') {
        failures.push(`${relation}.${verb}: refused with ${live}, not a privilege error`)
      }
    }
  }
  return failures
}

/**
 * The PG-17A fixture constraint the amendment made BINDING: both tenant
 * financial_proxy_versions rows are org-bound, and the global one is not.
 *
 * Asserted as a PREDICATE, never as a returned value: psql -tA prints a NULL
 * as an empty line which the harness drops, so "the row exists with a NULL
 * organization_id" and "the row is absent" both arrive as zero rows. Pushing
 * IS NULL / IS NOT NULL into the WHERE clause makes the count carry the
 * distinction.
 */
export function proxyTenancyFixtureFailures(c: AclCluster): string[] {
  const failures: string[] = []
  for (const org of [ORG_A, ORG_B]) {
    const n = c.scalar(
      `SELECT count(*) FROM public.financial_proxy_versions
       WHERE id = '${sentinelFor(org, 'financial_proxy_versions')}'
         AND organization_id IS NOT NULL`,
    )
    if (n !== '1') failures.push(`the ${org} tenant fixture is not org-bound (count=${n})`)
  }
  const g = c.scalar(
    `SELECT count(*) FROM public.financial_proxy_versions
     WHERE id = '${GLOBAL_PROXY_VERSION}' AND organization_id IS NULL`,
  )
  if (g !== '1') failures.push(`the approved-global row is missing, or is not global (count=${g})`)
  return failures
}
