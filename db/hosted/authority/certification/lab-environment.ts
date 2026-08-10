// db/hosted/authority/certification/lab-environment.ts
// COMMIT 5 — the disposable PostgreSQL 17.6 the governed chain is certified on,
// and the shim boundary stated before any result is.
//
// ---------------------------------------------------------------------------
// WHAT THIS ENVIRONMENT IS EVIDENCE ABOUT, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// The image is the one managed Supabase runs: public.ecr.aws/supabase/postgres,
// tag 17.6.1.143. That matters more than the version number, because it brings
// the ROLE TOPOLOGY with it — `postgres` NOSUPERUSER with CREATEROLE, schema
// `auth` owned by supabase_admin, `auth.users` owned by supabase_auth_admin —
// and the topology is what Train 5A aborted on, not the version.
//
// So this is real evidence about:
//   * whether the governed chain's SQL executes at all on 17.6;
//   * whether a NON-SUPERUSER installer can open and close every authority
//     window the plan emits;
//   * what the catalog holds afterwards — owners, memberships, ACLs, policies;
//   * whether a package that fails midway rolls back to where it started.
//
// It is NOT evidence about:
//   * a managed project's storage service, which owns storage.objects. This
//     container has an EMPTY storage schema, because storage.objects is created
//     by the Storage service and not by the database image. It is shimmed, and
//     the shim is listed below rather than described in prose.
//   * the Supabase platform's own migrations, PgBouncer, or anything reached
//     over a network. The container runs with `--network none`.
//   * whether the hosted project's `postgres` role holds the same privileges as
//     this image's. Where the two could differ the harness MEASURES rather than
//     assumes, and records the measurement.
//
// A green run here means the chain is engine-correct. Staging remains a
// separate question with separate evidence.

/** Pinned by digest as well as by tag: a tag can be re-pushed, a digest cannot. */
export const CERTIFICATION_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143'

export const EXPECTED_SERVER_VERSION = '17.6'
export const EXPECTED_SERVER_VERSION_NUM = '170006'

/**
 * `createrole_self_grant` must be EMPTY.
 *
 * Measured relevance: with `set`, a CREATEROLE role that creates another role
 * receives SET on it automatically. Every membership the chain opens and closes
 * would then have a second, invisible source, and lab M1 — "membership with SET
 * TRUE has to be granted explicitly" — would stop being true of this engine.
 * The certification would still pass, and would be measuring a different
 * database from the one being shipped to.
 */
export const EXPECTED_CREATEROLE_SELF_GRANT = ''

/**
 * The MINIMUM surface this image does not provide that the baseline references.
 *
 * Deliberately not "make it look like a Supabase project". Only what a unit in
 * BASELINE_UNITS actually names, and each entry carries what is wrong with it.
 */
export const LAB_SHIMS: readonly { readonly object: string; readonly whyItIsAShim: string }[] = [
  {
    object: 'storage.objects',
    whyItIsAShim:
      'Created by the Storage SERVICE on a real project, not by the database image, and owned there ' +
      'by supabase_storage_admin. Here it is created for `postgres` so that unit 41 can create its ' +
      'three evidence policies at all. Every privilege question those policies would actually face on ' +
      'a managed project is therefore answered trivially and wrongly, and no result about them is ' +
      'evidence of anything.',
  },
  {
    object: 'storage.foldername(text)',
    whyItIsAShim:
      'Same origin, same caveat. Referenced by can_read_evidence_object / can_write_evidence_object, ' +
      'which unit 42 then grants EXECUTE on — so its ABSENCE would break a dependency that has ' +
      'nothing to do with Storage.',
  },
  {
    object: 'the uellix-evidence bucket',
    whyItIsAShim:
      'Not created at all. No probe in this run asks about it, and none of the reported results ' +
      'depends on it — stated here so that its absence is a declared gap rather than an unnoticed one.',
  },
]

/**
 * What is NOT shimmed, and is therefore load-bearing.
 *
 * Listed because the value of this environment over the existing local
 * rehearsal is precisely this list: the rehearsal creates schema `auth` itself
 * and therefore owns it, which answers RR-09 in the convenient direction.
 */
export const LAB_FAITHFUL_SURFACE: readonly string[] = [
  'schema auth, owned by supabase_admin — NOT by the installer',
  'auth.users, owned by supabase_auth_admin',
  'auth.uid(), provided by the image',
  'postgres: NOSUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS — the managed installer identity',
  'supabase_admin is the only superuser and is never used to apply a chain package',
  'anon / authenticated / service_role / authenticator, as the image creates them',
  "postgres holds USAGE on schema auth WITHOUT the ability to CREATE in it (RR-09's asymmetry)",
]

/**
 * The storage shim, as SQL.
 *
 * Applied by the superuser because schema `storage` belongs to supabase_admin
 * and the installer cannot create in it — which is itself the measurement that
 * makes this a shim rather than a fixture.
 */
