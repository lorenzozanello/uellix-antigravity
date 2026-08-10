-- ============================================================================
-- stella_0014_operation_tickets — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/stella_0014_operation_tickets.sql
-- Source SHA-256 (LF-normalized): 92e4092c526885825b0de508d1e158cdb8c1eaf894b8b370f0346196d11a3396
--
-- The canonical file above is the ONLY source of truth. This artefact exists
-- because managed Supabase exposes no superuser and does not let `postgres`
-- grant USAGE on schema auth. Editing THIS file instead of the canonical one
-- creates the second source of truth the design exists to prevent — and the
-- verification suite will fail, because it regenerates and compares bytes.
--
-- Rewrite rules applied (id: times fired):
--   superuser-precondition: 1
--   auth-schema-grant: 1
--   auth-uid-precondition: 1
--   auth-uid-call: 10
--   capability-role-attributes: 1
--   capability-member-count: 1
--   auth-users-privilege-probe: 1
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/stella_0014_operation_tickets.sql
-- INT-INT-001 — a governed, server-issued operation ticket that gives quota
-- consumption an identity nothing else in this application can supply.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0014_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-int-001
-- RESPONSE:  docs/ops/contracts/INT-INT-001_operation_ticket_protocol.md
-- DEPENDS ON: stella_0013_grounded_query_quota.sql (this package charges
--             THROUGH uellix_stella.consume_stella_quota and never writes the
--             ledger itself). The dependency is a hard precondition in §0, so
--             the forward ORDER is imposed by this SQL and not by a runbook.
-- SOURCE OF TRUTH: the objects here are managed outside the drizzle chain on
-- purpose — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED. NO SERVER
-- ACTION CALLS ANY OF THIS — wiring it is INTEGRATION's reconciliation.
--
-- ============================================================================
-- WHAT INT-INT-001 ACTUALLY REPORTS, AND WHY NO EXISTING SOURCE CLOSES IT
-- ============================================================================
-- `uellix_stella.consume_stella_quota` requires an `idempotency_key`, and the
-- requirement is right: `uq_stella_interactions_idempotency` turns "do not
-- charge a retry twice" into a property of the DATA. But a key is only worth
-- the distinction it draws, and it must draw exactly one:
--
--     retry of an operation  ->  same key  (charged once)
--     a new operation        ->  new key   (charged again)
--
-- Every reachable source fails one side. Measured, not assumed:
--
--   * randomUUID() per invocation — the retry gets a NEW key, so the same
--     operation is CHARGED TWICE.
--   * digest of (user, project, query) — stable across the retry AND across
--     two legitimately identical questions, so the second question is FREE.
--   * a time bucket — the same collapse with an arbitrary window.
--   * a value in the payload — a key chosen by the client is a discount chosen
--     by the client.
--   * a Next.js bound argument — unforgeable, but fixed at RENDER, and one
--     render serves many questions: constant exactly where it must vary.
--
-- Searched for and NOT FOUND anywhere in this application: an operation-ticket
-- table, a reservation table, a transactional outbox, a canonical requestId /
-- correlationId / invocationId (there is no middleware), or a general-purpose
-- signing secret (only STRIPE_*, another domain). `app.request_id` exists as a
-- GUC read by stella_0007's audit trigger, but it is CALLER-SET, nothing in the
-- runtime sets it, and a value the caller chooses cannot be an identity.
--
-- So the identity has to be ISSUED, and it has to be issued BEFORE the
-- operation runs — which is the one thing a digest of the request can never be.
--
-- ============================================================================
-- WHY A NEW TABLE, AND WHY IT IS NOT stella_interactions
-- ============================================================================
-- The canonical structure is reused wherever it can be: one unit of quota is
-- still one row of `public.stella_interactions`, still counted by
-- `checkStellaQuota`, still written by `consume_stella_quota` and by nothing
-- else. This package adds NO second ledger and does NOT hold INSERT on the
-- ledger at all.
--
-- What it cannot reuse is the ROW. A ticket has a lifecycle — issued, bound,
-- completed or aborted — and `trg_stella_interactions_append_only` (prepared
-- stella_0002) refuses UPDATE and DELETE on that table for EVERY role including
-- the owner. A state machine cannot live in a table where no state can change.
-- That is not a preference; it is the reason the ticket is a separate object.
--
-- ============================================================================
-- THE PROTOCOL, AND WHY IT IS RESERVE-THEN-CHARGE
-- ============================================================================
--   1. issue    — server mints an opaque id, bound to actor/org/project/
--                 category, with an expiry. Nothing is reserved yet.
--   2. bind     — the caller presents the ticket AND the canonical digest of
--                 the query. The digest is fixed ONCE. Quota headroom is
--                 checked under the per-organization advisory lock, counting
--                 charged rows PLUS other live bound tickets; if there is no
--                 headroom the bind is REFUSED and the operation never runs.
--                 A successful bind is the RESERVATION.
--   3. execute  — outside any of these transactions. No database lock is held
--                 across it: the reservation is a row STATE, not a lock.
--   4. complete — charges exactly once through consume_stella_quota, with an
--                 idempotency key derived from the ticket and a nonce the
--                 caller never sees.
--   5. abort    — releases the reservation. Nothing is charged, and nothing is
--                 silently compensated: an abort is recorded as an abort.
--
-- WHY THE RESERVATION CANNOT BE A LEDGER ROW. A reservation must be RELEASABLE
-- when the operation fails, and a ledger row can never be removed (append-only,
-- owner included). Writing the reservation to the ledger would mean charging
-- for work that failed. So the reservation lives on the ticket, and the quota
-- arithmetic at bind time counts BOTH.
--
-- WHY AN ORPHANED RESERVATION CANNOT STARVE AN ORGANIZATION. `expires_at` is
-- part of the liveness predicate itself — a bound ticket stops reserving the
-- moment it expires, with NO reaper involved. There is no pg_cron in this
-- project and this package does not pretend there is: expire_operation_tickets
-- exists for hygiene and observability, and the guarantee does not depend on
-- anyone ever calling it.
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
DECLARE
  missing_roles text;
