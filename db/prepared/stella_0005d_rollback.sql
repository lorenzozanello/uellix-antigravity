-- db/prepared/stella_0005d_rollback.sql
-- Rollback of stella_0005d_storage_definer_repair.sql.
--
-- WARNING: the state this restores is BROKEN by measurement — with the grant
-- revoked, the SECURITY DEFINER evidence functions fail inside
-- `storage.foldername()` and every evidence upload/read/delete through the
-- storage API is refused. This file exists so the repair is exactly
-- reversible, not because the reverted state is desirable.
--
-- Apply in LOCAL ONLY, as the local superuser (see the forward script).

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0005d_rollback must run as the local superuser (supabase_admin).';
  END IF;
END
$$;

REVOKE USAGE ON SCHEMA storage FROM uellix_owner;

DO $$
BEGIN
  IF has_schema_privilege('uellix_owner', 'storage', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_owner still holds USAGE on schema storage after the rollback.';
  END IF;
END
$$;
