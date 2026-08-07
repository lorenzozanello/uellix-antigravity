-- ============================================================================
-- GENERATED — DO NOT EDIT. Unit ZERO of PHASE_BASELINE.
-- Regenerate with `pnpm journal:generate`; `pnpm journal:verify` compares bytes.
-- ============================================================================
--
-- Runs BEFORE unit 1, because a unit cannot record itself in a table that does
-- not exist. This is the ONLY uellix_* schema PHASE_BASELINE creates.
--
--   psql -1 -v ON_ERROR_STOP=1 -v uellix_project_ref=<staging-ref> -f db/prepared/journal/000_journal_bootstrap.sql
--
-- ============================================================================
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS uellix_provisioning;

CREATE TABLE IF NOT EXISTS uellix_provisioning.applied_units (
  id                      bigserial   PRIMARY KEY,
  environment             text        NOT NULL,
  project_ref             text        NOT NULL,
  package_id              text        NOT NULL,
  phase                   text        NOT NULL,
  source_sha256           text        NOT NULL,
  derived_sha256          text,
  security_surface_digest text,
  status                  text        NOT NULL,
  applied_at              timestamptz NOT NULL DEFAULT now(),
  apply_current_user      text        NOT NULL DEFAULT current_user,
  apply_session_user      text        NOT NULL DEFAULT session_user,
  CONSTRAINT applied_units_status_check CHECK (
    status IN ('APPLIED', 'FAILED', 'MANUAL_BOUNDARY_PENDING', 'MANUAL_BOUNDARY_VERIFIED')
  ),
  CONSTRAINT applied_units_env_check         CHECK (environment = 'staging'),
  CONSTRAINT applied_units_project_ref_check CHECK (project_ref ~ '^[a-z]{20}$'),
  CONSTRAINT applied_units_sha_check         CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  -- THE VETO. A row naming production raises inside the unit's transaction, so
  -- the unit rolls back. Applying to the wrong project stops being a thing that
  -- gets noticed afterwards.
  CONSTRAINT applied_units_not_production_check CHECK (project_ref NOT IN ('ctaxtgujyyprgynmnvtq'))
);

-- One APPLIED row per unit per project. 28 of the 40 Drizzle units cannot
-- survive a second application, so the database refuses to RECORD one rather
-- than leaving two contradictory rows for a reader to arbitrate.
CREATE UNIQUE INDEX IF NOT EXISTS applied_units_one_applied_per_package
  ON uellix_provisioning.applied_units (project_ref, package_id)
  WHERE status = 'APPLIED';

-- The boundary ledger for unit 41 PART B is a SEPARATE row shape: at most one
-- open boundary per project, so a second PENDING cannot hide an unfinished one.
CREATE UNIQUE INDEX IF NOT EXISTS applied_units_one_open_boundary
  ON uellix_provisioning.applied_units (project_ref, package_id)
  WHERE status = 'MANUAL_BOUNDARY_PENDING';
