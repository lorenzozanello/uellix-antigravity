// tests/postgres/ce3-acl-hardening.pg.test.ts
//
// CE-3 (HPO-ODS-W2-32) — the SIX required controls for the entitlement_grants /
// entitlement_effective ACL hardening unit, discharging the node authority
// amendment v1.0.2's new real-PostgreSQL probe family PG-CE3-ACL-HARDENING:
//
//   CE3-ACL-P-1   HOSTED_SHAPED_ACL_HARDENING_PACKAGE_APPLIED_AND_EXACT
//   CE3-ACL-N-1   TENANT_ROLE_DIRECT_TABLE_ACCESS_REFUSED
//   CE3-ACL-N-2   PLATFORM_BYPASSRLS_ROLE_DIRECT_ACCESS_REFUSED_AND_CANARY_UNDISCLOSED
//   CE3-ACL-N-3   PACKAGE_REFUSES_WRONG_GRANTOR_NOOP_REVOKE_AND_UNEXPECTED_GRANTEE
//   CE3-ACL-N-4   PACKAGE_STATEMENT_CLASS_CLOSED
//   CE3-ACL-M-1   ACL_HARDENING_PACKAGE_OMISSION_MUTATION_GOES_RED
//
// Run through the CANONICAL disposable harness scripts/db-audit-disposable.ts:
// a throwaway container on 127.0.0.1, ephemeral port, no bind mounts, teardown
// in `finally`, leftover check. NEVER staging, NEVER production, NEVER the
// canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently passed —
// otherwise. CE3-ACL-N-4 is a STATIC control and runs UNGATED, and so does the
// anti-skip self-check at the foot of this file.
//
// ---------------------------------------------------------------------------
// WHY THE SUBSTRATE IS THE CONTROL, AND NOT A DETAIL OF IT
// ---------------------------------------------------------------------------
// `pg_default_acl` is DATABASE-SCOPED. MEASURED on the pinned image: the rows
// live in the image's `postgres` database, `template1` carries NONE, and a
// database created with `CREATE DATABASE` — which is exactly what this harness
// does — inherits NONE, so a table created in it is born with `relacl = NULL`.
//
// On such a substrate `authenticated` and `service_role` hold NOTHING on
// entitlement_grants and THE DEFECT DOES NOT EXIST. Every exactness assertion
// in CE3-ACL-P-1 would pass with stella_hosted_0010 ABSENT, because
// correct-by-absence-of-the-defect is indistinguishable in the post-state from
// correct-by-hardening. That is precisely what CE3-ACL-M-1's substrate arm
// exists to detect, and it is why this file INSTALLS the hosted default
// privileges and READS THEM BACK from pg_default_acl as a measured assertion
// before the baseline runs, rather than hoping the image supplies them.
//
// The four frozen substrate requirements, none of them advisory:
//   (1) reproduce the hosted pg_default_acl rows for the baseline-applier role
//       in schema public, and MEASURE them by reading pg_default_acl back
//       BEFORE the baseline is applied;
//   (2) create public.entitlement_grants by the ACTUAL baseline-applier
//       identity — here `postgres`, exactly as on the managed platform;
//   (3) do NOT re-home public.entitlement_grants to uellix_owner;
//   (4) apply the REAL bytes of stella_hosted_0009 BEFORE the REAL bytes of
//       stella_hosted_0010.
//
// The container IMAGE is not frozen; the MEASURED pg_default_acl content is.
// This file uses the certification image because it also supplies the role
// shape the controls depend on — MEASURED on it, `postgres` is NOSUPERUSER but
// BYPASSRLS, and `service_role` is BYPASSRLS, which is what makes CE3-ACL-N-2
// non-vacuous and CE3-ACL-N-3's wrong-grantor arrangement reachable at all. A
// superuser applier could SET ROLE to anything and the standing guard could
// never be shown to refuse.
//
// ---------------------------------------------------------------------------
// WHY THE EXISTING CE-3 FIXTURE IS NOT REUSED
// ---------------------------------------------------------------------------
// tests/postgres/ce3-entitlement-grants-fixtures.ts re-homes ALL public tables
// to uellix_owner in a loop and separately performs stella_hosted_0009's
// ownership transfer itself. Both are correct for the probes that fixture
// serves and both are disqualifying here: (3) forbids the re-home, and (4)
// requires the REAL 0009 bytes rather than a transcription of what they do.
// That file is also owned by the CE-3 R4 lane and is not this act's to edit, so
// this host builds its own hosted-shaped substrate rather than narrowing
// someone else's.

import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import {
  PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP,
  PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING,
  sha256OfPreparedSql,
} from '@/db/hosted/prechain-ownership'
import {
  runDisposableHarness,
  type HarnessOutcome,
  type ProbeManifest,
  type SetupManifest,
} from '../../scripts/db-audit-disposable'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = process.cwd()

/**
 * The certification image, and NOT scripts/db-audit-disposable.ts's
 * DEFAULT_IMAGE. That default is postgres:16-alpine, which carries neither the
 * platform default privileges nor the anon / authenticated / service_role role
 * shape, so a run on it would satisfy the letter of "a real PostgreSQL probe"
 * while measuring a substrate the defect never existed on.
 */
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143'

const HOSTED_0009_SQL = PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP.sourceFile
const HOSTED_0010_SQL = PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING.sourceFile

const FN_SIG = 'public.entitlement_effective(uuid,varchar)'

// ---------------------------------------------------------------------------
// SENTINELS. Declared by the companion test manifest amendment v1.0.2 and used
// here as the KNOWN-POSITIVE instruments the controls name. Each is
// unmistakably synthetic and none is ever applied to a governed target.
// ---------------------------------------------------------------------------

/** The sibling-organization row CE3-ACL-N-2 proves is never disclosed. */
const SENTINEL_SIBLING_ORG_CANARY_ROW = 'SENTINEL_SIBLING_ORG_CANARY_ROW'

/** The synthetic third grantee CE3-ACL-N-3 arrangement (c) plants. */
const SENTINEL_ACL_UNEXPECTED_GRANTEE = 'sentinel_acl_unexpected_grantee'

/**
 * A synthetic, NEVER-EXECUTED SQL string carrying a GRANT on the governed
 * relation, plus a dynamic-SQL variant. It is the KNOWN-POSITIVE instrument for
 * CE3-ACL-N-4: a scanner that reports the package REVOKE-only without having
 * been shown to flag this has proven nothing, because a zero-hit result is
 * indistinguishable from a scan whose pattern matches nothing.
 *
 * It lives in a TypeScript constant and is never written to a .sql file and
 * never sent to a database, so it cannot be mistaken for package bytes.
 */
const SENTINEL_DETECTOR_POSITIVE_GRANT_STATEMENT = [
  '-- synthetic, never executed',
  'DO $$ BEGIN',
  '  GRANT SELECT ON TABLE public.entitlement_grants TO authenticated;',
  '  EXECUTE format($f$ REVOKE ALL ON TABLE %I FROM anon $f$, rel);',
  'END $$;',
].join('\n')

/**
 * A REVOKE-only string superficially similar to the package. It is the
 * KNOWN-NEGATIVE instrument: a detector that flags everything is as useless as
 * one that flags nothing, and only a detector shown to pass this AND flag the
 * sentinel above has been shown to discriminate.
 */
