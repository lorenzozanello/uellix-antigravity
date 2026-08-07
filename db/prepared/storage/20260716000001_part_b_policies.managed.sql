-- ============================================================================
-- GENERATED — DO NOT EDIT. PART B of unit 41.
-- Derived from supabase/migrations/20260716000001_storage_policies.sql by db/hosted/storage-policy-artifact.ts.
-- 
-- These statements name storage.objects, which is owned by
-- supabase_storage_admin. Measured on the applying identity:
--   MEMBER = false   USAGE = false   SET = false
-- so psql cannot apply them and SET ROLE is not available. They run through
-- a managed channel, executed by a human against a verified hash.
-- 
-- THE OPERATOR DOES NOT WRITE THIS SQL. Run this file as generated. If it
-- needs to change, change the canonical source and regenerate.
-- 
-- Nothing here enables RLS: it is already enabled on storage.objects by the
-- platform, and Supabase refuses attempts to change that.
-- ============================================================================
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
