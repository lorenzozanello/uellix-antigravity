-- FIBIU-01 — PC-01B regime boundary extended to outcome_taxonomy_mappings,
-- stage A/B (FIBC-004/FIBDB-003/FIBDB-042/FIBDB-054).
--
-- W1-05-RM2 (HPO-DEC-1, owner-unit incremental regime activation): Wave 1
-- applies governance_regime to every object whose governance regime is
-- activated by a Wave 1 authority. FIBDB-054's final design states the
-- regime for a taxonomy mapping "is carried entirely by the existing
-- governance_regime column (FIBDB-003)" — a column that did not yet exist on
-- this table. This migration is the minimal remediation closing that gap;
-- it does NOT extend governance_regime to any other later-wave object
-- (outcomes, indicators, stakeholder_groups, evidence_items, ...) — those
-- remain owned by FIBIU-30 (wave 6), which closes global coverage.
--
-- Combined stage A (additive column + CHECK) and stage B (safe automatic
-- backfill) in one file, mirroring 0045's precedent for a new column with
-- no earlier, less-protected state to stage separately from.
--
-- drizzle-kit generate also proposed, unrelated to this unit:
--   ALTER TABLE "stella_interactions" ALTER COLUMN "model_used" DROP DEFAULT;
-- This is the same pre-existing stella_interactions.model_used DEFAULT drift
-- already noted and deliberately left visible by 0043/0045/0046 (out of
-- scope for FIBIU-01 and W1-05-RM1 R-7 alike). Removed from this file for
-- the same reason; the snapshot below keeps tracking the stale default so
-- the drift resurfaces at the appropriate integration gate instead of being
-- silently absorbed here.

ALTER TABLE "outcome_taxonomy_mappings" ADD COLUMN "governance_regime" varchar(20);--> statement-breakpoint
ALTER TABLE "outcome_taxonomy_mappings" ADD CONSTRAINT "outcome_taxonomy_mappings_governance_regime_check" CHECK ("outcome_taxonomy_mappings"."governance_regime" IN ('pre_pc01b', 'pc01b'));--> statement-breakpoint

-- Stage B: every mapping row that already exists the moment this migration
-- runs is, by definition, pre-PC-01B — derived from existing table content
-- (BACKFILL_CLASS: SAFE_AUTOMATIC_BACKFILL), not literal data, so on an
-- empty database this necessarily affects zero rows.
UPDATE "outcome_taxonomy_mappings" SET "governance_regime" = 'pre_pc01b' WHERE "governance_regime" IS NULL;
