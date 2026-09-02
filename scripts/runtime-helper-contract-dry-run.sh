#!/usr/bin/env bash
# scripts/runtime-helper-contract-dry-run.sh
#
# Reconstruye el PRESTATE HOSPEDADO de los tres helpers RLS en un contenedor
# PostgreSQL 17 DESECHABLE, reproduce los dos defectos que
# stella_hosted_0006_runtime_rls_helper_contract.sql cierra, aplica el paquete y
# mide el estado resultante.
#
# POR QUÉ ES UN ARNÉS APARTE
#   capability-dry-run.sh y grounding-dry-run.sh restauran db/baseline/ completo
#   y afirman conteos exactos sobre él. Este mide una propiedad del ACL y de la
#   FORMA de tres funciones, que no depende del baseline entero; reconstruir sólo
#   la forma hospedada mantiene el arnés legible y hace visible, en un único
#   fichero, exactamente qué se está afirmando que rompe.
#
# LOS DOS DEFECTOS, REPRODUCIDOS ANTES DE ARREGLARLOS
#   B-1   uellix_app no puede ejecutar los helpers -> 42501, en llamada directa
#         y a través del predicado de una policy.
#   SEC   los cuerpos hospedados (SECURITY DEFINER, owner superusuario,
#         search_path=public, referencias sin cualificar) resuelven `users` a
#         través de pg_temp, de modo que el llamante decide su propio
#         is_super_admin.
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida, pase o
#   falle. Ningún fichero del repositorio se escribe.
#
#   bash scripts/runtime-helper-contract-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_runtime_helper_dry_run_$$"
PKG="db/prepared/stella_hosted_0006_runtime_rls_helper_contract.sql"

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -f "$PKG" ] || { echo "FALTA $PKG (ejecuta desde la raíz del repo)"; exit 1; }

echo "== arrancando contenedor desechable ($IMAGE) =="
docker run -d --name "$BOX" --network none -e POSTGRES_PASSWORD=throwaway "$IMAGE" >/dev/null
# El entrypoint de esta imagen arranca un servidor TEMPORAL para initdb que ya
# responde a pg_isready y despues lo detiene. Esperar al primer pg_isready
# rompe en esa ventana y la conexion siguiente falla, asi que se espera al
# HEALTHCHECK de la imagen y despues se exige una consulta real.
ready=0
for _ in $(seq 1 150); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$BOX" 2>/dev/null)" = "healthy" ]      && docker exec "$BOX" psql -U postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "el contenedor no arrancó"; docker logs "$BOX" 2>&1 | tail -20; exit 1; }

psql_() { docker exec -i "$BOX" psql -U postgres -v ON_ERROR_STOP="${1:-1}" -q; }

echo "== 1. PRESTATE HOSPEDADO =================================================="
psql_ 1 <<'PRESTATE'
-- La imagen de Supabase ya trae `authenticated`, `supabase_auth_admin`, el
-- schema `auth` y `auth.uid()` REALES. Se reutilizan deliberadamente: medir
-- contra la primitiva de identidad auténtica vale más que contra una imitación.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['uellix_owner','uellix_migrator','uellix_writer',
                           'uellix_auditor','uellix_app'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT', r);
    END IF;
  END LOOP;
END $$;
GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE;
-- SOLO PARA EL ARNES: permite a esta sesion asumir cada identidad con SET ROLE.
-- No forma parte del contrato hospedado y no lo concede ningun paquete.
GRANT uellix_app, uellix_writer, uellix_auditor, authenticated TO postgres;
GRANT USAGE ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT  CREATE ON SCHEMA public TO uellix_owner;

-- El ACL medido de schema auth: ningún rol uellix_* tiene USAGE.
REVOKE USAGE ON SCHEMA auth FROM uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;

CREATE TABLE public.users (
  id uuid PRIMARY KEY, email text UNIQUE, is_super_admin boolean NOT NULL DEFAULT false);
CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid,
  role text, status text);
CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);

-- Los tres helpers EN LA FORMA HOSPEDADA MEDIDA: SECURITY DEFINER, owner
-- postgres (superusuario), search_path=public, referencias SIN CUALIFICAR.
CREATE FUNCTION public.current_user_is_super_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT u.is_super_admin FROM users u WHERE u.id = auth.uid() LIMIT 1), false) $$;
CREATE FUNCTION public.current_user_org_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ARRAY(SELECT om.organization_id FROM organization_members om
               WHERE om.user_id = auth.uid() AND om.status = 'active') $$;
