-- Restore only the helper execution privileges required by authenticated RLS.
-- Migration 0033 intentionally revokes EXECUTE on every public function, so
-- these grants must run after that baseline (and after the Storage helpers).

GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_evidence_object(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_evidence_object(text, uuid) TO authenticated;
