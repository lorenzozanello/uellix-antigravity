// tests/postgres/legal-acceptance.pg.test.ts
// CL-1 — customer-lifecycle L0 legal-acceptance substrate (T1/T2/T3), REAL
// PostgreSQL controls, run through the CANONICAL disposable harness
// scripts/db-audit-disposable.ts: a throwaway postgres container on
// 127.0.0.1, ephemeral port, no bind mounts, teardown in `finally`, leftover
// check. Never staging, never production, never the canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise.
//
// WHAT THIS FILE PROVES that no mocked unit test can:
//   - append-only enforcement on legal_instrument_versions and
//     account_legal_acceptances (I-T2-2, I-T3-2) is a property of RLS/omitted
//     policies, not application discipline;
//   - the I-T3-1 uniqueness invariant is a real database constraint;
//   - the T3 cross-table invariants (I-T3-4 digest equality, I-T3-5
//     instrument_class ACCOUNT) enforced by the BEFORE INSERT trigger;
//   - the RLS postures R-CL1-1 (T1/T2 read-open/write-closed),
//     R-CL1-3/R-CL1-4 (T3 self-scoped read/write);
//   - the org-less audit INSERT admission (R-CL1-6, F-AO-15) against BOTH
//     sibling policies (0042, 0067) unedited;
//   - the L0 currency predicate (REACCEPTANCE.R2_CORRECTION_EFFECTIVE_AT),
//     including the empty/partial-registry fail-closed cases and the
//     pre-effective-version non-refusal case, evaluated as the identical SQL
//     shape lib/auth/legal-acceptance.ts issues.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { runDisposableHarness, DEFAULT_IMAGE, type HarnessOutcome, type SetupManifest, type ProbeManifest } from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(__dirname, '..', '..')

/** The CL-1 unit, DERIVED from the live manifest — never named by ordinal. */
const CL1_UNIT = BASELINE_UNITS.find((u) => /^\d{4}_customer_lifecycle_cl1_legal_acceptance\.sql$/.test(u.id))
if (!CL1_UNIT) throw new Error('the CL-1 legal-acceptance baseline unit is not registered in db/hosted/baseline-manifest.ts')

const IDS = {
  u1: '0c110000-0000-4000-8000-0000000000a1', // accepts nothing
  u2: '0c110000-0000-4000-8000-0000000000a2', // current on both required instruments
  u3: '0c110000-0000-4000-8000-0000000000a3', // stale — accepted v1 of terms only, v2 supersedes it
  uSA: '0c110000-0000-4000-8000-0000000000fa', // platform super admin, used only to seed rows through RLS
  // account_legal_acceptances rows, id fixed for the concurrency probe
  acceptU2Terms: '0c110000-0000-4000-8000-0000000001a1',
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
-- (3) Runtime reachability: schema usage, auth.uid() reach, RLS helper EXECUTE.
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app;
GRANT USAGE ON SCHEMA auth TO uellix_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
-- (4) The ordinary ACL floor the runtime writer role needs to exercise T1/T2/T3
-- and audit_logs as an authenticated subject — RLS is the wall under test, not
-- a missing table grant.
GRANT SELECT, INSERT ON public.legal_instruments, public.legal_instrument_versions, public.account_legal_acceptances TO uellix_writer;
GRANT UPDATE, DELETE ON public.legal_instruments, public.legal_instrument_versions, public.account_legal_acceptances TO uellix_writer;
GRANT INSERT ON public.audit_logs TO uellix_writer;
GRANT SELECT ON public.users TO uellix_writer;
`

function unitStatement(unit: (typeof BASELINE_UNITS)[number]): string {
  return `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(ROOT, unit.file), 'utf8')
}

const DIGEST_V1 = 'sha256:' + '1'.repeat(64)
const DIGEST_V2 = 'sha256:' + '2'.repeat(64)
const DIGEST_V3 = 'sha256:' + '3'.repeat(64)
const DIGEST_PRIVACY_V1 = 'sha256:' + '4'.repeat(64)
const DIGEST_WRONG = 'sha256:' + '9'.repeat(64)
const DIGEST_ORG_V1 = 'sha256:' + '5'.repeat(64)

/** Seeded AFTER the full baseline: super-admin seeds the fixture through RLS, honestly. */
const TENANT_FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.u1}','u1-cl1@pg.local'),('${IDS.u2}','u2-cl1@pg.local'),('${IDS.u3}','u3-cl1@pg.local'),('${IDS.uSA}','usa-cl1@pg.local')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.u1}','u1-cl1@pg.local',false),('${IDS.u2}','u2-cl1@pg.local',false),('${IDS.u3}','u3-cl1@pg.local',false),('${IDS.uSA}','usa-cl1@pg.local',true)
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.uSA}';

