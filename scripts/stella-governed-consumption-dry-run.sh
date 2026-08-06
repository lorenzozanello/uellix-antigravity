#!/usr/bin/env bash
# scripts/stella-governed-consumption-dry-run.sh
#
# Aplica, INVOCA, ataca, revierte y REAPLICA la cadena
#   stella_0013 -> stella_0014 -> stella_0015 -> stella_0016 -> stella_0017
# en un contenedor DESECHABLE restaurado desde db/baseline/. Deriva los
# conteos; no los asume.
#
# TREN 4.3b — R6-INT y el residual de R1. El arnés se aplica en DOS etapas a
# propósito: con stella_0013…0016 instalados y stella_0017 todavía no, el §6
# REPRODUCE el SOBRECONSUMO contra las funciones reales — una reserva viva, una
# hermana que cobra la última unidad con un INSERT directo, y un `complete` que
# ahora **sí** convierte porque stella_0016 quitó la comprobación de límite de la
# conversión. Resultado medido: Consumed = 2 contra Limit = 1.
#
# POR QUÉ ES UN ARNÉS APARTE Y NO UNA ETAPA DE stella-reserved-quota-dry-run.sh
#   Aquel afirma un VECTOR DE ESTADO de once componentes para la cadena
#   0013→0016 y lo compara entre «aplicado», «revertido» y «reaplicado». Añadir
#   una función y un CHECK desplazaría dos de esas cifras y con ellas la
#   evidencia de gate que el tren 4.3 ya produjo. Un arnés hermano mide lo nuevo
#   sin reescribir lo ya medido — el mismo argumento que aquel hizo frente a
#   stella-ticket-dry-run.sh, un tren antes.
#
# QUÉ HACE QUE ESTO NO SEA UNA INSPECCIÓN DE ESTRUCTURA
#   El bypass se REPRODUCE con llamadas reales antes de cerrarlo, y se reproduce
#   DOS veces: por el nombre `uellix_app` y por el privilegio HEREDADO de
#   `uellix_writer`, que es el que existe de verdad. Sólo después se aplica
#   stella_0017 y se vuelve a ejecutar la misma secuencia, que ahora falla con
#   42501. El recorrido hermano completo se ejerce para las SIETE categorías,
#   con reintentos, operaciones nuevas, abortos, expiración, cruce de periodo y
#   ocho duelos de concurrencia REAL (dos conexiones, no dos transacciones
#   simuladas).
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen montado, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida, pase o
#   falle. db/baseline/** se lee, nunca se escribe.
#
#   bash scripts/stella-governed-consumption-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_governed_consumption_dry_run_$$"
BASE_DIR="db/baseline"

# La cadena, en dos etapas. BASE es el estado que R6-INT reporta; FORWARD es la
# cadena completa. El §6 mide el defecto sobre BASE antes de que FORWARD lo
# cierre — un arnés que sólo midiera el estado final cerraría un hueco que nadie
# vio abierto.
FORWARD_BASE=(stella_0013_grounded_query_quota stella_0014_operation_tickets stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics)
FORWARD=("${FORWARD_BASE[@]}" stella_0017_governed_stella_consumption)
# Orden inverso, y el propio SQL lo impone en los cinco extremos.
ROLLBACKS=(stella_0017_rollback stella_0016_rollback stella_0015_rollback stella_0014_rollback stella_0013_rollback)

USER_A='99999999-9999-9999-9999-999999999981'
USER_B='99999999-9999-9999-9999-999999999982'
# SEGUNDO actor de la MISMA organizacion: la reserva es organizacional y un
# fixture con un actor por organizacion no puede expresar la disputa entre dos.
USER_C='99999999-9999-9999-9999-999999999983'
ORG_A='11111111-1111-1111-1111-111111111181'
ORG_B='11111111-1111-1111-1111-111111111182'
PROJ_A1='22222222-2222-2222-2222-222222222281'
PROJ_A2='22222222-2222-2222-2222-222222222283'
PROJ_B='22222222-2222-2222-2222-222222222282'

H1='1111111111111111111111111111111111111111111111111111111111111111'
H2='2222222222222222222222222222222222222222222222222222222222222222'
H3='3333333333333333333333333333333333333333333333333333333333333333'

# Las SIETE categorias gobernadas, derivadas del inventario real y no de una
# lista de deseos: son exactamente los valores que admite
# `operation_tickets_category_check` y los que valida `issue_operation_ticket`.
CATEGORIES=(advisor validator composer proxy_reviewer evidence_reviewer audit_assistant grounded_query)

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

assert_eq() {
  if [ "$2" = "$3" ]; then printf '  ok   %-58s %s\n' "$1" "$3"
  else printf '  FAIL %-58s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; exit 1; fi
}

# Extrae `RESULT clave=valor` de la salida de psql. Las pruebas vivas emiten sus
# hechos por RAISE NOTICE porque una función que devuelve una tabla dentro de un
# DO block no tiene canal de retorno — y porque un NOTICE sobrevive al ROLLBACK
# que muchas de estas pruebas necesitan.
res() { printf '%s' "$1" | sed -n "s/.*RESULT $2=\\(.*\\)/\\1/p" | tail -1 | tr -d '\r'; }

# El vector de estado que se compara entre "aplicado", "revertido" y
# "reaplicado". Se cuentan OBJETOS, no filas: el ledger es append-only.
#
# Las componentes 12 y 13 son de este tren: el CHECK de identidad gobernada y el
# numero de principales de runtime que conservan escritura sobre el ledger. Sin
# ellas el vector no distingue «stella_0016 aplicado» de «stella_0016 +
# stella_0017 aplicados» en lo unico que importa — quien puede escribir.
state() {
  printf '%s/%s/%s/%s/%s/%s/%s/%s/%s/%s/%s/%s/%s' \
    "$(Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix_cap\\_%'")" \
    "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname IN ('uellix_stella','uellix_stella_ops')")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")" \
    "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='uellix_stella_ops'")" \
    "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='uellix_stella_ops'")" \
    "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='uellix_stella_ops' AND NOT t.tgisinternal")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'uellix\\_check\\_operation%'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND pg_get_function_arguments(p.oid) LIKE '%p\\_expected\\_project\\_id uuid%'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND p.proname IN ('stella_capacity','consume_stella_capacity','settle_reserved_quota')")" \
    "$(Q "SELECT count(*) FROM pg_attribute a WHERE a.attrelid=to_regclass('uellix_stella_ops.operation_tickets') AND a.attname='period_month' AND a.attnum>0 AND NOT a.attisdropped")" \
    "$(Q "SELECT count(*) FROM pg_constraint c WHERE c.conrelid=to_regclass('public.stella_interactions') AND c.conname='stella_interactions_governed_identity_check'")" \
    "$(runtime_writers)"
}

