// tests/postgres/s1-founder-cardinality.pg.test.ts
// Multi-org S1 — founder traceability, REAL PostgreSQL controls
// (PG-S1-1..5, PG-6, T-S1-BACKFILL-1/2/3, T-S1-WALL-1, S1-2, S1-4, S1-5,
// N-9, M-5 sentinel, MUT-PG-1..6), run through the CANONICAL disposable
// harness scripts/db-audit-disposable.ts: a throwaway postgres container on
// 127.0.0.1, ephemeral port, no bind mounts, teardown in `finally`, leftover
// check. Never staging, never production, never the canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise.
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. cluster role topology mirrored from db/baseline/stella_g2_roles.sql;
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions);
//   4. EVERY db/hosted/baseline-manifest.ts unit BEFORE the S1 unit, in
//      manifest order — the S1 unit's position is DERIVED from the manifest;
//   5. the HISTORICAL fixture: six organizations that exist BEFORE S1 lands,
//      with the audit_logs rows that make each one a distinct MO-11 case
//      (exactly one qualifying row with an actor; zero rows; two rows; one row
//      with a NULL actor; SENTINEL_FOUNDER_NULL_ORG whose only signal is
//      invited_by IS NULL; a non-qualifying action);
//   6. the S1 unit itself — so the backfill runs against real historical rows;
//   7. hosted-fidelity block: auth.uid() with the HOSTED semantics, public.*
//      OWNER TO uellix_owner, runtime reachability grants, plus the
//      organizations table ACL floor for uellix_writer so that the ordinary-
//      user negative control below fails at the RLS wall and NOT at the ACL —
//      the two share SQLSTATE 42501 and only the message tells them apart.
//
// READ THIS BEFORE CITING A GREEN RUN: the hosted-fidelity block is a MODEL of
// the hosted posture, not a measurement of it — see
// tests/postgres/b3-completeness-harness.ts's identical disclosure.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { splitSqlStatements, stripSqlComments } from '@/db/hosted/baseline-scanner'
import { runDisposableHarness, DEFAULT_IMAGE, type HarnessOutcome, type SetupManifest, type ProbeManifest } from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(__dirname, '..', '..')

/** The S1 unit, DERIVED from the live manifest — never named by ordinal. */
const S1_UNIT = BASELINE_UNITS.find((u) => /^\d{4}_multiorg_s1_founder_traceability\.sql$/.test(u.id))
if (!S1_UNIT) throw new Error('the S1 founder-traceability baseline unit is not registered in db/hosted/baseline-manifest.ts')
const S1_INDEX = BASELINE_UNITS.indexOf(S1_UNIT)
const S1_SQL = readFileSync(path.join(ROOT, S1_UNIT.file), 'utf8')
/** The exact backfill statement, taken from the migration bytes for the repeatability probe. */
const BACKFILL_STATEMENT = splitSqlStatements(stripSqlComments(S1_SQL.split('\r\n').join('\n'))).find((s) => /^UPDATE\b/i.test(s))
if (!BACKFILL_STATEMENT) throw new Error('the S1 migration carries no top-level UPDATE backfill')

/** Deterministic fixture ids (v4-shaped, fixed). */
export const IDS = {
  // users
  uF1: '0a200000-0000-4000-8000-0000000000f1', // sole qualifying actor for H1; one of two for H2
  uF2: '0a200000-0000-4000-8000-0000000000f2', // second actor for H2; sole member (invited_by NULL) of HS
  uX: '0a200000-0000-4000-8000-00000000000a', // self-service subject for the cardinality probes
  uOrd: '0a200000-0000-4000-8000-00000000000b', // ordinary authenticated subject, no membership, not super admin
  uSA: '0a200000-0000-4000-8000-00000000000c', // platform super admin
  uC: '0a200000-0000-4000-8000-00000000000d', // concurrency subject
  uP: '0a200000-0000-4000-8000-00000000000e', // platform-provenance subject with no membership (N-9)
  uZ: '0a200000-0000-4000-8000-00000000000f', // referenced ONLY through founded_by (PG-S1-4 / MUT-PG-3), created inside the probe
  // historical organizations (exist BEFORE the S1 unit)
  H1: '1a200000-0000-4000-8000-0000000000a1', // exactly one organization.created row, non-null actor uF1 -> founded_by uF1
  H0: '1a200000-0000-4000-8000-0000000000a0', // zero rows -> NULL
  H2: '1a200000-0000-4000-8000-0000000000a2', // two rows (uF1, uF2) -> NULL
  HN: '1a200000-0000-4000-8000-0000000000a3', // one row with NULL actor -> NULL
  HS: '1a200000-0000-4000-8000-0000000000a4', // SENTINEL_FOUNDER_NULL_ORG: only signal is invited_by IS NULL -> NULL
  HU: '1a200000-0000-4000-8000-0000000000a5', // one row, action organization.updated (non-qualifying) -> NULL
} as const

