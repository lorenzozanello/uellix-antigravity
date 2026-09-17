// tests/postgres/ce3-entitlement-grants-fixtures.ts
//
// CE-3 (HPO-ODS-W2-30) — the shared disposable-PostgreSQL substrate (roles,
// baseline units, hosted-fidelity shims, the commercial + tenant + grant
// fixture) that tests/postgres/ce3-entitlement-grants.pg.test.ts builds from.
//
// Deliberately NOT named `*.pg.test.ts` or `*.test.ts`: importing this module
// registers no describe() block, so it cannot re-execute a container cycle as
// an import side effect. Same reasoning as its CL-1 and L1 siblings,
// tests/postgres/legal-acceptance-fixtures.ts and
// tests/postgres/organization-commercial-acceptance-fixtures.ts.
//
// ---------------------------------------------------------------------------
// THE TOPOLOGY, AND WHY EACH PIECE EXISTS
// ---------------------------------------------------------------------------
//   CommercialAccount X  governs  OrgA, OrgB
//   CommercialAccount Y  governs  OrgC
//   OrgD                 UNGOVERNED — commercial_account_id IS NULL, no grant
//   OrgK                 governs-by-X scratch organization for the CONCURRENCY
//                        probe only, so the one probe that must COMMIT cannot
//                        perturb any other probe's organization.
//
// A SINGLE-ACCOUNT FIXTURE CANNOT EXPRESS THE CLAIM UNDER TEST. OrgA and OrgB
// share ONE CommercialAccount, which is what makes "shared governance does not
// imply shared visibility" (SC-4) a real test rather than a test of two
// unrelated tenants. OrgC is governed by a DIFFERENT account and carries a
// REAL grant, because a cross-organization probe that returns nothing for want
// of data proves nothing at all.
//
// ---------------------------------------------------------------------------
// AT MOST ONE ACTIVE MEMBERSHIP PER SUBJECT — MEASURED, NOT ASSUMED
// ---------------------------------------------------------------------------
// db/schema.ts declares uniqueIndex('user_single_active_membership') on
// (user_id) WHERE status = 'active'. So "a principal with several LIVE
// organization scopes" is UNSATISFIABLE against this schema, and a probe
// written that way would fail for the wrong reason.
//
// The explicit-organization property is therefore proven in the strongest form
// this schema admits, as a PAIR:
//
//   (a) THE ARGUMENT IS HONOURED. multiOrg is ACTIVE in OrgB and asks for
//       OrgB, whose grant carries a value DISTINCT from OrgA's — so returning
//       some other organization's row is detectable BY VALUE and not merely by
//       row count.
//   (b) AMBIENT SUBSTITUTION IS REFUSED. multiOrg ALSO holds an INACTIVE
//       membership row in OrgA and asks for OrgA — which must RAISE U0113. An
//       evaluator that fell back to the caller's own scope, to a "first
//       membership", or to any membership row regardless of status would
//       ANSWER here instead of raising.
//
// (b) is the POSITIVE wrong-tenant detector: the defective implementation
// returns a well-formed, entirely wrong answer, and only an assertion on the
// RAISE can see it.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP } from '@/db/hosted/prechain-ownership'
import type { SetupManifest } from '../../scripts/db-audit-disposable'

const ROOT = path.resolve(__dirname, '..', '..')

/** The one production capability key of the CE-3 catalogue. */
export const CAPABILITY = 'stella.grounded_query'

/**
 * A key that is NOT in the production catalogue. It exists ONLY to exercise the
 * UNDECLARED path and is NOT a catalogue entry — no production capability is
 * invented to make a test easier to write.
 */
export const UNDECLARED_CAPABILITY = 'stella.not_a_real_capability'

/**
 * SENTINEL_SIBLING_ORG_CANARY_ROW. A uniquely-valued string carried in OrgB's
 * grant `reason`. OrgB is governed by the SAME CommercialAccount as OrgA, so
 * this value must never appear in ANY result set, error payload or message
 * produced by a request scoped to OrgA. Asserted BY IDENTITY, never by row
 * count — a count cannot distinguish "denied" from "no such row".
 */
export const CANARY = 'CANARY-CE3-7f31ab-sibling-org-grant-must-never-surface-cross-tenant'

