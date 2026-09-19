// tests/postgres/organization-commercial-acceptance-owner-topology.pg.test.ts
//
// L1 PG-06 REMEDIATION (HPO-ODS-W2-34) — THE OWNER-CAPABILITY CLOSED WORLD.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL, AND WHY ITS PROOF CANNOT LIVE IN THE L1 SUITE
// ---------------------------------------------------------------------------
// Making the trigger function SECURITY DEFINER moves its auth reach from the
// CALLER to the OWNER. That creates a new obligation nobody had before: the
// deployed function owner must actually HOLD the capabilities the body needs,
// and must hold NO MORE than those.
//
// That obligation cannot be proven in the canonical L1 fixture. MEASURED: the
// harness applies every fixture statement as `postgres`, the fixture's
// HOSTED_FIDELITY block re-homes only what pg_tables returns (TABLES), so the
// function stays owned by `postgres` — and on postgres:16-alpine that role is
// a SUPERUSER. A superuser owner satisfies every capability below trivially.
// An owner-capability suite run there would be GREEN against an owner that
// holds nothing, which is worse than no suite: it is a suite that cannot fail.
//
// So this file builds a CERTIFICATION-ONLY substrate whose function owner is
// deliberately NOT a superuser. It is the only place in the repository that
// issues ALTER FUNCTION ... OWNER TO, and that statement carries NO implication
// for production: it exists to make the requirement OBSERVABLE, never to
// suggest the deployed topology should re-home anything. The production rule is
// the opposite — the amended migration contains zero ownership statements and
// CREATE OR REPLACE preserves whatever owner applied it.
//
// ---------------------------------------------------------------------------
// C7 IS NOT BYPASSRLS, AND THE DISTINCTION IS THE WHOLE POINT OF FN-07
// ---------------------------------------------------------------------------
// SELECT PRIVILEGE IS NOT ROW VISIBILITY. db/migrations/0070 puts both legal
// registries under ENABLE ROW LEVEL SECURITY with a single SELECT policy TO
// uellix_app. A function owner that is neither named by a policy nor the table
// owner therefore reads ZERO ROWS — and the trigger does not raise a privilege
// error, it falls into its own foreign-key guard and reports 23503 'does not
// reference a published version'. A missing PRIVILEGE says 42501 and names the
// table; a missing VISIBILITY says 23503 and names nothing. Telling those two
// apart is what separates a real closed world from a list.
//
// Three mechanisms satisfy C7 and they are NOT interchangeable as evidence:
//   M1 TABLE OWNERSHIP  — THE PRODUCTION MECHANISM. RLS on both registries is
//                         ENABLE and NOT FORCE, so the table owner is exempt.
//   M2 A POLICY NAMING  — THE PROBE MECHANISM, used here. It keeps the probe
//      THE OWNER          owner NOSUPERUSER, NOBYPASSRLS and non-owner, and it
//                         makes C7 independently removable.
//   M3 BYPASSRLS        — sufficient, and REFUSED here. A probe that reached
//                         green through BYPASSRLS would license the inference
//                         that PRODUCTION needs it. Production needs ownership.
//
// ---------------------------------------------------------------------------
// GATING
// ---------------------------------------------------------------------------
// UELLIX_PG_TESTS=1 (Docker required). Disposable cluster only, ephemeral port,
// no bind mounts, teardown in the harness's own `finally`, leftover check.
// NEVER staging, NEVER production, NEVER the canonical local stack.

import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import {
  runDisposableHarness,
  DEFAULT_IMAGE,
  type HarnessOutcome,
  type ProbeManifest,
  type SetupManifest,
} from '../../scripts/db-audit-disposable'
import {
  IDS,
  ORG_V1_DIGEST,
  asUser,
  buildSetupManifest,
} from './organization-commercial-acceptance-fixtures'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const RELATION = 'organization_commercial_acceptances'
const FN = 'public.enforce_organization_commercial_acceptance_invariants()'

/** The non-superuser function owner this substrate exists to establish. */
const PROBE_OWNER = 'probe_fn_owner'

/** The schema the M-02 semantic arm plants its counterfeit registry in. */
const SHADOW = 'shadow_attack'

/**
 * SENTINEL_FORGED_CONTENT_DIGEST. If this value is ever found STORED in
 * organization_commercial_acceptances outside M-02 STATE_2, I-T4-4 has been
 * defeated and the search_path pin is not holding.
 */
const FORGED_DIGEST = 'sha256:dead' + '0'.repeat(60)

const L1_UNIT = BASELINE_UNITS.find((u) =>
  /^\d{4}_customer_lifecycle_l1_organization_commercial_acceptance\.sql$/.test(u.id)
)
if (!L1_UNIT) {
  throw new Error('the L1 organization-commercial-acceptance baseline unit is not registered in db/hosted/baseline-manifest.ts')
}

