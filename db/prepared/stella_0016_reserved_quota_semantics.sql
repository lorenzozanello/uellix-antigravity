-- db/prepared/stella_0016_reserved_quota_semantics.sql
-- R1 — one governed meaning for capacity: a live reservation is committed
-- capacity, and completing a grounded operation CONVERTS that reservation into
-- a charge instead of competing for it a second time.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0016_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-int-001 (residual R1)
-- RESPONSE:  docs/ops/contracts/R1_reserved_quota_semantics.md
-- DEPENDS ON: stella_0013 (the charge), stella_0014 (the ticket) and
--             stella_0015 (the project binding). This package REPLACES two of
--             stella_0015's four governed functions IN PLACE — same names, same
--             signatures — and publishes three new ones in stella_0013's schema.
--             The dependency is a hard precondition in §0, so the forward ORDER
--             is imposed by this SQL and not by a runbook.
-- SOURCE OF TRUTH: the objects here are managed outside the drizzle chain on
-- purpose — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED. NO SERVER
-- ACTION CALLS ANY OF THIS — wiring it is INTEGRATION's reconciliation.
--
-- ============================================================================
-- WHAT R1 REPORTS, AND THE SECOND DEFECT FOUND WHILE REPRODUCING IT
-- ============================================================================
-- R1, as the ledger states it: "a sibling Stella action charges between bind and
-- complete". Reproduced against the real functions in §5b of
-- scripts/stella-reserved-quota-dry-run.sh, with the remaining quota at one:
--
--     bind(ticket)            -> bound        -- the ticket RESERVES the unit
--     sibling checkQuota      -> used=0 < 1   -- the reservation is INVISIBLE
--     sibling db.insert       -> charged      -- the unit is sold
--     complete(ticket)        -> quota_exceeded
--
-- The grounded work ran, produced a usable answer, and was given away. Nothing
-- was overspent — the cap held — but the reservation bought the ticket nothing,
-- and `complete` lost a unit its own `bind` had already set aside.
--
-- TWO INDEPENDENT CAUSES, and only naming both explains why fixing one is not
-- enough:
--
--   (1) `uellix_stella.consume_stella_quota` counts CHARGED ROWS ONLY. It is
--       the function `complete` charges through, so `complete` re-enters the
--       same competition its reservation was supposed to have settled. The
--       five sibling actions do not even reach it: they read a count in
--       TypeScript and then `db.insert` the ledger directly through
--       `uellix_writer`'s standing grant (R6-INT). Neither path can see a
--       reservation, because reservations are not rows of that table and never
--       will be — a reservation must be RELEASABLE and the ledger is
--       append-only.
--
--   (2) THE RESERVATION COUNT IS ACTOR-SCOPED, and this one was not in the
--       ledger. `bind` counts live reservations with
--       `SELECT count(*) FROM uellix_stella_ops.operation_tickets`, executed as
--       `uellix_cap_stella_ticket` — a role with no BYPASSRLS, bound by
--       stella_0014 §5's `operation_tickets_definer_select`, whose predicate is
--       `actor_id = auth.uid()`. So each actor counts only its OWN reservations.
--       Two members of one organization each reserve the same last unit and both
--       are told `bound`. Reproduced in §5c of the same harness. Train 4.2
--       measured "two tickets for the last unit" with ONE actor, which is why it
--       read green.
--
-- ============================================================================
-- THE SEMANTICS THIS PACKAGE INSTALLS
-- ============================================================================
--     Consumed(org, period)  = rows of public.stella_interactions for that
--                              organization whose created_at is in the period
--     Reserved(org)          = tickets of that organization in status `bound`
--                              whose expires_at is still in the future
--     Available(org, period) = Limit - Consumed - Reserved
--
-- and the invariant, stated once and enforced in one place:
--
--     Consumed + Reserved <= Limit
--
-- Three verbs, one arithmetic:
--
--   * `uellix_stella.stella_capacity`         — computes it. No lock, no write.
--   * `uellix_stella.consume_stella_capacity` — the surface a TICKETLESS
--     consumer uses: takes the lock, refuses when Available <= 0, charges.
--   * `uellix_stella.settle_reserved_quota`   — the surface `complete` uses:
--     proves the reservation is live and CONVERTS it. It does NOT evaluate the
--     limit, because the unit it charges was already counted against it.
--
-- WHY `settle_reserved_quota` MAY SKIP THE LIMIT, AND WHY THAT IS NOT A HOLE.
-- A reservation is not a hint; it is capacity already committed. Re-checking the
-- limit at conversion would count the same unit twice — once as Reserved while
-- the work ran, once as Consumed when it lands — and the second count is what
-- makes `complete` lose to a sibling that arrived in between. So the check moves
-- to where the commitment is MADE (`bind`, and now every ticketless consumer)
-- and the conversion carries no decision at all.
--
-- The authorisation is not "the caller asked nicely": this function is granted
-- to `uellix_cap_stella_ticket` and to NOBODY else — not `uellix_app`, not
-- PUBLIC — and it independently re-reads the ticket row and refuses (U0111)
-- unless it is `bound`, unexpired, and welded to exactly the organization,
-- project and category it is being asked to charge. §7 asserts the grant.
--
-- WHY THE PERIOD OF A RESERVATION IS THE PERIOD IT LANDS IN
-- --------------------------------------------------------
-- `expires_at` is bounded to fifteen minutes (stella_0014 §3g), so a reservation
-- taken at 23:58 on the last day of a month can still convert at 00:03 of the
-- next. The charge row's `created_at` is `now()`, so it counts against the NEW
-- period — the one that never reserved it.
--
-- The rule, stated rather than left to an unfiltered query: a LIVE reservation
-- is counted in whatever period the availability question is asked in.
-- `Reserved` carries no month filter, deliberately. So the new period has
-- already set the unit aside before the conversion arrives, and the invariant
-- holds across the boundary without anybody backdating a compliance row. It is
-- conservative by at most the number of reservations live in a fifteen-minute
-- window, and being conservative here can only REFUSE a unit that was going to
-- be tight — never oversell one.
--
-- `period_month` is added so that membership is a RECORDED FACT rather than an
-- inference: a GENERATED ALWAYS column derived from `bound_at`. It is read by
-- observability and by the harness's period-transition case; the arithmetic
-- above does not branch on it, and §7 asserts it cannot be written.
--
-- WHAT AN ADMIN LOWERING THE CAP MID-RESERVATION MEANS. A reservation is a
-- commitment made under the limit in force when it was taken. Lowering
-- `stella_monthly_quota` afterwards does not void commitments already made:
-- those tickets still convert. It refuses every NEW reservation until Consumed
-- falls back under the new cap. Stated because the alternative — discarding
-- work already executed to satisfy a number that changed after the fact — is a
-- silent compensation, and this line does not make those.
--
-- ============================================================================
-- WHY THE NEW FUNCTIONS LIVE IN uellix_stella AND NOT IN uellix_stella_ops
-- ============================================================================
-- MEASURED, not preferred. `stella_0015` §4 asserts `count(*) = 6` over
-- `uellix_stella_ops`; a seventh function there makes stella_0015 abort on its
-- next apply, which is the same class of defect stella_0014 §1 recorded when it
-- refused to share `uellix_stella`. `stella_0013` §7 makes no count assertion
-- over `uellix_stella` — it asserts that every function there is SECURITY
-- DEFINER with an empty search_path, owned by `uellix_cap_stella_quota` and not
-- executable by PUBLIC. All three new functions satisfy all four, so
-- `stella_0013` remains idempotent over this package. §7 asserts that too.
--
-- `bind_operation_ticket` and `complete_operation_ticket` are REPUBLISHED IN
-- PLACE — identical names, identical argument names, identical types — so
-- `CREATE OR REPLACE` accepts them, no signature is dropped, no grant is
-- reissued and the function count in `uellix_stella_ops` stays exactly 6.
--
-- ============================================================================
-- THE TWO ASSERTIONS OF stella_0014 THIS PACKAGE DOES MOVE, AND THE GUARD
-- ============================================================================
-- One thing cannot be done additively: the availability arithmetic must see the
-- organization's WHOLE live reservation set, and the only policy that lets a
-- definer read `operation_tickets` is actor-scoped. So this package adds a
-- FOURTH policy — `operation_tickets_capacity_select`, for
-- `uellix_cap_stella_quota` only, organization-scoped and NOT actor-scoped.
-- `stella_0014` §7 (5) asserts `count(*) = 3` policies, so after this package
-- stella_0014 can no longer be re-applied. That is registered as a supersession
-- in `db/prepared-package-order.ts`, exactly as R2a's was, and `db/migrator.ts`
-- refuses the re-application INSIDE the transaction that would perform it.
--
-- The alternative was to widen stella_0014's assertion, which is editing a
-- published package to make room for a later one — the trade train 4.2 refused
-- and this one refuses for the same reason.
--
-- WHAT THE NEW POLICY DOES NOT GRANT. It is paired with a COLUMN-LEVEL SELECT
-- grant naming five columns. `charge_nonce` and `query_hash` are NOT among them,
-- so "counts the organization's reservations" and "can read the secret half of
-- an idempotency key" stay two different statements, enforced by the privilege
-- system rather than by the discipline of the function bodies. Column
-- privileges live in `pg_attribute.attacl`, so stella_0014 §7 (8) — which reads
-- `pg_class.relacl` over a named list of runtime principals that does not
-- include this role — is unaffected either way.
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
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0016 aborted: must run as a SUPERUSER (current_user=%). It transfers function ownership to a capability role and grants column-level SELECT on a table it does not own.', current_user;
  END IF;

  -- stella_0013. This package publishes into ITS schema and charges through ITS
  -- function; without it there is nothing to publish into and nothing to charge.
  IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: uellix_stella.consume_stella_quota is absent — apply db/prepared/stella_0013_grounded_query_quota.sql first. Every charge here still lands through that function; this package decides WHEN, never HOW.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_quota') THEN
    RAISE EXCEPTION 'stella_0016 aborted: role uellix_cap_stella_quota is absent — stella_0013 is not applied here.';
  END IF;

  -- stella_0014. The reservations this package counts are rows of its table.
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: uellix_stella_ops.operation_tickets is absent — apply db/prepared/stella_0014_operation_tickets.sql first. There is no reservation to count without it.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket') THEN
    RAISE EXCEPTION 'stella_0016 aborted: role uellix_cap_stella_ticket is absent — stella_0014 is not applied here.';
  END IF;

  -- stella_0015. This package REPLACES the project-bound bodies. Applied over
  -- stella_0014 alone it would publish two functions whose signatures do not
  -- exist yet — CREATE OR REPLACE would MINT them, leaving a database with both
  -- the project-blind pair and a project-bound pair nobody revoked. The order is
  -- imposed here so that cannot happen.
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: the project-bound bind/complete are absent — apply db/prepared/stella_0015_project_bound_operation_tickets.sql first. This package republishes those two bodies; it does not introduce the project binding and must not be the package that mints those signatures.';
  END IF;

  -- ...and the project-BLIND pair must be gone. A database that still holds it
  -- is one where stella_0015 was rolled back or never completed, and publishing
  -- reserved-quota semantics next to a door that takes no project would close R1
  -- while leaving R2-INT open beside it.
  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, character)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: an operation-ticket function that takes NO execution project still exists. R2-INT is reachable here; closing R1 on top of it would produce a database whose reservation accounting is exact and whose attribution is not.';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: auth.uid() not found. Every function here derives the actor from the session rather than from an argument.';
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: RLS helpers not found — apply db/migrations/0031_rls_core.sql first.';
  END IF;

  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0016 aborted: public.stella_interactions is missing — this database is not at the expected migration baseline.';
  END IF;