const SENTINEL_DETECTOR_NEGATIVE_REVOKE_ONLY = [
  '-- synthetic, never executed',
  'SET search_path = public;',
  'DO $$ BEGIN',
  '  REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM authenticated;',
  '  SET LOCAL ROLE uellix_owner;',
  '  REVOKE ALL PRIVILEGES ON FUNCTION public.entitlement_effective(uuid, varchar) FROM anon;',
  '  RESET ROLE;',
  'END $$;',
].join('\n')

// ---------------------------------------------------------------------------
// The substrate.
// ---------------------------------------------------------------------------

/**
 * The cluster roles the two frozen contracts name.
 *
 * anon, authenticated, service_role and postgres already exist on the
 * certification image and are NOT re-created or ALTERed here — in particular
 * service_role's BYPASSRLS is the platform's, not this file's, which is what
 * lets CE3-ACL-N-2 assert it from pg_roles as a measured fact rather than as a
 * property the fixture arranged for itself. The uellix_* roles do not exist on
 * a bare image and are created NOSUPERUSER / NOBYPASSRLS.
 */
const ROLE_PRELUDE = `
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN CREATE ROLE uellix_owner NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN CREATE ROLE uellix_writer NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN CREATE ROLE uellix_auditor NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN CREATE ROLE uellix_migrator NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN CREATE ROLE uellix_app NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS; END IF;
END $r$;
-- The membership stella_hosted_0000 establishes on managed Supabase, in the
-- same shape: SET TRUE so an administrative session can act as the owner,
-- INHERIT FALSE so it does not do so implicitly. Both halves are load-bearing
-- for stella_hosted_0009 and for hosted0010's ARM 2.
GRANT uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE;
-- PostgreSQL requires the NEW owner of a function to hold CREATE on its schema,
-- which is what stella_hosted_0009 PRE-9 refuses without.
GRANT CREATE, USAGE ON SCHEMA public TO uellix_owner;
`

/**
 * SUBSTRATE ARM (1). The hosted platform's own default privileges for the
 * baseline applier in schema public, reproduced and then READ BACK.
 *
 * MEASURED on a pristine container from the pinned image, these are exactly the
 * rows it ships in its `postgres` database:
 *
 *   r: {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
 *   f: {postgres=X,        anon=X,        authenticated=X,        service_role=X}
 *
 * `anon` is granted here and NOT withheld, because withholding it would be this
 * fixture pre-performing migration 0033's work. 0033 line 8 issues
 * `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon`
 * and the baseline is what must be seen to do it — which is why the read-back
 * below runs BEFORE the baseline and the post-baseline shape is asserted
 * separately.
 */
const HOSTED_DEFAULT_PRIVILEGES = `
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`

/** The evidence table the setup writes into and the probes read back. */
const EVIDENCE_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ce3_probe;
CREATE TABLE IF NOT EXISTS ce3_probe.evidence (k text PRIMARY KEY, v text NOT NULL);
`

/**
 * SUBSTRATE ARM (1), the MEASUREMENT half. Reads pg_default_acl back and
 * REFUSES if the rows are not there, so a substrate that silently failed to
 * install them cannot be mistaken for one where the defect is absent.
 *
 * This is the assertion CE3-ACL-M-1's substrate arm turns RED.
 */
const DEFAULT_ACL_READBACK = `
DO $d$
DECLARE tables_acl text; functions_acl text;
BEGIN
  SELECT d.defaclacl::text INTO tables_acl
  FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres' AND d.defaclobjtype = 'r';

  SELECT d.defaclacl::text INTO functions_acl
  FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres' AND d.defaclobjtype = 'f';

  IF tables_acl IS NULL OR functions_acl IS NULL THEN
    RAISE EXCEPTION 'SUBSTRATE NOT HOSTED-SHAPED: pg_default_acl carries no TABLES/FUNCTIONS row for role postgres in schema public (tables=%, functions=%). A database created by CREATE DATABASE inherits none, so on this substrate a new table is born with relacl = NULL, authenticated and service_role hold nothing, and the defect stella_hosted_0010 closes DOES NOT EXIST. Every exactness assertion would then pass with the package absent.', coalesce(tables_acl, '(none)'), coalesce(functions_acl, '(none)');
  END IF;

  IF tables_acl NOT LIKE '%authenticated=arwdDxtm/postgres%' OR tables_acl NOT LIKE '%service_role=arwdDxtm/postgres%' THEN
    RAISE EXCEPTION 'SUBSTRATE NOT HOSTED-SHAPED: the TABLES default is [%], which does not carry the platform grants to authenticated and service_role.', tables_acl;
  END IF;

  INSERT INTO ce3_probe.evidence(k, v) VALUES
    ('HOSTED_DEFAULT_ACL_TABLES_PRE_BASELINE', tables_acl),
    ('HOSTED_DEFAULT_ACL_FUNCTIONS_PRE_BASELINE', functions_acl)
  ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;

  RAISE NOTICE 'ce3-acl substrate: pg_default_acl READ BACK before the baseline. tables=% functions=%', tables_acl, functions_acl;
END $d$;
`

/**
 * The G2 environment prerequisite. Mirrors tests/postgres/disposable-db.ts: no
 * baseline unit creates public.stella_suggestion_decisions, but 0044 installs a
 * trigger on it, so a baseline-only provision stops there without this.
 */
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
 * The sibling-organization canary. One real grant row in an organization the
 * tenant under test has nothing to do with, carrying
 * SENTINEL_SIBLING_ORG_CANARY_ROW in its `reason`.
 *
 * source = 'PLATFORM_ADMIN' so the frozen CHECK constraints are satisfied
 * without a commercial_accounts row: the commercial-basis-forbidden constraint
 * requires commercial_account_id IS NULL for that source, which is exactly what
 * a fixture row should be.
 */
const CANARY_FIXTURE = `
INSERT INTO public.organizations (id, name, slug)
VALUES ('11111111-1111-4111-8111-111111111111', 'CE3 ACL sibling org', 'ce3-acl-sibling-org')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.entitlement_grants
  (organization_id, capability_key, source, limit_kind, effective_from, reason)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'ce3.acl.probe', 'PLATFORM_ADMIN', 'UNMETERED', now() - interval '1 day', '${SENTINEL_SIBLING_ORG_CANARY_ROW}');
`

/**
 * SUBSTRATE ARMS (2) and (3), MEASURED rather than arranged, plus the
 * pre-hardening defect proof.
 *
 * THE DEFECT MUST BE OBSERVABLE BEFORE THE PACKAGE RUNS. If the substrate
 * arrives already hardened this block RAISEs and the whole harness fails —
 * because a run that cannot see the defect cannot attribute its absence
 * afterwards to the package.
 *
 * The destructive half is TRANSACTIONALLY ISOLATED in a plpgsql subtransaction:
 * a successful TRUNCATE is rolled back by the RAISE that follows it, so the
 * relation and its canary survive intact for the probes. Distinguishing the two
 * outcomes by SQLSTATE — 42501 versus the synthetic raise — is what makes this
 * a measurement of the PRIVILEGE rather than of a row count.
 */
const PRE_HARDENING_MEASUREMENT = `
DO $p$
DECLARE
  tbl_owner      text;
  tbl_acl        text;
  fn_acl         text;
  truncate_result text;
  select_result   text;
  canary_seen     text;