/** A well-formed acceptance INSERT, schema-qualified so the TARGET never moves with search_path. */
function insertAcceptance(opts: { org?: string; version?: string; digest?: string; actor?: string; role?: string } = {}): string {
  return `INSERT INTO public.${RELATION}
     (organization_id, instrument_key, instrument_version_id, content_digest, accepted_by_user_id, accepted_by_role)
   VALUES ('${opts.org ?? IDS.orgA}', 'commercial_terms', '${opts.version ?? IDS.orgVersionV1}', '${opts.digest ?? ORG_V1_DIGEST}', '${opts.actor ?? IDS.adminA}', '${opts.role ?? 'organization_admin'}')`
}

// ---------------------------------------------------------------------------
// THE CAPABILITY LEDGER.
//
// Each entry is ONE independently revocable capability plus the error its
// removal was MEASURED to produce. Expressing them as data rather than as
// hand-written probe pairs is what makes M-05a..M-05e literally the same code
// path as FN-04: a capability cannot be asserted here and forgotten in the
// mutation matrix, because both are generated from this array.
// ---------------------------------------------------------------------------
interface Capability {
  id: 'C1' | 'C2' | 'C3' | 'C4' | 'C5'
  what: string
  /** Statements that REMOVE the capability from the probe owner. */
  revoke: string
  /** Statements that RESTORE it. */
  restore: string
  /** The SQLSTATE the positive was measured to return with the capability gone. */
  sqlstate: string
  /** The MESSAGE_TEXT, compared EXACTLY — 42501 alone cannot tell C3 from C4. */
  message: string
}

const CAPABILITIES: Capability[] = [
  {
    id: 'C1',
    what: 'USAGE ON SCHEMA auth',
    revoke: `REVOKE USAGE ON SCHEMA auth FROM ${PROBE_OWNER};`,
    restore: `GRANT USAGE ON SCHEMA auth TO ${PROBE_OWNER};`,
    sqlstate: '42501',
    message: 'permission denied for schema auth',
  },
  {
    id: 'C2',
    what: 'EXECUTE ON auth.uid()',
    // THE PUBLIC ARM IS MANDATORY AND IS THE WHOLE POINT. auth.uid() carries
    // EXECUTE to PUBLIC by default and the hosted baseline adds no REVOKE, so
    // revoking only the per-role grant leaves the positive GREEN. A mutation
    // written that way would certify a capability nobody proved. The
    // three-state vacuity demonstration lives in its own control below.
    revoke: `REVOKE EXECUTE ON FUNCTION auth.uid() FROM ${PROBE_OWNER}; REVOKE EXECUTE ON FUNCTION auth.uid() FROM PUBLIC;`,
    restore: `GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; GRANT EXECUTE ON FUNCTION auth.uid() TO ${PROBE_OWNER};`,
    sqlstate: '42501',
    message: 'permission denied for function uid',
  },
  {
    id: 'C3',
    what: 'SELECT ON legal_instrument_versions',
    revoke: `REVOKE SELECT ON public.legal_instrument_versions FROM ${PROBE_OWNER};`,
    restore: `GRANT SELECT ON public.legal_instrument_versions TO ${PROBE_OWNER};`,
    sqlstate: '42501',
    message: 'permission denied for table legal_instrument_versions',
  },
  {
    id: 'C4',
    // A DISTINCT capability from C3 with a DISTINCT error. The two registry
    // reads sit in ONE SELECT but are two separately revocable privileges, and
    // a control matching only the versions table would not fire here.
    id_note: undefined,
    what: 'SELECT ON legal_instruments',
    revoke: `REVOKE SELECT ON public.legal_instruments FROM ${PROBE_OWNER};`,
    restore: `GRANT SELECT ON public.legal_instruments TO ${PROBE_OWNER};`,
    sqlstate: '42501',
    message: 'permission denied for table legal_instruments',
  } as Capability,
  {
    id: 'C5',
    // OMITTED ENTIRELY by the first draft of this authority. It is load-bearing
    // precisely because db/migrations/0033 revokes EXECUTE on all public
    // functions from PUBLIC, so nothing supplies it by default. The helper is
    // itself SECURITY DEFINER, so the trigger owner needs EXECUTE on it and
    // needs NOTHING the helper reads.
    what: 'EXECUTE ON public.current_user_role_in_org(uuid)',
    revoke: `REVOKE EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) FROM ${PROBE_OWNER};`,
    restore: `GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO ${PROBE_OWNER};`,
    sqlstate: '42501',
    message: 'permission denied for function current_user_role_in_org',
  },
]

/**
 * The MEASURED NON-dependencies. The closed world is tight in BOTH directions:
 * without this half FN-04 could be satisfied by an over-privileged owner and
 * nothing would object, which would make the "closed world" a list rather than
 * a boundary.
 */
