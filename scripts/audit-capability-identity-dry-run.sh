#!/usr/bin/env bash
# scripts/audit-capability-identity-dry-run.sh
#
# Mide el CONTRATO DE IDENTIDAD de las dos unidades administrativas prechain de
# G1-B — stella_hosted_0008 (policy de INSERT sobre public.audit_logs) y
# stella_0020 (DROP DEFAULT sobre public.stella_interactions.model_used) — en un
# PostgreSQL 17 DESECHABLE.
#
# POR QUE EXISTE
#   La primera revision de stella_hosted_0008 exigia `current_user =
#   uellix_owner` y describia ese rol como dueno de public.audit_logs. La
#   observacion de catalogo del repositorio dice lo contrario: en hosted la
#   tabla pertenece a `postgres`. El paquete era INAPLICABLE por los dos lados —
#   como uellix_owner el DDL de policy da 42501, como postgres abortaba su
#   propia precondicion — y nadie lo habria sabido hasta la ventana operativa.
#
#   Este arnes mide las DOS posturas de propiedad que existen en este modelo, y
#   el rechazo fail-closed de la tercera. No sustituye a la certificacion: la
#   complementa, con el caso negativo que la certificacion no construye.
#
# LO QUE PRUEBA
#   1  SESSION_IS_OWNER   la tabla la posee la propia sesion administrativa.
#                         El paquete NO emite SET ROLE.
#   2  OWNER_ASSUMABLE    la tabla la posee uellix_owner y la sesion puede
#                         asumirlo. El paquete abre y CIERRA la ventana.
#   3  FAIL-CLOSED        la sesion no es el dueno ni puede asumirlo -> rechazo,
#                         nombrando al dueno medido. Nada aplicado.
#   4  IDENTIDAD          current_user == session_user al terminar, en AMBAS
#                         ramas.
#   5  PROPIEDAD          el dueno de la tabla no se mueve.
#   6  ACL                ni un privilegio nuevo.
#   7  IDEMPOTENCIA       reaplicar sobre el estado ya canonico es un no-op.
#   8  ANTI-SEGUNDA-POLICY una segunda policy de escritura hace REHUSAR.
#   9  ROLLBACK           el inverso exacto, por el mismo contrato de identidad.
#
# QUE NO TOCA
#   Nada persistente. Sin stack, sin volumen, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida.
#
#   bash scripts/audit-capability-identity-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_audit_identity_dry_run_$$"
PKG8="db/prepared/stella_hosted_0008_audit_log_write_capability.sql"
RB8="db/prepared/stella_hosted_0008_rollback.sql"
PKG20="db/prepared/stella_0020_stella_interactions_model_default.sql"
RB20="db/prepared/stella_0020_rollback.sql"

FAILURES=0
note_fail() { echo "   FALLO: $*"; FAILURES=$((FAILURES + 1)); }

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for f in "$PKG8" "$RB8" "$PKG20" "$RB20"; do
  [ -f "$f" ] || { echo "FALTA $f (ejecuta desde la raiz del repo)"; exit 1; }
done

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
[ "$ready" = "1" ] || { echo "el contenedor no arranco"; docker logs "$BOX" 2>&1 | tail -20; exit 1; }

docker cp "$PKG8"  "$BOX:/tmp/h0008.sql"      >/dev/null
docker cp "$RB8"   "$BOX:/tmp/h0008_rb.sql"   >/dev/null
docker cp "$PKG20" "$BOX:/tmp/s0020.sql"      >/dev/null
docker cp "$RB20"  "$BOX:/tmp/s0020_rb.sql"   >/dev/null

echo
echo "== 1. PRESTATE: la forma hospedada medida =================================="
# El esquema `auth` lo posee supabase_admin en la imagen gestionada, igual que en
# el proyecto real, y `postgres` solo tiene USAGE sobre el. `auth.uid()` la
# publica GoTrue, que no corre aqui: la crea el unico principal que puede, como
# parte del PRESTATE y no del paquete.
docker exec -i "$BOX" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'AUTHSHIM'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
AUTHSHIM
# Reproduce lo que la observacion de catalogo dice del proyecto de staging:
#   public.audit_logs           owner = postgres      RLS enabled, 1 policy SELECT
#   public.stella_interactions  owner = uellix_owner  RLS enabled
# mas los grants que stella_hosted_0006 y 0007 dejan.
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