const HISTORICAL_ORG_COUNT = 6
const EXPECTED_ATTRIBUTED = 1
const EXPECTED_LEFT_NULL = HISTORICAL_ORG_COUNT - EXPECTED_ATTRIBUTED

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
 * The HISTORICAL world S1's backfill runs against. Applied BEFORE the S1 unit,
 * so founded_by / founding_provenance do not exist yet — exactly the state of
 * every real organization row the day the migration lands.
 */
const HISTORICAL_FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.uF1}','uf1-s1@pg.local'),('${IDS.uF2}','uf2-s1@pg.local'),('${IDS.uX}','ux-s1@pg.local'),
  ('${IDS.uOrd}','uord-s1@pg.local'),('${IDS.uSA}','usa-s1@pg.local'),('${IDS.uC}','uc-s1@pg.local'),('${IDS.uP}','up-s1@pg.local')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.uF1}','uf1-s1@pg.local',false),('${IDS.uF2}','uf2-s1@pg.local',false),('${IDS.uX}','ux-s1@pg.local',false),
  ('${IDS.uOrd}','uord-s1@pg.local',false),('${IDS.uSA}','usa-s1@pg.local',true),('${IDS.uC}','uc-s1@pg.local',false),('${IDS.uP}','up-s1@pg.local',false)
  ON CONFLICT (id) DO NOTHING;
-- The local shim mirrors auth.users into public.users by trigger with the
-- column default (false), so the ON CONFLICT above leaves is_super_admin
-- untouched; the platform admin flag is set explicitly and measured below.
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.uSA}';
INSERT INTO public.organizations (id, name, slug) VALUES
  ('${IDS.H1}','S1 Historical H1 (one qualifying row)','s1-h1'),
  ('${IDS.H0}','S1 Historical H0 (zero rows)','s1-h0'),
  ('${IDS.H2}','S1 Historical H2 (two rows)','s1-h2'),
  ('${IDS.HN}','S1 Historical HN (null actor)','s1-hn'),
  ('${IDS.HS}','S1 Historical HS (sentinel invited_by null)','s1-hs'),
  ('${IDS.HU}','S1 Historical HU (non-qualifying action)','s1-hu');
-- H1: the founder is uF1 and also holds the admin membership; HS: uF2 is the
-- sole member with invited_by NULL and NO audit row — the M-5 sentinel.
INSERT INTO public.organization_members (organization_id, user_id, role, status, invited_by, joined_at) VALUES
  ('${IDS.H1}','${IDS.uF1}','organization_admin','active',NULL,now() - interval '30 days'),
  ('${IDS.HS}','${IDS.uF2}','organization_admin','active',NULL,now() - interval '40 days');
-- The deterministic source: audit_logs rows recording (or not) the founding ACT.
INSERT INTO public.audit_logs (organization_id, actor_user_id, entity_type, entity_id, action, after_json) VALUES
  ('${IDS.H1}','${IDS.uF1}','organization','${IDS.H1}','organization.created','{"fixture":"H1"}'),
  ('${IDS.H2}','${IDS.uF1}','organization','${IDS.H2}','organization.created','{"fixture":"H2-a"}'),
  ('${IDS.H2}','${IDS.uF2}','organization','${IDS.H2}','organization.created','{"fixture":"H2-b"}'),
  ('${IDS.HN}',NULL,'organization','${IDS.HN}','organization.created','{"fixture":"HN"}'),
  ('${IDS.HU}','${IDS.uF1}','organization','${IDS.HU}','organization.updated','{"fixture":"HU"}');
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
-- (4) The organizations ACL floor for the runtime writer role. This is what
-- makes the ordinary-user negative control a test of the RLS WALL rather than
-- of a missing table grant: both refuse with 42501, only the message differs,
-- and the probe asserts the message.
GRANT SELECT, INSERT ON public.organizations TO uellix_writer;
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
  for (const unit of BASELINE_UNITS.slice(0, S1_INDEX)) statements.push(unitStatement(unit))
  statements.push(HISTORICAL_FIXTURE)
  statements.push(unitStatement(S1_UNIT!))
  for (const unit of BASELINE_UNITS.slice(S1_INDEX + 1)) statements.push(unitStatement(unit))
  statements.push(HOSTED_FIDELITY)
  return { statements }
}

const asUser = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

