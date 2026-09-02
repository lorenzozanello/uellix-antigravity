-- ============================================================================
-- stella_hosted_0004_storage_schema_usage.sql
-- M-2 — the hosted counterpart of stella_0005d.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. FORWARD-ONLY: no rollback file, typed in
-- db/hosted/forward-only-packages.ts.
--
-- PRECHAIN ADMINISTRATIVE UNIT. NOT a member of HOSTED_CHAIN.
--
-- ----------------------------------------------------------------------------
-- WHY IT IS A SEPARATE PACKAGE FROM stella_hosted_0003
-- ----------------------------------------------------------------------------
-- Because locally it is a separate script too, and for the same reason.
-- `stella_0004` moves ownership; `stella_0005d` grants USAGE on schema
-- `storage`. They were not merged then and are not merged now:
--
--   they answer different questions — one is "who owns our function", the other
--   is "may our owner resolve a name in a schema the PLATFORM owns";
--   they touch different objects, one of which is not ours at all;
--   and stella_hosted_0003 states in its own contract that it grants nothing.
--     Widening it to carry a GRANT would retire the only sentence a reviewer can
--     check it against.
--
-- MEASURED, and this is why the pair is needed rather than just the first half:
-- with stella_hosted_0003 applied and this package absent, T11 still refuses —
-- at its §0.7 rather than its §0.6:
--
--   stella_0019 aborted: uellix_owner has no USAGE on schema storage, so both
--   helpers already return false for every caller (stella_0005d).
--
-- That refusal is correct and is the reason this package exists. Fixing a role
-- list over a surface that denies everyone would report success over an outage.
--
-- ----------------------------------------------------------------------------
-- WHAT BROKE, RESTATED FOR THE HOSTED SIDE
-- ----------------------------------------------------------------------------
-- The bodies of can_read_evidence_object / can_write_evidence_object call
-- `storage.foldername(name)`. They are SECURITY DEFINER, so that call resolves
-- with the OWNER's privileges. Once stella_hosted_0003 makes the owner
-- `uellix_owner`, and `uellix_owner` holds no USAGE on schema `storage`, the
-- qualified reference raises `permission denied for schema storage` INSIDE the
-- definer — where the functions' own `EXCEPTION WHEN OTHERS THEN RETURN false`
-- swallows it and answers false for every caller, silently.
--
-- Locally this was measured as "upload as analyst -> new row violates row-level
-- security policy" and closed by stella_0005d. On the hosted side the same hole
-- opens the moment ownership moves, and it is closed the same way.
--
-- ----------------------------------------------------------------------------
-- WHY `postgres` CAN DO THIS ON A MANAGED PROJECT, AND WHY IT IS NOT WIDENING
-- ----------------------------------------------------------------------------
-- Schema `storage` is owned by the platform, and stella_0005d therefore demands
-- a superuser locally. Managed Supabase exposes none — but it does not need to:
-- MEASURED on the certification image, `postgres` holds `U*` on that schema
-- (USAGE **WITH GRANT OPTION**, granted by supabase_admin), which is precisely
-- the right to pass USAGE on to another role. So the operation is available to
-- the ordinary administrative identity and requires no elevation anybody has to
-- invent.
--
-- THE GRANT IS ONE PRIVILEGE ON ONE SCHEMA. No table privilege in `storage` is
-- granted; `storage.foldername`'s EXECUTE is already held by PUBLIC from the
-- platform. §2 asserts both, and asserts that `uellix_app` — the runtime role —
-- did not gain USAGE as a side effect. Those three postconditions are copied
-- from stella_0005d deliberately: the hosted variant of a repair should be
-- checkable against the same facts as the local one.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO ROLLBACK
-- ----------------------------------------------------------------------------
-- Revoking it would re-open exactly the failure described above — every
-- evidence object operation refused, silently, for every role — on a project
-- whose helpers `uellix_owner` now owns. "Restore the previous state" and
-- "return the Storage surface to denying everyone without saying so" are the
-- same sentence. Deliberate reversal is a single administrative REVOKE by the
-- same principal, taken with the consequence visible at the time.
--
-- RUN AS ONE TRANSACTION, AS THE ADMINISTRATIVE IDENTITY:
--   psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent: re-granting a privilege already held changes nothing.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (administrative window)
-- ============================================================
DO $$
BEGIN
  -- 0.1 The role the grant is for.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_hosted_0004 aborted: role uellix_owner does not exist. Apply stella_hosted_0001_managed_role_bootstrap.sql first.';
  END IF;

  -- 0.2 The schema, which belongs to the platform and is never created here.
  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0004 aborted: schema storage does not exist. It is created by the Storage service, never by this package.';
  END IF;

  -- 0.3 THE CAPABILITY, asked rather than assumed. `postgres` holds USAGE WITH
  --     GRANT OPTION on a managed project (measured), and a superuser holds
  --     everything; anything else cannot pass this privilege on and would fail
  --     three lines later with a bare permission error.
  IF NOT (
    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR pg_catalog.pg_has_role(current_user, (SELECT nspowner FROM pg_namespace WHERE nspname = 'storage'), 'USAGE')
    OR EXISTS (
      SELECT 1 FROM pg_namespace ns, aclexplode(ns.nspacl) a
      WHERE ns.nspname = 'storage'
        AND a.privilege_type = 'USAGE'
        AND a.is_grantable
        AND pg_catalog.pg_has_role(current_user, a.grantee, 'USAGE')
    )
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0004 aborted: the current session (%) cannot pass on USAGE for schema storage. That schema belongs to the platform; on managed Supabase apply this as postgres, which holds USAGE WITH GRANT OPTION on it.', current_user;
  END IF;

  -- 0.4 The functions this exists to serve, and their owner. Applying it before
  --     stella_hosted_0003 would grant a privilege to a role that does not yet
  --     need it, and would leave the ordering nobody reviewed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('can_read_evidence_object', 'can_write_evidence_object')
      AND p.prosecdef
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'uellix_owner'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0004 aborted: no SECURITY DEFINER Storage helper is owned by uellix_owner. This package grants the USAGE that owner needs; apply stella_hosted_0003_storage_helper_ownership.sql first.';
  END IF;

  -- 0.5 The runtime role must be out of schema storage before and after.
  PERFORM set_config('stella_hosted_0004.app_had_usage',
    has_schema_privilege('uellix_app', 'storage', 'USAGE')::text, true);
END $$;

-- ============================================================
-- 1. The grant, and nothing else
-- ============================================================
GRANT USAGE ON SCHEMA storage TO uellix_owner;

-- ============================================================
-- 2. Postconditions — the same three facts stella_0005d asserts
-- ============================================================
DO $$
BEGIN
  IF NOT has_schema_privilege('uellix_owner', 'storage', 'USAGE') THEN
    RAISE EXCEPTION 'stella_hosted_0004 FAILED verification: uellix_owner still has no USAGE on schema storage.';
  END IF;

  IF NOT has_function_privilege('uellix_owner', 'storage.foldername(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0004 FAILED verification: uellix_owner cannot execute storage.foldername(text), which both helper bodies call.';
  END IF;

  -- USAGE ONLY. The owner must not have gained data access in a schema that is
  -- not ours.
  IF has_table_privilege('uellix_owner', 'storage.objects', 'SELECT')
     OR has_table_privilege('uellix_owner', 'storage.objects', 'INSERT')
     OR has_table_privilege('uellix_owner', 'storage.objects', 'UPDATE')
     OR has_table_privilege('uellix_owner', 'storage.objects', 'DELETE') THEN
    RAISE EXCEPTION 'stella_hosted_0004 FAILED verification: uellix_owner gained a table privilege on storage.objects; only USAGE was intended.';
  END IF;

  -- And the runtime role is exactly where it was. Compared against the captured
  -- value rather than asserted false outright: a project that had already
  -- granted it got there some other way, and this package must not be the thing
  -- that silently changes it in either direction.
  IF has_schema_privilege('uellix_app', 'storage', 'USAGE')::text
     IS DISTINCT FROM current_setting('stella_hosted_0004.app_had_usage', true) THEN
    RAISE EXCEPTION 'stella_hosted_0004 FAILED verification: uellix_app''s USAGE on schema storage changed while this package ran. It grants to uellix_owner and to nobody else.';
  END IF;

  RAISE NOTICE 'stella_hosted_0004: verification passed — uellix_owner holds USAGE on schema storage and can resolve storage.foldername(text); no table privilege in storage was granted; uellix_app is unchanged.';
END $$;
