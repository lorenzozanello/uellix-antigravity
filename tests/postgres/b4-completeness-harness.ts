// tests/postgres/b4-completeness-harness.ts
// W2-B4 (HPO-ODS-W2-12, docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json) — setup/
// probe generator for the CANONICAL disposable PostgreSQL harness
// (scripts/db-audit-disposable.ts, `pnpm db:audit:disposable`), frozen in
// docs/ops/wave2/W2_B4_TEST_MANIFEST_v1.json (postgres_requirements). It
// never opens a connection itself. Mirrors tests/postgres/b3-completeness-harness.ts
// exactly — the only committed template for this shape.
//
//   pnpm exec tsx tests/postgres/b4-completeness-harness.ts <outDir>
//     writes <outDir>/setup.json  — {statements: string[]}
//        and <outDir>/probes.json — {probes: [{id, sql}]}
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. cluster role topology mirrored from db/baseline/stella_g2_roles.sql;
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions);
//   4. EVERY db/hosted/baseline-manifest.ts unit in manifest order — 0062
//      (methodological_assumptions, assumption_object_links) and 0063
//      (counterfactual_assessments) included automatically, once registered
//      there, never spliced in by hand;
//   5. hosted-fidelity block: auth.uid() with the HOSTED semantics,
//      public.* OWNER TO uellix_owner, runtime reachability grants
//      (extended below with the RLS helpers this batch's own policies
//      call — current_user_org_ids/current_user_is_super_admin/
//      current_user_role_in_org — plus SELECT on the three new B4 tables
//      for uellix_writer/uellix_auditor, SEC-ACL-1's positive disposition);
//   6. a two-tenant fixture (org A: analyst uA + viewer uV; org B: analyst
//      uB), extended with one methodological_assumptions row, one
//      assumption_object_links row and one counterfactual_assessments row
//      per organization, so every cross-tenant probe below has a real,
//      pre-existing "other org's row" to prove it cannot read.
//
// READ THIS BEFORE CITING A GREEN RUN: the hosted-fidelity block is a MODEL
// of the hosted posture, not a measurement of it — see
// tests/postgres/b3-completeness-harness.ts's identical disclosure.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BASELINE_UNITS } from '../../db/hosted/baseline-manifest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const PROBES_TEMPLATE = 'tests/postgres/b4-completeness.probes.json'

/** Deterministic fixture ids (v4-shaped, fixed) — shared with the probes template. */
export const IDS = {
  uA: '0a000000-0000-4000-8000-00000000000a',
  uB: '0b000000-0000-4000-8000-00000000000b',
  uV: '0c000000-0000-4000-8000-00000000000c',
  oA: '1a000000-0000-4000-8000-00000000001a',
  oB: '1b000000-0000-4000-8000-00000000001b',
  pA: '2a000000-0000-4000-8000-00000000002a',
  pB: '2b000000-0000-4000-8000-00000000002b',
  sA: '3a000000-0000-4000-8000-00000000003a',
  sB: '3b000000-0000-4000-8000-00000000003b',
  outA: '4a000000-0000-4000-8000-00000000004a',
  // A SECOND org-A outcome with no fixture row of its own — scratch space
  // for probes that INSERT a fresh counterfactual_assessments row, so they
  // never collide with the caA fixture row already bound to
  // (outA, rA1) under uq_counterfactual_assessments_outcome_run.
  outA2: '4a000000-0000-4000-8000-00000000004b',
  outB: '4b000000-0000-4000-8000-00000000004c',
  rA1: '5a000000-0000-4000-8000-00000000005a',
  rB1: '5b000000-0000-4000-8000-00000000005c',
  maA: '7a000000-0000-4000-8000-00000000007a',
  maB: '7b000000-0000-4000-8000-00000000007b',
  aolA: '8a000000-0000-4000-8000-00000000008a',
  aolB: '8b000000-0000-4000-8000-00000000008b',
  caA: '9a000000-0000-4000-8000-00000000009a',
  caB: '9b000000-0000-4000-8000-00000000009b',
} as const

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
DO $o$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO uellix_owner', r.tablename);
  END LOOP;
