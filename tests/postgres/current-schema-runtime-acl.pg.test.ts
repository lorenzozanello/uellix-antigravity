/**
 * REAL PostgreSQL proof of the stella_0021 runtime ACL contract.
 *
 * This is the SECTION_14 matrix of
 * docs/ops/staging/CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_v1.0.0.json,
 * proven against a pinned, disposable PostgreSQL 17 cluster carrying the
 * governed substrate — stella_local_0000, the baseline units, stella_0001 —
 * and nothing this suite invented. Static SQL parsing does not replace it, and
 * the DB-free twin (tests/database-runtime-acl-closed-world.test.ts) proves a
 * different thing: the corpus, not the catalog.
 *
 * GATED on UELLIX_PG_TESTS=1 and SKIPPED, never silently passed, when Docker is
 * unreachable. A green real-PostgreSQL suite that never reached PostgreSQL is
 * the failure mode the gate exists to prevent, so the skip is loud.
 *
 * ONE CLUSTER, MANY CONTROLS, AND THE ORDER IS LOAD-BEARING. Building the
 * substrate costs ~90 seconds (86 baseline units), so the suite provisions once
 * and every control that MUTATES the database restores it and re-applies the
 * real package, with a guard at the end proving the substrate is still clean.
 * Sharing a cluster is what makes the matrix affordable; restoring after each
 * mutation is what keeps the controls independent.
 *
 * ASSERTIONS ARE ON SQLSTATE, NEVER ON MESSAGE TEXT. A message is prose that
 * moves between PostgreSQL releases; a control keyed on prose reports green the
 * day the wording changes. Where a message IS asserted it is only to prove a
 * refusal is ATTRIBUTABLE — that the package named the object it refused over,
 * rather than failing for an unrelated reason.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AclCluster,
  PG_TESTS_ENABLED,
  dockerAvailable,
  mutateUniquely,
  packageSource,
} from './current-schema-runtime-acl-harness'

// ---------------------------------------------------------------------------
// The contract, restated here as DATA, independently of the package source.
//
// These literals are the authority's, not the package's: the suite must be able
// to disagree with the file it tests. Reading the class arrays out of the SQL
// would make every assertion below a tautology — the exact vacuous shape the
// DB-free guard's own mutation controls exist to rule out over there.
// ---------------------------------------------------------------------------

/** Authority SECTION_2 APPEND_ONLY (8) + SECTION_2B APPEND_ONLY_legacy (3). */
const APPEND_ONLY = [
  'account_legal_acceptances', 'assumption_object_links', 'domain_object_versions',
  'evidence_sufficiency_determinations', 'evidence_tombstones',
  'organization_commercial_acceptances', 'readiness_assessments', 'sensitivity_scenarios',
] as const
const APPEND_ONLY_LEGACY = ['audit_logs', 'sroi_calculation_line_items', 'sroi_calculation_runs'] as const
/** Authority SECTION_2 OPERATIONAL_INSERT_UPDATE (6) — the deliberate new class. */
const OPERATIONAL_IU = [
  'counterfactual_assessments', 'evidence_versions', 'financial_proxy_versions',
  'methodological_assumptions', 'outcome_monetization_dispositions', 'sensitivity_candidates',
] as const
/** Authority SECTION_2 READ_ONLY (4). */
const READ_ONLY = [
  'governed_model_registry', 'legal_instrument_versions', 'legal_instruments',
  'proxy_material_fields_registry',
] as const
/** SECTION_2 NO_RUNTIME_ACCESS (1) + SECTION_3 entitlement_grants (1). */
const NO_RUNTIME_ACCESS = ['commercial_accounts', 'entitlement_grants'] as const
/** SECTION_2B GOVERNED_READ_legacy (1) — amended by the INSTALLED stella_0017. */
const GOVERNED_READ = ['stella_interactions'] as const
/** SECTION_2B CONDITIONAL_APPEND_ONLY (1). */
const CONDITIONAL = ['stella_suggestion_decisions'] as const
/** SECTION_2B OPERATIONAL_legacy (33), marketing_leads INCLUDED. */
const OPERATIONAL_LEGACY = [
  'evidence_items', 'financial_proxies', 'funders', 'fx_rates', 'impact_narratives',
  'indicators', 'invitations', 'marketing_leads', 'methodology_review_matrix',
  'methodology_review_matrix_items', 'organization_members', 'organizations',
  'outcome_funder_allocations', 'outcome_proxy_assignments', 'outcome_taxonomy_mappings',
  'outcomes', 'portfolios', 'project_investments', 'projects', 'proxy_sources',
  'signup_allowlist', 'sroi_assignment_inputs', 'sroi_filter_sets', 'sroi_report_sections',
  'sroi_reports', 'sroi_run_review_items', 'sroi_run_reviews', 'stakeholder_groups',
  'taxonomy_catalogs', 'taxonomy_codes', 'theory_of_change_links', 'theory_of_change_nodes',
  'users',
] as const
/** SECTION_3 — granted nothing, posture asserted, excluded from the closed world. */
const CAPABILITY_ONLY = [
  'capability_bootstrap_attempts', 'capability_verification_hits', 'evidence_chunks',
  'evidence_document_versions', 'report_public_disclosures', 'stripe_webhook_events',
] as const