-- T1: the two real required ACCOUNT-class instruments, plus one ORGANIZATION-
-- class instrument for the I-T3-5 negative control.
INSERT INTO public.legal_instruments (instrument_key, instrument_class) VALUES
  ('terms_of_service', 'ACCOUNT'),
  ('privacy_policy', 'ACCOUNT'),
  ('commercial_terms', 'ORGANIZATION');

-- T2: terms_of_service v1 (unmarked) -> v2 (marked, ALREADY effective) -> v3
-- (marked, NOT YET effective — pre-effective). privacy_policy has one
-- unmarked version. commercial_terms has one ORGANIZATION-class version.
INSERT INTO public.legal_instrument_versions
  (id, instrument_key, version, locale, content_digest, reaccept_required, effective_at, published_by, published_at)
VALUES
  ('0c110000-0000-4000-8000-0000000010a1', 'terms_of_service', 1, 'es', '${DIGEST_V1}', false, NULL, '${IDS.uSA}', now() - interval '30 days'),
  ('0c110000-0000-4000-8000-0000000010a2', 'terms_of_service', 2, 'es', '${DIGEST_V2}', true, now() - interval '1 day', '${IDS.uSA}', now() - interval '10 days'),
  ('0c110000-0000-4000-8000-0000000010a3', 'terms_of_service', 3, 'es', '${DIGEST_V3}', true, now() + interval '365 days', '${IDS.uSA}', now()),
  ('0c110000-0000-4000-8000-0000000010b1', 'privacy_policy', 1, 'es', '${DIGEST_PRIVACY_V1}', false, NULL, '${IDS.uSA}', now() - interval '30 days'),
  ('0c110000-0000-4000-8000-0000000010c1', 'commercial_terms', 1, 'es', '${DIGEST_ORG_V1}', false, NULL, '${IDS.uSA}', now() - interval '30 days');

-- T3, seeded through RLS as each subject themselves — proves the self-scoped
-- INSERT policy works for the LEGITIMATE case before the negative probes try
-- to break it.
`

const asUser = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

export function buildSetupManifest(): SetupManifest {
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(ROOT, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) statements.push(unitStatement(unit))
  statements.push(HOSTED_FIDELITY)
  statements.push(TENANT_FIXTURE)
  // Seed u2 and u3's acceptances through RLS, as themselves — the ONLY
  // legitimate way this table is ever written.
  statements.push(
    asUser(IDS.u2) +
      `INSERT INTO public.account_legal_acceptances (id, user_id, instrument_version_id, content_digest) VALUES
    ('${IDS.acceptU2Terms}', '${IDS.u2}', '0c110000-0000-4000-8000-0000000010a2', '${DIGEST_V2}'),
    (gen_random_uuid(), '${IDS.u2}', '0c110000-0000-4000-8000-0000000010b1', '${DIGEST_PRIVACY_V1}');
COMMIT;`
  )
  statements.push(
    asUser(IDS.u3) +
      `INSERT INTO public.account_legal_acceptances (id, user_id, instrument_version_id, content_digest) VALUES
    (gen_random_uuid(), '${IDS.u3}', '0c110000-0000-4000-8000-0000000010a1', '${DIGEST_V1}');