BEGIN
  SELECT pg_get_userbyid(c.relowner), coalesce(c.relacl::text, '(null)')
    INTO tbl_owner, tbl_acl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants';

  SELECT coalesce(p.proacl::text, '(null)') INTO fn_acl
  FROM pg_proc p WHERE p.oid = 'public.entitlement_effective(uuid,varchar)'::regprocedure;

  -- SUBSTRATE ARM (2): created by the ACTUAL baseline applier.
  IF tbl_owner <> 'postgres' THEN
    RAISE EXCEPTION 'SUBSTRATE NOT HOSTED-SHAPED: public.entitlement_grants is owned by % rather than by the baseline applier postgres.', tbl_owner;
  END IF;
  -- SUBSTRATE ARM (3): NOT re-homed to uellix_owner.
  IF tbl_owner = 'uellix_owner' THEN
    RAISE EXCEPTION 'SUBSTRATE NOT HOSTED-SHAPED: public.entitlement_grants was re-homed to uellix_owner, which rewrites the grantor of every inherited grant and makes the defect vanish.';
  END IF;

  -- THE DEFECT ITSELF. If it is absent there is nothing for the package to
  -- close and a green post-state would prove nothing.
  IF NOT has_table_privilege('authenticated', 'public.entitlement_grants', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SUBSTRATE ALREADY HARDENED: authenticated does not hold TRUNCATE on entitlement_grants before stella_hosted_0010 ran. ACL=[%]', tbl_acl;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.entitlement_grants', 'SELECT') THEN
    RAISE EXCEPTION 'SUBSTRATE ALREADY HARDENED: service_role does not hold SELECT on entitlement_grants before stella_hosted_0010 ran. ACL=[%]', tbl_acl;
  END IF;

  -- D1, EXERCISED rather than inferred from the ACL: can a tenant role actually
  -- empty the relation? Rolled back either way.
  BEGIN
    SET LOCAL ROLE authenticated;
    TRUNCATE public.entitlement_grants;
    RAISE EXCEPTION 'CE3_ACL_PROBE_ROLLBACK';
  EXCEPTION
    WHEN insufficient_privilege THEN truncate_result := 'REFUSED_42501';
    WHEN raise_exception THEN truncate_result := 'SUCCEEDED';
  END;
  RESET ROLE;

  -- D1, the read arm: RLS returns an EMPTY SET rather than 42501, which is the
  -- precise reason an empty result may never be used as evidence of refusal.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.entitlement_grants;
    select_result := 'PERMITTED_NO_42501';
  EXCEPTION
    WHEN insufficient_privilege THEN select_result := 'REFUSED_42501';
  END;
  RESET ROLE;

  -- D2: the BYPASSRLS platform role reads the sibling organization's row.
  BEGIN
    SET LOCAL ROLE service_role;
    SELECT max(g.reason) INTO canary_seen
    FROM public.entitlement_grants g WHERE g.reason = '${SENTINEL_SIBLING_ORG_CANARY_ROW}';
  EXCEPTION
    WHEN insufficient_privilege THEN canary_seen := 'REFUSED_42501';
  END;
  RESET ROLE;

  IF truncate_result <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'SUBSTRATE ALREADY HARDENED: authenticated could not TRUNCATE entitlement_grants before hardening (got %).', truncate_result;
  END IF;
  IF canary_seen IS DISTINCT FROM '${SENTINEL_SIBLING_ORG_CANARY_ROW}' THEN
    RAISE EXCEPTION 'SUBSTRATE ALREADY HARDENED: service_role could not read the sibling-organization canary before hardening (got %).', coalesce(canary_seen, '(null)');
  END IF;

  INSERT INTO ce3_probe.evidence(k, v) VALUES
    ('ENTITLEMENT_GRANTS_OWNER_PRE', tbl_owner),
    ('PRE_HARDENING_TABLE_ACL', tbl_acl),
    ('PRE_HARDENING_FUNCTION_ACL', fn_acl),
    ('PRE_HARDENING_AUTHENTICATED_TRUNCATE', truncate_result),
    ('PRE_HARDENING_AUTHENTICATED_SELECT', select_result),
    ('PRE_HARDENING_SERVICE_ROLE_CANARY', canary_seen)
  ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $p$;
`

/**
 * The UNCHANGED-object capture, taken AFTER stella_hosted_0009 and BEFORE
 * stella_hosted_0010.
 *
 * CE3-ACL-P-1 requires RLS, FORCE RLS, the policy set, the trigger set, both
 * owners and the evaluator digest to be UNCHANGED "against a pre-apply
 * capture". A probe that merely re-read those values afterwards and compared
 * them to the contract's expected values would be satisfied by a package that
 * had set them itself.
 */
const UNCHANGED_CAPTURE = `
INSERT INTO ce3_probe.evidence(k, v)
SELECT 'PRE_UNCHANGED_DIGEST', md5(
  (SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text || '/' || pg_get_userbyid(c.relowner)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants')
  || '|' ||
  (SELECT coalesce(string_agg(policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, ''), ',' ORDER BY policyname), '')
   FROM pg_policies WHERE schemaname = 'public' AND tablename = 'entitlement_grants')
  || '|' ||
  (SELECT coalesce(string_agg(t.tgname || ':' || t.tgtype::text, ',' ORDER BY t.tgname), '')
   FROM pg_trigger t WHERE t.tgrelid = 'public.entitlement_grants'::regclass AND NOT t.tgisinternal)
  || '|' ||
  (SELECT pg_get_userbyid(p.proowner) || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
          p.provolatile::text || ':' || p.proparallel::text || ':' || p.proleakproof::text || ':' ||
          coalesce(array_to_string(p.proconfig, ','), '-')
   FROM pg_proc p WHERE p.oid = 'public.entitlement_effective(uuid,varchar)'::regprocedure))
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
`

/** The same expression, re-evaluated. Compared to the capture by a probe. */
const UNCHANGED_COMPARISON_SQL = UNCHANGED_CAPTURE.replace(
  "INSERT INTO ce3_probe.evidence(k, v)\nSELECT 'PRE_UNCHANGED_DIGEST', md5(",
  'SELECT md5(',
).replace('\nON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;', '')

function unitStatement(unit: (typeof BASELINE_UNITS)[number]): string {
  return `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` + readFileSync(path.join(ROOT, unit.file), 'utf8')
}

/**
 * Applies a prepared package's REAL bytes with psql -1 semantics.
 *
 * The harness runs each setup statement WITHOUT -1, and the hosted packages
 * keep their pre-state in transaction-local set_config(..., true) settings that
 * do not survive statement-by-statement application — stella_hosted_0009 and
 * stella_hosted_0010 both REFUSE in that case rather than comparing a value
 * they have just re-read. Wrapping the file in an explicit BEGIN/COMMIT is
 * EXACTLY what `psql -1` does, and the package bytes themselves are passed
 * through unmodified: this is a transaction boundary, not an edit.
 */
function applyPackage(relativePath: string): string {
  return `BEGIN;\n${readFileSync(path.join(ROOT, relativePath), 'utf8')}\nCOMMIT;\n`
}

interface SubstrateOptions {
  /** false removes the pg_default_acl reproduction — CE3-ACL-M-1's substrate arm. */
  readonly hostedShaped: boolean
  /** false omits stella_hosted_0010 entirely — CE3-ACL-M-1's omission arm. */
  readonly applyHosted0010: boolean
}

function buildSetup(options: SubstrateOptions): SetupManifest {
  const statements: string[] = [EVIDENCE_SCHEMA, ROLE_PRELUDE]
  if (options.hostedShaped) {
    statements.push(HOSTED_DEFAULT_PRIVILEGES)
  }
  // The read-back runs in BOTH arms, deliberately. In the fixture-shaped arm it
  // is the assertion that goes RED, and a harness that simply skipped it there
  // would be hiding the very difference the mutation exists to expose.
  statements.push(DEFAULT_ACL_READBACK)
  statements.push(readFileSync(path.join(ROOT, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) statements.push(unitStatement(unit))
  statements.push(CANARY_FIXTURE)
  // SUBSTRATE ARM (4): the REAL 0009 bytes, before the REAL 0010 bytes.
  statements.push(applyPackage(HOSTED_0009_SQL))
  statements.push(PRE_HARDENING_MEASUREMENT)
  statements.push(UNCHANGED_CAPTURE)
  if (options.applyHosted0010) {
    statements.push(applyPackage(HOSTED_0010_SQL))
  }
  return { statements }
}

/** Reads one evidence key, failing the probe when it is missing. */
const requireEvidence = (key: string, expected: string) => `
DO $e$ DECLARE got text; BEGIN
  SELECT v INTO got FROM ce3_probe.evidence WHERE k = '${key}';
  IF got IS DISTINCT FROM '${expected}' THEN
    RAISE EXCEPTION '% is [%], expected [%]', '${key}', coalesce(got, '(absent)'), '${expected}';
  END IF;
