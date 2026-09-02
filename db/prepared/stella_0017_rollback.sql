-- db/prepared/stella_0017_rollback.sql
-- Rollback of db/prepared/stella_0017_governed_stella_consumption.sql
-- (R1 residual / R6-INT).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in stella_0016_rollback.sql the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- ORDER. This rollback runs FIRST, before stella_0016's, and the SQL imposes it
-- at both ends. §1 REFUSES on a database where stella_0016's objects are already
-- gone, because the five-argument conversion this script restores is a body that
-- calls `uellix_stella.stella_capacity` — restoring it without that function
-- would publish a `SECURITY DEFINER` function that fails at its first call, in a
-- state neither package describes. And in the other direction: the ten-argument
-- conversion is owned by `uellix_cap_stella_quota`, so leaving it behind makes
-- stella_0013's `DROP ROLE` fail and aborts a rollback three links downstream.
--
-- ============================================================================
-- WHAT THIS ROLLBACK REFUSES TO DO, AND WHY THAT IS THE STRATEGY
-- ============================================================================
-- A rollback normally restores what the forward package withdrew. Here that
-- would mean GRANTING `INSERT` on `public.stella_interactions` back to
-- `uellix_writer` — which every runtime session inherits — and DROPPING the
-- CHECK that requires a governed operation identity on every new row.
--
-- IT DOES NEITHER, and that is stated rather than omitted:
--
--     the REVOKE stays.  The CHECK stays.
--
-- The direct write is not a feature this package replaced; it is the defect it
-- closed. R6-INT is the statement that five actions can charge the ledger with
-- an unlocked read followed by an unlocked write, and R1 as measured on
-- stella_0016 is what that composes into once `complete` stops evaluating the
-- limit: `Consumed = 2` against `Limit = 1`. "Restoring the previous behaviour"
-- and "reopening a measured oversell" are the same statement, so this script
-- declines to make it in silence. An operator who genuinely wants the direct
-- write back has to write the GRANT themselves, in a statement someone signed.
--
-- WHAT THE DATABASE LOOKS LIKE AFTERWARDS. The grounded path is exactly what
-- stella_0016 left: issue, bind, the three-argument complete, abort, inspect,
-- expire, `stella_capacity`, `consume_stella_capacity` and the five-argument
-- `settle_reserved_quota`, all callable, all reservation-aware. The SIBLING
-- categories can still be issued, bound, aborted and inspected — the ticket has
-- carried all seven since stella_0014 — but they can no longer be COMPLETED,
-- because the verb that files their payload is gone and no runtime principal may
-- write the ledger by hand.
--
-- That is a CLOSED surface, not a degraded one, and it is the honest end state
-- for "undo the generalisation without reopening the hole": no sibling unit can
-- be charged, and no sibling unit can be charged UNGOVERNED either. Every
-- reservation left behind releases itself at its own `expires_at`, bounded to
-- fifteen minutes by `operation_tickets_expiry_window_check`, so nothing is
-- stranded for longer than that with no operator action at all.
--
-- WHAT IT DOES NOT REMOVE
--   * public.stella_interactions and every row in it — including the units
--     filed through the sibling verb. A charge is a charge; the construction is
--     deliberately indistinguishable from every other, and the ledger is
--     append-only for the owner as well. A rollback that could erase a
--     consumption is not a rollback, it is a refund nobody authorised.
--   * stella_interactions_governed_identity_check, and
--     stella_0013's narrower stella_interactions_grounded_query_idempotency_check.
--   * every REVOKE of §1 of the forward package.
--   * uellix_stella_ops.operation_tickets, its rows, its triggers, its four
--     policies, its generated period column and the six functions stella_0015
--     and stella_0016 left there.
--
-- RE-APPLYING stella_0017 AFTER THIS ROLLBACK IS EXACT. The revokes and the
-- CHECK are already in place and both are convergent, so the second application
-- reaches the same state as the first — asserted by the dry run rather than
-- claimed here.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  n_live    bigint;
  n_sibling bigint;
  n_charged bigint;
