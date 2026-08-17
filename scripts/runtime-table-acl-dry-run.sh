#!/usr/bin/env bash
# scripts/runtime-table-acl-dry-run.sh
#
# Reconstruye el ESTADO HOSPEDADO POSTERIOR A stella_hosted_0006 en un
# PostgreSQL 17 DESECHABLE, reproduce el 42501 de TABLA que el retest F1
# encontró, aplica stella_hosted_0007_runtime_table_acl_contract.sql y mide el
# estado resultante.
#
# POR QUÉ ES UN ARNÉS APARTE
#   runtime-helper-contract-dry-run.sh mide la capa de FUNCIONES. Ésta mide la
#   de TABLAS, que sólo se vuelve observable una vez cerrada la primera: el
#   check de db/identity-context.ts llama a current_user_is_super_admin() antes
#   de cualquier sentencia de negocio, así que mientras faltaba ese EXECUTE
#   ninguna petición llegaba nunca a tocar una tabla.
#
# LO QUE REPRODUCE ANTES DE ARREGLARLO
#   B-2   uellix_app no puede leer ni escribir public.users -> 42501, en el
#         SELECT de loadCurrentUserWithinContext y en el upsert de
#         syncUserProfile.
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida.
#
#   bash scripts/runtime-table-acl-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_table_acl_dry_run_$$"
PKG="db/prepared/stella_hosted_0007_runtime_table_acl_contract.sql"

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -f "$PKG" ] || { echo "FALTA $PKG (ejecuta desde la raíz del repo)"; exit 1; }

echo "== arrancando contenedor desechable ($IMAGE) =="
docker run -d --name "$BOX" --network none -e POSTGRES_PASSWORD=throwaway "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 150); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$BOX" 2>/dev/null)" = "healthy" ] \
     && docker exec "$BOX" psql -U postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "el contenedor no arrancó"; docker logs "$BOX" 2>&1 | tail -20; exit 1; }

SUB='00000000-0000-4000-8000-00000000f001'
OTHER='00000000-0000-4000-8000-00000000f002'

echo "== 1. PRESTATE HOSPEDADO (post-0006, tablas sin ACL de runtime) =========="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'PRESTATE'
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['uellix_owner','uellix_migrator','uellix_writer','uellix_auditor','uellix_app'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT', r);
    END IF;
  END LOOP;
END $$;

-- La membresía REAL medida en hosted.
GRANT uellix_writer TO uellix_app   WITH INHERIT TRUE,  SET FALSE;
-- stella_hosted_0001: postgres administra uellix_owner y puede ASUMIRLO, sin heredarlo.
GRANT uellix_owner  TO postgres     WITH INHERIT FALSE, SET TRUE;
-- SOLO PARA EL ARNES: permite a esta sesion asumir el runtime con SET ROLE.
GRANT uellix_app, uellix_writer, uellix_auditor, authenticated TO postgres;

GRANT USAGE ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- uellix_owner necesita CREATE en el esquema para poder RECIBIR la propiedad de
-- una tabla (ALTER TABLE ... OWNER TO lo exige del nuevo dueño).
GRANT CREATE ON SCHEMA public TO uellix_owner;
REVOKE USAGE  ON SCHEMA auth   FROM uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;

-- Las tablas con forma suficiente para las policies reales.
CREATE TABLE public.users (
  id uuid PRIMARY KEY, email text UNIQUE, full_name text, avatar_url text,
  is_super_admin boolean NOT NULL DEFAULT false, deleted_at timestamptz,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);
CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid,
  role text, status text);
CREATE TABLE public.projects (id uuid PRIMARY KEY, organization_id uuid, name text);
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
  actor_user_id uuid, action text);