/** SECTION_5 — the three, and the five deliberately excluded. */
const HELPERS = [
  'public.current_user_org_ids()',
  'public.current_user_is_super_admin()',
  'public.current_user_role_in_org(uuid)',
] as const
const EXCLUDED_FUNCTIONS = [
  'public.handle_new_user()', 'public.handle_update_user()',
  'public.can_read_evidence_object(text,uuid)', 'public.can_write_evidence_object(text,uuid)',
  'public.uellix_forbid_mutation()',
] as const

/** table -> the exact S/I/U/D the contract grants uellix_writer. */
const CONTRACT: ReadonlyMap<string, string> = new Map([
  ...APPEND_ONLY.map((t) => [t, 'SI'] as const),
  ...APPEND_ONLY_LEGACY.map((t) => [t, 'SI'] as const),
  ...CONDITIONAL.map((t) => [t, 'SI'] as const),
  ...OPERATIONAL_IU.map((t) => [t, 'SIU'] as const),
  ...READ_ONLY.map((t) => [t, 'S'] as const),
  ...GOVERNED_READ.map((t) => [t, 'S'] as const),
  ...OPERATIONAL_LEGACY.map((t) => [t, 'SIUD'] as const),
  ...NO_RUNTIME_ACCESS.map((t) => [t, ''] as const),
])

/** The tables uellix_auditor may read: everything but NO_RUNTIME_ACCESS. */
const AUDITOR_READABLE = [...CONTRACT.keys()].filter((t) => CONTRACT.get(t) !== '')

const enabled = PG_TESTS_ENABLED
let cluster: AclCluster | null = null
let skipReason = ''

/** The ACL immediately after the first clean apply — every mutation restores to this. */
let canonicalTableAcl = ''
let canonicalFunctionAcl = ''

beforeAll(async () => {
  if (!enabled) {
    skipReason = 'UELLIX_PG_TESTS is not 1'
    return
  }
  if (!dockerAvailable()) {
    skipReason = 'Docker is unreachable'
    return
  }
  cluster = await AclCluster.create()
  if (cluster === null) skipReason = 'the disposable cluster could not be provisioned'
}, 900_000)

afterAll(() => {
  if (cluster !== null) {
    const leftover = cluster.destroy()
    // PG-20. The teardown assertion lives here so it runs even when a control
    // above failed — the container must not survive a red suite.
    expect(leftover, 'the disposable container survived teardown').toBe(0)
    expect(AclCluster.leftovers(), 'a container from an earlier run survives').toEqual([])
    cluster = null
  }
}, 120_000)

/**
 * Per-test ceiling for the controls that probe the closed world ONE RELATION AT
 * A TIME.
 *
 * MEASURED, not precautionary. A `docker exec psql` round trip costs ~250ms on
 * this host, and the controls below deliberately refuse to collapse their loop
 * into a single set-returning query -- naming every one of the 25, 33, 37 or 58
 * members is the whole point of PG-04, PG-08 and PG-21. At 58 probes that is
 * ~15s against vitest's 5s default, so those five controls failed here with
 * "Test timed out in 5000ms" while asserting nothing at all: a RED that carried
 * no information about the contract.
 *
 * A timeout is not an assertion. Raising it changes no predicate, no census and
 * no expected value; it only lets the assertions that were already written
 * actually run to completion. The sibling PG-06/PG-17 suite reached the same
 * conclusion independently and uses the same figure.
 */
const PROBE_TIMEOUT = 120_000

/** Fails loudly rather than passing when the cluster is absent but expected. */
function db(): AclCluster {
  if (cluster === null) throw new Error(`no cluster: ${skipReason}`)
  return cluster
}

/** Restore the canonical posture after a control that mutated the database. */
function reconverge(): void {
  const r = db().applyPackage()
  expect(r.status, `the real package failed to re-converge the substrate:\n${r.stderr}`).toBe(0)
}

const maybe = enabled ? describe : describe.skip