COMMIT;`
  )
  return { statements }
}

/**
 * The EXACT currency-predicate SQL shape lib/auth/legal-acceptance.ts
 * deriveAccountAcceptanceCurrent issues, parameterised over an arbitrary
 * required-key list so the empty/partial-registry cases can be tested
 * without disturbing the shared fixture other probes depend on.
 *
 * Returns a bare boolean EXPRESSION (no SELECT/INTO) so callers can embed it
 * as `SELECT (${currencySql(...)}) INTO cur;` — plpgsql's INTO must follow
 * the select-list directly, which a trailing `AS alias` would break.
 */
function currencySql(userId: string, requiredKeys: string[]): string {
  const values = requiredKeys.map((k) => `('${k}'::varchar)`).join(', ')
  return `
    NOT EXISTS (
      SELECT 1
      FROM (VALUES ${values}) AS required(instrument_key)
      WHERE NOT EXISTS (
        SELECT 1
        FROM legal_instrument_versions v
        JOIN account_legal_acceptances a
          ON a.instrument_version_id = v.id
          AND a.user_id = '${userId}'::uuid
        WHERE v.instrument_key = required.instrument_key
          AND NOT EXISTS (
            SELECT 1
            FROM legal_instrument_versions v2
            WHERE v2.instrument_key = v.instrument_key
              AND v2.version > v.version
              AND v2.reaccept_required = true
              AND (v2.effective_at IS NULL OR v2.effective_at <= now())
          )
      )
    )`
}

export function buildProbeManifest(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  // --- R-CL1-1: T1/T2 read-open, write-closed --------------------------------
  add('R-CL1-1a-any-authenticated-subject-reads-T1-and-T2',
    asUser(IDS.u1) + `DO $w$ DECLARE n1 int; n2 int; BEGIN
  SELECT count(*) INTO n1 FROM public.legal_instruments;
  SELECT count(*) INTO n2 FROM public.legal_instrument_versions;
  IF n1 <> 3 THEN RAISE EXCEPTION 'R-CL1-1a legal_instruments count=% expected=3', n1; END IF;
  IF n2 <> 5 THEN RAISE EXCEPTION 'R-CL1-1a legal_instrument_versions count=% expected=5', n2; END IF;
