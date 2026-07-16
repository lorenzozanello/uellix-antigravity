-- Custom SQL migration: Integrity module
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_outcome_proxy_assignment
  ON outcome_proxy_assignments (project_id, outcome_id, proxy_id)
  WHERE assignment_status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sroi_run_project_version
  ON sroi_calculation_runs (project_id, version);