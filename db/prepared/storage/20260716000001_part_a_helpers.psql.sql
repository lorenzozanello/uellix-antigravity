-- ============================================================================
-- GENERATED — DO NOT EDIT. PART A of unit 41.
-- Derived from supabase/migrations/20260716000001_storage_policies.sql by db/hosted/storage-policy-artifact.ts.
-- Edit the source and regenerate; a hand edit here fails `pnpm storage:verify`.
-- 
-- This half is everything that does NOT touch storage.objects: the two
-- public.can_*_evidence_object helpers and their REVOKE/GRANT. It applies
-- through the ordinary psql runner because every object in it is ours.
-- 
-- 0039_grant_rls_helper_execution.sql depends on THIS half and on nothing
-- in PART B, so the baseline order is unchanged.
-- ============================================================================
-- 20260716000001_storage_policies.sql

-- ==============================================================================
-- Auxiliar functions for Storage RLS (Avoids dependency on Drizzle tables at start)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.can_read_evidence_object(object_name text, user_id uuid)
RETURNS boolean
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql AS $$
DECLARE
    project_id_str text;
    has_access boolean;
BEGIN
    -- Avoid executing if tables do not exist yet (during initial Supabase start)
    IF to_regclass('public.projects') IS NULL OR to_regclass('public.organization_members') IS NULL THEN
        RETURN false;
    END IF;

    -- Extract project ID from path: projectId/evidenceId/filename
    project_id_str := (storage.foldername(object_name))[1];
    IF project_id_str IS NULL OR project_id_str = '' THEN
        RETURN false;
    END IF;

    -- Validate access: any active member of the organization that owns the project
    SELECT EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.organization_members om ON om.organization_id = p.organization_id
        WHERE 
            p.id::text = project_id_str AND
            om.user_id = can_read_evidence_object.user_id AND
            om.status = 'active'
    ) INTO has_access;

    RETURN has_access;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_write_evidence_object(object_name text, user_id uuid)
RETURNS boolean
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql AS $$
DECLARE
    project_id_str text;
    has_access boolean;
BEGIN
    -- Avoid executing if tables do not exist yet (during initial Supabase start)
    IF to_regclass('public.projects') IS NULL OR to_regclass('public.organization_members') IS NULL THEN
        RETURN false;
    END IF;

    -- Extract project ID from path: projectId/evidenceId/filename
    project_id_str := (storage.foldername(object_name))[1];
    IF project_id_str IS NULL OR project_id_str = '' THEN
        RETURN false;
    END IF;

    -- Validate access: active organization_admin or analyst of the organization
    SELECT EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.organization_members om ON om.organization_id = p.organization_id
        WHERE 
            p.id::text = project_id_str AND
            om.user_id = can_write_evidence_object.user_id AND
            om.status = 'active' AND
            om.role IN ('organization_admin', 'analyst')
    ) INTO has_access;

    RETURN has_access;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;

-- Secure execution
REVOKE EXECUTE ON FUNCTION public.can_read_evidence_object(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_evidence_object(text, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.can_write_evidence_object(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_write_evidence_object(text, uuid) TO authenticated;