-- La membresia REAL medida en hosted: postgres puede ASUMIR uellix_owner sin
-- heredarlo, y uellix_app hereda de uellix_writer sin poder asumirlo.
GRANT uellix_writer TO uellix_app   WITH INHERIT TRUE,  SET FALSE;
GRANT uellix_owner  TO postgres     WITH INHERIT FALSE, SET TRUE;
GRANT uellix_owner  TO uellix_migrator WITH INHERIT FALSE, SET TRUE;
GRANT uellix_app, uellix_writer, uellix_auditor, uellix_migrator TO postgres;

GRANT USAGE  ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
GRANT CREATE ON SCHEMA public TO uellix_owner;

CREATE TABLE public.users (
  id uuid PRIMARY KEY, email text UNIQUE, is_super_admin boolean NOT NULL DEFAULT false);
CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid, status text);
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
  actor_user_id uuid, action text);
CREATE TABLE public.stella_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
  model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL);

-- Los helpers RLS ya endurecidos por stella_hosted_0006, y ejecutables por el
-- runtime: es la precondicion 0.4 de stella_hosted_0008.
CREATE FUNCTION public.current_user_is_super_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT COALESCE((SELECT u.is_super_admin FROM public.users u WHERE u.id = auth.uid() LIMIT 1), false) $fn$;
CREATE FUNCTION public.current_user_org_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT ARRAY(SELECT om.organization_id FROM public.organization_members om
               WHERE om.user_id = auth.uid() AND om.status = 'active') $fn$;
REVOKE EXECUTE ON FUNCTION public.current_user_is_super_admin(), public.current_user_org_ids() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.current_user_is_super_admin(), public.current_user_org_ids()
  TO uellix_writer, uellix_auditor;

ALTER TABLE public.audit_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stella_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_select_member_or_admin ON public.audit_logs FOR SELECT
  USING ((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin());

-- stella_hosted_0007 §1: el writer recibe SELECT+INSERT sobre audit_logs, y
-- uellix_app lo hereda. Es la precondicion 0.3 de stella_hosted_0008.
GRANT SELECT, INSERT ON public.audit_logs TO uellix_writer;
GRANT SELECT ON public.stella_interactions TO uellix_writer, uellix_auditor;

-- stella_0017 (T8, INSTALADO en hosted) §290-318: el ledger se escribe SOLO por
-- el protocolo gobernado. La imagen gestionada concede anon/authenticated/
-- service_role por default privileges al crear la tabla, exactamente como el
-- proyecto real, asi que el prestate tiene que reproducir tambien la retirada.
-- Sin ella el arnes mide una base que la cadena nunca deja, y §0.4 de
-- stella_0020 rehusa -- correctamente.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions
  FROM authenticated, anon, service_role, PUBLIC;

-- La transferencia que stella_hosted_0001 §399 hace, y SOLO esa.
ALTER TABLE public.stella_interactions OWNER TO uellix_owner;
PRESTATE

owner_pre8="$(docker exec "$BOX" psql -U postgres -tAc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.audit_logs'::regclass")"
owner_pre20="$(docker exec "$BOX" psql -U postgres -tAc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.stella_interactions'::regclass")"
acl_pre8="$(docker exec "$BOX" psql -U postgres -tAc "SELECT COALESCE(relacl::text,'') FROM pg_class WHERE oid='public.audit_logs'::regclass")"
echo "   audit_logs          owner = $owner_pre8   (la postura hosted medida)"
echo "   stella_interactions owner = $owner_pre20"
[ "$owner_pre8"  = "postgres" ]     || note_fail "el prestate no reproduce audit_logs owner=postgres"
[ "$owner_pre20" = "uellix_owner" ] || note_fail "el prestate no reproduce stella_interactions owner=uellix_owner"

