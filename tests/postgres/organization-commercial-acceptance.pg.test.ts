// tests/postgres/organization-commercial-acceptance.pg.test.ts
//
// L1 (HPO-ODS-W2-29) — ORACLE 1: LITERAL DATABASE INVARIANT PROBES, run
// through the CANONICAL disposable harness scripts/db-audit-disposable.ts — a
// throwaway postgres container on 127.0.0.1, ephemeral port, no bind mounts,
// teardown in `finally`, leftover check. NEVER staging, NEVER production,
// NEVER the canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently passed
// — otherwise; the anti-skip self-check lives in the sibling
// organization-commercial-acceptance-real-derivation.pg.test.ts, which is what
// the CI gate arms.
//
// ORACLE 1 PROVES THE DATABASE IS CORRECT AND SAYS NOTHING ABOUT WHETHER THE
// APPLICATION REACHES IT. Oracle 2 (the sibling file) runs the REAL exported
// resolver through a REAL authenticated connection. Both are required and
// neither substitutes for the other: a mocked client would happily accept
// every write the database refuses, so a unit test over a mock proves the
// OPPOSITE of what it appears to prove.
//
// EVERY PROBE BELOW RUNS WITH THE APPLICATION ENTIRELY BYPASSED. That is the
// point of the cross-tenant control in particular: its whole value is that it
// does not depend on the application being careful.

import { describe, expect, it, beforeAll } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import {
  runDisposableHarness,
  DEFAULT_IMAGE,
  type HarnessOutcome,
  type ProbeManifest,
} from '../../scripts/db-audit-disposable'
import {
  IDS,
  CANARY,
  ORG_V1_DIGEST,
  ORG_V2_DIGEST,
  WRONG_DIGEST,
  asUser,
  buildSetupManifestWithAcceptances,
} from './organization-commercial-acceptance-fixtures'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

/** The L1 unit, DERIVED from the live manifest — never named by ordinal. */
const L1_UNIT = BASELINE_UNITS.find((u) =>
  /^\d{4}_customer_lifecycle_l1_organization_commercial_acceptance\.sql$/.test(u.id)
)
if (!L1_UNIT) {
  throw new Error('the L1 organization-commercial-acceptance baseline unit is not registered in db/hosted/baseline-manifest.ts')
}

const RELATION = 'organization_commercial_acceptances'

/** A well-formed INSERT naming `org`/`version`/`digest`/`role`, for reuse across probes. */
function insertAcceptance(opts: {
  org: string
  version: string
  digest: string
  actor: string
  role?: string
  key?: string
}): string {
  return `INSERT INTO public.${RELATION}
     (organization_id, instrument_key, instrument_version_id, content_digest, accepted_by_user_id, accepted_by_role)
   VALUES ('${opts.org}', '${opts.key ?? 'commercial_terms'}', '${opts.version}', '${opts.digest}', '${opts.actor}', '${opts.role ?? 'organization_admin'}')`
}

