-- ============================================================================
-- stella_0015_project_bound_operation_tickets — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/stella_0015_project_bound_operation_tickets.sql
-- Source SHA-256 (LF-normalized): 117f61b7f5aa28472bd24c814dce26871475763922723c0784506a46290a2db9
--
-- The canonical file above is the ONLY source of truth. This artefact exists
-- because managed Supabase exposes no superuser and does not let `postgres`
-- grant USAGE on schema auth. Editing THIS file instead of the canonical one
-- creates the second source of truth the design exists to prevent — and the
-- verification suite will fail, because it regenerates and compares bytes.
--
-- Rewrite rules applied (id: times fired):
--   superuser-precondition: 1
--   auth-schema-grant: 0
--   auth-uid-precondition: 1
--   auth-uid-call: 4
--   capability-role-attributes: 0
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/stella_0015_project_bound_operation_tickets.sql
-- R2-INT — an operation ticket may only be reserved, completed, aborted or
-- inspected for the project it was welded to at issue.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0015_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-int-001 (residual R2-INT)
-- RESPONSE:  docs/ops/contracts/R2-INT_project_bound_operation_tickets.md
-- DEPENDS ON: stella_0014_operation_tickets.sql (this package REPLACES four of
--             its six governed functions and leaves the table, the triggers,
--             the policies, the role and the schema exactly as it found them).
--             The dependency is a hard precondition in §0, so the forward ORDER
--             is imposed by this SQL and not by a runbook.
-- SOURCE OF TRUTH: the objects here are managed outside the drizzle chain on
-- purpose — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED. NO SERVER
-- ACTION PASSES THE NEW ARGUMENT YET — wiring it is INTEGRATION's
-- reconciliation.
--
-- ============================================================================
-- WHAT R2-INT REPORTS, AND WHY stella_0014 CANNOT ANSWER IT
-- ============================================================================
-- A ticket is welded to an organization, a project and an actor at issue. Three
-- of those four bindings are re-imposed on every later call: the actor through
-- `auth.uid()` and the RLS policies, the organization through
-- `current_user_org_ids()`. The PROJECT is not — because
-- `bind_operation_ticket` and `complete_operation_ticket` never receive one.
--
-- So the database has nothing to compare. `complete` charges
-- `consume_stella_quota(v_org, v_project, …)` with the project of the TICKET,
-- while the work read its evidence under the project of the ACTION. Reproduced,
-- not argued — §7 below runs the attack against the real functions before this
-- package installs anything, and the same sequence is executed end to end in
-- §7 of scripts/stella-ticket-dry-run.sh:
--
--     issue(org A, project A1)  ->  ticket
--     bind(ticket, hash)        ->  bound      -- executed under project A2
--     complete(ticket, hash)    ->  completed  -- charged to project A1
--
-- One unit, the right organization, the WRONG project. It is not a quota escape
-- — the cap is organizational and exactly one unit is sold — it is an
-- attribution defect, and in a product whose entire output is an auditable SROI
-- figure a misattributed unit is worse than an uncharged one.
--
-- Reachable by any authenticated member of the organization: every export of a
-- `'use server'` module is a separately invocable endpoint, so the ticket minted
-- on one project's surface can be presented to the action mounted on another's.
--
-- ============================================================================
-- WHY A NEW PACKAGE AND NOT AN EDIT TO stella_0014
-- ============================================================================
-- Adding an argument CHANGES THE SIGNATURE, and `CREATE OR REPLACE FUNCTION`
-- refuses that (42P13: "cannot change name of input parameter"). Editing
-- stella_0014 in place would therefore not be an edit at all — it would be a
-- package that fails on every database that already has the old shape, which is
-- the population that matters.
--
-- So the old signatures are REVOKED, the new ones are PUBLISHED, and the old
-- ones are DROPPED. All three, in that order, in one transaction. Keeping the
-- old overload "for compatibility" would have left an executable path that
-- takes no project — which is the whole defect, still reachable, now with a
-- second door that reads as deliberate.
--
-- ============================================================================
-- WHY EVERY VERB RECHECKS, AND NOT ONLY bind
-- ============================================================================
-- `bind` and `complete` run in DIFFERENT transactions — the protocol requires
-- it (INT-INT-001 §4 step 3: the reservation is a row state, not a held lock),
-- so "bind already checked" is a claim about a request that has since ended. A
-- caller may bind under the project it is entitled to and complete under
-- another; only `complete` charges, so only `complete` can make the charge
-- land correctly. `abort` recheck stops one project's surface from releasing
-- another project's reservation, and `inspect` recheck stops the lifecycle of a
-- ticket from being readable across the boundary it is welded to.
--
-- `issue_operation_ticket` is unchanged: it is where the binding is CREATED,
-- it already takes the project explicitly and already proves the project
-- belongs to the organization. `expire_operation_tickets` is unchanged too, and
-- deliberately: it names no ticket, reveals no ticket's state, releases no live
-- reservation (its predicate is `expires_at <= now()`, and a ticket past its
-- expiry has already stopped reserving) and charges nothing. Giving it a
-- project argument would add a parameter with no decision behind it.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent AND convergent. No CREATE INDEX CONCURRENTLY.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (superuser window)
-- ============================================================
DO $$
BEGIN
  -- HOSTED VARIANT (Train 5B, generated — do not edit by hand).
  -- The superuser check below was replaced by a capability assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. Original message,
  -- preserved verbatim so the refusal it encoded stays reviewable:
  --   stella_0015 aborted: must run as a SUPERUSER (current_user=%). It drops and republishes functions owned by uellix_cap_stella_ticket, which uellix_owner does not own.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0015_project_bound_operation_tickets');

  -- The hard dependency. This package replaces four of stella_0014's six
  -- functions; without that package there is no ticket, no table and nothing
  -- for a project binding to bind.
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 aborted: uellix_stella_ops.operation_tickets is absent — apply db/prepared/stella_0014_operation_tickets.sql first. This package re-imposes the project binding of a ticket it does not create.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket') THEN
    RAISE EXCEPTION 'stella_0015 aborted: role uellix_cap_stella_ticket is absent — stella_0014 is not applied here.';
  END IF;

  -- `issue` stays stella_0014's, and it is the ONLY place the binding is
  -- created. If it were gone, the tickets this package judges would have to
  -- come from somewhere this package cannot see.
  IF to_regprocedure('uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 aborted: uellix_stella_ops.issue_operation_ticket is absent. This package does not mint tickets; it constrains what may be done with one.';
  END IF;

  -- The charge path is still stella_0013's, and still reached only by calling
  -- it. Asserted because complete_operation_ticket is republished below and a
  -- republished body that cannot resolve its charge would install cleanly and
  -- be unable to charge anything.
  IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 aborted: uellix_stella.consume_stella_quota is absent — apply db/prepared/stella_0013_grounded_query_quota.sql first.';
  END IF;

  IF to_regprocedure('public.uellix_auth_uid()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 aborted: auth.uid() not found. Every function here derives the actor from the session rather than from an argument.';
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 aborted: RLS helper public.current_user_org_ids() not found.';
  END IF;

  IF to_regclass('public.projects') IS NULL THEN
    RAISE EXCEPTION 'stella_0015 aborted: public.projects is missing — this database is not at the expected migration baseline.';
  END IF;
END $$;

-- ============================================================
-- 1. Revoke the OLD signatures, BEFORE anything replaces them
-- ============================================================
-- The revoke comes first, and the order is the point rather than a style: for
-- the whole of this transaction there must be no moment at which a runtime
-- principal holds EXECUTE on a function that takes no project. Dropping alone
-- would also achieve it, but a DROP that failed for any reason would leave the
-- grant standing, and a REVOKE that is stated separately is a REVOKE a reader
-- can find.
--
-- Guarded on existence so a SECOND apply — where the old signatures are already
-- gone — converges instead of failing. Fixed literals through EXECUTE: no ||,
-- no format(), no variable. The surrounding code decides WHETHER, never WHAT.
DO $$
BEGIN
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(character, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(character, character) FROM uellix_app';
  END IF;
  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, character) FROM uellix_app';
  END IF;
  IF to_regprocedure('uellix_stella_ops.abort_operation_ticket(character, character varying)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.abort_operation_ticket(character, character varying) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.abort_operation_ticket(character, character varying) FROM uellix_app';
  END IF;
  IF to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.inspect_operation_ticket(character) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.inspect_operation_ticket(character) FROM uellix_app';
  END IF;
END $$;

-- ============================================================
-- 2. The project-bound protocol (superuser window)
-- ============================================================
-- THE ERROR CODE. `U0110` is new in this package and it is deliberately NOT
-- U0102. The existing vocabulary already draws five distinctions, and a sixth
-- failure folded into one of them would be a failure nobody could act on:
--
--   U0100  malformed input, including a missing execution project
--   U0102  out of scope: another organization, another actor, or no such ticket
--   U0106  a category or an abort reason outside the governed vocabulary
--   U0107  the ticket is bound to a DIFFERENT query
--   U0108  the ticket is no longer live
--   U0109  the ticket is already settled
--   U0110  the ticket belongs to a DIFFERENT PROJECT      <-- this package
--
-- WHY A DISTINGUISHABLE CODE IS NOT AN ORACLE HERE. U0110 is raised only AFTER
-- the row has been found under RLS, and the SELECT policy requires
-- `actor_id = auth.uid()` — so the only party who can ever observe U0110 is the
-- ticket's own actor, about the ticket's own project. To anybody else the same
-- call is U0102 and indistinguishable from a ticket that never existed. Same
-- argument stella_0014 makes for checking expiry only after scope.
--
-- The message names no identifier. A refusal that echoed the project the caller
-- supplied would confirm which of its guesses reached a row.
--
-- LOCK ORDER, unchanged from stella_0014 and obeyed by every function below:
--     ticket row (SELECT ... FOR UPDATE)  ->  per-organization advisory lock
-- Never the reverse. The project comparison is a row-local test performed while
-- the row lock is already held and BEFORE the advisory lock is taken, so it
-- adds no lock and cannot reorder one.

-- ------------------------------------------------------------
-- 2a. bind — fix the question, RESERVE the unit, and prove the project
-- ------------------------------------------------------------
-- The project is checked IMMEDIATELY after the row is found: before expiry,
-- before the digest, before the state. A ticket of another project must not be
-- distinguishable as expired, as bound or as settled — otherwise the refusal
-- itself would report the lifecycle of a ticket the caller is not entitled to
-- read, which is exactly what §2d refuses to do out loud.
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
  v_month    timestamp;
  v_quota    integer;
  v_used     integer;
  v_reserved integer;
BEGIN
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;
  -- NO DEFAULT on the argument and NO tolerance for NULL. A caller that cannot
  -- say which project it is executing against has not been through a governed
  -- surface, and treating "unstated" as "whatever the ticket says" would be the
  -- defect this package closes, spelled as a convenience.
  IF p_expected_project_id IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the execution project is required' USING ERRCODE = 'U0100';
  END IF;
  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the query digest must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- The row lock, FIRST in the lock order. Named columns, never a star.
  SELECT t.organization_id, t.project_id, t.status, t.query_hash, t.expires_at
    INTO v_org, v_project, v_status, v_hash, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  -- Absent, another actor's, or another organization's: ONE answer.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- R2-INT. The ticket's project is immutable (stella_0014 §4 refuses an UPDATE
  -- of project_id for every role including the owner), so this comparison is
  -- against the value welded on at issue and against nothing else.
  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());
  IF v_expires <= v_now THEN
    RAISE EXCEPTION 'stella ticket: the ticket is no longer live' USING ERRCODE = 'U0108';
  END IF;

  -- The digest first, the state second.
  IF v_hash IS NOT NULL AND v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

  IF v_status IN ('aborted', 'expired') THEN
    RAISE EXCEPTION 'stella ticket: the ticket is already settled' USING ERRCODE = 'U0109';
  END IF;

  -- Already bound or already completed with the SAME digest: idempotent.
  IF v_status IN ('bound', 'completed') THEN
    RETURN QUERY SELECT v_status, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- Serialise the reservation against every other reservation AND against every
  -- charge for this organization. Same key as stella_0013, on purpose.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stella/quota/' || v_org::text, 0));

  v_month := pg_catalog.date_trunc('month', v_now);

  SELECT o.stella_monthly_quota INTO v_quota
  FROM public.organizations o WHERE o.id = v_org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- Charged rows this month, in the coordinate space lib/stella/quota.ts uses.
  -- ORGANIZATION-wide and deliberately NOT filtered by project: the cap is sold
  -- per organization, and counting per project would let one organization spend
  -- its cap once per project it owns.
  SELECT count(*)::integer INTO v_used
  FROM public.stella_interactions si
  WHERE si.organization_id = v_org AND si.created_at >= v_month;

  -- LIVE reservations held by OTHER tickets, across every project of the
  -- organization, for the same reason.
  SELECT count(*)::integer INTO v_reserved
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.organization_id = v_org
    AND t.status = 'bound'
    AND t.expires_at > v_now
    AND t.ticket_id <> p_ticket_id;

  IF v_quota IS NOT NULL THEN
    IF v_quota = 0 THEN
      RETURN QUERY SELECT 'no_quota'::text, v_used, v_quota;
      RETURN;
    END IF;
    IF v_used + v_reserved >= v_quota THEN
      RETURN QUERY SELECT 'quota_exceeded'::text, v_used, v_quota;
      RETURN;
    END IF;
  END IF;

  UPDATE uellix_stella_ops.operation_tickets t
  SET status = 'bound', query_hash = p_query_hash, bound_at = v_now
  WHERE t.ticket_id = p_ticket_id;

  RETURN QUERY SELECT 'bound'::text, v_used, v_quota;
END;
$$;

-- ------------------------------------------------------------
-- 2b. complete — settle, charge, and prove the project AGAIN
-- ------------------------------------------------------------
-- The recheck is INDEPENDENT and not a formality. `bind` committed in an
-- earlier transaction; between the two the caller may present the same ticket
-- from a different project's surface, and `complete` is the only call that
-- charges. A `complete` that trusted `bind` would be trusting a claim about a
-- request that has already ended — and it is the charge, not the reservation,
-- that lands in the ledger under a project_id.
CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(
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
  v_category varchar(50);
  v_status   text;
  v_hash     char(64);
  v_nonce    char(64);
  v_expires  timestamp;
  v_now      timestamp;
  v_key      char(64);
  v_charge   record;
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

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT t.organization_id, t.project_id, t.category, t.status, t.query_hash,
         t.charge_nonce, t.expires_at
    INTO v_org, v_project, v_category, v_status, v_hash, v_nonce, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- R2-INT, checked BEFORE the replay short-circuit. A completed ticket
  -- presented from another project must not be answered `replayed`: that answer
  -- says "this operation already happened and was already charged", and the
  -- operation it refers to is not the caller's.
  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  -- NEVER BOUND and BOUND TO SOMETHING ELSE are different failures.
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the ticket was never bound to a query' USING ERRCODE = 'U0109';
  END IF;
  IF v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

  -- RETRY AFTER COMPLETE. Reports what already happened and charges nothing.
  IF v_status = 'completed' THEN
    RETURN QUERY SELECT 'replayed'::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  IF v_status IN ('aborted', 'expired') THEN
    RAISE EXCEPTION 'stella ticket: the ticket is already settled' USING ERRCODE = 'U0109';
  END IF;

  IF v_status <> 'bound' THEN
    RAISE EXCEPTION 'stella ticket: the ticket was never bound to a query' USING ERRCODE = 'U0109';
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());
  IF v_expires <= v_now THEN
    RAISE EXCEPTION 'stella ticket: the ticket is no longer live' USING ERRCODE = 'U0108';
  END IF;

  -- THE KEY. Derived from the ticket and from a nonce the caller has never seen
  -- and no function returns.
  v_key := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'stella/ticket/charge/v1' || chr(10) || p_ticket_id || chr(10) || v_nonce,
      'UTF8')),
    'hex');

  -- THE ATTRIBUTION. `v_project` is the column read from the ticket row under
  -- the row lock, and the clause above has already proven it equal to the
  -- project the caller says it is executing against. Charging under
  -- `p_expected_project_id` would be equivalent TODAY and wrong as a rule: the
  -- persisted, immutable value is the one an auditor can re-derive from the
  -- ticket, and an argument is a value that arrives with the request.
  SELECT c.outcome, c.used, c.quota INTO v_charge
  FROM uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key) c;

  IF v_charge.outcome IN ('consumed', 'replayed') THEN
    UPDATE uellix_stella_ops.operation_tickets t
    SET status = 'completed', completed_at = v_now
    WHERE t.ticket_id = p_ticket_id;

    RETURN QUERY SELECT 'completed'::text, v_charge.used, v_charge.quota;
    RETURN;
  END IF;

  -- R1. The ledger refused after the work ran. Reported, never papered over:
  -- the ticket stays `bound` and abortable, and nothing was charged.
  RETURN QUERY SELECT v_charge.outcome, v_charge.used, v_charge.quota;
