-- db/prepared/stella_0014_rollback.sql
-- Rollback of db/prepared/stella_0014_operation_tickets.sql (INT-INT-001).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in stella_0013_rollback.sql the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- ORDER. This rollback runs BEFORE stella_0013's. The forward package holds an
-- EXECUTE grant on `uellix_stella.consume_stella_quota` and USAGE on the schema
-- that contains it; stella_0013's rollback drops both. Run in the wrong order,
-- the REVOKEs in §5 below find nothing to revoke — which they tolerate, being
-- guarded on the object existing — but the ticket protocol would have spent the
-- interval installed and unable to charge, which is precisely the invisible
-- failure mode INT-CAP-001 reported one train ago.
--
-- ============================================================================
-- WHY THIS ROLLBACK CAN REFUSE, AND WHEN
-- ============================================================================
-- A COMPLETED ticket is the only record of WHICH operation a charged row of
-- `public.stella_interactions` paid for. That ledger is append-only for every
-- role including the owner (trg_stella_interactions_append_only, prepared
-- stella_0002), so the charge cannot be withdrawn to match a ticket table that
-- has gone. Dropping the table would leave charges nobody can account for and
-- an idempotency key nobody can re-derive — so a retry arriving afterwards
-- would find no ticket, be issued a new one, and be CHARGED AGAIN. Uninstalling
-- the protocol would reintroduce the exact defect the protocol closes.
--
-- So this script counts first and refuses with an explanation. A database that
-- has SETTLED an operation cannot un-know it; one that only INSTALLED the
-- protocol rolls back to the byte.
--
-- Tickets that are issued, bound, aborted or expired carry no such record: none
-- of them charged anything. They go with the table.
--
-- WHAT THIS ROLLBACK DOES NOT TOUCH
-- ---------------------------------
--   * schema uellix_stella and role uellix_cap_stella_quota — stella_0013 owns
--     them and drops them in its own rollback.
--   * uellix_stella.consume_stella_quota — stella_0013's function. Only the
--     EXECUTE grant this package made to its own role is withdrawn.
--   * public.stella_interactions, its column idempotency_key, its constraints,
--     its index and its policies — all stella_0013's or the baseline's.
--   * public.uellix_forbid_mutation() — baseline, shared with five other
--     immutable tables.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  tbl_oid    oid;
  n_settled  bigint;
