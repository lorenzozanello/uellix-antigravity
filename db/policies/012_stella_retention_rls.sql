-- db/policies/012_stella_retention_rls.sql
-- RLS policies + minimal grants for the 3 tables added by Etapa A2.4
-- (DR-004 aprobado, migración 0047_stella_retention.sql). Run against the
-- local Supabase stack after applying that migration (same manual-apply
-- convention as 002_stella_interactions_rls.sql / 009_stella_ai_consent_rls.sql
-- / 011_stella_sensitive_aggregation_declarations_rls.sql — see those files'
-- headers for context).
--
-- Baseline confirmed before writing this file: newly created tables get NO
-- default SELECT/INSERT/UPDATE/DELETE grant for `authenticated` (0033's
-- ALTER DEFAULT PRIVILEGES only auto-grants postgres/service_role; the
-- TRUNCATE/REFERENCES/TRIGGER privileges `authenticated` already has on
-- these 3 tables are Supabase project-level defaults unrelated to data
-- access — PostgREST cannot read/write a table without an explicit
-- SELECT/INSERT/UPDATE/DELETE grant regardless of those three).
--
-- Row-level policy: SELECT only, scoped to the caller's organization — same
-- row-level shape as stella_ai_consent_events/stella_sensitive_aggregation_declarations
-- (no per-field split at the RLS layer; the UI's role-gating for
-- create/verify/hold/purge actions lives in the application layer, exactly
-- like every other Stella governance table this session). No INSERT/UPDATE/
-- DELETE policy for ANY table below — every legitimate write goes through
-- lib/stella/retention/*.ts using Drizzle over DATABASE_URL (the `postgres`
-- superuser role, BYPASSES RLS). A client authenticated via PostgREST can
-- read these rows (for a future direct-consumer scenario) but can NEVER
-- create a hold, release a hold, change retention settings, or execute a
-- purge directly — those all require the server-resolved actor/role checks
-- in the service layer, never a client-supplied value.

GRANT SELECT ON stella_retention_settings TO authenticated;
GRANT SELECT ON stella_retention_holds TO authenticated;
GRANT SELECT ON stella_retention_purge_runs TO authenticated;

ALTER TABLE stella_retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE stella_retention_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE stella_retention_purge_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "srs_select_member" ON stella_retention_settings;
CREATE POLICY "srs_select_member"
ON stella_retention_settings FOR SELECT
USING (
  organization_id = ANY(private.current_user_org_ids())
);

DROP POLICY IF EXISTS "srh_select_member" ON stella_retention_holds;
CREATE POLICY "srh_select_member"
ON stella_retention_holds FOR SELECT
USING (
  organization_id = ANY(private.current_user_org_ids())
);

DROP POLICY IF EXISTS "srpr_select_member" ON stella_retention_purge_runs;
CREATE POLICY "srpr_select_member"
ON stella_retention_purge_runs FOR SELECT
USING (
  organization_id = ANY(private.current_user_org_ids())
);

-- No INSERT/UPDATE/DELETE policy on any of the 3 tables → denied by RLS
-- regardless of GRANT (and no such GRANT exists for `authenticated` either —
-- two independent layers of defense from creation, same as migration 0046).