END $e$;`

function buildProbes(): ProbeManifest {
  const probes: { id: string; sql: string }[] = []
  const add = (id: string, sql: string) => probes.push({ id, sql })

  // -------------------------------------------------------------------------
  // CE3-ACL-P-1 — the substrate assertions. LOAD-BEARING, not a separate
  // concern: without them the exactness assertions below are satisfiable on a
  // substrate where the defect never existed.
  // -------------------------------------------------------------------------
  add('p1-substrate-default-acl-readback', `
DO $$ DECLARE tables_acl text; BEGIN
  SELECT v INTO tables_acl FROM ce3_probe.evidence WHERE k = 'HOSTED_DEFAULT_ACL_TABLES_PRE_BASELINE';
  IF tables_acl IS NULL THEN
    RAISE EXCEPTION 'no pg_default_acl read-back was recorded before the baseline: the substrate is not hosted-shaped';
  END IF;
  IF tables_acl NOT LIKE '%authenticated=arwdDxtm/postgres%' THEN
    RAISE EXCEPTION 'the recorded TABLES default [%] does not carry the platform grant to authenticated', tables_acl;
  END IF;
END $$;`)

  add('p1-substrate-owner-is-baseline-applier', `
${requireEvidence('ENTITLEMENT_GRANTS_OWNER_PRE', 'postgres')}
DO $$ DECLARE o text; BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants';
  IF o = 'uellix_owner' THEN RAISE EXCEPTION 'entitlement_grants is re-homed to uellix_owner; the substrate is fixture-shaped'; END IF;
  IF o <> 'postgres' THEN RAISE EXCEPTION 'entitlement_grants owner is % rather than the baseline applier postgres', o; END IF;
END $$;`)

  add('p1-pre-hardening-defect-was-observable', `
${requireEvidence('PRE_HARDENING_AUTHENTICATED_TRUNCATE', 'SUCCEEDED')}
${requireEvidence('PRE_HARDENING_AUTHENTICATED_SELECT', 'PERMITTED_NO_42501')}
${requireEvidence('PRE_HARDENING_SERVICE_ROLE_CANARY', SENTINEL_SIBLING_ORG_CANARY_ROW)}`)

  // -------------------------------------------------------------------------
  // CE3-ACL-P-1 — exactness, read through aclexplode as the exact SET.
  // -------------------------------------------------------------------------
  add('p1-nonowner-table-acl-exact', `
DO $$ DECLARE observed text; owner_name text; BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants';
  SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '') INTO observed FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants'
      AND coalesce(g.rolname, 'PUBLIC') <> owner_name
  ) x;
  IF observed <> 'uellix_owner:SELECT' THEN
    RAISE EXCEPTION 'non-owner TABLE ACL is [%], not the frozen {(uellix_owner, SELECT)}', observed;
  END IF;
END $$;`)

  add('p1-nonowner-function-execute-exact', `
DO $$ DECLARE observed text; BEGIN
  SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '') INTO observed FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE p.oid = '${FN_SIG}'::regprocedure
      AND coalesce(g.rolname, 'PUBLIC') <> pg_get_userbyid(p.proowner)
  ) x;
  IF observed <> 'authenticated:EXECUTE' THEN
    RAISE EXCEPTION 'non-owner EXECUTE ACL is [%], not the frozen {authenticated}', observed;
  END IF;
END $$;`)

  add('p1-security-objects-unchanged-against-capture', `
DO $$ DECLARE captured text; observed text; BEGIN
  SELECT v INTO captured FROM ce3_probe.evidence WHERE k = 'PRE_UNCHANGED_DIGEST';
  IF captured IS NULL THEN RAISE EXCEPTION 'no pre-apply capture was recorded, so "unchanged" cannot be evaluated'; END IF;
  ${UNCHANGED_COMPARISON_SQL.trim()} INTO observed;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'RLS, FORCE RLS, the policy set, the trigger set, an owner or the evaluator digest CHANGED across the hardening';
  END IF;
END $$;`)

  add('p1-evaluator-owner-and-definer-preserved', `
DO $$ DECLARE o text; secdef boolean; BEGIN
  SELECT pg_get_userbyid(p.proowner), p.prosecdef INTO o, secdef
  FROM pg_proc p WHERE p.oid = '${FN_SIG}'::regprocedure;
  IF o <> 'uellix_owner' THEN RAISE EXCEPTION 'evaluator owner is % rather than uellix_owner', o; END IF;
  IF NOT secdef THEN RAISE EXCEPTION 'evaluator is no longer SECURITY DEFINER'; END IF;
END $$;`)

  // -------------------------------------------------------------------------
  // PROBE ORDER IS LOAD-BEARING FROM HERE, AND IT IS NOT A STYLE CHOICE.
  //
  // Probes run SEQUENTIALLY against the SAME database, and two of them below
  // APPLY the package in order to prove idempotent convergence. Every probe
  // that measures the UNHARDENED state must therefore run BEFORE the first
  // probe that applies the package — otherwise CE3-ACL-M-1's omission arm
  // hardens itself halfway through its own run and the mutation silently
  // undoes itself.
  //
  // MEASURED, and not hypothetically: with the idempotency probes ordered
  // FIRST, the omission arm reported n1 and n2 GREEN with stella_hosted_0010
  // omitted from the substrate — because the idempotency probe had applied it.
  // The mutation control caught it. The order below is the fix, and it is kept
  // rather than solved by building a different probe set per arm, so that the
  // two arms stay byte-identical in their probes and the ONLY difference
  // between them is the substrate.
  //
  // CE3-ACL-N-1 — every refusal asserted on SQLSTATE 42501, never on an empty
  // result or a zero row count, and the row count asserted unchanged after all
  // five attempts.
  // -------------------------------------------------------------------------
  add('n1-authenticated-five-refusals-42501', `
DO $$
DECLARE
  rows_before bigint;
  rows_after  bigint;
  results     text := '';
  caught      text;