# CUANTOS principales de runtime pueden escribir el ledger. Se pregunta con
# has_table_privilege —que SIGUE la pertenencia de rol— porque el defecto entero
# es que `uellix_app` no tiene nada en `relacl` y escribe igual.
runtime_writers() {
  Q "SELECT count(DISTINCT r.rolname) FROM pg_roles r CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) AS p(priv) WHERE NOT r.rolsuper AND r.rolname <> 'uellix_owner' AND r.rolname <> 'uellix_cap_stella_quota' AND r.rolname NOT LIKE 'pg\\_%' AND has_table_privilege(r.oid, to_regclass('public.stella_interactions'), p.priv)"
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
  [ -f "db/prepared/$f.sql" ] || fail "falta db/prepared/$f.sql"
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql"
done

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

  for r in uellix_cap_stella_ticket uellix_cap_stella_quota; do
    docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
      "DROP ROLE IF EXISTS $r" >/dev/null || fail "no se pudo retirar el rol de clúster $r"
  done

  "${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null 2>&1 || fail "restore de roles falló"
  "${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null 2>&1 || fail "restore de schema falló"
  "${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null 2>&1 || fail "post-restore falló"
}

apply_forward() {
  for f in "$@"; do
    printf '  %-52s ' "$f"
    if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/gcerr_$$; then echo "OK"
    else echo "FAIL"; cat /tmp/gcerr_$$; exit 1; fi
  done
}

# ORG_A arranca con cuota 1: la ÚLTIMA unidad. Es el fixture mínimo que puede
# expresar el sobreconsumo — con dos unidades la hermana y el ticket caben los
# dos y no hay nada que disputar.
seed_fixture() {
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "la siembra falló"
SET ROLE uellix_owner;

INSERT INTO public.users (id, email) VALUES
  ('$USER_A', 'governed-a@example.invalid'),
  ('$USER_B', 'governed-b@example.invalid'),
  ('$USER_C', 'governed-c@example.invalid');

INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
  ('$ORG_A', 'Org Governed A', 'org-governed-a', 1),
  ('$ORG_B', 'Org Governed B', 'org-governed-b', 50);

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('$ORG_A', '$USER_A', 'analyst', 'active'),
  ('$ORG_A', '$USER_C', 'analyst', 'active'),
  ('$ORG_B', '$USER_B', 'analyst', 'active');

INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
  ('$PROJ_A1', '$ORG_A', 'Project A1', '$USER_A'),
  ('$PROJ_A2', '$ORG_A', 'Project A2', '$USER_A'),
  ('$PROJ_B', '$ORG_B', 'Project B', '$USER_B');
SQL
}

# --------------------------------------------------------------------------
say "3. Base postgres vacía desde template0 + restore del baseline"
# --------------------------------------------------------------------------
restore_baseline
BASELINE=$(state)
echo "  baseline: $BASELINE"
assert_eq "esquema uellix_stella_ops ausente" "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_stella_ops'")"

# --------------------------------------------------------------------------
say "4. El orden forward está impuesto por el SQL, no por este script"
# --------------------------------------------------------------------------
if "${PSQL[@]}" -1 -q -f "/stella_0017_governed_stella_consumption.sql" >/dev/null 2>/dev/null; then
  fail "stella_0017 se aplicó SIN su cadena — su guarda de dependencia no obliga"
fi
echo "  ok   stella_0017 sin la cadena aborta, como debe"

# --------------------------------------------------------------------------
say "5. Etapa 1 — la cadena 0013…0016: el estado que R6-INT reporta"
# --------------------------------------------------------------------------
apply_forward "${FORWARD_BASE[@]}"
BASE_STATE=$(state)
echo "  estado con 0013…0016: $BASE_STATE"
seed_fixture

echo "  --- inventario de escritura sobre el ledger, ANTES ---"
for r in uellix_app uellix_writer authenticated anon service_role uellix_auditor uellix_cap_stella_quota uellix_cap_stella_ticket uellix_owner; do
  printf '    %-26s insert=%s update=%s delete=%s truncate=%s\n' "$r" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','INSERT')")" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','UPDATE')")" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','DELETE')")" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','TRUNCATE')")"
done
WRITERS_BEFORE=$(runtime_writers)
echo "  principales de runtime con escritura: $WRITERS_BEFORE"
assert_eq "uellix_app puede INSERT antes"        "t" "$(Q "SELECT has_table_privilege('uellix_app','public.stella_interactions','INSERT')")"
assert_eq "...y no tiene NINGUNA entrada propia" "0" "$(Q "SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r',c.relowner))) a JOIN pg_roles g ON g.oid=a.grantee WHERE c.oid='public.stella_interactions'::regclass AND g.rolname='uellix_app'")"
assert_eq "el titular real es uellix_writer"     "1" "$(Q "SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r',c.relowner))) a JOIN pg_roles g ON g.oid=a.grantee WHERE c.oid='public.stella_interactions'::regclass AND g.rolname='uellix_writer' AND a.privilege_type='INSERT'")"

# --------------------------------------------------------------------------
say "6. REPRODUCCIÓN del sobreconsumo — antes de cerrarlo"
# --------------------------------------------------------------------------
# La secuencia, con cuota restante = 1:
#
#   1. issue + bind          -> el ticket RESERVA la única unidad
#   2. la acción hermana     -> lee el ledger (0 cargos), decide que puede, y
#                               COBRA la unidad con un INSERT directo
#   3. Grounding termina
#   4. complete              -> settle_reserved_quota NO evalúa el límite (es lo
#                               que stella_0016 arregló), así que CONVIERTE.
#
# Resultado: dos unidades vendidas contra un tope de una. Bajo stella_0015 la
# misma secuencia terminaba en `quota_exceeded` y el trabajo se regalaba — malo,
# pero el tope aguantaba. Con la conversión instalada ya no aguanta.
#
# La hermana se reproduce EXACTAMENTE como la escriben las cinco acciones
# TypeScript: `checkStellaQuota` (una lectura de count sin lock) seguida de
# `db.insert(stellaInteractions)` (una escritura sin lock, sin clave de
# idempotencia, sin pasar por ninguna función gobernada).
set +e
R_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
CREATE TEMP TABLE gc_ticket(ticket_id char(64));

DO \$r\$
DECLARE t char(64); r record; v_used int; v_quota int;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO gc_ticket VALUES (t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT bind=%', r.outcome;

  SELECT o.stella_monthly_quota INTO v_quota FROM public.organizations o WHERE o.id = '$ORG_A';
  SELECT count(*)::int INTO v_used FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A'
     AND si.created_at >= date_trunc('month', timezone('UTC', now()));
  RAISE NOTICE 'RESULT hermana_ve_usado=%', v_used;
  RAISE NOTICE 'RESULT hermana_cree_que_puede=%', (v_used < v_quota)::text;

  INSERT INTO public.stella_interactions
    (organization_id, project_id, created_by, stella_role, pipeline_step,
     context_hash, response_json, model_used)
  VALUES ('$ORG_A', '$PROJ_A2', '$USER_A', 'advisor', 'advisor',
          repeat('a', 64), '{"kind":"sibling"}'::jsonb, 'test-model');
  RAISE NOTICE 'RESULT hermana_cobro=true';

  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT complete=%', r.outcome;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT complete=EXCEPTION:%', SQLSTATE;
  END;
END
\$r\$;

RESET ROLE;
DO \$m\$
DECLARE c int; rsv int; lim int;
BEGIN
  SELECT count(*)::int INTO c FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A'
     AND si.created_at >= date_trunc('month', timezone('UTC', now()));
  SELECT count(*)::int INTO rsv FROM uellix_stella_ops.operation_tickets x
   WHERE x.organization_id = '$ORG_A' AND x.status = 'bound'
     AND x.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());
  SELECT o.stella_monthly_quota INTO lim FROM public.organizations o WHERE o.id = '$ORG_A';
  RAISE NOTICE 'RESULT consumed=%', c;
  RAISE NOTICE 'RESULT live_reserved=%', rsv;
  RAISE NOTICE 'RESULT limit=%', lim;
  RAISE NOTICE 'RESULT invariante_violada=%', ((c + rsv) > lim)::text;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$R_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'

