#!/usr/bin/env bash
# scripts/grounding-dry-run.sh
#
# Aplica, revierte y REAPLICA grounding_0002 + grounding_0003 en un contenedor
# DESECHABLE restaurado desde db/baseline/. Deriva los conteos; no los asume.
#
# POR QUÉ ES UN SCRIPT APARTE Y NO UNA ETAPA DE capability-dry-run.sh
#   Aquel arnés afirma conteos EXACTOS del estado de capacidades
#   (42/151/7/10/1). Añadirle dos tablas, un esquema, un rol y cinco funciones
#   desplazaría todas esas cifras, y con ellas la evidencia de gate que
#   CAPABILITIES ya produjo. Un arnés hermano mide lo nuevo sin reescribir lo
#   que ya estaba medido.
#
#   El precio es que el procedimiento de restore aparece dos veces. Se acepta
#   deliberadamente: es una copia de ~40 líneas de una secuencia que ya está
#   documentada línea a línea en capability-baseline-verify.sh, frente a
#   invalidar un conjunto de aserciones que otra línea depende de leer.
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen montado, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida, pase o
#   falle. db/baseline/** se lee, nunca se escribe.
#
#   bash scripts/grounding-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_grounding_dry_run_$$"
BASE_DIR="db/baseline"

FORWARD=(grounding_0002_document_versions grounding_0003_evidence_chunks)
# Orden inverso, y el propio SQL lo impone: el rollback de 0002 se niega
# mientras evidence_chunks conserve su clave foránea.
ROLLBACKS=(grounding_0003_rollback grounding_0002_rollback)

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

assert_eq() {
  if [ "$2" = "$3" ]; then printf '  ok   %-38s %s\n' "$1" "$3"
  else printf '  FAIL %-38s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; exit 1; fi
}

# El vector de estado que se compara entre "aplicado" y "reaplicado". Cada
# componente es una clase de objeto que uno de los dos paquetes crea.
state() {
  printf '%s/%s/%s/%s/%s/%s' \
    "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" \
    "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='public'")" \
    "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_grounding'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding'")" \
    "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_grounding'")" \
    "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")"
}

# --------------------------------------------------------------------------
say "1. Integridad del manifiesto de baseline"
# --------------------------------------------------------------------------
[ -f "$BASE_DIR/MANIFEST.sha256" ] || fail "falta $BASE_DIR/MANIFEST.sha256"
( cd "$BASE_DIR" && sha256sum -c MANIFEST.sha256 ) || fail "el manifiesto no cuadra"

# --------------------------------------------------------------------------
say "2. Contenedor desechable, sin red"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
# pg_cron y pg_net se reapuntan a template1 porque este script recrea `postgres`;
# atados a ella, uno sale con código 1 y el otro segfaulta, y el postmaster trata
# esa muerte como posible corrupción y reinicia a mitad del restore.
# `-D /etc/postgresql` reemplaza el Cmd por defecto y NO es opcional: ahí vive el
# postgresql.conf con shared_preload_libraries.
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

BASELINE=$(state)
echo "  baseline: $BASELINE  (tablas/policies/rol/funciones/schema/triggers)"
assert_eq "rol uellix_cap_grounding ausente" "0" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_grounding'")"
assert_eq "esquema uellix_grounding ausente" "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_grounding'")"
assert_eq "evidence_chunks ausente"          "0" "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='evidence_chunks'")"
assert_eq "evidence_document_versions ausente" "0" "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='evidence_document_versions'")"

for f in "${FORWARD[@]}" "${ROLLBACKS[@]}"; do
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql"
done

# --------------------------------------------------------------------------
say "4. El orden forward está impuesto por el SQL, no por este script"
# --------------------------------------------------------------------------
# Se aplica 0003 PRIMERO, a propósito: debe abortar por sí solo. Si pasara, el
# resto del arnés estaría midiendo un orden que nada obliga a respetar.
if "${PSQL[@]}" -1 -q -f "/grounding_0003_evidence_chunks.sql" >/dev/null 2>/dev/null; then
  fail "grounding_0003 se aplicó SIN grounding_0002 — su guarda de dependencia no obliga"
