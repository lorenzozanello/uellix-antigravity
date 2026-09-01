ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_rubric_factor_range_check" CHECK (("financial_proxy_versions"."c1_source_quality_verifiability" IS NULL OR "financial_proxy_versions"."c1_source_quality_verifiability" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."c2_outcome_correspondence" IS NULL OR "financial_proxy_versions"."c2_outcome_correspondence" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."c3_stakeholder_population_fit" IS NULL OR "financial_proxy_versions"."c3_stakeholder_population_fit" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."c4_geographic_context_fit" IS NULL OR "financial_proxy_versions"."c4_geographic_context_fit" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."c5_temporal_fit" IS NULL OR "financial_proxy_versions"."c5_temporal_fit" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."c6_methodological_unit_comparability" IS NULL OR "financial_proxy_versions"."c6_methodological_unit_comparability" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r1_provenance_risk" IS NULL OR "financial_proxy_versions"."r1_provenance_risk" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r2_source_limitation_risk" IS NULL OR "financial_proxy_versions"."r2_source_limitation_risk" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r3_conceptual_fit_risk" IS NULL OR "financial_proxy_versions"."r3_conceptual_fit_risk" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r4_geographic_population_transfer_risk" IS NULL OR "financial_proxy_versions"."r4_geographic_population_transfer_risk" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r5_temporal_obsolescence_risk" IS NULL OR "financial_proxy_versions"."r5_temporal_obsolescence_risk" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r6_transformation_risk" IS NULL OR "financial_proxy_versions"."r6_transformation_risk" BETWEEN 0 AND 3)
      AND ("financial_proxy_versions"."r7_methodological_uncertainty_risk" IS NULL OR "financial_proxy_versions"."r7_methodological_uncertainty_risk" BETWEEN 0 AND 3));--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_confidence_derivation_check" CHECK ("financial_proxy_versions"."confidence_score" IS NULL OR (
      "financial_proxy_versions"."c1_source_quality_verifiability" IS NOT NULL AND "financial_proxy_versions"."c2_outcome_correspondence" IS NOT NULL
      AND "financial_proxy_versions"."c3_stakeholder_population_fit" IS NOT NULL AND "financial_proxy_versions"."c4_geographic_context_fit" IS NOT NULL
      AND "financial_proxy_versions"."c5_temporal_fit" IS NOT NULL AND "financial_proxy_versions"."c6_methodological_unit_comparability" IS NOT NULL
      AND "financial_proxy_versions"."confidence_score" = ROUND(100.0 * (
        "financial_proxy_versions"."c1_source_quality_verifiability" + "financial_proxy_versions"."c2_outcome_correspondence" + "financial_proxy_versions"."c3_stakeholder_population_fit"
        + "financial_proxy_versions"."c4_geographic_context_fit" + "financial_proxy_versions"."c5_temporal_fit" + "financial_proxy_versions"."c6_methodological_unit_comparability"
      ) / 18)
    ));--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_risk_derivation_check" CHECK ("financial_proxy_versions"."methodological_risk_score" IS NULL OR (
      "financial_proxy_versions"."r1_provenance_risk" IS NOT NULL AND "financial_proxy_versions"."r2_source_limitation_risk" IS NOT NULL
      AND "financial_proxy_versions"."r3_conceptual_fit_risk" IS NOT NULL AND "financial_proxy_versions"."r4_geographic_population_transfer_risk" IS NOT NULL
      AND "financial_proxy_versions"."r5_temporal_obsolescence_risk" IS NOT NULL AND "financial_proxy_versions"."r6_transformation_risk" IS NOT NULL
      AND "financial_proxy_versions"."r7_methodological_uncertainty_risk" IS NOT NULL
      AND "financial_proxy_versions"."methodological_risk_score" = ROUND(100.0 * (
        "financial_proxy_versions"."r1_provenance_risk" + "financial_proxy_versions"."r2_source_limitation_risk" + "financial_proxy_versions"."r3_conceptual_fit_risk"
        + "financial_proxy_versions"."r4_geographic_population_transfer_risk" + "financial_proxy_versions"."r5_temporal_obsolescence_risk"
        + "financial_proxy_versions"."r6_transformation_risk" + "financial_proxy_versions"."r7_methodological_uncertainty_risk"
      ) / 21)
    ));--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_confidence_ceiling_check" CHECK ("financial_proxy_versions"."confidence_level" IS NULL OR (
      (NOT ("financial_proxy_versions"."c1_source_quality_verifiability" = 0 OR "financial_proxy_versions"."c2_outcome_correspondence" = 0) OR "financial_proxy_versions"."confidence_level" = 'low')
      AND (NOT (
        "financial_proxy_versions"."c1_source_quality_verifiability" = 0 OR "financial_proxy_versions"."c2_outcome_correspondence" = 0 OR "financial_proxy_versions"."c3_stakeholder_population_fit" = 0
        OR "financial_proxy_versions"."c4_geographic_context_fit" = 0 OR "financial_proxy_versions"."c5_temporal_fit" = 0 OR "financial_proxy_versions"."c6_methodological_unit_comparability" = 0
      ) OR "financial_proxy_versions"."confidence_level" != 'high')
    ));--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_risk_floor_check" CHECK ("financial_proxy_versions"."methodological_risk" IS NULL OR (
      (NOT (
        "financial_proxy_versions"."r1_provenance_risk" = 3 OR "financial_proxy_versions"."r2_source_limitation_risk" = 3 OR "financial_proxy_versions"."r3_conceptual_fit_risk" = 3
        OR "financial_proxy_versions"."r4_geographic_population_transfer_risk" = 3 OR "financial_proxy_versions"."r5_temporal_obsolescence_risk" = 3
        OR "financial_proxy_versions"."r6_transformation_risk" = 3 OR "financial_proxy_versions"."r7_methodological_uncertainty_risk" = 3
      ) OR "financial_proxy_versions"."methodological_risk" = 'high')
      AND (NOT (
        "financial_proxy_versions"."r1_provenance_risk" >= 2 OR "financial_proxy_versions"."r2_source_limitation_risk" >= 2 OR "financial_proxy_versions"."r3_conceptual_fit_risk" >= 2
        OR "financial_proxy_versions"."r4_geographic_population_transfer_risk" >= 2 OR "financial_proxy_versions"."r5_temporal_obsolescence_risk" >= 2
        OR "financial_proxy_versions"."r6_transformation_risk" >= 2 OR "financial_proxy_versions"."r7_methodological_uncertainty_risk" >= 2
      ) OR "financial_proxy_versions"."methodological_risk" != 'low')
    ));