assert_eq "la reserva grounded se toma"              "bound"     "$(res "$R_OUT" bind)"
assert_eq "la hermana ve 0 cargos"                   "0"         "$(res "$R_OUT" hermana_ve_usado)"
assert_eq "la hermana IGNORA la reserva y procede"   "true"      "$(res "$R_OUT" hermana_cree_que_puede)"
assert_eq "complete CONVIERTE igualmente"            "completed" "$(res "$R_OUT" complete)"
assert_eq "unidades efectivamente vendidas"          "2"         "$(res "$R_OUT" consumed)"
assert_eq "tope de la organización"                  "1"         "$(res "$R_OUT" limit)"
assert_eq "Consumed + LiveReserved > Limit"          "true"      "$(res "$R_OUT" invariante_violada)"

echo
echo "  SOBRECONSUMO REPRODUCIDO: la aritmética de reservas es exacta y la"
echo "  superficie de escritura del ledger no lo es. Dos unidades vendidas, una"
echo "  comprada."

# --------------------------------------------------------------------------
say "6b. REPRODUCCIÓN por el privilegio HEREDADO, no por el nombre"
# --------------------------------------------------------------------------
# Un REVOKE dirigido a `uellix_app` sería un no-op silencioso: el privilegio que
# se ejerce aquí es el INSERT de `uellix_writer`, heredado por
# `GRANT uellix_writer TO uellix_app WITH INHERIT TRUE`.
set +e
RH_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$w\$
BEGIN
  INSERT INTO public.stella_interactions
    (organization_id, project_id, created_by, stella_role, pipeline_step,
     context_hash, response_json, model_used)
  VALUES ('$ORG_A', '$PROJ_A1', '$USER_A', 'validator', 'validator',
          repeat('b', 64), '{"kind":"sibling"}'::jsonb, 'test-model');
  RAISE NOTICE 'RESULT heredado=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT heredado=%', SQLSTATE;
END
\$w\$;
ROLLBACK;
SQL
)
set -e
echo "$RH_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "el privilegio ejercido es el heredado" "ok" "$(res "$RH_OUT" heredado)"

# --------------------------------------------------------------------------
say "7. Etapa 2 — stella_0017 cierra la escritura directa"
# --------------------------------------------------------------------------
apply_forward stella_0017_governed_stella_consumption
APPLIED=$(state)
echo "  estado con 0013…0017: $APPLIED"
[ "$APPLIED" != "$BASE_STATE" ] || fail "el vector de estado no cambió al aplicar stella_0017"

echo "  --- inventario de escritura sobre el ledger, DESPUÉS ---"
for r in uellix_app uellix_writer authenticated anon service_role uellix_auditor uellix_cap_stella_quota uellix_cap_stella_ticket uellix_owner; do
  printf '    %-26s insert=%s update=%s delete=%s truncate=%s\n' "$r" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','INSERT')")" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','UPDATE')")" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','DELETE')")" \
    "$(Q "SELECT has_table_privilege('$r','public.stella_interactions','TRUNCATE')")"
done
WRITERS_AFTER=$(runtime_writers)
echo "  principales de runtime con escritura: $WRITERS_BEFORE -> $WRITERS_AFTER"
assert_eq "cero principales de runtime escriben"  "0" "$WRITERS_AFTER"
assert_eq "uellix_cap_stella_quota sigue pudiendo" "t" "$(Q "SELECT has_table_privilege('uellix_cap_stella_quota','public.stella_interactions','INSERT')")"
assert_eq "...y sigue sin poder borrar"            "f" "$(Q "SELECT has_table_privilege('uellix_cap_stella_quota','public.stella_interactions','DELETE')")"
assert_eq "el CHECK de identidad existe"           "1" "$(Q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.stella_interactions'::regclass AND conname='stella_interactions_governed_identity_check'")"
assert_eq "...y es NOT VALID"                      "f" "$(Q "SELECT convalidated FROM pg_constraint WHERE conrelid='public.stella_interactions'::regclass AND conname='stella_interactions_governed_identity_check'")"
assert_eq "RLS sigue encendida (COPY FROM cerrado)" "t" "$(Q "SELECT relrowsecurity FROM pg_class WHERE oid='public.stella_interactions'::regclass")"
assert_eq "uellix_stella_ops publica 7 funciones"  "7" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"

# --------------------------------------------------------------------------
say "8. La misma secuencia, ahora"
# --------------------------------------------------------------------------
set +e
C_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$r\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT bind=%', r.outcome;
  BEGIN
    INSERT INTO public.stella_interactions
      (organization_id, project_id, created_by, stella_role, pipeline_step,
       context_hash, response_json, model_used)
    VALUES ('$ORG_A', '$PROJ_A2', '$USER_A', 'advisor', 'advisor',
            repeat('a', 64), '{"kind":"sibling"}'::jsonb, 'test-model');
    RAISE NOTICE 'RESULT hermana_directa=ok';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT hermana_directa=%', SQLSTATE;
  END;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT complete=%', r.outcome;
END
\$r\$;
RESET ROLE;
DO \$m\$
DECLARE c int; lim int;
BEGIN
  SELECT count(*)::int INTO c FROM public.stella_interactions si WHERE si.organization_id='$ORG_A';
  SELECT o.stella_monthly_quota INTO lim FROM public.organizations o WHERE o.id='$ORG_A';
  RAISE NOTICE 'RESULT consumed=%', c;
  RAISE NOTICE 'RESULT limit=%', lim;
  RAISE NOTICE 'RESULT invariante=%', (c <= lim)::text;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$C_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "la escritura directa es refusada (42501)" "42501"     "$(res "$C_OUT" hermana_directa)"
assert_eq "la reserva grounded se convierte"         "completed" "$(res "$C_OUT" complete)"
assert_eq "unidades vendidas"                        "1"         "$(res "$C_OUT" consumed)"
assert_eq "Consumed + LiveReserved <= Limit"         "true"      "$(res "$C_OUT" invariante)"

# --------------------------------------------------------------------------
say "9. Las SIETE categorías por la ruta gobernada"
# --------------------------------------------------------------------------
# ORG_B tiene cuota 50, así que las siete caben. Se recorre issue -> bind ->
# complete con carga real y se comprueba que la fila del ledger conserva lo que
# `db.insert` escribía: rol, paso de pipeline, modelo, tokens y cuerpo.
for cat in "${CATEGORIES[@]}"; do
  set +e
  OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
DO \$c\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', '$cat');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_B', '$H1');
  RAISE NOTICE 'RESULT bind=%', r.outcome;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    t, '$PROJ_B', '$H1', 'stakeholders', 'gemini-2.0-flash', 4242, '{"findings":[]}'::jsonb);
  RAISE NOTICE 'RESULT complete=%', r.outcome;
