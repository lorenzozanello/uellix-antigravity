-- db/prepared/stella_0003_suggestion_decisions.sql
-- WS3b (persistence & DB security): stella_suggestion_decisions table.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE.md and the process in
-- docs/ops/SUPABASE_MIGRATION_GATE.md. Rollback: stella_0003_rollback.sql.
--
-- SOURCE OF TRUTH: this table is deliberately absent from db/schema.ts and the
-- drizzle snapshot — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md. Do not add
-- it to schema.ts without following the promotion procedure in that ADR §7.
--
-- RUN AS ONE TRANSACTION:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent AND convergent: on a database where the table already exists with
-- the expected shape, re-running reconciles indexes, grants, RLS, the policy
-- and the CHECK constraints. If the table exists with an INCOMPATIBLE shape the
-- script ABORTS with an explicit error instead of silently doing nothing.
--
-- PURPOSE: records what humans DID with Stella suggestions (accepted,
-- accepted with edits, rejected, undone) — the human-in-the-loop half of the
-- AI audit trail. The consuming server action
-- (app/actions/stella/decisions.ts, recordStellaDecision) ships DORMANT
-- behind STELLA_DECISIONS_PERSISTENCE_ENABLED=false and must stay off until
-- this script has been applied through G2.
--
-- PRIVACY INVARIANT: previous_value_hash stores a SHA-256 hex digest of the
-- value a suggestion replaced — NEVER the raw previous text. The hash is
-- computed server-side in recordStellaDecision. applied_text may store the
-- text that was actually applied (it becomes project content anyway).
--
-- PRIVILEGE HARDENING (2026-08-01, before this script's first application
-- anywhere): section 4 now does REVOKE ALL before granting anything back, and
-- section 6 attaches both append-only triggers. Both changes exist so this
-- table never inherits the Supabase default-privilege surplus (`Dxtm`) that
-- left the four pre-existing audit tables TRUNCATE-able and forced the
-- corrective script db/prepared/stella_0002b_append_only_truncate_hardening.sql.
-- This script has never been applied to any database, so hardening it now costs
-- nothing and leaves no environment to repair later.
-- Added dependency: db/migrations/0030_immutability.sql (uellix_forbid_mutation).

SET search_path = public;

-- On a database where the table ALREADY exists, section 6's DROP/CREATE TRIGGER
-- takes ACCESS EXCLUSIVE and holds it to COMMIT. Bound the wait so a long reader
-- cannot turn this script into a stall for every writer; the script is
-- convergent, so aborting and retrying costs nothing. (Added 2026-08-01.)
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions + shape guard
-- ============================================================
-- CREATE TABLE IF NOT EXISTS silently does nothing when a table of the same
-- name exists with a DIFFERENT shape. That would leave the application talking
-- to a table it does not understand. Fail loudly instead.
-- The error reports COLUMN NAMES AND TYPES ONLY — never row data.
DO $$
DECLARE
  mismatched   text;
  missing_roles text;