fi
echo "  ok   grounding_0003 sin 0002 aborta, como debe"

# --------------------------------------------------------------------------
say "5. Aplicar 0002 -> 0003, dos veces (idempotencia)"
# --------------------------------------------------------------------------
PASS1=""
for pass in 1 2; do
  for f in "${FORWARD[@]}"; do
    printf '  pase %s  %-40s ' "$pass" "$f"
    if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/gerr_$$; then echo "OK"
    else echo "FAIL"; cat /tmp/gerr_$$; exit 1; fi
  done
  S=$(state)
  echo "  estado tras pase $pass: $S"
  if [ "$pass" = "1" ]; then PASS1="$S"; fi
done
FORWARD_STATE=$(state)
[ "$PASS1" = "$FORWARD_STATE" ] || fail "no es idempotente: pase1=$PASS1 pase2=$FORWARD_STATE"

# --------------------------------------------------------------------------
say "6. Aserciones vivas sobre el estado aplicado"
# --------------------------------------------------------------------------
assert_eq "rol uellix_cap_grounding"        "1" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_grounding'")"
assert_eq "miembros del rol definer"        "0" "$(Q "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='uellix_cap_grounding'")"
assert_eq "definer NOLOGIN"                 "f" "$(Q "SELECT rolcanlogin FROM pg_roles WHERE rolname='uellix_cap_grounding'")"
assert_eq "definer NOBYPASSRLS"             "f" "$(Q "SELECT rolbypassrls FROM pg_roles WHERE rolname='uellix_cap_grounding'")"
assert_eq "funciones en uellix_grounding"   "5" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding'")"
assert_eq "todas SECURITY DEFINER"          "5" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding' AND p.prosecdef")"
# Se comprueba el VALOR, no la ortografía: PostgreSQL guarda `search_path = ''`
# como `search_path=""`. Preguntar por la forma sin comillas es lo que dejaba a
# los dos paquetes inaplicables y no lo decía.
assert_eq "todas con search_path vacio"     "5" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding' AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\\_path=%' AND btrim(split_part(cfg,'=',2),'\"') = '')")"
assert_eq "todas owned by el definer"       "5" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_grounding' AND pg_get_userbyid(p.proowner)='uellix_cap_grounding'")"
assert_eq "RLS en evidence_chunks"          "t" "$(Q "SELECT relrowsecurity FROM pg_class WHERE relname='evidence_chunks' AND relnamespace='public'::regnamespace")"
assert_eq "RLS en evidence_document_versions" "t" "$(Q "SELECT relrowsecurity FROM pg_class WHERE relname='evidence_document_versions' AND relnamespace='public'::regnamespace")"
assert_eq "policies de las dos tablas"      "7" "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('evidence_chunks','evidence_document_versions')")"
# TRAIN 3: 3 triggers por tabla (antes 2) — cada tabla suma su propio trigger
# de endurecimiento (scope-check en versions, canonical-acyclicity en chunks).
assert_eq "triggers (train 3: 3+3)"         "6" "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN ('evidence_chunks','evidence_document_versions') AND NOT t.tgisinternal")"
# Append-only, en dos capas, porque una sola no basta.
#
# CAPA 1 — GRANTs. Ningún principal CONCEDIDO tiene UPDATE/DELETE/TRUNCATE. El
# dueño se excluye a propósito, y no es una excepción cómoda: un dueño de tabla
# tiene esos privilegios de forma implícita en PostgreSQL y no hay REVOKE que se
# los quite. Por eso existe la capa 2. (Medido: los únicos privilegios mutantes
# sobre esta tabla son los implícitos de uellix_owner.)
assert_eq "grants mutantes concedidos"      "0" "$(Q "SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_name='evidence_document_versions' AND g.privilege_type IN ('UPDATE','DELETE','TRUNCATE') AND g.grantee <> (SELECT tableowner FROM pg_tables WHERE tablename='evidence_document_versions')")"
#
# CAPA 2 — el trigger, que SÍ alcanza al dueño. Se prueba con TRUNCATE porque es
# el único de los tres cuyo trigger es FOR EACH STATEMENT y por tanto dispara
# sobre una tabla vacía; un `DELETE` sobre cero filas no ejecuta un trigger
# FOR EACH ROW y afirmar lo contrario a partir de un `DELETE 0` sería leer un
# no-evento como una prueba.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; TRUNCATE public.evidence_document_versions;" >/dev/null 2>&1 \
  && fail "el dueño pudo TRUNCAR la historia de versiones — el trigger no lo alcanza"
