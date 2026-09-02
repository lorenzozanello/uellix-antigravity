-- ============================================================================
-- stella_0017_governed_stella_consumption — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/stella_0017_governed_stella_consumption.sql
-- Source SHA-256 (LF-normalized): 074050dc39e4baa1b53461559dc418e653397242efc4da9beabdf9825d3d04de
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
--   auth-uid-call: 2
--   capability-role-attributes: 0
--   capability-member-count: 0
--   auth-users-privilege-probe: 0
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/stella_0017_governed_stella_consumption.sql
-- R1 (residual) and R6-INT — quota units may enter the ledger ONLY through a
-- governed function, and the five sibling Stella actions get the same
-- server-issued operation identity the grounded path already has.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0017_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-int-001 (residual R1, R6-INT)
-- RESPONSE:  docs/ops/contracts/R1-B_governed_stella_consumption.md
-- DEPENDS ON: stella_0013 (the charge), stella_0014 (the ticket), stella_0015
--             (the project binding) and stella_0016 (reserved capacity). The
--             dependency is a hard precondition in §0, so the forward ORDER is
--             imposed by this SQL and not by a runbook.
-- SOURCE OF TRUTH: the objects here are managed outside the drizzle chain on
-- purpose — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED. NO SERVER
-- ACTION CALLS ANY OF THIS — wiring it is INTEGRATION's reconciliation.
--
-- ============================================================================
-- WHAT WAS MEASURED, AND WHY stella_0016 MADE IT WORSE RATHER THAN BETTER
-- ============================================================================
-- stella_0016 installed one arithmetic — Consumed + Reserved <= Limit — and
-- made `complete` CONVERT its reservation instead of competing for it again.
-- Both are right. But the conversion evaluates NO limit, deliberately, and the
-- five sibling Stella actions still reach the ledger with a bare `db.insert`
-- through `uellix_writer`'s standing grant (R6-INT). Composed, those two facts
-- are not R1 any more. They are an OVERSELL.
--
-- Reproduced against the real functions with the chain 0013→0016 installed and
-- `stella_monthly_quota = 1` (§6 of scripts/stella-governed-consumption-dry-run.sh):
--
--     bind(ticket)          -> bound        -- the ticket reserves the unit
--     sibling checkQuota    -> used = 0     -- the reservation is INVISIBLE
--     sibling db.insert     -> charged      -- unit 1 of 1 is sold
--     complete(ticket)      -> completed    -- the conversion evaluates no limit
--     ------------------------------------------------------------------
--     Consumed = 2, Limit = 1
--
-- Under stella_0015 the same sequence ended in `quota_exceeded` and the work was
-- given away — bad, but the cap held. Under stella_0016 the cap does not hold.
-- The reservation semantics are correct and the ledger's write surface is not,
-- and a correct arithmetic over an ungoverned write is arithmetic about a number
-- somebody else is free to change.
--
-- So this package does two things, and neither is optional for the other to
-- mean anything:
--
--   (1) it REMOVES the direct write. No runtime principal may INSERT, UPDATE,
--       DELETE or TRUNCATE `public.stella_interactions` afterwards — and the
--       privilege that has to go is `uellix_writer`'s, not `uellix_app`'s.
--   (2) it GENERALISES the operation ticket so the sibling categories have the
--       same server-issued identity, the same reservation and the same
--       conversion the grounded path has had since train 4.1.
--
-- ============================================================================
-- (1) THE PRIVILEGE THAT HAD TO GO IS NOT THE ONE WITH THE OBVIOUS NAME
-- ============================================================================
-- MEASURED on a restored baseline, not read off a grant statement:
--
--     uellix_app entries in stella_interactions.relacl ............... 0
--     has_table_privilege('uellix_app', ..., 'INSERT') ............... true
--
-- `uellix_app` holds NOTHING on this table. Its INSERT is entirely INHERITED:
-- `GRANT uellix_writer TO uellix_app WITH INHERIT TRUE` (db/baseline/
-- stella_g2_roles.sql:223), and `uellix_writer` holds `SELECT, INSERT`
-- (db/baseline/stella_g2_schema.sql:11321). A package that revoked from
-- `uellix_app` would be a package whose REVOKE is a no-op and whose
-- verification — if it also asked the wrong question — would report success.
--
-- Which is why §5 asks `has_table_privilege`, which FOLLOWS role membership,
-- rather than reading `relacl`, which does not. `aclexplode` is used as well,
-- for the complementary question: which grants exist to be revoked at all.
--
-- COPY. `COPY … FROM STDIN` needs the same INSERT privilege, so it closes with
-- it. It is additionally refused today by a property of the table rather than
-- of the role — PostgreSQL rejects `COPY FROM` on a relation with row level
-- security enabled — and §5 asserts RLS is still on so the second barrier is
-- not silently lost. Both are asserted; neither is assumed.
--
-- ============================================================================
-- WHY THE REVOKE ALONE IS NOT THE WHOLE CLOSURE
-- ============================================================================
-- A privilege can be granted again, by a baseline restore, by
-- `stella_0005c_rollback.sql` (which GRANTs INSERT back to `authenticated` and
-- `service_role` by name), or by anyone with the authority to write a GRANT. So
-- the guarantee is also stated where no grant can reach it:
--
--     stella_interactions_governed_identity_check:
--         CHECK (idempotency_key IS NOT NULL) NOT VALID
--
-- A row without a governed operation identity cannot exist. The identity is
-- minted by `issue_operation_ticket` and derived at completion from a nonce no
-- function returns, so a caller cannot produce one — which makes "every unit
-- was charged by a governed function" a property of the DATA, in the same sense
-- `uq_stella_interactions_idempotency` already makes "no retry is charged
-- twice" one.
--
-- NOT VALID, and that is precise rather than lax. Every row filed before this
-- package existed was filed by the direct path and carries no key; validating
-- against history would fail on exactly the rows the package exists to stop
-- being created. A `NOT VALID` CHECK is enforced on every INSERT and UPDATE
-- from the moment it is added — including for the table OWNER, which RLS is
-- not, and including under `session_replication_role = replica`, which a
-- trigger is not. It declines to make a claim about the past and makes an
-- absolute one about the future.
--
-- WHAT THIS BREAKS, SAID OUT LOUD. The five sibling server actions stop being
-- able to write the ledger the moment this package is applied — both by
-- privilege and by constraint. That is the closure, not a side effect: R6-INT
-- is the statement that they can. `scripts/seed-stella-local.ts` files a ledger
-- row with no key and stops working for the same reason; it belongs to another
-- line and is registered as remaining integration work rather than edited here.
--
-- ============================================================================
-- (2) ONE PROTOCOL, SEVEN CATEGORIES — WHAT WAS ALREADY THERE
-- ============================================================================
-- Inventoried before anything was designed. `uellix_stella_ops.operation_tickets`
-- ALREADY carries every category: `operation_tickets_category_check` names all
-- seven, `issue_operation_ticket` validates against the same seven, the category
-- is welded at issue and `stella_0014` §4 refuses an UPDATE that changes it for
-- every role including the owner. `settle_reserved_quota` already refuses
-- (U0111) unless the ticket's category equals the category being charged.
--
-- So the ticket did not need a second system, a second table or a second
-- vocabulary. It needed ONE thing the grounded path never had to carry: the
-- interaction PAYLOAD. `public.stella_interactions.response_json` is NOT NULL,
-- `model_used` is NOT NULL, and `tokens_used` is read by
-- `lib/admin/stella-services.ts`. A governed path that filed the fixed literal
-- `{"kind":"quota_consumption","version":1}` for a sibling would close R6-INT by
-- destroying the audit trail five live actions produce — which is a product
-- decision, and this line does not make those in silence.
--
-- THE ADDITION, in full:
--
--   * `uellix_stella.settle_reserved_quota(…10 args)` — the conversion, now
--     carrying the row it files. It is the ONLY implementation; the five-argument
--     signature stella_0016 published is REPLACED IN PLACE by a delegator that
--     passes NULL for every payload argument, so the grounded row is produced by
--     the same code and is byte-for-byte what it was. Two overloads, one INSERT.
--
--   * `uellix_stella_ops.complete_operation_ticket(…7 args)` — the sibling
--     completion verb. Same name, same first three arguments, same project
--     comparison, same U0110, same replay semantics. It differs from the
--     three-argument verb in exactly one way: it forwards the payload, and it
--     files the digest the ticket was BOUND to as the row's `context_hash`
--     instead of a derived one. That digest was fixed once, server-side, under
--     the row lock — which is a better `context_hash` than one that arrives with
--     the request.
--
-- NULL payload reproduces stella_0016's row exactly. §5 asserts the delegation
-- rather than trusting it, and the harness measures the two rows column by
-- column.
--
-- ============================================================================
-- WHAT THIS PACKAGE DOES NOT DO
-- ============================================================================
-- It does not touch `consume_stella_quota`, `stella_capacity`,
-- `consume_stella_capacity`, `bind_operation_ticket`,
-- `complete_operation_ticket(character, uuid, character)`,
-- `abort_operation_ticket`, `inspect_operation_ticket`,
-- `issue_operation_ticket` or `expire_operation_tickets`. It publishes no new
-- role, no new schema, no new table and no new policy. It decides WHO may write
-- the ledger and WHAT a sibling completion carries; it does not restate WHEN a
-- unit may be spent, because stella_0016 already does and two arithmetics that
-- can disagree are one arithmetic plus a latent oversell.
--
-- ORDER. Adding a seventh function to `uellix_stella_ops` moves the
-- `count(*) = 6` assertion that BOTH stella_0015 §4 (5) and stella_0016 §7 (2b)
-- make, so neither may be re-applied over this package. Both are registered as
-- supersessions in `db/prepared-package-order.ts`; both would abort in their own
-- transaction anyway, which is fail-closed, and the registry turns an abort with
-- a puzzling message into a refusal with an actionable one.
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
  --   stella_0017 aborted: must run as a SUPERUSER (current_user=%). It revokes privileges granted by the baseline restore and transfers function ownership to capability roles — neither of which uellix_owner can do.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0017_governed_stella_consumption');

  IF to_regclass('public.stella_interactions') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: stella_interactions, organizations, projects or users is missing — this database is not at the expected migration baseline.';
  END IF;

  -- stella_0013. The idempotency column and its unique index are what make the
  -- governed-identity CHECK below mean anything: without them a key would be a
  -- string nobody enforces.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stella_interactions'
      AND column_name = 'idempotency_key'
  ) THEN
    RAISE EXCEPTION 'stella_0017 aborted: public.stella_interactions.idempotency_key is absent — apply db/prepared/stella_0013_grounded_query_quota.sql first. This package makes that column mandatory; it does not create it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.stella_interactions'::regclass
      AND c.relname = 'uq_stella_interactions_idempotency'
      AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'stella_0017 aborted: uq_stella_interactions_idempotency is missing or not unique. Making the key mandatory without making it unique would require an identity and then allow it to be reused, which is the double charge INT-CAP-001 reported.';
  END IF;

  IF to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: uellix_stella.consume_stella_quota is absent — apply db/prepared/stella_0013_grounded_query_quota.sql first.';
  END IF;

  -- stella_0014. The ticket this package generalises.
  IF to_regclass('uellix_stella_ops.operation_tickets') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: uellix_stella_ops.operation_tickets is absent — apply db/prepared/stella_0014_operation_tickets.sql first. This package publishes a second completion verb over a ticket it does not create.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_ticket')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_quota') THEN
    RAISE EXCEPTION 'stella_0017 aborted: the capability roles uellix_cap_stella_quota / uellix_cap_stella_ticket are absent — stella_0013 and stella_0014 are not applied here.';
  END IF;

  -- stella_0015. The project binding must already be the only shape available:
  -- publishing a sibling verb that compares the project, next to a door that
  -- does not, would close R6-INT on top of an open R2-INT.
  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: the project-bound complete_operation_ticket is absent — apply db/prepared/stella_0015_project_bound_operation_tickets.sql first.';
  END IF;

  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, character)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.abort_operation_ticket(character, character varying)') IS NOT NULL
     OR to_regprocedure('uellix_stella_ops.inspect_operation_ticket(character)') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: an operation-ticket function that takes NO execution project still exists. R2-INT is reachable here; generalising the protocol on top of it would give five more categories a door around the attribution check.';
  END IF;

  -- stella_0016. This package REPLACES the five-argument conversion in place and
  -- charges through the ten-argument one it publishes. Without stella_0016 the
  -- five-argument signature does not exist, `CREATE OR REPLACE` would MINT it,
  -- and the database would hold a conversion whose caller — a `complete` that
  -- still charges through `consume_stella_quota` — re-competes for the unit its
  -- own bind reserved.
  IF to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: uellix_stella.settle_reserved_quota is absent — apply db/prepared/stella_0016_reserved_quota_semantics.sql first. This package republishes that body; it must not be the package that mints the signature.';
  END IF;

  IF to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: uellix_stella.stella_capacity is absent — apply db/prepared/stella_0016_reserved_quota_semantics.sql first. Every capacity decision in this campaign is that function''s; this package adds none of its own.';
  END IF;

  IF to_regprocedure('public.uellix_auth_uid()') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: auth.uid() not found. Every function here derives the actor from the session rather than from an argument.';
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'stella_0017 aborted: RLS helper public.current_user_org_ids() not found.';
  END IF;