const expectFoundedBy = (label: string, org: string, expected: string | null) =>
  `DO $b$ DECLARE v text; BEGIN
  SELECT founded_by::text INTO v FROM public.organizations WHERE id = '${org}';
  IF v IS DISTINCT FROM ${expected === null ? 'NULL' : `'${expected}'`} THEN RAISE EXCEPTION '${label} founded_by=% expected=${expected ?? 'NULL'}', coalesce(v, 'NULL'); END IF;
  SELECT founding_provenance INTO v FROM public.organizations WHERE id = '${org}';
  IF v IS DISTINCT FROM 'unknown' THEN RAISE EXCEPTION '${label} founding_provenance=% expected=unknown', v; END IF;
END $b$;\n`

export function buildProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  // --- schema --------------------------------------------------------------
  add('S1-SCHEMA-1-columns-founded_by-nullable-uuid-provenance-default-unknown', `DO $s$ DECLARE r record; BEGIN
  SELECT data_type, is_nullable, column_default INTO r FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='founded_by';
  IF r IS NULL OR r.data_type <> 'uuid' OR r.is_nullable <> 'YES' OR r.column_default IS NOT NULL THEN RAISE EXCEPTION 'S1-SCHEMA-1 founded_by measured=% expected uuid NULL no-default', r; END IF;
  SELECT data_type, is_nullable, column_default INTO r FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='founding_provenance';
  IF r IS NULL OR r.data_type <> 'character varying' OR r.is_nullable <> 'NO' OR r.column_default NOT LIKE '''unknown''%' THEN RAISE EXCEPTION 'S1-SCHEMA-1 founding_provenance measured=% expected varchar NOT NULL DEFAULT unknown', r; END IF;
END $s$;`)

  add('S1-SCHEMA-2-fk-founded_by-references-users-on-delete-restrict', `DO $s$ DECLARE r record; BEGIN
  SELECT c.confdeltype, c.confrelid::regclass::text AS target, c.contype INTO r FROM pg_constraint c WHERE c.conname = 'organizations_founded_by_users_id_fk';
  IF r IS NULL OR r.contype <> 'f' OR r.target <> 'users' OR r.confdeltype <> 'r' THEN RAISE EXCEPTION 'S1-SCHEMA-2 measured=% expected FK -> users ON DELETE RESTRICT (confdeltype r)', r; END IF;
END $s$;`)

  add('S1-SCHEMA-3-partial-unique-carrier-predicates-on-self_service-provenance', `DO $s$ DECLARE d text; BEGIN
  SELECT indexdef INTO d FROM pg_indexes WHERE schemaname='public' AND tablename='organizations' AND indexname='organizations_self_service_founder_unique';
  IF d IS NULL THEN RAISE EXCEPTION 'S1-SCHEMA-3 carrier index missing'; END IF;
  IF d !~ 'CREATE UNIQUE INDEX' OR d !~ '\\(founded_by\\)' OR d !~ 'founded_by IS NOT NULL' OR d !~ 'founding_provenance' OR d !~ 'self_service' THEN RAISE EXCEPTION 'S1-SCHEMA-3 carrier is not the discriminating partial unique index: %', d; END IF;
  -- Direction two: NO global uniqueness on founded_by exists anywhere.
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='organizations' AND indexdef ~ 'UNIQUE' AND indexdef ~ 'founded_by' AND indexdef !~ 'founding_provenance') THEN RAISE EXCEPTION 'S1-SCHEMA-3 a NAIVE global unique index on founded_by exists'; END IF;
END $s$;`)

  add('S1-SCHEMA-4-check-constraints-provenance-domain-and-self_service-requires-founder', `DO $s$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_constraint WHERE conrelid='public.organizations'::regclass AND contype='c' AND conname IN ('organizations_founding_provenance_check','organizations_self_service_requires_founder_check');
  IF n <> 2 THEN RAISE EXCEPTION 'S1-SCHEMA-4 CHECK constraints measured=% expected=2', n; END IF;
END $s$;`)

  add('S1-SCHEMA-5-DROP_LAST-user_single_active_membership-still-present', `DO $s$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='organization_members' AND indexname='user_single_active_membership' AND indexdef ~ 'UNIQUE') THEN RAISE EXCEPTION 'S1-SCHEMA-5 user_single_active_membership was dropped or altered — DROP_LAST violated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='organization_members_org_user_unique') THEN RAISE EXCEPTION 'S1-SCHEMA-5 organization_members_org_user_unique missing'; END IF;
END $s$;`)

  // --- backfill (T-S1-BACKFILL-1/2/3, PG-S1-3, M-5) --------------------------
  add('S1-BACKFILL-1-exactly-one-qualifying-row-non-null-actor-attributes', expectFoundedBy('S1-BACKFILL-1', IDS.H1, IDS.uF1))
  add('S1-BACKFILL-2a-zero-qualifying-rows-stays-NULL', expectFoundedBy('S1-BACKFILL-2a', IDS.H0, null))
  add('S1-BACKFILL-2b-more-than-one-qualifying-row-stays-NULL', expectFoundedBy('S1-BACKFILL-2b', IDS.H2, null))
  add('S1-BACKFILL-2c-qualifying-row-with-NULL-actor-stays-NULL', expectFoundedBy('S1-BACKFILL-2c', IDS.HN, null))
  add('S1-BACKFILL-2d-SENTINEL_FOUNDER_NULL_ORG-invited_by-NULL-is-not-a-founder-signal', expectFoundedBy('S1-BACKFILL-2d', IDS.HS, null))
  add('S1-BACKFILL-2e-non-qualifying-action-stays-NULL', expectFoundedBy('S1-BACKFILL-2e', IDS.HU, null))

  add('S1-BACKFILL-3-founding_provenance-unknown-for-EVERY-historical-row', `DO $p$ DECLARE n int; t int; BEGIN
  SELECT count(*) INTO t FROM public.organizations;
  IF t <> ${HISTORICAL_ORG_COUNT} THEN RAISE EXCEPTION 'S1-BACKFILL-3 historical row count=% expected=${HISTORICAL_ORG_COUNT}', t; END IF;
  SELECT count(*) INTO n FROM public.organizations WHERE founding_provenance IS DISTINCT FROM 'unknown';
  IF n <> 0 THEN RAISE EXCEPTION 'S1-BACKFILL-3 % historical row(s) carry a provenance other than unknown — historical self_service was inferred', n; END IF;
END $p$;`)

  add('S1-BACKFILL-4-PG-S1-3-attributed-and-left-NULL-counts-recomputable-from-the-same-inputs', `DO $c$ DECLARE attributed int; left_null int; recomputed int; mismatched int; BEGIN
  SELECT count(*) INTO attributed FROM public.organizations WHERE founded_by IS NOT NULL;
  SELECT count(*) INTO left_null FROM public.organizations WHERE founded_by IS NULL;
  IF attributed <> ${EXPECTED_ATTRIBUTED} OR left_null <> ${EXPECTED_LEFT_NULL} THEN RAISE EXCEPTION 'S1-BACKFILL-4 attributed=% left_null=% expected ${EXPECTED_ATTRIBUTED}/${EXPECTED_LEFT_NULL}', attributed, left_null; END IF;
  -- Independent formulation (correlated EXISTS, no GROUP BY, no aggregate over
  -- uuid): the organizations for which EXACTLY ONE qualifying row exists and
  -- that row's actor is non-null.
  SELECT count(*) INTO recomputed FROM public.organizations o
   WHERE (SELECT count(*) FROM public.audit_logs a WHERE a.entity_type='organization' AND a.action='organization.created' AND a.entity_id=o.id) = 1
     AND EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.entity_type='organization' AND a.action='organization.created' AND a.entity_id=o.id AND a.actor_user_id IS NOT NULL);
  IF recomputed <> attributed THEN RAISE EXCEPTION 'S1-BACKFILL-4 recomputed=% attributed=% — the backfill is not reproducible from its inputs', recomputed, attributed; END IF;
  -- And every attributed value equals THE sole qualifying row's actor (never a
  -- first/earliest pick among several, never a value from elsewhere).
  SELECT count(*) INTO mismatched FROM public.organizations o
   WHERE o.founded_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.audit_logs a
        WHERE a.entity_type='organization' AND a.action='organization.created' AND a.entity_id=o.id
          AND a.actor_user_id = o.founded_by
          AND (SELECT count(*) FROM public.audit_logs b WHERE b.entity_type='organization' AND b.action='organization.created' AND b.entity_id=o.id) = 1);
  IF mismatched <> 0 THEN RAISE EXCEPTION 'S1-BACKFILL-4 % attribution(s) do not equal the sole qualifying actor', mismatched; END IF;
END $c$;`)

  add('S1-BACKFILL-5-re-running-the-backfill-converges-to-zero-rows', `BEGIN;
DO $r$ DECLARE n int; BEGIN
  ${BACKFILL_STATEMENT!.replace(/;\s*$/, '')};
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'S1-BACKFILL-5 second application changed % row(s), expected 0', n; END IF;
END $r$;
${expectFoundedBy('S1-BACKFILL-5', IDS.H1, IDS.uF1)}
ROLLBACK;`)

  add('S1-REAPPLY-destructive-on-reapply-ADD-COLUMN-refuses-42701', `BEGIN;
DO $a$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    ALTER TABLE "organizations" ADD COLUMN "founded_by" uuid;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42701' THEN RAISE EXCEPTION 'S1-REAPPLY caught=% expected=42701 (duplicate column)', caught; END IF;
END $a$;
ROLLBACK;`)

  // --- cardinality carrier (PG-S1-1, PG-S1-2 / S1-2, S1-5, PG-6) -------------
  add('PG-S1-2-platform-provenance-does-NOT-consume-the-self-service-slot-then-PG-S1-1-second-self-service-founding-refused-23505', `BEGIN;
DO $k$ DECLARE caught text := 'none'; msg text := ''; n int; BEGIN
  -- A platform-created organization honestly recording uX as its deterministic
  -- provenance: under the NAIVE index this would consume uX's one slot.
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Platform for X','s1-platform-x','${IDS.uX}','platform');
  -- uX may STILL self-service-found exactly one organization.
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Self-service X','s1-self-x','${IDS.uX}','self_service');
  -- A SECOND self-service founding by the same subject fails closed at the database boundary.
  BEGIN
    INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Self-service X again','s1-self-x-2','${IDS.uX}','self_service');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'PG-S1-1 caught=% expected=23505 (%)', caught, msg; END IF;
  IF msg !~ 'organizations_self_service_founder_unique' THEN RAISE EXCEPTION 'PG-S1-1 refused by the wrong object: %', msg; END IF;
  SELECT count(*) INTO n FROM public.organizations WHERE founded_by='${IDS.uX}';
  IF n <> 2 THEN RAISE EXCEPTION 'PG-S1-2 expected exactly 2 organizations naming uX (1 platform + 1 self_service), measured=%', n; END IF;
  -- A second PLATFORM organization naming the same subject is also permitted: the carrier binds the self-service ACT only.
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Platform for X again','s1-platform-x-2','${IDS.uX}','platform');
END $k$;
ROLLBACK;`)

  add('S1-5-NULL-founded_by-rows-coexist-with-the-carrier', `BEGIN;
DO $n$ DECLARE c int; BEGIN
  INSERT INTO public.organizations (name, slug) VALUES ('Null founder A','s1-null-a'),('Null founder B','s1-null-b');
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Null founder C','s1-null-c',NULL,'unknown');
  SELECT count(*) INTO c FROM public.organizations WHERE founded_by IS NULL;
  IF c <> ${EXPECTED_LEFT_NULL + 3} THEN RAISE EXCEPTION 'S1-5 NULL founded_by rows measured=% expected=${EXPECTED_LEFT_NULL + 3}', c; END IF;
END $n$;
ROLLBACK;`)

  // A user referenced ONLY through founded_by — no membership, no audit row —
  // so the refusal can come from nothing but the S1 FK, and the message must
  // name it. Using a founder that also holds a membership would be vacuous:
  // organization_members.user_id would refuse first with the same SQLSTATE.
  add('PG-S1-4-ON-DELETE-RESTRICT-deleting-a-user-referenced-only-by-founded_by-refused-23503', `BEGIN;
INSERT INTO auth.users (id, email) VALUES ('${IDS.uZ}','uz-s1@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email) VALUES ('${IDS.uZ}','uz-s1@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Founded by Z','s1-founded-z','${IDS.uZ}','platform');
DO $f$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    DELETE FROM public.users WHERE id='${IDS.uZ}';
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23503' THEN RAISE EXCEPTION 'PG-S1-4 caught=% expected=23503 (%)', caught, msg; END IF;
  IF msg !~ 'organizations_founded_by_users_id_fk' THEN RAISE EXCEPTION 'PG-S1-4 refused by a different FK, not founded_by: %', msg; END IF;
END $f$;
ROLLBACK;`)

  add('S1-PROVENANCE-1-domain-CHECK-refuses-a-value-outside-self_service-platform-unknown-23514', `BEGIN;
DO $d$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Bogus','s1-bogus','${IDS.uX}','invented');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '23514' THEN RAISE EXCEPTION 'S1-PROVENANCE-1 caught=% expected=23514', caught; END IF;
END $d$;
ROLLBACK;`)

  add('S1-PROVENANCE-2-self_service-without-a-founder-refused-23514', `BEGIN;
DO $d$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Orphan self-service','s1-orphan',NULL,'self_service');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '23514' THEN RAISE EXCEPTION 'S1-PROVENANCE-2 caught=% expected=23514', caught; END IF;
END $d$;
ROLLBACK;`)

  // --- the pre-existing bootstrap/RLS wall (T-S1-WALL-1) -----------------------
  // PROVES THE PRE-EXISTING RLS/BOOTSTRAP WALL, NOT S1's NEW CONSTRAINTS. An
  // ordinary authenticated subject supplies VALID S1 values (its own id as
  // founder, self_service provenance) so that neither 23502 nor 23503 can
  // fire first; the refusal MUST be the RLS policy class, and the message
  // MUST name row-level security (a missing table grant is also 42501).
  add('T-S1-WALL-1-ordinary-user-INSERT-refused-by-the-PRE-EXISTING-RLS-wall-42501-not-23502-not-23503',
    asUser(IDS.uOrd) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  -- The claims must be EFFECTIVE, or a refusal would prove nothing about this subject.
  IF auth.uid() IS DISTINCT FROM '${IDS.uOrd}'::uuid THEN RAISE EXCEPTION 'T-S1-WALL-1 claims not effective: auth.uid()=%', auth.uid(); END IF;
  IF public.current_user_is_super_admin() THEN RAISE EXCEPTION 'T-S1-WALL-1 fixture defect: the ordinary subject is a super admin'; END IF;
  BEGIN
    INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Wall Org','s1-wall-org','${IDS.uOrd}','self_service');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught IN ('23502','23503') THEN RAISE EXCEPTION 'T-S1-WALL-1 VACUOUS: failed at an S1 constraint (%: %) instead of the RLS wall', caught, msg; END IF;
  IF caught <> '42501' THEN RAISE EXCEPTION 'T-S1-WALL-1 caught=% expected=42501 (%)', caught, msg; END IF;
  IF msg !~ 'row-level security' THEN RAISE EXCEPTION 'T-S1-WALL-1 42501 but not the RLS policy wall (a table grant, not the policy): %', msg; END IF;
END $w$;
ROLLBACK;`)

  add('T-S1-WALL-2-platform-super-admin-INSERT-still-permitted-by-orgs_insert_super_admin',
    asUser(IDS.uSA) + `DO $w$ DECLARE n int; BEGIN
  IF auth.uid() IS DISTINCT FROM '${IDS.uSA}'::uuid THEN RAISE EXCEPTION 'T-S1-WALL-2 claims not effective: auth.uid()=%', auth.uid(); END IF;
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'T-S1-WALL-2 fixture defect: uSA is not a super admin'; END IF;
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Admin-created','s1-admin-org','${IDS.uP}','platform');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T-S1-WALL-2 super-admin insert ROW_COUNT=% expected=1', n; END IF;
END $w$;
ROLLBACK;`)

  // --- PI-3: founded_by grants nothing (N-9, M-6) ------------------------------
  add('N-9-founder-named-in-founded_by-without-membership-reads-nothing', `BEGIN;
INSERT INTO public.organizations (id, name, slug, founded_by, founding_provenance) VALUES ('1a200000-0000-4000-8000-0000000000b9','Platform for P','s1-platform-p','${IDS.uP}','platform');
SET LOCAL ROLE uellix_app;
SELECT set_config('request.jwt.claims', '{"sub":"${IDS.uP}","role":"authenticated"}', true);
DO $n$ DECLARE c int; BEGIN
  IF auth.uid() IS DISTINCT FROM '${IDS.uP}'::uuid THEN RAISE EXCEPTION 'N-9 claims not effective: auth.uid()=%', auth.uid(); END IF;
  SELECT count(*) INTO c FROM public.organizations WHERE id='1a200000-0000-4000-8000-0000000000b9';
  IF c <> 0 THEN RAISE EXCEPTION 'N-9 founded_by GRANTED tenant read access (count=%) — PI-3 violated', c; END IF;
  IF '1a200000-0000-4000-8000-0000000000b9'::uuid = ANY(public.current_user_org_ids()) THEN RAISE EXCEPTION 'N-9 current_user_org_ids() includes a founded-but-not-member organization'; END IF;
END $n$;
ROLLBACK;`)

  add('PI-3-no-policy-helper-or-trigger-predicates-on-founded_by-or-founding_provenance', `DO $p$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ 'founded_by|founding_provenance';
  IF n <> 0 THEN RAISE EXCEPTION 'PI-3 % RLS policy/policies predicate on founder traceability', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname IN ('public','auth') AND p.prosrc ~ 'founded_by|founding_provenance';
  IF n <> 0 THEN RAISE EXCEPTION 'PI-3 % function(s) read founder traceability', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='organizations' AND NOT t.tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'PI-3 S1 must not add a trigger on organizations (measured %)', n; END IF;
END $p$;`)

  // --- mutation controls: each proves the guarantee is LOAD-BEARING --------------
  add('MUT-PG-1-carrier-index-removed-second-self-service-founding-SUCCEEDS-proving-the-index-is-load-bearing', `BEGIN;
DROP INDEX public.organizations_self_service_founder_unique;
DO $m$ DECLARE n int; BEGIN
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Mut A','s1-mut-a','${IDS.uX}','self_service'),('Mut B','s1-mut-b','${IDS.uX}','self_service');
  SELECT count(*) INTO n FROM public.organizations WHERE founded_by='${IDS.uX}' AND founding_provenance='self_service';
  IF n <> 2 THEN RAISE EXCEPTION 'MUT-PG-1 expected the duplicate founding to SUCCEED once the carrier is dropped (n=%)', n; END IF;
END $m$;
ROLLBACK;`)

  add('MUT-PG-2-provenance-CHECK-removed-invented-value-ACCEPTED-proving-the-CHECK-is-load-bearing', `BEGIN;
ALTER TABLE public.organizations DROP CONSTRAINT organizations_founding_provenance_check;
DO $m$ DECLARE n int; BEGIN
  INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Mut C','s1-mut-c','${IDS.uX}','invented');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'MUT-PG-2 expected the invalid provenance to be ACCEPTED once the CHECK is dropped (n=%)', n; END IF;
END $m$;
ROLLBACK;`)

  add('MUT-PG-3-FK-removed-deleting-the-founded_by-only-user-SUCCEEDS-proving-RESTRICT-is-load-bearing', `BEGIN;
INSERT INTO auth.users (id, email) VALUES ('${IDS.uZ}','uz-s1@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email) VALUES ('${IDS.uZ}','uz-s1@pg.local') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Founded by Z','s1-founded-z','${IDS.uZ}','platform');
ALTER TABLE public.organizations DROP CONSTRAINT organizations_founded_by_users_id_fk;
DO $m$ DECLARE n int; dangling int; BEGIN
  DELETE FROM public.users WHERE id='${IDS.uZ}';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'MUT-PG-3 expected the delete to SUCCEED once the FK is dropped (n=%)', n; END IF;
  SELECT count(*) INTO dangling FROM public.organizations o WHERE o.founded_by='${IDS.uZ}' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=o.founded_by);
  IF dangling <> 1 THEN RAISE EXCEPTION 'MUT-PG-3 expected one dangling attribution without the FK (measured %)', dangling; END IF;
