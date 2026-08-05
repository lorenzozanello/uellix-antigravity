#!/usr/bin/env bash
# scripts/stella-train4-dry-run.sh
#
# Aplica, INVOCA, revierte y REAPLICA la cadena Train 4 completa
#   grounding_0002 -> grounding_0003 -> stella_0013 -> grounding_0004
# en un contenedor DESECHABLE restaurado desde db/baseline/. Deriva los
# conteos; no los asume.
#
# POR QUÉ ES UN ARNÉS APARTE Y NO UNA ETAPA DE grounding-dry-run.sh
#   Aquel afirma conteos EXACTOS del estado del tren 3 (5 funciones, 7
#   policies, 6 triggers). Añadirle un rol, un esquema, dos funciones, tres
#   CHECK y una columna desplazaría todas esas cifras, y con ellas la evidencia
#   de gate que la línea ya produjo. Un arnés hermano mide lo nuevo sin
#   reescribir lo que ya estaba medido — el mismo argumento que
#   grounding-dry-run.sh hace frente a capability-dry-run.sh, un tren después.
#
# QUÉ HACE QUE ESTO NO SEA UNA INSPECCIÓN DE ESTRUCTURA
#   Las funciones se LLAMAN. La cuota se CONSUME, se reintenta, se agota y se
#   disputa entre dos transacciones concurrentes. El scope devuelto por SQL se
#   COMPARA contra el pedido. Los ataques cross-organization y cross-project se
#   EJECUTAN. El tren 2 demostró que un arnés que sólo inspecciona estructura
#   certifica que el paquete se instala, no que sirve: los dos paquetes de
#   grounding instalaban limpiamente y TODA llamada moría con 42501.
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen montado, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida, pase o
#   falle. db/baseline/** se lee, nunca se escribe.
#
#   bash scripts/stella-train4-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_train4_dry_run_$$"
BASE_DIR="db/baseline"

FORWARD=(grounding_0002_document_versions grounding_0003_evidence_chunks
         stella_0013_grounded_query_quota grounding_0004_runtime_attestation)
# Orden inverso, y el propio SQL lo impone en los dos extremos: el rollback de
# 0002 se niega mientras evidence_chunks conserve su clave foránea, y el de
# 0013 se niega mientras el ledger tenga filas grounded_query.
ROLLBACKS=(grounding_0004_rollback stella_0013_rollback
           grounding_0003_rollback grounding_0002_rollback)

# Identidades fijas de la siembra. Fuera de las funciones para que las
# aserciones de bash y el SQL no puedan discrepar sobre a quién se refieren.
USER_A='99999999-9999-9999-9999-999999999941'
USER_B='99999999-9999-9999-9999-999999999942'
ORG_A='11111111-1111-1111-1111-111111111141'
ORG_B='11111111-1111-1111-1111-111111111142'
PROJ_A='22222222-2222-2222-2222-222222222241'
PROJ_B='22222222-2222-2222-2222-222222222242'
EVID_A='33333333-3333-3333-3333-333333333341'
EVID_B='33333333-3333-3333-3333-333333333342'
VER_A='44444444-4444-4444-4444-444444444441'
VER_B='44444444-4444-4444-4444-444444444442'

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

assert_eq() {
  if [ "$2" = "$3" ]; then printf '  ok   %-46s %s\n' "$1" "$3"
  else printf '  FAIL %-46s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; exit 1; fi
}

