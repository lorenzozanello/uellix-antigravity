-- db/prepared/grounding_0002_rollback.sql
-- Rollback of db/prepared/grounding_0002_document_versions.sql (GR-002).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- `-1` and `-v ON_ERROR_STOP=1` are RECOMMENDED (atomicity, non-zero exit for a
-- gate that reads it) but they are NOT the barrier. Everything destructive
-- happens inside ONE `DO` block: in PL/pgSQL a RAISE EXCEPTION ends the block
-- immediately and no later statement OF THAT BLOCK runs. That is server
-- semantics inside a single statement, not client semantics between two — so
-- pasting this into the Supabase SQL editor, `supabase db execute`, a GUI client
-- or an open psql session cannot separate the guard from the DROP.
--
-- That separation is exactly the defect stella_0003_rollback.sql was hardened
-- against: a guard in a `DO` block followed by a top-level `DROP TABLE` is two
-- statements, and without `ON_ERROR_STOP` psql reports the first and sends the
-- second.
--
-- WHAT THIS DESTROYS
-- ------------------
-- public.evidence_document_versions is CHAIN OF CUSTODY, not a derived index.
-- Unlike evidence_chunks, it is NOT regenerable: the sealed file in Storage
-- yields the CURRENT bytes of an evidence item and says nothing about which
-- earlier bytes a citation was issued against. Dropping a populated table
-- destroys that history permanently.
--
-- Hence the authorization below. It is required only when the table HAS ROWS:
-- reverting a package that was applied and never written to is a technical
-- rollback and costs nothing.
--
--   SET grounding.rollback_confirm = 'true';   -- in THIS session, then run
--
-- ORDER. Functions before the table (they reference it), the table before the
-- schema, the schema before the role (a role owning objects cannot be dropped).
-- The role and the schema are dropped only if nothing else adopted them —
-- grounding_0003 puts its own functions in this schema, so rolling back 0002
-- while 0003 is applied leaves both in place and says so.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  tbl_oid      oid;
  n_rows       bigint;
  authorized   text;
  persisted    boolean;
  other_funcs  int;
  chunks_here  boolean;