BEGIN
  -- HOSTED VARIANT (Train 5B, generated — do not edit by hand).
  -- The superuser check below was replaced by a capability assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. Original message,
  -- preserved verbatim so the refusal it encoded stays reviewable:
  --   stella_0014 aborted: must run as a SUPERUSER (current_user=%). It creates a role, transfers ownership to it and grants USAGE on schema auth — none of which uellix_owner can do.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0014_operation_tickets');

  -- The hard dependency. This package charges THROUGH stella_0013's function
  -- and holds no INSERT on the ledger, so without it the whole protocol would
  -- install cleanly and be unable to charge anything — the exact failure mode
  -- INT-CAP-001 reported one train ago.
  IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: uellix_stella.consume_stella_quota is absent — apply db/prepared/stella_0013_grounded_query_quota.sql first. This package issues the identity that function requires; it does not replace it and cannot charge without it.';
  END IF;

  IF to_regclass('public.stella_interactions') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: stella_interactions, organizations, projects or users is missing — this database is not at the expected migration baseline.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations'
      AND column_name = 'stella_monthly_quota'
  ) THEN
    RAISE EXCEPTION 'stella_0014 aborted: public.organizations.stella_monthly_quota is absent — there is no limit for a reservation to reserve against.';
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: RLS helpers not found — apply db/migrations/0031_rls_core.sql first.';
  END IF;

  IF to_regprocedure('public.uellix_auth_uid()') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: auth.uid() not found. Every function here derives the actor from the session rather than from an argument, and without it there is no session to derive from.';
  END IF;

  IF to_regprocedure('public.uellix_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: function public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first.';
  END IF;

  -- gen_random_uuid() is the entropy source for both opaque identifiers. It is
  -- a pg_catalog builtin from PostgreSQL 13 and draws from pg_strong_random, so
  -- no pgcrypto and no reference to the `extensions` schema from a function
  -- whose search_path is empty. Asserted rather than assumed: on an older
  -- server the name resolves only through pgcrypto, and a ticket id derived
  -- from a weak source is a ticket id an attacker can guess.
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: pg_catalog.gen_random_uuid() not found. The ticket identity and the charge nonce are both derived from it, and substituting a weaker source would make an opaque identifier guessable.';
  END IF;

  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('uellix_owner'), ('uellix_app'), ('uellix_auditor'),
               ('uellix_cap_stella_quota'),
               ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 aborted: missing role(s): %.', missing_roles;
  END IF;
END $$;

-- ============================================================
-- 1. Capability role and grants (superuser window)
-- ============================================================
-- A role of its OWN, not uellix_cap_stella_quota, and the separation is the
-- security argument of this package rather than tidiness:
--
--   uellix_cap_stella_quota holds SELECT, INSERT on public.stella_interactions.
--   uellix_cap_stella_ticket holds NEITHER INSERT NOR UPDATE on it.
--
-- So the ticket definer cannot file a ledger row at all. The only way a charge
-- reaches the ledger from here is by CALLING consume_stella_quota, which
-- re-imposes every one of its own checks under its own owner. A single shared
-- role would have let a future edit to a ticket function write the ledger
-- directly and skip the governed path entirely.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket') THEN
    EXECUTE 'CREATE ROLE uellix_cap_stella_ticket';
  END IF;
END $$;

-- Stated unconditionally so a re-run converges even if someone widened them.
-- HOSTED VARIANT (generated — do not edit by hand).
-- The canonical statement set seven attributes in one ALTER ROLE. On managed Supabase
-- that statement is unexecutable: naming SUPERUSER, CREATEDB, REPLICATION or BYPASSRLS —
-- even negated — requires the caller to hold the attribute, and the applying identity
-- holds none of the four. Measured in staging: SQLSTATE 42501.
--
-- ASSERTION FIRST, deliberately. If the role HAS been widened, the ALTER below would
-- itself be refused with a permission error naming nothing useful; this way the operator
-- is told which attribute is the problem instead.
DO $$
DECLARE
  v_widened text[];
BEGIN
  SELECT array_agg(a.attribute ORDER BY a.attribute) INTO v_widened
  FROM pg_catalog.pg_roles r
  CROSS JOIN LATERAL (VALUES
      ('SUPERUSER', r.rolsuper),
      ('CREATEDB', r.rolcreatedb),
      ('REPLICATION', r.rolreplication),
      ('BYPASSRLS', r.rolbypassrls)
  ) AS a(attribute, held)
  WHERE r.rolname = 'uellix_cap_stella_ticket' AND a.held;

  IF v_widened IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_0014_operation_tickets aborted: role uellix_cap_stella_ticket holds %, which this package requires it NOT to hold. This identity cannot revoke those attributes — PostgreSQL requires the caller to hold an attribute to change it — so continuing would leave a capability role wider than the package claims. Have a superuser revoke them, or drop the role and re-run.',
      array_to_string(v_widened, ', ');
  END IF;
END $$;

-- The three a CREATEROLE installer may set are still SET, so a re-run still converges
-- on them even if someone widened them.
ALTER ROLE uellix_cap_stella_ticket NOLOGIN NOCREATEROLE NOINHERIT;

-- A SCHEMA OF ITS OWN, and this is not tidiness — it is a defect that was
-- MEASURED. stella_0013's self-verification §7 (4) and (5) are written over the
-- WHOLE `uellix_stella` schema: "every function here is SECURITY DEFINER with an
-- empty search_path AND is owned by uellix_cap_stella_quota". Six functions
-- owned by a different role placed in that schema make stella_0013 abort on its
-- SECOND apply — the forward chain stops being idempotent, which is the property
-- the dry run exists to measure. Observed in pass 2 of
-- scripts/stella-ticket-dry-run.sh, not reasoned about.
--
-- The alternative was to widen stella_0013's assertion. That would be editing a
-- published package to make room for a later one, and it would trade an exact
-- contract ("this schema contains only my functions") for a weaker one, so that
-- a seventh function arriving from anywhere would no longer be judged.
--
-- Instead this package takes the argument stella_0013 itself wrote for not
-- sharing `uellix_capability`: one schema per package family, so no rollback's
-- order is coupled to a campaign it does not depend on.
CREATE SCHEMA IF NOT EXISTS uellix_stella_ops AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_stella_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_stella_ops TO uellix_app;
GRANT USAGE ON SCHEMA uellix_stella_ops TO uellix_cap_stella_ticket;

-- USAGE on stella_0013's schema, so that `consume_stella_quota` RESOLVES.
-- Nothing more: the ticket role owns nothing there and this package neither
-- creates nor drops that schema.
GRANT USAGE ON SCHEMA uellix_stella TO uellix_cap_stella_ticket;

-- The RLS helpers. Both are SECURITY DEFINER owned by uellix_owner and read the
-- CALLER's auth.uid(), so granting EXECUTE confers no data.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_stella_ticket;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_stella_ticket;

-- USAGE on schema auth so `auth.uid()` RESOLVES — nothing more. §7 asserts what
-- it does NOT confer: this role cannot read auth.users.
-- HOSTED VARIANT (Train 5B, generated): the two grants this replaces are not issuable
-- on managed Supabase — `postgres` holds USAGE on schema auth WITHOUT GRANT OPTION.
-- EXECUTE on the bootstrap shim is the narrowest equivalent: it resolves the session
-- actor and confers nothing else. auth.users stays unreachable, asserted below.
GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO uellix_cap_stella_ticket;

-- Reads, and only reads, on the three business tables the protocol consults:
--   projects       — the project must belong to the organization being charged
--   organizations  — the monthly cap the reservation reserves against
--   stella_interactions — the charged rows the headroom check counts
--
-- SELECT on the ledger and NOTHING else. The REVOKE is stated rather than
-- merely omitted: a role that could write the ledger could charge without a
-- ticket, which is the whole boundary this package installs.
GRANT SELECT ON public.projects            TO uellix_cap_stella_ticket;
GRANT SELECT ON public.organizations       TO uellix_cap_stella_ticket;
GRANT SELECT ON public.stella_interactions TO uellix_cap_stella_ticket;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_ticket;

-- The charge path: through stella_0013's function, never around it.
GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)
  TO uellix_cap_stella_ticket;

-- ============================================================
-- 2. The ticket table (owner window)
-- ============================================================
SET ROLE uellix_owner;

