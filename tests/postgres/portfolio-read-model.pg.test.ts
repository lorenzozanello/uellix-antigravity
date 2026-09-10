// tests/postgres/portfolio-read-model.pg.test.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — POSTGRES_CONTRACT: the four
// things a real PostgreSQL database, and only a real one, can prove for PF3.
// Run through the CANONICAL disposable harness scripts/db-audit-disposable.ts
// — a throwaway container on 127.0.0.1, ephemeral port, no bind mounts,
// teardown in `finally`, leftover check. Never staging, never production,
// never the canonical local stack. Mirrors
// tests/postgres/portfolio-composition.pg.test.ts's shape exactly (same
// ROLE_PRELUDE, same G2_PREREQUISITE_SHIM, same asUser/ROLLBACK convention,
// same full-baseline-then-fixture ordering) — PF3 adds no schema, so the
// baseline is applied unmodified.
//
// what_a_real_database_must_prove (POSTGRES_CONTRACT):
//   * chunking at PORTFOLIO_READ_MODEL_CHUNK_SIZE = 500 against a REAL
//     bind-parameter limit — POS-SIZE-2.
//   * the paginated aggregate is byte-identical to the unpaginated aggregate
//     on a real multi-page portfolio — POS-SIZE-1.
//   * EH-5 counts approved GLOBAL proxy versions (organization_id IS NULL)
//     that a mock join would not have exercised — MUT-PF3-TENANT-1's fixture
//     obligation.
//   * cross-tenant isolation under real row-level security, where a missing
//     context returns zero rows rather than erroring.
//
// what_a_real_database_CANNOT_prove: the props-only architecture, the
// entrypoint pins, the audit-verb count, the Stella boundary — those are
// static-surface facts proven by NEG-PF3-ARCH-1, NEG-PF3-ARCH-2,
// POS-PF3-ARCH-1 and the audit controls (lib/portfolios/read-model.test.ts).
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise. LOCK-HEAVY-LOCAL-PG is taken only for the duration of
// this suite's own run, never for the whole implementation mission.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { runDisposableHarness, DEFAULT_IMAGE, type HarnessOutcome, type SetupManifest, type ProbeManifest } from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(__dirname, '..', '..')

/** PORTFOLIO_READ_MODEL_CHUNK_SIZE, restated here as a plain literal — this
 * file is raw SQL and cannot import a TS constant, so the value is pinned
 * verbatim and must be kept equal to lib/portfolios/read-model.ts's own
 * export by inspection. */
const CHUNK_SIZE = 500
const BULK_MEMBER_COUNT = CHUNK_SIZE + 40 // forces exactly two chunks (500 + 40)

/** Deterministic fixture ids (v4-shaped, fixed), disjoint from every other pg suite's own IDs prefix. */
export const IDS = {
  uIM_A: '3f300000-0000-4000-8000-0000000000a1', // impact_manager, member of org A only
  uSA: '3f300000-0000-4000-8000-0000000000a2', // platform super admin (fixture bootstrap only)
  orgA: '3f300000-0000-4000-8000-00000000000a',
  orgB: '3f300000-0000-4000-8000-00000000000b',
  portfolioBulk: '3f300000-0000-4000-8000-0000000000b1', // org A — POS-SIZE-1/POS-SIZE-2 (541 members)
  portfolioProxy: '3f300000-0000-4000-8000-0000000000b2', // org A — MUT-PF3-TENANT-1 (global proxy)
  portfolioB1: '3f300000-0000-4000-8000-0000000000b3', // org B — tenancy isolation target
  projProxy: '3f300000-0000-4000-8000-0000000000c1', // org A, member of portfolioProxy
  projB_sentinel: '3f300000-0000-4000-8000-0000000000c2', // SENT-PF3-CROSS-ORG-PROJECT, org B
  stakeholderGroupProxy: '3f300000-0000-4000-8000-0000000000d1',
  outcomeProxy: '3f300000-0000-4000-8000-0000000000d2',
  runProxy: '3f300000-0000-4000-8000-0000000000e1',
  reviewProxy: '3f300000-0000-4000-8000-0000000000e2',
  proxySourceGlobal: '3f300000-0000-4000-8000-0000000000f1',
  financialProxyGlobal: '3f300000-0000-4000-8000-0000000000f2',
  financialProxyVersionGlobal: '3f300000-0000-4000-8000-0000000000f3', // organization_id IS NULL, approved
  assignmentGlobal: '3f300000-0000-4000-8000-0000000000f4',
} as const