-- Las 32 restantes del contrato, con forma minima: el paquete mide PRIVILEGIOS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sroi_calculation_line_items','sroi_calculation_runs',
    'evidence_items','financial_proxies','funders','fx_rates','impact_narratives','indicators',
    'invitations','marketing_leads','methodology_review_matrix','methodology_review_matrix_items',
    'outcome_funder_allocations','outcome_proxy_assignments','outcome_taxonomy_mappings','outcomes',
    'portfolios','project_investments','proxy_sources','signup_allowlist','sroi_assignment_inputs',
    'sroi_filter_sets','sroi_report_sections','sroi_reports','sroi_run_review_items','sroi_run_reviews',
    'stakeholder_groups','taxonomy_catalogs','taxonomy_codes','theory_of_change_links',
    'theory_of_change_nodes'] LOOP
    EXECUTE format('CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid)', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- stella_interactions y las dos CAPABILITY-ONLY. La transferencia de propiedad
-- a uellix_owner se hace al FINAL del bloque: `postgres` no es superusuario en
-- esta imagen, asi que en cuanto deja de ser dueño ya no puede habilitar RLS,
-- crear policies ni conceder sobre ellas.
CREATE TABLE public.stella_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, created_by uuid, stella_role text);
CREATE TABLE public.evidence_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, project_id uuid, evidence_id uuid);
CREATE TABLE public.evidence_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, project_id uuid);

-- Los tres helpers YA ENDURECIDOS por stella_hosted_0006, y ejecutables.
CREATE FUNCTION public.current_user_is_super_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT COALESCE((SELECT u.is_super_admin FROM public.users u WHERE u.id = auth.uid() LIMIT 1), false) $fn$;
CREATE FUNCTION public.current_user_org_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT ARRAY(SELECT om.organization_id FROM public.organization_members om
               WHERE om.user_id = auth.uid() AND om.status = 'active') $fn$;
