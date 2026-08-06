#!/usr/bin/env bash
# scripts/stella-category-binding-dry-run.sh
# INTEGRACIÓN — Tren 4.3, CIERRE DE EVIDENCIA. El ensayo de stella_0018 contra
# una base REAL, desechable y sin red.
#
# ---------------------------------------------------------------------------
# QUÉ MIDE, Y POR QUÉ EL CONTROL NEGATIVO ES LA MITAD DEL GUION
# ---------------------------------------------------------------------------
# Un arnés que sólo midiera el estado final cerraría un hueco que nadie vio
# abierto. El §5 REPRODUCE R6a y R6b sobre la cadena 0013…0017 —la que el tren
# 4.3 dejó instalada— antes de que el §6 los cierre:
#
#   R6a  un ticket emitido para `advisor`, ligado y completado por la ruta
#        GROUNDED (verbo de tres argumentos), termina en `completed` y deja una
#        fila con `stella_role = 'advisor'` para una consulta fundamentada. La
#        tabla es append-only: esa atribución no se puede corregir después.
#
#   R6b  `consume_stella_capacity(org, project, 'composer', <64 hex a
#        elección>)` como `uellix_app` devuelve `consumed` con CERO tickets
#        emitidos — categoría e identidad elegidas por el llamante.
#
# El §7 vuelve a intentar exactamente lo mismo con stella_0018 aplicado y mide
# `U0112` y `42501`. El §10 comprueba que los tres paquetes anteriores ya no
# pueden reaplicarse, y el §11 que el rollback devuelve la base al estado que
# stella_0017 deja —reabriendo los dos defectos, que es lo que un rollback de
# este paquete significa y por eso se dice.
#
# ---------------------------------------------------------------------------
# AISLAMIENTO
# ---------------------------------------------------------------------------
# `--network none`: todo se conduce con `docker exec psql` DENTRO del
# contenedor, así que no hay interfaz por la que salir y ningún proveedor
# externo puede ser llamado. Cero volúmenes (`docker run` sin `-v` y sin
# `--mount`), y se AFIRMA sobre el contenedor real en vez de sobre la línea que
# lo creó. El contenedor se destruye en el trap de salida, pase o falle.
#
# No toca ningún stack persistente y no publica ningún puerto.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_0018_verify_$$"
BASE_DIR="db/baseline"
CHAIN=(stella_0013_grounded_query_quota stella_0014_operation_tickets stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics stella_0017_governed_stella_consumption)
PKG=stella_0018_category_bound_operation_tickets

USER_A='99999999-9999-9999-9999-999999999981'
ORG_A='99999999-9999-9999-9999-9999999999a1'
PROJ_A1='99999999-9999-9999-9999-9999999999b1'
H1=$(printf 'a%.0s' $(seq 1 64))
H2=$(printf 'b%.0s' $(seq 1 64))
H3=$(printf 'c%.0s' $(seq 1 64))

FAILED=0
cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }
assert_eq() { if [ "$2" = "$3" ]; then printf '  ok   %-58s %s\n' "$1" "$3"; else printf '  FAIL %-58s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; FAILED=1; fi; }

say "0. contenedor desechable sin red"
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
[ "$ok" -ge 3 ] || { docker logs --tail 20 "$BOX"; fail "no arrancó"; }
[ "$(docker inspect -f '{{len .Mounts}}' "$BOX")" = "0" ] || fail "tiene montajes"

say "1. restore del baseline"
for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f" >/dev/null
done
for f in "${CHAIN[@]}" "$PKG" stella_0018_rollback; do docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql" >/dev/null; done

docker exec "$BOX" psql -U supabase_admin -d template1 -q -c \
  "UPDATE pg_database SET datallowconn=false WHERE datname='postgres'" >/dev/null
for _ in $(seq 1 15); do
  docker exec "$BOX" psql -U supabase_admin -d template1 -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid()" >/dev/null 2>&1 || true
  docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
    "DROP DATABASE IF EXISTS postgres" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE postgres TEMPLATE template0 OWNER postgres" >/dev/null
"${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null 2>&1 || fail "roles"
"${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null 2>&1 || fail "schema"
"${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null 2>&1 || fail "post-restore"

say "2. 0018 SIN su cadena: debe abortar"
if "${PSQL[@]}" -1 -q -f "/$PKG.sql" >/dev/null 2>/dev/null; then
  echo "  FAIL 0018 se aplicó sin la cadena"; FAILED=1
else
  echo "  ok   0018 sin la cadena aborta"
fi

say "3. cadena 0013…0017"
for f in "${CHAIN[@]}"; do
  printf '  %-52s ' "$f"
  "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/e0018 && echo OK || { echo FAIL; cat /tmp/e0018; exit 1; }
done

say "4. siembra"
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "siembra"
SET ROLE uellix_owner;
INSERT INTO public.users (id, email) VALUES ('$USER_A','v0018@example.invalid');
INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES ('$ORG_A','Org 0018','org-0018',50);
INSERT INTO public.organization_members (organization_id,user_id,role,status) VALUES ('$ORG_A','$USER_A','analyst','active');
INSERT INTO public.projects (id,organization_id,name,created_by) VALUES ('$PROJ_A1','$ORG_A','Proj 0018','$USER_A');
SQL

say "5. ANTES de 0018 — R6a y R6b abiertos (control negativo)"
R=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$r\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A','$PROJ_A1','advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t,'$PROJ_A1','$H1');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t,'$PROJ_A1','$H1');
  RAISE NOTICE 'RESULT r6a=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT r6a=%', SQLSTATE; END \$r\$;
