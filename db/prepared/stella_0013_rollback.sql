-- db/prepared/stella_0013_rollback.sql
-- Rollback of db/prepared/stella_0013_grounded_query_quota.sql (INT-CAP-001).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in grounding_0002_rollback.sql the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- ============================================================================
-- WHY THIS ROLLBACK CAN REFUSE, AND WHEN
-- ============================================================================
-- Removing `grounded_query` from the role vocabulary means narrowing a CHECK
-- constraint. If the ledger already holds a `grounded_query` row, that narrower
-- CHECK is one the stored data violates, and PostgreSQL would refuse the
-- ALTER with a raw constraint-violation message.
--
-- There is no way around it and the absence of a way around it is deliberate:
-- `stella_interactions` is append-only for EVERY role including the owner
-- (trg_stella_interactions_append_only, prepared stella_0002), so a rollback
-- cannot delete the rows to make room for the narrower constraint. That is the
-- point of an append-only compliance trail — a consumption that was recorded
-- stays recorded.
--
-- So this script counts first and refuses with an explanation, rather than
-- letting the operator read a constraint violation and guess. A database that
-- has CHARGED the capability cannot un-know it; one that only INSTALLED it
-- rolls back to the byte.
--
-- WHAT THIS ROLLBACK DOES NOT TOUCH
-- ---------------------------------
--   * public.stella_interactions itself, its baseline grants, its baseline
--     policies and trg_stella_interactions_append_only — all pre-date this
--     package.
--   * public.uellix_forbid_mutation() — baseline, shared with four other
--     immutable tables.
--   * schema uellix_grounding and role uellix_cap_grounding — grounding_0002
--     owns them.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  tbl_oid     oid;
  n_charged   bigint;
  other_funcs int;
