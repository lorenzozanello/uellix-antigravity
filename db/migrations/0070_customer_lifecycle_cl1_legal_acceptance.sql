-- CL-1 -- customer-lifecycle L0 legal-acceptance substrate (T1/T2/T3), stage A.
--
-- Authority: docs/ops/compliance/CUSTOMER_LIFECYCLE_CL1_EXECUTION_AUTHORITY_v1.0.0.json
-- (HPO-ODS-W2-28), bounding docs/ops/compliance/CUSTOMER_LIFECYCLE_LEGAL_ACCEPTANCE_AUTHORITY_v1.0.0.json.
--
-- CREATE TABLE statements above the first statement-breakpoint are generated
-- cleanly by `drizzle-kit generate` from db/schema.ts. Everything from here
-- down -- RLS, triggers and the audit_logs policy -- is hand-authored,
-- following the 0067_tenancy_refusal_audit_insert_policy.sql /
-- 0045_fib_domain_object_version_lineage.sql idiom: idempotent
-- DROP POLICY IF EXISTS / CREATE POLICY, and DROP TRIGGER IF EXISTS /
-- CREATE TRIGGER.
--
-- WHAT THIS UNIT DOES NOT DO. It authors no legal instrument content, and it
-- decides no publisher identity for legal_instrument_versions -- that is a
-- PLATFORM_PUBLISHER_DEPENDENCY (U-AO-2) left entirely to the platform-roles
-- lineage. Both tables therefore ship with a READ policy and NO write policy
-- of any kind: the registry is empty until a successor lineage can publish
-- into it, which is the correct fail-closed posture (an empty required-
-- instrument registry refuses every L0/L1 evaluation, never passes one).
--
-- legal_instruments (T1) / legal_instrument_versions (T2) are PLATFORM-GLOBAL
-- reference data, not tenant data -- no organization_id anywhere on either
-- table, and RLS is ENABLED (not FORCED: nothing here needs to bind the
-- table owner) with a single SELECT policy open to any authenticated
-- subject, matching I-T2-7's read/write asymmetry.
--
-- account_legal_acceptances (T3) is per-subject evidence, not tenant data
-- either (I-T3-7): RLS is ENABLED AND FORCED (I-T3-8), SELECT and INSERT are
-- both restricted to the subject's own row (id = auth.uid()), following the
-- same self-scoped shape as users_insert_own (0031_rls_core.sql). No
-- UPDATE/DELETE policy exists on any of the three tables -- append-only by
-- omission, exactly like readiness_assessments and domain_object_versions --
-- and each also carries the uellix_forbid_mutation() trigger
-- (0030_immutability.sql) as defense in depth against the table owner.
--
-- T3 carries two invariants no CHECK constraint can express because both
-- cross tables (I-T3-4: the snapshotted content_digest must equal the
-- referenced version's digest at write time; I-T3-5: the referenced
-- instrument must be instrument_class ACCOUNT). A single BEFORE INSERT
-- trigger enforces both.
--
-- Finally, one ADDITIVE audit_logs INSERT policy (ORGLESS_AUDIT_AUTHORITY):
-- an account-class acceptance has no organization, so its audit row must
-- carry organization_id NULL, which NEITHER existing INSERT policy admits --
-- audit_logs_insert_member_or_admin (0042) requires organization_id IS NOT
-- NULL or super-admin, and audit_logs_insert_tenancy_refusal (0067) admits
-- NULL only for its own closed set of three tenancy-refusal verbs. Neither
-- policy is edited. The new policy admits exactly ONE verb
-- (legal.account_instrument_accepted), binds actor_user_id = auth.uid(),
-- binds entity_type/entity_id to the accepting subject themselves, and adds
-- no super-admin disjunct (RLS_AUTHORITY.NO_SUPERADMIN_BYPASS_MAY_BE_NEWLY_ADDED).

