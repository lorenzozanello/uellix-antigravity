// tests/postgres/organization-commercial-acceptance-fixtures.ts
//
// L1 (HPO-ODS-W2-29) — the shared disposable-Postgres substrate (roles,
// baseline units, hosted-fidelity shims, the tenant + T1/T2/T4 fixture) that
// BOTH organization-commercial-acceptance.pg.test.ts (the psql-literal
// invariant probes, ORACLE 1) and
// organization-commercial-acceptance-real-derivation.pg.test.ts (the real
// exported-function composition proof, ORACLE 2) build from.
//
// Deliberately NOT named `*.pg.test.ts` or `*.test.ts`: importing this module
// registers no describe() block, so neither suite re-executes the other's
// container cycle as an import side effect. Same reasoning as its CL-1
// sibling, tests/postgres/legal-acceptance-fixtures.ts.
//
// WHY THE T4 ROWS ARE SEEDED THROUGH RLS AS THE ADMIN AND NOT AS postgres.
// The 0072 BEFORE INSERT trigger re-verifies auth.uid() and the acting
// subject's ACTIVE organization_admin role at the DATABASE boundary, for
// EVERY writer including the table owner and a superuser. A fixture that
// seeded as postgres would be refused — which is the property working, not a
// harness problem. Seeding as the admin, through RLS, additionally proves the
// LEGITIMATE case before the negative probes try to break it.
//
// AT MOST ONE ACTIVE MEMBERSHIP PER SUBJECT, MEASURED. db/schema.ts declares
// uniqueIndex('user_single_active_membership') on (user_id) WHERE
// status = 'active'. So each ROLE gets its OWN user rather than one user
// wearing several hats, and the multi-membership dimension is expressed as
// SEVERAL MEMBERSHIP ROWS OF WHICH EXACTLY ONE IS ACTIVE — never as two live
// scopes, which is unsatisfiable against this schema and would be a test
// failing for the wrong reason.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { computeSelfDescribingDigest } from '@/lib/auth/legal-acceptance'
import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import type { SetupManifest } from '../../scripts/db-audit-disposable'

const ROOT = path.resolve(__dirname, '..', '..')

export const IDS = {
  // Organisations A and B are governed by the SAME CommercialAccount, which is
  // what makes N-AO-12 a real test of I-T4-8 rather than of two unrelated
  // tenants.
  ca: '0c120000-0000-4000-8000-0000000000ca',
  orgA: '0c120000-0000-4000-8000-00000000000a',
  orgB: '0c120000-0000-4000-8000-00000000000b',

  adminA: '0c120000-0000-4000-8000-0000000000a1',
  adminA2: '0c120000-0000-4000-8000-0000000000a2', // second admin of A — replay / concurrency
  adminB: '0c120000-0000-4000-8000-0000000000b1',

  // One user per non-admin role: the single-active-membership index forbids
  // one subject holding four.
  impactManager: '0c120000-0000-4000-8000-0000000000c1',
  analyst: '0c120000-0000-4000-8000-0000000000c2',
  reviewer: '0c120000-0000-4000-8000-0000000000c3',
  viewer: '0c120000-0000-4000-8000-0000000000c4',

  // A membership row CARRYING role super_admin — a value db/schema.ts
  // role_check permits. This subject is NOT a platform super-admin.
  tenantSuperAdmin: '0c120000-0000-4000-8000-0000000000d1',
  // A PLATFORM super-admin with NO membership in either organisation.
  platformSuperAdmin: '0c120000-0000-4000-8000-0000000000fa',

  // The former admin: an ACTIVE organization_admin who accepts, then loses the
  // role. Proves the acceptance stands (I-T4-7).
  formerAdmin: '0c120000-0000-4000-8000-0000000000e1',
  orgC: '0c120000-0000-4000-8000-00000000000c',

  orgVersionV1: '0c120000-0000-4000-8000-000000001001',
  orgVersionV2Pre: '0c120000-0000-4000-8000-000000001002',
  accountVersionV1: '0c120000-0000-4000-8000-000000001003',
  orgVersionV3Unpresentable: '0c120000-0000-4000-8000-000000001004',
} as const

const ROLE_PRELUDE = `
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
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $f$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$f$;
DO $o$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO uellix_owner', r.tablename);
  END LOOP;
END $o$;
GRANT USAGE ON SCHEMA public TO uellix_writer, uellix_auditor, uellix_app;
GRANT USAGE ON SCHEMA auth TO uellix_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_writer;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), public.current_user_role_in_org(uuid) TO uellix_writer, uellix_auditor;
-- The ordinary ACL floor the runtime writer role needs to exercise T1/T2/T4
-- and audit_logs as an authenticated subject. RLS is the wall under test, not
-- a missing table grant -- and UPDATE/DELETE are granted DELIBERATELY so that
-- N-AO-19's append-only refusal is proven by RLS and the trigger rather than
-- by an absent privilege, which would be a different property wearing the
-- same green tick.
GRANT SELECT, INSERT ON public.legal_instruments, public.legal_instrument_versions, public.organization_commercial_acceptances TO uellix_writer;
GRANT UPDATE, DELETE ON public.organization_commercial_acceptances TO uellix_writer;
GRANT INSERT ON public.audit_logs TO uellix_writer;
GRANT SELECT ON public.users, public.organizations, public.organization_members, public.commercial_accounts, public.audit_logs TO uellix_writer;
`

