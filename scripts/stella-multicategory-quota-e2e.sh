#!/usr/bin/env bash
# scripts/stella-multicategory-quota-e2e.sh
# INTEGRACIÓN — Tren 4.3c. La evidencia multicategoría contra una base REAL.
#
# ---------------------------------------------------------------------------
# QUÉ HACE ESTE GUION Y QUÉ NO
# ---------------------------------------------------------------------------
# Levanta un PostgreSQL DESECHABLE, restaura db/baseline/**, aplica la cadena
# COMPLETA de paquetes preparados —incluida `stella_0018`—, y ejecuta la batería
# `tests/e2e/stella-multicategory-quota.e2e.test.ts`, que corre en Node y
# conduce las SEIS server actions REALES (grounded, advisor, validator,
# composer y los tres roles reviewer) contra esa base.
#
# El contenedor se destruye en el trap de salida, pase o falle. Cero volúmenes:
# `docker run` sin `-v` y sin `--mount`, así que el almacenamiento vive en la
# capa efímera del contenedor y desaparece con él.
#
# ---------------------------------------------------------------------------
# LA DESVIACIÓN DE `--network none`, DECLARADA
# ---------------------------------------------------------------------------
# El propósito de esta batería es ejecutar el runtime de Node — `db/client`, el
# adaptador de tickets, las server actions — y con `--network none` el
# contenedor no tiene interfaz alguna por la que Node pueda conectarse. Las dos
# exigencias no son simultáneamente satisfacibles.
#
# La sustitución es la más estrecha disponible, y se enuncia en vez de ocultarse:
#
#   -p 127.0.0.1:56322:5432   publicado SÓLO en loopback; nada fuera de este
#                             host puede alcanzarlo.
#
# Lo que `--network none` protege —que ningún proveedor externo sea llamado— se
# conserva por otras dos vías, y ambas se miden: el adaptador del proveedor está
# INYECTADO y determinista (no abre socket), y la batería se invoca con
# `env -u GEMINI_API_KEY`, además de afirmarlo desde dentro del proceso.
#
# ---------------------------------------------------------------------------
# POR QUÉ EL PUERTO 56322 Y NO OTRO
# ---------------------------------------------------------------------------
# `db/safety/database-access.ts` exige, para la capacidad
# `local_integration_test`, que el puerto sea EXACTAMENTE `LOCAL_DB_PORT`
# (56322), y `db/client.ts` lo toma de `db/safety/local-stack.ts` sin
# parametrizarlo. No es una molestia: es la guarda que impide que esta batería
# apunte a una base remota o al stack de otro worktree.
#
# CONSECUENCIA DECLARADA: esta batería y `scripts/stella-ticket-e2e.sh`
# comparten puerto y NO pueden correr a la vez. El §0 lo comprueba y falla en
# vez de esperar — dos gates pesados simultáneos es exactamente lo que la fase
# 13 prohíbe. Cada guion nombra su fichero de prueba al invocar vitest, así que
# ninguno arrastra la batería del otro.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix-stella-multicat-e2e-$$"
PORT=56322
BASE_DIR="db/baseline"
SUITE="tests/e2e/stella-multicategory-quota.e2e.test.ts"

# La cadena COMPLETA. Ninguno es «best-effort»: si uno falla, el guion aborta,
# porque una batería que midiera cuota compartida sobre una cadena incompleta
# estaría midiendo el defecto en vez del arreglo.
#
#   grounding_0002/0003/0004  el lector atestiguado de chunks que la ruta
#                             grounded exige (`requireScopeAttestation: true`).
#   stella_0013               el cargo idempotente.
#   stella_0014               el ticket.
#   stella_0015               la ligadura al proyecto de ejecución (R2-INT).
#   stella_0016               la aritmética reservada (R1).
#   stella_0017               el cierre de la escritura directa (R6-INT).
#   stella_0018               la ligadura de categoría y la retirada del
#                             consumo sin ticket (R6a, R6b).
FORWARD=(
  grounding_0002_document_versions
  grounding_0003_evidence_chunks
  stella_0013_grounded_query_quota
  grounding_0004_runtime_attestation
  stella_0014_operation_tickets
  stella_0015_project_bound_operation_tickets
  stella_0016_reserved_quota_semantics
  stella_0017_governed_stella_consumption
  stella_0018_category_bound_operation_tickets
)

