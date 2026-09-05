// tests/postgres/b5-completeness-harness.ts
// W2-B5 (HPO-ODS-W2-17) — setup/probe generator for the CANONICAL disposable
// PostgreSQL harness (scripts/db-audit-disposable.ts, `pnpm db:audit:disposable`).
// It never opens a connection itself. Mirrors tests/postgres/b4-completeness-harness.ts
// exactly — the only committed template for this shape.
//
//   pnpm exec tsx tests/postgres/b5-completeness-harness.ts <outDir>
//     writes <outDir>/setup.json  — {statements: string[]}
//        and <outDir>/probes.json — {probes: [{id, sql}]}
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. cluster role topology mirrored from db/baseline/stella_g2_roles.sql;
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions);
//   4. EVERY db/hosted/baseline-manifest.ts unit in manifest order — 0064
//      (readiness_assessments, FIBIU-17) and 0065 (sensitivity_candidates,
//      sensitivity_scenarios, FIBIU-18) included automatically, once
//      registered there, never spliced in by hand;
//   5. hosted-fidelity block: auth.uid() with the HOSTED semantics,
//      public.* OWNER TO uellix_owner, runtime reachability grants,
//      extended with SELECT/INSERT[/UPDATE] on the three new B5 tables for
//      uellix_writer/uellix_auditor (SEC-ACL-1's positive disposition —
//      sensitivity_candidates alone also carries UPDATE, the
//      FIBC-022-mandated disposition transition; readiness_assessments and
//      sensitivity_scenarios are append-only, no UPDATE grant, no policy);
//   6. a two-tenant fixture (org A: analyst uA + viewer uV; org B: analyst
//      uB), extended with one readiness_assessments row, one
//      sensitivity_candidates row (disposition=pending) and one
//      sensitivity_scenarios row per organization, so every cross-tenant
//      probe below has a real, pre-existing "other org's row" to prove it
//      cannot read — plus a second, assessment-less run per org (scratch
//      space) so INSERT probes never collide with a unique index already
//      bound by the fixture row.
//
// READ THIS BEFORE CITING A GREEN RUN: the hosted-fidelity block is a MODEL
// of the hosted posture, not a measurement of it — see
// tests/postgres/b3-completeness-harness.ts's identical disclosure.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BASELINE_UNITS } from '../../db/hosted/baseline-manifest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const PROBES_TEMPLATE = 'tests/postgres/b5-completeness.probes.json'