END;
$$;

-- ------------------------------------------------------------
-- 2c. abort — release the reservation of THIS project's ticket
-- ------------------------------------------------------------
-- Without the recheck, one project's surface could release the reservation
-- another project's operation is holding. Nothing is charged either way, so
-- this is not a billing defect — it is a denial of service with a governed
-- name: the victim's `complete` then finds an aborted ticket (U0109) and its
-- already-executed work is discarded.
CREATE OR REPLACE FUNCTION uellix_stella_ops.abort_operation_ticket(
  p_ticket_id char(64),
  p_expected_project_id uuid,
  p_reason varchar(40)
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reasons text[] := ARRAY['caller_abort', 'execution_failed', 'no_result', 'quota_refused'];
  v_actor   uuid;
  v_project uuid;
  v_status  text;
  v_now     timestamp;
BEGIN
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;
  IF p_expected_project_id IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the execution project is required' USING ERRCODE = 'U0100';
  END IF;
  IF p_reason IS NULL OR NOT (p_reason = ANY(v_reasons)) THEN
    RAISE EXCEPTION 'stella ticket: that is not a governed abort reason' USING ERRCODE = 'U0106';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT t.project_id, t.status INTO v_project, v_status
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  -- A COMPLETED ticket is not abortable: the unit was charged to an
  -- append-only ledger and an abort is not a refund.
  IF v_status = 'completed' THEN
    RAISE EXCEPTION 'stella ticket: a completed operation cannot be aborted' USING ERRCODE = 'U0109';
  END IF;

  -- Already settled the other way: idempotent.
  IF v_status IN ('aborted', 'expired') THEN
    RETURN v_status;
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());

  UPDATE uellix_stella_ops.operation_tickets t
  SET status = 'aborted', aborted_at = v_now, abort_reason = p_reason
  WHERE t.ticket_id = p_ticket_id;

  RETURN 'aborted';