const NON_DEPENDENCIES: { id: string; probe: string; grant: string; revoke: string }[] = [
  {
    id: 'SELECT on organization_members',
    probe: `has_table_privilege('${PROBE_OWNER}', 'public.organization_members', 'SELECT')`,
    grant: `GRANT SELECT ON public.organization_members TO ${PROBE_OWNER};`,
    revoke: `REVOKE SELECT ON public.organization_members FROM ${PROBE_OWNER};`,
  },
  {
    id: 'EXECUTE on current_user_org_ids()',
    probe: `has_function_privilege('${PROBE_OWNER}', 'public.current_user_org_ids()', 'EXECUTE')`,
    grant: `GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO ${PROBE_OWNER};`,
    revoke: `REVOKE EXECUTE ON FUNCTION public.current_user_org_ids() FROM ${PROBE_OWNER};`,
  },
  {
    id: `INSERT on ${RELATION}`,
    probe: `has_table_privilege('${PROBE_OWNER}', 'public.${RELATION}', 'INSERT')`,
    grant: `GRANT INSERT ON public.${RELATION} TO ${PROBE_OWNER};`,
    revoke: `REVOKE INSERT ON public.${RELATION} FROM ${PROBE_OWNER};`,
  },
]

// ---------------------------------------------------------------------------
// SUBSTRATE
// ---------------------------------------------------------------------------

/**
 * The canonical L1 setup, then the certification-only owner topology on top.
 *
 * ORDER MATTERS: the re-home must follow the baseline units, because 0072 is
 * what creates the function in the first place.
 */
export function buildOwnerTopologySetup(): SetupManifest {
  const base = buildSetupManifest()

  const topology = `
-- A deliberately WEAK role. NOSUPERUSER and NOBYPASSRLS are asserted back by
-- FN-07 rather than trusted: they are the two properties that would make every
-- capability control below vacuous if they silently drifted.
CREATE ROLE ${PROBE_OWNER} NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;

-- THE ONE ALTER OWNER IN THE REPOSITORY, and it is certification-only.
ALTER FUNCTION ${FN} OWNER TO ${PROBE_OWNER};

-- C1..C5, granted individually so each can be revoked individually. C6 (USAGE
-- ON SCHEMA public) arrives via the PUBLIC default and is recorded as
-- required-but-not-independently-mutable: revoking it per-role is impossible
-- without revoking from PUBLIC, which would also disable the invoker and
-- confound every measurement in this file.
GRANT USAGE ON SCHEMA auth TO ${PROBE_OWNER};
GRANT EXECUTE ON FUNCTION auth.uid() TO ${PROBE_OWNER};
GRANT SELECT ON public.legal_instrument_versions TO ${PROBE_OWNER};
GRANT SELECT ON public.legal_instruments TO ${PROBE_OWNER};
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO ${PROBE_OWNER};

-- C7 -- RLS-VISIBLE READ REACH, via mechanism M2 (a probe-only policy).
--
-- The predicate is USING (true) DELIBERATELY. The shipped registry policies
-- read auth.uid(), and a probe policy that did the same would collapse C7 into
-- C1: revoking auth USAGE would then break VISIBILITY as well as the auth
-- assignment, and the 42501/23503 discrimination this whole file rests on
-- would stop working. USING (true) isolates visibility from every other
-- capability, which is exactly what an independently-removable control needs.
CREATE POLICY "probe_owner_reads_versions" ON public.legal_instrument_versions
  FOR SELECT TO ${PROBE_OWNER} USING (true);
CREATE POLICY "probe_owner_reads_instruments" ON public.legal_instruments
  FOR SELECT TO ${PROBE_OWNER} USING (true);

-- THE COUNTERFEIT REGISTRY for the M-02 semantic arm.
--
-- The schema is owned by postgres and the TABLES by the probe owner, so the
-- arm can control the owner's USAGE ON SCHEMA independently of whether it can
-- read the rows. That separation is what makes STATE_1 and STATE_2 different
-- states rather than the same state twice.
--
-- The counterfeit version reuses the REAL version's id on purpose: the
-- acceptance table carries a FOREIGN KEY on instrument_version_id, so an
-- invented id would be refused by the constraint and the attack would never
-- reach the guard it is meant to defeat. Same id, forged digest.
CREATE SCHEMA ${SHADOW};
CREATE TABLE ${SHADOW}.legal_instruments (instrument_key varchar(100) PRIMARY KEY, instrument_class varchar(20) NOT NULL);
CREATE TABLE ${SHADOW}.legal_instrument_versions (id uuid PRIMARY KEY, instrument_key varchar(100) NOT NULL, content_digest text NOT NULL);
INSERT INTO ${SHADOW}.legal_instruments VALUES ('commercial_terms', 'ORGANIZATION');
INSERT INTO ${SHADOW}.legal_instrument_versions VALUES ('${IDS.orgVersionV1}', 'commercial_terms', '${FORGED_DIGEST}');
ALTER TABLE ${SHADOW}.legal_instruments OWNER TO ${PROBE_OWNER};
ALTER TABLE ${SHADOW}.legal_instrument_versions OWNER TO ${PROBE_OWNER};
-- The probe owner starts BLIND to it. STATE_2 is what grants the USAGE.
REVOKE ALL ON SCHEMA ${SHADOW} FROM ${PROBE_OWNER};
`

  return { statements: [...base.statements, topology] }
}

