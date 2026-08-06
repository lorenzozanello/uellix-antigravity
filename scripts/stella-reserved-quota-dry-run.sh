#!/usr/bin/env bash
# scripts/stella-reserved-quota-dry-run.sh
#
# Aplica, INVOCA, ataca, revierte y REAPLICA la cadena
#   stella_0013 -> stella_0014 -> stella_0015 -> stella_0016
# en un contenedor DESECHABLE restaurado desde db/baseline/. Deriva los
# conteos; no los asume.
#
# TREN 4.3 — R1. El arnés se aplica en DOS etapas a propósito: con
# stella_0013/0014/0015 instalados y stella_0016 todavía no, el §5b REPRODUCE
# el sobreconsumo entre acciones hermanas contra las funciones reales — una
# reserva grounded viva, una hermana que cobra la última unidad sin verla, y un
# `complete` que ya no puede cobrar el trabajo que acaba de ejecutarse. Sólo
# después se aplica stella_0016 y se vuelve a ejecutar la misma secuencia, que
# ahora refusa a la hermana y deja que `complete` convierta su reserva.
#
# POR QUÉ ES UN ARNÉS APARTE Y NO UNA ETAPA DE stella-ticket-dry-run.sh
#   Aquel afirma un VECTOR DE ESTADO exacto de nueve componentes para la cadena
#   0013→0015 y lo compara entre «aplicado», «revertido» y «reaplicado». Añadir
#   tres funciones, una policy y una columna derivada desplazaría tres de esas
#   nueve cifras y con ellas la evidencia de gate que el tren 4.2 ya produjo. Un
#   arnés hermano mide lo nuevo sin reescribir lo ya medido — el
#   mismo argumento que stella-ticket-dry-run.sh hace frente a
#   stella-train4-dry-run.sh, un tren antes.
#
# QUÉ HACE QUE ESTO NO SEA UNA INSPECCIÓN DE ESTRUCTURA
#   R1 se REPRODUCE con llamadas reales antes de cerrarlo: se demuestra que la
#   ruta de escritura directa que usan las cinco acciones hermanas ignora una
#   reserva viva, que la organización vende una unidad de más contra la
#   semántica de reserva, y que el `complete` del ticket que la reservó es
#   rechazado. Sólo después se ejerce la conversión: se reservan unidades, se
#   convierten, se abortan, se dejan expirar, se cruzan periodos y se disputan
#   entre sesiones concurrentes REALES (dos conexiones, no dos transacciones
#   simuladas).
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen montado, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida, pase o
#   falle. db/baseline/** se lee, nunca se escribe.
#
#   bash scripts/stella-reserved-quota-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_reserved_quota_dry_run_$$"
BASE_DIR="db/baseline"

# La cadena, en dos etapas. BASE es el estado que R1 reporta; FORWARD es la
# cadena completa. El §5b mide el defecto sobre BASE antes de que FORWARD lo
# cierre — un arnés que sólo midiera el estado final cerraría un hueco que nadie
# vio abierto.
FORWARD_BASE=(stella_0013_grounded_query_quota stella_0014_operation_tickets stella_0015_project_bound_operation_tickets)
FORWARD=(stella_0013_grounded_query_quota stella_0014_operation_tickets stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics)
# Orden inverso, y el propio SQL lo impone en los cuatro extremos.
ROLLBACKS=(stella_0016_rollback stella_0015_rollback stella_0014_rollback stella_0013_rollback)

USER_A='99999999-9999-9999-9999-999999999961'
USER_B='99999999-9999-9999-9999-999999999962'
# SEGUNDO actor de la MISMA organizacion. Es la pieza que R1b necesita: el
# defecto no cruza ninguna frontera de organizacion ni de proyecto, asi que un
# fixture con un actor por organizacion no puede expresarlo. Y tiene que ser un
# usuario PROPIO: `user_single_active_membership` impide que USER_B tenga una
# segunda membresia activa, asi que reutilizarlo no era una opcion.
USER_C='99999999-9999-9999-9999-999999999963'
ORG_A='11111111-1111-1111-1111-111111111161'
ORG_B='11111111-1111-1111-1111-111111111162'
PROJ_A1='22222222-2222-2222-2222-222222222261'
PROJ_A2='22222222-2222-2222-2222-222222222263'
PROJ_B='22222222-2222-2222-2222-222222222262'

H1='1111111111111111111111111111111111111111111111111111111111111111'
H2='2222222222222222222222222222222222222222222222222222222222222222'
H3='3333333333333333333333333333333333333333333333333333333333333333'

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

seed_ticket() {
  local v
  v=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c "$1" | tail -1 | tr -d '[:space:]')
  [[ "$v" =~ ^[0-9a-f]{64}$ ]] || fail "seed_ticket: id sembrado con forma inesperada (longitud ${#v}): '$v'"
  printf '%s' "$v"
}

assert_eq() {
  if [ "$2" = "$3" ]; then printf '  ok   %-56s %s\n' "$1" "$3"
  else printf '  FAIL %-56s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; exit 1; fi
}

# Extrae `RESULT clave=valor` de la salida de psql. Las pruebas vivas emiten sus
# hechos por RAISE NOTICE porque una función que devuelve una tabla dentro de un
# DO block no tiene canal de retorno — y porque un NOTICE sobrevive al ROLLBACK
# que muchas de estas pruebas necesitan.
res() { printf '%s' "$1" | sed -n "s/.*RESULT $2=\\(.*\\)/\\1/p" | tail -1 | tr -d '\r'; }

# El vector de estado que se compara entre "aplicado", "revertido" y
# "reaplicado". Se cuentan OBJETOS, no filas: el ledger es append-only.
#
# Las componentes 10 y 11 son de este tren: las tres funciones de capacidad en
# uellix_stella y la columna derivada del periodo. Sin ellas el vector no
# distingue «stella_0015 aplicado» de «stella_0015 + stella_0016 aplicados» —
# las dos publican SEIS funciones en uellix_stella_ops, tres policies y dos
# triggers, y un vector que no distingue los dos estados no puede afirmar nada
# sobre el retorno al baseline de un paquete que republica cuerpos en el sitio.
state() {
  printf '%s/%s/%s/%s/%s/%s/%s/%s/%s/%s/%s' \
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
    "$(Q "SELECT count(*) FROM pg_attribute a WHERE a.attrelid=to_regclass('uellix_stella_ops.operation_tickets') AND a.attname='period_month' AND a.attnum>0 AND NOT a.attisdropped")"
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

  "${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "restore de roles falló"
  "${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "restore de schema falló"
  "${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore falló"
}

apply_forward() {
  for f in "$@"; do
    printf '  %-52s ' "$f"
    if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/rqerr_$$; then echo "OK"
    else echo "FAIL"; cat /tmp/rqerr_$$; exit 1; fi
  done
}

