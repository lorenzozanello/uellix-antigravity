// tests/postgres/ce1-commercial-account.pg.test.ts
// CE-1 — CommercialAccount relation and live association, REAL PostgreSQL
// controls (PG-1, PG-3, P-2, P-3's dynamic half, N-4, N-16), run through the
// CANONICAL disposable harness scripts/db-audit-disposable.ts: a throwaway
// postgres container on 127.0.0.1, ephemeral port, no bind mounts, teardown
// in `finally`, leftover check. Never staging, never production, never the
// canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise.
//
// PG-3 (CE-1's own probe): commercial_accounts is created with ENABLE + FORCE
// ROW LEVEL SECURITY and ZERO policies. The tenant-facing runtime role
// (uellix_app) must be denied SELECT/INSERT/UPDATE/DELETE, and its BYPASSRLS
// and table-ownership status must be ASSERTED, never assumed — FORCE is
// silently inert for a BYPASSRLS role or the table owner.
//
// PG-1: a subject scoped to OrgA reads zero rows of OrgB despite OrgA and
// OrgB sharing a governing CommercialAccount. The static half (no RLS
// predicate anywhere references commercial_account_id) lives in
// tests/commercial/ce1-commercial-account.test.ts; this file proves the
// dynamic half against a real database.
//
// CE-1 has no backfill and no historical-fixture dependency (unlike S1): the
// full baseline is applied in plain manifest order, CE-1 unit included.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { runDisposableHarness, DEFAULT_IMAGE, type HarnessOutcome, type SetupManifest, type ProbeManifest } from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(__dirname, '..', '..')

/** The CE-1 unit, DERIVED from the live manifest — never named by ordinal. */
const CE1_UNIT = BASELINE_UNITS.find((u) => /^\d{4}_commercial_account_ce1\.sql$/.test(u.id))
if (!CE1_UNIT) throw new Error('the CE-1 commercial_account baseline unit is not registered in db/hosted/baseline-manifest.ts')

/** Deterministic fixture ids (v4-shaped, fixed). */
export const IDS = {
  // users
  uA: '0ce10000-0000-4000-8000-0000000000a1', // member of OrgA
  uB: '0ce10000-0000-4000-8000-0000000000b1', // member of OrgB
  uC: '0ce10000-0000-4000-8000-0000000000c1', // member of OrgC (ungoverned)
  uSA: '0ce10000-0000-4000-8000-0000000000fa', // platform super admin, used only to seed rows through RLS
  // organizations
  orgA: '1ce10000-0000-4000-8000-0000000000a1', // governed by X
  orgB: '1ce10000-0000-4000-8000-0000000000b1', // governed by X (same account as OrgA) — SENTINEL_SIBLING_ORG_CANARY_ROW
  orgC: '1ce10000-0000-4000-8000-0000000000c1', // SENTINEL_UNGOVERNED_ORG — commercial_account_id stays NULL
  // commercial accounts
  accountX: '2ce10000-0000-4000-8000-0000000000e1',
  accountY: '2ce10000-0000-4000-8000-0000000000e2',
} as const

const ORG_B_CANARY_SLUG = 'ce1-orgb-sibling-canary-9f3a1c'

const ROLE_PRELUDE = `
-- Cluster roles mirrored from db/baseline/stella_g2_roles.sql (attributes only, no passwords).
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
  CONSTRAINT stella_suggestion_decisions_prev_hash_check CHECK (((previous_value_hash IS NULL) OR (previous_value_hash ~ '^[0-9a-f]{64}$'::text)))
);
`