echo
echo "== 2. stella_hosted_0008 rama SESSION_IS_OWNER (audit_logs es de postgres) ="
out8="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql 2>&1 || true)"
printf '%s\n' "$out8" | grep -E "NOTICE|ERROR" | sed 's/^/   /'
printf '%s' "$out8" | grep -q "SESSION_IS_OWNER" || note_fail "no clasifico SESSION_IS_OWNER"
printf '%s' "$out8" | grep -q "audit_logs_insert_member_or_admin INSERT TO uellix_app. OK." \
  || note_fail "no alcanzo la postcondicion OK"
printf '%s' "$out8" | grep -q "ERROR" && note_fail "hubo un ERROR en la rama SESSION_IS_OWNER"

echo
echo "== 3. El estado resultante ================================================="
docker exec -i "$BOX" psql -U postgres -q -t -A <<'VERIFY' | sed 's/^/   /'
SELECT 'policies_on_audit_logs = ' || string_agg(policyname || '/' || cmd || '/' || roles::text, ' , ' ORDER BY policyname)
FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs';
SELECT 'insert_policy_roles    = ' || roles::text FROM pg_policies
WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_logs_insert_member_or_admin';
SELECT 'rls_enabled            = ' || relrowsecurity::text FROM pg_class WHERE oid='public.audit_logs'::regclass;
SELECT 'owner_now              = ' || pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.audit_logs'::regclass;
VERIFY
owner_post8="$(docker exec "$BOX" psql -U postgres -tAc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.audit_logs'::regclass")"
acl_post8="$(docker exec "$BOX" psql -U postgres -tAc "SELECT COALESCE(relacl::text,'') FROM pg_class WHERE oid='public.audit_logs'::regclass")"
[ "$owner_post8" = "$owner_pre8" ] || note_fail "la PROPIEDAD de audit_logs cambio: $owner_pre8 -> $owner_post8"
[ "$acl_post8"   = "$acl_pre8"   ] || note_fail "el ACL de audit_logs cambio: $acl_pre8 -> $acl_post8"
echo "   ownership_unchanged    = $([ "$owner_post8" = "$owner_pre8" ] && echo true || echo false)"
echo "   acl_unchanged          = $([ "$acl_post8" = "$acl_pre8" ] && echo true || echo false)"

echo
echo "== 4. IDEMPOTENCIA: reaplicar sobre el estado ya canonico =================="
out8b="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql 2>&1 || true)"
printf '%s' "$out8b" | grep -q "INSERT TO uellix_app. OK." || note_fail "la reaplicacion no converge"
printf '%s' "$out8b" | grep -q "ERROR" && note_fail "la reaplicacion dio ERROR"
echo "   reaplicacion converge  = $(printf '%s' "$out8b" | grep -q 'OK.' && echo true || echo false)"

echo
echo "== 5. ANTI-SEGUNDA-POLICY: una policy de escritura extra debe REHUSAR ======"
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'STRAY'
CREATE POLICY audit_logs_stray_write ON public.audit_logs FOR ALL TO uellix_writer USING (true) WITH CHECK (true);
STRAY
stray="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql 2>&1 || true)"
if printf '%s' "$stray" | grep -q "a second write policy exists"; then
  echo "   REHUSADO correctamente (segunda policy de escritura)"
else
  note_fail "no rehuso ante una segunda policy de escritura"; printf '%s\n' "$stray" | tail -3
fi
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'UNSTRAY'
DROP POLICY audit_logs_stray_write ON public.audit_logs;
UNSTRAY

echo
echo "== 6. FAIL-CLOSED: una sesion que no es el dueno ni puede asumirlo ========="
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'OUTSIDER'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='uellix_outsider') THEN
    CREATE ROLE uellix_outsider LOGIN PASSWORD 'throwaway' INHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO uellix_outsider;
