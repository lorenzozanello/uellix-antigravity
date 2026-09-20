/**
 * PG-06 and PG-17 — the two families that have to be proven by DOING, not by
 * asking the catalog.
 *
 * PG-06 (parent SECTION_14, unchanged) — as uellix_app inside a
 * policy-satisfying identity context: INSERT succeeds on each of the 8
 * APPEND_ONLY and 6 OPERATIONAL_INSERT_UPDATE relations, UPDATE succeeds on
 * each of the 6, and SELECT succeeds on all 18. Privilege PRESENCE is PG-04's
 * claim and is not this family's evidence: a grant the policy layer then
 * refuses is not an allowed operation.
 *
 * PG-17 (superseded by CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_AMENDMENT
 * _v1.0.1, SECTION_A3) — PG-17 = PG-17A AND PG-17B. A naked PG-17 PASS is
 * INVALID unless both arms carry substantive per-relation evidence.
 *
 *   PG-17A  TWO_SIDED_SUBJECT_ISOLATION over 14 surfaces: 13 organisation-
 *           scoped relations plus account_legal_acceptances on the USER axis.
 *   PG-17B  GOVERNED_GLOBAL_VISIBILITY over 5 surfaces: the four platform-
 *           global registries plus the approved global row class of
 *           financial_proxy_versions.
 *
 * WHY THE AMENDMENT EXISTS, in one sentence: the parent asked for an
 * ORG_A/ORG_B sentinel on each of the 18, and four of the 18 have no
 * organization_id at all — their policy is literally auth.uid() IS NOT NULL.
 * Partitioning those by tenant is impossible, not inconvenient, and inventing
 * it would have been a false security claim.
 *
 * Gated on UELLIX_PG_TESTS=1; SKIPPED, never silently passed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AclCluster, PG_TESTS_ENABLED, dockerAvailable } from './current-schema-runtime-acl-harness'
import {
  APPEND_ONLY, IDS, INSERT_CENSUS, OPERATIONAL_IU, ORG_A, ORG_B, ORG_SCOPED,
  PLATFORM_GLOBAL, SELECT_CENSUS, UPDATE_CENSUS, USER_A, USER_B, USER_SCOPED,
  INSTRUMENT_KEY_ORG, INSTRUMENT_VERSION_ACCOUNT_2, INSTRUMENT_VERSION_ORG_2, VERSION_DIGEST,
  seedSubjects, seedTenantSentinels, sentinelFor,
  // THE ARM PREDICATES ARE IMPORTED, NOT RESTATED. Each control below asserts
  // that its predicate holds; the M-PG17-01..06 battery asserts that the SAME
  // function reports a failure once the guarantee it rests on is removed. A
  // locally restated copy would let the battery stay green against a control
  // that has since changed.
  globalExistenceFailures, globalSetEqualityFailures, globalWriteCatalogFailures,
  globalWriteLiveFailures, identityFreeFailures, orgArmFailures,
  proxyTenancyFixtureFailures, userArmFailures,
} from './current-schema-runtime-acl-tenancy-fixture'

const enabled = PG_TESTS_ENABLED
let cluster: AclCluster | null = null
let skipReason = ''

/** Docker-exec probe loops are ~250ms each; these describes run 18-56 of them. */
const PROBE_TIMEOUT = 120_000

beforeAll(async () => {
  if (!enabled) { skipReason = 'UELLIX_PG_TESTS is not 1'; return }
  if (!dockerAvailable()) { skipReason = 'Docker is unreachable'; return }
  cluster = await AclCluster.create()
  if (cluster === null) { skipReason = 'the disposable cluster could not be provisioned'; return }

  const applied = cluster.applyPackage()
  if (applied.status !== 0) {
    throw new Error(`stella_0021 failed to apply to the PG-06/PG-17 substrate:\n${applied.stderr}`)
  }
  seedSubjects(cluster)
  seedTenantSentinels(cluster)
}, 900_000)

afterAll(() => {
  if (cluster !== null) {
    const leftover = cluster.destroy()
    expect(leftover, 'the disposable container survived teardown').toBe(0)
    cluster = null
  }
}, 120_000)

