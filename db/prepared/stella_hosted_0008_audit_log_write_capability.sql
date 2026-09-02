-- db/prepared/stella_hosted_0008_audit_log_write_capability.sql
-- G1-B PRECONDITIONS — the hosted half of the audit_logs INSERT policy.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_hosted_0008_rollback.sql.
--
-- PRECHAIN ADMINISTRATIVE UNIT, registered and pinned by digest in
-- db/hosted/prechain-ownership.ts. NOT a member of HOSTED_CHAIN.
--
-- APPLIED THROUGH THE ADMINISTRATIVE HOSTED SESSION, in one transaction:
--   psql "$UELLIX_STAGING_ADMIN_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- NOT YET APPLIED TO ANY DATABASE.
--
-- ============================================================================
-- WHAT IS BROKEN, MEASURED
-- ============================================================================
-- On the hosted staging project, `public.audit_logs` has RLS ENABLED and
-- EXACTLY ONE policy. From the catalog observation kept in this repository —
-- artifacts/hosted-chain-posture-observation-postcred.json:
--
--     { name: 'audit_logs_select_member_or_admin', command: 'SELECT',
--       relation: 'public.audit_logs' }
--
-- There is NO INSERT policy. `uellix_app` is NOBYPASSRLS and owns nothing, so
-- every `INSERT INTO public.audit_logs` from the runtime is refused by
-- row-level security.
--
-- It is refused DESPITE the table privilege being correct:
-- `stella_hosted_0007` §1 grants `SELECT, INSERT ON public.audit_logs TO
-- uellix_writer`, and `stella_hosted_0001` §433 grants
-- `uellix_writer TO uellix_app WITH INHERIT TRUE`. The GRANT is present, the
-- POLICY is absent, and RLS denies by default when no permissive policy applies.
-- That posture is SAFE (nothing unauthorised can write) and FUNCTIONALLY DEAD
-- (nothing authorised can either).
--
-- ============================================================================
-- WHY THE HOSTED SIDE NEVER GOT IT
-- ============================================================================
-- The policy exists locally, created by `stella_0005c_runtime_policy_scope.sql`
-- (and before it `stella_0005`). Both are LOCAL-ONLY packages applied through
-- `pnpm db:prepared:apply:local`; neither is a member of HOSTED_CHAIN and
-- neither appears in db/hosted/hosted-package-manifest.ts. This is the same
-- class of omission `stella_hosted_0006` and `stella_hosted_0007` closed for
-- the FUNCTION and TABLE layers of stella_0004 §6 — the POLICY layer of
-- stella_0005c is the third one, and the last one the runtime needs.
--
-- ============================================================================
-- WHO APPLIES IT, AND WHY THAT SENTENCE HAD TO BE REWRITTEN
-- ============================================================================
-- THE CORRECTION. The first revision of this package demanded
-- `current_user = uellix_owner` and described that role as "the owner of the
-- policies on public.audit_logs". That is true LOCALLY, where stella_0004
-- transfers every relation in `public` to uellix_owner. It is FALSE on the
-- hosted project, and the same observation this package quotes above says so:
--
--     { "relation": "public.audit_logs", "owner": "postgres" }
--
-- `stella_hosted_0001` §399 transfers exactly ONE relation to uellix_owner —
-- public.stella_interactions — and `stella_hosted_0007` verifies that no owner
-- moved. So the demand made the package UNAPPLIABLE on the target it was
-- written for: as `uellix_owner` (rolsuper = false, MEASURED) the policy DDL
-- raises 42501 "must be owner of relation audit_logs", and as the identity that
-- IS the owner the precondition itself aborted. Both doors shut.
--
-- WHAT REPLACES IT is the shape stella_hosted_0007 already proved on this
-- project, stated as a sequence rather than as a role name:
--
--     administrative hosted session
--       -> MEASURED table owner   (pg_class.relowner, never a literal)
--       -> tightly-scoped policy DDL under the identity PostgreSQL requires
--       -> restored administrative identity, asserted
--
-- §0.6 measures the owner and admits exactly two outcomes, refusing everything
-- else. Nothing here assumes the owner is uellix_owner; nothing here assumes it
-- is postgres either.
--
--   SESSION_IS_OWNER    the administrative session already owns the table.
--                       This is the hosted posture today. NO role switch is
--                       issued — a SET ROLE to the role you already are is a
--                       line of ceremony that teaches a reader the wrong thing
--                       about why the other branch exists.
--   OWNER_ASSUMABLE     the table is owned by uellix_owner and this session can
--                       act as it or SET ROLE to it. §1 opens a SET LOCAL ROLE
--                       window around the policy DDL and closes it immediately,
--                       exactly as stella_hosted_0007 §4 does for the one table
--                       it grants on.
--   anything else       REFUSED, naming the owner it measured. A third owner is
--                       a fact about this database nobody has reviewed, and a
--                       package that seized a relation from a principal it
--                       cannot already act as would be doing the one thing this
--                       whole prechain family exists to avoid.
--
-- AND THE OTHER HALF OF THE SAME DEFECT, §0.7: whichever identity ends up
-- ISSUING the DDL must be able to RESOLVE the predicate. `CREATE POLICY`
-- analyses its WITH CHECK at creation time and this one names `auth.uid()`; on
-- managed Supabase the `auth` schema is owned by supabase_admin and its ACL
-- admits `postgres` and not the uellix_* roles. MEASURED on PostgreSQL 17.6 by
-- scripts/audit-capability-identity-dry-run.sh §11: with the table moved to
-- uellix_owner, the first revision's identity would have died inside the
-- CREATE POLICY with `permission denied for schema auth` — a second wall behind
-- the ownership one, and equally invisible from reading the file. §0.7 refuses
-- in advance, naming the missing privilege.
--
-- WHY uellix_owner IS SPELLED STATICALLY IN THAT ONE BRANCH. The role name in
-- SET LOCAL ROLE cannot come from a variable without dynamic SQL, and
-- tests/prepared-stella-sql.test.ts refuses dynamic DDL across every prepared
-- script for reasons that outrank this one. stella_hosted_0007 §0.5b resolved
-- the same tension the same way: the branch is spelled statically and the
-- PRECONDITION that admits it is spelled statically next to it, so the package
-- refuses in §0 with a sentence rather than failing inside a DDL statement.
-- The DECISION is measured; only the fallback identity is a literal.
--
-- ============================================================================
-- WHY THE PREDICATE IS COPIED AND NOT ADAPTED
-- ============================================================================
-- The WITH CHECK below is stella_0005c's, character for character. A hosted
-- policy that were merely SIMILAR would mean two tenancy rules to review
-- instead of one, and the difference between them would live in nobody's head.
-- tests/stella-audit-log-write-capability.test.ts compares the two bodies after
-- whitespace normalisation and fails if they diverge.
--
-- What the predicate says, and why each half is load-bearing:
--
--   actor_user_id = auth.uid()
--     Every appended row attributes itself to the SESSION's user. A NULL actor
--     from the runtime role is always a bug or a forgery — stella_0005c dropped
--     the actor_user_id IS NULL branch deliberately, super admins included —
--     and the caller cannot name someone else, because auth.uid() reads
--     request.jwt.claims, which only the identity context sets.
--
--   organization_id IS NOT NULL AND organization_id = ANY (current_user_org_ids())
--     The row lands in an organization the session actually belongs to. This is
--     the cross-tenant boundary for the audit trail, and it is enforced by the
--     DATABASE rather than by the caller passing the right value.
--
--   OR public.current_user_is_super_admin()
--     The one widening, and it does NOT widen the actor binding: a super admin
--     appends under their own name like everybody else.
--
-- ============================================================================
-- WHAT THIS PACKAGE DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It GRANTS NOTHING, to anyone. The table privilege already exists
--     (stella_hosted_0007 §1); the missing piece was only ever the policy. §2
--     compares the table ACL captured before the DDL against the one after it
--     and refuses if a single entry moved.
--   * It TRANSFERS NO OWNERSHIP. It issues no ALTER TABLE ... OWNER TO, and §2
--     compares the owner it measured in §0 against the owner afterwards.
--     Moving public.audit_logs to uellix_owner would "fix" the applicability
--     problem by changing the hosted ownership topology that stella_hosted_0007
--     was just certified against — a far larger change, in a package whose
--     whole contract is that it creates one policy.
--   * It creates NO policy for `authenticated`, `service_role`, `anon` or
--     PUBLIC. A policy with no TO clause is TO PUBLIC and would re-open the M1
--     finding stella_0005c closed: a caller with a valid user JWT writing to
--     audit_logs through PostgREST, bypassing the application entirely.
--   * It does not enable, disable or force RLS, does not touch the SELECT
--     policy, the append-only trigger, any other table, any role or any owner.
--   * It uses no CASCADE and no identifier built from a variable.
--
-- Idempotent AND convergent: DROP POLICY IF EXISTS + CREATE POLICY converges an
-- already-correct database, and a database carrying a DIFFERENT policy of the
-- same name is converged to this one rather than left ambiguous.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================
DO $$
DECLARE
  v_relrowsecurity boolean;
  v_owner          name;
  v_issuer         name;
  v_acl            text;
