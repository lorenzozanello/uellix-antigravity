#!/usr/bin/env bash
# scripts/capability-baseline-verify.sh
#
# Restaura el baseline versionado en un contenedor DESECHABLE y afirma 38/107/10.
#
# QUÉ PRUEBA
#   Que `db/baseline/` es autosuficiente: que a partir de los tres artefactos
#   versionados —y de nada más— se obtiene el clúster pre-capacidades que
#   `scripts/capability-dry-run.sh` necesita. Si este script pasa, el dry-run no
#   tiene ninguna razón para leer un stack persistente.
#
# QUÉ NO TOCA
#   Nada. No hay stack persistente, no hay volumen montado, no hay red
#   (`--network none`), no hay puertos publicados. El contenedor se destruye en
#   el trap de salida, pase o falle.
#
# POR QUÉ SE RECREA LA BASE `postgres`
#   La imagen de Supabase inicializa `postgres` con sus propios esquemas (auth,
#   storage, realtime, graphql, vault, extensions). Restaurar el dump encima
#   choca en cada `CREATE SCHEMA`, que es exactamente lo que el arnés anterior
#   silenciaba con `|| true`. Recrear `postgres` desde `template0` deja una base
#   vacía en la que el dump entra completo y sin un solo error, y conserva el
#   nombre de base que el resto del arnés ya usa.
#
#   bash scripts/capability-baseline-verify.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_cap_baseline_verify_$$"
BASE_DIR="db/baseline"

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# MSYS_NO_PATHCONV frena la reescritura de rutas de Git Bash del lado del
# CONTENEDOR, que es lo que queremos — pero también del lado del HOST, y Docker
# for Windows leería `/tmp/x` como `C:\tmp\x`. Se convierte explícitamente.
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

fail() { echo "FATAL: $*" >&2; exit 1; }
assert_eq() { # <etiqueta> <esperado> <obtenido>
  if [ "$2" = "$3" ]; then
    printf '  ok   %-34s %s\n' "$1" "$3"
  else
    printf '  FAIL %-34s esperado=%s obtenido=%s\n' "$1" "$2" "$3"
    exit 1
  fi
}

# --------------------------------------------------------------------------
say "1. Integridad del manifiesto"
# --------------------------------------------------------------------------
[ -f "$BASE_DIR/MANIFEST.sha256" ] || fail "falta $BASE_DIR/MANIFEST.sha256"
( cd "$BASE_DIR" && sha256sum -c MANIFEST.sha256 ) || fail "el manifiesto no cuadra con los artefactos"

# --------------------------------------------------------------------------
say "2. Contenedor desechable, sin red"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
# DOS background workers tienen la base `postgres` fijada por configuración, y
# este script la recrea. Si no se les reapunta antes:
#
#   * pg_cron   — su lanzador queda atado al OID de la base; al soltarla sale con
#                 código 1;
#   * pg_net    — es peor: no sale, SEGFAULTA («was terminated by signal 11»)
#                 tras varios «database "postgres" does not exist».
#
# El postmaster trata la muerte anómala de cualquier worker como posible
# corrupción de memoria compartida y responde con «terminating any other active
# server processes ... reinitializing»: el restore muere a mitad, en un DDL
# arbitrario y sin relación con la causa. Reapuntar ambos a `template1` los
# desacopla de la base que vamos a recrear.
#
# `-D /etc/postgresql` NO es opcional: es el Cmd por defecto de la imagen, y ahí
# vive el postgresql.conf con `shared_preload_libraries`. Al pasar argumentos
# propios se reemplaza el Cmd entero, así que omitirlo arranca con la
# configuración del PGDATA y deja fuera pg_net: el restore muere entonces en
# «pg_net is not in shared_preload_libraries».
docker run -d --name "$BOX" --network none \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -D /etc/postgresql \
    -c cron.database_name=template1 -c pg_net.database_name=template1 >/dev/null
