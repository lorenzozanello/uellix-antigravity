-- L1 -- customer-lifecycle ORGANIZATION_COMMERCIAL_ACCEPTANCE substrate (T4).
--
-- Authority: docs/ops/compliance/CUSTOMER_LIFECYCLE_L1_EXECUTION_AUTHORITY_v1.0.0.json
-- (HPO-ODS-W2-29), bounding docs/ops/compliance/CUSTOMER_LIFECYCLE_LEGAL_ACCEPTANCE_AUTHORITY_v1.0.0.json.
--
-- The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements above the RLS
-- section are generated cleanly by `drizzle-kit generate` from db/schema.ts.
-- Everything below is hand-authored, following the 0070 idiom: idempotent
-- DROP POLICY IF EXISTS / CREATE POLICY and DROP TRIGGER IF EXISTS /
-- CREATE TRIGGER.
--
-- WHAT THIS UNIT DOES NOT DO. It adds NO audit_logs INSERT policy. That is
-- the ONE material way L1's surface is SMALLER than its CL-1 sibling's, and
-- it is a MEASUREMENT, not a convenience: CL-1's acceptance audit row is
-- ORG-LESS, which 0042's audit_logs_insert_member_or_admin excludes by
-- construction (it requires organization_id IS NOT NULL or super-admin), so
-- CL-1 needed a fourth policy. L1's row is TENANT-SCOPED, is attributed to
-- the accepting subject, and names an organization that subject is an active
-- member of -- so it satisfies 0042's FIRST DISJUNCT on its own. Copying
-- CL-1's shape here would widen the audit write surface for no gain and move
-- the policy-count assertion CL-1's own suite pins. 0042, 0067 and 0070's
-- INSERT policy clauses are BYTE-UNCHANGED and the count stays at THREE
-- (X-L1-07, R-L1-12).
--
-- THE HONEST CAVEAT, recorded rather than repaired: 0042 carries an
-- `OR current_user_is_super_admin()` disjunct, so the AUDIT policy is WIDER
-- than the ACCEPTANCE policy below. A super-admin could write an audit row
-- naming an acceptance they cannot themselves perform. That is not a bypass
-- -- the T4 INSERT is the load-bearing gate and refuses them -- but it does
-- mean AN AUDIT ROW ALONE IS NOT PROOF OF A VALID ACCEPTANCE. An auditor
-- reconstructing acceptances must read T4, not audit_logs. Narrowing 0042 is
-- outside this authority.
--
-- It also authors no legal instrument content and decides no publisher
-- identity: legal_instruments and legal_instrument_versions keep exactly the
-- read-open/write-closed posture 0070 gave them (U-AO-2, still open).