END $$;

-- ============================================================
-- 1. The reservation's period, as a DERIVED fact
-- ============================================================
SET ROLE uellix_owner;

-- GENERATED ALWAYS, and that is the whole argument: a reservation's period must
-- be UNEQUIVOCAL, and a column nobody can write cannot disagree with the row it
-- describes. `bound_at` is itself effectively immutable — stella_0014 §4 admits
-- no `bound -> bound` transition, so an UPDATE that changed it is refused with
-- U0109 for every role including the owner.
--
-- The alternative was a third ENABLE ALWAYS trigger enforcing write-once. It
-- would have moved stella_0014 §7 (4)'s `count(*) = 2` as well as its policy
-- count, for a property the type system gives away for free.
--
-- `date_trunc(text, timestamp)` — the no-timezone overload — is IMMUTABLE, which
-- is what a generated expression requires. The timezone-aware overload is only
-- STABLE; `bound_at` is `timestamp`, so the immutable one is the one that
-- resolves, and the coordinate space is the same UTC month
-- `lib/stella/quota.ts` uses.
ALTER TABLE uellix_stella_ops.operation_tickets
  ADD COLUMN IF NOT EXISTS period_month timestamp
  GENERATED ALWAYS AS (date_trunc('month', bound_at)) STORED;

COMMENT ON COLUMN uellix_stella_ops.operation_tickets.period_month IS
  'R1 (prepared stella_0016): the UTC month a reservation was taken in, DERIVED from bound_at and writable by nobody. NULL until bind. Recorded so that a reservation''s period is a fact rather than an inference — the availability arithmetic deliberately does NOT filter on it, because a live reservation is counted in whatever period the question is asked in.';