maybe('the substrate itself (PG-01)', () => {
  it('provisions, or says why it did not — never silently green', () => {
    expect(cluster, `real-PostgreSQL suite could not run: ${skipReason}`).not.toBeNull()
  })

  it('PG-01 builds exactly the current schema: 58 public tables and no other relkind', () => {
    const tables = db().scalar(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')`,
    )
    // 57 migration-created + stella_suggestion_decisions. The authority froze
    // 57 against a base that predates db/migrations/0073; entitlement_grants
    // is the difference and SECTION_3 pre-classifies it.
    expect(tables).toBe('58')

    const otherKinds = db().query(
      `SELECT c.relkind, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind NOT IN ('r','p','i','I','c','t')`,
    )
    expect(otherKinds, 'the governed sources create no view, sequence or foreign table in public').toEqual([])
  })

  it('PG-01 establishes the governed role topology, and NOT by an ad-hoc grant', () => {
    for (const role of ['uellix_app', 'uellix_writer', 'uellix_auditor']) {
      expect(db().scalar(`SELECT count(*) FROM pg_roles WHERE rolname='${role}'`), role).toBe('1')
    }
    // The membership, and the property that actually carries the contract.
    expect(db().bool(`SELECT pg_has_role('uellix_app','uellix_writer','USAGE')`)).toBe(true)

    // MEASURED AND RECORDED: uellix_app is NOINHERIT at the ROLE level
    // (stella_0001:81) and inherits ONLY through the membership's own
    // inherit_option (stella_0001:180, PostgreSQL 16+). A precondition written
    // against pg_roles.rolinherit would refuse this correct topology.
    expect(db().bool(`SELECT rolinherit FROM pg_roles WHERE rolname='uellix_app'`)).toBe(false)
    expect(db().bool(
      `SELECT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member='uellix_app'::regrole AND m.roleid='uellix_writer'::regrole AND m.inherit_option)`,
    )).toBe(true)
  })

  it('PG-01 finds the three RLS helpers, all SECURITY DEFINER', () => {
    for (const sig of HELPERS) {
      expect(db().scalar(`SELECT to_regprocedure('${sig}') IS NOT NULL`), sig).toBe('t')
      expect(db().scalar(`SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('${sig}')`), sig).toBe('t')
    }
  })

  it('PG-01 the runtime is DENIED before the package runs — the defect, measured', () => {
    // The whole reason stella_0021 exists. Without it the runtime cannot read
    // the nineteen tables migrations added after stella_0004 was written, and
    // it cannot evaluate a policy predicate either. Asserting the BROKEN state
    // first is what makes every positive control below non-vacuous.
    expect(db().privileges('uellix_app', 'readiness_assessments')).toBe('')
    expect(db().privileges('uellix_app', 'evidence_versions')).toBe('')
    for (const sig of HELPERS) {
      expect(db().bool(`SELECT has_function_privilege('uellix_writer','${sig}','EXECUTE')`), sig).toBe(false)
    }
  })
})

maybe('applying the package (PG-02, PG-03)', () => {
  it('PG-02 first apply exits 0 with every precondition and postcondition satisfied', () => {
    const r = db().applyPackage()
    expect(r.status, r.stderr).toBe(0)
    // The package's own end-state assertion is what a green exit means here.
    expect(r.stderr).toMatch(/CANONICAL_RUNTIME_ACL/)
    expect(r.stderr).toMatch(/preconditions satisfied over 58 classified tables/)
    canonicalTableAcl = db().tableAclSnapshot()
    canonicalFunctionAcl = db().functionAclSnapshot()
    expect(canonicalTableAcl.length).toBeGreaterThan(0)
  })

  it('PG-03 a second apply is convergent — both ACL snapshots byte-identical', () => {
    const r = db().applyPackage()
    expect(r.status, r.stderr).toBe(0)
    expect(db().tableAclSnapshot()).toBe(canonicalTableAcl)
    expect(db().functionAclSnapshot()).toBe(canonicalFunctionAcl)
  })
})

maybe('the contract holds, per table and per role (PG-04, PG-06, PG-14, PG-15)', () => {
  it('PG-04 uellix_writer holds EXACTLY its class on all 58', () => {
    expect(CONTRACT.size, 'the contract under test must be the whole closed world').toBe(58)
    const wrong = [...CONTRACT].filter(([t, want]) => db().privileges('uellix_writer', t) !== want)
      .map(([t, want]) => `${t}: got "${db().privileges('uellix_writer', t)}" want "${want}"`)
    expect(wrong).toEqual([])
  }, PROBE_TIMEOUT)

  it('PG-04 uellix_app holds EXACTLY the same, by inheritance and no direct grant', () => {
    const wrong = [...CONTRACT].filter(([t, want]) => db().privileges('uellix_app', t) !== want)
      .map(([t, want]) => `${t}: got "${db().privileges('uellix_app', t)}" want "${want}"`)
    expect(wrong).toEqual([])
  }, PROBE_TIMEOUT)

  it('PG-15 uellix_app holds NO direct table grant anywhere in public', () => {
    const direct = db().query(
      `SELECT c.relname, a.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.grantee='uellix_app'::regrole`,
    )
    // The grounding pair's DIRECT app SELECT is that capability's contract and
    // is the one declared exception; it is absent from this substrate because
    // grounding_0002/0003 are not applied here, so the set is empty outright.
    expect(direct).toEqual([])
  })

  it('PG-14 uellix_auditor reads exactly the 56 it may, and writes nothing anywhere', () => {
    const readable = db().scalar(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege('uellix_auditor', c.oid, 'SELECT')`,
    )
    expect(readable).toBe(String(AUDITOR_READABLE.length))

    const writes = db().query(
      `SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) p(priv)
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege('uellix_auditor', c.oid, p.priv)`,
    )
    expect(writes).toEqual([])

    for (const t of NO_RUNTIME_ACCESS) {
      expect(db().bool(`SELECT has_table_privilege('uellix_auditor','public.${t}','SELECT')`), t).toBe(false)
    }
  })

  it('PG-06 the operations the runtime actually issues now SUCCEED', () => {
    // Before the package these raised 42501 on the HELPER, not on the table —
    // the policy predicate could not be evaluated at all. A clean SELECT is the
    // positive half that proves the refusals below are not vacuous.
    for (const t of [...APPEND_ONLY, ...OPERATIONAL_IU, ...READ_ONLY, 'users', 'marketing_leads']) {
      expect(db().sqlstate(`SELECT count(*) FROM public.${t}`, 'uellix_app'), t).toBeNull()
    }
  }, PROBE_TIMEOUT)

  it('PG-13 no runtime role holds a STRUCTURAL privilege, anywhere in public', () => {
    const structural = db().query(
      `SELECT c.relname, g.r, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN (VALUES ('uellix_writer'),('uellix_auditor'),('uellix_app')) g(r)
       CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(priv)
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege(g.r, c.oid, p.priv)`,
    )
    expect(structural, 'TRUNCATE is not governed by RLS, which is why it is named rather than merely ungranted').toEqual([])
  })

  it('PG-18 no runtime role holds SUPERUSER or BYPASSRLS after apply', () => {
    expect(db().query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('uellix_app','uellix_writer','uellix_auditor') AND (rolsuper OR rolbypassrls)`,
    )).toEqual([])
  })
})