DO \$s\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity('$ORG_A','$PROJ_A1','composer','$H2');
  RAISE NOTICE 'RESULT r6b=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT r6b=%', SQLSTATE; END \$s\$;
DO \$t\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota('$ORG_A','$PROJ_A1','composer','$H3');
  RAISE NOTICE 'RESULT r6b_quota=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT r6b_quota=%', SQLSTATE; END \$t\$;
ROLLBACK;
SQL
)
assert_eq "R6a abierto antes (advisor cobrado por ruta grounded)" "completed" "$(echo "$R" | sed -n 's/.*RESULT r6a=\([^ ]*\).*/\1/p' | head -1)"
assert_eq "R6b abierto antes (consumo sin ticket)"                "consumed"  "$(echo "$R" | sed -n 's/.*RESULT r6b=\([^ ]*\).*/\1/p' | head -1)"
# La OTRA superficie, y es la que importaba. `consume_stella_capacity` es la
# envoltura de stella_0016 y nunca tuvo llamante; `consume_stella_quota` es la
# que esa envoltura LLAMA, está concedida a uellix_app por stella_0013 §7, y
# ningún paquete de la cadena 0014→0017 la retira. Cuenta SÓLO filas cobradas,
# así que además de no tener ticket es ciega a una reserva viva.
assert_eq "R6b abierto antes (cargo sin ticket ni reserva)"       "consumed"  "$(echo "$R" | sed -n 's/.*RESULT r6b_quota=\([^ ]*\).*/\1/p' | head -1)"

say "6. stella_0018"
printf '  %-52s ' "$PKG"
"${PSQL[@]}" -1 -q -f "/$PKG.sql" >/dev/null 2>/tmp/e0018 && echo OK || { echo FAIL; cat /tmp/e0018; exit 1; }

say "6b. reaplicación idéntica (idempotencia)"
"${PSQL[@]}" -1 -q -f "/$PKG.sql" >/dev/null 2>/tmp/e0018b && echo "  ok   reaplica" || { echo "  FAIL"; cat /tmp/e0018b; FAILED=1; }

say "7. DESPUÉS de 0018 — R6a cerrado en SQL"
R=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;
DO \$r\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A','$PROJ_A1','advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t,'$PROJ_A1','$H1','grounded_query');
  RAISE NOTICE 'RESULT cruce=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT cruce=%', SQLSTATE; END \$r\$;
DO \$b\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A','$PROJ_A1','grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t,'$PROJ_A1','$H1','grounded_query');
  RAISE NOTICE 'RESULT propio_bind=%', r.outcome;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t,'$PROJ_A1','$H1');
  RAISE NOTICE 'RESULT propio_complete=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT propio=%', SQLSTATE; END \$b\$;
DO \$c\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A','$PROJ_A1','advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t,'$PROJ_A1','$H1');
  RAISE NOTICE 'RESULT bind_sin_categoria=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT bind_sin_categoria=%', SQLSTATE; END \$c\$;
DO \$d\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A','$PROJ_A1','advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t,'$PROJ_A1','$H1','no_such_capability');
  RAISE NOTICE 'RESULT vocabulario=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT vocabulario=%', SQLSTATE; END \$d\$;
DO \$e\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_capacity('$ORG_A','$PROJ_A1','composer','$H2');
  RAISE NOTICE 'RESULT r6b=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT r6b=%', SQLSTATE; END \$e\$;
DO \$f\$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota('$ORG_A','$PROJ_A1','composer','$H3');
  RAISE NOTICE 'RESULT r6b_quota=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT r6b_quota=%', SQLSTATE; END \$f\$;
