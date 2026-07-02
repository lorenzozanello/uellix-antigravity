-- 0013_performance_indexes
-- Hand-authored (matches the 0011/0012 pattern) because drizzle-kit generate
-- cannot run non-interactively against this repo: the meta snapshots stop at
-- 0010, so `generate` diffs the current schema against a stale snapshot and
-- prompts for column-rename resolution. These are pure additive indexes on
-- foreign-key columns that every tenant-scoped query already filters by;
-- Postgres does not auto-index FKs, so without these each list/read did a
-- sequential scan. All use IF NOT EXISTS so this migration is idempotent.

CREATE INDEX IF NOT EXISTS "idx_audit_logs_created_at" ON "audit_logs" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_organization_id" ON "audit_logs" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invitations_token_hash" ON "invitations" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invitations_organization_id" ON "invitations" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_portfolios_organization_id" ON "portfolios" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_organization_id" ON "projects" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_portfolio_id" ON "projects" ("portfolio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_impact_narratives_project_id" ON "impact_narratives" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stakeholder_groups_project_id" ON "stakeholder_groups" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outcomes_project_id" ON "outcomes" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outcomes_stakeholder_group_id" ON "outcomes" ("stakeholder_group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_indicators_project_id" ON "indicators" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_indicators_outcome_id" ON "indicators" ("outcome_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evidence_items_project_id" ON "evidence_items" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evidence_items_organization_id" ON "evidence_items" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evidence_items_outcome_id" ON "evidence_items" ("outcome_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evidence_items_indicator_id" ON "evidence_items" ("indicator_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proxy_sources_organization_id" ON "proxy_sources" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_financial_proxies_organization_id" ON "financial_proxies" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_financial_proxies_source_id" ON "financial_proxies" ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opa_project_id" ON "outcome_proxy_assignments" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opa_organization_id" ON "outcome_proxy_assignments" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opa_outcome_id" ON "outcome_proxy_assignments" ("outcome_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opa_proxy_id" ON "outcome_proxy_assignments" ("proxy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_investments_project_id" ON "project_investments" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_assignment_inputs_assignment_id" ON "sroi_assignment_inputs" ("assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_filter_sets_assignment_id" ON "sroi_filter_sets" ("assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_calculation_runs_project_id" ON "sroi_calculation_runs" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_line_items_run_id" ON "sroi_calculation_line_items" ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_line_items_assignment_id" ON "sroi_calculation_line_items" ("assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_run_reviews_calculation_run_id" ON "sroi_run_reviews" ("calculation_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_run_reviews_project_id" ON "sroi_run_reviews" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_run_review_items_review_id" ON "sroi_run_review_items" ("review_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_reports_project_id" ON "sroi_reports" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_reports_calculation_run_id" ON "sroi_reports" ("calculation_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sroi_report_sections_report_id" ON "sroi_report_sections" ("report_id");