RESET ROLE;

-- ============================================================
-- 2. The reservation set, readable for COUNTING and for nothing else
-- ============================================================
-- Column-level, and the list is the contract. `charge_nonce` and `query_hash`
-- are absent: a role that could read the nonce could compute the idempotency key
-- and charge outside the protocol, which is the one thing stella_0014 minted it
-- to prevent. `ticket_id` is present because `settle_reserved_quota` looks up
-- exactly one row by it.
--
-- Stated as a REVOKE first so a re-run narrows what a previous revision may have
-- widened: `GRANT SELECT (a, b)` adds to whatever column set is already there
-- and can never take one away.
REVOKE ALL ON TABLE uellix_stella_ops.operation_tickets FROM uellix_cap_stella_quota;

GRANT SELECT (ticket_id, organization_id, project_id, category, status, expires_at, period_month)
  ON TABLE uellix_stella_ops.operation_tickets TO uellix_cap_stella_quota;

-- USAGE so the schema resolves. It owns nothing there and this package neither
-- creates nor drops that schema.
GRANT USAGE ON SCHEMA uellix_stella_ops TO uellix_cap_stella_quota;

SET ROLE uellix_owner;

-- The FOURTH policy, and the one that closes cause (2). ORGANIZATION-scoped and
-- deliberately NOT actor-scoped: an organization's capacity is a property of the
-- organization, and an availability function that could only see the caller's
-- own reservations is the defect §5c of the harness reproduces.
--
-- Strictness is not lost, it is RELOCATED to where each layer's job is: this
-- policy serves functions that AGGREGATE (stella_capacity, consume_stella_
-- capacity) and one that looks up a single ticket it has already been told the
-- identity of (settle_reserved_quota). The verbs that disclose a ticket's
-- LIFECYCLE — inspect, bind, complete, abort — run as uellix_cap_stella_ticket
-- and stay bound by stella_0014 §5's actor-scoped policy, untouched.
--
-- Paired with the column grant above, what this role can observe about another
-- member's ticket is: that it exists, its organization, its project, its
-- category, its status, its expiry and its period. Not its question, not its
-- nonce, and not through any surface that returns a row.
DROP POLICY IF EXISTS "operation_tickets_capacity_select" ON uellix_stella_ops.operation_tickets;
CREATE POLICY "operation_tickets_capacity_select"
ON uellix_stella_ops.operation_tickets FOR SELECT
TO uellix_cap_stella_quota
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

RESET ROLE;

