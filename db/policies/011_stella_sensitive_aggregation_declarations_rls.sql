-- db/policies/011_stella_sensitive_aggregation_declarations_rls.sql
-- RLS policies for stella_sensitive_aggregation_declarations (Etapa A2.3.1,
-- STL-A231-006). Run against the local Supabase stack after applying
-- migration 0046_stella_sensitive_aggregation_declarations.sql (same
-- manual-apply convention as 002_stella_interactions_rls.sql /
-- 009_stella_ai_consent_rls.sql — see those files' headers for context).
--
-- Row-level policy: any ACTIVE member of the organization may SELECT a row
-- (same row-level shape as most Uellix tables — no per-field split at the
-- RLS layer). The field-level minimization the spec asks for ("un viewer
-- puede conocer el estado, pero no necesariamente el historial completo de
-- actor/fechas") is enforced in the APPLICATION layer instead
-- (lib/stella/aggregation/declaration-query.ts's typed
-- SensitiveAggregationDeclarationStatus never exposes declaredBy/verifiedBy/
-- revokedBy/reasons to any caller — that is a deliberate, documented
-- decision, not an oversight: Postgres RLS is row-level, and splitting this
-- single small table into a summary/detail pair purely to enforce a
-- column-level restriction would be over-engineering for a table with no UI
-- consumer yet (same call already made for stella_ai_consent_events, see
-- that policy file's header).
--
-- No INSERT/UPDATE/DELETE policy: denied by RLS regardless of GRANT. This
-- table's `authenticated` GRANT is ALREADY SELECT-only from creation
-- (migration 0046) — two independent layers of defense from day one.
-- Legitimate writes happen exclusively via
-- lib/stella/aggregation/declaration-service.ts, using Drizzle over
-- DATABASE_URL (the `postgres` superuser role, BYPASSRLS).

ALTER TABLE stella_sensitive_aggregation_declarations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ssad_select_member" ON stella_sensitive_aggregation_declarations;
CREATE POLICY "ssad_select_member"
ON stella_sensitive_aggregation_declarations FOR SELECT
USING (
  organization_id = ANY(private.current_user_org_ids())
);

-- No INSERT/UPDATE/DELETE policy → denied by RLS regardless of GRANT.