/** Deterministic fixture ids (v4-shaped, fixed) — shared with the probes template. */
export const IDS = {
  uA: '0a100000-0000-4000-8000-0000000000a1',
  uB: '0b100000-0000-4000-8000-0000000000b1',
  uV: '0c100000-0000-4000-8000-0000000000c1',
  oA: '1a100000-0000-4000-8000-0000000001a1',
  oB: '1b100000-0000-4000-8000-0000000001b1',
  pA: '2a100000-0000-4000-8000-0000000002a1',
  pB: '2b100000-0000-4000-8000-0000000002b1',
  sA: '3a100000-0000-4000-8000-0000000003a1',
  sB: '3b100000-0000-4000-8000-0000000003b1',
  outA: '4a100000-0000-4000-8000-0000000004a1',
  outB: '4b100000-0000-4000-8000-0000000004b1',
  rA1: '5a100000-0000-4000-8000-0000000005a1',
  // A SECOND org-A run with no readiness_assessments/sensitivity_candidates
  // row of its own — scratch space so INSERT probes never collide with the
  // fixture rows already bound under uq_readiness_assessments_calculation_run
  // / uq_sensitivity_candidates_run_key.
  rA2: '5a100000-0000-4000-8000-0000000005a2',
  rB1: '5b100000-0000-4000-8000-0000000005b1',
  raA: '6a100000-0000-4000-8000-0000000006a1',
  raB: '6b100000-0000-4000-8000-0000000006b1',
  scA: '7a100000-0000-4000-8000-0000000007a1',
  scB: '7b100000-0000-4000-8000-0000000007b1',
  ssA: '8a100000-0000-4000-8000-0000000008a1',
  ssB: '8b100000-0000-4000-8000-0000000008b1',
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
-- (4) SEC-ACL-1 — the B5 tables' hosted disposition, MODELED identically to
-- the pre-existing counterfactual_assessments pattern: RLS is the real gate,
-- these grants only clear the table-level ACL floor RLS itself sits behind.
-- sensitivity_candidates alone carries UPDATE (FIBC-022's governed
-- disposition transition); readiness_assessments and sensitivity_scenarios
-- are append-only, no UPDATE grant.
GRANT SELECT, INSERT ON public.readiness_assessments, public.sensitivity_scenarios TO uellix_writer;
GRANT SELECT, INSERT, UPDATE ON public.sensitivity_candidates TO uellix_writer;
GRANT SELECT ON public.readiness_assessments, public.sensitivity_candidates, public.sensitivity_scenarios TO uellix_auditor;
`

const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES ('${IDS.uA}','ua-b5@pg.local'),('${IDS.uB}','ub-b5@pg.local'),('${IDS.uV}','uv-b5@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email) VALUES ('${IDS.uA}','ua-b5@pg.local'),('${IDS.uB}','ub-b5@pg.local'),('${IDS.uV}','uv-b5@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES ('${IDS.oA}','B5 Org A','b5-org-a'),('${IDS.oB}','B5 Org B','b5-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.oA}','${IDS.uA}','analyst','active'),
  ('${IDS.oB}','${IDS.uB}','analyst','active'),
  ('${IDS.oA}','${IDS.uV}','viewer','active');
INSERT INTO public.projects (id, organization_id, name, created_by) VALUES ('${IDS.pA}','${IDS.oA}','B5 Project A','${IDS.uA}'),('${IDS.pB}','${IDS.oB}','B5 Project B','${IDS.uB}');
INSERT INTO public.stakeholder_groups (id, project_id, name) VALUES ('${IDS.sA}','${IDS.pA}','SG A'),('${IDS.sB}','${IDS.pB}','SG B');
INSERT INTO public.outcomes (id, project_id, stakeholder_group_id, title, created_by) VALUES
  ('${IDS.outA}','${IDS.pA}','${IDS.sA}','Outcome A','${IDS.uA}'),
  ('${IDS.outB}','${IDS.pB}','${IDS.sB}','Outcome B','${IDS.uB}');
INSERT INTO public.sroi_calculation_runs (id, project_id, organization_id, version, status, calculated_by) VALUES
  ('${IDS.rA1}','${IDS.pA}','${IDS.oA}',1,'calculated','${IDS.uA}'),
  ('${IDS.rA2}','${IDS.pA}','${IDS.oA}',2,'calculated','${IDS.uA}'),
  ('${IDS.rB1}','${IDS.pB}','${IDS.oB}',1,'calculated','${IDS.uB}');

-- FIBIU-17 fixture rows, one per organization.
INSERT INTO public.readiness_assessments (id, organization_id, project_id, calculation_run_id, readiness_model_version, global_score, band, dimension_scores, criteria_detail, created_by) VALUES
  ('${IDS.raA}','${IDS.oA}','${IDS.pA}','${IDS.rA1}','1.0.0','60.00','partial_preparation','{}','[]','${IDS.uA}'),
  ('${IDS.raB}','${IDS.oB}','${IDS.pB}','${IDS.rB1}','1.0.0','60.00','partial_preparation','{}','[]','${IDS.uB}');

-- FIBIU-18 fixture rows, one per organization.
INSERT INTO public.sensitivity_candidates (id, organization_id, project_id, calculation_run_id, candidate_key, candidate_kind, input_reference, base_value, disposition, sensitivity_model_version, created_by) VALUES
  ('${IDS.scA}','${IDS.oA}','${IDS.pA}','${IDS.rA1}','methodological_filter:x:deadweight','methodological_filter','{}','0','pending','1.0.0','${IDS.uA}'),
  ('${IDS.scB}','${IDS.oB}','${IDS.pB}','${IDS.rB1}','methodological_filter:x:deadweight','methodological_filter','{}','0','pending','1.0.0','${IDS.uB}');
INSERT INTO public.sensitivity_scenarios (id, organization_id, project_id, calculation_run_id, scenario_kind, candidate_ids, modified_inputs, reason, sensitivity_model_version, calculation_engine_version, result_json, base_result_json, selected_by, created_by) VALUES
  ('${IDS.ssA}','${IDS.oA}','${IDS.pA}','${IDS.rA1}','one_at_a_time','[]','[]','Fixture scenario A','1.0.0','1.0.0','{}','{}','${IDS.uA}','${IDS.uA}'),
  ('${IDS.ssB}','${IDS.oB}','${IDS.pB}','${IDS.rB1}','one_at_a_time','[]','[]','Fixture scenario B','1.0.0','1.0.0','{}','{}','${IDS.uB}','${IDS.uB}');
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
    console.error('usage: tsx tests/postgres/b5-completeness-harness.ts <outDir>')
    process.exit(2)
  }
  const { setupPath, probePath } = writeManifests(outDir)
  console.log(`setup:  ${setupPath} (${BASELINE_UNITS.length} baseline units)`)
  console.log(`probes: ${probePath}`)
}