maybe('the EXECUTE half (PG-16, N-12)', () => {
  it('PG-16 both roles can execute exactly the three helpers', () => {
    for (const role of ['uellix_writer', 'uellix_auditor']) {
      for (const sig of HELPERS) {
        expect(db().bool(`SELECT has_function_privilege('${role}','${sig}','EXECUTE')`), `${role} ${sig}`).toBe(true)
      }
    }
  })

  it('N-12 PUBLIC holds no EXECUTE on the three — measured on the live catalog', () => {
    // acldefault for a function is EXECUTE TO PUBLIC, so this cannot be
    // asserted as "proacl IS NULL"; it has to be asked of the catalog.
    for (const sig of HELPERS) {
      expect(db().bool(`SELECT has_function_privilege('public','${sig}','EXECUTE')`), sig).toBe(false)
    }
  })

  it('N-12 no runtime role can execute an EXCLUDED function — the two that WRITE above all', () => {
    const leaked = db().query(
      `SELECT g.r, v.sig FROM (VALUES ('uellix_writer'),('uellix_auditor'),('uellix_app')) g(r),
       (VALUES ${EXCLUDED_FUNCTIONS.map((s) => `('${s}')`).join(',')}) v(sig)
       WHERE to_regprocedure(v.sig) IS NOT NULL AND has_function_privilege(g.r, v.sig, 'EXECUTE')`,
    )
    expect(leaked, '"no indirect write path through a function" must stay checkable').toEqual([])
  })
})

maybe('every forbidden operation is refused, live (PG-07..PG-12, N-11)', () => {
  it('PG-08 DELETE is refused on ALL 58 — asserted one table at a time', () => {
    // A loop that can pass on one table is not this control. Every member of
    // the closed world is named, because no class in the contract carries
    // DELETE except OPERATIONAL_legacy, which is checked separately below.
    const deletable = [...CONTRACT].filter(([, want]) => !want.includes('D')).map(([t]) => t)
    expect(deletable.length).toBe(25)
    for (const t of deletable) {
      expect(db().sqlstate(`DELETE FROM public.${t}`, 'uellix_app'), t).toBe('42501')
    }
  }, PROBE_TIMEOUT)

  it('PG-09 UPDATE is refused on every APPEND_ONLY table', () => {
    const appendOnly = [...APPEND_ONLY, ...APPEND_ONLY_LEGACY, ...CONDITIONAL]
    expect(appendOnly.length).toBe(12)
    for (const t of appendOnly) {
      expect(db().sqlstate(`UPDATE public.${t} SET id = id`, 'uellix_app'), t).toBe('42501')
    }
  })

  it('PG-10 INSERT is refused on every READ_ONLY table', () => {
    expect(READ_ONLY.length).toBe(4)
    for (const t of READ_ONLY) {
      expect(db().sqlstate(`INSERT INTO public.${t} DEFAULT VALUES`, 'uellix_app'), t).toBe('42501')
    }
  })

  it('PG-07 INSERT is refused on stella_interactions — the R6-INT boundary', () => {
    // stella_0017 withdrew it; the ledger is charged through the governed
    // ticket protocol. A package that re-granted it would sell two units
    // against a cap of one.
    expect(db().sqlstate('INSERT INTO public.stella_interactions DEFAULT VALUES', 'uellix_app')).toBe('42501')
  })

  it('PG-11 / PG-12 every verb on both NO_RUNTIME_ACCESS tables is refused, for both roles', () => {
    for (const t of NO_RUNTIME_ACCESS) {
      for (const role of ['uellix_app', 'uellix_auditor']) {
        expect(db().sqlstate(`SELECT 1 FROM public.${t}`, role), `${role} SELECT ${t}`).toBe('42501')
      }
      expect(db().sqlstate(`INSERT INTO public.${t} DEFAULT VALUES`, 'uellix_app'), t).toBe('42501')
      expect(db().sqlstate(`DELETE FROM public.${t}`, 'uellix_app'), t).toBe('42501')
    }
  })

  it('N-11 the auditor is refused by TWO independent layers, and the outer one masks the inner', () => {
    // MEASURED, AND THE REASON THIS CONTROL HAS TWO ARMS. An ordinary auditor
    // session carries default_transaction_read_only = on (stella_0001:84), so
    // an INSERT dies at 25006 BEFORE the privilege layer is ever consulted. A
    // control asserting only the live failure would therefore stay GREEN even
    // if this package wrongly granted the auditor INSERT — a vacuous negative.
    expect(db().sqlstate('INSERT INTO public.audit_logs DEFAULT VALUES', 'uellix_auditor')).toBe('25006')

    // Arm two forces past the session default, so the GRANT layer — the one
    // this package actually owns — answers for itself.
    expect(db().sqlstate(
      'BEGIN; SET TRANSACTION READ WRITE; INSERT INTO public.audit_logs DEFAULT VALUES; COMMIT;',
      'uellix_auditor',
    )).toBe('42501')

    // And the same claim on the catalog, independent of any session setting.
    expect(db().bool(`SELECT has_table_privilege('uellix_auditor','public.audit_logs','INSERT')`)).toBe(false)
    expect(db().bool(`SELECT has_table_privilege('uellix_auditor','public.audit_logs','SELECT')`)).toBe(true)
  })
})

