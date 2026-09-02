// tests/postgres/b3-completeness-harness.ts
// W2-B3 completeness — setup/probe generator for the CANONICAL disposable
// PostgreSQL harness (scripts/db-audit-disposable.ts, `pnpm db:audit:disposable`),
// governed by docs/ops/wave2/W2_B3_COMPLETENESS_AUTHORITY_v1.0.0.json
// (AG-B3-5) and frozen in docs/ops/wave2/W2_B3_TEST_MANIFEST_v2.json
// (postgres_requirements). It never opens a connection itself.
//
//   pnpm exec tsx tests/postgres/b3-completeness-harness.ts <outDir>
//     writes <outDir>/setup.json  — {statements: string[]}
//        and <outDir>/probes.json — {probes: [{id, sql}]} with the
//        {{MIGRATION_0060_SQL}} placeholder of b3-completeness.probes.json
//        resolved from the migration file (so PG-15 always applies the
//        CURRENT bytes of 0060, never a copy that could drift).
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. cluster role topology mirrored from db/baseline/stella_g2_roles.sql
//      (attributes and memberships only, no passwords);
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions — see
//      tests/postgres/disposable-db.ts for why a baseline-only provision
//      needs it);
//   4. EVERY db/hosted/baseline-manifest.ts unit in manifest order — 0060
//      included once registered there, never spliced in by hand;
//   5. hosted-fidelity block: auth.uid() with the HOSTED semantics
//      (db/baseline/stella_g2_schema.sql:486-494 — the runtime sets
//      request.jwt.claims, the shim only reads request.jwt.claim.sub),
//      public.* OWNER TO uellix_owner as the G2 dump measures, runtime
//      reachability grants (stella_0004 §6b-bis), and the stella_0004 §6b
//      operational-class grant on outcome_monetization_dispositions;
//   6. a two-tenant fixture (org A: analyst uA + viewer uV; org B: analyst
//      uB; runs rA1 pre-approved, rA2 approved, rB1; dispositions dA1/dA2/dB1).
//
// READ THIS BEFORE CITING A GREEN RUN: everything in step 5 is a MODEL of
// the hosted posture, not a measurement of it — see the authority's
// downstream_ratio_consumer_classification.NEEDS_AUTHORITY_REVIEW entry on
// the hosted table ACL for tables born after stella_hosted_0007.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BASELINE_UNITS } from '../../db/hosted/baseline-manifest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const MIGRATION_0060 = 'db/migrations/0060_fib_outcome_monetization_dispositions_governance.sql'
export const PROBES_TEMPLATE = 'tests/postgres/b3-completeness.probes.json'

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
  outA2: '4a000000-0000-4000-8000-00000000004b',
  outB: '4b000000-0000-4000-8000-00000000004c',
  rA1: '5a000000-0000-4000-8000-00000000005a',
  rA2: '5a000000-0000-4000-8000-00000000005b',
  rB1: '5b000000-0000-4000-8000-00000000005c',
  dA1: '6a000000-0000-4000-8000-00000000006a',
  dA2: '6a000000-0000-4000-8000-00000000006b',
  dB1: '6b000000-0000-4000-8000-00000000006c',
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
-- (4) stella_0004 §6b operational class MODELED for the tables under test.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outcome_monetization_dispositions TO uellix_writer;
GRANT SELECT ON public.outcomes, public.sroi_calculation_runs, public.sroi_run_reviews, public.organization_members, public.projects, public.sroi_filter_sets TO uellix_writer;
`

const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES ('${IDS.uA}','ua@pg.local'),('${IDS.uB}','ub@pg.local'),('${IDS.uV}','uv@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email) VALUES ('${IDS.uA}','ua@pg.local'),('${IDS.uB}','ub@pg.local'),('${IDS.uV}','uv@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES ('${IDS.oA}','B3 Org A','b3-org-a'),('${IDS.oB}','B3 Org B','b3-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.oA}','${IDS.uA}','analyst','active'),
  ('${IDS.oB}','${IDS.uB}','analyst','active'),
  ('${IDS.oA}','${IDS.uV}','viewer','active');
INSERT INTO public.projects (id, organization_id, name, created_by) VALUES ('${IDS.pA}','${IDS.oA}','B3 Project A','${IDS.uA}'),('${IDS.pB}','${IDS.oB}','B3 Project B','${IDS.uB}');
INSERT INTO public.stakeholder_groups (id, project_id, name) VALUES ('${IDS.sA}','${IDS.pA}','SG A'),('${IDS.sB}','${IDS.pB}','SG B');
INSERT INTO public.outcomes (id, project_id, stakeholder_group_id, title, created_by) VALUES
  ('${IDS.outA}','${IDS.pA}','${IDS.sA}','Outcome A','${IDS.uA}'),
  ('${IDS.outA2}','${IDS.pA}','${IDS.sA}','Outcome A2','${IDS.uA}'),
  ('${IDS.outB}','${IDS.pB}','${IDS.sB}','Outcome B','${IDS.uB}');
-- status is explicit: the column's stored DEFAULT ('completed') predates the
-- CHECK that now allows only calculated/failed/pending — the service always
-- writes status explicitly too.
INSERT INTO public.sroi_calculation_runs (id, project_id, organization_id, version, status, calculated_by) VALUES
  ('${IDS.rA1}','${IDS.pA}','${IDS.oA}',1,'calculated','${IDS.uA}'),
  ('${IDS.rA2}','${IDS.pA}','${IDS.oA}',2,'calculated','${IDS.uA}'),
  ('${IDS.rB1}','${IDS.pB}','${IDS.oB}',1,'calculated','${IDS.uB}');
INSERT INTO public.sroi_run_reviews (organization_id, project_id, calculation_run_id, reviewer_id, status, created_by) VALUES
  ('${IDS.oA}','${IDS.pA}','${IDS.rA2}','${IDS.uA}','approved','${IDS.uA}');
INSERT INTO public.outcome_monetization_dispositions (id, organization_id, outcome_id, calculation_run_id, disposition, reason, justification, created_by) VALUES
  ('${IDS.dA1}','${IDS.oA}','${IDS.outA}','${IDS.rA1}','not_monetized','no_defensible_proxy','before','${IDS.uA}'),
  ('${IDS.dB1}','${IDS.oB}','${IDS.outB}','${IDS.rB1}','not_monetized','no_defensible_proxy','before-b','${IDS.uB}');
`