# ORG_A arranca con cuota 1: la ÚLTIMA unidad. Es el fixture mínimo que puede
# expresar R1 — con dos unidades la hermana y el ticket caben los dos y no hay
# nada que disputar.
seed_fixture() {
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "la siembra falló"
SET ROLE uellix_owner;

INSERT INTO public.users (id, email) VALUES
  ('$USER_A', 'reserved-a@example.invalid'),
  ('$USER_B', 'reserved-b@example.invalid'),
  ('$USER_C', 'reserved-c@example.invalid');

INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
  ('$ORG_A', 'Org Reserved A', 'org-reserved-a', 1),
  ('$ORG_B', 'Org Reserved B', 'org-reserved-b', 50);

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
if "${PSQL[@]}" -1 -q -f "/stella_0016_reserved_quota_semantics.sql" >/dev/null 2>/dev/null; then
  fail "stella_0016 se aplicó SIN su cadena — su guarda de dependencia no obliga"
fi
echo "  ok   stella_0016 sin la cadena aborta, como debe"

# --------------------------------------------------------------------------
say "5. Etapa 1 — la cadena 0013+0014+0015: el estado que R1 reporta"
# --------------------------------------------------------------------------
apply_forward "${FORWARD_BASE[@]}"
BASE_STATE=$(state)
echo "  estado con 0013+0014+0015: $BASE_STATE"
seed_fixture

# --------------------------------------------------------------------------
say "5b. REPRODUCCIÓN de R1 — antes de cerrarlo"
# --------------------------------------------------------------------------
# La secuencia, con cuota restante = 1:
#
#   1. issue + bind          -> el ticket RESERVA la única unidad
#   2. la acción hermana     -> lee el ledger (0 cargos), decide que puede, y
#                               COBRA la unidad con un INSERT directo
#   3. Grounding termina
#   4. complete              -> consume_stella_quota cuenta 1 cargo contra
#                               cuota 1 y RECHAZA. El trabajo se regala.
#
# La hermana se reproduce EXACTAMENTE como la escriben las cinco acciones
# TypeScript: `checkStellaQuota` (una lectura de count sin lock) seguida de
# `db.insert(stellaInteractions)` (una escritura sin lock, sin clave de
# idempotencia, sin pasar por consume_stella_quota). No es una simplificación:
# es la ruta que app/actions/stella/{advisor,validator,composer,reviewer}.ts
# ejecutan hoy.
#
# Se mide DENTRO de la transacción y se revierte: el ledger es append-only y
# estas filas no deben sobrevivir a la reproducción.
set +e
R1_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

-- El ticket se deja en una tabla temporal porque uellix_app NO PUEDE LEER
-- uellix_stella_ops.operation_tickets — sólo el definer puede, y eso es el
-- aislamiento que stella_0014 §6g instala, no un obstáculo del arnés. Las
-- mediciones sobre la tabla de tickets se hacen después, como superusuario.
CREATE TEMP TABLE r1_ticket(ticket_id char(64));

DO \$r1\$
DECLARE
  t char(64); r record; v_quota int; v_used int; v_sold int;
BEGIN
  -- 1. La reserva grounded toma la última unidad.
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO r1_ticket VALUES (t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT r1_bind=%', r.outcome;

  -- 2. La acción hermana. checkStellaQuota: una lectura sin lock del ledger.
  SELECT o.stella_monthly_quota INTO v_quota FROM public.organizations o WHERE o.id = '$ORG_A';
  SELECT count(*)::int INTO v_used FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A'
     AND si.created_at >= date_trunc('month', timezone('UTC', now()));
  RAISE NOTICE 'RESULT r1_hermana_ve_usado=%', v_used;
  RAISE NOTICE 'RESULT r1_hermana_ve_cuota=%', v_quota;
  RAISE NOTICE 'RESULT r1_hermana_cree_que_puede=%', (v_used < v_quota)::text;

  -- ...y la escritura directa que sigue. Sin lock, sin clave, sin función.
  INSERT INTO public.stella_interactions
    (organization_id, project_id, created_by, stella_role, pipeline_step,
     context_hash, response_json, model_used)
  VALUES ('$ORG_A', '$PROJ_A2', '$USER_A', 'advisor', 'advisor',
          repeat('a', 64), '{"kind":"sibling"}'::jsonb, 'test-model');
  RAISE NOTICE 'RESULT r1_hermana_cobro=true';

  -- 3. Grounding terminó fuera de toda transacción. 4. complete.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT r1_complete=%', r.outcome;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT r1_complete=EXCEPTION:%', SQLSTATE;
  END;

  SELECT count(*)::int INTO v_sold FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A'
     AND si.created_at >= date_trunc('month', timezone('UTC', now()));
  RAISE NOTICE 'RESULT r1_unidades_vendidas=%', v_sold;
  RAISE NOTICE 'RESULT r1_cargos_grounded=%', (
    SELECT count(*)::int FROM public.stella_interactions si
     WHERE si.organization_id = '$ORG_A' AND si.stella_role = 'grounded_query');
END
\$r1\$;

-- Las dos mediciones que sólo el superusuario alcanza. Siguen dentro de la
-- MISMA transacción, así que ven exactamente el estado que dejó el protocolo.
RESET ROLE;
DO \$m\$
DECLARE v int; s text;
BEGIN
  SELECT count(*)::int INTO v FROM uellix_stella_ops.operation_tickets x
   WHERE x.organization_id = '$ORG_A' AND x.status = 'bound'
     AND x.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());
  RAISE NOTICE 'RESULT r1_reservas_vivas=%', v;
  SELECT x.status INTO s FROM uellix_stella_ops.operation_tickets x
   WHERE x.ticket_id = (SELECT ticket_id FROM r1_ticket);
  RAISE NOTICE 'RESULT r1_estado_ticket=%', s;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$R1_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'

assert_eq "R1 la reserva grounded se toma"            "bound"          "$(res "$R1_OUT" r1_bind)"
assert_eq "R1 hay 1 reserva viva"                     "1"              "$(res "$R1_OUT" r1_reservas_vivas)"
assert_eq "R1 la hermana ve 0 cargos"                 "0"              "$(res "$R1_OUT" r1_hermana_ve_usado)"
assert_eq "R1 la hermana IGNORA la reserva y procede" "true"           "$(res "$R1_OUT" r1_hermana_cree_que_puede)"
assert_eq "R1 complete NO puede cobrar"               "quota_exceeded" "$(res "$R1_OUT" r1_complete)"
assert_eq "R1 el ticket queda bound, sin liquidar"    "bound"          "$(res "$R1_OUT" r1_estado_ticket)"
assert_eq "R1 el trabajo grounded se regala"          "0"              "$(res "$R1_OUT" r1_cargos_grounded)"
assert_eq "R1 unidades efectivamente vendidas"        "1"              "$(res "$R1_OUT" r1_unidades_vendidas)"

echo
echo "  R1 REPRODUCIDO: la reserva grounded no cuenta para la hermana, y complete"
echo "  vuelve a disputar la unidad que su propio bind ya había reservado."

# --------------------------------------------------------------------------
say "5c. REPRODUCCIÓN de R1b — la reserva tampoco cuenta entre ACTORES"
# --------------------------------------------------------------------------
# Segundo defecto del mismo conteo, y no es el que R1 nombra: la política
# `operation_tickets_definer_select` de stella_0014 §5 exige
# `actor_id = auth.uid()`, y `uellix_cap_stella_ticket` no tiene BYPASSRLS. Así
# que el `SELECT count(*)` de reservas vivas dentro de `bind` sólo ve los
# tickets DEL PROPIO ACTOR.
#
# Dos usuarios de la misma organización con una sola unidad restante reservan
# los dos. El tren 4.2 midió «dos tickets por la última unidad» con UN actor, y
# por eso pasó.
#
set +e
R1B_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
-- Creada por el superusuario y abierta a PUBLIC porque la escriben DOS roles
-- distintos dentro de la misma transacción. Es una tabla temporal de un
-- contenedor desechable, no una superficie del producto.
CREATE TEMP TABLE r1b(who text, ticket_id char(64));
GRANT ALL ON r1b TO PUBLIC;

SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO r1b VALUES ('a', t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT r1b_bind_actor_a=%', r.outcome;
END
\$a\$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_C"}', true);
SET LOCAL ROLE uellix_app;
DO \$b\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO r1b VALUES ('c', t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H2');
  RAISE NOTICE 'RESULT r1b_bind_actor_c=%', r.outcome;
END
\$b\$;

RESET ROLE;
DO \$m\$
DECLARE v int;
BEGIN
  SELECT count(*)::int INTO v FROM uellix_stella_ops.operation_tickets x
   WHERE x.organization_id = '$ORG_A' AND x.status = 'bound'
     AND x.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());
  RAISE NOTICE 'RESULT r1b_reservas_vivas=%', v;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$R1B_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'

assert_eq "R1b el actor A reserva la última unidad" "bound" "$(res "$R1B_OUT" r1b_bind_actor_a)"
assert_eq "R1b el actor C reserva LA MISMA unidad"  "bound" "$(res "$R1B_OUT" r1b_bind_actor_c)"
assert_eq "R1b dos reservas vivas contra cuota 1"   "2"     "$(res "$R1B_OUT" r1b_reservas_vivas)"

echo
echo "  R1b REPRODUCIDO: el conteo de reservas se hace bajo la policy de SELECT"
echo "  ligada al actor, así que cada actor sólo se ve a sí mismo."

# --------------------------------------------------------------------------
say "6. Etapa 2 — stella_0016 sobre la cadena"
# --------------------------------------------------------------------------
apply_forward stella_0016_reserved_quota_semantics
APPLIED=$(state)
echo "  estado con la cadena completa: $APPLIED"
[ "$APPLIED" != "$BASE_STATE" ] || fail "el vector de estado no distingue 0015 de 0016"

assert_eq "3 funciones de capacidad publicadas" "3" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND p.proname IN ('stella_capacity','consume_stella_capacity','settle_reserved_quota')")"
assert_eq "uellix_stella_ops sigue con 6 funciones" "6" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
assert_eq "period_month es GENERATED STORED" "s" \
  "$(Q "SELECT a.attgenerated FROM pg_attribute a WHERE a.attrelid='uellix_stella_ops.operation_tickets'::regclass AND a.attname='period_month'")"
assert_eq "settle NO ejecutable por uellix_app" "f" \
  "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)','EXECUTE')")"
assert_eq "settle ejecutable por el definer de tickets" "t" \
  "$(Q "SELECT has_function_privilege('uellix_cap_stella_ticket','uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)','EXECUTE')")"
assert_eq "el nonce sigue ilegible para capacidad" "f" \
  "$(Q "SELECT has_column_privilege('uellix_cap_stella_quota','uellix_stella_ops.operation_tickets','charge_nonce','SELECT')")"

# --------------------------------------------------------------------------
say "7. R1 CERRADO — la misma secuencia, ahora contra stella_0016"
# --------------------------------------------------------------------------
# Identica al 5b salvo por una linea: la hermana consume por la superficie
# gobernada en vez de escribir el ledger a mano. Ese cambio de UNA LINEA es la
# solicitud de integracion que este paquete emite.
set +e
FIX_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
CREATE TEMP TABLE fx_ticket(ticket_id char(64));

DO \$f\$
DECLARE t char(64); r record; c record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO fx_ticket VALUES (t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT fix_bind=%', r.outcome;

  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT fix_limite=%', c.limit_units;
  RAISE NOTICE 'RESULT fix_consumido=%', c.consumed;
  RAISE NOTICE 'RESULT fix_reservado=%', c.reserved;
  RAISE NOTICE 'RESULT fix_disponible=%', c.available;

  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A2', 'advisor', repeat('b', 64));
  RAISE NOTICE 'RESULT fix_hermana=%', r.outcome;

  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT fix_complete=%', r.outcome;

  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT fix_complete_retry=%', r.outcome;

  RAISE NOTICE 'RESULT fix_cargos_grounded=%', (
    SELECT count(*)::int FROM public.stella_interactions si
     WHERE si.organization_id = '$ORG_A' AND si.stella_role = 'grounded_query');
  RAISE NOTICE 'RESULT fix_unidades_vendidas=%', (
    SELECT count(*)::int FROM public.stella_interactions si
     WHERE si.organization_id = '$ORG_A'
       AND si.created_at >= date_trunc('month', timezone('UTC', now())));

  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT fix_consumido_final=%', c.consumed;
  RAISE NOTICE 'RESULT fix_reservado_final=%', c.reserved;
  RAISE NOTICE 'RESULT fix_disponible_final=%', c.available;
END
\$f\$;

RESET ROLE;
DO \$m\$
DECLARE s text; p timestamp;
BEGIN
  SELECT x.status, x.period_month INTO s, p FROM uellix_stella_ops.operation_tickets x
   WHERE x.ticket_id = (SELECT ticket_id FROM fx_ticket);
  RAISE NOTICE 'RESULT fix_estado_ticket=%', s;
  RAISE NOTICE 'RESULT fix_periodo_reserva=%', (p = date_trunc('month', timezone('UTC', now())))::text;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$FIX_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'

assert_eq "la reserva grounded se toma"                 "bound"          "$(res "$FIX_OUT" fix_bind)"
assert_eq "limite"                                      "1"              "$(res "$FIX_OUT" fix_limite)"
assert_eq "consumido con la reserva viva"               "0"              "$(res "$FIX_OUT" fix_consumido)"
assert_eq "reservado con la reserva viva"               "1"              "$(res "$FIX_OUT" fix_reservado)"
assert_eq "disponible = limite - consumido - reservado" "0"              "$(res "$FIX_OUT" fix_disponible)"
assert_eq "la hermana es RECHAZADA por la reserva"      "quota_exceeded" "$(res "$FIX_OUT" fix_hermana)"
assert_eq "complete CONVIERTE la reserva"               "completed"      "$(res "$FIX_OUT" fix_complete)"
assert_eq "el reintento no cobra"                       "replayed"       "$(res "$FIX_OUT" fix_complete_retry)"
assert_eq "el trabajo grounded SI se cobra"             "1"              "$(res "$FIX_OUT" fix_cargos_grounded)"
assert_eq "unidades vendidas = 1, nunca 2"              "1"              "$(res "$FIX_OUT" fix_unidades_vendidas)"
assert_eq "tras convertir: consumido"                   "1"              "$(res "$FIX_OUT" fix_consumido_final)"
assert_eq "tras convertir: reservado"                   "0"              "$(res "$FIX_OUT" fix_reservado_final)"
assert_eq "tras convertir: disponible"                  "0"              "$(res "$FIX_OUT" fix_disponible_final)"
assert_eq "el ticket queda completed"                   "completed"      "$(res "$FIX_OUT" fix_estado_ticket)"
assert_eq "period_month es el mes de la reserva"        "true"           "$(res "$FIX_OUT" fix_periodo_reserva)"

# --------------------------------------------------------------------------
say "7b. R1b CERRADO — la reserva cuenta ENTRE ACTORES"
# --------------------------------------------------------------------------
set +e
FIXB_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
CREATE TEMP TABLE fxb(who text, ticket_id char(64));
GRANT ALL ON fxb TO PUBLIC;

SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$a\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO fxb VALUES ('a', t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT fixb_bind_actor_a=%', r.outcome;
END
\$a\$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_C"}', true);
SET LOCAL ROLE uellix_app;
DO \$k\$
DECLARE t char(64); r record; c record;
BEGIN
  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT fixb_c_ve_reservado=%', c.reserved;

  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  INSERT INTO fxb VALUES ('c', t);
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H2');
  RAISE NOTICE 'RESULT fixb_bind_actor_c=%', r.outcome;

  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'validator', repeat('c', 64));
  RAISE NOTICE 'RESULT fixb_hermana_c=%', r.outcome;
END
\$k\$;

RESET ROLE;
DO \$m\$
DECLARE v int;
BEGIN
  SELECT count(*)::int INTO v FROM uellix_stella_ops.operation_tickets x
   WHERE x.organization_id = '$ORG_A' AND x.status = 'bound'
     AND x.expires_at > pg_catalog.timezone('UTC', pg_catalog.now());
  RAISE NOTICE 'RESULT fixb_reservas_vivas=%', v;
END
\$m\$;
ROLLBACK;
SQL
)
set -e
echo "$FIXB_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'

assert_eq "el actor A reserva la ultima unidad"   "bound"          "$(res "$FIXB_OUT" fixb_bind_actor_a)"
assert_eq "el actor C VE la reserva del actor A"  "1"              "$(res "$FIXB_OUT" fixb_c_ve_reservado)"
assert_eq "el actor C es RECHAZADO"               "quota_exceeded" "$(res "$FIXB_OUT" fixb_bind_actor_c)"
assert_eq "la hermana del actor C tambien"        "quota_exceeded" "$(res "$FIXB_OUT" fixb_hermana_c)"
assert_eq "una sola reserva viva contra cuota 1"  "1"              "$(res "$FIXB_OUT" fixb_reservas_vivas)"

# --------------------------------------------------------------------------
say "8. Abort y expiracion — la reserva se libera sin depender de un cron"
# --------------------------------------------------------------------------
# Estas pruebas COMMITean: la liberacion tiene que ser visible a otra sesion
# para significar algo. El §12 vuelve a restaurar el baseline.
set +e
REL_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', false);
SET ROLE uellix_app;

DO \$r\$
DECLARE t char(64); r record; c record;
BEGIN
  -- 8a. ABORT. La reserva se libera en el acto.
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT rel_reservado_antes_de_abort=%', c.reserved;

  RAISE NOTICE 'RESULT rel_abort=%',
    uellix_stella_ops.abort_operation_ticket(t, '$PROJ_A1', 'execution_failed');

  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT rel_reservado_tras_abort=%', c.reserved;
  RAISE NOTICE 'RESULT rel_disponible_tras_abort=%', c.available;

  -- La hermana ya puede consumir la unidad liberada.
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'advisor', repeat('1', 64));
  RAISE NOTICE 'RESULT rel_hermana_tras_abort=%', r.outcome;

  -- Reintentar complete sobre un ticket abortado no cobra.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT rel_complete_tras_abort=UNEXPECTED:%', r.outcome;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT rel_complete_tras_abort=%', SQLSTATE; END;