function db(): AclCluster {
  if (cluster === null) throw new Error(`no cluster: ${skipReason}`)
  return cluster
}

const maybe = enabled ? describe : describe.skip

/* -------------------------------------------------------------------------- */

maybe('the substrate, and the precondition the amendment left OPEN', () => {
  it('provisions, or says why it did not — never silently green', () => {
    expect(cluster, `PG-06/PG-17 could not run: ${skipReason}`).not.toBeNull()
  })

  it('PRE-PG17B-AUTHUID: an identity-free SELECT on each global registry returns ZERO ROWS and NO SQLSTATE', () => {
    // The amendment (SECTION_A6) froze this as an OPEN, UNDISCHARGED,
    // BINDING precondition and forbade reporting any PG-17B result before it
    // was run on the implementing base. It is discharged HERE, on this
    // substrate, and its outcome is recorded rather than assumed.
    //
    // WHAT IT DISTINGUISHES: "0 rows" is the policy correctly refusing. A
    // "permission denied for schema auth" is the invoking role being unable to
    // EVALUATE the policy at all. Both look like "nothing came back" to a test
    // that only counts rows, and they mean opposite things about whether the
    // governed ACL contract is correct.
    for (const relation of PLATFORM_GLOBAL) {
      const r = db().identityQuery(null, `SELECT count(*)::text FROM public.${relation}`)
      expect(r.sqlstate, `${relation} raised instead of refusing`).toBeNull()
      expect(r.rows[0]?.[0], `${relation} returned rows without an identity`).toBe('0')
    }
  }, PROBE_TIMEOUT)

  it('the measured reason it holds: EXECUTE on auth.uid() is PUBLIC, schema USAGE is not granted', () => {
    // Recorded because it is the whole explanation, and because a future reader
    // will otherwise assume the runtime was given schema auth.
    expect(db().bool(`SELECT has_schema_privilege('uellix_app','auth','USAGE')`)).toBe(false)
    expect(db().bool(`SELECT has_function_privilege('uellix_app','auth.uid()','EXECUTE')`)).toBe(true)
    // A DIRECT call by name still needs the schema and still fails — which is
    // why a STORED policy expression works while `SELECT auth.uid()` does not:
    // the policy's function OID is already bound, so no name resolution runs.
    expect(db().sqlstate('SELECT auth.uid()', 'uellix_app')).toBe('42501')
    // NO AD-HOC GRANT WAS ISSUED to make any of this true.
    expect(db().bool(`SELECT has_schema_privilege('uellix_writer','auth','USAGE')`)).toBe(false)
  })

  it('the identity helper cannot be satisfied by the set_config echo row', () => {
    // MEASURED HAZARD, named by the amendment: `SELECT set_config(...)` returns
    // its own value as a row, so a helper that concatenates the statement list
    // hands back a row no matter what the relation returned. If that leaked,
    // "ORG_B's sentinel is absent" would pass against an EMPTY result and
    // "own row present" could be satisfied by the claims string itself.
    const r = db().identityQuery({ sub: USER_A }, `SELECT 'only-this-row'`)
    expect(r.rows.map((x) => x[0])).toEqual(['only-this-row'])
    // The claims JSON contains the uuid; if the echo leaked it would be here.
    expect(r.rows.flat().join('|')).not.toContain(USER_A)
  })
})

/* -------------------------------------------------------------------------- */

