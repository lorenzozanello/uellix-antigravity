-- Custom SQL migration: Immutability module
CREATE OR REPLACE FUNCTION uellix_forbid_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_sroi_runs_append_only ON sroi_calculation_runs;
CREATE TRIGGER trg_sroi_runs_append_only
  BEFORE UPDATE OR DELETE ON sroi_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_sroi_line_items_append_only ON sroi_calculation_line_items;
CREATE TRIGGER trg_sroi_line_items_append_only
  BEFORE UPDATE OR DELETE ON sroi_calculation_line_items
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();