-- ============================================================================
-- GENERATED — DO NOT EDIT. CHECKPOINT A1 corroboration.
-- Regenerate with `pnpm a1:observation:generate`; `pnpm a1:observation:verify`
-- compares bytes. The 36 witness arms below come from
-- db/hosted/package-witnesses.ts, so this file cannot drift from the registry
-- that classifies its output.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Runs inside a READ ONLY
-- transaction and rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f db/prepared/checkpoint-a1/corroboration.sql
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MEASURES, AND THE ONE THING IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------------
-- CHECKPOINT A1 needs three INDEPENDENT signals of identity: the connection, the
-- declaration, and the database. This query can answer only the third, and it
-- must not appear to answer the first. `current_user` behind the Supabase
-- Session Pooler is plain `postgres` — the login role `postgres.<ref>` is
-- consumed by the pooler and never reaches the backend — so a "connectionHost"
-- or "poolerUser" reported from in here would be a value derived from the same
-- place as the sentinel, wearing the name of an independent signal. Those two
-- are supplied by the OPERATOR when the artefact is assembled.
--
-- SIGNAL 3 is `sentinelObservation.projectRef`, and it is read from the ROW.
-- The S1 probe reported only the row COUNT on purpose; that was right for a
-- phase whose expectation is that the row is ABSENT. A1 asks what the row SAYS,
-- and a count corroborates no identity.
--
-- Every witness is resolved individually and by FULL SIGNATURE. Arity is the
-- discriminator: settle_reserved_quota exists with five arguments in
-- stella_0016 and with ten in stella_0017, and stella_0017 re-creates the
-- five-argument one, so a lookup by name would report the successor installed
-- as soon as its predecessor was.
-- ============================================================================
\if :{?uellix_project_ref}
\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'An unattributed observation could describe any database, including production.'
\quit
\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

-- The ref reaches the guard through a transaction-local setting rather than
-- through :'uellix_project_ref' inside the body: psql does NOT substitute
-- variables inside a $$ ... $$ block, so the literal text would reach the server
-- and fail as syntax. Measured in S2, not assumed.
--
-- \gset, not a bare SELECT. THE OUTPUT OF THIS FILE IS THE ARTEFACT. A plain
-- SELECT prints its result row, so under -A -t the operator would receive the
-- ref on line 1 and the JSON on line 2 onward, and would have to hand-trim the
-- file before recording it. Every hand edit of a measurement is an opportunity
-- to record something other than what was measured, so the probe emits exactly
-- one document and nothing else. \gset consumes the row into a psql variable
-- and prints nothing.
SELECT pg_catalog.set_config('uellix.a1_project_ref', :'uellix_project_ref', true) AS uellix_a1_bound \gset

DO $$
DECLARE
  v_ref text := pg_catalog.current_setting('uellix.a1_project_ref');