# El vector de estado que se compara entre "aplicado", "revertido" y
# "reaplicado". Cada componente es una clase de objeto que uno de los cuatro
# paquetes crea o altera. Se cuentan OBJETOS, no filas: el ledger es
# append-only, así que una fila cobrada no puede retirarse y comparar filas
# haría que el retorno al baseline dependiera de qué pruebas corrieron antes.
state() {
  printf '%s/%s/%s/%s/%s/%s/%s/%s' \
    "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" \
    "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='public'")" \
    "$(Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix_cap\\_%'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('uellix_grounding','uellix_stella')")" \
    "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname IN ('uellix_grounding','uellix_stella')")" \
    "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")" \
    "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='stella_interactions'")" \
    "$(Q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='evidence_chunks' AND grantee='authenticated'")"
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

for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f"
done
for f in "${FORWARD[@]}" "${ROLLBACKS[@]}"; do
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql"
done

# --------------------------------------------------------------------------
# Restaurar el baseline. En una FUNCIÓN porque se invoca DOS veces: las pruebas
# vivas de concurrencia tienen que hacer COMMIT (dos sesiones no pueden
# compartir una transacción que se revierte), y el ledger es append-only, así
# que esas filas no se pueden retirar. Medir el retorno exacto al baseline
# exige por tanto una base que nunca cobró — y demostrar que el rollback SE
# NIEGA sobre una que sí cobró exige una que sí. Son dos experimentos y hacen
# falta dos bases.
# --------------------------------------------------------------------------
restore_baseline() {
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

  # Los roles son objetos de CLÚSTER, no de base: `DROP DATABASE` no se los
  # lleva. En el primer restore no hay ninguno porque el contenedor acaba de
  # arrancar; en el segundo, los dos roles de capacidad que la cadena creó
  # siguen ahí y el vector de estado los cuenta, así que sin esto el
  # "baseline" de la segunda vuelta no sería el mismo objeto que el de la
  # primera y la comparación del §13 mediría dos cosas distintas.
  #
  # Esto NO debilita la aserción del §13: allí el retorno al baseline lo
  # producen los ROLLBACKS, sin limpieza del arnés. Aquí sólo se restablece el
  # punto de partida.
  for r in uellix_cap_grounding uellix_cap_stella_quota; do
    docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
      "DROP ROLE IF EXISTS $r" >/dev/null || fail "no se pudo retirar el rol de clúster $r"
  done

  "${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "restore de roles falló"
  "${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "restore de schema falló"
  "${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore falló"
}

apply_forward() {
  for f in "${FORWARD[@]}"; do
    printf '  %-46s ' "$f"
    if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/t4err_$$; then echo "OK"
    else echo "FAIL"; cat /tmp/t4err_$$; exit 1; fi
  done
}

# La siembra que las pruebas vivas necesitan: dos organizaciones, dos
# proyectos, dos usuarios y una pertenencia ACTIVA sólo para el usuario A en la
# organización A. La asimetría es el punto: todo ataque cross-tenant de abajo
# se ejecuta con la sesión de A.
seed_fixture() {
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "la siembra falló"
SET ROLE uellix_owner;

INSERT INTO public.users (id, email) VALUES
  ('$USER_A', 'train4-a@example.invalid'),
  ('$USER_B', 'train4-b@example.invalid');

INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
  ('$ORG_A', 'Org Train4 A', 'org-train4-a', 2),
  ('$ORG_B', 'Org Train4 B', 'org-train4-b', 50);

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('$ORG_A', '$USER_A', 'analyst', 'active'),
  ('$ORG_B', '$USER_B', 'analyst', 'active');

INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
  ('$PROJ_A', '$ORG_A', 'Project A', '$USER_A'),
  ('$PROJ_B', '$ORG_B', 'Project B', '$USER_B');

INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, created_by) VALUES
  ('$EVID_A', '$PROJ_A', '$ORG_A', 'text', 'Evidence A', '$USER_A'),
  ('$EVID_B', '$PROJ_B', '$ORG_B', 'text', 'Evidence B', '$USER_B');

INSERT INTO public.evidence_document_versions (
  id, organization_id, project_id, evidence_id, version_id, raw_content_hash,
  normalized_content_hash, normalization_version, extractor_version,
  chunker_version, mime_type, ordinal, supersedes_version_id
) VALUES
  ('$VER_A', '$ORG_A', '$PROJ_A', '$EVID_A', repeat('1', 64), repeat('2', 64), repeat('3', 64),
   'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL),
  ('$VER_B', '$ORG_B', '$PROJ_B', '$EVID_B', repeat('4', 64), repeat('5', 64), repeat('6', 64),
   'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL);

-- Los chunks se siembran con digests REALES, derivados aquí mismo. Sembrarlos
-- con repeat('a',64) —lo que hace el arnés del tren 3— es exactamente lo que
-- los tres CHECK de grounding_0004 existen para rechazar, así que una siembra
-- que pasa es la primera prueba de que la derivación es la del contrato.
DO \$seed\$
DECLARE
  v_text_a text := 'hello world';
  v_text_b text := 'otro tenant';
  v_hash   char(64);
  v_id     char(64);
BEGIN
  v_hash := encode(sha256(convert_to(v_text_a, 'UTF8')), 'hex');
  v_id := encode(sha256(convert_to(
    'grounding/chunk/v1' || chr(10) || repeat('1', 64) || chr(10) || '0' || chr(10) || v_hash, 'UTF8')), 'hex');
  INSERT INTO public.evidence_chunks (
    chunk_id, organization_id, project_id, evidence_id, document_version_id,
    version_id, raw_content_hash, normalized_content_hash, chunk_index, content,
    content_hash, char_start, char_end, normalization_version, chunker_version,
    injection_scanner_version, signals, canonical_chunk_id
  ) VALUES (
    v_id, '$ORG_A', '$PROJ_A', '$EVID_A', '$VER_A', repeat('1', 64), repeat('2', 64), repeat('3', 64),
    0, v_text_a, v_hash, 0, length(v_text_a), 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL);

  v_hash := encode(sha256(convert_to(v_text_b, 'UTF8')), 'hex');
  v_id := encode(sha256(convert_to(
    'grounding/chunk/v1' || chr(10) || repeat('4', 64) || chr(10) || '0' || chr(10) || v_hash, 'UTF8')), 'hex');
  INSERT INTO public.evidence_chunks (
    chunk_id, organization_id, project_id, evidence_id, document_version_id,
    version_id, raw_content_hash, normalized_content_hash, chunk_index, content,
    content_hash, char_start, char_end, normalization_version, chunker_version,
    injection_scanner_version, signals, canonical_chunk_id
  ) VALUES (
    v_id, '$ORG_B', '$PROJ_B', '$EVID_B', '$VER_B', repeat('4', 64), repeat('5', 64), repeat('6', 64),
    0, v_text_b, v_hash, 0, length(v_text_b), 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL);
END \$seed\$;
SQL
}

# --------------------------------------------------------------------------
say "3. Base postgres vacía desde template0 + restore del baseline"
# --------------------------------------------------------------------------
restore_baseline
BASELINE=$(state)
echo "  baseline: $BASELINE"
echo "  (tablas/policies/roles cap/funciones/esquemas/triggers/cols stella_interactions/grants authenticated en chunks)"
assert_eq "rol uellix_cap_stella_quota ausente" "0" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_stella_quota'")"
assert_eq "esquema uellix_stella ausente"       "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_stella'")"
assert_eq "idempotency_key ausente"             "0" "$(Q "SELECT count(*) FROM information_schema.columns WHERE table_name='stella_interactions' AND column_name='idempotency_key'")"
assert_eq "grounded_query NO en el CHECK"       "0" "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='stella_interactions_stella_role_check' AND pg_get_constraintdef(oid) LIKE '%grounded_query%'")"