// ---------------------------------------------------------------------------
// PROBES
// ---------------------------------------------------------------------------

/** The positive insert, asserted to SUCCEED. Rolls back, so nothing accumulates. */
function positiveMustBeGreen(tag: string, extra = ''): string {
  return (
    asUser(IDS.adminA) +
    extra +
    `DO $w$ BEGIN
  ${insertAcceptance()};
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION '${tag}: expected the positive to be GREEN, measured % %', SQLSTATE, SQLERRM;
END $w$;
ROLLBACK;`
  )
}

/** The positive insert, asserted to fail with an EXACT code AND an EXACT message. */
function positiveMustBeRed(tag: string, sqlstate: string, message: string, extra = ''): string {
  return (
    asUser(IDS.adminA) +
    extra +
    `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    ${insertAcceptance()};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; END;
  IF caught <> '${sqlstate}' THEN RAISE EXCEPTION '${tag}: caught=% expected=${sqlstate} (msg=%)', caught, msg; END IF;
  IF msg <> '${message.replace(/'/g, "''")}' THEN
    RAISE EXCEPTION '${tag}: right SQLSTATE, WRONG cause -- measured message=%', msg;
  END IF;
END $w$;
ROLLBACK;`
  )
}

export function buildOwnerTopologyProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  // -------------------------------------------------------------------------
  // FN-07 — C7 MECHANISM HYGIENE, asserted FIRST.
  //
  // Everything after it is only meaningful if the owner really is weak. If the
  // probe role turned out to be a superuser or to hold BYPASSRLS, every
  // capability control below would pass while proving nothing, so this runs
  // before any of them.
  // -------------------------------------------------------------------------
  add('FN-07-the-probe-owner-is-NOSUPERUSER-NOBYPASSRLS-and-owns-NEITHER-registry',
    `DO $w$ DECLARE is_super boolean; can_bypass boolean; owns_v name; owns_i name; BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, can_bypass FROM pg_roles WHERE rolname = '${PROBE_OWNER}';
  IF is_super THEN RAISE EXCEPTION 'FN-07 the probe owner is a SUPERUSER -- every capability control in this file would be vacuous'; END IF;
  IF can_bypass THEN RAISE EXCEPTION 'FN-07 the probe owner holds BYPASSRLS -- C7 would be satisfied by the mechanism this control exists to refuse'; END IF;
  SELECT pg_get_userbyid(relowner) INTO owns_v FROM pg_class WHERE oid = 'public.legal_instrument_versions'::regclass;
  SELECT pg_get_userbyid(relowner) INTO owns_i FROM pg_class WHERE oid = 'public.legal_instruments'::regclass;
  IF owns_v = '${PROBE_OWNER}' OR owns_i = '${PROBE_OWNER}' THEN
    RAISE EXCEPTION 'FN-07 the probe owner OWNS a registry (v=%, i=%) -- it would be RLS-exempt and C7 would not be removable', owns_v, owns_i;
  END IF;
END $w$;`)

  add('FN-07b-RLS-on-both-registries-is-ENABLE-and-NOT-FORCE-which-is-what-makes-OWNERSHIP-the-production-mechanism',
    `DO $w$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c WHERE c.oid IN ('public.legal_instruments'::regclass, 'public.legal_instrument_versions'::regclass) LOOP
    IF r.relrowsecurity IS NOT TRUE THEN RAISE EXCEPTION 'FN-07b RLS is not enabled on % -- C7 is invisible on this substrate, which is exactly how it was missed before', r.relname; END IF;
    IF r.relforcerowsecurity IS TRUE THEN RAISE EXCEPTION 'FN-07b RLS is FORCED on % -- the table owner would NOT be exempt and the production mechanism (M1) would not hold', r.relname; END IF;
  END LOOP;
END $w$;`)

  add('FN-07c-the-probe-owner-is-the-function-owner-which-is-what-this-whole-substrate-exists-to-establish',
    `DO $w$ DECLARE fn_owner name; BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO fn_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_organization_commercial_acceptance_invariants';
  IF fn_owner <> '${PROBE_OWNER}' THEN RAISE EXCEPTION 'FN-07c the function owner is % -- the re-home did not take, so nothing below measures the owner', fn_owner; END IF;
END $w$;`)

  // -------------------------------------------------------------------------
  // FN-04 — the closed world is PRESENT, and the positive is GREEN with it.
  // -------------------------------------------------------------------------
  add('FN-04-the-owner-holds-C1-C6-asserted-INDIVIDUALLY-not-as-a-single-reach',
    `DO $w$ BEGIN
  IF NOT has_schema_privilege('${PROBE_OWNER}', 'auth', 'USAGE') THEN RAISE EXCEPTION 'FN-04 C1 absent'; END IF;
  IF NOT has_function_privilege('${PROBE_OWNER}', 'auth.uid()', 'EXECUTE') THEN RAISE EXCEPTION 'FN-04 C2 absent'; END IF;
  IF NOT has_table_privilege('${PROBE_OWNER}', 'public.legal_instrument_versions', 'SELECT') THEN RAISE EXCEPTION 'FN-04 C3 absent'; END IF;
  IF NOT has_table_privilege('${PROBE_OWNER}', 'public.legal_instruments', 'SELECT') THEN RAISE EXCEPTION 'FN-04 C4 absent'; END IF;
  IF NOT has_function_privilege('${PROBE_OWNER}', 'public.current_user_role_in_org(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FN-04 C5 absent'; END IF;
  IF NOT has_schema_privilege('${PROBE_OWNER}', 'public', 'USAGE') THEN RAISE EXCEPTION 'FN-04 C6 absent'; END IF;
END $w$;`)

  add('FN-04-C7-the-owner-has-RLS-VISIBLE-read-reach-via-a-PROBE-ONLY-policy-not-via-BYPASSRLS',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('legal_instruments','legal_instrument_versions')
     AND '${PROBE_OWNER}' = ANY(roles);
  IF n <> 2 THEN RAISE EXCEPTION 'FN-04 C7 expected exactly two probe-only policies naming the owner, measured %', n; END IF;
END $w$;`)

  add('FN-04-POSITIVE-with-the-full-closed-world-present-the-insert-SUCCEEDS-against-a-NON-SUPERUSER-owner',
    positiveMustBeGreen('FN-04-POSITIVE'))

  // -------------------------------------------------------------------------
  // FN-05 — the NEGATIVE half. Tightness, not just sufficiency.
  // -------------------------------------------------------------------------
  add('FN-05-the-owner-holds-NONE-of-the-measured-non-dependencies-WHILE-the-positive-is-GREEN',
    `DO $w$ BEGIN
${NON_DEPENDENCIES.map((d) => `  IF ${d.probe} THEN RAISE EXCEPTION 'FN-05 the owner holds ${d.id.replace(/'/g, "''")}, which the positive was measured NOT to need -- the closed world is a list, not a boundary'; END IF;`).join('\n')}
END $w$;
` + positiveMustBeGreen('FN-05'))

  // -------------------------------------------------------------------------
  // M-05a .. M-05e — remove EACH capability individually.
  //
  // Each probe MUTATES, OBSERVES, RESTORES and RE-PROVES GREEN in one psql
  // invocation. Restoring inside the probe is not tidiness: the registry read
  // precedes the auth assignment, so a lingering removal MASKS the next
  // mutation and the remaining controls would all fire on the first error.
  // -------------------------------------------------------------------------
  for (const cap of CAPABILITIES) {
    add(`M-05-${cap.id}-removing-${cap.id}-turns-the-positive-RED-with-its-OWN-measured-error`,
      `${cap.revoke}
${positiveMustBeRed(`M-05-${cap.id}`, cap.sqlstate, cap.message)}
${cap.restore}
${positiveMustBeGreen(`M-05-${cap.id}-RESTORED`)}`)
  }

  // M-05b VACUITY DEMONSTRATION. This is not decoration: it is the evidence
  // that the per-role-only form of the C2 mutation is worthless, and it is the
  // reason M-05-C2 above revokes from PUBLIC as well.
  add('M-05-C2-VACUITY-revoking-only-the-PER-ROLE-grant-leaves-the-positive-GREEN-which-is-why-the-PUBLIC-arm-is-mandatory',
    `REVOKE EXECUTE ON FUNCTION auth.uid() FROM ${PROBE_OWNER};
${positiveMustBeGreen('M-05-C2-VACUITY-per-role-only')}
REVOKE EXECUTE ON FUNCTION auth.uid() FROM PUBLIC;
${positiveMustBeRed('M-05-C2-VACUITY-both-revoked', '42501', 'permission denied for function uid')}
GRANT EXECUTE ON FUNCTION auth.uid() TO ${PROBE_OWNER};
${positiveMustBeGreen('M-05-C2-VACUITY-per-role-restored-PUBLIC-still-revoked')}
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;`)

  // -------------------------------------------------------------------------
  // M-05f — grant a NON-dependency and prove FN-05 notices.
  // -------------------------------------------------------------------------
  for (const dep of NON_DEPENDENCIES) {
    const slug = dep.id.replace(/[^a-zA-Z0-9]+/g, '-')
    add(`M-05f-granting-${slug}-turns-FN-05-RED`,
      `${dep.grant}
DO $w$ BEGIN
  IF NOT ${dep.probe} THEN RAISE EXCEPTION 'M-05f the mutation did not take -- ${dep.id.replace(/'/g, "''")} is still absent, so FN-05 was never challenged'; END IF;