/**
 * dA2 belongs to the APPROVED run rA2. Once 0060 is applied its guard refuses
 * every INSERT on an approved run, so the approved-run fixture row must be
 * inserted with the guard disabled — the fixture is the "row that existed
 * before approval" state PG-14 tests against. Session-local, superuser only,
 * never part of any product path.
 */
const APPROVED_FIXTURE = `
ALTER TABLE public.outcome_monetization_dispositions DISABLE TRIGGER trg_outcome_monetization_dispositions_approval_guard;
INSERT INTO public.outcome_monetization_dispositions (id, organization_id, outcome_id, calculation_run_id, disposition, reason, justification, created_by) VALUES
  ('${IDS.dA2}','${IDS.oA}','${IDS.outA}','${IDS.rA2}','not_monetized','no_defensible_proxy','before-approved','${IDS.uA}');
ALTER TABLE public.outcome_monetization_dispositions ENABLE TRIGGER trg_outcome_monetization_dispositions_approval_guard;
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
  const has0060 = BASELINE_UNITS.some((u) => u.file === MIGRATION_0060)
  statements.push(has0060 ? APPROVED_FIXTURE : APPROVED_FIXTURE.split('\n').filter((l) => !/TRIGGER trg_/.test(l)).join('\n'))
  return { statements }
}

export function resolveProbes(root: string = ROOT): ProbeManifest {
  const template = JSON.parse(readFileSync(path.join(root, PROBES_TEMPLATE), 'utf8')) as ProbeManifest
  const migration = readFileSync(path.join(root, MIGRATION_0060), 'utf8')
  return {
    probes: template.probes.map((p) => ({ id: p.id, sql: p.sql.split('{{MIGRATION_0060_SQL}}').join(migration) })),
  }
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
    console.error('usage: tsx tests/postgres/b3-completeness-harness.ts <outDir>')
    process.exit(2)
  }
  const { setupPath, probePath } = writeManifests(outDir)
  console.log(`setup:  ${setupPath} (${BASELINE_UNITS.length} baseline units)`)
  console.log(`probes: ${probePath}`)
}