END
\$c\$;
RESET ROLE;
DO \$m\$
DECLARE s record;
BEGIN
  SELECT stella_role, pipeline_step, model_used, tokens_used, context_hash INTO s
    FROM public.stella_interactions WHERE organization_id='$ORG_B' AND stella_role='$cat';
  RAISE NOTICE 'RESULT rol=%', s.stella_role;
  RAISE NOTICE 'RESULT step=%', s.pipeline_step;
  RAISE NOTICE 'RESULT tokens=%', s.tokens_used;
  RAISE NOTICE 'RESULT ctx=%', s.context_hash;
END
\$m\$;
COMMIT;
SQL
)
  set -e
  assert_eq "$cat: bind"                "bound"          "$(res "$OUT" bind)"
  assert_eq "$cat: complete"            "completed"      "$(res "$OUT" complete)"
  assert_eq "$cat: rol en el ledger"    "$cat"           "$(res "$OUT" rol)"
  assert_eq "$cat: paso de pipeline"    "stakeholders"   "$(res "$OUT" step)"
  assert_eq "$cat: tokens preservados"  "4242"           "$(res "$OUT" tokens)"
  assert_eq "$cat: context_hash = digest bound" "$H1"    "$(res "$OUT" ctx)"
done
assert_eq "siete unidades cobradas en ORG_B" "7" "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B'")"
assert_eq "las siete llevan identidad"       "7" "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B' AND idempotency_key IS NOT NULL")"
assert_eq "siete claves distintas"           "7" "$(Q "SELECT count(DISTINCT idempotency_key) FROM public.stella_interactions WHERE organization_id='$ORG_B'")"

# --------------------------------------------------------------------------
say "10. La fila grounded no cambió: NULL de carga reproduce stella_0016"
# --------------------------------------------------------------------------
set +e
G_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
DO \$g\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_B', '$H2');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_B', '$H2');
  RAISE NOTICE 'RESULT complete=%', r.outcome;
END
\$g\$;
RESET ROLE;
DO \$m\$
DECLARE s record;
BEGIN
  SELECT pipeline_step, model_used, tokens_used, response_json::text AS body, context_hash INTO s
    FROM public.stella_interactions
   WHERE organization_id='$ORG_B' AND stella_role='grounded_query'
   ORDER BY created_at DESC LIMIT 1;
  RAISE NOTICE 'RESULT step=%', s.pipeline_step;
  RAISE NOTICE 'RESULT modelo=%', s.model_used;
  RAISE NOTICE 'RESULT tokens=%', COALESCE(s.tokens_used::text, 'NULL');
  RAISE NOTICE 'RESULT body=%', s.body;
  RAISE NOTICE 'RESULT ctx_derivado=%', (s.context_hash <> '$H2')::text;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$G_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "grounded completa"                "completed"        "$(res "$G_OUT" complete)"
assert_eq "grounded: paso = categoría"       "grounded_query"   "$(res "$G_OUT" step)"
assert_eq "grounded: modelo literal"         "not-applicable"   "$(res "$G_OUT" modelo)"
assert_eq "grounded: sin tokens"             "NULL"             "$(res "$G_OUT" tokens)"
assert_eq "grounded: cuerpo literal fijo"    '{"kind": "quota_consumption", "version": 1}' "$(res "$G_OUT" body)"
assert_eq "grounded: digest derivado, no el bound" "true"       "$(res "$G_OUT" ctx_derivado)"

# --------------------------------------------------------------------------
say "11. Reintento frente a operación nueva"
# --------------------------------------------------------------------------
set +e
I_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
DO \$i\$
DECLARE t1 char(64); t2 char(64); r record;
BEGIN
  t1 := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_B', '$H3');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    t1, '$PROJ_B', '$H3', 'outcomes', 'gemini-2.0-flash', 100, '{"v":1}'::jsonb);
  RAISE NOTICE 'RESULT primera=%', r.outcome;

  -- REINTENTO: el MISMO ticket, incluso con una carga distinta — que es la
  -- forma que toma volver a ejecutar un modelo no determinista.
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    t1, '$PROJ_B', '$H3', 'outcomes', 'gemini-2.0-flash', 999, '{"v":2}'::jsonb);
  RAISE NOTICE 'RESULT reintento=%', r.outcome;

  -- OPERACIÓN NUEVA con EXACTAMENTE el mismo contenido: ticket nuevo, cobro
  -- nuevo. Si la identidad se derivara de la solicitud, esta sería gratis.
  t2 := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t2, '$PROJ_B', '$H3');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    t2, '$PROJ_B', '$H3', 'outcomes', 'gemini-2.0-flash', 100, '{"v":1}'::jsonb);
  RAISE NOTICE 'RESULT operacion_nueva=%', r.outcome;

  RAISE NOTICE 'RESULT tickets_distintos=%', (t1 <> t2)::text;
END
\$i\$;
RESET ROLE;
DO \$m\$
DECLARE c int;
BEGIN
  SELECT count(*)::int INTO c FROM public.stella_interactions
   WHERE organization_id='$ORG_B' AND stella_role='advisor';
  RAISE NOTICE 'RESULT filas_advisor=%', c;
  SELECT count(*)::int INTO c FROM public.stella_interactions
   WHERE organization_id='$ORG_B' AND stella_role='advisor' AND tokens_used = 999;
  RAISE NOTICE 'RESULT reintento_sobrescribio=%', c;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$I_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "primera ejecución cobra"                   "completed" "$(res "$I_OUT" primera)"
assert_eq "el reintento NO cobra"                     "replayed"  "$(res "$I_OUT" reintento)"
assert_eq "la operación nueva SÍ cobra"               "completed" "$(res "$I_OUT" operacion_nueva)"
assert_eq "y usa un ticket distinto"                  "true"      "$(res "$I_OUT" tickets_distintos)"
# 1 de §9 + 2 de aquí
assert_eq "tres filas advisor en total"               "3"         "$(res "$I_OUT" filas_advisor)"
assert_eq "el reintento no sobrescribió el ledger"    "0"         "$(res "$I_OUT" reintento_sobrescribio)"

# --------------------------------------------------------------------------
say "12. Semántica de reserva entre hermanas"
# --------------------------------------------------------------------------
# ORG_A tiene cuota 1 y cero cargos. Una reserva hermana viva tiene que impedir
# que otra hermana —y que un consumidor sin ticket— tome la misma unidad.
set +e
S_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
CREATE TEMP TABLE gc_s(who text, ticket_id char(64));
GRANT ALL ON gc_s TO PUBLIC;

SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'advisor');
  INSERT INTO gc_s VALUES ('a', t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT hermana_a=%', r.outcome;
END
\$a\$;

-- OTRO actor de la MISMA organización: la reserva es organizacional, no del actor.
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_C"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A2', 'validator');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A2', '$H2');
  RAISE NOTICE 'RESULT hermana_c=%', r.outcome;

  -- ...y el consumidor SIN ticket tampoco puede robarla.
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A2', 'composer', repeat('c', 64));
  RAISE NOTICE 'RESULT sin_ticket=%', r.outcome;
END
\$b\$;

-- ABORT libera.
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$c\$
DECLARE t char(64); r record; s text;
BEGIN
  SELECT ticket_id INTO t FROM gc_s WHERE who = 'a';
  s := uellix_stella_ops.abort_operation_ticket(t, '$PROJ_A1', 'execution_failed');
  RAISE NOTICE 'RESULT abort=%', s;
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'composer', repeat('d', 64));
  RAISE NOTICE 'RESULT tras_abort=%', r.outcome;
