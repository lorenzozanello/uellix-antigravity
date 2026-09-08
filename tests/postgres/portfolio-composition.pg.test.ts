// tests/postgres/portfolio-composition.pg.test.ts
// PORTFOLIO_PF2_EXECUTION_AUTHORITY_v1.0.0.json — Portfolio composition, REAL
// PostgreSQL controls (POS-PG-1, NEG-PG-1, NEG-TENANT-1/2, POS-COMP-3,
// POS-COMP-4, NEG-COMP-1, NEG-COMP-2, MUT-TENANT-1), run through the
// CANONICAL disposable harness scripts/db-audit-disposable.ts: a throwaway
// postgres container on 127.0.0.1, ephemeral port, no bind mounts, teardown
// in `finally`, leftover check. Never staging, never production, never the
// canonical local stack.
//
// SELF-CONTAINED PROBE PATTERN (POSTGRES_CONTRACT): no probes.json
// companion. PF2 introduces no schema, no migration and no RLS policy — the
// FULL baseline manifest is applied unmodified, and every probe below is
// application-shaped SQL exercising the pre-existing portfolios/projects RLS
// policies (db/migrations/0031_rls_core.sql) exactly as
// lib/portfolios/service.ts and lib/projects/service.ts issue their writes.
//
// what_a_real_database_must_prove (POSTGRES_CONTRACT): the cross-organization
// refusal on assign and move (with SENT-PF-CROSS-ORG-PROJECT absent from
// every org-A-scoped read); the read path for an impact_manager with the
// identity context open; that a move is one UPDATE affecting one row, and a
// move whose source no longer matches affects zero rows and is refused; that
// archiving a portfolio changes exactly one column of one portfolios row and
// leaves every member project's row byte-identical.
//
// what_a_real_database_CANNOT_prove (ROLE_ENFORCEMENT_LAYER): the analyst
// denial — both governing RLS policies admit 'analyst'. That control is
// discharged at the application layer, in tests/auth/permissions.test.ts and
// tests/portfolios.service.test.ts; asserting it here would be a FALSE
// control (PF2-NEG-ROLE-RLS-1).
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { runDisposableHarness, DEFAULT_IMAGE, type HarnessOutcome, type SetupManifest, type ProbeManifest } from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(__dirname, '..', '..')

/** Deterministic fixture ids (v4-shaped, fixed), disjoint from every other pg suite's own IDs prefix. */
export const IDS = {
  // users
  uIM_A: '2a200000-0000-4000-8000-0000000000a1', // impact_manager, member of org A only
  uSA: '2a200000-0000-4000-8000-0000000000a2', // platform super admin
  // organizations
  orgA: '2a200000-0000-4000-8000-00000000000a',
  orgB: '2a200000-0000-4000-8000-00000000000b',
  // portfolios
  portfolioA1: '2a200000-0000-4000-8000-0000000000b1', // active, in org A — assign/move target
  portfolioA2: '2a200000-0000-4000-8000-0000000000b2', // active, in org A — move source
  portfolioA3: '2a200000-0000-4000-8000-0000000000b3', // ARCHIVED, in org A — NEG-COMP-1
  portfolioB1: '2a200000-0000-4000-8000-0000000000b4', // active, in org B — NEG-TENANT-2 target
  // projects
  projA_unassigned: '2a200000-0000-4000-8000-0000000000c1', // in org A, no portfolio — POS-COMP-2/assign
  projA_inA2: '2a200000-0000-4000-8000-0000000000c2', // in org A, member of portfolioA2 — move source/target
  projA_inA3: '2a200000-0000-4000-8000-0000000000c3', // in org A, member of ARCHIVED portfolioA3 — POS-COMP-4
  projB_sentinel: '2a200000-0000-4000-8000-0000000000c4', // SENT-PF-CROSS-ORG-PROJECT, in org B
} as const

