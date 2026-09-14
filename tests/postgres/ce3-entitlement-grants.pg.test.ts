// tests/postgres/ce3-entitlement-grants.pg.test.ts
//
// CE-3 (HPO-ODS-W2-30) — the TWELVE required real-PostgreSQL probes for
// entitlement_grants and public.entitlement_effective, run through the
// CANONICAL disposable harness scripts/db-audit-disposable.ts: a throwaway
// container on 127.0.0.1, ephemeral port, no bind mounts, teardown in
// `finally`, leftover check. NEVER staging, NEVER production, NEVER the
// canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently passed —
// otherwise. The anti-skip self-check at the bottom of this file is UNGATED and
// is armed by UELLIX_CE3_PG_REQUIRED=1 in the dedicated CI gate.
//
// ---------------------------------------------------------------------------
// WHY STATIC READING OF THE MIGRATION IS NOT PROOF FOR ANY OF THESE TWELVE
// ---------------------------------------------------------------------------
// Partial-index behaviour under CONCURRENCY, RLS policy combination, definer
// GUC resolution, NULL-not-TRUE denial and effective-privilege inheritance are
// RUNTIME properties. FORCE ROW LEVEL SECURITY in particular is SILENTLY INERT
// for a BYPASSRLS role and for the table owner, so "the migration says FORCE"
// is not evidence that anybody is actually denied. Every claim below is
// measured on a real cluster, as a real role.
//
// EVERY PROBE RUNS WITH THE APPLICATION ENTIRELY BYPASSED. That is the point of
// the cross-organization and append-only controls especially: their whole value
// is that they do not depend on any TypeScript being careful.

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
  CAPABILITY,
  UNDECLARED_CAPABILITY,
  asAuthenticated,
  asAppRole,
  buildSetupManifest,
} from './ce3-entitlement-grants-fixtures'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

/** The CE-3 unit, DERIVED from the live manifest — never named by ordinal. */
const CE3_UNIT = BASELINE_UNITS.find((u) =>
  /^\d{4}_commercial_account_ce3_entitlement_grants\.sql$/.test(u.id)
)
if (!CE3_UNIT) {
  throw new Error('the CE-3 entitlement-grants baseline unit is not registered in db/hosted/baseline-manifest.ts')
}

const RELATION = 'entitlement_grants'
const FN = 'public.entitlement_effective'
const FN_SIG = 'public.entitlement_effective(uuid,varchar)'

export function buildProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  /**
   * THE CODE IS COMPARED, NOT THE CONDITION NAME. plpgsql's SQLSTATE variable
   * holds the five-character code ('23514'), never the readable condition name
   * ('check_violation') that RAISE ... USING ERRCODE accepts on the way IN.
   * A control written the other way round (`IF caught = 'check_violation'`)
   * would never be satisfiable and would therefore prove nothing while looking
   * strict. The readable name is kept in the message so a failure is legible.
   */
  const SQLSTATE_BY_CONDITION: Record<string, string> = {
    check_violation: '23514',
    foreign_key_violation: '23503',
    unique_violation: '23505',
    insufficient_privilege: '42501',
    not_null_violation: '23502',
    undefined_table: '42P01',
    // CE-3's two bespoke refusals. Already five-character codes.
    cross_organization: 'U0113',
    undeclared_capability: 'U0114',
  }

  /** Asserts that `body` raises the named SQLSTATE, acting as `actor`. */
  const refuses = (id: string, prelude: string, body: string, condition: string, why: string) => {
    const code = SQLSTATE_BY_CONDITION[condition]
    if (!code) throw new Error(`refuses(): unknown SQLSTATE condition ${condition}`)
    add(id, prelude + `DO $w$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    ${body};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '${code}' THEN RAISE EXCEPTION '${id}: ${why} -- caught=% expected=${code} (${condition})', caught; END IF;
END $w$;
ROLLBACK;`)
  }

  /** A well-formed INSERT, for reuse. Every column is named explicitly. */
  const insertGrant = (o: {
    org: string
    cap?: string
    source?: string
    account?: string | null
    limitKind?: string
    limitValue?: string
    from?: string
    to?: string
    reason?: string
  }) =>
    `INSERT INTO public.${RELATION}
       (organization_id, capability_key, source, commercial_account_id, limit_kind, limit_value, effective_from, effective_to, reason)
     VALUES ('${o.org}', '${o.cap ?? CAPABILITY}', '${o.source ?? 'PLAN'}',
             ${o.account === null ? 'NULL' : `'${o.account ?? IDS.caX}'`},
             '${o.limitKind ?? 'CAPPED'}', ${o.limitValue ?? '5'},
             ${o.from ?? `now() - interval '1 hour'`}, ${o.to ?? 'NULL'},
             ${o.reason ? `'${o.reason}'` : 'NULL'})`

  /**
   * Asserts the evaluator's answer for `actor` asking about `org`/`cap`.
   * Compares BOTH the kind and the limit_value, because "returned some row"
   * and "returned the RIGHT row" are different claims.
   */
  const answers = (id: string, actor: string, org: string, cap: string, kind: string, limit: string, why: string) =>
    add(id, asAuthenticated(actor) + `DO $w$ DECLARE k text; v integer; n int; BEGIN
  SELECT count(*) INTO n FROM ${FN}('${org}'::uuid, '${cap}'::varchar);
  IF n <> 1 THEN RAISE EXCEPTION '${id}: expected EXACTLY ONE semantic answer row, measured %', n; END IF;
  SELECT kind, limit_value INTO k, v FROM ${FN}('${org}'::uuid, '${cap}'::varchar);
  IF k IS DISTINCT FROM '${kind}' THEN RAISE EXCEPTION '${id}: ${why} -- kind=% expected=${kind}', k; END IF;
  IF v IS DISTINCT FROM ${limit} THEN RAISE EXCEPTION '${id}: ${why} -- limit_value=% expected=${limit}', v; END IF;
END $w$;
ROLLBACK;`)

  /* ====================================================================== */
  /* PG-4 — the partial unique index refuses a second LIVE grant under       */
  /*        GENUINE CONCURRENCY, and close-then-replace is expressible.      */
  /* ====================================================================== */
  //
  // A SEQUENTIAL SECOND INSERT IS REFUSED BY ANY IMPLEMENTATION, including one
  // whose only guard is an application-side SELECT-then-INSERT — which is
  // precisely what a concurrent pair defeats. So a sequential assertion cannot
  // distinguish a correct implementation from the defective one MUT-2
  // describes, and would leave mutation CE3-M-1 (drop the partial index)
  // GREEN. dblink gives two genuine backend sessions.
  //
  // dblink_is_busy IS THE LOAD-BEARING ASSERTION. It proves session 2 reached
  // its INSERT and BLOCKED on the index while session 1 was still uncommitted
  // — i.e. that both really raced. A read-then-write guard would NOT block: it
  // would see zero live rows and succeed, and the pair would commit two live
  // grants. Only after that is established does session 1 commit and session 2
  // collect its 23505.
  //
  // Runs in OrgK, a scratch organization no other probe touches, because this
  // is the ONE probe that must COMMIT.
  add('PG-4-partial-unique-index-refuses-a-second-LIVE-grant-under-genuine-concurrency', `CREATE EXTENSION IF NOT EXISTS dblink;
DO $c$ DECLARE conn text := 'dbname=' || current_database() || ' user=postgres'; busy int; n int; caught text := 'none'; msg text := ''; BEGIN
  PERFORM dblink_connect('ce3c1', conn);
  PERFORM dblink_connect('ce3c2', conn);
  PERFORM dblink_exec('ce3c1', 'BEGIN');
  PERFORM dblink_exec('ce3c2', 'BEGIN');
  PERFORM dblink_exec('ce3c1', $q$${insertGrant({ org: IDS.orgK, limitKind: 'CAPPED', limitValue: '11' })}$q$);
  PERFORM dblink_send_query('ce3c2', $q$${insertGrant({ org: IDS.orgK, limitKind: 'UNMETERED', limitValue: 'NULL' })}$q$);
  PERFORM pg_sleep(1.5);
  SELECT dblink_is_busy('ce3c2') INTO busy;
  IF busy <> 1 THEN RAISE EXCEPTION 'PG-4 the second LIVE grant did NOT block on the partial unique index (busy=%) -- an application pre-check, not a database guarantee', busy; END IF;
  PERFORM dblink_exec('ce3c1', 'COMMIT');
  BEGIN
    PERFORM * FROM dblink_get_result('ce3c2') AS t(r text);
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'PG-4 the losing session caught=% expected=23505 from the partial unique index (%)', caught, msg; END IF;
  BEGIN PERFORM * FROM dblink_get_result('ce3c2') AS t(r text); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM dblink_exec('ce3c2', 'ROLLBACK');
  PERFORM dblink_disconnect('ce3c1');
  PERFORM dblink_disconnect('ce3c2');
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgK}' AND effective_to IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'PG-4 expected EXACTLY ONE live grant for OrgK, measured %', n; END IF;
END $c$;
-- CLOSE-THEN-REPLACE, the additional shape CONCURRENCY_CONTRACT requires:
-- closing the live row and inserting its replacement must not transiently admit
-- two live rows, nor leave zero where one was expected. The close is a
-- legitimate NULL -> timestamp transition and must SUCCEED -- this is the
-- positive half that proves the append-only guard has not simply frozen the
-- relation.
DO $r$ DECLARE n int; k text; BEGIN
  UPDATE public.${RELATION} SET effective_to = now()
    WHERE organization_id = '${IDS.orgK}' AND effective_to IS NULL;
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgK}' AND effective_to IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'PG-4 close left % live rows, expected 0', n; END IF;
  ${insertGrant({ org: IDS.orgK, limitKind: 'BLOCKED', limitValue: 'NULL', from: 'now()' })};
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgK}' AND effective_to IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'PG-4 replacement left % live rows, expected exactly 1', n; END IF;
  SELECT limit_kind INTO k FROM public.${RELATION} WHERE organization_id = '${IDS.orgK}' AND effective_to IS NULL;
  IF k <> 'BLOCKED' THEN RAISE EXCEPTION 'PG-4 the live row is % , expected the REPLACEMENT (BLOCKED)', k; END IF;
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgK}';
  IF n <> 2 THEN RAISE EXCEPTION 'PG-4 expected 2 historical rows for OrgK (closed + replacement), measured %', n; END IF;
END $r$;`)

  /* ====================================================================== */
  /* PG-7 — a cross-organization request RAISES, and never returns an empty  */
  /*        set. Plus the direct-SQL undeclared-capability defence in depth.  */
  /* ====================================================================== */
  //
  // THE ASSERTION IS ON THE FAILURE CODE, NEVER ON ABSENCE. An empty result and
  // a refusal are indistinguishable to a test written on absence, and an
  // evaluator that quietly substituted the caller's own Organization would
  // return a NON-EMPTY and entirely WRONG answer that an absence-based test
  // would also pass. This is why SC-12 forbids delegating the refusal to RLS
  // filtering, and it is mutation CE3-M-3.
  refuses('PG-7a-cross-organization-request-RAISES-U0113-and-does-not-return-an-empty-set',
    asAuthenticated(IDS.adminA),
    `PERFORM * FROM ${FN}('${IDS.orgC}'::uuid, '${CAPABILITY}'::varchar)`,
    'cross_organization',
    'an OrgA-scoped principal asking about OrgC must RAISE, not return rows and not return an empty set')

  // OrgC HOLDS A REAL LIVE GRANT (BLOCKED). A probe that returned nothing for
  // want of data would prove nothing at all, so the refusal above is measured
  // against a populated, non-scoped organization.
  add('PG-7b-the-non-scoped-organization-really-does-hold-a-live-grant-so-7a-is-not-vacuous',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgC}' AND effective_to IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'PG-7b OrgC must hold exactly one live grant for PG-7a to mean anything, measured %', n; END IF;