GRANT SELECT ON pg_catalog.pg_class TO uellix_outsider;
OUTSIDER
outsider="$(docker exec -e PGPASSWORD=throwaway "$BOX" psql -U uellix_outsider -h 127.0.0.1 -d postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql 2>&1 || true)"
if printf '%s' "$outsider" | grep -q "is neither that role nor able to assume it"; then
  echo "   REHUSADO correctamente, nombrando al dueno medido"
  printf '%s' "$outsider" | grep -o "owned by [a-z_]*" | head -1 | sed 's/^/   /'
else
  note_fail "no rehuso fail-closed ante una sesion sin capacidad sobre el dueno"
  printf '%s\n' "$outsider" | tail -4 | sed 's/^/   /'
fi

echo
echo "== 7. ROLLBACK de 0008, mismo contrato de identidad ========================"
rb8="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008_rb.sql 2>&1 || true)"
printf '%s' "$rb8" | grep -q "audit_logs has no INSERT policy" || note_fail "el rollback de 0008 no alcanzo su postcondicion"
left="$(docker exec "$BOX" psql -U postgres -tAc "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_logs_insert_member_or_admin'")"
[ "$left" = "0" ] || note_fail "la policy sigue presente tras el rollback"
echo "   policy tras rollback   = $left (esperado 0)"
# y el forward vuelve a converger sobre el estado revertido
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql >/dev/null 2>&1 \
  || note_fail "el forward no reaplica tras el rollback"

echo
echo "== 8. stella_0020 rama OWNER_ASSUMABLE (la tabla es de uellix_owner) ======="
out20="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/s0020.sql 2>&1 || true)"
printf '%s\n' "$out20" | grep -E "NOTICE|ERROR" | sed 's/^/   /'
printf '%s' "$out20" | grep -q "OWNER_ASSUMABLE" || note_fail "0020 no clasifico OWNER_ASSUMABLE"
printf '%s' "$out20" | grep -q "model_used = NOT NULL, no default. OK." || note_fail "0020 no alcanzo su postcondicion"
printf '%s' "$out20" | grep -q "ERROR" && note_fail "hubo un ERROR aplicando 0020"

docker exec -i "$BOX" psql -U postgres -q -t -A <<'V20' | sed 's/^/   /'
SELECT 'model_used_not_null    = ' || a.attnotnull::text
  || '   default = ' || COALESCE(pg_get_expr(d.adbin, d.adrelid), 'NULL')
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE a.attrelid='public.stella_interactions'::regclass AND a.attname='model_used' AND NOT a.attisdropped;
SELECT 'owner_now              = ' || pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.stella_interactions'::regclass;
SELECT 'session_identity       = ' || current_user || ' / ' || session_user;
V20
owner_post20="$(docker exec "$BOX" psql -U postgres -tAc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.stella_interactions'::regclass")"
[ "$owner_post20" = "$owner_pre20" ] || note_fail "la PROPIEDAD de stella_interactions cambio"

echo
echo "== 9. 0020: idempotencia, rollback y reaplicacion =========================="
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/s0020.sql >/dev/null 2>&1 \
  || note_fail "0020 no es idempotente"
rb20="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/s0020_rb.sql 2>&1 || true)"
printf '%s' "$rb20" | grep -q "default restored to" || note_fail "el rollback de 0020 no alcanzo su postcondicion"
printf '%s\n' "$rb20" | grep -E "NOTICE|ERROR" | sed 's/^/   /'
docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/s0020.sql >/dev/null 2>&1 \
  || note_fail "0020 no reaplica tras su rollback"

echo
echo "== 10. 0020 rama SESSION_IS_OWNER, por la conexion del propio dueno ========"
# El runner local abre `SET ROLE uellix_owner` antes de aplicar. Esa rama tiene
# que existir de verdad y no emitir un segundo SET ROLE.
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'ASOWNER'
ALTER ROLE uellix_owner LOGIN PASSWORD 'throwaway';
ASOWNER
as_owner="$(docker exec -e PGPASSWORD=throwaway "$BOX" psql -U uellix_owner -h 127.0.0.1 -d postgres -1 -v ON_ERROR_STOP=1 -f /tmp/s0020.sql 2>&1 || true)"
if printf '%s' "$as_owner" | grep -q "SESSION_IS_OWNER"; then
  echo "   SESSION_IS_OWNER clasificado y aplicado sin cambio de rol"
