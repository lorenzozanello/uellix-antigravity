-- FIBIU-10 — material change policy and proxy field registry, stage A
-- (FIBC-013/FIBDB-007).
--
-- Hand-edited from the generated schema diff to bundle the deploy-time seed
-- (BACKFILL_CLASS: SCHEMA_ONLY — 39 fixed rows, one per persisted proxy
-- field, never derived from data) with the additive schema change, mirroring
-- 0040_governed_model_registry.sql's own treatment. registry_version '1.0.0'
-- matches the PROXY_MATERIAL_FIELDS row already seeded in
-- governed_model_registry (0040) — this table is that governed model's own
-- versioned content, read via getCurrentGovernedModelVersion elsewhere.
--
-- Every field lib/pipeline/proxies.ts's FinancialProxyInput can edit is
-- classified here; two (name, description) are the deliberate non_material
-- rows — pure display labels with no methodological content. The thirteen
-- rubric factor columns plus their five derived/version fields (category 9)
-- and exceptional_defendibility_determination (category 10) are also
-- registered even though they are written through a different entry point
-- (lib/pipeline/financial-proxy-rubric.ts, not FinancialProxyInput) — FIBC-013
-- requires EVERY persisted proxy field classified, not only the ones one
-- particular function edits. See lib/pipeline/proxy-material-change.ts's
-- MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY for the hand-kept service-layer
-- mirror of the FinancialProxyInput-reachable subset of these same rows.
CREATE TABLE "proxy_material_fields_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registry_version" varchar(20) NOT NULL,
	"table_name" varchar(60) NOT NULL,
	"field_name" varchar(100) NOT NULL,
	"category" varchar(60) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_material_fields_registry_version_table_field_unique" UNIQUE("registry_version","table_name","field_name"),
	CONSTRAINT "proxy_material_fields_registry_category_check" CHECK ("proxy_material_fields_registry"."category" IN (
      'identity_economic_value','source_provenance','outcome_stakeholder_correspondence',
      'geographic_institutional_context','temporal_context','methodology_comparability',
      'transformations','provenance_rationale','rubric_ratings_derivations',
      'exceptional_defendibility_determination','non_material'
    ))
);
--> statement-breakpoint
CREATE INDEX "idx_proxy_material_fields_registry_version" ON "proxy_material_fields_registry" USING btree ("registry_version");--> statement-breakpoint
-- Read-only catalog grant, mirroring 0040_governed_model_registry.sql's own
-- treatment (no INSERT/UPDATE/DELETE) — RLS: read-all members, per FIBDB-007.
GRANT SELECT ON public.proxy_material_fields_registry TO authenticated;--> statement-breakpoint
INSERT INTO "proxy_material_fields_registry" ("registry_version", "table_name", "field_name", "category") VALUES
	('1.0.0', 'financial_proxies', 'name', 'non_material'),
	('1.0.0', 'financial_proxies', 'description', 'non_material'),
	('1.0.0', 'financial_proxies', 'proxy_type', 'identity_economic_value'),
	('1.0.0', 'financial_proxies', 'confidence_level', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxies', 'methodological_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'source_id', 'source_provenance'),
	('1.0.0', 'financial_proxy_versions', 'value', 'identity_economic_value'),
	('1.0.0', 'financial_proxy_versions', 'currency', 'identity_economic_value'),
	('1.0.0', 'financial_proxy_versions', 'unit', 'identity_economic_value'),
	('1.0.0', 'financial_proxy_versions', 'reference_year', 'identity_economic_value'),
	('1.0.0', 'financial_proxy_versions', 'country', 'geographic_institutional_context'),
	('1.0.0', 'financial_proxy_versions', 'territory', 'geographic_institutional_context'),
	('1.0.0', 'financial_proxy_versions', 'geographic_contextual_scope', 'geographic_institutional_context'),
	('1.0.0', 'financial_proxy_versions', 'thematic_area', 'outcome_stakeholder_correspondence'),
	('1.0.0', 'financial_proxy_versions', 'linked_outcome_context', 'outcome_stakeholder_correspondence'),
	('1.0.0', 'financial_proxy_versions', 'consultation_date', 'temporal_context'),
	('1.0.0', 'financial_proxy_versions', 'methodology', 'methodology_comparability'),
	('1.0.0', 'financial_proxy_versions', 'documented_transformations', 'transformations'),
	('1.0.0', 'financial_proxy_versions', 'relevance_justification', 'provenance_rationale'),
	('1.0.0', 'financial_proxy_versions', 'recoverable_reference', 'source_provenance'),
	('1.0.0', 'financial_proxy_versions', 'c1_source_quality_verifiability', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'c2_outcome_correspondence', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'c3_stakeholder_population_fit', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'c4_geographic_context_fit', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'c5_temporal_fit', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'c6_methodological_unit_comparability', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r1_provenance_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r2_source_limitation_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r3_conceptual_fit_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r4_geographic_population_transfer_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r5_temporal_obsolescence_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r6_transformation_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'r7_methodological_uncertainty_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'confidence_score', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'confidence_level', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'methodological_risk_score', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'methodological_risk', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'rubric_version', 'rubric_ratings_derivations'),
	('1.0.0', 'financial_proxy_versions', 'exceptional_defendibility_determination', 'exceptional_defendibility_determination')
ON CONFLICT ("registry_version", "table_name", "field_name") DO NOTHING;