DO \$g\$
DECLARE t char(64); r record;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A','$PROJ_A1','advisor');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t,'$PROJ_A1','$H1',NULL);
  RAISE NOTICE 'RESULT categoria_nula=%', r.outcome;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT categoria_nula=%', SQLSTATE; END \$g\$;
ROLLBACK;
SQL
)
echo "$R" | grep -E 'RESULT' | sed 's/^/    /'
g() { echo "$R" | sed -n "s/.*RESULT $1=\([^ ]*\).*/\1/p" | head -1; }
assert_eq "cruce de categoría rechazado en bind"            "U0112"  "$(g cruce)"
assert_eq "la categoría propia sigue ligando"               "bound"  "$(g propio_bind)"
assert_eq "...y sigue completando"                          "completed" "$(g propio_complete)"
assert_eq "bind sin categoría fuera del alcance del runtime" "42501"  "$(g bind_sin_categoria)"
assert_eq "categoría fuera del vocabulario"                 "U0106"  "$(g vocabulario)"
assert_eq "R6b cerrado: consumo sin ticket rechazado"       "42501"  "$(g r6b)"
assert_eq "R6b cerrado: cargo sin ticket ni reserva"        "42501"  "$(g r6b_quota)"
# La ruta que el PRIMER BORRADOR de stella_0018 dejaba abierta, y que la revisión
# adversarial A nombró: bind(t, proj, hash, NULL) ES el bind sin comprobación, y
# uellix_app tiene EXECUTE sobre la firma de cuatro argumentos. Retirar la de
# tres no cierra nada mientras la de cuatro acepte NULL.
assert_eq "categoría NULA rechazada"                        "U0100"  "$(g categoria_nula)"

say "8. reserva liberada — un cruce no consume nada"
assert_eq "tickets ligados tras el cruce" "0" "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE status='bound'")"

say "9. superficie EXECUTE tras 0018"
assert_eq "uellix_app -> bind 4 args"        "t" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)','EXECUTE')")"
assert_eq "uellix_app -> bind 3 args"        "f" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella_ops.bind_operation_ticket(character, uuid, character)','EXECUTE')")"
assert_eq "uellix_app -> consume_capacity"   "f" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)','EXECUTE')")"
assert_eq "uellix_app -> consume_quota"      "f" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)','EXECUTE')")"
assert_eq "funciones en uellix_stella_ops"   "8" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
assert_eq "PUBLIC no ejecuta nada"           "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a WHERE n.nspname IN ('uellix_stella','uellix_stella_ops') AND a.grantee=0")"

say "10. 0015/0016/0017 no pueden reaplicarse sobre 0018"
for f in stella_0015_project_bound_operation_tickets stella_0016_reserved_quota_semantics stella_0017_governed_stella_consumption; do
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/dev/null; then
    echo "  FAIL $f se reaplicó sobre 0018"; FAILED=1
  else
    echo "  ok   $f aborta sobre 0018"
  fi
done

say "11. rollback y reaplicación"
"${PSQL[@]}" -1 -q -f "/stella_0018_rollback.sql" >/dev/null 2>/tmp/e0018r && echo "  ok   rollback" || { echo "  FAIL rollback"; cat /tmp/e0018r; FAILED=1; }
assert_eq "tras rollback: 7 funciones"       "7" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
assert_eq "tras rollback: uellix_app -> bind 3 args" "t" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella_ops.bind_operation_ticket(character, uuid, character)','EXECUTE')")"
assert_eq "tras rollback: R6b reabierto"     "t" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)','EXECUTE')")"
assert_eq "tras rollback: el cargo directo vuelve" "t" "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)','EXECUTE')")"
"${PSQL[@]}" -1 -q -f "/$PKG.sql" >/dev/null 2>/tmp/e0018x && echo "  ok   reaplica tras rollback" || { echo "  FAIL"; cat /tmp/e0018x; FAILED=1; }
"${PSQL[@]}" -1 -q -f "/stella_0018_rollback.sql" >/dev/null 2>&1 && echo "  ok   rollback idempotente" || { echo "  FAIL rollback idempotente"; FAILED=1; }

say "12. teardown"
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker ps -a --format '{{.Names}}' | grep -qx "$BOX" && fail "sobrevivió" || echo "  ok contenedor eliminado"

[ "$FAILED" = "0" ] && echo "
RESULTADO: TODAS LAS ASERCIONES PASAN" || { echo "
RESULTADO: HAY FALLOS"; exit 1; }