-- ============================================================
-- 3. The canonical availability surface (superuser window)
-- ============================================================
-- ONE function computes Available. Every decision below — the reservation, the
-- ticketless charge, and the observability read — asks it. The five sibling
-- server actions reconstruct this arithmetic in TypeScript today, each with its
-- own copy of "count rows for the UTC month", and none of them counts a
-- reservation; migrating them is the integration request this package files.
--
-- NO LOCK. This function decides nothing; it reports. A caller that is about to
-- DECIDE takes the advisory lock first and then asks — which is exactly what
-- §4 and §5 do, and why the lock is theirs and not this one's.
CREATE OR REPLACE FUNCTION uellix_stella.stella_capacity(
  p_organization_id uuid,
  p_exclude_ticket_id char(64)
)
RETURNS TABLE (
  limit_units integer,
  consumed integer,
  reserved integer,
  available integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor    uuid;
  v_now      timestamp;
  v_month    timestamp;
  v_limit    integer;
  v_consumed integer;
  v_reserved integer;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'stella capacity: the organization is required' USING ERRCODE = 'U0100';
  END IF;
  -- NULL means "exclude nothing". A malformed value is not the same thing, and
  -- letting it through would silently exclude no ticket while looking as though
  -- it excluded one.
  IF p_exclude_ticket_id IS NOT NULL AND p_exclude_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella capacity: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella capacity: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- SECURITY DEFINER bypasses RLS on what this body reads, so the caller's
  -- boundary is re-imposed here explicitly. Same message as "not found":
  -- distinguishing them is a tenancy oracle.
  IF NOT (p_organization_id = ANY(public.current_user_org_ids())
          OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'stella capacity: organization not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT o.stella_monthly_quota INTO v_limit
  FROM public.organizations o WHERE o.id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella capacity: organization not found' USING ERRCODE = 'U0102';
  END IF;

  v_now   := pg_catalog.timezone('UTC', pg_catalog.now());
  v_month := pg_catalog.date_trunc('month', v_now);

  -- CONSUMED. Charged rows of the current UTC month, organization-wide and
  -- across every category: the cap is sold per organization, and one unit is one
  -- row of this table — which is already true for the five sibling actions.
  SELECT count(*)::integer INTO v_consumed
  FROM public.stella_interactions si
  WHERE si.organization_id = p_organization_id
    AND si.created_at >= v_month;

  -- RESERVED. Live reservations, organization-wide and ACROSS ACTORS.
  --
  -- `expires_at > v_now` is inside the predicate rather than delegated to a
  -- reaper: an orphaned reservation stops counting the instant it expires, so a
  -- crashed process cannot starve an organization even if nothing ever cleans up
  -- after it. There is no pg_cron in this project and this function does not
  -- pretend there is.
  --
  -- Deliberately NOT filtered by period_month — see the header. A reservation
  -- taken before a month boundary converts after it, and the period it lands in
  -- must already have set the unit aside.
  SELECT count(*)::integer INTO v_reserved
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.organization_id = p_organization_id
    AND t.status = 'bound'
    AND t.expires_at > v_now
    AND (p_exclude_ticket_id IS NULL OR t.ticket_id <> p_exclude_ticket_id);

  -- A NULL limit means no cap has been assigned/enforced, and then Available is
  -- NULL rather than a large number: "unlimited" and "a lot" are different
  -- states, and lib/stella/quota.ts already tells them apart.
  RETURN QUERY SELECT
    v_limit,
    v_consumed,
    v_reserved,
    CASE WHEN v_limit IS NULL THEN NULL::integer
         ELSE v_limit - v_consumed - v_reserved END;
END;
$$;

-- ============================================================
-- 4. The ticketless consumption surface (superuser window)
-- ============================================================
-- The surface the five sibling actions must migrate to. It is NOT a replacement
-- for `consume_stella_quota` — it CALLS it, so the ledger keeps exactly one
-- writer and the idempotency guarantee keeps exactly one implementation. What it
-- adds is the half `consume_stella_quota` cannot have without reading a table
-- stella_0013 knows nothing about: the reservation count.
--
-- LOCK ORDER: per-organization advisory lock, then the charge. It takes NO row
-- lock and therefore cannot participate in the ticket-row -> advisory-lock
-- ordering the ticket verbs obey — there is no cycle to form.
--
-- The advisory lock key is DELIBERATELY the same expression stella_0013 and
-- stella_0014 use. Two different keys would be two different mutexes, and the
-- headroom check would race the charge it exists to constrain.
CREATE OR REPLACE FUNCTION uellix_stella.consume_stella_capacity(
  p_organization_id uuid,
  p_project_id uuid,
  p_stella_role varchar(50),
  p_idempotency_key char(64)
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
  v_existing uuid;
  v_cap      record;
  v_charge   record;
BEGIN
  IF p_organization_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION 'stella capacity: organization and project are required' USING ERRCODE = 'U0100';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella capacity: the idempotency key must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;
  IF p_stella_role IS NULL OR NOT (p_stella_role = ANY(v_governed)) THEN
    RAISE EXCEPTION 'stella capacity: that capability is not in the governed vocabulary' USING ERRCODE = 'U0106';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella capacity: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- SCOPE BEFORE BUSINESS STATE, and this ordering was MEASURED rather than
  -- reasoned about. `consume_stella_quota` re-imposes the same boundary and
  -- would refuse a cross-tenant project with U0102, so nothing could ever be
  -- charged either way — but without this clause the refusal only arrives when
  -- there is headroom left. At the cap, an out-of-scope request is answered
  -- `quota_exceeded`: a business state, retryable next month, for a call that is
  -- never going to be legal. §11 of scripts/stella-reserved-quota-dry-run.sh
  -- caught exactly that, on an organization whose quota happened to be spent.
  --
  -- `stella_capacity` re-checks the ORGANIZATION on the next line; this clause
  -- is the PROJECT half, which it has no argument for.
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'stella capacity: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- Serialise against every other reservation AND every other charge for this
  -- organization, BEFORE anything is counted. The count is taken after the lock,
  -- never before: that ordering is the entire mechanism.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stella/quota/' || p_organization_id::text, 0));

  -- REPLAY, checked under the lock and BEFORE capacity. A retry of an operation
  -- that already charged must not be refused for lack of headroom — it is not
  -- asking for headroom, it is asking what happened. Refusing it would turn a
  -- harmless retry into a failure on exactly the organizations that are at their
  -- cap, which is where retries are most likely.
  --
  -- Read under the CALLER's RLS (stella_interactions_select_member_or_admin
  -- carries no TO clause, so it binds this role too), which is a second,
  -- independent statement of the tenancy boundary.
  SELECT si.id INTO v_existing
  FROM public.stella_interactions si
  WHERE si.organization_id = p_organization_id
    AND si.idempotency_key = p_idempotency_key;

  SELECT c.limit_units, c.consumed, c.reserved, c.available INTO v_cap
  FROM uellix_stella.stella_capacity(p_organization_id, NULL) c;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;
    RETURN;
  END IF;

  -- The refusal. `no_quota` and `quota_exceeded` are the two states
  -- lib/stella/quota.ts already distinguishes, and this function does not invent
  -- a third: the caller renders one as "your organization has no Stella access"
  -- and the other as "you have used this month's allowance".
  IF v_cap.limit_units IS NOT NULL THEN
    IF v_cap.limit_units = 0 THEN
      RETURN QUERY SELECT 'no_quota'::text, v_cap.consumed, v_cap.limit_units;
      RETURN;
    END IF;
    -- THE CLAUSE R1 IS ABOUT. `available` is Limit - Consumed - RESERVED, so a
    -- ticketless consumer can no longer take a unit a live reservation is
    -- holding. A sibling that read only the ledger would see headroom here.
    IF v_cap.available <= 0 THEN
      RETURN QUERY SELECT 'quota_exceeded'::text, v_cap.consumed, v_cap.limit_units;
      RETURN;
    END IF;
  END IF;

  -- The charge, through the governed path and never around it. Its own
  -- ledger-only limit check is redundant here and harmless: Consumed alone can
  -- never exceed Consumed + Reserved, so a call that passed the clause above
  -- cannot be refused by it.
  SELECT c.outcome, c.used, c.quota INTO v_charge
  FROM uellix_stella.consume_stella_quota(p_organization_id, p_project_id, p_stella_role, p_idempotency_key) c;

  RETURN QUERY SELECT v_charge.outcome, v_charge.used, v_charge.quota;
END;
$$;

-- ============================================================
-- 5. The conversion: reservation -> charge (superuser window)
-- ============================================================
-- The one function in this campaign that charges WITHOUT evaluating a limit,
-- and the reason is the whole point of R1: the unit it files was counted against
-- that limit the moment the reservation was taken. Evaluating it again is what
-- made `complete` lose to a sibling that arrived while the model was running.
--
-- IT IS NOT A BACK DOOR, and three separate things keep it from being one:
--
--   * The GRANT. `uellix_cap_stella_ticket` and nobody else — not uellix_app,
--     not PUBLIC. §7 asserts both halves.
--   * The PROOF. It re-reads the ticket row itself and refuses unless that row
--     is `bound`, unexpired, and welded to exactly the organization, project and
--     category it is being asked to charge. It does not trust its caller's
--     account of any of the four.
--   * The IDENTITY. The idempotency key still arrives from the caller and is
--     still enforced by `uq_stella_interactions_idempotency`, so a second
--     conversion of the same ticket is a replay rather than a second unit —
--     as a property of the DATA, not of who called what.
--
-- WHY IT DOES NOT TAKE THE TICKET ROW LOCK. Its only caller already holds it:
-- `complete_operation_ticket` selects the row FOR UPDATE before deriving the key
-- and calling this. Re-locking inside the same transaction is a no-op, and
-- taking it HERE without the caller having taken it there would leave a window
-- between the state check and the conversion.
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

  -- THE PROOF. Named columns, never a star: this table holds a nonce and this
  -- role's column grant deliberately excludes it, so a `SELECT *` here would not
  -- merely be untidy — it would fail.
  SELECT t.organization_id, t.project_id, t.category, t.status, t.expires_at
    INTO v_org, v_project, v_category, v_status, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id;

  -- ONE answer for every way the reservation can fail to be one: absent, another
  -- organization's, another actor's, another project's, another category's,
  -- never bound, already settled, expired. The caller is a definer that has
  -- already made every one of these distinctions with its own error codes; a
  -- second, differently-worded taxonomy here would be a second contract to keep
  -- in step, and this one is reached only when the two disagree — which is a
  -- bug, not a business state.
  IF NOT FOUND
     OR v_org      IS DISTINCT FROM p_organization_id
     OR v_project  IS DISTINCT FROM p_project_id
     OR v_category IS DISTINCT FROM p_stella_role
     OR v_status   IS DISTINCT FROM 'bound' THEN
    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());
  IF v_expires <= v_now THEN
    -- The reservation was released by time and its unit may already have been
    -- handed to somebody else. Converting now would be the oversell this
    -- package exists to make impossible.
    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';
  END IF;

  -- Serialise against every reservation and every charge for this organization.
  -- Not because this function makes a capacity decision — it makes none — but
  -- because the INSERT below and the caller's UPDATE of the ticket to
  -- `completed` have to become visible to a competing capacity check as ONE
  -- move. Under the shared lock a sibling either sees the reservation still held
  -- (and the charge not yet filed) or the charge filed (and the reservation
  -- gone). Consumed + Reserved is the same number on both sides.
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

  -- NO LIMIT CHECK. This is the sentence R1 was asking for, and it is deliberate
  -- rather than omitted: the unit was committed at bind and counted against the
  -- cap ever since, so testing it again would charge the organization twice for
  -- one commitment and lose the work of whichever operation asked second.
  --
  -- Every column that is not derived from a validated argument is a fixed
  -- literal or a server-computed digest — the same construction stella_0013 §6
  -- uses, and deliberately identical so that a row filed by a conversion and a
  -- row filed by a direct consumption are indistinguishable to an auditor
  -- reading the ledger. A charge is a charge.
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

  -- Zero rows means a concurrent transaction filed this exact key between the
  -- replay check and here. The advisory lock makes that unreachable for two
  -- callers of the governed functions, but `uellix_writer`'s standing INSERT
  -- grant takes no such lock — so the conflict clause is what keeps the
  -- guarantee a property of the DATA rather than of who happened to call what.
  IF v_inserted = 0 THEN
    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'consumed'::text, v_cap.consumed + 1, v_cap.limit_units;
END;
$$;

-- ------------------------------------------------------------
-- 5b. Ownership and ACL for the three new functions
-- ------------------------------------------------------------
ALTER FUNCTION uellix_stella.stella_capacity(uuid, char(64))
  OWNER TO uellix_cap_stella_quota;
ALTER FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64))
  OWNER TO uellix_cap_stella_quota;