maybe('PG-06 — allowed operations SUCCEED as uellix_app', () => {
  it('the three censuses are EXACTLY 14 / 6 / 18, derived from the frozen classes', () => {
    expect(APPEND_ONLY).toHaveLength(8)
    expect(OPERATIONAL_IU).toHaveLength(6)
    expect(PLATFORM_GLOBAL).toHaveLength(4)
    expect(INSERT_CENSUS).toHaveLength(14)
    expect(UPDATE_CENSUS).toHaveLength(6)
    expect(SELECT_CENSUS).toHaveLength(18)
    // Derived, never discovered: the INSERT census is the two writable classes
    // and nothing else, and the SELECT census is the 19 minus the single
    // NO_RUNTIME_ACCESS member.
    expect([...INSERT_CENSUS].sort()).toEqual([...APPEND_ONLY, ...OPERATIONAL_IU].sort())
    expect(SELECT_CENSUS).not.toContain('commercial_accounts')
    expect(SELECT_CENSUS).not.toContain('entitlement_grants')
  })

  it('SELECT succeeds on all 18, and returns the subject\'s OWN row where one exists', () => {
    // Success alone is not the evidence the parent asks for: "with a
    // policy-satisfying fixture row". A SELECT that succeeds and returns
    // nothing would be indistinguishable from a policy refusing everything.
    for (const relation of SELECT_CENSUS) {
      const r = db().identityQuery({ sub: USER_A }, `SELECT count(*)::text FROM public.${relation}`)
      expect(r.sqlstate, `SELECT on ${relation} errored`).toBeNull()
      expect(Number(r.rows[0]?.[0] ?? '0'), `${relation} returned no rows to ORG_A's member`).toBeGreaterThan(0)
    }
  }, PROBE_TIMEOUT)

  it('INSERT succeeds on each of the 14, and the row is THERE afterwards', () => {
    const before = new Map(INSERT_CENSUS.map((t) => [t, Number(db().scalar(`SELECT count(*) FROM public.${t}`) ?? '0')]))
    const failures: string[] = []

    for (const relation of INSERT_CENSUS) {
      const r = db().identityQuery({ sub: USER_A }, pg06Insert(relation))
      if (r.sqlstate !== null) { failures.push(`${relation}: ${r.sqlstate} ${r.message}`); continue }
      const after = Number(db().scalar(`SELECT count(*) FROM public.${relation}`) ?? '0')
      if (after !== (before.get(relation) ?? 0) + 1) {
        failures.push(`${relation}: exit 0 but the row did not land (${before.get(relation)} -> ${after})`)
      }
    }
    expect(failures, 'an allowed INSERT was refused, or silently wrote nothing').toEqual([])
  }, PROBE_TIMEOUT)

  it('UPDATE succeeds on each of the 6, and the value actually CHANGED', () => {
    const failures: string[] = []
    for (const relation of UPDATE_CENSUS) {
      const col = PG06_UPDATE_COLUMN[relation]
      const marker = `PG06-UPDATED-${relation}`
      const r = db().identityQuery(
        { sub: USER_A },
        `UPDATE public.${relation} SET ${col} = '${marker}' WHERE organization_id = '${ORG_A}'`,
      )
      if (r.sqlstate !== null) { failures.push(`${relation}: ${r.sqlstate}`); continue }
      const seen = Number(db().scalar(
        `SELECT count(*) FROM public.${relation} WHERE ${col}::text = '${marker}'`,
      ) ?? '0')
      if (seen === 0) failures.push(`${relation}: exit 0 but no row carries the new value`)
    }
    expect(failures, 'an allowed UPDATE was refused, or changed nothing').toEqual([])
  }, PROBE_TIMEOUT)

  it('PG-06 is not a catalog reading: the same verbs are REFUSED where the class forbids them', () => {
    // The discriminator. If these passed too, every assertion above would be
    // explained by "the runtime can do anything" rather than by the contract.
    expect(db().identityQuery({ sub: USER_A }, `DELETE FROM public.evidence_versions`).sqlstate).toBe('42501')
    expect(db().identityQuery({ sub: USER_A }, `UPDATE public.readiness_assessments SET band = 'x'`).sqlstate).toBe('42501')
    expect(db().identityQuery({ sub: USER_A }, `INSERT INTO public.governed_model_registry (model_id, version, definition_hash) VALUES ('x','1','${'c'.repeat(64)}')`).sqlstate).toBe('42501')
  })
})

/* -------------------------------------------------------------------------- */

