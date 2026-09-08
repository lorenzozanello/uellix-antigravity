// tests/postgres/portfolio-aggregate.pg.test.ts
// PF1 (PORTFOLIO_PF1_EXECUTION_AUTHORITY_v1.0.0) — the portfolio aggregate's
// approved-run population, review tie-break, legacy exclusion, traceability
// and Σ/Σ arithmetic, against REAL PostgreSQL, through the CANONICAL
// disposable harness scripts/db-audit-disposable.ts: a throwaway postgres
// container on 127.0.0.1, ephemeral port, no bind mounts, teardown in
// `finally`, leftover check. Never staging, never production, never the
// canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). SKIPPED — never silently
// passed — otherwise.
//
// SELF-CONTAINED, by authority: the setup manifest is built here in code and
// the probe manifest is the COMMITTED template
// tests/postgres/portfolio-aggregate.probes.json. There is deliberately NO
// companion `-harness.ts` module (b3/b4/b5 each have one) and NO committed
// `*.setup.json`, because PF1's authorized write surface is exactly five paths
// and either would be a sixth. s1-founder-cardinality.pg.test.ts shows the
// same split-free pattern.
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. the cluster role topology mirrored from db/baseline/stella_g2_roles.sql;
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions);
//   4. EVERY db/hosted/baseline-manifest.ts unit, in manifest order;
//   5. the PF1 fixture — two organizations, three portfolios, seventeen
//      projects, eighteen calculation runs and twenty-one run reviews, built
//      so that every frozen exclusion reason and both prohibited review
//      orderings are exercised by real rows.
//
// READ THIS BEFORE CITING A GREEN RUN. The committed probes express the frozen
// PF1 selection rule as SQL views (`pf1_selected` / `pf1_classified`). That is
// a RE-EXPRESSION of the rule, not the application's own statement:
// lib/portfolios/analytics.ts reaches PostgreSQL through Drizzle and cannot be
// executed inside psql. A green run proves the RULE holds against real rows
// and real constraints; it does not prove the ORM emits character-identical
// SQL. The predicate-correspondence control below pins the two together
// statically, and tests/portfolios.analytics.service.test.ts renders the
// Drizzle query to real PostgreSQL text and asserts the same predicates.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import {
  runDisposableHarness,
  DEFAULT_IMAGE,
  parseProbeManifestContent,
  type HarnessOutcome,
  type ProbeManifest,
  type SetupManifest,
} from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(__dirname, '..', '..')
const PROBES_TEMPLATE = path.join(ROOT, 'tests', 'postgres', 'portfolio-aggregate.probes.json')

/**
 * Deterministic fixture ids (v4-shaped, fixed). The committed probe template
 * names the same values; the coverage control below asserts they agree, so a
 * drift between this fixture and the probes is a test failure rather than a
 * silently vacuous run.
 */
