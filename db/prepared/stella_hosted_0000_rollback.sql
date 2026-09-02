-- ============================================================================
-- stella_hosted_0000_rollback.sql
-- HPO-ODS-W2-03 — reverses stella_hosted_0000_managed_role_identity_bootstrap.sql.
-- ============================================================================
--
-- FAIL-CLOSED BY CONSTRUCTION. The five role identities are the FOUNDATION of
-- everything hosted: the baseline's 0042/0045 policies name uellix_app, the
-- post-baseline bootstrap transfers ownership to uellix_owner, and the chain's
-- objects are owned by roles that inherit from these. Dropping them while any
-- of that exists does not "revert" — it produces a database whose policies
-- name a missing role and whose objects have no owner. PostgreSQL would refuse
-- the DROP ROLE anyway, three quarters of the way through, with a dependency
-- message instead of a reason. So the refusals come first and say why.
--
--   psql "<staging>" -1 -v ON_ERROR_STOP=1 \
--        -c "SET uellix.bootstrap_environment = 'staging'" \
--        -f db/prepared/stella_hosted_0000_rollback.sql
--
-- Order, if a genuine full revert is wanted:
--   chain rollbacks (0018 -> 0013, grounding 0004 -> 0002)
--   -> stella_hosted_0001_rollback (bootstrap schema, shim, schema-public
--      privileges; it deliberately leaves the roles to THIS file)
--   -> the baseline itself is not rolled back by script (DESTROY_AND_REPROVISION)
--   -> THEN this file.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Refusals
-- ============================================================
DO $$
DECLARE
  v_owned   int;
  v_granted text;
BEGIN
  -- (R1) The post-baseline bootstrap must already be gone. Its schema is the
  --      cheapest true witness that stella_hosted_0001 (and therefore possibly
  --      the chain) is installed on top of these roles.
  IF to_regnamespace('uellix_bootstrap') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000_rollback refused: schema uellix_bootstrap exists, so stella_hosted_0001 is still installed on top of these roles. Run db/prepared/stella_hosted_0001_rollback.sql first (which itself refuses while any chain package is installed).';
  END IF;

  -- (R2) None of the five roles may own anything, anywhere: relations,
  --      functions or schemas. Checked explicitly so the operator learns WHAT
  --      is in the way instead of reading a dependency list.
  SELECT count(*) INTO v_owned
  FROM (
    SELECT c.relowner AS owner FROM pg_class c
    UNION ALL SELECT p.proowner FROM pg_proc p
    UNION ALL SELECT n.nspowner FROM pg_namespace n
  ) AS o
  JOIN pg_roles r ON r.oid = o.owner
  WHERE r.rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor');

  IF v_owned > 0 THEN
    RAISE EXCEPTION 'stella_hosted_0000_rollback refused: % object(s) are still owned by a role this file drops. Transfer or drop them first; this package will not guess who should inherit them.', v_owned;
  END IF;

  -- (R3) None of the five roles may still hold a privilege on schema public.
  --      stella_hosted_0001 §2b-bis grants them and its rollback revokes them;
  --      PostgreSQL refuses to drop a role that still holds one (measured on
  --      17.6: "privileges for schema public").
  SELECT string_agg(a.grantee::regrole::text, ', ' ORDER BY a.grantee::regrole::text) INTO v_granted
  FROM pg_namespace n, aclexplode(n.nspacl) a
  WHERE n.nspname = 'public'
    AND a.grantee::regrole::text IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor');

  IF v_granted IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000_rollback refused: role(s) % still hold privileges on schema public. Run db/prepared/stella_hosted_0001_rollback.sql first; it revokes what its forward package granted.', v_granted;
  END IF;

  -- (R4) The environment must be declared, exactly as for the forward package.
  IF coalesce(current_setting('uellix.bootstrap_environment', true), '') IS DISTINCT FROM 'staging' THEN
    RAISE EXCEPTION 'stella_hosted_0000_rollback refused: uellix.bootstrap_environment must be exactly ''staging''. Set it in the same session.';
  END IF;
END $$;

-- ============================================================
-- 1. Memberships first — PostgreSQL refuses to drop a role still granted
-- ============================================================
DO $$
BEGIN
  IF to_regrole('uellix_owner') IS NOT NULL AND to_regrole('uellix_migrator') IS NOT NULL THEN
    REVOKE uellix_owner FROM uellix_migrator;
  END IF;
  IF to_regrole('uellix_writer') IS NOT NULL AND to_regrole('uellix_app') IS NOT NULL THEN
    REVOKE uellix_writer FROM uellix_app;
  END IF;
END $$;

-- ============================================================
-- 2. The five roles
-- ============================================================
-- The RR-02 membership (uellix_owner granted to postgres) and the automatic
-- creator memberships go with the roles: DROP ROLE removes every
-- pg_auth_members row that names the dropped role.
DROP ROLE IF EXISTS uellix_app;
DROP ROLE IF EXISTS uellix_writer;
DROP ROLE IF EXISTS uellix_auditor;
DROP ROLE IF EXISTS uellix_migrator;
DROP ROLE IF EXISTS uellix_owner;

-- ============================================================
-- 3. Postconditions
-- ============================================================
DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_left
  FROM pg_roles
  WHERE rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor');

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000_rollback FAILED: role(s) % survived. A partial rollback is worse than none: the baseline would find some of its roles and not others.', v_left;
  END IF;

  RAISE NOTICE 'stella_hosted_0000_rollback: complete — 5 role identities dropped, no residue. The cluster is role-pristine again with respect to uellix_*.';
END $$;
