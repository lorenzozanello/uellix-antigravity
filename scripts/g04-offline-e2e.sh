#!/usr/bin/env bash
# scripts/g04-offline-e2e.sh
# G-04 — THE GOVERNED OFFLINE EVIDENCE JOURNEY, END TO END, AGAINST A REAL
# DATABASE.
#
# ---------------------------------------------------------------------------
# WHAT THIS PROVES THAT NO EXISTING GATE PROVED
# ---------------------------------------------------------------------------
# `scripts/stella-ticket-e2e.sh` already drives ingestion -> retrieval ->
# extractive answer -> ticket against a disposable PostgreSQL. What it CANNOT
# drive is the half of the journey that comes first: its evidence rows are
# SEEDED by `supabase_admin`, so the upload service, the auto-index decision
# that follows a committed upload, and the compensation that follows a failed
# one have never been exercised together with the corpus they produce.
#
# This battery starts one step earlier and never seeds an evidence row:
#
#   createFileEvidenceAction  (the real Server Action)
#     -> createFileEvidenceForProject  (reserve / upload / finalize + M2-COMP)
#     -> ingestProjectEvidenceForProject  (G-01 auto-index)
#     -> evidence_document_versions + evidence_chunks  (governed T1/T2)
#     -> readProjectCorpusStateForProject  (the truthful read model)
#     -> issue + runStellaGroundedQueryForProject  (ticket, quota, retrieval)
#     -> extractive answer + validated citations
#
# ---------------------------------------------------------------------------
# THE DEVIATION FROM `--network none`, DECLARED
# ---------------------------------------------------------------------------
# The same one `scripts/stella-ticket-e2e.sh` declares, for the same reason:
# this battery runs the Node runtime, and with `--network none` the container
# has no interface Node could dial. The narrowest available substitution is
#
#   -p 127.0.0.1:56322:5432   published on loopback ONLY.
#
# What `--network none` protects — that no external provider is called — is
# preserved by three measured facts instead: the generator is the LOCAL
# extractive one, Supabase Storage is replaced by an in-process bucket so no
# HTTP client is constructed at all, and the suite is invoked with
# `env -u GEMINI_API_KEY` while also asserting the absence from inside the
# process AND counting outbound `fetch` calls during a full journey.
#
# ---------------------------------------------------------------------------
# WHY PORT 56322 AND NOT ANOTHER
# ---------------------------------------------------------------------------
# `db/safety/database-access.ts` requires the local port to be EXACTLY
# `LOCAL_DB_PORT` (56322). That is the guard that stops this battery from ever
# addressing a hosted database. CONSEQUENCE, DECLARED: this script, the ticket
# battery and the multicategory battery share the port and cannot run at the
# same time. §0 fails instead of waiting.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix-g04-offline-e2e-$$"
PORT=56322
BASE_DIR="db/baseline"
SUITE="tests/e2e/g04-governed-evidence-journey.e2e.test.ts"

# The chain, in dependency order. It is the SAME list scripts/stella-ticket-e2e.sh
# applies, and it is a hard dependency rather than a preference:
#
#   grounding_0002/0003  the corpus tables the ingestion writes into.
#   stella_0013          consume_stella_quota; stella_0014 refuses without it.
#   grounding_0004       the ATTESTED chunk reader. The runtime asks for
#                        `requireScopeAttestation: true`, so without this
#                        package every grounded query fails closed.
#   stella_0014..0018    the ticket protocol, project binding, reserved-quota
#                        arithmetic, governed consumption and category binding.
#   grounding_0005       M-8. LAST, and mandatory: without it
#                        `claim_active_document_version` takes a row lock on
#                        public.evidence_items, PostgreSQL requires UPDATE to
#                        take one, `uellix_cap_grounding` holds only SELECT, and
#                        every governed ingestion by `uellix_app` dies with
#                        42501. The whole write half of this battery would be
#                        dead while the chain installed cleanly.
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
  grounding_0005_claim_advisory_lock
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
say "0. Nothing heavy in flight, and the port free"
# --------------------------------------------------------------------------
for prefix in uellix-g04-offline-e2e- uellix-stella-ticket-e2e- uellix-stella-multicat-e2e-; do
  if docker ps --format '{{.Names}}' | grep -q "$prefix"; then
    fail "a heavy gate is already running ($prefix) — they share port $PORT"
  fi
done

# --------------------------------------------------------------------------
say "1. Baseline manifest integrity"
# --------------------------------------------------------------------------
[ -f "$BASE_DIR/MANIFEST.sha256" ] || fail "no baseline manifest"
(cd "$BASE_DIR" && sha256sum -c MANIFEST.sha256) >/dev/null \
  || fail "the baseline does not match its manifest — it is read, never written"
echo "  ok   baseline intact"

# --------------------------------------------------------------------------
say "2. Disposable PostgreSQL, no volumes, loopback only"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker run -d --name "$BOX" \
  -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -D /etc/postgresql \
    -c cron.database_name=template1 -c pg_net.database_name=template1 >/dev/null \
  || fail "could not create the container (is port $PORT held by a persistent stack?)"
# `cron.database_name` / `pg_net.database_name` point at template1 rather than
# `postgres`, which §3 drops and recreates. With the default the pg_cron and
# pg_net background workers stay attached to `postgres`, die when it goes away,
# and the postmaster tears down the whole restore session.

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
[ "$ok" -ge 3 ] || { docker logs --tail 20 "$BOX"; fail "the disposable server never came up"; }