END
\$r\$;
RESET ROLE;
SQL
)
set -e
echo "$REL_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "8a reservado con la reserva viva"      "1"      "$(res "$REL_OUT" rel_reservado_antes_de_abort)"
assert_eq "8a abort libera"                       "aborted" "$(res "$REL_OUT" rel_abort)"
assert_eq "8a reservado tras abort"               "0"      "$(res "$REL_OUT" rel_reservado_tras_abort)"
assert_eq "8a disponible tras abort"              "1"      "$(res "$REL_OUT" rel_disponible_tras_abort)"
assert_eq "8a la hermana consume lo liberado"     "consumed" "$(res "$REL_OUT" rel_hermana_tras_abort)"
assert_eq "8a complete tras abort no cobra"       "U0109"  "$(res "$REL_OUT" rel_complete_tras_abort)"
assert_eq "8a un solo cargo en total"             "1" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_A'")"

# --- 8b. Expiracion LOGICA, sin que nadie barra nada ------------------------
# La cuota se sube a 2 para que quede exactamente una unidad libre despues del
# cargo de 8a. La reserva expirada NO debe consumirla.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 2 WHERE id = '$ORG_A';" >/dev/null

# El ticket vencido se construye por el OWNER, no por el protocolo: las
# funciones gobernadas se niegan a atar un ticket ya expirado (U0108), que es
# precisamente la garantia que se quiere medir desde el otro lado. El
# `issued -> bound` es una transicion legal y el trigger la admite; lo que no
# admite es tocar issued_at o expires_at despues.
EXPIRED_T=$(printf 'e%.0s' $(seq 1 64) | tr 'e' 'a')
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "8b: no se pudo sembrar el ticket vencido"
SET ROLE uellix_owner;
INSERT INTO uellix_stella_ops.operation_tickets (
  ticket_id, organization_id, project_id, actor_id, category, status,
  charge_nonce, issued_at, expires_at)