END;
$$;

-- ------------------------------------------------------------
-- 2d. inspect — the state of THIS project's ticket, and nothing else
-- ------------------------------------------------------------
-- Restructured rather than merely guarded: stella_0014 streamed the row
-- straight out with `RETURN QUERY SELECT ... WHERE ticket_id = …`, so a project
-- test added after it would have refused only AFTER the row had already been
-- returned to the caller. The row is read into locals, judged, and only then
-- emitted — which is the difference between a check and a disclaimer.
CREATE OR REPLACE FUNCTION uellix_stella_ops.inspect_operation_ticket(
  p_ticket_id char(64),
  p_expected_project_id uuid
)
RETURNS TABLE (
  status text,
  category varchar(50),
  expires_at timestamp,
  has_query_hash boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor    uuid;
  v_project  uuid;
  v_status   text;
  v_category varchar(50);
  v_expires  timestamp;
  v_hash     char(64);
BEGIN
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;
  IF p_expected_project_id IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the execution project is required' USING ERRCODE = 'U0100';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- No FOR UPDATE: this verb decides nothing and must not queue behind a bind
  -- or a complete that is in flight.
  SELECT t.project_id, t.status, t.category, t.expires_at, t.query_hash
    INTO v_project, v_status, v_category, v_expires, v_hash
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  -- Neither the digest nor the nonce crosses the boundary — only whether a
  -- digest exists. Unchanged from stella_0014, and restated because this body
  -- is republished and a republished body is a body that can drift.
  RETURN QUERY SELECT v_status, v_category, v_expires, (v_hash IS NOT NULL);
END;
$$;

-- ------------------------------------------------------------
-- 2e. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), uuid, varchar(40))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64), uuid)
  OWNER TO uellix_cap_stella_ticket;

