-- W2-B1-R3 (R-B1-04, M-1) — FIBDB-014 verbatim: "Per monetized outcome per
-- run." The B1 evidence_sufficiency_determinations table bound only to
-- outcome_id; this migration adds the missing run binding so a
-- determination recorded for one calculation run can never satisfy
-- approval of a different run merely because outcome_id matches.
--
-- Generated cleanly by drizzle-kit generate.
--
-- NOT NULL WITH NO DEFAULT ON AN EXISTING TABLE: safe here specifically
-- because evidence_sufficiency_determinations was created in this same
-- Wave 2 batch (0050_fib_evidence_sufficiency_determinations.sql) and has
-- never been applied to any hosted database — there is no historical row
-- for this ADD COLUMN to violate. FIBDB-014's BACKFILL_CLASS is
-- HUMAN_COMPLETION_REQUIRED / PROSPECTIVE, so this is remediating the
-- table's own key while it is still new, not invalidating a determination
-- corpus that exists nowhere yet.
--
-- Ordinal is re-scoped from (outcome_id, ordinal) to (outcome_id,
-- calculation_run_id, ordinal): a re-determination is ordinal+1 WITHIN the
-- same (outcome, run) pair; a new run starts its own ordinal sequence for
-- that outcome, never continuing a prior run's.

ALTER TABLE "evidence_sufficiency_determinations" DROP CONSTRAINT "evidence_sufficiency_determinations_outcome_ordinal_unique";--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD COLUMN "calculation_run_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD CONSTRAINT "evidence_sufficiency_determinations_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_evidence_sufficiency_determinations_outcome_run" ON "evidence_sufficiency_determinations" USING btree ("outcome_id","calculation_run_id");--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD CONSTRAINT "evidence_sufficiency_determinations_outcome_run_ordinal_unique" UNIQUE("outcome_id","calculation_run_id","ordinal");