const SENTINEL_MARKER = 'SENT-PF-CROSS-ORG-PROJECT'

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

/**
 * The world PF2's composition writes act on: two organizations, an
 * impact_manager who belongs to org A only, and the portfolio/project rows
 * each probe below exercises. PF2 adds no schema, so this fixture is applied
 * AFTER the full baseline manifest.
 */
const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.uIM_A}','pf2-im-a@pg.local'),('${IDS.uSA}','pf2-sa@pg.local')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.uIM_A}','pf2-im-a@pg.local',false),('${IDS.uSA}','pf2-sa@pg.local',false)
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.uSA}';

INSERT INTO public.organizations (id, name, slug) VALUES
  ('${IDS.orgA}','PF2 Org A','pf2-org-a'),
  ('${IDS.orgB}','PF2 Org B','pf2-org-b');

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}','${IDS.uIM_A}','impact_manager','active');

INSERT INTO public.portfolios (id, organization_id, name, status, created_by) VALUES
  ('${IDS.portfolioA1}','${IDS.orgA}','PF2 Portfolio A1 (active target)','active','${IDS.uIM_A}'),
  ('${IDS.portfolioA2}','${IDS.orgA}','PF2 Portfolio A2 (move source)','active','${IDS.uIM_A}'),
  ('${IDS.portfolioA3}','${IDS.orgA}','PF2 Portfolio A3 (archived)','archived','${IDS.uIM_A}'),
  ('${IDS.portfolioB1}','${IDS.orgB}','PF2 Portfolio B1 (other org)','active','${IDS.uSA}');

INSERT INTO public.projects (id, organization_id, portfolio_id, name, status, created_by) VALUES
  ('${IDS.projA_unassigned}','${IDS.orgA}',NULL,'PF2 Project A (unassigned)','active','${IDS.uIM_A}'),
  ('${IDS.projA_inA2}','${IDS.orgA}','${IDS.portfolioA2}','PF2 Project A (in A2)','active','${IDS.uIM_A}'),
  ('${IDS.projA_inA3}','${IDS.orgA}','${IDS.portfolioA3}','PF2 Project A (in archived A3)','active','${IDS.uIM_A}'),
  ('${IDS.projB_sentinel}','${IDS.orgB}',NULL,'${SENTINEL_MARKER}','active','${IDS.uSA}');
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
-- (3) Runtime reachability: schema usage, auth.uid() reach, RLS helper EXECUTE.
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app;
GRANT USAGE ON SCHEMA auth TO uellix_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
-- (4) The runtime writer's table ACL floor — matches the GRANT db/migrations/0033_public_api_grants.sql issues.
GRANT SELECT, INSERT, UPDATE ON public.organizations, public.portfolios, public.projects TO uellix_writer;
GRANT SELECT ON public.organization_members, public.users TO uellix_writer;
`

function unitStatement(unit: (typeof BASELINE_UNITS)[number]): string {
  return `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(ROOT, unit.file), 'utf8')
}

export function buildSetupManifest(): SetupManifest {
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(ROOT, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) statements.push(unitStatement(unit))
  statements.push(FIXTURE)
  statements.push(HOSTED_FIDELITY)
  return { statements }
}

const asUser = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

