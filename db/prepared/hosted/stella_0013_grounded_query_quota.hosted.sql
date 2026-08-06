-- ============================================================================
-- stella_0013_grounded_query_quota — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/stella_0013_grounded_query_quota.sql
-- Source SHA-256 (LF-normalized): 9fdcf86e694989b53964de169a340a12f1f7c22348eb1c1d5194bfbc6192e189
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
--   auth-uid-call: 2
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/stella_0013_grounded_query_quota.sql
-- INT-CAP-001 — a governed, transactional, idempotent quota consumption path
-- for `grounded_query`.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0013_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-cap-001
-- RESPONSE:  docs/ops/contracts/CAP-TRAIN4-001_grounded_query_quota_response.md
-- SOURCE OF TRUTH: the objects here are managed outside the drizzle chain on
-- purpose — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED.
--
-- ============================================================================
-- WHAT INT-CAP-001 ACTUALLY ASKS FOR, AND WHY THE CHECK IS THE SMALL HALF
-- ============================================================================
-- The contract asks for one thing by name: add `grounded_query` to
-- `stella_interactions_stella_role_check`. That alone would make the row
-- REPRESENTABLE and would still leave the capability unable to CHARGE, because
-- the gap integration reported is not only a vocabulary gap:
--
--   * `checkStellaQuota` (lib/stella/quota.ts) READS a count and returns; the
--     decision and the write are two statements with no transaction between
--     them, so two concurrent callers both observe `used = quota - 1` and both
--     proceed. A vocabulary that permits the row does not serialise the two.
--
--   * A retried server action must not charge twice. Nothing in
--     `stella_interactions` identifies "the same operation" — `context_hash`
--     is the hash of an interaction's CONTEXT and legitimately repeats.
--
--   * A caller that supplies its own organization could charge another
--     tenant's ledger. The read path re-imposes the boundary; the write path
--     had none, because there was no write path.
--
-- So this package ships the vocabulary AND the mechanism that makes the
-- vocabulary chargeable: one governed function, one transaction, one advisory
-- lock per organization, one idempotency key with a unique index behind it.
--
-- ============================================================================
-- WHY THIS EXTENDS stella_interactions INSTEAD OF ADDING A SECOND LEDGER
-- ============================================================================
-- `checkStellaQuota` counts rows of `stella_interactions` for the current UTC
-- month and compares against `organizations.stella_monthly_quota`. A second
-- table would have to be counted TOO, by an edit to a function five other
-- Stella actions already depend on — and until every one of them migrated, the
-- enforced quota and the charged quota would be two different numbers.
--
-- One unit of quota is one row of this table. That is already true for the
-- five sibling actions; this package makes it true for the sixth as well.
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
  --   stella_0013 aborted: must run as a SUPERUSER (current_user=%). It creates a role, transfers function ownership to it, and grants USAGE on schema auth — none of which uellix_owner can do.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0013_grounded_query_quota');

  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: table public.stella_interactions is absent — this database is not at the expected migration baseline (db/migrations/0012_stella_interactions.sql).';
  END IF;

  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: organizations, projects or users is missing — this database is not at the expected migration baseline.';
  END IF;

  -- The quota column the ledger is measured against. Without it there is no
  -- limit to check and this package would install a consumption path that
  -- consumes against nothing.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations'
      AND column_name = 'stella_monthly_quota'
  ) THEN
    RAISE EXCEPTION 'stella_0013 aborted: public.organizations.stella_monthly_quota is absent — there is no limit for a consumption path to enforce.';
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: RLS helpers not found — apply db/migrations/0031_rls_core.sql first.';
  END IF;

  IF to_regprocedure('public.uellix_auth_uid()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: auth.uid() not found. The governed function derives created_by from the session rather than from an argument, and without it there is no session to derive from.';
  END IF;

  IF to_regprocedure('public.uellix_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: function public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first.';
  END IF;

  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('uellix_owner'), ('uellix_app'), ('uellix_auditor'),
               ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: missing role(s): %.', missing_roles;
  END IF;
END $$;

-- ============================================================
-- 1. Capability role and schema (superuser window)
-- ============================================================
-- NOLOGIN, ZERO members. Same posture as uellix_cap_grounding and for the same
-- reason: with no members, no LOGIN role reaches its privileges by SET ROLE,
-- so `uellix_migrator` (a LOGIN role that reaches uellix_owner) is not a path
-- into the quota ledger's write privilege.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stella_quota') THEN
    EXECUTE 'CREATE ROLE uellix_cap_stella_quota';
  END IF;
END $$;

-- Stated unconditionally so a re-run converges even if someone widened them.
ALTER ROLE uellix_cap_stella_quota
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- A schema of its own, not `uellix_capability`: the five public-capability
-- packages drop that schema in their rollbacks as soon as it is empty, so
-- sharing it would couple this rollback's order to a campaign it does not
-- depend on. Same argument grounding_0002 §1 makes for uellix_grounding.
CREATE SCHEMA IF NOT EXISTS uellix_stella AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_stella FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_stella TO uellix_app;
GRANT USAGE ON SCHEMA uellix_stella TO uellix_cap_stella_quota;

-- The definer needs EXECUTE on the RLS helpers it calls. They are themselves
-- SECURITY DEFINER owned by uellix_owner and read the CALLER's auth.uid(), so
-- granting EXECUTE confers no data: for a caller with no session they return
-- the empty set and this function then refuses.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_stella_quota;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_stella_quota;

-- USAGE on schema auth so `auth.uid()` RESOLVES — nothing more. The same
-- narrow grant stella_0004 §"auth" makes for uellix_owner, and §9 below
-- asserts what it does NOT confer: this role cannot read auth.users. The
-- alternative — re-implementing auth.uid()'s `current_setting` expression
-- inline — would be a second copy of the identity derivation, which drifts.
-- HOSTED VARIANT (Train 5B, generated): the two grants this replaces are not issuable
-- on managed Supabase — `postgres` holds USAGE on schema auth WITHOUT GRANT OPTION.
-- EXECUTE on the bootstrap shim is the narrowest equivalent: it resolves the session
-- actor and confers nothing else. auth.users stays unreachable, asserted below.
GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO uellix_cap_stella_quota;

-- The three business tables the definer reads, SELECT and only SELECT.
--
-- No UPDATE on organizations, and that is a deliberate design constraint on
-- the function rather than an oversight: serialising two concurrent
-- consumptions with `SELECT ... FOR UPDATE` on the organization row would
-- require UPDATE privilege on public.organizations, and widening a business
-- table's write surface to make a lock convenient is exactly how a boundary
-- stops meaning anything. The function takes a transaction-scoped ADVISORY
-- lock instead — same mutual exclusion, no privilege at all. Same repair
-- grounding_0002's register_document_version already carries.
GRANT SELECT ON public.organizations TO uellix_cap_stella_quota;
GRANT SELECT ON public.projects      TO uellix_cap_stella_quota;

-- SELECT to count the month, INSERT to charge. Never UPDATE, never DELETE,
-- never TRUNCATE: this is an append-only compliance trail, and a consumption
-- path that could erase a consumption is not one.
GRANT SELECT, INSERT ON public.stella_interactions TO uellix_cap_stella_quota;
REVOKE UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_quota;

-- ============================================================
-- 2. The idempotency key (owner window)
-- ============================================================
SET ROLE uellix_owner;

-- NULLABLE, because the five sibling Stella actions write rows through the
-- ordinary runtime path and have no key to supply. NOT NULL would make this
-- package a breaking change to five working flows for the benefit of a sixth.
--
-- The biconditional that matters is stated as a CHECK below instead: a
-- `grounded_query` row MUST carry a key. So the column is nullable in general
-- and mandatory exactly where idempotency is a requirement.
ALTER TABLE public.stella_interactions
  ADD COLUMN IF NOT EXISTS idempotency_key char(64);

COMMENT ON COLUMN public.stella_interactions.idempotency_key IS
  'INT-CAP-001 (prepared stella_0013): caller-chosen, server-verified operation identity for quota consumption. NULL for the five pre-existing Stella roles; mandatory for grounded_query. Uniqueness is scoped to the organization by uq_stella_interactions_idempotency.';

-- ============================================================
-- 3. Constraint reconciliation — convergent, by DEFINITION
-- ============================================================
-- Every statement is a LITERAL. The static contract in
-- tests/helpers/sql-structure.ts refuses dynamic SQL rather than guessing at
-- it, so a composed ALTER would be a statement no gate can judge.
DO $$
DECLARE
  current_def text;
BEGIN
  -- 3a. The role vocabulary. SEVEN values: the six that db/schema.ts declares
  --     plus `grounded_query`, which is what INT-CAP-001 asks for by name.
  --
  --     Matched on the QUOTED literals as pg_get_constraintdef prints them — a
  --     bare substring match would be satisfied by a superstring role (a
  --     hypothetical 'super_advisor' satisfies LIKE '%advisor%' without
  --     'advisor' being in the set). Same reasoning as stella_0002 §3, which
  --     this reconciliation supersedes for the same constraint.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.stella_interactions'::regclass
    AND c.conname = 'stella_interactions_stella_role_check';

  IF current_def IS NULL
     OR current_def NOT LIKE '%''advisor''%'
     OR current_def NOT LIKE '%''validator''%'
     OR current_def NOT LIKE '%''composer''%'
     OR current_def NOT LIKE '%''proxy_reviewer''%'
     OR current_def NOT LIKE '%''evidence_reviewer''%'
     OR current_def NOT LIKE '%''audit_assistant''%'
     OR current_def NOT LIKE '%''grounded_query''%'
  THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE public.stella_interactions
        DROP CONSTRAINT stella_interactions_stella_role_check;
    END IF;
    ALTER TABLE public.stella_interactions
      ADD CONSTRAINT stella_interactions_stella_role_check
      CHECK (stella_role IN ('advisor', 'validator', 'composer', 'proxy_reviewer',
                             'evidence_reviewer', 'audit_assistant', 'grounded_query'));
  END IF;

  -- 3b. Shape. A key that is not a lowercase-hex SHA-256 is not an identity a
  --     second caller could have computed independently, and the whole point
  --     of an idempotency key is that the retry computes the SAME one.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.stella_interactions'::regclass
    AND c.conname = 'stella_interactions_idempotency_key_shape_check';

  IF current_def IS NULL OR position('^[0-9a-f]{64}$' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE public.stella_interactions
        DROP CONSTRAINT stella_interactions_idempotency_key_shape_check;
    END IF;
    ALTER TABLE public.stella_interactions
      ADD CONSTRAINT stella_interactions_idempotency_key_shape_check
      CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$');
  END IF;

  -- 3c. Mandatory exactly where it is required.
  --
  --     This is the constraint that makes the guarantee survive the direct
  --     write path. `uellix_app` INHERITS `uellix_writer`, which holds
  --     SELECT, INSERT on this table (db/baseline/stella_g2_roles.sql:223,
  --     db/baseline/stella_g2_schema.sql:11321), so the governed function is
  --     not the only way a row can land here — that direct grant is the
  --     canonical mechanism the five sibling actions use and this package does
  --     not get to revoke it. What it CAN do is make the direct path unable to
  --     charge a `grounded_query` unit without an identity, and (with the
  --     unique index below) unable to charge the same identity twice.
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.stella_interactions'::regclass
    AND c.conname = 'stella_interactions_grounded_query_idempotency_check';

  IF current_def IS NULL
     OR position('grounded_query' in current_def) = 0
     OR position('idempotency_key IS NOT NULL' in current_def) = 0 THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE public.stella_interactions
        DROP CONSTRAINT stella_interactions_grounded_query_idempotency_check;
    END IF;
    ALTER TABLE public.stella_interactions
      ADD CONSTRAINT stella_interactions_grounded_query_idempotency_check
      CHECK (stella_role <> 'grounded_query' OR idempotency_key IS NOT NULL);
  END IF;
END $$;

-- ============================================================
-- 4. The uniqueness that makes a retry free
-- ============================================================
-- PARTIAL, and scoped to the ORGANIZATION rather than global: a key is chosen
-- by the caller, and two tenants that independently derive the same digest
-- must not collide across a boundary neither of them can see. Scoped to the
-- organization the collision domain is exactly the ledger being charged.
--
-- Idempotent by name; never dropped and re-added, for the same reason §3
-- refuses to replace a CHECK it cannot read.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stella_interactions_idempotency
  ON public.stella_interactions (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO def
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.stella_interactions'::regclass
    AND c.relname = 'uq_stella_interactions_idempotency';

  IF def IS NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: the idempotency index was not created';
  END IF;
  IF position('UNIQUE INDEX' in def) = 0
     OR position('idempotency_key IS NOT NULL' in def) = 0
     OR position('organization_id, idempotency_key' in def) = 0 THEN
    RAISE EXCEPTION
      'stella_0013 aborted: uq_stella_interactions_idempotency exists with an unexpected definition (%). A non-unique or unpredicated variant would silently drop the no-double-charge guarantee.',
      def;
  END IF;
END $$;

-- ============================================================
-- 5. RLS — the invariant, stated in the database
-- ============================================================
-- `stella_interactions_select_member_or_admin` (baseline) carries no TO
-- clause, so it already applies to this role: the definer counts only rows of
-- organizations the CALLER belongs to, because auth.uid() is unchanged by
-- SECURITY DEFINER. Nothing to add for reads.
--
-- Writes need their own policy: the baseline INSERT policy names uellix_app
-- and this role is not that. The predicate restates every invariant the
-- function upholds, so a future edit to the function cannot quietly drop one.
DROP POLICY IF EXISTS "stella_interactions_quota_definer_insert" ON public.stella_interactions;
CREATE POLICY "stella_interactions_quota_definer_insert"
ON public.stella_interactions FOR INSERT
TO uellix_cap_stella_quota
WITH CHECK (
  -- The actor is the session, not an argument.
  created_by = public.uellix_auth_uid()
  -- A charged row is an identified row.
  AND idempotency_key IS NOT NULL
  -- The ledger charged is one the caller belongs to. SECURITY DEFINER bypasses
  -- RLS on the tables the function reads under its own privileges, but a
  -- policy ON THIS TABLE binds the definer role itself, which holds no
  -- BYPASSRLS. This is the cross-organization boundary in the database.
  AND (organization_id = ANY(public.current_user_org_ids())
       OR public.current_user_is_super_admin())
  -- ...and the project charged belongs to the organization charged. Without
  -- this, a caller inside organization A could file a unit against a project
  -- of organization B while still satisfying the clause above.
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = stella_interactions.project_id
      AND p.organization_id = stella_interactions.organization_id
  )
);

RESET ROLE;

-- ============================================================
-- 6. The governed consumption path (superuser window)
-- ============================================================
-- ONE call that decides AND charges, inside the caller's transaction.
--
-- WHY IT RETURNS AN OUTCOME INSTEAD OF RAISING WHEN THE QUOTA IS SPENT
-- --------------------------------------------------------------------
-- "Exhausted" is an expected business state that the product renders as a
-- message with the reset date. Raising would abort the CALLER's transaction,
-- so an action that had already written an audit row would lose it — a
-- refusal to serve would silently become a refusal to record. Exceptions are
-- reserved for what they are for: malformed input (U0100), a scope the caller
-- may not touch (U0102), a category outside the governed vocabulary (U0106).
--
-- WHY ONE ADVISORY LOCK PER ORGANIZATION
-- --------------------------------------
-- Read-then-write without serialisation is the defect INT-CAP-001 reports:
-- two transactions both read `used = quota - 1` and both insert, and the
-- organization spends one unit more than it was sold. The lock is
-- transaction-scoped, so it is released by COMMIT or ROLLBACK with nothing to
-- remember, and it is keyed on a NAMESPACED digest of the organization id so
-- it cannot alias grounding_0002's evidence-item lock.
--
-- The second transaction therefore waits, and when it proceeds it takes a NEW
-- statement snapshot under READ COMMITTED, so it counts the row the first one
-- committed. That is the whole mechanism: the count is taken after the lock,
-- never before.
CREATE OR REPLACE FUNCTION uellix_stella.consume_stella_quota(
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
  -- The governed vocabulary, as a literal. §9 asserts this array and the CHECK
  -- constraint name the same set, so the two cannot drift into disagreeing
  -- about what is chargeable.
  v_governed  text[] := ARRAY['advisor', 'validator', 'composer', 'proxy_reviewer',
                              'evidence_reviewer', 'audit_assistant', 'grounded_query'];
  v_actor     uuid;
  v_quota     integer;
  v_used      integer;
  v_month     timestamp;
  v_existing  uuid;
  v_inserted  integer;
BEGIN
  -- Argument validation, before anything is read. The messages name the
  -- ARGUMENT, never a value: an error string is a channel, and an id echoed
  -- back to an untrusted caller is an oracle.
  IF p_organization_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION 'stella quota: organization and project are required' USING ERRCODE = 'U0100';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stella quota: the idempotency key must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';
  END IF;
  IF p_stella_role IS NULL OR NOT (p_stella_role = ANY(v_governed)) THEN
    RAISE EXCEPTION 'stella quota: that capability is not in the governed vocabulary' USING ERRCODE = 'U0106';
  END IF;

  -- The actor is DERIVED. There is no argument for it, so no caller can charge
  -- a unit in someone else's name, and the RLS policy in §5 re-checks the same
  -- equality against the row that lands.
  v_actor := public.uellix_auth_uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'stella quota: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- SECURITY DEFINER bypasses RLS on what this body reads, so the caller's
  -- boundary is re-imposed here explicitly. Same message as "not found":
  -- distinguishing them is a tenancy oracle.
  IF NOT (p_organization_id = ANY(public.current_user_org_ids())
          OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'stella quota: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- The project must belong to the organization being charged. Stated here and
  -- again in the RLS policy: a caller inside A must not spend A's quota on a
  -- project of B, and must not spend B's quota at all.
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'stella quota: organization not found' USING ERRCODE = 'U0102';
  END IF;

  -- Serialise every consumption for THIS organization. Namespaced so it cannot
  -- alias the evidence-item lock grounding_0002 takes with the same primitive.
  PERFORM pg_advisory_xact_lock(hashtextextended('stella/quota/' || p_organization_id::text, 0));

  -- The month boundary, in the same coordinate space lib/stella/quota.ts uses:
  -- `startOfCurrentUtcMonth()`. `created_at` is `timestamp` (no zone) filled by
  -- now(), so the two agree exactly when the server's TimeZone is UTC — which
  -- is Supabase's default and what every environment of this project runs.
  v_month := date_trunc('month', timezone('UTC', now()));

  -- REPLAY, checked under the lock. A retry of the same operation is free and
  -- reports the ledger as it stands; it does NOT report "consumed", because
  -- the caller asked whether it may proceed and the honest answer is "you
  -- already did".
  SELECT si.id INTO v_existing
  FROM public.stella_interactions si
  WHERE si.organization_id = p_organization_id
    AND si.idempotency_key = p_idempotency_key;

  SELECT count(*)::integer INTO v_used
  FROM public.stella_interactions si
  WHERE si.organization_id = p_organization_id
    AND si.created_at >= v_month;

  SELECT o.stella_monthly_quota INTO v_quota
  FROM public.organizations o
  WHERE o.id = p_organization_id;

  -- No readable organization row is the same answer as no membership: the
  -- SELECT above runs under the CALLER's RLS (orgs_select_member_or_admin
  -- carries no TO clause, so it binds this role too), which is a second,
  -- independent statement of the boundary checked above.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella quota: organization not found' USING ERRCODE = 'U0102';
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, v_used, v_quota;
    RETURN;
  END IF;

  -- NULL quota means no cap has been assigned/enforced; 0 means blocked. The
  -- two are different states and lib/stella/quota.ts already tells them apart.
  IF v_quota IS NOT NULL THEN
    IF v_quota = 0 THEN
      RETURN QUERY SELECT 'no_quota'::text, v_used, v_quota;
      RETURN;
    END IF;
    IF v_used >= v_quota THEN
      RETURN QUERY SELECT 'quota_exceeded'::text, v_used, v_quota;
      RETURN;
    END IF;
  END IF;

  -- The charge. Every column that is not derived from a validated argument is
  -- a fixed literal or a server-computed digest:
  --
  --   created_by     auth.uid()               — the session, never an argument
  --   pipeline_step  the governed category    — validated against v_governed
  --   context_hash   SHA-256 of a namespaced preimage over (org, role, key)
  --   response_json  a fixed literal          — NEVER a prompt, an answer or a
  --                                             passage; this row records that
  --                                             a unit was spent, nothing else
  --   model_used     'not-applicable'         — no model ran to spend a unit
  --
  -- pg_catalog.sha256 is a builtin, so no pgcrypto and no reference to the
  -- `extensions` schema from a function whose search_path is empty.
  -- convert_to pins UTF8 so the digest cannot depend on client_encoding. Same
  -- construction as grounding_0003's chunk_id derivation.
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

  -- Zero rows means a concurrent transaction charged this exact key between
  -- the replay check and here. The lock makes that unreachable for two callers
  -- of THIS function, but the direct write path (uellix_writer's INSERT grant)
  -- takes no such lock — so the conflict clause is what keeps the guarantee a
  -- property of the DATA rather than of who happened to call what.
  IF v_inserted = 0 THEN
    RETURN QUERY SELECT 'replayed'::text, v_used, v_quota;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'consumed'::text, v_used + 1, v_quota;
END;
$$;

-- ------------------------------------------------------------
-- 6b. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64))
  OWNER TO uellix_cap_stella_quota;

REVOKE ALL ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) TO uellix_app;

COMMENT ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) IS
  'INT-CAP-001: checks and consumes exactly one unit of an organization''s monthly Stella quota, in the caller''s transaction, under a per-organization advisory lock, idempotent on (organization_id, idempotency_key). Returns outcome/used/quota; raises only for malformed input (U0100), an out-of-scope organization (U0102) or an ungoverned capability (U0106).';

