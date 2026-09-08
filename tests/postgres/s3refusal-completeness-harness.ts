// tests/postgres/s3refusal-completeness-harness.ts
// Multi-org S3 REFUSAL AUDIT (HPO-ODS-W2-25) — setup/probe generator for the
// CANONICAL disposable PostgreSQL harness (scripts/db-audit-disposable.ts,
// `pnpm db:audit:disposable`). It never opens a connection itself. Mirrors
// tests/postgres/b5-completeness-harness.ts, the committed template for this
// shape.
//
//   pnpm exec tsx tests/postgres/s3refusal-completeness-harness.ts <outDir>
//     writes <outDir>/setup.json  — {statements: string[]}
//        and <outDir>/probes.json — {probes: [{id, sql}]}
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. cluster role topology mirrored from db/baseline/stella_g2_roles.sql;
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions);
//   4. EVERY db/hosted/baseline-manifest.ts unit in manifest order — which is
//      how 0067_tenancy_refusal_audit_insert_policy.sql reaches the cluster.
//      It is NEVER spliced in by hand: if the unit were not registered in the
//      manifest, this harness would provision a database without it and every
//      positive probe below would fail. That is deliberate — it means a green
//      run is also evidence that the unit is registered.
//   5. hosted-fidelity block: auth.uid() with the HOSTED semantics, public.*
//      OWNER TO uellix_owner, runtime reachability grants, extended with
//      SELECT/INSERT on public.audit_logs for uellix_writer (which uellix_app
//      inherits) — the table-level ACL floor that RLS then sits behind;
//   6. a two-tenant fixture plus a super-admin principal, so every readability
//      probe has a real "other org's member" and a real super-admin to measure
//      against, and one VALID-BUT-UNREGISTERED organisation UUID that
//      deliberately has NO organizations row, so the no-existence-oracle probe
//      is non-vacuous.
//
// READ THIS BEFORE CITING A GREEN RUN: the hosted-fidelity block is a MODEL of
// the hosted posture, not a measurement of it — see
// tests/postgres/b3-completeness-harness.ts's identical disclosure.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BASELINE_UNITS } from '../../db/hosted/baseline-manifest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const PROBES_TEMPLATE = 'tests/postgres/s3refusal-completeness.probes.json'

/**
 * Deterministic fixture ids (v4-shaped, fixed) — shared with the probes
 * template, which carries the same literals.
 */
export const IDS = {
  /** Active member of organisation A. The refusing subject in every probe. */
  uA: '0a300000-0000-4000-8000-0000000000a3',
  /** Active member of organisation B — the org NAMED in the Form B subject. */
  uB: '0b300000-0000-4000-8000-0000000000b3',
  /** Super admin, deliberately a member of NOTHING. */
  uS: '0c300000-0000-4000-8000-0000000000c3',
  oA: '1a300000-0000-4000-8000-0000000001a3',
  oB: '1b300000-0000-4000-8000-0000000001b3',
  /**
   * A well-formed organisation UUID with NO organizations row, ever.
   *
   * Load-bearing and non-vacuous: the no-existence-oracle probe inserts a
   * Form B refusal naming this id and requires it to be ACCEPTED. If anyone
   * ever adds an existence lookup to the policy, that probe goes red — which
   * is the only way a lookup can be caught, since a lookup against an org
   * that DOES exist is indistinguishable from no lookup at all.
   */
  oGhost: '1f300000-0000-4000-8000-0000000001f3',
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
-- (3) Runtime reachability: stella_0004 6b-bis / stella_hosted_0006 (helper EXECUTE), schema usage, auth.uid() reach.
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app;
GRANT USAGE ON SCHEMA auth TO uellix_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
-- (4) The audit_logs ACL floor. RLS is the real gate — these grants only clear
-- the table-level permission RLS sits behind, and are modeled on 0033's
-- GRANT SELECT, INSERT ON public.audit_logs TO authenticated. NO UPDATE and NO
-- DELETE: audit_logs is append-only, and probe SEC-ACL-3 proves no policy for
-- either command exists to make them reachable.
GRANT SELECT, INSERT ON public.audit_logs TO uellix_writer;
GRANT SELECT ON public.audit_logs TO uellix_auditor;
`

const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.uA}','ua-s3refusal@pg.local'),
  ('${IDS.uB}','ub-s3refusal@pg.local'),
  ('${IDS.uS}','us-s3refusal@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.uA}','ua-s3refusal@pg.local', false),
  ('${IDS.uB}','ub-s3refusal@pg.local', false),
  ('${IDS.uS}','us-s3refusal@pg.local', true) ON CONFLICT (id) DO NOTHING;
-- MEASURED, AND THE INSERT ABOVE IS NOT ENOUGH ON ITS OWN. Baseline unit
-- 20260716000000_auth_trigger.sql syncs auth.users -> public.users, so the
-- auth.users insert above has ALREADY created these rows with is_super_admin
-- at its column default of false. The ON CONFLICT DO NOTHING above then
-- silently keeps that default, and the super-admin readability control fails
-- with a bare "helper returned false". The flag is therefore asserted here
-- explicitly rather than left to insert ordering, and probe FIXTURE-1
-- verifies it independently before RA-SUBJECT-10 relies on it.
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.uS}';
UPDATE public.users SET is_super_admin = false WHERE id IN ('${IDS.uA}','${IDS.uB}');
INSERT INTO public.organizations (id, name, slug) VALUES
  ('${IDS.oA}','S3 Refusal Org A','s3refusal-org-a'),
  ('${IDS.oB}','S3 Refusal Org B','s3refusal-org-b');
-- uA belongs to A, uB belongs to B. The super admin belongs to NOTHING, so a
-- green RA-SUBJECT-10 cannot be explained by an accidental membership.
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.oA}','${IDS.uA}','analyst','active'),
  ('${IDS.oB}','${IDS.uB}','analyst','active');
-- NOTHING is inserted for IDS.oGhost. Its absence is the control.
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
    console.error('usage: tsx tests/postgres/s3refusal-completeness-harness.ts <outDir>')
    process.exit(2)
  }
  const { setupPath, probePath } = writeManifests(outDir)
  console.log(`setup:  ${setupPath} (${BASELINE_UNITS.length} baseline units)`)
  console.log(`probes: ${probePath}`)
}