END $w$;
ROLLBACK;`)

  add('R-CL1-2a-T2-INSERT-denied-no-tenant-role-write-path-PLATFORM_PUBLISHER_DEPENDENCY',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    INSERT INTO public.legal_instrument_versions (instrument_key, version, locale, content_digest, reaccept_required, published_by)
    VALUES ('terms_of_service', 99, 'es', '${DIGEST_WRONG}', false, '${IDS.u1}');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'R-CL1-2a caught=% expected=42501 (%)', caught, msg; END IF;
END $w$;
ROLLBACK;`)

  add('I-T2-2-T2-UPDATE-denied-append-only',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  BEGIN
    UPDATE public.legal_instrument_versions SET reaccept_required = false WHERE instrument_key = 'terms_of_service' AND version = 2;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'I-T2-2 UPDATE affected % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'I-T2-2 unexpected SQLSTATE=%', caught; END IF;
END $w$;
ROLLBACK;`)

  add('I-T2-2-T2-DELETE-denied-append-only',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  BEGIN
    DELETE FROM public.legal_instrument_versions WHERE instrument_key = 'terms_of_service' AND version = 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'I-T2-2 DELETE affected % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'I-T2-2 unexpected SQLSTATE=%', caught; END IF;
END $w$;
ROLLBACK;`)

  // --- R-CL1-3/R-CL1-4: T3 self-scoped write/read ----------------------------
  add('R-CL1-3a-T3-INSERT-for-SELF-succeeds',
    asUser(IDS.u1) + `DO $w$ BEGIN
  INSERT INTO public.account_legal_acceptances (user_id, instrument_version_id, content_digest)
  VALUES ('${IDS.u1}', '0c110000-0000-4000-8000-0000000010b1', '${DIGEST_PRIVACY_V1}');
END $w$;
ROLLBACK;`)

  add('N-AO-24-T3-INSERT-for-ANOTHER-subject-denied',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    INSERT INTO public.account_legal_acceptances (user_id, instrument_version_id, content_digest)
    VALUES ('${IDS.u2}', '0c110000-0000-4000-8000-0000000010b1', '${DIGEST_PRIVACY_V1}');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'N-AO-24 caught=% expected=42501 (%)', caught, msg; END IF;
END $w$;
ROLLBACK;`)

  add('I-T3-8-T3-SELECT-scoped-to-SELF-only',
    asUser(IDS.u2) + `DO $w$ DECLARE n int; leaked int; BEGIN
  SELECT count(*) INTO n FROM public.account_legal_acceptances WHERE user_id = '${IDS.u2}';
  IF n <> 2 THEN RAISE EXCEPTION 'I-T3-8 own-row count=% expected=2', n; END IF;
  SELECT count(*) INTO leaked FROM public.account_legal_acceptances WHERE user_id = '${IDS.u3}';
  IF leaked <> 0 THEN RAISE EXCEPTION 'I-T3-8 u3''s acceptance leaked into u2''s scoped read (count=%)', leaked; END IF;
END $w$;
ROLLBACK;`)

  add('I-T3-2-T3-UPDATE-denied-append-only',
    asUser(IDS.u2) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  BEGIN
    UPDATE public.account_legal_acceptances SET content_digest = '${DIGEST_WRONG}' WHERE id = '${IDS.acceptU2Terms}';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'I-T3-2 UPDATE affected % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'I-T3-2 unexpected SQLSTATE=%', caught; END IF;
END $w$;
ROLLBACK;`)

  add('I-T3-2-T3-DELETE-denied-append-only',
    asUser(IDS.u2) + `DO $w$ DECLARE caught text := 'none'; n int; BEGIN
  BEGIN
    DELETE FROM public.account_legal_acceptances WHERE id = '${IDS.acceptU2Terms}';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'I-T3-2 DELETE affected % rows instead of being denied', n; END IF;
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught NOT IN ('none','42501') THEN RAISE EXCEPTION 'I-T3-2 unexpected SQLSTATE=%', caught; END IF;
END $w$;
ROLLBACK;`)

  // --- I-T3-1: uniqueness is the concurrency control -------------------------
  add('I-T3-1-duplicate-acceptance-of-the-SAME-version-refused-23505',
    asUser(IDS.u2) + `DO $w$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    INSERT INTO public.account_legal_acceptances (user_id, instrument_version_id, content_digest)
    VALUES ('${IDS.u2}', '0c110000-0000-4000-8000-0000000010a2', '${DIGEST_V2}');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '23505' THEN RAISE EXCEPTION 'I-T3-1 caught=% expected=23505 (unique_violation)', caught; END IF;
END $w$;
ROLLBACK;`)

  // --- I-T3-4 / I-T3-5: the cross-table trigger invariants -------------------
  add('I-T3-4-digest-mismatch-refused-by-trigger',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    INSERT INTO public.account_legal_acceptances (user_id, instrument_version_id, content_digest)
    VALUES ('${IDS.u1}', '0c110000-0000-4000-8000-0000000010b1', '${DIGEST_WRONG}');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23514' THEN RAISE EXCEPTION 'I-T3-4 caught=% expected=23514 (check_violation) (%)', caught, msg; END IF;
  IF msg !~ 'I-T3-4' THEN RAISE EXCEPTION 'I-T3-4 refused for the wrong reason: %', msg; END IF;
END $w$;
ROLLBACK;`)

  add('I-T3-5-ORGANIZATION-class-instrument-refused-on-the-account-acceptance-path',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; msg text := ''; BEGIN
  BEGIN
    INSERT INTO public.account_legal_acceptances (user_id, instrument_version_id, content_digest)
    VALUES ('${IDS.u1}', '0c110000-0000-4000-8000-0000000010c1', '${DIGEST_ORG_V1}');
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; msg := SQLERRM; END;
  IF caught <> '23514' THEN RAISE EXCEPTION 'I-T3-5 caught=% expected=23514 (check_violation) (%)', caught, msg; END IF;
  IF msg !~ 'I-T3-5' THEN RAISE EXCEPTION 'I-T3-5 refused for the wrong reason: %', msg; END IF;
END $w$;
ROLLBACK;`)

  // --- the currency predicate, the exact SQL shape L0 issues -----------------
  add('N-AO-32-zero-acceptances-never-passes-vacuously',
    asUser(IDS.u1) + `DO $w$ DECLARE cur boolean; BEGIN
  SELECT (${currencySql(IDS.u1, ['terms_of_service', 'privacy_policy'])}) INTO cur;
  IF cur IS DISTINCT FROM false THEN RAISE EXCEPTION 'N-AO-32 zero-acceptance subject measured current=%, expected false', cur; END IF;
END $w$;
ROLLBACK;`)

  add('N-AO-4-a-later-MARKED-EFFECTIVE-version-refuses-a-stale-acceptor',
    asUser(IDS.u3) + `DO $w$ DECLARE cur boolean; BEGIN
  SELECT (${currencySql(IDS.u3, ['terms_of_service'])}) INTO cur;
  IF cur IS DISTINCT FROM false THEN RAISE EXCEPTION 'N-AO-4 u3 (accepted only v1) measured current=%, expected false (v2 supersedes)', cur; END IF;
END $w$;
ROLLBACK;`)

  add('P-AO-6-P-AO-17-P-AO-21-current-on-the-latest-EFFECTIVE-marked-version-passes-despite-a-PRE-EFFECTIVE-later-one',
    asUser(IDS.u2) + `DO $w$ DECLARE cur boolean; BEGIN
  SELECT (${currencySql(IDS.u2, ['terms_of_service', 'privacy_policy'])}) INTO cur;
  IF cur IS DISTINCT FROM true THEN RAISE EXCEPTION 'P-AO-21 u2 (current on v2 + privacy v1) measured current=%, expected true (v3 is not yet effective)', cur; END IF;
END $w$;
ROLLBACK;`)

  add('P-AO-15-N-AO-37-empty-and-partial-registry-both-refuse-fail-closed',
    asUser(IDS.u2) + `DO $w$ DECLARE cur boolean; BEGIN
  -- u2 is current on the two REAL required keys (proven above), but adding a
  -- required key with ZERO published versions must still refuse the whole
  -- conjunction — there is no empty set to be vacuously true over.
  SELECT (${currencySql(IDS.u2, ['terms_of_service', 'privacy_policy', 'nonexistent_required_key_for_fail_closed_probe'])}) INTO cur;
  IF cur IS DISTINCT FROM false THEN RAISE EXCEPTION 'P-AO-15/N-AO-37 measured current=% with an unpublished required key present, expected false', cur; END IF;
END $w$;
ROLLBACK;`)

  // --- R-CL1-6 / ORGLESS_AUDIT_AUTHORITY --------------------------------------
  add('R-CL1-6-orgless-acceptance-audit-INSERT-admitted-for-the-authorized-subject',
    asUser(IDS.u1) + `DO $w$ BEGIN
  INSERT INTO public.audit_logs (actor_user_id, entity_type, entity_id, action, organization_id, after_json)
  VALUES ('${IDS.u1}', 'user', '${IDS.u1}', 'legal.account_instrument_accepted', NULL,
    jsonb_build_object('instrumentKey', 'privacy_policy', 'version', 1, 'contentDigest', '${DIGEST_PRIVACY_V1}'));
END $w$;
ROLLBACK;`)

  add('N-AO-25-orgless-audit-refuses-a-DIFFERENT-closed-verb-even-with-organization_id-NULL',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    INSERT INTO public.audit_logs (actor_user_id, entity_type, entity_id, action, organization_id)
    VALUES ('${IDS.u1}', 'user', '${IDS.u1}', 'legal.account_instrument_accepted_but_not_really', NULL);
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'N-AO-25 caught=% expected=42501', caught; END IF;
END $w$;
ROLLBACK;`)

  add('ORGLESS_AUDIT-refuses-an-actor-mismatch-cannot-attribute-the-acceptance-to-someone-else',
    asUser(IDS.u1) + `DO $w$ DECLARE caught text := 'none'; BEGIN
  BEGIN
    INSERT INTO public.audit_logs (actor_user_id, entity_type, entity_id, action, organization_id)
    VALUES ('${IDS.u2}', 'user', '${IDS.u2}', 'legal.account_instrument_accepted', NULL);
  EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; END;
  IF caught <> '42501' THEN RAISE EXCEPTION 'ORGLESS_AUDIT actor-mismatch caught=% expected=42501', caught; END IF;
END $w$;
ROLLBACK;`)

  add('ORGLESS_AUDIT-0042-and-0067-remain-unedited-a-normal-org-scoped-audit-insert-still-works',
    `DO $w$ DECLARE n int; BEGIN
  -- Sanity: the additive policy did not disturb 0042's ordinary tenant path.
  -- Run as postgres (owner) so this is purely a policy-existence smoke check,
  -- not a second RLS probe.
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd = 'INSERT';
  IF n <> 3 THEN RAISE EXCEPTION 'ORGLESS_AUDIT expected exactly 3 audit_logs INSERT policies (0042, 0067, CL-1), measured %', n; END IF;
END $w$;`)

  return { probes }
}

const EXPECTED_PROBE_IDS = buildProbeManifest().probes.map((p) => p.id)

describe.skipIf(!PG_TESTS_ENABLED)('CL-1 legal acceptance — real PostgreSQL (canonical disposable harness)', { timeout: 1_200_000 }, () => {
  let outcome: HarnessOutcome

  beforeAll(() => {
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: buildSetupManifest(),
      probe: buildProbeManifest(),
    })
    console.log(`CL1_PG_OUTCOME=${JSON.stringify({
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

  it('the CL-1 unit is the LAST baseline unit', () => {
    const index = BASELINE_UNITS.indexOf(CL1_UNIT!)
    expect(index).toBe(BASELINE_UNITS.length - 1)
  })

  it(`the harness provisioned the full baseline (${BASELINE_UNITS.length} units, CL-1 included) and tore itself down with zero leftovers`, () => {
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