ALTER FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))
  OWNER TO uellix_cap_stella_quota;

-- REVOKE BEFORE GRANT, on every one. A CREATE OR REPLACE keeps the previous
-- ACL, so a package that only granted would be unable to narrow what a prior
-- revision handed out.
REVOKE ALL ON FUNCTION uellix_stella.stella_capacity(uuid, char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) FROM PUBLIC;

-- The two the runtime may reach.
GRANT EXECUTE ON FUNCTION uellix_stella.stella_capacity(uuid, char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64)) TO uellix_app;

-- ...and the one it may NOT. `settle_reserved_quota` charges without evaluating
-- the limit; a runtime principal holding EXECUTE on it could file a unit past
-- the cap for any ticket it could name. It is granted to the ticket definer and
-- to nothing else, and §7 asserts the absence as well as the presence — an
-- ungranted privilege and a revoked one read the same in a catalogue only if
-- somebody checks.
GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))
  TO uellix_cap_stella_ticket;

-- The capacity surface is reached from inside the ticket verbs too.
GRANT EXECUTE ON FUNCTION uellix_stella.stella_capacity(uuid, char(64)) TO uellix_cap_stella_ticket;

COMMENT ON FUNCTION uellix_stella.stella_capacity(uuid, char(64)) IS
  'R1 (prepared stella_0016): the canonical availability arithmetic. Returns the organization''s limit, its charged rows for the current UTC month, its LIVE reservations across every actor and project, and Limit - Consumed - Reserved. Takes no lock and writes nothing; a caller that is about to decide takes the per-organization advisory lock first. Raises U0100 for malformed input and U0102 for an out-of-scope organization.';