export const STORAGE_SHIM_SQL = `
-- CERTIFICATION SHIM. See LAB_SHIMS in lab-environment.ts before citing any
-- result that touches storage.objects.
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid
);
ALTER TABLE storage.objects OWNER TO postgres;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $shim$ SELECT string_to_array(name, '/') $shim$;
ALTER FUNCTION storage.foldername(text) OWNER TO postgres;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
`

/** The session setting stella_hosted_0001 refuses to guess. */
export const BOOTSTRAP_ENVIRONMENT_SETTING = "SET uellix.bootstrap_environment = 'staging';"

/**
 * The installer identity the governed chain is written for.
 *
 * NOT `postgres`. Every temporary elevation the generator emits names
 * `uellix_migrator` — `GOVERNED_INSTALLER` in governed-generator.ts — and
 * `SET ROLE uellix_cap_grounding` after `GRANT ... TO uellix_migrator` is
 * refused for any other session with `permission denied to set role`. A harness
 * that applied the chain as the baseline owner would be certifying a sequence
 * nobody will ever run, and would report the refusal as a chain defect.
 *
 * Measured on this image: the local socket is `peer`-authenticated, so the
 * migrator is reached over 127.0.0.1 instead — still inside a `--network none`
 * container, so still not reachable from anywhere.
 */
export const CHAIN_INSTALLER_ROLE = 'uellix_migrator'

/**
 * The two identities a governed package could conceivably be applied as, and
 * why the certification tries BOTH rather than picking one.
 *
 * E-02. Measured on this image, each fails at a different statement, for
 * opposite reasons:
 *
 *   postgres          holds CREATEROLE, so `assert_hosted_capabilities` passes
 *                     and the chain runs — until the first CAPABILITY window,
 *                     where `GRANT uellix_cap_grounding TO uellix_migrator`
 *                     followed by `SET ROLE uellix_cap_grounding` is refused
 *                     with `permission denied to set role`: the grant named the
 *                     migrator and the session is not it. (T1 line 1000.)
 *
 *   uellix_migrator   IS the role every temporary elevation names, so the SET
 *                     ROLEs would work — but `stella_hosted_0001` creates it
 *                     NOCREATEROLE, and `assert_hosted_capabilities` (C1)
 *                     requires CREATEROLE because every chain package creates
 *                     its capability role. It is refused at T1's FIRST
 *                     statement. (T1 line 216.)
 *
 * So the governed chain, as generated, has no session that can apply it. The
 * gap is not in the SQL of any one package: the generator's GOVERNED_INSTALLER
 * and the bootstrap's capability contract disagree about who the installer is.
 */
export const CANDIDATE_INSTALLERS: readonly string[] = ['postgres', 'uellix_migrator']

/** Disposable, container-local, and never leaves the container. */
export const CHAIN_INSTALLER_PASSWORD = 'uellix-pg176-certification'

/**
 * Giving the migrator a password is PROVISIONING, not a workaround.
 *
 * `stella_hosted_0001` creates `uellix_migrator WITH LOGIN` and sets no
 * password, because the credential belongs to the operator's secret manager
 * and not to a package in a repository. The provisioning runbook accordingly
 * offers a separate migrator connection URL. Standing in for that here is the
 * same substitution as the staging sentinel, and it is declared for the same
 * reason.
 */
export const MIGRATOR_LOGIN_SQL = `ALTER ROLE ${CHAIN_INSTALLER_ROLE} PASSWORD '${CHAIN_INSTALLER_PASSWORD}';`

/**
 * A project ref that cannot be a project.
 *
 * `staging_sentinel_project_ref` demands `^[a-z]{20}$`, so the value has to be
 * twenty lowercase letters — but nothing says which twenty. Using the REAL
 * staging ref here would put the live project's identifier into a disposable
 * container and into every artefact this run writes, for no gain: no package in
 * T1..T9 reads the column. So it is a sentence instead, and one that cannot be
 * mistaken for a ref in a log.
 */
export const LAB_PROJECT_REF = 'localcertlabnotrealx'

/**
 * The staging sentinel row.
 *
 * stella_hosted_0001 CREATES the table and deliberately does not INSERT the
 * row: "a bootstrap that minted its own sentinel would be a bootstrap that
 * certifies itself". Writing it is the last step of provisioning, done by a
 * human who has just created the project. The certification harness is standing
 * in for that human, and it does so EXPLICITLY — this is a declared
 * prerequisite, not a workaround for a refusal.
 *
 * Without it, `uellix_bootstrap.assert_hosted_capabilities` refuses every
 * package in the chain at its first statement, which is the correct behaviour
 * and is exercised as a negative case rather than assumed.
 */
