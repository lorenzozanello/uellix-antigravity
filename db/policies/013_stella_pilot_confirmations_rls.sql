-- db/policies/013_stella_pilot_confirmations_rls.sql
-- Etapa B0 (modo piloto restringido) — RLS + grant mínimo para
-- stella_pilot_confirmations, mismo patrón que
-- 009_stella_ai_consent_rls.sql / 012_stella_retention_rls.sql: SELECT
-- únicamente para authenticated, aislado por organización; sin INSERT/
-- UPDATE/DELETE (las escrituras legítimas pasan por
-- lib/stella/pilot/confirmation-service.ts vía Drizzle sobre DATABASE_URL,
-- rol postgres, BYPASSA RLS).

GRANT SELECT ON stella_pilot_confirmations TO authenticated;

ALTER TABLE stella_pilot_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "spc_select_member" ON stella_pilot_confirmations;
CREATE POLICY "spc_select_member"
ON stella_pilot_confirmations FOR SELECT
USING (
  organization_id = ANY(private.current_user_org_ids())
);

-- No INSERT/UPDATE/DELETE policy → denied by RLS regardless of GRANT (and no
-- such GRANT exists for `authenticated` either — two independent layers of
-- defense from creation, same as every other Stella governance table).