BEGIN
  -- ------------------------------------------------------------------
  -- 1. The refusal that makes the order safe.
  --
  --    This is not hygiene. §3 republishes the five-argument conversion with
  --    stella_0016's own body, and that body calls `uellix_stella.stella_capacity`
  --    and reads `uellix_stella_ops.operation_tickets` through a column grant and
  --    a policy stella_0016 installs. On a database where stella_0016's rollback
  --    has already run, none of those exist: the republished function would
  --    install cleanly, be granted to the ticket definer, and fail on its first
  --    call. A rollback that leaves a callable function which cannot work is
  --    worse than one that refuses, because only one of the two is visible.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback REFUSED: uellix_stella.stella_capacity is absent, so stella_0016 has already been rolled back here. This script restores a conversion whose body calls that function; publishing it now would install a SECURITY DEFINER function that fails at its first call. There is nothing left of stella_0017 to remove that stella_0016''s rollback did not already make unreachable — and if the ten-argument conversion still exists, drop it explicitly before continuing.';
  END IF;

  IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback REFUSED: uellix_stella_ops.operation_tickets is absent — stella_0014 is not installed here. Every verb this script removes reads that table, and a rollback that runs against a chain it cannot see is a rollback whose postconditions mean nothing.';
  END IF;

  -- ------------------------------------------------------------------
  -- 2. Say what is in flight, BEFORE removing the verb that settles it.
  --
  --    A NOTICE and not a refusal, and the distinction is stella_0016's and is
  --    reused rather than reargued: a `bound` ticket holds a reservation, never
  --    a charge, and its reservation is released by `expires_at` alone. Refusing
  --    would block a rollback for at most fifteen minutes of self-healing state.
  --
  --    The SIBLING count is reported separately because it is the one this
  --    script actually strands: a grounded reservation can still be completed
  --    afterwards, and a sibling one cannot.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n_live
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.status = 'bound'
    AND t.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());

  SELECT count(*) INTO n_sibling
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.status = 'bound'
    AND t.expires_at > pg_catalog.timezone('UTC', pg_catalog.now())
    AND t.category <> 'grounded_query';

  IF n_live > 0 THEN
    RAISE NOTICE 'stella_0017 rollback: % live reservation(s) exist, % of them for a sibling category. None was ever charged. The sibling ones can no longer be completed after this script runs — abort_operation_ticket settles them explicitly, and expires_at settles them on its own within 15 minutes.', n_live, n_sibling;
  END IF;

  SELECT count(*) INTO n_charged
  FROM public.stella_interactions si
  WHERE si.idempotency_key IS NOT NULL;
  RAISE NOTICE 'stella_0017 rollback: % identified charge(s) remain in public.stella_interactions and are left exactly as found. Nothing here removes a consumption.', n_charged;

  -- ------------------------------------------------------------------
  -- 3. The sibling completion verb: revoked, then dropped.
  --
  --    UNCONDITIONAL, and that is INT-CAP-004 (1)'s lesson: a DROP nested inside
  --    a test for something else is a DROP that silently does not happen. The
  --    REVOKE is stated even though the DROP would take the ACL with it — a
  --    reader auditing "what privileges did this withdraw" must find the answer
  --    by reading, not by inferring it from a cascade.
  --
  --    Fixed literals through EXECUTE: no ||, no format(), no variable.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb) FROM uellix_app';
  END IF;
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)';
END $$;

