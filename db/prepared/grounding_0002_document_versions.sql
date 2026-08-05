-- db/prepared/grounding_0002_document_versions.sql
-- GR-002 — append-only chain of custody for document versions.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: grounding_0002_rollback.sql.
--
-- CONTRACT:     docs/ops/contracts/GR-002_document_version_history.md
-- RESPONSE:     docs/ops/contracts/GR-CAP-001_grounding_persistence_response.md
-- COMMON MODEL: docs/ops/DATABASE_CAPABILITY_MODEL.md
-- SOURCE OF TRUTH: this table is deliberately absent from db/schema.ts and the
-- drizzle snapshot — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §7.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- `evidence_items` holds ONE content_hash per evidence row. Re-uploading a
-- corrected file overwrites it, and every citation issued against the previous
-- bytes is orphaned without anything saying so: the chunk ids depend on
-- versionId, versionId depends on rawContentHash, and the old hash is gone.
--
-- This table is the chain of custody, not a derived index. Unlike
-- `evidence_chunks` (grounding_0003), which is regenerable from the sealed file
-- and may be dropped, a row here is never modified and never deleted — same
-- posture as audit_logs / runs / line_items, enforced by the same trigger
-- function (public.uellix_forbid_mutation) rather than merely intended.
--
-- ============================================================================
-- HOW "EXACTLY ONE ACTIVE VERSION" IS TRUE WITHOUT A SINGLE UPDATE
-- ============================================================================
-- An `is_active boolean` column would need an UPDATE to move the flag, and an
-- UPDATE is the one thing an append-only table must not accept. So activeness
-- is DERIVED, and the derivation is made total by four constraints:
--
--   UNIQUE (evidence_id, ordinal)                  -- no two versions rank equal
--   UNIQUE (evidence_id, version_id)               -- re-ingesting bytes is idempotent
--   UNIQUE (evidence_id, supersedes_version_id)    -- a version is replaced at most
--                                                     once, so the history cannot fork
--   CHECK  ((ordinal = 1) = (supersedes_version_id IS NULL))
--                                                  -- exactly one root, and only
--                                                     the root supersedes nothing
--
-- Together those make the history of an evidence item a LINEAR chain rooted at
-- ordinal 1. "The active version" is then `max(ordinal)`, which is unique by the
-- first constraint. `uellix_grounding.claim_active_document_version` returns it
-- and takes the same lock the registrar takes, so a reader never observes a
-- half-registered successor.
--
-- ============================================================================
-- WHY IT RUNS AS SUPERUSER (same reason as stella_0006..0012)
-- ============================================================================
-- It CREATEs a role, and `uellix_owner` is NOCREATEROLE by design — granting it
-- CREATEROLE would undo stella_0004, which checks for exactly that and aborts.
-- Three windows, same functional boundaries as the capability campaign:
--   1. superuser      — preconditions, CREATE ROLE, schema and its grants
--   2. SET ROLE owner — DDL on public, table grants, policies, triggers
--   3. superuser      — the functions, their ownership, their ACL, postconditions
--
-- RUN AS ONE TRANSACTION:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent AND convergent. If the table exists with an INCOMPATIBLE shape the
-- script ABORTS with the mismatching column list instead of silently doing
-- nothing. No CREATE INDEX CONCURRENTLY, so single-transaction execution holds.

SET search_path = public;

-- Section 6's DROP/CREATE TRIGGER takes ACCESS EXCLUSIVE and holds it to COMMIT.
-- Bound the wait: the script is convergent, so aborting and retrying is free.
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (superuser window)
-- ============================================================
DO $$
DECLARE
  mismatched    text;
  missing_roles text;
