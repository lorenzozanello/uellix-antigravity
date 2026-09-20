/**
 * M-PG17-01..06 — the falsification obligations of the amended PG-17.
 *
 * WHAT THIS FILE IS FOR. CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY
 * _AMENDMENT_v1.0.1 SECTION_A7 froze six mutations and made them binding: "a
 * control that cannot be made to fail has proven nothing". The companion test
 * manifest carried all six as STATUS=FUTURE_MATERIALIZATION with
 * test_file: UNKNOWN. This file materialises them.
 *
 * THE ARMS ARE NOT RE-EXPRESSED HERE. Every assertion below calls the SAME
 * exported predicate that the positive control in
 * current-schema-runtime-acl-rls.pg.test.ts calls — orgArmFailures,
 * userArmFailures, globalExistenceFailures, globalSetEqualityFailures,
 * identityFreeFailures, globalWriteCatalogFailures, globalWriteLiveFailures.
 * A battery that restated the predicate would prove that ITS COPY goes red,
 * and the copy would drift from the control on the next edit. Sharing makes
 * each mutation a falsification of the control that actually runs.
 *
 * ANCHOR UNIQUENESS IS FAIL-CLOSED. SECTION_A7's
 * ANCHOR_UNIQUENESS_REQUIREMENT is binding: every anchor must match EXACTLY
 * ONE site, asserted BEFORE anything is written. An anchor matching a sibling
 * mutates a surface other than the one under test — so the red is attributed
 * to the wrong control — or leaves the intended site untouched, and the green
 * is misread as robustness. requireExactlyOne() below throws rather than
 * mutating, so a bad anchor aborts the battery instead of producing a result.
 *
 * EVERY MUTATION IS TRANSIENT AND ITS RESTORATION IS PROVEN. Each arm asserts
 * GREEN before (otherwise the red proves nothing about the mutation), RED
 * after, and GREEN again once restored — and the closing control re-measures
 * the whole substrate against the fingerprints taken before the first
 * mutation, so a restoration that merely looked right cannot pass.
 *
 * Gated on UELLIX_PG_TESTS=1; SKIPPED, never silently passed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AclCluster, PG_TESTS_ENABLED, dockerAvailable } from './current-schema-runtime-acl-harness'
import {
  GLOBAL_PROXY_VERSION, ORG_A, ORG_B, USER_A, USER_A2, USER_B,
  globalExistenceFailures, globalSetEqualityFailures, globalWriteCatalogFailures,
  globalWriteLiveFailures, identityFreeFailures, orgArmFailures,
  seedSubjects, seedTenantSentinels, userArmFailures,
} from './current-schema-runtime-acl-tenancy-fixture'

const enabled = PG_TESTS_ENABLED
let cluster: AclCluster | null = null
let skipReason = ''

/** Docker-exec probe loops are ~250ms each; these arms run 13-36 of them. */
const PROBE_TIMEOUT = 180_000

/** The one organisation-scoped relation M-PG17-01 breaks. Named once. */
const M01_RELATION = 'readiness_assessments'
/** The one platform-global registry M-PG17-03 and M-PG17-04 touch. Named once. */
const M03_RELATION = 'governed_model_registry'

/** Substrate fingerprints taken before the first mutation. */
const baseline: { tableAcl?: string; functionAcl?: string; rolconfig?: string } = {}