const HOSTED_FIDELITY = `
-- (1) auth.uid() with the HOSTED semantics, verbatim from db/baseline/stella_g2_schema.sql:486-494.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $f$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$f$;
-- (2) Ownership as measured in the G2 baseline dump (ALTER TABLE public.* OWNER TO uellix_owner).
-- commercial_accounts is included: this is the DEFAULT-DENY posture PG-3
-- exists to prove is not silently bypassed by table ownership.
DO $o$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO uellix_owner', r.tablename);
  END LOOP;
END $o$;
-- (3) Runtime reachability: schema usage, auth.uid() reach, RLS helper EXECUTE.
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app;
GRANT USAGE ON SCHEMA auth TO uellix_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
-- (4) The organizations ACL floor for the runtime writer role — makes the
-- ordinary-user negative controls tests of the RLS WALL, not of a missing
-- table grant.
GRANT SELECT, INSERT ON public.organizations TO uellix_writer;
GRANT SELECT ON public.organization_members, public.users TO uellix_writer;
-- (5) commercial_accounts deliberately receives NO table grant to uellix_writer
-- beyond what FORCE + zero policies already deny by default — CE-1 grants
-- nothing extra, and the PG-3 probes below prove the default-deny holds even
-- so (uellix_app inherits uellix_writer, so an accidental table grant here
-- would silently defeat the RLS wall this migration installs).
`