BEGIN
  -- (1) PRODUCTION DENY, by name, before a single catalogue row is read.
  IF v_ref IN ('ctaxtgujyyprgynmnvtq') THEN
    RAISE EXCEPTION 'A1 REFUSED: % is a PRODUCTION project ref. CHECKPOINT A1 authorises PHASE_STELLA_CHAIN; it never runs there, not even read-only, because an artefact describing production would be a corroboration nobody should be able to produce.', v_ref;
  END IF;

  -- (2) THE PIN. A consistent identity for the wrong project is still the wrong
  --     project, and this probe exists to authorise exactly one.
  IF v_ref <> 'bvyzblhqymxruxdguaee' THEN
    RAISE EXCEPTION 'A1 REFUSED: this probe corroborates % and you declared %.', 'bvyzblhqymxruxdguaee', v_ref;
  END IF;

  -- (3) THE TWO RELATIONS THIS QUERY NAMES STATICALLY.
  --
  --     NOT belt-and-braces, and not a nicety. PostgreSQL PARSES a statement
  --     before it evaluates it, so a CASE arm guarding a missing relation does
  --     NOT save the statement: the first draft of this file wrapped the
  --     sentinel read in
  --       CASE WHEN to_regclass(...) IS NULL THEN <nulls> ELSE (SELECT … FROM
  --       uellix_bootstrap.staging_sentinel) END
  --     and it failed with 42P01 against a database where the table was absent,
  --     because the ELSE arm still has to parse. MEASURED against PostgreSQL,
  --     not reasoned about.
  --
  --     So the absence is refused HERE, by name, with the phase that would have
  --     created it — which is also the more useful output. A1 has one
  --     precondition per relation and an operator who is missing one needs to
  --     know which, not a JSON document full of nulls.
  IF pg_catalog.to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN
    RAISE EXCEPTION 'A1 REFUSED: uellix_bootstrap.staging_sentinel does not exist, so PHASE_STELLA_BOOTSTRAP (S1) has not committed against this database. CHECKPOINT A1 reads identity out of that row; there is nothing here to corroborate.';
  END IF;

  IF pg_catalog.to_regclass('uellix_provisioning.applied_units') IS NULL THEN
    RAISE EXCEPTION 'A1 REFUSED: uellix_provisioning.applied_units does not exist, so no baseline unit can be shown to have been applied. Unrecorded is not applied, and PHASE_STELLA_CHAIN does not run on a baseline nobody can account for.';
  END IF;
END $$;