# --------------------------------------------------------------------------
say "4. El orden forward está impuesto por el SQL, no por este script"
# --------------------------------------------------------------------------
# grounding_0004 PRIMERO, a propósito: debe abortar por sí solo. Si pasara, el
# resto del arnés estaría midiendo un orden que nada obliga a respetar.
if "${PSQL[@]}" -1 -q -f "/grounding_0004_runtime_attestation.sql" >/dev/null 2>/dev/null; then
  fail "grounding_0004 se aplicó SIN grounding_0002/0003 — su guarda de dependencia no obliga"
fi
echo "  ok   grounding_0004 sin 0002/0003 aborta, como debe"

# --------------------------------------------------------------------------
say "5. Aplicar la cadena de 4, dos veces (idempotencia)"
# --------------------------------------------------------------------------
PASS1=""
for pass in 1 2; do
  echo "  --- pase $pass ---"
  apply_forward
  S=$(state)
  echo "  estado tras pase $pass: $S"
  if [ "$pass" = "1" ]; then PASS1="$S"; fi
done
FORWARD_STATE=$(state)
[ "$PASS1" = "$FORWARD_STATE" ] || fail "no es idempotente: pase1=$PASS1 pase2=$FORWARD_STATE"

# --------------------------------------------------------------------------
say "6. Superficie gobernada — aserciones estructurales"
# --------------------------------------------------------------------------
assert_eq "rol uellix_cap_stella_quota"          "1" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_stella_quota'")"
assert_eq "definer de cuota NOLOGIN"             "f" "$(Q "SELECT rolcanlogin FROM pg_roles WHERE rolname='uellix_cap_stella_quota'")"
assert_eq "definer de cuota NOBYPASSRLS"         "f" "$(Q "SELECT rolbypassrls FROM pg_roles WHERE rolname='uellix_cap_stella_quota'")"
assert_eq "definer de cuota NOINHERIT"           "f" "$(Q "SELECT rolinherit FROM pg_roles WHERE rolname='uellix_cap_stella_quota'")"
assert_eq "miembros del definer de cuota"        "0" "$(Q "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='uellix_cap_stella_quota'")"
# 6 en uellix_grounding (2 de grounding_0002 + 3 de grounding_0003 + 1 de
# grounding_0004) y 1 en uellix_stella. El conteo es EXACTO a propósito: una
# séptima función en uno de los dos esquemas llegaría sin que ninguna de las
# tres aserciones siguientes la hubiera juzgado, y el contrato de definer que
# ambos paquetes se auto-verifican está escrito sobre el ESQUEMA entero por
# exactamente la misma razón.
assert_eq "funciones (grounding 6 + stella 1)"   "7" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('uellix_grounding','uellix_stella')")"
assert_eq "todas SECURITY DEFINER"               "7" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('uellix_grounding','uellix_stella') AND p.prosecdef")"
# Se comprueba el VALOR, no la ortografía: PostgreSQL guarda `search_path = ''`
# como `search_path=""`.
assert_eq "todas con search_path vacio"          "7" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('uellix_grounding','uellix_stella') AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\\_path=%' AND btrim(split_part(cfg,'=',2),'\"') = '')")"
assert_eq "todas propiedad de un rol cap"        "7" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('uellix_grounding','uellix_stella') AND pg_get_userbyid(p.proowner) IN ('uellix_cap_grounding','uellix_cap_stella_quota')")"
assert_eq "cero EXECUTE para PUBLIC"             "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname IN ('uellix_grounding','uellix_stella') AND a.grantee=0")"
# INT-CAP-002: la superficie de lectura de PostgREST, cerrada.
assert_eq "authenticated sin nada en chunks"     "0" "$(Q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='evidence_chunks' AND grantee='authenticated'")"
# PERMISIVA, y la distinción es el punto entero. Una policy RESTRICTIVE se
# conjunta con todas las demás y sólo puede ESTRECHAR, así que
# evidence_chunks_scope_consistency (grounding_0003) nombrando `authenticated`
# no concede nada: enuncia un invariante que ataría a ese rol si alguna vez
# tuviera un grant. Una PERMISIVA se disyunta, y una que lo nombre es una vía
# de entrada. Exigir cero de LAS DOS habría obligado a reescribir una policy de
# grounding_0003 para satisfacer una aserción que mide la propiedad equivocada.
assert_eq "ninguna policy PERMISIVA lo nombra"   "0" "$(Q "SELECT count(*) FROM pg_policy pol, LATERAL unnest(pol.polroles) r(oid) JOIN pg_roles g ON g.oid=r.oid WHERE pol.polrelid='public.evidence_chunks'::regclass AND g.rolname='authenticated' AND pol.polpermissive")"
# El definer de cuota no puede borrar lo que escribe, ni leer el almacén de
# identidades al que sólo se le dio USAGE para que auth.uid() resuelva.
assert_eq "definer de cuota sin UPDATE/DELETE"   "0" "$(Q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='stella_interactions' AND grantee='uellix_cap_stella_quota' AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')")"
assert_eq "definer de cuota no lee auth.users"   "f" "$(Q "SELECT has_table_privilege('uellix_cap_stella_quota','auth.users','SELECT')")"
assert_eq "grounded_query EN el CHECK"           "1" "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='stella_interactions_stella_role_check' AND pg_get_constraintdef(oid) LIKE '%grounded_query%'")"
assert_eq "3 CHECK nuevos en evidence_chunks"    "3" "$(Q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.evidence_chunks'::regclass AND conname IN ('evidence_chunks_content_hash_derivation_check','evidence_chunks_span_length_check','evidence_chunks_chunk_id_derivation_check')")"
assert_eq "cero constraints NOT VALID"           "0" "$(Q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.evidence_chunks'::regclass AND contype='c' AND NOT convalidated")"
# La ruta gobernada tiene que ser ALCANZABLE por la identidad de la aplicación.
# El tren 2 instaló dos paquetes funcionalmente muertos y ninguna aserción de
# estructura lo vio.
assert_eq "uellix_app puede llamar a la cuota"   "t" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella.consume_stella_quota(uuid,uuid,character varying,character)','EXECUTE')")"
assert_eq "uellix_app puede llamar al atestado"  "t" "$(Q "SELECT has_function_privilege('uellix_app','uellix_grounding.chunks_in_scope_attested(uuid,uuid,uuid)','EXECUTE')")"