END $m$;
ROLLBACK;`)

  add('MUT-PG-4-a-backfill-that-infers-from-invited_by-IS-NULL-WOULD-attribute-the-sentinel-proving-2d-discriminates', `BEGIN;
DO $m$ DECLARE v text; BEGIN
  UPDATE public.organizations o SET founded_by = m.user_id FROM public.organization_members m
   WHERE m.organization_id = o.id AND m.invited_by IS NULL AND o.founded_by IS NULL;
  SELECT founded_by::text INTO v FROM public.organizations WHERE id='${IDS.HS}';
  IF v IS DISTINCT FROM '${IDS.uF2}' THEN RAISE EXCEPTION 'MUT-PG-4 the prohibited predicate did not move the sentinel (v=%), so the sentinel would not catch it', coalesce(v,'NULL'); END IF;
END $m$;
ROLLBACK;`)

  add('MUT-PG-5-a-backfill-without-the-exactly-one-conjunct-WOULD-attribute-the-two-row-case-proving-2b-discriminates', `BEGIN;
DO $m$ DECLARE v text; BEGIN
  UPDATE public.organizations o SET founded_by = q.actor_user_id FROM (
    SELECT entity_id AS organization_id, (array_agg(actor_user_id))[1] AS actor_user_id FROM public.audit_logs
    WHERE action='organization.created' AND entity_type='organization' GROUP BY entity_id HAVING count(actor_user_id) >= 1
  ) q WHERE o.id = q.organization_id AND o.founded_by IS NULL;
  SELECT founded_by::text INTO v FROM public.organizations WHERE id='${IDS.H2}';
  IF v IS NULL THEN RAISE EXCEPTION 'MUT-PG-5 the mutated backfill did not attribute H2, so 2b would not catch it'; END IF;