const SENTINEL_MARKER = 'SENT-PF3-CROSS-ORG-PROJECT'

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
 * The world PF3's reads act on. `portfolioBulk` carries BULK_MEMBER_COUNT
 * (541) approved-run member projects, generated with generate_series rather
 * than hand-written — this is the fixture the chunking/pagination probes
 * below exercise at real bind-parameter scale. `portfolioProxy` carries a
 * SINGLE project whose outcome is bound to a GLOBALLY approved proxy version
 * (organization_id IS NULL) — the fixture MUT-PF3-TENANT-1 requires.
 */
const FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.uIM_A}','pf3-im-a@pg.local'),('${IDS.uSA}','pf3-sa@pg.local')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.uIM_A}','pf3-im-a@pg.local',false),('${IDS.uSA}','pf3-sa@pg.local',false)
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.uSA}';

INSERT INTO public.organizations (id, name, slug) VALUES
  ('${IDS.orgA}','PF3 Org A','pf3-org-a'),
  ('${IDS.orgB}','PF3 Org B','pf3-org-b');

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}','${IDS.uIM_A}','impact_manager','active');

INSERT INTO public.portfolios (id, organization_id, name, status, created_by) VALUES
  ('${IDS.portfolioBulk}','${IDS.orgA}','PF3 Bulk Portfolio (541 members)','active','${IDS.uIM_A}'),
  ('${IDS.portfolioProxy}','${IDS.orgA}','PF3 Proxy Portfolio','active','${IDS.uIM_A}'),
  ('${IDS.portfolioB1}','${IDS.orgB}','PF3 Portfolio B1 (other org)','active','${IDS.uSA}');

-- BULK MEMBERS: ${BULK_MEMBER_COUNT} projects, each with one CALCULATED run
-- (currency USD, methodology_version set, positive investment/net) and one
-- APPROVED review of the SAME organization — every one of them is an
-- INCLUDED member under PF1's own selection rule, so the full-portfolio
-- aggregate this fixture supports is deterministic: net = investment * 2 for
-- every member, so Sum(net)/Sum(investment) = 2 exactly, independent of N.
DO $bulk$
DECLARE
  i int;
  proj_id uuid;
  run_id uuid;
