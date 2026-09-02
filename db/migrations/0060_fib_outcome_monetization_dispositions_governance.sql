-- FIBIU-12 — monetization disposition governance, stage B (FIBDB-009/045).
-- W2-B3 completeness successor migration, governed by
-- docs/ops/wave2/W2_B3_COMPLETENESS_AUTHORITY_v1.0.0.json (AG-B3-6,
-- pg12_measured_fact, successor_migration_contract). Custom SQL migration:
-- no db/schema.ts diff — no column, CHECK or NOT NULL is added.
--
-- PG-12 (measured in the canonical disposable harness before this file was
-- authored): outcome_monetization_dispositions has RLS enabled, not forced,
-- SELECT + INSERT policies only. Under the runtime-equivalent identity
-- (session role uellix_app, request.jwt.claims set transaction-locally) a
-- same-tenant analyst UPDATE of a pre-approved disposition matches 0 rows
-- while the service's read-back returns the unchanged row — the service's
-- create-or-update contract (recordOutcomeMonetizationDisposition) was
-- unreachable at the database. Result: RLS_ENFORCED_UPDATE_DENIED_OR_ZERO,
-- no runtime RLS bypass (only the table owner bypasses, as PostgreSQL
-- defines). Sealed 0059 is never edited; this successor carries the delta.
--
-- 1. UPDATE policy — the same analyst+ floor 0059's INSERT policy uses, on
--    both sides of the row (USING for the row being updated, WITH CHECK for
--    the row as written), org-scoped through current_user_org_ids(). No
--    DELETE policy is added: DELETE stays RLS-denied for the runtime.
--
-- 2. Approved-run immutability, race-safe (FIBDB-009 "immutable once the
--    run is approved"). A service-only read -> check -> update has a TOCTOU
--    window: an approval can commit between the check and the write. Two
--    triggers close it with a transaction-scoped advisory lock protocol —
--    no table privilege is needed for advisory locks, so the protocol does
--    not depend on the hosted GRANT posture (a FOR UPDATE row lock on the
--    append-only sroi_calculation_runs would need UPDATE privilege):
--
--      guard   (dispositions, BEFORE INSERT/UPDATE/DELETE, SECURITY DEFINER):
--              pg_advisory_xact_lock_shared(60, hashtext(run_id)) then refuse
--              if the run carries an approved review; on UPDATE also refuse
--              any change to the identity columns.
--      lock    (sroi_run_reviews, BEFORE INSERT/UPDATE): when the row
--              becomes 'approved', pg_advisory_xact_lock(60, hashtext(run_id))
--              — exclusive, held to commit.
--
--    An approval in flight blocks every disposition write on that run until
--    it commits; the guard's fresh READ COMMITTED snapshot then sees the
--    approved review and refuses. A disposition write in flight blocks the
--    approval until it commits. Key namespace: int4 key1 = 60 (this
--    ordinal) in the two-int advisory space — disjoint from the one-int8
--    space grounding_0005 uses.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS, DROP
-- POLICY IF EXISTS — reapply converges (PG-15).

DROP POLICY IF EXISTS "outcome_monetization_dispositions_update" ON outcome_monetization_dispositions;--> statement-breakpoint
CREATE POLICY "outcome_monetization_dispositions_update"
ON outcome_monetization_dispositions FOR UPDATE
USING (
  organization_id = ANY(current_user_org_ids())
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
)
WITH CHECK (
  organization_id = ANY(current_user_org_ids())
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION uellix_guard_disposition_run_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.calculation_run_id ELSE NEW.calculation_run_id END;
BEGIN
  -- Serialize against an approval in flight for this run (see header).
  PERFORM pg_advisory_xact_lock_shared(60, hashtext(v_run_id::text));

  IF EXISTS (
    SELECT 1 FROM sroi_run_reviews r
    WHERE r.calculation_run_id = v_run_id AND r.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'immutable: % on outcome_monetization_dispositions is not permitted once calculation run % is approved (FIBDB-009)', TG_OP, v_run_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.outcome_id IS DISTINCT FROM OLD.outcome_id
       OR NEW.calculation_run_id IS DISTINCT FROM OLD.calculation_run_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable: identity columns of outcome_monetization_dispositions (id, organization_id, outcome_id, calculation_run_id, created_by, created_at) cannot change'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_outcome_monetization_dispositions_approval_guard ON outcome_monetization_dispositions;--> statement-breakpoint
CREATE TRIGGER trg_outcome_monetization_dispositions_approval_guard
  BEFORE INSERT OR UPDATE OR DELETE ON outcome_monetization_dispositions
  FOR EACH ROW EXECUTE FUNCTION uellix_guard_disposition_run_approval();--> statement-breakpoint

CREATE OR REPLACE FUNCTION uellix_lock_run_dispositions_on_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    -- Exclusive: conflicts with the guard's shared lock for the same run.
    PERFORM pg_advisory_xact_lock(60, hashtext(NEW.calculation_run_id::text));
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_sroi_run_reviews_approval_lock ON sroi_run_reviews;--> statement-breakpoint
CREATE TRIGGER trg_sroi_run_reviews_approval_lock
  BEFORE INSERT OR UPDATE ON sroi_run_reviews
  FOR EACH ROW EXECUTE FUNCTION uellix_lock_run_dispositions_on_approval();
