-- FIBIU-01 — PC-01B regime boundary, stage B (FIBDB-003/FIBC-004).
--
-- The boundary marker itself. Every project row that already exists the
-- moment this migration runs is, by definition, pre-PC-01B — the row set is
-- derived from existing table content (BACKFILL_CLASS: SAFE_AUTOMATIC_BACKFILL),
-- not literal data, so on an empty database this necessarily affects zero rows.
-- Split from 0040 because that unit's DML is literal seed data instead — a
-- different db/hosted/baseline-manifest.ts classification.

UPDATE "projects" SET "governance_regime" = 'pre_pc01b' WHERE "governance_regime" IS NULL;