END $m$;
ROLLBACK;`)

  add('MUT-PG-6-a-backfill-that-falls-back-to-membership-on-a-NULL-actor-WOULD-attribute-HN-proving-2c-discriminates', `BEGIN;
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES ('${IDS.HN}','${IDS.uOrd}','organization_admin','active');
DO $m$ DECLARE v text; BEGIN
  UPDATE public.organizations o SET founded_by = coalesce(
      (SELECT a.actor_user_id FROM public.audit_logs a WHERE a.entity_type='organization' AND a.action='organization.created' AND a.entity_id=o.id LIMIT 1),
      (SELECT m.user_id FROM public.organization_members m WHERE m.organization_id=o.id ORDER BY m.created_at LIMIT 1))
   WHERE o.id='${IDS.HN}' AND o.founded_by IS NULL;
  SELECT founded_by::text INTO v FROM public.organizations WHERE id='${IDS.HN}';
  IF v IS NULL THEN RAISE EXCEPTION 'MUT-PG-6 the fallback backfill did not attribute HN, so 2c would not catch it'; END IF;
END $m$;
ROLLBACK;`)

  // --- PG-S1-5: REAL concurrency -----------------------------------------------
  // Two sessions, the SAME subject, both self-service. Session 1 inserts and
  // holds its transaction open; session 2's insert must BLOCK on the carrier
  // (a read-then-write check would not block, it would see zero rows and
  // succeed), then be REFUSED with 23505 once session 1 commits. Exactly one
  // organization survives. dblink gives two genuine backend sessions.
  add('PG-S1-5-concurrent-self-service-founding-by-the-same-subject-yields-ONE-organization-and-ONE-refusal', `CREATE EXTENSION IF NOT EXISTS dblink;