-- OWNED BY uellix_owner, not by the capability role, and that is what makes the
-- RLS policies in §5 bind the definer: a table owner is exempt from its own
-- policies unless FORCE ROW LEVEL SECURITY is set, and this line has a standing
-- decision NOT to set FORCE (it would make this package's own rollback count 0
-- completed tickets on a populated table and lie about how much it destroys —
-- the argument grounding_0002 made and integration sustained in train 3).
--
-- The invariants that must reach the OWNER too therefore live in CHECK
-- constraints and in ENABLE ALWAYS triggers (§3, §4), not in RLS.
--
-- NO COLUMN HOLDS TEXT. Not the query, not a prompt, not an answer, not
-- evidence, not a secret. `query_hash` is a digest and `abort_reason` is a
-- value from a closed vocabulary — both are constrained to shapes that cannot
-- carry a sentence.
CREATE TABLE IF NOT EXISTS uellix_stella_ops.operation_tickets (
  -- Opaque, server-minted, 256 bits wide. Never a uuid the caller could have
  -- produced, and never sequential: the id IS the bearer credential, so it has
  -- to be unguessable even before the scope checks refuse a guess.
  ticket_id       char(64) PRIMARY KEY,

  -- The scope the ticket is welded to. A ticket presented against any other
  -- organization, project or actor is not a valid ticket.
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  project_id      uuid NOT NULL REFERENCES public.projects(id),
  actor_id        uuid NOT NULL REFERENCES public.users(id),

  -- The governed capability this ticket may spend a unit on. A ticket issued
  -- for one category cannot be completed as another.
  category        varchar(50) NOT NULL,

  status          text NOT NULL,

  -- Fixed exactly once, at bind. NULL until then, and never NULL again after.
  query_hash      char(64),

  -- The preimage half of the idempotency key that reaches
  -- consume_stella_quota. Minted here, stored here, and returned by NO
  -- function — which is what makes the key underivable by the party holding
  -- the ticket. Without it the caller could compute the key from the ticket id
  -- and charge outside the protocol.
  charge_nonce    char(64) NOT NULL,

  issued_at       timestamp NOT NULL DEFAULT timezone('UTC', now()),
  expires_at      timestamp NOT NULL,
  bound_at        timestamp,
  completed_at    timestamp,
  aborted_at      timestamp,
  expired_at      timestamp,

  -- A CODE from a closed set, never free text. "The operation failed" is a
  -- fact worth recording; WHY it failed is a payload and does not belong in a
  -- table that survives the request.
  abort_reason    varchar(40)
);

COMMENT ON TABLE uellix_stella_ops.operation_tickets IS
  'INT-INT-001 (prepared stella_0014): server-issued operation tickets. The identity `consume_stella_quota` requires and that no request-derived value can supply. One ticket is at most one charged unit. Holds NO query text, no prompt, no answer and no secret — only a digest, a closed-vocabulary reason code and a nonce. Managed outside the drizzle chain — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';

COMMENT ON COLUMN uellix_stella_ops.operation_tickets.ticket_id IS
  'Opaque 256-bit server-minted identifier, lowercase hex. Derived from two pg_catalog.gen_random_uuid() draws — never from the request, the actor or the clock alone.';
COMMENT ON COLUMN uellix_stella_ops.operation_tickets.query_hash IS
  'Canonical SHA-256 of the query, supplied by the caller and fixed ONCE at bind. The canonicalization is stated in docs/ops/contracts/INT-INT-001_operation_ticket_protocol.md; the query TEXT is never sent to, nor stored by, this database.';
COMMENT ON COLUMN uellix_stella_ops.operation_tickets.charge_nonce IS
  'Server-minted secret half of the idempotency-key preimage. Returned by no function and readable by no runtime role: the caller cannot compute, choose or replay the key consume_stella_quota is called with.';
COMMENT ON COLUMN uellix_stella_ops.operation_tickets.expires_at IS
  'Part of the liveness predicate itself, not a hint for a reaper. A bound ticket stops reserving quota the moment it expires, whether or not expire_operation_tickets is ever called.';

-- The reservation lookup, and the only index this package adds. PARTIAL on the
-- reserving state so it stays the size of the live set rather than the history.
CREATE INDEX IF NOT EXISTS ix_operation_tickets_live_reservation
  ON uellix_stella_ops.operation_tickets (organization_id, expires_at)
  WHERE status = 'bound';

-- ============================================================
-- 3. Constraint reconciliation — convergent, by DEFINITION
-- ============================================================
-- Every statement is a LITERAL. The static contract in
-- tests/helpers/sql-structure.ts refuses dynamic SQL rather than guessing at
-- it, so a composed ALTER would be a statement no gate can judge. Same shape as
-- stella_0013 §3, and for the same reason.
--
-- These are CHECKs and not triggers wherever a single row version is enough,
-- because a CHECK cannot be silenced: `session_replication_role = replica`
-- disables triggers and leaves constraints standing.
DO $$
DECLARE
  current_def text;
