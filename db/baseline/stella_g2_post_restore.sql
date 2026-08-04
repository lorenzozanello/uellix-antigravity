-- db/baseline/stella_g2_post_restore.sql
--
-- LO QUE pg_dump --schema-only NO EMITE, Y POR QUÉ IMPORTA.
--
-- `pg_dump` trata el esquema `public` como preexistente: no lo crea, no fija
-- su propietario y no emite las entradas de ACL que corresponden a PUBLIC.
-- Sí emite los GRANT a roles nombrados (postgres, anon, authenticated,
-- service_role, uellix_*), que se encuentran al final de
-- `stella_g2_schema.sql`. Faltan exactamente dos:
--
--   1. `ALTER SCHEMA public OWNER TO pg_database_owner`
--   2. `GRANT USAGE ON SCHEMA public TO PUBLIC`   -- la entrada `=U/...`
--
-- La segunda es RR-CAP-7 y NO es cosmética. Todos los roles de capacidad
-- heredan `USAGE` sobre `public` de esa concesión a PUBLIC. Sin ella los
-- SECURITY DEFINER no pueden ni nombrar `public.users`: cada llamada de
-- capacidad falla con 42501 y el ensayo termina midiendo el sembrado en vez de
-- los paquetes. El arnés anterior lo parcheaba a mano, en línea y sin versionar
-- (`scripts/capability-dry-run.sh:104`); aquí queda versionado, hasheado en el
-- manifiesto y afirmado por `tests/capability-baseline-artifact.test.ts`.
--
-- ORDEN DE APLICACIÓN: 1) stella_g2_roles.sql  2) stella_g2_schema.sql
--                      3) este archivo.
--
-- Idempotente: puede aplicarse dos veces sin cambiar el resultado.

\restrict uellix_baseline_g2

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

-- 1. Propietario del esquema. `pg_database_owner` es un rol implícito: se
--    resuelve al propietario de la base actual, así que el baseline no queda
--    atado al nombre de la base en la que se restaure.
ALTER SCHEMA public OWNER TO pg_database_owner;

-- 2. La concesión a PUBLIC. Sin cláusula de rol, `GRANT ... TO PUBLIC` produce
--    la entrada de ACL con grantee vacío (`=U/pg_database_owner`).
GRANT USAGE ON SCHEMA public TO PUBLIC;

\unrestrict uellix_baseline_g2
