-- db/policies/010_proxy_material_fields_registry_rls.sql
-- W2-B2-R1 / R-B2-07 — RLS for proxy_material_fields_registry (FIBIU-10 /
-- FIBDB-007), stage A. AG-B2-2 (W2_B2_REMEDIATION_AUTHORITY_v1.0.0) adjudicated
-- A_RLS_REQUIRED_IN_STAGE_A: FIBDB-007 declares "RLS: read-all members" and
-- migration_stage ['A'] only — there is no stage B or E to defer to.
-- Structurally identical to db/policies/009_governed_model_registry_rls.sql,
-- the same global, org-agnostic reference-catalog shape (no organization_id
-- to scope by).
--
-- ENABLE, never FORCE: the seed is migration-owner DML (0055 for 1.0.0, 0056
-- for 1.1.0); FORCE would subject the owner to policy and break both the seed
-- on reprovision and every future registry_version seed.
-- No INSERT/UPDATE/DELETE policy: with RLS enabled and no write policy, rows
-- are structurally immutable to every non-owner role — which is how
-- FIBDB-007's "immutable per version" becomes enforced rather than asserted.
-- The existing GRANT SELECT TO authenticated (0055) is retained unchanged.
-- Run in the Supabase SQL Editor. Idempotent: drops the policy before recreating.

ALTER TABLE proxy_material_fields_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "proxy_material_fields_registry_select" ON proxy_material_fields_registry;
CREATE POLICY "proxy_material_fields_registry_select" ON proxy_material_fields_registry FOR SELECT
USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policies: writes only via the migration-owner seed path.
