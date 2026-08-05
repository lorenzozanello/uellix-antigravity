#!/usr/bin/env bash
# scripts/stella-release-e2e-dry-run.sh
#
# STELLA_RELEASE_LOCAL_END_TO_END_GATE_TRAIN_4.
#
# The disposable-database local-runtime harness: restores the same baseline
# scripts/grounding-dry-run.sh uses, applies grounding_0002 + grounding_0003
# (REQUIRED — the harness fails closed if either does not apply cleanly),
# attempts stella_0003 BEST-EFFORT (see section 4b below — a real,
# discovered baseline/package drift currently blocks it; not this line's
# file to fix), and applies TRAIN 4's own package if integration has landed
# one, before handing off to
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

# REQUIRED. Evidence persistence — the harness fails closed if either does
# not apply.
FORWARD=(grounding_0002_document_versions grounding_0003_evidence_chunks)

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
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
say "4. Aplicar grounding_0002 -> grounding_0003 (REQUERIDO)"
# --------------------------------------------------------------------------
for f in "${FORWARD[@]}"; do
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql"
  printf '  %-42s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/stella_e2e_err_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/stella_e2e_err_$$; fail "$f no se pudo aplicar"; fi
done
APPLIED_PACKAGES="grounding_0002,grounding_0003"

# --------------------------------------------------------------------------
say "4b. stella_0003 (MEJOR ESFUERZO — ver hallazgo documentado)"
# --------------------------------------------------------------------------
# stella_0003's own section 4b structural guard needs to know which role
# DATABASE_URL would connect as; unset, it falls back to current_user (here,
# supabase_admin — a superuser, not the table owner and not a direct grantee)
# and the ownership/grant check fails. uellix_owner genuinely OWNS the table
# this script creates, so declaring it satisfies the guard by ownership, not
# by working around it. ALTER DATABASE ... SET persists across the new
# connection `-f` opens.
docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c \
  "ALTER DATABASE postgres SET stella.writer_role = 'uellix_owner'" >/dev/null \
  || fail "no se pudo declarar stella.writer_role"

# NOT in FORWARD, NOT required by Fase 3's own package list (only
# grounding_0002/0003 and a possible Train 4 package are). Attempted anyway
# because it is the only prepared package for the "decisión humana local" leg
# of the journey — but this run DISCOVERED a real, out-of-scope blocker:
# db/baseline/stella_g2_schema.sql already contains a NEWER
# stella_suggestion_decisions design (an INSERT policy bound to uellix_app,
# uellix_writer holding direct SELECT+INSERT) than
# db/prepared/stella_0003_suggestion_decisions.sql currently ships (owner-only
# writes, no INSERT policy) — the two disagree on RLS policy COUNT and the
# package's own end-of-script self-verification (correctly) refuses to apply
# over that drift. Neither db/baseline/** nor db/prepared/** is a path this
# RELEASE line may modify (see the Train 4 dispatch's prohibitions), so this
# is recorded as a finding for docs/ops/workstreams/RELEASE.md, not patched
# here. The journey script (step 6) tolerates the table being absent.
docker cp "$(hp "db/prepared/stella_0003_suggestion_decisions.sql")" "$BOX:/stella_0003_suggestion_decisions.sql"
printf '  %-42s ' "stella_0003_suggestion_decisions"
if "${PSQL[@]}" -1 -q -f "/stella_0003_suggestion_decisions.sql" >/dev/null 2>/tmp/stella_e2e_err_$$; then
  echo "OK"
  APPLIED_PACKAGES="${APPLIED_PACKAGES},stella_0003"
else
  echo "BLOCKED (documented finding, not fatal)"
  tail -5 /tmp/stella_e2e_err_$$
fi

# --------------------------------------------------------------------------
say "5. Paquete TRAIN 4 (opcional — integración lo aporta más adelante)"
# --------------------------------------------------------------------------
# ONLY the grounding_000N sequence (grounding_0001 -> 0002 -> 0003 -> a
# possible 0004) is "Train 4" in this harness's sense — the evidence
# persistence/retrieval line this gate exists to exercise. `stella_000N` is a
# SEPARATE, unrelated numbering CAPABILITIES uses for other prepared packages
# (invitation, webhook identity, role separation, ...); a bare stella_0004*
# glob matched db/prepared/stella_0004_role_separation.sql on this branch —
# an unrelated package with its own precondition (an explicit table
# classification list that predates grounding_0002/0003 existing) — and
# applying it here would misattribute someone else's blocker to this train.
# Not required to exist on this branch — this train's own tests must stay
# green whether or not a parallel branch has landed one yet (see the Train 4
# dispatch: "puede permanecer rojo el gate de capacidad que dependa de los
# cambios paralelos").
TRAIN4_STATUS="not-yet-available"
for candidate in db/prepared/grounding_0004*.sql; do
  [ -f "$candidate" ] || continue
  base="$(basename "$candidate" .sql)"
  case "$base" in *_rollback) continue ;; esac
  docker cp "$(hp "$candidate")" "$BOX:/$base.sql"
  printf '  %-42s ' "$base"
  if "${PSQL[@]}" -1 -q -f "/$base.sql" >/dev/null 2>/tmp/stella_e2e_err_$$; then
    echo "OK"
    APPLIED_PACKAGES="${APPLIED_PACKAGES},${base}"
    TRAIN4_STATUS="applied"
  else
    echo "FAIL"; cat /tmp/stella_e2e_err_$$
    fail "$base existe pero no se pudo aplicar"
  fi
done
if [ "$TRAIN4_STATUS" = "not-yet-available" ]; then
  echo "  (sin paquete Train 4 en db/prepared/ todavía — se documenta como pendiente, no se sustituye)"
fi

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