BEGIN
  -- 0-pre. The grantee roles must exist BEFORE anything is created or altered.
  --        Without this, section 4's REVOKE/GRANT and section 0b's
  --        has_function_privilege() both die on a bare
  --        'role "authenticated" does not exist', after the table already
  --        exists. Ported from stella_0002b §0-pre, whose comment notes this is
  --        otherwise the one precondition the script never states.
  --        The writer role is checked separately in section 4b, because it is
  --        declared, not fixed — and the installer is NOT assumed to be it.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: missing role(s): %. This database was not bootstrapped by Supabase; the grant model this script reconciles does not apply', missing_roles;
  END IF;

  -- 0a. FK targets must exist.
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: one of the referenced tables (organizations, projects, users, stella_interactions) is missing — this database is not at the expected migration baseline (G2 precondition "migraciones base al día")';
  END IF;

  -- 0b. RLS helper functions must exist (db/migrations/0031_rls_core.sql);
  --     EXECUTE is granted by 0039_grant_rls_helper_execution.sql.
  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: RLS helpers public.current_user_org_ids()/current_user_is_super_admin() not found — apply db/migrations/0031_rls_core.sql and 0039_grant_rls_helper_execution.sql first';
  END IF;

  -- Existing is not enough: they must be EXECUTABLE by authenticated, or the
  -- SELECT policy in section 5 fails at runtime for every real user.
  -- 0033_public_api_grants.sql:18 does REVOKE EXECUTE ON ALL FUNCTIONS ... FROM
  -- authenticated, and 0039 grants it back — an environment that received the
  -- first and not the second looks healthy here but denies every read.
  IF NOT has_function_privilege('authenticated', 'public.current_user_org_ids()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0003 aborted: role authenticated lacks EXECUTE on the RLS helpers — apply db/migrations/0039_grant_rls_helper_execution.sql (0033:18 revokes it; 0039 grants it back). Without it the SELECT policy denies every read';
  END IF;

  -- 0b-bis. The append-only trigger function must exist
  --         (db/migrations/0030_immutability.sql). Section 6 attaches this
  --         table's immutability triggers to it, mirroring the posture that
  --         prepared stella_0002/stella_0002b established for
  --         stella_interactions and the other audit tables.
  IF to_regprocedure('public.uellix_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: function public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first (G2 precondition "migraciones base al día")';
  END IF;

  -- 0c. Shape guard — only when the table already exists.
  IF to_regclass('public.stella_suggestion_decisions') IS NOT NULL THEN
    SELECT string_agg(
             format('%s (expected %s%s)', e.col, e.typ,
                    CASE WHEN e.nul = 'NO' THEN ' NOT NULL' ELSE ' NULL' END),
             ', ' ORDER BY e.col)
      INTO mismatched
    FROM (VALUES
      ('id',                  'uuid',                        'NO'),
      ('organization_id',     'uuid',                        'NO'),
      ('project_id',          'uuid',                        'NO'),
      ('interaction_id',      'uuid',                        'YES'),
      ('suggestion_key',      'text',                        'NO'),
      ('decision',            'text',                        'NO'),
      ('previous_value_hash', 'text',                        'YES'),
      ('applied_text',        'text',                        'YES'),
      ('rejection_reason',    'text',                        'YES'),
      ('decided_by',          'uuid',                        'NO'),
      ('decided_at',          'timestamp with time zone',    'NO')
    ) AS e(col, typ, nul)
    LEFT JOIN information_schema.columns c
           ON c.table_schema = 'public'
          AND c.table_name   = 'stella_suggestion_decisions'
          AND c.column_name  = e.col
          AND c.data_type    = e.typ
          AND c.is_nullable  = e.nul
    WHERE c.column_name IS NULL;

    IF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'stella_0003 aborted: public.stella_suggestion_decisions already exists with an INCOMPATIBLE shape. Missing or mismatched columns: %. This script never ALTERs COLUMNS of an existing table (it does reconcile stale constraints) — resolve manually and re-run (see "Criterios de aborto" in docs/ops/gates/G2_PACKAGE.md).',
        mismatched;
    END IF;

    -- 0d. Columns matching is not enough: a pre-existing table can still be
    --     unusable by the application. Check the three cases that would break
    --     recordStellaDecision's INSERT at runtime.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.stella_suggestion_decisions'::regclass AND contype = 'p'
    ) THEN
      RAISE EXCEPTION 'stella_0003 aborted: public.stella_suggestion_decisions exists without a PRIMARY KEY';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stella_suggestion_decisions'
        AND column_name = 'id' AND column_default IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'stella_0003 aborted: public.stella_suggestion_decisions.id has no DEFAULT — the application INSERT omits id and would fail';
    END IF;

    SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO mismatched
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stella_suggestion_decisions'
      AND is_nullable = 'NO' AND column_default IS NULL
      AND column_name NOT IN (
        'id', 'organization_id', 'project_id', 'suggestion_key',
        'decision', 'decided_by'
      );
    IF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'stella_0003 aborted: public.stella_suggestion_decisions has unexpected NOT NULL columns without a default (%), which the application INSERT does not populate.',
        mismatched;
    END IF;
  END IF;
END $$;

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  -- The stella_interactions row whose suggestion was decided on; NULL when the
  -- UI cannot attribute the decision to a specific interaction.
  interaction_id uuid REFERENCES public.stella_interactions(id),
  -- Stable key identifying WHICH suggestion inside the interaction payload
  -- (e.g. 'advisor.suggested_next_actions[2]') — assigned by the UI layer.
  suggestion_key text NOT NULL,
  decision text NOT NULL,
  -- SHA-256 (hex) of the replaced value; raw previous text is never persisted.
  previous_value_hash text,
  applied_text text,
  rejection_reason text,
  -- Same user-FK convention as stella_interactions.created_by (public.users).
  decided_by uuid NOT NULL REFERENCES public.users(id),
  decided_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT stella_suggestion_decisions_decision_check
    CHECK (decision IN ('accepted', 'accepted_edited', 'rejected', 'undone')),
  CONSTRAINT stella_suggestion_decisions_prev_hash_check
    CHECK (previous_value_hash IS NULL OR previous_value_hash ~ '^[0-9a-f]{64}$')
);