END $w$;`)

  refuses('PG-7c-a-NON-EXISTENT-organization-raises-the-SAME-U0113-and-is-not-distinguishable',
    asAuthenticated(IDS.adminA),
    `PERFORM * FROM ${FN}('${IDS.nonExistentOrg}'::uuid, '${CAPABILITY}'::varchar)`,
    'cross_organization',
    'an organization that exists in no row must be refused identically to one that exists but is out of scope')

  refuses('PG-7d-the-SIBLING-organization-under-the-SAME-commercial-account-is-also-refused',
    asAuthenticated(IDS.adminA),
    `PERFORM * FROM ${FN}('${IDS.orgB}'::uuid, '${CAPABILITY}'::varchar)`,
    'cross_organization',
    'shared commercial governance must NOT imply shared entitlement visibility (SC-4)')

  refuses('PG-7e-a-scopeless-PLATFORM-super-admin-is-refused-too-CE3-invents-no-bypass',
    asAuthenticated(IDS.platformSuperAdmin),
    `PERFORM * FROM ${FN}('${IDS.orgA}'::uuid, '${CAPABILITY}'::varchar)`,
    'cross_organization',
    'CE-3 invents no super-admin bypass and infers no role hierarchy')

  // THE UNIFORMITY OF THE REFUSAL, asserted rather than assumed. All four
  // cross-organization shapes must produce the IDENTICAL message with no
  // DETAIL, no HINT, no organization id, no capability key and no canary.
  add('PG-7f-every-cross-organization-refusal-carries-the-IDENTICAL-fixed-message-and-leaks-nothing',
    asAuthenticated(IDS.adminA) + `DO $w$
DECLARE msgs text[] := '{}'; m text; d text; h text; seen text;
BEGIN
  FOR seen IN SELECT unnest(ARRAY['${IDS.orgB}','${IDS.orgC}','${IDS.nonExistentOrg}']) LOOP
    BEGIN
      PERFORM * FROM ${FN}(seen::uuid, '${CAPABILITY}'::varchar);
      RAISE EXCEPTION 'PG-7f % was NOT refused', seen;
    EXCEPTION WHEN sqlstate 'U0113' THEN
      GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL, h = PG_EXCEPTION_HINT;
      msgs := msgs || m;
      IF coalesce(d,'') <> '' THEN RAISE EXCEPTION 'PG-7f refusal carried a DETAIL: %', d; END IF;
      IF coalesce(h,'') <> '' THEN RAISE EXCEPTION 'PG-7f refusal carried a HINT: %', h; END IF;
      IF m LIKE '%' || seen || '%' THEN RAISE EXCEPTION 'PG-7f refusal ECHOED the organization id: %', m; END IF;
      IF m LIKE '%${CAPABILITY}%' THEN RAISE EXCEPTION 'PG-7f refusal ECHOED the capability key: %', m; END IF;
      IF m LIKE '%${CANARY}%' THEN RAISE EXCEPTION 'PG-7f refusal LEAKED the sibling canary: %', m; END IF;
    END;
  END LOOP;
  IF (SELECT count(DISTINCT x) FROM unnest(msgs) AS x) <> 1 THEN
    RAISE EXCEPTION 'PG-7f the refusals are DISTINGUISHABLE by message: %', msgs;
  END IF;
END $w$;
ROLLBACK;`)

  // DEFENCE IN DEPTH, AND THE COORDINATOR-DERIVED CONTROL. EXECUTE on the
  // evaluator is granted to `authenticated`, so a caller can invoke the SQL
  // function DIRECTLY and never reach the TypeScript pre-check. The undeclared
  // key must be refused HERE, at the database, with its own SQLSTATE. A
  // TypeScript-only catalogue guard does NOT satisfy this control, and removing
  // the SQL-side check while leaving TypeScript intact is mutation 17.
  refuses('PG-7g-an-UNDECLARED-capability-raises-U0114-at-the-DATABASE-even-for-an-IN-SCOPE-caller',
    asAuthenticated(IDS.adminA),
    `PERFORM * FROM ${FN}('${IDS.orgA}'::uuid, '${UNDECLARED_CAPABILITY}'::varchar)`,
    'undeclared_capability',
    'an undeclared capability must be REFUSED at the SQL boundary, never collapsed to NO_LIVE_GRANT')

  // AND IT MUST NOT BECOME A CATALOGUE ORACLE. An OUT-OF-SCOPE caller asking
  // about an undeclared key must still get U0113 — the SCOPE refusal — because
  // the scope guard runs FIRST. If the capability were validated first, a
  // caller with no scope anywhere could enumerate the product's capability
  // vocabulary by watching which code came back.
  refuses('PG-7h-an-OUT-OF-SCOPE-caller-asking-an-UNDECLARED-key-still-gets-U0113-not-U0114',
    asAuthenticated(IDS.adminA),
    `PERFORM * FROM ${FN}('${IDS.orgC}'::uuid, '${UNDECLARED_CAPABILITY}'::varchar)`,
    'cross_organization',
    'the scope guard must precede the capability guard so the evaluator cannot be used as a catalogue oracle')

  /* ====================================================================== */
  /* PG-CE3-SEC3 — ENTITLEMENT DOES NOT IMPLY AUTHORIZATION.                 */
  /* ====================================================================== */
  add('PG-CE3-SEC3-a-live-grant-confers-no-membership-no-role-and-no-tenant-read',
    `BEGIN;
DO $w$ DECLARE before_n int; after_n int; role_n int; BEGIN
  SELECT count(*) INTO before_n FROM public.organization_members WHERE organization_id = '${IDS.orgD}';
  ${insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'UNMETERED', limitValue: 'NULL' })};
  SELECT count(*) INTO after_n FROM public.organization_members WHERE organization_id = '${IDS.orgD}';
  IF before_n <> after_n THEN RAISE EXCEPTION 'SEC3 inserting a grant changed organization_members: % -> %', before_n, after_n; END IF;
  -- entitlement_grants references organization_members NOT AT ALL and carries
  -- no role column (SC-13). Measured from the catalogue, not read off the DDL.
  SELECT count(*) INTO role_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='${RELATION}' AND column_name IN ('role','member_id','user_role','organization_member_id');
  IF role_n <> 0 THEN RAISE EXCEPTION 'SEC3 the relation carries % membership/role column(s)', role_n; END IF;
