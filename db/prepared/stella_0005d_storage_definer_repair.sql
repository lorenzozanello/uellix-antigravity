-- db/prepared/stella_0005d_storage_definer_repair.sql
-- Repair the evidence-storage authorisation path broken by the ownership move.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0005d_rollback.sql.
--
-- ADMINISTRATIVE SCRIPT, like stella_0005b: it grants on a schema owned by
-- the Supabase platform, which `uellix_owner` cannot do for itself. Apply in
-- LOCAL ONLY, as the local superuser:
--
--   docker exec -i supabase_db_<stack> psql -U supabase_admin -d postgres \
--     -1 -v ON_ERROR_STOP=1 -f - < db/prepared/stella_0005d_storage_definer_repair.sql
--
-- ============================================================================
-- WHAT BROKE
-- ============================================================================
-- storage.objects carries three policies on the `uellix-evidence` bucket
-- (insert/select/delete) whose predicate is public.can_write_evidence_object /
-- can_read_evidence_object. stella_0004 moved those two functions — SECURITY
-- DEFINER — to `uellix_owner`. Their bodies call `storage.foldername(name)`,
-- and `uellix_owner` holds no USAGE on schema `storage`; the qualified
-- reference therefore raises `permission denied for schema storage` inside the
-- definer, the functions' `EXCEPTION WHEN OTHERS RETURN false` swallows it,
-- and EVERY evidence object operation through the storage API is refused —
-- measured on the rehearsal stack, discovered by the restored integration
-- suite (upload as analyst → "new row violates row-level security policy").
--
-- THE FIX IS ONE GRANT: USAGE on schema `storage` for `uellix_owner`. No table
-- privilege in `storage` is granted — the functions only need to resolve
-- `storage.foldername`, whose EXECUTE is already granted to PUBLIC by the
-- platform. The functions' own logic and ACLs are untouched.

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'stella_0005d must run as the local superuser (supabase_admin): it grants on the '
      'platform-owned schema "storage".';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'Role uellix_owner does not exist. Apply stella_0004 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('can_write_evidence_object', 'can_read_evidence_object')
      AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'uellix_owner'
  ) THEN
    RAISE EXCEPTION
      'The evidence-object definer functions are not owned by uellix_owner; this repair '
      'targets the post-stella_0004 state only.';
  END IF;
END
$$;

-- ============================================================
-- 1. The grant
-- ============================================================

GRANT USAGE ON SCHEMA storage TO uellix_owner;

-- ============================================================
-- 2. Postconditions
-- ============================================================

DO $$
BEGIN
  IF NOT has_schema_privilege('uellix_owner', 'storage', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_owner still has no USAGE on schema storage.';
  END IF;

  IF NOT has_function_privilege('uellix_owner', 'storage.foldername(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_owner cannot execute storage.foldername(text).';
  END IF;

  -- USAGE only: the owner must NOT have gained data access in storage.
  IF has_table_privilege('uellix_owner', 'storage.objects', 'SELECT')
     OR has_table_privilege('uellix_owner', 'storage.objects', 'INSERT')
     OR has_table_privilege('uellix_owner', 'storage.objects', 'UPDATE')
     OR has_table_privilege('uellix_owner', 'storage.objects', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_owner gained a table privilege on storage.objects; only USAGE was intended.';
  END IF;

  -- The runtime role stays out of storage entirely.
  IF has_schema_privilege('uellix_app', 'storage', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_app gained USAGE on schema storage; this script must not touch it.';
  END IF;
END
$$;