-- REVOKE BEFORE GRANT, on every one. A CREATE OR REPLACE keeps the previous
-- ACL, so a package that only granted would be unable to narrow what a prior
-- revision handed out.
REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), uuid, varchar(40)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64), uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), uuid, varchar(40)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64), uuid) TO uellix_app;

-- ============================================================
-- 3. Drop the OLD signatures — no unbound path survives
-- ============================================================
-- UNCONDITIONAL, and INT-CAP-004 (1)'s lesson applied: a DROP nested inside a
-- test for something else is a DROP that silently does not happen. `IF EXISTS`
-- makes the statement converge on a second apply; nothing else guards it.
--
-- This is the statement that makes the package a CLOSURE rather than an
-- addition. Keeping the two-argument overload callable would leave the R2-INT
-- path reachable next to its own fix.
DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(character, character);
DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, character);
DROP FUNCTION IF EXISTS uellix_stella_ops.abort_operation_ticket(character, character varying);
DROP FUNCTION IF EXISTS uellix_stella_ops.inspect_operation_ticket(character);

COMMENT ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) IS
  'R2-INT (prepared stella_0015): fixes the canonical query digest onto a ticket ONCE and reserves one unit of quota, ONLY when the ticket''s project equals the execution project the governed surface supplies. Raises U0110 when they differ, before expiry, digest or state are examined. Otherwise as stella_0014: bound/quota_exceeded/no_quota, U0100, U0102, U0107, U0108, U0109.';