maybe('PG-21 the legacy posture is preserved in BOTH directions', () => {
  it('amended arm — stella_interactions keeps the INSERT stella_0017 withdrew', () => {
    expect(db().privileges('uellix_writer', 'stella_interactions')).toBe('S')
    expect(db().bool(`SELECT has_table_privilege('uellix_auditor','public.stella_interactions','SELECT')`)).toBe(true)
  })

  it('amended arm — the conditional member is append-only where it exists', () => {
    expect(db().privileges('uellix_writer', 'stella_suggestion_decisions')).toBe('SI')
  })

  it('UNAMENDED arm — marketing_leads keeps SIUD, because stella_0009 is NOT installed', () => {
    // The converse failure: a package that NARROWED it would be freezing an
    // unapplied design package, and would refuse on every target where
    // stella_hosted_0007 is applied. Equally red, opposite direction.
    expect(db().privileges('uellix_writer', 'marketing_leads')).toBe('SIUD')
  })

  it('all 33 OPERATIONAL_legacy tables keep SIUD', () => {
    const wrong = OPERATIONAL_LEGACY.filter((t) => db().privileges('uellix_writer', t) !== 'SIUD')
    expect(wrong).toEqual([])
  }, PROBE_TIMEOUT)
})

maybe('PG-17 RLS remains the row boundary, with two organizations', () => {
  it('a cross-org read as uellix_app never returns the sibling organization row', () => {
    const orgA = '11111111-1111-4111-8111-111111111111'
    const orgB = '22222222-2222-4222-8222-222222222222'
    const userA = '33333333-3333-4333-8333-333333333333'

    // public.organizations.slug is NOT NULL with a UNIQUE constraint
    // (db/migrations/0000:32,39), so both sentinel rows must carry one. The
    // fixture helper THROWS on a failed statement rather than returning a
    // status, which is what surfaced the omission instead of leaving this
    // control asserting over an empty table.
    db().fixture(`
      INSERT INTO auth.users (id, email) VALUES ('${userA}','a@acl.local') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.users (id, email) VALUES ('${userA}','a@acl.local') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.organizations (id, name, slug)
        VALUES ('${orgA}','Org A','acl-org-a'),('${orgB}','Org B','acl-org-b') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.organization_members (organization_id, user_id, role)
        VALUES ('${orgA}','${userA}','organization_admin') ON CONFLICT DO NOTHING;
    `)

    // A table privilege is necessary and NOT sufficient: the grant lets the
    // statement run, and the policy decides which rows it reaches. Both halves
    // are asserted, because a package that accidentally disabled RLS would
    // still pass every privilege assertion above.
    expect(db().bool(`SELECT has_table_privilege('uellix_app','public.organizations','SELECT')`)).toBe(true)

    const asOrgA = db().query(
      `SET LOCAL ROLE uellix_app; SELECT set_config('app.organization_id','${orgA}',true); SELECT id FROM public.organizations`,
      'supabase_admin',
    )
    const ids = asOrgA.map((r) => r[0])
    expect(ids, 'the ORG_B sentinel row must never appear in ORG_A\'s result set').not.toContain(orgB)

    // The positive half: RLS is ON and FORCED where the schema says so, so the
    // negative above is a filter rather than an empty table.
    expect(db().bool(`SELECT relrowsecurity FROM pg_class WHERE oid='public.organizations'::regclass`)).toBe(true)
    expect(db().scalar(`SELECT count(*) FROM public.organizations`, 'postgres')).toBe('2')
  })
})

maybe('PG-22 the capability-only exclusions are untouched', () => {
  it('the package grants nothing on any of the six, present or absent', () => {
    for (const t of CAPABILITY_ONLY) {
      const present = db().bool(`SELECT to_regclass('public.${t}') IS NOT NULL`)
      if (!present) continue
      for (const role of ['uellix_writer', 'uellix_auditor']) {
        const held = db().privileges(role, t)
        // report_public_disclosures is the ONE declared exception and holds
        // SELECT for the writer by stella_0007:414 — never more, never for
        // this package's doing.
        const allowed = t === 'report_public_disclosures' && role === 'uellix_writer' ? ['', 'S'] : ['']
        expect(allowed, `${role} on ${t} holds "${held}"`).toContain(held)
      }
    }
  })
})