echo "  ok   TRUNCATE por el dueño rechazado       (trigger alcanza al owner)"
# Los de UPDATE/DELETE son FOR EACH ROW: se comprueba que existan, habilitados y
# con el momento y los eventos correctos. Ejercitarlos con datos exigiría toda la
# cadena de FKs (organizations -> projects -> evidence_items) y eso pertenece a
# las pruebas de integración con base poblada, no a este arnés.
# Se comprueban los eventos POR SEPARADO, no la cadena completa de la
# definición: PostgreSQL NORMALIZA la lista de eventos al almacenarla, así que
# `BEFORE UPDATE OR DELETE` del código fuente se lee como `BEFORE DELETE OR
# UPDATE`. Fijar el orden del fuente es un falso negativo autoinfligido — y uno
# que se lee como «el trigger no existe».
assert_eq "trigger BEFORE UPDATE (owner incl.)" "1" "$(Q "SELECT count(*) FROM information_schema.triggers WHERE event_object_table='evidence_document_versions' AND event_manipulation='UPDATE' AND action_timing='BEFORE' AND action_orientation='ROW' AND action_statement LIKE '%uellix_forbid_mutation%'")"
assert_eq "trigger BEFORE DELETE (owner incl.)" "1" "$(Q "SELECT count(*) FROM information_schema.triggers WHERE event_object_table='evidence_document_versions' AND event_manipulation='DELETE' AND action_timing='BEFORE' AND action_orientation='ROW' AND action_statement LIKE '%uellix_forbid_mutation%'")"
# TRAIN 3: los 3 triggers de evidence_document_versions (2 append-only + el
# scope-check nuevo) deben ser ENABLE ALWAYS (tgenabled='A'), no 'O' — 'O' es
# justamente lo que session_replication_role=replica desactiva.
assert_eq "los 3 son ENABLE ALWAYS (versions)"   "3" "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='evidence_document_versions' AND NOT t.tgisinternal AND t.tgenabled='A'")"
assert_eq "cero triggers en modo O (versions)"   "0" "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='evidence_document_versions' AND NOT t.tgisinternal AND t.tgenabled='O'")"
assert_eq "los 3 son ENABLE ALWAYS (chunks)"     "3" "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='evidence_chunks' AND NOT t.tgisinternal AND t.tgenabled='A'")"
assert_eq "cero triggers en modo O (chunks)"     "0" "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='evidence_chunks' AND NOT t.tgisinternal AND t.tgenabled='O'")"
# Y la asimetría deliberada: los chunks SÍ son regenerables.
assert_eq "DELETE en chunks (definer)"      "1" "$(Q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='evidence_chunks' AND privilege_type='DELETE' AND grantee='uellix_cap_grounding'")"
assert_eq "project_id NOT NULL en chunks"   "NO" "$(Q "SELECT is_nullable FROM information_schema.columns WHERE table_name='evidence_chunks' AND column_name='project_id'")"
assert_eq "project_id NOT NULL en versiones" "NO" "$(Q "SELECT is_nullable FROM information_schema.columns WHERE table_name='evidence_document_versions' AND column_name='project_id'")"
assert_eq "cero extension vector"           "0" "$(Q "SELECT count(*) FROM pg_extension WHERE extname='vector'")"

