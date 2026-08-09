-- ============================================================================
-- GENERATED — DO NOT EDIT. Class-C evidence observation.
-- Regenerate with `pnpm classc:observation:generate`; `pnpm classc:observation:verify`
-- compares bytes.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Runs inside a READ ONLY
-- transaction and rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f db/prepared/class-c/observation.sql
--
-- EACH PROBE'S `sql` IS THE CANONICAL §2.7 STRING, emitted from CLASS_C_PROBES
-- rather than typed. `hosted-capability-preflight-ready` requires the
-- attestation to quote them VERBATIM, so the query the operator runs and the
-- query the criterion demands are one string by construction.
--
-- The apply-identity probes (current_user, MEMBER, USAGE, SET) are NOT
-- re-measured here: they have their own artefact, nothing about that identity
-- changed, and two artefacts answering one question is the divergence this
-- programme keeps paying for.
--
-- `bucketDetail` is recorded for AUDIT ONLY. The criterion consumes
-- `evidenceBucketExists.observed` and nothing else; the extra columns are here
-- so a reader can see what the bucket actually is, not so a gate can rest on
-- them silently.
-- ============================================================================
\if :{?uellix_project_ref}
\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'An unattributed observation could describe any database.'
\quit
\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'targetProjectRef', :'uellix_project_ref',
  'targetRole', 'staging',
  'measuredBy', 'operator, psql session pooler, inside a READ ONLY transaction, from db/prepared/class-c/observation.sql',
  'note', 'Project refs are not secret. No credential, connection string or user data is recorded here. Every value below was measured by the query recorded beside it.',
  'probes', jsonb_build_array(
    jsonb_build_object(
      'name', 'canCreateTriggerOnAuthUsers',
      'sql', 'SELECT has_table_privilege(current_user, ''auth.users'', ''TRIGGER'')',
      'unit', '20260716000000_auth_trigger.sql',
      'observed', (SELECT has_table_privilege(current_user, 'auth.users', 'TRIGGER'))),
    jsonb_build_object(
      'name', 'ownsStorageObjects',
      'sql', 'SELECT pg_has_role(current_user, relowner, ''USAGE'') FROM pg_class WHERE oid = ''storage.objects''::regclass',
      'unit', '20260716000001_storage_policies.sql',
      'observed', (SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = 'storage.objects'::regclass)),
    jsonb_build_object(
      'name', 'evidenceBucketExists',
      'sql', 'SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = ''uellix-evidence'')',
      'unit', '20260716000001_storage_policies.sql (its policies gate on bucket_id = ''uellix-evidence'')',
      'observed', (SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uellix-evidence')))
  ),
  'bucketDetail', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'public', public,
        'file_size_limit', file_size_limit, 'allowed_mime_types', allowed_mime_types)), '[]'::jsonb)
      FROM storage.buckets WHERE id = 'uellix-evidence'),
  'bucketsTotal', (SELECT count(*) FROM storage.buckets)
));

ROLLBACK;