# pg_isready no basta: el entrypoint arranca un servidor TEMPORAL sobre el mismo
# socket para initdb y luego lo apaga, así que una sonda puede acertar contra un
# servidor que está a punto de desaparecer. Se exigen N consultas reales
# consecutivas para esperar al segundo arranque, el permanente.
ok=0
for _ in $(seq 1 90); do
  if docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then ok=$((ok + 1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break
  sleep 2
done
[ "$ok" -ge 3 ] || { docker logs --tail 20 "$BOX"; fail "el servidor desechable nunca arrancó"; }
echo "  imagen : $IMAGE"
echo "  id     : $(docker image inspect "$IMAGE" --format '{{.Id}}')"

# --------------------------------------------------------------------------
say "3. Base postgres vacía desde template0"
# --------------------------------------------------------------------------
# La imagen deja procesos de fondo conectados a `postgres` (pg_cron y el
# arranque del entrypoint). `datallowconn=false` cierra la puerta a reconexiones
# antes de expulsar las sesiones vivas; sin ese orden la carrera se repite.
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "UPDATE pg_database SET datallowconn = false WHERE datname = 'postgres'" \
  || fail "no se pudo cerrar la base postgres a nuevas conexiones"
dropped=0
for _ in $(seq 1 15); do
  docker exec "$BOX" psql -U supabase_admin -d template1 -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  if docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
       "DROP DATABASE IF EXISTS postgres" >/dev/null 2>&1; then dropped=1; break; fi
  sleep 1
done
[ "$dropped" = "1" ] || fail "no se pudo soltar la base postgres de fábrica"
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE postgres TEMPLATE template0 OWNER postgres" \
  || fail "no se pudo recrear la base postgres"

# --------------------------------------------------------------------------
say "4. Restore fail-closed desde los artefactos versionados"
# --------------------------------------------------------------------------
for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f"
done
# Sin `|| true` en ninguna de las tres. ON_ERROR_STOP=1 aborta en el primer
# ERROR; los NOTICE de membresías ya concedidas no son errores y no abortan.
"${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "restore de roles falló"
"${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "restore de schema falló"
"${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore falló"

# --------------------------------------------------------------------------
say "5. Postcondiciones del baseline"
# --------------------------------------------------------------------------
assert_eq "PostgreSQL"            "17.6" "$(Q "SELECT current_setting('server_version')")"
assert_eq "tablas public"         "38"   "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
assert_eq "policies public"       "107"  "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='public'")"
assert_eq "triggers public"       "10"   "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")"
assert_eq "owner de public"       "pg_database_owner" "$(Q "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")"
assert_eq "USAGE de public"       "1"    "$(Q "SELECT count(*) FROM pg_namespace, unnest(nspacl) a WHERE nspname='public' AND a::text LIKE '=U/%'")"
assert_eq "owner de las tablas"   "uellix_owner" "$(Q "SELECT string_agg(DISTINCT tableowner,',') FROM pg_tables WHERE schemaname='public'")"
assert_eq "roles uellix_*"        "5"    "$(Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix\\_%'")"
assert_eq "roles de capacidad"    "0"    "$(Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix_cap%' OR rolname='uellix_stripe'")"
assert_eq "policies cap_*"        "0"    "$(Q "SELECT count(*) FROM pg_policies WHERE policyname LIKE 'cap\\_%'")"
assert_eq "schema de capacidad"   "0"    "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_capability'")"
assert_eq "evidence_chunks"       "0"    "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='evidence_chunks'")"
assert_eq "suggestion_decisions"  "1"    "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='stella_suggestion_decisions'")"
assert_eq "filas en public"       "0"    "$(Q "SELECT coalesce(sum(n_live_tup),0)::text FROM pg_stat_user_tables WHERE schemaname='public'")"

say "BASELINE VERIFICADO 38/107/10 — contenedor destruido al salir"