VALUES ('$EXPIRED_T', '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'issued',
        repeat('9', 64),
        timezone('UTC', now()) - interval '20 minutes',
        timezone('UTC', now()) - interval '5 minutes');
UPDATE uellix_stella_ops.operation_tickets
   SET status = 'bound', query_hash = '$H2',
       bound_at = timezone('UTC', now()) - interval '19 minutes'
 WHERE ticket_id = '$EXPIRED_T';
SQL

assert_eq "8b el ticket vencido esta bound en la tabla" "bound" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$EXPIRED_T'")"

set +e
EXP_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', false);
SET ROLE uellix_app;
DO \$e\$
DECLARE r record; c record; n int;
BEGIN
  -- La reserva huerfana NO cuenta, y nadie ha barrido nada: la columna status
  -- sigue diciendo bound en la tabla.
  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT exp_reservado=%', c.reserved;
  RAISE NOTICE 'RESULT exp_disponible=%', c.available;

  -- La hermana consume la unidad que la reserva vencida ya no retiene.
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'composer', repeat('2', 64));
  RAISE NOTICE 'RESULT exp_hermana=%', r.outcome;

  -- Y completar el ticket vencido se rechaza: su unidad ya se entrego.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket('$EXPIRED_T', '$PROJ_A1', '$H2');
    RAISE NOTICE 'RESULT exp_complete=UNEXPECTED:%', r.outcome;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT exp_complete=%', SQLSTATE; END;

  -- La materializacion es HIGIENE: llega despues, y no cambia ninguna de las
  -- respuestas de arriba.
  SELECT uellix_stella_ops.expire_operation_tickets(1000) INTO n;
  RAISE NOTICE 'RESULT exp_barridos=%', n;
END
\$e\$;
RESET ROLE;
SQL
)
set -e
echo "$EXP_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "8b la reserva vencida no cuenta"        "0"        "$(res "$EXP_OUT" exp_reservado)"
assert_eq "8b disponible ignora la vencida"        "1"        "$(res "$EXP_OUT" exp_disponible)"
assert_eq "8b la hermana consume la unidad"        "consumed" "$(res "$EXP_OUT" exp_hermana)"
assert_eq "8b complete tras expirar se rechaza"    "U0108"    "$(res "$EXP_OUT" exp_complete)"
assert_eq "8b expire materializa 1 ticket"         "1"        "$(res "$EXP_OUT" exp_barridos)"
assert_eq "8b el ticket ya figura expired"         "expired" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$EXPIRED_T'")"
assert_eq "8b dos cargos, nunca tres"              "2" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_A'")"

# --------------------------------------------------------------------------
say "9. Cambio de periodo — una reserva viva de OTRO mes sigue contando"
# --------------------------------------------------------------------------
# La regla, medida: `Reserved` NO lleva filtro de periodo. Una reserva tomada
# antes del cierre convierte despues de el, y el periodo en el que aterriza el
# cargo tiene que haberla contado ya.
#
# La fila se construye a mano porque la version fisica sólo ocurre en una
# ventana de quince minutos al mes: se fija `bound_at` — y con el la columna
# derivada `period_month` — en un mes anterior, dejando `expires_at` en el
# futuro. Es exactamente el estado que un cruce real produce a las 00:03 del
# dia 1, sin tener que esperar a que lo sea.
PERIOD_T=$(printf 'b%.0s' $(seq 1 64))
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "9: no se pudo sembrar la reserva de otro periodo"
SET ROLE uellix_owner;
INSERT INTO uellix_stella_ops.operation_tickets (
  ticket_id, organization_id, project_id, actor_id, category, status,
  charge_nonce, issued_at, expires_at)
VALUES ('$PERIOD_T', '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'issued',
        repeat('7', 64),
        timezone('UTC', now()),
        timezone('UTC', now()) + interval '10 minutes');
UPDATE uellix_stella_ops.operation_tickets
   SET status = 'bound', query_hash = '$H3',
       bound_at = timezone('UTC', now()) - interval '40 days'
 WHERE ticket_id = '$PERIOD_T';
SQL

assert_eq "9 la reserva pertenece a un mes anterior" "t" \
  "$(Q "SELECT (period_month < date_trunc('month', timezone('UTC', now()))) FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$PERIOD_T'")"
assert_eq "9 y sigue viva" "t" \
  "$(Q "SELECT (expires_at > timezone('UTC', now())) FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$PERIOD_T'")"

docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 3 WHERE id = '$ORG_A';" >/dev/null

set +e
PER_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', false);
SET ROLE uellix_app;
DO \$p\$
DECLARE r record; c record;
BEGIN
  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT per_consumido=%', c.consumed;
  RAISE NOTICE 'RESULT per_reservado=%', c.reserved;
  RAISE NOTICE 'RESULT per_disponible=%', c.available;

  -- La hermana es rechazada POR la reserva del periodo anterior: el mes actual
  -- ya aparto la unidad que esa reserva va a cobrar.
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
    '$ORG_A', '$PROJ_A1', 'validator', repeat('3', 64));
  RAISE NOTICE 'RESULT per_hermana=%', r.outcome;

  -- ...y la conversion aterriza en el mes ACTUAL, contra la unidad que el mes
  -- actual habia reservado. Ni desaparece del conteo ni se cobra dos veces.
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket('$PERIOD_T', '$PROJ_A1', '$H3');
  RAISE NOTICE 'RESULT per_complete=%', r.outcome;

  SELECT * INTO c FROM uellix_stella.stella_capacity('$ORG_A', NULL);
  RAISE NOTICE 'RESULT per_consumido_final=%', c.consumed;
  RAISE NOTICE 'RESULT per_reservado_final=%', c.reserved;
  RAISE NOTICE 'RESULT per_disponible_final=%', c.available;
