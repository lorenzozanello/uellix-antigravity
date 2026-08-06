#!/usr/bin/env bash
# scripts/stella-ticket-e2e.sh
# INTEGRACIÓN — Tren 4.1, FASE 10. El recorrido completo de una consulta
# fundamentada contra una base REAL, con el protocolo de tickets instalado.
#
# ---------------------------------------------------------------------------
# QUÉ HACE ESTE GUION Y QUÉ NO
# ---------------------------------------------------------------------------
# Levanta un PostgreSQL DESECHABLE, restaura db/baseline/**, aplica los
# paquetes preparados que el recorrido necesita, siembra dos organizaciones /
# dos proyectos / dos actores / evidencia real, y a continuación ejecuta la
# batería `tests/e2e/stella-ticket-journey.e2e.test.ts` — que corre en Node y
# conduce el SERVER ACTION REAL, los ADAPTERS REALES y el GENERADOR EXTRACTIVO
# REAL contra esa base.
#
# El contenedor se destruye en el trap de salida, pase o falle. Cero
# volúmenes: `docker run` sin `-v` y sin `--mount`, así que el almacenamiento
# vive en la capa efímera del contenedor y desaparece con él.
#
# ---------------------------------------------------------------------------
# LA DESVIACIÓN DE `--network none`, DECLARADA
# ---------------------------------------------------------------------------
# `scripts/stella-ticket-dry-run.sh` corre con `--network none` y puede
# hacerlo porque conduce todo con `docker exec psql` DENTRO del contenedor.
# Esta batería no puede: su propósito es ejecutar el runtime de Node —
# `db/client`, el adaptador de tickets, el server action — y con
# `--network none` el contenedor no tiene interfaz alguna por la que Node
# pueda conectarse. Las dos exigencias no son simultáneamente satisfacibles.
#
# La sustitución es la más estrecha disponible, y se enuncia en vez de
# ocultarse:
#
#   -p 127.0.0.1:56322:5432   publicado SÓLO en loopback; nada fuera de este
#                             host puede alcanzarlo.
#
# Lo que `--network none` protege —que ningún proveedor externo sea llamado—
# se conserva por otras dos vías, y ambas se miden: el generador es el
# extractivo LOCAL (`createExtractiveAnswerProvider`, sin red), y la batería se
# invoca con `env -u GEMINI_API_KEY`, además de afirmar en la propia prueba que
# la variable no está definida.
#
# ---------------------------------------------------------------------------
# POR QUÉ EL PUERTO 56322 Y NO OTRO
# ---------------------------------------------------------------------------
# `db/safety/database-access.ts` exige, para la capacidad
# `local_integration_test`, que el puerto sea EXACTAMENTE `LOCAL_DB_PORT`
# (56322). No es una molestia: es la guarda que impide que esta batería
# apunte a una base remota o al stack de otro worktree. Si el stack persistente
# de ESTE worktree estuviera levantado, `docker run` fallaría por puerto
# ocupado — que es exactamente el fallo correcto, y la razón de que este guion
# no lo apague ni lo reutilice.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix-stella-ticket-e2e-$$"
PORT=56322
BASE_DIR="db/baseline"

