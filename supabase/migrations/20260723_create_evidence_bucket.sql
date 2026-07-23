-- 20260723_create_evidence_bucket.sql
-- Create the 'uellix-evidence' storage bucket if it doesn't exist

INSERT INTO storage.buckets (id, name, owner, public)
VALUES ('uellix-evidence', 'uellix-evidence', NULL, false)
ON CONFLICT (id) DO NOTHING;