CREATE FUNCTION public.current_user_role_in_org(org_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT om.role FROM organization_members om
  WHERE om.user_id = auth.uid() AND om.organization_id = org_id
    AND om.status = 'active' LIMIT 1 $$;

-- 0033 revoca de PUBLIC; 0039 restaura SÓLO a authenticated.
REVOKE EXECUTE ON FUNCTION public.current_user_is_super_admin(),
  public.current_user_org_ids(), public.current_user_role_in_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin(),
  public.current_user_org_ids(), public.current_user_role_in_org(uuid) TO authenticated;
-- stella_hosted_0001 §5d: sólo dos de los tres, y sólo al instalador.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO uellix_owner WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_owner WITH GRANT OPTION;

-- Las dos que ESCRIBEN: el runtime nunca debe alcanzarlas.
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN new; END $$;
CREATE FUNCTION public.handle_update_user() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN new; END $$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user(), public.handle_update_user() FROM PUBLIC;

-- RLS: una policy que llama auth.uid() DIRECTAMENTE y otra que llama un helper.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_own ON public.users FOR SELECT
  USING ((id = auth.uid()) OR public.current_user_is_super_admin());
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_select ON public.organization_members FOR SELECT
  USING ((organization_id = ANY (public.current_user_org_ids()))
         OR public.current_user_is_super_admin());
GRANT SELECT ON public.users, public.organization_members, public.organizations
  TO uellix_writer, uellix_auditor, authenticated;

-- F1-equivalente: usuario confirmado, sin membership, sin organización.
INSERT INTO public.users VALUES
  ('00000000-0000-4000-8000-00000000f001', 'hosted-preview-smoke+f1@example.test', false);
-- Un segundo tenant, para la prueba cross-org.
INSERT INTO public.users VALUES
  ('00000000-0000-4000-8000-00000000f002', 'other@example.test', false);
INSERT INTO public.organizations VALUES ('00000000-0000-4000-8000-0000000000aa', 'Otra Org');
INSERT INTO public.organization_members (user_id, organization_id, role, status)
  VALUES ('00000000-0000-4000-8000-00000000f002',
          '00000000-0000-4000-8000-0000000000aa', 'organization_admin', 'active');
PRESTATE
echo "   prestate construido"

echo
echo "== 2. B-1: el 42501, en los dos caminos ==================================="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=0 <<'B1' 2>&1 | grep -E "ERROR|OK:" || true
SET ROLE uellix_app;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f001', false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000f001"}', false);
\echo '-- 2a llamada directa:'
SELECT public.current_user_is_super_admin();
\echo '-- 2b a traves del predicado de una policy:'
SELECT count(*) FROM public.organization_members;
B1

echo
echo "== 3. SEC: escalada pg_temp ANTES del fix ================================="
docker exec -i "$BOX" psql -U postgres -q -t -A <<'SEC1'
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f001', false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000f001"}', false);
CREATE TEMP TABLE users (id uuid PRIMARY KEY, is_super_admin boolean NOT NULL DEFAULT true);
INSERT INTO pg_temp.users VALUES ('00000000-0000-4000-8000-00000000f001', true);
SELECT 'PG_TEMP_ESCALATION_PRE_FIX=' || public.current_user_is_super_admin()::text;
DROP TABLE pg_temp.users;
SEC1

echo
echo "== 4. APLICANDO stella_hosted_0006 (una transaccion) ======================"
docker cp "$PKG" "$BOX:/tmp/pkg.sql" >/dev/null
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 | grep -E "NOTICE|ERROR" || true

echo
echo "== 5. ESTADO POSTERIOR ===================================================="
docker exec -i "$BOX" psql -U postgres -q -t -A <<'POST'
\echo '-- forma endurecida instalada:'
SELECT '   ' || p.proname || ' :: ' || array_to_string(p.proconfig, ',')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname IN
  ('current_user_org_ids','current_user_is_super_admin','current_user_role_in_org')
ORDER BY p.proname;

\echo '-- EXECUTE efectivo (uellix_app SOLO por herencia):'
SELECT '   ' || r || ' ' || s || ' = ' || has_function_privilege(r, s, 'EXECUTE')::text
FROM (VALUES ('uellix_writer'),('uellix_auditor'),('uellix_app'),('authenticated')) g(r),
     (VALUES ('public.current_user_org_ids()'),('public.current_user_is_super_admin()'),
             ('public.current_user_role_in_org(uuid)')) f(s)
ORDER BY 1;