else
  note_fail "0020 no clasifico SESSION_IS_OWNER por la conexion del dueno"
  printf '%s\n' "$as_owner" | tail -4 | sed 's/^/   /'
fi
printf '%s' "$as_owner" | grep -q "ERROR" && note_fail "0020 dio ERROR por la conexion del dueno"

echo
echo "== 11. stella_hosted_0008 rama OWNER_ASSUMABLE ============================="
# La rama que la postura hosted de HOY no ejercita, y la que un cambio futuro de
# propiedad activaria sin avisar. Se mide moviendo audit_logs a uellix_owner y
# aplicando por la MISMA conexion administrativa: el paquete tiene que abrir la
# ventana, emitir el DDL, cerrarla, y devolver la sesion.
docker exec -i "$BOX" psql -U postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'MOVE'
DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;
ALTER TABLE public.audit_logs OWNER TO uellix_owner;
MOVE
# 11a. SIN USAGE sobre el esquema auth. El predicado nombra auth.uid() y
#      CREATE POLICY lo analiza al crearse, asi que el paquete tiene que rehusar
#      en su precondicion 0.7 -- NOMBRANDO el privilegio que falta -- en vez de
#      morir dentro del DDL con "permission denied for schema auth".
noauth="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql 2>&1 || true)"
if printf '%s' "$noauth" | grep -q "cannot resolve auth.uid()"; then
  echo "   11a REHUSADO en la precondicion (uellix_owner sin USAGE sobre auth)"
else
  note_fail "11a no rehuso en 0.7; el fallo llego al DDL"
  printf '%s\n' "$noauth" | tail -3 | sed 's/^/   /'
fi

# 11b. Con esa USAGE concedida -- que es una pregunta separada, en la forma que
#      stella_hosted_0004 ya usa para el esquema storage -- la rama funciona.
docker exec -i "$BOX" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 >/dev/null <<'AUTHUSAGE'
GRANT USAGE ON SCHEMA auth TO uellix_owner;
AUTHUSAGE
assumable="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008.sql 2>&1 || true)"
printf '%s\n' "$assumable" | grep -E "NOTICE|ERROR" | sed 's/^/   /'
printf '%s' "$assumable" | grep -q "OWNER_ASSUMABLE" || note_fail "0008 no clasifico OWNER_ASSUMABLE"
printf '%s' "$assumable" | grep -q "INSERT TO uellix_app. OK." || note_fail "0008 no alcanzo su postcondicion en OWNER_ASSUMABLE"
printf '%s' "$assumable" | grep -q "ERROR" && note_fail "0008 dio ERROR en la rama OWNER_ASSUMABLE"

docker exec -i "$BOX" psql -U postgres -q -t -A <<'V11' | sed 's/^/   /'
SELECT 'owner_now              = ' || pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.audit_logs'::regclass;
SELECT 'insert_policy_roles    = ' || roles::text FROM pg_policies
WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_logs_insert_member_or_admin';
SELECT 'session_identity       = ' || current_user || ' / ' || session_user;
V11
# y el rollback por la misma rama
rb_assumable="$(docker exec "$BOX" psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/h0008_rb.sql 2>&1 || true)"
printf '%s' "$rb_assumable" | grep -q "no INSERT policy" || note_fail "el rollback de 0008 fallo en OWNER_ASSUMABLE"
printf '%s' "$rb_assumable" | grep -q "ERROR" && note_fail "el rollback de 0008 dio ERROR en OWNER_ASSUMABLE"
echo "   rollback OWNER_ASSUMABLE = ok"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "== DRY-RUN COMPLETO: 0 fallos. Contenedor destruido en el trap de salida =="
else
  echo "== DRY-RUN COMPLETO CON $FAILURES FALLO(S) ================================"
  exit 1
fi
