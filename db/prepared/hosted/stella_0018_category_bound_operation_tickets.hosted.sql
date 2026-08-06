-- ============================================================================
-- stella_0018_category_bound_operation_tickets — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/stella_0018_category_bound_operation_tickets.sql
-- Source SHA-256 (LF-normalized): 6a4e12575fce8cdb081bd059017b26d0f3c041db5da4d9689f7e31c1c48ac922
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
--   auth-uid-precondition: 0
--   auth-uid-call: 1
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/stella_0018_category_bound_operation_tickets.sql
-- R6a and R6b — the two residuals Train 4.3's closeout MEASURED, closed in SQL.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0018_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-int-001 (R6a, R6b)
-- DEPENDS ON: stella_0013 → stella_0014 → stella_0015 → stella_0016 →
--             stella_0017. The dependency is a hard precondition in §0, so the
--             forward ORDER is imposed by this SQL and not by a runbook.
-- SOURCE OF TRUTH: docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- ADDITIVE. It edits no published package. It republishes ONE body in place
-- (`bind_operation_ticket(char(64), uuid, char(64))`, which becomes a
-- delegator), adds ONE signature, and withdraws TWO grants. Nothing is dropped.
--
-- ============================================================================
-- R6a — WHAT WAS MEASURED, NOT REASONED ABOUT
-- ============================================================================
-- Reproduced against the real functions with the chain 0013→0017 installed,
-- as `uellix_app`, with the session actor set to a member of the organization:
--
--     issue_operation_ticket(org, project, 'advisor')  -> t
--     bind_operation_ticket(t, project, <grounded digest>)   -> bound
--     complete_operation_ticket(t, project, <grounded digest>) -> completed
--     ------------------------------------------------------------------
--     stella_interactions: 1 row, stella_role = 'advisor',
--                                 pipeline_step = 'advisor'
--
-- The work that ran was a GROUNDED QUERY. The charge, the role and the step all
-- say `advisor`. Nothing in the append-only trail says which one executed, and
-- an append-only row cannot be corrected afterwards.
--
-- WHY THE EXISTING DEFENCES DO NOT REACH IT:
--
--   * `settle_reserved_quota` refuses (U0111) when the category it is ASKED to
--     charge differs from the ticket's. It is never asked for a different one:
--     `complete_operation_ticket` reads the category OFF THE TICKET ROW and
--     passes that. There is no mismatch to detect — the row is consistent with
--     itself and wrong about the world.
--
--   * `runGovernedStellaOperation` compares the ticket's category against the
--     surface's constant in Node, which closes the five sibling surfaces. The
--     GROUNDED action does not run that driver and performs no such comparison
--     (app/actions/stella/grounded-query.ts), so the direction measured above
--     has no check at all.
--
--   * `bind_operation_ticket` — the one verb every surface calls before any
--     work runs — takes no expected category and therefore cannot refuse one.
--
-- THE CLOSURE. The expected category becomes an ARGUMENT of `bind`, compared in
-- SQL against the value welded onto the ticket at issue, BEFORE the advisory
-- lock is taken and before any unit is reserved. A mismatch reserves nothing,
-- runs nothing and charges nothing: U0112, raised in the same position and for
-- the same reason U0110 is raised for the project. That makes the property
-- STRUCTURAL rather than layered — exactly the residual db/stella/
-- operation-tickets.ts records next to `category_mismatch`.
--
-- WHY AT `bind` AND NOT AT `complete`. `complete` runs AFTER the provider round
-- trip. A refusal there is a refusal for work that has already been done, which
-- is the R1 shape this campaign spent two packages removing. `bind` is the only
-- point at which refusing is free.
--
-- ============================================================================
-- R6b — THE TICKETLESS CONSUMPTION SURFACE
-- ============================================================================
-- Also measured, on the same database, as `uellix_app`:
--
--     consume_stella_capacity(org, project, 'composer', <64 hex of my choosing>)
--         -> consumed
--     stella_interactions: 1 row.  operation_tickets: 0 rows.
--
-- One unit charged. No ticket issued, no reservation taken, no bind, no abort
-- path, no expiry, and a CATEGORY AND AN IDEMPOTENCY KEY BOTH CHOSEN BY THE
-- CALLER. stella_0017 §1 states the invariant this contradicts:
--
--     "The identity is minted by issue_operation_ticket and derived at
--      completion from a nonce no function returns, so a caller cannot produce
--      one."
--
-- `stella_interactions_governed_identity_check` (`idempotency_key IS NOT NULL`,
-- NOT VALID) is satisfied by any 64 hex characters, so the CHECK does not carry
-- the claim on its own. What carried it was supposed to be the grant surface,
-- and the grant surface still names `uellix_app`.
--
-- stella_0016 §4 published that function as "the surface a TICKETLESS consumer
-- uses — the surface the five sibling actions must migrate to". They did not
-- migrate to it: Train 4.3 migrated them to the TICKET protocol, which is
-- strictly stronger. So the grant has no remaining caller — verified by search
-- across app/**, lib/**, scripts/** and db/** — and a grant with no caller and
-- a bypass in it is withdrawn rather than documented.
--
-- WHAT IS NOT DONE, AND WHY. The function is NOT dropped. It is the only place
-- the reserved-capacity arithmetic is expressed for a consumer that holds no
-- ticket, `stella_0016`'s rollback restores a database that expects it to
-- exist, and dropping a published function from a later package is the
-- destructive edit this line refuses. It keeps its owner
-- (`uellix_cap_stella_quota`) and therefore stays callable from inside another
-- SECURITY DEFINER owned by that role — encapsulated, not reachable.
--
-- ============================================================================
-- ORDER
-- ============================================================================
-- This package makes `uellix_stella_ops` hold EIGHT functions. `stella_0015`
-- §4 (5) and `stella_0016` §7 (2b) assert six; `stella_0017` §5 asserts seven.
-- None of the three may be re-applied over this package — all three would abort
-- on their own assertion, which is fail-closed, and all three are registered as
-- supersessions in `db/prepared-package-order.ts` so the operator gets a
-- refusal that names the reason instead of an assertion that names a number.
--
-- `stella_0016` §7 (3) additionally asserts that `uellix_app` CAN execute
-- `consume_stella_capacity`. §4 below withdraws exactly that grant, so the
-- assertion is now false by design — stated here so a future reader does not
-- read the abort as a regression.
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
  --   stella_0018 aborted: must run as a SUPERUSER (current_user=%). It withdraws grants issued by earlier packages and republishes SECURITY DEFINER bodies owned by a capability role.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0018_category_bound_operation_tickets');

  -- stella_0014 / stella_0015: the ticket table and the project-bound verbs.
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL THEN
    RAISE EXCEPTION 'stella_0018 aborted: uellix_stella_ops.operation_tickets is missing — apply stella_0014 and stella_0015 first.';
  END IF;
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0018 aborted: the project-bound bind verb is missing — apply stella_0015 first.';
  END IF;

  -- stella_0016: the reserved-capacity arithmetic this bind must keep calling.
  IF to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NULL
     OR to_regprocedure('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0018 aborted: the reserved-capacity surface is missing — apply stella_0016 first.';
  END IF;

  -- stella_0017: the governed-consumption closure. Asserted rather than assumed
  -- because R6a is only half a defect on a database whose ledger still has a
  -- direct writer: closing the attribution of a charge nobody has to make
  -- through a governed function would be closing a door in an open wall.
  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'stella_0018 aborted: stella_0017 is not installed. Apply the chain in order: stella_0013 -> stella_0014 -> stella_0015 -> stella_0016 -> stella_0017 -> stella_0018.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_quota') THEN
    RAISE EXCEPTION 'stella_0018 aborted: the capability roles are missing — this database is not at the expected baseline.';
  END IF;
END
$$;

-- ============================================================
-- 1. bind, with the expected category (superuser window)
-- ============================================================
-- The IMPLEMENTATION. Byte-for-byte stella_0016 §6a with ONE clause added and
-- nothing removed: the category comparison, placed immediately after the
-- project comparison and BEFORE the expiry check, the digest check, the status
-- short-circuit and the advisory lock.
--
-- THE POSITION IS THE PROPERTY. Above the status short-circuit, so a RE-bind of
-- an already-`bound` ticket by a different surface is refused too — a mismatch
-- that only the first delivery caught would be a mismatch a retry could launder.
-- Above the advisory lock, so a refusal never serialises an organization. Above
-- every capacity read, so a refused presentation reserves nothing.
--
-- NULL IS REFUSED, and the first draft of this package got that wrong. It
-- accepted NULL as "no expectation" and withdrew `uellix_app`'s EXECUTE on the
-- three-argument signature — which buys nothing, because
-- `bind(t, project, hash, NULL)` IS the unchecked bind and `uellix_app` can call
-- it. ADVERSARIAL REVIEW A named it: retiring a signature does not retire a
-- behaviour that the surviving signature still reaches. The argument is
-- MANDATORY, and §5 asserts the refusal is in the body rather than in a comment.
CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(
  p_ticket_id char(64),
  p_expected_project_id uuid,
  p_query_hash char(64),
  p_expected_category varchar(50)
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
  -- THE ARGUMENT IS MANDATORY. A caller that cannot name its own capability has
  -- not come through a governed surface, and answering it with "no expectation"
  -- would reproduce, through the four-argument signature, exactly the unchecked
  -- bind §3 withdraws.
  IF p_expected_category IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the expected capability is required' USING ERRCODE = 'U0100';
  END IF;
  -- A category OUTSIDE the governed vocabulary is refused as ungoverned (U0106)
  -- rather than as a mismatch, and the distinction is not cosmetic: a surface
  -- that names a capability this system does not have is a wiring defect, while
  -- a surface that names another surface's capability is an attack. They reach
  -- the operator's log as different facts.
  IF NOT (p_expected_category = ANY(v_governed)) THEN
    RAISE EXCEPTION 'stella ticket: that capability is not in the governed vocabulary' USING ERRCODE = 'U0106';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- The row lock, FIRST in the lock order. Named columns, never a star.
  SELECT t.organization_id, t.project_id, t.category, t.status, t.query_hash, t.expires_at
    INTO v_org, v_project, v_category, v_status, v_hash, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- R2-INT, unchanged and checked as soon as the row is found.
  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  -- R6a. The ticket's own category, welded at issue by
  -- `issue_operation_ticket` and refused an UPDATE by stella_0014 §4 for every
  -- role including the owner, against the constant of the surface presenting
  -- it. Nothing has been reserved at this point and nothing has run.
  IF v_category IS DISTINCT FROM p_expected_category THEN
    RAISE EXCEPTION 'stella ticket: the ticket was issued for a different capability' USING ERRCODE = 'U0112';
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

  -- Already bound or already completed with the SAME digest: idempotent. A
  -- retried bind is not a second reservation, and it must not re-run the
  -- capacity check — which could refuse a ticket that is already holding its
  -- unit and turn a harmless retry into a failure.
  IF v_status IN ('bound', 'completed') THEN
    RETURN QUERY SELECT v_status, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- Serialise the reservation against every other reservation AND against every
  -- charge for this organization. Same key as stella_0013, on purpose.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stella/quota/' || v_org::text, 0));

  -- THE CANONICAL ARITHMETIC. This ticket is excluded from its own reservation
  -- count — it is not `bound` yet, so it would not be counted anyway, and
  -- passing it makes the intent explicit rather than dependent on the state
  -- machine's current shape.
  SELECT c.limit_units, c.consumed, c.reserved, c.available INTO v_cap
  FROM uellix_stella.stella_capacity(v_org, p_ticket_id) c;

  IF v_cap.limit_units IS NOT NULL THEN
    IF v_cap.limit_units = 0 THEN
      RETURN QUERY SELECT 'no_quota'::text, v_cap.consumed, v_cap.limit_units;
      RETURN;
    END IF;
    IF v_cap.available <= 0 THEN
      -- REFUSED, and the ticket stays `issued`. Nothing was reserved, nothing
      -- was charged, and the operation has not run — which is the only point at
      -- which refusing is free.
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

-- ============================================================
-- 2. The three-argument signature, as a delegator
-- ============================================================
-- REPLACED IN PLACE — identical name, identical argument names, identical
-- types — so `CREATE OR REPLACE` accepts it, no signature is dropped and no
-- caller's compiled reference breaks. Same manoeuvre stella_0017 §3 performed
-- on the five-argument `settle_reserved_quota`, for the same reason: two
-- implementations of one arithmetic are one arithmetic plus a place for it to
-- drift.
--
-- It REFUSES rather than delegates, and that is the second half of the fix
-- ADVERSARIAL REVIEW A forced. A delegator passing NULL would be the unchecked
-- bind wearing the governed one's name; a signature that raises is a signature
-- and not a route, which is exactly what §3's REVOKE is trying to say and could
-- not say alone.
--
-- `U0106` and not `U0100`: the caller reached a verb that cannot name a
-- capability at all, which is an ungoverned surface rather than a malformed
-- argument.
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
BEGIN
  RAISE EXCEPTION 'stella ticket: this verb cannot name the expected capability; use the category-bound signature'
    USING ERRCODE = 'U0106';
END;
$$;

-- ============================================================
-- 3. Ownership and ACL for the two bind bodies
-- ============================================================
-- REVOKE BEFORE GRANT on the new signature: a fresh function's ACL is NULL,
-- which PostgreSQL reads as the owner's default — and `acldefault('f', …)`
-- includes EXECUTE for PUBLIC. A package that only GRANTed would leave the
-- whole cluster able to call it.
ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))
  OWNER TO uellix_cap_stella_ticket;

REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) FROM PUBLIC;

-- The route the runtime keeps: the one that takes an expected category.
GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50))
  TO uellix_app;

-- The route it loses: the one that cannot refuse a cross-category presentation.
-- Named explicitly rather than left to the REVOKE FROM PUBLIC above, because
-- `uellix_app` holds this one by an EXPLICIT grant from stella_0016 §7 and a
-- PUBLIC revoke does not touch it — the same class of no-op stella_0017 §1
-- records for the inherited INSERT.
REVOKE EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))
  FROM uellix_app;

COMMENT ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50)) IS
  'stella_0018 R6a: reserves one unit for a ticket whose category, project and scope are re-proved in SQL before anything is reserved. U0112 when the presenting surface is not the one the ticket was issued for.';
COMMENT ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) IS
  'stella_0018: the unchecked arity. RAISES U0106 unconditionally and is not executable by any runtime principal. Retained only so the signature survives and stella_0018_rollback is exact.';

-- ============================================================
-- 4. R6b — the ticketless consumption surface leaves the runtime
-- ============================================================
-- TWO FUNCTIONS, NOT ONE, and the second one is the one that mattered.
--
-- The first draft of this package withdrew only `consume_stella_capacity` —
-- stella_0016's wrapper, which has never had a caller. ADVERSARIAL REVIEW A
-- found that `uellix_stella.consume_stella_quota` is granted to `uellix_app` by
-- `stella_0013` §7 and that NO package in the 0014→0017 chain takes it back.
-- That function is the one the wrapper CALLS: it takes `p_stella_role` and
-- `p_idempotency_key` from its caller, files the ledger row itself, and — unlike
-- the wrapper — counts CHARGED ROWS ONLY, with no reservation term at all.
--
-- So the surface withdrawn below is not one bypass but two, and the second is
-- strictly worse than the first:
--
--     consume_stella_quota(org, project, 'composer', <64 hex of my choosing>)
--         -> one unit charged, no ticket, no reservation, and INVISIBLE to the
--            reservation a bound ticket is holding — which composes with a
--            conversion that evaluates no limit into the measured oversell
--            stella_0017 §0 records: Consumed = 2 against Limit = 1.
--
-- `scripts/stella-train4-dry-run.sh` asserted `uellix_app` COULD call it, as a
-- statement of the pre-ticket design. That assertion is inverted there in the
-- same change that publishes this package.
--
-- Both keep their owner (`uellix_cap_stella_quota`), so both stay reachable from
-- inside another SECURITY DEFINER owned by that role — which is how
-- `consume_stella_quota` is reached from `consume_stella_capacity`, and what
-- "encapsulated" means here. Neither is dropped: `stella_0013` is the package
-- that publishes `consume_stella_quota` and dropping it from here would be the
-- destructive edit this line refuses.
REVOKE ALL ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64)) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64))
  FROM uellix_app;

REVOKE ALL ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64))
  FROM uellix_app;

COMMENT ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64)) IS
  'stella_0016 §4, WITHDRAWN from the runtime by stella_0018 §4 (R6b): it charges a unit with a caller-chosen category and a caller-chosen idempotency key, with no ticket, no reservation and no abort path. Reachable only from a SECURITY DEFINER owned by uellix_cap_stella_quota.';
COMMENT ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) IS
  'stella_0013 §5, WITHDRAWN from the runtime by stella_0018 §4 (R6b): it charges a unit with a caller-chosen category and identity, counting CHARGED ROWS ONLY — so it cannot see a live reservation and composes with the conversion into an oversell. Reachable only from a SECURITY DEFINER owned by uellix_cap_stella_quota.';

-- ============================================================
-- 5. Self-verification (superuser window)
-- ============================================================
-- Every claim this package makes, asked of the CATALOG rather than of the file
-- that was just executed.
DO $$
DECLARE
  problem text;
  def     text;
  n       integer;
BEGIN
  -- (1) Both signatures exist, and the schema now holds exactly eight.
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NULL THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category-bound bind signature was not published';
  END IF;
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the three-argument bind signature was dropped. This package is additive; dropping it would break stella_0016_rollback';
  END IF;

  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops';
  IF n <> 8 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: uellix_stella_ops holds % functions, expected 8 (six from stella_0014/0015, the seventh from stella_0017, the eighth here)', n;
  END IF;

  -- (2) THE CHECK IS IN THE BODY, and it is above the lock. Asserted on the
  --     function definition, because a bind that accepted the argument and
  --     ignored it would satisfy every signature check above and be R6a with a
  --     wider signature. Both halves are asserted: that the comparison exists,
  --     and that it is positioned before anything is committed.
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)')) INTO def;
  IF position('U0112' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category-bound bind never raises U0112, so it cannot refuse a cross-category presentation';
  END IF;
  IF position('v_category IS DISTINCT FROM p_expected_category' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category-bound bind does not compare the ticket row''s category against the expected one';
  END IF;
  IF position('U0112' in def) > position('pg_advisory_xact_lock' in def) THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category refusal is raised AFTER the advisory lock is taken, so a cross-category presentation serialises the organization it is attacking';
  END IF;
  IF position('U0112' in def) > position('stella_capacity' in def) THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category refusal is raised AFTER the capacity read, so a refused presentation is answered with a business state instead of a scope refusal';
  END IF;
  -- Above the status short-circuit: a mismatch a re-bind could launder is a
  -- mismatch that survives one delivery.
  IF position('U0112' in def) > position('IF v_status IN (''bound'', ''completed'')' in def) THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category refusal is raised AFTER the idempotent re-bind short-circuit, so a second delivery of an already-bound ticket bypasses it';
  END IF;
  -- The reservation arithmetic stella_0016 installed is still the one this body
  -- calls. A category-bound bind that counted charged rows only would close R6a
  -- and reopen R1.
  IF position('uellix_stella.stella_capacity' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category-bound bind does not call stella_capacity, so it does not see live reservations (R1)';
  END IF;
  -- THE ARGUMENT IS MANDATORY. Without this, `bind(t, project, hash, NULL)` is
  -- the unchecked bind reached through the governed signature, and withdrawing
  -- the three-argument one buys nothing. Adversarial review A, and it was exact.
  IF position('p_expected_category IS NULL' in def) = 0
     OR position('U0100' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category-bound bind accepts a NULL expected capability, which reproduces the unchecked bind through the governed signature';
  END IF;
  IF position('IS NOT NULL AND v_category IS DISTINCT FROM' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the category comparison is guarded by a NULL check, so a NULL expectation skips it';
  END IF;

  -- (3) The three-argument body REFUSES. Not a delegator passing NULL — that
  --     would be the unchecked bind wearing the governed one''s name — and not a
  --     second implementation of the arithmetic either.
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella_ops.bind_operation_ticket(character, uuid, character)')) INTO def;
  IF position('U0106' in def) = 0
     OR position('pg_advisory_xact_lock' in def) > 0
     OR position('stella_capacity' in def) > 0
     OR position('operation_tickets' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: the three-argument bind does not refuse unconditionally — a signature that still binds is a route, whatever its grant says';
  END IF;

  -- (4) THE GRANT SURFACE. The unchecked bind and BOTH ticketless consumers are
  --     out of reach of every runtime principal. Driven from pg_roles rather
  --     than a VALUES list, because `has_function_privilege` RAISES on a role
  --     that does not exist and the planner may evaluate clauses in any order.
  --
  --     `authenticator` is in the list because stella_0017 §1 counted it a
  --     runtime principal when it revoked over the ledger, and an assertion that
  --     measured a narrower set than the train declared would report a closure
  --     over a principal nobody asked about.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO problem
  FROM pg_roles r
  WHERE r.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role',
                      'uellix_writer', 'uellix_reader', 'uellix_auditor', 'authenticator')
    AND has_function_privilege(r.oid, to_regprocedure(
          'uellix_stella_ops.bind_operation_ticket(character, uuid, character)'), 'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: % can execute the bind that takes no expected category — R6a is open through it', problem;
  END IF;

  -- BOTH consumers, and the second is the one that mattered.
  -- `consume_stella_capacity` never had a caller; `consume_stella_quota` is
  -- granted to uellix_app by stella_0013 §7, is what the wrapper CALLS, and
  -- counts charged rows only — so it is a ticketless charge that is also blind
  -- to live reservations. A verification that asked about only one of them would
  -- pass over a database with the worse bypass open.
  SELECT string_agg(r.rolname || ' -> ' || f.sig, ', ' ORDER BY r.rolname, f.sig) INTO problem
  FROM pg_roles r
  CROSS JOIN (VALUES
    ('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)'),
    ('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)')
  ) AS f(sig)
  WHERE r.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role',
                      'uellix_writer', 'uellix_reader', 'uellix_auditor', 'authenticator')
    AND has_function_privilege(r.oid, to_regprocedure(f.sig), 'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: % — a unit may still be charged with no ticket, no reservation and a caller-chosen identity (R6b)', problem;
  END IF;

  -- ...and the route the runtime MUST keep, or nothing can be bound at all.
  IF NOT has_function_privilege('uellix_app', to_regprocedure(
       'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: uellix_app cannot execute the category-bound bind, so no operation can reserve a unit';
  END IF;

  -- (5) PUBLIC holds nothing, anywhere in either schema — the invariant
  --     stella_0013 §7 and stella_0014 §7 both state, restated over what this
  --     package added.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname IN ('uellix_stella', 'uellix_stella_ops') AND a.grantee = 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: PUBLIC holds EXECUTE on % function(s) of the governed schemas', n;
  END IF;

  -- (6) The schema-wide contracts of stella_0013 and stella_0014 still hold
  --     over what this package published. Both spellings of the empty
  --     search_path, as stella_0016 §7 and stella_0017 §5 write them.
  SELECT string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ')', ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname IN ('uellix_stella', 'uellix_stella_ops')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  -- (7) NO DEFAULTS on the four project-bound verbs, restated over the new
  --     arity. An argument with a DEFAULT is an argument the caller may omit,
  --     and the guarantee has to be that the SIGNATURE refuses the call.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND p.proname IN ('bind_operation_ticket', 'complete_operation_ticket',
                      'abort_operation_ticket', 'inspect_operation_ticket')
    AND p.pronargdefaults > 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: % ticket verb(s) declare a DEFAULT, so a governed argument can be omitted', n;
  END IF;

  -- (8) The ledger's governed-identity CHECK stella_0017 added is still there.
  --     Asserted because §4 above withdraws the grant that made it possible to
  --     satisfy it with a caller-chosen key: the two facts are one closure and
  --     a database that lost the CHECK would have R6b back under a new name.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stella_interactions_governed_identity_check'
      AND conrelid = 'public.stella_interactions'::regclass
  ) THEN
    RAISE EXCEPTION 'stella_0018 FAILED verification: stella_interactions_governed_identity_check is gone — stella_0017 was rolled back under this package';
  END IF;
END
$$;