END $$;

-- ============================================================
-- 1. The direct write, removed (superuser window)
-- ============================================================
-- STATED PER ROLE, AS FIXED LITERALS, GUARDED ON EXISTENCE. The static contract
-- in tests/helpers/sql-structure.ts refuses composed SQL rather than guessing at
-- it, so a loop over a role list with `format()` would be a statement no gate
-- can judge. The surrounding code decides WHETHER; it never decides WHAT.
--
-- The list is written over every principal that can reach a session in this
-- product, not only the ones that hold something today: a REVOKE for a privilege
-- nobody has is a no-op, and a missing REVOKE for a privilege somebody regains
-- is a reopened hole. `uellix_reader` is included and guarded because it exists
-- in some environments of this cluster and not in the restored baseline —
-- measured, not assumed (stella_0016 §7 (3) records the same discovery).
--
-- `uellix_writer` is the one that matters. Everything else is defence against a
-- future grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_reader') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_reader';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_auditor';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM authenticator';
  END IF;
END $$;

-- PUBLIC last and unconditionally: it is not a role that can be absent, and a
-- privilege held by PUBLIC is held by every principal above regardless of what
-- the statements before this one revoked from them by name.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM PUBLIC;

-- The two principals that keep writing, restated so a reader does not have to
-- infer them from an absence. `uellix_cap_stella_quota` is the only non-owner
-- role holding INSERT afterwards, and it holds it in order to be the function
-- that files a charge.
GRANT SELECT, INSERT ON public.stella_interactions TO uellix_cap_stella_quota;
REVOKE UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_quota;