CREATE FUNCTION public.current_user_role_in_org(org_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT om.role FROM public.organization_members om
  WHERE om.user_id = auth.uid() AND om.organization_id = org_id AND om.status = 'active' LIMIT 1 $fn$;
REVOKE EXECUTE ON FUNCTION public.current_user_is_super_admin(),
  public.current_user_org_ids(), public.current_user_role_in_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin(),
  public.current_user_org_ids(), public.current_user_role_in_org(uuid)
  TO authenticated, uellix_writer, uellix_auditor;

-- Las dos que ESCRIBEN: el runtime nunca debe alcanzarlas.
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = '' AS $fn$ BEGIN RETURN new; END $fn$;
CREATE FUNCTION public.handle_update_user() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = '' AS $fn$ BEGIN RETURN new; END $fn$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user(), public.handle_update_user() FROM PUBLIC;

-- RLS y las policies REALES sobre users (las tres medidas en hosted).
ALTER TABLE public.users                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stella_interactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_chunks            ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_own ON public.users FOR SELECT
  USING ((id = auth.uid()) OR public.current_user_is_super_admin());
CREATE POLICY users_insert_own ON public.users FOR INSERT
  WITH CHECK (id = auth.uid());
CREATE POLICY users_update_own ON public.users FOR UPDATE
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY members_select ON public.organization_members FOR SELECT
  USING ((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin());
CREATE POLICY audit_logs_select ON public.audit_logs FOR SELECT
  USING ((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin());
CREATE POLICY stella_interactions_select ON public.stella_interactions FOR SELECT
  USING ((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin());

-- grounding_0002/0003: ALL revocado al writer, SELECT DIRECTO a app y auditor.
REVOKE ALL ON public.evidence_document_versions, public.evidence_chunks
  FROM uellix_app, uellix_writer, uellix_auditor;
GRANT SELECT ON public.evidence_document_versions, public.evidence_chunks
  TO uellix_app, uellix_auditor;

-- authenticated conserva su superficie PostgREST; el writer NO tiene NADA.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.organizations,
  public.organization_members, public.projects TO authenticated;

-- F1-equivalente y un segundo tenant.
INSERT INTO public.users (id, email) VALUES ('00000000-0000-4000-8000-00000000f001','f1@example.test');
INSERT INTO public.users (id, email) VALUES ('00000000-0000-4000-8000-00000000f002','other@example.test');

-- AHORA la transferencia de propiedad, con RLS, policies y grants ya en su
-- sitio: reproduce el reparto medido en hosted (36 de postgres, 3 de
-- uellix_owner) y es lo que obliga al paquete a usar SET LOCAL ROLE.
ALTER TABLE public.stella_interactions        OWNER TO uellix_owner;
ALTER TABLE public.evidence_document_versions OWNER TO uellix_owner;
ALTER TABLE public.evidence_chunks            OWNER TO uellix_owner;
PRESTATE
echo "   prestate construido (39 tablas; uellix_writer con 0 privilegios)"

echo
echo "== 2. B-2: el 42501 de TABLA, en los dos caminos del login =============="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=0 <<B2 2>&1 | grep -E "ERROR|OK" || true
SET ROLE uellix_app;
SELECT set_config('request.jwt.claim.sub','$SUB', false);
SELECT set_config('request.jwt.claims','{"sub":"$SUB"}', false);
\echo '-- 2a loadCurrentUserWithinContext (SELECT):'
SELECT count(*) FROM public.users WHERE id = '$SUB';
\echo '-- 2b syncUserProfile (INSERT ... ON CONFLICT DO UPDATE):'
INSERT INTO public.users (id, email) VALUES ('$SUB','f1@example.test')
  ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = now();
B2

echo
echo "== 3. APLICANDO stella_hosted_0007 (una transaccion) ===================="
docker cp "$PKG" "$BOX:/tmp/pkg.sql" >/dev/null
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 | grep -E "NOTICE|ERROR" || true

echo
echo "== 4. RECORRIDO F1 DESPUES DEL FIX ======================================"
docker exec -i "$BOX" psql -U postgres -q -t -A -v ON_ERROR_STOP=0 <<POST 2>&1
SET ROLE uellix_app;
SELECT set_config('request.jwt.claim.sub','$SUB', false);
SELECT set_config('request.jwt.claims','{"sub":"$SUB"}', false);
SELECT 'A loadCurrentUser (SELECT propio) = ' || count(*)::text || ' (esperado 1)' FROM public.users WHERE id = '$SUB';
INSERT INTO public.users (id, email) VALUES ('$SUB','f1@example.test')
  ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = now();
SELECT 'B syncUserProfile upsert           = OK';
SELECT 'C users visibles (RLS row-scope)   = ' || count(*)::text || ' (esperado 1, no 2)' FROM public.users;
WITH hijack AS (
  UPDATE public.users SET full_name = 'hacked' WHERE id = '$OTHER' RETURNING 1)
SELECT 'D cross-user UPDATE ajeno          = ' || count(*)::text || ' filas (esperado 0: RLS)' FROM hijack;
SELECT 'E org_ids sin membership           = ' || coalesce(array_length(public.current_user_org_ids(),1),0)::text || ' (esperado 0)';
SELECT 'F is_super_admin                   = ' || public.current_user_is_super_admin()::text || ' (esperado false)';
POST

echo
echo "== 5. APPEND-ONLY: SELECT/INSERT si, UPDATE/DELETE no ==================="
docker exec -i "$BOX" psql -U postgres -q -t -A -v ON_ERROR_STOP=0 <<'AO' 2>&1 | grep -E "ERROR|OK:|denied" || true
SET ROLE uellix_app;
\echo '-- 5a audit_logs UPDATE (debe ser denied):'
UPDATE public.audit_logs SET action = 'x';
\echo '-- 5b audit_logs DELETE (debe ser denied):'
DELETE FROM public.audit_logs;
\echo '-- 5c stella_interactions INSERT (debe ser denied: R6-INT / stella_0017):'
INSERT INTO public.stella_interactions (organization_id) VALUES (gen_random_uuid());
\echo '-- 5d stella_interactions SELECT (debe funcionar):'
SELECT 'OK: stella_interactions SELECT = ' || count(*)::text FROM public.stella_interactions;
AO

echo
echo "== 6. MATRIZ DE PRIVILEGIOS RESULTANTE =================================="
docker exec -i "$BOX" psql -U postgres -q -t -A <<'MATRIX'
\echo '-- clases (writer):'
SELECT '   ' || t.tbl || ' = ' ||
  (CASE WHEN has_table_privilege('uellix_writer',t.tbl,'SELECT') THEN 'S' ELSE '-' END ||
   CASE WHEN has_table_privilege('uellix_writer',t.tbl,'INSERT') THEN 'I' ELSE '-' END ||
   CASE WHEN has_table_privilege('uellix_writer',t.tbl,'UPDATE') THEN 'U' ELSE '-' END ||
   CASE WHEN has_table_privilege('uellix_writer',t.tbl,'DELETE') THEN 'D' ELSE '-' END)
FROM (VALUES ('public.audit_logs'),('public.sroi_calculation_runs'),('public.stella_interactions'),
             ('public.users'),('public.projects'),('public.evidence_chunks'),
             ('public.evidence_document_versions')) t(tbl) ORDER BY 1;

\echo '-- uellix_app SOLO por herencia (0 entradas ACL directas en las 37):'
SELECT '   direct_app_acl_on_contract_tables = ' || count(*)::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a
WHERE n.nspname='public' AND c.relkind='r' AND a.grantee='uellix_app'::regrole
  AND c.relname NOT IN ('evidence_chunks','evidence_document_versions');

\echo '-- ESTRUCTURALES (deben ser 0):'
SELECT '   structural_privileges_held = ' || count(*)::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN (VALUES ('uellix_writer'),('uellix_auditor'),('uellix_app')) g(r)
CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(priv)
WHERE n.nspname='public' AND c.relkind='r' AND has_table_privilege(g.r,c.oid,p.priv);

\echo '-- AUDITOR no escribe (debe ser 0):'
SELECT '   auditor_write_privileges = ' || count(*)::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) p(priv)
WHERE n.nspname='public' AND c.relkind='r' AND has_table_privilege('uellix_auditor',c.oid,p.priv);

\echo '-- atributos del runtime:'
SELECT '   uellix_app bypassrls=' || rolbypassrls::text || ' super=' || rolsuper::text
    || ' createrole=' || rolcreaterole::text FROM pg_roles WHERE rolname='uellix_app';

\echo '-- las dos que escriben siguen inalcanzables:'
SELECT '   handle_new_user(app)=' || has_function_privilege('uellix_app','public.handle_new_user()','EXECUTE')::text
    || ' handle_update_user(app)=' || has_function_privilege('uellix_app','public.handle_update_user()','EXECUTE')::text;

\echo '-- owners intactos:'
SELECT '   stella_interactions owner = ' || pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.stella_interactions'::regclass;
MATRIX

echo
echo "== 7. IDEMPOTENCIA: reaplicar sobre estado ya canonico =================="
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 | grep -E "prestate|ERROR" || true

echo
echo "== 8. TERCER ESTADO: widening append-only debe REHUSAR =================="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'MIX'
GRANT UPDATE ON public.audit_logs TO uellix_writer;
MIX
third="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 || true)"
if printf '%s' "$third" | grep -qE "already holds UPDATE or DELETE on an append-only table"; then
  echo "   REHUSADO correctamente (append-only widening)"
else
  echo "   NO REHUSO -- FALLO"; printf '%s\n' "$third" | tail -3; exit 1
fi
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'UNMIX'
REVOKE UPDATE ON public.audit_logs FROM uellix_writer;
UNMIX

echo
echo "== 9. TERCER ESTADO: privilegio ESTRUCTURAL debe REHUSAR ================"
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'STRUCT'
GRANT TRUNCATE ON public.projects TO uellix_writer;
STRUCT
fourth="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 || true)"
if printf '%s' "$fourth" | grep -qE "STRUCTURAL privilege in schema public"; then
  echo "   REHUSADO correctamente (structural widening)"
else
  echo "   NO REHUSO -- FALLO"; printf '%s\n' "$fourth" | tail -3; exit 1
fi
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'UNSTRUCT'
REVOKE TRUNCATE ON public.projects FROM uellix_writer;
UNSTRUCT

echo
echo "== 10. TERCER ESTADO: grant DIRECTO a uellix_app debe REHUSAR ==========="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'DIRECT'
GRANT SELECT ON public.projects TO uellix_app;
DIRECT
fifth="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 || true)"
if printf '%s' "$fifth" | grep -qE "holds a DIRECT table grant"; then
  echo "   REHUSADO correctamente (direct app grant)"
else
  echo "   NO REHUSO -- FALLO"; printf '%s\n' "$fifth" | tail -3; exit 1
fi

echo
echo "== 11. ORDEN: sin stella_hosted_0006 debe REHUSAR ======================="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'UNDO6'
REVOKE SELECT ON public.projects FROM uellix_app;
REVOKE EXECUTE ON FUNCTION public.current_user_org_ids(),
  public.current_user_is_super_admin(), public.current_user_role_in_org(uuid)
  FROM uellix_writer, uellix_auditor;
UNDO6
sixth="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 || true)"
if printf '%s' "$sixth" | grep -qE "Apply stella_hosted_0006_runtime_rls_helper_contract.sql first"; then
  echo "   REHUSADO correctamente (RT-01 ausente: el orden lo impone el paquete)"
else
  echo "   NO REHUSO -- FALLO"; printf '%s\n' "$sixth" | tail -3; exit 1
fi

echo
echo "== dry-run completo; contenedor destruido en el trap de salida =="