-- ============================================================
-- 7. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  tbl_oid oid;
  fn_oid  oid;
  problem text;
  def     text;
  n       int;
BEGIN
  tbl_oid := to_regclass('public.stella_interactions');

  -- Looked up by NAME in the catalogue rather than through to_regprocedure:
  -- that function needs the argument list spelled exactly as PostgreSQL
  -- normalises it (`character varying`, `character`), and a spelling mistake
  -- returns NULL — which reads as "the function is missing" and would fail
  -- this script for a reason that is not true.
  SELECT p.oid INTO fn_oid
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella' AND p.proname = 'consume_stella_quota';

  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: uellix_stella.consume_stella_quota does not exist after the script ran';
  END IF;

  -- (1) The vocabulary actually admits grounded_query. This is the literal ask
  --     of INT-CAP-001 and it is asserted, not assumed.
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conrelid = tbl_oid AND c.conname = 'stella_interactions_stella_role_check';
  IF def IS NULL OR position('''grounded_query''' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: stella_interactions_stella_role_check does not admit grounded_query (%)', coalesce(def, '<absent>');
  END IF;

  -- (1b) ...and the function's own governed array names the SAME set. Two
  --      lists that can disagree are one list plus a latent bug: a role
  --      admitted by the CHECK but rejected by the function is a capability
  --      that can be recorded and never charged, which is precisely the
  --      failure INT-CAP-001 reports.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO problem
  FROM (VALUES ('advisor'), ('validator'), ('composer'), ('proxy_reviewer'),
               ('evidence_reviewer'), ('audit_assistant'), ('grounded_query')) AS r(name)
  WHERE position('''' || r.name || '''' in def) = 0
     OR position('''' || r.name || '''' in pg_get_functiondef(fn_oid)) = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: the CHECK and the function disagree about the governed vocabulary for: %', problem;
  END IF;

  -- (2) The idempotency column, its shape guard and its mandate.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = tbl_oid AND a.attname = 'idempotency_key'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: stella_interactions.idempotency_key is absent';
  END IF;
  SELECT string_agg(c.name, ', ' ORDER BY c.name) INTO problem
  FROM (VALUES
    ('stella_interactions_idempotency_key_shape_check'),
    ('stella_interactions_grounded_query_idempotency_check')
  ) AS c(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint pc
    WHERE pc.conrelid = tbl_oid AND pc.conname = c.name AND pc.contype = 'c'
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: CHECK constraint(s) % are absent', problem;
  END IF;

  -- (3) The unique index is unique AND predicated. Without the predicate every
  --     legacy row (idempotency_key IS NULL) would collide on the second one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = tbl_oid AND c.relname = 'uq_stella_interactions_idempotency'
      AND i.indisunique
      AND position('idempotency_key IS NOT NULL' in pg_get_indexdef(i.indexrelid)) > 0
  ) THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: uq_stella_interactions_idempotency is missing, not unique, or lost its predicate';
  END IF;

  -- (4) The function is SECURITY DEFINER with an EMPTY search_path, owned by
  --     the capability role, and not executable by PUBLIC. Written over the
  --     whole schema rather than the one name, so a second function added
  --     later cannot arrive unchecked.
  --
  --     BOTH spellings of the empty path: PostgreSQL stores `SET search_path
  --     = ''` as `search_path=""`, and a bare-form-only check is the bug that
  --     made grounding_0002/0003 abort on every apply.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella'
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_stella'
    AND pg_get_userbyid(p.proowner) <> 'uellix_cap_stella_quota';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: function(s) % are not owned by uellix_cap_stella_quota', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_stella' AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  -- (5) The capability role holds NO mutating privilege on the ledger, and
  --     nothing this package granted lets it erase a consumption.
  --
  --     aclexplode, not information_schema: the latter reports privileges a
  --     role merely INHERITS and short-circuits for superusers, so an
  --     over-granted table verifies clean.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND g.rolname = 'uellix_cap_stella_quota'
    AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: uellix_cap_stella_quota holds % on the ledger. An append-only trail whose writer can erase is not one', problem;
  END IF;

  -- (6) The capability role has ZERO members, so no LOGIN role reaches its
  --     privileges by SET ROLE.
  SELECT count(*) INTO n FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  WHERE r.rolname = 'uellix_cap_stella_quota';
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: uellix_cap_stella_quota has % member(s)', n;
  END IF;

  -- (7) The role attributes, restated as a postcondition rather than trusted
  --     from the ALTER above.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_cap_stella_quota'
      AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: uellix_cap_stella_quota carries an attribute it must not (LOGIN/SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION/INHERIT)';
  END IF;

  -- (8) USAGE on schema auth confers auth.uid() and NOTHING ELSE. The same
  --     postcondition stella_0004 §9 makes, restated for this role because a
  --     grant it did not exist for is a grant nobody re-checked.
  IF has_table_privilege('uellix_cap_stella_quota', 'auth.users', 'SELECT') THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: uellix_cap_stella_quota can read auth.users. The USAGE on schema auth exists so that auth.uid() resolves, not to expose the identity store';
  END IF;

  -- (9) The write policy that binds the definer exists and names it.
  SELECT count(*) INTO n FROM pg_policy
  WHERE polrelid = tbl_oid AND polname = 'stella_interactions_quota_definer_insert';
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0013 FAILED verification: stella_interactions_quota_definer_insert is missing. The definer holds no BYPASSRLS, so with no INSERT policy it could not charge at all — and with a widened one it could charge anything';
  END IF;

  RAISE NOTICE 'stella_0013: verification passed — grounded_query in the role vocabulary and in the function''s governed array, idempotency column with shape and mandate CHECKs, unique partial index, one SECURITY DEFINER function with empty search_path owned by uellix_cap_stella_quota, no mutating privilege on the ledger, capability role with 0 members and no auth.users access, definer INSERT policy present.';
END $$;