END $o$;
-- (3) Runtime reachability: stella_0004 §6b-bis / stella_hosted_0006 (helper EXECUTE), schema usage, auth.uid() reach.
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app;
GRANT USAGE ON SCHEMA auth TO uellix_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
-- (4) SEC-ACL-1 — the B4 tables' hosted disposition, MODELED identically to
-- the pre-existing outcome_monetization_dispositions pattern: RLS is the
-- real gate, this SELECT grant only clears the table-level ACL floor RLS
-- itself sits behind.
GRANT SELECT, INSERT, UPDATE ON public.methodological_assumptions, public.counterfactual_assessments TO uellix_writer;
GRANT SELECT, INSERT ON public.assumption_object_links TO uellix_writer;
GRANT SELECT ON public.methodological_assumptions, public.assumption_object_links, public.counterfactual_assessments TO uellix_auditor;
`

const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES ('${IDS.uA}','ua@pg.local'),('${IDS.uB}','ub@pg.local'),('${IDS.uV}','uv@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email) VALUES ('${IDS.uA}','ua@pg.local'),('${IDS.uB}','ub@pg.local'),('${IDS.uV}','uv@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES ('${IDS.oA}','B4 Org A','b4-org-a'),('${IDS.oB}','B4 Org B','b4-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.oA}','${IDS.uA}','analyst','active'),
  ('${IDS.oB}','${IDS.uB}','analyst','active'),
  ('${IDS.oA}','${IDS.uV}','viewer','active');
INSERT INTO public.projects (id, organization_id, name, created_by) VALUES ('${IDS.pA}','${IDS.oA}','B4 Project A','${IDS.uA}'),('${IDS.pB}','${IDS.oB}','B4 Project B','${IDS.uB}');
INSERT INTO public.stakeholder_groups (id, project_id, name) VALUES ('${IDS.sA}','${IDS.pA}','SG A'),('${IDS.sB}','${IDS.pB}','SG B');
INSERT INTO public.outcomes (id, project_id, stakeholder_group_id, title, created_by) VALUES
  ('${IDS.outA}','${IDS.pA}','${IDS.sA}','Outcome A','${IDS.uA}'),
  ('${IDS.outA2}','${IDS.pA}','${IDS.sA}','Outcome A2 (scratch)','${IDS.uA}'),
  ('${IDS.outB}','${IDS.pB}','${IDS.sB}','Outcome B','${IDS.uB}');
INSERT INTO public.sroi_calculation_runs (id, project_id, organization_id, version, status, calculated_by) VALUES
  ('${IDS.rA1}','${IDS.pA}','${IDS.oA}',1,'calculated','${IDS.uA}'),
  ('${IDS.rB1}','${IDS.pB}','${IDS.oB}',1,'calculated','${IDS.uB}');

-- FIBIU-15 fixture rows, one per organization.
INSERT INTO public.methodological_assumptions (id, organization_id, project_id, formulation, rationale, basis_type, materiality_flag, created_by) VALUES
  ('${IDS.maA}','${IDS.oA}','${IDS.pA}','Assumption A formulation','Assumption A rationale','derived','material','${IDS.uA}'),
  ('${IDS.maB}','${IDS.oB}','${IDS.pB}','Assumption B formulation','Assumption B rationale','derived','material','${IDS.uB}');
INSERT INTO public.assumption_object_links (id, organization_id, assumption_id, affected_object_type, affected_object_id, created_by) VALUES
  ('${IDS.aolA}','${IDS.oA}','${IDS.maA}','outcome','${IDS.outA}','${IDS.uA}'),
  ('${IDS.aolB}','${IDS.oB}','${IDS.maB}','outcome','${IDS.outB}','${IDS.uB}');

-- FIBIU-14 fixture rows, one per organization.
INSERT INTO public.counterfactual_assessments (id, organization_id, outcome_id, calculation_run_id, baseline_availability, basis_kind, deadweight_support_state, rationale, created_by) VALUES
  ('${IDS.caA}','${IDS.oA}','${IDS.outA}','${IDS.rA1}','not_applicable','documented_assumption','supported','Assessment A rationale','${IDS.uA}'),
  ('${IDS.caB}','${IDS.oB}','${IDS.outB}','${IDS.rB1}','not_applicable','documented_assumption','supported','Assessment B rationale','${IDS.uB}');
`

export interface SetupManifest {
  statements: string[]
}
export interface ProbeManifest {
  probes: { id: string; sql: string }[]
}

export function buildSetupManifest(root: string = ROOT): SetupManifest {
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(root, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) {
    statements.push(`-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(root, unit.file), 'utf8'))
  }
  statements.push(HOSTED_FIDELITY)
  statements.push(FIXTURE)
  return { statements }
}

export function resolveProbes(root: string = ROOT): ProbeManifest {
  const template = JSON.parse(readFileSync(path.join(root, PROBES_TEMPLATE), 'utf8')) as ProbeManifest
  return template
}

export function writeManifests(outDir: string, root: string = ROOT): { setupPath: string; probePath: string } {
  mkdirSync(outDir, { recursive: true })
  const setupPath = path.join(outDir, 'setup.json')
  const probePath = path.join(outDir, 'probes.json')
  writeFileSync(setupPath, JSON.stringify(buildSetupManifest(root)), 'utf8')
  writeFileSync(probePath, JSON.stringify(resolveProbes(root), null, 1), 'utf8')
  return { setupPath, probePath }
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  const outDir = process.argv[2]
  if (!outDir) {
    console.error('usage: tsx tests/postgres/b4-completeness-harness.ts <outDir>')
    process.exit(2)
  }
  const { setupPath, probePath } = writeManifests(outDir)
  console.log(`setup:  ${setupPath} (${BASELINE_UNITS.length} baseline units)`)
  console.log(`probes: ${probePath}`)
}