export const IDS = {
  caX: '0ce30000-0000-4000-8000-0000000000ca',
  caY: '0ce30000-0000-4000-8000-0000000000cb',

  orgA: '0ce30000-0000-4000-8000-00000000000a',
  orgB: '0ce30000-0000-4000-8000-00000000000b',
  orgC: '0ce30000-0000-4000-8000-00000000000c',
  orgD: '0ce30000-0000-4000-8000-00000000000d',
  orgK: '0ce30000-0000-4000-8000-00000000000e',

  // One subject per ACTIVE membership — the single-active-membership index
  // forbids one subject holding several.
  adminA: '0ce30000-0000-4000-8000-0000000000a1',
  adminB: '0ce30000-0000-4000-8000-0000000000b1',
  adminC: '0ce30000-0000-4000-8000-0000000000c1',
  adminD: '0ce30000-0000-4000-8000-0000000000d1',
  adminK: '0ce30000-0000-4000-8000-0000000000e1',

  /** ACTIVE in OrgB, INACTIVE row in OrgA. See the explicit-organization pair above. */
  multiOrg: '0ce30000-0000-4000-8000-0000000000f1',

  /** No membership anywhere. Proves a scopeless caller is refused, not answered. */
  outsider: '0ce30000-0000-4000-8000-0000000000f2',

  /**
   * A PLATFORM super-admin (public.users.is_super_admin = true) with NO
   * membership in any organization. CE-3 invents no super-admin bypass
   * (RLS_SECURITY_CONTRACT.prohibitions_restated), so this subject must be
   * refused exactly like any other non-member — asserted, not assumed.
   */
  platformSuperAdmin: '0ce30000-0000-4000-8000-0000000000fa',

  /** An organization id that exists in no row at all. */
  nonExistentOrg: '0ce30000-0000-4000-8000-0000000000ff',

  grantOrgALive: '0ce30000-0000-4000-8000-000000001001',
  grantOrgAClosed: '0ce30000-0000-4000-8000-000000001002',
  grantOrgB: '0ce30000-0000-4000-8000-000000001003',
  grantOrgC: '0ce30000-0000-4000-8000-000000001004',
} as const

/**
 * The cluster role topology. Mirrors the L1/CL-1 prelude exactly; roles are
 * cluster-wide and this is a throwaway container.
 *
 * uellix_owner is NOBYPASSRLS and NOT a superuser, and the tenant-facing roles
 * are NOBYPASSRLS too. That is load-bearing rather than cosmetic: FORCE ROW
 * LEVEL SECURITY is SILENTLY INERT for a BYPASSRLS role and for the table
 * owner, so a fixture that quietly granted BYPASSRLS anywhere would make every
 * isolation probe below pass while measuring nothing. The suite ASSERTS these
 * attributes from pg_roles rather than trusting this block.
 */
const ROLE_PRELUDE = `
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN CREATE ROLE uellix_owner NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN CREATE ROLE uellix_writer NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN CREATE ROLE uellix_auditor NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN CREATE ROLE uellix_migrator NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN CREATE ROLE uellix_app NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS; END IF;
END $r$;
GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE;
GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE;
`

const G2_PREREQUISITE_SHIM = `
CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  interaction_id uuid,
  suggestion_key text NOT NULL,
  decision text NOT NULL,
  previous_value_hash text,
  applied_text text,
  rejection_reason text,
  decided_by uuid NOT NULL,
  decided_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT stella_suggestion_decisions_decision_check CHECK ((decision = ANY (ARRAY['accepted'::text, 'accepted_edited'::text, 'rejected'::text, 'undone'::text]))),
  CONSTRAINT stella_suggestion_decisions_prev_hash_check CHECK (((previous_value_hash IS NULL) OR (previous_value_hash ~ '^[0-9a-f]{64}$')))
);
`

