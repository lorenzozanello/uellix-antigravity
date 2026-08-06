-- db/prepared/stella_0016_rollback.sql
-- Rollback of db/prepared/stella_0016_reserved_quota_semantics.sql (R1).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in stella_0015_rollback.sql the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- ORDER. This rollback runs FIRST, before stella_0015's, and the SQL imposes it
-- at both ends: the functions removed here are the ones stella_0015's rollback
-- expects to find already gone or still present under names it drops with
-- `IF EXISTS`, and the three functions this package added to `uellix_stella` are
-- owned by `uellix_cap_stella_quota`, so stella_0013's `DROP ROLE` fails while
-- they still exist — its whole transaction aborts and nothing is destroyed.
--
-- ============================================================================
-- WHAT THIS ROLLBACK REFUSES TO DO, AND WHY THAT IS THE STRATEGY
-- ============================================================================
-- A rollback normally restores what the forward package replaced. Here that
-- would mean RECREATING stella_0015's `bind_operation_ticket` and
-- `complete_operation_ticket` — the pair whose reservation arithmetic is
-- actor-scoped and whose `complete` charges through `consume_stella_quota` and
-- therefore competes a second time for the unit its own `bind` reserved.
--
-- That is the defect. R1 is not a bug inside a function body that a newer body
-- fixed; it is the ABSENCE of reservation-aware arithmetic, so "restoring the
-- previous version" and "republishing the vulnerability" are the same statement.
-- On a database that only INSTALLED the package the two are also
-- indistinguishable from harmless — but this script cannot know which database
-- it is running on, and the one where it matters is the one with real tickets,
-- real reservations and a real reason to be rolling something back.
--
-- So the strategy is stated rather than implied:
--
--   * the three capacity functions are revoked and dropped;
--   * `bind_operation_ticket` and `complete_operation_ticket` are revoked and
--     DROPPED — not reverted. §5 asserts that no version of either survives;
--   * the capacity policy, the column grants and the derived period column go;
--   * every CHARGED ROW stays. A unit filed by a conversion is indistinguishable
--     from a unit filed by any other consumption — the construction is
--     deliberately identical — and the ledger is append-only for the owner too.
--
-- WHAT THE DATABASE LOOKS LIKE AFTERWARDS. `issue_operation_ticket`,
-- `abort_operation_ticket`, `inspect_operation_ticket` and
-- `expire_operation_tickets` remain callable and none of them charges anything:
-- a ticket can still be minted, inspected, abandoned and swept, and nothing can
-- be reserved or settled. `uellix_stella.consume_stella_quota` is untouched, so
-- the five ticketless Stella actions keep exactly the path they had before this
-- package existed. That is a CLOSED surface, not a degraded one — the honest end
-- state for "undo the fix without reopening the hole".
--
-- Any ticket left in `bound` releases its reservation on its own at
-- `expires_at`, which stella_0014's own CHECK bounds to fifteen minutes, so no
-- quota is stranded for longer than that with no operator action at all.
--
-- If the intent is to return to the project-bound-but-not-reservation-aware
-- protocol, that is a decision this script deliberately does not make in
-- silence — re-applying stella_0015_project_bound_operation_tickets.sql
-- republishes those two signatures, in a statement someone has to write on
-- purpose. If the intent is to remove the protocol entirely, run
-- stella_0015_rollback.sql next, then stella_0014's, then stella_0013's.
--
-- TO RE-APPLY stella_0016 AFTER THIS ROLLBACK, RUN stella_0015 FIRST:
--
--     psql -1 -f db/prepared/stella_0015_project_bound_operation_tickets.sql
--     psql -1 -f db/prepared/stella_0016_reserved_quota_semantics.sql
--
-- and the order is enforced, not advised: stella_0016 §0 REFUSES to install
-- when the three-argument bind/complete are absent, precisely so it can never
-- be the package that MINTS those signatures. That is the price of dropping
-- them rather than reverting them, and it is the right side to pay on — the
-- alternative is a rollback that quietly restores an arithmetic which counts
-- charged rows only.
--
-- stella_0014's rollback REFUSES on a database with completed tickets, and that
-- refusal is deliberate and belongs to that package: a completed ticket is the
-- counterpart of a charged, append-only ledger row. Nothing here weakens it.
--
-- WHAT THIS ROLLBACK DOES NOT TOUCH
-- ---------------------------------
--   * public.stella_interactions and every row in it, including the units filed
--     by settle_reserved_quota and consume_stella_capacity.
--   * uellix_stella.consume_stella_quota, schema uellix_stella, role
--     uellix_cap_stella_quota — stella_0013's.
--   * uellix_stella_ops.operation_tickets and every row in it, its triggers, its
--     three original policies, issue/abort/inspect/expire, the schema and
--     uellix_cap_stella_ticket — stella_0014's and stella_0015's.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  n_live    bigint;
  n_charged bigint;