COMMENT ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64)) IS
  'R1 (prepared stella_0016): the consumption surface for Stella actions that hold NO operation ticket. Takes the per-organization advisory lock, replays on a known idempotency key, refuses when Limit - Consumed - Reserved <= 0, and otherwise charges through uellix_stella.consume_stella_quota. Returns consumed/replayed/no_quota/quota_exceeded — the vocabulary lib/stella/quota.ts already speaks.';
COMMENT ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) IS
  'R1 (prepared stella_0016): converts a LIVE reservation into a charge. Evaluates NO limit, because the unit was committed at bind and has been counted against the cap ever since. Re-proves the ticket is bound, unexpired and welded to the organization, project and category it is asked to charge; raises U0111 otherwise. Granted to uellix_cap_stella_ticket ONLY — never to uellix_app, never to PUBLIC.';

-- ============================================================
-- 6. The two ticket verbs, republished IN PLACE
-- ============================================================
-- Same names, same argument names, same types — so CREATE OR REPLACE accepts
-- them, no signature is dropped, no grant is reissued, and the function count in
-- `uellix_stella_ops` stays exactly 6. Everything stella_0015 imposed is
-- restated here verbatim, because a republished body is a body that can drift.

-- ------------------------------------------------------------
-- 6a. bind — reserve, through the canonical arithmetic
-- ------------------------------------------------------------
-- What changed: the inline headroom query is gone. It counted charged rows and
-- live reservations with two hand-written SELECTs, the second of which ran under
-- an actor-scoped policy and therefore counted only the caller's own tickets.
-- Both counts now come from `stella_capacity`, which the ticketless surface asks
-- as well — one arithmetic, two callers, no way for them to disagree.
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

  -- The row lock, FIRST in the lock order. Named columns, never a star.
  SELECT t.organization_id, t.project_id, t.status, t.query_hash, t.expires_at
    INTO v_org, v_project, v_status, v_hash, v_expires
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

-- ------------------------------------------------------------
-- 6b. complete — CONVERT the reservation, never re-compete for it
-- ------------------------------------------------------------
-- What changed, and it is the whole of R1: the charge goes through
-- `settle_reserved_quota` instead of `consume_stella_quota`. The branch that
-- returned `quota_exceeded` from a COMPLETE is gone, because that outcome is now
-- unreachable — a `complete` whose reservation is live cannot be refused for
-- capacity, and a `complete` whose reservation is NOT live was already refused
-- upstream with U0108 or U0109.
--
-- Nothing is compensated silently: if the reservation is gone the caller is told
-- so and the answer is never presented as successful, exactly as before. What is
-- no longer possible is for the reservation to be gone because somebody else
-- spent a unit this ticket had already set aside.
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

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- The row lock, FIRST in the lock order and held for the whole conversion.
  -- Two concurrent completes of the same ticket serialise here; the second finds
  -- `completed` and replays.
  SELECT t.organization_id, t.project_id, t.category, t.status, t.query_hash,
         t.charge_nonce, t.expires_at
    INTO v_org, v_project, v_category, v_status, v_hash, v_nonce, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- R2-INT, checked BEFORE the replay short-circuit.
  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the ticket was never bound to a query' USING ERRCODE = 'U0109';
  END IF;
  IF v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

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

  -- THE CONVERSION. `v_project` is the column read from the ticket row under the
  -- row lock and already proven equal to the execution project. The ticket id
  -- travels too, so the conversion can re-prove the reservation for itself
  -- instead of taking this function's word for it.
  SELECT c.outcome, c.used, c.quota INTO v_charge
  FROM uellix_stella.settle_reserved_quota(v_org, v_project, v_category, v_key, p_ticket_id) c;

  -- The settle raises U0111 rather than returning a refusal, so reaching here
  -- means the unit is filed. The UPDATE and that INSERT are in ONE transaction:
  -- either both happen or neither does. A settled ticket with no charge would
  -- give the work away; a charge with no settled ticket would charge the retry
  -- again.
  UPDATE uellix_stella_ops.operation_tickets t
  SET status = 'completed', completed_at = v_now
  WHERE t.ticket_id = p_ticket_id;

  RETURN QUERY SELECT 'completed'::text, v_charge.used, v_charge.quota;