# --------------------------------------------------------------------------
say "6-bis. Las funciones se INVOCAN, no sólo se inspeccionan"
# --------------------------------------------------------------------------
# AÑADIDO POR LA REVISIÓN ADVERSARIAL DEL TREN 2. Las aserciones de arriba
# comprueban forma: existencia, propiedad, search_path, policies. Ninguna llama
# a nada. Eso dejó pasar un BLOCKER completo — el dueño SECURITY DEFINER no
# tenía privilegio sobre public.evidence_items, así que los paquetes
# instalaban limpiamente y TODA llamada moría con 42501. Un arnés que sólo
# inspecciona estructura certifica que el paquete se instala, no que sirve.
#
# El discriminador es el SQLSTATE, y separa exactamente los dos fallos:
#   42501  permission denied  -> el definer no puede leer lo que necesita
#   U0102  not found/not yours -> el definer leyó, y rechazó por alcance
# Sin sesión autenticada, current_user_org_ids() devuelve el conjunto vacío, así
# que la respuesta CORRECTA a una llamada anónima es U0102. Un 42501 aquí es el
# BLOCKER; un U0102 prueba que el privilegio existe Y que la comprobación de
# organización —ausente antes de esta integración— dispara.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c "
  SET ROLE uellix_owner;
  INSERT INTO public.organizations (id, name, slug)
    VALUES ('11111111-1111-1111-1111-111111111111', 'Org Dry Run', 'org-dry-run');
" >/dev/null 2>&1 || fail "no se pudo sembrar la organización de prueba"

SQLSTATE_OUT=$(docker exec "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=0 -c "
  SET ROLE uellix_app;
  DO \$probe\$
  BEGIN
    PERFORM uellix_grounding.register_document_version(
      '22222222-2222-2222-2222-222222222222'::uuid,
      repeat('a', 64)::char(64), repeat('b', 64)::char(64), repeat('c', 64)::char(64),
      'norm-1', 'extract-probe', 'chunk-1', 'text/plain');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'SQLSTATE=%', SQLSTATE;
  END
  \$probe\$;
" 2>&1 | grep -oE 'SQLSTATE=[A-Za-z0-9]{5}|ERROR:.*' | head -1)

echo "  register_document_version (llamante anónimo) -> $SQLSTATE_OUT"
case "$SQLSTATE_OUT" in
  *42501*) fail "el definer sigue sin privilegio sobre evidence_items (42501) — A-BLOCKER-1 no está corregido" ;;
  *U0102*) echo "  ok   privilegio presente y frontera de organización impuesta (U0102)" ;;
  *)       fail "resultado inesperado al invocar register_document_version: $SQLSTATE_OUT" ;;
esac

# Limpieza dentro del contenedor desechable; el rollback de abajo mide el
# retorno al baseline y una fila sembrada lo falsearía.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c "
  SET ROLE uellix_owner;
  DELETE FROM public.organizations WHERE id = '11111111-1111-1111-1111-111111111111';
" >/dev/null 2>&1 || fail "no se pudo retirar la organización de prueba"

# --------------------------------------------------------------------------
say "6-ter. TRAIN 3 — integridad canónica y bypass del owner, con datos reales"
# --------------------------------------------------------------------------
# A diferencia de 6-bis (que sólo puede alcanzar U0102, porque esta sesión no
# está autenticada), TODO lo de aquí opera con INSERT/UPDATE/DELETE/TRUNCATE
# DIRECTOS bajo `SET ROLE uellix_owner` — el escenario exacto que las FKs
# compuestas y los triggers de esta unidad existen para cerrar, porque RLS no
# ata al dueño y las funciones SECURITY DEFINER no son la única vía de
# escritura hacia estas tablas.
#
# TODO ocurre dentro de UNA transacción que termina en ROLLBACK: las tablas
# involucradas incluyen la de versiones (append-only — ni siquiera el dueño
# puede borrar una fila ya insertada), así que la única forma de dejar el
# contenedor exactamente como lo encontró esta sección es no hacer COMMIT
# nunca. Las secciones 7-9 miden el estado desde una conexión NUEVA, así que
# no ven nada de lo de aquí.
#
# Cada sub-prueba usa un bloque BEGIN/EXCEPTION anidado — un savepoint
# implícito de PL/pgSQL — para que un fallo esperado no aborte la transacción
# exterior y la siguiente sub-prueba pueda correr. `RESULT nombre=SQLSTATE` es
# el único contrato entre este SQL y el grep de bash de abajo.
set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<'SQL' 2>&1
BEGIN;
SET ROLE uellix_owner;