# --------------------------------------------------------------------------
say "7. Siembra y pruebas vivas — todo dentro de UNA transacción revertida"
# --------------------------------------------------------------------------
seed_fixture

# `RESULT nombre=valor` es el único contrato entre este SQL y el grep de bash.
# Cada sub-prueba usa un bloque BEGIN/EXCEPTION anidado —un savepoint implícito
# de PL/pgSQL— para que un fallo ESPERADO no aborte la transacción exterior.
set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

-- ------------------------------------------------------------------
-- CUOTA. La organización A tiene stella_monthly_quota = 2.
-- ------------------------------------------------------------------
DO \$q1\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota(
    '$ORG_A', '$PROJ_A', 'grounded_query', repeat('a', 64));
  RAISE NOTICE 'RESULT quota_first=%|%|%', r.outcome, r.used, r.quota;
END \$q1\$;

-- Misma clave: reintento. Debe ser gratis y decirlo.
DO \$q2\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota(
    '$ORG_A', '$PROJ_A', 'grounded_query', repeat('a', 64));
  RAISE NOTICE 'RESULT quota_replay=%|%', r.outcome, r.used;
END \$q2\$;

-- Clave distinta: segunda unidad, la última.
DO \$q3\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota(
    '$ORG_A', '$PROJ_A', 'grounded_query', repeat('b', 64));
  RAISE NOTICE 'RESULT quota_second=%|%', r.outcome, r.used;
END \$q3\$;

-- Tercera: agotada.
DO \$q4\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota(
    '$ORG_A', '$PROJ_A', 'grounded_query', repeat('c', 64));
  RAISE NOTICE 'RESULT quota_exhausted=%|%', r.outcome, r.used;
END \$q4\$;

-- Sólo se cobró lo que se dijo: 2 filas, no 3, y ninguna sin identidad.
DO \$q5\$
DECLARE n int; m int;
BEGIN
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  SELECT count(*) INTO m FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND idempotency_key IS NULL;
  RAISE NOTICE 'RESULT quota_rows=%', n;
  RAISE NOTICE 'RESULT quota_rows_sin_clave=%', m;
END \$q5\$;

-- Organización cruzada: la sesión es de A, el ledger pedido es el de B.
DO \$q6\$
DECLARE r record;
BEGIN
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_quota(
      '$ORG_B', '$PROJ_B', 'grounded_query', repeat('d', 64));
    RAISE NOTICE 'RESULT quota_cross_org=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT quota_cross_org=%', SQLSTATE;
  END;