maybe('PG-17A — two-sided subject isolation over 14 surfaces', () => {
  it('the arm covers EXACTLY 13 organisation-scoped relations plus the one user-scoped relation', () => {
    expect(ORG_SCOPED).toHaveLength(13)
    expect(USER_SCOPED).toBe('account_legal_acceptances')
    expect([...ORG_SCOPED, USER_SCOPED]).toHaveLength(14)
    // And the four platform-global relations are NOT in this arm — applying a
    // tenant predicate to them is exactly what the amendment forbids.
    for (const g of PLATFORM_GLOBAL) expect(ORG_SCOPED).not.toContain(g)
  })

  it('ORG_A sees its OWN row and never ORG_B\'s, on each of the 13', () => {
    // OWN_ROW_PRESENT and SIBLING_ROW_ABSENT, both by row IDENTITY rather than
    // by count, live inside orgArmFailures — which is also what M-PG17-01
    // turns red.
    expect(orgArmFailures(db(), USER_A, ORG_A, ORG_B)).toEqual([])
  }, PROBE_TIMEOUT)

  it('ORG_B sees its OWN row and never ORG_A\'s — the symmetric direction', () => {
    expect(orgArmFailures(db(), USER_B, ORG_B, ORG_A)).toEqual([])
  }, PROBE_TIMEOUT)

  it('financial_proxy_versions tenant fixtures carry organization_id IS NOT NULL', () => {
    // BINDING (amendment FINANCIAL_PROXY_VERSIONS_FIXTURE_CONSTRAINT). A tenant
    // fixture left NULL would fall into the approved-global class, be visible
    // to both organisations BY DESIGN, and turn this relation's isolation
    // assertion RED against a correct implementation. The predicate also
    // asserts that the two arms are satisfied by DIFFERENT rows.
    expect(proxyTenancyFixtureFailures(db())).toEqual([])
  })

  it('the USER arm: USER_A and USER_A2 are in the SAME organisation, and still cannot see each other', () => {
    // MANDATORY_ATTRIBUTION_GUARD. account_legal_acceptances has no
    // organization_id, so its only isolation is user_id = auth.uid(). Two users
    // in DIFFERENT organisations would make a green result equally explainable
    // by an organisation boundary; co-membership removes that explanation and
    // forces the user predicate to carry the result alone. The guard is INSIDE
    // the predicate, which is what gives M-PG17-02 something to turn red.
    expect(userArmFailures(db())).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

maybe('PG-17B — governed global visibility over 5 surfaces', () => {
  it('B1 a governed global row ACTUALLY EXISTS on each covered surface', () => {
    // An empty registry makes every downstream visibility claim vacuous: "A and
    // B see the same rows" is trivially true of nothing. Existence is an
    // ASSERTED precondition, not a setup assumption — and it is what M-PG17-03
    // and M-PG17-06 turn red.
    expect(globalExistenceFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)

  it('B2/B3 identity A and identity B — in DIFFERENT organisations — see the SAME governed set', () => {
    // Cross-identity IDENTITY of the result set is the correct property here,
    // and cross-identity DIFFERENCE was the parent's defect. The predicate
    // refuses a vacuous pass: an empty set for identity A is a failure, not a
    // trivially satisfied equality.
    expect(globalSetEqualityFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)

  it('B4 an identity-free context returns ZERO ROWS and NO SQLSTATE', () => {
    // ZERO ROWS is the policy refusing; a SQLSTATE is the role being unable to
    // evaluate the policy at all. The predicate keeps the two apart, which is
    // the whole point of PRE-PG17B-AUTHUID above. M-PG17-05 leaks an identity
    // into this arm and this is what must notice.
    expect(identityFreeFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)

  it('B5 the runtime holds NO INSERT/UPDATE/DELETE on any of the four, per verb per relation', () => {
    expect(globalWriteCatalogFailures(db())).toEqual([])
  })

  it('B6 a LIVE mutation of each of the four is refused — and attributed to the privilege layer', () => {
    // B5 and B6 are both required and neither substitutes for the other: a
    // catalog predicate can be FALSE while a live path still succeeds through
    // some other grant, and a live refusal can arise from a cause other than
    // privilege. 42501 alone does not attribute — an RLS WITH CHECK violation
    // raises it too, BEFORE NOT NULL and FK constraints — so each live refusal
    // is PAIRED with the catalog predicate for the same relation and verb.
    // M-PG17-04 must turn BOTH this and B5 red, which is what proves the two
    // layers are independently load-bearing.
    expect(globalWriteLiveFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('PG-17 — the CONJUNCTION is what the family means', () => {
  it('PG-17 = PG-17A AND PG-17B, and neither arm alone is the family', () => {
    // SECTION_A3 CONJUNCTION_IS_BINDING. Recorded as an assertion so a reader
    // of the run output sees the shape of the claim, and so a future edit that
    // deleted one arm cannot leave a green "PG-17" behind.
    const armA = [...ORG_SCOPED, USER_SCOPED]
    const armB = [...PLATFORM_GLOBAL, 'financial_proxy_versions:approved_global']
    expect(armA).toHaveLength(14)
    expect(armB).toHaveLength(5)
    // financial_proxy_versions is the ONE relation in both arms, by different
    // row classes — the two arms must never be satisfied by the same row.
    expect(armA).toContain('financial_proxy_versions')
    expect(armB.some((s) => s.startsWith('financial_proxy_versions'))).toBe(true)
    // The parent's family count is unchanged: PG-17A/B are SUB-ARMS.
    expect(armA.length + armB.length).toBe(19)
  })
})

/** The PG-06 INSERT for one relation, policy-satisfying and schema-valid. */
function pg06Insert(relation: string): string {
  const f = IDS[ORG_A]
  const tag = `PG06-INSERT-${relation}`
  const rows: Record<string, string> = {
    account_legal_acceptances:
      `INSERT INTO public.account_legal_acceptances (user_id, instrument_version_id, content_digest) VALUES ('${USER_A}','${INSTRUMENT_VERSION_ACCOUNT_2}','${VERSION_DIGEST}')`,
    // A DIFFERENT (type, id) PAIR FROM THE PG-17 SENTINEL ROW, deliberately.
    // uq_assumption_object_links_assumption_object is UNIQUE on (assumption_id,
    // affected_object_type, affected_object_id), and the PG-17A sentinel for
    // ORG_A already links THIS assumption to ('outcome', outcome). Reusing the
    // triple made PG-06 refuse with 23505 — a uniqueness refusal that says
    // nothing about whether the runtime role may INSERT here. MEASURED: the
    // relation has FKs on assumption_id, created_by and organization_id but
    // NONE on affected_object_id (it is polymorphic, discriminated by
    // affected_object_type), and the CHECK vocabulary admits
    // 'sroi_calculation_run', so this pair is schema-legal and collision-free.
    assumption_object_links:
      `INSERT INTO public.assumption_object_links (organization_id, assumption_id, affected_object_type, affected_object_id, created_by) VALUES ('${ORG_A}','${sentinelFor(ORG_A, 'methodological_assumptions')}','sroi_calculation_run','${f.run}','${USER_A}')`,
    domain_object_versions:
      `INSERT INTO public.domain_object_versions (organization_id, object_type, object_id, ordinal, payload_json, content_hash, created_by) VALUES ('${ORG_A}','${tag}','${f.outcome}',2,'{}'::jsonb,'${'2'.repeat(64)}','${USER_A}')`,
    evidence_sufficiency_determinations:
      `INSERT INTO public.evidence_sufficiency_determinations (organization_id, project_id, outcome_id, calculation_run_id, ordinal, determination, rationale, actor_user_id) VALUES ('${ORG_A}','${f.project}','${f.outcome}','${f.run2}',2,'sufficient','${tag}','${USER_A}')`,
    evidence_tombstones:
      `INSERT INTO public.evidence_tombstones (organization_id, evidence_id, evidence_version_id, erasure_state, erasure_reason, rationale, actor_user_id) VALUES ('${ORG_A}','${f.evidence}','${sentinelFor(ORG_A, 'evidence_versions')}','erasure_blocked','retention_policy','${tag}','${USER_A}')`,
    organization_commercial_acceptances:
      `INSERT INTO public.organization_commercial_acceptances (organization_id, instrument_key, instrument_version_id, content_digest, accepted_by_user_id, accepted_by_role) VALUES ('${ORG_A}','${INSTRUMENT_KEY_ORG}','${INSTRUMENT_VERSION_ORG_2}','${VERSION_DIGEST}','${USER_A}','organization_admin')`,
    readiness_assessments:
      `INSERT INTO public.readiness_assessments (organization_id, project_id, calculation_run_id, readiness_model_version, global_score, band, dimension_scores, criteria_detail, created_by) VALUES ('${ORG_A}','${f.project}','${f.run2}','2.0.0',60.00,'advanced_preparation','{}'::jsonb,'{}'::jsonb,'${USER_A}')`,
    sensitivity_scenarios:
      `INSERT INTO public.sensitivity_scenarios (organization_id, project_id, calculation_run_id, scenario_kind, candidate_ids, modified_inputs, reason, sensitivity_model_version, calculation_engine_version, result_json, base_result_json, selected_by, created_by) VALUES ('${ORG_A}','${f.project}','${f.run2}','one_at_a_time','[]'::jsonb,'[]'::jsonb,'${tag}','1.0.0','1.0.0','{}'::jsonb,'{}'::jsonb,'${USER_A}','${USER_A}')`,
    counterfactual_assessments:
      `INSERT INTO public.counterfactual_assessments (organization_id, outcome_id, calculation_run_id, baseline_availability, basis_kind, deadweight_support_state, rationale, created_by) VALUES ('${ORG_A}','${f.outcome}','${f.run2}','not_applicable','documented_assumption','unknown_or_insufficient','${tag}','${USER_A}')`,
    evidence_versions:
      `INSERT INTO public.evidence_versions (organization_id, evidence_id, ordinal, content, review_status, created_by) VALUES ('${ORG_A}','${f.evidence}',2,'${tag}','draft','${USER_A}')`,
    financial_proxy_versions:
      `INSERT INTO public.financial_proxy_versions (organization_id, financial_proxy_id, ordinal, source_id, review_status, relevance_justification, created_by) VALUES ('${ORG_A}','${f.proxy}',2,'${f.source}','draft','${tag}','${USER_A}')`,
    methodological_assumptions:
      `INSERT INTO public.methodological_assumptions (organization_id, project_id, formulation, rationale, basis_type, materiality_flag, created_by) VALUES ('${ORG_A}','${f.project}','${tag}','r','derived','non_material','${USER_A}')`,
    outcome_monetization_dispositions:
      `INSERT INTO public.outcome_monetization_dispositions (organization_id, outcome_id, calculation_run_id, disposition, created_by) VALUES ('${ORG_A}','${f.outcome}','${f.run2}','monetized','${USER_A}')`,
    sensitivity_candidates:
      `INSERT INTO public.sensitivity_candidates (organization_id, project_id, calculation_run_id, candidate_key, candidate_kind, input_reference, sensitivity_model_version, created_by) VALUES ('${ORG_A}','${f.project}','${f.run2}','${tag}','other_quantitative_input','{}'::jsonb,'1.0.0','${USER_A}')`,
  }
  const sql = rows[relation]
  if (sql === undefined) throw new Error(`no PG-06 INSERT defined for ${relation}`)
  return sql
}

/**
 * A harmless, schema-valid, unconstrained column to move under PG-06's UPDATE.
 *
 * Chosen per relation rather than reused from the sentinel scheme: the sentinel
 * is now the PRIMARY KEY, and updating a primary key would be a different
 * assertion (and, on an append-only lineage, a meaningless one). Each column
 * below is free text with no CHECK, so a successful UPDATE proves the verb
 * reached the relation rather than that a vocabulary happened to admit a value.
 */
const PG06_UPDATE_COLUMN: Readonly<Record<string, string>> = {
  counterfactual_assessments: 'rationale',
  evidence_versions: 'content',
  financial_proxy_versions: 'relevance_justification',
  methodological_assumptions: 'formulation',
  outcome_monetization_dispositions: 'justification',
  sensitivity_candidates: 'rationale',
}