BEGIN
  -- ------------------------------------------------------------------
  -- 1. Say what is in flight, BEFORE removing the verbs that settle it.
  --
  --    A NOTICE and not a refusal, and the difference is measured rather than
  --    preferred: a `bound` ticket holds a reservation, never a charge, and its
  --    reservation is released by `expires_at` alone. Refusing here would block
  --    a rollback for at most fifteen minutes of self-healing state, which is a
  --    refusal that protects nothing.
  -- ------------------------------------------------------------------
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NOT NULL THEN
    SELECT count(*) INTO n_live
    FROM uellix_stella_ops.operation_tickets t
    WHERE t.status = 'bound'
      AND t.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());

    IF n_live > 0 THEN
      RAISE NOTICE 'stella_0016 rollback: % live reservation(s) exist. They were never charged, and each releases itself at its own expires_at — bounded to 15 minutes by operation_tickets_expiry_window_check. Their tickets can no longer be completed after this script runs; abort_operation_ticket stays available to settle them explicitly.', n_live;
    END IF;
  ELSE
    RAISE NOTICE 'stella_0016 rollback: uellix_stella_ops.operation_tickets is absent — stella_0014 is not installed here, so nothing of this package can be attached to it.';
  END IF;

  -- The charges this package's two writing paths filed. Reported, NEVER removed:
  -- they are units an organization actually spent, they are indistinguishable
  -- from every other unit by construction, and the ledger is append-only for the
  -- owner as well. A rollback that could erase a consumption is not a rollback,
  -- it is a refund nobody authorised.
  IF to_regclass('public.stella_interactions') IS NOT NULL THEN
    SELECT count(*) INTO n_charged
    FROM public.stella_interactions si
    WHERE si.idempotency_key IS NOT NULL;
    RAISE NOTICE 'stella_0016 rollback: % identified charge(s) remain in public.stella_interactions and are left exactly as found. Nothing here removes a consumption.', n_charged;
  END IF;

  -- ------------------------------------------------------------------
  -- 2. The two ticket verbs: revoked, then dropped. NOT reverted.
  --
  --    Both UNCONDITIONAL, and that is INT-CAP-004 (1)'s lesson:
  --    grounding_0003_rollback nested its DROP FUNCTIONs inside `IF the table
  --    exists`, so a database whose table had gone by another route reported a
  --    successful rollback while leaving callable SECURITY DEFINER functions
  --    behind — which then made the DROP ROLE permanently impossible.
  --
  --    The REVOKE is stated even though the DROP would take the ACL with it: if
  --    the DROP failed for any reason the transaction aborts and neither
  --    happened, but a reader auditing "what privileges did this withdraw" must
  --    be able to find the answer by reading, not by inferring it from a cascade.
  --
  --    Fixed literals through EXECUTE: no ||, no format(), no variable.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(character, uuid, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(character, uuid, character) FROM uellix_app';
  END IF;
  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, uuid, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, uuid, character) FROM uellix_app';
  END IF;

  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(character, uuid, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, uuid, character)';

  -- ------------------------------------------------------------------
  -- 3. The three capacity functions.
  --
  --    settle_reserved_quota FIRST in the reading order, because it is the one
  --    that can charge without evaluating a limit and therefore the one whose
  --    continued existence would matter most. The DROPs are independent, so the
  --    order is for the reader; the transaction makes them simultaneous.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character) FROM uellix_cap_stella_ticket';
  END IF;
  IF to_regprocedure('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character) FROM uellix_app';
  END IF;
  IF to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.stella_capacity(uuid, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.stella_capacity(uuid, character) FROM uellix_app';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.stella_capacity(uuid, character) FROM uellix_cap_stella_ticket';
  END IF;

  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.stella_capacity(uuid, character)';

  -- ------------------------------------------------------------------
  -- 4. The read surface this package opened onto the ticket table, and the
  --    derived column.
  --
  --    Guarded on the TABLE rather than on the policy: a database where
  --    stella_0014 has already gone has no table for either statement to name,
  --    and DROP POLICY takes no IF EXISTS for a missing relation.
  -- ------------------------------------------------------------------
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "operation_tickets_capacity_select" ON uellix_stella_ops.operation_tickets';
    EXECUTE 'REVOKE ALL ON TABLE uellix_stella_ops.operation_tickets FROM uellix_cap_stella_quota';
    -- The column is GENERATED, so nothing depends on it that this script did not
    -- create, and its value is recomputable from bound_at at any time.
    EXECUTE 'ALTER TABLE uellix_stella_ops.operation_tickets DROP COLUMN IF EXISTS period_month';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops') THEN
    EXECUTE 'REVOKE USAGE ON SCHEMA uellix_stella_ops FROM uellix_cap_stella_quota';
  END IF;

  -- ------------------------------------------------------------------
  -- 5. Postconditions. Asserted rather than assumed: this is the last moment at
  --    which the transaction can still roll back.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 rollback FAILED: a capacity function is still installed and still callable.';
  END IF;

  -- The refusal, as a machine assertion. If a future edit "restores" the
  -- previous version of either verb, this fires and the transaction rolls back —
  -- so the one thing this rollback must never do cannot be done by accident.
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, character)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 rollback FAILED: a reserve-or-settle verb exists. Rolling back R1 must not republish an arithmetic that counts charged rows only, nor a complete that competes for the unit its own bind reserved — aborting so the transaction rolls back.';
  END IF;

  -- stella_0013's half must be exactly as this script found it. Its function is
  -- how the five ticketless actions will keep charging after this rollback, and
  -- a rollback that took it would close capabilities this package never opened.
  IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 rollback FAILED: uellix_stella.consume_stella_quota is gone. This rollback must not remove stella_0013''s charge path — aborting so the transaction rolls back.';
  END IF;

  -- stella_0014's half likewise. `issue` is the only place a ticket's bindings
  -- are created; `abort` is what an operator uses to settle the reservations
  -- §1 just reported.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops') THEN
    IF to_regprocedure('uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)') IS NULL
       OR to_regprocedure('uellix_stella_ops.expire_operation_tickets(integer)') IS NULL THEN
      RAISE EXCEPTION 'stella_0016 rollback FAILED: stella_0014''s issue_operation_ticket or expire_operation_tickets is gone. This rollback must not remove them — aborting so the transaction rolls back.';
    END IF;
    IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL THEN
      RAISE EXCEPTION 'stella_0016 rollback FAILED: the ticket table is gone but its schema survives. This rollback must not touch stella_0014''s objects — aborting so the transaction rolls back.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('uellix_stella_ops.operation_tickets')
        AND a.attname = 'period_month' AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'stella_0016 rollback FAILED: operation_tickets.period_month survives — aborting so the transaction rolls back.';
    END IF;
  END IF;

  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 rollback FAILED: public.stella_interactions no longer exists. This rollback must never touch the compliance trail — aborting so the transaction rolls back.';
  END IF;

  RAISE NOTICE 'stella_0016 rollback: complete. The three capacity functions are gone, bind and complete were DROPPED rather than reverted, the capacity policy and the column grants are withdrawn and period_month is removed — reserving and settling are closed rather than reopened. public.stella_interactions, uellix_stella.consume_stella_quota, uellix_stella_ops.operation_tickets, its rows, issue/abort/inspect/expire, the schema and both capability roles are intentionally left in place.';
END $$;