END $w$;
${dep.revoke}
DO $w$ BEGIN
  IF ${dep.probe} THEN RAISE EXCEPTION 'M-05f the mutation was not RESTORED -- ${dep.id.replace(/'/g, "''")} is still present'; END IF;
END $w$;
${positiveMustBeGreen(`M-05f-${slug}-RESTORED`)}`)
  }

  // -------------------------------------------------------------------------
  // M-05g — C7, once per registry.
  //
  // THE TWO HALVES ARE OBSERVATIONALLY IDENTICAL. One JOIN reads both
  // registries, so either invisible side collapses the row to none and both
  // yield 23503 'does not reference a published version'. Each half is
  // therefore anchored by WHICH POLICY THE PROBE DROPPED, never by the
  // message, and this file does not claim to tell them apart by observation.
  //
  // What it DOES discriminate, and must, is C7 from C3/C4: a missing PRIVILEGE
  // raises 42501 and NAMES THE TABLE (M-05-C3/C4 above); a missing VISIBILITY
  // raises 23503 and names nothing. The removal is performed by dropping the
  // policy and NEVER by toggling BYPASSRLS, so nothing here can be read as
  // evidence that production needs it.
  // -------------------------------------------------------------------------
  for (const [table, policy] of [
    ['legal_instrument_versions', 'probe_owner_reads_versions'],
    ['legal_instruments', 'probe_owner_reads_instruments'],
  ] as const) {
    add(`M-05g-dropping-the-probe-only-policy-on-${table}-turns-the-positive-RED-23503-visibility-not-42501-privilege`,
      `DROP POLICY "${policy}" ON public.${table};