END $w$;
ROLLBACK;`)

  // A NON-MEMBER OF OrgA GETS NOTHING FROM OrgA'S LIVE GRANT. The outsider
  // holds no membership anywhere, so the evaluator refuses them for scope —
  // the grant does not make them a tenant.
  refuses('PG-CE3-SEC3-a-subject-with-no-membership-gains-nothing-from-an-existing-grant',
    asAuthenticated(IDS.outsider),
    `PERFORM * FROM ${FN}('${IDS.orgA}'::uuid, '${CAPABILITY}'::varchar)`,
    'cross_organization',
    'a live grant for OrgA must give a non-member of OrgA no ability to act in OrgA')

  /* ====================================================================== */
  /* PG-CE3-SEC4 — MEMBERSHIP DOES NOT IMPLY ENTITLEMENT.                    */
  /* ====================================================================== */
  //
  // THE FIXTURE ACTIVELY EXCLUDES A ROLE-BASED EXPLANATION. adminD holds an
  // ACTIVE organization_admin membership in OrgD — the HIGHEST tenant role this
  // schema's role_check admits short of the tenant super_admin value — so the
  // NO_LIVE_GRANT answer below cannot be explained by an insufficient role. It
  // is attributable to the MISSING GRANT and to nothing else.
  answers('PG-CE3-SEC4-an-organization_admin-of-an-org-with-no-live-grant-gets-NO_LIVE_GRANT',
    IDS.adminD, IDS.orgD, CAPABILITY, 'NO_LIVE_GRANT', 'NULL',
    'membership does not imply entitlement; the admin role must not manufacture one')

  add('PG-CE3-SEC4-the-refused-subject-really-does-hold-the-admin-role-so-the-control-is-not-vacuous',
    `DO $w$ DECLARE r text; BEGIN
  SELECT role INTO r FROM public.organization_members
   WHERE organization_id = '${IDS.orgD}' AND user_id = '${IDS.adminD}' AND status = 'active';
  IF r IS DISTINCT FROM 'organization_admin' THEN RAISE EXCEPTION 'SEC4 fixture subject holds role=%, expected organization_admin', r; END IF;
END $w$;`)

  /* ====================================================================== */
  /* PG-CE3-TENANT-ISOLATION — the R-A architecture, arms A..G.              */
  /* ====================================================================== */

  // A — the definer invocation SUCCEEDS under the intended tenant identity for
  // the caller's OWN organization, and returns OrgA's own distinct value.
  answers('PG-CE3-TENANT-ISOLATION-A-definer-invocation-succeeds-for-the-callers-OWN-organization',
    IDS.adminA, IDS.orgA, CAPABILITY, 'CAPPED', '100',
    'the R-A definer read must actually work for the scoped caller, or the node has no deliverable')

  // B — PRODUCTION PRIVILEGE POSTURE. A direct SELECT as a tenant identity with
  // NO table grant fails 42501 on PRIVILEGE, before RLS is ever consulted. Two
  // independent tenant roles are checked, because a posture that held for one
  // and not the other would be an accident.
  refuses('PG-CE3-TENANT-ISOLATION-B1-direct-SELECT-as-authenticated-fails-42501-on-privilege',
    asAuthenticated(IDS.adminA),
    `PERFORM * FROM public.${RELATION}`,
    'insufficient_privilege',
    'no tenant identity may hold SELECT on entitlement_grants; the production migration grants none')

  refuses('PG-CE3-TENANT-ISOLATION-B2-direct-SELECT-as-uellix_app-fails-42501-on-privilege',
    asAppRole(IDS.adminA),
    `PERFORM * FROM public.${RELATION}`,
    'insufficient_privilege',
    'the runtime writer role likewise holds no privilege on entitlement_grants')

  // C — RLS DEFENCE IN DEPTH. This is NOT the same query as B with a second
  // outcome: it is a SECOND, INDEPENDENT LAYER. Inside a transaction that is
  // rolled back, the tenant identity is TEMPORARILY GRANTED SELECT — and must
  // STILL see ZERO rows, because ENABLE + FORCE with no tenant-facing policy
  // leaves no policy that can match. Without this arm, "denied" would be
  // attributable entirely to the missing privilege and the RLS posture would be
  // unmeasured.
  add('PG-CE3-TENANT-ISOLATION-C-with-a-TEMPORARY-SELECT-grant-RLS-still-exposes-ZERO-rows',
    `BEGIN;
GRANT SELECT ON public.${RELATION} TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"${IDS.adminA}","role":"authenticated"}', true);
DO $w$ DECLARE n int; c int; BEGIN
  SELECT count(*) INTO n FROM public.${RELATION};
  IF n <> 0 THEN RAISE EXCEPTION 'ISOLATION-C with SELECT granted, FORCE RLS + zero tenant policies must still expose 0 rows, measured %', n; END IF;
  SELECT count(*) INTO c FROM public.${RELATION} WHERE reason = '${CANARY}';
  IF c <> 0 THEN RAISE EXCEPTION 'ISOLATION-C the sibling canary was visible'; END IF;
END $w$;
ROLLBACK;
-- The temporary grant is undone by the ROLLBACK above; GRANT is transactional
-- in PostgreSQL. Re-asserted here as a separate statement so a future change
-- that made it non-transactional would be caught rather than assumed away.
DO $v$ DECLARE ok boolean; BEGIN
  SELECT has_table_privilege('authenticated', 'public.${RELATION}', 'SELECT') INTO ok;
  IF ok THEN RAISE EXCEPTION 'ISOLATION-C the temporary SELECT grant SURVIVED the rollback'; END IF;
END $v$;`)

  // D — THE SIBLING CANARY IS ABSENT FROM ROWS, ANSWERS AND ERROR PAYLOADS.
  // Asserted BY IDENTITY rather than by row count: a count cannot distinguish
  // "denied" from "no such row".
  add('PG-CE3-TENANT-ISOLATION-D-the-sibling-canary-never-surfaces-in-any-answer-or-error',
    asAuthenticated(IDS.adminA) + `DO $w$ DECLARE k text; v integer; m text; BEGIN
  SELECT kind, limit_value INTO k, v FROM ${FN}('${IDS.orgA}'::uuid, '${CAPABILITY}'::varchar);
  IF k = 'UNMETERED' THEN RAISE EXCEPTION 'ISOLATION-D OrgA received OrgB UNMETERED answer -- the sibling row leaked'; END IF;
  IF k <> 'CAPPED' OR v <> 100 THEN RAISE EXCEPTION 'ISOLATION-D OrgA answer is %/%, expected CAPPED/100', k, v; END IF;
  BEGIN
    PERFORM * FROM ${FN}('${IDS.orgB}'::uuid, '${CAPABILITY}'::varchar);
    RAISE EXCEPTION 'ISOLATION-D the sibling organization was NOT refused';
  EXCEPTION WHEN sqlstate 'U0113' THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT;
    IF m LIKE '%${CANARY}%' THEN RAISE EXCEPTION 'ISOLATION-D the canary leaked through the error payload'; END IF;
  END;
END $w$;
ROLLBACK;`)

  // E — POLICY CENSUS, read from pg_policy rather than from the migration text.
  add('PG-CE3-TENANT-ISOLATION-E-exactly-ONE-policy-SELECT-only-TO-uellix_owner-and-ZERO-tenant-policies',
    `DO $w$ DECLARE n int; r text; cmd char; e boolean; f boolean; roles text; BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO e, f FROM pg_class WHERE oid = 'public.${RELATION}'::regclass;
  IF e IS NOT TRUE THEN RAISE EXCEPTION 'ISOLATION-E ENABLE ROW LEVEL SECURITY is not in effect'; END IF;
  IF f IS NOT TRUE THEN RAISE EXCEPTION 'ISOLATION-E FORCE ROW LEVEL SECURITY is not in effect'; END IF;

  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public.${RELATION}'::regclass;
  IF n <> 1 THEN RAISE EXCEPTION 'ISOLATION-E expected EXACTLY ONE policy, measured %', n; END IF;

  SELECT polcmd INTO cmd FROM pg_policy WHERE polrelid = 'public.${RELATION}'::regclass;
  IF cmd <> 'r' THEN RAISE EXCEPTION 'ISOLATION-E the policy is not SELECT-only (polcmd=%)', cmd; END IF;

  SELECT string_agg(pg_get_userbyid(x), ',' ORDER BY pg_get_userbyid(x)) INTO roles
    FROM pg_policy p, unnest(p.polroles) AS x WHERE p.polrelid = 'public.${RELATION}'::regclass;
  IF roles IS DISTINCT FROM 'uellix_owner' THEN RAISE EXCEPTION 'ISOLATION-E the policy addresses %, expected uellix_owner alone', roles; END IF;

  -- NAMED TENANT ROLES, CHECKED ONE BY ONE. A bare "no other policy exists"
  -- would already follow from the count above; this asserts the stronger and
  -- more useful claim that no policy addresses any of the five roles a tenant
  -- request can arrive as -- including polroles = {0}, which means PUBLIC.
  SELECT count(*) INTO n FROM pg_policy p WHERE p.polrelid = 'public.${RELATION}'::regclass
    AND (0 = ANY(p.polroles) OR EXISTS (
      SELECT 1 FROM unnest(p.polroles) AS x
       WHERE pg_get_userbyid(x) IN ('authenticated','anon','uellix_app','uellix_writer','service_role')));
  IF n <> 0 THEN RAISE EXCEPTION 'ISOLATION-E % tenant-facing polic(ies) exist', n; END IF;