BEGIN
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'authenticated has rolbypassrls = true; a refusal measured against it would not be measuring the privilege';
  END IF;
  SELECT count(*) INTO rows_before FROM public.entitlement_grants;

  BEGIN SET LOCAL ROLE authenticated; PERFORM 1 FROM public.entitlement_grants; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; END; RESET ROLE;
  results := results || 'SELECT=' || caught || ' ';

  BEGIN SET LOCAL ROLE authenticated;
    INSERT INTO public.entitlement_grants (organization_id, capability_key, source, limit_kind, effective_from)
    VALUES ('11111111-1111-4111-8111-111111111111','ce3.acl.n1','PLATFORM_ADMIN','UNMETERED', now()); caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'INSERT=' || caught || ' ';

  BEGIN SET LOCAL ROLE authenticated; UPDATE public.entitlement_grants SET reason = 'x'; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'UPDATE=' || caught || ' ';

  BEGIN SET LOCAL ROLE authenticated; DELETE FROM public.entitlement_grants; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'DELETE=' || caught || ' ';

  BEGIN SET LOCAL ROLE authenticated; TRUNCATE public.entitlement_grants; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'TRUNCATE=' || caught;

  IF results <> 'SELECT=42501 INSERT=42501 UPDATE=42501 DELETE=42501 TRUNCATE=42501' THEN
    RAISE EXCEPTION 'authenticated was not refused with 42501 on all five: [%]', results;
  END IF;

  SELECT count(*) INTO rows_after FROM public.entitlement_grants;
  IF rows_after <> rows_before THEN
    RAISE EXCEPTION 'the relation row count moved from % to % across the five attempts', rows_before, rows_after;
  END IF;
  IF rows_before = 0 THEN
    RAISE EXCEPTION 'the relation is EMPTY, so an unchanged row count would be satisfied by a TRUNCATE that succeeded';
  END IF;
END $$;`)

  // -------------------------------------------------------------------------
  // CE3-ACL-N-2 — the BYPASSRLS arm. rolbypassrls is asserted TRUE so that RLS
  // is known NOT to be the protecting mechanism: a service_role created without
  // it would be refused by row-level security for the wrong reason.
  // -------------------------------------------------------------------------
  add('n2-service-role-refused-and-canary-undisclosed', `