BEGIN
  tbl_oid := to_regclass('public.evidence_document_versions');

  -- ------------------------------------------------------------------
  -- 1. grounding_0003 depends on this package. Refuse rather than
  --    cascade: dropping this table while evidence_chunks references it
  --    would either fail with PostgreSQL's native FK message or, with a
  --    CASCADE somebody added, silently take the chunk index with it.
  -- ------------------------------------------------------------------
  chunks_here := to_regclass('public.evidence_chunks') IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM pg_constraint c
                   WHERE c.conrelid = to_regclass('public.evidence_chunks')
                     AND c.contype = 'f'
                     AND c.confrelid = tbl_oid
                 );
  IF chunks_here THEN
    RAISE EXCEPTION
      'grounding_0002 rollback refused: public.evidence_chunks still references this table. Roll back grounding_0003 first (db/prepared/grounding_0003_rollback.sql).';
  END IF;

  -- ------------------------------------------------------------------
  -- 2. Nothing to do.
  -- ------------------------------------------------------------------
  IF tbl_oid IS NULL THEN
    RAISE NOTICE 'grounding_0002 rollback: public.evidence_document_versions is absent — nothing to drop.';
  ELSE
    -- ----------------------------------------------------------------
    -- 3. FORCE ROW LEVEL SECURITY makes count(*) untrustworthy.
    --    FORCE removes the owner's RLS bypass, so an owner without
    --    rolbypassrls counts 0 over a populated table — and this script
    --    would announce "no history lost" while destroying it. Same
    --    finding as stella_0003_rollback M1, reproduced on PG 17.6.
    -- ----------------------------------------------------------------
    IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
      RAISE EXCEPTION
        'grounding_0002 rollback refused: FORCE ROW LEVEL SECURITY is ON, so the row count below cannot be trusted. Turn it off, verify the count, and re-run.';
    END IF;

    -- ----------------------------------------------------------------
    -- 4. Close the TOCTOU with a concurrent INSERT, and pin the
    --    isolation level: under REPEATABLE READ the snapshot is taken
    --    BEFORE the lock, so the count can miss rows committed in that
    --    window and the script would certify a loss that happened.
    -- ----------------------------------------------------------------
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION
        'grounding_0002 rollback refused: transaction_isolation is %, not read committed. The row count would be taken from a snapshot older than the lock.',
        current_setting('transaction_isolation');
    END IF;

    LOCK TABLE public.evidence_document_versions IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO n_rows FROM public.evidence_document_versions;

    RAISE NOTICE 'grounding_0002 rollback: public.evidence_document_versions holds % version row(s).', n_rows;

    IF n_rows > 0 THEN
      -- --------------------------------------------------------------
      -- 5. Authorization. Only the EXACT string 'true' authorizes:
      --    'yes', 'y', '1', 'TRUE', 'True', 'on', 't' and ' true ' are
      --    all rejected, so a habit from another tool cannot approve a
      --    destructive act by accident.
      -- --------------------------------------------------------------
      authorized := current_setting('grounding.rollback_confirm', true);

      -- ...and it must come from THIS session. An `ALTER DATABASE/ROLE
      -- ... SET` persists the approval into every future session, which
      -- moves the defect from psql flags to the GUC layer instead of
      -- removing it. NB: pg_settings does not expose custom placeholder
      -- GUCs (0 rows), so provenance is read from pg_db_role_setting.
      -- The filter is on session_user: PostgreSQL applies those settings
      -- per LOGIN role, and a current_user variant fails OPEN exactly
      -- when the operator re-runs under SET ROLE.
      SELECT EXISTS (
        SELECT 1 FROM pg_db_role_setting s
        WHERE EXISTS (
          SELECT 1 FROM unnest(s.setconfig) AS cfg
          WHERE cfg LIKE 'grounding.rollback_confirm=%'
        )
        AND (s.setrole = 0 OR s.setrole = (SELECT oid FROM pg_roles WHERE rolname = session_user))
      ) INTO persisted;

      IF persisted THEN
        RAISE EXCEPTION
          'grounding_0002 rollback refused: grounding.rollback_confirm is persisted via ALTER DATABASE/ROLE, so it would pre-authorize every future session. Remove the persisted setting and set it per session instead.';
      END IF;

      IF authorized IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION
          'grounding_0002 rollback refused: public.evidence_document_versions holds % row(s) of chain-of-custody history, which is NOT regenerable from Storage. To proceed: SET grounding.rollback_confirm = ''true''; in this session (exactly that string), then re-run.',
          n_rows;
      END IF;

      RAISE NOTICE 'grounding_0002 rollback: AUTHORIZED to destroy % version row(s).', n_rows;
    END IF;

    -- ----------------------------------------------------------------
    -- 6. The DROPs. Fixed literals through EXECUTE — no ||, no format(),
    --    no variable. The surrounding code decides WHETHER to run them,
    --    never WHAT they say. No IF EXISTS on the table: its existence
    --    was proven a few lines above, in this same block.
    -- ----------------------------------------------------------------
    EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.register_document_version(uuid, char, char, char, character varying, character varying, character varying, character varying)';
    EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.claim_active_document_version(uuid)';
    -- Policies, indexes and triggers fall with the table.
    EXECUTE 'DROP TABLE public.evidence_document_versions';
    -- TRAIN 3 HARDENING. public.uellix_check_document_version_scope() is a
    -- plain (non-SECURITY-DEFINER) trigger function created BY this package,
    -- unlike public.uellix_forbid_mutation() which is baseline and shared with
    -- other append-only tables — that one is never dropped here. This one is
    -- exclusive to evidence_document_versions and has no other caller. Dropped
    -- AFTER the table: trg_evidence_document_versions_scope_check depends on
    -- it, and PostgreSQL refuses to drop a function a live trigger still
    -- references.
    EXECUTE 'DROP FUNCTION IF EXISTS public.uellix_check_document_version_scope()';
  END IF;

  -- ------------------------------------------------------------------
  -- 7. Schema and role, only when nothing else lives there.
  --    grounding_0003 installs its own functions in uellix_grounding, so
  --    a rollback of 0002 alone must leave both standing.
  -- ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_grounding') THEN
    SELECT count(*) INTO other_funcs
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'uellix_grounding';

    IF other_funcs = 0 THEN
      EXECUTE 'DROP SCHEMA uellix_grounding';

      -- FIXED BY INTEGRATION (train 2 dry-run). DROP ROLE is blocked by two
      -- distinct things, and the reasoning below only covered one of them:
      --
      --   * OWNERSHIP — objects the role owns. Those are gone: its five
      --     functions lived in uellix_grounding, dropped one statement above.
      --   * PRIVILEGES HELD — grants made TO the role on objects it does NOT
      --     own. Section 2 of grounding_0002 grants EXECUTE on
      --     public.current_user_org_ids() and public.current_user_is_super_admin()
      --     so the definer can call the RLS helpers. Those two functions belong
      --     to the BASELINE and are not dropped by anything here, so the grants
      --     survive and PostgreSQL refuses with
      --     "role ... cannot be dropped because some objects depend on it".
      --
      -- The rollback therefore aborted every time, leaving the role and the
      -- (already dropped) schema in an inconsistent half-state. No static test
      -- could see this: it only appears when the script is actually run.
      --
      -- Revoked EXPLICITLY, naming the two grants this package made, rather
      -- than with DROP OWNED BY: a blunt DROP OWNED would also silently
      -- discard a grant some OTHER package made to the same role, which is
      -- exactly the "object this rollback did not know about" the note below
      -- wants surfaced, not swallowed.
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.current_user_org_ids() FROM uellix_cap_grounding';
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_grounding';
      -- Same class, third grant: §2 also gives the definer SELECT on
      -- public.evidence_items so it can derive a version's scope from its
      -- parent. That table is baseline and outlives this package, so the
      -- privilege outlives it too and blocks DROP ROLE identically. Caught by
      -- scripts/grounding-dry-run.sh on the very run that proved the grant was
      -- needed — which is the argument for a rollback stage in a dry-run.
      EXECUTE 'REVOKE SELECT ON public.evidence_items FROM uellix_cap_grounding';

      -- DROP ROLE still fails if any object anywhere is owned by it, or if any
      -- privilege this package did not grant is still held — which is the
      -- desired behaviour: it surfaces something this rollback did not know
      -- about instead of orphaning it.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_grounding') THEN
        EXECUTE 'DROP ROLE uellix_cap_grounding';
      END IF;
      RAISE NOTICE 'grounding_0002 rollback: schema uellix_grounding and role uellix_cap_grounding dropped.';
    ELSE
      RAISE NOTICE 'grounding_0002 rollback: schema uellix_grounding still holds % function(s) (grounding_0003) — schema and role uellix_cap_grounding left in place.', other_funcs;
    END IF;
  END IF;

  RAISE NOTICE 'grounding_0002 rollback: complete.';
END $$;