BEGIN
  -- 0.1 The table must exist. Everything below reads it.
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008 aborted: table public.audit_logs not found.';
  END IF;

  -- 0.2 RLS MUST ALREADY BE ENABLED. This package creates a PERMISSIVE policy,
  --     and a permissive policy on a table with RLS off is decoration: every
  --     role would read and write freely and the postcondition below would
  --     still pass. Refuse rather than install a fence around an open field.
  SELECT c.relrowsecurity INTO v_relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'audit_logs';

  IF v_relrowsecurity IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: row level security is not enabled on public.audit_logs. A permissive INSERT policy on a table without RLS grants nothing and hides that fact.';
  END IF;

  -- 0.3 The runtime role must exist and must already hold the table privilege.
  --     Without it the policy would be installed next to a 42501 and the gap
  --     would look closed while the runtime still could not write.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_hosted_0008 aborted: role uellix_app does not exist.';
  END IF;

  IF NOT has_table_privilege('uellix_app', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: uellix_app holds no INSERT privilege on public.audit_logs. Apply stella_hosted_0007 first — this package supplies the POLICY half only and grants nothing.';
  END IF;

  -- 0.4 The two helper functions the predicate calls must be reachable by the
  --     runtime. They are SECURITY DEFINER and stella_hosted_0006 grants them;
  --     without EXECUTE the policy evaluates to a 42501 rather than to false.
  IF NOT has_function_privilege('uellix_app', 'public.current_user_org_ids()', 'EXECUTE')
     OR NOT has_function_privilege('uellix_app', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: uellix_app cannot EXECUTE the RLS helper functions the policy predicate calls. Apply stella_hosted_0006 first.';
  END IF;

  -- 0.5 THE PRESTATE OF THE THREE THINGS THIS PACKAGE MUST NOT MOVE.
  --     Captured HERE, before any DDL, and compared in §2. Transaction-local
  --     settings rather than a temporary table: nothing is created, nothing
  --     survives the COMMIT, and a ROLLBACK takes them with it.
  SELECT pg_catalog.pg_get_userbyid(c.relowner), COALESCE(c.relacl::text, '')
    INTO v_owner, v_acl
  FROM pg_class c WHERE c.oid = 'public.audit_logs'::regclass;

  PERFORM set_config('uellix.h0008_owner_pre', v_owner, true);
  PERFORM set_config('uellix.h0008_acl_pre', v_acl, true);

  -- 0.6 THE IDENTITY DECISION, MEASURED. See the header: two admitted outcomes,
  --     everything else refused by name.
  IF v_owner = current_user THEN
    v_issuer := current_user;
    PERFORM set_config('uellix.h0008_assume_owner', 'no', true);
    RAISE NOTICE 'stella_hosted_0008: public.audit_logs is owned by % and this session IS that role. SESSION_IS_OWNER — the policy DDL is issued directly and no role is assumed.', v_owner;

  ELSIF v_owner = 'uellix_owner'
        AND (pg_catalog.pg_has_role(current_user, 'uellix_owner', 'USAGE')
             OR pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET')) THEN
    v_issuer := 'uellix_owner';
    PERFORM set_config('uellix.h0008_assume_owner', 'yes', true);
    RAISE NOTICE 'stella_hosted_0008: public.audit_logs is owned by uellix_owner and this session (%) can act as it. OWNER_ASSUMABLE — the policy DDL is issued inside a SET LOCAL ROLE window that closes immediately.', current_user;

  ELSE
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: public.audit_logs is owned by % and this session (%) is neither that role nor able to assume it. CREATE POLICY and DROP POLICY require ownership of the table and no privilege substitutes for it. Apply this package through the administrative hosted session that owns the baseline relations — and if the owner is a role this repository does not model, that is a fact about this database to review rather than to work around.',
      v_owner, current_user;
  END IF;

  -- 0.7 THE ISSUING IDENTITY MUST BE ABLE TO RESOLVE THE PREDICATE.
  --     MEASURED, and it is the second half of the same defect the ownership
  --     check closes. `CREATE POLICY` parses and analyses its WITH CHECK at
  --     creation time, and this one names `auth.uid()`. On managed Supabase the
  --     `auth` schema is owned by supabase_admin and its ACL admits `postgres`
  --     but NOT the uellix_* roles — so an issuer that is not the
  --     administrative session fails with `permission denied for schema auth`
  --     INSIDE the CREATE POLICY, several hundred lines after the identity
  --     checks all passed.
  --
  --     REPRODUCED on PostgreSQL 17.6 by
  --     scripts/audit-capability-identity-dry-run.sh §11, which is why this is
  --     a precondition and not a comment. Today it is unreachable — the hosted
  --     owner IS the administrative session — and it exists for the database
  --     where that stops being true, so the refusal names the missing privilege
  --     instead of the statement that tripped over it. The remedy would be the
  --     same shape stella_hosted_0004 already has for schema `storage`: one
  --     package, one USAGE, reviewed on its own.
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: auth.uid() does not exist. The policy predicate names it, and CREATE POLICY resolves its WITH CHECK at creation time.';
  END IF;

  IF NOT has_schema_privilege(v_issuer, 'auth', 'USAGE')
     OR NOT has_function_privilege(v_issuer, 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: the identity that would issue the policy DDL (%) cannot resolve auth.uid() — it lacks USAGE on schema auth, EXECUTE on the function, or both. The WITH CHECK names auth.uid() and is analysed at CREATE POLICY time, so this is a hard failure and not a runtime one. On managed Supabase the auth schema is owned by supabase_admin and admits the administrative session; granting a uellix_* role USAGE on it is a separate question, in the shape stella_hosted_0004 uses for schema storage, and not something this package will decide.',
      v_issuer;
  END IF;
END $$;

-- ============================================================
-- 1. The policy. stella_0005c's, verbatim, under the required identity.
-- ============================================================
-- The DDL lives inside a block because the role window is CONDITIONAL, and a
-- conditional at the top level of a SQL file does not exist. The window is
-- LOCAL: it is undone by the enclosing COMMIT or ROLLBACK whatever happens,
-- RESET ROLE closes it in the same block that opened it, and §2 asserts the
-- session came back regardless of which branch ran.
DO $$
DECLARE
  v_decision text := NULLIF(current_setting('uellix.h0008_assume_owner', true), '');
BEGIN
  -- Fail closed on an unset decision. A ROLLBACK TO SAVEPOINT between §0 and
  -- here leaves the setting as the empty string rather than as NULL — the
  -- reason NULLIF is not decoration — and an empty decision must never be read
  -- as "no role switch needed".
  IF v_decision IS NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: the identity decision from section 0 is not present in this transaction. This block refuses to guess which identity the policy DDL needs.';
  END IF;

  IF v_decision = 'yes' THEN
    SET LOCAL ROLE uellix_owner;
  ELSIF v_decision <> 'no' THEN
    RAISE EXCEPTION 'stella_hosted_0008 aborted: unrecognised identity decision "%".', v_decision;
  END IF;

  DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;
  CREATE POLICY audit_logs_insert_member_or_admin
    ON public.audit_logs
    FOR INSERT
    TO uellix_app
    WITH CHECK (
      actor_user_id = auth.uid()
      AND (
        (
          organization_id IS NOT NULL
          AND organization_id = ANY (public.current_user_org_ids())
        )
        OR public.current_user_is_super_admin()
      )
    );

  COMMENT ON POLICY audit_logs_insert_member_or_admin ON public.audit_logs IS
    'prepared stella_hosted_0008: the hosted half of stella_0005c. The application appends its own audit trail as uellix_app, bound to the session actor and to an organization the session belongs to. No client role has an INSERT policy or an INSERT grant on this table.';

  IF v_decision = 'yes' THEN
    RESET ROLE;
  END IF;
END $$;

-- ============================================================
-- 2. Postconditions — assert the end state
-- ============================================================
DO $$
DECLARE
  v_roles     text;
  v_cmd       text;
  v_check     text;
  v_stray     text;
  v_owner_pre text := NULLIF(current_setting('uellix.h0008_owner_pre', true), '');
  v_acl_pre   text := current_setting('uellix.h0008_acl_pre', true);
  v_owner_now text;
  v_acl_now   text;
  v_rls_now   boolean;
BEGIN
  -- (0) THE SESSION CAME BACK. Section 1 may have changed role; if it had not
  --     been given back, every measurement below would describe uellix_owner's
  --     view instead of the executor's, and the package would end leaving a
  --     transaction in a role nobody asked for. Asserted on BOTH branches, not
  --     only on the one that switches — a check that ran only where it could
  --     fail is a check nobody can read as a guarantee.
  IF current_user <> session_user THEN
    RAISE EXCEPTION
      'stella_hosted_0008 FAILED verification: the session is still acting as % rather than %. The policy block issues RESET ROLE in the same block that opened the window.',
      current_user, session_user;
  END IF;

  SELECT p.roles::text, p.cmd, p.with_check
    INTO v_roles, v_cmd, v_check
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'audit_logs'
    AND p.policyname = 'audit_logs_insert_member_or_admin';

  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the policy was not created';
  END IF;
  IF v_cmd <> 'INSERT' THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: policy command is % (expected INSERT)', v_cmd;
  END IF;
  IF v_roles <> '{uellix_app}' THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: policy applies to % (expected {uellix_app})', v_roles;
  END IF;
  IF v_check IS NULL OR position('auth.uid()' in v_check) = 0 THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the actor binding is missing from WITH CHECK';
  END IF;
  IF position('current_user_org_ids()' in v_check) = 0 THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the tenant binding is missing from WITH CHECK';
  END IF;
  IF position('current_user_is_super_admin()' in v_check) = 0 THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the super-admin widening is missing from WITH CHECK';
  END IF;

  -- The other direction, and the one an INSTALL check silently gets wrong: no
  -- OTHER INSERT policy may exist on this table. A second one would be OR-ed
  -- with this one, so a permissive stray would defeat the binding above
  -- entirely while every assertion so far still passed.
  SELECT string_agg(p.policyname || ' -> ' || p.roles::text, ', ' ORDER BY p.policyname)
    INTO v_stray
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'audit_logs'
    AND p.cmd IN ('INSERT', 'ALL')
    AND p.policyname <> 'audit_logs_insert_member_or_admin';

  IF v_stray IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0008 postcondition failed: a second write policy exists on public.audit_logs [%]. Permissive policies are OR-ed, so it would defeat the actor and tenant binding.',
      v_stray;
  END IF;

  -- THE THREE THINGS THAT MUST NOT HAVE MOVED, compared against the prestate
  -- rather than asserted from the fact that no statement here writes them.
  SELECT pg_catalog.pg_get_userbyid(c.relowner), COALESCE(c.relacl::text, ''), c.relrowsecurity
    INTO v_owner_now, v_acl_now, v_rls_now
  FROM pg_class c WHERE c.oid = 'public.audit_logs'::regclass;

  IF v_owner_pre IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the owner measured before the DDL is not present in this transaction, so "the owner did not move" cannot be checked.';
  END IF;
  IF v_owner_now <> v_owner_pre THEN
    RAISE EXCEPTION
      'stella_hosted_0008 postcondition failed: public.audit_logs is now owned by % and was owned by % when this package started. It issues no ALTER TABLE ... OWNER TO, and its role window changes who ISSUES the policy, never who OWNS the table.',
      v_owner_now, v_owner_pre;
  END IF;
  IF v_acl_now IS DISTINCT FROM v_acl_pre THEN
    RAISE EXCEPTION
      'stella_hosted_0008 postcondition failed: the ACL of public.audit_logs changed from [%] to [%]. This package grants nothing to anyone.',
      v_acl_pre, v_acl_now;
  END IF;
  IF v_rls_now IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: row level security is no longer enabled on public.audit_logs.';
  END IF;

  RAISE NOTICE 'stella_hosted_0008: audit_logs_insert_member_or_admin INSERT TO uellix_app. OK.';
END $$;