-- ============================================================
-- 2. CHECK reconciliation — convergent
-- ============================================================
-- Covers the case where the table pre-exists with the right columns (so the
-- shape guard passed) but a named CHECK is MISSING **or STALE**.
--
-- Comparing only `conname` would be a trap: an earlier revision that created
-- decision_check with 3 values (no 'undone') carries the right name with the
-- wrong definition, and a name-only check would silently leave it in place —
-- the gate would sign off green and recordStellaDecision would fail at runtime
-- on the first 'undone'. So we compare the DEFINITION, matching quoted
-- literals exactly as pg_get_constraintdef renders them (same rigour as
-- stella_0002's stella_role reconciliation).
DO $$
DECLARE
  def       text;
  offending text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.stella_suggestion_decisions'::regclass
    AND conname = 'stella_suggestion_decisions_decision_check';

  -- position(), not LIKE: in a LIKE pattern `_` matches ANY single character,
  -- so `LIKE '%''accepted_edited''%'` would also accept a stale constraint
  -- spelling 'acceptedXedited' and leave it in place. position() is a literal
  -- substring search with no metacharacters at all.
  -- Reconcile on the SAME test section 7 verifies with — presence AND
  -- exclusivity. Reconciling on presence alone left a convergence gap: a
  -- pre-existing CHECK that was a strict SUPERSET (the four states plus a
  -- fifth) satisfied section 2, was left in place, and then made section 7
  -- abort the whole transaction. Now it is rebuilt instead.
  IF def IS NULL
     OR position('''accepted''' in def) = 0
     OR position('''accepted_edited''' in def) = 0
     OR position('''rejected''' in def) = 0
     OR position('''undone''' in def) = 0
     OR EXISTS (
          SELECT 1
          FROM (SELECT (regexp_matches(def, '''([^'']+)''', 'g'))[1] AS lit) AS x
          WHERE lit NOT IN ('accepted', 'accepted_edited', 'rejected', 'undone')
        )
  THEN
    -- Before narrowing the constraint, check the DATA. Rebuilding a CHECK that
    -- existing rows violate fails with PostgreSQL's generic
    -- 'check constraint "..." is violated by some row' — no table name, no
    -- guidance, and none of the 'stella_0003 aborted:' prefix that this file's
    -- header and the G2 abort criteria tell the operator to look for. Report
    -- the offending STATES (never row data) instead.
    SELECT string_agg(DISTINCT d.decision, ', ' ORDER BY d.decision) INTO offending
    FROM public.stella_suggestion_decisions d
    WHERE d.decision NOT IN ('accepted', 'accepted_edited', 'rejected', 'undone');

    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'stella_0003 aborted: existing rows hold decision state(s) outside the contract: %. The CHECK cannot be narrowed to accepted / accepted_edited / rejected / undone without losing or rewriting those rows — resolve manually (see "Criterios de aborto" in docs/ops/gates/G2_PACKAGE.md). No row data is shown, only the distinct states', offending;
    END IF;

    IF def IS NOT NULL THEN
      ALTER TABLE public.stella_suggestion_decisions
        DROP CONSTRAINT stella_suggestion_decisions_decision_check;
    END IF;
    ALTER TABLE public.stella_suggestion_decisions
      ADD CONSTRAINT stella_suggestion_decisions_decision_check
      CHECK (decision IN ('accepted', 'accepted_edited', 'rejected', 'undone'));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.stella_suggestion_decisions'::regclass
    AND conname = 'stella_suggestion_decisions_prev_hash_check';

  -- The hash-not-content invariant: the definition must still pin the ANCHORED
  -- 64-hex shape. Matching the bare class would accept a stale UNANCHORED regex
  -- ('[0-9a-f]{64}' without ^$), which would happily admit
  -- "<raw text><64 hex><more raw text>" — i.e. the very leak this CHECK exists
  -- to prevent. pg_get_constraintdef renders the literal as '^[0-9a-f]{64}$',
  -- so match it including its surrounding quotes.
  -- position() again: the pattern contains no `_`, but LIKE would still treat
  -- any future edit's `_` as a wildcard. Literal search removes the trap class.
  IF def IS NULL OR position('''^[0-9a-f]{64}$''' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.stella_suggestion_decisions
        DROP CONSTRAINT stella_suggestion_decisions_prev_hash_check;
    END IF;
    ALTER TABLE public.stella_suggestion_decisions
      ADD CONSTRAINT stella_suggestion_decisions_prev_hash_check
      CHECK (previous_value_hash IS NULL OR previous_value_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- ============================================================
-- 3. Indexes (no CONCURRENTLY — this script runs inside one transaction)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_org_decided_at
  ON public.stella_suggestion_decisions (organization_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_interaction_id
  ON public.stella_suggestion_decisions (interaction_id);

-- ============================================================
-- 4. Grants — deny-by-default, then grant back the minimum
-- ============================================================
-- WHY REVOKE ALL FIRST (hardened 2026-08-01, before this script's first ever
-- application anywhere):
--
-- Supabase configures ALTER DEFAULT PRIVILEGES so that every table created by
-- `postgres` in schema `public` is born granting `Dxtm` to `authenticated` —
-- D=TRUNCATE, x=REFERENCES, t=TRIGGER, m=MAINTAIN (PG17+) — and full `arwdDxtm`
-- to `service_role`. That inheritance is exactly what left the four existing
-- append-only tables TRUNCATE-able by `authenticated`, a MAJOR finding that
-- prepared stella_0002b had to repair after the fact (it was demonstrated on a
-- real PostgreSQL 17: `SET LOCAL ROLE authenticated; TRUNCATE ...` succeeded).
--
-- Listing privileges to revoke one by one is a losing game: it silently misses
-- whatever a future PostgreSQL version or Supabase bootstrap adds. REVOKE ALL
-- and then granting back is the only formulation that cannot inherit a surplus
-- it was not written to anticipate. This table therefore never carries the
-- defect its siblings had to be repaired for.
--
-- REVOKE of a privilege a role does not hold is a no-op, so this is repeatable.
REVOKE ALL ON public.stella_suggestion_decisions FROM anon;
REVOKE ALL ON public.stella_suggestion_decisions FROM authenticated;
REVOKE ALL ON public.stella_suggestion_decisions FROM service_role;
-- PUBLIC is a fourth grantee, and an easy one to forget: it is not a role in
-- pg_roles (it is grantee OID 0 in the ACL), so a check that joins pg_roles
-- cannot even see it. Revoking is cheap and closes the gap by construction.
REVOKE ALL ON public.stella_suggestion_decisions FROM PUBLIC;

-- The minimum the real architecture needs:
--
--   authenticated -> SELECT only. Reads are gated by the org-scoped RLS policy
--     in section 5. This is stricter than the append-only tables, which also
--     carry an (inert) INSERT grant.
--
--   anon -> nothing. Never reads or writes this table.
--
--   service_role -> nothing. The only writer is recordStellaDecision
--     (app/actions/stella/decisions.ts), which goes through the Drizzle client
--     in db/client.ts. That client connects with DATABASE_URL, i.e. as the
--     table's OWNER, whose access derives from ownership and not from any
--     grant. Granting service_role here would hand out privileges that nothing
--     in this system exercises. If a deployment ever routes writes through
--     PostgREST with a service_role JWT, that deployment must add the grant
--     deliberately, through its own gate — it must not be inherited by default.
GRANT SELECT ON public.stella_suggestion_decisions TO authenticated;

-- ============================================================
-- 4b. Write-path guard — what SQL can prove, and what it cannot
-- ============================================================
-- REPLACES an earlier guard that read `has_table_privilege(current_user, ...,
-- 'INSERT')`. That check was VACUOUS: has_table_privilege() returns true
-- unconditionally for any role with rolsuper, so it was blind precisely in the
-- scenario its own comment named — this script being applied by tooling running
-- as `supabase_admin`, which IS a superuser. It also proved the wrong thing:
-- "the role applying this script can insert", not "the role the application
-- connects as can insert". Those coincide only by operational convention, which
-- is the assumption the guard existed to stop making.
--
-- HONEST SCOPE. No SQL statement can observe which role DATABASE_URL resolves
-- to — that lives in the environment, not the database. So the assurance is
-- split into three parts, and only the first is enforced here:
--
--   1. STRUCTURAL GUARD (this block) — verifiable facts only: the writer role
--      exists, it owns the table (or holds a DIRECT, non-inherited INSERT+SELECT
--      grant AND can get past RLS), and the owner is never one of the PostgREST
--      roles.
--   2. OFFLINE CODE TEST — tests/prepared-stella-sql.test.ts asserts that the
--      application's only write path is db/client.ts (postgres-js over
--      DATABASE_URL), not a service_role/PostgREST client.
--   3. HUMAN GATE PRECONDITION — docs/ops/gates/G2_PACKAGE.md requires the
--      operator to confirm that DATABASE_URL's role equals the writer role
--      below. That step cannot be automated from inside the database.
--
-- DECLARING THE WRITER ROLE
--   Set it explicitly, e.g.:   SET stella.writer_role = 'postgres';
--   (or `psql -c "SET stella.writer_role='...'" -f this_file` / ALTER DATABASE).
--
--   WHEN UNSET the script falls back to `current_user` and says so with a
--   NOTICE, because in the documented architecture the installer IS the
--   application role. In that mode the owner check is tautological — CREATE
--   TABLE makes current_user the owner — so it verifies nothing and the script
--   reports it as an ASSUMPTION rather than pretending otherwise. Setting the
--   variable is what turns this block into a real check, which is why the
--   remote G2 checklist requires it.
--
--   Verify locally:  SHOW stella.writer_role;  -- and compare with the role in
--                    DATABASE_URL (never print the connection string itself)
--   Verify remotely: same, as step 0 of the G2 checklist.
DO $$
DECLARE
  writer        name;
  writer_oid    oid;
  writer_declared boolean;
  tbl_owner     name;
  owner_is_writer boolean;
  direct_insert boolean;
  direct_select boolean;
  writer_bypassrls boolean;
  force_rls     boolean;
BEGIN
  writer := nullif(current_setting('stella.writer_role', true), '');
  writer_declared := writer IS NOT NULL;
  IF NOT writer_declared THEN
    writer := current_user;
  END IF;

  -- Resolve the OID by exact rolname. NOT `writer::regrole`: regrolein parses
  -- its input as an SQL identifier — it lowercases anything unquoted and splits
  -- on dots — so a role genuinely named "AppWriter" or "app.writer" would pass
  -- an existence check on rolname and then fail here with
  -- 'role "appwriter" does not exist'.
  SELECT oid INTO writer_oid FROM pg_roles WHERE rolname = writer;
  IF writer_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: declared writer role % does not exist. Set stella.writer_role to the role DATABASE_URL connects as', writer;
  END IF;

  -- The writer must not be a PostgREST-facing role. Those reach the database
  -- from the browser through `authenticator` + SET ROLE; making one the backend
  -- writer would give every session the backend's reach.
  IF writer IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'stella_0003 aborted: declared writer role % is a PostgREST role. The backend writer is the role DATABASE_URL connects as, not a JWT role', writer;
  END IF;

  SELECT pg_get_userbyid(c.relowner) INTO tbl_owner
  FROM pg_class c WHERE c.oid = to_regclass('public.stella_suggestion_decisions');

  -- The owner must never be one of the PostgREST-facing roles: that would hand
  -- every browser session implicit full access, RLS included.
  IF tbl_owner IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'stella_0003 aborted: table owner is %, a PostgREST role. Ownership implies unrestricted access — apply this script as the backend/database role instead', tbl_owner;
  END IF;

  owner_is_writer := (tbl_owner = writer);

  -- DIRECT grants only. aclexplode() over relacl reads the ACL literally, so a
  -- privilege the writer merely INHERITS through role membership does not count
  -- — and neither does the superuser short-circuit that broke the old guard.
  SELECT
    bool_or(a.privilege_type = 'INSERT'),
    bool_or(a.privilege_type = 'SELECT')
  INTO direct_insert, direct_select
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = to_regclass('public.stella_suggestion_decisions')
    AND a.grantee = writer_oid;

  SELECT rolbypassrls INTO writer_bypassrls FROM pg_roles WHERE oid = writer_oid;
  SELECT relforcerowsecurity INTO force_rls
  FROM pg_class WHERE oid = to_regclass('public.stella_suggestion_decisions');

  -- FORCE ROW LEVEL SECURITY removes the owner's RLS bypass. With no INSERT
  -- policy (by design, section 5) that would make the owner path fail too, so
  -- the owner branch below is only valid while FORCE is off.
  IF COALESCE(force_rls, false) THEN
    RAISE EXCEPTION 'stella_0003 aborted: FORCE ROW LEVEL SECURITY is ON for public.stella_suggestion_decisions. Neither the owner nor any grantee could INSERT, because there is deliberately no INSERT policy. Turn FORCE off, or add an INSERT policy through its own gate';
  END IF;

  -- Why ownership (or bypassrls) and not just an INSERT grant: section 5 enables
  -- RLS and deliberately creates NO INSERT policy. A non-owner without
  -- rolbypassrls would hold the grant and still be denied every row. And
  -- recordStellaDecision issues INSERT ... RETURNING id, which PostgreSQL also
  -- requires SELECT on the returned column for — hence direct_select too.
  IF NOT owner_is_writer
     AND NOT (COALESCE(direct_insert, false) AND COALESCE(direct_select, false)
              AND COALESCE(writer_bypassrls, false)) THEN
    RAISE EXCEPTION
      'stella_0003 aborted: writer role % has no working INSERT path (table owner: %, direct INSERT grant: %, direct SELECT grant: %, rolbypassrls: %). RLS is enabled with no INSERT policy, so the writer must either OWN the table or hold direct INSERT+SELECT and bypass RLS. recordStellaDecision writes via db/client.ts over DATABASE_URL — apply this script AS that role. Do NOT grant INSERT to authenticated or service_role to satisfy this check',
      writer, tbl_owner, COALESCE(direct_insert, false), COALESCE(direct_select, false), COALESCE(writer_bypassrls, false);
  END IF;

  IF writer_declared THEN
    RAISE NOTICE 'stella_0003: write path VERIFIED against declared writer role % (owner: %, owner_is_writer: %).', writer, tbl_owner, owner_is_writer;
  ELSE
    RAISE NOTICE 'stella_0003: stella.writer_role is UNSET — assuming installer (%) is the application writer. This is an ASSUMPTION, not a verification: the owner check is tautological in this mode. Set stella.writer_role to have it checked (required by the remote G2 checklist).', writer;
  END IF;
END $$;

-- ============================================================
-- 5. RLS (mirrors db/policies/002_stella_interactions_rls.sql posture)
-- ============================================================
--   - SELECT: org members read their own org's decisions; super_admin sees all
--   - No INSERT policy: inserts are strictly server-side, via recordStellaDecision
--     over the Drizzle client. NOTE (corrected 2026-08-01): that client connects
--     as the table OWNER, and it is OWNERSHIP that bypasses RLS here — there is
--     no FORCE ROW LEVEL SECURITY on this table. It is NOT `service_role` doing
--     the bypassing: after section 4, service_role holds no privilege on this
--     table at all. The earlier wording claimed the opposite and would have led
--     a reader to believe the write path depended on a grant that does not exist.
--   - No UPDATE policy: decisions are immutable ('undone' is a NEW row, not an
--     update of the original decision)
--   - No DELETE policy: audit-trail integrity

ALTER TABLE public.stella_suggestion_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stella_suggestion_decisions_select" ON public.stella_suggestion_decisions;
CREATE POLICY "stella_suggestion_decisions_select"
ON public.stella_suggestion_decisions FOR SELECT
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

-- No INSERT policy -> INSERT denied via RLS (service role only)
-- No UPDATE policy -> UPDATE denied (immutable decisions)
-- No DELETE policy -> DELETE denied (audit trail integrity)

-- ============================================================
-- 6. Append-only enforcement at the database level
-- ============================================================
-- RLS and grants both stop at the table OWNER, and the only writer here IS the
-- owner (db/client.ts connects with DATABASE_URL). Triggers are the one control
-- that fires for every role, owner included, so they are what actually makes
-- "decisions are immutable" true rather than merely intended.
--
-- Two triggers are required, not one, because they cover disjoint events:
--   * FOR EACH ROW  on UPDATE/DELETE — no OLD/NEW rows exist for TRUNCATE, so a
--     row trigger can never see it;
--   * FOR EACH STATEMENT on TRUNCATE — PostgreSQL forbids FOR EACH ROW here.
-- Omitting the second is precisely the gap that stella_0002b had to close on
-- the four pre-existing audit tables. This table ships with both from day one.
--
-- 'undone' is a NEW row, never an UPDATE of the original decision, so nothing in
-- the application is affected by forbidding mutation.
--
-- public.uellix_forbid_mutation() is reused unchanged: it reads only TG_OP and
-- TG_TABLE_NAME, both available at row and statement level, and always raises
-- with SQLSTATE 42501.

DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_append_only ON public.stella_suggestion_decisions;
CREATE TRIGGER trg_stella_suggestion_decisions_append_only
  BEFORE UPDATE OR DELETE ON public.stella_suggestion_decisions
  FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_no_truncate ON public.stella_suggestion_decisions;
CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate
  BEFORE TRUNCATE ON public.stella_suggestion_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

COMMENT ON TRIGGER trg_stella_suggestion_decisions_append_only ON public.stella_suggestion_decisions IS
  'WS3b (prepared stella_0003, gate G2): human-decision audit trail is append-only; UPDATE/DELETE are forbidden even for the table owner.';
COMMENT ON TRIGGER trg_stella_suggestion_decisions_no_truncate ON public.stella_suggestion_decisions IS
  'WS3b (prepared stella_0003, gate G2): TRUNCATE is forbidden on this append-only table, including for the table owner.';

COMMENT ON TABLE public.stella_suggestion_decisions IS
  'Human decisions over Stella suggestions (WS3b, prepared stella_0003, gate G2). previous_value_hash is a SHA-256 digest — raw previous text is never stored. Managed outside the drizzle chain: see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';

-- ============================================================
-- 7. Self-verification — assert the end state, inside this transaction
-- ============================================================
-- Ported from stella_0002b §5, whose lesson was learned the hard way (RK-04b):
-- a REVOKE only removes grants made by the CURRENT grantor, and PostgreSQL
-- merely emits a WARNING — never an error — when there is nothing to revoke.
-- So "I ran REVOKE ALL" is not evidence that the privilege is gone.
--
-- Everything below reads pg_catalog directly. In particular, privileges come
-- from aclexplode() over pg_class.relacl, which reports the ACL literally:
-- privileges a role merely INHERITS through membership do not appear, and there
-- is no superuser short-circuit of the kind that made the old write-path guard
-- vacuous. information_schema.role_table_grants would have reported both.
--
-- Running inside the same transaction is what makes this worth doing: a failure
-- rolls the whole script back instead of leaving a table that reported success.
DO $$
DECLARE
  tbl_oid        oid;
  tbl_owner      name;
  problem        text;
  def            text;
  n              int;
BEGIN
  -- (1) The table exists.
  tbl_oid := to_regclass('public.stella_suggestion_decisions');
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: public.stella_suggestion_decisions does not exist after the script ran';
  END IF;

  -- (2) Owner is a real backend role, never a PostgREST role.
  SELECT pg_get_userbyid(relowner) INTO tbl_owner FROM pg_class WHERE oid = tbl_oid;
  IF tbl_owner IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: table owner is %, a PostgREST role', tbl_owner;
  END IF;

  -- (3) Columns: exact name, type, nullability and presence/absence of default.
  SELECT string_agg(format('%s(%s)', e.col, e.why), ', ' ORDER BY e.col) INTO problem
  FROM (
    SELECT x.col,
           CASE
             WHEN a.attname IS NULL THEN 'missing'
             WHEN format_type(a.atttypid, a.atttypmod) <> x.typ
               THEN 'type ' || format_type(a.atttypid, a.atttypmod) || ' <> ' || x.typ
             WHEN a.attnotnull <> x.req_notnull THEN 'nullability'
             WHEN (a.atthasdef OR a.attidentity <> '') <> x.req_hasdef THEN 'default'
           END AS why
    FROM (VALUES
      ('id',                  'uuid',                        true,  true),
      ('organization_id',     'uuid',                        true,  false),
      ('project_id',          'uuid',                        true,  false),
      ('interaction_id',      'uuid',                        false, false),
      ('suggestion_key',      'text',                        true,  false),
      ('decision',            'text',                        true,  false),
      ('previous_value_hash', 'text',                        false, false),
      ('applied_text',        'text',                        false, false),
      ('rejection_reason',    'text',                        false, false),
      ('decided_by',          'uuid',                        true,  false),
      ('decided_at',          'timestamp with time zone',    true,  true)
    -- NB: the alias cannot be `notnull` — PostgreSQL parses NOTNULL as an
    -- operator (`x NOTNULL` == `x IS NOT NULL`), so it is not a usable name.
    ) AS x(col, typ, req_notnull, req_hasdef)
    LEFT JOIN pg_attribute a
           ON a.attrelid = tbl_oid AND a.attname = x.col AND a.attnum > 0 AND NOT a.attisdropped
  ) AS e
  WHERE e.why IS NOT NULL;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: column contract broken: %', problem;
  END IF;

  -- ...and no EXTRA columns. Checking the 11 named columns says nothing about a
  -- 12th that the application does not know exists.
  SELECT count(*) INTO n FROM pg_attribute
  WHERE attrelid = tbl_oid AND attnum > 0 AND NOT attisdropped;
  IF n <> 11 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 11 columns, found %', n;
  END IF;

  -- (4) Primary key on (id).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = tbl_oid AND contype = 'p'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = tbl_oid AND attname = 'id')]
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: PRIMARY KEY on (id) missing or on the wrong column(s)';
  END IF;

  -- (5) Foreign keys to the four referenced tables.
  SELECT string_agg(f.col || '->' || f.tbl, ', ' ORDER BY f.col) INTO problem
  FROM (VALUES
    ('organization_id', 'organizations'),
    ('project_id',      'projects'),
    ('interaction_id',  'stella_interactions'),
    ('decided_by',      'users')
  ) AS f(col, tbl)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid AND c.contype = 'f'
      AND c.confrelid = to_regclass('public.' || f.tbl)
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = tbl_oid AND attname = f.col)]
      -- confdeltype 'a' = NO ACTION. This is a DELIBERATE invariant (RK-04f):
      -- these rows must BLOCK deletion of their organization/project/user
      -- rather than vanish with it. STELLA_RETENTION_POLICY.md documents it, so
      -- pin it here — a silent switch to CASCADE would turn an accidental org
      -- delete into silent audit-trail loss.
      AND c.confdeltype = 'a'
  );

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: missing FOREIGN KEY(s), or one is not ON DELETE NO ACTION: %', problem;
  END IF;

  -- ...and no EXTRA foreign keys.
  SELECT count(*) INTO n FROM pg_constraint WHERE conrelid = tbl_oid AND contype = 'f';
  IF n <> 4 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 4 foreign keys, found %', n;
  END IF;

  -- (6) UNIQUE: this table deliberately has NO unique constraint beyond the PK —
  --     the same (project, suggestion_key) may be decided more than once
  --     ('undone' is a NEW row). Assert that on purpose, so adding one silently
  --     later is caught rather than assumed.
  SELECT count(*) INTO n FROM pg_constraint WHERE conrelid = tbl_oid AND contype = 'u';
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected UNIQUE constraint(s) (%). Decisions are append-only history: re-deciding a suggestion inserts a NEW row', n;
  END IF;

  -- pg_constraint is not enough: a bare CREATE UNIQUE INDEX enforces uniqueness
  -- without creating a constraint, so the check above would miss it entirely.
  -- Exclude the primary key's own index, which is legitimately unique.
  SELECT count(*) INTO n
  FROM pg_index i
  WHERE i.indrelid = tbl_oid AND i.indisunique AND NOT i.indisprimary;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: % unexpected UNIQUE index(es) besides the primary key. A standalone unique index enforces uniqueness without a constraint and would silently forbid re-deciding a suggestion', n;
  END IF;

  -- (7)+(8) decision CHECK holds exactly the four states. position(), not LIKE:
  --         `_` is a LIKE wildcard, so 'acceptedXedited' would have passed.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = tbl_oid AND conname = 'stella_suggestion_decisions_decision_check';
  IF def IS NULL
     OR position('''accepted''' in def) = 0
     OR position('''accepted_edited''' in def) = 0
     OR position('''rejected''' in def) = 0
     OR position('''undone''' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: decision CHECK missing or incomplete: %', COALESCE(def, '<absent>');
  END IF;

  -- Presence is not exclusivity. Without this, a stale CHECK that ALSO allowed
  -- a fifth state (e.g. 'deleted') would satisfy the four position() probes and
  -- pass. Extract every quoted literal from the rendered definition and require
  -- the set to be exactly the four documented states.
  -- `[^'']+`, not `[a-z_]+`: a stale CHECK admitting 'accepted2', 'Deleted' or
  -- 'v2' would produce NO match under the narrower class and pass silently —
  -- the same "matches only what we already expected" trap that MIN-A closed.
  SELECT string_agg(DISTINCT lit, ', ' ORDER BY lit) INTO problem
  FROM (
    SELECT (regexp_matches(def, '''([^'']+)''', 'g'))[1] AS lit
  ) AS x
  WHERE lit NOT IN ('accepted', 'accepted_edited', 'rejected', 'undone');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: decision CHECK allows unexpected state(s): %. The contract is exactly accepted / accepted_edited / rejected / undone', problem;
  END IF;

  -- (9) hash CHECK still pins the ANCHORED 64-hex shape. An unanchored variant
  --     would admit "<raw text><64 hex><more>" — the very leak it prevents.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = tbl_oid AND conname = 'stella_suggestion_decisions_prev_hash_check';
  IF def IS NULL OR position('''^[0-9a-f]{64}$''' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: previous_value_hash CHECK missing or not anchored: %', COALESCE(def, '<absent>');
  END IF;

  -- (10) RLS enabled — and FORCE explicitly OFF.
  --      FORCE matters as much as RLS itself here: the whole write path rests
  --      on the owner bypassing row-level security. With FORCE ON the owner
  --      stops bypassing, and since there is deliberately no INSERT policy,
  --      every write would fail — while this script still reported success.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: ROW LEVEL SECURITY is not enabled';
  END IF;
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: FORCE ROW LEVEL SECURITY is ON. The owner would stop bypassing RLS and, with no INSERT policy, recordStellaDecision could never write. Turn it off, or add an explicit INSERT policy through its own gate';
  END IF;

  -- (11) Exactly one policy: org-scoped SELECT, and nothing else.
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 1 RLS policy, found %. INSERT/UPDATE/DELETE must stay denied by absence', n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = tbl_oid
      AND polname = 'stella_suggestion_decisions_select'
      AND polcmd = 'r'                                   -- SELECT
      AND position('current_user_org_ids' in pg_get_expr(polqual, polrelid)) > 0
      AND position('current_user_is_super_admin' in pg_get_expr(polqual, polrelid)) > 0
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: the SELECT policy is missing, is not SELECT-only, or lost its org scoping';
  END IF;

  -- (12) Exactly one BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger.
  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgrelid = tbl_oid AND NOT tgisinternal
    AND tgname = 'trg_stella_suggestion_decisions_append_only'
    AND (tgtype & 1) = 1 AND (tgtype & 2) = 2        -- ROW, BEFORE
    AND (tgtype & 16) = 16 AND (tgtype & 8) = 8      -- UPDATE, DELETE
    AND (tgtype & 4) = 0;                            -- never INSERT
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 1 BEFORE UPDATE OR DELETE FOR EACH ROW trigger, found %', n;
  END IF;

  -- (13) Exactly one BEFORE TRUNCATE ... FOR EACH STATEMENT trigger.
  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgrelid = tbl_oid AND NOT tgisinternal
    AND tgname = 'trg_stella_suggestion_decisions_no_truncate'
    AND (tgtype & 1) = 0 AND (tgtype & 2) = 2        -- STATEMENT, BEFORE
    AND (tgtype & 32) = 32;                          -- TRUNCATE
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 1 BEFORE TRUNCATE FOR EACH STATEMENT trigger, found %', n;
  END IF;

  -- (14) Both triggers call public.uellix_forbid_mutation(), and no other
  --      non-internal trigger exists on this table.
  SELECT count(*) INTO n FROM pg_trigger t
  WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal
    AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')::oid;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected 2 triggers bound to public.uellix_forbid_mutation(), found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = tbl_oid AND NOT tgisinternal;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected extra trigger(s) on the table (total %, expected 2)', n;
  END IF;

  -- (15)(16)(17)(18) Privileges, read as DIRECT ACL entries only.
  --   anon         -> nothing
  --   authenticated-> exactly SELECT
  --   service_role -> nothing
  --   and no write-ish privilege for any of the three.
  SELECT string_agg(g.rolname || ':' || a.privilege_type, ', ' ORDER BY g.rolname, a.privilege_type)
    INTO problem
  FROM pg_class c,
       aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND g.rolname IN ('anon', 'authenticated', 'service_role')
    -- `AND NOT a.is_grantable`: the one allowed entry is a PLAIN SELECT. A
    -- SELECT WITH GRANT OPTION (rendered `authenticated=r*/postgres`) would
    -- otherwise be excluded here and pass unreported, even though it lets
    -- authenticated re-grant SELECT to anon.
    AND NOT (g.rolname = 'authenticated' AND a.privilege_type = 'SELECT' AND NOT a.is_grantable);

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected DIRECT privilege(s) present: %. Target is: authenticated=SELECT only; anon and service_role none. A REVOKE only removes grants from the current grantor — investigate other grantors', problem;
  END IF;

  -- PUBLIC separately: it is grantee OID 0 and has no pg_roles row, so the
  -- JOIN above cannot see it. A grant to PUBLIC would reach every role in the
  -- cluster, including anon.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = tbl_oid AND a.grantee = 0;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: PUBLIC holds privilege(s): %. That reaches every role in the cluster, anon included', problem;
  END IF;

  -- ...and the one privilege that must NOT have been over-revoked.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c,
         aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = tbl_oid AND g.rolname = 'authenticated' AND a.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: authenticated LOST its direct SELECT grant — the RLS read path would deny every user';
  END IF;

  -- (19) NOT CHECKED AT RUNTIME, deliberately.
  --      An earlier revision raised here if public.evidence_chunks existed,
  --      meaning to assert "this script created no foreign object". That was
  --      WRONG and broke the convergence this file promises:
  --      db/prepared/grounding_0001_evidence_chunks.sql legitimately creates
  --      that table on the SAME database under its own gate (G5 P3). Once G5 P3
  --      is applied, every re-run of this script would abort the whole
  --      transaction with a misleading message.
  --      The real invariant — that THIS file never creates it — is static, not
  --      runtime: the EXECUTABLE sql never mentions evidence_chunks (it appears
  --      only in these comments), and tests/prepared-stella-sql.test.ts pins
  --      that, asserting its absence from the comment-stripped script. A
  --      runtime check cannot distinguish "I created it" from "another gate
  --      did", so it must not try.

  -- (20) NOT CHECKED AT RUNTIME either, for a different reason: it is
  --      unfalsifiable. defaclacl is aclitem[] — 'grantee=privs/grantor' — and
  --      never contains a table name, so searching it for
  --      'stella_suggestion_decisions' always returns 0. The previous form was
  --      a check that could never fire while reporting itself as verified.
  --      That this script issues no ALTER DEFAULT PRIVILEGES is, again, a
  --      static property enforced offline.

  RAISE NOTICE 'stella_0003: verification passed — table owned by %, column contract exact (11 columns, no extras), PK, 4 FKs all NO ACTION, 0 UNIQUE, both CHECKs, RLS on (FORCE off) with 1 SELECT policy, 2 append-only triggers, authenticated=SELECT only (not grantable), anon/service_role=none.', tbl_owner;
END $$;