END
\$c\$;
ROLLBACK;
SQL
)
set -e
echo "$S_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "la hermana A reserva la única unidad"    "bound"          "$(res "$S_OUT" hermana_a)"
assert_eq "la hermana C (otro actor) es refusada"   "quota_exceeded" "$(res "$S_OUT" hermana_c)"
assert_eq "el consumidor sin ticket es refusado"    "quota_exceeded" "$(res "$S_OUT" sin_ticket)"
assert_eq "abort libera la reserva"                 "aborted"        "$(res "$S_OUT" abort)"
assert_eq "...y la unidad vuelve a estar libre"     "consumed"       "$(res "$S_OUT" tras_abort)"

# --------------------------------------------------------------------------
say "13. Expiración lógica, sin cron"
# --------------------------------------------------------------------------
# `expires_at > now()` está DENTRO del predicado de liveness, así que una reserva
# huérfana deja de contar en el instante en que expira, llame o no nadie a
# expire_operation_tickets. Se envejece la fila como owner —el trigger prohíbe
# tocar expires_at, así que se mide sobre una reserva creada y luego caducada por
# el reloj del propio motor mediante una fila sembrada.
set +e
E_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SET LOCAL ROLE uellix_owner;
-- Una reserva ya caducada, sembrada directamente: el trigger de transicion
-- prohibe declarar un ticket como bound de un salto, asi que se inserta issued y
-- se transiciona, ambas cosas que el trigger si permite.
INSERT INTO uellix_stella_ops.operation_tickets
  (ticket_id, organization_id, project_id, actor_id, category, status, charge_nonce,
   issued_at, expires_at)
VALUES (repeat('e', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'advisor', 'issued', repeat('f', 64),
        timezone('UTC', now()) - interval '20 minutes',
        timezone('UTC', now()) - interval '5 minutes');
UPDATE uellix_stella_ops.operation_tickets
   SET status = 'bound', query_hash = '$H1', bound_at = timezone('UTC', now()) - interval '19 minutes'
 WHERE ticket_id = repeat('e', 64);

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$e\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT reservadas=%', r.reserved;
  RAISE NOTICE 'RESULT disponibles=%', r.available;
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'composer', repeat('9', 64));
  RAISE NOTICE 'RESULT tras_expiracion=%', r.outcome;
END
\$e\$;
ROLLBACK;
SQL
)
set -e
echo "$E_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "la reserva caducada no cuenta"      "0"        "$(res "$E_OUT" reservadas)"
assert_eq "la unidad está disponible"          "1"        "$(res "$E_OUT" disponibles)"
assert_eq "y puede cobrarse"                   "consumed" "$(res "$E_OUT" tras_expiracion)"

# --------------------------------------------------------------------------
say "14. Cruce de periodo"
# --------------------------------------------------------------------------
# La regla publicada en stella_0016: una reserva VIVA se cuenta en el periodo en
# el que se hace la pregunta, y `Reserved` no filtra por mes a propósito. Se
# comprueba sobre una reserva tomada el último día del mes anterior que sigue
# viva ahora, y se cobra una hermana en el mes nuevo.
set +e
P_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SET LOCAL ROLE uellix_owner;
UPDATE public.organizations SET stella_monthly_quota = 2 WHERE id = '$ORG_A';
-- Un cargo del MES ANTERIOR: no cuenta contra el mes en curso.
INSERT INTO public.stella_interactions
  (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash,
   response_json, model_used, idempotency_key, created_at)
VALUES ('$ORG_A', '$PROJ_A1', '$USER_A', 'advisor', 'advisor', repeat('7', 64),
        '{"kind":"quota_consumption","version":1}'::jsonb, 'not-applicable', repeat('7', 64),
        date_trunc('month', timezone('UTC', now())) - interval '2 days');

-- La reserva del mes ANTERIOR que sigue VIVA ahora. Se siembra como owner y se
-- transiciona issued -> bound en un solo paso, que es la unica transicion que el
-- trigger admite: un UPDATE de bound a bound se rechaza con U0109 para todos los
-- roles, incluido el owner, asi que retrodatar bound_at despues del hecho no es
-- posible ni siquiera aqui.
--
-- issued_at y expires_at quedan en la ventana de 15 minutos que exige
-- operation_tickets_expiry_window_check; bound_at NO esta atado a ellos, y es de
-- bound_at de donde period_month se deriva. Eso es exactamente la situacion real:
-- una reserva tomada a las 23:58 del ultimo dia sigue viva a las 00:03 del
-- siguiente.
INSERT INTO uellix_stella_ops.operation_tickets
  (ticket_id, organization_id, project_id, actor_id, category, status, charge_nonce,
   issued_at, expires_at)
VALUES (repeat('c', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'advisor', 'issued', repeat('d', 64),
        timezone('UTC', now()) - interval '1 minute',
        timezone('UTC', now()) + interval '13 minutes');
UPDATE uellix_stella_ops.operation_tickets
   SET status = 'bound', query_hash = '$H1',
       bound_at = date_trunc('month', timezone('UTC', now())) - interval '2 minutes'
 WHERE ticket_id = repeat('c', 64);

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$p1\$
DECLARE r record;
BEGIN
  RAISE NOTICE 'RESULT bind=bound';
  SELECT * INTO r FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT consumido_mes_actual=%', r.consumed;
  RAISE NOTICE 'RESULT reservado=%', r.reserved;
  RAISE NOTICE 'RESULT disponible_antes=%', r.available;
END
\$p1\$;

DO \$p2\$
DECLARE t char(64) := repeat('c', 64); r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT reservado_mes_nuevo=%', r.reserved;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    t, '$PROJ_A1', '$H1', 'outcomes', 'gemini-2.0-flash', 7, '{"x":1}'::jsonb);
  RAISE NOTICE 'RESULT complete=%', r.outcome;
  SELECT * INTO r FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT consumido_despues=%', r.consumed;
  RAISE NOTICE 'RESULT disponible_despues=%', r.available;
END
\$p2\$;

RESET ROLE;
DO \$m\$
DECLARE s record;
BEGIN
  SELECT period_month, date_trunc('month', timezone('UTC', now())) AS mes_actual INTO s
    FROM uellix_stella_ops.operation_tickets WHERE ticket_id = repeat('c', 64);
  RAISE NOTICE 'RESULT periodo_reserva_es_anterior=%', (s.period_month < s.mes_actual)::text;
  RAISE NOTICE 'RESULT cargo_en_mes_actual=%', (
    SELECT count(*)::int FROM public.stella_interactions si
     WHERE si.organization_id='$ORG_A' AND si.tokens_used = 7
       AND si.created_at >= date_trunc('month', timezone('UTC', now())));
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$P_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "el cargo del mes anterior no cuenta"          "0"         "$(res "$P_OUT" consumido_mes_actual)"
assert_eq "la reserva se toma"                           "bound"     "$(res "$P_OUT" bind)"
assert_eq "disponible antes = 2 - 0 - 1"                 "1"         "$(res "$P_OUT" disponible_antes)"
assert_eq "la reserva del mes anterior sigue contando"   "1"         "$(res "$P_OUT" reservado_mes_nuevo)"
assert_eq "su period_month es el mes ANTERIOR"           "true"      "$(res "$P_OUT" periodo_reserva_es_anterior)"
assert_eq "complete convierte en el mes nuevo"           "completed" "$(res "$P_OUT" complete)"
assert_eq "el cargo se atribuye al mes ACTUAL"           "1"         "$(res "$P_OUT" cargo_en_mes_actual)"
assert_eq "consumido después = 1"                        "1"         "$(res "$P_OUT" consumido_despues)"
assert_eq "disponible después = 2 - 1 - 0"               "1"         "$(res "$P_OUT" disponible_despues)"

# --------------------------------------------------------------------------
say "15. Ataques en vivo"
# --------------------------------------------------------------------------
attack() {
  local label="$1" expected="$2" sql="$3"
  local out
  set +e
  out=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
BEGIN;
$sql
ROLLBACK;
SQL
)
  set -e
  assert_eq "$label" "$expected" "$(res "$out" x)"
}