/**
 * Brings the bare corpus cluster up to the ownership and ACL shape of the real
 * G2 environment (db/baseline/stella_g2_schema.sql), where uellix_owner OWNS
 * every public relation and every SECURITY DEFINER helper.
 *
 * WHY OWNERSHIP MATTERS HERE AND NOT MERELY FOR TIDINESS. entitlement_effective
 * is SECURITY DEFINER owned by uellix_owner and calls current_user_org_ids().
 * In G2 that helper is owned by uellix_owner too, so the call is free; on a
 * corpus-only cluster 0031 creates it owned by the migrating role and
 * 0033_public_api_grants.sql revokes EXECUTE from PUBLIC, which would leave
 * uellix_owner unable to call it. Re-homing it reproduces production rather
 * than papering over a gap — and it is done HERE, in the test substrate, never
 * in the migration.
 *
 * THE TENANT ACL FLOOR IS GRANTED DELIBERATELY WIDE ON OTHER RELATIONS and is
 * granted NOT AT ALL on entitlement_grants. A tenant identity gets USAGE on the
 * schema and the ordinary reads it needs elsewhere, so that when a direct
 * SELECT on entitlement_grants fails it fails for the RIGHT reason — the
 * absent table privilege this node deliberately never grants — and not because
 * the role could not see the schema at all.
 */
const HOSTED_FIDELITY = `
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $f$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$f$;
DO $o$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO uellix_owner', r.tablename);
  END LOOP;
END $o$;
-- THE EVALUATOR IS NOT RE-HOMED HERE, AND THAT ABSENCE IS THE POINT.
--
-- Until R4 this block carried a direct ownership transfer for the evaluator,
-- and the suite then asserted the owner it had just assigned. That proves
-- assignment works; it proves nothing about the system establishing the owner.
-- COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1 clause
-- FIXTURE_DECONTAMINATION ordered the statement removed, and CE3-OWN-N-1
-- forbids retyping it anywhere under tests/** -- in a helper, a constant, a
-- template literal or a second fixture.
--
-- The transition now arrives from the REAL bytes of the governed hosted
-- administrative package (OWNERSHIP_PACKAGE_SQL below), applied AFTER the
-- pre-state has been recorded, so the owner CE3-OWN-P-1 asserts is the one
-- that application produced and not one this file manufactured.
--
-- THE TWO MEMBERSHIPS BELOW ARE PRECONDITIONS OF THAT PACKAGE, NOT A
-- SUBSTITUTE FOR IT. stella_hosted_0000 establishes exactly this shape on a
-- managed project: SET TRUE so an administrative session can act as the
-- owner, INHERIT FALSE so it never does so implicitly; and CREATE on schema
-- public, which PostgreSQL requires of the NEW owner of a function and which
-- stella_hosted_0009 PRE-9 refuses without. Neither statement names the
-- evaluator, and neither can transfer anything.
GRANT uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE;
GRANT CREATE, USAGE ON SCHEMA public TO uellix_owner;

-- The three helper re-homes below are OUT OF SCOPE of the decontamination
-- order, which names the evaluator and only the evaluator. They reproduce G2,
-- where uellix_owner owns every SECURITY DEFINER helper: on a corpus-only
-- cluster 0031 creates them owned by the migrating role and 0033 revokes
-- EXECUTE from PUBLIC, which would leave uellix_owner unable to call them.
ALTER FUNCTION public.current_user_org_ids() OWNER TO uellix_owner;
ALTER FUNCTION public.current_user_is_super_admin() OWNER TO uellix_owner;
ALTER FUNCTION public.current_user_role_in_org(uuid) OWNER TO uellix_owner;
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app, authenticated, anon;
GRANT USAGE ON SCHEMA auth TO uellix_writer, uellix_app, uellix_owner, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer, uellix_app, uellix_owner, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
GRANT SELECT ON public.users, public.organizations, public.organization_members, public.commercial_accounts TO uellix_writer, uellix_app, authenticated;
`

/**
 * The commercial + tenant + grant fixture.
 *
 * THE GRANT ROWS ARE SEEDED AS postgres, DELIBERATELY. entitlement_grants has
 * NO INSERT policy for any role and no tenant INSERT privilege — that is the
 * node's posture, not an omission — so the only identity that can plant the
 * substrate is one RLS does not constrain. This is the opposite of the L1
 * fixture's choice, and for the opposite reason: L1's relation is tenant data
 * written by a tenant subject, so seeding through RLS proved the legitimate
 * path; CE-3's relation has no legitimate tenant write path at all, and
 * pretending otherwise would be inventing one.
 */