DO $c$ DECLARE conn text := 'dbname=' || current_database() || ' user=postgres'; busy int; n int; caught text := 'none'; msg text := ''; BEGIN
  PERFORM dblink_connect('s1c1', conn);
  PERFORM dblink_connect('s1c2', conn);
  PERFORM dblink_exec('s1c1', 'BEGIN');
  PERFORM dblink_exec('s1c2', 'BEGIN');
  PERFORM dblink_exec('s1c1', $q$INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Concurrent A','s1-conc-a','${IDS.uC}','self_service')$q$);
  PERFORM dblink_send_query('s1c2', $q$INSERT INTO public.organizations (name, slug, founded_by, founding_provenance) VALUES ('Concurrent B','s1-conc-b','${IDS.uC}','self_service')$q$);
  PERFORM pg_sleep(1.5);
  SELECT dblink_is_busy('s1c2') INTO busy;
  IF busy <> 1 THEN RAISE EXCEPTION 'PG-S1-5 the second founding did NOT block on the carrier (busy=%) — a read-then-write check, not a database guarantee', busy; END IF;
  PERFORM dblink_exec('s1c1', 'COMMIT');
  BEGIN
    PERFORM * FROM dblink_get_result('s1c2') AS t(r text);
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'PG-S1-5 second session caught=% expected=23505 (%)', caught, msg; END IF;
  BEGIN PERFORM * FROM dblink_get_result('s1c2') AS t(r text); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM dblink_exec('s1c2', 'ROLLBACK');
  PERFORM dblink_disconnect('s1c1');
  PERFORM dblink_disconnect('s1c2');
  SELECT count(*) INTO n FROM public.organizations WHERE founded_by='${IDS.uC}' AND founding_provenance='self_service';
  IF n <> 1 THEN RAISE EXCEPTION 'PG-S1-5 expected exactly ONE organization for the subject, measured=%', n; END IF;
END $c$;
-- Clean the committed row so the disposable database's final state is the historical world plus nothing.
DELETE FROM public.organizations WHERE slug IN ('s1-conc-a','s1-conc-b');`)

  return { probes }
}

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)('Multi-org S1 founder traceability — real PostgreSQL (canonical disposable harness)', { timeout: 1_200_000 }, () => {
  let outcome: HarnessOutcome

  beforeAll(() => {
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: buildSetupManifest(),
      probe: buildProbeManifest(),
    })
    // Machine-readable summary for the implementation evidence artefact.
    console.log(`S1_PG_OUTCOME=${JSON.stringify({
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

  afterAll(() => {
    // Nothing to clean: the harness tears its container down in `finally`.
  })

  it('the S1 unit is the LAST baseline unit and the setup applied the historical fixture BEFORE it', () => {
    expect(S1_INDEX).toBe(BASELINE_UNITS.length - 1)
    const setup = buildSetupManifest()
    const fixtureAt = setup.statements.findIndex((s) => s.includes('S1 Historical H1'))
    const s1At = setup.statements.findIndex((s) => s.startsWith(`-- BASELINE UNIT ${S1_UNIT!.ordinal}/`))
    expect(fixtureAt).toBeGreaterThan(-1)
    expect(s1At).toBe(fixtureAt + 1)
  })

  it(`the harness provisioned the full baseline (${BASELINE_UNITS.length} units, S1 included) and tore itself down with zero leftovers`, () => {
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
