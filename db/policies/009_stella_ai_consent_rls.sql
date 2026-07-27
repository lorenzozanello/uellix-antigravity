-- db/policies/009_stella_ai_consent_rls.sql
-- RLS policies for stella_ai_consent_events (Etapa A2.1, STL-A21-009).
-- Run against the local Supabase stack after applying migration
-- 0045_stella_ai_consent.sql (same manual-apply convention as
-- 002_stella_interactions_rls.sql — see that file's header for context).
--
-- Append-only event log:
--   - SELECT: any active member of the organization (same policy shape as
--     002_stella_interactions_rls.sql — the summarized/full-history
--     distinction discussed in STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-007
--     is deliberately NOT implemented here to avoid over-engineering a
--     per-field visibility split the UI cannot use yet; documented as a
--     limitation, not an oversight).
--   - No INSERT/UPDATE/DELETE policy: denied by RLS. Unlike
--     stella_interactions (which needed migration 0043 later to also
--     narrow its GRANT), this table's `authenticated` GRANT is ALREADY
--     SELECT-only from its creation (migration 0045) — two independent
--     layers of defense from day one, not one added retroactively.
--   - Legitimate writes happen exclusively via app/actions/stella/consent.ts,
--     through lib/stella/consent/consent-log.ts, using Drizzle over
--     DATABASE_URL (the `postgres` superuser role, BYPASSRLS).

ALTER TABLE stella_ai_consent_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stella_ai_consent_events_select_member_or_admin" ON stella_ai_consent_events;
CREATE POLICY "stella_ai_consent_events_select_member_or_admin"
ON stella_ai_consent_events FOR SELECT
USING (
  organization_id = ANY(private.current_user_org_ids())
  OR private.current_user_is_super_admin()
);

-- No INSERT/UPDATE/DELETE policy → denied by RLS regardless of GRANT.