# El orden es una dependencia real, no una preferencia. stella_0014 se NIEGA a
# aplicarse sin consume_stella_quota (stella_0013), y el lector atestiguado de
# chunks que el runtime exige (`requireScopeAttestation: true`) sólo existe
# después de grounding_0004.
# Es la lista de scripts/stella-train4-dry-run.sh, en su mismo orden, más
# stella_0014 al final.
#
# stella_0002 / stella_0002b NO están, y su ausencia es deliberada: el baseline
# ya trae `trg_stella_interactions_append_only` (se comprueba en §4b, no se
# supone), y reaplicar 0002b sobre él falla su propia verificación porque el
# baseline ya reorganizó los privilegios que aquel paquete espera encontrar
# intactos. Aplicar un paquete ya incorporado no es más seguridad; es una
# segunda fuente de verdad sobre el mismo hecho.
FORWARD=(
  grounding_0002_document_versions
  grounding_0003_evidence_chunks
  stella_0013_grounded_query_quota
  grounding_0004_runtime_attestation
  stella_0014_operation_tickets
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
if docker ps --format '{{.Names}}' | grep -q "uellix-stella-ticket-e2e-"; then
  fail "ya hay un contenedor de esta batería corriendo — no se ejecutan dos gates pesados a la vez"
fi

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
# `cron.database_name` / `pg_net.database_name` apuntan a template1 y no a
# postgres, que es la base que §3 suelta y recrea. Con el valor por defecto los
# workers de background de pg_cron y pg_net siguen aferrados a `postgres`,
# mueren cuando desaparece, y el postmaster derriba TODA la sesión de restore
# ("terminating connection because of crash of another server process"). El
# mismo ajuste que stella-ticket-dry-run.sh, por la misma razón.

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

# Cero volúmenes, afirmado sobre el contenedor real en vez de sobre la línea de
# comandos que lo creó.
MOUNTS=$(docker inspect -f '{{len .Mounts}}' "$BOX")
[ "$MOUNTS" = "0" ] || fail "el contenedor tiene $MOUNTS montaje(s); esta batería no persiste nada"
echo "  ok   contenedor arriba, 0 montajes, publicado sólo en 127.0.0.1:$PORT"

# --------------------------------------------------------------------------
say "3. Restore del baseline"
# --------------------------------------------------------------------------
for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f" >/dev/null
done

# La base de fábrica que trae la imagen YA tiene los esquemas de Supabase, así
# que el dump del baseline colisiona con ellos ("schema auth already exists").
# Se recrea desde template0 — la misma maniobra que `restore_baseline` en
# stella-ticket-dry-run.sh — para que lo que se mida sea el baseline y no el
# baseline superpuesto a lo que la imagen trajera ese día.
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
for f in "${FORWARD[@]}"; do
  [ -f "db/prepared/$f.sql" ] || fail "falta db/prepared/$f.sql"
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql" >/dev/null
  "${PSQL[@]}" -q -f "/$f.sql" >/dev/null || fail "$f no aplicó"
  echo "  ok   $f"
done

# La afirmación que hace real al resto de la batería: las seis funciones
# gobernadas existen y la tabla de tickets también. Si esto falla, cualquier
# resultado posterior sería sobre una base que no tiene el protocolo.
FNS=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")
[ "$FNS" = "6" ] || fail "se esperaban 6 funciones gobernadas en uellix_stella_ops, hay $FNS"
echo "  ok   6 funciones gobernadas presentes"

# 4b. El append-only del ledger viene del baseline, y se COMPRUEBA en vez de
#     suponerse: la batería cuenta cargos como deltas precisamente porque las
#     filas no se pueden retirar, y si el trigger no estuviera esa premisa
#     sería falsa sin que ninguna prueba lo notara.
APPEND_ONLY=$(Q "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_stella_interactions_append_only' AND NOT tgisinternal")
[ "$APPEND_ONLY" = "1" ] || fail "el ledger no es append-only en esta base (trigger encontrado: $APPEND_ONLY)"
echo "  ok   ledger append-only confirmado"

# 4c. Credenciales para las DOS conexiones de la batería.
#
# `POSTGRES_HOST_AUTH_METHOD=trust` sólo cubre el arranque de la imagen; el
# pg_hba que el baseline deja exige contraseña para conexiones por TCP, que es
# como Node se conecta. Se fijan AQUÍ, después del restore, porque el restore
# recrea los roles y borraría cualquier contraseña puesta antes.
#
# El valor es un literal efímero de este contenedor: no es un secreto, no sale
# de loopback, y el contenedor se destruye al salir. No se lee de .env ni se
# escribe en ninguna parte.
E2E_PASSWORD='e2e-disposable'
# `supabase_admin` y no `postgres`: en esta imagen `postgres` NO es
# superusuario y no tiene privilegio sobre las tablas que `uellix_owner` posee
# (evidence_document_versions, evidence_chunks). La conexión privilegiada de la
# batería siembra esas tablas, así que necesita el rol que el propio §4 usa
# para aplicar los paquetes.
"${PSQL[@]}" -q -c "ALTER ROLE supabase_admin WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
"${PSQL[@]}" -q -c "ALTER ROLE uellix_app     WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
echo "  ok   credenciales efímeras fijadas para supabase_admin y uellix_app"

# --------------------------------------------------------------------------
say "5. Batería de runtime (Node, server action real)"
# --------------------------------------------------------------------------
# `env -u GEMINI_API_KEY`: la clave no se lee, no se imprime y no está en el
# entorno del proceso hijo. La prueba vuelve a afirmarlo desde dentro.
# `MSYS_NO_PATHCONV=1` está puesto arriba para que Git Bash no convierta las
# rutas `/archivo.sql` que van DENTRO del contenedor. Aquí estorba: corrompe la
# ruta de Windows con la que corepack localiza pnpm. Se desactiva sólo para
# esta invocación en vez de globalmente, porque las secciones de docker de
# arriba sí la necesitan.
set +e
UELLIX_RUNTIME_DATABASE_URL="postgresql://uellix_app:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_TICKET_E2E_ADMIN_URL="postgresql://supabase_admin:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_TICKET_E2E=1 \
  env -u MSYS_NO_PATHCONV -u GEMINI_API_KEY \
  pnpm exec vitest run --config vitest.e2e.config.ts --reporter=verbose
RESULT=$?
set -e

# --------------------------------------------------------------------------
say "6. Teardown"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -qx "$BOX"; then
  fail "el contenedor sobrevivió al teardown"
fi
echo "  ok   contenedor eliminado, cero residuos"

exit $RESULT