attack "INSERT directo como uellix_app" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$ BEGIN
  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
  VALUES ('$ORG_A','$PROJ_A1','$USER_A','advisor','advisor', repeat('a',64), '{}'::jsonb, 'm', repeat('1',64));
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "INSERT como authenticated" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE authenticated;
DO \$a\$ BEGIN
  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
  VALUES ('$ORG_A','$PROJ_A1','$USER_A','advisor','advisor', repeat('a',64), '{}'::jsonb, 'm', repeat('2',64));
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "SET ROLE uellix_writer explícito" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$ BEGIN
  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
  VALUES ('$ORG_A','$PROJ_A1','$USER_A','validator','validator', repeat('a',64), '{}'::jsonb, 'm', repeat('3',64));
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "UPDATE del ledger como uellix_app" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$ BEGIN
  UPDATE public.stella_interactions SET tokens_used = 0 WHERE organization_id='$ORG_B';
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "DELETE del ledger como uellix_app" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$ BEGIN
  DELETE FROM public.stella_interactions WHERE organization_id='$ORG_B';
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "TRUNCATE del ledger como uellix_app" "42501" "
SET LOCAL ROLE uellix_app;
DO \$a\$ BEGIN
  TRUNCATE public.stella_interactions;
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "el OWNER tampoco puede filar sin identidad" "23514" "
SET LOCAL ROLE uellix_owner;
DO \$a\$ BEGIN
  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used)
  VALUES ('$ORG_A','$PROJ_A1','$USER_A','advisor','advisor', repeat('a',64), '{}'::jsonb, 'm');
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "session_replication_role=replica no lo silencia" "23514" "
SET LOCAL session_replication_role = replica;
SET LOCAL ROLE uellix_owner;
DO \$a\$ BEGIN
  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used)
  VALUES ('$ORG_A','$PROJ_A1','$USER_A','advisor','advisor', repeat('a',64), '{}'::jsonb, 'm');
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "ticket de OTRA categoría" "U0111" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_B', '$H1');
  SET LOCAL ROLE uellix_cap_stella_ticket;
  SELECT * INTO r FROM uellix_stella.settle_reserved_quota(
    '$ORG_B', '$PROJ_B', 'composer', repeat('5',64), t, NULL, NULL, NULL, NULL, NULL);
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "ticket de OTRO proyecto" "U0110" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    t, '$PROJ_A2', '$H1', 'outcomes', 'm', 1, '{}'::jsonb);
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "ticket de OTRO actor" "U0102" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
CREATE TEMP TABLE gc_atk(t char(64));
GRANT ALL ON gc_atk TO PUBLIC;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'advisor');
  INSERT INTO gc_atk VALUES (t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
END \$a\$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_C\"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    (SELECT t FROM gc_atk), '$PROJ_A1', '$H1', 'outcomes', 'm', 1, '{}'::jsonb);
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$b\$;"

attack "ticket de OTRA organización" "U0102" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE r record;
BEGIN
  PERFORM uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'advisor');
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "el runtime NO puede ejecutar la conversión (10 args)" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.settle_reserved_quota(
    '$ORG_A', '$PROJ_A1', 'advisor', repeat('6',64), repeat('e',64), NULL, NULL, NULL, NULL, NULL);
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

attack "el runtime NO puede leer la tabla de tickets" "42501" "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM uellix_stella_ops.operation_tickets;
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

# COPY necesita el MISMO privilegio INSERT, asi que cae con el. El 42501 es la
# medicion de eso. La segunda barrera —PostgreSQL rechaza COPY FROM sobre una
# relacion con RLS activo, 0A000— se afirma estructuralmente en el §7 sobre
# `relrowsecurity`, porque un rol sin INSERT nunca llega a verla.
attack "COPY FROM sobre el ledger" "42501" "
SET LOCAL ROLE uellix_app;
DO \$a\$
BEGIN
  EXECUTE 'COPY public.stella_interactions FROM PROGRAM ''echo''';
  RAISE NOTICE 'RESULT x=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT x=%', SQLSTATE; END \$a\$;"

echo "  --- superficie de EXECUTE ---"
assert_eq "PUBLIC no ejecuta nada en uellix_stella"      "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a WHERE n.nspname='uellix_stella' AND a.grantee=0")"
assert_eq "PUBLIC no ejecuta nada en uellix_stella_ops"  "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a WHERE n.nspname='uellix_stella_ops' AND a.grantee=0")"
assert_eq "ninguna firma sin proyecto sobrevive"         "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket','abort_operation_ticket','inspect_operation_ticket') AND pg_get_function_arguments(p.oid) NOT LIKE '%p\\_expected\\_project\\_id uuid%'")"

# --------------------------------------------------------------------------
say "16. Concurrencia real — dos conexiones"
# --------------------------------------------------------------------------
# La espera MEDIDA es la evidencia de serialización: si las dos transacciones no
# se excluyeran, la segunda no esperaría. `pg_stat_database.deadlocks` se lee al
# final y tiene que ser 0 — el orden de locks es uno solo en todos los caminos.
DEADLOCKS_BEFORE=$(Q "SELECT deadlocks FROM pg_stat_database WHERE datname='postgres'")

duel() {
  local label="$1" a_sql="$2" b_sql="$3" expect_a="$4" expect_b="$5"
  local fa fb outa outb
  fa=$(mktemp); fb=$(mktemp)
  set +e
  ( docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL >"$fa" 2>&1
$a_sql
SQL
  ) &
  local pid_a=$!
  sleep 1
  ( docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL >"$fb" 2>&1
$b_sql
SQL
  ) &
  local pid_b=$!
  wait $pid_a; wait $pid_b
  set -e
  outa=$(cat "$fa"); outb=$(cat "$fb"); rm -f "$fa" "$fb"
  assert_eq "$label (A)" "$expect_a" "$(res "$outa" x)"
  assert_eq "$label (B)" "$expect_b" "$(res "$outb" x)"
}