BEGIN
  FOR i IN 1..${BULK_MEMBER_COUNT} LOOP
    proj_id := ('3f300001-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid;
    run_id := ('3f300002-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid;
    INSERT INTO public.projects (id, organization_id, portfolio_id, name, status, governance_regime, created_by)
      VALUES (proj_id, '${IDS.orgA}', '${IDS.portfolioBulk}', 'PF3 Bulk Project ' || i, 'active', 'pc01b', '${IDS.uIM_A}');
    INSERT INTO public.sroi_calculation_runs
      (id, project_id, organization_id, version, currency, total_investment, net_social_value, sroi_ratio, status, methodology_version, calculated_by)
      VALUES (run_id, proj_id, '${IDS.orgA}', 1, 'USD', 100, 200, 2, 'calculated', 'v1', '${IDS.uIM_A}');
    INSERT INTO public.sroi_run_reviews (organization_id, project_id, calculation_run_id, reviewer_id, status, created_by)
      VALUES ('${IDS.orgA}', proj_id, run_id, '${IDS.uIM_A}', 'approved', '${IDS.uIM_A}');
  END LOOP;
END $bulk$;

-- PROXY FIXTURE (MUT-PF3-TENANT-1): one project, one outcome, one GLOBALLY
-- approved proxy version (organization_id IS NULL), one active assignment
-- binding the outcome to it, organization-bound through the assignment.
INSERT INTO public.projects (id, organization_id, portfolio_id, name, status, created_by)
  VALUES ('${IDS.projProxy}','${IDS.orgA}','${IDS.portfolioProxy}','PF3 Proxy Project','active','${IDS.uIM_A}');
INSERT INTO public.stakeholder_groups (id, project_id, name, status)
  VALUES ('${IDS.stakeholderGroupProxy}','${IDS.projProxy}','PF3 Stakeholder Group','active');
INSERT INTO public.outcomes (id, project_id, stakeholder_group_id, title, status, created_by)
  VALUES ('${IDS.outcomeProxy}','${IDS.projProxy}','${IDS.stakeholderGroupProxy}','PF3 Outcome','active','${IDS.uIM_A}');
INSERT INTO public.sroi_calculation_runs
  (id, project_id, organization_id, version, currency, total_investment, net_social_value, sroi_ratio, status, methodology_version, calculated_by)
  VALUES ('${IDS.runProxy}','${IDS.projProxy}','${IDS.orgA}',1,'USD',500,1000,2,'calculated','v1','${IDS.uIM_A}');
INSERT INTO public.sroi_run_reviews (id, organization_id, project_id, calculation_run_id, reviewer_id, status, created_by)
  VALUES ('${IDS.reviewProxy}','${IDS.orgA}','${IDS.projProxy}','${IDS.runProxy}','${IDS.uIM_A}','approved','${IDS.uIM_A}');
INSERT INTO public.proxy_sources (id, organization_id, name, created_by)
  VALUES ('${IDS.proxySourceGlobal}', NULL, 'PF3 Global Proxy Source', '${IDS.uSA}');
INSERT INTO public.financial_proxies (id, organization_id, source_id, name, value, currency, value_usd, unit, reference_year, review_status, created_by)
  VALUES ('${IDS.financialProxyGlobal}', NULL, '${IDS.proxySourceGlobal}', 'PF3 Global Proxy', 100, 'USD', 100, 'per unit', 2026, 'approved', '${IDS.uSA}');
-- organization_id IS NULL: a legitimate GLOBALLY approved proxy version.
INSERT INTO public.financial_proxy_versions (id, organization_id, financial_proxy_id, ordinal, source_id, value, currency, unit, reference_year, value_usd, review_status, created_by)
  VALUES ('${IDS.financialProxyVersionGlobal}', NULL, '${IDS.financialProxyGlobal}', 1, '${IDS.proxySourceGlobal}', 100, 'USD', 'per unit', 2026, 100, 'approved', '${IDS.uSA}');
INSERT INTO public.outcome_proxy_assignments (id, project_id, organization_id, outcome_id, proxy_id, financial_proxy_version_id, assigned_by, assignment_status)
  VALUES ('${IDS.assignmentGlobal}', '${IDS.projProxy}', '${IDS.orgA}', '${IDS.outcomeProxy}', '${IDS.financialProxyGlobal}', '${IDS.financialProxyVersionGlobal}', '${IDS.uIM_A}', 'active');

-- TENANCY SENTINEL: an org-B project, never visible from an org-A read.
INSERT INTO public.projects (id, organization_id, portfolio_id, name, status, created_by)
  VALUES ('${IDS.projB_sentinel}','${IDS.orgB}','${IDS.portfolioB1}','${SENTINEL_MARKER}','active','${IDS.uSA}');
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
GRANT SELECT, INSERT, UPDATE ON public.organizations, public.portfolios, public.projects, public.outcomes,
  public.stakeholder_groups, public.sroi_calculation_runs, public.sroi_run_reviews, public.proxy_sources,
  public.financial_proxies, public.financial_proxy_versions, public.outcome_proxy_assignments TO uellix_writer;
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

  // --- POS-SIZE-1: the full-portfolio aggregate is byte-identical regardless
  // of how the comparison view is paginated. Proven by computing the
  // aggregate exactly as lib/portfolios/analytics.ts's aggregatePortfolioSroi
  // does — Sum(net_social_value) / Sum(total_investment) over EVERY approved
  // member — and asserting it against the deterministic fixture value (2),
  // AND that the member count matches BULK_MEMBER_COUNT exactly (never a
  // page-truncated count).
  add(
    'POS-SIZE-1-full-portfolio-aggregate-covers-every-member-not-a-page',
    asUser(IDS.uIM_A) +
      `DO $p$ DECLARE member_count int; total_inv numeric; total_net numeric; ratio numeric; BEGIN
  SELECT count(*) INTO member_count FROM public.projects WHERE portfolio_id = '${IDS.portfolioBulk}';
  IF member_count <> ${BULK_MEMBER_COUNT} THEN RAISE EXCEPTION 'POS-SIZE-1 member_count=% expected=%', member_count, ${BULK_MEMBER_COUNT}; END IF;

  SELECT sum(r.total_investment), sum(r.net_social_value) INTO total_inv, total_net
    FROM public.sroi_calculation_runs r
    JOIN public.projects p ON p.id = r.project_id
   WHERE p.portfolio_id = '${IDS.portfolioBulk}'
     AND r.status = 'calculated'
     AND EXISTS (SELECT 1 FROM public.sroi_run_reviews v WHERE v.calculation_run_id = r.id AND v.organization_id = r.organization_id AND v.status = 'approved');

  ratio := total_net / total_inv;
  IF ratio <> 2 THEN RAISE EXCEPTION 'POS-SIZE-1 aggregate ratio=% expected=2 (Sum(net)/Sum(investment) over ALL % members)', ratio, member_count; END IF;
  IF total_inv <> (100 * ${BULK_MEMBER_COUNT}) THEN RAISE EXCEPTION 'POS-SIZE-1 total_investment=% expected=% — the aggregate must cover the WHOLE portfolio, not a 25-row page', total_inv, 100 * ${BULK_MEMBER_COUNT}; END IF;
END $p$;
ROLLBACK;`
  )

  // --- POS-SIZE-2: the chunked read is proven against REAL bind-parameter
  // expansion, not a mock. Two chunks (500 + 41) are queried with `= ANY(...)`
  // over real arrays of that exact size, and their combined result is proven
  // identical to the unchunked query — the same proof POS-SIZE-1 makes, but
  // this probe specifically exercises the ARRAY-of-500 and ARRAY-of-41 shapes
  // buildPortfolioProjectRunSummaries's chunkArray(..., 500) produces.
  add(
    'POS-SIZE-2-chunked-inArray-at-500-plus-remainder-matches-the-unchunked-total',
    asUser(IDS.uIM_A) +
      `DO $p$ DECLARE
  all_ids uuid[];
  chunk1 uuid[];
  chunk2 uuid[];
  unchunked_count int;
  chunked_count int;
BEGIN
  SELECT array_agg(id ORDER BY id) INTO all_ids FROM public.projects WHERE portfolio_id = '${IDS.portfolioBulk}';
  IF array_length(all_ids, 1) <> ${BULK_MEMBER_COUNT} THEN RAISE EXCEPTION 'POS-SIZE-2 fixture size=% expected=%', array_length(all_ids, 1), ${BULK_MEMBER_COUNT}; END IF;

  chunk1 := all_ids[1:${CHUNK_SIZE}];
  chunk2 := all_ids[${CHUNK_SIZE + 1}:${BULK_MEMBER_COUNT}];
  IF array_length(chunk1, 1) <> ${CHUNK_SIZE} THEN RAISE EXCEPTION 'POS-SIZE-2 chunk1 size=% expected=%', array_length(chunk1, 1), ${CHUNK_SIZE}; END IF;
  IF array_length(chunk2, 1) <> ${BULK_MEMBER_COUNT - CHUNK_SIZE} THEN RAISE EXCEPTION 'POS-SIZE-2 chunk2 size=% expected=%', array_length(chunk2, 1), ${BULK_MEMBER_COUNT - CHUNK_SIZE}; END IF;

  SELECT count(*) INTO unchunked_count FROM public.sroi_calculation_runs WHERE project_id = ANY(all_ids);
  SELECT
    (SELECT count(*) FROM public.sroi_calculation_runs WHERE project_id = ANY(chunk1)) +
    (SELECT count(*) FROM public.sroi_calculation_runs WHERE project_id = ANY(chunk2))
    INTO chunked_count;

  IF chunked_count <> unchunked_count THEN RAISE EXCEPTION 'POS-SIZE-2 chunked_count=% unchunked_count=% — two real bind-parameter arrays (500 + %) must together equal the unchunked read', chunked_count, unchunked_count, ${BULK_MEMBER_COUNT - CHUNK_SIZE}; END IF;
  IF chunked_count <> ${BULK_MEMBER_COUNT} THEN RAISE EXCEPTION 'POS-SIZE-2 chunked_count=% expected=%', chunked_count, ${BULK_MEMBER_COUNT}; END IF;
END $p$;
ROLLBACK;`
  )

  // --- MUT-PF3-TENANT-1: EH-5 reaches a GLOBALLY approved proxy version
  // (organization_id IS NULL) when bound through outcome_proxy_assignments —
  // and a predicate directly on financial_proxy_versions.organization_id
  // would silently drop it, proven by running BOTH forms against real rows.
  add(
    'MUT-PF3-TENANT-1-global-proxy-version-reachable-through-the-assignment-join',
    asUser(IDS.uIM_A) +
      `DO $p$ DECLARE correct_status text; mutated_count int; BEGIN
  -- CORRECT binding: through outcome_proxy_assignments (organization_id NOT
  -- NULL, project_id NOT NULL), then financial_proxy_versions.review_status
  -- with NO organization predicate on that row.
  SELECT fpv.review_status INTO correct_status
    FROM public.outcome_proxy_assignments opa
    JOIN public.financial_proxy_versions fpv ON fpv.id = opa.financial_proxy_version_id
   WHERE opa.organization_id = '${IDS.orgA}' AND opa.project_id = '${IDS.projProxy}' AND opa.assignment_status = 'active';
  IF correct_status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'MUT-PF3-TENANT-1 correct binding: expected approved, got %', correct_status; END IF;

  -- MUTATED binding: the same join, but with an added
  -- financial_proxy_versions.organization_id predicate — the exact mutation
  -- MUT-PF3-TENANT-1 forbids. The global version carries organization_id IS
  -- NULL, and NULL = '${IDS.orgA}' is never true, so this must return ZERO ROWS.
  SELECT count(*) INTO mutated_count
    FROM public.outcome_proxy_assignments opa
    JOIN public.financial_proxy_versions fpv ON fpv.id = opa.financial_proxy_version_id AND fpv.organization_id = '${IDS.orgA}'
   WHERE opa.organization_id = '${IDS.orgA}' AND opa.project_id = '${IDS.projProxy}' AND opa.assignment_status = 'active';
  IF mutated_count <> 0 THEN RAISE EXCEPTION 'MUT-PF3-TENANT-1 mutation did not bite: expected 0 rows under an organization_id predicate on financial_proxy_versions, got %', mutated_count; END IF;
END $p$;
ROLLBACK;`
  )

  // --- Cross-tenant isolation: an org-A read never sees org-B's portfolio,
  // project, or sentinel marker.
  add(
    'NEG-PF3-TENANT-1-org-B-portfolio-and-sentinel-project-invisible-from-org-A',
    asUser(IDS.uIM_A) +
      `DO $p$ DECLARE n int; found text; BEGIN
  SELECT count(*) INTO n FROM public.portfolios WHERE id = '${IDS.portfolioB1}';
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-PF3-TENANT-1 org B portfolio visible from org A (count=%)', n; END IF;
  SELECT count(*) INTO n FROM public.projects WHERE id = '${IDS.projB_sentinel}';
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-PF3-TENANT-1 sentinel project visible from org A (count=%)', n; END IF;
  SELECT string_agg(name, ',') INTO found FROM public.projects WHERE organization_id = '${IDS.orgA}' AND name = '${SENTINEL_MARKER}';
  IF found IS NOT NULL THEN RAISE EXCEPTION 'NEG-PF3-TENANT-1 sentinel marker leaked into an org-A-scoped read: %', found; END IF;
END $p$;
ROLLBACK;`
  )

  // --- A read issued with NO identity context set returns ZERO rows, never
  // an error — the failure direction db/client.ts and every PF3 module rely
  // on (SHARED_PAGE_SUCCESSION / TENANCY_CONTRACT.no_cross_tenant_leakage).
  add(
    'NEG-PF3-TENANT-2-a-read-with-no-open-identity-context-returns-zero-rows',
    `BEGIN; SET LOCAL ROLE uellix_app;
DO $p$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.projects WHERE portfolio_id = '${IDS.portfolioBulk}';
  IF n <> 0 THEN RAISE EXCEPTION 'NEG-PF3-TENANT-2 expected 0 rows with no identity context set, got %', n; END IF;
END $p$;
ROLLBACK;`
  )

  return { probes }
}

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)('Portfolio read model (PF3) — real PostgreSQL (canonical disposable harness)', { timeout: 1_200_000 }, () => {
  let outcome: HarnessOutcome

  beforeAll(() => {
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: buildSetupManifest(),
      probe: buildProbeManifest(),
    })
    console.log(`PF3_PG_OUTCOME=${JSON.stringify({
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