cleanup() {
  docker rm -f "$BOX" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

# --------------------------------------------------------------------------
say "0. Nada pesado en curso, y el puerto libre"
# --------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qE "uellix-stella-multicat-e2e-|uellix-stella-ticket-e2e-"; then
  fail "ya hay una batería E2E corriendo — no se ejecutan dos gates pesados a la vez"
fi
[ -f "$SUITE" ] || fail "falta $SUITE"

# --------------------------------------------------------------------------
say "1. Integridad del manifiesto de baseline"
# --------------------------------------------------------------------------
[ -f "$BASE_DIR/MANIFEST.sha256" ] || fail "no hay manifiesto de baseline"
(cd "$BASE_DIR" && sha256sum -c MANIFEST.sha256) >/dev/null \
  || fail "el baseline no coincide con su manifiesto — se lee, nunca se escribe"
echo "  ok   baseline íntegro"

# --------------------------------------------------------------------------
say "2. PostgreSQL desechable, sin volúmenes, loopback"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker run -d --name "$BOX" \
  -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -D /etc/postgresql \
    -c cron.database_name=template1 -c pg_net.database_name=template1 >/dev/null \
  || fail "no se pudo crear el contenedor (¿puerto $PORT ocupado por un stack persistente?)"

ok=0
for _ in $(seq 1 90); do
  if docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    ok=$((ok + 1))
  else
    ok=0
  fi
  [ "$ok" -ge 3 ] && break
  sleep 1
done
[ "$ok" -ge 3 ] || { docker logs --tail 20 "$BOX"; fail "el servidor desechable nunca arrancó"; }

MOUNTS=$(docker inspect -f '{{len .Mounts}}' "$BOX")
[ "$MOUNTS" = "0" ] || fail "el contenedor tiene $MOUNTS montaje(s); esta batería no persiste nada"
echo "  ok   contenedor arriba, 0 montajes, publicado sólo en 127.0.0.1:$PORT"

# --------------------------------------------------------------------------
say "3. Restore del baseline"
# --------------------------------------------------------------------------
for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f" >/dev/null
done

docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "UPDATE pg_database SET datallowconn = false WHERE datname = 'postgres'" >/dev/null
dropped=0
for _ in $(seq 1 15); do
  docker exec "$BOX" psql -U supabase_admin -d template1 -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  if docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
       "DROP DATABASE IF EXISTS postgres" >/dev/null 2>&1; then dropped=1; break; fi
  sleep 1
done
[ "$dropped" = "1" ] || fail "no se pudo soltar la base postgres de fábrica"
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE postgres TEMPLATE template0 OWNER postgres" >/dev/null \
  || fail "no se pudo recrear la base postgres"
"${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "restore de roles falló"
"${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "restore de schema falló"
"${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore falló"
echo "  ok   baseline restaurado"

# --------------------------------------------------------------------------
say "4. Paquetes preparados, en orden de dependencia"
# --------------------------------------------------------------------------
# LA GUARDA DE ORDEN, con la MISMA sonda que declara `db/prepared-package-order.ts`.
# Es literal, nunca compuesta, y corre ANTES de aplicar el archivo: nada
# inseguro llega a publicarse.
package_order_guard() {
  local pkg="$1" installed probe superseder
  while IFS='|' read -r rule_pkg superseder probe; do
    [ "$rule_pkg" = "$pkg" ] || continue
    installed=$(Q "$probe")
    if [ "$installed" = "t" ]; then
      fail "DB_MIGRATOR_PACKAGE_ORDER_VIOLATION: $pkg.sql no puede aplicarse sobre una base que ya tiene $superseder.sql — ver db/prepared-package-order.ts"
    fi
  done <<'RULES'
stella_0014_operation_tickets|stella_0015_project_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL
stella_0015_project_bound_operation_tickets|stella_0016_reserved_quota_semantics|SELECT to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NOT NULL
stella_0015_project_bound_operation_tickets|stella_0017_governed_stella_consumption|SELECT to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL
stella_0016_reserved_quota_semantics|stella_0017_governed_stella_consumption|SELECT to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL
stella_0015_project_bound_operation_tickets|stella_0018_category_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL
stella_0016_reserved_quota_semantics|stella_0018_category_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL
stella_0017_governed_stella_consumption|stella_0018_category_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL
RULES
}

for f in "${FORWARD[@]}"; do
  [ -f "db/prepared/$f.sql" ] || fail "falta db/prepared/$f.sql"
  package_order_guard "$f"
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql" >/dev/null
  "${PSQL[@]}" -q -f "/$f.sql" >/dev/null || fail "$f no aplicó"
  echo "  ok   $f"
done

# 4b. El estado final, preguntado al CATÁLOGO y no al hecho de que los archivos
#     se ejecutaran.
FNS=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")
[ "$FNS" = "8" ] || fail "se esperaban 8 funciones gobernadas en uellix_stella_ops, hay $FNS"

APPEND_ONLY=$(Q "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_stella_interactions_append_only' AND NOT tgisinternal")
[ "$APPEND_ONLY" = "1" ] || fail "el ledger no es append-only en esta base"

WRITERS=$(Q "SELECT count(DISTINCT r.rolname) FROM pg_roles r CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) AS p(priv)
  WHERE NOT r.rolsuper AND r.rolname <> 'uellix_owner' AND r.rolname <> 'uellix_cap_stella_quota'
    AND r.rolname NOT LIKE 'pg\\_%'
    AND has_table_privilege(r.oid, to_regclass('public.stella_interactions'), p.priv)")
[ "$WRITERS" = "0" ] || fail "$WRITERS principal(es) de runtime todavía pueden escribir stella_interactions"

for pair in \
  "uellix_stella_ops.bind_operation_ticket(character, uuid, character)|el bind SIN categoría esperada (R6a)" \
  "uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)|el consumo SIN ticket (R6b)" \
  "uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)|el cargo SIN ticket ni reserva (R6b)"
do
  sig="${pair%%|*}"; label="${pair##*|}"
  UNSAFE=$(Q "SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) FROM pg_roles r
    WHERE r.rolname IN ('uellix_app','authenticated','anon','service_role','uellix_writer','uellix_reader','uellix_auditor','authenticator')
      AND has_function_privilege(r.oid, to_regprocedure('$sig'), 'EXECUTE')")
  [ -z "$UNSAFE" ] || fail "$UNSAFE puede ejecutar $label"
done
echo "  ok   8 funciones, 0 escritores de runtime, 0 rutas sin ticket"

# 4c. Credenciales efímeras para las DOS conexiones de la batería.
#
# Literal de este contenedor: no es un secreto, no sale de loopback, y el
# contenedor se destruye al salir. No se lee de .env ni se escribe en ninguna
# parte.
E2E_PASSWORD='e2e-disposable'
"${PSQL[@]}" -q -c "ALTER ROLE supabase_admin WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
"${PSQL[@]}" -q -c "ALTER ROLE uellix_app     WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
echo "  ok   credenciales efímeras fijadas"

# --------------------------------------------------------------------------
say "5. Batería multicategoría (Node, seis server actions reales)"
# --------------------------------------------------------------------------
# `env -u GEMINI_API_KEY`: la clave no se lee, no se imprime y no está en el
# entorno del proceso hijo. La prueba vuelve a afirmarlo desde dentro.
set +e
UELLIX_RUNTIME_DATABASE_URL="postgresql://uellix_app:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_MULTICATEGORY_E2E_ADMIN_URL="postgresql://supabase_admin:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_TICKET_E2E=1 \
UELLIX_MULTICATEGORY_TEARDOWN_GUARDED=1 \
  env -u MSYS_NO_PATHCONV -u GEMINI_API_KEY \
  pnpm exec vitest run --config vitest.e2e.config.ts "$SUITE" --reporter=verbose
RESULT=$?
set -e

# --------------------------------------------------------------------------
say "6. Teardown"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -qx "$BOX"; then
  fail "el contenedor sobrevivió al teardown"
fi
if docker volume ls -q | grep -q "$BOX"; then
  fail "el contenedor dejó un volumen"
fi
echo "  ok   contenedor eliminado, cero volúmenes, cero residuos"

exit $RESULT