BEGIN
  tbl_oid := to_regclass('public.stella_interactions');

  IF tbl_oid IS NULL THEN
    RAISE NOTICE 'stella_0013 rollback: public.stella_interactions is absent — nothing of this package can be attached to it.';
  END IF;

  -- ------------------------------------------------------------------
  -- 1. The refusal, BEFORE anything is destroyed.
  -- ------------------------------------------------------------------
  IF tbl_oid IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = tbl_oid AND a.attname = 'idempotency_key'
         AND a.attnum > 0 AND NOT a.attisdropped
     ) THEN
    SELECT count(*) INTO n_charged
    FROM public.stella_interactions si
    WHERE si.stella_role = 'grounded_query';

    IF n_charged > 0 THEN
      RAISE EXCEPTION
        'stella_0013 rollback refused: the ledger holds % grounded_query row(s). Narrowing stella_interactions_stella_role_check back to six values would leave a CHECK the stored rows violate, and this table is append-only for every role including the owner — the rows cannot be removed to make room for it. A database that has CHARGED this capability keeps the vocabulary that names what it charged.',
        n_charged;
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- 2. The governed function.
  --
  --    UNCONDITIONAL, and that is INT-CAP-004's lesson applied before it can
  --    repeat: grounding_0003_rollback nested its three DROP FUNCTIONs inside
  --    `IF the table exists`, so a database whose table had gone by another
  --    route reported a successful rollback while leaving three callable
  --    SECURITY DEFINER functions behind. Nothing about dropping a function
  --    depends on a table, so nothing here is conditional on one.
  --
  --    Fixed literals through EXECUTE: no ||, no format(), no variable. The
  --    surrounding code decides WHETHER, never WHAT.
  -- ------------------------------------------------------------------
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)';

  -- ------------------------------------------------------------------
  -- 3. The policy, the index and the constraints this package added.
  -- ------------------------------------------------------------------
  IF tbl_oid IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "stella_interactions_quota_definer_insert" ON public.stella_interactions';
    EXECUTE 'DROP INDEX IF EXISTS public.uq_stella_interactions_idempotency';
    EXECUTE 'ALTER TABLE public.stella_interactions DROP CONSTRAINT IF EXISTS stella_interactions_grounded_query_idempotency_check';
    EXECUTE 'ALTER TABLE public.stella_interactions DROP CONSTRAINT IF EXISTS stella_interactions_idempotency_key_shape_check';
    -- The column last: dropping it would take the two constraints and the
    -- index with it anyway, and relying on that would make this rollback's
    -- effect depend on a cascade it never states.
    EXECUTE 'ALTER TABLE public.stella_interactions DROP COLUMN IF EXISTS idempotency_key';

    -- ----------------------------------------------------------------
    -- 4. The vocabulary, back to the six values db/schema.ts declares.
    --    Reached only when §1 proved nothing was charged.
    -- ----------------------------------------------------------------
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = tbl_oid AND conname = 'stella_interactions_stella_role_check'
    ) THEN
      EXECUTE 'ALTER TABLE public.stella_interactions DROP CONSTRAINT stella_interactions_stella_role_check';
    END IF;
    EXECUTE 'ALTER TABLE public.stella_interactions ADD CONSTRAINT stella_interactions_stella_role_check CHECK (stella_role IN (''advisor'', ''validator'', ''composer'', ''proxy_reviewer'', ''evidence_reviewer'', ''audit_assistant''))';
  END IF;

  -- ------------------------------------------------------------------
  -- 5. Schema and role, only when nothing else lives there.
  --
  --    DROP ROLE is blocked by two distinct things and both are handled:
  --    OWNERSHIP (the function, dropped in §2) and PRIVILEGES HELD (grants to
  --    the role on objects it does not own, which outlive the package and
  --    block the drop with "role ... cannot be dropped because some objects
  --    depend on it"). Every grant stella_0013 §1 made is revoked here by
  --    NAME rather than with a blunt DROP OWNED BY, which would also discard
  --    a grant some other package made to the same role.
  -- ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella') THEN
    SELECT count(*) INTO other_funcs
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'uellix_stella';

    IF other_funcs = 0 THEN
      EXECUTE 'DROP SCHEMA uellix_stella';
    ELSE
      RAISE NOTICE 'stella_0013 rollback: schema uellix_stella still holds % function(s) from another package — schema and role left in place.', other_funcs;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_quota') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.current_user_org_ids() FROM uellix_cap_stella_quota';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_stella_quota';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION auth.uid() FROM uellix_cap_stella_quota';
    EXECUTE 'REVOKE USAGE ON SCHEMA auth FROM uellix_cap_stella_quota';
    EXECUTE 'REVOKE SELECT ON public.organizations FROM uellix_cap_stella_quota';
    EXECUTE 'REVOKE SELECT ON public.projects FROM uellix_cap_stella_quota';
    EXECUTE 'REVOKE SELECT, INSERT ON public.stella_interactions FROM uellix_cap_stella_quota';

    -- DROP ROLE still fails if any object anywhere is owned by it, or if any
    -- privilege this package did not grant is still held — which is the
    -- desired behaviour: it surfaces something this rollback did not know
    -- about instead of orphaning it.
    EXECUTE 'DROP ROLE uellix_cap_stella_quota';
    RAISE NOTICE 'stella_0013 rollback: schema uellix_stella and role uellix_cap_stella_quota dropped.';
  END IF;

  -- ------------------------------------------------------------------
  -- 6. Postconditions. Asserted rather than assumed: this is the last moment
  --    at which the transaction can still roll back.
  -- ------------------------------------------------------------------
  IF tbl_oid IS NULL AND to_regclass('public.stella_interactions') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 rollback FAILED: the ledger appeared mid-transaction — refusing to report a result about a table this run never inspected.';
  END IF;
  IF to_regclass('public.stella_interactions') IS NULL AND tbl_oid IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 rollback FAILED: public.stella_interactions no longer exists. This rollback must never remove the compliance trail — aborting so the transaction rolls back.';
  END IF;
  IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 rollback FAILED: the governed function is still installed and still callable.';
  END IF;

  RAISE NOTICE 'stella_0013 rollback: complete. public.stella_interactions, its baseline grants and policies, and trg_stella_interactions_append_only are intentionally left in place.';
END $$;
