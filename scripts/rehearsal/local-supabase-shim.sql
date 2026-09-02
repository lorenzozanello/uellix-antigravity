-- scripts/rehearsal/local-supabase-shim.sql
-- TRAIN 5C0 — Phase 9. The MINIMUM Supabase-provided surface a disposable
-- database needs before the Uellix baseline can be applied to it.
--
-- ===========================================================================
-- READ THIS BEFORE TREATING A GREEN REHEARSAL AS EVIDENCE
-- ===========================================================================
-- Everything below is a SHIM. On a real managed Supabase project none of it is
-- ours: schema `auth` belongs to supabase_auth_admin, schema `storage` to
-- supabase_storage_admin, and `postgres` holds USAGE on them WITHOUT GRANT
-- OPTION. That asymmetry is the whole of RR-09 and the whole reason
-- supabase/migrations/20260716000000_auth_trigger.sql is classified
-- C-requires-adaptation in db/hosted/baseline-manifest.ts.
--
-- Here we create those schemas ourselves, which means we OWN them, which means
-- every privilege question the hosted apply will actually face is answered
-- trivially and wrongly. A rehearsal that passes proves the fifty units are
-- internally consistent and correctly ORDERED. It proves nothing whatsoever
-- about whether managed Supabase will permit them.
--
-- The shim is deliberately minimal: only what the corpus references. Anything
-- more would start to look like a Supabase project, and looking like one is
-- exactly the confusion this comment exists to prevent.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
-- HPO-ODS-W2-03: the managed-role identity package (stella_hosted_0000 §0 E1)
-- checks that the three Supabase schemas exist before it creates a role. On a
-- real project `extensions` is provided by the platform; a fresh database in
-- the disposable cluster has none of the three, so the shim provides it too.
CREATE SCHEMA IF NOT EXISTS extensions;

-- auth.users — referenced by the two triggers in 20260716000000.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255),
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb
);

-- auth.uid() — called by 0031, 0032, 004 and the storage policies. Returns the
-- request-local claim the real one returns; NULL when unset, which is what an
-- unauthenticated session sees.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- storage.objects and storage.foldername() — referenced by 20260716000001.
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$ SELECT string_to_array(name, '/') $$;

GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