-- ============================================================
-- 4. The five-argument conversion, restored to stella_0016's own body
-- ============================================================
-- OUTSIDE the DO block, and deliberately: `CREATE OR REPLACE FUNCTION` with a
-- dollar-quoted body cannot be nested inside another dollar-quoted body without
-- a second quoting level, and a rollback whose most delicate statement is the
-- one hardest to read is a rollback nobody audits. §5 asserts the result.
--
-- This is stella_0016 §5 verbatim — the self-contained conversion, not the
-- delegator stella_0017 replaced it with. It has to be restored BEFORE the
-- ten-argument function it currently delegates to is dropped, and both happen in
-- this one transaction, so there is no moment at which a caller can reach a
-- delegator whose target is gone.
CREATE OR REPLACE FUNCTION uellix_stella.settle_reserved_quota(
  p_organization_id uuid,
  p_project_id uuid,
  p_stella_role varchar(50),
  p_idempotency_key char(64),
  p_ticket_id char(64)
)
RETURNS TABLE (
  outcome text,
  used integer,
  quota integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_governed text[] := ARRAY['advisor', 'validator', 'composer', 'proxy_reviewer',
                             'evidence_reviewer', 'audit_assistant', 'grounded_query'];
  v_actor    uuid;
  v_org      uuid;
  v_project  uuid;
  v_category varchar(50);
  v_status   text;
  v_expires  timestamp;
  v_now      timestamp;
  v_cap      record;
  v_existing uuid;
  v_inserted integer;
BEGIN
  IF p_organization_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION 'stella settle: organization and project are required' USING ERRCODE = 'U0100';
  END IF;
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella settle: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella settle: the idempotency key must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;
  IF p_stella_role IS NULL OR NOT (p_stella_role = ANY(v_governed)) THEN
    RAISE EXCEPTION 'stella settle: that capability is not in the governed vocabulary' USING ERRCODE = 'U0106';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';
  END IF;

  SELECT t.organization_id, t.project_id, t.category, t.status, t.expires_at
    INTO v_org, v_project, v_category, v_status, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id;

  IF NOT FOUND
     OR v_org      IS DISTINCT FROM p_organization_id
     OR v_project  IS DISTINCT FROM p_project_id
     OR v_category IS DISTINCT FROM p_stella_role
     OR v_status   IS DISTINCT FROM 'bound' THEN
    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());
  IF v_expires <= v_now THEN
    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stella/quota/' || p_organization_id::text, 0));

  SELECT si.id INTO v_existing
  FROM public.stella_interactions si
  WHERE si.organization_id = p_organization_id
    AND si.idempotency_key = p_idempotency_key;

  SELECT c.limit_units, c.consumed INTO v_cap
  FROM uellix_stella.stella_capacity(p_organization_id, p_ticket_id) c;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;
    RETURN;
  END IF;

  INSERT INTO public.stella_interactions (
    organization_id, project_id, created_by, stella_role, pipeline_step,
    context_hash, response_json, model_used, idempotency_key
  )
  VALUES (
    p_organization_id,
    p_project_id,
    v_actor,
    p_stella_role,
    p_stella_role,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'stella/quota/v1' || chr(10) || p_organization_id::text || chr(10)
          || p_stella_role || chr(10) || p_idempotency_key,
        'UTF8')),
      'hex'),
    '{"kind":"quota_consumption","version":1}'::jsonb,
    'not-applicable',
    p_idempotency_key
  )
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'consumed'::text, v_cap.consumed + 1, v_cap.limit_units;
END;
$$;

-- Owner and ACL restated. CREATE OR REPLACE preserves both, so these are
-- convergence statements rather than changes — and they are stated because a
-- rollback that assumed them would stop being true the day somebody replaces
-- this function from somewhere else.
ALTER FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))
  OWNER TO uellix_cap_stella_quota;
REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))
  TO uellix_cap_stella_ticket;

COMMENT ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) IS
  'R1 (prepared stella_0016): converts a LIVE reservation into a charge. Evaluates NO limit, because the unit was committed at bind and has been counted against the cap ever since. Re-proves the ticket is bound, unexpired and welded to the organization, project and category it is asked to charge; raises U0111 otherwise. Granted to uellix_cap_stella_ticket ONLY — never to uellix_app, never to PUBLIC.';

-- ============================================================
-- 5. The ten-argument conversion, and the postconditions
-- ============================================================
DO $$
DECLARE
  problem text;
  def     text;
  n       int;