MOUNTS=$(docker inspect -f '{{len .Mounts}}' "$BOX")
[ "$MOUNTS" = "0" ] || fail "the container has $MOUNTS mount(s); this battery persists nothing"
echo "  ok   container up, 0 mounts, published on 127.0.0.1:$PORT only"

# --------------------------------------------------------------------------
say "3. Baseline restore"
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
[ "$dropped" = "1" ] || fail "could not drop the factory postgres database"
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE postgres TEMPLATE template0 OWNER postgres" >/dev/null \
  || fail "could not recreate the postgres database"
"${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "role restore failed"
"${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "schema restore failed"
"${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore failed"
echo "  ok   baseline restored"

# --------------------------------------------------------------------------
say "4. Prepared packages, in dependency order"
# --------------------------------------------------------------------------
for f in "${FORWARD[@]}"; do
  [ -f "db/prepared/$f.sql" ] || fail "missing db/prepared/$f.sql"
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql" >/dev/null
  "${PSQL[@]}" -q -f "/$f.sql" >/dev/null || fail "$f did not apply"
  echo "  ok   $f"
done

# The postconditions that make every later result mean something. Asked of the
# CATALOG, never inferred from "the file executed".
FNS=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")
[ "$FNS" = "8" ] || fail "expected 8 governed functions in uellix_stella_ops, found $FNS"

for sig in \
  'uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)' \
  'uellix_grounding.claim_active_document_version(uuid)' \
  'uellix_grounding.register_document_version(uuid, character, character, character, character varying, character varying, character varying, character varying)' \
  'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)' \
  'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)'
do
  [ "$(Q "SELECT to_regprocedure('$sig') IS NOT NULL")" = "t" ] \
    || fail "missing governed object $sig — the prepared chain is incomplete"
done
echo "  ok   the governed read, write and ticket surfaces all exist"

# M-8, asked of the INSTALLED BODY rather than of the file that was applied.
# Without the advisory lock the write half of this battery is dead on 42501 and
# every "not indexed" assertion below would pass for the wrong reason.
CLAIM_LOCK=$(Q "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version' AND position('pg_advisory_xact_lock' in regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')) > 0)")
[ "$CLAIM_LOCK" = "t" ] || fail "grounding_0005 did not take — governed ingestion would die with 42501"
echo "  ok   claim_active_document_version serialises on an advisory lock (M-8)"

# The privilege posture the repair had to preserve. A GRANT UPDATE here would
# have made the ingestion work by giving the capability role the ability to
# CHANGE chain-of-custody rows.
CAN_UPDATE=$(Q "SELECT has_table_privilege('uellix_cap_grounding','public.evidence_items','UPDATE')")
[ "$CAN_UPDATE" = "f" ] || fail "uellix_cap_grounding gained UPDATE on evidence_items"
echo "  ok   uellix_cap_grounding still holds SELECT and not UPDATE on evidence_items"

# M2-COMP-01's premise, MEASURED rather than quoted: evidence_items has RLS on
# and no DELETE policy, while the DELETE privilege is granted. That pair is the
# whole defect the compensation had to stop relying on.
[ "$(Q "SELECT relrowsecurity FROM pg_class WHERE oid='public.evidence_items'::regclass")" = "t" ] \
  || fail "RLS is off on evidence_items — the compensation premise does not hold on this database"
[ "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='evidence_items' AND cmd='DELETE'")" = "0" ] \
  || fail "a DELETE policy exists on evidence_items — this is not the baseline M2-COMP-01 was measured against"
echo "  ok   evidence_items: RLS on, 0 DELETE policies (the M2-COMP-01 premise)"

# --------------------------------------------------------------------------
say "4b. Ephemeral credentials for the battery's two connections"
# --------------------------------------------------------------------------
# `POSTGRES_HOST_AUTH_METHOD=trust` only covers the image's own startup; the
# pg_hba the baseline leaves requires a password over TCP, which is how Node
# connects. Set AFTER the restore, which recreates the roles.
#
# A literal ephemeral to this container: not a secret, never leaves loopback,
# and the container is destroyed on exit. Never read from .env, never written.
E2E_PASSWORD='e2e-disposable'
"${PSQL[@]}" -q -c "ALTER ROLE supabase_admin WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
"${PSQL[@]}" -q -c "ALTER ROLE uellix_app     WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
echo "  ok   ephemeral credentials set for supabase_admin and uellix_app"

# --------------------------------------------------------------------------
say "5. The battery (Node, real server actions)"
# --------------------------------------------------------------------------
# `env -u GEMINI_API_KEY`: the key is not read, not printed, and absent from the
# child process. The suite asserts it again from inside, and additionally counts
# outbound fetch calls across a whole grounded journey.
set +e
UELLIX_RUNTIME_DATABASE_URL="postgresql://uellix_app:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_G04_E2E_ADMIN_URL="postgresql://supabase_admin:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_G04_E2E=1 \
  env -u MSYS_NO_PATHCONV -u GEMINI_API_KEY \
  pnpm exec vitest run --config vitest.e2e.config.ts "$SUITE" --reporter=verbose
RESULT=$?
set -e

# --------------------------------------------------------------------------
say "6. Teardown"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -qx "$BOX"; then
  fail "the container survived teardown"
fi
echo "  ok   container removed, zero residue"

exit $RESULT
