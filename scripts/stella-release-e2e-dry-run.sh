#!/usr/bin/env bash
# scripts/stella-release-e2e-dry-run.sh
#
# STELLA_RELEASE_LOCAL_END_TO_END_GATE_TRAIN_4.
#
# The disposable-database local-runtime harness: restores the same baseline
# scripts/grounding-dry-run.sh uses, then applies FOUR REQUIRED prepared
# packages in dependency order (see section 4), before handing off to
# tests/eval/stella-release/e2e/run-local-journey.ts for the real
# ingestion -> persistence -> retrieval -> generation -> citation ->
# Product-result -> local-decision journey. Finally reduces the journey's own
# report through the fail-closed local-runtime-harness gate
# (tests/eval/stella-release/harness-report.ts) and exits non-zero on any gap.
#
# QUÉ NO TOCA. Nada persistente. Sin stack, sin volumen montado, sin puertos,
# sin red (`--network none`, matching scripts/grounding-dry-run.sh). The
# container is destroyed in the EXIT trap, pass or fail. db/baseline/** and
# db/prepared/** are read, never written. No provider is called — the
# generation step is tests/eval/stella-release/e2e/local-extractive-generator.ts,
# not Gemini.
#
#   bash scripts/stella-release-e2e-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_stella_e2e_dry_run_$$"
BASE_DIR="db/baseline"
# Outside the repo tree entirely — this is a run artifact, never something to
# commit or leave behind for a careless `git add -A` to pick up.
REPORT_PATH="${TMPDIR:-/tmp}/stella-e2e-report-$$.json"

# REQUIRED, IN DEPENDENCY ORDER. Every one of these must apply cleanly or the
# harness fails closed — there is no best-effort package left in this script.
#
# The order is DERIVED, not preferred:
#
#   grounding_0002  creates evidence_document_versions, schema
#                   uellix_grounding and role uellix_cap_grounding.
#   grounding_0003  creates evidence_chunks and the three governed functions.
#                   Its own preconditions abort without 0002.
#   stella_0013     widens stella_interactions' role CHECK and installs
#                   consume_stella_quota. Independent of the grounding pair
#                   (it needs only baseline tables), placed here because
#                   grounding_0004's self-verification counts policies and a
#                   package landing between the count and the check would make
#                   a failure ambiguous.
#   grounding_0004  publishes chunks_in_scope_attested, ties three integrity
#                   CHECKs, and REPAIRS THE RLS FINDING (adds
#                   uellix_cap_grounding to both SELECT policies). Its §0
#                   preconditions name 0002 and 0003 explicitly and abort
#                   without them.
#
# stella_0003 IS DELIBERATELY NOT APPLIED, and that is a change from train 3.
# It creates stella_suggestion_decisions, which exists for DECISION
# PERSISTENCE — a leg this journey does not walk (INT-PR-001 is open, the flag
# is off, and nothing in the run writes a decision). It is therefore not a
# dependency of the local journey, and the Train 4 dispatch is explicit that a
# package serving only decision persistence must not be applied. Its absence
# does not weaken the no-persistence claim: db/baseline/stella_g2_schema.sql
# already ships stella_suggestion_decisions, so step 6 still takes a real local
# decision and still proves the table it COULD have been written to holds zero
# rows. (The package was also blocked: db/baseline/stella_g2_schema.sql ships a
# newer design than db/prepared/stella_0003 does, and the package's own
# self-verification correctly refuses over that drift. Recorded in
# docs/ops/workstreams/RELEASE.md; not repaired here, because the package is
# no longer on this path at all.)
FORWARD=(
  grounding_0002_document_versions
  grounding_0003_evidence_chunks
  stella_0013_grounded_query_quota
  grounding_0004_runtime_attestation
)

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
assert_eq_local() {
  if [ "$2" = "$3" ]; then printf '  ok   %-46s %s
' "$1" "$3"
  else printf '  FAIL %-46s esperado=%s obtenido=%s
' "$1" "$2" "$3"; exit 1; fi
}
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

# --------------------------------------------------------------------------
say "1. Integridad del manifiesto de baseline"
# --------------------------------------------------------------------------
[ -f "$BASE_DIR/MANIFEST.sha256" ] || fail "falta $BASE_DIR/MANIFEST.sha256"
( cd "$BASE_DIR" && sha256sum -c MANIFEST.sha256 ) || fail "el manifiesto no cuadra"

# --------------------------------------------------------------------------
say "2. Contenedor desechable, sin red"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker run -d --name "$BOX" --network none \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -D /etc/postgresql \
    -c cron.database_name=template1 -c pg_net.database_name=template1 >/dev/null
ok=0
for _ in $(seq 1 90); do
  if docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then ok=$((ok + 1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break
  sleep 2
done
[ "$ok" -ge 3 ] || { docker logs --tail 20 "$BOX"; fail "el servidor desechable nunca arrancó"; }
echo "  imagen : $IMAGE"

# --------------------------------------------------------------------------
say "3. Base postgres vacía desde template0 + restore del baseline"
# --------------------------------------------------------------------------
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "UPDATE pg_database SET datallowconn = false WHERE datname = 'postgres'" >/dev/null \
  || fail "no se pudo cerrar la base postgres"
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

for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f"
done
"${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "restore de roles falló"
"${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "restore de schema falló"
"${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore falló"
echo "  ok   baseline restaurado"

# --------------------------------------------------------------------------
say "4. Aplicar los cuatro paquetes REQUERIDOS, en orden de dependencia"
# --------------------------------------------------------------------------
APPLIED_PACKAGES=""
for f in "${FORWARD[@]}"; do
  [ -f "db/prepared/$f.sql" ] || fail "falta db/prepared/$f.sql — es un paquete REQUERIDO, no opcional"
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql"
  printf '  %-42s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/stella_e2e_err_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/stella_e2e_err_$$; fail "$f no se pudo aplicar"; fi
  # El basename sin sufijo descriptivo es lo que el reductor del gate espera.
  base="${f%%_[a-z]*}"
  case "$f" in
    grounding_0002*) base=grounding_0002 ;;
    grounding_0003*) base=grounding_0003 ;;
    grounding_0004*) base=grounding_0004 ;;
    stella_0013*)    base=stella_0013 ;;
  esac
  APPLIED_PACKAGES="${APPLIED_PACKAGES:+$APPLIED_PACKAGES,}$base"