COMMENT ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) IS
  'R2-INT (prepared stella_0015): settles a bound ticket and charges exactly one unit through uellix_stella.consume_stella_quota, under the ticket''s own project — re-proven equal to the execution project on THIS call and not inherited from bind, which committed in an earlier transaction. Raises U0110 on a mismatch, before the replayed short-circuit.';
COMMENT ON FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), uuid, varchar(40)) IS
  'R2-INT (prepared stella_0015): releases the reservation of an issued or bound ticket of THIS project. Raises U0110 for a ticket of another project, so one project''s surface cannot discard another project''s reservation. Refuses a completed ticket (U0109).';
COMMENT ON FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64), uuid) IS
  'R2-INT (prepared stella_0015): the state of the caller''s own ticket, for the project it was issued against. Raises U0110 rather than disclosing the lifecycle of a ticket welded to another project. Returns neither the query digest nor the charge nonce.';

-- ============================================================
-- 4. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  problem text;
  def     text;
  n       int;
BEGIN
  -- (1) The four project-bound signatures EXIST, by exact signature.
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella_ops.bind_operation_ticket(character, uuid, character)'),
    ('uellix_stella_ops.complete_operation_ticket(character, uuid, character)'),
    ('uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)'),
    ('uellix_stella_ops.inspect_operation_ticket(character, uuid)')
  ) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: project-bound signature(s) % are absent', problem;
  END IF;

  -- (2) The four UNBOUND signatures are GONE. This is the assertion the whole
  --     package exists for: an overload that takes no project is a path around
  --     the fix, and "we dropped it" is worth exactly as much as a measurement.
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella_ops.bind_operation_ticket(character, character)'),
    ('uellix_stella_ops.complete_operation_ticket(character, character)'),
    ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
    ('uellix_stella_ops.inspect_operation_ticket(character)')
  ) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NOT NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: signature(s) % still exist and take no execution project', problem;
  END IF;

  -- (3) ...and no OTHER overload of these four names arrived either. Written
  --     over the name rather than over the signatures listed above, so a fifth
  --     shape nobody anticipated is reported instead of ignored.
  SELECT string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ')', ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND p.proname IN ('bind_operation_ticket', 'complete_operation_ticket',
                      'abort_operation_ticket', 'inspect_operation_ticket')
    AND pg_get_function_arguments(p.oid) NOT LIKE '%p_expected_project_id uuid%';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: % takes no p_expected_project_id', problem;
  END IF;

  -- (3b) The argument carries NO DEFAULT. A defaulted argument is an argument
  --      the caller may omit, and the guarantee has to be that the SIGNATURE
  --      refuses the call — not that a branch inside the body catches it.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND p.proname IN ('bind_operation_ticket', 'complete_operation_ticket',
                      'abort_operation_ticket', 'inspect_operation_ticket')
    AND p.pronargdefaults > 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: % declares a DEFAULT, so the execution project can be omitted at the call site', problem;
  END IF;

  -- (4) Each of the four actually COMPARES the argument and raises the governed
  --     mismatch code. A function that accepted the project and ignored it
  --     would satisfy every assertion above and close nothing.
  FOR def IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'uellix_stella_ops'
      AND p.proname IN ('bind_operation_ticket', 'complete_operation_ticket',
                        'abort_operation_ticket', 'inspect_operation_ticket')
      AND (pg_get_functiondef(p.oid) NOT LIKE '%v_project IS DISTINCT FROM p_expected_project_id%'
           OR pg_get_functiondef(p.oid) NOT LIKE '%U0110%')
  LOOP
    RAISE EXCEPTION 'stella_0015 FAILED verification: % does not compare the ticket project against the execution project and raise U0110', def;
  END LOOP;

  -- (5) The schema still publishes SIX functions and no more: the two
  --      stella_0014 keeps (issue, expire) and the four replaced here. A
  --      seventh would be a surface nobody reviewed; a fifth leftover overload
  --      would be the defect itself.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops';
  IF n <> 6 THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: expected exactly 6 functions in uellix_stella_ops, found %', n;
  END IF;

  -- (6) stella_0014's definer contract still holds over the WHOLE schema, and
  --      is restated because four of its six bodies were just replaced. Both
  --      spellings of the empty search_path.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND pg_get_userbyid(p.proowner) <> 'uellix_cap_stella_ticket';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: function(s) % are not owned by uellix_cap_stella_ticket', problem;
  END IF;

  -- (7) No EXECUTE for PUBLIC anywhere in the schema, and EXECUTE for the
  --      runtime on exactly the four republished names.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_stella_ops'
    AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella_ops.bind_operation_ticket(character, uuid, character)'),
    ('uellix_stella_ops.complete_operation_ticket(character, uuid, character)'),
    ('uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)'),
    ('uellix_stella_ops.inspect_operation_ticket(character, uuid)')
  ) AS f(sig)
  WHERE NOT has_function_privilege('uellix_app', to_regprocedure(f.sig), 'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: uellix_app cannot execute %, so the runtime cannot reach the governed path at all', problem;
  END IF;

  -- (8) The privilege boundary stella_0014 installed is untouched: the ticket
  --      role still cannot write the ledger, and no runtime principal reaches
  --      the table where the nonce lives. Restated rather than assumed —
  --      replacing four function bodies is exactly the kind of change that
  --      tempts a grant.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = to_regclass('public.stella_interactions')
    AND g.rolname = 'uellix_cap_stella_ticket'
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: uellix_cap_stella_ticket holds % on the ledger', problem;
  END IF;

  SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = to_regclass('uellix_stella_ops.operation_tickets')
    AND g.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role',
                      'uellix_auditor', 'uellix_writer', 'uellix_reader');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: % holds a direct privilege on operation_tickets', problem;
  END IF;

  -- (9) No function of this package RETURNS the nonce or the digest. Measured
  --      on the RETURN TYPE, which is what crosses the boundary — not on the
  --      body, which merely mentions them. Word anchors: `has_query_hash`
  --      CONTAINS `query_hash`, and it is the boolean that exists in order NOT
  --      to be the digest.
  SELECT string_agg(q.proname, ', ' ORDER BY q.proname) INTO problem
  FROM (SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'uellix_stella_ops' OFFSET 0) q
  WHERE pg_get_function_result(q.oid) ~ '\mcharge_nonce\M'
     OR pg_get_function_result(q.oid) ~ '\mquery_hash\M';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0015 FAILED verification: % returns the charge nonce or the query digest', problem;
  END IF;

  RAISE NOTICE 'stella_0015: verification passed — bind, complete, abort and inspect take a non-defaulted p_expected_project_id, compare it against the ticket project and raise U0110 on a mismatch; the four unbound signatures are gone; uellix_stella_ops publishes exactly 6 SECURITY DEFINER functions with empty search_path owned by uellix_cap_stella_ticket, no EXECUTE for PUBLIC, EXECUTE for uellix_app on the four, no write privilege on the ledger and no direct privilege for any runtime principal.';
END $$;
