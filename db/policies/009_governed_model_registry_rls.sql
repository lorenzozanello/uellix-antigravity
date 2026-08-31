-- db/policies/009_governed_model_registry_rls.sql
-- RLS for governed_model_registry (FIBIU-01 / FIBDB-002). A global, org-agnostic
-- registry: readable by any authenticated user ("read for all org members" per
-- FIBDB-002 — there is no organization_id to scope by). Writes only via the
-- service-role seed path (bundled with the schema migration); no INSERT/UPDATE/
-- DELETE policy exists, so rows are structurally immutable once written.
-- Run in the Supabase SQL Editor. Idempotent: drops policies before recreating.

ALTER TABLE governed_model_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "governed_model_registry_select" ON governed_model_registry;
CREATE POLICY "governed_model_registry_select" ON governed_model_registry FOR SELECT
USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policies: writes only via the service-role seed path.
