-- 0043_stella_interactions_privilege_hardening.sql
--
-- Etapa A1.5 (STL-A15-006). Defensa en profundidad para stella_interactions:
-- hasta ahora su garantia append-only dependia de UNA sola capa (la ausencia
-- de una politica RLS permisiva de UPDATE/DELETE — ver
-- db/policies/002_stella_interactions_rls.sql). El rol `authenticated`
-- conservaba, a nivel de GRANT de tabla, privilegios de INSERT/UPDATE/DELETE
-- que ninguna politica llegaba a autorizar en la practica, pero que quedarian
-- disponibles de inmediato si una migracion futura anadiera por error una
-- politica permisiva (hallazgo documentado en STELLA_THREAT_MODEL.md, I4).
--
-- Verificado antes de escribir esta migracion (Etapa A1.5, 2026-07-25):
--   - has_table_privilege('authenticated', 'public.stella_interactions', 'INSERT')
--     = true, igual para UPDATE y DELETE (grant original en
--     0033_public_api_grants.sql:50, agrupado con tablas de negocio en vez de
--     con el grupo "Append-Only Tables" del mismo archivo).
--   - recordStellaInteraction() (lib/stella/audit-log.ts) es el UNICO punto
--     de insercion en el codigo (grep confirmado sobre app/, components/,
--     lib/) y usa Drizzle sobre DATABASE_URL, que conecta como el rol
--     `postgres` (superusuario, BYPASSRLS) — un camino de conexion Postgres
--     directo, completamente independiente de PostgREST/`authenticated`.
--     Ningun flujo legitimo del producto llama a
--     supabase.from('stella_interactions').insert(...)/.update(...)/
--     .delete(...) desde el cliente ni desde ningun server action.
--   - `service_role` y `postgres` mantienen privilegios completos (no se
--     tocan aqui): son los roles administrativos que sí los necesitan.
--   - `anon` ya no tiene ningun privilegio sobre esta tabla desde
--     0033_public_api_grants.sql:7 (REVOKE ALL ... FROM anon).
--
-- Reversible: un REVOKE/GRANT es una operacion de permisos, no destructiva;
-- para revertir bastaria
--   GRANT INSERT, UPDATE, DELETE ON TABLE public.stella_interactions TO authenticated;
-- Esta migracion no borra columnas, filas ni tablas.

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.stella_interactions
FROM authenticated;

GRANT SELECT
ON TABLE public.stella_interactions
TO authenticated;
