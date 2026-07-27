-- db/policies/010_stella_interactions_access_control_rls.sql
-- Etapa A2.2 (STL-A22-004, DR-007 aprobado 2026-07-26). Reemplaza la
-- política SELECT de stella_interactions definida en
-- db/policies/002_stella_interactions_rls.sql (NO se edita ese archivo — ver
-- su nota de cabecera actualizada). El resto de la protección append-only
-- (ausencia de política de INSERT/UPDATE/DELETE, privilegios de tabla
-- mínimos desde la migración 0043) permanece sin cambios: este archivo solo
-- redefine SELECT.
--
-- Matriz de acceso aprobada (ver STELLA_A2_DR007_IMPLEMENTATION_REPORT.md
-- para la matriz completa, las decisiones interpretativas y por qué esta es
-- la implementación más simple que cumple la decisión):
--   - Creador: su propia interacción, mientras conserve membresía ACTIVA en
--     esa organización (current_user_org_ids() ya filtra por status='active',
--     ver migración 0031_rls_core.sql).
--   - organization_admin / super_admin (con una membresía EXPLÍCITA de ese
--     nivel en esta organización — nunca por el flag global
--     is_super_admin): toda la organización.
--   - impact_manager / analyst: toda la organización — porque Uellix no
--     tiene ACL por proyecto hoy (mismo criterio que projects/portfolios/
--     impact_narratives, que ya usan esta lista de 4 roles para escritura
--     en 0031_rls_core.sql). Esto es el alcance real existente, no una ACL
--     nueva inventada en este bloque.
--   - reviewer, viewer: SIN acceso general (más allá de su propia
--     interacción como creador, ya cubierto arriba).
--   - Sin "OR private.current_user_is_super_admin()": eliminado
--     deliberadamente. Un super_admin global sin membresía explícita en la
--     organización no obtiene ningún acceso vía esta política. No existe
--     hoy ningún mecanismo de acceso excepcional auditado (soporte,
--     impersonación, "break glass") en el repositorio — se aplica el
--     principio de menor privilegio (denegar) en vez de construirlo dentro
--     de este bloque. Ver "Riesgos residuales" en el informe de
--     implementación.
--
-- Esta política es la contraparte RLS de
-- lib/stella/access/stella-interaction-access.ts#canReadStellaInteraction —
-- ambas deben mantenerse en sincronía manualmente (RLS no puede importar
-- código TypeScript). Un cambio en una debe replicarse en la otra.

DROP POLICY IF EXISTS "stella_interactions_select_member_or_admin" ON stella_interactions;
DROP POLICY IF EXISTS "stella_interactions_select_scoped" ON stella_interactions;

CREATE POLICY "stella_interactions_select_scoped"
ON stella_interactions FOR SELECT
USING (
  (
    created_by = auth.uid()
    AND organization_id = ANY(private.current_user_org_ids())
  )
  OR
  private.current_user_role_in_org(organization_id) IN ('organization_admin', 'super_admin', 'impact_manager', 'analyst')
);

-- No UPDATE/DELETE policy → sigue denegado (sin cambios respecto a 002).
-- No INSERT policy → sigue denegado (sin cambios respecto a 002).