# Antes de cada duelo ORG_A queda con EXACTAMENTE una unidad libre. El tope se
# recalcula a partir de los cargos que ya existen en vez de fijarse en 1: el
# ledger es append-only y los duelos anteriores ya cobraron, así que un tope
# constante dejaría cero unidades libres a partir del segundo duelo y todos
# medirían «sin cuota» en vez de «disputa».
#
# Las reservas vivas sí se retiran — son tickets, no cargos, y un ticket sin
# liquidar de un duelo anterior falsearía el siguiente.
reset_org_a() {
  docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c \
    "SET ROLE uellix_owner; DELETE FROM uellix_stella_ops.operation_tickets WHERE organization_id='$ORG_A' AND status <> 'completed'" >/dev/null
  docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c \
    "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 1 + (SELECT count(*) FROM public.stella_interactions si WHERE si.organization_id='$ORG_A' AND si.created_at >= date_trunc('month', timezone('UTC', now()))) WHERE id='$ORG_A'" >/dev/null
}

# 1. Dos hermanas por la última unidad.
reset_org_a
duel "dos hermanas por la última unidad" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT x=%', r.outcome;
  PERFORM pg_sleep(3);
END \$a\$;
COMMIT;" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_C\"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A2', 'validator');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A2', '$H2');
  RAISE NOTICE 'RESULT x=%', r.outcome;
END \$b\$;
COMMIT;" "bound" "quota_exceeded"

# 2. Reserva grounded contra hermana sin ticket.
reset_org_a
duel "reserva grounded vs hermana sin ticket" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT x=%', r.outcome;
  PERFORM pg_sleep(3);
END \$a\$;
COMMIT;" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_C\"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A2', 'advisor', repeat('b', 64));
  RAISE NOTICE 'RESULT x=%', r.outcome;
END \$b\$;
COMMIT;" "bound" "quota_exceeded"

# 3. Dos consumidores sin ticket, dos actores.
reset_org_a
duel "dos consumidores sin ticket" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'advisor', repeat('1', 64));
  RAISE NOTICE 'RESULT x=%', r.outcome;
  PERFORM pg_sleep(3);
END \$a\$;
COMMIT;" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_C\"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A2', 'validator', repeat('2', 64));
  RAISE NOTICE 'RESULT x=%', r.outcome;
END \$b\$;
COMMIT;" "consumed" "quota_exceeded"

# 4. Reintento hermano concurrente sobre el MISMO ticket: uno cobra, el otro
#    replica. Nunca dos unidades.
reset_org_a
TICKET_D4=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET ROLE uellix_app;
SELECT uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'advisor');" | tail -1 | tr -d '[:space:]')
[[ "$TICKET_D4" =~ ^[0-9a-f]{64}$ ]] || fail "duelo 4: ticket con forma inesperada '$TICKET_D4'"
BIND_D4=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET ROLE uellix_app;
SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TICKET_D4', '$PROJ_A1', '$H1');" | tail -1 | tr -d '[:space:]')
assert_eq "duelo 4: la reserva previa se toma" "bound" "$BIND_D4"
duel "reintento hermano concurrente (mismo ticket)" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    '$TICKET_D4', '$PROJ_A1', '$H1', 'outcomes', 'm', 5, '{}'::jsonb);
  RAISE NOTICE 'RESULT x=%', r.outcome;
  PERFORM pg_sleep(3);
END \$a\$;
COMMIT;" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(
    '$TICKET_D4', '$PROJ_A1', '$H1', 'outcomes', 'm', 5, '{}'::jsonb);
  RAISE NOTICE 'RESULT x=%', r.outcome;
END \$b\$;
COMMIT;" "completed" "replayed"
assert_eq "el reintento concurrente cobró UNA vez" "1" "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_A' AND tokens_used = 5")"

# 5. Abort concurrente contra hermana.
reset_org_a
TICKET_D5=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET ROLE uellix_app;
SELECT uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'composer');" | tail -1 | tr -d '[:space:]')
[[ "$TICKET_D5" =~ ^[0-9a-f]{64}$ ]] || fail "duelo 5: ticket con forma inesperada '$TICKET_D5'"
BIND_D5=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c "
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET ROLE uellix_app;
SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TICKET_D5', '$PROJ_A1', '$H1');" | tail -1 | tr -d '[:space:]')
assert_eq "duelo 5: la reserva previa se toma" "bound" "$BIND_D5"
duel "abort vs hermana esperando la unidad" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE s text;
BEGIN
  s := uellix_stella_ops.abort_operation_ticket('$TICKET_D5', '$PROJ_A1', 'execution_failed');
  RAISE NOTICE 'RESULT x=%', s;
  PERFORM pg_sleep(3);
END \$a\$;
COMMIT;" "
BEGIN;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_C\"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE r record;
BEGIN
  PERFORM pg_sleep(4);
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A2', 'advisor', repeat('4', 64));
  RAISE NOTICE 'RESULT x=%', r.outcome;
END \$b\$;
COMMIT;" "aborted" "consumed"

DEADLOCKS_AFTER=$(Q "SELECT deadlocks FROM pg_stat_database WHERE datname='postgres'")
assert_eq "sin deadlocks en toda la concurrencia" "$DEADLOCKS_BEFORE" "$DEADLOCKS_AFTER"

FINAL_CONSUMED=$(Q "SELECT count(*) FROM public.stella_interactions si WHERE si.organization_id='$ORG_A' AND si.created_at >= date_trunc('month', timezone('UTC', now()))")
FINAL_RESERVED=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets t WHERE t.organization_id='$ORG_A' AND t.status='bound' AND t.expires_at > timezone('UTC', now())")
FINAL_LIMIT=$(Q "SELECT stella_monthly_quota FROM public.organizations WHERE id='$ORG_A'")
echo "  ORG_A: Consumed=$FINAL_CONSUMED LiveReserved=$FINAL_RESERVED Limit=$FINAL_LIMIT"
assert_eq "Consumed + LiveReserved <= Limit" "t" "$(Q "SELECT ($FINAL_CONSUMED + $FINAL_RESERVED) <= $FINAL_LIMIT")"

# --------------------------------------------------------------------------
say "17. Reaplicación idéntica del paquete"
# --------------------------------------------------------------------------
apply_forward stella_0017_governed_stella_consumption
REAPPLIED=$(state)
assert_eq "el vector de estado converge" "$APPLIED" "$REAPPLIED"

say "17b. stella_0013 sigue siendo reaplicable; 0015 y 0016 no"
if "${PSQL[@]}" -1 -q -f "/stella_0013_grounded_query_quota.sql" >/dev/null 2>/dev/null; then
  echo "  ok   stella_0013 sigue reaplicable"
else
  fail "stella_0013 dejó de ser reaplicable — este paquete no debía moverlo"
fi
for p in stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics; do
  if "${PSQL[@]}" -1 -q -f "/$p.sql" >/dev/null 2>/dev/null; then
    fail "$p se reaplicó sobre stella_0017 — la aserción de conteo no está sujetando"
  fi
  echo "  ok   $p aborta (fail-closed)"