function unitStatement(unit: (typeof BASELINE_UNITS)[number]): string {
  return `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(ROOT, unit.file), 'utf8')
}

/**
 * SYNTHETIC placeholder text, never real legal content
 * (EMPTY_AND_PARTIAL_REGISTRY.NO_INSTRUMENT_LEGAL_CONTENT_IS_AUTHORIZED_HERE).
 * The CANARY is what sentinel S-L1-NO-INSTRUMENT-TEXT-IN-AUDIT plants: it must
 * appear in NO audit_logs column after an acceptance, while instrument_key,
 * version and content_digest DO appear.
 */
export const CANARY = 'CANARY-L1-b41f7e-instrument-body-must-never-reach-audit-logs'
export const ORG_V1_TEXT = `L1 fixture -- synthetic commercial_terms v1. ${CANARY}`
export const ORG_V1_DIGEST = computeSelfDescribingDigest(ORG_V1_TEXT)
export const ORG_V2_TEXT = 'L1 fixture -- synthetic commercial_terms v2, published but NOT YET effective.'
export const ORG_V2_DIGEST = computeSelfDescribingDigest(ORG_V2_TEXT)
export const ACCOUNT_V1_DIGEST = 'sha256:' + '5'.repeat(64)
/** A version whose retained bytes do NOT hash to its recorded digest. */
export const ORG_V3_TEXT = 'L1 fixture -- retained bytes that do not match the recorded digest.'
export const ORG_V3_DECLARED_DIGEST = 'sha256:' + '8'.repeat(64)
export const WRONG_DIGEST = 'sha256:' + '9'.repeat(64)

/** Opens a transaction acting as `id` through the runtime role, exactly as the application does. */
export const asUser = (id: string) =>
  `BEGIN; SET LOCAL ROLE uellix_app; SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\n`

const TENANT_FIXTURE = `
INSERT INTO auth.users (id, email) VALUES
  ('${IDS.adminA}','admin-a@pg.local'),('${IDS.adminA2}','admin-a2@pg.local'),('${IDS.adminB}','admin-b@pg.local'),
  ('${IDS.impactManager}','im@pg.local'),('${IDS.analyst}','an@pg.local'),('${IDS.reviewer}','rv@pg.local'),('${IDS.viewer}','vw@pg.local'),
  ('${IDS.tenantSuperAdmin}','tsa@pg.local'),('${IDS.platformSuperAdmin}','psa@pg.local'),('${IDS.formerAdmin}','fa@pg.local')
  ON CONFLICT (id) DO NOTHING;
-- NOTE the explicit UPDATE below. The 20260716000000_auth_trigger.sql unit
-- creates a public.users row the moment an auth.users row appears, with
-- is_super_admin defaulting to FALSE -- so the INSERT ... ON CONFLICT DO
-- NOTHING that follows does NOTHING for every one of these subjects, and the
-- platform super-admin silently is not one. Measured, not assumed: the probe
-- that asserts current_user_is_super_admin() caught it. Same repair the CL-1
-- fixture carries for the same reason.
INSERT INTO public.users (id, email, is_super_admin) VALUES
  ('${IDS.adminA}','admin-a@pg.local',false),('${IDS.adminA2}','admin-a2@pg.local',false),('${IDS.adminB}','admin-b@pg.local',false),
  ('${IDS.impactManager}','im@pg.local',false),('${IDS.analyst}','an@pg.local',false),('${IDS.reviewer}','rv@pg.local',false),('${IDS.viewer}','vw@pg.local',false),
  ('${IDS.tenantSuperAdmin}','tsa@pg.local',false),('${IDS.platformSuperAdmin}','psa@pg.local',true),('${IDS.formerAdmin}','fa@pg.local',false)
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_super_admin = true WHERE id = '${IDS.platformSuperAdmin}';
UPDATE public.users SET is_super_admin = false WHERE id <> '${IDS.platformSuperAdmin}';

-- ONE CommercialAccount governing BOTH organisations (N-AO-12 / I-T4-8).
INSERT INTO public.commercial_accounts (id, legal_name, commercial_status)
VALUES ('${IDS.ca}', 'L1 Fixture Group', 'active');

INSERT INTO public.organizations (id, name, slug, status, commercial_account_id) VALUES
  ('${IDS.orgA}', 'Org A', 'org-a', 'active', '${IDS.ca}'),
  ('${IDS.orgB}', 'Org B', 'org-b', 'active', '${IDS.ca}'),
  ('${IDS.orgC}', 'Org C', 'org-c', 'active', NULL);

-- Memberships. AT MOST ONE ACTIVE PER SUBJECT (user_single_active_membership).
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}', '${IDS.adminA}', 'organization_admin', 'active'),
  ('${IDS.orgA}', '${IDS.adminA2}', 'organization_admin', 'active'),
  ('${IDS.orgB}', '${IDS.adminB}', 'organization_admin', 'active'),
  ('${IDS.orgA}', '${IDS.impactManager}', 'impact_manager', 'active'),
  ('${IDS.orgA}', '${IDS.analyst}', 'analyst', 'active'),
  ('${IDS.orgA}', '${IDS.reviewer}', 'reviewer', 'active'),
  ('${IDS.orgA}', '${IDS.viewer}', 'viewer', 'active'),
  ('${IDS.orgA}', '${IDS.tenantSuperAdmin}', 'super_admin', 'active'),
  ('${IDS.orgC}', '${IDS.formerAdmin}', 'organization_admin', 'active');