-- ------------------------------------------------------------------
-- Semilla: dos organizaciones/proyectos/evidencias (A y B), una versión
-- correctamente escrita para A, y un chunk canónico correctamente escrito
-- para A. En modo de replicación NORMAL (origin): session_replication_role
-- sólo se pone en replica más abajo, acotado a las dos sub-pruebas 13-14 que
-- existen precisamente para exigir eso. Ponerlo aquí arriba SILENCIARÍA las
-- dos FOREIGN KEY compuestas para el resto de esta sección — PostgreSQL
-- implementa las FK con triggers internos (RI_ConstraintTrigger_*) que
-- también respetan session_replication_role y que, a diferencia de los
-- triggers propios de este paquete, NO se pueden fijar en ENABLE ALWAYS desde
-- SQL estático: su nombre es un OID generado en cada base, así que sólo es
-- alcanzable con SQL dinámico — que el contrato estático de esta línea
-- prohíbe. Ver el riesgo remanente anotado en el informe de esta unidad.
INSERT INTO public.users (id, email) VALUES
  ('99999999-9999-9999-9999-999999999901', 'dryrun-a@example.invalid'),
  ('99999999-9999-9999-9999-999999999902', 'dryrun-b@example.invalid');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111111101', 'Org Dry Run A', 'org-dry-run-a-t3'),
  ('11111111-1111-1111-1111-111111111102', 'Org Dry Run B', 'org-dry-run-b-t3');

INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111101', 'Project A', '99999999-9999-9999-9999-999999999901'),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111102', 'Project B', '99999999-9999-9999-9999-999999999902');

INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, created_by) VALUES
  ('33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111101', 'text', 'Evidence A', '99999999-9999-9999-9999-999999999901'),
  ('33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111102', 'text', 'Evidence B', '99999999-9999-9999-9999-999999999902');

INSERT INTO public.evidence_document_versions (
  id, organization_id, project_id, evidence_id, version_id, raw_content_hash, normalized_content_hash,
  normalization_version, extractor_version, chunker_version, mime_type, ordinal, supersedes_version_id
) VALUES (
  '44444444-4444-4444-4444-444444444401',
  '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
  repeat('1', 64), repeat('2', 64), repeat('3', 64), 'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL
);

INSERT INTO public.evidence_chunks (
  chunk_id, organization_id, project_id, evidence_id, document_version_id,
  version_id, raw_content_hash, normalized_content_hash,
  chunk_index, content, content_hash, char_start, char_end,
  normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
) VALUES (
  repeat('a', 64), '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
  '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
  0, 'hello world', repeat('b', 64), 0, 11, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
);
DO $seed_ok$ BEGIN RAISE NOTICE 'RESULT seed=OK'; END $seed_ok$;

-- ------------------------------------------------------------------
-- 1. canonical inexistente
-- ------------------------------------------------------------------
DO $t1$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('c', 64), '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      1, NULL, repeat('b', 64), 12, 20, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, repeat('9', 64)
    );
    RAISE NOTICE 'RESULT canonical_inexistente=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT canonical_inexistente=%', SQLSTATE;
  END;
END $t1$;

-- ------------------------------------------------------------------
-- 2. self-reference
-- ------------------------------------------------------------------
DO $t2$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('d', 64), '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      2, NULL, repeat('b', 64), 21, 30, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, repeat('d', 64)
    );
    RAISE NOTICE 'RESULT self_reference=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT self_reference=%', SQLSTATE;
  END;
END $t2$;

-- ------------------------------------------------------------------
-- 3. cross-project (misma org, project_id equivocado)
-- ------------------------------------------------------------------
DO $t3$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('e', 64), '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      3, 'cross project text', repeat('f', 64), 31, 50, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
    );
    RAISE NOTICE 'RESULT cross_project=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT cross_project=%', SQLSTATE;
  END;
END $t3$;

