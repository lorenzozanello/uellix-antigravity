-- 0033_public_api_grants.sql

-- 1. Ensure basic schema usage
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- 2. Revoke everything from anon (ningún acceso a tablas de negocio)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- 3. Explicit Grants for service_role
-- service_role needs full access to bypass RLS effectively and manage all tables.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, service_role;

-- 4. Revoke EXECUTE on all functions from PUBLIC and anon by default
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- ==========================================
-- EXPLICIT GRANTS FOR authenticated ROLE
-- ==========================================
-- Business Tables (CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_investments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.funders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fx_rates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolios TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.impact_narratives TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stakeholder_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outcomes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outcome_funder_allocations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outcome_taxonomy_mappings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.indicators TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.evidence_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.proxy_sources TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_proxies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outcome_proxy_assignments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.theory_of_change_nodes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.theory_of_change_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sroi_filter_sets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sroi_assignment_inputs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sroi_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sroi_report_sections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sroi_run_reviews TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sroi_run_review_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.methodology_review_matrix TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.methodology_review_matrix_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stella_interactions TO authenticated;

-- Users (Specific)
-- No DB trigger syncs auth.users -> public.users; app/(public)/login/actions.ts
-- and lib/auth/session.ts#syncUserProfile perform an explicit
-- INSERT ... ON CONFLICT DO UPDATE on every login/signup, which requires
-- INSERT even for existing rows. Deletion is managed by trigger or cascade.
GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;

-- Append-Only Tables (No UPDATE, No DELETE)
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT SELECT, INSERT ON public.sroi_calculation_runs TO authenticated;
GRANT SELECT, INSERT ON public.sroi_calculation_line_items TO authenticated;

-- Read-Only Tables (Catalogs) (No INSERT, UPDATE, DELETE)
GRANT SELECT ON public.taxonomy_catalogs TO authenticated;
GRANT SELECT ON public.taxonomy_codes TO authenticated;

-- Security / Internal tables (NO ACCESS to authenticated)
REVOKE ALL PRIVILEGES ON public.signup_allowlist FROM authenticated;

-- Functions (Explicit EXECUTE if needed)
-- Storage policy helper functions will be granted EXECUTE to authenticated in their own Supabase migration file.