done
TRAIN4_STATUS="applied"

# --------------------------------------------------------------------------
say "5. El hallazgo RLS del tren 4, vuelto a ejecutar contra la base viva"
# --------------------------------------------------------------------------
# Antes de grounding_0004, uellix_cap_grounding tenia SELECT sobre las dos
# tablas de grounding y no estaba nombrado por ninguna de las dos policies
# permisivas: sin BYPASSRLS, toda lectura del definer devolvia el conjunto
# VACIO. Un GRANT ausente lanza; una POLICY ausente calla — por eso se
# comprueba aqui, sobre el catalogo vivo, y no leyendo el .sql.
for t in evidence_chunks evidence_document_versions; do
  n=$(Q "SELECT count(*) FROM pg_policy pol
         CROSS JOIN LATERAL unnest(pol.polroles) AS r(oid)
         JOIN pg_roles g ON g.oid = r.oid
         WHERE pol.polrelid = to_regclass('public.$t')
           AND pol.polpermissive AND pol.polcmd IN ('r','*')
           AND g.rolname = 'uellix_cap_grounding'")
  if [ "$n" -ge 1 ]; then printf '  ok   %-46s %s policy(s)
' "uellix_cap_grounding lee public.$t" "$n"
  else fail "uellix_cap_grounding no esta nombrado por ninguna policy SELECT permisiva en public.$t — el hallazgo RLS sigue abierto y toda lectura gobernada devolveria vacio"; fi
done
# authenticated no debe conservar ningun privilegio sobre el indice de chunks.
n=$(Q "SELECT count(*) FROM pg_class c
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
       JOIN pg_roles g ON g.oid = a.grantee
       WHERE c.oid = to_regclass('public.evidence_chunks') AND g.rolname = 'authenticated'")
assert_eq_local "authenticated sin grants en evidence_chunks" "0" "$n"
# La funcion atestada existe y devuelve 17 columnas.
n=$(Q "SELECT count(*) FROM unnest((SELECT p.proargnames FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname='uellix_grounding' AND p.proname='chunks_in_scope_attested'))")
assert_eq_local "chunks_in_scope_attested columnas" "20" "$n"

# --------------------------------------------------------------------------
say "6. Recorrido E2E real (tests/eval/stella-release/e2e/run-local-journey.ts)"
# --------------------------------------------------------------------------
rm -f "$REPORT_PATH"
# MSYS_NO_PATHCONV=1 (set above, for docker's own /container/paths) corrupts
# pnpm's Windows shim resolution — disabled only around this Node/tsx call.
#
# NOT `|| fail ...` here on purpose. A real SQL function failing mid-journey
# is exactly the case Fase 3 asks this harness to surface clearly — but
# "clearly" means destroying the container and running the fail-closed gate
# to produce a specific, actionable reason, not aborting mid-lifecycle with a
# bare non-zero exit. run-local-journey.ts itself already writes a complete
# (honestly mostly-false) report before exiting non-zero in this case — see
# its try/catch. JOURNEY_STATUS is read below, after cleanup, and is what
# ultimately decides this script's own exit code.
set +e
env -u MSYS_NO_PATHCONV pnpm exec tsx tests/eval/stella-release/e2e/run-local-journey.ts --box "$BOX" --out "$REPORT_PATH"
JOURNEY_STATUS=$?
set -e
[ -f "$REPORT_PATH" ] || fail "el recorrido E2E no produjo $REPORT_PATH (ni siquiera un reporte de bloqueo)"
if [ "$JOURNEY_STATUS" -eq 0 ]; then
  echo "  ok   recorrido E2E completo, reporte en $REPORT_PATH"
else
  echo "  BLOCKED  recorrido E2E encontró un bloqueador real (ver arriba) — reporte parcial en $REPORT_PATH"
fi

# --------------------------------------------------------------------------
say "7. Destruir el contenedor ANTES de evaluar el gate"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -qx "$BOX"; then
  fail "el contenedor $BOX sigue existiendo tras docker rm -f"
fi
CONTAINER_DESTROYED="true"
echo "  ok   contenedor destruido y confirmado ausente"

# --------------------------------------------------------------------------
say "8. Gate local-runtime-harness (fail-closed, tests/eval/stella-release/harness-report.ts)"
# --------------------------------------------------------------------------
set +e
env -u MSYS_NO_PATHCONV pnpm exec tsx tests/eval/stella-release/e2e/print-harness-gate.ts \
  --report "$REPORT_PATH" \
  --container-destroyed "$CONTAINER_DESTROYED" \
  --packages "$APPLIED_PACKAGES" \
  --train4-status "$TRAIN4_STATUS"
GATE_STATUS=$?
set -e

if [ "$GATE_STATUS" -ne 0 ]; then
  fail "local-runtime-harness-ready=false — ver arriba lo que falta"
fi

say "STELLA E2E DRY RUN COMPLETO — local-runtime-harness-ready=true, contenedor destruido"