CREATE TABLE "organization_commercial_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"instrument_key" varchar(100) NOT NULL,
	"instrument_version_id" uuid NOT NULL,
	"content_digest" text NOT NULL,
	"accepted_by_user_id" uuid NOT NULL,
	"accepted_by_role" varchar(50) NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"audit_log_id" uuid,
	CONSTRAINT "organization_commercial_acceptances_content_digest_check" CHECK ("organization_commercial_acceptances"."content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "organization_commercial_acceptances" ADD CONSTRAINT "organization_commercial_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_commercial_acceptances" ADD CONSTRAINT "organization_commercial_acceptances_instrument_key_legal_instruments_instrument_key_fk" FOREIGN KEY ("instrument_key") REFERENCES "public"."legal_instruments"("instrument_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_commercial_acceptances" ADD CONSTRAINT "organization_commercial_acceptances_instrument_version_id_legal_instrument_versions_id_fk" FOREIGN KEY ("instrument_version_id") REFERENCES "public"."legal_instrument_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_commercial_acceptances" ADD CONSTRAINT "organization_commercial_acceptances_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_commercial_acceptances" ADD CONSTRAINT "organization_commercial_acceptances_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_commercial_acceptances_org_version" ON "organization_commercial_acceptances" USING btree ("organization_id","instrument_version_id");--> statement-breakpoint
CREATE INDEX "idx_organization_commercial_acceptances_organization_id" ON "organization_commercial_acceptances" USING btree ("organization_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- T4 -- organization_commercial_acceptances. TENANT DATA (I-T4-9), unlike its
-- T3 sibling: RLS is ENABLED AND FORCED, and the read predicate is
-- organization membership rather than subject identity.
-- ---------------------------------------------------------------------------

ALTER TABLE organization_commercial_acceptances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE organization_commercial_acceptances FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- SELECT -- organization-member visibility, through the repository's LIVE
-- org-membership primitive current_user_org_ids() (0031_rls_core.sql), which
-- resolves the caller's ACTIVE memberships from auth.uid(). An acceptance row
-- is visible to members of its own organization and to nobody else (R-L1-11).
-- No current_user_is_super_admin() disjunct: the authority names no platform
-- read path for this relation and L1 does not invent one.
DROP POLICY IF EXISTS "organization_commercial_acceptances_select" ON organization_commercial_acceptances;--> statement-breakpoint
CREATE POLICY "organization_commercial_acceptances_select" ON organization_commercial_acceptances FOR SELECT
TO uellix_app
USING (organization_id = ANY (public.current_user_org_ids()));--> statement-breakpoint

-- INSERT -- THREE CONJUNCTIVE CONDITIONS (RLS_AUTHORITY.required_posture.insert):
--
--   1. accepted_by_user_id = auth.uid()              -- the accepting subject only, no delegation.
--   2. organization_id = ANY(current_user_org_ids()) -- an ACTIVE membership in THE ROW'S organization.
--   3. current_user_role_in_org(organization_id) = 'organization_admin'
--                                                   -- the role, by EXACT EQUALITY.
--
-- WHY current_user_role_in_org AND NOT THE AMBIENT IDIOM. Measured at
-- db/migrations/0031_rls_core.sql:40-51: it is SECURITY DEFINER STABLE, filters
-- status = 'active', takes the organization as a PARAMETER (so it applies to
-- THE ROW'S organization_id rather than to an ambient scope), and carries NO
-- super_admin disjunct of any kind. Compared by EQUALITY it yields precisely
-- the ratified predicate (RAT-AO-01 AO1_C6, RAT-AO-02 AO2_C2).
--
-- THE PREDICATE IS NOT A THRESHOLD. db/schema.ts role_check permits a
-- membership row to carry role 'super_admin', and hasRole('super_admin',
-- 'organization_admin') is 100 >= 80 = TRUE -- so a RANGE predicate would
-- admit a tenant super_admin as an accepting principal. This equality does
-- not (N-AO-27, mutation M-AO-15). There is deliberately NO
-- current_user_is_super_admin(), NO hasRole comparison and NO ROLE_HIERARCHY
-- reference anywhere in this unit (X-AO-06 / X-L1-03,
-- S-L1-NO-SUPERADMIN-DISJUNCT).
--
-- CONDITION 2 IS NOT REDUNDANT WITH CONDITION 3 and is not carried for
-- symmetry. Condition 3 is what makes the predicate ROW-PARAMETERISED; if a
-- future edit replaced it with an ambient role lookup, condition 2 would
-- still refuse the cross-tenant insert on its own. Both exist so that
-- removing either leaves the cross-tenant refusal standing
-- (TENANT-cross-org-insert-refused; mutation MUT-L1-drop-cross-tenant-condition
-- removes BOTH row bindings, which is the only way to make that control RED
-- while every role control stays green).
--
-- CROSS-TENANT REFUSAL IS THE SINGLE MOST IMPORTANT PROPERTY HERE, because
-- it is the one the application cannot be trusted to provide: an
-- organization_admin of Org-A must be refused an INSERT naming Org-B EVEN
-- WITH THE APPLICATION BYPASSED ENTIRELY.
DROP POLICY IF EXISTS "organization_commercial_acceptances_insert" ON organization_commercial_acceptances;--> statement-breakpoint
CREATE POLICY "organization_commercial_acceptances_insert"
ON organization_commercial_acceptances FOR INSERT
TO uellix_app
WITH CHECK (
  accepted_by_user_id = auth.uid()
  AND organization_id = ANY (public.current_user_org_ids())
  AND public.current_user_role_in_org(organization_id) = 'organization_admin'
);--> statement-breakpoint
-- No UPDATE/DELETE policy -> denied by RLS (I-T4-2, append-only).

-- APPEND-ONLY IS ENFORCED, NOT MERELY UNPOLICIED. An omitted policy is
-- necessary but a trigger makes the refusal explicit, survives a future
-- policy addition, and binds the table OWNER too (RLS_AUTHORITY
-- .append_only_is_ENFORCED_not_merely_UNPOLICIED). Reuses
-- uellix_forbid_mutation() from 0030_immutability.sql -- no new function.
DROP TRIGGER IF EXISTS trg_organization_commercial_acceptances_append_only ON organization_commercial_acceptances;--> statement-breakpoint
CREATE TRIGGER trg_organization_commercial_acceptances_append_only
  BEFORE UPDATE OR DELETE ON organization_commercial_acceptances
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();--> statement-breakpoint

-- THE INVARIANTS NO CHECK CONSTRAINT CAN EXPRESS. 0070's
-- enforce_account_legal_acceptance_invariants() is a CONCEPTUAL PRECEDENT for
-- the SHAPE only; this function is NOT a copy of it. It asserts ORGANIZATION
-- where the sibling asserts ACCOUNT -- which is the whole point of the guard
-- existing in both directions (N-AO-20) -- and it carries obligations the
-- account-side twin does not have at all:
--
--   I-T4-5  the referenced instrument must be instrument_class ORGANIZATION.
--   I-T4-4  the snapshotted content_digest must equal the referenced
--           version's digest AT WRITE TIME.
--   (key)   the PHYSICALLY PERSISTED instrument_key must agree with the
--           referenced version's own instrument_key. T4 persists the key
--           where T3 omitted it, so the duplicate is closed HERE rather than
--           avoided by omission -- it cannot drift.
--   I-T4-6  accepted_by_user_id = auth.uid(), AND that subject holds an
--           ACTIVE membership in organization_id whose role is EXACTLY
--           organization_admin, RE-VERIFIED AT THE DATABASE BOUNDARY in this
--           same transaction and NEVER taken from a client-supplied role.
--   I-T4-7  accepted_by_role must BE that exact verified role -- so the
--           snapshot records what was true, and a forged or stale value is
--           refused rather than stored.
--
-- WHY THE ROLE IS RE-VERIFIED HERE WHEN THE INSERT POLICY ALREADY CHECKS IT.
-- The policy binds the uellix_app role only. A trigger binds every writer,
-- including the table owner and a superuser, so the "application bypassed
-- entirely" property is a property of the DATABASE and not of which role
-- happened to connect.
CREATE OR REPLACE FUNCTION enforce_organization_commercial_acceptance_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digest text;
  v_key    varchar(100);
  v_class  varchar(20);
  v_role   text;
  v_actor  uuid;
BEGIN
  SELECT v.content_digest, v.instrument_key, i.instrument_class
    INTO v_digest, v_key, v_class
    FROM legal_instrument_versions v
    JOIN legal_instruments i ON i.instrument_key = v.instrument_key
    WHERE v.id = NEW.instrument_version_id;

  IF v_digest IS NULL THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: instrument_version_id % does not reference a published version', NEW.instrument_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_class <> 'ORGANIZATION' THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: instrument_version_id % is instrument_class %, not ORGANIZATION (I-T4-5)', NEW.instrument_version_id, v_class
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.instrument_key <> v_key THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: instrument_key does not match the referenced version''s instrument_key'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.content_digest <> v_digest THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: content_digest does not match the referenced version''s digest (I-T4-4)'
      USING ERRCODE = 'check_violation';
  END IF;

  v_actor := auth.uid();

  IF v_actor IS NULL OR NEW.accepted_by_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: accepted_by_user_id must be the acting subject (I-T4-6)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- EXACT EQUALITY on the ACTIVE membership role in THE ROW'S organization.
  -- current_user_role_in_org returns NULL for a non-member and for an
  -- inactive membership, and NULL <> 'organization_admin' is NULL, so the
  -- IS DISTINCT FROM form below refuses both without a separate branch.
  v_role := public.current_user_role_in_org(NEW.organization_id);

  IF v_role IS DISTINCT FROM 'organization_admin' THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: the acting subject does not hold an ACTIVE organization_admin membership in this organization (I-T4-6)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.accepted_by_role IS DISTINCT FROM v_role THEN
    RAISE EXCEPTION 'organization_commercial_acceptances: accepted_by_role must be the server-verified role held at accept time (I-T4-7)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- 0033_public_api_grants.sql revoked EXECUTE on all THEN-EXISTING public
-- functions from PUBLIC, anon and authenticated, and PostgreSQL grants
-- EXECUTE to PUBLIC by default at CREATE time -- so a function created after
-- 0033 needs its own REVOKE. Following the 0061 and 0070 precedent exactly:
-- one REVOKE, no re-GRANT, because a trigger invokes its function internally
-- regardless of the triggering role's own EXECUTE grant.
REVOKE EXECUTE ON FUNCTION enforce_organization_commercial_acceptance_invariants() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_organization_commercial_acceptances_invariants ON organization_commercial_acceptances;--> statement-breakpoint
CREATE TRIGGER trg_organization_commercial_acceptances_invariants
  BEFORE INSERT ON organization_commercial_acceptances
  FOR EACH ROW EXECUTE FUNCTION enforce_organization_commercial_acceptance_invariants();