CREATE TABLE "account_legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"instrument_version_id" uuid NOT NULL,
	"content_digest" text NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"audit_log_id" uuid,
	CONSTRAINT "account_legal_acceptances_content_digest_check" CHECK ("account_legal_acceptances"."content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "legal_instrument_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_key" varchar(100) NOT NULL,
	"version" integer NOT NULL,
	"locale" varchar(10) NOT NULL,
	"content_digest" text NOT NULL,
	"reaccept_required" boolean NOT NULL,
	"effective_at" timestamp,
	"published_by" uuid NOT NULL,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"audit_log_id" uuid,
	CONSTRAINT "legal_instrument_versions_content_digest_check" CHECK ("legal_instrument_versions"."content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "legal_instruments" (
	"instrument_key" varchar(100) PRIMARY KEY NOT NULL,
	"instrument_class" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legal_instruments_instrument_class_check" CHECK ("legal_instruments"."instrument_class" IN ('ACCOUNT', 'ORGANIZATION'))
);
--> statement-breakpoint
ALTER TABLE "account_legal_acceptances" ADD CONSTRAINT "account_legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_legal_acceptances" ADD CONSTRAINT "account_legal_acceptances_instrument_version_id_legal_instrument_versions_id_fk" FOREIGN KEY ("instrument_version_id") REFERENCES "public"."legal_instrument_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_legal_acceptances" ADD CONSTRAINT "account_legal_acceptances_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_instrument_versions" ADD CONSTRAINT "legal_instrument_versions_instrument_key_legal_instruments_instrument_key_fk" FOREIGN KEY ("instrument_key") REFERENCES "public"."legal_instruments"("instrument_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_instrument_versions" ADD CONSTRAINT "legal_instrument_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_instrument_versions" ADD CONSTRAINT "legal_instrument_versions_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_legal_acceptances_user_version" ON "account_legal_acceptances" USING btree ("user_id","instrument_version_id");--> statement-breakpoint
CREATE INDEX "idx_account_legal_acceptances_user_id" ON "account_legal_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_legal_instrument_versions_key_version_locale" ON "legal_instrument_versions" USING btree ("instrument_key","version","locale");--> statement-breakpoint
CREATE INDEX "idx_legal_instrument_versions_instrument_key" ON "legal_instrument_versions" USING btree ("instrument_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- T1 -- legal_instruments. Platform-global, read-open, write-closed.
-- ---------------------------------------------------------------------------

ALTER TABLE legal_instruments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "legal_instruments_select" ON legal_instruments;--> statement-breakpoint
CREATE POLICY "legal_instruments_select" ON legal_instruments FOR SELECT
TO uellix_app
USING (auth.uid() IS NOT NULL);--> statement-breakpoint
-- No INSERT/UPDATE/DELETE policy -> denied by RLS. Publication is a
-- PLATFORM_PUBLISHER_DEPENDENCY (U-AO-2) this unit does not decide.

DROP TRIGGER IF EXISTS trg_legal_instruments_append_only ON legal_instruments;--> statement-breakpoint
CREATE TRIGGER trg_legal_instruments_append_only
  BEFORE UPDATE OR DELETE ON legal_instruments
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- T2 -- legal_instrument_versions. Platform-global, read-open, write-closed.
-- ---------------------------------------------------------------------------

ALTER TABLE legal_instrument_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "legal_instrument_versions_select" ON legal_instrument_versions;--> statement-breakpoint
CREATE POLICY "legal_instrument_versions_select" ON legal_instrument_versions FOR SELECT
TO uellix_app
USING (auth.uid() IS NOT NULL);--> statement-breakpoint
-- No INSERT/UPDATE/DELETE policy -> denied by RLS (R-CL1-2, PLATFORM_PUBLISHER_DEPENDENCY).

DROP TRIGGER IF EXISTS trg_legal_instrument_versions_append_only ON legal_instrument_versions;--> statement-breakpoint
CREATE TRIGGER trg_legal_instrument_versions_append_only
  BEFORE UPDATE OR DELETE ON legal_instrument_versions
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- T3 -- account_legal_acceptances. Per-subject evidence, not tenant data.
-- RLS ENABLED AND FORCED (I-T3-8); write predicate is the subject's own id,
-- the same shape as users_insert_own (0031_rls_core.sql).
-- ---------------------------------------------------------------------------

ALTER TABLE account_legal_acceptances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE account_legal_acceptances FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "account_legal_acceptances_select" ON account_legal_acceptances;--> statement-breakpoint
CREATE POLICY "account_legal_acceptances_select" ON account_legal_acceptances FOR SELECT
TO uellix_app
USING (user_id = auth.uid());--> statement-breakpoint
-- No current_user_is_super_admin() disjunct: the parent authority does not
-- name a platform read path for this relation, and CL-1 does not invent one
-- (RLS_AUTHORITY.NO_SUPERADMIN_BYPASS_MAY_BE_NEWLY_ADDED).

DROP POLICY IF EXISTS "account_legal_acceptances_insert" ON account_legal_acceptances;--> statement-breakpoint
CREATE POLICY "account_legal_acceptances_insert"
ON account_legal_acceptances FOR INSERT
TO uellix_app
WITH CHECK (user_id = auth.uid());--> statement-breakpoint
-- No UPDATE/DELETE policy -> denied by RLS (I-T3-2, append-only).

DROP TRIGGER IF EXISTS trg_account_legal_acceptances_append_only ON account_legal_acceptances;--> statement-breakpoint
CREATE TRIGGER trg_account_legal_acceptances_append_only
  BEFORE UPDATE OR DELETE ON account_legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();--> statement-breakpoint

-- I-T3-4 (snapshotted digest must equal the referenced version's digest at
-- write time) and I-T3-5 (the referenced instrument must be instrument_class
-- ACCOUNT). Neither is a plain CHECK -- both cross tables -- so a trigger
-- enforces them together, once, on INSERT (the only write this table admits).
CREATE OR REPLACE FUNCTION enforce_account_legal_acceptance_invariants()
RETURNS trigger AS $$
DECLARE
  v_digest text;
  v_class varchar(20);
BEGIN
  SELECT v.content_digest, i.instrument_class
    INTO v_digest, v_class
    FROM legal_instrument_versions v
    JOIN legal_instruments i ON i.instrument_key = v.instrument_key
    WHERE v.id = NEW.instrument_version_id;

  IF v_digest IS NULL THEN
    RAISE EXCEPTION 'account_legal_acceptances: instrument_version_id % does not reference a published version', NEW.instrument_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_class <> 'ACCOUNT' THEN
    RAISE EXCEPTION 'account_legal_acceptances: instrument_version_id % is instrument_class %, not ACCOUNT (I-T3-5)', NEW.instrument_version_id, v_class
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.content_digest <> v_digest THEN
    RAISE EXCEPTION 'account_legal_acceptances: content_digest does not match the referenced version''s digest (I-T3-4)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- B0-17 (0033_public_api_grants.sql REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
-- public FROM PUBLIC, anon, authenticated): that sweep predates this function,
-- and PostgreSQL grants EXECUTE to PUBLIC on a function by default at CREATE
-- time. Following the exact 0061_fib_disposition_governance_function_execute_
-- revocation.sql precedent for a trigger function created after 0033: one
-- REVOKE, nothing else. No re-GRANT is needed -- a trigger invokes its
-- function internally regardless of the triggering role's own EXECUTE grant.
REVOKE EXECUTE ON FUNCTION enforce_account_legal_acceptance_invariants() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_account_legal_acceptances_invariants ON account_legal_acceptances;--> statement-breakpoint
CREATE TRIGGER trg_account_legal_acceptances_invariants
  BEFORE INSERT ON account_legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION enforce_account_legal_acceptance_invariants();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ORGLESS_AUDIT_AUTHORITY -- the one narrow additive audit_logs INSERT policy
-- CL-1 is authorized to add. 0042's and 0067's clauses are byte-unchanged;
-- see the migration header for why neither can carry this row.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_logs_insert_legal_acceptance" ON audit_logs;--> statement-breakpoint
CREATE POLICY "audit_logs_insert_legal_acceptance"
ON audit_logs FOR INSERT
TO uellix_app
WITH CHECK (
  actor_user_id = auth.uid()
  AND organization_id IS NULL
  AND action = 'legal.account_instrument_accepted'
  AND entity_type = 'user'
  AND entity_id = auth.uid()
);