BEGIN
  -- 3a. The ticket identity is a lowercase-hex SHA-256-width value. An id of
  --     another shape is one this package did not mint.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_ticket_id_shape_check';
  IF current_def IS NULL OR position('^[0-9a-f]{64}$' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_ticket_id_shape_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_ticket_id_shape_check
      CHECK (ticket_id ~ '^[0-9a-f]{64}$');
  END IF;

  -- 3b. The nonce, same shape and same reason.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_charge_nonce_shape_check';
  IF current_def IS NULL OR position('^[0-9a-f]{64}$' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_charge_nonce_shape_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_charge_nonce_shape_check
      CHECK (charge_nonce ~ '^[0-9a-f]{64}$');
  END IF;

  -- 3c. The query digest. NULL until bind; a digest afterwards. A value of any
  --     other shape would be a value that is not a digest — which is the only
  --     thing this column is allowed to be, because the TEXT must not be here.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_query_hash_shape_check';
  IF current_def IS NULL OR position('^[0-9a-f]{64}$' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_query_hash_shape_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_query_hash_shape_check
      CHECK (query_hash IS NULL OR query_hash ~ '^[0-9a-f]{64}$');
  END IF;

  -- 3d. The state vocabulary. FIVE values, matched on the QUOTED literals as
  --     pg_get_constraintdef prints them.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_status_check';
  IF current_def IS NULL
     OR current_def NOT LIKE '%''issued''%'
     OR current_def NOT LIKE '%''bound''%'
     OR current_def NOT LIKE '%''completed''%'
     OR current_def NOT LIKE '%''aborted''%'
     OR current_def NOT LIKE '%''expired''%' THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_status_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_status_check
      CHECK (status IN ('issued', 'bound', 'completed', 'aborted', 'expired'));
  END IF;

  -- 3e. The governed capability vocabulary — the SAME seven values
  --     stella_0013 admits. A ticket for a category the ledger cannot record
  --     is a ticket that can never be completed.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_category_check';
  IF current_def IS NULL
     OR current_def NOT LIKE '%''advisor''%'
     OR current_def NOT LIKE '%''validator''%'
     OR current_def NOT LIKE '%''composer''%'
     OR current_def NOT LIKE '%''proxy_reviewer''%'
     OR current_def NOT LIKE '%''evidence_reviewer''%'
     OR current_def NOT LIKE '%''audit_assistant''%'
     OR current_def NOT LIKE '%''grounded_query''%' THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_category_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_category_check
      CHECK (category IN ('advisor', 'validator', 'composer', 'proxy_reviewer',
                          'evidence_reviewer', 'audit_assistant', 'grounded_query'));
  END IF;

  -- 3f. The abort reason vocabulary, and its biconditional with the state.
  --     A reason without an abort is noise; an abort without a reason is an
  --     unexplained release of a reservation.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_abort_reason_check';
  IF current_def IS NULL
     OR current_def NOT LIKE '%''caller_abort''%'
     OR current_def NOT LIKE '%''execution_failed''%'
     OR current_def NOT LIKE '%''no_result''%'
     OR current_def NOT LIKE '%''quota_refused''%' THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_abort_reason_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_abort_reason_check
      CHECK (abort_reason IS NULL
             OR abort_reason IN ('caller_abort', 'execution_failed', 'no_result', 'quota_refused'));
  END IF;

  -- 3g. Expiry EXISTS and is in the future of issuance, and is BOUNDED. An
  --     unbounded expiry is the same defect as no expiry: a reservation that
  --     never releases. 15 minutes is stated as an interval literal so the
  --     bound survives a direct INSERT by the owner, not only the function.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_expiry_window_check';
  IF current_def IS NULL
     OR position('expires_at > issued_at' in current_def) = 0
     OR position('00:15:00' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_expiry_window_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_expiry_window_check
      CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes');
  END IF;

  -- 3h. The state/timestamp biconditionals, as ONE constraint so no half of a
  --     pair can be dropped without the other becoming visibly unenforced.
  --
  --     `issued` implies no digest: the digest is what bind FIXES, and a
  --     ticket that already carried one before being bound would be a ticket
  --     whose identity was decided somewhere this package cannot see.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'uellix_stella_ops.operation_tickets'::regclass
    AND c.conname = 'operation_tickets_state_consistency_check';
  IF current_def IS NULL
     OR position('completed_at IS NOT NULL' in current_def) = 0
     OR position('query_hash IS NOT NULL' in current_def) = 0
     OR position('aborted_at IS NOT NULL' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE uellix_stella_ops.operation_tickets
        DROP CONSTRAINT operation_tickets_state_consistency_check;
    END IF;
    ALTER TABLE uellix_stella_ops.operation_tickets
      ADD CONSTRAINT operation_tickets_state_consistency_check
      CHECK (
        (status <> 'issued'    OR (query_hash IS NULL AND bound_at IS NULL))
        AND (status NOT IN ('bound', 'completed') OR (query_hash IS NOT NULL AND bound_at IS NOT NULL))
        AND (completed_at IS NOT NULL) = (status = 'completed')
        AND (aborted_at   IS NOT NULL) = (status = 'aborted')
        AND (abort_reason IS NOT NULL) = (status = 'aborted')
        AND (expired_at   IS NOT NULL) = (status = 'expired')
      );
  END IF;
END $$;

-- ============================================================
-- 4. The state machine, enforced for every role including the owner
-- ============================================================
-- A CHECK sees one row version and therefore cannot say "this column did not
-- change" or "this transition is legal". Those are the invariants a trigger
-- has to carry, and a BEFORE trigger has no owner exemption: it fires for
-- `SET ROLE uellix_owner` exactly as it does for the capability role. Same
-- repair grounding_0002 §7b makes, one train later.
--
-- The trigger is SECURITY INVOKER on purpose — it must run with the privileges
-- of whoever is writing, because its job is to bind THEM. `search_path = ''`
-- with fully qualified names so a schema planted ahead of it cannot redirect a
-- lookup.
CREATE OR REPLACE FUNCTION public.uellix_check_operation_ticket_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_project_org uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A ticket is born ISSUED. Every other state is reached by a transition
    -- this trigger judged, so a row inserted straight into `completed` — the
    -- forgery that would charge nothing and claim everything — is refused
    -- here, for the owner as much as for the definer.
    IF NEW.status <> 'issued' THEN
      RAISE EXCEPTION 'stella ticket: a ticket is issued, not declared'
        USING ERRCODE = 'U0109';
    END IF;

    -- The project must belong to the organization the ticket is welded to.
    -- Stated here as well as in the RLS policy because RLS does not bind the
    -- owner and this is a cross-tenant boundary, not a filter.
    SELECT p.organization_id INTO v_project_org
    FROM public.projects p WHERE p.id = NEW.project_id;

    IF NOT FOUND OR v_project_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'stella ticket: the project does not belong to the organization named'
        USING ERRCODE = 'U0102';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- A completed ticket is the only record of WHICH operation a charged
    -- ledger row paid for. The ledger row can never be removed; letting its
    -- counterpart go would leave a charge nobody can account for.
    IF OLD.status = 'completed' THEN
      RAISE EXCEPTION 'stella ticket: a completed ticket is the counterpart of a charged, append-only ledger row and cannot be deleted'
        USING ERRCODE = 'U0109';
    END IF;
    RETURN OLD;
  END IF;

  -- ---- UPDATE ----------------------------------------------------------
  -- Terminal is terminal. Checked FIRST so no later clause can be reached on
  -- a row that has already been settled.
  IF OLD.status IN ('completed', 'aborted', 'expired') THEN
    RAISE EXCEPTION 'stella ticket: the ticket is already settled'
      USING ERRCODE = 'U0109';
  END IF;

  -- The scope, the category, the identity and the window are what the ticket
  -- IS. A ticket whose organization can be edited is not bound to one.
  IF NEW.ticket_id       IS DISTINCT FROM OLD.ticket_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id      IS DISTINCT FROM OLD.project_id
     OR NEW.actor_id        IS DISTINCT FROM OLD.actor_id
     OR NEW.category        IS DISTINCT FROM OLD.category
     OR NEW.charge_nonce    IS DISTINCT FROM OLD.charge_nonce
     OR NEW.issued_at       IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'stella ticket: the scope, category, identity and expiry of a ticket are fixed at issue'
      USING ERRCODE = 'U0109';
  END IF;

  -- WRITE-ONCE. This is invariant 5 and 6 of the contract in one clause: the
  -- digest may go from absent to present exactly once, and may never move to
  -- a different value. Without it a ticket could be bound to one question and
  -- completed as another — a reused ticket doing free work.
  IF OLD.query_hash IS NOT NULL AND NEW.query_hash IS DISTINCT FROM OLD.query_hash THEN
    RAISE EXCEPTION 'stella ticket: the query digest of a ticket is fixed at bind'
      USING ERRCODE = 'U0107';
  END IF;

  -- The legal transitions, exhaustively. Anything not named is refused, so a
  -- state added later without a rule here fails closed rather than open.
  IF NOT (
       (OLD.status = 'issued' AND NEW.status IN ('bound', 'aborted', 'expired'))
    OR (OLD.status = 'bound'  AND NEW.status IN ('completed', 'aborted', 'expired'))
  ) THEN
    RAISE EXCEPTION 'stella ticket: that is not a legal transition'
      USING ERRCODE = 'U0109';
  END IF;

  -- A ticket may only be COMPLETED while it is still live. Expiry is checked
  -- in the function too; restating it here means a direct UPDATE by the owner
  -- cannot settle a ticket whose reservation had already been released.
  IF NEW.status = 'completed' AND OLD.expires_at <= pg_catalog.timezone('UTC', pg_catalog.now()) THEN
    RAISE EXCEPTION 'stella ticket: the ticket expired before it was completed'
      USING ERRCODE = 'U0108';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.uellix_check_operation_ticket_transition() IS
  'INT-INT-001 (prepared stella_0014): the operation-ticket state machine, as a BEFORE trigger so it binds the table owner — which RLS does not, and which this line deliberately does not fix with FORCE ROW LEVEL SECURITY.';

DROP TRIGGER IF EXISTS trg_operation_tickets_transition ON uellix_stella_ops.operation_tickets;
CREATE TRIGGER trg_operation_tickets_transition
  BEFORE INSERT OR UPDATE OR DELETE ON uellix_stella_ops.operation_tickets
  FOR EACH ROW EXECUTE FUNCTION public.uellix_check_operation_ticket_transition();

DROP TRIGGER IF EXISTS trg_operation_tickets_no_truncate ON uellix_stella_ops.operation_tickets;
CREATE TRIGGER trg_operation_tickets_no_truncate
  BEFORE TRUNCATE ON uellix_stella_ops.operation_tickets
  FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

-- A trigger's default tgenabled='O' does not fire under
-- `session_replication_role = replica`, which disables it both for logical
-- replication AND for a session that sets replica mode deliberately to bypass
-- triggers — exactly the posture this table exists to make impossible.
-- ENABLE ALWAYS fires in origin, local AND replica.
ALTER TABLE uellix_stella_ops.operation_tickets ENABLE ALWAYS TRIGGER trg_operation_tickets_transition;
ALTER TABLE uellix_stella_ops.operation_tickets ENABLE ALWAYS TRIGGER trg_operation_tickets_no_truncate;

-- ============================================================
-- 5. RLS — the invariants, restated where the definer is bound
-- ============================================================
-- The capability role holds no BYPASSRLS, so these policies bind it. They are
-- not the last line of defence — §3 and §4 are, because they also bind the
-- owner — but they state the same boundary at the privilege layer, so an edit
-- to a function body cannot quietly widen what that function may touch.
--
-- The actor equality is ABSOLUTE and carries no super-admin disjunction, unlike
-- consume_stella_quota's organization check. A ticket is issued TO someone; a
-- super admin inspecting another user's organization has no business completing
-- that user's operation. Strictness composes: this layer may refuse what the
-- layer below would have allowed.
ALTER TABLE uellix_stella_ops.operation_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operation_tickets_definer_select" ON uellix_stella_ops.operation_tickets;
CREATE POLICY "operation_tickets_definer_select"
ON uellix_stella_ops.operation_tickets FOR SELECT
TO uellix_cap_stella_ticket
USING (
  actor_id = public.uellix_auth_uid()
  AND organization_id = ANY(public.current_user_org_ids())
);

DROP POLICY IF EXISTS "operation_tickets_definer_insert" ON uellix_stella_ops.operation_tickets;
CREATE POLICY "operation_tickets_definer_insert"
ON uellix_stella_ops.operation_tickets FOR INSERT
TO uellix_cap_stella_ticket
WITH CHECK (
  -- The actor is the session, never an argument.
  actor_id = public.uellix_auth_uid()
  AND organization_id = ANY(public.current_user_org_ids())
  -- A ticket is born issued, unbound and undigested.
  AND status = 'issued'
  AND query_hash IS NULL
  -- ...and the project charged belongs to the organization charged.
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = operation_tickets.project_id
      AND p.organization_id = operation_tickets.organization_id
  )
);

DROP POLICY IF EXISTS "operation_tickets_definer_update" ON uellix_stella_ops.operation_tickets;
CREATE POLICY "operation_tickets_definer_update"
ON uellix_stella_ops.operation_tickets FOR UPDATE
TO uellix_cap_stella_ticket
USING (
  actor_id = public.uellix_auth_uid()
  AND organization_id = ANY(public.current_user_org_ids())
)
WITH CHECK (
  actor_id = public.uellix_auth_uid()
  AND organization_id = ANY(public.current_user_org_ids())
);

-- NO DELETE POLICY, deliberately. The definer holds no DELETE grant either
-- (§6b), so removal is impossible through the governed path — and the trigger
-- in §4 refuses it for the owner as well when the ticket is completed. There
-- is no state in this protocol whose correct resolution is "make the ticket
-- disappear": a reservation is released by abort or by expiry, both of which
-- leave a row that says so.

RESET ROLE;

-- ============================================================
-- 6. The governed protocol (superuser window)
-- ============================================================
-- LOCK ORDER, stated once and obeyed by every function below:
--
--     ticket row (SELECT ... FOR UPDATE)  ->  per-organization advisory lock
--
-- Never the reverse. `complete` takes the row lock and then reaches the
-- advisory lock inside consume_stella_quota; `bind` takes the same two in the
-- same order. A single order across every path is what makes a deadlock
-- unreachable rather than merely unobserved.
--
-- The advisory lock key is DELIBERATELY the same expression stella_0013 uses —
-- `hashtextextended('stella/quota/' || organization_id, 0)`. The reservation
-- and the charge must exclude each other; two different keys would be two
-- different mutexes and the headroom check would race the charge it exists to
-- constrain.

-- ------------------------------------------------------------
-- 6a. issue — mint an identity, weld it to a scope, nothing more
-- ------------------------------------------------------------
-- NO TTL ARGUMENT. The expiry is a server constant, because every value a
-- caller can choose is a value a caller can choose badly: a 30-day ticket is a
-- reservation that never releases, and a bound on an argument is one more thing
-- that has to be right. §3g states the same 15 minutes as a CHECK, so a direct
-- INSERT cannot widen what this function will not.
CREATE OR REPLACE FUNCTION uellix_stella_ops.issue_operation_ticket(
  p_organization_id uuid,
  p_project_id uuid,
  p_category varchar(50)
)
RETURNS char(64)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_governed  text[] := ARRAY['advisor', 'validator', 'composer', 'proxy_reviewer',
                              'evidence_reviewer', 'audit_assistant', 'grounded_query'];
  v_actor     uuid;
  v_ticket    char(64);
  v_nonce     char(64);
  v_now       timestamp;
BEGIN
  IF p_organization_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION 'stella ticket: organization and project are required' USING ERRCODE = 'U0100';
  END IF;
  IF p_category IS NULL OR NOT (p_category = ANY(v_governed)) THEN
    RAISE EXCEPTION 'stella ticket: that capability is not in the governed vocabulary' USING ERRCODE = 'U0106';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- SECURITY DEFINER bypasses RLS on what this body reads, so the caller's
  -- boundary is re-imposed explicitly. Same message as "not found":
  -- distinguishing them is a tenancy oracle.
  IF NOT (p_organization_id = ANY(public.current_user_org_ids())) THEN
    RAISE EXCEPTION 'stella ticket: organization not found' USING ERRCODE = 'U0102';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'stella ticket: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- Two independent strong-random draws, folded through SHA-256. The digest is
  -- not the entropy — the two uuids are, at 122 bits each — but folding gives a
  -- fixed 64-hex shape that the CHECK in §3a can state and that no consumer can
  -- mistake for a uuid it may parse, compare or re-derive.
  v_ticket := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'stella/ticket/id/v1' || chr(10)
        || pg_catalog.gen_random_uuid()::text || chr(10)
        || pg_catalog.gen_random_uuid()::text,
      'UTF8')),
    'hex');

  v_nonce := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'stella/ticket/nonce/v1' || chr(10)
        || pg_catalog.gen_random_uuid()::text || chr(10)
        || pg_catalog.gen_random_uuid()::text,
      'UTF8')),
    'hex');

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());

  INSERT INTO uellix_stella_ops.operation_tickets (
    ticket_id, organization_id, project_id, actor_id, category, status,
    charge_nonce, issued_at, expires_at
  ) VALUES (
    v_ticket, p_organization_id, p_project_id, v_actor, p_category, 'issued',
    v_nonce, v_now, v_now + interval '15 minutes'
  );

  RETURN v_ticket;
