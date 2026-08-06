-- db/prepared/stella_0015_rollback.sql
-- Rollback of db/prepared/stella_0015_project_bound_operation_tickets.sql (R2-INT).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in stella_0014_rollback.sql the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- ORDER. This rollback runs BEFORE stella_0014's, and the SQL imposes it at
-- both ends: the four functions below are owned by `uellix_cap_stella_ticket`,
-- so stella_0014's `DROP ROLE` fails while they still exist — its whole
-- transaction aborts and nothing is destroyed. Run in the right order, this
-- script removes them first and stella_0014's rollback then converges.
--
-- ============================================================================
-- WHAT THIS ROLLBACK REFUSES TO DO, AND WHY THAT IS THE STRATEGY
-- ============================================================================
-- A rollback normally restores what the forward package replaced. Here that
-- would mean RECREATING `bind_operation_ticket(char, char)` and
-- `complete_operation_ticket(char, char)` — the two signatures that take no
-- execution project — and granting EXECUTE on them to `uellix_app` again.
--
-- That is the defect. R2-INT is not a bug inside a function body that a newer
-- body fixed; it is the ABSENCE of an argument, so "restoring the previous
-- version" and "republishing the vulnerability" are the same statement. On a
-- database that only INSTALLED the package the two are also indistinguishable
-- from harmless — but this script cannot know which database it is running on,
-- and the one where it matters is the one with real tickets and real charges.
--
-- So the strategy is stated rather than implied:
--
--   * the four project-bound signatures are revoked and dropped;
--   * the four unbound signatures are NOT recreated, and §4 asserts they are
--     absent when this script finishes;
--   * everything stella_0014 owns — the table, its rows, the triggers, the
--     policies, the RLS, the role, the schema, `issue` and `expire` — is left
--     exactly as found, for stella_0014's own rollback to remove.
--
-- WHAT THE DATABASE LOOKS LIKE AFTERWARDS. `issue_operation_ticket` and
-- `expire_operation_tickets` remain callable and neither of them charges
-- anything: a ticket can still be minted and abandoned, and nothing can be
-- reserved, settled, aborted or inspected. That is a CLOSED surface, not a
-- degraded one — the honest end state for "undo the fix without reopening the
-- hole". Any ticket left in `bound` releases its reservation on its own at
-- `expires_at`, which stella_0014's own CHECK bounds to fifteen minutes, so no
-- quota is stranded for longer than that with no operator action at all.
--
-- If the intent is to remove the ticket protocol entirely, run
-- stella_0014_rollback.sql next; if the intent is to return to the unbound
-- protocol, that is a decision this script deliberately does not make in
-- silence — re-applying stella_0014_operation_tickets.sql republishes those
-- signatures, in a statement someone has to write on purpose.
--
-- WHAT THIS ROLLBACK DOES NOT TOUCH
-- ---------------------------------
--   * uellix_stella_ops.operation_tickets and every row in it.
--   * uellix_stella_ops.issue_operation_ticket / expire_operation_tickets,
--     schema uellix_stella_ops, role uellix_cap_stella_ticket,
--     public.uellix_check_operation_ticket_transition() — stella_0014's.
--   * schema uellix_stella, uellix_stella.consume_stella_quota,
--     public.stella_interactions — stella_0013's or the baseline's. This
--     package granted nothing on any of them and withdraws nothing.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  n_live bigint;
BEGIN
  -- ------------------------------------------------------------------
  -- 1. Say what is in flight, BEFORE removing the verbs that settle it.
  --
  --    A NOTICE and not a refusal, and the difference is measured rather than
  --    preferred: a `bound` ticket holds a reservation, never a charge, and its
  --    reservation is released by `expires_at` alone (stella_0014 §4: expiry is
  --    part of the liveness predicate, not a job for a sweeper). Refusing here
  --    would block a rollback for at most fifteen minutes of self-healing
  --    state, which is a refusal that protects nothing.
  -- ------------------------------------------------------------------
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NOT NULL THEN
    SELECT count(*) INTO n_live
    FROM uellix_stella_ops.operation_tickets t
    WHERE t.status = 'bound'
      AND t.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());

    IF n_live > 0 THEN
      RAISE NOTICE 'stella_0015 rollback: % live reservation(s) exist. They were never charged, and each releases itself at its own expires_at — bounded to 15 minutes by operation_tickets_expiry_window_check. Their tickets can no longer be completed or aborted after this script runs.', n_live;
    END IF;
  ELSE
    RAISE NOTICE 'stella_0015 rollback: uellix_stella_ops.operation_tickets is absent — stella_0014 is not installed here, so nothing of this package can be attached to it.';
  END IF;

  -- ------------------------------------------------------------------
  -- 2. Revoke, then drop. Both UNCONDITIONAL, and that is INT-CAP-004 (1)'s
  --    lesson: grounding_0003_rollback nested its DROP FUNCTIONs inside
  --    `IF the table exists`, so a database whose table had gone by another
  --    route reported a successful rollback while leaving callable SECURITY
  --    DEFINER functions behind — which then made the DROP ROLE permanently
  --    impossible. Nothing about dropping a function depends on a table.
  --
  --    The REVOKE is stated even though the DROP would take the ACL with it:
  --    if the DROP failed for any reason the transaction aborts and neither
  --    happened, but a reader auditing "what privileges did this withdraw"
  --    must be able to find the answer by reading, not by inferring it from a
  --    cascade.
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
  IF to_regprocedure('uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.abort_operation_ticket(character, uuid, character varying) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.abort_operation_ticket(character, uuid, character varying) FROM uellix_app';
  END IF;
  IF to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character, uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.inspect_operation_ticket(character, uuid) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.inspect_operation_ticket(character, uuid) FROM uellix_app';
  END IF;

  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(character, uuid, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, uuid, character)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.inspect_operation_ticket(character, uuid)';

  -- ------------------------------------------------------------------
  -- 3. The unbound signatures are NOT recreated. There is no statement here,
  --    and its absence is the strategy — §4 turns it into an assertion so the
  --    absence cannot be undone by an edit that reads as a restoration.
  -- ------------------------------------------------------------------

  -- ------------------------------------------------------------------
  -- 4. Postconditions. Asserted rather than assumed: this is the last moment
  --    at which the transaction can still roll back.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 rollback FAILED: a project-bound function is still installed and still callable.';
  END IF;

  -- The refusal, as a machine assertion. If a future edit "restores" the
  -- previous version, this fires and the transaction rolls back — so the one
  -- thing this rollback must never do cannot be done by accident.
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.abort_operation_ticket(character, character varying)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 rollback FAILED: an operation-ticket function that takes NO execution project exists. Rolling back R2-INT must not republish the cross-project attribution it closes — aborting so the transaction rolls back.';
  END IF;

  -- stella_0014's half must be exactly as this script found it.
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL
     AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops') THEN
    RAISE EXCEPTION 'stella_0015 rollback FAILED: the ticket table is gone but its schema survives. This rollback must not touch stella_0014''s objects — aborting so the transaction rolls back.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_stella_ops')
     AND to_regprocedure('uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 rollback FAILED: stella_0014''s issue_operation_ticket is gone. This rollback must not remove it — aborting so the transaction rolls back.';
  END IF;
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 rollback FAILED: public.stella_interactions no longer exists. This rollback must never touch the compliance trail — aborting so the transaction rolls back.';
  END IF;

  RAISE NOTICE 'stella_0015 rollback: complete. The four project-bound functions are gone and the four unbound ones were NOT recreated — reserving, completing, aborting and inspecting are closed rather than reopened. uellix_stella_ops.operation_tickets, its rows, issue_operation_ticket, expire_operation_tickets, the schema and uellix_cap_stella_ticket are intentionally left in place — stella_0014 owns them.';
END $$;