END \$q6\$;

-- Proyecto cruzado: organización propia, proyecto ajeno.
DO \$q7\$
DECLARE r record;
BEGIN
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_quota(
      '$ORG_A', '$PROJ_B', 'grounded_query', repeat('e', 64));
    RAISE NOTICE 'RESULT quota_cross_project=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT quota_cross_project=%', SQLSTATE;
  END;
END \$q7\$;

-- Categoría fuera del vocabulario gobernado.
DO \$q8\$
DECLARE r record;
BEGIN
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_quota(
      '$ORG_A', '$PROJ_A', 'not_a_capability', repeat('f', 64));
    RAISE NOTICE 'RESULT quota_role_no_gobernado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT quota_role_no_gobernado=%', SQLSTATE;
  END;
END \$q8\$;

-- Clave malformada: la identidad tiene que ser recomputable por el reintento.
DO \$q9\$
DECLARE r record;
BEGIN
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_quota(
      '$ORG_A', '$PROJ_A', 'grounded_query', 'no-es-un-sha256');
    RAISE NOTICE 'RESULT quota_clave_malformada=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT quota_clave_malformada=%', SQLSTATE;
  END;
END \$q9\$;

-- Una operación fallida no deja rastro: el conteo tras los cuatro rechazos es
-- el mismo que antes de ellos. Sin esto, "rechazó" y "rechazó DESPUÉS de
-- cobrar" se leen igual.
DO \$q10\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.stella_interactions WHERE organization_id = '$ORG_A';
  RAISE NOTICE 'RESULT quota_rows_tras_rechazos=%', n;
END \$q10\$;

-- ------------------------------------------------------------------
-- SCOPE ATESTADO. Lo que se compara es el scope PEDIDO contra el
-- DEVUELTO, que es justo lo que INT-GR-004 dice que hoy no se puede.
-- ------------------------------------------------------------------
DO \$s1\$
DECLARE r record; n int := 0; mismatched int := 0;
BEGIN
  FOR r IN SELECT * FROM uellix_grounding.chunks_in_scope_attested('$ORG_A', '$PROJ_A', '$VER_A') LOOP
    n := n + 1;
    IF r.organization_id <> '$ORG_A' OR r.project_id <> '$PROJ_A'
       OR r.evidence_id <> '$EVID_A' OR r.document_version_id <> '$VER_A' THEN
      mismatched := mismatched + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'RESULT scope_filas=%', n;
  RAISE NOTICE 'RESULT scope_fuera_de_alcance=%', mismatched;
END \$s1\$;

-- La ruta de lectura de grounding_0003, con los mismos argumentos. Mide la
-- reparación de §2a del paquete: antes de ella el rol de capacidad no estaba
-- nombrado por ninguna policy permisiva y ESTA función devolvía cero filas
-- —silenciosamente— para todo llamante. Si volviera a devolver cero mientras
-- la atestada devuelve una, la reparación se habría aplicado a medias.
DO \$s1b\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM uellix_grounding.chunks_in_scope('$ORG_A', '$PROJ_A', '$VER_A');
  RAISE NOTICE 'RESULT scope_lector_0003_filas=%', n;
END \$s1b\$;

-- La otra mitad del mismo hallazgo: finalize_document_ingestion cuenta chunks
-- canónicos a través del mismo rol. Con la policy ausente contaba 0 y toda
-- ingestión se declaraba incompleta (U0103). Con 1 chunk sembrado, esperar 1
-- tiene que pasar en silencio.
DO \$s1c\$
BEGIN
  BEGIN
    PERFORM uellix_grounding.finalize_document_ingestion('$VER_A', 1);
    RAISE NOTICE 'RESULT finalize_cuenta_correcta=OK';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT finalize_cuenta_correcta=%', SQLSTATE;
  END;
END \$s1c\$;

-- Proyecto cruzado dentro de la organización propia: cero filas, no error.
DO \$s2\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM uellix_grounding.chunks_in_scope_attested('$ORG_A', '$PROJ_B', '$VER_A');
  RAISE NOTICE 'RESULT scope_cross_project_filas=%', n;
END \$s2\$;

-- Versión de otro tenant nombrada por su uuid, con el scope de A: cero filas.
DO \$s3\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM uellix_grounding.chunks_in_scope_attested('$ORG_A', '$PROJ_A', '$VER_B');
  RAISE NOTICE 'RESULT scope_evidencia_ajena_filas=%', n;
END \$s3\$;

-- Organización cruzada: la frontera del definer, no un filtro.
DO \$s4\$
DECLARE n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM uellix_grounding.chunks_in_scope_attested('$ORG_B', '$PROJ_B', '$VER_B');
    RAISE NOTICE 'RESULT scope_cross_org=UNEXPECTED_SUCCESS_%', n;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT scope_cross_org=%', SQLSTATE;
  END;
END \$s4\$;