-- ...and the ticket definer still reaches the ledger only by CALLING, never by
-- writing. Restated for the same reason stella_0015 §8 restated it: this package
-- publishes a function owned by that role which files a charge, and that is
-- exactly the kind of change that tempts a grant.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_ticket;

-- ============================================================
-- 2. The governed identity, as a property of the data (owner window)
-- ============================================================
SET ROLE uellix_owner;

-- Convergent BY DEFINITION and stated as a literal, same shape as stella_0013 §3
-- and for the same reason: a composed ALTER is a statement no gate can judge.
--
-- The constraint stella_0013 added — `stella_role <> 'grounded_query' OR
-- idempotency_key IS NOT NULL` — is left standing rather than replaced. It is
-- implied by this one and costs nothing, and dropping a published package's
-- constraint to install a superset is how a rollback stops being able to return
-- anywhere.
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.stella_interactions'::regclass
    AND c.conname = 'stella_interactions_governed_identity_check';

  IF current_def IS NULL OR position('idempotency_key IS NOT NULL' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE public.stella_interactions
        DROP CONSTRAINT stella_interactions_governed_identity_check;
    END IF;
    ALTER TABLE public.stella_interactions
      ADD CONSTRAINT stella_interactions_governed_identity_check
      CHECK (idempotency_key IS NOT NULL) NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT stella_interactions_governed_identity_check ON public.stella_interactions IS
  'R6-INT (prepared stella_0017): every unit charged from here on carries a server-minted operation identity. NOT VALID on purpose — rows filed before this package existed were filed by the direct write path and have no key, and validating against history would fail on exactly the rows this constraint exists to stop being created. Enforced on every INSERT and UPDATE, for the table owner as well, and not silenceable by session_replication_role.';

RESET ROLE;

-- ============================================================
-- 3. The conversion, carrying the row it files (superuser window)
-- ============================================================
-- TEN ARGUMENTS, five of which are the payload. Every one may be NULL, and an
-- all-NULL payload produces EXACTLY the row stella_0016 produced — the fixed
-- literal, `not-applicable`, the derived context digest, the category as the
-- pipeline step. That is what lets the five-argument signature become a
-- delegator instead of a second copy, and it is asserted in §5 rather than
-- claimed here.
--
-- NO LIMIT CHECK, unchanged from stella_0016 and for its reason: the unit was
-- committed at bind and has been counted against the cap ever since. Testing it
-- again would charge the organization twice for one commitment.
--
-- WHY THE PAYLOAD IS NOT A HOLE. It cannot choose the organization, the project,
-- the actor, the category, the identity or the period — those come from the
-- ticket row this function re-reads for itself, or from the session. It chooses
-- what the audit row SAYS about an interaction that has already been paid for,
-- which is precisely what `db.insert` chose before, under no supervision at all.
CREATE OR REPLACE FUNCTION uellix_stella.settle_reserved_quota(
  p_organization_id uuid,
  p_project_id uuid,
  p_stella_role varchar(50),
  p_idempotency_key char(64),
  p_ticket_id char(64),
  p_pipeline_step varchar(100),
  p_context_hash char(64),
  p_model_used varchar(100),
  p_tokens_used integer,
  p_response_json jsonb
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
  v_step     varchar(100);
  v_hash     varchar(64);
  v_model    varchar(100);
  v_body     jsonb;
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
  -- The context digest, when supplied, is a DIGEST. A column that may hold any
  -- 64 characters is a column that may hold a fragment of the question, and this
  -- function is the last place that can refuse one.
  IF p_context_hash IS NOT NULL AND p_context_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella settle: the context digest must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;
  IF p_tokens_used IS NOT NULL AND p_tokens_used < 0 THEN
    RAISE EXCEPTION 'stella settle: the token count cannot be negative' USING ERRCODE = 'U0100';
  END IF;

  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';
  END IF;

  -- THE PROOF, unchanged from stella_0016 §5. Named columns, never a star: this
  -- role's column grant deliberately excludes the nonce and the query digest, so
  -- a `SELECT *` here would not merely be untidy — it would fail.
  SELECT t.organization_id, t.project_id, t.category, t.status, t.expires_at
    INTO v_org, v_project, v_category, v_status, v_expires
  FROM uellix_stella_ops.operation_tickets t
  WHERE t.ticket_id = p_ticket_id;

  -- ONE answer for every way the reservation can fail to be one.
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

  -- Serialise against every reservation and every charge for this organization,
  -- so the INSERT below and the caller's UPDATE of the ticket to `completed`
  -- become visible to a competing capacity check as ONE move.
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

  -- THE PAYLOAD, resolved. Every default is the value stella_0016 wrote, so a
  -- caller that supplies nothing gets the row stella_0016 produced.
  v_step  := COALESCE(p_pipeline_step, p_stella_role);
  v_model := COALESCE(p_model_used, 'not-applicable');
  v_body  := COALESCE(p_response_json, '{"kind":"quota_consumption","version":1}'::jsonb);
  v_hash  := COALESCE(
    p_context_hash,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'stella/quota/v1' || chr(10) || p_organization_id::text || chr(10)
          || p_stella_role || chr(10) || p_idempotency_key,
        'UTF8')),
      'hex'));

  INSERT INTO public.stella_interactions (
    organization_id, project_id, created_by, stella_role, pipeline_step,
    context_hash, response_json, model_used, tokens_used, idempotency_key
  )
  VALUES (
    p_organization_id,
    p_project_id,
    v_actor,
    p_stella_role,
    v_step,
    v_hash,
    v_body,
    v_model,
    p_tokens_used,
    p_idempotency_key
  )
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Zero rows means a concurrent transaction filed this exact key between the
  -- replay check and here. The advisory lock makes that unreachable for two
  -- callers of the governed functions; the conflict clause is what keeps the
  -- guarantee a property of the DATA rather than of who happened to call what.
  IF v_inserted = 0 THEN
    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'consumed'::text, v_cap.consumed + 1, v_cap.limit_units;
