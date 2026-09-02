-- FIBIU-02 — run version identity triple, stage A (FIBC-001/FIBDB-001).
--
-- Adds the three columns to sroi_calculation_runs: methodology_version,
-- calculation_engine_version, build_identity. All three are nullable —
-- every run created before this unit keeps them permanently NULL
-- (BACKFILL_CLASS: IMPOSSIBLE_TO_BACKFILL, FIBDB-001), which is how a
-- legacy/pre-versioning run stays distinguishable from a governed one.
-- No CHECK constraint requiring them NOT NULL is added here — the fail-closed
-- guarantee ("refuse to persist a run if any of the three cannot be
-- resolved") is enforced in the service layer at INSERT time
-- (lib/pipeline/run-version-identity.ts), not at the schema boundary, so a
-- historical NULL row is never rejected by its own table.
--
-- Write-once: the existing 0030_immutability.sql trigger
-- (trg_sroi_runs_append_only) already forbids UPDATE on this table, so no
-- new immutability enforcement is needed for these columns.

ALTER TABLE "sroi_calculation_runs" ADD COLUMN "methodology_version" varchar(20);--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ADD COLUMN "calculation_engine_version" varchar(20);--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ADD COLUMN "build_identity" varchar(100);