done
assert_eq "el estado no se movió tras los intentos" "$APPLIED" "$(state)"

# --------------------------------------------------------------------------
say "18. Rollback sobre una base LIQUIDADA"
# --------------------------------------------------------------------------
CHARGES_BEFORE=$(Q "SELECT count(*) FROM public.stella_interactions")
TICKETS_BEFORE=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets")
echo "  cargos=$CHARGES_BEFORE tickets=$TICKETS_BEFORE"
printf '  %-52s ' "stella_0017_rollback"
if "${PSQL[@]}" -1 -q -f "/stella_0017_rollback.sql" >/dev/null 2>/tmp/gcrb_$$; then echo "OK"
else echo "FAIL"; cat /tmp/gcrb_$$; exit 1; fi

assert_eq "ningún cargo se borró"                    "$CHARGES_BEFORE" "$(Q "SELECT count(*) FROM public.stella_interactions")"
assert_eq "ningún ticket se borró"                   "$TICKETS_BEFORE" "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets")"
assert_eq "el verbo hermano desapareció"             "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='complete_operation_ticket' AND pg_get_function_arguments(p.oid) LIKE '%p_response_json%'")"
assert_eq "la conversión de 10 argumentos también"   "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND p.proname='settle_reserved_quota' AND pg_get_function_arguments(p.oid) LIKE '%p_response_json%'")"
assert_eq "uellix_stella_ops vuelve a 6 funciones"   "6" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
assert_eq "LA ESCRITURA DIRECTA NO SE RESTAURA"      "0" "$(runtime_writers)"
assert_eq "el CHECK de identidad SIGUE"              "1" "$(Q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.stella_interactions'::regclass AND conname='stella_interactions_governed_identity_check'")"
assert_eq "el grounded sigue convirtiendo"           "1" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND p.proname='settle_reserved_quota'")"

set +e
RB_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_B', '$H3');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_B', '$H3');
  RAISE NOTICE 'RESULT grounded=%', r.outcome;
END
\$a\$;
DO \$b\$
BEGIN
  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
  VALUES ('$ORG_B','$PROJ_B','$USER_B','advisor','advisor', repeat('a',64), '{}'::jsonb, 'm', repeat('8',64));
  RAISE NOTICE 'RESULT directo=ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT directo=%', SQLSTATE; END \$b\$;
ROLLBACK;
SQL
)
set -e
echo "$RB_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "tras el rollback, grounded sigue vivo"    "completed" "$(res "$RB_OUT" grounded)"
assert_eq "...y la escritura directa sigue cerrada"  "42501"     "$(res "$RB_OUT" directo)"

# --------------------------------------------------------------------------
say "19. Reaplicación tras el rollback"
# --------------------------------------------------------------------------
apply_forward stella_0017_governed_stella_consumption
assert_eq "el estado vuelve al vector de aplicado" "$APPLIED" "$(state)"
printf '  %-52s ' "stella_0017_rollback (2ª vez)"
if "${PSQL[@]}" -1 -q -f "/stella_0017_rollback.sql" >/dev/null 2>/tmp/gcrb2_$$; then echo "OK"
else echo "FAIL"; cat /tmp/gcrb2_$$; exit 1; fi
apply_forward stella_0017_governed_stella_consumption
assert_eq "y otra vez, idéntico" "$APPLIED" "$(state)"

# --------------------------------------------------------------------------
say "20. Orden de rollback impuesto por el SQL"
# --------------------------------------------------------------------------
# stella_0016 se revierte con stella_0017 todavía instalado: la conversión de
# diez argumentos es propiedad de uellix_cap_stella_quota y su verbo hermano la
# llama. El §1 del rollback de stella_0017 se niega en el otro sentido.
printf '  %-52s ' "stella_0016_rollback con 0017 puesto"
if "${PSQL[@]}" -1 -q -f "/stella_0016_rollback.sql" >/dev/null 2>/dev/null; then
  echo "aplicado"
  printf '  %-52s ' "stella_0017_rollback después"
  if "${PSQL[@]}" -1 -q -f "/stella_0017_rollback.sql" >/dev/null 2>/dev/null; then
    fail "el rollback de stella_0017 NO se negó sobre una base sin stella_capacity"
  fi
  echo "SE NIEGA, como debe"
else
  echo "abortó (también aceptable: fail-closed)"
fi

# --------------------------------------------------------------------------
say "21. Retorno EXACTO al baseline desde una base limpia"
# --------------------------------------------------------------------------
restore_baseline
CLEAN=$(state)
assert_eq "el baseline restaurado coincide" "$BASELINE" "$CLEAN"
apply_forward "${FORWARD[@]}"
FRESH=$(state)
assert_eq "aplicar la cadena da el mismo vector" "$APPLIED" "$FRESH"
for rb in "${ROLLBACKS[@]}"; do
  printf '  %-52s ' "$rb"
  if "${PSQL[@]}" -1 -q -f "/$rb.sql" >/dev/null 2>/tmp/gcall_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/gcall_$$; exit 1; fi
done
FINAL=$(state)
echo "  baseline : $BASELINE"
echo "  final    : $FINAL"

# LOS DOCE PRIMEROS COMPONENTES VUELVEN AL BASELINE; EL DECIMOTERCERO NO, Y ES
# DELIBERADO. La cadena completa de rollbacks retira cada objeto que los cinco
# paquetes crearon —incluido el CHECK de identidad gobernada, que desaparece
# con la COLUMNA que restringe cuando el rollback de stella_0013 la DROPea— pero
# NINGUNO de los cinco vuelve a conceder INSERT sobre el ledger. La base termina
# con cero principales de runtime capaces de escribirlo, frente a los tres del
# baseline restaurado.
#
# Consecuencia declarada y comprobada abajo: sobre esa base, stella_0017 NO se
# puede reaplicar solo. Su §0 exige la columna idempotency_key y su índice único,
# así que hay que volver a aplicar la cadena desde stella_0013. Fail-closed en el
# sentido correcto: lo que falta es el mecanismo de cobro, no la barrera.
assert_eq "los 12 primeros componentes vuelven al baseline" "${BASELINE%/*}" "${FINAL%/*}"
assert_eq "la escritura directa sigue cerrada al final"     "0" "$(runtime_writers)"
assert_eq "el CHECK se fue con su columna"                  "0" "$(Q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.stella_interactions'::regclass AND conname='stella_interactions_governed_identity_check'")"
assert_eq "...porque la columna ya no existe"               "0" "$(Q "SELECT count(*) FROM pg_attribute a WHERE a.attrelid=to_regclass('public.stella_interactions') AND a.attname='idempotency_key' AND a.attnum>0 AND NOT a.attisdropped")"
if "${PSQL[@]}" -1 -q -f "/stella_0017_governed_stella_consumption.sql" >/dev/null 2>/dev/null; then
  fail "stella_0017 se aplicó sobre una base sin la columna de identidad"
fi
echo "  ok   stella_0017 se niega sin su cadena, tras el rollback completo"

# --------------------------------------------------------------------------
say "22. Teardown"
# --------------------------------------------------------------------------
cleanup
echo
echo "STELLA_GOVERNED_CONSUMPTION_DRY_RUN_OK"