END;
$$;

-- ------------------------------------------------------------
-- 3b. The five-argument signature, REPLACED IN PLACE by a delegator
-- ------------------------------------------------------------
-- Same name, same argument names, same types, same return — so CREATE OR REPLACE
-- accepts it, no signature is dropped, no grant is reissued, and
-- `STELLA_0016_INSTALLED_PROBE` in db/prepared-package-order.ts keeps resolving
-- the function it was written over. Dropping this signature would have silently
-- disarmed the guard that stops stella_0015 being re-applied over stella_0016.
--
-- It is a DELEGATOR and not a copy, and that is the point: one INSERT into the
-- ledger from this schema, reached by two arities. A second body would be a
-- second place for the idempotency semantics to drift.
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
BEGIN
  RETURN QUERY
  SELECT c.outcome, c.used, c.quota
  FROM uellix_stella.settle_reserved_quota(
    p_organization_id, p_project_id, p_stella_role, p_idempotency_key, p_ticket_id,
    NULL::varchar(100), NULL::char(64), NULL::varchar(100), NULL::integer, NULL::jsonb) c;
END;
$$;

-- ============================================================
-- 4. The sibling completion verb (superuser window)
-- ============================================================
-- THE SAME NAME. `complete_operation_ticket` is the verb that settles a ticket,
-- and a `complete_stella_interaction` next to it would be a second protocol with
-- a different vocabulary for the same lifecycle — which is what "no crees cinco
-- sistemas diferentes" refuses. The first three arguments are identical and in
-- the same positions, so a reader comparing the two overloads is comparing two
-- lists in the same order.
--
-- WHAT IT DOES NOT ADD. No capacity decision (that was made at bind), no second
-- reservation, no state the three-argument verb does not have, and no argument
-- that can move the charge: the organization, the project, the actor and the
-- category all come from the ticket row read under the row lock.
--
-- THE context_hash. The three-argument verb lets `settle_reserved_quota` derive
-- one; this verb files the digest the ticket was BOUND to. That digest was fixed
-- exactly once, server-side, and `stella_0014` §4 refuses an UPDATE that changes
-- it — so the ledger's `context_hash` becomes re-derivable from the ticket
-- instead of being a value that arrived with the request, which is what it was
-- when `db.insert` supplied it.
CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(
  p_ticket_id char(64),
  p_expected_project_id uuid,
  p_query_hash char(64),
  p_pipeline_step varchar(100),
  p_model_used varchar(100),
  p_tokens_used integer,
  p_response_json jsonb
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
  IF p_tokens_used IS NOT NULL AND p_tokens_used < 0 THEN
    RAISE EXCEPTION 'stella ticket: the token count cannot be negative' USING ERRCODE = 'U0100';
  END IF;

  v_actor := public.uellix_auth_uid();
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

  -- R2-INT, checked BEFORE the replay short-circuit. A completed ticket
  -- presented from another project must not be answered `replayed`.
  IF v_project IS DISTINCT FROM p_expected_project_id THEN
    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';
  END IF;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'stella ticket: the ticket was never bound to a query' USING ERRCODE = 'U0109';
  END IF;
  IF v_hash <> p_query_hash THEN
    RAISE EXCEPTION 'stella ticket: this ticket is bound to a different query' USING ERRCODE = 'U0107';
  END IF;

  -- RETRY AFTER COMPLETE. The same ticket presented again reports what already
  -- happened and charges nothing — including when the retry now carries a
  -- DIFFERENT payload, which is the shape a re-run of a non-deterministic model
  -- takes. The unit was already filed; a second row would be a second charge and
  -- an overwrite would edit an append-only trail.
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
  -- and no function returns — so the identity this charge lands under is not a
  -- field in the request, not a digest of the request, and not anything the
  -- caller can choose, replay or pre-compute. Identical derivation to the
  -- three-argument verb, on purpose: one ticket is one unit whichever verb
  -- settles it, and two derivations would let the same ticket charge twice.
  v_key := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'stella/ticket/charge/v1' || chr(10) || p_ticket_id || chr(10) || v_nonce,
      'UTF8')),
    'hex');

  -- THE CONVERSION, carrying the audit row. `v_project` and `v_category` are the
  -- columns read under the row lock; `v_hash` is the digest fixed at bind. The
  -- payload arguments are the only values that come from the caller, and none of
  -- them can move the charge.
  SELECT c.outcome, c.used, c.quota INTO v_charge
  FROM uellix_stella.settle_reserved_quota(
    v_org, v_project, v_category, v_key, p_ticket_id,
    p_pipeline_step, v_hash, p_model_used, p_tokens_used, p_response_json) c;

  -- The settle raises U0111 rather than returning a refusal, so reaching here
  -- means the unit is filed. The UPDATE and that INSERT are in ONE transaction.
  UPDATE uellix_stella_ops.operation_tickets t
  SET status = 'completed', completed_at = v_now
  WHERE t.ticket_id = p_ticket_id;

  RETURN QUERY SELECT 'completed'::text, v_charge.used, v_charge.quota;
