#!/usr/bin/env bash
# Reproduce INT-CAP-004 (1) on the DEFECT PATH and prove the repair.
#
# The grounding dry-run only exercises the branch where evidence_chunks EXISTS.
# The defect was on the other branch: a database whose table went by another
# route got a rollback that reported success and left three callable SECURITY
# DEFINER functions behind — which then made grounding_0002's own rollback
# permanently impossible, because uellix_cap_grounding still OWNED them.
#
# Disposable container, --network none, destroyed on exit. Writes nothing.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_rollback_defect_$$"
BASE_DIR="db/baseline"

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }
chk() { if [ "$2" = "$3" ]; then printf '  ok   %-52s %s\n' "$1" "$3"; else printf '  FAIL %-52s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; exit 1; fi; }

docker rm -f "$BOX" >/dev/null 2>&1 || true
docker run -d --name "$BOX" --network none \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -D /etc/postgresql \
    -c cron.database_name=template1 -c pg_net.database_name=template1 >/dev/null
ok=0
for _ in $(seq 1 90); do
  if docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then ok=$((ok+1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break
  sleep 2
done
[ "$ok" -ge 3 ] || fail "el servidor desechable nunca arrancó"

echo "== restore del baseline =="
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "UPDATE pg_database SET datallowconn = false WHERE datname = 'postgres'" >/dev/null
for _ in $(seq 1 15); do
  docker exec "$BOX" psql -U supabase_admin -d template1 -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  if docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
       "DROP DATABASE IF EXISTS postgres" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE postgres TEMPLATE template0 OWNER postgres" >/dev/null
for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f"
  "${PSQL[@]}" -q -f "/$f" >/dev/null
done

echo "== aplicar grounding_0002 -> grounding_0003 =="
for f in grounding_0002_document_versions grounding_0003_evidence_chunks; do
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql"
  "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null
done
chk "funciones gobernadas instaladas" "5" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding'")"

echo "== LA RUTA DEL DEFECTO: la tabla se va por otro camino =="
# Exactamente el escenario que INT-CAP-004 (1) describe: un restore parcial,
# un DROP manual, o una aplicación forward que murió a medias.
"${PSQL[@]}" -q -c "DROP TABLE public.evidence_chunks" >/dev/null
chk "evidence_chunks ausente" "" "$(Q "SELECT to_regclass('public.evidence_chunks')")"

echo "== correr grounding_0003_rollback sobre esa base =="
docker cp "$(hp "db/prepared/grounding_0003_rollback.sql")" "$BOX:/rb.sql"
"${PSQL[@]}" -1 -q -f /rb.sql >/dev/null || fail "el rollback abortó en la ruta del defecto"

# ANTES DE LA REPARACIÓN estas tres seguían instaladas y el rollback salía 0.
chk "insert_evidence_chunks retirada" "" "$(Q "SELECT to_regprocedure('uellix_grounding.insert_evidence_chunks(uuid, jsonb)')")"
chk "finalize_document_ingestion retirada" "" "$(Q "SELECT to_regprocedure('uellix_grounding.finalize_document_ingestion(uuid, integer)')")"
chk "chunks_in_scope retirada" "" "$(Q "SELECT to_regprocedure('uellix_grounding.chunks_in_scope(uuid, uuid, uuid)')")"
chk "uellix_check_canonical_chunk retirada" "" "$(Q "SELECT to_regprocedure('public.uellix_check_canonical_chunk()')")"
chk "funciones que aún posee la capacidad" "2" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding'")"

echo "== la consecuencia real: el rollback de grounding_0002 vuelve a ser posible =="
docker cp "$(hp "db/prepared/grounding_0002_rollback.sql")" "$BOX:/rb2.sql"
docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  -c "ALTER DATABASE postgres SET grounding.rollback_confirm = 'DESTROY EVIDENCE VERSION HISTORY'" >/dev/null 2>&1 || true
"${PSQL[@]}" -1 -q -f /rb2.sql >/dev/null || fail "grounding_0002_rollback sigue bloqueado — la reparación no alcanza"
chk "rol uellix_cap_grounding retirado" "0" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_grounding'")"
chk "schema uellix_grounding retirado" "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_grounding'")"

echo ""
echo "== INT-CAP-004 (1) VERIFICADO EN LA RUTA DEL DEFECTO — contenedor destruido al salir =="