maybe('it FAILS CLOSED — every refusal is driven, not described (PG-05, N-05..N-08)', () => {
  it('PG-05 an unknown public relation refuses, names it, and changes nothing', () => {
    const before = db().tableAclSnapshot()
    db().fixture('CREATE TABLE public.zz_acl_unknown_fixture (id int)')
    const r = db().applyPackage()

    expect(r.status, 'the package applied over a relation no authority classified').not.toBe(0)
    expect(r.stderr).toMatch(/UNCLASSIFIED public relation/)
    expect(r.stderr, 'the refusal must be ATTRIBUTABLE to the fixture').toMatch(/zz_acl_unknown_fixture/)
    expect(db().tableAclSnapshot(), 'the refused transaction still changed the ACL').toBe(before)

    db().fixture('DROP TABLE public.zz_acl_unknown_fixture')
    reconverge()
  })

  it('N-08 a VIEW and a SEQUENCE in public each refuse, named', () => {
    for (const [ddl, drop, name, kind] of [
      ['CREATE VIEW public.zz_acl_view AS SELECT 1 AS x', 'DROP VIEW public.zz_acl_view', 'zz_acl_view', 'v'],
      ['CREATE SEQUENCE public.zz_acl_seq', 'DROP SEQUENCE public.zz_acl_seq', 'zz_acl_seq', 'S'],
    ] as const) {
      db().fixture(ddl)
      const r = db().applyPackage()
      expect(r.status, `${name} did not refuse`).not.toBe(0)
      expect(r.stderr).toMatch(new RegExp(`${name} \\(relkind ${kind}\\)`))
      db().fixture(drop)
    }
    reconverge()
  })

  it('N-05 an OVERPRIVILEGED PRESTATE refuses, and the surplus SURVIVES the refusal', () => {
    try {
      db().fixture('GRANT DELETE ON public.readiness_assessments TO uellix_writer')
      const widened = db().tableAclSnapshot()

      const r = db().applyPackage()
      expect(r.status, 'the package silently narrowed a surplus it did not create').not.toBe(0)
      expect(r.stderr).toMatch(/OVERPRIVILEGED PRESTATE/)
      expect(r.stderr).toMatch(/readiness_assessments/)

      // The point of refusing rather than narrowing: the evidence is still
      // there to be explained. If the package had swallowed it, nothing would
      // record that something outside this repository widened the runtime.
      expect(db().bool(`SELECT has_table_privilege('uellix_writer','public.readiness_assessments','DELETE')`)).toBe(true)
      expect(db().tableAclSnapshot()).toBe(widened)
    } finally {
      db().fixture('REVOKE DELETE ON public.readiness_assessments FROM uellix_writer')
      reconverge()
    }
  })

  it('N-06 role topology drift refuses — and the fixture is proven to have taken effect', () => {
    try {
      // The fixture is issued as supabase_admin because it is the GRANTOR of
      // the membership: as postgres the REVOKE returns 42501 and the "negative
      // control" would report a failure to refuse a drift never established.
      db().fixture('REVOKE uellix_writer FROM uellix_app', 'supabase_admin')
      expect(db().bool(`SELECT pg_has_role('uellix_app','uellix_writer','USAGE')`), 'the fixture did not take').toBe(false)

      const r = db().applyPackage()
      expect(r.status, 'the package granted to a writer the runtime cannot inherit from').not.toBe(0)
      expect(r.stderr).toMatch(/is not an inheriting member of uellix_writer/)
    } finally {
      db().fixture('GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE', 'supabase_admin')
      expect(db().bool(`SELECT pg_has_role('uellix_app','uellix_writer','USAGE')`)).toBe(true)
      reconverge()
    }
  })

  it('N-06b BYPASSRLS on a runtime role refuses', () => {
    try {
      // A role that bypasses RLS makes every row-level claim in this schema
      // unmeasurable, and every negative control that passes against it passes
      // vacuously.
      db().fixture('ALTER ROLE uellix_app BYPASSRLS', 'supabase_admin')
      const r = db().applyPackage()
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/SUPERUSER or BYPASSRLS/)
    } finally {
      db().fixture('ALTER ROLE uellix_app NOBYPASSRLS', 'supabase_admin')
      reconverge()
    }
  })

  it('N-07 an RLS helper that is no longer SECURITY DEFINER refuses, named', () => {
    try {
      // The authority's fixture DROPs a helper. Measured here: it cannot be
      // dropped without CASCADE, because the policies name these functions in
      // their predicates — so a DROP would destroy the RLS layer the package
      // exists to serve and the refusal would become unattributable. ALTER
      // FUNCTION ... SECURITY INVOKER exercises the same §0.5 arm, reversibly.
      db().fixture('ALTER FUNCTION public.current_user_role_in_org(uuid) SECURITY INVOKER')
      const r = db().applyPackage()
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/not SECURITY DEFINER/)
      expect(r.stderr).toMatch(/current_user_role_in_org/)
    } finally {
      db().fixture('ALTER FUNCTION public.current_user_role_in_org(uuid) SECURITY DEFINER')
      reconverge()
    }
  })
})