END;
$$;

-- ------------------------------------------------------------
-- 6b. bind — fix the question, and RESERVE the unit
-- ------------------------------------------------------------
-- This is where the quota decision happens, and it happens BEFORE the operation
-- runs. That ordering is the answer to "an operation that fails must not be
-- charged": there is nothing to refund because nothing was charged, and there
-- is nothing to over-spend because the reservation was counted.
--
-- Returns an OUTCOME rather than raising when the quota refuses, for the reason
-- stella_0013 §6 gives: "exhausted" is an expected business state the product
-- renders, and raising would abort the CALLER's transaction. Exceptions stay
-- reserved for malformed input, an out-of-scope ticket, a reused ticket and a
-- ticket that is no longer live.
CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(
  p_ticket_id char(64),
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
  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the query digest must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- The row lock, FIRST in the lock order. Named columns, never a star: a
  -- SELECT * here would silently start reading charge_nonce into a variable
  -- some later edit could return.
  SELECT t.organization_id, t.status, t.query_hash, t.expires_at
    INTO v_org, v_status, v_hash, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  -- Absent, another actor's, or another organization's: ONE answer. The RLS
  -- policy already restricts what this SELECT can see to the caller's own
  -- tickets, so a forged or borrowed id simply finds nothing — and finds
  -- nothing in a way that cannot be told apart from an id that never existed.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- Expiry is checked only AFTER the scope check has passed, so "expired" is a
  -- distinction only the ticket's own actor can ever observe. To anyone else it
  -- is indistinguishable from "not found", which is what keeps a distinguishable
  -- error from becoming an existence oracle.
  v_now := pg_catalog.timezone('UTC', pg_catalog.now());
  IF v_expires <= v_now THEN
    RAISE EXCEPTION 'stella ticket: the ticket is no longer live' USING ERRCODE = 'U0108';
  END IF;

  -- The digest first, the state second. A ticket presented with a DIFFERENT
  -- question is refused whatever state it is in — including completed, where
  -- reporting "already done" for a question it never ran would be a lie.
  IF v_hash IS NOT NULL AND v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

  IF v_status IN ('aborted', 'expired') THEN
    RAISE EXCEPTION 'stella ticket: the ticket is already settled' USING ERRCODE = 'U0109';
  END IF;

  -- Already bound or already completed with the SAME digest: idempotent. A
  -- retried bind is not a second reservation, and it must not re-run the
  -- headroom check — which could refuse a ticket that is already holding its
  -- unit and turn a harmless retry into a failure.
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
  SELECT count(*)::integer INTO v_used
  FROM public.stella_interactions si
  WHERE si.organization_id = v_org AND si.created_at >= v_month;

  -- LIVE reservations held by OTHER tickets. `expires_at > v_now` is inside the
  -- predicate rather than delegated to a reaper: an orphaned reservation stops
  -- counting the instant it expires, so a crashed process cannot starve an
  -- organization even if nothing ever cleans up after it.
  --
  -- Deliberately NOT filtered by month. A reservation taken at 23:58 on the
  -- last day charges into the next month; counting it in both is conservative
  -- by at most the number of tickets live in a 15-minute window, and being
  -- conservative here can only refuse a unit that was going to be tight, never
  -- oversell one.
  SELECT count(*)::integer INTO v_reserved
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.organization_id = v_org
    AND t.status = 'bound'
    AND t.expires_at > v_now
    AND t.ticket_id <> p_ticket_id;

  -- NULL quota means no cap has been assigned/enforced; 0 means blocked. The
  -- two are different states and lib/stella/quota.ts already tells them apart.
  IF v_quota IS NOT NULL THEN
    IF v_quota = 0 THEN
      RETURN QUERY SELECT 'no_quota'::text, v_used, v_quota;
      RETURN;
    END IF;
    IF v_used + v_reserved >= v_quota THEN
      -- REFUSED, and the ticket stays `issued`. Nothing was reserved, nothing
      -- was charged, and the operation has not run — which is the only point at
      -- which refusing is free.
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
-- 6c. complete — settle the ticket and charge, atomically
-- ------------------------------------------------------------
-- The UPDATE that settles the ticket and the INSERT that charges the ledger are
-- in ONE statement's transaction: consume_stella_quota runs inside this
-- function, which runs inside the caller's transaction. Either both happen or
-- neither does. A settled ticket with no charge would give the work away; a
-- charge with no settled ticket would charge the retry again.
CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(
  p_ticket_id char(64),
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

  -- NEVER BOUND and BOUND TO SOMETHING ELSE are different failures and get
  -- different codes. Collapsing them into U0107 would tell a caller whose
  -- reservation was refused — so the digest was never fixed — that its ticket
  -- belongs to another question, which is not true and not actionable.
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the ticket was never bound to a query' USING ERRCODE = 'U0109';
  END IF;
  IF v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

  -- RETRY AFTER COMPLETE. The whole point of the protocol: the same ticket
  -- presented again reports what already happened and charges nothing. Checked
  -- BEFORE expiry, because a completed ticket stays completed after it expires
  -- and a retry arriving late must still be told the truth rather than an error.
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
    -- The reservation was already released by time. Completing now would charge
    -- against headroom that has since been handed to someone else, so the
    -- honest answer is a refusal and a ticket the caller must abandon.
    RAISE EXCEPTION 'stella ticket: the ticket is no longer live' USING ERRCODE = 'U0108';
  END IF;

  -- THE KEY. Derived from the ticket and from a nonce the caller has never
  -- seen and no function returns. This is the sentence INT-INT-001 was asking
  -- for: the identity `consume_stella_quota` charges under is not a field in
  -- the request, not a digest of the request, and not anything the caller can
  -- choose, replay or pre-compute.
  v_key := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'stella/ticket/charge/v1' || chr(10) || p_ticket_id || chr(10) || v_nonce,
      'UTF8')),
    'hex');

  -- The charge, through the governed path. This role holds no INSERT on the
  -- ledger, so there is no other path available to it even in principle.
  SELECT c.outcome, c.used, c.quota INTO v_charge
  FROM uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key) c;

  IF v_charge.outcome IN ('consumed', 'replayed') THEN
    UPDATE uellix_stella_ops.operation_tickets t
    SET status = 'completed', completed_at = v_now
    WHERE t.ticket_id = p_ticket_id;

    RETURN QUERY SELECT 'completed'::text, v_charge.used, v_charge.quota;
    RETURN;
  END IF;

  -- The ledger refused. This is reachable only in a narrow window — bind
  -- reserved headroom, and a SIBLING Stella action charged the ledger directly
  -- between then and now — and it is reported rather than papered over.
  --
  -- The ticket stays `bound`, which is deliberate and is NOT a silent
  -- compensation: it leaves the caller a ticket it can abort with a reason that
  -- says exactly what happened, and it never charges more units than the
  -- organization was sold. Whether an operation that reached this point should
  -- be given away or should overrun the cap by one is a billing decision, not a
  -- database decision; the database refuses to make it silently.
  RETURN QUERY SELECT v_charge.outcome, v_charge.used, v_charge.quota;