const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.adminA}','ce3-admin-a@pg.local'),
  ('${IDS.adminB}','ce3-admin-b@pg.local'),
  ('${IDS.adminC}','ce3-admin-c@pg.local'),
  ('${IDS.adminD}','ce3-admin-d@pg.local'),
  ('${IDS.adminK}','ce3-admin-k@pg.local'),
  ('${IDS.multiOrg}','ce3-multi@pg.local'),
  ('${IDS.outsider}','ce3-outsider@pg.local'),
  ('${IDS.platformSuperAdmin}','ce3-psa@pg.local')
  ON CONFLICT (id) DO NOTHING;

-- The auth trigger unit creates the public.users row the moment an auth.users
-- row appears, with is_super_admin defaulting to FALSE — so the INSERT below
-- does NOTHING for every subject and the platform super-admin would silently
-- not be one. The explicit UPDATE is the repair the CL-1 and L1 fixtures carry
-- for the same measured reason.
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.adminA}','ce3-admin-a@pg.local',false),
  ('${IDS.adminB}','ce3-admin-b@pg.local',false),
  ('${IDS.adminC}','ce3-admin-c@pg.local',false),
  ('${IDS.adminD}','ce3-admin-d@pg.local',false),
  ('${IDS.adminK}','ce3-admin-k@pg.local',false),
  ('${IDS.multiOrg}','ce3-multi@pg.local',false),
  ('${IDS.outsider}','ce3-outsider@pg.local',false),
  ('${IDS.platformSuperAdmin}','ce3-psa@pg.local',true)
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.platformSuperAdmin}';
UPDATE public.users SET is_super_admin = false WHERE id <> '${IDS.platformSuperAdmin}';

INSERT INTO public.commercial_accounts (id, legal_name, commercial_status) VALUES
  ('${IDS.caX}', 'CE3 Fixture Group X', 'active'),
  ('${IDS.caY}', 'CE3 Fixture Group Y', 'active');

-- OrgD is UNGOVERNED: commercial_account_id IS NULL. SENTINEL_UNGOVERNED_ORG.
INSERT INTO public.organizations (id, name, slug, status, commercial_account_id) VALUES
  ('${IDS.orgA}', 'CE3 Org A', 'ce3-org-a', 'active', '${IDS.caX}'),
  ('${IDS.orgB}', 'CE3 Org B', 'ce3-org-b', 'active', '${IDS.caX}'),
  ('${IDS.orgC}', 'CE3 Org C', 'ce3-org-c', 'active', '${IDS.caY}'),
  ('${IDS.orgD}', 'CE3 Org D ungoverned', 'ce3-org-d', 'active', NULL),
  ('${IDS.orgK}', 'CE3 Org K concurrency', 'ce3-org-k', 'active', '${IDS.caX}');

-- ACTIVE memberships. AT MOST ONE PER SUBJECT (user_single_active_membership).
-- Every role below is organization_admin so that a refusal can NEVER be
-- explained by the role: CE3-N-2 requires the fixture to actively EXCLUDE a
-- role-based explanation rather than merely not offer one.
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}', '${IDS.adminA}', 'organization_admin', 'active'),
  ('${IDS.orgB}', '${IDS.adminB}', 'organization_admin', 'active'),
  ('${IDS.orgC}', '${IDS.adminC}', 'organization_admin', 'active'),
  ('${IDS.orgD}', '${IDS.adminD}', 'organization_admin', 'active'),
  ('${IDS.orgK}', '${IDS.adminK}', 'organization_admin', 'active'),
  ('${IDS.orgB}', '${IDS.multiOrg}', 'organization_admin', 'active');

-- The multi-membership dimension in its SATISFIABLE form: multiOrg holds a
-- SECOND membership row in OrgA that is INACTIVE. Two ROWS, exactly one
-- ACTIVE — never two live scopes, which the live index forbids.
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}', '${IDS.multiOrg}', 'organization_admin', 'inactive');

-- THE GRANTS. Every organization carries a DISTINCT metered answer, so a probe
-- that received the wrong organization's row would be caught BY VALUE and not
-- merely by a row count.
--
--   OrgA  CAPPED 100   (live)   + one CLOSED BLOCKED row  (SENTINEL_CLOSED_GRANT_ROW)
--   OrgB  UNMETERED    (live)   carrying the CANARY        (SENTINEL_SIBLING_ORG_CANARY_ROW)
--   OrgC  BLOCKED      (live)   a REAL grant in a NON-SCOPED organization
--   OrgD  none                  (SENTINEL_UNGOVERNED_ORG)
--   OrgK  none                  reserved for the concurrency probe, which commits
--
-- The CLOSED OrgA row and the LIVE OrgA row share (organization_id,
-- capability_key). That is legal and is the point: the partial unique index
-- constrains only rows WHERE effective_to IS NULL, so history accumulates
-- while exactly one row is live.
INSERT INTO public.entitlement_grants
  (id, organization_id, capability_key, source, commercial_account_id, plan_ref,
   limit_kind, limit_value, effective_from, effective_to, reason, actor_user_id)
