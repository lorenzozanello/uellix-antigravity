-- SUPERSEDED, do not run standalone (found 2026-07-22 while scoping the
-- pending gate work). This file predates the discovery that the Storage
-- helper functions and their grants already live in a separate,
-- non-Drizzle migration: supabase/migrations/20260716000001_storage_policies.sql
-- (lines 81-85 there are these exact two GRANTs, plus the functions
-- themselves and the REVOKE from PUBLIC/anon, plus the actual storage.objects
-- policies). Applying both would just no-op the second one; apply
-- 20260716000001_storage_policies.sql instead and treat this file as
-- historical.
--
-- Original intent, kept for context: restore only the helper execution
-- privileges required by authenticated RLS. Migration 0033 intentionally
-- revokes EXECUTE on every public function, so these grants must run after
-- that baseline (and after the Storage helpers). The three core RLS helpers
-- (current_user_is_super_admin, current_user_org_ids, current_user_role_in_org)
-- are no longer granted here either: 0031_rls_core now creates them directly
-- in the `private` schema with their own explicit REVOKE/GRANT, so 0033's
-- public-schema-only revoke never touches them.

GRANT EXECUTE ON FUNCTION public.can_read_evidence_object(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_evidence_object(text, uuid) TO authenticated;