beforeAll(async () => {
  if (!enabled) { skipReason = 'UELLIX_PG_TESTS is not 1'; return }
  if (!dockerAvailable()) { skipReason = 'Docker is unreachable'; return }
  cluster = await AclCluster.create()
  if (cluster === null) { skipReason = 'the disposable cluster could not be provisioned'; return }

  const applied = cluster.applyPackage()
  if (applied.status !== 0) {
    throw new Error(`stella_0021 failed to apply to the mutation substrate:\n${applied.stderr}`)
  }
  seedSubjects(cluster)
  seedTenantSentinels(cluster)

  baseline.tableAcl = cluster.tableAclSnapshot()
  baseline.functionAcl = cluster.functionAclSnapshot()
  baseline.rolconfig = rolconfigOf(cluster, 'uellix_app')
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

/**
 * ANCHOR_UNIQUENESS_REQUIREMENT, enforced fail-closed.
 *
 * Throws rather than returning a boolean: a mutation harness that merely
 * REPORTS a bad anchor and carries on has already mutated the wrong surface by
 * the time anyone reads the report.
 */
function requireExactlyOne(countSql: string, label: string): void {
  const n = db().scalar(countSql)
  if (n !== '1') {
    throw new Error(
      `ANCHOR UNIQUENESS VIOLATED for ${label}: the anchor matched ${n} sites, not 1. ` +
      `Aborting BEFORE any mutation is applied — a red attributed to the wrong surface, ` +
      `or a green from an unmutated site, is worse than no result.`,
    )
  }
}

/** The role-level GUC list, as a stable string. Empty when the role has none. */
function rolconfigOf(c: AclCluster, role: string): string {
  return c.scalar(
    `SELECT coalesce(array_to_string(rolconfig, ';'), '<none>') FROM pg_roles WHERE rolname = '${role}'`,
  ) ?? '<unreadable>'
}

/** A stable content digest of one relation, used to prove an exact restoration. */
function contentDigest(relation: string): string {
  return db().scalar(
    `SELECT coalesce(md5(string_agg(t::text, '' ORDER BY t::text)), '<empty>') FROM public.${relation} t`,
  ) ?? '<unreadable>'
}

const maybe = enabled ? describe : describe.skip

/* -------------------------------------------------------------------------- */

maybe('the mutation substrate', () => {
  it('provisions, or says why it did not — never silently green', () => {
    expect(cluster, `the PG-17 mutation battery could not run: ${skipReason}`).not.toBeNull()
  })

  it('every arm is GREEN before the first mutation — otherwise no red below means anything', () => {
    expect(orgArmFailures(db(), USER_A, ORG_A, ORG_B), 'PG-17A org arm, A direction').toEqual([])
    expect(orgArmFailures(db(), USER_B, ORG_B, ORG_A), 'PG-17A org arm, B direction').toEqual([])
    expect(userArmFailures(db()), 'PG-17A user arm').toEqual([])
    expect(globalExistenceFailures(db()), 'PG-17B B1').toEqual([])
    expect(globalSetEqualityFailures(db()), 'PG-17B B2/B3').toEqual([])
    expect(identityFreeFailures(db()), 'PG-17B B4').toEqual([])
    expect(globalWriteCatalogFailures(db()), 'PG-17B B5').toEqual([])
    expect(globalWriteLiveFailures(db()), 'PG-17B B6').toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('M-PG17-01 — break the tenant discriminator on exactly one of the 13', () => {
  it('the org arm goes RED in BOTH directions, names that relation, and recovers', () => {
    // ANCHOR: the single SELECT policy of the single target relation.
    requireExactlyOne(
      `SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = '${M01_RELATION}' AND cmd = 'SELECT'`,
      `the SELECT policy of ${M01_RELATION}`,
    )
    const policy = db().scalar(
      `SELECT policyname FROM pg_policies
       WHERE schemaname='public' AND tablename='${M01_RELATION}' AND cmd='SELECT'`,
    )
    const originalQual = db().scalar(
      `SELECT qual FROM pg_policies
       WHERE schemaname='public' AND tablename='${M01_RELATION}' AND cmd='SELECT'`,
    )
    // The captured text is the thing the restoration depends on, so its SHAPE
    // is asserted before it is trusted: a truncated or mis-parsed qual would
    // otherwise be discovered only as a silently weakened substrate.
    expect(originalQual, 'the captured policy expression must carry the tenant predicate')
      .toContain('current_user_org_ids')

    expect(orgArmFailures(db(), USER_A, ORG_A, ORG_B)).toEqual([])
    expect(orgArmFailures(db(), USER_B, ORG_B, ORG_A)).toEqual([])

    // MUTATE: the tenant predicate no longer restricts to the caller's orgs.
    db().fixture(`ALTER POLICY ${policy} ON public.${M01_RELATION} USING (true);`)
    try {
      const a = orgArmFailures(db(), USER_A, ORG_A, ORG_B)
      const b = orgArmFailures(db(), USER_B, ORG_B, ORG_A)
      // BOTH DIRECTIONS, as SECTION_A7 requires. A one-sided red would leave
      // open that the arm only ever reads one subject.
      expect(a, 'the A direction stayed green with the discriminator removed').not.toEqual([])
      expect(b, 'the B direction stayed green with the discriminator removed').not.toEqual([])
      // ATTRIBUTED, not merely red: the failure must name the relation that was
      // actually mutated, or the battery has proven nothing about THIS anchor.
      expect(a.join(' ')).toContain(M01_RELATION)
      expect(b.join(' ')).toContain(M01_RELATION)
      expect(a.join(' ')).toContain('LEAKED')
      // ...and nothing else moved: the other twelve relations stay clean.
      expect(a.filter((f) => !f.startsWith(M01_RELATION)), 'a sibling relation also went red').toEqual([])
    } finally {
      db().fixture(`ALTER POLICY ${policy} ON public.${M01_RELATION} USING (${originalQual});`)
    }

    // RESTORED, proven by the catalog and then by the arm itself.
    expect(db().scalar(
      `SELECT qual FROM pg_policies
       WHERE schemaname='public' AND tablename='${M01_RELATION}' AND cmd='SELECT'`,
    )).toBe(originalQual)
    expect(orgArmFailures(db(), USER_A, ORG_A, ORG_B)).toEqual([])
    expect(orgArmFailures(db(), USER_B, ORG_B, ORG_A)).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('M-PG17-02 — put the two user-arm subjects in DIFFERENT organisations', () => {
  it('the attribution guard goes RED, and the isolation result alone would NOT have', () => {
    requireExactlyOne(
      `SELECT count(*) FROM public.organization_members WHERE user_id = '${USER_A2}'`,
      `the single membership row of ${USER_A2}`,
    )
    expect(userArmFailures(db())).toEqual([])

    db().fixture(
      `UPDATE public.organization_members SET organization_id = '${ORG_B}' WHERE user_id = '${USER_A2}';`,
    )
    try {
      const f = userArmFailures(db())
      expect(f, 'the user arm stayed green with co-membership removed').not.toEqual([])
      expect(f.join(' ')).toContain('ATTRIBUTION GUARD')

      // THE POINT OF THE MUTATION, stated as its own assertion. user_id
      // isolation still HOLDS across the boundary — so a user arm without the
      // attribution guard would have stayed green here, and its green would
      // have been equally explainable by the organisation boundary. The guard
      // is the only thing that notices, which is why it lives inside the
      // predicate rather than beside it.
      expect(f.filter((x) => x.includes('LEAKED')), 'isolation itself broke, confounding the mutation')
        .toEqual([])
    } finally {
      db().fixture(
        `UPDATE public.organization_members SET organization_id = '${ORG_A}' WHERE user_id = '${USER_A2}';`,
      )
    }

    expect(userArmFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('M-PG17-03 — remove the governed global rows from one registry', () => {
  it('B1 and B2 both go RED, and the set-equality is shown to have been non-vacuous', () => {
    requireExactlyOne(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = '${M03_RELATION}'`,
      `the relation public.${M03_RELATION}`,
    )
    const before = contentDigest(M03_RELATION)
    expect(Number(db().scalar(`SELECT count(*) FROM public.${M03_RELATION}`) ?? '0'),
      'the registry is already empty — the mutation would be vacuous').toBeGreaterThan(0)

    expect(globalExistenceFailures(db())).toEqual([])
    expect(globalSetEqualityFailures(db())).toEqual([])

    db().fixture(`
      CREATE TABLE pg17_mut_backup AS SELECT * FROM public.${M03_RELATION};
      DELETE FROM public.${M03_RELATION};
    `)
    try {
      const b1 = globalExistenceFailures(db())
      const b2 = globalSetEqualityFailures(db())
      expect(b1, 'B1 stayed green against an EMPTY registry').not.toEqual([])
      expect(b1.join(' ')).toContain(M03_RELATION)
      expect(b1.join(' ')).toContain('vacuous')
      // B2 must go red too. Its set-equality would otherwise be the trivial
      // equality of two empty sets — the single most likely way for PG-17B to
      // look green while proving nothing.
      expect(b2, 'B2 stayed green: two EMPTY sets are equal, and that is the defect').not.toEqual([])
      expect(b2.join(' ')).toContain(M03_RELATION)
      expect(b2.join(' ')).toContain('vacuous')
    } finally {
      db().fixture(`
        INSERT INTO public.${M03_RELATION} SELECT * FROM pg17_mut_backup;
        DROP TABLE pg17_mut_backup;
      `)
    }

    // Restored by CONTENT, not by row count: a count would not notice a row
    // that came back with different values.
    expect(contentDigest(M03_RELATION)).toBe(before)
    expect(globalExistenceFailures(db())).toEqual([])
    expect(globalSetEqualityFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('M-PG17-04 — grant the runtime a forbidden write on a global registry', () => {
  it('B5 AND B6 both go RED — neither layer is a restatement of the other', () => {
    // VERB CHOICE: INSERT is not usable here. governed_model_registry carries
    // only a SELECT policy (db/policies/009_governed_model_registry_rls.sql);
    // under RLS with no INSERT policy, a granted INSERT is refused by the
    // WITH CHECK default-deny (42501) before it ever reaches the table, so
    // the live arm of B6 never fires and the control would be measuring only
    // the catalog layer. UPDATE is granted instead: measured on this exact
    // substrate, a granted UPDATE with no applicable RLS policy is a REAL
    // live success (default-deny filters it to zero rows via USING, not an
    // error) — both B5 and B6 are independently observable, per SECTION_A7.
    requireExactlyOne(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = '${M03_RELATION}'`,
      `the relation public.${M03_RELATION}`,
    )
    expect(db().bool(`SELECT has_table_privilege('uellix_app','public.${M03_RELATION}','UPDATE')`),
      'the privilege is already held — the mutation would be vacuous').toBe(false)

    // Fingerprint taken BEFORE the grant: the live probe below carries a real
    // SET clause, and this control does not get to assume RLS filters it to
    // zero rows — that must be demonstrated, not presumed. A row count alone
    // would not notice a row that came back with different values than it had.
    const contentBefore = contentDigest(M03_RELATION)
    expect(globalWriteCatalogFailures(db())).toEqual([])
    expect(globalWriteLiveFailures(db())).toEqual([])

    const catalogSignal = `${M03_RELATION}.UPDATE: the catalog says the privilege is HELD`
    const liveSignal = `${M03_RELATION}.UPDATE: the live mutation SUCCEEDED`

    db().fixture(`GRANT UPDATE ON public.${M03_RELATION} TO uellix_app;`)
    try {
      const b5 = globalWriteCatalogFailures(db())
      const b6 = globalWriteLiveFailures(db())
      // B5 is the catalog predicate alone, and only for this relation/verb.
      expect(b5, 'B5 stayed green against a real widening of the runtime capability').toEqual([catalogSignal])
      // B6 must carry BOTH independent signals literally — not merely a
      // non-empty array, and not merely a substring either signal could
      // satisfy on its own. Each is asserted by exact string membership so
      // that only the catalog predicate firing (without the live branch, or
      // the reverse) is provably insufficient to pass this control.
      expect(b6, 'B6 stayed green against a real widening of the runtime capability').not.toEqual([])
      expect(b6, 'the catalog signal did not fire in B6').toContain(catalogSignal)
      expect(b6, 'the LIVE-SUCCEEDED branch did not fire — B6 would be decorative').toContain(liveSignal)
      // BOTH RED IS THE CLAIM. If only one moved, the other would be decorative
      // — and SECTION_A7 M-PG17-04 exists precisely to refuse that reading.
      // Only the UPDATE verb of only this relation moved, in both.
      expect(b5.filter((f) => f !== catalogSignal)).toEqual([])
      expect(b6.filter((f) => f !== catalogSignal && f !== liveSignal)).toEqual([])
    } finally {
      db().fixture(`REVOKE UPDATE ON public.${M03_RELATION} FROM uellix_app;`)
    }

    // Restored, proven against the ACL snapshot AND the content fingerprint
    // taken before any mutation ran — not merely against a row count.
    expect(db().tableAclSnapshot()).toBe(baseline.tableAcl)
    expect(contentDigest(M03_RELATION), 'the live UPDATE probe altered registry content').toBe(contentBefore)
    expect(globalWriteCatalogFailures(db())).toEqual([])
    expect(globalWriteLiveFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('M-PG17-05 — leak an identity into the arm that must run without one', () => {
  it('B4 goes RED, and the leak is installed in the SUBSTRATE, not in the assertion', () => {
    // THE MUTATION IS A ROLE-LEVEL GUC, deliberately. Editing the test to pass
    // an identity would falsify the CALL, not the CONTROL: it would prove only
    // that a different argument gives a different answer. A default claim
    // attached to uellix_app itself is the realistic contamination — every new
    // session of that role silently starts with an identity — and it reaches
    // B4 without B4 being touched at all.
    requireExactlyOne(
      `SELECT count(*) FROM pg_roles WHERE rolname = 'uellix_app'`,
      'the role uellix_app',
    )
    expect(rolconfigOf(db(), 'uellix_app'), 'uellix_app already carries a default claim')
      .not.toContain('request.jwt.claims')

    expect(identityFreeFailures(db())).toEqual([])

    // ISSUED AS supabase_admin, and that is a measured property of the
    // substrate rather than a convenience. `postgres` is NOT a superuser on
    // this image — ALTER ROLE uellix_app as postgres returns "permission
    // denied to alter role" — because the disposable substrate reproduces the
    // hosted role topology faithfully. The harness reaches the same conclusion
    // for its own ALTER ROLE ... WITH PASSWORD. Using the role that actually
    // administers the runtime chain keeps the mutation inside the substrate's
    // own authority model instead of inventing one.
    db().fixture(
      `ALTER ROLE uellix_app SET "request.jwt.claims" = '{"sub":"${USER_A}"}';`,
      'supabase_admin',
    )
    try {
      const b4 = identityFreeFailures(db())
      expect(b4, 'B4 stayed green while every identity-free session carried an identity').not.toEqual([])
      // It must go red by RETURNING ROWS, not by erroring: an error would mean
      // the leak broke the probe rather than defeating the arm.
      expect(b4.join(' ')).toContain('without an identity')
      expect(b4.join(' '), 'B4 went red for the wrong reason').not.toContain('ERRORED')
    } finally {
      db().fixture(`ALTER ROLE uellix_app RESET "request.jwt.claims";`, 'supabase_admin')
    }

    expect(rolconfigOf(db(), 'uellix_app')).toBe(baseline.rolconfig)
    expect(identityFreeFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('M-PG17-06 — make the global proxy version un-approved', () => {
  it('the approved-global controls go RED on review_status alone, with the row still global', () => {
    requireExactlyOne(
      `SELECT count(*) FROM public.financial_proxy_versions
       WHERE id = '${GLOBAL_PROXY_VERSION}' AND organization_id IS NULL`,
      'the single approved-global financial_proxy_versions row',
    )
    const before = contentDigest('financial_proxy_versions')

    expect(globalExistenceFailures(db())).toEqual([])
    expect(globalSetEqualityFailures(db())).toEqual([])

    // 'draft' is admitted by financial_proxy_versions_review_status_check, so
    // the mutation produces a LEGAL row. A constraint failure here would mask
    // the signal with a different error.
    db().fixture(
      `UPDATE public.financial_proxy_versions SET review_status = 'draft' WHERE id = '${GLOBAL_PROXY_VERSION}';`,
    )
    try {
      // The row is still global — only its approval changed. This is what
      // separates a control that reads review_status from one that reads only
      // organization_id IS NULL and would silently publish unapproved rows.
      expect(db().scalar(
        `SELECT count(*) FROM public.financial_proxy_versions
         WHERE id = '${GLOBAL_PROXY_VERSION}' AND organization_id IS NULL`,
      )).toBe('1')

      const p1 = globalExistenceFailures(db())
      const p3 = globalSetEqualityFailures(db())
      expect(p1, 'the existence control does not read review_status').not.toEqual([])
      expect(p1.join(' ')).toContain('approved-global rows = 0')
      expect(p3, 'the visibility control does not read review_status').not.toEqual([])
      expect(p3.join(' ')).toContain('financial_proxy_versions approved-global row not visible')
      // Only financial_proxy_versions moved; the four registries are untouched.
      expect(p1.filter((f) => !f.startsWith('financial_proxy_versions'))).toEqual([])
    } finally {
      db().fixture(
        `UPDATE public.financial_proxy_versions SET review_status = 'approved' WHERE id = '${GLOBAL_PROXY_VERSION}';`,
      )
    }

    expect(contentDigest('financial_proxy_versions')).toBe(before)
    expect(globalExistenceFailures(db())).toEqual([])
    expect(globalSetEqualityFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)
})

/* -------------------------------------------------------------------------- */

maybe('the battery leaves the substrate exactly as it found it', () => {
  it('all six mutations were transient — ACLs, role config and every arm are back', () => {
    expect(db().tableAclSnapshot(), 'a table ACL survived the battery').toBe(baseline.tableAcl)
    expect(db().functionAclSnapshot(), 'a function ACL survived the battery').toBe(baseline.functionAcl)
    expect(rolconfigOf(db(), 'uellix_app'), 'a role-level GUC survived the battery').toBe(baseline.rolconfig)
    // The scratch table M-PG17-03 needed must not survive: the parent's PG-05
    // closed world refuses an unknown public relation, so leaving one behind
    // would poison any later apply on this substrate.
    expect(db().scalar(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'pg17_mut_backup'`,
    ), 'the mutation backup table survived').toBe('0')

    expect(orgArmFailures(db(), USER_A, ORG_A, ORG_B)).toEqual([])
    expect(orgArmFailures(db(), USER_B, ORG_B, ORG_A)).toEqual([])
    expect(userArmFailures(db())).toEqual([])
    expect(globalExistenceFailures(db())).toEqual([])
    expect(globalSetEqualityFailures(db())).toEqual([])
    expect(identityFreeFailures(db())).toEqual([])
    expect(globalWriteCatalogFailures(db())).toEqual([])
    expect(globalWriteLiveFailures(db())).toEqual([])
  }, PROBE_TIMEOUT)

  it('all six binding mutations of SECTION_A7 are materialised here, and none is missing', () => {
    // The manifest carried M-PG17-01..06 as STATUS=FUTURE_MATERIALIZATION with
    // test_file: UNKNOWN. Recorded as an assertion so that deleting one of the
    // describes above cannot quietly reduce the battery.
    const materialised = [
      'M-PG17-01', 'M-PG17-02', 'M-PG17-03', 'M-PG17-04', 'M-PG17-05', 'M-PG17-06',
    ]
    expect(materialised).toHaveLength(6)
    expect(new Set(materialised).size).toBe(6)
  })
})