export function buildProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  /**
   * Asserts that `body` raises the named SQLSTATE condition, acting as `actor`.
   *
   * THE CODE IS COMPARED, NOT THE CONDITION NAME. plpgsql's SQLSTATE variable
   * holds the five-character code ('23514'), never the readable condition name
   * ('check_violation') that RAISE ... USING ERRCODE accepts on the way in.
   * Comparing against the NAME makes every one of these controls fail for the
   * wrong reason — and, far worse, a control written the other way round
   * (`IF caught = 'check_violation' THEN ok`) would NEVER be satisfiable and
   * would therefore pass nothing while looking strict. The readable name is
   * kept in the message so a failure is legible.
   */
  const SQLSTATE_BY_CONDITION: Record<string, string> = {
    check_violation: '23514',
    foreign_key_violation: '23503',
    unique_violation: '23505',
    insufficient_privilege: '42501',
  }
  const refuses = (id: string, actor: string, body: string, condition: string, why: string) => {
    const code = SQLSTATE_BY_CONDITION[condition]
    if (!code) throw new Error(`refuses(): unknown SQLSTATE condition ${condition}`)
    add(id, asUser(actor) + `DO $w$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    ${body};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '${code}' THEN RAISE EXCEPTION '${id}: ${why} -- caught=% expected=${code} (${condition})', caught; END IF;
END $w$;
ROLLBACK;`)
  }

  /* ---------------------------------------------------------------------- */
  /* R-L1-1 .. R-L1-12 — the RLS posture                                     */
  /* ---------------------------------------------------------------------- */

  add('R-L1-1-force-rls-is-in-effect-read-from-pg_class-not-from-the-migration-text',
    `DO $w$ DECLARE e boolean; f boolean; BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO e, f
    FROM pg_class WHERE oid = 'public.${RELATION}'::regclass;
  IF e IS NOT TRUE THEN RAISE EXCEPTION 'R-L1-1 ENABLE ROW LEVEL SECURITY is not in effect'; END IF;
  IF f IS NOT TRUE THEN RAISE EXCEPTION 'R-L1-1 FORCE ROW LEVEL SECURITY is not in effect'; END IF;
END $w$;`)

  add('R-L1-2-an-active-organization_admin-of-the-rows-own-organization-may-INSERT',
    asUser(IDS.adminA) + `DO $w$ DECLARE n int; BEGIN
  ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgA}';
  IF n <> 1 THEN RAISE EXCEPTION 'R-L1-2 expected exactly one acceptance row, measured %', n; END IF;
END $w$;
ROLLBACK;`)

  add('R-L1-11-SELECT-is-organization-scoped-Org-B-never-leaks-into-an-Org-A-scoped-read',
    asUser(IDS.adminA) + `DO $w$ DECLARE n int; BEGIN
  -- Org C's acceptance (seeded by the former admin) exists, and adminA is not
  -- a member of Org C. It must be invisible.
  SELECT count(*) INTO n FROM public.${RELATION};
  IF n <> 0 THEN RAISE EXCEPTION 'R-L1-11 a non-member saw % acceptance row(s); expected 0', n; END IF;
END $w$;
ROLLBACK;`)

  add('R-L1-11b-a-member-of-the-rows-own-organization-DOES-see-it',
    asUser(IDS.formerAdmin) + `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgC}';
  IF n <> 1 THEN RAISE EXCEPTION 'R-L1-11b an own-organization member saw % row(s); expected 1', n; END IF;
END $w$;
ROLLBACK;`)

  add('R-L1-12-the-acceptance-audit-row-is-admitted-by-the-PRE-EXISTING-0042-policy',
    asUser(IDS.adminA) + `DO $w$ BEGIN
  INSERT INTO public.audit_logs (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES ('${IDS.orgA}', '${IDS.adminA}', 'organization', '${IDS.orgA}', 'legal.organization_instrument_accepted',
          jsonb_build_object('instrumentKey','commercial_terms','version',1,'contentDigest','${ORG_V1_DIGEST}'));
END $w$;
ROLLBACK;`)

  add('R-L1-12b-EXACTLY-THREE-audit_logs-INSERT-policies-remain-no-fourth-was-added',
    `DO $w$ DECLARE n int; names text; BEGIN
  SELECT count(*), string_agg(policyname, ',' ORDER BY policyname) INTO n, names
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd = 'INSERT';
  IF n <> 3 THEN RAISE EXCEPTION 'R-L1-12b expected exactly 3 audit_logs INSERT policies (0042, 0067, 0070), measured %: %', n, names; END IF;
  IF names <> 'audit_logs_insert_legal_acceptance,audit_logs_insert_member_or_admin,audit_logs_insert_tenancy_refusal'
    THEN RAISE EXCEPTION 'R-L1-12b the three audit_logs INSERT policies are not the expected ones: %', names; END IF;
END $w$;`)

  add('SEC-existing-policies-byte-unchanged-0042-0067-0070-predicate-text-is-untouched',
    `DO $w$ DECLARE c0042 text; c0067 text; c0070 text; BEGIN
  SELECT with_check INTO c0042 FROM pg_policies WHERE tablename='audit_logs' AND policyname='audit_logs_insert_member_or_admin';
  SELECT with_check INTO c0067 FROM pg_policies WHERE tablename='audit_logs' AND policyname='audit_logs_insert_tenancy_refusal';
  SELECT with_check INTO c0070 FROM pg_policies WHERE tablename='audit_logs' AND policyname='audit_logs_insert_legal_acceptance';
  -- 0042 still carries its own super-admin disjunct -- recorded, not repaired.
  -- THE AUDIT POLICY IS WIDER THAN THE ACCEPTANCE POLICY, which is precisely
  -- why an auditor reconstructing acceptances must read T4 and not audit_logs.
  IF c0042 IS NULL OR c0042 NOT LIKE '%current_user_is_super_admin()%' THEN RAISE EXCEPTION 'SEC 0042 clause changed: %', c0042; END IF;
  IF c0042 NOT LIKE '%current_user_org_ids()%' THEN RAISE EXCEPTION 'SEC 0042 clause changed: %', c0042; END IF;
  IF c0067 IS NULL OR c0067 NOT LIKE '%tenancy.%' THEN RAISE EXCEPTION 'SEC 0067 clause changed: %', c0067; END IF;
  IF c0070 IS NULL OR c0070 NOT LIKE '%legal.account_instrument_accepted%' THEN RAISE EXCEPTION 'SEC 0070 clause changed: %', c0070; END IF;
END $w$;`)

  /* ---------------------------------------------------------------------- */
  /* THE ACCEPTING PRINCIPAL — exact equality, never a threshold             */
  /* ---------------------------------------------------------------------- */

  // N-AO-26: EACH of the FOUR named non-admin roles, asserted INDIVIDUALLY.
  // Never a set-equality over the role collection, which matches 6/6 rather
  // than 5/6 and is therefore indifferent to the excluded role.
  for (const [role, actor] of [
    ['impact_manager', IDS.impactManager],
    ['analyst', IDS.analyst],
    ['reviewer', IDS.reviewer],
    ['viewer', IDS.viewer],
  ] as const) {
    refuses(
      `N-AO-26-${role}-is-refused-the-acceptance-write`,
      actor,
      insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor, role }),
      'check_violation',
      `role ${role} must not be an accepting principal`
    )
  }

  // N-AO-27: ITS OWN control, never folded into the four-role sweep. A
  // near-correct predicate gets 5 of 6 roles right and fails only on this one:
  // hasRole('super_admin','organization_admin') is 100 >= 80 = TRUE, and
  // db/schema.ts role_check PERMITS a membership row carrying super_admin.
  refuses(
    'N-AO-27-a-TENANT-super_admin-membership-is-NOT-an-accepting-principal',
    IDS.tenantSuperAdmin,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.tenantSuperAdmin, role: 'super_admin' }),
    'check_violation',
    'a membership row carrying role super_admin must be refused by EXACT EQUALITY'
  )

  refuses(
    'N-AO-27b-a-tenant-super_admin-cannot-launder-the-role-by-claiming-organization_admin',
    IDS.tenantSuperAdmin,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.tenantSuperAdmin, role: 'organization_admin' }),
    'check_violation',
    'accepted_by_role is SERVER-VERIFIED, never taken from the row as supplied'
  )

  // N-AO-23 restates the ordinary-member half over a role picked from the
  // four, as its own named control.
  refuses(
    'N-AO-23-a-non-admin-MEMBER-cannot-discharge-L1',
    IDS.viewer,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.viewer, role: 'viewer' }),
    'check_violation',
    'an active member at a role short of organization_admin must be refused'
  )

  refuses(
    'N-AO-29-a-PLATFORM-super-admin-with-NO-membership-is-refused',
    IDS.platformSuperAdmin,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.platformSuperAdmin }),
    'check_violation',
    'no platform or support path may record an organisation acceptance'
  )

  add('SEC-superadmin-context-is-not-a-write-capability-the-READ-and-the-WRITE-are-separate',
    asUser(IDS.platformSuperAdmin) + `DO $w$ DECLARE is_sa boolean; caught text := 'none'; BEGIN
  -- The platform super-admin IS confirmed as such by the database ...
  SELECT public.current_user_is_super_admin() INTO is_sa;
  IF is_sa IS NOT TRUE THEN RAISE EXCEPTION 'SEC fixture broken: the platform super-admin is not recognised'; END IF;
  -- ... and is STILL refused the acceptance INSERT, because the predicate
  -- routes through current_user_role_in_org, which carries NO super-admin
  -- disjunct. The read capability and the write capability are separate.
  BEGIN
    ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.platformSuperAdmin })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught = 'none' THEN RAISE EXCEPTION 'SEC a platform super-admin was ADMITTED the acceptance write'; END IF;
END $w$;
ROLLBACK;`)

  add('SEC-no-superadmin-disjunct-in-the-new-policies-or-the-new-trigger',
    `DO $w$ DECLARE txt text; BEGIN
  SELECT coalesce(string_agg(coalesce(qual,'') || ' ' || coalesce(with_check,''), ' '), '') INTO txt
    FROM pg_policies WHERE schemaname='public' AND tablename='${RELATION}';
  IF txt = '' THEN RAISE EXCEPTION 'SEC the new relation has no policies at all -- a vacuous zero, not a measurement'; END IF;
  IF txt LIKE '%current_user_is_super_admin%' THEN RAISE EXCEPTION 'SEC a super-admin disjunct is present in a T4 policy: %', txt; END IF;
  IF txt NOT LIKE '%current_user_role_in_org%' THEN RAISE EXCEPTION 'SEC the T4 INSERT policy does not route through current_user_role_in_org: %', txt; END IF;
  SELECT prosrc INTO txt FROM pg_proc WHERE proname = 'enforce_organization_commercial_acceptance_invariants';
  IF txt IS NULL THEN RAISE EXCEPTION 'SEC the invariants trigger function does not exist'; END IF;
  IF txt LIKE '%current_user_is_super_admin%' THEN RAISE EXCEPTION 'SEC a super-admin disjunct is present in the T4 trigger'; END IF;
END $w$;`)

  add('SEC-the-new-trigger-function-is-REVOKEd-from-PUBLIC-per-the-0033-0061-0070-precedent',
    `DO $w$ DECLARE acl text; BEGIN
  SELECT coalesce(array_to_string(proacl, ','), '') INTO acl
    FROM pg_proc WHERE proname = 'enforce_organization_commercial_acceptance_invariants';
  IF acl LIKE '%=X/%' AND acl LIKE '%"=X%' THEN RAISE EXCEPTION 'SEC EXECUTE is still granted to PUBLIC: %', acl; END IF;
  IF position('=X/' in acl) > 0 AND substring(acl from 1 for 3) = '=X/' THEN RAISE EXCEPTION 'SEC EXECUTE is still granted to PUBLIC: %', acl; END IF;
END $w$;`)

  /* ---------------------------------------------------------------------- */
  /* CROSS-TENANT — the single most important property                       */
  /* ---------------------------------------------------------------------- */

  refuses(
    'TENANT-cross-org-insert-refused-an-admin-of-Org-A-cannot-accept-for-Org-B',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgB, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA }),
    'check_violation',
    'an organization_admin of Org-A must be REFUSED BY THE DATABASE an INSERT naming Org-B'
  )

  // THE PREMISE IS ASSERTED AS OWNER, NOT INSIDE THE SCOPED SESSION. Reading
  // it as adminA measures ONE organisation, because the organizations SELECT
  // policy scopes the caller to their own memberships — so the premise check
  // would fail for a reason that has nothing to do with the property, and the
  // obvious "fix" would be to weaken it to `>= 1`, which is satisfied by the
  // caller's own organisation alone and therefore proves nothing about
  // sharing. The PREMISE and the PROPERTY are measured at different levels on
  // purpose.
  add('N-AO-12-premise-Org-A-and-Org-B-really-are-governed-by-the-SAME-CommercialAccount',
    `DO $w$ DECLARE same_ca int; BEGIN
  SELECT count(*) INTO same_ca FROM public.organizations
    WHERE id IN ('${IDS.orgA}','${IDS.orgB}') AND commercial_account_id = '${IDS.ca}';
  IF same_ca <> 2 THEN RAISE EXCEPTION 'N-AO-12 fixture broken: the two organisations do not share a CommercialAccount (%)', same_ca; END IF;
END $w$;`)

  add('N-AO-12-L1-is-PER-ORGANIZATION-not-per-CommercialAccount',
    asUser(IDS.adminA) + `DO $w$ DECLARE caught text := 'none'; BEGIN
  -- Discharge for Org A ...
  ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};

  -- ... and Org B still REFUSES, despite the shared CommercialAccount. An
  -- organisation that never accepted anything gets no PASSING L1 by
  -- inheritance (I-T4-8, CA-08).
  BEGIN
    ${insertAcceptance({ org: IDS.orgB, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught = 'none' THEN RAISE EXCEPTION 'N-AO-12 an acceptance for Org A was inherited by Org B'; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-12b-and-Org-Bs-OWN-admin-still-has-to-accept-separately',
    asUser(IDS.adminB) + `DO $w$ DECLARE n int; BEGIN
  ${insertAcceptance({ org: IDS.orgB, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminB })};
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgB}';
  IF n <> 1 THEN RAISE EXCEPTION 'N-AO-12b Org B could not record its own acceptance (%)', n; END IF;
