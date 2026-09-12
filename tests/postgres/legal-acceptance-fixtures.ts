// tests/postgres/legal-acceptance-fixtures.ts
//
// CL-1 — the shared disposable-Postgres substrate (roles, baseline units,
// hosted-fidelity shims, T1/T2/T3 tenant fixture) that BOTH
// legal-acceptance.pg.test.ts (the psql-literal RLS/property probes) and
// legal-acceptance-real-derivation.pg.test.ts (U-1's real-function
// composition proof) build their disposable databases from.
//
// Deliberately NOT named `*.pg.test.ts` or `*.test.ts`: importing this module
// registers no `describe()` block. An earlier version had
// legal-acceptance-real-derivation.pg.test.ts import these constants directly
// from legal-acceptance.pg.test.ts, which meant every test run that touched
// EITHER file re-executed the OTHER file's full 27-probe disposable-container
// suite a second time as an import side effect — harmless but a real,
// avoidable extra container cycle on every run. Extracting the shared
// substrate here removes that coupling: each `.pg.test.ts` file registers
// exactly its own tests.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { computeSelfDescribingDigest } from '@/lib/auth/legal-acceptance'
import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import type { SetupManifest } from '../../scripts/db-audit-disposable'

const ROOT = path.resolve(__dirname, '..', '..')

export const IDS = {
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

export const DIGEST_V1 = 'sha256:' + '1'.repeat(64)
export const DIGEST_V2 = 'sha256:' + '2'.repeat(64)
export const DIGEST_V3 = 'sha256:' + '3'.repeat(64)
export const DIGEST_PRIVACY_V1 = 'sha256:' + '4'.repeat(64)
export const DIGEST_WRONG = 'sha256:' + '9'.repeat(64)
export const DIGEST_ORG_V1 = 'sha256:' + '5'.repeat(64)

// Presentation-binding fixture: SYNTHETIC placeholder text
// (S-AO-NO-REAL-INSTRUMENT-TEXT-AND-NO-REAL-SECRETS), never real legal
// content. The digest is computed by the SAME function the acceptance page
// uses to re-verify what it renders, so a mismatch here would mean the
// fixture itself is wrong, not just the probe.
export const SYNTHETIC_TERMS_V4_TEXT = 'CL-1 presentation-binding fixture — synthetic terms_of_service v4, not real legal content.'
export const SYNTHETIC_TERMS_V4_DIGEST = computeSelfDescribingDigest(SYNTHETIC_TERMS_V4_TEXT)

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
-- (marked, NOT YET effective — pre-effective) -> v4 (unmarked, effective,
-- carries content_bytes for the presentation-binding probes). privacy_policy
-- has one unmarked version. commercial_terms has one ORGANIZATION-class
-- version. v4 being unmarked means it changes NO currency-predicate probe
-- above: it never supersedes u2's accepted v2 (REACCEPTANCE requires the
-- superseding version to be MARKED, not merely later).
INSERT INTO public.legal_instrument_versions
  (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
VALUES
  ('0c110000-0000-4000-8000-0000000010a1', 'terms_of_service', 1, 'es', '${DIGEST_V1}', NULL, false, NULL, '${IDS.uSA}', now() - interval '30 days'),
  ('0c110000-0000-4000-8000-0000000010a2', 'terms_of_service', 2, 'es', '${DIGEST_V2}', NULL, true, now() - interval '1 day', '${IDS.uSA}', now() - interval '10 days'),
  ('0c110000-0000-4000-8000-0000000010a3', 'terms_of_service', 3, 'es', '${DIGEST_V3}', NULL, true, now() + interval '365 days', '${IDS.uSA}', now()),
  ('0c110000-0000-4000-8000-0000000010a4', 'terms_of_service', 4, 'es', '${SYNTHETIC_TERMS_V4_DIGEST}', '${SYNTHETIC_TERMS_V4_TEXT}', false, now() - interval '1 day', '${IDS.uSA}', now() - interval '1 day'),
  ('0c110000-0000-4000-8000-0000000010b1', 'privacy_policy', 1, 'es', '${DIGEST_PRIVACY_V1}', NULL, false, NULL, '${IDS.uSA}', now() - interval '30 days'),
  ('0c110000-0000-4000-8000-0000000010c1', 'commercial_terms', 1, 'es', '${DIGEST_ORG_V1}', NULL, false, NULL, '${IDS.uSA}', now() - interval '30 days');

-- T3, seeded through RLS as each subject themselves — proves the self-scoped
-- INSERT policy works for the LEGITIMATE case before the negative probes try
-- to break it.
`

export const asUser = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

/**
 * Roles + baseline migration units + hosted-fidelity shims — schema and
 * policies only, deliberately WITHOUT any legal_instruments,
 * legal_instrument_versions or account_legal_acceptances row. Exported
 * separately (not just as an implementation slice of buildSetupManifest())
 * so a caller that needs a genuinely EMPTY required-instrument registry
 * (legal_instrument_versions and account_legal_acceptances are append-only —
 * RLS write-closed plus a BEFORE UPDATE OR DELETE trigger enforcing it even
 * for the postgres superuser — so a registry that starts populated can never
 * be emptied again on the same database) has an explicit, named entry point
 * rather than having to know how many trailing statements buildSetupManifest()
 * happens to append.
 */
export function buildBaselineOnlyStatements(): string[] {
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(ROOT, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) statements.push(unitStatement(unit))
  statements.push(HOSTED_FIDELITY)
  return statements
}

export function buildSetupManifest(): SetupManifest {
  const statements = [...buildBaselineOnlyStatements(), TENANT_FIXTURE]
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