END;
$$;

-- ------------------------------------------------------------
-- 4b. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb)
  OWNER TO uellix_cap_stella_quota;
ALTER FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))
  OWNER TO uellix_cap_stella_quota;
ALTER FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb)
  OWNER TO uellix_cap_stella_ticket;

-- REVOKE BEFORE GRANT, on every one. A CREATE OR REPLACE keeps the previous ACL,
-- so a package that only granted would be unable to narrow what a prior revision
-- handed out.
REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb) FROM PUBLIC;

-- The conversion charges WITHOUT evaluating the limit, so who may execute it IS
-- the security property. Both arities go to the ticket definer and to NOBODY
-- else — not uellix_app, not PUBLIC. §5 asserts the absence as well as the
-- presence: an ungranted privilege and a revoked one read the same in a
-- catalogue only if somebody checks.
GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb)
  TO uellix_cap_stella_ticket;
GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))
  TO uellix_cap_stella_ticket;

-- ...and the verb the runtime calls.
GRANT EXECUTE ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb)
  TO uellix_app;

COMMENT ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb) IS
  'R6-INT (prepared stella_0017): converts a LIVE reservation into a charge and files the interaction row it pays for. Evaluates NO limit — the unit was committed at bind. Re-proves the ticket is bound, unexpired and welded to the organization, project and category it is asked to charge; raises U0111 otherwise. An all-NULL payload reproduces exactly the row stella_0016 filed. Granted to uellix_cap_stella_ticket ONLY.';