VALUES
  ('${IDS.grantOrgAClosed}', '${IDS.orgA}', '${CAPABILITY}', 'PLAN', '${IDS.caX}', 'plan-basic-v1',
   'BLOCKED', NULL, now() - interval '60 days', now() - interval '30 days', 'CE3 fixture: superseded grant', '${IDS.adminA}'),
  ('${IDS.grantOrgALive}', '${IDS.orgA}', '${CAPABILITY}', 'PLAN', '${IDS.caX}', 'plan-pro-v2',
   'CAPPED', 100, now() - interval '30 days', NULL, 'CE3 fixture: live capped grant', '${IDS.adminA}'),
  ('${IDS.grantOrgB}', '${IDS.orgB}', '${CAPABILITY}', 'PLAN', '${IDS.caX}', 'plan-pro-v2',
   'UNMETERED', NULL, now() - interval '10 days', NULL, '${CANARY}', '${IDS.adminB}'),
  ('${IDS.grantOrgC}', '${IDS.orgC}', '${CAPABILITY}', 'COMMERCIAL_EXCEPTION', '${IDS.caY}', NULL,
   'BLOCKED', NULL, now() - interval '5 days', NULL, 'CE3 fixture: real grant in a non-scoped organization', '${IDS.adminC}');
`

/* -------------------------------------------------------------------------- */
/* THE GOVERNED OWNERSHIP ORIGIN (CE3-OWN-P-1 / CE3-OWN-M-1)                  */
/* -------------------------------------------------------------------------- */

/**
 * The governed hosted administrative package that performs the evaluator
 * ownership transition, named through the REGISTRY rather than as a string
 * literal, so a package that was moved or renamed cannot leave this substrate
 * silently applying nothing.
 */
export const OWNERSHIP_PACKAGE_SQL = PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP.sourceFile

/** The evidence table the substrate writes into and the probes read back. */
const OWNERSHIP_EVIDENCE_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ce3_own;
CREATE TABLE IF NOT EXISTS ce3_own.evidence (k text PRIMARY KEY, v text NOT NULL);
`

/**
 * THE PRE-STATE, RECORDED BEFORE THE PACKAGE RUNS -- and the reason the whole
 * arrangement can say anything about ORIGIN at all.
 *
 * A fixture-set owner and a package-set owner leave BYTE-IDENTICAL pg_proc
 * rows, so no assertion taken after setup can tell them apart. Provenance is a
 * TEMPORAL property: it is established by bracketing the candidate cause with a
 * measurement on each side, in a substrate where nothing else could have
 * produced the transition. This block is the near side of that bracket.
 *
 * IT RUNS IN BOTH ARMS, DELIBERATELY. The omission arm (CE3-OWN-M-1) records
 * the same pre-state and simply never applies the package, so its RED comes
 * from the owner still being the one recorded here -- not from a missing file,
 * an import error or a harness crash.
 *
 * IT REFUSES A SUBSTRATE THAT IS ALREADY AT THE TARGET. If the evaluator were
 * already owned by uellix_owner before the package ran, the transition would
 * have no observable origin and every provenance assertion downstream would
 * pass with the package absent -- exactly the vacuity R4 was ordered to end.
 */
const OWNERSHIP_PRE_MEASUREMENT = `
DO $own$ DECLARE pre text; BEGIN
  IF pg_catalog.to_regprocedure('public.entitlement_effective(uuid,varchar)') IS NULL THEN
    RAISE EXCEPTION 'CE3-OWN SUBSTRATE INCOMPLETE: public.entitlement_effective(uuid,varchar) does not exist before the governed package runs, so migration 0073 did not apply and there is nothing to transfer.';
  END IF;
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO pre
  FROM pg_catalog.pg_proc p WHERE p.oid = 'public.entitlement_effective(uuid,varchar)'::regprocedure;
  IF pre = 'uellix_owner' THEN
    RAISE EXCEPTION 'CE3-OWN SUBSTRATE CONTAMINATED: the evaluator is ALREADY owned by uellix_owner before stella_hosted_0009 is applied. The transition would have no observable origin and CE3-OWN-P-1 would pass with the package absent. Owner=[%]', pre;
  END IF;
  INSERT INTO ce3_own.evidence(k, v) VALUES ('ENTITLEMENT_EFFECTIVE_OWNER_PRE', pre)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $own$;
`