END;
$$;

-- ------------------------------------------------------------
-- 6c. Ownership and ACL, restated for the two republished bodies
-- ------------------------------------------------------------
-- CREATE OR REPLACE preserves owner and ACL, so these are convergence
-- statements rather than changes. They are stated because a package that
-- assumed them would be a package that stops being true the day somebody
-- replaces one of these functions from somewhere else.
ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64))
  OWNER TO uellix_cap_stella_ticket;

REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) TO uellix_app;

COMMENT ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) IS
  'R1 (prepared stella_0016): fixes the canonical query digest onto a ticket ONCE and RESERVES one unit, refusing when uellix_stella.stella_capacity reports Limit - Consumed - Reserved <= 0. The reservation count is organization-wide and ACROSS ACTORS. R2-INT unchanged: raises U0110 when the ticket''s project differs from the execution project, before expiry, digest or state are examined.';
COMMENT ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) IS
  'R1 (prepared stella_0016): settles a bound ticket by CONVERTING its reservation into a charge through uellix_stella.settle_reserved_quota, which evaluates no limit because the unit was already committed at bind. A complete with a live reservation can no longer be refused for capacity. A retry returns `replayed` and charges nothing.';

-- ============================================================
-- 7. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  tbl_oid oid;
  problem text;
  def     text;
  n       int;