export function buildProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  // --- POS-PG-1: the read path for an impact_manager in organization A -------
  add('POS-PG-1-impact_manager-reads-own-organization-portfolios-and-projects', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; BEGIN
  IF auth.uid() IS DISTINCT FROM '${IDS.uIM_A}'::uuid THEN RAISE EXCEPTION 'POS-PG-1 claims not effective: auth.uid()=%', auth.uid(); END IF;
  SELECT count(*) INTO n FROM public.portfolios WHERE organization_id = '${IDS.orgA}';
  IF n <> 3 THEN RAISE EXCEPTION 'POS-PG-1 org A portfolio count=% expected=3', n; END IF;
  SELECT count(*) INTO n FROM public.projects WHERE organization_id = '${IDS.orgA}';
  IF n <> 3 THEN RAISE EXCEPTION 'POS-PG-1 org A project count=% expected=3', n; END IF;
END $p$;
ROLLBACK;`)

  // --- NEG-TENANT-2: a portfolio in org B is not readable from org A ---------
  add('NEG-TENANT-2-org-B-portfolio-and-sentinel-project-invisible-from-org-A', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; found text; BEGIN
  SELECT count(*) INTO n FROM public.portfolios WHERE id = '${IDS.portfolioB1}';
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-TENANT-2 org B portfolio visible from org A (count=%)', n; END IF;
  SELECT count(*) INTO n FROM public.projects WHERE id = '${IDS.projB_sentinel}';
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-TENANT-2 sentinel project visible from org A (count=%)', n; END IF;
  SELECT string_agg(name, ',') INTO found FROM public.projects WHERE organization_id = '${IDS.orgA}' AND name = '${SENTINEL_MARKER}';
  IF found IS NOT NULL THEN RAISE EXCEPTION 'NEG-TENANT-2 sentinel marker leaked into an org-A-scoped read: %', found; END IF;
END $p$;
ROLLBACK;`)

  // --- NEG-TENANT-1 / NEG-PG-1: cross-org assign refused ----------------------
  // Mirrors assignProjectToPortfolioForCurrentOrganization's exact WHERE
  // clause: the app-layer organization_id predicate on its own already
  // excludes the sentinel (0 rows), which is the applicaton-layer half of
  // the control.
  add('NEG-TENANT-1-cross-org-assign-refused-at-the-application-predicate', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; BEGIN
  UPDATE public.projects SET portfolio_id = '${IDS.portfolioA1}'
   WHERE id = '${IDS.projB_sentinel}' AND organization_id = '${IDS.orgA}' AND portfolio_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-TENANT-1 expected 0 rows updated, got %', n; END IF;
END $p$;
ROLLBACK;`)

  // --- MUT-TENANT-1's real-database counterpart: even WITHOUT the org -------
  // predicate, RLS independently refuses — current_user_role_in_org(orgB) for
  // a caller who only belongs to org A resolves outside the allowed list, so
  // the USING clause excludes the row and zero rows are affected.
  add('NEG-PG-1-removing-the-organization-predicate-still-refused-by-RLS', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; BEGIN
  UPDATE public.projects SET portfolio_id = '${IDS.portfolioA1}'
   WHERE id = '${IDS.projB_sentinel}' AND portfolio_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-PG-1 expected RLS to independently refuse (0 rows), got %', n; END IF;
END $p$;
ROLLBACK;`)

  // --- NEG-COMP-1: assign/move refused against an ARCHIVED portfolio --------
  add('NEG-COMP-1-assign-refused-against-an-archived-portfolio', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; BEGIN
  UPDATE public.projects SET portfolio_id = '${IDS.portfolioA3}'
   WHERE id = '${IDS.projA_unassigned}' AND organization_id = '${IDS.orgA}' AND portfolio_id IS NULL
     AND EXISTS (SELECT 1 FROM public.portfolios WHERE id = '${IDS.portfolioA3}' AND status <> 'archived');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-COMP-1 expected assign against an archived portfolio to be refused (0 rows), got %', n; END IF;
END $p$;
ROLLBACK;`)

  // --- POS-COMP-3 / NEG-COMP-2: move is one UPDATE, one row; a mismatched ---
  // source affects zero rows and is refused, never retried, never converted.
  add('POS-COMP-3-move-is-one-UPDATE-affecting-exactly-one-row', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; dest text; BEGIN
  UPDATE public.projects SET portfolio_id = '${IDS.portfolioA1}'
   WHERE id = '${IDS.projA_inA2}' AND organization_id = '${IDS.orgA}' AND portfolio_id = '${IDS.portfolioA2}';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'POS-COMP-3 expected exactly 1 row updated, got %', n; END IF;
  SELECT portfolio_id::text INTO dest FROM public.projects WHERE id = '${IDS.projA_inA2}';
  IF dest IS DISTINCT FROM '${IDS.portfolioA1}' THEN RAISE EXCEPTION 'POS-COMP-3 project did not land in the target portfolio (dest=%)', dest; END IF;
END $p$;
ROLLBACK;`)

  add('NEG-COMP-2-move-with-a-stale-source-affects-zero-rows-and-is-refused', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; before text; BEGIN
  SELECT portfolio_id::text INTO before FROM public.projects WHERE id = '${IDS.projA_inA2}';
  -- projA_inA2 actually belongs to portfolioA2, not portfolioA1 — a stale source.
  UPDATE public.projects SET portfolio_id = '${IDS.portfolioA3}'
   WHERE id = '${IDS.projA_inA2}' AND organization_id = '${IDS.orgA}' AND portfolio_id = '${IDS.portfolioA1}';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-COMP-2 expected 0 rows updated on a stale source, got %', n; END IF;
  -- No partial move: the project's portfolio_id is unchanged, never nulled.
  PERFORM 1 FROM public.projects WHERE id = '${IDS.projA_inA2}' AND portfolio_id::text IS NOT DISTINCT FROM before;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEG-COMP-2 a refused move must never change portfolio_id'; END IF;
END $p$;
ROLLBACK;`)

  // --- POS-COMP-4: archiving changes exactly one column of one portfolios --
  // row and leaves every member project's row byte-identical.
  add('POS-COMP-4-archive-changes-one-column-and-leaves-member-projects-byte-identical', asUser(IDS.uIM_A) + `DO $p$ DECLARE n int; before_hash text; after_hash text; BEGIN
  -- portfolioA3 is already archived in the fixture; use a fresh active
  -- portfolio for this probe so the archiving UPDATE itself is observed. The
  -- project is moved into it FIRST, and the "before" hash is captured only
  -- AFTER that move settles — otherwise the move itself, not the archive,
  -- would be what the hash comparison actually measures.
  INSERT INTO public.portfolios (id, organization_id, name, status, created_by)
    VALUES ('2a200000-0000-4000-8000-0000000000b9', '${IDS.orgA}', 'PF2 Archive Probe Portfolio', 'active', '${IDS.uIM_A}');
  UPDATE public.projects SET portfolio_id = '2a200000-0000-4000-8000-0000000000b9'
   WHERE id = '${IDS.projA_inA3}' AND organization_id = '${IDS.orgA}' AND portfolio_id = '${IDS.portfolioA3}';

  SELECT md5(t::text) INTO before_hash FROM public.projects t WHERE id = '${IDS.projA_inA3}';

  UPDATE public.portfolios SET status = 'archived', updated_at = now()
   WHERE id = '2a200000-0000-4000-8000-0000000000b9' AND organization_id = '${IDS.orgA}';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'POS-COMP-4 expected exactly 1 portfolios row updated, got %', n; END IF;

  SELECT md5(t::text) INTO after_hash FROM public.projects t WHERE id = '${IDS.projA_inA3}';
  IF after_hash IS DISTINCT FROM before_hash THEN RAISE EXCEPTION 'POS-COMP-4 member project row changed when its portfolio was archived'; END IF;
END $p$;
ROLLBACK;`)

  return { probes }
}

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)('Portfolio composition (PF2) — real PostgreSQL (canonical disposable harness)', { timeout: 1_200_000 }, () => {
  let outcome: HarnessOutcome

  beforeAll(() => {
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: buildSetupManifest(),
      probe: buildProbeManifest(),
    })
    console.log(`PF2_PG_OUTCOME=${JSON.stringify({
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

  it(`the harness provisioned the full baseline (${BASELINE_UNITS.length} units) and tore itself down with zero leftovers`, () => {
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