END
\$p\$;
RESET ROLE;
SQL
)
set -e
echo "$PER_OUT" | grep -E 'RESULT|ERROR' | sed 's/^/  /'
assert_eq "9 consumido en el mes actual"                "2"              "$(res "$PER_OUT" per_consumido)"
assert_eq "9 la reserva de otro mes SI cuenta"          "1"              "$(res "$PER_OUT" per_reservado)"
assert_eq "9 disponible = 3 - 2 - 1"                    "0"              "$(res "$PER_OUT" per_disponible)"
assert_eq "9 la hermana es rechazada por ella"          "quota_exceeded" "$(res "$PER_OUT" per_hermana)"
assert_eq "9 la conversion cruza el cierre"             "completed"      "$(res "$PER_OUT" per_complete)"
assert_eq "9 tras convertir: consumido"                 "3"              "$(res "$PER_OUT" per_consumido_final)"
assert_eq "9 tras convertir: reservado"                 "0"              "$(res "$PER_OUT" per_reservado_final)"
assert_eq "9 tras convertir: disponible"                "0"              "$(res "$PER_OUT" per_disponible_final)"
assert_eq "9 NUNCA se excede el limite"                 "3" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_A'")"

# --------------------------------------------------------------------------
say "10. Concurrencia real — dos sesiones, no dos transacciones simuladas"
# --------------------------------------------------------------------------
# Estas pruebas NO se pueden revertir: dos sesiones no comparten una
# transaccion, asi que la primera tiene que hacer COMMIT para que la segunda vea
# su fila. Por eso el §12 vuelve a restaurar el baseline.
#
# La organizacion B se usa entera para esto, con cuota 1: exactamente una unidad
# en disputa y ningun cargo previo que confunda los conteos.
setq_b() {
  docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
    "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = $1 WHERE id = '$ORG_B';" >/dev/null \
    || fail "no se pudo fijar la cuota de la organizacion B"
}
issue_b() {
  docker exec "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1 -c \
    "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'grounded_query');" \
    | tail -1 | tr -d '[:space:]'
}
bind_b() {
  docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c \
    "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$1', '$PROJ_B', '$2');" \
    | tail -1 | tr -d '[:space:]'
}

# Un caso de concurrencia = una sesion lenta que retiene su transaccion cinco
# segundos y una rapida que llega dos segundos despues. La ESPERA MEDIDA es la
# evidencia de que hubo serializacion: sin el lock compartido la segunda habria
# contado el estado viejo y respondido en milisegundos.
#
# `$1` etiqueta el caso, `$2` es el SQL de la sesion 1 y `$3` el de la sesion 2.
# Deja S1_RES, S2_RES y ELAPSED.
duel() {
  local tag="$1" sql1="$2" sql2="$3" pid t0 t1 st
  docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >"/tmp/duel_${tag}_$$" 2>&1 <<DUEL1 &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
$sql1
RESET ROLE;
SELECT pg_sleep(5);
COMMIT;
DUEL1
  pid=$!
  sleep 2
  t0=$(date +%s)
  set +e
  S2_RAW=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -tA <<DUEL2 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
$sql2
COMMIT;
DUEL2
)
  st=$?
  set -e
  t1=$(date +%s)
  wait "$pid" || true
  ELAPSED=$((t1 - t0))
  # `|| true` en las DOS: una sesion que aborta no imprime su etiqueta, y bajo
  # `set -e` un grep sin coincidencia mataria el arnes ANTES de que la asercion
  # pudiera decir que fue lo que paso. Un arnes que muere en silencio en el
  # camino a un fallo es peor que uno que no existe.
  S1_RES=$(grep -oE 'S1=[A-Za-z0-9_]+' "/tmp/duel_${tag}_$$" | head -1 || true)
  if [ -z "$S1_RES" ]; then S1_RES="S1=ERROR"; echo "    sesion 1 sin etiqueta:"; sed 's/^/      /' "/tmp/duel_${tag}_$$"; fi
  rm -f "/tmp/duel_${tag}_$$"
  S2_RES=$(printf '%s' "$S2_RAW" | grep -oE 'S2=[A-Za-z0-9_]+' | head -1 || true)
  if [ -z "$S2_RES" ]; then S2_RES="S2=ERROR"; fi
  echo "  ${tag}: S1 -> ${S1_RES:-<vacio>} | S2 -> $S2_RES  (espero ${ELAPSED}s)"
}

# Devuelve un SQL que llama a la superficie hermana y etiqueta la salida.
#
# `$2` tiene que ser UN SOLO caracter hexadecimal: la clave de idempotencia se
# construye con `repeat($2, 64)` y el guardia de forma exige `^[0-9a-f]{64}$`.
# Dos caracteres dan 128 y la llamada muere con U0100 «malformado» — que se lee
# como un rechazo por cuota y dejaria el duelo sin ejecutar.
sib() { printf "SELECT '%s=' || outcome FROM uellix_stella.consume_stella_capacity('%s', '%s', 'advisor', repeat('%s', 64));" "$1" "$ORG_B" "$PROJ_B" "$2"; }

# --- 10a. reserva grounded vs consumo hermano ------------------------------
setq_b 1
T1=$(issue_b)
duel "10a" \
  "SELECT 'S1=' || outcome FROM uellix_stella_ops.bind_operation_ticket('$T1', '$PROJ_B', '$H1');" \
  "$(sib S2 d)"
assert_eq "10a la reserva gana"                "S1=bound"          "$S1_RES"
assert_eq "10a la hermana es rechazada"        "S2=quota_exceeded" "$S2_RES"
[ "$ELAPSED" -ge 2 ] || fail "10a: la hermana no espero al lock — nada serializo"

# --- 10b. consumo hermano primero vs bind grounded -------------------------
setq_b 2
T2=$(issue_b)
duel "10b" \
  "$(sib S1 e)" \
  "SELECT 'S2=' || outcome FROM uellix_stella_ops.bind_operation_ticket('$T2', '$PROJ_B', '$H2');"