BEGIN
  tbl_oid := to_regclass('uellix_stella_ops.operation_tickets');

  -- (1) The three new functions exist, by exact signature.
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella.stella_capacity(uuid, character)'),
    ('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)'),
    ('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)')
  ) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: function(s) % are absent', problem;
  END IF;

  -- (2) stella_0013's schema-wide contract still holds over the three additions,
  --     which is what keeps stella_0013 idempotent over this package. Written
  --     over the WHOLE schema rather than the three names, exactly as
  --     stella_0013 §7 (4) writes it — so a fourth function added here later
  --     cannot arrive unjudged either.
  --
  --     BOTH spellings of the empty path: PostgreSQL stores `SET search_path =
  --     ''` as `search_path=""`.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella'
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''. stella_0013 asserts this over its whole schema and would abort on its next apply', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella'
    AND pg_get_userbyid(p.proowner) <> 'uellix_cap_stella_quota';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: function(s) % in uellix_stella are not owned by uellix_cap_stella_quota', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_stella' AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  -- (2b) ...and this package added NOTHING to stella_0014's schema. Asserted
  --      rather than assumed: stella_0015 §4 requires EXACTLY six functions
  --      there, so a seventh would make that package abort on its next apply —
  --      the same defect stella_0014 §1 recorded and refused to introduce.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops';
  IF n <> 6 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: uellix_stella_ops holds % function(s) instead of 6. This package republishes two bodies IN PLACE and must add none — stella_0015 asserts the count and would abort on its next apply', n;
  END IF;

  -- (3) THE GRANT THAT IS THE BOUNDARY. `settle_reserved_quota` charges without
  --     evaluating the limit, so who may execute it IS the security property.
  --     Both halves are asserted: the ticket definer holds it, and no runtime
  --     principal does.
  IF NOT has_function_privilege('uellix_cap_stella_ticket',
        'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: uellix_cap_stella_ticket cannot execute settle_reserved_quota, so complete_operation_ticket cannot convert a reservation at all';
  END IF;

  -- DRIVEN FROM pg_roles, not from a VALUES list filtered by an EXISTS. A
  -- planner is free to evaluate the two WHERE clauses in either order, and
  -- `has_function_privilege` RAISES on a role that does not exist rather than
  -- returning false — so the guarded-looking form aborts the package on any
  -- cluster missing one of these names. Measured on a baseline with no
  -- `uellix_reader`, not reasoned about.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO problem
  FROM pg_roles r
  WHERE r.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role',
                      'uellix_writer', 'uellix_reader', 'uellix_auditor')
    AND has_function_privilege(r.oid,
          to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)'),
          'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: % can execute settle_reserved_quota. That function files a unit WITHOUT evaluating the limit; a runtime principal holding it could charge past the cap for any ticket it could name', problem;
  END IF;

  -- ...and the two the runtime DOES need.
  IF NOT has_function_privilege('uellix_app', 'uellix_stella.stella_capacity(uuid, character)', 'EXECUTE')
     OR NOT has_function_privilege('uellix_app',
          'uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: uellix_app cannot reach the capacity surface, so the ticketless consumers have nothing to migrate to';
  END IF;

  -- (4) THE RESERVATION IS IN THE ARITHMETIC. Asserted on the function body,
  --     because a capacity function that returned Limit - Consumed would satisfy
  --     every signature check above and be R1 with a new name.
  SELECT pg_get_functiondef(to_regprocedure('uellix_stella.stella_capacity(uuid, character)')) INTO def;
  IF position('uellix_stella_ops.operation_tickets' in def) = 0
     OR position('v_limit - v_consumed - v_reserved' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: stella_capacity does not subtract live reservations from the limit. A capacity function that counts only charged rows IS the defect this package closes';
  END IF;
  IF position('t.expires_at > v_now' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: stella_capacity does not exclude expired reservations from the live set, so an abandoned ticket would starve its organization until somebody swept it — and there is no pg_cron in this project';
  END IF;

  -- (4b) THE TICKETLESS SURFACE JUDGES SCOPE BEFORE CAPACITY. Without it an
  --      out-of-scope project is answered `quota_exceeded` whenever the
  --      organization happens to be at its cap — a retryable business state for
  --      a call that can never be legal.
  SELECT pg_get_functiondef(to_regprocedure('uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)')) INTO def;
  IF position('p.organization_id = p_organization_id' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: consume_stella_capacity never proves the project belongs to the organization being charged';
  END IF;
  IF position('p.organization_id = p_organization_id' in def) > position('pg_advisory_xact_lock' in def) THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: consume_stella_capacity checks the project AFTER taking the lock and counting, so an out-of-scope call is answered with a business state instead of a scope refusal';
  END IF;

  -- (5) COMPLETE NO LONGER RE-COMPETES. The charge path is the conversion, and
  --     the old one is gone from the body rather than merely unused.
  SELECT pg_get_functiondef(to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)')) INTO def;
  IF position('uellix_stella.settle_reserved_quota' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: complete_operation_ticket does not charge through settle_reserved_quota';
  END IF;
  IF position('uellix_stella.consume_stella_quota' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: complete_operation_ticket still calls consume_stella_quota, which evaluates the limit against charged rows only — so completing still competes for the unit bind already reserved. That is R1';
  END IF;
  IF position('INSERT INTO public.stella_interactions' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: complete_operation_ticket writes the ledger directly, going around the governed path';
  END IF;

  -- (6) BIND ASKS THE CANONICAL ARITHMETIC rather than rebuilding it. A second
  --     copy of the count is a second thing that can be actor-scoped by accident,
  --     which is exactly how cause (2) of R1 arose.
  SELECT pg_get_functiondef(to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)')) INTO def;
  IF position('uellix_stella.stella_capacity' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: bind_operation_ticket does not use the canonical capacity function';
  END IF;
  IF position('FROM uellix_stella_ops.operation_tickets t' in def) > 0
     AND position('count(*)' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: bind_operation_ticket still counts reservations with its own query. Two arithmetics that can disagree are one arithmetic plus a latent oversell';
  END IF;
  -- R2-INT must survive the republication. A body rewritten for R1 that dropped
  -- the project comparison would close one contract by reopening another.
  IF position('v_project IS DISTINCT FROM p_expected_project_id' in def) = 0
     OR position('U0110' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: the republished bind_operation_ticket lost the R2-INT project comparison';
  END IF;

  -- (7) The period is DERIVED and writable by nobody. `attgenerated = 's'` is a
  --     stored generated column; anything else is a column somebody can set.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = tbl_oid AND a.attname = 'period_month'
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = 's'
  ) THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: operation_tickets.period_month is absent or is not a STORED generated column. A period a caller can write is a period that can disagree with the reservation it describes';
  END IF;

  -- (8) THE POLICY THAT COUNTS ACROSS ACTORS. Its predicate must NOT mention
  --     actor_id: an availability function that only sees the caller's own
  --     reservations is cause (2) of R1, reproduced in §5c of the harness.
  SELECT count(*) INTO n FROM pg_policy
  WHERE polrelid = tbl_oid AND polname = 'operation_tickets_capacity_select';
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: operation_tickets_capacity_select is missing. The capacity definer holds no BYPASSRLS, so with no policy it counts zero reservations and every organization looks empty';
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO def
  FROM pg_policy pol
  WHERE pol.polrelid = tbl_oid AND pol.polname = 'operation_tickets_capacity_select';
  IF position('actor_id' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: operation_tickets_capacity_select is actor-scoped (%). Then two members of one organization each reserve the same last unit and both are told bound', def;
  END IF;
  IF position('current_user_org_ids' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: operation_tickets_capacity_select does not restrict to the caller''s organizations, so the capacity definer reads the estate';
  END IF;

  -- (9) THE NONCE STAYS UNREADABLE. The column grant is the boundary, so it is
  --     asserted column by column rather than inferred from the GRANT statement.
  SELECT string_agg(c.name, ', ' ORDER BY c.name) INTO problem
  FROM (VALUES ('charge_nonce'), ('query_hash')) AS c(name)
  WHERE has_column_privilege('uellix_cap_stella_quota',
          'uellix_stella_ops.operation_tickets', c.name, 'SELECT');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: uellix_cap_stella_quota can read column(s) % of operation_tickets. A role that can read the nonce can compute the idempotency key and charge outside the protocol', problem;
  END IF;

  IF NOT has_column_privilege('uellix_cap_stella_quota',
        'uellix_stella_ops.operation_tickets', 'status', 'SELECT')
     OR NOT has_column_privilege('uellix_cap_stella_quota',
        'uellix_stella_ops.operation_tickets', 'expires_at', 'SELECT') THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: uellix_cap_stella_quota cannot read the columns the live-reservation predicate is written over';
  END IF;

  -- (10) ...and it may only READ. A capacity role that could update a ticket
  --       could release somebody else's reservation, or extend its own.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND g.rolname = 'uellix_cap_stella_quota'
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: uellix_cap_stella_quota holds % on operation_tickets. It counts reservations; it does not get to change them', problem;
  END IF;

  -- (11) No project-blind signature reappeared. stella_0015 dropped them and
  --      this package republishes two of the bodies it left — a republication
  --      that used the wrong argument list would MINT the old signature back.
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella_ops.bind_operation_ticket(character, character)'),
    ('uellix_stella_ops.complete_operation_ticket(character, character)'),
    ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
    ('uellix_stella_ops.inspect_operation_ticket(character)')
  ) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NOT NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0016 FAILED verification: signature(s) % still exist and take no execution project', problem;
  END IF;

  RAISE NOTICE 'stella_0016: verification passed — three governed functions in uellix_stella (capacity, ticketless consumption, reservation conversion), settle_reserved_quota executable ONLY by uellix_cap_stella_ticket, bind and complete republished in place with uellix_stella_ops still at 6 functions, period_month generated and unwritable, an organization-wide non-actor-scoped capacity policy, and a column grant that leaves the charge nonce unreadable.';
END $$;