-- ------------------------------------------------------------------
-- 4. cross-organization
-- ------------------------------------------------------------------
DO $t4$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('1', 63) || '0', '11111111-1111-1111-1111-111111111102', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      4, 'cross org text', repeat('2', 63) || '1', 51, 70, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
    );
    RAISE NOTICE 'RESULT cross_organization=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT cross_organization=%', SQLSTATE;
  END;
END $t4$;

-- ------------------------------------------------------------------
-- 5. hash distinto (raw_content_hash de la versión no coincide)
-- ------------------------------------------------------------------
DO $t5$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('3', 63) || '0', '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('9', 64), repeat('3', 64),
      5, 'wrong hash text', repeat('4', 63) || '1', 71, 90, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
    );
    RAISE NOTICE 'RESULT hash_distinto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT hash_distinto=%', SQLSTATE;
  END;
END $t5$;

-- ------------------------------------------------------------------
-- 6. versión distinta (document_version_id que no existe)
-- ------------------------------------------------------------------
DO $t6$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('5', 63) || '0', '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444449999', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      6, 'other version text', repeat('6', 63) || '1', 91, 110, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
    );
    RAISE NOTICE 'RESULT version_distinta=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT version_distinta=%', SQLSTATE;
  END;
END $t6$;

-- ------------------------------------------------------------------
-- 7. ciclo de dos nodos: dos filas en el MISMO INSERT, cada una nombrando a
--    la otra, ninguna existente todavía. Debe rechazarse por completo.
-- ------------------------------------------------------------------
DO $t7$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES
    (repeat('7', 63) || '0', '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      7, NULL, repeat('b', 64), 111, 120, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, repeat('7', 63) || '1'),
    (repeat('7', 63) || '1', '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      8, NULL, repeat('b', 64), 121, 130, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, repeat('7', 63) || '0');
    RAISE NOTICE 'RESULT ciclo_dos_nodos=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT ciclo_dos_nodos=%', SQLSTATE;
  END;
END $t7$;
-- Confirmado, no asumido: ninguna de las dos filas quedó insertada.
DO $t7b$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.evidence_chunks WHERE chunk_id IN (repeat('7', 63) || '0', repeat('7', 63) || '1');
  RAISE NOTICE 'RESULT ciclo_dos_nodos_filas_persistidas=%', n;
END $t7b$;

-- ------------------------------------------------------------------
-- 8. cadena / ciclo largo: chunkX es un duplicado VÁLIDO de A0 (succeeds),
--    luego chunkY intenta apuntar a chunkX (que ya NO es canónico) — debe
--    rechazarse, cerrando cualquier indirección de más de un nivel.
-- ------------------------------------------------------------------
INSERT INTO public.evidence_chunks (
  chunk_id, organization_id, project_id, evidence_id, document_version_id,
  version_id, raw_content_hash, normalized_content_hash,
  chunk_index, content, content_hash, char_start, char_end,
  normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
) VALUES (
  repeat('8', 64), '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
  '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
  9, NULL, repeat('b', 64), 131, 140, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, repeat('a', 64)
);
DO $cadena_ok$ BEGIN RAISE NOTICE 'RESULT cadena_setup=OK'; END $cadena_ok$;

DO $t8$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('9', 64), '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
      '44444444-4444-4444-4444-444444444401', repeat('1', 64), repeat('2', 64), repeat('3', 64),
      10, NULL, repeat('b', 64), 141, 150, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, repeat('8', 64)
    );
    RAISE NOTICE 'RESULT ciclo_largo=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT ciclo_largo=%', SQLSTATE;
  END;
END $t8$;

-- ------------------------------------------------------------------
-- 9. owner intentando UPDATE (chunks) — nunca, ni para el dueño.
-- ------------------------------------------------------------------
DO $t9$
BEGIN
  BEGIN
    UPDATE public.evidence_chunks SET char_start = 999 WHERE chunk_id = repeat('a', 64);
    RAISE NOTICE 'RESULT owner_update_chunks=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_update_chunks=%', SQLSTATE;
  END;
END $t9$;

-- ------------------------------------------------------------------
-- 10. owner intentando UPDATE (versions) — nunca, ni para el dueño.
-- ------------------------------------------------------------------
DO $t10$
BEGIN
  BEGIN
    UPDATE public.evidence_document_versions SET ordinal = 99 WHERE id = '44444444-4444-4444-4444-444444444401';
    RAISE NOTICE 'RESULT owner_update_versions=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_update_versions=%', SQLSTATE;
  END;
END $t10$;

-- ------------------------------------------------------------------
-- 11. owner intentando DELETE (versions) — nunca, ni para el dueño. Cadena de
--     custodia, no índice derivado.
-- ------------------------------------------------------------------
DO $t11$
BEGIN
  BEGIN
    DELETE FROM public.evidence_document_versions WHERE id = '44444444-4444-4444-4444-444444444401';
    RAISE NOTICE 'RESULT owner_delete_versions=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_delete_versions=%', SQLSTATE;
  END;
END $t11$;

-- ------------------------------------------------------------------
-- 12. owner intentando TRUNCATE (chunks) — nunca, ni para el dueño.
-- ------------------------------------------------------------------
DO $t12$
BEGIN
  BEGIN
    TRUNCATE public.evidence_chunks;
    RAISE NOTICE 'RESULT owner_truncate_chunks=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_truncate_chunks=%', SQLSTATE;
  END;
END $t12$;

-- ------------------------------------------------------------------
-- 13. session_replication_role=replica NO desactiva la inmutabilidad —
--     ENABLE ALWAYS ya está en efecto desde el arranque de esta sesión.
--
--     session_replication_role sólo lo puede fijar un superusuario, así que
--     hay que volver a supabase_admin (RESET ROLE) para tocarlo y volver a
--     uellix_owner después — SET ROLE no toca session_replication_role, pero
--     el GUC en sí exige current_user superusuario en cada extremo.
-- ------------------------------------------------------------------
RESET ROLE;
SET session_replication_role = replica;
SET ROLE uellix_owner;
DO $t13$
BEGIN
  BEGIN
    UPDATE public.evidence_chunks SET content_hash = repeat('0', 64) WHERE chunk_id = repeat('a', 64);
    RAISE NOTICE 'RESULT replica_bypass_chunks=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT replica_bypass_chunks=%', SQLSTATE;
  END;
END $t13$;

DO $t14$
BEGIN
  BEGIN
    DELETE FROM public.evidence_document_versions WHERE id = '44444444-4444-4444-4444-444444444401';
    RAISE NOTICE 'RESULT replica_bypass_versions=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT replica_bypass_versions=%', SQLSTATE;
  END;
END $t14$;

-- ------------------------------------------------------------------
-- 14. owner intentando DELETE (chunks) — DEBE funcionar: derivado y
--     regenerable, la asimetría deliberada frente a versions. Se ejecuta al
--     final para no interferir con las pruebas anteriores que dependen de A0.
-- ------------------------------------------------------------------
RESET ROLE;
RESET session_replication_role;
SET ROLE uellix_owner;
DO $t15$
DECLARE n int;
BEGIN
  DELETE FROM public.evidence_chunks WHERE chunk_id = repeat('a', 64);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'RESULT owner_delete_chunks_filas=%', n;
END $t15$;

ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
echo "$LIVE_OUT"
if [ "$LIVE_STATUS" -ne 0 ]; then
  fail "6-ter: el script SQL terminó con código $LIVE_STATUS (salida completa arriba)"
fi
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

check_result() {
  local name="$1" expected_pattern="$2"
  local line
  line=$(echo "$LIVE_OUT" | grep -oE "RESULT ${name}=[A-Za-z0-9_]+" | tail -1)
  if [ -z "$line" ]; then
    fail "6-ter: no se observó ningún resultado para '$name'"
  fi
  if ! echo "$line" | grep -qE "$expected_pattern"; then
    fail "6-ter: '$name' -> '$line', no coincide con lo esperado ($expected_pattern)"
  fi
  echo "  ok   $line"
}

check_result "seed" "=OK$"
# Puede rechazarlo la FK compuesta (23503, "no existe fila") o el trigger de
# aciclicidad (U0105, "no es canónico" — su rama NOT FOUND cubre "no existe" y
# "existe pero no es canónico" con el mismo mensaje). El orden de disparo
# entre una FK y un trigger AFTER definido por el usuario no está garantizado.
check_result "canonical_inexistente" "=(23503|U0105)$"
check_result "self_reference" "=(23514|check_violation)$"
check_result "cross_project" "=(23503|foreign_key_violation)$"
check_result "cross_organization" "=(23503|foreign_key_violation)$"
check_result "hash_distinto" "=(23503|foreign_key_violation)$"
check_result "version_distinta" "=(23503|foreign_key_violation)$"
# ciclo_dos_nodos: no se fija un SQLSTATE único a propósito — el orden de
# disparo entre la FK compuesta y el trigger de aciclicidad no está
# garantizado, y cualquiera de los dos debe rechazar. Lo que SÍ se fija,
# abajo, es que ninguna de las dos filas quedó persistida y que el resultado
# nunca fue UNEXPECTED_SUCCESS.
check_result "ciclo_dos_nodos_filas_persistidas" "=0$"
check_result "cadena_setup" "=OK$"
check_result "ciclo_largo" "=(U0105|23503)$"
check_result "owner_update_chunks" "=(insufficient_privilege|42501|U[0-9]{4})$"
check_result "owner_update_versions" "=(insufficient_privilege|42501|U[0-9]{4})$"
check_result "owner_delete_versions" "=(insufficient_privilege|42501|U[0-9]{4})$"
check_result "owner_truncate_chunks" "=(insufficient_privilege|42501|U[0-9]{4})$"
check_result "replica_bypass_chunks" "=(insufficient_privilege|42501|U[0-9]{4})$"
check_result "replica_bypass_versions" "=(insufficient_privilege|42501|U[0-9]{4})$"
check_result "owner_delete_chunks_filas" "=1$"

# ciclo_dos_nodos: cualquier SQLSTATE de rechazo vale, pero NUNCA éxito.
if echo "$LIVE_OUT" | grep -q 'RESULT ciclo_dos_nodos=UNEXPECTED_SUCCESS'; then
  fail "6-ter: el ciclo de dos nodos fue ACEPTADO — canonical_chunk_id permite un ciclo directo"
fi

echo "  ok   6-ter completo: reparaciones train 3 verificadas con datos reales, transacción revertida (ROLLBACK)"

# --------------------------------------------------------------------------
say "7. El orden de rollback está impuesto por el SQL"
# --------------------------------------------------------------------------
# 0002 primero debe NEGARSE: evidence_chunks aún referencia la tabla de versiones.
if "${PSQL[@]}" -1 -q -f "/grounding_0002_rollback.sql" >/dev/null 2>/dev/null; then
  fail "grounding_0002_rollback corrió con la FK de evidence_chunks viva"
fi
echo "  ok   rollback de 0002 antes que 0003 se niega, como debe"

# --------------------------------------------------------------------------
say "8. Rollback en orden inverso"
# --------------------------------------------------------------------------
for f in "${ROLLBACKS[@]}"; do
  printf '  %-42s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/gerr_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/gerr_$$; exit 1; fi
done
ROLLBACK_STATE=$(state)
echo "  estado tras rollback: $ROLLBACK_STATE"
assert_eq "vuelve exactamente al baseline" "$BASELINE" "$ROLLBACK_STATE"

# --------------------------------------------------------------------------
say "9. Reaplicar — el estado debe ser idéntico al del paso 5"
# --------------------------------------------------------------------------
for f in "${FORWARD[@]}"; do
  printf '  %-42s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/gerr_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/gerr_$$; exit 1; fi
done
REAPPLY_STATE=$(state)
assert_eq "reaplicado == aplicado" "$FORWARD_STATE" "$REAPPLY_STATE"

say "GROUNDING DRY RUN COMPLETO — contenedor destruido al salir"
echo "  imagen           : $IMAGE"
echo "  baseline         : $BASELINE"
echo "  forward          : $FORWARD_STATE"
echo "  rollback         : $ROLLBACK_STATE"
echo "  re-apply         : $REAPPLY_STATE"
echo "  (tablas/policies/rol definer/funciones/schema/triggers)"