/**
 * The far side of the bracket, recorded IMMEDIATELY after the package step in
 * the conformant arm and at the same position in the omission arm. Nothing
 * between the two captures touches ownership except the package itself, which
 * the host asserts structurally against the setup manifest.
 */
const OWNERSHIP_POST_MEASUREMENT = `
DO $own$ DECLARE post text; BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO post
  FROM pg_catalog.pg_proc p WHERE p.oid = 'public.entitlement_effective(uuid,varchar)'::regprocedure;
  INSERT INTO ce3_own.evidence(k, v) VALUES ('ENTITLEMENT_EFFECTIVE_OWNER_POST', post)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $own$;
`

/**
 * Applies a prepared package from its REAL bytes with psql -1 semantics.
 *
 * The harness applies each setup statement separately and WITHOUT -1, while
 * stella_hosted_0009 keeps its entire pre-state in transaction-local
 * set_config(..., true) settings and REFUSES rather than comparing values it
 * has just re-read. Wrapping the file in an explicit BEGIN/COMMIT is EXACTLY
 * what psql -1 does; the package bytes themselves are passed through
 * unmodified. This is a transaction boundary, not an edit. Same shape as
 * tests/postgres/ce3-acl-hardening.pg.test.ts.
 */
export function applyPackage(relativePath: string): string {
  return `BEGIN;\n${readFileSync(path.join(ROOT, relativePath), 'utf8')}\nCOMMIT;\n`
}

export interface SubstrateOptions {
  /**
   * false OMITS the governed ownership package entirely -- CE3-OWN-M-1.
   * Everything else, including both evidence captures, is left intact, so the
   * resulting RED is the ownership obligation failing and not a crash.
   */
  readonly applyOwnershipPackage?: boolean
}

function unitStatement(unit: (typeof BASELINE_UNITS)[number]): string {
  return `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(ROOT, unit.file), 'utf8')
}

/**
 * Opens a transaction acting as `id` through the `authenticated` JWT role —
 * the role migration 0073 grants EXECUTE on the evaluator to, and therefore
 * the identity a real request arrives as.
 */
export const asAuthenticated = (id: string) =>
  `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

/**
 * Opens a transaction acting as `id` through the runtime writer role
 * `uellix_app`. Used for the DIRECT-TABLE privilege posture: a second,
 * independent tenant identity that likewise holds no privilege on
 * entitlement_grants.
 */
export const asAppRole = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

/**
 * Roles + baseline migration units (which now include 0073) + hosted-fidelity
 * shims + the GOVERNED OWNERSHIP ORIGIN, bracketed by its two measurements.
 *
 * THE ORDER IS LOAD-BEARING AND IS ASSERTED BY THE HOST, not left to a reader:
 * evidence schema -> PRE capture -> the real package bytes -> POST capture.
 * A probe that applied the artifact itself would contaminate the arm that omits
 * it, so the application lives in the SUBSTRATE and the probes only read back.
 */
export function buildBaselineOnlyStatements(options: SubstrateOptions = {}): string[] {
  const applyOwnershipPackage = options.applyOwnershipPackage ?? true
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(ROOT, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) statements.push(unitStatement(unit))
  statements.push(HOSTED_FIDELITY)
  statements.push(OWNERSHIP_EVIDENCE_SCHEMA)
  statements.push(OWNERSHIP_PRE_MEASUREMENT)
  if (applyOwnershipPackage) statements.push(applyPackage(OWNERSHIP_PACKAGE_SQL))
  statements.push(OWNERSHIP_POST_MEASUREMENT)
  return statements
}

/** Baseline + the governed ownership origin + the commercial/tenant/grant fixture. */
export function buildSetupManifest(options: SubstrateOptions = {}): SetupManifest {
  return { statements: [...buildBaselineOnlyStatements(options), FIXTURE] }
}