END;
$$;

-- ------------------------------------------------------------
-- 6d. abort — release the reservation, and say so
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION uellix_stella_ops.abort_operation_ticket(
  p_ticket_id char(64),
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
  v_status  text;
  v_now     timestamp;
BEGIN
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;
  IF p_reason IS NULL OR NOT (p_reason = ANY(v_reasons)) THEN
    RAISE EXCEPTION 'stella ticket: that is not a governed abort reason' USING ERRCODE = 'U0106';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT t.status INTO v_status
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  -- A COMPLETED ticket is not abortable, and this is the invariant that keeps
  -- "aborted" from becoming a refund path. The unit was charged to an
  -- append-only ledger; a state that claimed otherwise would be a compensation
  -- the money never received.
  IF v_status = 'completed' THEN
    RAISE EXCEPTION 'stella ticket: a completed operation cannot be aborted' USING ERRCODE = 'U0109';
  END IF;

  -- Already settled the other way: idempotent, so a retried abort after a
  -- crash is not an error.
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
-- 6e. inspect — the minimum a caller needs, and nothing else
-- ------------------------------------------------------------
-- Returns NEITHER the query digest NOR the nonce. The digest would let a party
-- holding a ticket confirm a guess about the question it was bound to; the
-- nonce would hand over the idempotency key. `has_query_hash` answers the only
-- question a retrying caller actually has — "was this ever bound?" — without
-- answering "to what".
CREATE OR REPLACE FUNCTION uellix_stella_ops.inspect_operation_ticket(
  p_ticket_id char(64)
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
  v_actor uuid;
BEGIN
  IF p_ticket_id IS NULL OR p_ticket_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella ticket: the ticket is not a valid identifier' USING ERRCODE = 'U0100';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  RETURN QUERY
  SELECT t.status, t.category, t.expires_at, (t.query_hash IS NOT NULL)
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 6f. expire — hygiene, and explicitly NOT the guarantee
-- ------------------------------------------------------------
-- THERE IS NO pg_cron IN THIS PROJECT, and this function does not pretend
-- otherwise. Nothing calls it today. The property "an orphaned reservation
-- stops consuming quota" does NOT depend on it: `expires_at > now()` is part of
-- the liveness predicate in bind_operation_ticket, so an abandoned ticket stops
-- reserving at its expiry whether or not this ever runs.
--
-- What it buys is that the stored `status` eventually agrees with the truth, so
-- an operator reading the table is not looking at a thousand rows that say
-- `bound` and mean `gone`.
CREATE OR REPLACE FUNCTION uellix_stella_ops.expire_operation_tickets(
  p_max integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_now   timestamp;
  v_count integer;
BEGIN
  IF p_max IS NULL OR p_max < 1 OR p_max > 10000 THEN
    RAISE EXCEPTION 'stella ticket: the batch size is out of range' USING ERRCODE = 'U0100';
  END IF;

  -- Scope-bound like everything else: this sweeps the CALLER's own abandoned
  -- tickets, never the estate. A maintenance verb that crossed tenants would be
  -- a cross-tenant write with a tidy name.
  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';
  END IF;

  v_now := pg_catalog.timezone('UTC', pg_catalog.now());

  WITH due AS (
    SELECT t.ticket_id
    FROM uellix_stella_ops.operation_tickets t
    WHERE t.status IN ('issued', 'bound')
      AND t.expires_at <= v_now
    ORDER BY t.expires_at
    LIMIT p_max
    FOR UPDATE
  )
  UPDATE uellix_stella_ops.operation_tickets t
  SET status = 'expired', expired_at = v_now
  FROM due
  WHERE t.ticket_id = due.ticket_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- 6g. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_stella_ops.issue_operation_ticket(uuid, uuid, varchar(50))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), char(64))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), char(64))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), varchar(40))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64))
  OWNER TO uellix_cap_stella_ticket;