export const IDS = {
  ORG_A: 'a0f10000-0000-4000-8000-00000000000a',
  ORG_B: 'a0f10000-0000-4000-8000-00000000000b',
  USER_A: 'b0f10000-0000-4000-8000-00000000000a',
  USER_B: 'b0f10000-0000-4000-8000-00000000000b',
  PF_MAIN: 'c0f10000-0000-4000-8000-000000000001',
  PF_ALL_EXCLUDED: 'c0f10000-0000-4000-8000-000000000002',
  PF_OTHER_ORG: 'c0f10000-0000-4000-8000-000000000003',
  P01: 'd0f10000-0000-4000-8000-000000000001',
  P02: 'd0f10000-0000-4000-8000-000000000002',
  P03: 'd0f10000-0000-4000-8000-000000000003',
  P04: 'd0f10000-0000-4000-8000-000000000004',
  P05: 'd0f10000-0000-4000-8000-000000000005',
  P06: 'd0f10000-0000-4000-8000-000000000006',
  P07: 'd0f10000-0000-4000-8000-000000000007',
  P08: 'd0f10000-0000-4000-8000-000000000008',
  P09: 'd0f10000-0000-4000-8000-000000000009',
  P10: 'd0f10000-0000-4000-8000-000000000010',
  P11: 'd0f10000-0000-4000-8000-000000000011',
  P12: 'd0f10000-0000-4000-8000-000000000012',
  P13: 'd0f10000-0000-4000-8000-000000000013',
  P14: 'd0f10000-0000-4000-8000-000000000014',
  PX: 'd0f10000-0000-4000-8000-0000000000a1',
  PE1: 'd0f10000-0000-4000-8000-0000000000e1',
  PE2: 'd0f10000-0000-4000-8000-0000000000e2',
  R01: 'e0f10000-0000-4000-8000-000000000001',
  R02: 'e0f10000-0000-4000-8000-000000000002',
  R03A: 'e0f10000-0000-4000-8000-00000000031a',
  R03B: 'e0f10000-0000-4000-8000-00000000031b',
  R04A: 'e0f10000-0000-4000-8000-00000000041a',
  R04B: 'e0f10000-0000-4000-8000-00000000041b',
  R05: 'e0f10000-0000-4000-8000-000000000005',
  R06: 'e0f10000-0000-4000-8000-000000000006',
  R07: 'e0f10000-0000-4000-8000-000000000007',
  R08: 'e0f10000-0000-4000-8000-000000000008',
  R09: 'e0f10000-0000-4000-8000-000000000009',
  R10: 'e0f10000-0000-4000-8000-000000000010',
  R11: 'e0f10000-0000-4000-8000-000000000011',
  R12: 'e0f10000-0000-4000-8000-000000000012',
  R13: 'e0f10000-0000-4000-8000-000000000013',
  R14: 'e0f10000-0000-4000-8000-000000000014',
  RX: 'e0f10000-0000-4000-8000-0000000000a1',
  RE1: 'e0f10000-0000-4000-8000-0000000000e1',
  V01: 'f0f10000-0000-4000-8000-000000000001',
  V02_DRAFT: 'f0f10000-0000-4000-8000-00000000002d',
  V02_ARCHIVED: 'f0f10000-0000-4000-8000-00000000002a',
  V02_CROSS_ORG: 'f0f10000-0000-4000-8000-00000000002c',
  V03A: 'f0f10000-0000-4000-8000-00000000031a',
  V03B_DRAFT: 'f0f10000-0000-4000-8000-00000000031b',
  V04A: 'f0f10000-0000-4000-8000-00000000041a',
  V04B: 'f0f10000-0000-4000-8000-00000000041b',
  V05_A: 'f0f10000-0000-4000-8000-0000000005a1',
  V05_Z: 'f0f10000-0000-4000-8000-0000000005c2',
  V05_OLDEST: 'f0f10000-0000-4000-8000-0000000005ff',
  V06: 'f0f10000-0000-4000-8000-000000000006',
  V07: 'f0f10000-0000-4000-8000-000000000007',
  V08: 'f0f10000-0000-4000-8000-000000000008',
  V09: 'f0f10000-0000-4000-8000-000000000009',
  V10: 'f0f10000-0000-4000-8000-000000000010',
  V11: 'f0f10000-0000-4000-8000-000000000011',
  V12: 'f0f10000-0000-4000-8000-000000000012',
  V14: 'f0f10000-0000-4000-8000-000000000014',
  VX: 'f0f10000-0000-4000-8000-0000000000a1',
  VE1: 'f0f10000-0000-4000-8000-0000000000e1',
  REPORT_P01: 'a1f10000-0000-4000-8000-000000000001',
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
  CONSTRAINT stella_suggestion_decisions_prev_hash_check CHECK (((previous_value_hash IS NULL) OR (previous_value_hash ~ '^[0-9a-f]{64}$')))
);
`

/**
 * The PF1 world.
 *
 * Every project is designed to land on exactly one frozen outcome, and the
 * numbers are chosen so that a wrong implementation is observable
 * ARITHMETICALLY, not only by inspection:
 *
 *   included      P01, P03(v2), P04(v5), P05, P14  → Σinv 600, Σnet 2100, ratio 3.5
 *   average-of-ratios (the classic mistake)        → 3.2
 *   approval filtered AFTER selection (P03 → v3)   → 4 included, ratio 3.6
 *   legacy exclusion removed (P06, P07 join)       → Σinv 16600, Σnet 50100
 *
 * The two sentinels carry magnitudes that appear nowhere in the included
 * population, so their absence is arithmetic rather than a matter of
 * inspection: SENT-PF-UNAPPROVED-RUN is R02 (55555) together with R03B
 * (1000000), and SENT-PF-LEGACY-RUN is R06 (9000) together with R07 (7000).
 * PG-PF1-08 asserts that none of those four magnitudes reaches the aggregate.
 */
const PF1_FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.USER_A}', 'pf1-a@pgtest.local'),
  ('${IDS.USER_B}', 'pf1-b@pgtest.local')
  ON CONFLICT (id) DO NOTHING;

-- scripts/rehearsal/local-supabase-shim.sql mirrors auth.users into
-- public.users by trigger, so these rows already exist by the time this
-- statement runs. The insert is kept — and made idempotent — so the fixture
-- still states its own preconditions instead of depending on the shim, which
-- is the same shape tests/postgres/s1-founder-cardinality.pg.test.ts uses.
INSERT INTO public.users (id, email) VALUES
  ('${IDS.USER_A}', 'pf1-a@pgtest.local'),
  ('${IDS.USER_B}', 'pf1-b@pgtest.local')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('${IDS.ORG_A}', 'PF1 Organization A', 'pf1-org-a'),
  ('${IDS.ORG_B}', 'PF1 Organization B', 'pf1-org-b');

INSERT INTO public.portfolios (id, organization_id, name, created_by) VALUES
  ('${IDS.PF_MAIN}', '${IDS.ORG_A}', 'PF1 main portfolio', '${IDS.USER_A}'),
  ('${IDS.PF_ALL_EXCLUDED}', '${IDS.ORG_A}', 'PF1 all-excluded portfolio', '${IDS.USER_A}'),
  ('${IDS.PF_OTHER_ORG}', '${IDS.ORG_B}', 'PF1 other-organization portfolio', '${IDS.USER_B}');

INSERT INTO public.projects (id, organization_id, portfolio_id, name, governance_regime, created_by) VALUES
  ('${IDS.P01}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P01 approved and included', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P02}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P02 calculated but never approved', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P03}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P03 older approved beats newer unapproved', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P04}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P04 newest approved version wins', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P05}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P05 approved-review tie-break', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P06}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P06 legacy by NULL methodology version', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P07}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P07 legacy by governance regime', 'pre_pc01b', '${IDS.USER_A}'),
  ('${IDS.P08}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P08 non-USD', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P09}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P09 no SROI ratio', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P10}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P10 zero investment', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P11}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P11 negative investment', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P12}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P12 null investment', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P13}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P13 no calculated run', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.P14}', '${IDS.ORG_A}', '${IDS.PF_MAIN}', 'P14 twin of P01 without a report', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.PE1}', '${IDS.ORG_A}', '${IDS.PF_ALL_EXCLUDED}', 'PE1 legacy member of the all-excluded portfolio', 'pre_pc01b', '${IDS.USER_A}'),
  ('${IDS.PE2}', '${IDS.ORG_A}', '${IDS.PF_ALL_EXCLUDED}', 'PE2 runless member of the all-excluded portfolio', 'pc01b', '${IDS.USER_A}'),
  ('${IDS.PX}', '${IDS.ORG_B}', '${IDS.PF_OTHER_ORG}', 'SENT-PF-CROSS-ORG-PROJECT', 'pc01b', '${IDS.USER_B}');

INSERT INTO public.sroi_calculation_runs
  (id, project_id, organization_id, version, currency, total_investment, net_social_value, sroi_ratio, status, methodology_version, calculated_by, calculated_at) VALUES
  ('${IDS.R01}',  '${IDS.P01}', '${IDS.ORG_A}', 1, 'USD', 100,     300,  3,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R02}',  '${IDS.P02}', '${IDS.ORG_A}', 1, 'USD', 55555,   55555, 1,   'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R03A}', '${IDS.P03}', '${IDS.ORG_A}', 2, 'USD', 100,     300,  3,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-03-01T00:00:00Z'),
  ('${IDS.R03B}', '${IDS.P03}', '${IDS.ORG_A}', 3, 'USD', 1000000, 0,    0,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-06-01T00:00:00Z'),
  ('${IDS.R04A}', '${IDS.P04}', '${IDS.ORG_A}', 2, 'USD', 100,     100,  1,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-09-01T00:00:00Z'),
  ('${IDS.R04B}', '${IDS.P04}', '${IDS.ORG_A}', 5, 'USD', 200,     1000, 5,    'calculated', 'v2.0.0', '${IDS.USER_A}', '2026-02-01T00:00:00Z'),
  ('${IDS.R05}',  '${IDS.P05}', '${IDS.ORG_A}', 1, 'USD', 100,     200,  2,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R06}',  '${IDS.P06}', '${IDS.ORG_A}', 1, 'USD', 9000,    27000, 3,   'calculated', NULL,     '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R07}',  '${IDS.P07}', '${IDS.ORG_A}', 1, 'USD', 7000,    21000, 3,   'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R08}',  '${IDS.P08}', '${IDS.ORG_A}', 1, 'COP', 100,     300,  3,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R09}',  '${IDS.P09}', '${IDS.ORG_A}', 1, 'USD', 900,     0,    NULL, 'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R10}',  '${IDS.P10}', '${IDS.ORG_A}', 1, 'USD', 0,       500,  5,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R11}',  '${IDS.P11}', '${IDS.ORG_A}', 1, 'USD', -250,    500,  5,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R12}',  '${IDS.P12}', '${IDS.ORG_A}', 1, 'USD', NULL,    500,  5,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R13}',  '${IDS.P13}', '${IDS.ORG_A}', 1, 'USD', 100,     300,  3,    'pending',    'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.R14}',  '${IDS.P14}', '${IDS.ORG_A}', 1, 'USD', 100,     300,  3,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.RE1}',  '${IDS.PE1}', '${IDS.ORG_A}', 1, 'USD', 100,     300,  3,    'calculated', 'v1.0.0', '${IDS.USER_A}', '2026-01-10T00:00:00Z'),
  ('${IDS.RX}',   '${IDS.PX}',  '${IDS.ORG_B}', 1, 'USD', 777,     7770, 10,   'calculated', 'v1.0.0', '${IDS.USER_B}', '2026-01-10T00:00:00Z');

INSERT INTO public.sroi_run_reviews
  (id, organization_id, project_id, calculation_run_id, reviewer_id, status, readiness_score, reviewed_at, created_at, created_by) VALUES
  ('${IDS.V01}',          '${IDS.ORG_A}', '${IDS.P01}', '${IDS.R01}',  '${IDS.USER_A}', 'approved', 80,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V02_DRAFT}',    '${IDS.ORG_A}', '${IDS.P02}', '${IDS.R02}',  '${IDS.USER_A}', 'draft',    70,   NULL,                   '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V02_ARCHIVED}', '${IDS.ORG_A}', '${IDS.P02}', '${IDS.R02}',  '${IDS.USER_A}', 'archived', 65,   '2026-02-03T00:00:00Z', '2026-02-02T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V02_CROSS_ORG}','${IDS.ORG_B}', '${IDS.P02}', '${IDS.R02}',  '${IDS.USER_B}', 'approved', 55,   '2026-02-04T00:00:00Z', '2026-02-04T00:00:00Z', '${IDS.USER_B}'),
  ('${IDS.V03A}',         '${IDS.ORG_A}', '${IDS.P03}', '${IDS.R03A}', '${IDS.USER_A}', 'approved', 40,   '2026-03-02T00:00:00Z', '2026-03-02T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V03B_DRAFT}',   '${IDS.ORG_A}', '${IDS.P03}', '${IDS.R03B}', '${IDS.USER_A}', 'draft',    90,   NULL,                   '2026-06-02T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V04A}',         '${IDS.ORG_A}', '${IDS.P04}', '${IDS.R04A}', '${IDS.USER_A}', 'approved', 10,   '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V04B}',         '${IDS.ORG_A}', '${IDS.P04}', '${IDS.R04B}', '${IDS.USER_A}', 'approved', 60,   '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V05_OLDEST}',   '${IDS.ORG_A}', '${IDS.P05}', '${IDS.R05}',  '${IDS.USER_A}', 'approved', 99,   NULL,                   '2026-01-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V05_A}',        '${IDS.ORG_A}', '${IDS.P05}', '${IDS.R05}',  '${IDS.USER_A}', 'approved', 10,   '2026-09-09T00:00:00Z', '2026-05-05T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V05_Z}',        '${IDS.ORG_A}', '${IDS.P05}', '${IDS.R05}',  '${IDS.USER_A}', 'approved', 20,   '2026-08-08T00:00:00Z', '2026-05-05T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V06}',          '${IDS.ORG_A}', '${IDS.P06}', '${IDS.R06}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V07}',          '${IDS.ORG_A}', '${IDS.P07}', '${IDS.R07}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V08}',          '${IDS.ORG_A}', '${IDS.P08}', '${IDS.R08}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V09}',          '${IDS.ORG_A}', '${IDS.P09}', '${IDS.R09}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V10}',          '${IDS.ORG_A}', '${IDS.P10}', '${IDS.R10}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V11}',          '${IDS.ORG_A}', '${IDS.P11}', '${IDS.R11}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V12}',          '${IDS.ORG_A}', '${IDS.P12}', '${IDS.R12}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.V14}',          '${IDS.ORG_A}', '${IDS.P14}', '${IDS.R14}',  '${IDS.USER_A}', 'approved', NULL, '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.VE1}',          '${IDS.ORG_A}', '${IDS.PE1}', '${IDS.RE1}',  '${IDS.USER_A}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_A}'),
  ('${IDS.VX}',           '${IDS.ORG_B}', '${IDS.PX}',  '${IDS.RX}',   '${IDS.USER_B}', 'approved', 50,   '2026-02-02T00:00:00Z', '2026-02-01T00:00:00Z', '${IDS.USER_B}');

INSERT INTO public.sroi_reports
  (id, organization_id, project_id, calculation_run_id, title, status, created_by, locked_by, locked_at) VALUES
  ('${IDS.REPORT_P01}', '${IDS.ORG_A}', '${IDS.P01}', '${IDS.R01}', 'P01 locked report', 'locked', '${IDS.USER_A}', '${IDS.USER_A}', '2026-02-05T00:00:00Z');
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
  statements.push(PF1_FIXTURE)
  return { statements }
}

/** The COMMITTED probe template — the SQL assertions live in the diff, not only at runtime. */
export function loadProbes(): ProbeManifest {
  return parseProbeManifestContent(readFileSync(PROBES_TEMPLATE, 'utf8'), true)
}

const PROBE_MANIFEST = loadProbes()
const PROBE_IDS = PROBE_MANIFEST.probes.map((p) => p.id)

/**
 * The frozen matrix of POSTGRES_CONTRACT.frozen_matrix. It is a FLOOR: extra
 * rows are permitted, dropping or weakening one is not.
 */
const FROZEN_MATRIX_IDS = [
  'PG-PF1-01',
  'PG-PF1-02',
  'PG-PF1-03',
  'PG-PF1-04',
  'PG-PF1-05',
  'PG-PF1-06',
  'PG-PF1-07',
  'PG-PF1-08',
  'PG-PF1-09',
  'PG-PF1-10',
  'PG-PF1-11',
  'PG-PF1-12',
  'PG-PF1-13',
  'PG-PF1-14',
] as const

// ── Controls that need no database ────────────────────────────────────────────

describe('PF1 real-PostgreSQL contract (no database required)', () => {
  it('covers every row of the frozen matrix', () => {
    for (const id of FROZEN_MATRIX_IDS) {
      expect(PROBE_IDS.some((probe) => probe.startsWith(`${id}-`)), `frozen matrix row ${id} has no probe`).toBe(true)
    }
  })

  it('declares probe ids that are unique and non-empty', () => {
    expect(new Set(PROBE_IDS).size).toBe(PROBE_IDS.length)
    for (const probe of PROBE_MANIFEST.probes) {
      expect(probe.id.length).toBeGreaterThan(0)
      expect(probe.sql.trim().length).toBeGreaterThan(0)
    }
  })

  it('names the same fixture ids the setup inserts, so a drift makes the probes fail instead of passing vacuously', () => {
    const probeText = PROBE_MANIFEST.probes.map((p) => p.sql).join('\n')
    // Every id the probes assert against must be one this fixture actually writes.
    const referenced = new Set(probeText.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ?? [])
    const known = new Set<string>(Object.values(IDS))
    expect(referenced.size).toBeGreaterThan(10)
    for (const id of referenced) expect(known.has(id), `probe references unknown fixture id ${id}`).toBe(true)
    // And the discriminating ids must be exercised.
    for (const id of [IDS.PF_MAIN, IDS.PF_ALL_EXCLUDED, IDS.R03A, IDS.R03B, IDS.R04B, IDS.V05_Z, IDS.V05_OLDEST, IDS.PX]) {
      expect(referenced.has(id), `the fixture id ${id} is never asserted against`).toBe(true)
    }
  })

  it('the setup applies the whole baseline before the fixture, and adds no baseline unit of its own', () => {
    const setup = buildSetupManifest()
    const fixtureAt = setup.statements.findIndex((s) => s.includes('SENT-PF-CROSS-ORG-PROJECT'))
    expect(fixtureAt).toBe(setup.statements.length - 1)
    expect(setup.statements.filter((s) => s.startsWith('-- BASELINE UNIT ')).length).toBe(BASELINE_UNITS.length)
  })

  // The probe SQL is a re-expression of the frozen rule; this pins it to the
  // application's own predicates so the two cannot drift apart silently.
  it('the committed probe SQL carries the same predicates as lib/portfolios/analytics.ts', () => {
    const canonical = PROBE_MANIFEST.probes[0]
    expect(canonical.id).toBe('PG-PF1-00-canonical-approved-selection-views')
    const sql = canonical.sql
    for (const predicate of [
      "r.status = 'calculated'",
      "v.status = 'approved'",
      'v.calculation_run_id = r.id',
      'v.organization_id = r.organization_id',
      'a.version DESC',
      'v.created_at DESC, v.id DESC',
      "x.governance_regime = 'pre_pc01b'",
      'x.methodology_version IS NULL',
      'x.sroi_ratio IS NULL',
      'x.total_investment <= 0',
    ]) {
      expect(sql, `the canonical probe lost the predicate ${predicate}`).toContain(predicate)
    }
    // The six frozen reasons, and nothing else, are what the probe classifies to.
    const emitted = sql.slice(sql.indexOf('CREATE VIEW pf1_classified')).match(/THEN '([a-z_]+)'/g) ?? []
    expect(emitted.map((m) => m.replace(/^THEN '/, '').replace(/'$/, ''))).toEqual([
      'no_run',
      'no_approved_run',
      'no_run',
      'legacy_non_authoritative',
      'non_usd_currency',
      'no_sroi_ratio',
      'zero_or_invalid_investment',
    ])
  })
})

// ── The real-PostgreSQL run ───────────────────────────────────────────────────

describe.skipIf(!PG_TESTS_ENABLED)('PF1 portfolio aggregate — real PostgreSQL (canonical disposable harness)', { timeout: 1_800_000 }, () => {
  let outcome: HarnessOutcome

  beforeAll(() => {
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: buildSetupManifest(),
      probe: PROBE_MANIFEST,
    })
    // Machine-readable summary for the implementation evidence artefact.
    console.log(`PF1_PG_OUTCOME=${JSON.stringify({
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
  }, 1_800_000)

  it(`provisioned the full baseline (${BASELINE_UNITS.length} units) and tore itself down with zero leftovers`, () => {
    expect(outcome.failureReason).toBeNull()
    expect(outcome.setupStatus).toBe('SUCCESS')
    expect(outcome.teardownStatus).toBe('SUCCESS')
    expect(outcome.leftoverDatabaseCount).toBe(0)
    expect(outcome.lifecycleState).toBe('VERIFIED_GONE')
    expect(outcome.targetLocality).toBe('LOCAL')
  })

  it('ran every committed probe, in the declared order', () => {
    expect(outcome.probeResults.map((p) => p.id)).toEqual(PROBE_IDS)
  })

  it.each(PROBE_IDS)('%s', (id) => {
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