END $w$;`)

  // F — PUBLIC HOLDS NO EXECUTE. New functions get PUBLIC EXECUTE by default
  // and 0033's historical blanket revoke cannot reach a function created later,
  // so this is measured from pg_proc.proacl (grantee 0 == PUBLIC), not assumed
  // from the presence of a REVOKE line. Removing that REVOKE is mutation 15.
  add('PG-CE3-TENANT-ISOLATION-F-PUBLIC-holds-no-EXECUTE-on-the-evaluator-or-the-trigger-function',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = '${FN_SIG}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF n <> 0 THEN RAISE EXCEPTION 'ISOLATION-F PUBLIC holds EXECUTE on the evaluator'; END IF;

  SELECT count(*) INTO n FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.enforce_entitlement_grant_append_only()'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF n <> 0 THEN RAISE EXCEPTION 'ISOLATION-F PUBLIC holds EXECUTE on the append-only trigger function'; END IF;

  -- The INTENDED grant is present, so F is not passing because the function is
  -- unreachable by everyone.
  IF NOT has_function_privilege('authenticated', '${FN_SIG}', 'EXECUTE') THEN
    RAISE EXCEPTION 'ISOLATION-F authenticated does NOT hold EXECUTE -- the production grant is missing';
  END IF;

  -- SECURITY DEFINER, owned by uellix_owner, and that owner is NOT a superuser
  -- and NOT BYPASSRLS -- otherwise FORCE RLS would be silently inert for it and
  -- arms C and E would be measuring nothing.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = '${FN_SIG}'::regprocedure) THEN
    RAISE EXCEPTION 'ISOLATION-F the evaluator is not SECURITY DEFINER';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '${FN_SIG}'::regprocedure) <> 'uellix_owner' THEN
    RAISE EXCEPTION 'ISOLATION-F the evaluator is not owned by uellix_owner';
  END IF;
END $w$;`)

  // G — anon cannot execute. Behavioural, as a real role: the ACL census in F
  // and an actual attempt are different claims, and only the attempt is
  // evidence that the ACL is the one PostgreSQL enforces.
  refuses('PG-CE3-TENANT-ISOLATION-G-anon-cannot-execute-the-evaluator',
    `BEGIN; SET LOCAL ROLE anon;\n`,
    `PERFORM * FROM ${FN}('${IDS.orgA}'::uuid, '${CAPABILITY}'::varchar)`,
    'insufficient_privilege',
    'the anonymous role must not reach the evaluator at all')

  // THE ROLE ATTRIBUTES THE WHOLE SUITE RESTS ON. FORCE ROW LEVEL SECURITY is
  // SILENTLY INERT for a BYPASSRLS role and for the table owner, so if any
  // tenant role were BYPASSRLS every isolation arm above would pass while
  // measuring nothing. Asserted from pg_roles, and the suite is NOT
  // superuser-only: the probes act as authenticated / uellix_app / anon.
  add('PG-CE3-TENANT-ISOLATION-role-attributes-tenant-roles-NOBYPASSRLS-and-not-the-table-owner',
    `DO $w$ DECLARE bad text; owner_name text; BEGIN
  SELECT string_agg(rolname, ',') INTO bad FROM pg_roles
   WHERE rolname IN ('authenticated','anon','uellix_app','uellix_writer','uellix_owner')
     AND (rolbypassrls OR rolsuper);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ISOLATION role attributes: % are BYPASSRLS or SUPERUSER, so FORCE RLS is inert for them', bad; END IF;

  SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid = 'public.${RELATION}'::regclass;
  IF owner_name <> 'uellix_owner' THEN RAISE EXCEPTION 'ISOLATION the table owner is %, expected uellix_owner', owner_name; END IF;
  IF owner_name IN ('authenticated','anon','uellix_app','uellix_writer') THEN
    RAISE EXCEPTION 'ISOLATION a tenant role OWNS the table';
  END IF;
END $w$;`)

  /* ====================================================================== */
  /* PG-CE3-APPEND-ONLY — the storage boundary, against SENTINEL_CLOSED_GRANT */
  /* ====================================================================== */
  //
  // ISSUED DIRECTLY AGAINST THE RELATION, never through a verb that declines to
  // issue them. And issued as postgres, a SUPERUSER — deliberately: a trigger
  // binds EVERY writer including the owner and a superuser, so proving the
  // refusal under the most privileged identity available is the strongest form
  // of the claim. (RLS would not deny a superuser at all, which is exactly why
  // append-only cannot be left to the absence of a policy.)
  add('PG-CE3-APPEND-ONLY-insert-then-close-once-succeeds-and-every-other-mutation-is-REFUSED',
    `BEGIN;
DO $w$ DECLARE caught text; msg text; n int; gid uuid; BEGIN
  -- POSITIVE FIRST: the legitimate lifecycle must work, or the refusals below
  -- would be satisfied by a relation that is simply frozen.
  ${insertGrant({ org: IDS.orgD, source: 'BOOTSTRAP_DEFAULT', account: null, limitKind: 'CAPPED', limitValue: '7' })}
    RETURNING id INTO gid;
  UPDATE public.${RELATION} SET effective_to = now() WHERE id = gid;
  SELECT count(*) INTO n FROM public.${RELATION} WHERE id = gid AND effective_to IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'APPEND-ONLY the single legitimate close did not take effect'; END IF;

  -- SECOND CLOSE -> REFUSED.
  caught := 'none';
  BEGIN UPDATE public.${RELATION} SET effective_to = now() + interval '1 day' WHERE id = gid;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY a SECOND close was not refused (caught=%)', caught; END IF;

  -- RE-OPENING a closed row -> REFUSED.
  caught := 'none';
  BEGIN UPDATE public.${RELATION} SET effective_to = NULL WHERE id = gid;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY re-opening a closed grant was not refused (caught=%)', caught; END IF;

  -- DELETE IS REFUSED **BY THE DELETE ARM**, AND THE MESSAGE IS WHAT PROVES IT.
  --
  -- THE SQLSTATE ALONE CANNOT SEE THIS GUARANTEE, measured rather than assumed:
  -- with the IF TG_OP = DELETE arm deleted, a CLOSED-row DELETE still falls
  -- through to the "a closed grant cannot be modified" arm, and a LIVE-row
  -- DELETE still falls through to the NEW.effective_to IS NULL arm -- because
  -- NEW is NULL under DELETE, so that predicate is TRUE. BOTH still raise 42501,
  -- so a control asserting only the code stays GREEN while the dedicated arm is
  -- gone. That was a real ZERO-HIT result from mutation 6, not a hypothetical.
  --
  -- Asserting the DELETE-SPECIFIC MESSAGE makes the arm observable and upgrades
  -- the claim from "the statement was refused" to "the statement was refused FOR
  -- THE RIGHT REASON" -- which is the difference between defence in depth that
  -- exists and defence in depth that merely appears to.
  caught := 'none'; msg := '';
  BEGIN DELETE FROM public.${RELATION} WHERE id = gid;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY DELETE of a closed grant was not refused (caught=%)', caught; END IF;
  IF msg NOT LIKE '%append-only and cannot be deleted%' THEN
    RAISE EXCEPTION 'APPEND-ONLY the closed-row DELETE was refused by the WRONG arm (msg=%) -- the dedicated DELETE guard is missing', msg;
  END IF;

  caught := 'none'; msg := '';
  BEGIN DELETE FROM public.${RELATION} WHERE id = '${IDS.grantOrgALive}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY DELETE of a LIVE grant was not refused (caught=%)', caught; END IF;
  IF msg NOT LIKE '%append-only and cannot be deleted%' THEN
    RAISE EXCEPTION 'APPEND-ONLY the live-row DELETE was refused by the WRONG arm (msg=%) -- the dedicated DELETE guard is missing', msg;
  END IF;

  -- MUTATING ANOTHER COLUMN WHILE CLOSING -> REFUSED. The close itself is
  -- legal; smuggling a limit change alongside it is not.
  caught := 'none';
  BEGIN UPDATE public.${RELATION} SET effective_to = now(), limit_value = 999 WHERE id = '${IDS.grantOrgALive}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY a limit_value change smuggled into the close was not refused (caught=%)', caught; END IF;

  -- MUTATING A NULLABLE COLUMN TO NULL -> REFUSED. This is the arm an equality
  -- chain would MISS: NEW.reason <> OLD.reason is UNKNOWN when either side is
  -- NULL, so a NULL-unsafe guard would ADMIT this edit. Only the row-wise
  -- IS DISTINCT FROM comparison catches it.
  caught := 'none';
  BEGIN UPDATE public.${RELATION} SET effective_to = now(), reason = NULL WHERE id = '${IDS.grantOrgALive}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY a NULLING edit slipped past the NULL-safe comparison (caught=%)', caught; END IF;

  -- AND FROM NULL TO A VALUE, the same hazard in the other direction.
  caught := 'none';
  BEGIN UPDATE public.${RELATION} SET effective_to = now(), plan_ref = 'smuggled' WHERE id = '${IDS.grantOrgC}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY a NULL -> value edit slipped past the comparison (caught=%)', caught; END IF;

  -- THE PRE-EXISTING CLOSED SENTINEL ROW IS FROZEN TOO.
  caught := 'none';
  BEGIN UPDATE public.${RELATION} SET effective_to = now() WHERE id = '${IDS.grantOrgAClosed}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'APPEND-ONLY SENTINEL_CLOSED_GRANT_ROW accepted a second close (caught=%)', caught; END IF;
END $w$;
ROLLBACK;`)

  // CE3-P-2 — PROVENANCE IS COMPLETE AND RECONSTRUCTIBLE, asserted by actually
  // RECONSTRUCTING A PAST INSTANT rather than by inspecting the column list. A
  // column census passes on a table nobody can query historically, which is
  // precisely why the control is written this way.
  //
  // The full ratified lifecycle is exercised in one transaction: insert a live
  // grant, CLOSE it, insert its replacement, then ask what was in force BEFORE
  // the close and confirm the superseded row still carries every provenance
  // field. Append-only is what makes this answerable at all — a DELETE or an
  // in-place UPDATE would have destroyed the very row being reconstructed.
  add('PG-CE3-APPEND-ONLY-a-past-instant-is-RECONSTRUCTIBLE-with-full-provenance-after-a-close',
    `BEGIN;
DO $w$
DECLARE
  t0 timestamptz := now() - interval '10 days';
  t1 timestamptz := now() - interval '5 days';
  k text; v integer; src text; pref text; rsn text; act uuid; acct uuid; n int;
BEGIN
  INSERT INTO public.${RELATION}
    (organization_id, capability_key, source, commercial_account_id, plan_ref,
     limit_kind, limit_value, effective_from, reason, actor_user_id)
  VALUES ('${IDS.orgD}', '${CAPABILITY}', 'PLATFORM_ADMIN', NULL, 'plan-legacy-v0',
          'CAPPED', 50, t0, 'granted by platform admin', '${IDS.adminD}');

  UPDATE public.${RELATION} SET effective_to = t1
   WHERE organization_id = '${IDS.orgD}' AND effective_to IS NULL;

  INSERT INTO public.${RELATION}
    (organization_id, capability_key, source, commercial_account_id, plan_ref,
     limit_kind, limit_value, effective_from, reason, actor_user_id)
  VALUES ('${IDS.orgD}', '${CAPABILITY}', 'BOOTSTRAP_DEFAULT', NULL, NULL,
          'UNMETERED', NULL, t1, 'replacement grant', NULL);

  -- WHAT WAS IN FORCE AT AN INSTANT BEFORE THE CLOSE.
  SELECT limit_kind, limit_value, source, plan_ref, reason, actor_user_id, commercial_account_id
    INTO k, v, src, pref, rsn, act, acct
    FROM public.${RELATION}
   WHERE organization_id = '${IDS.orgD}' AND capability_key = '${CAPABILITY}'
     AND effective_from <= now() - interval '7 days'
     AND (effective_to IS NULL OR effective_to > now() - interval '7 days');
  IF k <> 'CAPPED' OR v <> 50 THEN RAISE EXCEPTION 'P-2 the superseded grant reconstructs as %/%, expected CAPPED/50', k, v; END IF;
  IF src <> 'PLATFORM_ADMIN' THEN RAISE EXCEPTION 'P-2 lost the source: %', src; END IF;
  IF pref <> 'plan-legacy-v0' THEN RAISE EXCEPTION 'P-2 lost the plan snapshot: %', pref; END IF;
  IF rsn <> 'granted by platform admin' THEN RAISE EXCEPTION 'P-2 lost the reason: %', rsn; END IF;
  IF act IS DISTINCT FROM '${IDS.adminD}'::uuid THEN RAISE EXCEPTION 'P-2 lost the actor: %', act; END IF;
  IF acct IS NOT NULL THEN RAISE EXCEPTION 'P-2 invented a commercial basis: %', acct; END IF;

  -- AND WHAT IS IN FORCE NOW is the REPLACEMENT, not the superseded row.
  SELECT limit_kind, actor_user_id INTO k, act
    FROM public.${RELATION}
   WHERE organization_id = '${IDS.orgD}' AND capability_key = '${CAPABILITY}'
     AND effective_to IS NULL;
  IF k <> 'UNMETERED' THEN RAISE EXCEPTION 'P-2 the current grant is %, expected UNMETERED', k; END IF;
  -- actor_user_id NULL is MEANINGFUL (PI-5): a machine-originated grant, not a
  -- missing value to be backfilled with a service account.
  IF act IS NOT NULL THEN RAISE EXCEPTION 'P-2 the machine-originated replacement acquired an actor: %', act; END IF;

  -- BOTH rows survive. Reconstruction is only possible because nothing was
  -- deleted or rewritten in place.
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgD}';
  IF n <> 2 THEN RAISE EXCEPTION 'P-2 expected 2 historical rows, measured %', n; END IF;
END $w$;
ROLLBACK;`)

  /* ====================================================================== */
  /* PG-CE3-SOURCE-VALIDATION                                               */
  /* ====================================================================== */
  refuses('PG-CE3-SOURCE-VALIDATION-a-FIFTH-source-value-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'TRIAL', account: null }), 'check_violation',
    'the source vocabulary is a CLOSED four-value set pinned in the database')

  refuses('PG-CE3-SOURCE-VALIDATION-PLAN-with-a-NULL-commercial-basis-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLAN', account: null }), 'check_violation',
    'PLAN requires a commercial basis (CHECK-3)')

  refuses('PG-CE3-SOURCE-VALIDATION-COMMERCIAL_EXCEPTION-with-a-NULL-commercial-basis-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'COMMERCIAL_EXCEPTION', account: null }), 'check_violation',
    'COMMERCIAL_EXCEPTION requires a commercial basis (CHECK-3)')

  // THE SECOND HALF OF THE BICONDITIONAL — the half an implementer omits by
  // default, and mutation CE3-M-7. Without it a PLATFORM_ADMIN grant could
  // carry a commercial basis that never existed.
  refuses('PG-CE3-SOURCE-VALIDATION-PLATFORM_ADMIN-with-a-NON-NULL-commercial-basis-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: IDS.caX }), 'check_violation',
    'PLATFORM_ADMIN must carry NO commercial basis (CHECK-4)')

  refuses('PG-CE3-SOURCE-VALIDATION-BOOTSTRAP_DEFAULT-with-a-NON-NULL-commercial-basis-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'BOOTSTRAP_DEFAULT', account: IDS.caX }), 'check_violation',
    'BOOTSTRAP_DEFAULT must carry NO commercial basis (CHECK-4)')

  // ALL FOUR SOURCES ARE EXPRESSIBLE WITH THEIR CORRECT BASIS — the POSITIVE
  // half, so the five refusals above are not passing because the relation
  // refuses everything.
  add('PG-CE3-SOURCE-VALIDATION-all-FOUR-sources-are-expressible-with-their-correct-basis',
    `BEGIN;
DO $w$ DECLARE n int; BEGIN
  ${insertGrant({ org: IDS.orgD, source: 'PLAN', account: IDS.caX })};
  UPDATE public.${RELATION} SET effective_to = now() WHERE organization_id = '${IDS.orgD}' AND effective_to IS NULL;
  ${insertGrant({ org: IDS.orgD, source: 'COMMERCIAL_EXCEPTION', account: IDS.caY })};
  UPDATE public.${RELATION} SET effective_to = now() WHERE organization_id = '${IDS.orgD}' AND effective_to IS NULL;
  ${insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null })};
  UPDATE public.${RELATION} SET effective_to = now() WHERE organization_id = '${IDS.orgD}' AND effective_to IS NULL;
  ${insertGrant({ org: IDS.orgD, source: 'BOOTSTRAP_DEFAULT', account: null })};
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgD}';
  IF n <> 4 THEN RAISE EXCEPTION 'SOURCE-VALIDATION expected all 4 sources to be insertable, measured %', n; END IF;
END $w$;
ROLLBACK;`)

  /* ====================================================================== */
  /* PG-CE3-LIMIT-VALIDATION                                                */
  /* ====================================================================== */
  // CE3-N-5's DATABASE half: a grant insert that states NO metered semantic at
  // all is REFUSED, not silently defaulted. limit_kind is NOT NULL and carries
  // NO DEFAULT precisely so that this fails closed — attaching a default here
  // is what would generalise the legacy null-means-unlimited semantic to every
  // future capability, which is mutation CE3-M-2.
  refuses('PG-CE3-LIMIT-VALIDATION-an-insert-that-states-NO-metered-semantic-is-refused-not-defaulted',
    'BEGIN;\n',
    `INSERT INTO public.${RELATION}
       (organization_id, capability_key, source, commercial_account_id, effective_from)
     VALUES ('${IDS.orgD}', '${CAPABILITY}', 'PLATFORM_ADMIN', NULL, now() - interval '1 hour')`,
    'not_null_violation',
    'an omitted limit_kind must fail closed rather than acquire a default')

  refuses('PG-CE3-LIMIT-VALIDATION-a-FOURTH-limit-kind-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'THROTTLED', limitValue: '5' }), 'check_violation',
    'the limit_kind vocabulary is a CLOSED three-value set pinned in the database')

  refuses('PG-CE3-LIMIT-VALIDATION-CAPPED-with-a-NULL-limit_value-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'CAPPED', limitValue: 'NULL' }), 'check_violation',
    'CAPPED requires a limit_value (CHECK-1)')

  refuses('PG-CE3-LIMIT-VALIDATION-CAPPED-with-a-NEGATIVE-limit_value-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'CAPPED', limitValue: '-1' }), 'check_violation',
    'CAPPED requires limit_value >= 0 (CHECK-1)')

  refuses('PG-CE3-LIMIT-VALIDATION-UNMETERED-with-a-NON-NULL-limit_value-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'UNMETERED', limitValue: '10' }), 'check_violation',
    'UNMETERED carries no limit_value (CHECK-2)')

  refuses('PG-CE3-LIMIT-VALIDATION-BLOCKED-with-a-NON-NULL-limit_value-is-refused',
    'BEGIN;\n', insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'BLOCKED', limitValue: '0' }), 'check_violation',
    'BLOCKED carries no limit_value -- it is a limit_kind, never "CAPPED with 0" (CHECK-2)')

  // THE BOUNDARY THAT MATTERS MOST: CAPPED 0 is VALID, is stored as CAPPED, and
  // the evaluator answers CAPPED/0 -- NOT BLOCKED. Collapsing them would
  // reintroduce the legacy organizations.stella_monthly_quota overload
  // (0-means-blocked) that limit_kind exists to stop generalising.
  add('PG-CE3-LIMIT-VALIDATION-CAPPED-ZERO-is-valid-and-stays-CAPPED-it-is-NOT-BLOCKED',
    `BEGIN;
DO $w$ DECLARE k text; v integer; BEGIN
  ${insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'CAPPED', limitValue: '0' })};
  SELECT limit_kind, limit_value INTO k, v FROM public.${RELATION}
   WHERE organization_id = '${IDS.orgD}' AND effective_to IS NULL;
  IF k <> 'CAPPED' OR v <> 0 THEN RAISE EXCEPTION 'LIMIT-VALIDATION CAPPED 0 stored as %/%', k, v; END IF;
END $w$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"${IDS.adminD}","role":"authenticated"}', true);
DO $x$ DECLARE k text; v integer; BEGIN
  SELECT kind, limit_value INTO k, v FROM ${FN}('${IDS.orgD}'::uuid, '${CAPABILITY}'::varchar);
  IF k <> 'CAPPED' THEN RAISE EXCEPTION 'LIMIT-VALIDATION the evaluator answered % for CAPPED 0 -- BLOCKED and a zero cap must stay distinct', k; END IF;
  IF v IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'LIMIT-VALIDATION the evaluator lost the zero cap (limit_value=%)', v; END IF;
END $x$;
ROLLBACK;`)

  // AND ALL THREE METERED STATES ARE DISTINGUISHABLE END TO END (CE3-P-6),
  // measured as three DIFFERENT answers to the SAME capability key in three
  // different organizations, each asked BY ITS OWN SCOPED PRINCIPAL.
  //
  // AN EARLIER VERSION OF THIS CONTROL WAS VACUOUS AND IS RECORDED HERE RATHER
  // THAN QUIETLY REPLACED. It put `SET LOCAL ROLE authenticated` INSIDE a
  // plpgsql DO block that no BEGIN had opened, so the SET LOCAL was inert, all
  // three reads ran as the postgres SUPERUSER, and the probe passed while
  // measuring neither the definer path nor the tenant identity -- a superuser
  // bypasses RLS entirely and holds EXECUTE implicitly. Splitting it into three
  // separate transactions, each opened by asAuthenticated(), is what makes the
  // identity real; the three distinct expected values are the distinctness
  // proof, and no cross-probe comparison is needed to state it.
  answers('PG-CE3-LIMIT-VALIDATION-three-states-OrgA-answers-CAPPED-100',
    IDS.adminA, IDS.orgA, CAPABILITY, 'CAPPED', '100',
    'the CAPPED state must be reported with its cap')

  answers('PG-CE3-LIMIT-VALIDATION-three-states-OrgB-answers-UNMETERED',
    IDS.adminB, IDS.orgB, CAPABILITY, 'UNMETERED', 'NULL',
    'UNMETERED must be distinguishable from a large cap')

  answers('PG-CE3-LIMIT-VALIDATION-three-states-OrgC-answers-BLOCKED',
    IDS.adminC, IDS.orgC, CAPABILITY, 'BLOCKED', 'NULL',
    'BLOCKED is a limit_kind and must never arrive as CAPPED 0 or as NO_LIVE_GRANT')

  /* ====================================================================== */
  /* PG-CE3-EFFECTIVE-PERIOD                                                */
  /* ====================================================================== */
  refuses('PG-CE3-EFFECTIVE-PERIOD-effective_to-EQUAL-to-effective_from-is-refused',
    'BEGIN;\n',
    insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, from: `timestamptz '2026-01-01 00:00:00+00'`, to: `timestamptz '2026-01-01 00:00:00+00'` }),
    'check_violation',
    'CHECK-5 is a STRICT inequality; the equality case is the one a non-strict implementation silently admits')

  refuses('PG-CE3-EFFECTIVE-PERIOD-effective_to-BEFORE-effective_from-is-refused',
    'BEGIN;\n',
    insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, from: `timestamptz '2026-01-02 00:00:00+00'`, to: `timestamptz '2026-01-01 00:00:00+00'` }),
    'check_violation',
    'a period that ends before it starts is refused')

  // THE EXPLICIT EVALUATION-INSTANT DECISION, PROVEN. A FUTURE-DATED row with
  // effective_to NULL OCCUPIES the unique live key -- so a second live grant is
  // still refused -- while the evaluator answers NO_LIVE_GRANT until its
  // effective_from passes. These are two different notions of "live" and the
  // probe measures both at once, which is the only way to show they are kept
  // apart deliberately rather than by accident.
  add('PG-CE3-EFFECTIVE-PERIOD-a-FUTURE-dated-live-row-occupies-the-unique-key-yet-evaluates-NO_LIVE_GRANT',
    `BEGIN;
DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  ${insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'UNMETERED', limitValue: 'NULL', from: `now() + interval '30 days'` })};
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgD}' AND effective_to IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'EFFECTIVE-PERIOD the future-dated row is not live-keyed (n=%)', n; END IF;
  BEGIN ${insertGrant({ org: IDS.orgD, source: 'PLATFORM_ADMIN', account: null, limitKind: 'BLOCKED', limitValue: 'NULL' })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'EFFECTIVE-PERIOD a future-dated row must still OCCUPY the unique live key (caught=%)', caught; END IF;
END $w$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"${IDS.adminD}","role":"authenticated"}', true);
DO $x$ DECLARE k text; BEGIN
  SELECT kind INTO k FROM ${FN}('${IDS.orgD}'::uuid, '${CAPABILITY}'::varchar);
  IF k <> 'NO_LIVE_GRANT' THEN RAISE EXCEPTION 'EFFECTIVE-PERIOD a NOT-YET-EFFECTIVE grant was reported as % -- the evaluator must require effective_from <= now()', k; END IF;
END $x$;
ROLLBACK;`)

  /* ====================================================================== */
  /* PG-CE3-EXPLICIT-ORG — the POSITIVE wrong-tenant detector.               */
  /* ====================================================================== */
  //
  // TWO LIVE SCOPES ARE UNSATISFIABLE AGAINST THIS SCHEMA, measured:
  // db/schema.ts declares uniqueIndex('user_single_active_membership') on
  // (user_id) WHERE status = 'active'. So the property is proven in the
  // strongest form the schema admits, as a PAIR -- see the fixtures header.
  add('PG-CE3-EXPLICIT-ORG-the-fixture-subject-really-holds-one-ACTIVE-and-one-INACTIVE-membership',
    `DO $w$ DECLARE a int; i int; BEGIN
  SELECT count(*) INTO a FROM public.organization_members WHERE user_id = '${IDS.multiOrg}' AND status = 'active';
  SELECT count(*) INTO i FROM public.organization_members WHERE user_id = '${IDS.multiOrg}' AND status <> 'active';
  IF a <> 1 THEN RAISE EXCEPTION 'EXPLICIT-ORG expected exactly ONE active membership, measured %', a; END IF;
  IF i <> 1 THEN RAISE EXCEPTION 'EXPLICIT-ORG expected exactly ONE inactive membership, measured %', i; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = '${IDS.multiOrg}' AND organization_id = '${IDS.orgB}' AND status = 'active')
    THEN RAISE EXCEPTION 'EXPLICIT-ORG the ACTIVE membership is not OrgB'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = '${IDS.multiOrg}' AND organization_id = '${IDS.orgA}' AND status <> 'active')
    THEN RAISE EXCEPTION 'EXPLICIT-ORG the INACTIVE membership is not OrgA'; END IF;
END $w$;`)

  // (a) THE ARGUMENT IS HONOURED, and the answer is discriminated BY VALUE:
  // OrgB is UNMETERED while OrgA is CAPPED/100, so returning the wrong
  // organization's row is visible, not merely a different row count.
  answers('PG-CE3-EXPLICIT-ORG-asking-explicitly-for-OrgB-returns-OrgBs-own-distinct-answer',
    IDS.multiOrg, IDS.orgB, CAPABILITY, 'UNMETERED', 'NULL',
    'the explicit organization argument must select the answer')

  // (b) AMBIENT SUBSTITUTION IS REFUSED. This is the POSITIVE wrong-tenant
  // detector and the detector for mutation CE3-M-4: an evaluator that fell back
  // to the caller's own scope, to a "first membership", or to any membership row
  // regardless of status would ANSWER here (with OrgB's UNMETERED, or OrgA's
  // CAPPED/100) instead of raising. An absence-based test could not see either.
  refuses('PG-CE3-EXPLICIT-ORG-asking-for-the-INACTIVE-membership-organization-RAISES-and-is-never-substituted',
    asAuthenticated(IDS.multiOrg),
    `PERFORM * FROM ${FN}('${IDS.orgA}'::uuid, '${CAPABILITY}'::varchar)`,
    'cross_organization',
    'an INACTIVE membership is not scope; the evaluator must not fall back to any other organization')

  /* ====================================================================== */
  /* PG-CE3-NO-CE4-CONSUMER — the runtime half of the enforcement boundary.  */
  /* ====================================================================== */
  add('PG-CE3-NO-CE4-CONSUMER-no-trigger-rule-view-default-or-FK-action-makes-the-relation-change-anything',
    `BEGIN;
DO $w$ DECLARE n int; t text; before_n int; after_n int; BEGIN
  -- (a) NO TRIGGER ON commercial_accounts AT ALL that could reach this relation
  -- (SC-15: a commercial write silently becoming a capability change is the
  -- package's central contradiction, and CE-3 creates the relation such a
  -- trigger would target).
  SELECT count(*) INTO n FROM pg_trigger tg
   WHERE tg.tgrelid = 'public.commercial_accounts'::regclass AND NOT tg.tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'NO-CE4 commercial_accounts carries % user trigger(s)', n; END IF;

  -- (b) THE ONLY TRIGGER ON entitlement_grants IS THE APPEND-ONLY GUARD.
  SELECT count(*) INTO n FROM pg_trigger tg
   WHERE tg.tgrelid = 'public.${RELATION}'::regclass AND NOT tg.tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'NO-CE4 expected exactly ONE user trigger on the relation, measured %', n; END IF;
  SELECT tgname INTO t FROM pg_trigger
   WHERE tgrelid = 'public.${RELATION}'::regclass AND NOT tgisinternal;
  IF t <> 'trg_entitlement_grants_append_only' THEN RAISE EXCEPTION 'NO-CE4 unexpected trigger %', t; END IF;

  -- (c) NO RULE and NO VIEW depends on the relation.
  SELECT count(*) INTO n FROM pg_rewrite r
   WHERE r.ev_class = 'public.${RELATION}'::regclass AND r.rulename <> '_RETURN';
  IF n <> 0 THEN RAISE EXCEPTION 'NO-CE4 % rewrite rule(s) on the relation', n; END IF;
  SELECT count(*) INTO n FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class c ON c.oid = r.ev_class AND c.relkind IN ('v','m')
   WHERE d.refobjid = 'public.${RELATION}'::regclass AND d.classid = 'pg_rewrite'::regclass;
  IF n <> 0 THEN RAISE EXCEPTION 'NO-CE4 % view(s)/matview(s) read the relation', n; END IF;

  -- (d) NOTHING REFERENCES entitlement_grants, so no FK action anywhere can
  -- cascade INTO it, and its own FKs are all NO ACTION so it cascades nowhere.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'public.${RELATION}'::regclass;
  IF n <> 0 THEN RAISE EXCEPTION 'NO-CE4 % foreign key(s) point AT the relation', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = 'public.${RELATION}'::regclass AND (confupdtype <> 'a' OR confdeltype <> 'a');
  IF n <> 0 THEN RAISE EXCEPTION 'NO-CE4 % outbound FK(s) carry a non-NO-ACTION referential action', n; END IF;

  -- (e) plan_ref carries NO foreign key (SC-11), so editing a plan definition
  -- cannot retroactively rewrite what an Organization was granted.
  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.contype = 'f' AND c.conrelid = 'public.${RELATION}'::regclass
     AND 'plan_ref' = ANY (SELECT a.attname FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k);
  IF n <> 0 THEN RAISE EXCEPTION 'NO-CE4 plan_ref carries a foreign key'; END IF;

  -- (f) BEHAVIOURAL: writing to commercial_accounts produces no grant row.
  SELECT count(*) INTO before_n FROM public.${RELATION};
  UPDATE public.commercial_accounts SET commercial_status = 'past_due' WHERE id = '${IDS.caX}';
  INSERT INTO public.commercial_accounts (legal_name, commercial_status) VALUES ('NO-CE4 probe account', 'active');
  SELECT count(*) INTO after_n FROM public.${RELATION};
  IF before_n <> after_n THEN RAISE EXCEPTION 'NO-CE4 a commercial_accounts write changed entitlement_grants: % -> %', before_n, after_n; END IF;
END $w$;
ROLLBACK;`)

  /* ====================================================================== */
  /* PG-CE3-UNGOVERNED — SENTINEL_UNGOVERNED_ORG.                            */
  /* ====================================================================== */
  //
  // NULL GOVERNANCE IS NOT READ AS FREE, TRIAL OR UNLIMITED. An implementation
  // that treated an absent commercial account as a permissive default would
  // reintroduce CA-05's violation through the back door -- and it would look
  // exactly like a working evaluator until someone checked this fixture.
  add('PG-CE3-UNGOVERNED-the-sentinel-org-really-has-NULL-governance-and-no-grant',
    `DO $w$ DECLARE a uuid; n int; BEGIN
  SELECT commercial_account_id INTO a FROM public.organizations WHERE id = '${IDS.orgD}';
  IF a IS NOT NULL THEN RAISE EXCEPTION 'UNGOVERNED the sentinel organization is governed by %', a; END IF;
  SELECT count(*) INTO n FROM public.${RELATION} WHERE organization_id = '${IDS.orgD}';
  IF n <> 0 THEN RAISE EXCEPTION 'UNGOVERNED the sentinel organization holds % grant row(s)', n; END IF;
END $w$;`)

  answers('PG-CE3-UNGOVERNED-an-ungoverned-organization-evaluates-NO_LIVE_GRANT-never-a-permissive-answer',
    IDS.adminD, IDS.orgD, CAPABILITY, 'NO_LIVE_GRANT', 'NULL',
    'NULL governance must never be read as free, trial or unlimited')

  return { probes }
}