DO $$
DECLARE caught text; results text := ''; disclosed text;
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'service_role does not have rolbypassrls = true, so this control would be measuring RLS rather than the absence of the privilege';
  END IF;

  BEGIN SET LOCAL ROLE service_role; PERFORM 1 FROM public.entitlement_grants; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; END; RESET ROLE;
  results := results || 'SELECT=' || caught || ' ';

  BEGIN SET LOCAL ROLE service_role;
    INSERT INTO public.entitlement_grants (organization_id, capability_key, source, limit_kind, effective_from)
    VALUES ('11111111-1111-4111-8111-111111111111','ce3.acl.n2','PLATFORM_ADMIN','UNMETERED', now()); caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'INSERT=' || caught || ' ';

  BEGIN SET LOCAL ROLE service_role; UPDATE public.entitlement_grants SET reason = 'x'; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'UPDATE=' || caught || ' ';

  BEGIN SET LOCAL ROLE service_role; DELETE FROM public.entitlement_grants; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'DELETE=' || caught || ' ';

  BEGIN SET LOCAL ROLE service_role; TRUNCATE public.entitlement_grants; caught := 'PERMITTED';
  EXCEPTION WHEN insufficient_privilege THEN caught := '42501'; WHEN OTHERS THEN caught := 'OTHER:' || SQLSTATE; END; RESET ROLE;
  results := results || 'TRUNCATE=' || caught;

  IF results <> 'SELECT=42501 INSERT=42501 UPDATE=42501 DELETE=42501 TRUNCATE=42501' THEN
    RAISE EXCEPTION 'service_role was not refused with 42501 on all five: [%]', results;
  END IF;

  -- THE CANARY IS STILL THERE TO BE DISCLOSED, read as the owner. Without this
  -- the "not disclosed" assertion would be satisfied by a row that no longer
  -- exists.
  SELECT max(reason) INTO disclosed FROM public.entitlement_grants WHERE reason = '${SENTINEL_SIBLING_ORG_CANARY_ROW}';
  IF disclosed IS DISTINCT FROM '${SENTINEL_SIBLING_ORG_CANARY_ROW}' THEN
    RAISE EXCEPTION 'the sibling-organization canary row is absent, so "service_role did not see it" proves nothing';
  END IF;

  -- AND THE FUNCTION ARM: no EXECUTE for service_role, anon or PUBLIC.
  IF has_function_privilege('service_role', '${FN_SIG}', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role still holds EXECUTE on the evaluator';
  END IF;
  IF has_function_privilege('anon', '${FN_SIG}', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on the evaluator';
  END IF;
  IF has_function_privilege('public', '${FN_SIG}', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on the evaluator';
  END IF;
END $$;`)

  // -------------------------------------------------------------------------
  // CE3-ACL-P-1 — IDEMPOTENT CONVERGENCE. A second application of the REAL
  // bytes must PASS every precondition, issue ZERO REVOKEs and leave identical
  // catalogs. The zero is read from the package's own transaction-local
  // counter, so "it issued none" is measured rather than inferred from the ACL
  // not having moved — which a package that revoked and re-granted would also
  // satisfy.
  // -------------------------------------------------------------------------
  add('p1-idempotent-second-apply-zero-revokes', `
DO $$ DECLARE before_t text; before_f text; BEGIN
  SELECT coalesce(c.relacl::text,'') INTO before_t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='entitlement_grants';
  SELECT coalesce(p.proacl::text,'') INTO before_f FROM pg_proc p WHERE p.oid='${FN_SIG}'::regprocedure;
  INSERT INTO ce3_probe.evidence(k,v) VALUES ('SECOND_APPLY_TABLE_ACL_BEFORE', before_t), ('SECOND_APPLY_FN_ACL_BEFORE', before_f)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
${applyPackage(HOSTED_0010_SQL)}
DO $$ DECLARE before_t text; before_f text; after_t text; after_f text; BEGIN
  SELECT v INTO before_t FROM ce3_probe.evidence WHERE k='SECOND_APPLY_TABLE_ACL_BEFORE';
  SELECT v INTO before_f FROM ce3_probe.evidence WHERE k='SECOND_APPLY_FN_ACL_BEFORE';
  SELECT coalesce(c.relacl::text,'') INTO after_t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='entitlement_grants';
  SELECT coalesce(p.proacl::text,'') INTO after_f FROM pg_proc p WHERE p.oid='${FN_SIG}'::regprocedure;
  IF after_t IS DISTINCT FROM before_t OR after_f IS DISTINCT FROM before_f THEN
    RAISE EXCEPTION 'the second application changed an ACL: table [%] -> [%], function [%] -> [%]', before_t, after_t, before_f, after_f;
  END IF;
END $$;`)

  // The ZERO-REVOKE count itself, in its own transaction so the counter the
  // package sets is still visible when it is read.
  add('p1-idempotent-second-apply-counter-is-zero', `
BEGIN;
${readFileSync(path.join(ROOT, HOSTED_0010_SQL), 'utf8')}
DO $$ DECLARE n text; BEGIN
  n := current_setting('stella_hosted_0010.revokes_issued', true);
  IF n IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'a third application against an ALREADY_HARDENED target issued % REVOKE statement(s); the contract requires ZERO, and convergence must come from the measured prestate rather than from PostgreSQL tolerating a redundant REVOKE', coalesce(n, '(unset)');
  END IF;
END $$;
COMMIT;`)

  // -------------------------------------------------------------------------
  // CE3-ACL-N-3 — the THREE controlled refusals. Each of these probes is
  // EXPECTED TO FAIL: the harness records ok=false and the assertion in this
  // file reads the governed message out of `detail`. A probe that SUCCEEDED
  // here would mean the package applied in an arrangement it is required to
  // refuse.
  //
  // Each arrangement is wrapped in BEGIN ... and the package's own RAISE aborts
  // the transaction, so the arrangement is rolled back with it and the ACL is
  // left byte-identical for the probes that follow.
  // -------------------------------------------------------------------------

  // (a) and (b) WRONG GRANTOR / NO-OP REVOKE. A grant is re-created under
  // grantor uellix_owner and the session's membership in uellix_owner is then
  // withdrawn, so a naive REVOKE issued as postgres would warn and change
  // nothing. The naive REVOKE is issued FIRST, in the same transaction, to
  // prove the hazard is real rather than hypothetical — and then the package is
  // asked to act, and must REFUSE rather than report success.
  add('n3a-wrong-grantor-refused-before-mutation', `
BEGIN;
SET LOCAL ROLE uellix_owner;
GRANT EXECUTE ON FUNCTION public.entitlement_effective(uuid, varchar) TO anon;
RESET ROLE;
-- SENTINEL_FOREIGN_GRANTOR_GRANT: the session can no longer act as the grantor.
REVOKE uellix_owner FROM postgres;
DO $$ DECLARE acl_before text; acl_after text; BEGIN
  SELECT proacl::text INTO acl_before FROM pg_proc WHERE oid = '${FN_SIG}'::regprocedure;
  -- THE NAIVE REVOKE, issued by a non-grantor. PostgreSQL warns and commits.
  REVOKE EXECUTE ON FUNCTION public.entitlement_effective(uuid, varchar) FROM anon;
  SELECT proacl::text INTO acl_after FROM pg_proc WHERE oid = '${FN_SIG}'::regprocedure;
  IF acl_after IS DISTINCT FROM acl_before THEN
    RAISE EXCEPTION 'ARRANGEMENT INVALID: the naive REVOKE actually worked, so this arrangement does not reproduce the no-op hazard';
  END IF;
  RAISE NOTICE 'NOOP_REVOKE_DETECTION: a REVOKE issued by a non-grantor left the ACL byte-identical at [%]', acl_after;
END $$;
${readFileSync(path.join(ROOT, HOSTED_0010_SQL), 'utf8')}
COMMIT;`)

  // (c) UNEXPECTED THIRD GRANTEE.
  add('n3c-unexpected-grantee-refused', `
BEGIN;
CREATE ROLE ${SENTINEL_ACL_UNEXPECTED_GRANTEE} NOLOGIN;
GRANT SELECT ON TABLE public.entitlement_grants TO ${SENTINEL_ACL_UNEXPECTED_GRANTEE};
${readFileSync(path.join(ROOT, HOSTED_0010_SQL), 'utf8')}
COMMIT;`)

  // (c-bis) PUBLIC EXECUTE on the evaluator.
  add('n3c2-public-execute-refused', `
BEGIN;
SET LOCAL ROLE uellix_owner;
GRANT EXECUTE ON FUNCTION public.entitlement_effective(uuid, varchar) TO PUBLIC;
RESET ROLE;
${readFileSync(path.join(ROOT, HOSTED_0010_SQL), 'utf8')}
COMMIT;`)

  // (d) HOSTED0009 PRECEDENCE. ACL-PRE-8 is the MEASURABLE form of "0009
  // precedes 0010", and without a control over it the precondition could be
  // deleted and nothing would go red. The evaluator is temporarily handed back
  // to the baseline applier — which is exactly the state stella_hosted_0009
  // exists to close — and the package must REFUSE rather than harden a node
  // whose definer still runs as a BYPASSRLS role. Rolled back with the
  // package's own RAISE.
  add('n3d-hosted0009-precedence-refused', `
BEGIN;
-- MOVING THE OWNER TAKES BOTH HALVES OF A MEMBERSHIP, and the managed topology
-- deliberately supplies only one. postgres holds uellix_owner WITH INHERIT
-- FALSE, so as itself it is "not owner of function"; and as uellix_owner it
-- cannot reach postgres, which is "must be able to SET ROLE postgres". Both
-- failures happen BEFORE the package runs, and an arrangement that never
-- reaches the package would have credited it with a refusal it never issued.
-- So the arrangement hands the evaluator to a synthetic role uellix_owner IS a
-- member of, which is the one transfer this topology actually permits.
CREATE ROLE ce3_probe_other_owner NOLOGIN;
GRANT ce3_probe_other_owner TO uellix_owner;
GRANT CREATE, USAGE ON SCHEMA public TO ce3_probe_other_owner;
SET LOCAL ROLE uellix_owner;
ALTER FUNCTION public.entitlement_effective(uuid, varchar) OWNER TO ce3_probe_other_owner;
RESET ROLE;
${readFileSync(path.join(ROOT, HOSTED_0010_SQL), 'utf8')}
COMMIT;`)

  // THE KNOWN-NEGATIVE FOR ALL THREE: after every refusal above, the catalogs
  // are still the conformant ones. If an arrangement had leaked, this goes RED.
  add('n3-refusals-left-the-acl-untouched', `
DO $$ DECLARE t text; f text; BEGIN
  SELECT coalesce(c.relacl::text,'') INTO t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='entitlement_grants';
  SELECT coalesce(p.proacl::text,'') INTO f FROM pg_proc p WHERE p.oid='${FN_SIG}'::regprocedure;
  IF t NOT LIKE '%uellix_owner=r/postgres%' OR t LIKE '%authenticated=%' OR t LIKE '%service_role=%' THEN
    RAISE EXCEPTION 'the TABLE ACL was disturbed by a refusal arrangement: [%]', t;
  END IF;
  IF f NOT LIKE '%authenticated=X/uellix_owner%' OR f LIKE '%anon=%' OR f LIKE '%service_role=%' THEN
    RAISE EXCEPTION 'the FUNCTION ACL was disturbed by a refusal arrangement: [%]', f;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SENTINEL_ACL_UNEXPECTED_GRANTEE}') THEN
    RAISE EXCEPTION 'the synthetic sentinel role survived its own transaction';
  END IF;
END $$;`)

  return { probes }
}

/** The probe ids that are EXPECTED to fail, with the governed text each must carry. */
const EXPECTED_REFUSALS: ReadonlyArray<{ id: string; mustContain: string }> = [
  // THE MESSAGE ASSERTED IS THE SPECIFIC GUARD'S, NOT merely "the package
  // aborted". This package is layered — the §0 standing check, the ARM 2
  // guard and the §1 catalog re-read each independently refuse this
  // arrangement — so a control that accepted any abort would stay GREEN with
  // any ONE of the three deleted, and would be measuring the package's
  // redundancy rather than the guard it names.
  { id: 'n3a-wrong-grantor-refused-before-mutation', mustContain: 'can neither issue the REVOKE as itself nor legitimately act as that grantor' },
  { id: 'n3c-unexpected-grantee-refused', mustContain: 'UNEXPECTED non-owner grantee' },
  { id: 'n3c2-public-execute-refused', mustContain: 'UNEXPECTED non-owner grantee' },
  { id: 'n3d-hosted0009-precedence-refused', mustContain: 'rather than uellix_owner' },
]

const probeOf = (outcome: HarnessOutcome, id: string) => {
  const found = outcome.probeResults.find((p) => p.id === id)
  if (!found) throw new Error(`probe ${id} did not run; probes recorded: ${outcome.probeResults.map((p) => p.id).join(', ')}`)
  return found
}

// ---------------------------------------------------------------------------
// CE3-ACL-N-4 — the STATIC statement-class detector. UNGATED: it needs no
// database, so it runs in every suite and not only under UELLIX_PG_TESTS=1.
// ---------------------------------------------------------------------------

/**
 * A CODE-ONLY projection of a SQL file: comments stripped, string literals
 * blanked, read as ONE SEMANTIC STRING.
 *
 * READING THE FILE AS ONE STRING IS THE REQUIREMENT, not a convenience. A
 * line-by-line grep cannot see a statement split across lines, and this
 * package's own REVOKEs and RAISE messages span several. Blanking literals is
 * what stops a RAISE message that QUOTES the word GRANT from being counted as a
 * GRANT — which is the failure mode that makes a scanner look strict while
 * flagging its own prose.
 */
export function codeOnlyProjection(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    // Dollar-quoted body: $tag$ ... $tag$. Kept, because the package's real
    // statements live inside DO $$ ... $$ blocks — only the tags are consumed.
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
    if (dollar) {
      out += ' '.repeat(dollar[0].length)
      i += dollar[0].length
      continue
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j += 1; break }
        j += 1
      }
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    out += sql[i]
    i += 1
  }
  return out
}

/** The prohibited statement classes, as whole-word patterns over the projection. */
const PROHIBITED_CLASSES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'GRANT', re: /\bGRANT\b/i },
  { name: 'CREATE', re: /\bCREATE\b/i },
  { name: 'DROP', re: /\bDROP\b/i },
  { name: 'ALTER', re: /\bALTER\b/i },
  { name: 'INSERT', re: /\bINSERT\s+INTO\b/i },
  { name: 'UPDATE', re: /\bUPDATE\s+[a-z_."]+\s+SET\b/i },
  { name: 'DELETE', re: /\bDELETE\s+FROM\b/i },
  { name: 'TRUNCATE', re: /\bTRUNCATE\b/i },
  { name: 'dynamic SQL', re: /\bEXECUTE\s+format\s*\(/i },
  { name: 'dynamic SQL (EXECUTE of an expression)', re: /\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b)['a-z_$]/i },
  { name: 'schema-wide TABLES wildcard', re: /\bALL\s+TABLES\s+IN\s+SCHEMA\b/i },
  { name: 'schema-wide FUNCTIONS wildcard', re: /\bALL\s+FUNCTIONS\s+IN\s+SCHEMA\b/i },
]

export interface DetectorReport {
  readonly searchedChars: number
  readonly flagged: string[]
  readonly revokeCount: number
  readonly offTargetRevokes: string[]
  readonly setLocalRoleCount: number
  readonly resetRoleCount: number
}

export function detectStatementClasses(sql: string): DetectorReport {
  const code = codeOnlyProjection(sql)
  const flagged = PROHIBITED_CLASSES.filter((c) => c.re.test(code)).map((c) => c.name)

  // Every REVOKE, read as one semantic string so a statement wrapped across
  // lines is still one match.
  const revokes = code.match(/\bREVOKE\b[\s\S]*?;/gi) ?? []
  const offTargetRevokes = revokes.filter((r) => {
    const flat = r.replace(/\s+/g, ' ')
    return !/ON\s+TABLE\s+public\.entitlement_grants\b/i.test(flat)
      && !/ON\s+FUNCTION\s+public\.entitlement_effective\s*\(\s*uuid\s*,\s*varchar\s*\)/i.test(flat)
  })

  return {
    searchedChars: code.length,
    flagged,
    revokeCount: revokes.length,
    offTargetRevokes: offTargetRevokes.map((r) => r.replace(/\s+/g, ' ').slice(0, 120)),
    setLocalRoleCount: (code.match(/\bSET\s+LOCAL\s+ROLE\b/gi) ?? []).length,
    resetRoleCount: (code.match(/\bRESET\s+ROLE\b/gi) ?? []).length,
  }
}

describe('CE3-ACL-N-4 — the package statement class is CLOSED (static, ungated)', () => {
  const sql = readFileSync(path.join(ROOT, HOSTED_0010_SQL), 'utf8')
  const report = detectStatementClasses(sql)

  it('searched a NON-ZERO population', () => {
    // A zero-hit result is indistinguishable from a scan that read nothing.
    expect(report.searchedChars).toBeGreaterThan(10_000)
    expect(sql.length).toBeGreaterThan(10_000)
  })

  it('KNOWN POSITIVE: the detector FLAGS the sentinel GRANT and dynamic-SQL statement', () => {
    const positive = detectStatementClasses(SENTINEL_DETECTOR_POSITIVE_GRANT_STATEMENT)
    expect(positive.flagged).toContain('GRANT')
    expect(positive.flagged).toContain('dynamic SQL')
  })

  it('KNOWN NEGATIVE: the detector does NOT flag a REVOKE-only string of the same shape', () => {
    // A detector that flags everything proves as little as one that flags
    // nothing. This string carries REVOKEs, a SET LOCAL ROLE and a RESET ROLE,
    // and must come back clean.
    const negative = detectStatementClasses(SENTINEL_DETECTOR_NEGATIVE_REVOKE_ONLY)
    expect(negative.flagged).toEqual([])
    expect(negative.revokeCount).toBeGreaterThan(0)
  })

  it('the REAL package carries ZERO prohibited statement classes', () => {
    expect(report.flagged).toEqual([])
  })

  it('every REVOKE names exactly one of the two frozen target objects', () => {
    expect(report.revokeCount).toBeGreaterThan(0)
    expect(report.offTargetRevokes).toEqual([])
  })

  it('every SET LOCAL ROLE is paired with a RESET ROLE', () => {
    expect(report.setLocalRoleCount).toBeGreaterThan(0)
    expect(report.resetRoleCount).toBeGreaterThanOrEqual(report.setLocalRoleCount)
  })

  it('the file sha256 matches the registry pin through sha256OfPreparedSql', () => {
    expect(sha256OfPreparedSql(sql)).toBe(PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING.sourceSha256)
  })

  it('the package is declared FORWARD-ONLY with no rollback, and no rollback file exists', () => {
    expect(PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING.rollbackFile).toBeNull()
    expect(PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING.rollbackSha256).toBeNull()
    expect(PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING.forwardOnlyNoRollbackReason?.length ?? 0).toBeGreaterThan(400)
  })
})

// ---------------------------------------------------------------------------
// The three REAL-PostgreSQL runs.
// ---------------------------------------------------------------------------

let conformant: HarnessOutcome | null = null
let mutationOmitted: HarnessOutcome | null = null
let mutationFixtureShaped: HarnessOutcome | null = null

const HARNESS_TIMEOUT_MS = 1_800_000

describe.runIf(PG_TESTS_ENABLED)('PG-CE3-ACL-HARDENING — real PostgreSQL', () => {
  beforeAll(async () => {
    conformant = runDisposableHarness({
      image: IMAGE,
      setup: buildSetup({ hostedShaped: true, applyHosted0010: true }),
      probe: buildProbes(),
      // The certification image runs a two-phase entrypoint and needs longer to
      // reach its SERVING postmaster than the 30-attempt default allows.
      containerReadyAttempts: 240,
    })
    mutationOmitted = runDisposableHarness({
      image: IMAGE,
      setup: buildSetup({ hostedShaped: true, applyHosted0010: false }),
      probe: buildProbes(),
      containerReadyAttempts: 240,
    })
    mutationFixtureShaped = runDisposableHarness({
      image: IMAGE,
      setup: buildSetup({ hostedShaped: false, applyHosted0010: true }),
      probe: buildProbes(),
      containerReadyAttempts: 240,
    })
  }, HARNESS_TIMEOUT_MS)

  describe('the disposable lifecycle itself', () => {
    it('created, applied and DESTROYED a LOCAL throwaway target', () => {
      expect(conformant!.targetLocality).toBe('LOCAL')
      expect(conformant!.teardownStatus).toBe('SUCCESS')
      expect(conformant!.leftoverDatabaseCount).toBe(0)
      expect(conformant!.lifecycleState).toBe('VERIFIED_GONE')
    })

    it('the CONFORMANT substrate applied without a setup failure', () => {
      // setupStatus SKIPPED is the harness's INITIAL value, so asserting
      // "not FAILED" would pass on a run that never applied anything.
      expect(conformant!.setupStatus).toBe('SUCCESS')
      expect(conformant!.failureReason).toBeNull()
    })
  })

  describe('CE3-ACL-P-1 — hosted-shaped ACL hardening applied and EXACT', () => {
    it.each([
      'p1-substrate-default-acl-readback',
      'p1-substrate-owner-is-baseline-applier',
      'p1-pre-hardening-defect-was-observable',
      'p1-nonowner-table-acl-exact',
      'p1-nonowner-function-execute-exact',
      'p1-security-objects-unchanged-against-capture',
      'p1-evaluator-owner-and-definer-preserved',
      'p1-idempotent-second-apply-zero-revokes',
      'p1-idempotent-second-apply-counter-is-zero',
    ])('%s', (id) => {
      const probe = probeOf(conformant!, id)
      expect(probe.ok, `${id}: ${probe.detail ?? ''}`).toBe(true)
    })
  })

  describe('CE3-ACL-N-1 — tenant role direct table access REFUSED', () => {
    it('authenticated is refused SELECT/INSERT/UPDATE/DELETE/TRUNCATE with 42501 and the row count is unchanged', () => {
      const probe = probeOf(conformant!, 'n1-authenticated-five-refusals-42501')
      expect(probe.ok, probe.detail ?? '').toBe(true)
    })
  })

  describe('CE3-ACL-N-2 — BYPASSRLS platform role refused, canary undisclosed', () => {
    it('service_role is refused by ACL although rolbypassrls is TRUE, and never sees the sibling canary', () => {
      const probe = probeOf(conformant!, 'n2-service-role-refused-and-canary-undisclosed')
      expect(probe.ok, probe.detail ?? '').toBe(true)
    })
  })

  describe('CE3-ACL-N-3 — the package REFUSES three controlled arrangements', () => {
    it.each(EXPECTED_REFUSALS)('$id refuses with the governed message, before mutation', ({ id, mustContain }) => {
      const probe = probeOf(conformant!, id)
      // THE ASSERTION IS ON THE REFUSAL. A probe that SUCCEEDED here would mean
      // the package applied in an arrangement the contract requires it to
      // refuse, which is the defect this control exists to catch.
      expect(probe.ok, `${id} was EXPECTED to be refused by the package but it succeeded`).toBe(false)
      expect(probe.detail ?? '').toContain(mustContain)
    })

    it('the KNOWN NEGATIVE: none of the three fires on the conformant run, which left the ACL untouched', () => {
      const probe = probeOf(conformant!, 'n3-refusals-left-the-acl-untouched')
      expect(probe.ok, probe.detail ?? '').toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // CE3-ACL-M-1 — the non-vacuity control for the entire ACL contract.
  // -------------------------------------------------------------------------
  describe('CE3-ACL-M-1 — omitting the package turns P-1, N-1 and N-2 RED', () => {
    it('the mutated arrangement still provisioned: the RED is not a crash, an import error or a timeout', () => {
      expect(mutationOmitted!.setupStatus).toBe('SUCCESS')
      expect(mutationOmitted!.lifecycleState).toBe('VERIFIED_GONE')
      expect(mutationOmitted!.probeCount).toBe(conformant!.probeCount)
    })

    it.each([
      'p1-nonowner-table-acl-exact',
      'p1-nonowner-function-execute-exact',
      'n1-authenticated-five-refusals-42501',
      'n2-service-role-refused-and-canary-undisclosed',
    ])('%s goes RED with stella_hosted_0010 omitted', (id) => {
      const probe = probeOf(mutationOmitted!, id)
      expect(probe.ok, `${id} stayed GREEN without the package, so it was never grounded on it`).toBe(false)
    })

    it('and RED for the RIGHT REASONS — the ACLs are not the contracts, not an unrelated error', () => {
      expect(probeOf(mutationOmitted!, 'p1-nonowner-table-acl-exact').detail ?? '')
        .toContain('non-owner TABLE ACL is')
      expect(probeOf(mutationOmitted!, 'p1-nonowner-function-execute-exact').detail ?? '')
        .toContain('non-owner EXECUTE ACL is')
      expect(probeOf(mutationOmitted!, 'n1-authenticated-five-refusals-42501').detail ?? '')
        .toContain('authenticated was not refused with 42501')
      expect(probeOf(mutationOmitted!, 'n2-service-role-refused-and-canary-undisclosed').detail ?? '')
        .toContain('service_role was not refused with 42501')
    })

    it('the SUBSTRATE arm: a fixture-shaped substrate turns P-1 RED on its substrate assertions even WITH the package applied', () => {
      // The defect never existed there, so the exactness assertions would pass
      // and the substrate assertions are the ONLY thing standing between this
      // suite and a vacuous proof. If they stay green they are decorative.
      expect(mutationFixtureShaped!.setupStatus).toBe('FAILED')
      expect(mutationFixtureShaped!.failureReason ?? '').toContain('SUBSTRATE NOT HOSTED-SHAPED')
    })
  })
})

// ---------------------------------------------------------------------------
// ANTI-SKIP SELF-CHECK — UNGATED, so a CI lane that silently stopped running
// the real-PostgreSQL family is caught by the same suite that would otherwise
// report green. Armed by UELLIX_CE3_ACL_PG_REQUIRED=1 in the dedicated gate.
// ---------------------------------------------------------------------------
describe('the PG-CE3-ACL-HARDENING family is not silently skipped', () => {
  it('runs for real when the dedicated gate arms it', () => {
    if (process.env.UELLIX_CE3_ACL_PG_REQUIRED === '1') {
      expect(
        PG_TESTS_ENABLED,
        'UELLIX_CE3_ACL_PG_REQUIRED=1 but UELLIX_PG_TESTS is not 1: the six CE3-ACL controls would have been SKIPPED and the suite would still have reported green',
      ).toBe(true)
    } else {
      // Not armed: record the fact rather than asserting a condition that is
      // trivially true, so a reader can tell a skip from a pass.
      expect(typeof PG_TESTS_ENABLED).toBe('boolean')
    }
  })
})