BEGIN
  tbl_oid := to_regclass('uellix_stella_ops.operation_tickets');

  -- ------------------------------------------------------------------
  -- 1. The refusal, BEFORE anything is destroyed.
  -- ------------------------------------------------------------------
  IF tbl_oid IS NOT NULL THEN
    SELECT count(*) INTO n_settled
    FROM uellix_stella_ops.operation_tickets t
    WHERE t.status = 'completed';

    IF n_settled > 0 THEN
      RAISE EXCEPTION
        'stella_0014 rollback refused: % completed ticket(s) exist. Each one is the counterpart of a charged row in an append-only ledger, and dropping the table would leave those charges unattributable and their idempotency keys unrecoverable — so a retry would be issued a NEW ticket and charged a SECOND time. Uninstalling the protocol here would reintroduce the defect it closes.',
        n_settled;
    END IF;
  ELSE
    RAISE NOTICE 'stella_0014 rollback: uellix_stella_ops.operation_tickets is absent — nothing of this package can be attached to it.';
  END IF;

  -- ------------------------------------------------------------------
  -- 2. The six governed functions.
  --
  --    UNCONDITIONAL, and that is INT-CAP-004 (1)'s lesson applied before it
  --    can repeat: grounding_0003_rollback nested its DROP FUNCTIONs inside
  --    `IF the table exists`, so a database whose table had gone by another
  --    route reported a successful rollback while leaving callable SECURITY
  --    DEFINER functions behind — which then made the DROP ROLE permanently
  --    impossible. Nothing about dropping a function depends on a table, so
  --    nothing here is conditional on one.
  --
  --    Fixed literals through EXECUTE: no ||, no format(), no variable. The
  --    surrounding code decides WHETHER, never WHAT.
  -- ------------------------------------------------------------------
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(character, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.abort_operation_ticket(character, character varying)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.inspect_operation_ticket(character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.expire_operation_tickets(integer)';

  -- ------------------------------------------------------------------
  -- 3. The table — with its policies, triggers, constraints and index.
  --
  --    Reached only when §1 proved nothing was settled. NO CASCADE: this
  --    package's table is referenced by nothing, and a CASCADE would make the
  --    blast radius of this statement depend on what somebody attached later
  --    instead of on what this script states.
  --
  --    The policies and triggers are dropped EXPLICITLY first even though DROP
  --    TABLE would take them: a rollback whose effect depends on a cascade it
  --    never names is a rollback nobody can read.
  -- ------------------------------------------------------------------
  IF tbl_oid IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "operation_tickets_definer_select" ON uellix_stella_ops.operation_tickets';
    EXECUTE 'DROP POLICY IF EXISTS "operation_tickets_definer_insert" ON uellix_stella_ops.operation_tickets';
    EXECUTE 'DROP POLICY IF EXISTS "operation_tickets_definer_update" ON uellix_stella_ops.operation_tickets';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_operation_tickets_transition ON uellix_stella_ops.operation_tickets';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_operation_tickets_no_truncate ON uellix_stella_ops.operation_tickets';
    EXECUTE 'DROP INDEX IF EXISTS uellix_stella_ops.ix_operation_tickets_live_reservation';
    EXECUTE 'DROP TABLE uellix_stella_ops.operation_tickets';
  END IF;

  -- The schema belongs to THIS package, so unlike stella_0013's rollback — which
  -- shares `uellix_stella` with nobody today but was written not to assume it —
  -- this one drops it. Still guarded on emptiness rather than CASCADEd: if
  -- something else took up residence here, the right outcome is a NOTICE naming
  -- it, not a cascade that removes it.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops') THEN
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'uellix_stella_ops'
      UNION ALL
      SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'uellix_stella_ops'
    ) THEN
      RAISE NOTICE 'stella_0014 rollback: schema uellix_stella_ops still holds objects from another package — schema left in place.';
    ELSE
      EXECUTE 'DROP SCHEMA uellix_stella_ops';
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- 4. The trigger function in `public`.
  --
  --    UNCONDITIONAL, same reason as §2 — and it lives in `public`, where a
  --    leftover would be visible to every role in the cluster rather than
  --    tucked inside a capability schema.
  -- ------------------------------------------------------------------
  EXECUTE 'DROP FUNCTION IF EXISTS public.uellix_check_operation_ticket_transition()';

  -- ------------------------------------------------------------------
  -- 5. Every grant §1 of the forward package made, by NAME.
  --
  --    Not DROP OWNED BY: that would also discard a grant some other package
  --    made to the same role. Each REVOKE is guarded on the OBJECT existing,
  --    because this rollback must survive being run after stella_0013's (where
  --    consume_stella_quota and the schema are already gone) without reporting
  --    a failure that is really an ordering it tolerates.
  -- ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket') THEN
    IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NOT NULL THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, character varying, character) FROM uellix_cap_stella_ticket';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella') THEN
      EXECUTE 'REVOKE USAGE ON SCHEMA uellix_stella FROM uellix_cap_stella_ticket';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops') THEN
      EXECUTE 'REVOKE USAGE ON SCHEMA uellix_stella_ops FROM uellix_cap_stella_ticket';
      EXECUTE 'REVOKE USAGE ON SCHEMA uellix_stella_ops FROM uellix_app';
    END IF;
    IF to_regprocedure('public.current_user_org_ids()') IS NOT NULL THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.current_user_org_ids() FROM uellix_cap_stella_ticket';
    END IF;
    IF to_regprocedure('public.current_user_is_super_admin()') IS NOT NULL THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_stella_ticket';
    END IF;
    IF to_regprocedure('auth.uid()') IS NOT NULL THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION auth.uid() FROM uellix_cap_stella_ticket';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
      EXECUTE 'REVOKE USAGE ON SCHEMA auth FROM uellix_cap_stella_ticket';
    END IF;
    IF to_regclass('public.projects') IS NOT NULL THEN
      EXECUTE 'REVOKE SELECT ON public.projects FROM uellix_cap_stella_ticket';
    END IF;
    IF to_regclass('public.organizations') IS NOT NULL THEN
      EXECUTE 'REVOKE SELECT ON public.organizations FROM uellix_cap_stella_ticket';
    END IF;
    IF to_regclass('public.stella_interactions') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL ON public.stella_interactions FROM uellix_cap_stella_ticket';
    END IF;

    -- DROP ROLE still fails if any object anywhere is owned by it, or if any
    -- privilege this package did not grant is still held — which is the
    -- desired behaviour: it surfaces something this rollback did not know
    -- about instead of orphaning it.
    EXECUTE 'DROP ROLE uellix_cap_stella_ticket';
    RAISE NOTICE 'stella_0014 rollback: role uellix_cap_stella_ticket dropped.';
  END IF;

  -- ------------------------------------------------------------------
  -- 6. Postconditions. Asserted rather than assumed: this is the last moment
  --    at which the transaction can still roll back.
  -- ------------------------------------------------------------------
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: uellix_stella_ops.operation_tickets is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops') THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: schema uellix_stella_ops still exists.';
  END IF;
  IF to_regprocedure('uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.abort_operation_ticket(character, character varying)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.expire_operation_tickets(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: a governed function is still installed and still callable.';
  END IF;
  IF to_regprocedure('public.uellix_check_operation_ticket_transition()') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: the state-machine trigger function is still installed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket') THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: role uellix_cap_stella_ticket still exists.';
  END IF;
  -- The ledger must be exactly as this rollback found it. A rollback that
  -- removed a charged row would be destroying the compliance trail to tidy up
  -- after itself.
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: public.stella_interactions no longer exists. This rollback must never touch the compliance trail — aborting so the transaction rolls back.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella')
     AND to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 rollback FAILED: schema uellix_stella survives but stella_0013''s function is gone. This rollback must not remove it — aborting so the transaction rolls back.';
  END IF;

  RAISE NOTICE 'stella_0014 rollback: complete. Schema uellix_stella, role uellix_cap_stella_quota, uellix_stella.consume_stella_quota and public.stella_interactions are intentionally left in place — stella_0013 owns them.';
END $$;