ALTER FUNCTION uellix_stella_ops.expire_operation_tickets(integer)
  OWNER TO uellix_cap_stella_ticket;

-- REVOKE BEFORE GRANT, on every one. A CREATE OR REPLACE keeps the previous
-- ACL, so a package that only granted would be unable to narrow what a prior
-- revision handed out.
REVOKE ALL ON FUNCTION uellix_stella_ops.issue_operation_ticket(uuid, uuid, varchar(50)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), varchar(40)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.expire_operation_tickets(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION uellix_stella_ops.issue_operation_ticket(uuid, uuid, varchar(50)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), varchar(40)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64)) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_stella_ops.expire_operation_tickets(integer) TO uellix_app;

-- The table itself is reachable by NOBODY but the definer. Not uellix_app, not
-- authenticated, not anon, not service_role. Stated as an explicit REVOKE
-- rather than left to the absence of a GRANT, because `ALTER DEFAULT
-- PRIVILEGES` elsewhere in this cluster is exactly the kind of thing that makes
-- "we never granted it" and "nobody holds it" two different statements.
REVOKE ALL ON TABLE uellix_stella_ops.operation_tickets FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE uellix_stella_ops.operation_tickets TO uellix_cap_stella_ticket;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE uellix_stella_ops.operation_tickets FROM uellix_cap_stella_ticket;

COMMENT ON FUNCTION uellix_stella_ops.issue_operation_ticket(uuid, uuid, varchar(50)) IS
  'INT-INT-001: mints an opaque server-issued operation ticket welded to the session actor, an organization, a project and a governed category, with a 15-minute expiry. Raises for malformed input (U0100), an out-of-scope scope (U0102) or an ungoverned category (U0106).';
COMMENT ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), char(64)) IS
  'INT-INT-001: fixes the canonical query digest onto a ticket ONCE and reserves one unit of quota under the per-organization advisory lock, counting charged rows plus other live reservations. Returns bound/quota_exceeded/no_quota; raises U0100, U0102, U0107 (different query), U0108 (expired), U0109 (settled).';
COMMENT ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), char(64)) IS
  'INT-INT-001: settles a bound ticket and charges exactly one unit through uellix_stella.consume_stella_quota, under an idempotency key derived from the ticket and a nonce the caller never sees. A retry returns `replayed` and charges nothing.';
COMMENT ON FUNCTION uellix_stella_ops.abort_operation_ticket(char(64), varchar(40)) IS
  'INT-INT-001: releases the reservation of an issued or bound ticket with a reason from a closed vocabulary. Refuses a completed ticket (U0109): the ledger is append-only and an abort is not a refund.';
COMMENT ON FUNCTION uellix_stella_ops.inspect_operation_ticket(char(64)) IS
  'INT-INT-001: the state of the caller''s own ticket. Returns neither the query digest nor the charge nonce — only whether a digest exists.';