assert_eq "10b la hermana gana"                "S1=consumed"       "$S1_RES"
assert_eq "10b la reserva es rechazada"        "S2=quota_exceeded" "$S2_RES"
[ "$ELAPSED" -ge 2 ] || fail "10b: la reserva no espero al lock"
assert_eq "10b Consumed + Reserved <= Limit"   "t" \
  "$(Q "SELECT (SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B') + (SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE organization_id='$ORG_B' AND status='bound' AND expires_at > timezone('UTC', now())) <= 2")"

# --- 10c. complete grounded vs consumo hermano -----------------------------
# El caso que R1 nombra, ahora en vivo: la reserva esta viva, la hermana llega
# mientras Grounding corre, y complete NO pierde su unidad.
setq_b 4
T3=$(issue_b)
assert_eq "10c la reserva se toma" "bound" "$(bind_b "$T3" "$H3")"
duel "10c" \
  "SELECT 'S1=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$T3', '$PROJ_B', '$H3');" \
  "$(sib S2 f)"
assert_eq "10c complete convierte su reserva"  "S1=completed" "$S1_RES"
assert_eq "10c la hermana usa OTRA unidad"     "S2=consumed"  "$S2_RES"
[ "$ELAPSED" -ge 2 ] || fail "10c: la hermana no espero al lock"

# --- 10d. abort vs consumo hermano -----------------------------------------
# MEDIDO, no supuesto: `abort_operation_ticket` toma el lock de FILA y NUNCA el
# advisory — no decide nada sobre capacidad, asi que no tiene por que
# serializarse contra quien la evalua. La consecuencia es que una hermana que ya
# estaba corriendo cuando llega el abort NO espera, y ve la reserva todavia
# viva: se la rechaza.
#
# Eso es aislamiento transaccional, no un defecto, y la direccion del error es
# la que importa — conservadora. La liberacion es real y se comprueba justo
# despues, con una hermana que llega DESPUES del commit.
setq_b 5
T4=$(issue_b)
assert_eq "10d la reserva se toma" "bound" "$(bind_b "$T4" "$H1")"
duel "10d" \
  "SELECT 'S1=' || uellix_stella_ops.abort_operation_ticket('$T4', '$PROJ_B', 'caller_abort');" \
  "$(sib S2 0)"
assert_eq "10d el abort libera"                    "S1=aborted"        "$S1_RES"
assert_eq "10d la hermana simultanea es rechazada" "S2=quota_exceeded" "$S2_RES"
assert_eq "10d la reserva quedo liberada"          "aborted" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$T4'")"
POST_ABORT=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella.consume_stella_capacity('$ORG_B', '$PROJ_B', 'advisor', repeat('3', 64));" \
  | tail -1 | tr -d '[:space:]')
assert_eq "10d la hermana POSTERIOR si consume"    "consumed"          "$POST_ABORT"

# --- 10e. dos tickets grounded por la ultima unidad ------------------------
setq_b 6
T5=$(issue_b); T6=$(issue_b)
[ "$T5" != "$T6" ] || fail "10e: no se emitieron dos tickets distintos"
duel "10e" \
  "SELECT 'S1=' || outcome FROM uellix_stella_ops.bind_operation_ticket('$T5', '$PROJ_B', '$H1');" \
  "SELECT 'S2=' || outcome FROM uellix_stella_ops.bind_operation_ticket('$T6', '$PROJ_B', '$H2');"
assert_eq "10e la primera reserva"             "S1=bound"          "$S1_RES"
assert_eq "10e la segunda es rechazada"        "S2=quota_exceeded" "$S2_RES"
[ "$ELAPSED" -ge 2 ] || fail "10e: la segunda reserva no espero al lock"

# --- 10f. dos hermanas por la ultima unidad --------------------------------
# Con T5 reservado, queda exactamente cero disponible: 5 cargos + 1 reserva
# contra un limite de 6.
duel "10f" "$(sib S1 1)" "$(sib S2 2)"
assert_eq "10f la primera hermana es rechazada" "S1=quota_exceeded" "$S1_RES"
assert_eq "10f la segunda tambien"              "S2=quota_exceeded" "$S2_RES"

# --- 10g. complete duplicado ------------------------------------------------
duel "10g" \
  "SELECT 'S1=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$T5', '$PROJ_B', '$H1');" \
  "SELECT 'S2=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$T5', '$PROJ_B', '$H1');"
assert_eq "10g una sola conversion"            "S1=completed" "$S1_RES"
assert_eq "10g la segunda replays"             "S2=replayed"  "$S2_RES"
[ "$ELAPSED" -ge 2 ] || fail "10g: el complete duplicado no espero al lock de fila"

# --- 10h. complete vs abort -------------------------------------------------
setq_b 10
T7=$(issue_b)
assert_eq "10h la reserva se toma" "bound" "$(bind_b "$T7" "$H3")"
duel "10h" \
  "SELECT 'S1=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$T7', '$PROJ_B', '$H3');" \
  "SELECT 'S2=' || COALESCE(uellix_stella_ops.abort_operation_ticket('$T7', '$PROJ_B', 'caller_abort'), 'null');"
assert_eq "10h complete gana"                  "S1=completed" "$S1_RES"
assert_eq "10h el abort concurrente se rechaza" "S2=ERROR"    "$S2_RES"

# --- El invariante, sobre TODO lo que hizo el §10 --------------------------
CONSUMED_B=$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B' AND created_at >= date_trunc('month', timezone('UTC', now()))")
RESERVED_B=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE organization_id='$ORG_B' AND status='bound' AND expires_at > timezone('UTC', now())")
LIMIT_B=$(Q "SELECT stella_monthly_quota FROM public.organizations WHERE id='$ORG_B'")
echo "  invariante: consumido=$CONSUMED_B reservado=$RESERVED_B limite=$LIMIT_B"
assert_eq "Consumed + Reserved <= Limit tras 8 duelos" "t" \
  "$(Q "SELECT ($CONSUMED_B + $RESERVED_B) <= $LIMIT_B")"
assert_eq "cero deadlocks" "0" \
  "$(Q "SELECT deadlocks FROM pg_stat_database WHERE datname='postgres'")"

# --------------------------------------------------------------------------
say "11. Ataques en vivo"
# --------------------------------------------------------------------------
set +e
ATK_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', false);
SET ROLE uellix_app;
DO \$a\$
DECLARE r record; n int;
BEGIN
  -- (1) La conversion, invocada por el runtime. Cobra sin evaluar el limite:
  --     si uellix_app la alcanzara, podria cobrar por encima de la cuota.
  BEGIN
    SELECT * INTO r FROM uellix_stella.settle_reserved_quota(
      '$ORG_A', '$PROJ_A1', 'grounded_query', repeat('4', 64), repeat('5', 64));
    RAISE NOTICE 'RESULT atk_settle_por_runtime=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_settle_por_runtime=%', SQLSTATE; END;

  -- (2) SELECT directo de la tabla de reservas.
  BEGIN
    SELECT count(*) INTO n FROM uellix_stella_ops.operation_tickets;
    RAISE NOTICE 'RESULT atk_select_directo=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_select_directo=%', SQLSTATE; END;

  -- (3) Capacidad de OTRA organizacion.
  BEGIN
    SELECT * INTO r FROM uellix_stella.stella_capacity('$ORG_B', NULL);
    RAISE NOTICE 'RESULT atk_capacidad_cruzada=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_capacidad_cruzada=%', SQLSTATE; END;

  -- (4) Consumo contra OTRA organizacion.
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
      '$ORG_B', '$PROJ_B', 'advisor', repeat('6', 64));
    RAISE NOTICE 'RESULT atk_consumo_cruzado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_consumo_cruzado=%', SQLSTATE; END;

  -- (5) Consumo con el proyecto de OTRA organizacion bajo la propia.
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
      '$ORG_A', '$PROJ_B', 'advisor', repeat('8', 64));
    RAISE NOTICE 'RESULT atk_proyecto_cruzado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_proyecto_cruzado=%', SQLSTATE; END;

  -- (6) Categoria fuera del vocabulario gobernado.
  BEGIN
    SELECT * INTO r FROM uellix_stella.consume_stella_capacity(
      '$ORG_A', '$PROJ_A1', 'super_advisor', repeat('a', 64));
    RAISE NOTICE 'RESULT atk_categoria_invalida=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_categoria_invalida=%', SQLSTATE; END;
END
\$a\$;
RESET ROLE;

-- (7) La conversion invocada por SU PROPIO definer, pero mintiendo sobre la
--     reserva. El rol es NOLOGIN, asi que sólo el superusuario llega — y esa es
--     la unica manera de comprobar que la funcion no se fia de su llamador.
SET ROLE uellix_cap_stella_ticket;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', false);
DO \$d\$
DECLARE r record;
BEGIN
  -- Ticket inexistente.
  BEGIN
    SELECT * INTO r FROM uellix_stella.settle_reserved_quota(
      '$ORG_A', '$PROJ_A1', 'grounded_query', repeat('b', 64), repeat('c', 64));
    RAISE NOTICE 'RESULT atk_settle_ticket_inventado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_settle_ticket_inventado=%', SQLSTATE; END;

  -- Ticket real, YA expirado y materializado en el §8b.
  BEGIN
    SELECT * INTO r FROM uellix_stella.settle_reserved_quota(
      '$ORG_A', '$PROJ_A1', 'grounded_query', repeat('d', 64), '$EXPIRED_T');
    RAISE NOTICE 'RESULT atk_settle_expirado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_settle_expirado=%', SQLSTATE; END;

  -- Ticket real ya convertido en el §9: no vuelve a estar bound.
  BEGIN
    SELECT * INTO r FROM uellix_stella.settle_reserved_quota(
      '$ORG_A', '$PROJ_A1', 'grounded_query', repeat('e', 64), '$PERIOD_T');
    RAISE NOTICE 'RESULT atk_settle_ya_convertido=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT atk_settle_ya_convertido=%', SQLSTATE; END;
