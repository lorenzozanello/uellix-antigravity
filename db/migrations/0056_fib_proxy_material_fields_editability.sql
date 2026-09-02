-- W2-B2-R1 / R-B2-03 — exhaustive persisted-field registry and the
-- editability dimension (FIBC-013 / FIBDB-007; W2_B2_REMEDIATION_AUTHORITY
-- _v1.0.0 material_registry_exhaustiveness_disposition and
-- AG-B2-3-DERIVED ORTHOGONAL_EDITABILITY_DIMENSION).
--
-- Hand-edited from the generated schema diff to bundle three things:
--   1. ADD COLUMN editability, NULLable with no default and a CHECK over the
--      three frozen values. registry_version '1.0.0' rows keep NULL — that
--      version never classified this dimension, and FIBDB-007's "immutable
--      per version" forbids rewriting it. No 1.0.0 row is touched.
--   2. The complete classification as a NEW registry_version '1.1.0': one
--      row per persisted column of financial_proxies (24) and
--      financial_proxy_versions (46) — 70 literal rows, generated
--      mechanically from lib/pipeline/proxy-material-change.ts's
--      PROXY_MATERIAL_FIELDS_REGISTRY (the service-layer mirror) so the two
--      cannot differ by transcription; a committed reflective test proves
--      set equality with db/schema.ts in both directions.
--   3. The governed_model_registry append ('PROXY_MATERIAL_FIELDS','1.1.0'),
--      by the same append-only convention as 0040 — the 1.0.0 row is NOT
--      modified; getCurrentGovernedModelVersion now resolves 1.1.0.
--
-- The category CHECK constraint is NOT modified: the ten sealed FIBC-013
-- categories are not extended. Approval/audit metadata rows carry category
-- non_material AND editability system_sealed — never "editable non-material".

ALTER TABLE "proxy_material_fields_registry" ADD COLUMN "editability" varchar(20);--> statement-breakpoint
ALTER TABLE "proxy_material_fields_registry" ADD CONSTRAINT "proxy_material_fields_registry_editability_check" CHECK ("proxy_material_fields_registry"."editability" IS NULL OR "proxy_material_fields_registry"."editability" IN ('user_editable','system_derived','system_sealed'));--> statement-breakpoint
INSERT INTO "proxy_material_fields_registry" ("registry_version", "table_name", "field_name", "category", "editability") VALUES
	('1.1.0', 'financial_proxies', 'id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'organization_id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'source_id', 'source_provenance', 'user_editable'),
	('1.1.0', 'financial_proxies', 'name', 'non_material', 'user_editable'),
	('1.1.0', 'financial_proxies', 'description', 'non_material', 'user_editable'),
	('1.1.0', 'financial_proxies', 'proxy_type', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxies', 'country', 'geographic_institutional_context', 'user_editable'),
	('1.1.0', 'financial_proxies', 'territory', 'geographic_institutional_context', 'user_editable'),
	('1.1.0', 'financial_proxies', 'currency', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxies', 'value', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxies', 'value_usd', 'identity_economic_value', 'system_derived'),
	('1.1.0', 'financial_proxies', 'fx_rate_id', 'transformations', 'system_derived'),
	('1.1.0', 'financial_proxies', 'unit', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxies', 'reference_year', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxies', 'thematic_area', 'outcome_stakeholder_correspondence', 'user_editable'),
	('1.1.0', 'financial_proxies', 'methodology', 'methodology_comparability', 'user_editable'),
	('1.1.0', 'financial_proxies', 'confidence_level', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxies', 'methodological_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxies', 'review_status', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'reviewer_id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'reviewed_at', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'created_by', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'created_at', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxies', 'updated_at', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'organization_id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'financial_proxy_id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'ordinal', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'source_id', 'source_provenance', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'value', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'currency', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'unit', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'reference_year', 'identity_economic_value', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'value_usd', 'identity_economic_value', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'fx_rate_id', 'transformations', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'country', 'geographic_institutional_context', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'territory', 'geographic_institutional_context', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'thematic_area', 'outcome_stakeholder_correspondence', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'methodology', 'methodology_comparability', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'geographic_contextual_scope', 'geographic_institutional_context', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'linked_outcome_context', 'outcome_stakeholder_correspondence', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'recoverable_reference', 'source_provenance', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'relevance_justification', 'provenance_rationale', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'documented_transformations', 'transformations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'consultation_date', 'temporal_context', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'c1_source_quality_verifiability', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'c2_outcome_correspondence', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'c3_stakeholder_population_fit', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'c4_geographic_context_fit', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'c5_temporal_fit', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'c6_methodological_unit_comparability', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r1_provenance_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r2_source_limitation_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r3_conceptual_fit_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r4_geographic_population_transfer_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r5_temporal_obsolescence_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r6_transformation_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'r7_methodological_uncertainty_risk', 'rubric_ratings_derivations', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'confidence_score', 'rubric_ratings_derivations', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'confidence_level', 'rubric_ratings_derivations', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'methodological_risk_score', 'rubric_ratings_derivations', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'methodological_risk', 'rubric_ratings_derivations', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'rubric_version', 'rubric_ratings_derivations', 'system_derived'),
	('1.1.0', 'financial_proxy_versions', 'exceptional_defendibility_determination', 'exceptional_defendibility_determination', 'user_editable'),
	('1.1.0', 'financial_proxy_versions', 'review_status', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'reviewer_id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'reviewed_at', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'supersedes_version_id', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'created_by', 'non_material', 'system_sealed'),
	('1.1.0', 'financial_proxy_versions', 'created_at', 'non_material', 'system_sealed')
ON CONFLICT ("registry_version", "table_name", "field_name") DO NOTHING;--> statement-breakpoint
-- Append-only governed model version (FIBC-003 convention of 0040): the
-- 1.0.0 row is untouched; ON CONFLICT DO NOTHING keeps this idempotent.
INSERT INTO "governed_model_registry" ("model_id", "version", "definition_hash") VALUES
	('PROXY_MATERIAL_FIELDS', '1.1.0', 'ea6967b720ff52f6bfbc54bc509ae57568d566cae57ba7c1cab05f6cdac75a14')
ON CONFLICT ("model_id", "version") DO NOTHING;
