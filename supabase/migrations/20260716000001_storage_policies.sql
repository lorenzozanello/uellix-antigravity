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


-- ==============================================================================
-- STORAGE POLICIES
-- ==============================================================================

-- Remove previous policies if they existed
DROP POLICY IF EXISTS "select_evidence" ON storage.objects;
DROP POLICY IF EXISTS "insert_evidence" ON storage.objects;
DROP POLICY IF EXISTS "delete_evidence" ON storage.objects;
DROP POLICY IF EXISTS "update_evidence" ON storage.objects;

-- Storage policies for the 'uellix-evidence' bucket
-- SELECT Policy
CREATE POLICY "select_evidence" ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'uellix-evidence' AND
    public.can_read_evidence_object(name, auth.uid())
);

-- INSERT Policy
CREATE POLICY "insert_evidence" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'uellix-evidence' AND
    public.can_write_evidence_object(name, auth.uid())
);

-- DELETE Policy
CREATE POLICY "delete_evidence" ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'uellix-evidence' AND
    public.can_write_evidence_object(name, auth.uid())
);