END
\$d\$;
RESET ROLE;
SQL
)
set -e
echo "$ATK_OUT" | grep -E 'RESULT' | sed 's/^/  /'
assert_eq "11 settle inalcanzable para el runtime" "42501" "$(res "$ATK_OUT" atk_settle_por_runtime)"
assert_eq "11 SELECT directo de reservas denegado" "42501" "$(res "$ATK_OUT" atk_select_directo)"
assert_eq "11 capacidad cross-organizacion"        "U0102" "$(res "$ATK_OUT" atk_capacidad_cruzada)"
assert_eq "11 consumo cross-organizacion"          "U0102" "$(res "$ATK_OUT" atk_consumo_cruzado)"
assert_eq "11 consumo con proyecto cruzado"        "U0102" "$(res "$ATK_OUT" atk_proyecto_cruzado)"
assert_eq "11 categoria fuera del vocabulario"     "U0106" "$(res "$ATK_OUT" atk_categoria_invalida)"
assert_eq "11 settle con ticket inventado"         "U0111" "$(res "$ATK_OUT" atk_settle_ticket_inventado)"
assert_eq "11 settle con reserva expirada"         "U0111" "$(res "$ATK_OUT" atk_settle_expirado)"
assert_eq "11 settle con reserva ya convertida"    "U0111" "$(res "$ATK_OUT" atk_settle_ya_convertido)"

# --- 11b. Superficie: PUBLIC, firmas viejas, privilegios --------------------
assert_eq "11b PUBLIC no ejecuta nada de uellix_stella" "0" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname='uellix_stella' AND a.grantee=0")"
assert_eq "11b ninguna firma sin proyecto vive" "0" \
  "$(Q "SELECT count(*) FROM (VALUES ('uellix_stella_ops.bind_operation_ticket(character, character)'),('uellix_stella_ops.complete_operation_ticket(character, character)'),('uellix_stella_ops.abort_operation_ticket(character, character varying)'),('uellix_stella_ops.inspect_operation_ticket(character)')) s(sig) WHERE to_regprocedure(s.sig) IS NOT NULL")"
assert_eq "11b el rol de capacidad no escribe tickets" "0" \
  "$(Q "SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a JOIN pg_roles g ON g.oid=a.grantee WHERE c.oid='uellix_stella_ops.operation_tickets'::regclass AND g.rolname='uellix_cap_stella_quota' AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')")"
assert_eq "11b la policy de capacidad no mira el actor" "0" \
  "$(Q "SELECT count(*) FROM pg_policy WHERE polrelid='uellix_stella_ops.operation_tickets'::regclass AND polname='operation_tickets_capacity_select' AND pg_get_expr(polqual, polrelid) LIKE '%actor_id%'")"

# --- 11c. session_replication_role = replica --------------------------------
# Los triggers de stella_0014 son ENABLE ALWAYS, asi que la maquina de estados
# sigue de pie incluso cuando la sesion se declara replica para saltarselos.
set +e
REPL_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
SET session_replication_role = replica;
SET ROLE uellix_owner;
DO \$s\$
BEGIN
  BEGIN
    INSERT INTO uellix_stella_ops.operation_tickets (
      ticket_id, organization_id, project_id, actor_id, category, status,
      query_hash, bound_at, completed_at, charge_nonce, issued_at, expires_at)
    VALUES (repeat('f', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'completed',
            '$H1', timezone('UTC', now()), timezone('UTC', now()), repeat('0', 64),
            timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes');
    RAISE NOTICE 'RESULT repl_nace_completado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT repl_nace_completado=%', SQLSTATE; END;
END
\$s\$;
RESET ROLE;
SQL
)
set -e
echo "$REPL_OUT" | grep -E 'RESULT' | sed 's/^/  /'
assert_eq "11c replica no desarma la maquina de estados" "U0109" "$(res "$REPL_OUT" repl_nace_completado)"

# --- 11d. period_month es inescribible --------------------------------------
set +e
GEN_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
SET ROLE uellix_owner;
DO \$g\$
BEGIN
  BEGIN
    UPDATE uellix_stella_ops.operation_tickets
       SET period_month = date_trunc('month', timezone('UTC', now()) - interval '1 year')
     WHERE ticket_id = '$PERIOD_T';
    RAISE NOTICE 'RESULT gen_escribe_periodo=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT gen_escribe_periodo=%', SQLSTATE; END;
END
\$g\$;
RESET ROLE;
SQL
)
set -e
echo "$GEN_OUT" | grep -E 'RESULT' | sed 's/^/  /'
assert_eq "11d el periodo derivado no se puede escribir" "428C9" "$(res "$GEN_OUT" gen_escribe_periodo)"

# --------------------------------------------------------------------------
say "12. Rollback sobre una base LIQUIDADA — cargos reales, tickets reales"
# --------------------------------------------------------------------------
# Esta es la base que las §7 a §11 dejaron: cargos cobrados por las dos rutas
# nuevas, tickets en completed, aborted, expired, bound e issued. Es la base
# donde un rollback puede hacer dano, y por eso se prueba aqui antes que en la
# limpia.
echo "  estado de tickets antes del rollback:"
Q "SELECT status || '=' || count(*) FROM uellix_stella_ops.operation_tickets GROUP BY status ORDER BY status" | sed 's/^/    /'
CHARGES_BEFORE=$(Q "SELECT count(*) FROM public.stella_interactions")
TICKETS_BEFORE=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets")
echo "    cargos=$CHARGES_BEFORE tickets=$TICKETS_BEFORE"
[ "$CHARGES_BEFORE" -gt 0 ] || fail "12: la base no tiene cargos — el rollback se estaria probando sobre nada"

for st in completed aborted expired issued; do
  n=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE status='$st'")
  [ "$n" -gt 0 ] || fail "12: no hay tickets en estado $st — el rollback no se prueba contra el estado que importa"
done
echo "  ok   la base cubre completed / aborted / expired / issued"

printf '  %-52s ' "stella_0016_rollback"
"${PSQL[@]}" -1 -q -f "/stella_0016_rollback.sql" >/tmp/rb_$$ 2>&1 && echo "OK" || { echo "FAIL"; cat /tmp/rb_$$; exit 1; }
grep -E 'NOTICE' /tmp/rb_$$ | sed 's/^/    /'; rm -f /tmp/rb_$$

assert_eq "12 ningun cargo se perdio"        "$CHARGES_BEFORE" "$(Q "SELECT count(*) FROM public.stella_interactions")"
assert_eq "12 ningun ticket se perdio"       "$TICKETS_BEFORE" "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets")"
assert_eq "12 las 3 funciones de capacidad se fueron" "0" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND p.proname IN ('stella_capacity','consume_stella_capacity','settle_reserved_quota')")"
assert_eq "12 bind y complete se fueron, no se revirtieron" "0" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket')")"
assert_eq "12 issue/abort/inspect/expire siguen" "4" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
assert_eq "12 consume_stella_quota sigue intacta" "1" \
  "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND p.proname='consume_stella_quota'")"
assert_eq "12 period_month se fue"            "0" \
  "$(Q "SELECT count(*) FROM pg_attribute a WHERE a.attrelid='uellix_stella_ops.operation_tickets'::regclass AND a.attname='period_month' AND a.attnum>0 AND NOT a.attisdropped")"
assert_eq "12 la policy de capacidad se fue"  "3" \
  "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='uellix_stella_ops'")"
assert_eq "12 el rol de capacidad no lee tickets" "f" \
  "$(Q "SELECT has_column_privilege('uellix_cap_stella_quota','uellix_stella_ops.operation_tickets','status','SELECT')")"

# FAIL-CLOSED: reservar y liquidar ya no existen, y el runtime lo descubre como
# un error, nunca como un exito silencioso.
set +e
FC_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella_ops.bind_operation_ticket(repeat('a',64), '$PROJ_A1', '$H1');" 2>&1)
set -e
printf '%s' "$FC_OUT" | grep -q "does not exist" \
  || { echo "$FC_OUT"; fail "12: bind sigue alcanzable tras el rollback"; }
echo "  ok   bind es inalcanzable tras el rollback (fail-closed)"