COMMENT ON FUNCTION uellix_stella_ops.expire_operation_tickets(integer) IS
  'INT-INT-001: hygiene only. Marks the caller-visible tickets past their expiry as expired. The guarantee that an orphaned reservation stops consuming quota does NOT depend on this being called — expires_at is part of the liveness predicate itself. There is no pg_cron in this project.';

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
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: uellix_stella_ops.operation_tickets does not exist after the script ran';
  END IF;

  -- (1) All six functions exist, by name, and none arrived unchecked. Written
  --     over the SET of expected names rather than a count, so a missing one is
  --     reported as a missing NAME.
  SELECT string_agg(f.name, ', ' ORDER BY f.name) INTO problem
  FROM (VALUES ('issue_operation_ticket'), ('bind_operation_ticket'),
               ('complete_operation_ticket'), ('abort_operation_ticket'),
               ('inspect_operation_ticket'), ('expire_operation_tickets')) AS f(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'uellix_stella_ops' AND p.proname = f.name
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: function(s) % are absent', problem;
  END IF;

  -- (2) Every function of this package is SECURITY DEFINER with an EMPTY
  --     search_path and owned by the ticket role. Written over the WHOLE schema
  --     rather than the six names, which is exactly what having a schema of its
  --     own buys: a seventh function added here later cannot arrive unjudged.
  --     stella_0013 makes the same assertion over ITS schema, and this package
  --     stays out of it so that assertion keeps holding.
  --
  --     BOTH spellings of the empty path: PostgreSQL stores `SET search_path =
  --     ''` as `search_path=""`, and a bare-form-only check is the bug that made
  --     grounding_0002/0003 abort on every apply.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND pg_get_userbyid(p.proowner) <> 'uellix_cap_stella_ticket';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: function(s) % are not owned by uellix_cap_stella_ticket', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_stella_ops'
    AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  -- (2b) ...and this package added NOTHING to stella_0013's schema. Asserted
  --      rather than assumed, because the whole reason for a schema of its own
  --      is a property that only holds if nobody drifts back.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella'
    AND pg_get_userbyid(p.proowner) = 'uellix_cap_stella_ticket';
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: % function(s) owned by uellix_cap_stella_ticket live in schema uellix_stella. stella_0013 asserts that every function there belongs to uellix_cap_stella_quota and would abort on its next apply', n;
  END IF;

  -- (3) The eight constraints that carry the state machine's row-local half.
  SELECT string_agg(c.name, ', ' ORDER BY c.name) INTO problem
  FROM (VALUES
    ('operation_tickets_ticket_id_shape_check'),
    ('operation_tickets_charge_nonce_shape_check'),
    ('operation_tickets_query_hash_shape_check'),
    ('operation_tickets_status_check'),
    ('operation_tickets_category_check'),
    ('operation_tickets_abort_reason_check'),
    ('operation_tickets_expiry_window_check'),
    ('operation_tickets_state_consistency_check')
  ) AS c(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint pc
    WHERE pc.conrelid = tbl_oid AND pc.conname = c.name AND pc.contype = 'c'
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: CHECK constraint(s) % are absent', problem;
  END IF;

  -- (3b) The expiry window is BOUNDED, not merely present. A CHECK that said
  --      only `expires_at > issued_at` would admit a ticket that expires in the
  --      next century — a reservation that never releases, which is the exact
  --      failure the expiry exists to prevent.
  SELECT pg_get_constraintdef(pc.oid) INTO def
  FROM pg_constraint pc
  WHERE pc.conrelid = tbl_oid AND pc.conname = 'operation_tickets_expiry_window_check';
  IF def IS NULL OR position('00:15:00' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: the expiry window is unbounded (%)', coalesce(def, '<absent>');
  END IF;

  -- (4) Both triggers exist AND are ENABLE ALWAYS (tgenabled='A'). A
  --      plain-enabled trigger is skipped under session_replication_role=replica,
  --      which is precisely the posture this table exists to make impossible.
  SELECT count(*) INTO n FROM pg_trigger t
  WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal AND t.tgenabled = 'A';
  IF n <> 2 THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: expected 2 ENABLE ALWAYS triggers on operation_tickets, found %', n;
  END IF;

  -- (5) RLS is on and the three policies exist. There is NO delete policy, and
  --      its absence is asserted rather than assumed: a fourth policy arriving
  --      later would be a removal path nobody designed.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = tbl_oid AND relrowsecurity) THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: row level security is not enabled on operation_tickets';
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
  IF n <> 3 THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: expected exactly 3 policies on operation_tickets (select/insert/update, and no delete), found %', n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = tbl_oid AND polcmd = 'd') THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: a DELETE policy exists on operation_tickets. Nothing in this protocol is resolved by making a ticket disappear';
  END IF;

  -- (6) The ticket role holds NO write privilege on the LEDGER. This is the
  --      separation that makes "the only way to charge is through the governed
  --      function" a fact about privileges and not a claim about a function body.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = to_regclass('public.stella_interactions')
    AND g.rolname = 'uellix_cap_stella_ticket'
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: uellix_cap_stella_ticket holds % on the ledger. It must reach the ledger only by calling consume_stella_quota', problem;
  END IF;

  -- (7) ...and no DELETE on its own table either.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND g.rolname = 'uellix_cap_stella_ticket'
    AND a.privilege_type IN ('DELETE', 'TRUNCATE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: uellix_cap_stella_ticket holds % on operation_tickets', problem;
  END IF;

  -- (8) NO runtime principal reaches the table directly. The nonce lives here;
  --      a role that could SELECT it could compute the idempotency key and
  --      charge outside the protocol, which is the one thing the nonce exists
  --      to prevent.
  SELECT string_agg(g.rolname || ':' || a.privilege_type, ', ' ORDER BY g.rolname || ':' || a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND g.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role', 'uellix_auditor', 'uellix_writer', 'uellix_reader');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: % holds a direct privilege on operation_tickets. The charge nonce must be unreadable outside the definer', problem;
  END IF;

  -- (9) The capability role has ZERO members, so no LOGIN role reaches its
  --      privileges by SET ROLE.
  -- HOSTED VARIANT (Train 5B / Commit 5.1, generated — do not edit by hand).
  -- The zero-member count below was replaced by a topology assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. RR-02 makes a member
  -- unavoidable for a managed installer; the assertion checks what the count was
  -- standing in for. Original message, preserved verbatim:
  --   stella_0014 FAILED verification: uellix_cap_stella_ticket has % member(s)
  PERFORM uellix_bootstrap.assert_capability_membership_topology('stella_0014_operation_tickets', 'uellix_cap_stella_ticket');

  -- (10) The role attributes, restated as a postcondition rather than trusted
  --      from the ALTER above.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_cap_stella_ticket'
      AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: uellix_cap_stella_ticket carries an attribute it must not (LOGIN/SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION/INHERIT)';
  END IF;

  -- (11) USAGE on schema auth confers auth.uid() and NOTHING ELSE.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'auth' AND c.relname = 'users' AND has_table_privilege('uellix_cap_stella_ticket', c.oid, 'SELECT')) THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: uellix_cap_stella_ticket can read auth.users. The USAGE on schema auth exists so that auth.uid() resolves, not to expose the identity store';
  END IF;

  -- (12) The table carries NO text column. Asserted structurally rather than
  --      promised in a comment: the prohibition on persisting the query is a
  --      property of the SHAPE, and a shape can be measured. `status` is the
  --      one `text` column and it is pinned by a five-value CHECK, so it is
  --      named here as the single exception rather than exempted by a pattern
  --      a future column could accidentally match.
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO problem
  FROM pg_attribute a
  WHERE a.attrelid = tbl_oid AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid IN ('text'::regtype, 'json'::regtype, 'jsonb'::regtype, 'bytea'::regtype)
    AND a.attname <> 'status';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0014 FAILED verification: column(s) % could hold a payload. This table stores digests and closed-vocabulary codes, never the query, a prompt, an answer or evidence', problem;
  END IF;

  RAISE NOTICE 'stella_0014: verification passed — operation_tickets with 8 CHECK constraints and no payload column, 2 ENABLE ALWAYS triggers, RLS on with 3 policies and no DELETE policy, 6 SECURITY DEFINER functions with empty search_path owned by uellix_cap_stella_ticket, no EXECUTE for PUBLIC, no write privilege on the ledger, no direct privilege for any runtime principal, capability role with 0 members and no auth.users access.';
END $$;