-- SELECT amplio y directo, la ruta que INT-CAP-002 cierra.
DO \$s5\$
DECLARE n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.evidence_chunks;
    RAISE NOTICE 'RESULT select_directo_app_filas=%', n;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT select_directo_app=%', SQLSTATE;
  END;
END \$s5\$;

RESET ROLE;
ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
if [ "$LIVE_STATUS" -ne 0 ]; then
  echo "$LIVE_OUT"
  fail "7: el script SQL terminó con código $LIVE_STATUS"
fi
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

check_result() {
  local name="$1" expected_pattern="$2" line
  line=$(echo "$LIVE_OUT" | grep -oE "RESULT ${name}=[A-Za-z0-9_|]+" | tail -1)
  [ -n "$line" ] || fail "no se observó ningún resultado para '$name'"
  echo "$line" | grep -qE "$expected_pattern" \
    || fail "'$name' -> '$line', no coincide con lo esperado ($expected_pattern)"
  echo "  ok   $line"
}

# --- Cuota -----------------------------------------------------------------
check_result "quota_first"                "=consumed\|1\|2$"
check_result "quota_replay"               "=replayed\|1$"
check_result "quota_second"               "=consumed\|2$"
check_result "quota_exhausted"            "=quota_exceeded\|2$"
check_result "quota_rows"                 "=2$"
check_result "quota_rows_sin_clave"       "=0$"
check_result "quota_rows_tras_rechazos"   "=2$"
# U0102 y no un error de permiso: el definer LEE (privilegio presente) y
# RECHAZA por alcance. Un 42501 aquí sería el BLOCKER del tren 2 repetido.
check_result "quota_cross_org"            "=U0102$"
check_result "quota_cross_project"        "=U0102$"
check_result "quota_role_no_gobernado"    "=U0106$"
check_result "quota_clave_malformada"     "=U0100$"

# --- Scope -----------------------------------------------------------------
check_result "scope_filas"                "=1$"
check_result "scope_fuera_de_alcance"     "=0$"
# La reparación de §2a, medida sobre la función de grounding_0003 y sobre la
# que cuenta. Ambas leen a través del mismo rol de capacidad: si la policy no
# lo nombrara, la primera devolvería 0 y la segunda U0103.
check_result "scope_lector_0003_filas"    "=1$"
check_result "finalize_cuenta_correcta"   "=OK$"
check_result "scope_cross_project_filas"  "=0$"
check_result "scope_evidencia_ajena_filas" "=0$"
check_result "scope_cross_org"            "=U0102$"
# INT-CAP-002: uellix_app conserva su SELECT (lo necesita para nada, pero
# grounding_0003 se lo dio y este paquete no se lo quita); lo que se cerró es
# `authenticated`, medido en §6. Lo que aquí importa es que la ruta directa
# NUNCA devuelve más que la gobernada.
check_result "select_directo_app_filas"   "=1$"

# --------------------------------------------------------------------------
say "8. Ataques de escritura con el OWNER — donde RLS no llega"
# --------------------------------------------------------------------------
set +e
OWNER_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SET ROLE uellix_owner;

-- chunk_id forjado (INT-CAP-004). El CHECK ata al dueño; la FK y el cuerpo de
-- insert_evidence_chunks no.
DO \$o1\$
BEGIN
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash, chunk_index, content,
      content_hash, char_start, char_end, normalization_version, chunker_version,
      injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      repeat('a', 64), '$ORG_A', '$PROJ_A', '$EVID_A', '$VER_A',
      repeat('1', 64), repeat('2', 64), repeat('3', 64), 1, 'forjado',
      encode(sha256(convert_to('forjado', 'UTF8')), 'hex'), 0, 7,
      'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL);
    RAISE NOTICE 'RESULT owner_chunk_id_forjado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_chunk_id_forjado=%', SQLSTATE;
  END;
END \$o1\$;

-- content_hash que no es el digest de content (INT-CAP-003).
DO \$o2\$
DECLARE v_id char(64);
BEGIN
  v_id := encode(sha256(convert_to(
    'grounding/chunk/v1' || chr(10) || repeat('1', 64) || chr(10) || '2' || chr(10) || repeat('9', 64), 'UTF8')), 'hex');
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash, chunk_index, content,
      content_hash, char_start, char_end, normalization_version, chunker_version,
      injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      v_id, '$ORG_A', '$PROJ_A', '$EVID_A', '$VER_A',
      repeat('1', 64), repeat('2', 64), repeat('3', 64), 2, 'texto real',
      repeat('9', 64), 0, 10, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL);
    RAISE NOTICE 'RESULT owner_hash_no_deriva=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_hash_no_deriva=%', SQLSTATE;
  END;
END \$o2\$;