BEGIN
  -- 0.1 Superuser — required for CREATE ROLE (see the header).
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'grounding_0002 aborted: must run as a SUPERUSER (current_user=%). It creates a role, and uellix_owner is NOCREATEROLE by design — granting it CREATEROLE would undo stella_0004.', current_user;
  END IF;

  -- 0.2 stella_0004 role separation must already be in place. Without it there
  --     is no owner to authorize the schema to and no runtime role to grant
  --     EXECUTE to, and the whole isolation argument below is vacuous.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('uellix_owner'), ('uellix_app'), ('uellix_auditor')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 aborted: requires stella_0004 (missing role(s): %).', missing_roles;
  END IF;

  -- 0.3 The Supabase-facing roles must exist: section 4 revokes from them, and
  --     a bare 'role "authenticated" does not exist' would land after the table
  --     was already created.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 aborted: missing role(s): %. This database was not bootstrapped by Supabase; the grant model this script reconciles does not apply.', missing_roles;
  END IF;

  -- 0.4 FK targets.
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.evidence_items') IS NULL THEN
    RAISE EXCEPTION 'grounding_0002 aborted: organizations, projects or evidence_items is missing — this database is not at the expected migration baseline.';
  END IF;

  -- 0.5 RLS helpers (db/migrations/0031_rls_core.sql), executable by the reader
  --     role (0039_grant_rls_helper_execution.sql — 0033:18 revokes it, 0039
  --     grants it back; a database with the first and not the second looks
  --     healthy here and denies every read).
  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'grounding_0002 aborted: RLS helpers public.current_user_org_ids()/current_user_is_super_admin() not found — apply db/migrations/0031_rls_core.sql first.';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.current_user_org_ids()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'grounding_0002 aborted: role authenticated lacks EXECUTE on the RLS helpers — apply db/migrations/0039_grant_rls_helper_execution.sql. Without it the SELECT policy denies every read.';
  END IF;

  -- 0.6 The append-only trigger function (db/migrations/0030_immutability.sql).
  IF to_regprocedure('public.uellix_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION 'grounding_0002 aborted: public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first.';
  END IF;

  -- 0.7 Shape guard — only when the table already exists. Column names, types
  --     and nullability only; never row data.
  IF to_regclass('public.evidence_document_versions') IS NOT NULL THEN
    SELECT string_agg(
             format('%s (expected %s%s)', e.col, e.typ,
                    CASE WHEN e.nul = 'NO' THEN ' NOT NULL' ELSE ' NULL' END),
             ', ' ORDER BY e.col)
      INTO mismatched
    FROM (VALUES
      ('id',                      'uuid',                     'NO'),
      ('organization_id',         'uuid',                     'NO'),
      ('project_id',              'uuid',                     'NO'),
      ('evidence_id',             'uuid',                     'NO'),
      ('version_id',              'character',                'NO'),
      ('raw_content_hash',        'character',                'NO'),
      ('normalized_content_hash', 'character',                'NO'),
      ('normalization_version',   'character varying',        'NO'),
      ('extractor_version',       'character varying',        'NO'),
      ('chunker_version',         'character varying',        'NO'),
      ('mime_type',               'character varying',        'NO'),
      ('ordinal',                 'integer',                  'NO'),
      ('supersedes_version_id',   'character',                'YES'),
      ('created_at',              'timestamp with time zone', 'NO')
    ) AS e(col, typ, nul)
    LEFT JOIN information_schema.columns c
           ON c.table_schema = 'public'
          AND c.table_name   = 'evidence_document_versions'
          AND c.column_name  = e.col
          AND c.data_type    = e.typ
          AND c.is_nullable  = e.nul
    WHERE c.column_name IS NULL;

    IF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'grounding_0002 aborted: public.evidence_document_versions already exists with an INCOMPATIBLE shape. Missing or mismatched columns: %. This script never ALTERs COLUMNS of an existing table — resolve manually and re-run.',
        mismatched;
    END IF;
  END IF;
END $$;

-- ============================================================
-- 1. Capability role and schema (superuser window)
-- ============================================================
-- NOLOGIN, no attributes, ZERO members. It exists to OWN the SECURITY DEFINER
-- functions and for nothing else: with no members, no LOGIN role can reach its
-- privileges by SET ROLE, which is what stops `uellix_migrator` (a LOGIN role
-- that reaches uellix_owner) from becoming a path into the ingestion writes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_grounding') THEN
    EXECUTE 'CREATE ROLE uellix_cap_grounding';
  END IF;
END $$;

-- Stated unconditionally so a re-run converges even if someone widened them.
ALTER ROLE uellix_cap_grounding
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- A schema of its own rather than `uellix_capability`: the five capability
-- packages drop that schema in their rollbacks as soon as it is empty, so
-- sharing it would couple this package's rollback order to a campaign it has no
-- dependency on.
CREATE SCHEMA IF NOT EXISTS uellix_grounding AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;
GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;

-- The definer needs EXECUTE on the RLS helpers it calls. They are themselves
-- SECURITY DEFINER owned by uellix_owner and read the CALLER's auth.uid(), so
-- granting EXECUTE confers no data: for a caller with no session they return
-- the empty set.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_grounding;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_grounding;

-- ADDED BY INTEGRATION (train 2 adversarial review). The definer resolves a
-- version's scope from its parent evidence item — that derivation is the whole
-- reason the payload is not trusted to declare organization and project — and
-- it held NO privilege on that table, so every call failed with "permission
-- denied for table evidence_items".
--
-- SELECT, and only SELECT. Not UPDATE: the row lock that used to require it is
-- now an advisory lock (see register_document_version), because widening a
-- business table's write surface to make a lock convenient is how a boundary
-- stops meaning anything. Not DELETE, not INSERT: this role must never change
-- an evidence item, only read the two columns that place it.
GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;

-- ============================================================
-- 2. Table (owner window)
-- ============================================================
SET ROLE uellix_owner;

-- char(64), not varchar/text: every hash here is a lowercase-hex SHA-256 of
-- fixed width (lib/grounding/contracts/core.ts, CONTENT_HASH_HEX_LENGTH). A
-- fixed-width type plus the anchored CHECKs in section 3 makes a truncated or
-- salted digest unstorable rather than merely unexpected.
CREATE TABLE IF NOT EXISTS public.evidence_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- Scope. Both are DERIVED from evidence_items by the registrar function and
  -- re-checked by section 3's constraints; neither is accepted from a caller.
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  -- NOT NULL, deliberately diverging from GR-002/GR-001 §2.1, which proposed a
  -- nullable project ("null = organization-scoped evidence"). No such evidence
  -- exists: evidence_items.project_id is itself NOT NULL. A nullable column
  -- here would invite a row that no evidence item can produce, and every
  -- project-scoped read would have to carry an OR IS NULL branch that can only
  -- ever widen the boundary.
  project_id uuid NOT NULL REFERENCES public.projects(id),

  -- NO ACTION (the default), NOT CASCADE: this table is chain of custody. It
  -- must BLOCK deletion of the evidence row rather than vanish with it — the
  -- same invariant db/prepared/stella_0003 pins for the decision trail.
  -- evidence_chunks (grounding_0003) is the regenerable index and DOES cascade.
  evidence_id uuid NOT NULL REFERENCES public.evidence_items(id),

  -- deriveVersionId(evidenceId, rawContentHash) — content-addressed, so
  -- re-ingesting identical bytes yields the same id and never forks history.
  version_id char(64) NOT NULL,
  raw_content_hash char(64) NOT NULL,
  -- The coordinate space every anchor of this version addresses. Chunk offsets
  -- are meaningful ONLY against the text with this digest.
  normalized_content_hash char(64) NOT NULL,

  normalization_version varchar(32) NOT NULL,
  -- NOT in GR-002's proposed shape, and not decoration. versionId is derived
  -- from (evidenceId, rawContentHash) ONLY, so a change of extractor produces a
  -- different normalized_content_hash under the SAME version_id. Without this
  -- column, re-ingestion under a new extractor is indistinguishable from a
  -- replay and would be discarded as a duplicate, leaving stale offsets in
  -- place with nothing to indicate it. With it, the registrar can refuse.
  extractor_version varchar(32) NOT NULL,
  chunker_version varchar(32) NOT NULL,

  -- The one metadata column, and it is bounded on purpose: a normalized MIME
  -- type ("text/csv", parameters stripped) selects which extractor contract
  -- applies when a third party re-derives the chunks. The source LABEL
  -- (filename/URL) is deliberately NOT stored — it is user-supplied text that
  -- routinely carries personal data, and nothing in the verification chain
  -- needs it.
  mime_type varchar(255) NOT NULL,

  -- 1-based position in this document's history.
  ordinal integer NOT NULL,
  -- version_id of the version this one replaces; NULL only for the root.
  supersedes_version_id char(64),

  -- Server clock. The ingestion core is pure and holds no clock by design, so
  -- this is the only timestamp in the chain and it is the database's.
  created_at timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT evidence_document_versions_version_id_unique
    UNIQUE (evidence_id, version_id),
  CONSTRAINT evidence_document_versions_ordinal_unique
    UNIQUE (evidence_id, ordinal),
  -- A version may be superseded at most once: without this, two concurrent
  -- registrations could both claim to replace version N and the history would
  -- fork into two branches with no way to say which one a citation resolves in.
  CONSTRAINT evidence_document_versions_supersedes_unique
    UNIQUE (evidence_id, supersedes_version_id),
  CONSTRAINT evidence_document_versions_ordinal_check
    CHECK (ordinal >= 1),
  -- Exactly one root per evidence item, only the root supersedes nothing, and
  -- no version replaces itself (which would make the chain cyclic).
  CONSTRAINT evidence_document_versions_history_shape_check
    CHECK ((ordinal = 1) = (supersedes_version_id IS NULL)
           AND (supersedes_version_id IS NULL OR supersedes_version_id <> version_id)),
  -- One constraint over every digest rather than four: the reconciliation in
  -- section 3 compares DEFINITIONS, and four near-identical definitions are
  -- four chances to reconcile the wrong one.
  CONSTRAINT evidence_document_versions_hash_shape_check
    CHECK (version_id ~ '^[0-9a-f]{64}$'
           AND raw_content_hash ~ '^[0-9a-f]{64}$'
           AND normalized_content_hash ~ '^[0-9a-f]{64}$'
           AND (supersedes_version_id IS NULL OR supersedes_version_id ~ '^[0-9a-f]{64}$')),
  CONSTRAINT evidence_document_versions_pipeline_version_check
    CHECK (normalization_version <> '' AND extractor_version <> '' AND chunker_version <> ''),
  CONSTRAINT evidence_document_versions_mime_type_check
    CHECK (mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$')
);

-- ============================================================
-- 3. Constraint reconciliation — convergent, by DEFINITION
-- ============================================================
-- Comparing conname alone is a trap: a constraint carrying the right name with
-- a stale definition survives a re-run and lets the gate sign off green over a
-- weaker guarantee. Compare what pg_get_constraintdef renders.
--
-- CHECKs are rebuilt when stale. UNIQUEs are NEVER silently dropped — dropping
-- a uniqueness guarantee to re-add a variant is riskier than stopping, so a
-- mismatch aborts. Same asymmetry as grounding_0001 and stella_0003.
--
-- EVERY STATEMENT BELOW IS A LITERAL. No `EXECUTE format(...)`, no variable, no
-- concatenation — not for style, but because the static contract in
-- tests/helpers/sql-structure.ts REFUSES dynamic SQL rather than guessing at
-- it: a composed statement is reported as `unparsed-security-statement` and no
-- gate can judge what it does. A table-driven loop would have been shorter and
-- unreadable to the one reader that matters.
--
-- position(), never LIKE: `_` is a LIKE wildcard and every identifier here
-- contains one, so a stale definition spelling `versionXid` would match.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_ordinal_check';
  IF def IS NULL OR position('ordinal >= 1' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_document_versions
        DROP CONSTRAINT evidence_document_versions_ordinal_check;
    END IF;
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_ordinal_check CHECK (ordinal >= 1);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_history_shape_check';
  -- Both halves are probed. Checking only the root clause would leave a stale
  -- definition that dropped the self-supersede half silently in place.
  IF def IS NULL
     OR position('ordinal = 1' in def) = 0
     OR position('<> version_id' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_document_versions
        DROP CONSTRAINT evidence_document_versions_history_shape_check;
    END IF;
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_history_shape_check
      CHECK ((ordinal = 1) = (supersedes_version_id IS NULL)
             AND (supersedes_version_id IS NULL OR supersedes_version_id <> version_id));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_hash_shape_check';
  -- Each column is probed by NAME as well as the anchored pattern: a stale
  -- definition that kept the pattern but dropped one column would otherwise
  -- survive, and the dropped one is the one that stops being validated.
  IF def IS NULL
     OR position('^[0-9a-f]{64}$' in def) = 0
     OR position('version_id' in def) = 0
     OR position('raw_content_hash' in def) = 0
     OR position('normalized_content_hash' in def) = 0
     OR position('supersedes_version_id' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_document_versions
        DROP CONSTRAINT evidence_document_versions_hash_shape_check;
    END IF;
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_hash_shape_check
      CHECK (version_id ~ '^[0-9a-f]{64}$'
             AND raw_content_hash ~ '^[0-9a-f]{64}$'
             AND normalized_content_hash ~ '^[0-9a-f]{64}$'
             AND (supersedes_version_id IS NULL OR supersedes_version_id ~ '^[0-9a-f]{64}$'));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_pipeline_version_check';
  IF def IS NULL
     OR position('normalization_version' in def) = 0
     OR position('extractor_version' in def) = 0
     OR position('chunker_version' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_document_versions
        DROP CONSTRAINT evidence_document_versions_pipeline_version_check;
    END IF;
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_pipeline_version_check
      CHECK (normalization_version <> '' AND extractor_version <> '' AND chunker_version <> '');
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_mime_type_check';
  IF def IS NULL OR position('mime_type' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_document_versions
        DROP CONSTRAINT evidence_document_versions_mime_type_check;
    END IF;
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_mime_type_check
      CHECK (mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$');
  END IF;

  -- --- UNIQUE: added when missing, never silently replaced ------------------
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_version_id_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_version_id_unique UNIQUE (evidence_id, version_id);
  ELSIF position('UNIQUE (evidence_id, version_id)' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0002 aborted: constraint evidence_document_versions_version_id_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_ordinal_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_ordinal_unique UNIQUE (evidence_id, ordinal);
  ELSIF position('UNIQUE (evidence_id, ordinal)' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0002 aborted: constraint evidence_document_versions_ordinal_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_document_versions'::regclass
    AND conname = 'evidence_document_versions_supersedes_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_document_versions
      ADD CONSTRAINT evidence_document_versions_supersedes_unique UNIQUE (evidence_id, supersedes_version_id);
  ELSIF position('UNIQUE (evidence_id, supersedes_version_id)' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0002 aborted: constraint evidence_document_versions_supersedes_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;
END $$;

-- ============================================================
-- 4. Indexes (no CONCURRENTLY — one transaction)
-- ============================================================
-- The history lookup the registrar does on every ingestion.
CREATE INDEX IF NOT EXISTS idx_evidence_document_versions_evidence_ordinal
  ON public.evidence_document_versions (evidence_id, ordinal DESC);
-- The isolation lookup: every scoped read filters on both, explicitly, in
-- addition to RLS. Same double belt the rest of the pipeline uses.
CREATE INDEX IF NOT EXISTS idx_evidence_document_versions_scope
  ON public.evidence_document_versions (organization_id, project_id);

-- ============================================================
-- 5. Grants — deny by default, then the minimum back
-- ============================================================
-- REVOKE ALL first rather than listing privileges to remove: Supabase's
-- ALTER DEFAULT PRIVILEGES makes every table created in `public` born granting
-- `Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) to `authenticated` and full
-- `arwdDxtm` to `service_role`. That surplus is exactly what left the four
-- pre-existing audit tables TRUNCATE-able and forced stella_0002b. Enumerating
-- what to revoke silently misses whatever a future version adds; REVOKE ALL
-- cannot inherit a surplus it was not written to anticipate.
REVOKE ALL ON public.evidence_document_versions FROM PUBLIC;
REVOKE ALL ON public.evidence_document_versions FROM anon;
REVOKE ALL ON public.evidence_document_versions FROM authenticated;
REVOKE ALL ON public.evidence_document_versions FROM service_role;
REVOKE ALL ON public.evidence_document_versions FROM uellix_app;
REVOKE ALL ON public.evidence_document_versions FROM uellix_writer;
REVOKE ALL ON public.evidence_document_versions FROM uellix_auditor;

-- Reads only, and every read is bounded by the RLS policy in section 6.
--
-- `authenticated` — the PostgREST principal. SELECT only.
-- `uellix_app`    — the runtime. SELECT only: it NEVER inserts here directly.
--                   Registration goes through the SECURITY DEFINER function in
--                   section 8, which is the whole point of the capability role:
--                   an endpoint that reached this table with an INSERT could
--                   invent a history, and inventing a history is the failure
--                   this table exists to make impossible.
-- `uellix_auditor`— SELECT. Reading the chain of custody is its job.
-- `anon`, `service_role`, `uellix_writer` — nothing.
--
-- No INSERT grant to anyone. The definer function owns the write path and holds
-- its privilege by OWNERSHIP of the table's schema path, not by a grant that
-- something else could also receive.
GRANT SELECT ON public.evidence_document_versions TO authenticated;
GRANT SELECT ON public.evidence_document_versions TO uellix_app;
GRANT SELECT ON public.evidence_document_versions TO uellix_auditor;
GRANT SELECT, INSERT ON public.evidence_document_versions TO uellix_cap_grounding;

-- ============================================================
-- 6. RLS — organization AND project isolation
-- ============================================================
-- Two policies, and the split is not cosmetic:
--
--   evidence_document_versions_select — for real users (authenticated,
--     uellix_app, uellix_auditor). Bounded by organization membership, with the
--     project boundary carried by the explicit filter every caller applies plus
--     the function in section 8 that will not answer across projects.
--
--   evidence_document_versions_definer_insert — the ONLY INSERT policy, scoped
--     TO uellix_cap_grounding. A policy without a TO clause applies to PUBLIC,
--     which is what re-activated the pre-cutover grants in stella_0005c; every
--     policy here names its role.
--
-- No UPDATE policy and no DELETE policy: append-only, denied by absence AND by
-- the triggers in section 7, which are the only control that also reaches the
-- table owner.
ALTER TABLE public.evidence_document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_document_versions_select" ON public.evidence_document_versions;
CREATE POLICY "evidence_document_versions_select"
ON public.evidence_document_versions FOR SELECT
TO authenticated, uellix_app, uellix_auditor
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

DROP POLICY IF EXISTS "evidence_document_versions_definer_insert" ON public.evidence_document_versions;
CREATE POLICY "evidence_document_versions_definer_insert"
ON public.evidence_document_versions FOR INSERT
TO uellix_cap_grounding
WITH CHECK (
  -- The scope written must be the scope the evidence row actually has. The
  -- registrar derives it, so this can only fire if someone changes the
  -- registrar — which is the point: the invariant is in the database, not only
  -- in the function that currently upholds it.
  EXISTS (
    SELECT 1 FROM public.evidence_items e
    WHERE e.id = evidence_document_versions.evidence_id
      AND e.organization_id = evidence_document_versions.organization_id
      AND e.project_id = evidence_document_versions.project_id
  )
);

-- RESTRICTIVE, so it ANDs with everything above and can only narrow. It states
-- the isolation invariant a second time, for every command and every role: a
-- row whose scope disagrees with its evidence item is unreadable and
-- uninsertable no matter which permissive policy would otherwise admit it.
DROP POLICY IF EXISTS "evidence_document_versions_scope_consistency" ON public.evidence_document_versions;
CREATE POLICY "evidence_document_versions_scope_consistency"
ON public.evidence_document_versions AS RESTRICTIVE FOR ALL
TO authenticated, uellix_app, uellix_auditor, uellix_cap_grounding
USING (
  EXISTS (
    SELECT 1 FROM public.evidence_items e
    WHERE e.id = evidence_document_versions.evidence_id
      AND e.organization_id = evidence_document_versions.organization_id
      AND e.project_id = evidence_document_versions.project_id
  )
);

-- ============================================================
-- 7. Append-only enforcement
-- ============================================================
-- RLS and grants both stop at the table OWNER. Triggers are the one control
-- that fires for every role, owner included, so they are what makes "a version
-- is never modified and never deleted" true rather than merely intended.
--
-- Two triggers, disjoint events: a FOR EACH ROW trigger can never see TRUNCATE
-- (there are no OLD/NEW rows), and PostgreSQL forbids FOR EACH ROW on TRUNCATE.
-- Omitting the second is exactly the gap stella_0002b had to close after the
-- fact on four tables. This one ships with both.
DROP TRIGGER IF EXISTS trg_evidence_document_versions_append_only ON public.evidence_document_versions;
CREATE TRIGGER trg_evidence_document_versions_append_only
  BEFORE UPDATE OR DELETE ON public.evidence_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_evidence_document_versions_no_truncate ON public.evidence_document_versions;
CREATE TRIGGER trg_evidence_document_versions_no_truncate
  BEFORE TRUNCATE ON public.evidence_document_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

COMMENT ON TRIGGER trg_evidence_document_versions_append_only ON public.evidence_document_versions IS
  'GR-002 (prepared grounding_0002): document version history is append-only; UPDATE/DELETE are forbidden even for the table owner.';
COMMENT ON TRIGGER trg_evidence_document_versions_no_truncate ON public.evidence_document_versions IS
  'GR-002 (prepared grounding_0002): TRUNCATE is forbidden on this append-only table, including for the table owner.';

COMMENT ON TABLE public.evidence_document_versions IS
  'Append-only chain of custody for evidence document versions (GR-002, prepared grounding_0002). Not a derived index: a row is never modified or deleted. Managed outside the drizzle chain — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';

RESET ROLE;

-- ============================================================
-- 8. Governed write path (superuser window)
-- ============================================================
-- The whole function lifecycle runs here — CREATE OR REPLACE, ALTER OWNER,
-- REVOKE, GRANT — for the two reasons stella_0006's header records:
--   * ALTER FUNCTION ... OWNER TO requires the NEW owner to hold CREATE on the
--     schema, and the capability role deliberately holds only USAGE;
--   * a second apply's CREATE OR REPLACE as uellix_owner would fail «must be
--     owner of function», because ownership resolves through has_privs_of_role
--     and the role has no members.
-- Doing it as superuser removes the reason the capability role would need a
-- member at all, so it keeps ZERO — and a role with zero members is not
-- reachable by SET ROLE from any connection string.
--
-- search_path is '' — not 'public, pg_temp'. With pg_temp on the path a caller
-- can create a temporary object that shadows an unqualified name, and a
-- SECURITY DEFINER would then run it with the definer's privileges. Every
-- object below is schema-qualified, so the empty path costs nothing.

-- ------------------------------------------------------------
-- 8a. register_document_version
-- ------------------------------------------------------------
-- Registers one version and returns its row id.
--
-- SCOPE IS DERIVED, NEVER ACCEPTED. The caller supplies an evidence id and the
-- pipeline facts; organization and project come from the evidence row. A caller
-- that could state its own scope could file a version of another tenant's
-- document under its own organization, and no predicate over the arguments
-- could tell that apart from a legitimate call.
--
-- IDEMPOTENT, AND THAT IS NOT THE SAME AS PERMISSIVE. Re-registering the same
-- version_id returns the existing id — re-ingesting identical bytes must not
-- fork history. But if the stored row disagrees on ANY pipeline fact
-- (normalized hash, normalization/extractor/chunker version), it raises U0101
-- instead: that combination means the same bytes produced a different
-- coordinate space, so every stored offset for this version is now suspect and
-- silently returning the old id would leave them in place. See the note in
-- docs/ops/contracts/GR-CAP-001_grounding_persistence_response.md §5 —
-- rejecting is the strict reading; the alternative (a NEW ordinal for the same
-- bytes under a new pipeline) is a product decision, not a schema one.
CREATE OR REPLACE FUNCTION uellix_grounding.register_document_version(
  p_evidence_id uuid,
  p_version_id char(64),
  p_raw_content_hash char(64),
  p_normalized_content_hash char(64),
  p_normalization_version varchar(32),
  p_extractor_version varchar(32),
  p_chunker_version varchar(32),
  p_mime_type varchar(255)
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org        uuid;
  v_project    uuid;
  v_existing   public.evidence_document_versions%ROWTYPE;
  v_prev       public.evidence_document_versions%ROWTYPE;
  v_id         uuid;
BEGIN
  -- Argument validation, before anything is read. The messages name the
  -- ARGUMENT, never a value: an error string is a channel, and a hash echoed
  -- back to an untrusted caller is an oracle.
  IF p_evidence_id IS NULL THEN
    RAISE EXCEPTION 'grounding: evidence id is required' USING ERRCODE = 'U0100';
  END IF;
  IF p_version_id !~ '^[0-9a-f]{64}$'
     OR p_raw_content_hash !~ '^[0-9a-f]{64}$'
     OR p_normalized_content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'grounding: a supplied digest is not a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;
  IF coalesce(p_normalization_version, '') = ''
     OR coalesce(p_extractor_version, '') = ''
     OR coalesce(p_chunker_version, '') = ''
     OR coalesce(p_mime_type, '') = '' THEN
    RAISE EXCEPTION 'grounding: pipeline versions and mime type are required' USING ERRCODE = 'U0100';
  END IF;

  -- Serialise two concurrent registrations for the same document against each
  -- other, which is what makes the ordinal and the supersedes link consistent
  -- rather than racy — the UNIQUE constraints would catch a race, but as a
  -- constraint violation the caller cannot distinguish from a genuine conflict.
  --
  -- FIXED BY INTEGRATION (train 2 adversarial review). This was
  -- `SELECT ... FROM public.evidence_items ... FOR UPDATE`, and PostgreSQL
  -- requires UPDATE privilege on a table to take a row lock on it — not just
  -- SELECT. `uellix_cap_grounding` holds neither (verified in a disposable
  -- container: `has_table_privilege` returns false for SELECT and for UPDATE),
  -- so EVERY call failed with "permission denied for table evidence_items" and
  -- no document version could ever be registered. The packages installed
  -- cleanly and were functionally dead; a dry-run that inspects structure
  -- without INVOKING the functions cannot see that, which is why this one now
  -- calls them.
  --
  -- The repair is a transaction-scoped ADVISORY lock rather than
  -- `GRANT UPDATE ON public.evidence_items TO uellix_cap_grounding`. Granting
  -- write on a business table so that a lock in another table's function is
  -- convenient is exactly what §6 of this package warns against: it is how a
  -- boundary becomes decorative. The advisory lock gives the same mutual
  -- exclusion, keyed on the same row, and needs no privilege at all.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0));

  SELECT e.organization_id, e.project_id INTO v_org, v_project
  FROM public.evidence_items e
  WHERE e.id = p_evidence_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'grounding: evidence item not found' USING ERRCODE = 'U0102';
  END IF;

  -- The definer bypasses RLS, so the caller's boundary has to be re-imposed
  -- here explicitly.
  --
  -- FIXED BY INTEGRATION (train 2 adversarial review). This check was ABSENT,
  -- and it is present in all three sibling definer functions
  -- (`claim_active_document_version` below, `insert_evidence_chunks` and
  -- `chunks_in_scope` in grounding_0003). This is the only WRITE entry point
  -- into the version history, EXECUTE is granted to the shared runtime role
  -- `uellix_app`, and the table is append-only — so a caller holding another
  -- organization's `evidence_items.id` appended a permanent, attacker-chosen
  -- row to that organization's chain of custody, which
  -- `claim_active_document_version` then returned as the active version, with
  -- no UPDATE or DELETE path for anyone to remove it.
  --
  -- Same message as "not found", for the same reason as everywhere else here:
  -- telling the two apart is a tenancy oracle.
  IF NOT (v_org = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: evidence item not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT * INTO v_existing
  FROM public.evidence_document_versions v
  WHERE v.evidence_id = p_evidence_id AND v.version_id = p_version_id;

  IF FOUND THEN
    IF v_existing.normalized_content_hash <> p_normalized_content_hash
       OR v_existing.normalization_version <> p_normalization_version
       OR v_existing.extractor_version <> p_extractor_version
       OR v_existing.chunker_version <> p_chunker_version THEN
      RAISE EXCEPTION
        'grounding: this version is already registered under a different pipeline; stored anchors would no longer resolve'
        USING ERRCODE = 'U0101';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_prev
  FROM public.evidence_document_versions v
  WHERE v.evidence_id = p_evidence_id
  ORDER BY v.ordinal DESC
  LIMIT 1;

  INSERT INTO public.evidence_document_versions (
    organization_id, project_id, evidence_id, version_id,
    raw_content_hash, normalized_content_hash,
    normalization_version, extractor_version, chunker_version, mime_type,
    ordinal, supersedes_version_id
  ) VALUES (
    v_org, v_project, p_evidence_id, p_version_id,
    p_raw_content_hash, p_normalized_content_hash,
    p_normalization_version, p_extractor_version, p_chunker_version, p_mime_type,
    coalesce(v_prev.ordinal, 0) + 1, v_prev.version_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- 8b. claim_active_document_version
-- ------------------------------------------------------------
-- The active version is max(ordinal), which is unique by construction (see the
-- header). "Claim" rather than "get": it takes the same evidence-row lock the
-- registrar takes, so a caller that is about to write chunks against the answer
-- cannot have a successor registered underneath it before it commits.
--
-- STABLE is deliberately NOT declared: the lock is a side effect, and a STABLE
-- function may be folded or executed in a snapshot where the lock means
-- nothing.
CREATE OR REPLACE FUNCTION uellix_grounding.claim_active_document_version(
  p_evidence_id uuid
)
RETURNS TABLE (
  id uuid,
  version_id char(64),
  ordinal integer,
  normalized_content_hash char(64),
  normalization_version varchar(32),
  extractor_version varchar(32),
  chunker_version varchar(32)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF p_evidence_id IS NULL THEN
    RAISE EXCEPTION 'grounding: evidence id is required' USING ERRCODE = 'U0100';
  END IF;

  SELECT e.organization_id INTO v_org
  FROM public.evidence_items e
  WHERE e.id = p_evidence_id
  FOR UPDATE;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'grounding: evidence item not found' USING ERRCODE = 'U0102';
  END IF;

  -- The definer bypasses RLS, so the caller's boundary has to be re-imposed
  -- here explicitly. Same message for "not yours" and "does not exist": telling
  -- them apart is a tenancy oracle.
  IF NOT (v_org = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: evidence item not found' USING ERRCODE = 'U0102';
  END IF;

  -- Explicit column list, never SELECT *: a column added later would silently
  -- change this function's result shape and break its callers at run time.
  RETURN QUERY
  SELECT v.id, v.version_id, v.ordinal, v.normalized_content_hash,
         v.normalization_version, v.extractor_version, v.chunker_version
  FROM public.evidence_document_versions v
  WHERE v.evidence_id = p_evidence_id
  ORDER BY v.ordinal DESC
  LIMIT 1;
END;
$$;

-- ------------------------------------------------------------
-- 8c. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_grounding.register_document_version(uuid, char(64), char(64), char(64), varchar(32), varchar(32), varchar(32), varchar(255))
  OWNER TO uellix_cap_grounding;
ALTER FUNCTION uellix_grounding.claim_active_document_version(uuid)
  OWNER TO uellix_cap_grounding;

-- EXECUTE is granted to PUBLIC by default on a new function. Revoke first, then
-- grant to the one role that may call it.
REVOKE ALL ON FUNCTION uellix_grounding.register_document_version(uuid, char(64), char(64), char(64), varchar(32), varchar(32), varchar(32), varchar(255)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_grounding.claim_active_document_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_grounding.register_document_version(uuid, char(64), char(64), char(64), varchar(32), varchar(32), varchar(32), varchar(255)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_grounding.claim_active_document_version(uuid) TO uellix_app;

COMMENT ON FUNCTION uellix_grounding.register_document_version(uuid, char(64), char(64), char(64), varchar(32), varchar(32), varchar(32), varchar(255)) IS
  'GR-002: registers one document version. Scope is derived from evidence_items, never accepted from the caller. Idempotent on version_id; raises U0101 when the same version is re-registered under a different pipeline.';
COMMENT ON FUNCTION uellix_grounding.claim_active_document_version(uuid) IS
  'GR-002: the active version of a document (max ordinal, unique by construction), under the same evidence-row lock the registrar takes.';

-- ============================================================
-- 9. Self-verification — assert the end state, in this transaction
-- ============================================================
-- A REVOKE only removes grants made by the CURRENT grantor and PostgreSQL emits
-- a WARNING, never an error, when there is nothing to revoke. So "I ran REVOKE
-- ALL" is not evidence the privilege is gone. Everything below reads pg_catalog
-- through aclexplode(), which reports the ACL literally: inherited privileges
-- do not appear and there is no superuser short-circuit.
DO $$
DECLARE
  tbl_oid oid;
  problem text;
  n       int;
BEGIN
  tbl_oid := to_regclass('public.evidence_document_versions');
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: the table does not exist after the script ran';
  END IF;

  -- (1) Exactly the 14 contracted columns, no extras.
  SELECT count(*) INTO n FROM pg_attribute
  WHERE attrelid = tbl_oid AND attnum > 0 AND NOT attisdropped;
  IF n <> 14 THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: expected exactly 14 columns, found %', n;
  END IF;

  -- (2) The FK to evidence_items must be NO ACTION. CASCADE here would turn an
  --     evidence deletion into silent chain-of-custody loss, which is the whole
  --     thing this table exists to prevent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid AND c.contype = 'f'
      AND c.confrelid = to_regclass('public.evidence_items')
      AND c.confdeltype = 'a'
  ) THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: the evidence_items foreign key is missing or is not ON DELETE NO ACTION';
  END IF;

  -- (3) The three UNIQUE constraints that make "one active version" a theorem.
  SELECT string_agg(s.conname, ', ' ORDER BY s.conname) INTO problem
  FROM (VALUES
    ('evidence_document_versions_version_id_unique'),
    ('evidence_document_versions_ordinal_unique'),
    ('evidence_document_versions_supersedes_unique')
  ) AS s(conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = tbl_oid AND contype = 'u' AND conname = s.conname
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: missing UNIQUE constraint(s): %. Without them the version history can fork and "the active version" stops being well defined', problem;
  END IF;

  -- (4) RLS on, FORCE off. FORCE would remove the owner's bypass; with no
  --     UPDATE/DELETE policy that is harmless, but it would also block the
  --     definer's INSERT path, and the script would still report success.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: ROW LEVEL SECURITY is not enabled';
  END IF;

  -- (5) Exactly three policies, and no UPDATE or DELETE policy at all.
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
  IF n <> 3 THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: expected exactly 3 RLS policies, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid AND polcmd IN ('w', 'd');
  IF n <> 0 THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: % UPDATE/DELETE policy(ies) present. Append-only means they are denied by absence', n;
  END IF;

  -- (6) Both append-only triggers, bound to public.uellix_forbid_mutation, and
  --     nothing else on the table.
  SELECT count(*) INTO n FROM pg_trigger t
  WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal
    AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')::oid;
  IF n <> 2 THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: expected 2 triggers bound to public.uellix_forbid_mutation(), found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = tbl_oid AND NOT tgisinternal;
  IF n <> 2 THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: unexpected extra trigger(s) (total %, expected 2)', n;
  END IF;

  -- (7) No write privilege for any principal other than the definer role, and
  --     nothing at all for PUBLIC.
  SELECT string_agg(g.rolname || ':' || a.privilege_type, ', ' ORDER BY g.rolname, a.privilege_type)
    INTO problem
  FROM pg_class c,
       aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND g.rolname <> 'uellix_cap_grounding'
    AND g.rolname <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = tbl_oid);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: unexpected write privilege(s): %. Only the definer role may write, and only through uellix_grounding.register_document_version', problem;
  END IF;

  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = tbl_oid AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: PUBLIC holds privilege(s): %. That reaches every role in the cluster, anon included', problem;
  END IF;

  -- (8) The capability role has ZERO members. A member would make the ingestion
  --     write path reachable by SET ROLE from a real connection string.
  SELECT count(*) INTO n FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  WHERE r.rolname = 'uellix_cap_grounding';
  IF n <> 0 THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: uellix_cap_grounding has % member(s). It must have none, or SET ROLE reaches the write path', n;
  END IF;

  -- (9) Both functions are SECURITY DEFINER with an EMPTY search_path, and
  --     EXECUTE is not held by PUBLIC.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_grounding'
    -- BOTH spellings, and this is not defensive padding: PostgreSQL stores
    -- `SET search_path = ''` in proconfig as `search_path=""` — it QUOTES the
    -- empty value. Checking only the bare form makes this predicate always
    -- true, so the RAISE below fired on every apply and the package could not
    -- be installed at all (found by scripts/grounding-dry-run.sh; the functions
    -- themselves were correct, the verifier was not). Every stella_0006..0011
    -- package in this directory already checks both forms; this one did not.
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_grounding' AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0002 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  RAISE NOTICE 'grounding_0002: verification passed — 14 columns, evidence FK NO ACTION, 3 UNIQUE constraints, RLS on with 3 policies and no UPDATE/DELETE policy, 2 append-only triggers, no write privilege outside uellix_cap_grounding, capability role with 0 members, both functions SECURITY DEFINER with empty search_path.';
END $$;
