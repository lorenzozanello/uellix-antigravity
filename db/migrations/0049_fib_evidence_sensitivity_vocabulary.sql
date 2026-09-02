-- FIBIU-05 — evidence sensitivity and treatment vocabulary, stage A
-- (FIBC-007/FIBDB-043's evidence_versions slice — the erasure_state slice
-- of the same FIBDB-043 item is owned by FIBIU-07, see
-- 0051_fib_evidence_erasure_substrate.sql). Pure DDL on the columns FIBIU-04
-- already created on evidence_versions; no new table.
--
-- Generated cleanly by drizzle-kit generate (three ADD CONSTRAINT
-- statements, no unrelated statements to hand-remove this time).
--
-- The third CHECK is FIBDB-043's own pairing rule: "treatment NOT NULL when
-- sensitivity_classification <> 'non_sensitive'". Unclassified
-- (sensitivity_classification IS NULL) evidence is unaffected by this CHECK
-- — the fail-closed gate that blocks such evidence from reaching `approved`
-- is a service-layer contract (lib/pipeline/evidence.ts), not a DB
-- constraint, matching the FIBC-040 reasoning against DB-level CHECKs the
-- FIB text explicitly applies elsewhere in this baseline.

ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_sensitivity_classification_check" CHECK ("evidence_versions"."sensitivity_classification" IS NULL OR "evidence_versions"."sensitivity_classification" IN ('non_sensitive', 'personal_data', 'identifiable_restricted', 'confidential_third_party', 'special_category'));--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_treatment_check" CHECK ("evidence_versions"."treatment" IS NULL OR "evidence_versions"."treatment" IN ('not_required', 'anonymized', 'pseudonymized', 'identifiable_restricted_access'));--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_treatment_required_check" CHECK ("evidence_versions"."sensitivity_classification" IS NULL OR "evidence_versions"."sensitivity_classification" = 'non_sensitive' OR "evidence_versions"."treatment" IS NOT NULL);