-- Span declarado sobre miles de caracteres para un pasaje de diez.
DO \$o3\$
DECLARE v_txt text := 'diez chars'; v_hash char(64); v_id char(64);
BEGIN
  v_hash := encode(sha256(convert_to(v_txt, 'UTF8')), 'hex');
  v_id := encode(sha256(convert_to(
    'grounding/chunk/v1' || chr(10) || repeat('1', 64) || chr(10) || '3' || chr(10) || v_hash, 'UTF8')), 'hex');
  BEGIN
    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash, chunk_index, content,
      content_hash, char_start, char_end, normalization_version, chunker_version,
      injection_scanner_version, signals, canonical_chunk_id
    ) VALUES (
      v_id, '$ORG_A', '$PROJ_A', '$EVID_A', '$VER_A',
      repeat('1', 64), repeat('2', 64), repeat('3', 64), 3, v_txt,
      v_hash, 0, 5000, 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL);
    RAISE NOTICE 'RESULT owner_span_absurdo=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_span_absurdo=%', SQLSTATE;
  END;
END \$o3\$;

-- Y el control positivo: una fila BIEN derivada sí entra. Sin él, los tres
-- rechazos de arriba serían igual de compatibles con "el CHECK rechaza todo".
DO \$o4\$
DECLARE v_txt text := 'pasaje valido'; v_hash char(64); v_id char(64);
BEGIN
  v_hash := encode(sha256(convert_to(v_txt, 'UTF8')), 'hex');
  v_id := encode(sha256(convert_to(
    'grounding/chunk/v1' || chr(10) || repeat('1', 64) || chr(10) || '4' || chr(10) || v_hash, 'UTF8')), 'hex');
  INSERT INTO public.evidence_chunks (
    chunk_id, organization_id, project_id, evidence_id, document_version_id,
    version_id, raw_content_hash, normalized_content_hash, chunk_index, content,
    content_hash, char_start, char_end, normalization_version, chunker_version,
    injection_scanner_version, signals, canonical_chunk_id
  ) VALUES (
    v_id, '$ORG_A', '$PROJ_A', '$EVID_A', '$VER_A',
    repeat('1', 64), repeat('2', 64), repeat('3', 64), 4, v_txt,
    v_hash, 0, length(v_txt), 'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL);
  RAISE NOTICE 'RESULT owner_fila_valida=OK';
END \$o4\$;

ROLLBACK;
SQL
)
OWNER_STATUS=$?
set -e
if [ "$OWNER_STATUS" -ne 0 ]; then
  echo "$OWNER_OUT"
  fail "8: el script SQL terminó con código $OWNER_STATUS"
fi
echo "$OWNER_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'
LIVE_OUT="$OWNER_OUT"
check_result "owner_chunk_id_forjado" "=23514$"
check_result "owner_hash_no_deriva"   "=23514$"
check_result "owner_span_absurdo"     "=23514$"
check_result "owner_fila_valida"      "=OK$"

# --------------------------------------------------------------------------
say "9. Concurrencia real — dos sesiones sobre la última unidad"
# --------------------------------------------------------------------------
# Esta es la única prueba que NO se puede revertir: dos sesiones no comparten
# una transacción, así que la primera tiene que hacer COMMIT para que la
# segunda vea su fila. Por eso el §11 vuelve a restaurar el baseline.
#
# La organización B tiene cuota 50; se baja a 1 para que quede exactamente una
# unidad en disputa. Sin el lock de advisory, la sesión 2 contaría 0 (la fila
# de la sesión 1 sigue sin commitear) y devolvería `consumed`. Con él, espera y
# después cuenta 1, luego `quota_exceeded`. El resultado DISCRIMINA.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 1 WHERE id = '$ORG_B';" >/dev/null \
  || fail "no se pudo fijar la cuota de la organización B"

docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >/tmp/t4s1_$$ 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT outcome FROM uellix_stella.consume_stella_quota('$ORG_B', '$PROJ_B', 'grounded_query', repeat('1', 64));
RESET ROLE;
SELECT pg_sleep(5);
COMMIT;
SQL
S1_PID=$!
sleep 2

T0=$(date +%s)
set +e
S2_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S2=' || outcome FROM uellix_stella.consume_stella_quota('$ORG_B', '$PROJ_B', 'grounded_query', repeat('2', 64));
COMMIT;
SQL
)
S2_STATUS=$?
set -e
T1=$(date +%s)
wait "$S1_PID" || true
ELAPSED=$((T1 - T0))

[ "$S2_STATUS" -eq 0 ] || { echo "$S2_OUT"; fail "9: la sesión 2 falló"; }
S1_OUTCOME=$(grep -oE 'consumed|replayed|quota_exceeded|no_quota' "/tmp/t4s1_$$" | head -1)
S2_OUTCOME=$(echo "$S2_OUT" | grep -oE 'S2=(consumed|replayed|quota_exceeded|no_quota)' | head -1)
rm -f "/tmp/t4s1_$$"

echo "  sesión 1 -> $S1_OUTCOME"
echo "  sesión 2 -> $S2_OUTCOME  (esperó ${ELAPSED}s)"
assert_eq "sesión 1 obtiene la última unidad" "consumed"           "$S1_OUTCOME"
assert_eq "sesión 2 es rechazada"             "S2=quota_exceeded"  "$S2_OUTCOME"
# La espera es la evidencia de que hubo SERIALIZACIÓN y no una coincidencia de
# orden: sin lock la sesión 2 habría respondido en milisegundos.
if [ "$ELAPSED" -lt 2 ]; then
  fail "9: la sesión 2 respondió en ${ELAPSED}s — no esperó, así que el lock no serializó nada"