END $w$;
ROLLBACK;`)

  // Same split, same reason: the membership rows are counted AS OWNER, because
  // the organization_members SELECT policy scopes a caller to the
  // organisations they are an ACTIVE member of — which is precisely the row
  // this premise needs to see the absence of.
  add('MULTI-MEMBERSHIP-premise-adminB-holds-TWO-membership-rows-of-which-EXACTLY-ONE-is-active',
    `DO $w$ DECLARE n_rows int; n_active int; BEGIN
  SELECT count(*) INTO n_rows FROM public.organization_members WHERE user_id = '${IDS.adminB}';
  SELECT count(*) INTO n_active FROM public.organization_members WHERE user_id = '${IDS.adminB}' AND status = 'active';
  IF n_rows <> 2 OR n_active <> 1 THEN RAISE EXCEPTION 'MULTI fixture broken: rows=% active=%', n_rows, n_active; END IF;
END $w$;`)

  add('MULTI-MEMBERSHIP-an-INACTIVE-membership-grants-nothing',
    asUser(IDS.adminB) + `DO $w$ DECLARE caught text := 'none'; BEGIN
  -- The INACTIVE membership in Org A must not admit them.
  BEGIN
    ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminB })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught = 'none' THEN RAISE EXCEPTION 'MULTI an INACTIVE membership admitted an acceptance write'; END IF;