function unitStatement(unit: (typeof BASELINE_UNITS)[number]): string {
  return `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(ROOT, unit.file), 'utf8')
}

/** Seeded AFTER the full baseline: super-admin seeds the tenant fixture through RLS, honestly. */
const TENANT_FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.uA}','ua-ce1@pg.local'),('${IDS.uB}','ub-ce1@pg.local'),('${IDS.uC}','uc-ce1@pg.local'),('${IDS.uSA}','usa-ce1@pg.local')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.uA}','ua-ce1@pg.local',false),('${IDS.uB}','ub-ce1@pg.local',false),('${IDS.uC}','uc-ce1@pg.local',false),('${IDS.uSA}','usa-ce1@pg.local',true)
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.uSA}';

-- CommercialAccount X governs BOTH OrgA and OrgB (CA-02: one account, two+
-- organizations, P-2). CommercialAccount Y governs neither yet.
INSERT INTO public.commercial_accounts (id, legal_name, commercial_status) VALUES
  ('${IDS.accountX}','CE1 Shared Account X','active'),
  ('${IDS.accountY}','CE1 Account Y','active');

INSERT INTO public.organizations (id, name, slug, commercial_account_id) VALUES
  ('${IDS.orgA}','CE1 Org A','ce1-org-a','${IDS.accountX}'),
  ('${IDS.orgB}','CE1 Org B (sibling canary)','${ORG_B_CANARY_SLUG}','${IDS.accountX}'),
  ('${IDS.orgC}','CE1 Org C (ungoverned)','ce1-org-c',NULL);

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}','${IDS.uA}','organization_admin','active'),
  ('${IDS.orgB}','${IDS.uB}','organization_admin','active'),
  ('${IDS.orgC}','${IDS.uC}','organization_admin','active');
`

export function buildSetupManifest(): SetupManifest {
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(ROOT, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) statements.push(unitStatement(unit))
  statements.push(HOSTED_FIDELITY)
  statements.push(TENANT_FIXTURE)
  return { statements }
}

const asUser = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

export function buildProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  // --- role/ownership provenance (PG-3 preconditions) ------------------------
  add('PG-3-0a-uellix_app-is-NOT-BYPASSRLS-asserted-not-assumed', `DO $p$ DECLARE b bool; BEGIN
  SELECT rolbypassrls INTO b FROM pg_roles WHERE rolname='uellix_app';
  IF b IS NULL OR b <> false THEN RAISE EXCEPTION 'PG-3-0a uellix_app rolbypassrls=% expected=false', b; END IF;
END $p$;`)

  add('PG-3-0b-uellix_app-is-NOT-the-commercial_accounts-table-owner-asserted-not-assumed', `DO $p$ DECLARE o text; BEGIN
  SELECT tableowner INTO o FROM pg_tables WHERE schemaname='public' AND tablename='commercial_accounts';
  IF o IS NULL OR o = 'uellix_app' THEN RAISE EXCEPTION 'PG-3-0b commercial_accounts owner=% expected != uellix_app', o; END IF;
  IF o <> 'uellix_owner' THEN RAISE EXCEPTION 'PG-3-0b commercial_accounts owner=% expected=uellix_owner', o; END IF;
END $p$;`)

  add('PG-3-0c-commercial_accounts-has-ENABLE-and-FORCE-row-security-set', `DO $p$ DECLARE r record; BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO r FROM pg_class WHERE oid = 'public.commercial_accounts'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION 'PG-3-0c relrowsecurity=false, expected true (ENABLE missing)'; END IF;
  IF NOT r.relforcerowsecurity THEN RAISE EXCEPTION 'PG-3-0c relforcerowsecurity=false, expected true (FORCE missing)'; END IF;
END $p$;`)

  add('PG-3-0d-zero-policies-exist-on-commercial_accounts', `DO $p$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='commercial_accounts';
  IF n <> 0 THEN RAISE EXCEPTION 'PG-3-0d % policies exist on commercial_accounts, expected 0', n; END IF;
END $p$;`)

  // --- PG-3: the tenant-facing runtime role is denied every DML verb ---------
  add('PG-3-1-uellix_app-SELECT-commercial_accounts-denied-42501-row-level-security',
    asUser(IDS.uA) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; n int; BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.commercial_accounts;
    IF n <> 0 THEN RAISE EXCEPTION 'PG-3-1 SELECT returned % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  -- FORCE + zero policies means either a 42501 refusal OR a silent zero-row
  -- result is acceptable evidence of denial for SELECT (RLS filters rows
  -- rather than raising by default); assert one of the two, never a leak.
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'PG-3-1 unexpected SQLSTATE=% (%)', caught, msg; END IF;
END $w$;
ROLLBACK;`)

  // CE-1's migration issues no GRANT on commercial_accounts to uellix_writer
  // (measured: db/baseline/stella_g2_schema.sql grants every OTHER public
  // table to uellix_writer by an explicit per-table statement, and there is
  // no ALTER DEFAULT PRIVILEGES covering schema public — a new table starts
  // with NO table-level ACL for uellix_writer unless its own migration grants
  // one, and CE-1 deliberately grants none). So the denial legitimately comes
  // from the ACL wall (42501 "permission denied for table") here, layered
  // OUTSIDE the RLS wall MUT-PG-CE1-1/2 and PG-3-0c/0d prove independently —
  // both are correct default-deny evidence, and asserting one specific
  // message would fail closed on the more defensive of the two.
  add('PG-3-2-uellix_app-INSERT-commercial_accounts-denied-42501',
    asUser(IDS.uA) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    INSERT INTO public.commercial_accounts (legal_name) VALUES ('Should Be Denied');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'PG-3-2 caught=% expected=42501 (%)', caught, msg; END IF;
  IF msg !~ 'row-level security' AND msg !~ 'permission denied for table' THEN RAISE EXCEPTION 'PG-3-2 42501 but not an ACL or RLS wall: %', msg; END IF;
END $w$;
ROLLBACK;`)

  add('PG-3-3-uellix_app-UPDATE-commercial_accounts-denied-42501-or-zero-rows',
    asUser(IDS.uA) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; n int; BEGIN
  BEGIN
    UPDATE public.commercial_accounts SET legal_name = 'Should Be Denied' WHERE id = '${IDS.accountX}';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'PG-3-3 UPDATE affected % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'PG-3-3 unexpected SQLSTATE=% (%)', caught, msg; END IF;
END $w$;
ROLLBACK;`)

  add('PG-3-4-uellix_app-DELETE-commercial_accounts-denied-42501-or-zero-rows',
    asUser(IDS.uA) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; n int; BEGIN
  BEGIN
    DELETE FROM public.commercial_accounts WHERE id = '${IDS.accountX}';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'PG-3-4 DELETE affected % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'PG-3-4 unexpected SQLSTATE=% (%)', caught, msg; END IF;
  -- confirm the row genuinely survives, from a role that CAN see it (superuser).
END $w$;
ROLLBACK;`)

  add('PG-3-5-super-admin-tenant-role-is-ALSO-denied-commercial_accounts-not-a-platform-admin-bypass-at-CE-1',
    asUser(IDS.uSA) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.commercial_accounts;
    IF n <> 0 THEN RAISE EXCEPTION 'PG-3-5 super-admin SELECT returned % rows — Platform Admin access is CE-8''s, not CE-1''s', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'PG-3-5 unexpected SQLSTATE=%', caught; END IF;
END $w$;
ROLLBACK;`)

  // --- PG-1 / N-4: shared governance does not widen tenant visibility --------
  add('PG-1-1-OrgA-member-sees-ONLY-OrgA-the-SENTINEL_SIBLING_ORG_CANARY_ROW-never-appears',
    asUser(IDS.uA) + `DO $w$ DECLARE n int; leaked int; BEGIN
  SELECT count(*) INTO n FROM public.organizations;
  IF n <> 1 THEN RAISE EXCEPTION 'PG-1-1 OrgA-scoped subject sees % organizations, expected exactly 1', n; END IF;
  SELECT count(*) INTO leaked FROM public.organizations WHERE slug = '${ORG_B_CANARY_SLUG}';
  IF leaked <> 0 THEN RAISE EXCEPTION 'N-4 SENTINEL_SIBLING_ORG_CANARY_ROW leaked into an OrgA-scoped read (count=%)', leaked; END IF;
  PERFORM 1 FROM public.organizations WHERE id = '${IDS.orgA}' AND commercial_account_id = '${IDS.accountX}';
  IF NOT FOUND THEN RAISE EXCEPTION 'PG-1-1 OrgA row missing or commercial_account_id not readable as X'; END IF;
END $w$;
ROLLBACK;`)

  add('PG-1-2-OrgB-member-sees-ONLY-OrgB-despite-sharing-CommercialAccount-X-with-OrgA',
    asUser(IDS.uB) + `DO $w$ DECLARE n int; leaked int; BEGIN
  SELECT count(*) INTO n FROM public.organizations;
  IF n <> 1 THEN RAISE EXCEPTION 'PG-1-2 OrgB-scoped subject sees % organizations, expected exactly 1', n; END IF;
  SELECT count(*) INTO leaked FROM public.organizations WHERE id = '${IDS.orgA}';
  IF leaked <> 0 THEN RAISE EXCEPTION 'PG-1-2 OrgA leaked into an OrgB-scoped read despite sharing CommercialAccount X (count=%)', leaked; END IF;
  PERFORM 1 FROM public.organizations WHERE id = '${IDS.orgB}' AND commercial_account_id = '${IDS.accountX}';
  IF NOT FOUND THEN RAISE EXCEPTION 'PG-1-2 OrgB row missing or commercial_account_id not readable as X'; END IF;
END $w$;
ROLLBACK;`)

  add('PG-1-3-current_user_org_ids-is-NOT-widened-by-shared-commercial-governance',
    asUser(IDS.uA) + `DO $w$ BEGIN
  IF '${IDS.orgB}'::uuid = ANY(public.current_user_org_ids()) THEN RAISE EXCEPTION 'PG-1-3 current_user_org_ids() includes OrgB via shared CommercialAccount X — SEC-7 violated'; END IF;
  IF NOT ('${IDS.orgA}'::uuid = ANY(public.current_user_org_ids())) THEN RAISE EXCEPTION 'PG-1-3 fixture defect: OrgA missing from current_user_org_ids()'; END IF;
END $w$;
ROLLBACK;`)

  // --- N-16: SENTINEL_UNGOVERNED_ORG yields no capability ---------------------
  add('N-16-SENTINEL_UNGOVERNED_ORG-commercial_account_id-is-NULL-and-grants-nothing-extra',
    asUser(IDS.uC) + `DO $w$ DECLARE v uuid; n int; BEGIN
  SELECT commercial_account_id INTO v FROM public.organizations WHERE id = '${IDS.orgC}';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'N-16 SENTINEL_UNGOVERNED_ORG commercial_account_id=% expected NULL', v; END IF;
  SELECT count(*) INTO n FROM public.organizations;
  IF n <> 1 THEN RAISE EXCEPTION 'N-16 OrgC-scoped subject sees % organizations, expected exactly 1 (ungoverned is not free/unlimited visibility)', n; END IF;
END $w$;
ROLLBACK;`)

  // --- P-3 dynamic half: exactly one live governing account, reassignable ----
  add('P-3-1-reassigning-commercial_account_id-overwrites-the-scalar-never-stacks', `BEGIN;
UPDATE public.organizations SET commercial_account_id = '${IDS.accountY}' WHERE id = '${IDS.orgA}';
DO $p$ DECLARE v uuid; BEGIN
  SELECT commercial_account_id INTO v FROM public.organizations WHERE id = '${IDS.orgA}';
  IF v IS DISTINCT FROM '${IDS.accountY}'::uuid THEN RAISE EXCEPTION 'P-3-1 measured=% expected=${IDS.accountY} (single scalar overwrite)', v; END IF;
END $p$;
ROLLBACK;`)

  // --- FK / reapply behaviour --------------------------------------------------
  // MEASURED: PostgreSQL implements ON DELETE RESTRICT (and NO ACTION) via
  // the single SQLSTATE 23503 foreign_key_violation — 23001 restrict_violation
  // is not what the RESTRICT action code path actually raises.
  add('CE1-FK-1-ON-DELETE-RESTRICT-deleting-a-governing-account-with-a-live-organization-refused-23503',
    `DO $f$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    DELETE FROM public.commercial_accounts WHERE id = '${IDS.accountX}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23503' THEN RAISE EXCEPTION 'CE1-FK-1 caught=% expected=23503 (foreign_key_violation) (%)', caught, msg; END IF;
  IF msg !~ 'organizations_commercial_account_id_commercial_accounts_id_fk' THEN RAISE EXCEPTION 'CE1-FK-1 refused by a different FK: %', msg; END IF;
END $f$;`)

  add('CE1-REAPPLY-destructive-on-reapply-CREATE-TABLE-refuses-42P07',
    `BEGIN;
DO $a$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    CREATE TABLE "commercial_accounts" (id uuid PRIMARY KEY);
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42P07' THEN RAISE EXCEPTION 'CE1-REAPPLY caught=% expected=42P07 (duplicate table)', caught; END IF;
END $a$;
ROLLBACK;`)

  // --- mutation controls: each proves the guarantee is LOAD-BEARING ----------
  add('MUT-PG-CE1-1-FORCE-removed-owner-can-then-read-proving-FORCE-was-load-bearing', `BEGIN;
ALTER TABLE public.commercial_accounts NO FORCE ROW LEVEL SECURITY;
DO $m$ DECLARE n int; BEGIN
  SET LOCAL ROLE uellix_owner;
  SELECT count(*) INTO n FROM public.commercial_accounts;
  IF n < 1 THEN RAISE EXCEPTION 'MUT-PG-CE1-1 expected the table OWNER to read rows once FORCE is dropped (n=%), proving FORCE was load-bearing', n; END IF;
END $m$;
ROLLBACK;`)

  // The realistic regression this models is BOTH halves of "for convenience":
  // a table GRANT (CE-1 issues none — see PG-3-2's comment) AND a permissive
  // policy. Granting only the table privilege would still be caught by
  // PG-3-0d (zero policies) and would deny at the RLS wall (no policy = no
  // match = deny even with USAGE); granting only a policy with no table
  // privilege would still be caught by the ACL wall. Only the COMBINATION
  // leaks, and that combination is exactly what PG-3-0d and PG-3-1 exist to
  // notice on the real (non-mutated) migration.
  add('MUT-PG-CE1-2-zero-policies-removed-hypothesis-a-tenant-policy-added-for-convenience-WOULD-be-caught-by-PG-3', `BEGIN;
GRANT SELECT ON public.commercial_accounts TO uellix_writer;
CREATE POLICY "commercial_accounts_select_hypothetical" ON public.commercial_accounts FOR SELECT USING (true);
DO $m$ DECLARE n int; BEGIN
  SET LOCAL ROLE uellix_app;
  PERFORM set_config('request.jwt.claims', '{"sub":"${IDS.uA}","role":"authenticated"}', true);
  SELECT count(*) INTO n FROM public.commercial_accounts;
  IF n < 1 THEN RAISE EXCEPTION 'MUT-PG-CE1-2 expected a granted+policied table to leak tenant reads (n=%), proving PG-3-0d/PG-3-1 would catch a real one', n; END IF;
END $m$;
ROLLBACK;`)

  add('MUT-PG-CE1-3-RESTRICT-relaxed-to-CASCADE-deleting-the-account-WOULD-silently-drop-the-organization-proving-RESTRICT-is-load-bearing', `BEGIN;
-- Clear the UNRELATED, pre-existing organization_members -> organizations FK
-- for OrgA/OrgB first: this mutation targets ONLY the CE-1 FK's ON DELETE
-- action, and the fixture's memberships would otherwise block the cascade
-- for a reason that has nothing to do with what this control is proving.
DELETE FROM public.organization_members WHERE organization_id IN ('${IDS.orgA}','${IDS.orgB}');
ALTER TABLE public.organizations DROP CONSTRAINT organizations_commercial_account_id_commercial_accounts_id_fk;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_commercial_account_id_commercial_accounts_id_fk
  FOREIGN KEY (commercial_account_id) REFERENCES public.commercial_accounts(id) ON DELETE CASCADE;
DO $m$ DECLARE n int; BEGIN
  DELETE FROM public.commercial_accounts WHERE id = '${IDS.accountX}';
  SELECT count(*) INTO n FROM public.organizations WHERE id IN ('${IDS.orgA}','${IDS.orgB}');
  IF n <> 0 THEN RAISE EXCEPTION 'MUT-PG-CE1-3 expected CASCADE to have silently deleted OrgA/OrgB (measured=%), proving RESTRICT is load-bearing', n; END IF;
END $m$;
ROLLBACK;`)

  return { probes }
}

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)('CE-1 CommercialAccount — real PostgreSQL (canonical disposable harness)', { timeout: 1_200_000 }, () => {
  let outcome: HarnessOutcome

  beforeAll(() => {
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: buildSetupManifest(),
      probe: buildProbeManifest(),
    })
    // Machine-readable summary for the implementation evidence artefact.
    console.log(`CE1_PG_OUTCOME=${JSON.stringify({
      setupStatus: outcome.setupStatus,
      probeStatus: outcome.probeStatus,
      probeCount: outcome.probeCount,
      probeFailureCount: outcome.probeFailureCount,
      teardownStatus: outcome.teardownStatus,
      leftoverDatabaseCount: outcome.leftoverDatabaseCount,
      lifecycleState: outcome.lifecycleState,
      failureReason: outcome.failureReason,
      failed: outcome.probeResults.filter((p) => !p.ok).map((p) => ({ id: p.id, detail: p.detail })),
    })}`)
  }, 1_200_000)

  it('the CE-1 unit is the LAST baseline unit', () => {
    const index = BASELINE_UNITS.indexOf(CE1_UNIT!)
    expect(index).toBe(BASELINE_UNITS.length - 1)
  })

  it(`the harness provisioned the full baseline (${BASELINE_UNITS.length} units, CE-1 included) and tore itself down with zero leftovers`, () => {
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
})