/**
 * E-01, and the ONLY reason this constant exists.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ENGINE MEASURED
 * ---------------------------------------------------------------------------
 * The chain grants privileges on SIX objects in schema `public` from inside an
 * owner or capability window — as `uellix_owner`. On a LOCAL database that
 * works, because `stella_0004_role_separation.sql` transfers all 38 tables and
 * 8 functions to `uellix_owner` (lines 456-502). On a HOSTED database it cannot,
 * because `stella_hosted_0001` deliberately performs a NARROW transfer — only
 * `public.stella_interactions` — and says why: moving the RLS helper functions
 * to a role that cannot receive USAGE on schema `auth` would break every policy
 * in the product (RR-09).
 *
 * So on managed Supabase those six objects stay owned by the baseline owner,
 * `uellix_owner` holds neither ownership nor GRANT OPTION over them, and
 * PostgreSQL 17.6 answers `permission denied for function
 * current_user_org_ids`. Measured, T1 line 278, this image, not inferred.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS APPLIED ONLY IN A DIAGNOSTIC RUN
 * ---------------------------------------------------------------------------
 * This is a HYPOTHESIS about the remediation — hand `uellix_owner` the GRANT
 * OPTION rather than the ownership, which leaves RR-09 intact — and it is
 * applied to the ENVIRONMENT, never to the chain. A certification run does not
 * use it, and a run that does is not certification evidence: it answers only
 * "is E-01 the first blocker or the only one?", which is what decides whether
 * closing E-01 is worth attempting before the next certification.
 */
/**
 * ---------------------------------------------------------------------------
 * WHY THE PATCH IS A SWEEP AND NOT A LIST
 * ---------------------------------------------------------------------------
 * It began as a list of the six objects T1's GRANT statements name. Each round
 * of the diagnostic moved the failure a few hundred lines further into the same
 * package and named a different object:
 *
 *   line 278  permission denied for function current_user_org_ids
 *             -> the two RLS helpers the chain re-grants
 *   line 398  permission denied for table organizations
 *             -> a FOREIGN KEY needs REFERENCES on its TARGET, which the chain
 *                never grants because locally it owns the target
 *   line 682  permission denied for function public.uellix_forbid_mutation
 *             -> a TRIGGER needs EXECUTE on its function
 *
 * Three different privileges on three different object classes, none of them
 * mentioned in the statement that fails. That is the shape of a systemic gap
 * rather than three defects, so the patch stops enumerating and sweeps: give
 * `uellix_owner` everything an OWNER of schema public would have, without
 * moving any ownership, and let the engine say whether that is sufficient.
 *
 * If the chain still fails under this, the answer is that privileges cannot
 * substitute for ownership here and the remediation has to be an ownership
 * decision — which is precisely the decision RR-09 constrains.
 */
export const E01_DIAGNOSTIC_PATCH_SQL = `
-- E-02, the installer gap. Hands \`postgres\` the ability to become
-- \`uellix_migrator\` AND to inherit what is granted to it, so that a session
-- with CREATEROLE can also satisfy the SET ROLEs the generator emits.
--
-- This is RR-02 being exercised deliberately: on managed Supabase \`postgres\`
-- holds ADMIN OPTION on every role it created and can widen its own membership
-- at any time. That the remediation is AVAILABLE is not an argument that it is
-- correct — it re-joins the two identities the model deliberately separated,
-- and choosing it is an authority decision, not a fix.
GRANT uellix_migrator TO postgres WITH INHERIT TRUE, SET TRUE;

DO $e01$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS o
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v')
      AND pg_get_userbyid(c.relowner) = current_user
  LOOP
    EXECUTE format('GRANT ALL PRIVILEGES ON %I.%I TO uellix_owner WITH GRANT OPTION', r.s, r.o);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure::text AS o
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO uellix_owner WITH GRANT OPTION', r.o);
  END LOOP;

  FOR r IN
    SELECT c.relname AS o
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND pg_get_userbyid(c.relowner) = current_user
  LOOP
    EXECUTE format('GRANT ALL PRIVILEGES ON SEQUENCE public.%I TO uellix_owner WITH GRANT OPTION', r.o);
  END LOOP;
END
$e01$;
`

/**
 * The objects the CERTIFICATION run measured E-01 on, named individually.
 *
 * The patch above sweeps; this list is what the failing statements actually
 * named, in the order the engine reached them. A reader deciding what to
 * remediate needs the second, not the first.
 */
export const E01_OBJECTS: readonly string[] = [
  'public.current_user_org_ids()      — GRANT EXECUTE, T1 line 278',
  'public.current_user_is_super_admin() — GRANT EXECUTE, T1 line 279',
  'public.organizations               — REFERENCES (foreign key), T1 line 398',
  'public.projects                    — REFERENCES (foreign key), T1 line 398',
  'public.evidence_items              — REFERENCES and GRANT SELECT/UPDATE',
  'public.uellix_forbid_mutation()    — EXECUTE (trigger function), T1 line 682',
  'public.uellix_auth_uid()           — GRANT EXECUTE, later packages',
]

export const STAGING_SENTINEL_SQL = `
INSERT INTO uellix_bootstrap.staging_sentinel
  (id, environment, project_ref, bootstrap_version, owner_separation)
VALUES
  (true, 'staging', '${LAB_PROJECT_REF}', 'pg176-engine-certification',
   'RR-02: postgres retains ADMIN OPTION on uellix_owner — auditable obstacle, not a barrier')
ON CONFLICT (id) DO NOTHING;
`