DO $w$ BEGIN
  IF has_table_privilege('${PROBE_OWNER}', 'public.${table}', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'M-05g the SELECT PRIVILEGE was removed too -- this would be a C3/C4 mutation wearing a C7 label';
  END IF;
END $w$;
${positiveMustBeRed(`M-05g-${table}`, '23503', `organization_commercial_acceptances: instrument_version_id ${IDS.orgVersionV1} does not reference a published version`)}
CREATE POLICY "${policy}" ON public.${table} FOR SELECT TO ${PROBE_OWNER} USING (true);
${positiveMustBeGreen(`M-05g-${table}-RESTORED`)}`)
  }

  // -------------------------------------------------------------------------
  // M-02 — THE SEARCH_PATH PIN, AS A THREE-STATE PROOF.
  //
  // A catalog-shape assertion alone is weak and a two-state arm passes for the
  // wrong reason. MEASURED, and all three states are binding:
  //
  //   STATE_1  pin removed, owner BLIND to the shadow schema
  //            => ATTACK REFUSED 23514 digest mismatch. Name resolution
  //               silently SKIPS schemas the effective user cannot see, so the
  //               real registry answers and the forged digest does not match.
  //   STATE_2  pin removed, owner CAN SEE the shadow schema
  //            => ATTACK SUCCEEDS. The forged digest is STORED. I-T4-4 is
  //               defeated. THIS IS THE ONLY STATE THAT FALSIFIES THE PIN.
  //   STATE_3  pin restored, owner still sees it
  //            => ATTACK REFUSED again.
  //
  // A suite that ran STATE_1 alone would observe a harmless failure and
  // conclude the pin is unnecessary -- the exact wrong conclusion. Granting the
  // owner USAGE on the shadow schema is what reaches STATE_2; it is permitted
  // for this certification-only probe and implies nothing for production.
  // -------------------------------------------------------------------------
  const ATTACK_PRELUDE = `SET LOCAL search_path = ${SHADOW}, public;\n`
  const attack = (tag: string, expect: 'REFUSED' | 'STORED') =>
    asUser(IDS.adminA) +
    ATTACK_PRELUDE +
    (expect === 'REFUSED'
      ? `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    ${insertAcceptance({ digest: FORGED_DIGEST })};
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; END;
  IF caught <> '23514' THEN RAISE EXCEPTION '${tag}: expected the digest guard to refuse with 23514, caught=% (msg=%)', caught, msg; END IF;
  IF msg NOT LIKE '%content_digest does not match%' THEN RAISE EXCEPTION '${tag}: refused 23514 but NOT on the digest guard -- msg=%', msg; END IF;
END $w$;
ROLLBACK;`
      : `DO $w$ DECLARE n int; BEGIN
  ${insertAcceptance({ digest: FORGED_DIGEST })};
  SELECT count(*) INTO n FROM public.${RELATION} WHERE content_digest = '${FORGED_DIGEST}';
  IF n <> 1 THEN RAISE EXCEPTION '${tag}: the pin was removed and the owner could see the shadow schema, yet the forged digest was NOT stored (n=%) -- the arm did not reach STATE_2 and proves nothing', n; END IF;
END $w$;
ROLLBACK;`)

  add('M-02-STATE-1-pin-REMOVED-owner-BLIND-to-the-shadow-schema-the-attack-is-REFUSED-which-alone-would-prove-the-pin-unnecessary',
    `ALTER FUNCTION ${FN} RESET search_path;
${attack('M-02-STATE-1', 'REFUSED')}`)

  add('M-02-STATE-2-pin-REMOVED-owner-CAN-SEE-the-shadow-schema-the-attack-SUCCEEDS-and-the-forged-digest-is-STORED',
    `GRANT USAGE ON SCHEMA ${SHADOW} TO ${PROBE_OWNER};
${attack('M-02-STATE-2', 'STORED')}`)

  add('M-02-STATE-3-pin-RESTORED-owner-still-sees-the-shadow-schema-the-attack-is-REFUSED-again',
    `ALTER FUNCTION ${FN} SET search_path = public;
${attack('M-02-STATE-3', 'REFUSED')}
${positiveMustBeGreen('M-02-STATE-3-legitimate-positive-still-green', ATTACK_PRELUDE)}`)

  add('M-02-FN-02-the-catalog-shape-is-back-to-exactly-search_path-public-after-the-arm',
    `DO $w$ DECLARE cfg text[]; secdef boolean; BEGIN
  SELECT p.proconfig, p.prosecdef INTO cfg, secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_organization_commercial_acceptance_invariants';
  IF secdef IS NOT TRUE THEN RAISE EXCEPTION 'M-02 restoration left the function INVOKER'; END IF;
  IF cfg IS DISTINCT FROM ARRAY['search_path=public'] THEN RAISE EXCEPTION 'M-02 restoration left proconfig as %', cfg; END IF;
END $w$;`)

  // SENTINEL sweep. The forged digest was observed STORED inside STATE_2's
  // transaction and that transaction rolled back. If it is committed anywhere,
  // the pin is not holding on this substrate.
  add('SENTINEL-FORGED-CONTENT-DIGEST-appears-in-NO-committed-row',
    `DO $w$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.${RELATION} WHERE content_digest = '${FORGED_DIGEST}';
  IF n <> 0 THEN RAISE EXCEPTION 'SENTINEL_FORGED_CONTENT_DIGEST is committed in % row(s) -- I-T4-4 has been defeated', n; END IF;
END $w$;`)

  return { probes }
}

const EXPECTED_PROBE_IDS = buildOwnerTopologyProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)(
  'L1 PG-06 remediation — OWNER TOPOLOGY PROBE (certification-only, non-superuser function owner)',
  { timeout: 1_800_000 },
  () => {
    let outcome: HarnessOutcome

    beforeAll(() => {
      outcome = runDisposableHarness({
        image: DEFAULT_IMAGE,
        setup: buildOwnerTopologySetup(),
        probe: buildOwnerTopologyProbeManifest(),
      })
      console.log(
        `L1_OWNER_TOPOLOGY_OUTCOME=${JSON.stringify({
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

    it('the substrate came up and tore itself down with zero leftovers', () => {
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

/* -------------------------------------------------------------------------- */
/* THE PRODUCTION BOUNDARY — DB-free, and therefore NEVER SKIPPED.            */
/*                                                                            */
/* Everything above runs on a substrate that deliberately re-homes a function  */
/* and creates policies on the two registries. These assertions are what stop  */
/* any of that leaking into the claim about production: the amended migration  */
/* does none of it.                                                            */
/* -------------------------------------------------------------------------- */
describe('L1 PG-06 remediation — the amended migration implies NO production ownership or RLS change', () => {
  const L1_SQL = readFileSync(path.resolve(__dirname, '..', '..', L1_UNIT!.file), 'utf8')

  /**
   * The unit with `--` line comments and block comments removed.
   *
   * MEASURED NECESSITY, not caution. db/migrations/0072:160 contains the
   * sentence "including the table owner and a superuser", which is the PROSE
   * explaining why the trigger binds every writer. A token scan over the raw
   * bytes counts that explanation as a privilege grant — the first draft of
   * this control did exactly that and went red against a correct migration.
   *
   * The lesson generalises: a control that forbids a TOKEN must admit the
   * token appearing in the text that justifies the control. Stripping comments
   * does not weaken the assertion, it gives it grammar.
   */
  const L1_CODE = L1_SQL.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

  it('confers no BYPASSRLS and no SUPERUSER — in CODE, admitting the prose that explains why', () => {
    // The tokens, outside comments.
    expect(L1_CODE).not.toMatch(/BYPASSRLS/i)
    expect(L1_CODE).not.toMatch(/\bSUPERUSER\b/i)
    // And the statements that could confer them, so a future edit cannot
    // smuggle a role attribute in under a spelling this pair does not know.
    expect(L1_CODE).not.toMatch(/\b(CREATE|ALTER)\s+ROLE\b/i)
    expect(L1_CODE).not.toMatch(/\bALTER\s+USER\b/i)
    // The prose IS still there — asserted, so that a future editor deleting
    // the explanation cannot make this control pass for the wrong reason.
    expect(L1_SQL).toMatch(/\bsuperuser\b/i)
  })

  it('creates no policy on legal_instruments or legal_instrument_versions', () => {
    // C7 is satisfied in production by OWNERSHIP, never by a new policy. If
    // the remediation ever created one here it would be widening the registry
    // read surface under cover of a privilege-mode change.
    const policyTargets = [...L1_CODE.matchAll(/CREATE\s+POLICY\s+"?[\w]+"?\s+ON\s+"?([\w.]+)"?/gi)].map((m) => m[1])
    expect(policyTargets.length).toBeGreaterThan(0) // the unit DOES create policies — on its own table
    expect(policyTargets).not.toContain('legal_instruments')
    expect(policyTargets).not.toContain('legal_instrument_versions')
  })

  it('issues no ALTER FUNCTION ... OWNER TO — the one in this file is certification-only', () => {
    expect(L1_CODE).not.toMatch(/ALTER\s+FUNCTION[\s\S]*?OWNER\s+TO/i)
  })

  it('CI-01 — the L1 real-PG workflow NAMES this file, so it is not a committed-but-unexecuted document', () => {
    // MEASURED HAZARD: the workflow invokes vitest on explicitly named paths.
    // vitest discovers nothing else in tests/postgres/**, so a suite absent
    // from that file never runs — and a suite that never runs reports no
    // colour at all. Nothing else in the repository turns red when this path
    // is dropped, which is precisely why the check has to be an assertion and
    // not a convention.
    const workflow = readFileSync(
      path.resolve(__dirname, '..', '..', '.github/workflows/l1-organization-commercial-acceptance-real-pg-gate.yml'),
      'utf8'
    )
    // THE COMMANDS, NOT THE COMMENTARY. The workflow's header EXPLAINS that
    // --passWithNoTests must never be set, so a scan over the raw file finds
    // the flag in the very sentence forbidding it. Same trap as the SUPERUSER
    // prose in the migration above: a control that forbids a token has to
    // admit the token in the text that justifies the control.
    const runLines = workflow
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')

    const invoked = [...runLines.matchAll(/pnpm exec vitest run (\S+)/g)].map((m) => m[1])
    expect(invoked).toContain('tests/postgres/organization-commercial-acceptance-owner-topology.pg.test.ts')
    // The two pre-existing oracles must not be displaced by the addition.
    expect(invoked).toContain('tests/postgres/organization-commercial-acceptance.pg.test.ts')
    expect(invoked).toContain('tests/postgres/organization-commercial-acceptance-real-derivation.pg.test.ts')
    // ... and each in its own step, so one heavy PostgreSQL lifecycle is alive
    // at a time (REAL_POSTGRESQL_EXCLUSIVE).
    expect(invoked).toHaveLength(3)
    // A run matching zero test files must FAIL, never exit 0.
    expect(runLines).not.toContain('--passWithNoTests')
    // Both gating variables set EXPLICITLY on every step: a skipped suite is
    // indistinguishable from a passing one, and the anti-skip self-check is
    // only armed by UELLIX_L1_PG_REQUIRED.
    expect(runLines.match(/UELLIX_PG_TESTS: '1'/g) ?? []).toHaveLength(3)
    expect(runLines.match(/UELLIX_L1_PG_REQUIRED: '1'/g) ?? []).toHaveLength(3)
  })

  it('the certification-only re-home lives HERE and nowhere in db/', () => {
    // If this ever moves into the migration corpus it stops being a probe
    // device and becomes a production privilege change.
    expect(buildOwnerTopologySetup().statements.join('\n')).toMatch(
      new RegExp(`ALTER FUNCTION ${FN.replace(/[().]/g, '\\$&')} OWNER TO ${PROBE_OWNER}`)
    )
  })
})
