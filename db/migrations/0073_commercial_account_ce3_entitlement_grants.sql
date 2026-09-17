CREATE TABLE "entitlement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability_key" varchar(100) NOT NULL,
	"source" varchar(50) NOT NULL,
	"commercial_account_id" uuid,
	"plan_ref" varchar(255),
	"limit_kind" varchar(50) NOT NULL,
	"limit_value" integer,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"reason" text,
	"actor_user_id" uuid,
	"audit_log_id" uuid,
	CONSTRAINT "entitlement_grants_source_check" CHECK ("entitlement_grants"."source" IN ('PLAN', 'PLATFORM_ADMIN', 'BOOTSTRAP_DEFAULT', 'COMMERCIAL_EXCEPTION')),
	CONSTRAINT "entitlement_grants_limit_kind_check" CHECK ("entitlement_grants"."limit_kind" IN ('UNMETERED', 'BLOCKED', 'CAPPED')),
	CONSTRAINT "entitlement_grants_capped_limit_check" CHECK ("entitlement_grants"."limit_kind" <> 'CAPPED' OR ("entitlement_grants"."limit_value" IS NOT NULL AND "entitlement_grants"."limit_value" >= 0)),
	CONSTRAINT "entitlement_grants_unmetered_blocked_limit_check" CHECK ("entitlement_grants"."limit_kind" NOT IN ('UNMETERED', 'BLOCKED') OR "entitlement_grants"."limit_value" IS NULL),
	CONSTRAINT "entitlement_grants_commercial_basis_required_check" CHECK ("entitlement_grants"."source" NOT IN ('PLAN', 'COMMERCIAL_EXCEPTION') OR "entitlement_grants"."commercial_account_id" IS NOT NULL),
	CONSTRAINT "entitlement_grants_commercial_basis_forbidden_check" CHECK ("entitlement_grants"."source" NOT IN ('PLATFORM_ADMIN', 'BOOTSTRAP_DEFAULT') OR "entitlement_grants"."commercial_account_id" IS NULL),
	CONSTRAINT "entitlement_grants_effective_period_check" CHECK ("entitlement_grants"."effective_to" IS NULL OR "entitlement_grants"."effective_to" > "entitlement_grants"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_commercial_account_id_commercial_accounts_id_fk" FOREIGN KEY ("commercial_account_id") REFERENCES "public"."commercial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entitlement_grants_live_org_capability" ON "entitlement_grants" USING btree ("organization_id","capability_key") WHERE "entitlement_grants"."effective_to" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_entitlement_grants_commercial_account_id" ON "entitlement_grants" USING btree ("commercial_account_id");

-- ===========================================================================
-- CE-3 -- entitlement_grants SECURITY POSTURE, EVALUATOR AND STORAGE BOUNDARY.
--
-- Authority: docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_v1.0.0.json
-- (HPO-ODS-W2-30), bounding docs/ops/commercial/COMMERCIAL_ACCOUNT_ENTITLEMENT_AUTHORITY_v1.0.0.json.
--
-- Everything ABOVE this banner is generated cleanly by `drizzle-kit generate`
-- from db/schema.ts. Everything BELOW is hand-authored, following the 0070 /
-- 0072 idiom: idempotent DROP POLICY IF EXISTS / CREATE POLICY and
-- DROP TRIGGER IF EXISTS / CREATE TRIGGER.
--
-- F-CE3-1 IS RESOLVED AS R-A -- A NON-TENANT-FACING DEFINER READ.
-- RLS_SECURITY_CONTRACT.POLICY_SET left CE-3's one security decision open
-- because tenancy S4 freezes the conjunctive tenant model and is NOT
-- integrated. The tension it states is real: ENABLE + FORCE with ZERO policies
-- (CE-1's posture) denies the evaluator itself, so the node's own deliverable
-- would be unreadable; authoring the tenant-facing policy set now is
-- PROHIBITED by MULTIORG_INTERSECTION's explicit ordering (R-C, refused by
-- name). R-A is taken: the read path is a SECURITY DEFINER function owned by
-- uellix_owner, for which EXACTLY ONE narrow SELECT policy exists, and NO
-- policy is addressed to any tenant role. Every tenant-facing policy decision
-- is thereby DEFERRED to S4 rather than pre-empted, and nothing written here
-- has to be re-derived when S4 lands.
--
-- NO BYPASSRLS ANYWHERE. R-A's own wording admits "a single narrow policy (or
-- a BYPASSRLS posture)". The policy is chosen and BYPASSRLS is refused: a
-- BYPASSRLS role would make FORCE ROW LEVEL SECURITY silently inert for it,
-- so the isolation probes would be measuring nothing, and the exemption would
-- outlive CE-3 on every relation the role ever touches -- not just this one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- THIS UNIT NAMES uellix_owner AND DOES NOT CREATE OR RE-HOME IT.
--
-- db/hosted/baseline-manifest.ts BASELINE_GLOBAL_INVARIANTS pins
-- roleStatements = 0 and ownershipStatements = 0 across the WHOLE baseline,
-- "no baseline unit may introduce this; there is no per-unit opt-out". Role
-- topology and object ownership belong to the hosted provisioning chain
-- (db/prepared/hosted/**), never to a migration -- which is why the nine
-- SECURITY DEFINER functions already in db/migrations/** likewise declare no
-- owner, and why the real G2 environment shows them owned by uellix_owner
-- anyway (db/baseline/stella_g2_schema.sql).
--
-- A GUARDED `CREATE ROLE ... IF NOT EXISTS` INSIDE A DO BLOCK WAS WRITTEN,
-- MEASURED AND REMOVED. The scanner strips dollar-quoted bodies before its
-- lexical tests, so that form reported roleStatements = 0 and passed the
-- invariant while substantively introducing the corpus's first role statement
-- -- an announced edit that changes what a unit does and produces no second
-- signal, which is precisely the failure db/hosted/baseline-scanner.ts exists
-- to prevent. Passing because the counter cannot see you is not passing.
--
-- CONSEQUENCE, STATED RATHER THAN HIDDEN: this unit does not apply to a
-- cluster that lacks uellix_owner, exactly as 0042_fib_audit_insert_policy.sql
-- does not apply to one lacking uellix_app. The environment provides the role.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- RLS. ENABLE because a relation without it is PERMISSIVE by default, which
-- fails open -- the wrong direction for commercial provenance. FORCE because
-- without it the TABLE OWNER is exempt, which would make the policy below
-- silently inert for exactly the role the definer function runs as, and every
-- isolation probe would then be measuring the owner exemption rather than the
-- policy.
-- ---------------------------------------------------------------------------
ALTER TABLE entitlement_grants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE entitlement_grants FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- EXACTLY ONE CE-3 POLICY. SELECT only, addressed to uellix_owner only.
--
-- USING (true) IS NOT A WIDE READ. The predicate is unconditional BECAUSE the
-- scope check does not belong here: SC-12 requires the cross-organization
-- refusal to be an EXPLICIT RAISE, never RLS filtering, since a non-matching
-- policy yields an EMPTY SET and SEC-6 rejects absence as a refusal signal.
-- Putting an organization predicate in this policy would therefore create a
-- SECOND, SILENT refusal path with exactly the shape the authority forbids --
-- and it could not be written anyway without naming the tenant model S4 has
-- not yet frozen. The narrowing that matters is the ROLE: this policy is
-- reachable only by uellix_owner, which no tenant request path can become.
--
-- NO tenant-facing policy. NO policy TO authenticated, anon, uellix_app,
-- uellix_writer or service_role. NO INSERT/UPDATE/DELETE policy of any kind --
-- writes are denied to every ordinary role by RLS with no permissive policy,
-- and the append-only trigger below binds even the roles RLS exempts.
DROP POLICY IF EXISTS "entitlement_grants_select_owner" ON entitlement_grants;--> statement-breakpoint
CREATE POLICY "entitlement_grants_select_owner" ON entitlement_grants FOR SELECT
TO uellix_owner
USING (true);--> statement-breakpoint

-- A POLICY IS NOT A PRIVILEGE. RLS narrows what a role may see; it never
-- grants the base SELECT privilege. uellix_owner needs one to read through the
-- policy when it is not also the table's owner (a corpus-only cluster leaves
-- ownership with whoever ran the migration).
--
-- AND DELIBERATELY NOTHING ELSE. No SELECT, INSERT, UPDATE or DELETE is
-- granted to authenticated, anon, uellix_app, uellix_writer or service_role.
-- That absence is load-bearing and is asserted at runtime: a direct
-- `SELECT * FROM entitlement_grants` as a tenant identity must fail 42501 on
-- PRIVILEGE, before RLS is ever consulted.
GRANT SELECT ON public.entitlement_grants TO uellix_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE EVALUATOR. public.entitlement_effective(uuid, varchar).
--
-- ORDERING IS LOAD-BEARING AND IS NOT AN IMPLEMENTATION DETAIL:
--
--   1. validate caller scope against the EXPLICIT organization argument;
--   2. out of scope            -> U0113, uniform refusal;
--   3. validate capability_key against the closed production catalogue;
--   4. undeclared capability   -> U0114, uniform refusal;
--   5. only then evaluate the grant.
--
-- The scope check comes FIRST so that an out-of-scope caller can never use
-- this function as a CATALOGUE ORACLE. Were the capability validated first, a
-- caller with no scope anywhere could still distinguish declared from
-- undeclared keys by which SQLSTATE came back, and would learn the product's
-- capability vocabulary from a function whose entire purpose is to refuse
-- them. In this order every out-of-scope caller sees U0113 and nothing else,
-- whatever they ask about.
--
-- BOTH REFUSALS CARRY THE IDENTICAL FIXED MESSAGE, no DETAIL and no HINT. No
-- organization id, no capability key, no row count and no grant information is
-- echoed. The two cases are distinguished ONLY by SQLSTATE, which is what the
-- typed wrapper maps -- so message text can never become a side channel, and a
-- log that captures messages captures nothing a caller did not already supply.
--
-- U0113 AND U0114 ARE FREE AT THIS BASE, MEASURED. The occupied U0 namespace
-- runs U0001..U0003 and U0100..U0112; the identical sweep that returns zero
-- for U0113 and U0114 returns 45 hits for U0112, so the absence is measured
-- rather than an empty grep believed on its own.
--
-- SECURITY DEFINER, AND WHY auth.uid() STILL MEANS THE CALLER. The scope check
-- delegates to public.current_user_org_ids(), the repository's live
-- org-membership primitive, which resolves ACTIVE memberships from auth.uid().
-- auth.uid() reads the SESSION GUCs request.jwt.claim.sub / request.jwt.claims
-- (db/baseline/stella_g2_schema.sql:486-494) -- NOT current_user. SECURITY
-- DEFINER swaps the effective ROLE for privilege checks and leaves session
-- GUCs untouched, so caller identity survives the definer boundary intact.
-- Had auth.uid() been built on current_user, this function would have silently
-- authorized its own OWNER against every organization, and the guard would
-- have been worse than absent. current_user_org_ids() is itself SECURITY
-- DEFINER and is already invoked this way from RLS policies under arbitrary
-- roles, so the composition is the corpus's existing behaviour and not a new
-- assumption. It is nevertheless PROVEN at runtime, not inferred from this
-- comment, by the explicit-organization and cross-organization probes.
--
-- THE EXPLICIT ARGUMENT IS THE SCOPE. There is no selected-organization
-- fallback, no first-active-membership, no user_single_active_membership
-- dependence and no commercial-account scope. The check is a CONTAINMENT test
-- of the caller's memberships against the argument the caller named -- so a
-- subject with several memberships gets an answer about the organization they
-- ASKED about, and asking about one they do not hold is refused rather than
-- quietly rewritten to one they do.
--
-- STABLE, not VOLATILE: the function writes nothing (EVALUATOR_CONTRACT.purity
-- -- no row, no GUC, no audit entry, no lazy materialisation of a missing
-- grant), and transaction_timestamp() is fixed for the transaction, so two
-- calls in one transaction cannot disagree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entitlement_effective(
  p_organization_id uuid,
  p_capability_key varchar
)
RETURNS TABLE (kind text, limit_value integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit_kind  varchar(50);
  v_limit_value integer;
BEGIN
  -- 1/2. CALLER SCOPE, against the explicit argument. A NULL argument is
  -- refused here rather than treated as "any organization".
  IF p_organization_id IS NULL
     OR NOT (p_organization_id = ANY (public.current_user_org_ids())) THEN
    RAISE EXCEPTION 'entitlement request refused' USING ERRCODE = 'U0113';
  END IF;

  -- 3/4. CAPABILITY CATALOGUE, re-validated AT THE DATABASE BOUNDARY. The
  -- typed wrapper in lib/capabilities/entitlement-evaluator.ts refuses an
  -- undeclared key before any round trip, but EXECUTE on this function is
  -- granted to the `authenticated` JWT role, so a caller can invoke it
  -- DIRECTLY and bypass TypeScript entirely. A catalogue enforced only in the
  -- application is a guard on the polite path. The literal below is the whole
  -- production catalogue for Commercial V1 and is kept byte-identical to
  -- ENTITLEMENT_CAPABILITY_CATALOGUE in that module.
  IF p_capability_key IS NULL
     OR p_capability_key <> 'stella.grounded_query' THEN
    RAISE EXCEPTION 'entitlement request refused' USING ERRCODE = 'U0114';
  END IF;

  -- 5. THE EFFECTIVE GRANT.
  --
  -- effective_to IS NULL is the parent's definition of LIVE and matches the
  -- partial unique index exactly, so at most one row can satisfy the first
  -- three terms.
  --
  -- effective_from <= transaction_timestamp() IS THE EXPLICIT DECISION
  -- EVALUATOR_CONTRACT.evaluation_instant_semantics requires, recorded rather
  -- than left to emerge from whichever comparison the query happened to carry.
  -- A grant whose effective_to is NULL and whose effective_from is in the
  -- FUTURE -- which CHECK-5 permits -- OCCUPIES the unique key but is NOT yet
  -- in force, and this function answers NO_LIVE_GRANT for it until its
  -- effective_from passes. The unique index is deliberately NOT narrowed to
  -- match: adding an effective_from term to its predicate would admit two rows
  -- SC-5 forbids. The database key and "in force right now" are two different
  -- notions and are kept apart on purpose.
  SELECT g.limit_kind, g.limit_value
    INTO v_limit_kind, v_limit_value
    FROM public.entitlement_grants g
   WHERE g.organization_id = p_organization_id
     AND g.capability_key = p_capability_key
     AND g.effective_to IS NULL
     AND g.effective_from <= transaction_timestamp();

  -- NO_LIVE_GRANT IS AN ANSWER, NOT A REFUSAL. "Nobody decided" is distinct
  -- from BLOCKED ("decided against") and from the U0113/U0114 refusals above,
  -- which are not answers about entitlement at all. Collapsing any two of the
  -- three is what EVALUATOR_CONTRACT.output_shape.conflation_prohibitions
  -- forbids, and is mutation CE3-M-3 / control CE3-P-8.
  -- `NOT FOUND`, NEVER A SENTINEL VARIABLE SET BY THE SELECT ITSELF. An
  -- earlier version selected a literal `true` into a `v_found boolean := false`
  -- and branched on `IF NOT v_found`. That is WRONG, and wrong in the direction
  -- that fails OPEN: when SELECT INTO matches no row it sets EVERY target
  -- variable to NULL -- including v_found -- so `NOT v_found` evaluated to NULL,
  -- which is not TRUE, so the branch did NOT fire, and the function fell through
  -- and returned (NULL, NULL) instead of NO_LIVE_GRANT. A caller reading that
  -- row would have seen a kind it could not recognise for every ungoverned
  -- Organization. This is the same NULL-is-not-FALSE hazard the append-only
  -- guard below answers with IS DISTINCT FROM, and the real-PostgreSQL
  -- ungoverned-sentinel probe is what caught it.
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NO_LIVE_GRANT'::text, NULL::integer;
    RETURN;
  END IF;

  -- EXACTLY ONE SEMANTIC ANSWER ROW. limit_kind is returned verbatim -- the
  -- three values are pinned by a CHECK constraint, so there is no mapping
  -- table here that could drift from the column's own closed set. limit_value
  -- accompanies CAPPED and is NULL for UNMETERED and BLOCKED by CHECK-2, so
  -- BLOCKED can never arrive looking like CAPPED 0.
  RETURN QUERY SELECT v_limit_kind::text, v_limit_value;
END;
$$;--> statement-breakpoint

-- PostgreSQL grants EXECUTE to PUBLIC by default at CREATE time.
-- 0033_public_api_grants.sql revoked EXECUTE on all THEN-EXISTING public
-- functions from PUBLIC, anon and authenticated -- a historical command that
-- CANNOT reach a function created later, so relying on it here would leave
-- this evaluator world-executable. The explicit REVOKE follows the 0061 /
-- 0070 / 0072 precedent; the re-GRANT is narrow and deliberate.
REVOKE EXECUTE ON FUNCTION public.entitlement_effective(uuid, varchar) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.entitlement_effective(uuid, varchar) TO authenticated;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE APPEND-ONLY STORAGE BOUNDARY (SC-6).
--
-- A BESPOKE FUNCTION, AND NOT uellix_forbid_mutation(). 0030_immutability.sql
-- defines that guard and 0072 reuses it, but it refuses EVERY update -- which
-- would refuse the ONE legal transition this relation has. Revocation here is
-- expressed by CLOSING a grant, so a blanket refusal would make the lifecycle
-- the parent ratified unexpressible. Reuse was considered and rejected for
-- that specific reason.
--
-- AT THE STORAGE BOUNDARY, NOT IN A VERB BODY. A trigger binds EVERY writer --
-- the table owner and a superuser included -- so append-only is a property of
-- the DATABASE rather than of which code path happened to issue the statement.
-- The probes issue these statements DIRECTLY against the relation, never
-- through a verb that declines to issue them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_entitlement_grant_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- DELETE: never, for any row, live or closed. A deleted grant is a past
  -- entitlement state that can no longer be reconstructed, which SEC-12
  -- requires to survive.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'entitlement_grants rows are append-only and cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- SECOND CLOSE. A row whose effective_to is already set is FROZEN: closing
  -- it again would rewrite when an entitlement ended.
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'entitlement_grants: a closed grant cannot be modified'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- RE-OPENING. timestamp -> NULL is caught above; NULL -> NULL is caught
  -- here, so an UPDATE that touches other columns while leaving effective_to
  -- NULL cannot slip through as "no close attempted".
  IF NEW.effective_to IS NULL THEN
    RAISE EXCEPTION 'entitlement_grants: the only permitted update is closing a live grant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- THE OTHER TWELVE COLUMNS MUST BE UNCHANGED.
  --
  -- ROW-WISE `IS DISTINCT FROM`, NOT `<>` OR `!=`. Seven of these twelve
  -- columns are NULLABLE, and ordinary equality on a NULL yields UNKNOWN, not
  -- FALSE -- so a chain of `NEW.x <> OLD.x OR ...` would evaluate to UNKNOWN
  -- for precisely the rows an attacker would edit, the IF would not fire, and
  -- the mutation would be ADMITTED. `IS DISTINCT FROM` is NULL-safe in both
  -- directions and treats NULL -> value and value -> NULL as changes, which is
  -- what "unchanged" has to mean here.
  IF (NEW.id, NEW.organization_id, NEW.capability_key, NEW.source,
      NEW.commercial_account_id, NEW.plan_ref, NEW.limit_kind, NEW.limit_value,
      NEW.effective_from, NEW.reason, NEW.actor_user_id, NEW.audit_log_id)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.capability_key, OLD.source,
      OLD.commercial_account_id, OLD.plan_ref, OLD.limit_kind, OLD.limit_value,
      OLD.effective_from, OLD.reason, OLD.actor_user_id, OLD.audit_log_id) THEN
    RAISE EXCEPTION 'entitlement_grants: only effective_to may change, once, from NULL to a timestamp'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.enforce_entitlement_grant_append_only() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_entitlement_grants_append_only ON entitlement_grants;--> statement-breakpoint
CREATE TRIGGER trg_entitlement_grants_append_only
  BEFORE UPDATE OR DELETE ON entitlement_grants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_entitlement_grant_append_only();