-- THE MULTI-MEMBERSHIP DIMENSION, in its SATISFIABLE form: adminB holds a
-- SECOND membership row in Org A that is INACTIVE. Two ROWS, exactly one
-- ACTIVE -- never two live scopes, which the live index forbids.
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('${IDS.orgA}', '${IDS.adminB}', 'organization_admin', 'inactive');

-- T1: the ORGANIZATION-class instrument L1 requires, plus an ACCOUNT-class
-- one for the class guard in the other direction (N-AO-20).
INSERT INTO public.legal_instruments (instrument_key, instrument_class) VALUES
  ('commercial_terms', 'ORGANIZATION'),
  ('terms_of_service', 'ACCOUNT');

-- T2: commercial_terms v1 (effective, presentable, carries the CANARY);
-- v2 (marked reaccept_required but NOT YET effective -- publication is not
-- applicability); v3 (effective, but its retained bytes do NOT hash to its
-- recorded digest -- UNPRESENTABLE, fail closed with no fallback to v1);
-- terms_of_service v1 is ACCOUNT-class.
INSERT INTO public.legal_instrument_versions
  (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
VALUES
  ('${IDS.orgVersionV1}', 'commercial_terms', 1, 'es', '${ORG_V1_DIGEST}', '${ORG_V1_TEXT.replace(/'/g, "''")}', false, now() - interval '30 days', '${IDS.platformSuperAdmin}', now() - interval '30 days'),
  ('${IDS.orgVersionV2Pre}', 'commercial_terms', 2, 'es', '${ORG_V2_DIGEST}', '${ORG_V2_TEXT.replace(/'/g, "''")}', true, now() + interval '365 days', '${IDS.platformSuperAdmin}', now()),
  ('${IDS.accountVersionV1}', 'terms_of_service', 1, 'es', '${ACCOUNT_V1_DIGEST}', NULL, false, NULL, '${IDS.platformSuperAdmin}', now() - interval '30 days');
`

/**
 * Roles + baseline migration units + hosted-fidelity shims -- schema and
 * policies only, with NO legal_instruments, legal_instrument_versions,
 * organization_commercial_acceptances or tenant row of any kind.
 *
 * Exported separately so a caller that needs a genuinely EMPTY required
 * registry has a named entry point: legal_instrument_versions and
 * organization_commercial_acceptances are append-only (RLS write-closed plus a
 * BEFORE UPDATE OR DELETE trigger that binds even the owner), so a registry
 * that starts populated can never be emptied again on the same database.
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

/** Baseline + tenant/registry fixture, with NO acceptance row yet. */
export function buildSetupManifest(): SetupManifest {
  return { statements: [...buildBaselineOnlyStatements(), TENANT_FIXTURE] }
}

/**
 * Baseline + fixture + the two acceptances the HISTORY controls need, written
 * THROUGH RLS as the accepting admins themselves -- the only way this table is
 * ever legitimately written.
 */
export function buildSetupManifestWithAcceptances(): SetupManifest {
  const statements = [...buildBaselineOnlyStatements(), TENANT_FIXTURE]

  // Org C's founding admin accepts, and then loses the role entirely. The
  // acceptance must survive (I-T4-7, HISTORY-former-admin-passes).
  statements.push(
    asUser(IDS.formerAdmin) +
      `INSERT INTO public.organization_commercial_acceptances
     (organization_id, instrument_key, instrument_version_id, content_digest, accepted_by_user_id, accepted_by_role)
   VALUES ('${IDS.orgC}', 'commercial_terms', '${IDS.orgVersionV1}', '${ORG_V1_DIGEST}', '${IDS.formerAdmin}', 'organization_admin');
COMMIT;`
  )
  // Demote the former admin to viewer AND deactivate the membership. Done as
  // the owner, because membership administration is not what is under test
  // here -- what is under test is that the ACCEPTANCE does not move.
  statements.push(
    `UPDATE public.organization_members SET role = 'viewer' WHERE organization_id = '${IDS.orgC}' AND user_id = '${IDS.formerAdmin}';`
  )

  return { statements }
}