maybe('the controls are FALSIFIABLE — mutation battery (M-SQL-01..04)', () => {
  it('M-SQL-01 deleting the closed-world sweep makes PG-05 stop refusing', () => {
    const mutant = mutateUniquely(
      packageSource(),
      `  SELECT string_agg('public.' || c.relname, ', ' ORDER BY c.relname) INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT (c.relname = ANY (accounted_tables));`,
      '  v_bad := NULL;',
      'M-SQL-01',
    )

    db().fixture('CREATE TABLE public.zz_acl_unknown_fixture (id int)')
    expect(db().applyPackage().status, 'the real package must refuse').not.toBe(0)
    expect(db().applyMutant(mutant).status, 'the mutant must NOT refuse — otherwise PG-05 proves nothing').toBe(0)

    db().fixture('DROP TABLE public.zz_acl_unknown_fixture')
    reconverge()
  })

  it('M-SQL-03 a ONE-SIDED widening is absorbed; the two-sided one is caught', () => {
    const source = packageSource()
    const oneSided = mutateUniquely(
      source,
      'GRANT SELECT, INSERT, UPDATE ON\n  public.counterfactual_assessments,',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON\n  public.counterfactual_assessments,',
      'M-SQL-03 one-sided',
    )

    // MEASURED AND RECORDED, because it changes what this control proves: the
    // class's convergence REVOKE runs immediately after the GRANT and takes the
    // surplus straight back. The package is SELF-HEALING against a one-sided
    // edit, so a battery that mutated only the GRANT would report false GREEN.
    expect(db().applyMutant(oneSided).status).toBe(0)
    expect(db().privileges('uellix_app', 'counterfactual_assessments')).toBe('SIU')

    // The realistic defect is a CLASS REDEFINITION, which edits both sides.
    const twoSided = mutateUniquely(
      oneSided,
      'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON\n  public.counterfactual_assessments,',
      'REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON\n  public.counterfactual_assessments,',
      'M-SQL-03 two-sided',
    )
    const r = db().applyMutant(twoSided)
    expect(r.status, 'a widened class reached the end state undetected').not.toBe(0)
    expect(r.stderr).toMatch(/writer contract does not hold/)
    expect(db().privileges('uellix_app', 'counterfactual_assessments')).toBe('SIU')
    reconverge()
  })

  it('M-SQL-04a re-granting the INSERT stella_0017 withdrew is caught', () => {
    const oneSided = mutateUniquely(
      packageSource(),
      'GRANT SELECT ON public.stella_interactions TO uellix_writer;',
      'GRANT SELECT, INSERT ON public.stella_interactions TO uellix_writer;',
      'M-SQL-04a one-sided',
    )
    expect(db().applyMutant(oneSided).status).toBe(0)
    expect(db().privileges('uellix_writer', 'stella_interactions')).toBe('S')

    const twoSided = mutateUniquely(
      oneSided,
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON\n  public.stella_interactions\nFROM uellix_writer;',
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON\n  public.stella_interactions\nFROM uellix_writer;',
      'M-SQL-04a two-sided',
    )
    const r = db().applyMutant(twoSided)
    expect(r.status, 'a closed vulnerability was re-opened undetected').not.toBe(0)
    expect(r.stderr).toMatch(/stella_interactions/)
    expect(db().privileges('uellix_writer', 'stella_interactions')).toBe('S')
    reconverge()
  })

  it('M-SQL-04b NARROWING marketing_leads is caught — against an unwidened prestate', () => {
    const mutant = mutateUniquely(
      packageSource(),
      `GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.evidence_items, public.financial_proxies, public.funders,
  public.fx_rates, public.impact_narratives, public.indicators,
  public.invitations, public.marketing_leads, public.methodology_review_matrix,`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.evidence_items, public.financial_proxies, public.funders,
  public.fx_rates, public.impact_narratives, public.indicators,
  public.invitations, public.methodology_review_matrix,`,
      'M-SQL-04b',
    )

    try {
      // MEASURED: on an ALREADY-CONVERGED substrate the omission is INVISIBLE,
      // because the privilege is still present from the prior apply and the
      // postcondition reads SIUD. A mutation control that reused a converged
      // database would report false GREEN.
      expect(db().applyMutant(mutant).status).toBe(0)

      // Against the prestate a FIRST apply actually faces, it is caught.
      db().fixture('REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer')
      const r = db().applyMutant(mutant)
      expect(r.status, 'an unamended legacy table was silently narrowed').not.toBe(0)
      expect(r.stderr).toMatch(/marketing_leads/)
    } finally {
      reconverge()
    }
    expect(db().privileges('uellix_writer', 'marketing_leads')).toBe('SIUD')
  })

  it('M-SQL-02 the surplus is stopped by FOUR independent guards, and all four are needed', () => {
    const source = packageSource()
    const OVERPRIV = /IF \(strpos\(r\.want, 'S'\) = 0 AND strpos\(r\.got, 'S'\) > 0\)[\s\S]*?END IF;\n  END LOOP;/
    const POST_WRITER = "    RAISE EXCEPTION 'stella_0021 FAILED verification: the writer contract does not hold — %.', problem;"
    const POST_APP = "    RAISE EXCEPTION 'stella_0021 FAILED verification: the EFFECTIVE runtime privilege does not match the contract — %. uellix_app holds no direct grant, so this measures the inherited membership that actually serves a request.', problem;"

    // MEASURED, AND THE COUNT WAS ARRIVED AT BY BEING WRONG TWICE. A surplus on
    // an APPEND_ONLY table has to get past FOUR independent guards:
    //   (1) §0.10, the OVERPRIVILEGED PRESTATE refusal;
    //   (2) the class's convergence REVOKE, which takes it back;
    //   (3) §12 arm 2, the WRITER contract measured got-vs-want;
    //   (4) §12 arm 3, the EFFECTIVE privilege of uellix_app through inheritance.
    // A first draft removed (1) and (2) and asserted the surplus would survive;
    // (3) caught it. A second removed (1), (2) and (3); (4) caught it. Each
    // time the assertion was under-counting the guards rather than finding a
    // defect — which is the honest way to arrive at how deep the depth is.
    try {
      db().fixture('GRANT DELETE ON public.account_legal_acceptances TO uellix_writer')

      // GUARD 1 alone answers first, so the other two never speak.
      const guarded = db().applyPackage()
      expect(guarded.status).not.toBe(0)
      expect(guarded.stderr).toMatch(/OVERPRIVILEGED PRESTATE/)

      // Remove guard 1: guard 2 converges the surplus away, silently and
      // successfully — which is exactly the behaviour §0.10 exists to prevent.
      const noPrestate = source.replace(OVERPRIV, 'NULL;\n  END LOOP;')
      expect(noPrestate, 'the §0.10 excision anchor did not match').not.toBe(source)
      expect(db().applyMutant(noPrestate).status).toBe(0)
      expect(db().bool(`SELECT has_table_privilege('uellix_writer','public.account_legal_acceptances','DELETE')`)).toBe(false)

      // Remove guards 1 and 2: guard 3 still refuses, so the surplus STILL
      // never reaches the end state.
      const noPrestateNoRevoke = mutateUniquely(
        noPrestate,
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON\n  public.account_legal_acceptances,',
        'REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON\n  public.account_legal_acceptances,',
        'M-SQL-02 guards 1+2',
      )
      db().fixture('GRANT DELETE ON public.account_legal_acceptances TO uellix_writer')
      const two = db().applyMutant(noPrestateNoRevoke)
      expect(two.status, 'the WRITER postcondition is the third guard and must still refuse').not.toBe(0)
      expect(two.stderr).toMatch(/writer contract does not hold/)

      // Remove guards 1, 2 and 3: guard 4 — the EFFECTIVE privilege of the
      // runtime, measured through inheritance rather than on the writer —
      // still refuses. The two postcondition arms are NOT one control stated
      // twice: one asks what uellix_writer holds, the other asks what
      // uellix_app can actually do with it.
      const noWriterArm = mutateUniquely(noPrestateNoRevoke, POST_WRITER, '    problem := NULL;', 'M-SQL-02 guards 1+2+3')
      const three = db().applyMutant(noWriterArm)
      expect(three.status, 'the EFFECTIVE-privilege arm is the fourth guard and must still refuse').not.toBe(0)
      expect(three.stderr).toMatch(/EFFECTIVE runtime privilege does not match/)

      // Remove all four: ONLY NOW does the surplus reach the end state. That
      // is what makes each guard's contribution measured rather than asserted.
      const noneAtAll = mutateUniquely(noWriterArm, POST_APP, '    problem := NULL;', 'M-SQL-02 guards 1+2+3+4')
      const none = db().applyMutant(noneAtAll)
      const survived = db().bool(`SELECT has_table_privilege('uellix_writer','public.account_legal_acceptances','DELETE')`)
      expect(none.status, none.stderr).toBe(0)
      expect(survived, 'with all four guards removed the surplus must reach the end state').toBe(true)
    } finally {
      // IN A FINALLY, because a failed expectation above would otherwise leave
      // the surplus in place and every later control would fail against a
      // substrate this control broke — which is precisely what happened before
      // this block was wrapped.
      db().fixture('REVOKE DELETE ON public.account_legal_acceptances FROM uellix_writer')
      reconverge()
    }
  })

  it('a mutation whose anchor is absent or ambiguous is REFUSED, not silently skipped', () => {
    expect(() => mutateUniquely(packageSource(), 'NO SUCH ANCHOR ANYWHERE', 'x', 'probe')).toThrow(/ABSENT/)
    // `TO uellix_writer;` ends many statements — an ambiguous anchor would
    // mutate a sibling class and attribute the result to the wrong one.
    expect(() => mutateUniquely(packageSource(), 'TO uellix_writer;', 'x', 'probe')).toThrow(/matches \d+ times/)
  })
})

maybe('the substrate survived the battery', () => {
  it('the canonical posture is restored, byte for byte', () => {
    reconverge()
    expect(db().tableAclSnapshot()).toBe(canonicalTableAcl)
    expect(db().functionAclSnapshot()).toBe(canonicalFunctionAcl)
  })
})