BEGIN
  IF to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb) FROM uellix_cap_stella_ticket';
  END IF;
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)';

  -- ------------------------------------------------------------------
  -- Postconditions. Asserted rather than assumed: this is the last moment at
  -- which the transaction can still roll back.
  -- ------------------------------------------------------------------

  -- (1) Both objects this package published are gone.
  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL
     OR to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: a payload-carrying function is still installed and still callable — aborting so the transaction rolls back.';
  END IF;

  -- (2) THE ONE THING THIS ROLLBACK MUST NEVER DO. Stated as a machine
  --     assertion so that a future edit which "restores the previous behaviour"
  --     fires it and rolls the whole thing back.
  SELECT string_agg(x.rolname, ', ' ORDER BY x.rolname) INTO problem
  FROM (
    SELECT DISTINCT r.rolname
    FROM pg_roles r
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
    WHERE NOT r.rolsuper
      AND r.rolname <> 'uellix_owner'
      AND r.rolname <> 'uellix_cap_stella_quota'
      AND r.rolname NOT LIKE 'pg\_%'
      AND has_table_privilege(r.oid, to_regclass('public.stella_interactions'), p.priv)
  ) x;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: role(s) % can write public.stella_interactions directly. Rolling back the generalisation must not reopen the ungoverned write — that is the measured oversell, not a feature this package replaced — aborting so the transaction rolls back.', problem;
  END IF;

  -- (3) ...and the CHECK that survives a re-grant is still standing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.stella_interactions')
      AND c.conname = 'stella_interactions_governed_identity_check'
      AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: stella_interactions_governed_identity_check is gone. A row with no governed operation identity would be creatable again by the table owner — aborting so the transaction rolls back.';
  END IF;

  -- (4) The five-argument conversion is back, self-contained, and reachable by
  --     the ticket definer and by nobody else.
  IF to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: the five-argument settle_reserved_quota is absent, so the grounded complete cannot convert its reservation — aborting so the transaction rolls back.';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)')) INTO def;
  IF position('INSERT INTO public.stella_interactions' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: the restored five-argument settle_reserved_quota is still a delegator, and the function it delegates to has just been dropped — aborting so the transaction rolls back.';
  END IF;
  IF position('uellix_stella.stella_capacity' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: the restored conversion does not ask the canonical capacity arithmetic — aborting so the transaction rolls back.';
  END IF;
  IF NOT has_function_privilege('uellix_cap_stella_ticket',
        'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: uellix_cap_stella_ticket cannot execute the restored conversion — aborting so the transaction rolls back.';
  END IF;
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO problem
  FROM pg_roles r
  WHERE r.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role',
                      'uellix_writer', 'uellix_reader', 'uellix_auditor')
    AND has_function_privilege(r.oid, to_regprocedure(
          'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)'), 'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: % can execute the restored conversion, which files a unit without evaluating the limit — aborting so the transaction rolls back.', problem;
  END IF;

  -- (5) stella_0016's state is exactly what this script found. `uellix_stella_ops`
  --     back to SIX functions is the number stella_0015 §4 (5) and stella_0016
  --     §7 (2b) both assert, so this rollback is also what makes those two
  --     packages re-appliable again.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops';
  IF n <> 6 THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: uellix_stella_ops holds % function(s) instead of 6 — aborting so the transaction rolls back.', n;
  END IF;

  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NULL
     OR to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NULL
     OR to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NULL
     OR to_regprocedure('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)') IS NULL
     OR to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: an object of stella_0013, stella_0015 or stella_0016 is gone. This rollback must remove only what stella_0017 added — aborting so the transaction rolls back.';
  END IF;

  -- (6) ...and no project-blind signature reappeared. Republishing a body is
  --     exactly the operation that can mint an old signature back.
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella_ops.bind_operation_ticket(character, character)'),
    ('uellix_stella_ops.complete_operation_ticket(character, character)'),
    ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
    ('uellix_stella_ops.inspect_operation_ticket(character)')
  ) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NOT NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: signature(s) % take no execution project — aborting so the transaction rolls back.', problem;
  END IF;

  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 rollback FAILED: public.stella_interactions no longer exists. This rollback must never touch the compliance trail — aborting so the transaction rolls back.';
  END IF;

  RAISE NOTICE 'stella_0017 rollback: complete. The sibling completion verb and the payload-carrying conversion are gone, the five-argument conversion is back to stella_0016''s self-contained body, uellix_stella_ops is at 6 functions again, and every charge is untouched. The REVOKE and the governed-identity CHECK STAY: no runtime principal can write public.stella_interactions and no row can be filed without a server-minted operation identity. Sibling categories can still be issued, bound, aborted and inspected; they can no longer be completed, and they can no longer be charged around the protocol either.';
END $$;