fi
echo "  ok   la sesión 2 esperó al COMMIT de la 1 antes de contar (${ELAPSED}s)"
assert_eq "una sola unidad cobrada en B" "1" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B' AND stella_role='grounded_query'")"

# --------------------------------------------------------------------------
say "10. El rollback de stella_0013 SE NIEGA sobre un ledger ya cobrado"
# --------------------------------------------------------------------------
if "${PSQL[@]}" -1 -q -f "/stella_0013_rollback.sql" >/dev/null 2>/dev/null; then
  fail "stella_0013_rollback corrió sobre un ledger con filas grounded_query — el CHECK de seis valores habría quedado violado por los datos"
fi
echo "  ok   se niega, como debe, y el ledger append-only queda intacto"
# UNA fila, no tres. Las dos de la organización A se cobraron dentro de la
# transacción del §7, que termina en ROLLBACK; la única que sobrevive es la que
# la sesión 1 del §9 tuvo que COMMITear para que la 2 pudiera verla. Que el
# conteo sea 1 y no 3 es en sí la prueba de que el §7 no dejó residuo.
assert_eq "la fila cobrada del §9 sigue ahí" "1" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE stella_role='grounded_query'")"

# --------------------------------------------------------------------------
say "11. Base limpia otra vez — para medir el retorno EXACTO al baseline"
# --------------------------------------------------------------------------
restore_baseline
BASELINE2=$(state)
assert_eq "el segundo restore es el mismo baseline" "$BASELINE" "$BASELINE2"
apply_forward
FORWARD2=$(state)
assert_eq "la cadena reaplicada da el mismo estado" "$FORWARD_STATE" "$FORWARD2"

# --------------------------------------------------------------------------
say "12. El orden de rollback está impuesto por el SQL"
# --------------------------------------------------------------------------
# 0003 antes que 0004 debe NEGARSE... o mejor dicho: 0003 no se niega, pero
# grounding_0002 sí mientras evidence_chunks exista, y eso ya lo mide el arnés
# del tren 3. Lo que se comprueba AQUÍ es lo que Train 4 añade: aplicar
# grounding_0003 con grounding_0004 puesto ABORTA, porque CREATE OR REPLACE no
# puede cambiar el tipo de retorno... y no aborta, precisamente porque este
# paquete publicó una función NUEVA en vez de sustituir la firma. Se mide el
# hecho, no la intención.
if "${PSQL[@]}" -1 -q -f "/grounding_0003_evidence_chunks.sql" >/dev/null 2>/tmp/t4err_$$; then
  echo "  ok   grounding_0003 se re-aplica con 0004 puesto (la función atestada es NUEVA, no un reemplazo de firma)"
else
  cat /tmp/t4err_$$
  fail "grounding_0003 dejó de ser re-aplicable con grounding_0004 puesto — la cadena forward ya no es idempotente"
fi
# ...y 0004 detrás vuelve a estrechar lo que 0003 acaba de reabrir.
"${PSQL[@]}" -1 -q -f "/grounding_0004_runtime_attestation.sql" >/dev/null \
  || fail "grounding_0004 no converge tras una re-aplicación de 0003"
assert_eq "0004 vuelve a cerrar la superficie de 0003" "0" \
  "$(Q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='evidence_chunks' AND grantee='authenticated'")"

# --------------------------------------------------------------------------
say "13. Rollback en orden inverso"
# --------------------------------------------------------------------------
for f in "${ROLLBACKS[@]}"; do
  printf '  %-46s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/t4err_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/t4err_$$; exit 1; fi
done
ROLLBACK_STATE=$(state)
echo "  estado tras rollback: $ROLLBACK_STATE"
assert_eq "vuelve exactamente al baseline" "$BASELINE" "$ROLLBACK_STATE"
assert_eq "grounded_query fuera del CHECK otra vez" "0" \
  "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='stella_interactions_stella_role_check' AND pg_get_constraintdef(oid) LIKE '%grounded_query%'")"
assert_eq "el rol de cuota ya no existe" "0" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_stella_quota'")"

# --------------------------------------------------------------------------
say "14. Reaplicar — el estado debe ser idéntico al del paso 5"
# --------------------------------------------------------------------------
apply_forward
REAPPLY_STATE=$(state)
assert_eq "reaplicado == aplicado" "$FORWARD_STATE" "$REAPPLY_STATE"

say "TRAIN 4 DRY RUN COMPLETO — contenedor destruido al salir"
echo "  imagen           : $IMAGE"
echo "  baseline         : $BASELINE"
echo "  forward          : $FORWARD_STATE"
echo "  rollback         : $ROLLBACK_STATE"
echo "  re-apply         : $REAPPLY_STATE"
echo "  (tablas/policies/roles cap/funciones/esquemas/triggers/cols stella_interactions/grants authenticated en chunks)"
