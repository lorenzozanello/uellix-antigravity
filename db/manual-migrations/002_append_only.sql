-- Backlog #4 — make append-only a DB invariant, not just an app convention.
--
-- Today nothing stops the service role (which bypasses RLS) from UPDATE/DELETE
-- on the audit log or persisted calculation runs, yet the privacy policy states
-- these records "cannot be edited or deleted retroactively". A BEFORE trigger
-- enforces that at the database level, for every role including the owner —
-- REVOKE alone would not stop the table owner.
--
-- Scope: audit_logs is strictly append-only. Calculation runs + line items are
-- immutable once written (a re-calculation creates a NEW versioned run, it never
-- mutates an old one). Report status transitions (draft -> locked) still need
-- UPDATE, so reports are intentionally NOT covered here.

CREATE OR REPLACE FUNCTION uellix_forbid_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

-- audit_logs: no UPDATE, no DELETE.
DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();

-- sroi_calculation_runs: immutable once persisted.
DROP TRIGGER IF EXISTS trg_sroi_runs_append_only ON sroi_calculation_runs;
CREATE TRIGGER trg_sroi_runs_append_only
  BEFORE UPDATE OR DELETE ON sroi_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();

-- sroi_calculation_line_items: immutable once persisted.
DROP TRIGGER IF EXISTS trg_sroi_line_items_append_only ON sroi_calculation_line_items;
CREATE TRIGGER trg_sroi_line_items_append_only
  BEFORE UPDATE OR DELETE ON sroi_calculation_line_items
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();

-- Rollback (if ever needed):
--   DROP TRIGGER trg_audit_logs_append_only ON audit_logs;
--   DROP TRIGGER trg_sroi_runs_append_only ON sroi_calculation_runs;
--   DROP TRIGGER trg_sroi_line_items_append_only ON sroi_calculation_line_items;
--   DROP FUNCTION uellix_forbid_mutation();