SELECT jsonb_pretty(jsonb_build_object(
  'targetProjectRef', :'uellix_project_ref',
  'measuredBy', 'operator, psql session pooler, inside a READ ONLY transaction, from db/prepared/checkpoint-a1/corroboration.sql',
  'note', 'Project refs are not secret. No credential, connection string or user data is recorded here. connectionHost and poolerUser are DELIBERATELY absent: they are client-side facts and this database cannot see them.',

  -- GAP A. The ROW, not the count.
  --
  -- Two jsonb objects merged with `||`: the facts that hold whatever the table
  -- contains, and the row's own fields. The second half is a scalar subquery, so
  -- an empty table yields NULL and the coalesce supplies explicit nulls — the
  -- COUNT still reports the truth, and the parser refuses anything other than
  -- exactly one row rather than reading a null-filled object as "fine".
  'sentinelObservation', (
    jsonb_build_object(
      'tablePresent', (pg_catalog.to_regclass('uellix_bootstrap.staging_sentinel') IS NOT NULL),
      'rowCount',     (SELECT count(*) FROM uellix_bootstrap.staging_sentinel))
    || coalesce(
      (SELECT jsonb_build_object(
         'id',               s.id,
         'environment',      s.environment,
         -- SIGNAL 3. Read from the ROW. Nothing downstream may substitute the
         -- declared ref for it, and a mismatch is a refusal rather than a
         -- preference.
         'projectRef',       s.project_ref,
         'bootstrapVersion', s.bootstrap_version,
         'provisionedAt',    s.provisioned_at,
         'ownerSeparation',  s.owner_separation,
         -- Derived HERE, beside the text it comes from, so an artefact where
         -- the two disagree is provably hand-edited.
         --
         -- `strpos`, not `position(… in …)`. The latter is SQL keyword syntax
         -- and cannot be schema-qualified — `pg_catalog.position('x' in y)` is a
         -- syntax error, measured rather than assumed — and an unqualified call
         -- would resolve through a search_path this transaction has emptied.
         'rr02Present',      pg_catalog.strpos(s.owner_separation, 'RR-02') > 0)
       FROM uellix_bootstrap.staging_sentinel s
       ORDER BY s.id
       LIMIT 1),
      jsonb_build_object('id', NULL, 'environment', NULL, 'projectRef', NULL,
                         'bootstrapVersion', NULL, 'provisionedAt', NULL,
                         'ownerSeparation', NULL, 'rr02Present', NULL))),

  -- The chain's precondition, not an assumption inherited from CHECKPOINT B0.
  'bootstrapSchemaPresent', EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_bootstrap'),

  -- Re-measured rather than carried forward. B0 was taken before the bootstrap;
  -- a ledger read today is what says the baseline is still complete today.
  'baselineJournal', jsonb_build_object(
    'tablePresent', (pg_catalog.to_regclass('uellix_provisioning.applied_units') IS NOT NULL),
    'units', coalesce((SELECT jsonb_agg(jsonb_build_object('packageId', u.package_id, 'status', u.status)
                                        ORDER BY u.package_id, u.status)
                       FROM uellix_provisioning.applied_units u), '[]'::jsonb),
    -- DISTINCT, because the question is "does this ledger describe more than one
    -- project", and one foreign row is the whole answer.
    'projectRefs', coalesce((SELECT jsonb_agg(DISTINCT u.project_ref)
                             FROM uellix_provisioning.applied_units u), '[]'::jsonb),
    'environments', coalesce((SELECT jsonb_agg(DISTINCT u.environment)
                              FROM uellix_provisioning.applied_units u), '[]'::jsonb)),

  -- GAP C. 10 packages, 36 witnesses, each measured on its own.
  'packageObservations', jsonb_build_array(
    jsonb_build_object(
      'packageId', 'grounding_0002_document_versions',
      'witnesses', jsonb_build_object(
      'schema:uellix_grounding', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_grounding'),
      'role:uellix_cap_grounding', EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_cap_grounding'),
      'regclass:public.evidence_document_versions', (pg_catalog.to_regclass('public.evidence_document_versions') IS NOT NULL),
      'regprocedure:uellix_grounding.claim_active_document_version(uuid)', (pg_catalog.to_regprocedure('uellix_grounding.claim_active_document_version(uuid)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'grounding_0003_evidence_chunks',
      'witnesses', jsonb_build_object(
      'regclass:public.evidence_chunks', (pg_catalog.to_regclass('public.evidence_chunks') IS NOT NULL),
      'regprocedure:uellix_grounding.insert_evidence_chunks(uuid,jsonb)', (pg_catalog.to_regprocedure('uellix_grounding.insert_evidence_chunks(uuid,jsonb)') IS NOT NULL),
      'regprocedure:uellix_grounding.finalize_document_ingestion(uuid,integer)', (pg_catalog.to_regprocedure('uellix_grounding.finalize_document_ingestion(uuid,integer)') IS NOT NULL),
      'regprocedure:uellix_grounding.chunks_in_scope(uuid,uuid,uuid)', (pg_catalog.to_regprocedure('uellix_grounding.chunks_in_scope(uuid,uuid,uuid)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'grounding_0004_runtime_attestation',
      'witnesses', jsonb_build_object(
      'regprocedure:uellix_grounding.chunks_in_scope_attested(uuid,uuid,uuid)', (pg_catalog.to_regprocedure('uellix_grounding.chunks_in_scope_attested(uuid,uuid,uuid)') IS NOT NULL),
      'constraint:public.evidence_chunks.evidence_chunks_content_hash_derivation_check', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'evidence_chunks' AND k.conname = 'evidence_chunks_content_hash_derivation_check'),
      'constraint:public.evidence_chunks.evidence_chunks_span_length_check', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'evidence_chunks' AND k.conname = 'evidence_chunks_span_length_check'),
      'constraint:public.evidence_chunks.evidence_chunks_chunk_id_derivation_check', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'evidence_chunks' AND k.conname = 'evidence_chunks_chunk_id_derivation_check')
      )),
    jsonb_build_object(
      'packageId', 'stella_0013_grounded_query_quota',
      'witnesses', jsonb_build_object(
      'schema:uellix_stella', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_stella'),
      'role:uellix_cap_stella_quota', EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_cap_stella_quota'),
      'column:public.stella_interactions.idempotency_key', EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'stella_interactions' AND a.attname = 'idempotency_key' AND a.attnum > 0 AND NOT a.attisdropped),
      'regprocedure:uellix_stella.consume_stella_quota(uuid,uuid,character varying,character)', (pg_catalog.to_regprocedure('uellix_stella.consume_stella_quota(uuid,uuid,character varying,character)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'stella_0014_operation_tickets',
      'witnesses', jsonb_build_object(
      'schema:uellix_stella_ops', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_stella_ops'),
      'role:uellix_cap_stella_ticket', EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_cap_stella_ticket'),
      'regclass:uellix_stella_ops.operation_tickets', (pg_catalog.to_regclass('uellix_stella_ops.operation_tickets') IS NOT NULL),
      'regprocedure:uellix_stella_ops.expire_operation_tickets(integer)', (pg_catalog.to_regprocedure('uellix_stella_ops.expire_operation_tickets(integer)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'stella_0015_project_bound_operation_tickets',
      'witnesses', jsonb_build_object(
      'regprocedure:uellix_stella_ops.bind_operation_ticket(character,uuid,character)', (pg_catalog.to_regprocedure('uellix_stella_ops.bind_operation_ticket(character,uuid,character)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.complete_operation_ticket(character,uuid,character)', (pg_catalog.to_regprocedure('uellix_stella_ops.complete_operation_ticket(character,uuid,character)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.abort_operation_ticket(character,uuid,character varying)', (pg_catalog.to_regprocedure('uellix_stella_ops.abort_operation_ticket(character,uuid,character varying)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.inspect_operation_ticket(character,uuid)', (pg_catalog.to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character,uuid)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.bind_operation_ticket(character,character)', (pg_catalog.to_regprocedure('uellix_stella_ops.bind_operation_ticket(character,character)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.complete_operation_ticket(character,character)', (pg_catalog.to_regprocedure('uellix_stella_ops.complete_operation_ticket(character,character)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.abort_operation_ticket(character,character varying)', (pg_catalog.to_regprocedure('uellix_stella_ops.abort_operation_ticket(character,character varying)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.inspect_operation_ticket(character)', (pg_catalog.to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'stella_0016_reserved_quota_semantics',
      'witnesses', jsonb_build_object(
      'regprocedure:uellix_stella.stella_capacity(uuid,character)', (pg_catalog.to_regprocedure('uellix_stella.stella_capacity(uuid,character)') IS NOT NULL),
      'regprocedure:uellix_stella.consume_stella_capacity(uuid,uuid,character varying,character)', (pg_catalog.to_regprocedure('uellix_stella.consume_stella_capacity(uuid,uuid,character varying,character)') IS NOT NULL),
      'regprocedure:uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character)', (pg_catalog.to_regprocedure('uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'stella_0017_governed_stella_consumption',
      'witnesses', jsonb_build_object(
      'regprocedure:uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character,character varying,character,character varying,integer,jsonb)', (pg_catalog.to_regprocedure('uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character,character varying,character,character varying,integer,jsonb)') IS NOT NULL),
      'regprocedure:uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb)', (pg_catalog.to_regprocedure('uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb)') IS NOT NULL),
      'constraint:public.stella_interactions.stella_interactions_governed_identity_check', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'stella_interactions' AND k.conname = 'stella_interactions_governed_identity_check')
      )),
    jsonb_build_object(
      'packageId', 'stella_0018_category_bound_operation_tickets',
      'witnesses', jsonb_build_object(
      'regprocedure:uellix_stella_ops.bind_operation_ticket(character,uuid,character,character varying)', (pg_catalog.to_regprocedure('uellix_stella_ops.bind_operation_ticket(character,uuid,character,character varying)') IS NOT NULL)
      )),
    jsonb_build_object(
      'packageId', 'grounding_0005_claim_advisory_lock',
      'witnesses', jsonb_build_object(
      'routine-body:uellix_grounding.claim_active_document_version(uuid):pg_advisory_xact_lock', EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('uellix_grounding.claim_active_document_version(uuid)') AND position('pg_advisory_xact_lock' in pg_catalog.regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^\n]*', '', 'g')) > 0)
      )))
));

ROLLBACK;