\echo '-- uellix_app NO alcanza las dos que escriben:'
SELECT '   handle_new_user    = ' || has_function_privilege('uellix_app','public.handle_new_user()','EXECUTE')::text;
SELECT '   handle_update_user = ' || has_function_privilege('uellix_app','public.handle_update_user()','EXECUTE')::text;

\echo '-- USAGE sobre schema auth (debe seguir false):'
SELECT '   ' || r || ' = ' || has_schema_privilege(r,'auth','USAGE')::text
FROM (VALUES ('uellix_app'),('uellix_writer'),('uellix_auditor')) g(r);

\echo '-- bypassrls del runtime:'
SELECT '   uellix_app rolbypassrls = ' || rolbypassrls::text FROM pg_roles WHERE rolname='uellix_app';
POST

echo
echo "== 6. SEC: la misma escalada DESPUES del fix =============================="
docker exec -i "$BOX" psql -U postgres -q -t -A <<'SEC2'
SET ROLE uellix_app;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f001', false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000f001"}', false);
CREATE TEMP TABLE users (id uuid PRIMARY KEY, is_super_admin boolean NOT NULL DEFAULT true);
INSERT INTO pg_temp.users VALUES ('00000000-0000-4000-8000-00000000f001', true);
CREATE TEMP TABLE organization_members (user_id uuid, organization_id uuid, status text, role text);
INSERT INTO pg_temp.organization_members
  VALUES ('00000000-0000-4000-8000-00000000f001','00000000-0000-4000-8000-0000000000aa','active','super_admin');
SELECT 'PG_TEMP_ESCALATION_POST_FIX=' || public.current_user_is_super_admin()::text;
SELECT 'PG_TEMP_ORG_IDS_POST_FIX=' || coalesce(array_length(public.current_user_org_ids(),1),0)::text;
SELECT 'PG_TEMP_ROLE_IN_ORG_POST_FIX=' ||
  coalesce(public.current_user_role_in_org('00000000-0000-4000-8000-0000000000aa'),'<null>');
DROP TABLE pg_temp.users; DROP TABLE pg_temp.organization_members;
SEC2

echo
echo "== 7. RECORRIDO F1 (sin membership) y CROSS-ORG ==========================="
docker exec -i "$BOX" psql -U postgres -q -t -A <<'RUNTIME'
SET ROLE uellix_app;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f001', false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000f001"}', false);
SELECT 'C users_select_own          = ' || count(*)::text || ' (esperado 1: su propia fila)' FROM public.users;
SELECT 'E current_user_org_ids      = ' || coalesce(array_length(public.current_user_org_ids(),1),0)::text || ' (esperado 0)';
SELECT 'F current_user_is_super_admin = ' || public.current_user_is_super_admin()::text || ' (esperado false)';
SELECT 'G role_in_org(arbitrario)   = ' || coalesce(public.current_user_role_in_org(gen_random_uuid()),'NULL') || ' (esperado NULL)';
SELECT 'H cross-org members visibles = ' || count(*)::text || ' (esperado 0)' FROM public.organization_members;
SELECT 'D contexto organizacional   = ' ||
  CASE WHEN coalesce(array_length(public.current_user_org_ids(),1),0)=0
       THEN 'DENIED (sin membership)' ELSE 'CONCEDIDO -- FALLO' END;
RUNTIME

echo
echo "== 8. IDEMPOTENCIA: reaplicar sobre estado ya endurecido =================="
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 | grep -E "prestate|ERROR" || true

echo
echo "== 9. TERCER ESTADO: debe REHUSAR ========================================"
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 <<'MIX'
CREATE OR REPLACE FUNCTION public.current_user_role_in_org(org_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT NULL::text $$;
MIX
echo -n "   estado inyectado: "
docker exec "$BOX" psql -U postgres -tAc   "SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid='public.current_user_role_in_org(uuid)'::regprocedure;"
# La salida se captura ANTES de filtrarla: con `set -o pipefail` el estado de la
# tuberia seria el de psql, que aqui falla POR DISENO, y el `if` leeria eso en
# lugar del veredicto de grep.
third="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/pkg.sql 2>&1 || true)"
if printf '%s' "$third" | grep -qE "is in a state this package cannot account for"; then
  echo "   REHUSADO correctamente (UNEXPECTED_PRESTATE)"
else
  echo "   NO REHUSO -- FALLO"; printf '%s
' "$third" | tail -3; exit 1
fi

echo
echo "== dry-run completo; contenedor destruido en el trap de salida =="