/**
 * Strips line comments and single-quoted string literals from probe SQL, so a
 * lexical test reads CODE and never DATA. Dollar-quoted bodies are preserved on
 * purpose — the statements under test live inside them.
 */
function stripProbeNoise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''")
}

/**
 * Statement-shaped mutation detector. GRANT and REVOKE are anchored to a
 * statement boundary rather than matched as bare words: both are ordinary
 * English and appear throughout this file's messages and identifiers.
 */
const MUTATING =
  /(?:^|;|\n)\s*(?:GRANT|REVOKE)\s|\b(?:INSERT\s+INTO|UPDATE\s+"?[a-z_]|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+(?:TABLE|ROLE|POLICY|TRIGGER))\b/i

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

/** The twelve probe FAMILIES the authority requires, each matched by id prefix. */
export const REQUIRED_PROBE_FAMILIES = [
  'PG-4',
  'PG-7',
  'PG-CE3-SEC3',
  'PG-CE3-SEC4',
  'PG-CE3-TENANT-ISOLATION',
  'PG-CE3-APPEND-ONLY',
  'PG-CE3-SOURCE-VALIDATION',
  'PG-CE3-LIMIT-VALIDATION',
  'PG-CE3-EFFECTIVE-PERIOD',
  'PG-CE3-EXPLICIT-ORG',
  'PG-CE3-NO-CE4-CONSUMER',
  'PG-CE3-UNGOVERNED',
] as const

describe.skipIf(!PG_TESTS_ENABLED)(
  'CE-3 entitlement grants — real PostgreSQL (canonical disposable harness)',
  { timeout: 1_800_000 },
  () => {
    let outcome: HarnessOutcome

    beforeAll(() => {
      outcome = runDisposableHarness({
        image: DEFAULT_IMAGE,
        setup: buildSetupManifest(),
        probe: buildProbeManifest(),
      })
      console.log(
        `CE3_PG_OUTCOME=${JSON.stringify({
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
    }, 1_800_000)

    it('the CE-3 unit is the CURRENT TAIL of the baseline, immediately after the L1 unit', () => {
      const index = BASELINE_UNITS.indexOf(CE3_UNIT!)
      expect(index).toBe(BASELINE_UNITS.length - 1)
      expect(BASELINE_UNITS[index - 1].id).toBe('0072_customer_lifecycle_l1_organization_commercial_acceptance.sql')
    })

    it(`the harness provisioned the full baseline (${BASELINE_UNITS.length} units, CE-3 included) and tore itself down with zero leftovers`, () => {
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

    it('every one of the TWELVE required probe families is represented', () => {
      // The family name may be followed by a '-' OR by a single lettered
      // sub-index ('PG-7a', 'PG-7b', ...). Requiring a literal `${family}-`
      // reported the PG-7 family as ABSENT while eight PG-7* probes were
      // running and passing — a false negative from the matcher, not from the
      // coverage.
      for (const family of REQUIRED_PROBE_FAMILIES) {
        const pattern = new RegExp(`^${family.replace(/[-]/g, '\\-')}[a-z]?(-|$)`)
        const matching = EXPECTED_PROBE_IDS.filter((id) => pattern.test(id))
        expect(matching.length, `probe family ${family} has no probe`).toBeGreaterThan(0)
      }
      expect(REQUIRED_PROBE_FAMILIES.length).toBe(12)
    })

    it('the family matcher distinguishes a sub-indexed member from an unrelated id', () => {
      const pattern = (family: string) => new RegExp(`^${family.replace(/[-]/g, '\\-')}[a-z]?(-|$)`)
      expect(pattern('PG-7').test('PG-7a-cross-organization')).toBe(true)
      expect(pattern('PG-7').test('PG-7')).toBe(true)
      expect(pattern('PG-4').test('PG-4-partial-unique')).toBe(true)
      expect(pattern('PG-7').test('PG-70-something-else')).toBe(false)
      expect(pattern('PG-CE3-SEC3').test('PG-CE3-SEC4-membership')).toBe(false)
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

/**
 * THE ANTI-SKIP SELF-CHECK — UNGATED, and therefore never skipped.
 *
 * A SKIPPED SUITE IS INDISTINGUISHABLE FROM A PASSING ONE: the block above is
 * describe.skipIf(!PG_TESTS_ENABLED), so without UELLIX_PG_TESTS=1 it reports
 * green having executed nothing. The dedicated CI gate sets
 * UELLIX_CE3_PG_REQUIRED=1, which arms this block to FAIL when the real suite
 * did not actually run.
 *
 * The measured hazard it answers is specific: the disposable harness's
 * `setupStatus` value SKIPPED is ALSO its INITIALIZATION value, so a harness
 * that bailed out BEFORE setup reports the same value as one that deliberately
 * skipped. Only an assertion made OUTSIDE the gated block can tell them apart.
 */
describe('CE-3 real-PostgreSQL gate self-check (never skipped)', () => {
  it('when UELLIX_CE3_PG_REQUIRED=1, the gated real-PostgreSQL suite must actually have run', () => {
    if (process.env.UELLIX_CE3_PG_REQUIRED !== '1') {
      expect(PG_TESTS_ENABLED === true || PG_TESTS_ENABLED === false).toBe(true)
      return
    }
    expect(
      PG_TESTS_ENABLED,
      'UELLIX_CE3_PG_REQUIRED=1 but UELLIX_PG_TESTS is not 1, so the real-PostgreSQL suite was SKIPPED and its green is empty',
    ).toBe(true)
  })

  it('the probe manifest is well formed, non-empty and free of duplicate ids', () => {
    const ids = buildProbeManifest().probes.map((p) => p.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of buildProbeManifest().probes) {
      expect(p.sql.trim().length, `probe ${p.id} has empty SQL`).toBeGreaterThan(0)
    }
  })

  /**
   * EVERY MUTATING PROBE MUST OPEN A TRANSACTION IT LATER ROLLS BACK.
   *
   * THIS GUARD EXISTS BECAUSE THE OMISSION ACTUALLY HAPPENED HERE. Three probes
   * were written ending in `ROLLBACK;` but never opened a transaction, so psql
   * ran their statements in AUTOCOMMIT, the trailing ROLLBACK was a no-op that
   * merely warned, and their writes COMMITTED into the shared disposable
   * database. The committed rows then poisoned every later probe touching the
   * same organization — the ungoverned sentinel acquired a live UNMETERED grant
   * and reported a permissive answer, and subsequent inserts collided with
   * 23505. Seven probes failed for one cause, and the cause was invisible in
   * each individual probe's text.
   *
   * The ORDER of probes is not the defect and reordering is not the fix:
   * probes share one database by design, so isolation has to be a property each
   * mutating probe carries itself.
   */
  it('every MUTATING probe opens a transaction and rolls it back, except the one that must commit', () => {
    // PG-4 is the single deliberate committer: two genuinely concurrent
    // transactions cannot be proven inside one rolled-back transaction, and it
    // writes only to OrgK, a scratch organization no other probe reads.
    const DELIBERATE_COMMITTERS = new Set(
      buildProbeManifest().probes.map((p) => p.id).filter((id) => id.startsWith('PG-4')),
    )
    expect(DELIBERATE_COMMITTERS.size).toBe(1)

    for (const probe of buildProbeManifest().probes) {
      // COMMENTS **AND SINGLE-QUOTED LITERALS** ARE STRIPPED FIRST, and the
      // second half is not optional: an earlier version of this guard stripped
      // only comments and then flagged the READ-ONLY probe PG-7b, because its
      // RAISE message contains the words "live grant for" and the pattern
      // /GRANT\s/i matched inside the string literal. A guard that reads DATA as
      // CODE is the same defect db/hosted/baseline-scanner.ts documents having
      // been bitten by twice — and here it produced a false FAILURE, which is
      // the merciful direction; the same bug in an absence control produces a
      // false PASS.
      //
      // Dollar-quoted bodies are deliberately NOT stripped: the statements this
      // guard exists to find live inside DO $w$ ... $w$.
      const code = stripProbeNoise(probe.sql)
      if (!MUTATING.test(code)) continue
      if (DELIBERATE_COMMITTERS.has(probe.id)) continue

      expect(/^\s*(CREATE EXTENSION[^;]*;\s*)?BEGIN\s*;/i.test(code), `probe ${probe.id} MUTATES but never opens a transaction — its ROLLBACK would be a no-op and its writes would COMMIT into the shared database`).toBe(true)
      expect(/\bROLLBACK\s*;/i.test(code), `probe ${probe.id} MUTATES but never rolls back`).toBe(true)
    }
  })

  // The guard above asserts an absence, so it needs a known-positive: a probe
  // shaped like the defect must actually trip the predicate.
  it('the transaction guard can see the defect it exists to catch, and only that defect', () => {
    // POSITIVE: a probe shaped like the real omission must trip it.
    const defective = `DO $w$ BEGIN INSERT INTO public.entitlement_grants (id) VALUES (gen_random_uuid()); END $w$;\nROLLBACK;`
    expect(MUTATING.test(stripProbeNoise(defective))).toBe(true)
    expect(/^\s*(CREATE EXTENSION[^;]*;\s*)?BEGIN\s*;/i.test(defective)).toBe(false)

    // NEGATIVE 1: a mutation named only in a COMMENT is not a mutation.
    const commented = `-- INSERT INTO public.entitlement_grants is only mentioned here\nSELECT 1;`
    expect(MUTATING.test(stripProbeNoise(commented))).toBe(false)

    // NEGATIVE 2: the exact false positive this guard actually produced — the
    // English word "grant" inside a RAISE message on a READ-ONLY probe.
    const readOnly = `DO $w$ BEGIN RAISE EXCEPTION 'OrgC must hold exactly one live grant for this to mean anything'; END $w$;`
    expect(MUTATING.test(stripProbeNoise(readOnly))).toBe(false)

    // NEGATIVE 3: a real GRANT statement is still caught, so stripping literals
    // has not blinded the detector to the thing it exists for.
    expect(MUTATING.test(stripProbeNoise(`BEGIN;\nGRANT SELECT ON public.entitlement_grants TO authenticated;`))).toBe(true)
  })
})
