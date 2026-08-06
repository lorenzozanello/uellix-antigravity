-- db/prepared/stella_0018_rollback.sql
-- Reverts db/prepared/stella_0018_category_bound_operation_tickets.sql and
-- returns the database to the state stella_0017 leaves it in.
--
-- WHAT "REVERT" MEANS HERE, SAID OUT LOUD. This restores R6a and R6b. After it
-- runs, a ticket issued for one capability can be bound and charged by another
-- (the ledger row is internally inconsistent and append-only), and `uellix_app`
-- can charge a unit through `consume_stella_capacity` with no ticket and an
-- identity of its own choosing. It exists because a package that cannot be
-- withdrawn is a package nobody can safely apply — not because withdrawing it
-- is safe.
--
-- ORDER. The three-argument body is restored to its self-contained stella_0016
-- form BEFORE the four-argument signature is dropped: the delegator calls it,
-- and dropping a function another function's body references would leave a
-- signature whose first invocation fails at runtime rather than here.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions
-- ============================================================
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0018_rollback aborted: must run as a SUPERUSER (current_user=%).', current_user;
  END IF;

  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0018_rollback aborted: the three-argument bind signature is missing — this database is not at the state stella_0018 leaves.';
  END IF;
END
$$;

-- ============================================================
-- 1. The three-argument bind, self-contained again (stella_0016 §6a)
-- ============================================================
CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(
  p_ticket_id char(64),
  p_expected_project_id uuid,
  p_query_hash char(64)
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
  v_actor    uuid;
  v_org      uuid;
  v_project  uuid;
  v_status   text;
  v_hash     char(64);
  v_expires  timestamp;
  v_now      timestamp;
  v_cap      record;
BEGIN
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;
  IF p_expected_project_id IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the execution project is required' USING ERRCODE = 'U0100';
  END IF;
  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the query digest must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT t.organization_id, t.project_id, t.status, t.query_hash, t.expires_at
    INTO v_org, v_project, v_status, v_hash, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());
  IF v_expires <= v_now THEN
    RAISE EXCEPTION 'stella ticket: the ticket is no longer live' USING ERRCODE = 'U0108';
  END IF;

  IF v_hash IS NOT NULL AND v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

  IF v_status IN ('aborted', 'expired') THEN
    RAISE EXCEPTION 'stella ticket: the ticket is already settled' USING ERRCODE = 'U0109';
  END IF;

  IF v_status IN ('bound', 'completed') THEN
    RETURN QUERY SELECT v_status, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stella/quota/' || v_org::text, 0));

  SELECT c.limit_units, c.consumed, c.reserved, c.available INTO v_cap
  FROM uellix_stella.stella_capacity(v_org, p_ticket_id) c;

  IF v_cap.limit_units IS NOT NULL THEN
    IF v_cap.limit_units = 0 THEN
      RETURN QUERY SELECT 'no_quota'::text, v_cap.consumed, v_cap.limit_units;
      RETURN;
    END IF;
    IF v_cap.available <= 0 THEN
      RETURN QUERY SELECT 'quota_exceeded'::text, v_cap.consumed, v_cap.limit_units;
      RETURN;
    END IF;
  END IF;

  UPDATE uellix_stella_ops.operation_tickets t
  SET status = 'bound', query_hash = p_query_hash, bound_at = v_now
  WHERE t.ticket_id = p_ticket_id;

  RETURN QUERY SELECT 'bound'::text, v_cap.consumed, v_cap.limit_units;
END;
$$;

ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))
  OWNER TO uellix_cap_stella_ticket;
REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) TO uellix_app;

COMMENT ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) IS
  'stella_0016 §6a: reserves one unit under the per-organization advisory lock, counting charged rows AND live reservations.';

-- ============================================================
-- 2. The category-bound signature goes
-- ============================================================
DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50));

-- ============================================================
-- 3. The ticketless consumption surface returns to the runtime (R6b reopens)
-- ============================================================
GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64))
  TO uellix_app;
-- BOTH grants, or the revert is not one. `stella_0016` §7 (3) asserts uellix_app
-- can reach the capacity surface and `stella_0013` §7 grants the charge itself;
-- a rollback that restored only the first would leave a database on which
-- stella_0013 and stella_0016 abort — the operator who rolled back to re-apply
-- the chain could not.
GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64))
  TO uellix_app;

COMMENT ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64)) IS
  'stella_0016 §4: the surface a TICKETLESS consumer uses — takes the per-organization advisory lock, refuses when Available <= 0, charges.';
COMMENT ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) IS
  'stella_0013 §5: checks and charges one unit under the per-organization advisory lock, counting charged rows only.';

-- ============================================================
-- 4. Self-verification
-- ============================================================
DO $$
DECLARE
  def text;
  n   integer;
BEGIN
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: the category-bound bind signature survives';
  END IF;

  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops';
  IF n <> 7 THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: uellix_stella_ops holds % functions, expected 7 (the state stella_0017 leaves)', n;
  END IF;

  -- The restored body is the SELF-CONTAINED one, not a delegator pointing at a
  -- function that no longer exists.
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella_ops.bind_operation_ticket(character, uuid, character)')) INTO def;
  IF position('pg_advisory_xact_lock' in def) = 0
     OR position('uellix_stella.stella_capacity' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: the three-argument bind was not restored to its stella_0016 body';
  END IF;
  IF position('U0112' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: the restored body still carries the category refusal';
  END IF;
  -- The restored body BINDS. stella_0018 §2 left this signature raising U0106
  -- unconditionally; a rollback that only dropped the four-argument function
  -- would leave a refusal where stella_0017 expects a working verb.
  IF position('U0106' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: the three-argument bind still refuses unconditionally — the restore replaced a signature but not a behaviour';
  END IF;

  IF NOT has_function_privilege('uellix_app', to_regprocedure(
       'uellix_stella_ops.bind_operation_ticket(character, uuid, character)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: uellix_app cannot bind, so the runtime is broken rather than reverted';
  END IF;
  IF NOT has_function_privilege('uellix_app', to_regprocedure(
       'uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: uellix_app cannot reach the capacity surface, so stella_0016 §7 (3) would abort on its next apply';
  END IF;
  IF NOT has_function_privilege('uellix_app', to_regprocedure(
       'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: uellix_app cannot reach the charge itself, so the pre-ticket surface stella_0013 §7 publishes is not restored';
  END IF;

  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname IN ('uellix_stella', 'uellix_stella_ops') AND a.grantee = 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0018_rollback FAILED: PUBLIC holds EXECUTE on % function(s)', n;
  END IF;
END
$$;