# El eslabon siguiente tambien converge sobre la misma base liquidada.
printf '  %-52s ' "stella_0015_rollback"
"${PSQL[@]}" -1 -q -f "/stella_0015_rollback.sql" >/tmp/rb_$$ 2>&1 && echo "OK" || { echo "FAIL"; cat /tmp/rb_$$; exit 1; }
rm -f /tmp/rb_$$

# Y el de stella_0014 SE NIEGA, que es su proteccion de diseno y no un fallo del
# arnes: hay tickets `completed`, cada uno contraparte de un cargo en un ledger
# append-only, y soltar la tabla dejaria esos cargos sin atribuir y sus claves de
# idempotencia irrecuperables — un reintento recibiria un ticket NUEVO y se
# cobraria una SEGUNDA vez.
#
# Se afirma la negativa porque es la propiedad que importa: el rollback de este
# tren no debilita la que el tren anterior instalo.
set +e
RB14=$("${PSQL[@]}" -1 -q -f "/stella_0014_rollback.sql" 2>&1)
RB14_ST=$?
set -e
[ "$RB14_ST" -ne 0 ] || fail "12: stella_0014_rollback NO se nego sobre una base con tickets completed"
printf '%s' "$RB14" | grep -q "completed ticket(s) exist" \
  || { echo "$RB14"; fail "12: stella_0014_rollback fallo por una razon distinta de los tickets liquidados"; }
echo "  ok   stella_0014_rollback se niega ante tickets completed, como debe"

assert_eq "12 el ledger sobrevive a los rollbacks" "$CHARGES_BEFORE" \
  "$(Q "SELECT count(*) FROM public.stella_interactions")"
assert_eq "12 los tickets liquidados siguen ahi" "$TICKETS_BEFORE" \
  "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets")"

# --------------------------------------------------------------------------
say "13. Rollback sobre una base LIMPIA — retorno EXACTO al baseline"
# --------------------------------------------------------------------------
# Una base que nunca cobro nada, porque el ledger es append-only y una fila
# cobrada no puede retirarse: medir el retorno EXACTO al baseline exige una base
# que nunca vendio una unidad. Son dos experimentos y hacen falta dos bases —
# el §12 midio el otro.
restore_baseline
CLEAN=$(state)
assert_eq "13 el baseline vuelve a ser el mismo" "$BASELINE" "$CLEAN"
apply_forward "${FORWARD[@]}"
seed_fixture
assert_eq "13 la cadena reaplica sobre limpio" "$APPLIED" "$(state)"

# 13a. Rollback sin ningun ticket, y la REAPLICACION que exige.
#
# El rollback DROPEA bind y complete en vez de revertirlos, asi que volver a
# aplicar stella_0016 exige reaplicar stella_0015 primero — y stella_0016 §0 lo
# EXIGE, no lo sugiere: se niega a instalarse si las firmas de tres argumentos
# no estan, precisamente para no ser nunca el paquete que las acuna. Se mide la
# negativa antes de obedecerla, para que la precondicion no sea una afirmacion
# sin comprobar.
printf '  %-52s ' "0016 rollback sin tickets"
"${PSQL[@]}" -1 -q -f "/stella_0016_rollback.sql" >/dev/null 2>&1 && echo "OK" || { echo "FAIL"; exit 1; }
if "${PSQL[@]}" -1 -q -f "/stella_0016_reserved_quota_semantics.sql" >/dev/null 2>/dev/null; then
  fail "13a: stella_0016 se aplico sin bind/complete de tres argumentos"
fi
echo "  ok   stella_0016 se niega a acunar las firmas que no le pertenecen"
apply_forward stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics

# 13b. Rollback con un ticket ISSUED y otro BOUND — reservas vivas de verdad.
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q >/dev/null <<SQL || fail "13b: no se pudo preparar el estado"
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', false);
SET ROLE uellix_app;
DO \$s\$
DECLARE t char(64);
BEGIN
  PERFORM uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  PERFORM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', '$H1');
END
\$s\$;
RESET ROLE;
SQL
LIVE_BEFORE=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE status='bound' AND expires_at > timezone('UTC', now())")
assert_eq "13b hay una reserva viva" "1" "$LIVE_BEFORE"
set +e
RB2=$("${PSQL[@]}" -1 -q -f "/stella_0016_rollback.sql" 2>&1)
RB2_ST=$?
set -e
[ "$RB2_ST" -eq 0 ] || { echo "$RB2"; fail "13b: el rollback fallo con una reserva viva"; }
printf '%s' "$RB2" | grep -q "live reservation" \
  || { echo "$RB2"; fail "13b: el rollback no reporto la reserva viva"; }
echo "  ok   el rollback reporta la reserva viva y NO la borra"
assert_eq "13b los dos tickets siguen ahi" "2" \
  "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets")"

# 13c. REAPLICACION IDENTICA — y sobre un estado con tickets, no sobre vacio.
apply_forward stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics
assert_eq "13c la reaplicacion devuelve el mismo estado" "$APPLIED" "$(state)"
assert_eq "13c period_month se recalcula para el ticket bound" "1" \
  "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE period_month = date_trunc('month', timezone('UTC', now()))")"
# ...y la segunda aplicacion del MISMO paquete converge en vez de fallar.
apply_forward stella_0016_reserved_quota_semantics
assert_eq "13c doble aplicacion converge" "$APPLIED" "$(state)"

# 13d. La cadena entera vuelve a ser reaplicable: stella_0013 sigue siendo
#      idempotente sobre un esquema al que este paquete anadio tres funciones.
apply_forward stella_0013_grounded_query_quota
assert_eq "13d stella_0013 reaplica sobre stella_0016" "$APPLIED" "$(state)"

# --------------------------------------------------------------------------
say "14. Guarda de orden — stella_0015 NO puede reaplicarse sobre stella_0016"
# --------------------------------------------------------------------------
# Es el mismo riesgo que R2a un tren antes, en la otra direccion: stella_0015 es
# idempotente por diseno, asi que reaplicarlo SOLO republicaria bind y complete
# con la aritmetica que cuenta unicamente filas cobradas — R1, instalado al lado
# de su propio arreglo.
#
# Ningun SQL puede impedir que otro SQL se ejecute despues. Eso se afirma sobre
# el RUNNER: db/prepared-package-order.ts lo registra y db/migrator.ts lo
# rechaza DENTRO de la transaccion que lo aplicaria. Aqui se mide la premisa —
# que reaplicarlo de verdad reintroduce el defecto — para que el registro no sea
# una precaucion sin medir.
"${PSQL[@]}" -1 -q -f "/stella_0015_project_bound_operation_tickets.sql" >/dev/null 2>&1 \
  || fail "14: stella_0015 no se aplico sobre stella_0016"
REGRESSED=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='bind_operation_ticket' AND position('stella_capacity' in pg_get_functiondef(p.oid)) = 0")
assert_eq "14 reaplicar 0015 SI reintroduce R1" "1" "$REGRESSED"
echo "  ok   la premisa del registro de supersesiones queda medida"
# Se repara reaplicando 0016, para que el teardown mida lo que debe.
apply_forward stella_0016_reserved_quota_semantics
assert_eq "14 stella_0016 vuelve a cerrarlo" "$APPLIED" "$(state)"

# --------------------------------------------------------------------------
say "15. Teardown"
# --------------------------------------------------------------------------
for f in "${ROLLBACKS[@]}"; do
  printf '  %-52s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/tmp/rb_$$ 2>&1; then echo "OK"; else echo "FAIL"; cat /tmp/rb_$$; exit 1; fi
  rm -f /tmp/rb_$$
done
FINAL=$(state)
assert_eq "15 retorno EXACTO al baseline" "$BASELINE" "$FINAL"
assert_eq "15 cero roles de capacidad residuales" "0" \
  "$(Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix_cap\\_stella%'")"

echo
printf '\033[1m%s\033[0m\n' "STELLA_RESERVED_QUOTA_DRY_RUN_OK"
echo "  baseline  : $BASELINE"
echo "  0013..0015: $BASE_STATE"
echo "  0013..0016: $APPLIED"
echo "  revertido : $FINAL"
