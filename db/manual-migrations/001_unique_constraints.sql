-- Backlog #7 — uniqueness guards for duplicate assignments and version races.
-- Complements the application-layer guards already added in
-- lib/pipeline/proxies.ts (duplicate active assignment) and
-- lib/pipeline/sroi-calculation.ts (version computed inside a transaction).

-- ── PRECHECK 1: duplicate ACTIVE assignments (must return 0 rows) ────────────
-- If this returns rows, archive/merge the duplicates before creating the index.
SELECT project_id, outcome_id, proxy_id, count(*)
FROM outcome_proxy_assignments
WHERE assignment_status = 'active'
GROUP BY project_id, outcome_id, proxy_id
HAVING count(*) > 1;

-- ── PRECHECK 2: duplicate run versions (must return 0 rows) ──────────────────
SELECT project_id, version, count(*)
FROM sroi_calculation_runs
GROUP BY project_id, version
HAVING count(*) > 1;

-- ── APPLY (only after both prechecks return 0 rows) ─────────────────────────

-- One active assignment per (project, outcome, proxy). Partial unique index so
-- archived rows don't conflict and can coexist as history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_outcome_proxy_assignment
  ON outcome_proxy_assignments (project_id, outcome_id, proxy_id)
  WHERE assignment_status = 'active';

-- One version number per project's calculation runs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sroi_run_project_version
  ON sroi_calculation_runs (project_id, version);
