-- ============================================================================
-- stella_hosted_0010_entitlement_grants_acl_hardening.sql
-- CE-3 — the entitlement_grants / entitlement_effective ACL hardening unit.
-- ============================================================================
--
-- CATEGORY D — PRECHAIN ACL HARDENING UNIT. A FOURTH hosted disposition, and
-- deliberately not a widening of category C: C is "an administrative unit that
-- normalises an owner", and the only state-changing statement class this unit
-- is allowed to issue is REVOKE. Frozen by
-- docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2.json
-- HOSTED0010_CONTRACT, narrowed from
-- docs/ops/commercial/COMMERCIAL_ACCOUNT_ENTITLEMENT_AUTHORITY_AMENDMENT_v1.0.2.json
-- FUTURE_HOSTED_PACKAGE_CONTRACT_0010.
--
-- APPLY WINDOW: prechain, AFTER stella_hosted_0009_entitlement_evaluator_ownership.
-- FORWARD-ONLY. NO ROLLBACK FILE, and that absence is BINDING rather than an
-- omission: a script whose only effect is to hand a tenant role TRUNCATE on
-- entitlement_grants again, and a BYPASSRLS platform role a direct read of
-- every organization's grants, is a script that reopens a security defect
-- invisibly. See db/hosted/forward-only-packages.ts for the recorded reason.
--
-- APPLY WITH psql -1. Pre-state capture, every REVOKE, every role window and
-- every postcondition run in ONE transaction. The capture lives in
-- transaction-local set_config(..., true) settings, so a package applied
-- statement-by-statement loses it and §2 REFUSES rather than silently
-- comparing a value it has just re-read.
--
-- ---------------------------------------------------------------------------
-- WHAT DEFECT THIS CLOSES, AND WHY A MIGRATION COULD NOT
-- ---------------------------------------------------------------------------
-- db/migrations/0073 states the property in its own prose: "a direct
-- `SELECT * FROM entitlement_grants` as a tenant identity must fail 42501 on
-- PRIVILEGE, before RLS is ever consulted". On the hosted platform that
-- sentence is FALSE, and not because 0073 is wrong — because it cannot reach
-- the cause. Supabase installs, PER DATABASE, default privileges equivalent to
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
-- TABLES TO authenticated, service_role. MEASURED on
-- public.ecr.aws/supabase/postgres:17.6.1.143, pg_default_acl carries
-- {postgres=arwdDxtm,anon=arwdDxtm,authenticated=arwdDxtm,service_role=arwdDxtm}
-- for tables in schema public, and a table created afterwards by the baseline
-- applier is BORN carrying those grants. So:
--
--   D1  `authenticated` holds table privileges including `D` — TRUNCATE, which
--       is NOT a row operation: it does not consult row-level security and it
--       does not fire a FOR EACH ROW trigger. The append-only guard 0073
--       installs is BEFORE UPDATE OR DELETE FOR EACH ROW, so it never sees a
--       TRUNCATE either. A tenant role could empty the relation, and neither
--       of the two controls CE-3 relies on would fire.
--
--   D2  `service_role` holds arwdDxtm AND rolbypassrls = true. Row-level
--       security is therefore NOT the mechanism protecting anything from it;
--       only the ABSENCE of the privilege is. With the privilege present it
--       reads every organization's grants directly, across tenants.
--
-- Neither is repairable by a migration: BASELINE_GLOBAL_INVARIANTS pins every
-- baseline unit at zero ownership statements, the grants are inherited at
-- CREATE time from a platform default the baseline never wrote, and their
-- grantor is the baseline applier rather than any role a migration runs as.
-- That is the same shape of reason stella_hosted_0009 exists for the
-- evaluator's owner.
--
-- ---------------------------------------------------------------------------
-- THE GRANTOR / ANTI-SEIZURE DOCTRINE — the load-bearing half of this file
-- ---------------------------------------------------------------------------
-- A REVOKE only strips privileges the CURRENT role granted. Issued by anyone
-- else PostgreSQL raises
--
--     WARNING:  no privileges could be revoked for "entitlement_grants"
--
-- changes NOTHING, and THE TRANSACTION STILL COMMITS. MEASURED on the pinned
-- image: a REVOKE of a grantor_role-granted SELECT, issued as postgres, warns
-- and leaves `grantee_role=r/grantor_role` exactly in place, with exit code 0.
-- A package that trusted its own REVOKE statements would therefore report a
-- hardening it had not performed.
--
-- So this unit NEVER assumes a revoking identity. For every (grantee,
-- privilege) pair it intends to revoke it MEASURES the grantor out of the
-- object's own ACL through aclexplode — never assuming postgres, never
-- assuming uellix_owner — and it decides by RE-READING the ACL afterwards
-- rather than by the presence or absence of the WARNING.
--
-- THE APPROVED GRANTOR SET IS CLOSED at the object's measured current owner
-- and uellix_owner. It is expressed RELATIVE TO THE OWNER and the owner is
-- read from pg_class.relowner / pg_proc.proowner, so the set is a PREDICATE
-- over measured state and not a list of frozen names. Two things are decided
-- separately, and conflating them is a defect:
--
--   APPROVAL   is the grantor one this package will adjudicate at all? Only
--              the object's measured current owner, or uellix_owner. Anything
--              else is an unexplained provenance and is REFUSED — even if the
--              session could trivially act as it.
--
--   STANDING   may this session act as that grantor? Either grantor =
--              current_user, or pg_has_role(current_user, grantor, 'SET').
--              An approved grantor the session cannot assume is REFUSED
--              BEFORE any mutation, because the attempt would warn, change
--              nothing and still commit.
--
-- EXECUTION follows the measured grantor rather than a frozen name:
--
--   DIRECT     grantor = current_user. The REVOKE is issued as-is and NO role
--              window is opened. On the hosted shape this is the TABLE arm:
--              the relation's inherited grants carry grantor `postgres`,
--              which is also the administrative applier.
--
--   ASSUMED    any other approved, assumable measured grantor. The session
--              enters it with set_config('role', <measured value>, true),
--              issues the same literal REVOKE, RE-READS the ACL to prove the
--              pair is gone, and restores with set_config('role','none',true).
--              On the hosted shape this is the EVALUATOR arm, where
--              stella_hosted_0009 has re-attributed the non-owner EXECUTE
--              grants to uellix_owner — reached because it is MEASURED there,
--              not because this file named it in advance.
--
-- AN EARLIER REVISION REFUSED THE ASSUMED ARM FOR ANY GRANTOR OTHER THAN A
-- LITERAL uellix_owner, on the stated ground that a category-D unit forbidding
-- dynamic SQL could not act as a role it had not frozen. THAT GROUND WAS
-- FALSE. `SET LOCAL ROLE <name>` takes an IDENTIFIER and would indeed have
-- required constructed SQL; set_config('role', g, true) takes a VALUE and does
-- not. The narrowing under-supported a topology the contract authorizes — a
-- table owned by a measured administrative role other than the applier — and
-- is corrected here. The APPROVED SET IS UNCHANGED: this widens execution
-- support, never approval.
--
-- Refusing remains the fail-closed answer; manufacturing standing remains the
-- answer this package is forbidden to give. It issues no GRANT, creates no
-- role, grants itself no membership and transfers no ownership — EVER, and not
-- merely "not by default".
--
-- ---------------------------------------------------------------------------
-- WHAT THIS PACKAGE DOES NOT DO
-- ---------------------------------------------------------------------------
-- No GRANT. No CREATE. No DROP. No ALTER of any kind, including ALTER OWNER
-- and ALTER FUNCTION. No CREATE POLICY and no DROP POLICY. No INSERT, UPDATE,
-- DELETE or TRUNCATE. No CREATE ROLE and no role-membership GRANT. No function
-- body replacement. No dynamic SQL and no EXECUTE format(...). No
-- schema-wide ALL TABLES / ALL FUNCTIONS wildcard form. It names exactly TWO
-- objects and no third:
--
--     public.entitlement_grants
--     public.entitlement_effective(uuid,varchar)
--
-- It does NOT repair an invalid precondition. It does not create a missing
-- role, does not GRANT `authenticated` the EXECUTE the contract requires, does
-- not enable FORCE ROW LEVEL SECURITY, does not author a policy and does not
-- silently strip an unexpected third grantee. Every one of those is a REFUSAL,
-- so that a human adjudicates the state rather than inheriting a package's
-- guess about it.
--
-- OWNER RESIDUAL. The owner's implicit privileges — including TRUNCATE — are
-- NOT removed and cannot be. They are ADMINISTRATIVE_RESIDUAL, never a tenant
-- and never a runtime permission, and the reason that is acceptable is
-- measured elsewhere rather than re-argued here: db/safety/database-role.ts
-- forbids postgres, supabase_admin, service_role, authenticator, uellix_owner
-- and uellix_migrator as runtime database roles, and RUNTIME_DATABASE_ROLE is
-- uellix_app. No Commercial V1 request path executes as the owner.
--
-- IDEMPOTENCY IS A REQUIREMENT, NOT A TOLERANCE. A second application against
-- an ALREADY_HARDENED target satisfies every precondition, issues ZERO
-- REVOKEs, satisfies every postcondition and exits successfully. That is
-- semantic convergence — measured by CE3-ACL-P-1, not PostgreSQL happening to
-- accept a redundant REVOKE.
--
-- ---------------------------------------------------------------------------
-- THIS SCRIPT'S SESSION SETTINGS, AND WHY THEY ARE NOT A STATEMENT CLASS
-- ---------------------------------------------------------------------------
-- `SET search_path = public;` below is THIS SCRIPT'S session setting, required
-- of every file in db/prepared/** by the corpus doctrine
-- tests/prepared-sql-source-of-truth.test.ts enforces. It governs how
-- unqualified names in THIS FILE resolve while it runs; every catalog
-- reference below is pg_catalog-qualified anyway, so it is defence in depth
-- rather than load-bearing.
--
-- It is NOT a state-changing statement and is not part of the REVOKE-only
-- class. `SET` changes a session variable, not a database object: it grants
-- nothing, creates nothing and leaves no catalog trace after the transaction.
-- The frozen prohibition list is GRANT, CREATE, DROP, ALTER, policy mutation,
-- table DDL, role creation or membership, function body replacement, DML and
-- dynamic SQL — and the same authority PERMITS SET LOCAL ROLE outright, under
-- the grantor doctrine, which would be incoherent if SET were itself a
-- forbidden class. The static detector CE3-ACL-N-4 measures that distinction
-- explicitly rather than inheriting it from this comment.
--
-- The TARGET FUNCTION'S OWN `SET search_path = public` is a different thing
-- entirely: it is frozen into pg_proc.proconfig by 0073, is part of the CE-3
-- contract, and is covered by the §0 digest that §2 re-asserts. Changing this
-- script's session setting would not change the function's, and changing the
-- function's is prohibited outright.
-- ============================================================================
SET search_path = public;
SET lock_timeout = '5s';


-- ============================================================
-- 0. Preconditions (ACL-PRE-1 .. ACL-PRE-16) and the pre-state capture
-- ============================================================
-- FAIL-CLOSED AND EXHAUSTIVE AS A FLOOR. Every one of these holds before a
-- single REVOKE is issued, and any failure RAISEs and aborts the whole
-- transaction, leaving the prior posture intact.
DO $$
DECLARE
  tbl_oid        oid;
  fn_oid         oid;
  tbl_owner      text;
  fn_owner       text;
  overloads      int;
  policy_n       int;
  tenant_n       int;
  trigger_n      int;
  missing        text;
  offending      text;
  bad_grantor    text;
BEGIN
  -- 0.1 ACL-PRE-1. The version floor. pg_has_role(..., 'SET') — the guard the
  --     whole anti-seizure doctrine rests on — exists from PostgreSQL 16. A
  --     lower major is a substrate on which the guard cannot be evaluated, and
  --     this package refuses rather than degrading to an unguarded REVOKE.
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: PostgreSQL % is below the 16 floor this package requires. pg_has_role(..., ''SET'') — the guard that proves this session may legitimately act as a measured ACL grantor — does not exist before 16, and a REVOKE issued without that guard is one that can warn and change nothing while reporting success.', current_setting('server_version');
  END IF;

  -- 0.2 ACL-PRE-2. Every role the two contracts name must EXIST. A REVOKE FROM
  --     a non-existent role is an error, and a contract over roles that are not
  --     there has not been measured. This package creates NO role.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing
  FROM (VALUES ('uellix_owner'), ('authenticated'), ('anon'), ('service_role'),
               ('uellix_app'), ('uellix_writer'), ('uellix_auditor'), ('uellix_migrator')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles pr WHERE pr.rolname = r.name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: the role(s) [%] named by the frozen TABLE and FUNCTION contracts do not exist. Apply stella_hosted_0000_managed_role_identity_bootstrap.sql (managed) or stella_0004_role_separation.sql (local) first. This package does not create a role to make its own precondition true.', missing;
  END IF;

  -- 0.3 ACL-PRE-3. The relation, by exact identity and relkind.
  SELECT c.oid, pg_catalog.pg_get_userbyid(c.relowner)
    INTO tbl_oid, tbl_owner
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants' AND c.relkind = 'r';
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: public.entitlement_grants does not exist as an ordinary relation. It is created by db/migrations/0073_commercial_account_ce3_entitlement_grants.sql; a target without it has not had CE-3 applied.';
  END IF;

  -- 0.4 ACL-PRE-4. ENABLE + FORCE ROW LEVEL SECURITY. Hardening a relation
  --     whose FORCE is off would leave the owner-policy arm of R-A unprotected
  --     for the one role the definer evaluator runs as. This package does NOT
  --     enable it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = tbl_oid AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: public.entitlement_grants does not carry ENABLE + FORCE ROW LEVEL SECURITY. 0073 sets both. Without FORCE the table OWNER is exempt from its own policy, and after stella_hosted_0009 that owner is exactly the role the SECURITY DEFINER evaluator runs as. This package hardens privileges and does not enable row-level security.';
  END IF;

  -- 0.5 ACL-PRE-5. EXACTLY ONE policy, FOR SELECT, addressed to exactly
  --     {uellix_owner}. R-A's single narrow policy. Zero is a relation the
  --     evaluator cannot read through; two is a combination nobody adjudicated.
  SELECT count(*) INTO policy_n
  FROM pg_catalog.pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename = 'entitlement_grants';
  IF policy_n <> 1 THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: % policies exist on public.entitlement_grants; R-A requires EXACTLY ONE. Zero is a relation the evaluator cannot read through; two is a combination nobody adjudicated.', policy_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'entitlement_grants'
      AND p.cmd = 'SELECT' AND p.roles::text = '{uellix_owner}'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: the single policy on public.entitlement_grants is not the frozen R-A shape (FOR SELECT, TO uellix_owner). A policy of a different command, or addressed to a different role set, is not the object this contract was written for.';
  END IF;

  -- 0.6 ACL-PRE-6. ZERO tenant-facing policies. R-C is PROHIBITED before
  --     tenancy S4; a tenant-facing policy at apply time means S4 was
  --     pre-empted, and this package refuses rather than blessing it by
  --     proceeding. The same refusal as stella_hosted_0009 PRE-12.
  SELECT count(*) INTO tenant_n
  FROM pg_catalog.pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename = 'entitlement_grants'
    AND p.roles::text <> '{uellix_owner}';
  IF tenant_n > 0 THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: % tenant-facing policies exist on public.entitlement_grants. 0073 authors none, and every tenant-facing policy decision is DEFERRED to tenancy S4. A target where one exists has pre-empted S4 and this package will not bless it by hardening around it.', tenant_n;
  END IF;

  -- 0.7 ACL-PRE-7. EXACTLY ONE evaluator, by exact regprocedure, SECURITY
  --     DEFINER. An overload is a second callable evaluator this package is not
  --     authorized to touch; an INVOKER function is not the object whose
  --     EXECUTE contract this is.
  fn_oid := pg_catalog.to_regprocedure('public.entitlement_effective(uuid,varchar)');
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: public.entitlement_effective(uuid,varchar) does not exist. It is created by db/migrations/0073_commercial_account_ce3_entitlement_grants.sql; a target without it has not had CE-3 applied.';
  END IF;
  SELECT count(*) INTO overloads
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'entitlement_effective';
  IF overloads <> 1 THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: % functions named public.entitlement_effective exist; 0073 creates exactly one. A sibling overload is a second callable evaluator whose EXECUTE posture this package is not authorized to adjudicate and must not silently leave behind.', overloads;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid AND p.prosecdef) THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: public.entitlement_effective(uuid,varchar) is not SECURITY DEFINER. The EXECUTE contract is about who may invoke a DEFINER evaluator; hardening an INVOKER function would restrict a call that never carried the definer''s authority in the first place.';
  END IF;

  -- 0.8 ACL-PRE-8. THE MEASURABLE FORM OF "hosted0009 PRECEDES hosted0010".
  --     It is asserted on the evaluator's OWNER rather than on a journal entry,
  --     because the owner is what makes the REVOKE arm's grantor stable and
  --     measured: after the transfer the function's non-owner EXECUTE grants
  --     are attributed to uellix_owner. This package does NOT transfer
  --     ownership to make its own precondition true.
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO fn_owner
  FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
  IF fn_owner <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: public.entitlement_effective(uuid,varchar) is owned by % rather than uellix_owner. That is the state db/prepared/stella_hosted_0009_entitlement_evaluator_ownership.sql exists to close, and applying it is a PREREQUISITE of this unit. This package hardens privileges; it does not transfer an owner to satisfy its own precondition.', fn_owner;
  END IF;

  -- 0.9 ACL-PRE-9. The two owner attributes v1.0.1 froze. A SUPERUSER or
  --     BYPASSRLS owner makes FORCE ROW LEVEL SECURITY inert for the very role
  --     the evaluator runs as, which would leave this hardening protecting a
  --     posture that was already hollow.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'uellix_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: uellix_owner has rolsuper = true. A superuser owner bypasses row-level security regardless of rolbypassrls, so the single R-A policy would be silently inert for the role the evaluator executes as and this hardening would be protecting nothing.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'uellix_owner' AND rolbypassrls) THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: uellix_owner has rolbypassrls = true. This is the arm 0073 refuses by name ("NO BYPASSRLS ANYWHERE"): FORCE ROW LEVEL SECURITY would be inert for every read the evaluator performs, and the CE-3 isolation probes would be measuring the exemption rather than the policy.';
  END IF;

  -- 0.10 ACL-PRE-15. THE APPLYING PRINCIPAL. Stated on IDENTITY rather than on
  --      a downstream capability failure, so the message names the real defect:
  --      an administrative unit applied by a runtime or tenant identity is
  --      applied by the wrong principal class, whatever it could or could not
  --      then do. Captured below, because §2 asserts the session was restored
  --      to exactly it.
  IF current_user IN ('uellix_app', 'uellix_writer', 'uellix_auditor', 'authenticated', 'anon', 'service_role') THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: the session is running as %, which is a runtime or tenant identity. This is a governed ADMINISTRATIVE unit and is applied by the same principal class that applies stella_hosted_0003..0009 — never by the application runtime, never by uellix_migrator and never by a tenant role.', current_user;
  END IF;

  -- 0.11 ACL-PRE-14. The append-only guard. This hardening is ADDITIVE to the
  --      row-level guard, never a replacement for it, and a relation missing
  --      the guard has not had 0073 applied as frozen. Asserted by SHAPE —
  --      BEFORE, UPDATE OR DELETE, FOR EACH ROW, and the exact function it
  --      calls — because a trigger of the same NAME with a different timing or
  --      level would satisfy a name check while enforcing nothing.
  SELECT count(*) INTO trigger_n
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE t.tgrelid = tbl_oid
    AND NOT t.tgisinternal
    AND t.tgname = 'trg_entitlement_grants_append_only'
    AND (t.tgtype & 1) = 1          -- FOR EACH ROW
    AND (t.tgtype & 2) = 2          -- BEFORE
    AND (t.tgtype & 16) = 16        -- UPDATE
    AND (t.tgtype & 8) = 8          -- DELETE
    AND n.nspname = 'public'
    AND p.proname = 'enforce_entitlement_grant_append_only';
  IF trigger_n <> 1 THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: the append-only guard trg_entitlement_grants_append_only is absent or is not the frozen shape (BEFORE UPDATE OR DELETE, FOR EACH ROW, EXECUTE FUNCTION public.enforce_entitlement_grant_append_only()). This package hardens privileges ADDITIVELY to that guard; on a relation that has not had 0073 applied as frozen it would be hardening half a node.';
  END IF;

  -- 0.12 ACL-PRE-13 and ACL-PRE-10, TABLE arm. The non-owner grantee set must
  --      be a SUBSET of {uellix_owner, authenticated, service_role} and
  --      uellix_owner must hold EXACTLY {SELECT}. A fourth grantee — PUBLIC
  --      included — is an unexplained state: this package neither tolerates it
  --      nor silently revokes it, because silently revoking a privilege nobody
  --      adjudicated is how a package stops being auditable.
  SELECT string_agg(DISTINCT x.grantee, ', ' ORDER BY x.grantee) INTO offending
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') AS grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE c.oid = tbl_oid
      AND coalesce(g.rolname, 'PUBLIC') <> tbl_owner
  ) AS x
  WHERE x.grantee NOT IN ('uellix_owner', 'authenticated', 'service_role');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: UNEXPECTED non-owner grantee(s) [%] hold a privilege on public.entitlement_grants. The allowed prestate family is a SUBSET of {uellix_owner, authenticated, service_role}; anything else — PUBLIC included — is a state nobody measured. This package REFUSES so that a human adjudicates it, and does NOT silently revoke it.', offending;
  END IF;

  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO offending
  FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND coalesce(g.rolname, 'PUBLIC') = 'uellix_owner'
    AND 'uellix_owner' <> tbl_owner
    AND a.privilege_type <> 'SELECT';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: uellix_owner holds [%] on public.entitlement_grants beyond the SELECT the frozen contract allows. 0073 grants it SELECT and nothing else; a wider grant is outside the measured prestate family and this package will not guess which half of it to strip.', offending;
  END IF;

  -- 0.13 ACL-PRE-13 and ACL-PRE-11, FUNCTION arm. The non-owner EXECUTE holder
  --      set must be a SUBSET of {authenticated, anon, service_role}, PUBLIC
  --      must hold NOTHING, and `authenticated` MUST be PRESENT.
  --
  --      authenticated is REQUIRED, not merely permitted, and its absence is a
  --      REFUSAL rather than a repair: 0073 line 284 grants it and the typed
  --      wrapper in lib/capabilities/** calls the evaluator as that role, so a
  --      target without it has not had 0073 applied as frozen. GRANT is
  --      PROHIBITED in category D, so "grant it back" is not an option this
  --      package has — which is exactly why the contract states the
  --      requirement as a PRECONDITION rather than as a postcondition to
  --      repair toward.
  SELECT string_agg(DISTINCT x.grantee, ', ' ORDER BY x.grantee) INTO offending
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') AS grantee
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') <> fn_owner
  ) AS x
  WHERE x.grantee NOT IN ('authenticated', 'anon', 'service_role');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: UNEXPECTED non-owner grantee(s) [%] hold EXECUTE on public.entitlement_effective(uuid,varchar). The allowed prestate family is a SUBSET of {authenticated, anon, service_role}, and PUBLIC holding anything is the defect stella_hosted_0009 PRE-13 already refuses. This package REFUSES rather than adjudicating an unmeasured grantee.', offending;
  END IF;

  IF NOT pg_catalog.has_function_privilege('authenticated', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: `authenticated` cannot EXECUTE public.entitlement_effective(uuid,varchar). That grant is REQUIRED by the frozen FUNCTION contract — 0073 line 284 issues it and the typed capability wrapper calls the evaluator as that role. Its absence means 0073 did not apply as frozen. GRANT is PROHIBITED in category D, so this package refuses rather than repairing a precondition it is not authorized to write.';
  END IF;

  -- 0.14 ACL-PRE-12. THE ANTI-SEIZURE GUARD, applied to every pair this
  --      package could revoke, on BOTH objects, BEFORE any mutation. The
  --      grantor is MEASURED from aclexplode — never assumed to be postgres and
  --      never assumed to be uellix_owner — and must be APPROVED (the object's
  --      measured current owner, or uellix_owner) AND assumable by this
  --      session.
  --
  --      FIRST: provenance. An unapproved grantor is an unexplained state.
  SELECT string_agg(DISTINCT x.grantor, ', ' ORDER BY x.grantor) INTO bad_grantor
  FROM (
    SELECT coalesce(gr.rolname, 'PUBLIC') AS grantor
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles g  ON g.oid  = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid
      AND coalesce(g.rolname, 'PUBLIC') IN ('authenticated', 'service_role')
    UNION ALL
    SELECT coalesce(gr.rolname, 'PUBLIC') AS grantor
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g  ON g.oid  = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') IN ('anon', 'service_role')
  ) AS x
  WHERE x.grantor NOT IN (tbl_owner, fn_owner, 'uellix_owner');
  IF bad_grantor IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: a privilege this package would revoke was granted by [%], which is not in the APPROVED grantor set (the object''s measured current owner, or uellix_owner). An unapproved grantor is an unexplained provenance this package does not adjudicate, and it will not GRANT itself standing to strip it.', bad_grantor;
  END IF;

  --      SECOND: standing, and it is a SEPARATE PREDICATE from approval.
  --      grantor = current_user, or ANY approved measured grantor this session
  --      can already legitimately act as. Anything else is refused BEFORE the
  --      attempt, because the attempt would warn, change nothing and commit.
  --
  --      APPROVAL AND STANDING ARE INDEPENDENT, and conflating them is the
  --      defect this clause was corrected for. The FIRST query above decides
  --      whether a grantor is one this package will adjudicate at all; this one
  --      decides only whether the session may act as it. A grantor can be
  --      approved and unassumable (refused here), or assumable and unapproved
  --      (refused above), and neither refusal substitutes for the other.
  --
  --      THE PREDICATE IS OVER THE MEASURED GRANTOR, NOT OVER A FROZEN NAME.
  --      An earlier revision asked whether the grantor was literally
  --      uellix_owner, on the stated ground that a category-D unit forbidding
  --      dynamic SQL could not act as a role it had not named in advance. That
  --      ground was FALSE and the narrowing was a defect: it refused an
  --      approved measured OWNER -- a topology the contract explicitly admits,
  --      since the approved set is expressed RELATIVE TO THE OWNER and the
  --      owner is read from pg_class.relowner rather than frozen. §1 enters the
  --      measured grantor with set_config('role', <value>, true), which is an
  --      ordinary function call carrying a runtime VALUE, not constructed SQL.
  SELECT string_agg(DISTINCT x.grantor, ', ' ORDER BY x.grantor) INTO bad_grantor
  FROM (
    SELECT coalesce(gr.rolname, 'PUBLIC') AS grantor
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles g  ON g.oid  = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid
      AND coalesce(g.rolname, 'PUBLIC') IN ('authenticated', 'service_role')
    UNION ALL
    SELECT coalesce(gr.rolname, 'PUBLIC') AS grantor
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g  ON g.oid  = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') IN ('anon', 'service_role')
  ) AS x
  WHERE x.grantor <> current_user
    AND NOT pg_catalog.pg_has_role(current_user, x.grantor, 'SET');
  IF bad_grantor IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: a privilege this package would revoke carries grantor [%], and this session (%) can neither issue the REVOKE as itself nor legitimately act as that grantor: pg_has_role(current_user, grantor, ''SET'') is false. A REVOKE issued by any other role raises "no privileges could be revoked", changes nothing and STILL COMMITS — so the package refuses BEFORE attempting it rather than reporting a hardening it did not perform. It does not GRANT itself a membership to manufacture the standing it lacks: standing is MEASURED, never manufactured.', bad_grantor, current_user;
  END IF;

  -- 0.15 ACL-PRE-16. THE CAPTURE. Transaction-local set_config(..., true), so
  --      nothing here can leak into a later session or be pre-seeded by one.
  --      A postcondition that asserts "unchanged" without a captured pre-state
  --      is asserting against a value it has just re-read; this capture is what
  --      makes §2 falsifiable rather than tautological.
  --
  --      The ACLs are captured as the NON-OWNER (grantee, privilege) sets,
  --      because the owner's implicit entry is not what this package moves, and
  --      an owner-inclusive digest would compare a thing that legitimately
  --      differs between the hosted substrate (owner postgres) and a
  --      corpus-only one.
  PERFORM set_config('stella_hosted_0010.session_user', current_user, true);
  PERFORM set_config('stella_hosted_0010.table_owner', tbl_owner, true);
  PERFORM set_config('stella_hosted_0010.fn_owner', fn_owner, true);

  PERFORM set_config('stella_hosted_0010.table_acl',
    (SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '')
     FROM (
       SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
       FROM pg_catalog.pg_class c
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
       LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
       WHERE c.oid = tbl_oid AND coalesce(g.rolname, 'PUBLIC') <> tbl_owner
     ) AS x), true);

  PERFORM set_config('stella_hosted_0010.fn_acl',
    (SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '')
     FROM (
       SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
       WHERE p.oid = fn_oid AND coalesce(g.rolname, 'PUBLIC') <> fn_owner
     ) AS x), true);

  PERFORM set_config('stella_hosted_0010.rls',
    (SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
     FROM pg_catalog.pg_class c WHERE c.oid = tbl_oid), true);

  PERFORM set_config('stella_hosted_0010.policies',
    (SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || permissive || '|' ||
                                    roles::text || '|' || coalesce(qual, '') || '|' ||
                                    coalesce(with_check, ''),
                                    E'\n' ORDER BY policyname), ''))
     FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'entitlement_grants'), true);

  PERFORM set_config('stella_hosted_0010.policy_count', policy_n::text, true);

  -- The trigger SET, by name AND by tgtype, so a re-created trigger whose
  -- timing or level changed is caught by the digest rather than surviving a
  -- count that never looked at its shape.
  PERFORM set_config('stella_hosted_0010.triggers',
    (SELECT md5(coalesce(string_agg(t.tgname || '|' || t.tgtype::text || '|' ||
                                    pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.proname,
                                    E'\n' ORDER BY t.tgname), ''))
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal), true);

  -- The evaluator's body and every flag the contract pins. §2 compares this
  -- DIGEST rather than re-asserting each flag's desired value, so a package
  -- that somehow replaced the body with one that still happened to be SECURITY
  -- DEFINER would still be caught.
  PERFORM set_config('stella_hosted_0010.fn_digest',
    (SELECT md5(p.oid::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
                p.provolatile::text || ':' || p.proparallel::text || ':' || p.proleakproof::text || ':' ||
                coalesce(array_to_string(p.proconfig, ','), '-'))
     FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid), true);

  -- The relation's row count. This package writes no row, and capturing the
  -- count makes "no table-row change" falsifiable instead of inferred from the
  -- absence of a DML statement in this file — an inference that would hold
  -- equally for a package that called a function which issued one.
  PERFORM set_config('stella_hosted_0010.grant_rows',
    (SELECT count(*)::text FROM public.entitlement_grants), true);

  -- Role attributes and memberships, so §2's "no role or membership changed"
  -- is MEASURED rather than inferred from this file containing no role
  -- statement. inherit_option and set_option are captured alongside
  -- admin_option because flipping INHERIT would silently turn every
  -- administrative statement into an owner statement without adding or
  -- removing a single membership.
  PERFORM set_config('stella_hosted_0010.roles',
    (SELECT md5(coalesce(string_agg(r.rolname || ':' || r.rolsuper::text || ':' ||
                                    r.rolbypassrls::text || ':' || r.rolcreaterole::text || ':' ||
                                    r.rolcanlogin::text || ':' || r.rolinherit::text,
                                    E'\n' ORDER BY r.rolname), ''))
     FROM pg_catalog.pg_roles r
     WHERE r.rolname LIKE 'uellix%'
        OR r.rolname IN ('authenticated', 'anon', 'service_role')), true);

  PERFORM set_config('stella_hosted_0010.memberships',
    (SELECT md5(coalesce(string_agg(pg_catalog.pg_get_userbyid(m.member) || '->' ||
                                    pg_catalog.pg_get_userbyid(m.roleid) || ':' ||
                                    m.admin_option::text || ':' || m.inherit_option::text ||
                                    ':' || m.set_option::text,
                                    E'\n' ORDER BY m.member, m.roleid), ''))
     FROM pg_catalog.pg_auth_members m), true);

  RAISE NOTICE 'stella_hosted_0010: preconditions hold. table owner=%, evaluator owner=%, session=%. Non-owner TABLE ACL=[%]; non-owner EXECUTE ACL=[%].',
    tbl_owner, fn_owner, current_user,
    current_setting('stella_hosted_0010.table_acl'),
    current_setting('stella_hosted_0010.fn_acl');
END $$;


-- ============================================================
-- 1. The REVOKEs, and nothing else
-- ============================================================
-- EVERY state-changing statement below is a REVOKE. There is no other kind,
-- and §2 plus the static detector CE3-ACL-N-4 both measure that rather than
-- taking this comment's word for it.
--
-- EACH REVOKE IS CONDITIONAL ON MEASURED PRESENCE. A (grantee, privilege) pair
-- measured ABSENT is NOT revoked and is NOT a failure — that is what makes the
-- second application issue ZERO REVOKEs instead of relying on PostgreSQL
-- tolerating a redundant one.
--
-- EACH REVOKE IS A LITERAL STATEMENT naming ONE of the two frozen objects. No
-- identifier below is interpolated, no statement is assembled as a string and
-- nothing is executed through EXECUTE format(...). That is what lets the
-- statement class be MEASURED by reading this file.
--
-- THE GRANTOR, BY CONTRAST, IS DERIVED AND NOT ENUMERATED. Each target has a
-- direct arm (grantor = current_user) and a loop over every OTHER measured
-- grantor, entered as a runtime VALUE through set_config('role', g, true).
-- Statement text stays static while the acting identity is measured; the two
-- are independent, and an earlier revision conflated them.
--
-- AFTER EVERY REVOKE THE ACL IS RE-READ AND THE PAIR ASSERTED ABSENT. A pair
-- still present is FAILURE and aborts the transaction — whether PostgreSQL
-- raised "WARNING: no privileges could be revoked" or said nothing at all. The
-- package decides by reading the catalog, never by the presence of a warning.
DO $$
DECLARE
  tbl_oid            oid;
  fn_oid             oid;
  tbl_owner          text;
  fn_owner           text;
  revokes_issued     int := 0;
  residual           text;
  sess               text;
  g                  text;
  left_over          int;
  -- Per (object, grantee): is there at least one pair whose grantor is THIS
  -- session? Those take the direct arm and open no role window at all.
  tbl_auth_self      boolean;
  tbl_svc_self       boolean;
  fn_anon_self       boolean;
  fn_svc_self        boolean;
BEGIN
  tbl_owner := current_setting('stella_hosted_0010.table_owner', true);
  fn_owner  := current_setting('stella_hosted_0010.fn_owner', true);
  IF tbl_owner IS NULL OR tbl_owner = '' OR fn_owner IS NULL OR fn_owner = '' THEN
    RAISE EXCEPTION 'stella_hosted_0010 aborted: §0 recorded no pre-state, so this block cannot know which grants it measured or which grantor granted them. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT c.oid INTO tbl_oid
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants' AND c.relkind = 'r';
  fn_oid := pg_catalog.to_regprocedure('public.entitlement_effective(uuid,varchar)');

  sess := current_setting('stella_hosted_0010.session_user', true);

  -- WHICH PAIRS EXIST, AND UNDER WHICH GRANTOR. Measured per (object, grantee)
  -- so that a grantee holding privileges from SEVERAL approved grantors is
  -- stripped under EACH of them rather than half-stripped by whichever matched
  -- first. The self-arm booleans below are the "no role window at all" case;
  -- every other measured grantor is walked as a VALUE by the loops further
  -- down.
  SELECT
    bool_or(x.grantee = 'authenticated'  AND x.grantor = current_user),
    bool_or(x.grantee = 'service_role'   AND x.grantor = current_user)
  INTO tbl_auth_self, tbl_svc_self
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') AS grantee, coalesce(gr.rolname, 'PUBLIC') AS grantor
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles g  ON g.oid  = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid AND coalesce(g.rolname, 'PUBLIC') <> tbl_owner
  ) AS x;

  SELECT
    bool_or(x.grantee = 'anon'         AND x.grantor = current_user),
    bool_or(x.grantee = 'service_role' AND x.grantor = current_user)
  INTO fn_anon_self, fn_svc_self
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') AS grantee, coalesce(gr.rolname, 'PUBLIC') AS grantor
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g  ON g.oid  = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid AND coalesce(g.rolname, 'PUBLIC') <> fn_owner
  ) AS x;

  -- ------------------------------------------------------------------------
  -- HOW A MEASURED GRANTOR IS ENTERED, AND WHY THIS IS NOT DYNAMIC SQL
  -- ------------------------------------------------------------------------
  -- Each non-self arm below walks the DISTINCT measured grantors of one
  -- (object, grantee) target and enters each with
  --
  --     PERFORM set_config('role', g, true);
  --
  -- That is an ordinary FUNCTION CALL. `g` is a runtime VALUE in a parameter;
  -- the statement text is fixed and contains no identifier this file did not
  -- write. Nothing is concatenated, nothing is passed to EXECUTE, format() or
  -- quote_ident(), and no identifier is interpolated. `SET LOCAL ROLE <name>`
  -- would have taken an IDENTIFIER and therefore genuinely would have required
  -- constructed SQL for a measured role — which is exactly the confusion that
  -- made an earlier revision refuse an approved measured OWNER it was
  -- authorized to serve. The GUC, and its effect, are identical either way.
  --
  -- THE SWITCH IS TRANSACTION-LOCAL (third argument true) and is closed by
  -- set_config('role', 'none', true), which restores the session identity.
  -- MEASURED: current_user moves postgres -> <grantor> -> postgres, and a
  -- COMMIT restores it even if a restore were somehow missed.
  --
  -- STANDING IS STILL MEASURED, NEVER MANUFACTURED. §0.14 already refused any
  -- grantor that is unapproved OR unassumable; each arm re-asserts standing
  -- immediately before switching, and PostgreSQL itself refuses the switch
  -- with "permission denied to set role" if the session lacks it. The package
  -- GRANTS itself no membership at any point.
  --
  -- EIGHT LITERAL REVOKE STATEMENTS REMAIN, four direct and four inside these
  -- loops, each naming one of the two frozen objects and one frozen grantee.
  -- A loop repeats a fixed statement under a different identity; it does not
  -- build one.

  -- ---- TABLE / authenticated, ARM 1: grantor = current_user. No role window.
  IF coalesce(tbl_auth_self, false) THEN
    REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM authenticated;
    revokes_issued := revokes_issued + 1;
  END IF;

  -- ---- TABLE / authenticated, ARM 2: every OTHER measured grantor. ----
  FOR g IN
    SELECT DISTINCT coalesce(gr.rolname, 'PUBLIC')
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid
      AND coalesce(gg.rolname, 'PUBLIC') = 'authenticated'
      AND coalesce(gr.rolname, 'PUBLIC') <> current_user
    ORDER BY 1
  LOOP
    IF NOT pg_catalog.pg_has_role(current_user, g, 'SET') THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: a TABLE privilege held by authenticated carries grantor % and this session (%) cannot act as it. Standing is MEASURED, never manufactured: this package does not GRANT itself the membership that would let it proceed.', g, current_user;
    END IF;
    PERFORM set_config('role', g, true);
    IF current_user <> g THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: the session did not become the measured grantor % (it is %). The REVOKE is not attempted under an identity that was not entered.', g, current_user;
    END IF;
    REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM authenticated;
    revokes_issued := revokes_issued + 1;
    SELECT count(*) INTO left_over
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid AND coalesce(gg.rolname, 'PUBLIC') = 'authenticated'
      AND coalesce(gr.rolname, 'PUBLIC') = g;
    PERFORM set_config('role', 'none', true);
    IF left_over > 0 THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: % privilege(s) held by authenticated under grantor % survived the REVOKE issued AS that grantor. A REVOKE that leaves its target present did nothing.', left_over, g;
    END IF;
    IF current_user <> sess THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: the role window opened for grantor % did not close (session is % rather than %).', g, current_user, sess;
    END IF;
  END LOOP;

  -- ---- TABLE / service_role, ARM 1. ----
  IF coalesce(tbl_svc_self, false) THEN
    REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM service_role;
    revokes_issued := revokes_issued + 1;
  END IF;

  -- ---- TABLE / service_role, ARM 2. ----
  FOR g IN
    SELECT DISTINCT coalesce(gr.rolname, 'PUBLIC')
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid
      AND coalesce(gg.rolname, 'PUBLIC') = 'service_role'
      AND coalesce(gr.rolname, 'PUBLIC') <> current_user
    ORDER BY 1
  LOOP
    IF NOT pg_catalog.pg_has_role(current_user, g, 'SET') THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: a TABLE privilege held by service_role carries grantor % and this session (%) cannot act as it. Standing is MEASURED, never manufactured: this package does not GRANT itself the membership that would let it proceed.', g, current_user;
    END IF;
    PERFORM set_config('role', g, true);
    IF current_user <> g THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: the session did not become the measured grantor % (it is %). The REVOKE is not attempted under an identity that was not entered.', g, current_user;
    END IF;
    REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM service_role;
    revokes_issued := revokes_issued + 1;
    SELECT count(*) INTO left_over
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE c.oid = tbl_oid AND coalesce(gg.rolname, 'PUBLIC') = 'service_role'
      AND coalesce(gr.rolname, 'PUBLIC') = g;
    PERFORM set_config('role', 'none', true);
    IF left_over > 0 THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: % privilege(s) held by service_role under grantor % survived the REVOKE issued AS that grantor. A REVOKE that leaves its target present did nothing.', left_over, g;
    END IF;
    IF current_user <> sess THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: the role window opened for grantor % did not close (session is % rather than %).', g, current_user, sess;
    END IF;
  END LOOP;

  -- ---- FUNCTION / anon, ARM 1. ----
  IF coalesce(fn_anon_self, false) THEN
    REVOKE ALL PRIVILEGES ON FUNCTION public.entitlement_effective(uuid, varchar) FROM anon;
    revokes_issued := revokes_issued + 1;
  END IF;

  -- ---- FUNCTION / anon, ARM 2. THE HOSTED ARM. ----
  -- After stella_hosted_0009 the evaluator is owned by uellix_owner and every
  -- non-owner EXECUTE entry is re-attributed to it, so on the hosted shape the
  -- measured grantor this loop walks IS uellix_owner — reached now because it
  -- is the measured grantor, not because it is a name this file froze.
  -- `authenticated` is NEVER named in any arm: its EXECUTE is REQUIRED by the
  -- frozen contract and §0 refuses if it is absent.
  FOR g IN
    SELECT DISTINCT coalesce(gr.rolname, 'PUBLIC')
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid
      AND coalesce(gg.rolname, 'PUBLIC') = 'anon'
      AND coalesce(gr.rolname, 'PUBLIC') <> current_user
    ORDER BY 1
  LOOP
    IF NOT pg_catalog.pg_has_role(current_user, g, 'SET') THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: an EXECUTE privilege held by anon carries grantor % and this session (%) cannot act as it. Standing is MEASURED, never manufactured: this package does not GRANT itself the membership that would let it proceed.', g, current_user;
    END IF;
    PERFORM set_config('role', g, true);
    IF current_user <> g THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: the session did not become the measured grantor % (it is %). The REVOKE is not attempted under an identity that was not entered.', g, current_user;
    END IF;
    REVOKE ALL PRIVILEGES ON FUNCTION public.entitlement_effective(uuid, varchar) FROM anon;
    revokes_issued := revokes_issued + 1;
    SELECT count(*) INTO left_over
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid AND coalesce(gg.rolname, 'PUBLIC') = 'anon'
      AND coalesce(gr.rolname, 'PUBLIC') = g;
    PERFORM set_config('role', 'none', true);
    IF left_over > 0 THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: % EXECUTE privilege(s) held by anon under grantor % survived the REVOKE issued AS that grantor. A REVOKE that leaves its target present did nothing.', left_over, g;
    END IF;
    IF current_user <> sess THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: the role window opened for grantor % did not close (session is % rather than %).', g, current_user, sess;
    END IF;
  END LOOP;

  -- ---- FUNCTION / service_role, ARM 1. ----
  IF coalesce(fn_svc_self, false) THEN
    REVOKE ALL PRIVILEGES ON FUNCTION public.entitlement_effective(uuid, varchar) FROM service_role;
    revokes_issued := revokes_issued + 1;
  END IF;

  -- ---- FUNCTION / service_role, ARM 2. ----
  FOR g IN
    SELECT DISTINCT coalesce(gr.rolname, 'PUBLIC')
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid
      AND coalesce(gg.rolname, 'PUBLIC') = 'service_role'
      AND coalesce(gr.rolname, 'PUBLIC') <> current_user
    ORDER BY 1
  LOOP
    IF NOT pg_catalog.pg_has_role(current_user, g, 'SET') THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: an EXECUTE privilege held by service_role carries grantor % and this session (%) cannot act as it. Standing is MEASURED, never manufactured: this package does not GRANT itself the membership that would let it proceed.', g, current_user;
    END IF;
    PERFORM set_config('role', g, true);
    IF current_user <> g THEN
      RAISE EXCEPTION 'stella_hosted_0010 aborted: the session did not become the measured grantor % (it is %). The REVOKE is not attempted under an identity that was not entered.', g, current_user;
    END IF;
    REVOKE ALL PRIVILEGES ON FUNCTION public.entitlement_effective(uuid, varchar) FROM service_role;
    revokes_issued := revokes_issued + 1;
    SELECT count(*) INTO left_over
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles gg ON gg.oid = a.grantee
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
    WHERE p.oid = fn_oid AND coalesce(gg.rolname, 'PUBLIC') = 'service_role'
      AND coalesce(gr.rolname, 'PUBLIC') = g;
    PERFORM set_config('role', 'none', true);
    IF left_over > 0 THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: % EXECUTE privilege(s) held by service_role under grantor % survived the REVOKE issued AS that grantor. A REVOKE that leaves its target present did nothing.', left_over, g;
    END IF;
    IF current_user <> sess THEN
      RAISE EXCEPTION 'stella_hosted_0010 FAILED: the role window opened for grantor % did not close (session is % rather than %).', g, current_user, sess;
    END IF;
  END LOOP;

  -- THE RE-READ. This is what decides, and it is deliberately NOT a check of
  -- the WARNING: a no-op REVOKE warns and commits, so a package that trusted
  -- its own statements would report a hardening it never performed.
  SELECT string_agg(x.entry, ', ' ORDER BY x.entry) INTO residual
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE c.oid = tbl_oid
      AND coalesce(g.rolname, 'PUBLIC') <> tbl_owner
      AND coalesce(g.rolname, 'PUBLIC') IN ('authenticated', 'service_role')
    UNION ALL
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') <> fn_owner
      AND coalesce(g.rolname, 'PUBLIC') IN ('anon', 'service_role')
  ) AS x;
  IF residual IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED: after issuing % REVOKE statement(s) the pair(s) [%] are STILL PRESENT in the catalog. A REVOKE that leaves its target present did nothing — PostgreSQL raises "no privileges could be revoked" for a grant the current role did not make, changes nothing and still commits. This is FAILURE, never a success with a warning, and the transaction is aborted so the prior posture is left intact.', revokes_issued, residual;
  END IF;

  -- The role window must be closed before §2, and by this block rather than by
  -- the end of the transaction: a postcondition that only held because the
  -- transaction ended would not be measuring this package's discipline.
  IF current_user <> current_setting('stella_hosted_0010.session_user', true) THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED: a role window is still open — the session is running as % rather than the captured %. Every measured-grantor window this package opens with set_config(''role'', <value>, true) is closed by set_config(''role'', ''none'', true) in the same loop iteration.',
      current_user, current_setting('stella_hosted_0010.session_user', true);
  END IF;

  PERFORM set_config('stella_hosted_0010.revokes_issued', revokes_issued::text, true);
  IF revokes_issued = 0 THEN
    RAISE NOTICE 'stella_hosted_0010: ZERO REVOKEs issued — the target was already at the frozen contract. This is the idempotent convergence the contract REQUIRES, not a skipped application.';
  ELSE
    RAISE NOTICE 'stella_hosted_0010: % REVOKE statement(s) issued and verified absent by catalog re-read.', revokes_issued;
  END IF;
END $$;


-- ============================================================
-- 2. Self-verification — assert the end state, in this transaction
-- ============================================================
-- Verified INSIDE the same transaction as the REVOKEs, against the §0 capture.
-- ANY failure RAISEs and aborts, leaving the prior posture intact. The package
-- does not warn, does not partially apply and does not record a success with
-- caveats.
DO $$
DECLARE
  tbl_oid    oid;
  fn_oid     oid;
  tbl_owner  text;
  fn_owner   text;
  captured   text;
  observed   text;
BEGIN
  captured := current_setting('stella_hosted_0010.session_user', true);
  IF captured IS NULL OR captured = '' THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: §0 recorded no pre-state, so every "UNCHANGED" assertion below would be comparing a value against itself. The three blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  tbl_owner := current_setting('stella_hosted_0010.table_owner', true);
  fn_owner  := current_setting('stella_hosted_0010.fn_owner', true);

  SELECT c.oid INTO tbl_oid
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants' AND c.relkind = 'r';
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: public.entitlement_grants does not exist after the hardening.';
  END IF;
  fn_oid := pg_catalog.to_regprocedure('public.entitlement_effective(uuid,varchar)');
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: public.entitlement_effective(uuid,varchar) does not exist after the hardening.';
  END IF;

  -- POST-1. NON-OWNER TABLE ACL EXACTNESS. Read through aclexplode, compared as
  -- the exact set the contract freezes — not as "the things I meant to remove
  -- are gone", which a relation carrying a fourth grantee would also satisfy.
  SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '') INTO observed
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE c.oid = tbl_oid AND coalesce(g.rolname, 'PUBLIC') <> tbl_owner
  ) AS x;
  -- On a substrate where uellix_owner IS the table owner its SELECT is implicit
  -- owner capability and the non-owner set is legitimately empty; both readings
  -- satisfy the frozen contract, which is expressed RELATIVE TO THE OWNER.
  IF observed <> 'uellix_owner:SELECT' AND NOT (observed = '' AND tbl_owner = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the non-owner TABLE ACL of public.entitlement_grants is [%], not the frozen {(uellix_owner, SELECT)} (table owner = %).', observed, tbl_owner;
  END IF;

  -- POST-2. `authenticated` holds NONE of the five, asserted through
  -- has_table_privilege — the EFFECTIVE privilege, which also catches a
  -- privilege reachable through a role membership rather than a direct grant.
  IF pg_catalog.has_table_privilege('authenticated', tbl_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', tbl_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', tbl_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', tbl_oid, 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', tbl_oid, 'TRUNCATE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: `authenticated` still holds an effective privilege on public.entitlement_grants. TRUNCATE in particular is not a row operation: it consults no policy and fires no FOR EACH ROW trigger, so its absence is the ONLY thing that denies it.';
  END IF;

  -- POST-3. `service_role` likewise. It is BYPASSRLS on the platform, so
  -- nothing but the absence of the privilege denies it anything.
  IF pg_catalog.has_table_privilege('service_role', tbl_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', tbl_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', tbl_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', tbl_oid, 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', tbl_oid, 'TRUNCATE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: `service_role` still holds an effective privilege on public.entitlement_grants. That role is BYPASSRLS on the hosted platform, so row-level security denies it nothing and only the absence of the privilege does.';
  END IF;

  -- POST-4. The remaining contract roles hold nothing, EXCEPT where one of them
  -- is the measured table owner — in which case it is the owner and POST-1
  -- already asserted the non-owner set exactly.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO observed
  FROM (VALUES ('anon'), ('uellix_app'), ('uellix_writer'), ('uellix_auditor'), ('uellix_migrator')) AS r(name)
  WHERE r.name <> tbl_owner
    AND (pg_catalog.has_table_privilege(r.name, tbl_oid, 'SELECT')
      OR pg_catalog.has_table_privilege(r.name, tbl_oid, 'INSERT')
      OR pg_catalog.has_table_privilege(r.name, tbl_oid, 'UPDATE')
      OR pg_catalog.has_table_privilege(r.name, tbl_oid, 'DELETE')
      OR pg_catalog.has_table_privilege(r.name, tbl_oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege(r.name, tbl_oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege(r.name, tbl_oid, 'TRIGGER'));
  IF observed IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the role(s) [%] hold an effective privilege on public.entitlement_grants, and the frozen contract gives them none.', observed;
  END IF;

  -- POST-5. NON-OWNER EVALUATOR EXECUTE EXACTNESS.
  SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '') INTO observed
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid AND coalesce(g.rolname, 'PUBLIC') <> fn_owner
  ) AS x;
  IF observed <> 'authenticated:EXECUTE' THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the non-owner EXECUTE ACL of public.entitlement_effective(uuid,varchar) is [%], not the frozen {authenticated}.', observed;
  END IF;

  -- POST-6 / POST-7 / POST-8. PUBLIC absent; authenticated RETAINED; anon and
  -- service_role absent. Stated separately from POST-5 because each is a
  -- different failure a reader needs named: a package that revoked too much is
  -- as defective as one that revoked too little.
  IF pg_catalog.has_function_privilege('public', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: PUBLIC holds EXECUTE on public.entitlement_effective(uuid,varchar). 0073 revokes it and this package never grants it.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: `authenticated` can no longer EXECUTE the evaluator. That grant is REQUIRED by the frozen contract and the typed capability wrapper calls the function as that role — revoking it would take the product down rather than harden it.';
  END IF;
  IF pg_catalog.has_function_privilege('anon', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: `anon` still holds EXECUTE on the evaluator.';
  END IF;
  IF pg_catalog.has_function_privilege('service_role', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: `service_role` still holds EXECUTE on the evaluator.';
  END IF;

  -- POST-9. RLS and FORCE RLS UNCHANGED, against the capture — not merely
  -- "true", which would also pass on a target this package had itself enabled.
  captured := current_setting('stella_hosted_0010.rls', true);
  SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text INTO observed
  FROM pg_catalog.pg_class c WHERE c.oid = tbl_oid;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: entitlement_grants RLS/FORCE RLS is now [%] against a captured [%]. This package issues only REVOKE and does not touch row-level security.', observed, captured;
  END IF;

  -- POST-10. The policy set UNCHANGED by identity AND by cardinality.
  captured := current_setting('stella_hosted_0010.policies', true);
  SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || permissive || '|' ||
                                 roles::text || '|' || coalesce(qual, '') || '|' ||
                                 coalesce(with_check, ''),
                                 E'\n' ORDER BY policyname), '')) INTO observed
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'entitlement_grants';
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the policies on public.entitlement_grants changed while this package ran. It creates, alters and drops none.';
  END IF;
  captured := current_setting('stella_hosted_0010.policy_count', true);
  SELECT count(*)::text INTO observed
  FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'entitlement_grants';
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the policy COUNT on public.entitlement_grants moved from % to %.', captured, observed;
  END IF;

  -- POST-11. Table owner UNCHANGED. ALTER OWNER is prohibited outright, and
  -- this is what measures that rather than inferring it from the file.
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO observed
  FROM pg_catalog.pg_class c WHERE c.oid = tbl_oid;
  IF observed IS DISTINCT FROM tbl_owner THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the owner of public.entitlement_grants moved from % to %. This package performs no ALTER of any kind.', tbl_owner, observed;
  END IF;

  -- POST-12. Evaluator owner UNCHANGED, and still uellix_owner.
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO observed
  FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
  IF observed IS DISTINCT FROM fn_owner OR observed <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the evaluator owner is now % against a captured % (and must be uellix_owner). This package performs no ALTER FUNCTION.', observed, fn_owner;
  END IF;

  -- POST-13. Evaluator body / prosecdef / provolatile / proparallel /
  -- proleakproof / proconfig digest UNCHANGED.
  captured := current_setting('stella_hosted_0010.fn_digest', true);
  SELECT md5(p.oid::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
             p.provolatile::text || ':' || p.proparallel::text || ':' || p.proleakproof::text || ':' ||
             coalesce(array_to_string(p.proconfig, ','), '-')) INTO observed
  FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the evaluator body, its SECURITY DEFINER flag, its volatility, its parallel safety, its leakproofness or its search_path changed. This package issues only REVOKE and must touch none of them.';
  END IF;

  -- POST-14. The trigger set UNCHANGED, by name and by tgtype.
  captured := current_setting('stella_hosted_0010.triggers', true);
  SELECT md5(coalesce(string_agg(t.tgname || '|' || t.tgtype::text || '|' ||
                                 pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.proname,
                                 E'\n' ORDER BY t.tgname), '')) INTO observed
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the triggers on public.entitlement_grants changed while this package ran. The append-only guard is the control this hardening is ADDITIVE to, never a thing it replaces.';
  END IF;

  -- POST-15. NO ROLE WINDOW REMAINS OPEN.
  IF current_user <> current_setting('stella_hosted_0010.session_user', true) THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the session is running as % rather than the captured %. Every measured-grantor window this package opens with set_config(''role'', <value>, true) is closed by set_config(''role'', ''none'', true) in the same loop iteration.',
      current_user, current_setting('stella_hosted_0010.session_user', true);
  END IF;

  -- POST-16. NOTHING ELSE MOVED. Role attributes, memberships and the
  -- relation's row count are compared against the capture, so "this package
  -- issued no GRANT, created no role and wrote no row" is MEASURED rather than
  -- inferred from the absence of such a statement in this file — an inference
  -- that would hold equally for a package that called a function which issued
  -- one.
  captured := current_setting('stella_hosted_0010.roles', true);
  SELECT md5(coalesce(string_agg(r.rolname || ':' || r.rolsuper::text || ':' ||
                                 r.rolbypassrls::text || ':' || r.rolcreaterole::text || ':' ||
                                 r.rolcanlogin::text || ':' || r.rolinherit::text,
                                 E'\n' ORDER BY r.rolname), '')) INTO observed
  FROM pg_catalog.pg_roles r
  WHERE r.rolname LIKE 'uellix%' OR r.rolname IN ('authenticated', 'anon', 'service_role');
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: a role attribute changed while this package ran. It creates and alters no role.';
  END IF;

  captured := current_setting('stella_hosted_0010.memberships', true);
  SELECT md5(coalesce(string_agg(pg_catalog.pg_get_userbyid(m.member) || '->' ||
                                 pg_catalog.pg_get_userbyid(m.roleid) || ':' ||
                                 m.admin_option::text || ':' || m.inherit_option::text ||
                                 ':' || m.set_option::text,
                                 E'\n' ORDER BY m.member, m.roleid), '')) INTO observed
  FROM pg_catalog.pg_auth_members m;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: a role membership changed while this package ran. It grants itself, and anyone else, no membership — standing is measured, never manufactured.';
  END IF;

  captured := current_setting('stella_hosted_0010.grant_rows', true);
  SELECT count(*)::text INTO observed FROM public.entitlement_grants;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0010 FAILED verification: the entitlement_grants row count moved from % to %. This package writes no row.', captured, observed;
  END IF;

  RAISE NOTICE 'stella_hosted_0010: VERIFIED. Non-owner TABLE ACL = {(uellix_owner, SELECT)}; non-owner EXECUTE ACL = {authenticated}; RLS, FORCE RLS, policies, triggers, owners, evaluator digest, roles, memberships and row count all UNCHANGED against the §0 capture. REVOKEs issued: %.',
    current_setting('stella_hosted_0010.revokes_issued', true);
END $$;