END $w$;
ROLLBACK;`)

  /* ---------------------------------------------------------------------- */
  /* THE CROSS-TABLE GUARDS                                                 */
  /* ---------------------------------------------------------------------- */

  refuses(
    'N-AO-20-an-ACCOUNT-class-version-cannot-be-recorded-through-the-ORGANIZATION-path',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: IDS.accountVersionV1, digest: 'sha256:' + '5'.repeat(64), actor: IDS.adminA, key: 'terms_of_service' }),
    'check_violation',
    'the class guard must refuse an ACCOUNT-class version (I-T4-5)'
  )

  refuses(
    'N-AO-21-a-DIGEST-MISMATCH-is-refused-by-the-BEFORE-INSERT-trigger',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: WRONG_DIGEST, actor: IDS.adminA }),
    'check_violation',
    'the snapshotted digest must equal the referenced version digest (I-T4-4)'
  )

  refuses(
    'KEY-GUARD-a-persisted-instrument_key-that-disagrees-with-the-version-is-refused',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA, key: 'terms_of_service' }),
    'check_violation',
    'T4 persists instrument_key, so the duplicate must be closed at the boundary. The FK to '
      + 'legal_instruments is SATISFIED here (terms_of_service exists), so what refuses is the '
      + 'trigger key-agreement branch, not the constraint -- which is the point: the guard is '
      + 'about AGREEMENT with the referenced version, not about existence'
  )

  refuses(
    'FK-GUARD-a-version-id-that-references-nothing-is-refused',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: '0c120000-0000-4000-8000-00000000dead', digest: ORG_V1_DIGEST, actor: IDS.adminA }),
    'foreign_key_violation',
    'an unresolvable version must be refused'
  )

  refuses(
    'ACTOR-GUARD-accepted_by_user_id-must-BE-the-acting-subject-no-delegation',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA2 }),
    'check_violation',
    'an admin must not be able to attribute an acceptance to another admin'
  )

  refuses(
    'ROLE-SNAPSHOT-GUARD-accepted_by_role-must-BE-the-server-verified-role',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA, role: 'viewer' }),
    'check_violation',
    'a forged accepted_by_role must be refused, not stored (I-T4-7)'
  )

  refuses(
    'DIGEST-FORMAT-a-non-sha256-digest-is-refused-by-the-CHECK-constraint',
    IDS.adminA,
    insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: 'not-a-digest', actor: IDS.adminA }),
    'check_violation',
    'the digest format CHECK follows the 0070 precedent'
  )

  /* ---------------------------------------------------------------------- */
  /* APPEND-ONLY, UNIQUENESS, CONCURRENCY                                   */
  /* ---------------------------------------------------------------------- */

  add('N-AO-19-UPDATE-CHANGES-NOTHING-against-EVERY-column-and-DELETE-REMOVES-NOTHING',
    asUser(IDS.formerAdmin) + `DO $w$ DECLARE affected int; before_role text; after_role text; n_before int; n_after int; cols text[] := ARRAY[
    'organization_id = organization_id',
    'instrument_key = instrument_key',
    'instrument_version_id = instrument_version_id',
    'content_digest = content_digest',
    'accepted_by_user_id = accepted_by_user_id',
    'accepted_by_role = ''viewer''',
    'accepted_at = now()',
    'audit_log_id = NULL'
  ]; c text; BEGIN
  -- AN UPDATE THAT MATCHES ZERO ROWS IS NOT AN ERROR, and this is the trap
  -- this control is written around. With NO UPDATE policy, RLS filters the
  -- candidate set to EMPTY, so the statement SUCCEEDS having changed nothing
  -- and no trigger ever fires. A control that only asserted "an exception was
  -- raised" would therefore be RED for the runtime role while the property
  -- HOLDS -- and the tempting repair would be to delete the control. The
  -- honest assertion is that NOTHING CHANGED: zero rows affected, and the row
  -- itself byte-identical afterwards. The TRIGGER half, which does raise, is
  -- proven against the TABLE OWNER in N-AO-19b, where RLS is not in the way.
  SELECT accepted_by_role INTO before_role FROM public.${RELATION} WHERE organization_id = '${IDS.orgC}';
  SELECT count(*) INTO n_before FROM public.${RELATION};

  FOREACH c IN ARRAY cols LOOP
    BEGIN
      EXECUTE format('UPDATE public.${RELATION} SET %s WHERE organization_id = ''${IDS.orgC}''', c);
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 0 THEN RAISE EXCEPTION 'N-AO-19 UPDATE affected % row(s) on %', affected, c; END IF;
    EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '42501' THEN
      -- A raised refusal is equally acceptable: what must never happen is a
      -- MUTATION.
      NULL;
    END;
  END LOOP;

  BEGIN
    DELETE FROM public.${RELATION} WHERE organization_id = '${IDS.orgC}';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'N-AO-19 DELETE removed % row(s)', affected; END IF;
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '42501' THEN NULL;
  END;

  -- THE ROW IS UNCHANGED, and it is still there.
  SELECT accepted_by_role INTO after_role FROM public.${RELATION} WHERE organization_id = '${IDS.orgC}';
  SELECT count(*) INTO n_after FROM public.${RELATION};
  IF after_role IS DISTINCT FROM before_role THEN RAISE EXCEPTION 'N-AO-19 the snapshot moved: % -> %', before_role, after_role; END IF;
  IF n_after <> n_before THEN RAISE EXCEPTION 'N-AO-19 the row count moved: % -> %', n_before, n_after; END IF;
  IF n_before < 1 THEN RAISE EXCEPTION 'N-AO-19 vacuous: there was no row to attempt to mutate'; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-19b-append-only-binds-the-TABLE-OWNER-too-not-only-the-runtime-role',
    `DO $w$ DECLARE caught text := 'none'; BEGIN
  -- Run as the harness superuser, with RLS out of the picture entirely. The
  -- uellix_forbid_mutation() trigger is what refuses here, which is why an
  -- omitted policy alone would NOT be sufficient evidence.
  BEGIN
    UPDATE public.${RELATION} SET accepted_by_role = 'viewer';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught = 'none' THEN RAISE EXCEPTION 'N-AO-19b the table owner UPDATEd an append-only relation'; END IF;
  caught := 'none';
  BEGIN
    DELETE FROM public.${RELATION};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught = 'none' THEN RAISE EXCEPTION 'N-AO-19b the table owner DELETEd from an append-only relation'; END IF;
END $w$;`)

  add('N-AO-19c-there-is-NO-UPDATE-and-NO-DELETE-policy-on-the-relation',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_policies
    WHERE schemaname='public' AND tablename='${RELATION}' AND cmd IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'N-AO-19c expected zero UPDATE/DELETE policies, measured %', n; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='${RELATION}';
  IF n <> 2 THEN RAISE EXCEPTION 'N-AO-19c expected exactly 2 policies (SELECT, INSERT), measured %', n; END IF;
END $w$;`)

  add('BIND-already-accepted-refused-the-I-T4-1-unique-constraint-raises-23505',
    asUser(IDS.adminA) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};
  BEGIN
    ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'BIND-already-accepted caught=% expected=23505', caught; END IF;
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgA}';
  IF n <> 1 THEN RAISE EXCEPTION 'BIND-already-accepted produced % rows; expected exactly 1', n; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-17-TWO-DIFFERENT-admins-accepting-the-SAME-version-yield-EXACTLY-ONE-row',
    asUser(IDS.adminA) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  -- THE FIRST eligible organization_admin accepts.
  ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};

  -- THE IDENTITY IS SWITCHED IN PLACE, and the probe stays in ONE
  -- transaction that ROLLS BACK. The obvious shape -- commit as admin A, then
  -- open a second session as admin A2 -- would leave a COMMITTED row behind,
  -- and this relation is APPEND-ONLY FOR EVERYONE INCLUDING THE OWNER, so
  -- that row could never be removed for the life of the container. It would
  -- silently poison every later probe that asserts Org A has no acceptance
  -- (N-AO-11 and M-AO-14 both do). set_config(..., true) is transaction-local
  -- and auth.uid() reads request.jwt.claims, so this IS a different acting
  -- subject as far as every policy and every trigger is concerned.
  PERFORM set_config('request.jwt.claims', '{"sub":"${IDS.adminA2}","role":"authenticated"}', true);
  IF auth.uid() <> '${IDS.adminA2}'::uuid THEN RAISE EXCEPTION 'N-AO-17 the identity switch did not take effect'; END IF;

  -- A DIFFERENT eligible organization_admin of the SAME organisation. The
  -- LOSER receives a constraint violation, never a silent success, and the
  -- second acceptance adds NO new fact.
  BEGIN
    ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA2 })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'N-AO-17 the second admin caught=% expected=23505', caught; END IF;
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgA}';
  IF n <> 1 THEN RAISE EXCEPTION 'N-AO-17 expected exactly one row after two admins accepted, measured %', n; END IF;
END $w$;
ROLLBACK;`)

  add('UNIQUE-DIMENSION-is-ORGANIZATION-plus-VERSION-never-CommercialAccount-level',
    `DO $w$ DECLARE cols text; BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = 'public.${RELATION}'::regclass AND i.indisunique AND NOT i.indisprimary
   GROUP BY c.relname;
  IF cols IS DISTINCT FROM 'organization_id,instrument_version_id'
    THEN RAISE EXCEPTION 'UNIQUE-DIMENSION expected organization_id,instrument_version_id, measured %', cols; END IF;
END $w$;`)

  add('M-AO-13-there-is-NO-is_current-NO-is_valid-and-NO-stored-currency-flag',
    `DO $w$ DECLARE cols text; BEGIN
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO cols
    FROM information_schema.columns WHERE table_schema='public' AND table_name='${RELATION}';
  IF cols IS DISTINCT FROM 'accepted_at,accepted_by_role,accepted_by_user_id,audit_log_id,content_digest,id,instrument_key,instrument_version_id,organization_id'
    THEN RAISE EXCEPTION 'M-AO-13 the column set is not the authorised one: %', cols; END IF;
END $w$;`)

  add('M-AO-24-the-evidence-floor-holds-WITHOUT-a-mandatory-hash-algorithm-column',
    `DO $w$ DECLARE n int; BEGIN
  -- R4 WITHDREW the algorithm-storage shape from the required floor, requiring
  -- only that the hash be VERIFIABLE. The self-describing 'sha256:<hex>'
  -- digest delivers that with NO separately persisted algorithm column, and an
  -- implementation holding exactly the floor elements must remain conformant.
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='${RELATION}'
      AND column_name IN ('hash_algorithm','digest_algorithm','algorithm');
  IF n <> 0 THEN RAISE EXCEPTION 'M-AO-24 a hash-algorithm column was made mandatory (% found)', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint
    WHERE conrelid = 'public.${RELATION}'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%sha256:%';
  IF n <> 1 THEN RAISE EXCEPTION 'M-AO-24 the self-describing digest CHECK is missing (% found)', n; END IF;
END $w$;`)

  /* ---------------------------------------------------------------------- */
  /* HISTORY — the role snapshot                                            */
  /* ---------------------------------------------------------------------- */

  add('HISTORY-role-snapshot-preserved-after-the-actor-is-demoted',
    `DO $w$ DECLARE snap text; live text; BEGIN
  SELECT accepted_by_role INTO snap FROM public.${RELATION} WHERE organization_id = '${IDS.orgC}';
  SELECT role INTO live FROM public.organization_members WHERE organization_id='${IDS.orgC}' AND user_id='${IDS.formerAdmin}';
  IF snap <> 'organization_admin' THEN RAISE EXCEPTION 'HISTORY the snapshot moved: %', snap; END IF;
  IF live <> 'viewer' THEN RAISE EXCEPTION 'HISTORY fixture broken: the actor was not demoted (%)', live; END IF;
END $w$;`)

  add('HISTORY-former-admin-passes-the-acceptance-row-still-stands-after-the-role-is-lost',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.${RELATION}
   WHERE organization_id = '${IDS.orgC}' AND instrument_version_id = '${IDS.orgVersionV1}';
  IF n <> 1 THEN RAISE EXCEPTION 'HISTORY the acceptance did not survive the demotion (%)', n; END IF;
END $w$;`)

  /* ---------------------------------------------------------------------- */
  /* REGISTRY DIMENSIONS — applicability, not publication                    */
  /* ---------------------------------------------------------------------- */

  add('BIND-not-yet-effective-refused-publication-is-NOT-applicability',
    asUser(IDS.adminA) + `DO $w$ DECLARE n int; BEGIN
  -- commercial_terms v2 is PUBLISHED and marked reaccept_required, but its
  -- effective_at is in the FUTURE, so it is not in the currently applicable
  -- set. The application refuses it before any insert is attempted; here the
  -- REGISTRY FACT the refusal rests on is asserted directly.
  SELECT count(*) INTO n FROM public.legal_instrument_versions
   WHERE id = '${IDS.orgVersionV2Pre}' AND effective_at > now() AND reaccept_required;
  IF n <> 1 THEN RAISE EXCEPTION 'BIND-not-yet-effective fixture broken (%)', n; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-31-once-effective_at-has-PASSED-with-reaccept_required-there-is-no-grace-window',
    asUser(IDS.adminA) + `DO $w$ DECLARE applicable int; BEGIN
  -- The currently applicable set is computed from effective_at alone: there is
  -- no grace column, no per-organisation override and no deferral anywhere on
  -- this relation or on the registry.
  SELECT count(*) INTO applicable FROM public.legal_instrument_versions
   WHERE instrument_key = 'commercial_terms' AND (effective_at IS NULL OR effective_at <= now());
  IF applicable <> 1 THEN RAISE EXCEPTION 'N-AO-31 expected exactly one currently applicable version, measured %', applicable; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-31b-NO-grace-or-deferral-column-exists-on-the-registry-or-the-acceptance-relation',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name IN ('${RELATION}','legal_instrument_versions')
     AND (column_name LIKE '%grace%' OR column_name LIKE '%defer%' OR column_name LIKE '%override%');
  IF n <> 0 THEN RAISE EXCEPTION 'N-AO-31b a grace/deferral column exists (%)', n; END IF;
END $w$;`)

  add('N-AO-2-a-repurposed-timestamp-is-NOT-acceptance-evidence',
    asUser(IDS.adminA) + `DO $w$ DECLARE n int; BEGIN
  -- Org A has NO acceptance row. Whatever other timestamps exist about its
  -- members, none of them is an acceptance (I-X-4).
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgA}';
  IF n <> 0 THEN RAISE EXCEPTION 'N-AO-2 fixture broken: Org A already has an acceptance row (%)', n; END IF;
END $w$;
ROLLBACK;`)

  add('I-X-5-NO-denormalised-acceptance-column-was-added-to-any-existing-relation',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public'
     AND table_name IN ('organizations','users','organization_members','commercial_accounts')
     AND (column_name LIKE '%acceptance%' OR column_name LIKE '%accepted%');
  IF n <> 0 THEN RAISE EXCEPTION 'I-X-5 a denormalised acceptance column exists (%)', n; END IF;
END $w$;`)

  /* ---------------------------------------------------------------------- */
  /* AUDIT — the content-leak prohibition and the refusal silence            */
  /* ---------------------------------------------------------------------- */

  add('N-AO-3-S-L1-NO-INSTRUMENT-TEXT-IN-AUDIT-the-canary-never-reaches-audit_logs',
    asUser(IDS.adminA) + `DO $w$ DECLARE leaked int; identified int; body text; BEGIN
  -- The synthetic instrument body carries a unique canary. Accept it, write
  -- the audit row exactly as the action does, then look for the canary in
  -- EVERY audit_logs column -- before_json, after_json and the rest.
  SELECT content_bytes INTO body FROM public.legal_instrument_versions WHERE id = '${IDS.orgVersionV1}';
  IF body NOT LIKE '%${CANARY}%' THEN RAISE EXCEPTION 'N-AO-3 fixture broken: the canary is not in the instrument body'; END IF;

  ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.adminA })};
  INSERT INTO public.audit_logs (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES ('${IDS.orgA}', '${IDS.adminA}', 'organization', '${IDS.orgA}', 'legal.organization_instrument_accepted',
          jsonb_build_object('instrumentKey','commercial_terms','version',1,'contentDigest','${ORG_V1_DIGEST}'));

  SELECT count(*) INTO leaked FROM public.audit_logs a
   WHERE a.action = 'legal.organization_instrument_accepted'
     AND (coalesce(a.after_json::text,'') LIKE '%${CANARY}%'
       OR coalesce(a.before_json::text,'') LIKE '%${CANARY}%'
       OR coalesce(a.reason,'') LIKE '%${CANARY}%'
       OR coalesce(a.entity_type,'') LIKE '%${CANARY}%');
  IF leaked <> 0 THEN RAISE EXCEPTION 'N-AO-3 the instrument body LEAKED into audit_logs (% row(s))', leaked; END IF;

  -- POSITIVE HALF: the identifying facts ARE there. A negative alone would
  -- pass over an audit row that carried nothing at all.
  SELECT count(*) INTO identified FROM public.audit_logs a
   WHERE a.action = 'legal.organization_instrument_accepted'
     AND a.after_json::text LIKE '%commercial_terms%'
     AND a.after_json::text LIKE '%${ORG_V1_DIGEST}%';
  IF identified <> 1 THEN RAISE EXCEPTION 'N-AO-3 the audit row does not identify the instrument (%)', identified; END IF;
END $w$;
ROLLBACK;`)

  add('AUDIT-no-refusal-rows-a-refused-acceptance-writes-ZERO-audit-rows',
    asUser(IDS.viewer) + `DO $w$ DECLARE before_n int; after_n int; caught text := 'none'; BEGIN
  SELECT count(*) INTO before_n FROM public.audit_logs WHERE action = 'legal.organization_instrument_accepted';
  BEGIN
    ${insertAcceptance({ org: IDS.orgA, version: IDS.orgVersionV1, digest: ORG_V1_DIGEST, actor: IDS.viewer, role: 'viewer' })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught = 'none' THEN RAISE EXCEPTION 'AUDIT-no-refusal-rows the refusal did not happen'; END IF;
  SELECT count(*) INTO after_n FROM public.audit_logs WHERE action = 'legal.organization_instrument_accepted';
  IF after_n <> before_n THEN RAISE EXCEPTION 'AUDIT-no-refusal-rows a refusal wrote an audit row (% -> %)', before_n, after_n; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-11-ORGANIZATION_PENDING_COMMERCIAL_ACCEPTANCE-is-a-legitimate-state-not-a-partial-failure',
    `DO $w$ DECLARE org int; mem int; ca int; acc int; BEGIN
  -- After AB-2 commits and BEFORE AB-3 happens, the organisation, its
  -- founder's organization_admin membership and its CommercialAccount
  -- association are ALL fully present and consistent. The window is REAL,
  -- LEGITIMATE and UNAVOIDABLE and must be HANDLED, not eliminated.
  SELECT count(*) INTO org FROM public.organizations WHERE id = '${IDS.orgA}' AND status = 'active';
  SELECT count(*) INTO mem FROM public.organization_members
    WHERE organization_id = '${IDS.orgA}' AND user_id = '${IDS.adminA}' AND role = 'organization_admin' AND status = 'active';
  SELECT count(*) INTO ca FROM public.organizations WHERE id = '${IDS.orgA}' AND commercial_account_id = '${IDS.ca}';
  SELECT count(*) INTO acc FROM public.${RELATION} WHERE organization_id = '${IDS.orgA}';
  IF org <> 1 OR mem <> 1 OR ca <> 1 THEN RAISE EXCEPTION 'N-AO-11 the pre-acceptance state is not consistent (org=% mem=% ca=%)', org, mem, ca; END IF;
  IF acc <> 0 THEN RAISE EXCEPTION 'N-AO-11 an acceptance already exists, so the window was not observed (%)', acc; END IF;
END $w$;`)

  add('M-AO-14-the-acceptance-is-NOT-folded-into-the-AB-2-bootstrap',
    `DO $w$ DECLARE n int; BEGIN
  -- Org A and Org B were both founded with an organization_admin and a
  -- CommercialAccount, and NEITHER has an acceptance row. If AB-3 had been
  -- folded into AB-2, founding would have produced one.
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id IN ('${IDS.orgA}','${IDS.orgB}');
  IF n <> 0 THEN RAISE EXCEPTION 'M-AO-14 founding produced an acceptance row (%)', n; END IF;
END $w$;`)

  return { probes }
}

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)(
  'L1 organization commercial acceptance — real PostgreSQL (canonical disposable harness)',
  { timeout: 1_200_000 },
  () => {
    let outcome: HarnessOutcome

    beforeAll(() => {
      outcome = runDisposableHarness({
        image: DEFAULT_IMAGE,
        setup: buildSetupManifestWithAcceptances(),
        probe: buildProbeManifest(),
      })
      console.log(
        `L1_PG_OUTCOME=${JSON.stringify({
          setupStatus: outcome.setupStatus,
          probeStatus: outcome.probeStatus,
          probeCount: outcome.probeCount,
          probeFailureCount: outcome.probeFailureCount,
          teardownStatus: outcome.teardownStatus,
          leftoverDatabaseCount: outcome.leftoverDatabaseCount,
          lifecycleState: outcome.lifecycleState,
          failureReason: outcome.failureReason,
          failed: outcome.probeResults.filter((p) => !p.ok).map((p) => ({ id: p.id, detail: p.detail })),
        })}`
      )
    }, 1_200_000)

    it('the L1 unit is the CURRENT TAIL of the baseline, immediately after the CL-1 content-bytes unit', () => {
      const index = BASELINE_UNITS.indexOf(L1_UNIT!)
      expect(index).toBe(BASELINE_UNITS.length - 1)
      expect(BASELINE_UNITS[index - 1].id).toBe('0071_customer_lifecycle_cl1_content_bytes.sql')
    })

    it(`the harness provisioned the full baseline (${BASELINE_UNITS.length} units, L1 included) and tore itself down with zero leftovers`, () => {
      expect(outcome.failureReason).toBeNull()
      expect(outcome.setupStatus).toBe('SUCCESS')
      expect(outcome.teardownStatus).toBe('SUCCESS')
      expect(outcome.leftoverDatabaseCount).toBe(0)
      expect(outcome.lifecycleState).toBe('VERIFIED_GONE')
      expect(outcome.targetLocality).toBe('LOCAL')
    })

    it('ran every probe, in the declared order', () => {
      expect(outcome.probeResults.map((p) => p.id)).toEqual(EXPECTED_PROBE_IDS)
    })

    it.each(EXPECTED_PROBE_IDS)('%s', (id) => {
      const probe = outcome.probeResults.find((p) => p.id === id)
      expect(probe, `probe ${id} did not run`).toBeDefined()
      expect(probe!.detail ?? '').toBe('')
      expect(probe!.ok).toBe(true)
    })

    it('POSTGRES_FAILURES=0 (harness verdict)', () => {
      expect(outcome.probeFailureCount).toBe(0)
      expect(outcome.harnessStatus).toBe('SUCCESS')
    })
  }
)