COMMENT ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) IS
  'R6-INT (prepared stella_0017): the five-argument conversion stella_0016 published, now a DELEGATOR to the ten-argument one with a NULL payload. Same name, same signature, same behaviour, same grant — kept so that the supersession probe in db/prepared-package-order.ts keeps resolving it, and so that this schema holds one INSERT into the ledger rather than two.';
COMMENT ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb) IS
  'R6-INT (prepared stella_0017): the completion verb for the sibling Stella categories. Settles a bound ticket, converts its reservation through uellix_stella.settle_reserved_quota and files the interaction payload the five server actions write today. Identical scope, project (U0110), digest (U0107), liveness (U0108) and replay semantics to the three-argument verb; the payload cannot move the charge, and a retry after completion returns `replayed` even when it carries a different payload.';

-- ============================================================
-- 5. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  tbl_oid oid;
  problem text;
  def     text;
  n       int;
BEGIN
  tbl_oid := to_regclass('public.stella_interactions');

  -- (1) NO RUNTIME PRINCIPAL CAN WRITE THE LEDGER. Asked with
  --     `has_table_privilege`, which FOLLOWS role membership — the whole defect
  --     is that `uellix_app` holds nothing directly and can write anyway. A
  --     check written over `relacl` would report this table clean while the
  --     inherited INSERT stood.
  SELECT string_agg(x.rolname || ':' || x.priv, ', ' ORDER BY x.rolname || ':' || x.priv) INTO problem
  FROM (
    SELECT r.rolname, p.priv
    FROM pg_roles r
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
    WHERE r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_reader', 'uellix_auditor',
                        'authenticated', 'anon', 'service_role', 'authenticator')
      AND has_table_privilege(r.oid, tbl_oid, p.priv)
  ) x;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: runtime principal(s) can still write the ledger: %. A governed consumption path next to a standing direct grant is a governed path nobody has to use', problem;
  END IF;

  -- (1b) ...and the same question asked exhaustively, over every role in the
  --      cluster that is not a superuser, not the owner and not the one
  --      capability role that files charges. A named list can be outrun by a
  --      role somebody adds; this cannot.
  SELECT string_agg(x.rolname, ', ' ORDER BY x.rolname) INTO problem
  FROM (
    SELECT DISTINCT r.rolname
    FROM pg_roles r
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
    WHERE NOT r.rolsuper
      AND r.rolname <> 'uellix_owner'
      AND r.rolname <> 'uellix_cap_stella_quota'
      AND r.rolname NOT LIKE 'pg\_%'
      AND has_table_privilege(r.oid, tbl_oid, p.priv)
  ) x;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: role(s) % hold a write privilege on the ledger. Only the table owner and uellix_cap_stella_quota may, and the second only in order to BE the governed function', problem;
  END IF;

  -- (2) ...and the capability role that DOES write still cannot erase. An
  --      append-only compliance trail whose writer can UPDATE is not one.
  IF NOT has_table_privilege('uellix_cap_stella_quota', tbl_oid, 'INSERT') THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: uellix_cap_stella_quota cannot INSERT into the ledger, so no governed function can charge anything at all';
  END IF;
  SELECT string_agg(p.priv, ', ' ORDER BY p.priv) INTO problem
  FROM (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
  WHERE has_table_privilege('uellix_cap_stella_quota', tbl_oid, p.priv);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: uellix_cap_stella_quota holds % on the ledger', problem;
  END IF;

  -- (3) The ticket definer reaches the ledger only by CALLING. It owns a
  --     function that files a charge now, which is exactly when this stops being
  --     obvious.
  SELECT string_agg(p.priv, ', ' ORDER BY p.priv) INTO problem
  FROM (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
  WHERE has_table_privilege('uellix_cap_stella_ticket', tbl_oid, p.priv);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: uellix_cap_stella_ticket holds % on the ledger. It must reach it only through uellix_stella.settle_reserved_quota', problem;
  END IF;

  -- (4) THE CONSTRAINT THAT SURVIVES A RE-GRANT. Present, over the right column,
  --     and NOT VALID — a VALIDATED one would mean somebody validated it against
  --     history that cannot satisfy it, which can only have happened by deleting
  --     rows from an append-only ledger.
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conrelid = tbl_oid AND c.conname = 'stella_interactions_governed_identity_check';
  IF def IS NULL OR position('idempotency_key IS NOT NULL' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: stella_interactions_governed_identity_check is absent or does not require an operation identity (%)', coalesce(def, '<absent>');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid AND c.conname = 'stella_interactions_governed_identity_check'
      AND c.contype = 'c' AND NOT c.convalidated
  ) THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: stella_interactions_governed_identity_check is VALIDATED. Every row filed before this package carries no key, so a validated constraint means rows were removed from an append-only trail to make it pass';
  END IF;

  -- (4b) stella_0013's narrower constraint is still standing. This package adds
  --      a superset and drops nothing: a rollback that had to recreate a
  --      constraint another package owns is a rollback that cannot converge.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid
      AND c.conname = 'stella_interactions_grounded_query_idempotency_check'
      AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: stella_0013''s grounded_query idempotency CHECK is gone. This package adds a superset; it does not get to remove another package''s constraint';
  END IF;

  -- (5) RLS IS STILL ON. It is not the barrier — §1 is — but PostgreSQL refuses
  --     `COPY … FROM` on a table with row level security, and that second
  --     barrier disappears silently if RLS is ever turned off.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = tbl_oid AND relrowsecurity) THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: row level security is not enabled on stella_interactions. Beyond the policies, its absence would re-enable COPY FROM for any principal that regained INSERT';
  END IF;

  -- (6) The three published functions exist, by EXACT signature.
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO problem
  FROM (VALUES
    ('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)'),
    ('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)'),
    ('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)')
  ) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: signature(s) % are absent', problem;
  END IF;

  -- (7) THE FIVE-ARGUMENT CONVERSION IS A DELEGATOR, not a copy. Asserted on the
  --     body, because a second INSERT that happened to agree today is a second
  --     place for the idempotency semantics to drift tomorrow.
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)')) INTO def;
  IF position('uellix_stella.settle_reserved_quota(' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the five-argument settle_reserved_quota does not delegate';
  END IF;
  IF position('INSERT INTO public.stella_interactions' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the five-argument settle_reserved_quota still writes the ledger itself. Two writers in one schema are two sets of idempotency semantics';
  END IF;

  -- (8) THE SIBLING VERB CHARGES THROUGH THE CONVERSION and nowhere else. A verb
  --     that wrote the ledger directly would satisfy every privilege assertion
  --     above — it runs as a role that may — and would skip the reservation
  --     proof entirely.
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)')) INTO def;
  IF position('uellix_stella.settle_reserved_quota' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the sibling complete_operation_ticket does not charge through settle_reserved_quota';
  END IF;
  IF position('INSERT INTO public.stella_interactions' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the sibling complete_operation_ticket writes the ledger directly, going around the governed path';
  END IF;
  IF position('uellix_stella.consume_stella_quota' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the sibling complete_operation_ticket charges through consume_stella_quota, which evaluates the limit against charged rows only — so completing competes again for the unit bind already reserved. That is R1';
  END IF;
  -- R2-INT must hold for the new verb as much as for the old one.
  IF position('v_project IS DISTINCT FROM p_expected_project_id' in def) = 0
     OR position('U0110' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the sibling complete_operation_ticket does not compare the ticket project against the execution project and raise U0110';
  END IF;
  -- The charge key must come from the ticket and the nonce, never from the
  -- payload. A verb that derived it from what the caller sent would let two
  -- different operations collapse onto one charge, or one retry become two.
  IF position('stella/ticket/charge/v1' in def) = 0
     OR position('v_nonce' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the sibling complete_operation_ticket does not derive its idempotency key from the ticket and the charge nonce';
  END IF;
  IF position('p_response_json' in def) > position('v_key := ' in def)
     AND position('sha256' in def) > position('p_response_json' in def) THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the payload appears inside the key derivation. Content-derived idempotency makes two legitimately identical operations one charge';
  END IF;

  -- (9) THE GRANT THAT IS THE BOUNDARY. Neither arity of the conversion may be
  --     reachable by a runtime principal: it files a unit without evaluating the
  --     limit, so EXECUTE on it is a charge past the cap for any ticket the
  --     caller can name.
  --
  --     Driven from pg_roles rather than from a VALUES list filtered by an
  --     EXISTS: `has_function_privilege` RAISES on a role that does not exist,
  --     and a planner is free to evaluate the two clauses in either order.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO problem
  FROM pg_roles r
  WHERE r.rolname IN ('uellix_app', 'authenticated', 'anon', 'service_role',
                      'uellix_writer', 'uellix_reader', 'uellix_auditor')
    AND (has_function_privilege(r.oid, to_regprocedure(
           'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)'), 'EXECUTE')
         OR has_function_privilege(r.oid, to_regprocedure(
           'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)'), 'EXECUTE'));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: % can execute settle_reserved_quota. That function files a unit WITHOUT evaluating the limit', problem;
  END IF;

  IF NOT has_function_privilege('uellix_cap_stella_ticket', to_regprocedure(
       'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: uellix_cap_stella_ticket cannot execute the payload-carrying conversion, so no ticket can be completed at all';
  END IF;

  IF NOT has_function_privilege('uellix_app', to_regprocedure(
       'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: uellix_app cannot execute the sibling completion verb, so the five actions have nothing to migrate to';
  END IF;

  -- (10) The schema-wide contracts of stella_0013 and stella_0014 still hold
  --      over everything this package added. Written over the WHOLE schema, as
  --      those packages write them, so a function added here later cannot arrive
  --      unjudged either. Both spellings of the empty search_path.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname IN ('uellix_stella', 'uellix_stella_ops')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE (ns.nspname = 'uellix_stella'     AND pg_get_userbyid(p.proowner) <> 'uellix_cap_stella_quota')
     OR (ns.nspname = 'uellix_stella_ops' AND pg_get_userbyid(p.proowner) <> 'uellix_cap_stella_ticket');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: function(s) % are owned by the wrong capability role', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname IN ('uellix_stella', 'uellix_stella_ops') AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  -- (10b) No function of either schema RETURNS the nonce or the query digest.
  --       stella_0015 §4 (9) makes this assertion over uellix_stella_ops and a
  --       new overload is exactly the moment it stops being true by accident.
  SELECT string_agg(q.proname, ', ' ORDER BY q.proname) INTO problem
  FROM (SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname IN ('uellix_stella', 'uellix_stella_ops') OFFSET 0) q
  WHERE pg_get_function_result(q.oid) ~ '\mcharge_nonce\M'
     OR pg_get_function_result(q.oid) ~ '\mquery_hash\M';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: % returns the charge nonce or the query digest', problem;
  END IF;

  -- (11) uellix_stella_ops now publishes SEVEN functions and no more: the six
  --      stella_0015 left plus the sibling verb. Asserted so that an eighth
  --      cannot arrive unreviewed, and so the supersessions registered in
  --      db/prepared-package-order.ts are measured against a number rather than
  --      a memory.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops';
  IF n <> 7 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: uellix_stella_ops holds % function(s) instead of 7', n;
  END IF;

  -- (12) Every overload of `complete_operation_ticket` still takes the execution
  --      project, without a DEFAULT. stella_0015 §4 (3)/(3b) assert this over the
  --      NAME, so the new overload has to satisfy it or that package could never
  --      be re-applied even after a rollback of this one.
  SELECT string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ')', ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella_ops'
    AND p.proname IN ('bind_operation_ticket', 'complete_operation_ticket',
                      'abort_operation_ticket', 'inspect_operation_ticket')
    AND (pg_get_function_arguments(p.oid) NOT LIKE '%p_expected_project_id uuid%'
         OR p.pronargdefaults > 0);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: % either takes no p_expected_project_id or declares a DEFAULT, so the execution project can be omitted at the call site', problem;
  END IF;

  -- (13) The three-argument verb and the ticketless surface are UNTOUCHED — the
  --      grounded path this package must not disturb. Measured on the property
  --      each was published for, not on a checksum.
  SELECT pg_get_functiondef(to_regprocedure(
    'uellix_stella_ops.complete_operation_ticket(character, uuid, character)')) INTO def;
  IF position('uellix_stella.settle_reserved_quota' in def) = 0
     OR position('uellix_stella.consume_stella_quota' in def) > 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: the three-argument complete_operation_ticket no longer converts its reservation. This package must not disturb the grounded path';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('uellix_stella.stella_capacity(uuid, character)')) INTO def;
  IF position('v_limit - v_consumed - v_reserved' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0017 FAILED verification: stella_capacity no longer subtracts live reservations. Every capacity decision in this campaign is that function''s';
  END IF;

  RAISE NOTICE 'stella_0017: verification passed — no runtime principal holds INSERT/UPDATE/DELETE/TRUNCATE on the ledger (asked through role membership, exhaustively over pg_roles), a NOT VALID governed-identity CHECK that binds the owner and survives a re-grant, RLS still on so COPY FROM stays refused, a payload-carrying settle_reserved_quota granted only to uellix_cap_stella_ticket with the five-argument signature delegating to it, one sibling complete_operation_ticket that charges only through the conversion and derives its key from the ticket nonce, uellix_stella_ops at exactly 7 functions all project-bound and default-free, and the grounded path untouched.';
END $$;
