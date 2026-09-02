#!/usr/bin/env bash
# scripts/stella-ticket-dry-run.sh
#
# Aplica, INVOCA, ataca, revierte y REAPLICA la cadena
#   stella_0013 -> stella_0014 -> stella_0015
# en un contenedor DESECHABLE restaurado desde db/baseline/. Deriva los
# conteos; no los asume.
#
# TREN 4.2 — R2-INT. El arnés se aplica en DOS etapas a propósito: con
# stella_0014 instalado y stella_0015 todavía no, el §7b REPRODUCE la
# atribución cross-proyecto contra las funciones reales (ticket del proyecto
# A1, trabajo bajo el proyecto A2 de la MISMA organización, cargo archivado en
# A1). Sólo después se aplica stella_0015 y se vuelve a ejecutar la misma
# secuencia, que ahora se rechaza con U0110 y cobra cero.
#
# POR QUÉ ES UN ARNÉS APARTE Y NO UNA ETAPA DE stella-train4-dry-run.sh
#   Aquel afirma conteos EXACTOS del estado del tren 4 — «7 funciones en
#   uellix_grounding + uellix_stella», «todas SECURITY DEFINER», «todas
#   propiedad de un rol cap». Añadir seis funciones, una tabla, dos triggers y
#   tres policies desplazaría todas esas cifras y con ellas la evidencia de gate
#   que la línea ya produjo. Un arnés hermano mide lo nuevo sin reescribir lo ya
#   medido — el mismo argumento que stella-train4-dry-run.sh hace frente a
#   grounding-dry-run.sh, un tren antes.
#
# QUÉ HACE QUE ESTO NO SEA UNA INSPECCIÓN DE ESTRUCTURA
#   El bloqueo INT-INT-001 se REPRODUCE con llamadas reales antes de cerrarlo:
#   se demuestra que un uuid por invocación cobra DOS veces el mismo reintento y
#   que un digest de la consulta deja GRATIS la segunda pregunta legítima. Sólo
#   después se ejerce el protocolo: se emiten tickets, se reintentan, se
#   reutilizan con otro texto, se abortan, se dejan expirar y se disputan entre
#   dos sesiones concurrentes. Los ataques cross-organization, cross-project,
#   cross-actor y de OWNER se EJECUTAN.
#
# QUÉ NO TOCA
#   Nada persistente. Sin stack, sin volumen montado, sin puertos, sin red
#   (`--network none`). El contenedor se destruye en el trap de salida, pase o
#   falle. db/baseline/** se lee, nunca se escribe.
#
#   bash scripts/stella-ticket-dry-run.sh
#
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix_ticket_dry_run_$$"
BASE_DIR="db/baseline"

# La cadena, en dos etapas. BASE es el estado que R2-INT reporta; FORWARD es la
# cadena completa. El §7b mide el defecto sobre BASE antes de que FORWARD lo
# cierre — un arnés que sólo midiera el estado final cerraría un hueco que
# nadie vio abierto.
FORWARD_BASE=(stella_0013_grounded_query_quota stella_0014_operation_tickets)
FORWARD=(stella_0013_grounded_query_quota stella_0014_operation_tickets stella_0015_project_bound_operation_tickets)
# Orden inverso, y el propio SQL lo impone en los tres extremos: stella_0014 se
# niega a aplicarse sin consume_stella_quota, stella_0015 se niega sin la tabla
# de tickets, y el rollback de stella_0014 no puede soltar el rol mientras las
# cuatro funciones de stella_0015 sigan siendo suyas. El rollback de stella_0013
# suelta el esquema uellix_stella en cuanto no le quedan funciones — así que el
# de 0014 tiene que retirarlas antes.
ROLLBACKS=(stella_0015_rollback stella_0014_rollback stella_0013_rollback)

# Identidades fijas de la siembra. Fuera de las funciones para que las
# aserciones de bash y el SQL no puedan discrepar sobre a quién se refieren.
USER_A='99999999-9999-9999-9999-999999999951'
USER_B='99999999-9999-9999-9999-999999999952'
ORG_A='11111111-1111-1111-1111-111111111151'
ORG_B='11111111-1111-1111-1111-111111111152'
PROJ_A1='22222222-2222-2222-2222-222222222251'
PROJ_B='22222222-2222-2222-2222-222222222252'
# El SEGUNDO proyecto de la MISMA organización. Es la pieza que R2-INT necesita
# y que el tren 4.1 no tenía: el ataque cross-proyecto no cruza ninguna
# frontera de organización ni de actor, así que un fixture con un proyecto por
# organización no puede expresarlo.
PROJ_A2='22222222-2222-2222-2222-222222222253'

# Digests de consulta. Constantes del arnés, NUNCA texto enviado a la base: la
# canonicalización vive en la aplicación (contrato
# docs/ops/contracts/INT-INT-001_operation_ticket_protocol.md) y lo único que
# cruza la frontera es el digest. H1 y H2 son dos preguntas distintas; H1 se usa
# además para DOS operaciones distintas, que es exactamente la distinción que
# INT-INT-001 dice que hoy no se puede trazar.
H1='1111111111111111111111111111111111111111111111111111111111111111'
H2='2222222222222222222222222222222222222222222222222222222222222222'
H3='3333333333333333333333333333333333333333333333333333333333333333'
H4='4444444444444444444444444444444444444444444444444444444444444444'

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; }
trap cleanup EXIT

hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }
PSQL=(docker exec "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
Q() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

# Un id sembrado que cruza a SQL tiene que ser EXACTAMENTE 64 hex, y por eso se
# VALIDA aqui en vez de confiarse.
#
# `-q` no es cosmetico: sin el, psql imprime el tag `INSERT 0 1` DESPUES de la
# fila de RETURNING, y quedarse con la ultima linea devuelve el tag. Un id
# invalido hace que todo ataque de aislamiento muera con U0100 «malformado» — que
# PASA, por las razones equivocadas, dejando el ataque sin ejecutar. Un arnes que
# se equivoca hacia el verde es peor que uno que no existe.
seed_ticket() {
  local v
  v=$(docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -v ON_ERROR_STOP=1 -c "$1" | tail -1 | tr -d '[:space:]')
  [[ "$v" =~ ^[0-9a-f]{64}$ ]] || fail "seed_ticket: id sembrado con forma inesperada (longitud ${#v}): '$v'"
  printf '%s' "$v"
}

assert_eq() {
  if [ "$2" = "$3" ]; then printf '  ok   %-52s %s\n' "$1" "$3"
  else printf '  FAIL %-52s esperado=%s obtenido=%s\n' "$1" "$2" "$3"; exit 1; fi
}

# El vector de estado que se compara entre "aplicado", "revertido" y
# "reaplicado". Se cuentan OBJETOS, no filas: el ledger es append-only, así que
# una fila cobrada no puede retirarse y comparar filas haría que el retorno al
# baseline dependiera de qué pruebas corrieron antes.
#
# La NOVENA componente es de este tren. Sin ella el vector no distingue
# «stella_0014 aplicado» de «stella_0014 + stella_0015 aplicados»: las dos
# publican SEIS funciones en uellix_stella_ops. Un vector que no distingue los
# dos estados no puede afirmar nada sobre el retorno al baseline de un paquete
# que sólo cambia firmas.
state() {
  printf '%s/%s/%s/%s/%s/%s/%s/%s/%s' \
    "$(Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix_cap\\_%'")" \
    "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname IN ('uellix_stella','uellix_stella_ops')")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")" \
    "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='uellix_stella_ops'")" \
    "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='uellix_stella_ops'")" \
    "$(Q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='uellix_stella_ops' AND NOT t.tgisinternal")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'uellix\\_check\\_operation%'")" \
    "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND pg_get_function_arguments(p.oid) LIKE '%p\\_expected\\_project\\_id uuid%'")"
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
# que esas filas no se pueden retirar. Medir el retorno EXACTO al baseline exige
# por tanto una base que nunca cobró — y demostrar que el rollback SE NIEGA
# sobre una que sí liquidó exige una que sí. Son dos experimentos y hacen falta
# dos bases.
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
  # lleva. Esto NO debilita la aserción del §14: allí el retorno al baseline lo
  # producen los ROLLBACKS, sin limpieza del arnés. Aquí sólo se restablece el
  # punto de partida.
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
    printf '  %-46s ' "$f"
    if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/tkerr_$$; then echo "OK"
    else echo "FAIL"; cat /tmp/tkerr_$$; exit 1; fi
  done
}

# Dos organizaciones, dos proyectos, dos actores, y una pertenencia ACTIVA sólo
# de cada usuario en SU organización. La asimetría es el punto: todo ataque
# cross-tenant de abajo se ejecuta con la sesión de A.
#
# ORG_A arranca con cuota 2 — suficiente para cobrar dos operaciones legítimas
# con el MISMO texto y quedarse sin nada para la tercera, que es la secuencia
# que discrimina el protocolo de todos sus sustitutos.
seed_fixture() {
docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL >/dev/null || fail "la siembra falló"
SET ROLE uellix_owner;

INSERT INTO public.users (id, email) VALUES
  ('$USER_A', 'ticket-a@example.invalid'),
  ('$USER_B', 'ticket-b@example.invalid');

INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
  ('$ORG_A', 'Org Ticket A', 'org-ticket-a', 2),
  ('$ORG_B', 'Org Ticket B', 'org-ticket-b', 50);

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ('$ORG_A', '$USER_A', 'analyst', 'active'),
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
echo "  (roles cap/esquemas/fn uellix_stella/fn uellix_stella_ops/tablas/policies/triggers/trigger fn en public/firmas con proyecto)"
assert_eq "rol uellix_cap_stella_ticket ausente" "0" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_stella_ticket'")"
assert_eq "esquema uellix_stella ausente"        "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_stella'")"
assert_eq "esquema uellix_stella_ops ausente"    "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_stella_ops'")"

# --------------------------------------------------------------------------
say "4. El orden forward está impuesto por el SQL, no por este script"
# --------------------------------------------------------------------------
# stella_0014 PRIMERO, a propósito: debe abortar por sí solo. Si pasara, el
# resto del arnés estaría midiendo un orden que nada obliga a respetar — y peor,
# un paquete que instala el protocolo entero y no puede cobrar nada, que es
# exactamente la clase de fallo invisible que INT-CAP-001 reportó un tren antes.
if "${PSQL[@]}" -1 -q -f "/stella_0014_operation_tickets.sql" >/dev/null 2>/dev/null; then
  fail "stella_0014 se aplicó SIN stella_0013 — su guarda de dependencia no obliga"
fi
echo "  ok   stella_0014 sin stella_0013 aborta, como debe"

# El mismo argumento un eslabón más allá: stella_0015 no crea la tabla de
# tickets, la CONSTRIÑE. Aplicado sobre una base sin stella_0014 dejaría cuatro
# funciones gobernadas apuntando a una tabla que no existe — instaladas,
# concedidas y muertas.
if "${PSQL[@]}" -1 -q -f "/stella_0015_project_bound_operation_tickets.sql" >/dev/null 2>/dev/null; then
  fail "stella_0015 se aplicó SIN stella_0014 — su guarda de dependencia no obliga"
fi
echo "  ok   stella_0015 sin stella_0014 aborta, como debe"

# --------------------------------------------------------------------------
say "5. Etapa 1 — stella_0013 + stella_0014: el estado que R2-INT reporta"
# --------------------------------------------------------------------------
apply_forward "${FORWARD_BASE[@]}"
BASE_STATE=$(state)
echo "  estado con 0013+0014: $BASE_STATE"
seed_fixture

# --------------------------------------------------------------------------
say "5b. REPRODUCCIÓN de R2-INT — antes de cerrarlo"
# --------------------------------------------------------------------------
# El ticket se emite para el proyecto A1. La capa de aplicación se ejecuta bajo
# el proyecto A2 de la MISMA organización — alcanzable porque cada export de un
# módulo 'use server' es un endpoint invocable por separado, así que el ticket
# acuñado en la superficie de A1 puede presentarse a la acción montada sobre
# A2. Ni bind ni complete reciben proyecto, así que la base no tiene con qué
# comparar y el cargo se archiva bajo A1.
#
# Se mide DENTRO de la transacción y se revierte: el ledger es append-only y
# esta fila no debe sobrevivir a la reproducción.
set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

DO \$r2\$
DECLARE t char(64); r record; v_charged uuid; n int;
BEGIN
  t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');

  -- La aplicación cree estar trabajando sobre A2. La base no se entera.
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$H1');
  RAISE NOTICE 'RESULT r2int_bind_bajo_a2=%', r.outcome;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t, '$H1');
  RAISE NOTICE 'RESULT r2int_complete_bajo_a2=%', r.outcome;

  SELECT si.project_id INTO v_charged FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A' AND si.stella_role = 'grounded_query'
   ORDER BY si.created_at DESC LIMIT 1;
  RAISE NOTICE 'RESULT r2int_cargo_en_proyecto_del_ticket=%', (v_charged = '$PROJ_A1')::text;
  RAISE NOTICE 'RESULT r2int_cargo_en_proyecto_del_trabajo=%', (v_charged = '$PROJ_A2')::text;

  -- Y las otras dos verbos tampoco distinguen: un ticket de A1 es inspeccionable
  -- y abortable desde la superficie de A2.
  SELECT * INTO r FROM uellix_stella_ops.inspect_operation_ticket(t);
  RAISE NOTICE 'RESULT r2int_inspect_bajo_a2=%', r.status;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'uellix_stella_ops'
     AND p.proname IN ('bind_operation_ticket','complete_operation_ticket',
                       'abort_operation_ticket','inspect_operation_ticket')
     AND pg_get_function_arguments(p.oid) LIKE '%project%';
  RAISE NOTICE 'RESULT r2int_firmas_con_proyecto=%', n;
END \$r2\$;

ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
[ "$LIVE_STATUS" -eq 0 ] || { echo "$LIVE_OUT"; fail "5b: el script SQL terminó con código $LIVE_STATUS"; }
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

LIVE_OUT="$LIVE_OUT"
check_result() {
  local name="$1" expected_pattern="$2" line
  line=$(echo "$LIVE_OUT" | grep -oE "RESULT ${name}=[A-Za-z0-9_|-]+" | tail -1)
  [ -n "$line" ] || fail "no se observó ningún resultado para '$name'"
  echo "$line" | grep -qE "$expected_pattern" \
    || fail "'$name' -> '$line', no coincide con lo esperado ($expected_pattern)"
  echo "  ok   $line"
}

check_result "r2int_bind_bajo_a2"                  "=bound$"
check_result "r2int_complete_bajo_a2"              "=completed$"
# EL DEFECTO, medido: el cargo cae en el proyecto del TICKET y no en el del
# TRABAJO. Se afirman los DOS lados — «cayó en A1» solo sería compatible con un
# fixture en el que A2 no existe.
check_result "r2int_cargo_en_proyecto_del_ticket"  "=true$"
check_result "r2int_cargo_en_proyecto_del_trabajo" "=false$"
check_result "r2int_inspect_bajo_a2"               "=completed$"
# Y la razón, en el catálogo: ninguna de las cuatro recibe un proyecto.
check_result "r2int_firmas_con_proyecto"           "=0$"
echo "  --> R2-INT reproducido: una unidad, la organización correcta, el proyecto EQUIVOCADO"

# --------------------------------------------------------------------------
say "5c. Etapa 2 — stella_0015, y la cadena completa dos veces (idempotencia)"
# --------------------------------------------------------------------------
PASS1=""
for pass in 1 2; do
  echo "  --- pase $pass ---"
  apply_forward "${FORWARD[@]}"
  S=$(state)
  echo "  estado tras pase $pass: $S"
  if [ "$pass" = "1" ]; then PASS1="$S"; fi
done
FORWARD_STATE=$(state)
[ "$PASS1" = "$FORWARD_STATE" ] || fail "no es idempotente: pase1=$PASS1 pase2=$FORWARD_STATE"
# Y el vector distingue las dos etapas. Sin esto, «vuelve al baseline» y
# «vuelve a la etapa 1» serían la misma afirmación.
[ "$BASE_STATE" != "$FORWARD_STATE" ] \
  || fail "el vector de estado no distingue 0014 de 0014+0015: $BASE_STATE"

# --------------------------------------------------------------------------
say "6. Superficie gobernada — aserciones estructurales"
# --------------------------------------------------------------------------
assert_eq "rol uellix_cap_stella_ticket"           "1" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_stella_ticket'")"
assert_eq "definer de ticket NOLOGIN"              "f" "$(Q "SELECT rolcanlogin FROM pg_roles WHERE rolname='uellix_cap_stella_ticket'")"
assert_eq "definer de ticket NOBYPASSRLS"          "f" "$(Q "SELECT rolbypassrls FROM pg_roles WHERE rolname='uellix_cap_stella_ticket'")"
assert_eq "definer de ticket NOINHERIT"            "f" "$(Q "SELECT rolinherit FROM pg_roles WHERE rolname='uellix_cap_stella_ticket'")"
assert_eq "miembros del definer de ticket"         "0" "$(Q "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='uellix_cap_stella_ticket'")"
# EL AISLAMIENTO DE ESQUEMA, medido. stella_0013 afirma en su §7 (4)/(5) que
# TODA función de `uellix_stella` es SECURITY DEFINER, con search_path vacío y
# propiedad de `uellix_cap_stella_quota`. Poner una sola de las seis ahí hace
# que stella_0013 ABORTE en su SEGUNDA aplicación — observado en el pase 2 de
# este mismo arnés, y la razón por la que existe uellix_stella_ops.
assert_eq "funciones en uellix_stella (sólo 0013)" "1" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella'")"
assert_eq "funciones en uellix_stella_ops"         "6" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
assert_eq "nada del ticket en el esquema de 0013"  "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella' AND pg_get_userbyid(p.proowner)='uellix_cap_stella_ticket'")"
assert_eq "todas SECURITY DEFINER"                 "6" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.prosecdef")"
# Se comprueba el VALOR, no la ortografía: PostgreSQL guarda `search_path = ''`
# como `search_path=""`.
assert_eq "todas con search_path vacio"            "6" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\\_path=%' AND btrim(split_part(cfg,'=',2),'\"') = '')")"
assert_eq "todas propiedad del rol de ticket"      "6" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND pg_get_userbyid(p.proowner)='uellix_cap_stella_ticket'")"
assert_eq "cero EXECUTE para PUBLIC"               "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname='uellix_stella_ops' AND a.grantee=0")"
assert_eq "policies sobre operation_tickets"       "3" "$(Q "SELECT count(*) FROM pg_policies WHERE schemaname='uellix_stella_ops' AND tablename='operation_tickets'")"
assert_eq "policies de DELETE"                     "0" "$(Q "SELECT count(*) FROM pg_policy WHERE polrelid='uellix_stella_ops.operation_tickets'::regclass AND polcmd='d'")"
assert_eq "triggers ENABLE ALWAYS"                 "2" "$(Q "SELECT count(*) FROM pg_trigger WHERE tgrelid='uellix_stella_ops.operation_tickets'::regclass AND NOT tgisinternal AND tgenabled='A'")"
assert_eq "CHECK sobre operation_tickets"          "8" "$(Q "SELECT count(*) FROM pg_constraint WHERE conrelid='uellix_stella_ops.operation_tickets'::regclass AND contype='c'")"
# La frontera que hace que «la única forma de cobrar es la función gobernada»
# sea un hecho sobre PRIVILEGIOS y no una afirmación sobre un cuerpo de función.
assert_eq "ticket role sin escritura en el ledger" "0" "$(Q "SELECT count(*) FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a JOIN pg_roles g ON g.oid=a.grantee WHERE c.oid='public.stella_interactions'::regclass AND g.rolname='uellix_cap_stella_ticket' AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')")"
# El nonce es lo que impide que quien tiene el ticket calcule la clave de cuota.
# Si algún principal de runtime pudiera leer la tabla, no serviría de nada.
assert_eq "ningún principal de runtime en la tabla" "0" "$(Q "SELECT count(*) FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a JOIN pg_roles g ON g.oid=a.grantee WHERE c.oid='uellix_stella_ops.operation_tickets'::regclass AND g.rolname IN ('uellix_app','authenticated','anon','service_role','uellix_writer','uellix_reader','uellix_auditor')")"
# NINGUNA función DEVUELVE el nonce ni el digest. Medido sobre el TIPO DE
# RETORNO, no sobre el texto del cuerpo: una revisión anterior de esta aserción
# contaba las funciones cuyo cuerpo MENCIONA `charge_nonce` y obtuvo 3 — porque
# `issue` lo escribe, `complete` lo lee y `bind` lo NOMBRA EN UN COMENTARIO.
# Contar menciones mide la prosa; lo que importa es qué sale por la frontera.
#
# El digest está aquí por la misma razón que el nonce: devolverlo dejaría a
# quien tiene un ticket confirmar una conjetura sobre la pregunta a la que está
# atado. `inspect` responde `has_query_hash`, nunca cuál.
#
# OFFSET 0 es una VALLA de optimización, no un adorno: sin ella el planificador
# puede evaluar la función de catálogo antes del join con pg_namespace y topar
# con un agregado, para el que `pg_get_functiondef` lanza. Medido.
#
# Los anclajes de PALABRA (\m … \M) son la diferencia entre medir y casi medir:
# `has_query_hash` CONTIENE `query_hash`, así que un LIKE '%query_hash%' marca
# como fuga precisamente la columna booleana que existe para NO serlo. `_` es
# carácter de palabra, de modo que \mquery_hash no casa dentro de
# has_query_hash — y sí casaría con una columna llamada `query_hash` a secas.
assert_eq "ninguna función devuelve el nonce"      "0" "$(Q "SELECT count(*) FROM (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' OFFSET 0) q WHERE pg_get_function_result(q.oid) ~ '\mcharge_nonce\M'")"
assert_eq "ninguna función devuelve el digest"     "0" "$(Q "SELECT count(*) FROM (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' OFFSET 0) q WHERE pg_get_function_result(q.oid) ~ '\mquery_hash\M'")"
# Y la firma de `inspect`, fijada: lo único que dice del digest es si existe.
assert_eq "inspect sólo expone un booleano del digest" "TABLE(status text, category character varying, expires_at timestamp without time zone, has_query_hash boolean)" "$(Q "SELECT pg_get_function_result(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='inspect_operation_ticket'")"
# ...y la única que LEE el nonce es la que deriva la clave de cuota con él.
assert_eq "sólo complete lee el nonce"             "complete_operation_ticket" "$(Q "SELECT string_agg(q.proname, ',' ORDER BY q.proname) FROM (SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' OFFSET 0) q WHERE pg_get_functiondef(q.oid) LIKE '%t.charge_nonce%'")"

# --- R2-INT: la firma publicada, leída del catálogo ------------------------
# Las cuatro firmas EXACTAS, no «alguna función que menciona proyecto». Una
# aserción sobre pg_get_function_arguments es la única que no puede ser
# satisfecha por un comentario ni por un cuerpo que reciba el argumento y lo
# ignore — para eso está, además, la aserción de cuerpo más abajo.
assert_eq "bind recibe el proyecto de ejecución"     "p_ticket_id character, p_expected_project_id uuid, p_query_hash character" "$(Q "SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='bind_operation_ticket'")"
assert_eq "complete recibe el proyecto de ejecución" "p_ticket_id character, p_expected_project_id uuid, p_query_hash character" "$(Q "SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='complete_operation_ticket'")"
assert_eq "abort recibe el proyecto de ejecución"    "p_ticket_id character, p_expected_project_id uuid, p_reason character varying" "$(Q "SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='abort_operation_ticket'")"
assert_eq "inspect recibe el proyecto de ejecución"  "p_ticket_id character, p_expected_project_id uuid" "$(Q "SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname='inspect_operation_ticket'")"
# NINGUNA firma antigua sobrevive. Un overload que no toma proyecto es un camino
# alrededor del arreglo, publicado al lado del arreglo.
assert_eq "cero overloads sin proyecto"            "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket','abort_operation_ticket','inspect_operation_ticket') AND pg_get_function_arguments(p.oid) NOT LIKE '%p\\_expected\\_project\\_id uuid%'")"
# ...y el argumento no tiene DEFAULT: la llamada de dos argumentos no resuelve,
# que es una propiedad de la FIRMA y no de una rama dentro del cuerpo.
# Sobre las CUATRO y no sobre el esquema: expire_operation_tickets(p_max
# integer DEFAULT 1000) es de stella_0014 y su default es legítimo — un tamaño
# de lote no decide a quién se cobra. Afirmarlo sobre el esquema entero medía
# otra cosa y fallaba por la razón equivocada.
assert_eq "el proyecto no tiene DEFAULT"           "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket','abort_operation_ticket','inspect_operation_ticket') AND p.pronargdefaults > 0")"
# El cuerpo COMPARA de verdad, y con el código gobernado propio.
assert_eq "las cuatro comparan y levantan U0110"   "4" "$(Q "SELECT count(*) FROM (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket','abort_operation_ticket','inspect_operation_ticket') OFFSET 0) q WHERE pg_get_functiondef(q.oid) LIKE '%v_project IS DISTINCT FROM p_expected_project_id%' AND pg_get_functiondef(q.oid) LIKE '%U0110%'")"
# El runtime alcanza las cuatro NUEVAS, y sólo por EXECUTE.
assert_eq "uellix_app ejecuta las cuatro nuevas"   "4" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket','abort_operation_ticket','inspect_operation_ticket') AND has_function_privilege('uellix_app', p.oid, 'EXECUTE')")"

# --------------------------------------------------------------------------
say "7. REPRODUCCIÓN del bloqueo INT-INT-001 — antes de cerrarlo"
# --------------------------------------------------------------------------
# Las dos candidatas que el ledger de contratos declara inservibles, EJECUTADAS
# contra la función real. Sin esto, el protocolo de abajo cerraría un hueco que
# nadie vio abierto.
set +e
REPRO_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

-- A. UUID POR INVOCACIÓN. Un reintento del servidor action recibe una clave
--    nueva porque nada le dice que es el mismo trabajo. Resultado: la MISMA
--    operación se cobra dos veces.
DO \$r1\$
DECLARE r record; n int;
BEGIN
  SELECT * INTO r FROM uellix_stella.consume_stella_quota(
    '$ORG_A', '$PROJ_A1', 'grounded_query',
    encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'));
  RAISE NOTICE 'RESULT repro_uuid_1=%', r.outcome;
  SELECT * INTO r FROM uellix_stella.consume_stella_quota(
    '$ORG_A', '$PROJ_A1', 'grounded_query',
    encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'));
  RAISE NOTICE 'RESULT repro_uuid_2=%', r.outcome;
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT repro_uuid_filas=%', n;
END \$r1\$;

ROLLBACK;
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

-- B. DIGEST DE (usuario, proyecto, consulta). Estable en el reintento — y
--    estable TAMBIÉN entre dos preguntas legítimas idénticas, así que la
--    segunda sale gratis. La prohibición explícita del despacho, medida.
DO \$r2\$
DECLARE r record; k char(64); n int;
BEGIN
  k := encode(sha256(convert_to('$USER_A' || '$PROJ_A1' || 'la misma pregunta', 'UTF8')), 'hex');
  SELECT * INTO r FROM uellix_stella.consume_stella_quota('$ORG_A', '$PROJ_A1', 'grounded_query', k);
  RAISE NOTICE 'RESULT repro_digest_1=%', r.outcome;
  SELECT * INTO r FROM uellix_stella.consume_stella_quota('$ORG_A', '$PROJ_A1', 'grounded_query', k);
  RAISE NOTICE 'RESULT repro_digest_2=%', r.outcome;
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT repro_digest_filas=%', n;
END \$r2\$;

ROLLBACK;
SQL
)
REPRO_STATUS=$?
set -e
[ "$REPRO_STATUS" -eq 0 ] || { echo "$REPRO_OUT"; fail "7: el script SQL terminó con código $REPRO_STATUS"; }
echo "$REPRO_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

LIVE_OUT="$REPRO_OUT"

# Dos `consumed` para UNA operación reintentada: el doble cobro, ejecutado.
check_result "repro_uuid_1"      "=consumed$"
check_result "repro_uuid_2"      "=consumed$"
check_result "repro_uuid_filas"  "=2$"
# `replayed` para una pregunta NUEVA con el mismo texto: la segunda, gratis.
check_result "repro_digest_1"    "=consumed$"
check_result "repro_digest_2"    "=replayed$"
check_result "repro_digest_filas" "=1$"
echo "  --> INT-INT-001 reproducido: ninguna fuente derivable del request traza la distinción"

# --------------------------------------------------------------------------
say "8. El protocolo de tickets — invocado, no inspeccionado"
# --------------------------------------------------------------------------
set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

DO \$p\$
DECLARE
  t1 char(64); t2 char(64); t3 char(64); t4 char(64);
  r  record;
  n  int;
BEGIN
  -- ---- Identidad opaca ------------------------------------------------
  t1 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  t2 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  RAISE NOTICE 'RESULT ticket_forma=%', (t1 ~ '^[0-9a-f]{64}\$')::text;
  RAISE NOTICE 'RESULT ticket_distintos=%', (t1 <> t2)::text;

  -- ---- Reservar --------------------------------------------------------
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT bind_1=%', r.outcome;

  -- Rebind idéntico: idempotente, NO una segunda reserva.
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT bind_repetido=%', r.outcome;

  -- Rebind con OTRO texto: el ticket no es reutilizable.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_A1', '$H2');
    RAISE NOTICE 'RESULT bind_otro_texto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT bind_otro_texto=%', SQLSTATE;
  END;

  -- Reservar no cobra. Ésta es la mitad del contrato que hace que una
  -- operación fallida no cueste nada: cuando falle, no habrá nada que devolver.
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT filas_tras_bind=%', n;

  -- ---- Completar -------------------------------------------------------
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT complete_1=%|%', r.outcome, r.used;

  -- REINTENTO de la MISMA operación: no cobra.
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT complete_reintento=%', r.outcome;

  -- Completar el mismo ticket con otro texto.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A1', '$H2');
    RAISE NOTICE 'RESULT complete_otro_texto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT complete_otro_texto=%', SQLSTATE;
  END;

  -- Abortar lo ya cobrado sería una compensación que el dinero nunca recibió.
  BEGIN
    PERFORM uellix_stella_ops.abort_operation_ticket(t1, '$PROJ_A1', 'caller_abort');
    RAISE NOTICE 'RESULT abort_completado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT abort_completado=%', SQLSTATE;
  END;

  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT filas_tras_reintentos=%', n;

  -- ---- Operación fallida: se aborta y NO cobra -------------------------
  -- ANTES de gastar la segunda unidad, a propósito: la organización A tiene
  -- cuota 2, y una reserva sólo es observable mientras quede margen. Ponerla
  -- después mediría un quota_exceeded y no un abort.
  t3 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t3, '$PROJ_A1', '$H3');
  RAISE NOTICE 'RESULT bind_fallida=%', r.outcome;
  RAISE NOTICE 'RESULT abort_fallida=%', uellix_stella_ops.abort_operation_ticket(t3, '$PROJ_A1', 'execution_failed');
  -- Abortar dos veces no es un error: un reintento tras una caída lo hará.
  RAISE NOTICE 'RESULT abort_idempotente=%', uellix_stella_ops.abort_operation_ticket(t3, '$PROJ_A1', 'execution_failed');
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t3, '$PROJ_A1', '$H3');
    RAISE NOTICE 'RESULT complete_tras_abort=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT complete_tras_abort=%', SQLSTATE;
  END;
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT filas_tras_fallo=%', n;

  -- ---- LA DISTINCIÓN. Pregunta NUEVA con el MISMO texto, otro ticket ----
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t2, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT bind_consulta_nueva=%', r.outcome;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t2, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT complete_consulta_nueva=%', r.outcome;
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT filas_dos_operaciones=%', n;

  -- ---- Cuota agotada: se refuta ANTES de ejecutar ----------------------
  -- La organización A tiene cuota 2 y lleva 2 cobradas. El bind se niega, así
  -- que la operación no llega a correr: no hay trabajo que regalar.
  t4 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t4, '$PROJ_A1', '$H4');
  RAISE NOTICE 'RESULT bind_sin_cuota=%|%|%', r.outcome, r.used, r.quota;
  -- Vía la funcion gobernada, no por SELECT directo: la tabla no esta concedida
  -- a uellix_app y una lectura directa aqui moriria con 42501 — que es
  -- exactamente lo que el §9 comprueba a proposito.
  SELECT * INTO r FROM uellix_stella_ops.inspect_operation_ticket(t4, '$PROJ_A1');
  RAISE NOTICE 'RESULT estado_tras_refuso=%', r.status;

  -- ---- Inspección: estado sí, secretos no ------------------------------
  SELECT * INTO r FROM uellix_stella_ops.inspect_operation_ticket(t1, '$PROJ_A1');
  RAISE NOTICE 'RESULT inspect_estado=%', r.status;
  RAISE NOTICE 'RESULT inspect_tiene_hash=%', r.has_query_hash::text;
END \$p\$;

-- El texto de la consulta nunca cruzó la frontera: la tabla no tiene una sola
-- columna capaz de guardarlo. Medido, no prometido.
DO \$p2\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_attribute a
   WHERE a.attrelid = 'uellix_stella_ops.operation_tickets'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.atttypid IN ('text'::regtype, 'json'::regtype, 'jsonb'::regtype, 'bytea'::regtype)
     AND a.attname <> 'status';
  RAISE NOTICE 'RESULT columnas_de_payload=%', n;
END \$p2\$;

ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
[ "$LIVE_STATUS" -eq 0 ] || { echo "$LIVE_OUT"; fail "8: el script SQL terminó con código $LIVE_STATUS"; }
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

check_result "ticket_forma"              "=true$"
check_result "ticket_distintos"          "=true$"
check_result "bind_1"                    "=bound$"
check_result "bind_repetido"             "=bound$"
check_result "bind_otro_texto"           "=U0107$"
check_result "filas_tras_bind"           "=0$"
check_result "complete_1"                "=completed\|1$"
check_result "complete_reintento"        "=replayed$"
check_result "complete_otro_texto"       "=U0107$"
check_result "abort_completado"          "=U0109$"
# UNA fila tras el reintento y los dos rechazos. Ésta es la propiedad entera.
check_result "filas_tras_reintentos"     "=1$"
check_result "bind_fallida"              "=bound$"
check_result "abort_fallida"             "=aborted$"
check_result "abort_idempotente"         "=aborted$"
# U0109 y no U0107: nunca se ató a otra pregunta, se abandonó. Codigos distintos
# para fallos distintos.
check_result "complete_tras_abort"       "=U0109$"
# UNA. La operación que falló no cobró: el cobro todavía no había ocurrido.
check_result "filas_tras_fallo"          "=1$"
check_result "bind_consulta_nueva"       "=bound$"
check_result "complete_consulta_nueva"   "=completed$"
# DOS. El mismo texto, dos operaciones, dos cobros — la otra mitad de la
# distinción, la que el digest de la consulta pierde.
check_result "filas_dos_operaciones"     "=2$"
check_result "bind_sin_cuota"            "=quota_exceeded\|2\|2$"
check_result "estado_tras_refuso"        "=issued$"
check_result "inspect_estado"            "=completed$"
check_result "inspect_tiene_hash"        "=true$"
check_result "columnas_de_payload"       "=0$"

# --------------------------------------------------------------------------
say "9. Aislamiento — otra organización, otro proyecto, otro actor"
# --------------------------------------------------------------------------
# Los tickets ajenos los siembra el OWNER, porque ninguna sesión de A puede
# emitirlos: emitir ya está cerrado por el scope. Lo que se prueba aquí es lo
# otro — que un ticket que EXISTE y pertenece a otro no es utilizable por A.
FOREIGN_ORG=$(seed_ticket "SET ROLE uellix_owner; INSERT INTO uellix_stella_ops.operation_tickets (ticket_id, organization_id, project_id, actor_id, category, status, charge_nonce, issued_at, expires_at) VALUES (repeat('a',64), '$ORG_B', '$PROJ_B', '$USER_B', 'grounded_query', 'issued', repeat('b',64), timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes') RETURNING ticket_id")
FOREIGN_ACTOR=$(seed_ticket "SET ROLE uellix_owner; INSERT INTO uellix_stella_ops.operation_tickets (ticket_id, organization_id, project_id, actor_id, category, status, charge_nonce, issued_at, expires_at) VALUES (repeat('c',64), '$ORG_A', '$PROJ_A1', '$USER_B', 'grounded_query', 'issued', repeat('d',64), timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes') RETURNING ticket_id")
EXPIRED_ISSUED=$(seed_ticket "SET ROLE uellix_owner; INSERT INTO uellix_stella_ops.operation_tickets (ticket_id, organization_id, project_id, actor_id, category, status, charge_nonce, issued_at, expires_at) VALUES (repeat('e',64), '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'issued', repeat('f',64), timezone('UTC', now()) - interval '1 hour', timezone('UTC', now()) - interval '50 minutes') RETURNING ticket_id")
[ -n "$FOREIGN_ORG" ] && [ -n "$FOREIGN_ACTOR" ] && [ -n "$EXPIRED_ISSUED" ] || fail "9: la siembra de tickets ajenos falló"
echo "  sembrados: ticket de otra org, ticket de otro actor, ticket expirado"

set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

DO \$i\$
DECLARE r record; t char(64);
BEGIN
  -- Ticket de OTRA ORGANIZACIÓN.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket('$FOREIGN_ORG', '$PROJ_B', '$H1');
    RAISE NOTICE 'RESULT iso_otra_org=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_otra_org=%', SQLSTATE; END;

  -- Ticket de OTRO ACTOR dentro de la organización propia. Es la prueba de que
  -- la identidad del actor no es decorativa: la organización coincide.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket('$FOREIGN_ACTOR', '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT iso_otro_actor=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_otro_actor=%', SQLSTATE; END;

  -- Ticket EXPIRADO propio. U0108 y no U0102: la distinción sólo la ve el
  -- dueño del ticket, porque el scope se comprueba ANTES que la vigencia.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket('$EXPIRED_ISSUED', '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT iso_expirado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_expirado=%', SQLSTATE; END;

  -- Ticket INEXISTENTE, con la forma correcta. Indistinguible de uno ajeno.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(repeat('9', 64), '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT iso_inexistente=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_inexistente=%', SQLSTATE; END;

  -- Ticket MALFORMADO.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket('no-es-un-ticket', '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT iso_malformado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_malformado=%', SQLSTATE; END;

  -- Digest MALFORMADO: la identidad de la pregunta tiene que ser recomputable.
  BEGIN
    t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t, '$PROJ_A1', 'no-es-un-sha256');
    RAISE NOTICE 'RESULT iso_digest_malformado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_digest_malformado=%', SQLSTATE; END;

  -- Emitir contra un PROYECTO ajeno, con la organización propia.
  BEGIN
    t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_B', 'grounded_query');
    RAISE NOTICE 'RESULT iso_otro_proyecto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_otro_proyecto=%', SQLSTATE; END;

  -- Emitir contra una ORGANIZACIÓN ajena.
  BEGIN
    t := uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'grounded_query');
    RAISE NOTICE 'RESULT iso_emitir_otra_org=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_emitir_otra_org=%', SQLSTATE; END;

  -- Categoría fuera del vocabulario gobernado.
  BEGIN
    t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'not_a_capability');
    RAISE NOTICE 'RESULT iso_categoria=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_categoria=%', SQLSTATE; END;

  -- Razón de aborto fuera del vocabulario: nada de texto libre.
  BEGIN
    t := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
    PERFORM uellix_stella_ops.abort_operation_ticket(t, '$PROJ_A1', 'el modelo se cayo y perdimos la respuesta');
    RAISE NOTICE 'RESULT iso_razon_libre=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_razon_libre=%', SQLSTATE; END;

  -- Inspeccionar un ticket ajeno.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.inspect_operation_ticket('$FOREIGN_ORG', '$PROJ_B');
    RAISE NOTICE 'RESULT iso_inspect_ajeno=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_inspect_ajeno=%', SQLSTATE; END;
END \$i\$;

-- La tabla, directamente. El nonce vive ahí: un SELECT que funcionara haría
-- calculable la clave de cuota y todo el protocolo sería decorativo.
DO \$i2\$
DECLARE n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM uellix_stella_ops.operation_tickets;
    RAISE NOTICE 'RESULT iso_select_directo=UNEXPECTED_SUCCESS_%', n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_select_directo=%', SQLSTATE; END;

  BEGIN
    INSERT INTO uellix_stella_ops.operation_tickets (
      ticket_id, organization_id, project_id, actor_id, category, status,
      charge_nonce, issued_at, expires_at)
    VALUES (repeat('7', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'issued',
            repeat('8', 64), timezone('UTC', now()), timezone('UTC', now()) + interval '5 minutes');
    RAISE NOTICE 'RESULT iso_insert_directo=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT iso_insert_directo=%', SQLSTATE; END;
END \$i2\$;

ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
[ "$LIVE_STATUS" -eq 0 ] || { echo "$LIVE_OUT"; fail "9: el script SQL terminó con código $LIVE_STATUS"; }
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

check_result "iso_otra_org"          "=U0102$"
check_result "iso_otro_actor"        "=U0102$"
check_result "iso_expirado"          "=U0108$"
check_result "iso_inexistente"       "=U0102$"
check_result "iso_malformado"        "=U0100$"
check_result "iso_digest_malformado" "=U0100$"
check_result "iso_otro_proyecto"     "=U0102$"
check_result "iso_emitir_otra_org"   "=U0102$"
check_result "iso_categoria"         "=U0106$"
check_result "iso_razon_libre"       "=U0106$"
check_result "iso_inspect_ajeno"     "=U0102$"
# 42501: privilegio insuficiente. La tabla no está concedida a nadie del runtime.
check_result "iso_select_directo"    "=42501$"
check_result "iso_insert_directo"    "=42501$"

# --------------------------------------------------------------------------
say "9b. R2-INT cerrado — la matriz cross-proyecto, ejecutada"
# --------------------------------------------------------------------------
# La MISMA secuencia del §5b, ahora contra las firmas project-bound. Todo
# ocurre dentro de UNA organización y con UN actor: nada de esto cruza una
# frontera que el tren 4.1 ya cerrara, y por eso ninguna de las defensas
# anteriores lo veía.
#
# La cuota de A se sube a 5 DENTRO de la transacción, que se revierte al final:
# la matriz necesita margen para dos cobros legítimos, y el §11 mide después el
# retorno exacto al baseline.
set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SET ROLE uellix_owner;
UPDATE public.organizations SET stella_monthly_quota = 5 WHERE id = '$ORG_A';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_A"}', true);
SET LOCAL ROLE uellix_app;

DO \$pb\$
DECLARE t1 char(64); t2 char(64); t3 char(64); r record; v uuid; n int;
BEGIN
  -- ---- (1) ticket A1 + proyecto esperado A1: el camino legítimo ----------
  -- CONTROL POSITIVO primero. Sin él, todo rechazo de abajo sería igual de
  -- compatible con «la firma nueva rechaza todo».
  t1 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A1', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT pb_bind_mismo_proyecto=%', r.outcome;

  -- ---- (2) ticket A1 + proyecto A2 de la MISMA organización -------------
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_A2', '$H1');
    RAISE NOTICE 'RESULT pb_bind_otro_proyecto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_bind_otro_proyecto=%', SQLSTATE; END;

  -- ---- (3) ticket A1 + proyecto de OTRA organización --------------------
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, '$PROJ_B', '$H1');
    RAISE NOTICE 'RESULT pb_bind_proyecto_otra_org=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_bind_proyecto_otra_org=%', SQLSTATE; END;

  -- ---- proyecto ausente: U0100 y no U0110. Un argumento que falta no es un
  --      argumento que no coincide, y el llamante actúa distinto en cada caso.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t1, NULL::uuid, '$H1');
    RAISE NOTICE 'RESULT pb_bind_sin_proyecto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_bind_sin_proyecto=%', SQLSTATE; END;

  -- ---- (6) bind correcto, complete con OTRO proyecto --------------------
  -- La reserva ya está tomada bajo A1. Esto es exactamente R2-INT: el trabajo
  -- corrió bajo A2 y quiere que el cargo se archive donde diga el ticket.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A2', '$H1');
    RAISE NOTICE 'RESULT pb_complete_otro_proyecto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_complete_otro_proyecto=%', SQLSTATE; END;

  -- CERO CARGO ante el mismatch, medido sobre el ledger y no sobre el retorno.
  SELECT count(*) INTO n FROM public.stella_interactions
   WHERE organization_id = '$ORG_A' AND stella_role = 'grounded_query';
  RAISE NOTICE 'RESULT pb_cargo_tras_mismatch=%', n;

  -- ---- (7) bind correcto, abort con OTRO proyecto -----------------------
  BEGIN
    PERFORM uellix_stella_ops.abort_operation_ticket(t1, '$PROJ_A2', 'caller_abort');
    RAISE NOTICE 'RESULT pb_abort_otro_proyecto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_abort_otro_proyecto=%', SQLSTATE; END;
  -- ...y la reserva de A1 SIGUE VIVA. Sin esta línea el rechazo de arriba sería
  -- compatible con un abort que falló después de haber soltado la reserva.
  SELECT * INTO r FROM uellix_stella_ops.inspect_operation_ticket(t1, '$PROJ_A1');
  RAISE NOTICE 'RESULT pb_reserva_sobrevive=%', r.status;

  -- ---- (8) inspect con OTRO proyecto ------------------------------------
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.inspect_operation_ticket(t1, '$PROJ_A2');
    RAISE NOTICE 'RESULT pb_inspect_otro_proyecto=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_inspect_otro_proyecto=%', SQLSTATE; END;

  -- ---- (12) el camino legítimo cobra, y cobra DONDE debe ----------------
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT pb_complete_mismo_proyecto=%', r.outcome;
  SELECT si.project_id INTO v FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A' AND si.stella_role = 'grounded_query'
   ORDER BY si.created_at DESC LIMIT 1;
  RAISE NOTICE 'RESULT pb_cargo_en_a1=%', (v = '$PROJ_A1')::text;

  -- ---- (9) reintento post-complete con OTRO proyecto --------------------
  -- U0110 y NO "replayed": responder «esto ya pasó y ya se cobró» a la
  -- superficie de A2 sería informarle de una operación que no es suya.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A2', '$H1');
    RAISE NOTICE 'RESULT pb_retry_otro_proyecto=UNEXPECTED_SUCCESS_%', r.outcome;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_retry_otro_proyecto=%', SQLSTATE; END;
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t1, '$PROJ_A1', '$H1');
  RAISE NOTICE 'RESULT pb_retry_mismo_proyecto=%', r.outcome;

  -- ---- (10) dos proyectos, el MISMO texto, dos operaciones --------------
  t2 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A2', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t2, '$PROJ_A2', '$H1');
  SELECT * INTO r FROM uellix_stella_ops.complete_operation_ticket(t2, '$PROJ_A2', '$H1');
  RAISE NOTICE 'RESULT pb_complete_a2=%', r.outcome;
  SELECT count(*) INTO n FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A' AND si.project_id = '$PROJ_A1';
  RAISE NOTICE 'RESULT pb_cargos_a1=%', n;
  SELECT count(*) INTO n FROM public.stella_interactions si
   WHERE si.organization_id = '$ORG_A' AND si.project_id = '$PROJ_A2';
  RAISE NOTICE 'RESULT pb_cargos_a2=%', n;

  -- ---- (11) la cuota sigue siendo ORGANIZACIONAL ------------------------
  -- Dos proyectos, un solo presupuesto. Si el margen se contara por proyecto,
  -- una organización gastaría su cuota una vez por cada proyecto que posea.
  t3 := uellix_stella_ops.issue_operation_ticket('$ORG_A', '$PROJ_A2', 'grounded_query');
  SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(t3, '$PROJ_A2', '$H2');
  RAISE NOTICE 'RESULT pb_cuota_organizacional=%|%', r.used, r.quota;

  -- ---- (4)(5) el proyecto correcto NO rescata un scope ajeno ------------
  -- Los tres devuelven U0102 y no U0110: el scope se comprueba ANTES que el
  -- proyecto, así que el nuevo código no se convierte en un oráculo de
  -- existencia para tickets que el llamante no puede ver.
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket('$FOREIGN_ACTOR', '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT pb_otro_actor=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_otro_actor=%', SQLSTATE; END;
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket(repeat('9', 64), '$PROJ_A1', '$H1');
    RAISE NOTICE 'RESULT pb_inventado=%', 'UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_inventado=%', SQLSTATE; END;
  BEGIN
    SELECT * INTO r FROM uellix_stella_ops.bind_operation_ticket('$FOREIGN_ORG', '$PROJ_B', '$H1');
    RAISE NOTICE 'RESULT pb_otra_org=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT pb_otra_org=%', SQLSTATE; END;
END \$pb\$;

ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
[ "$LIVE_STATUS" -eq 0 ] || { echo "$LIVE_OUT"; fail "9b: el script SQL terminó con código $LIVE_STATUS"; }
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

check_result "pb_bind_mismo_proyecto"       "=bound$"
check_result "pb_bind_otro_proyecto"        "=U0110$"
check_result "pb_bind_proyecto_otra_org"    "=U0110$"
check_result "pb_bind_sin_proyecto"         "=U0100$"
check_result "pb_complete_otro_proyecto"    "=U0110$"
# CERO. La mitad de R2-INT que importa: el mismatch no cobra.
check_result "pb_cargo_tras_mismatch"       "=0$"
check_result "pb_abort_otro_proyecto"       "=U0110$"
check_result "pb_reserva_sobrevive"         "=bound$"
check_result "pb_inspect_otro_proyecto"     "=U0110$"
check_result "pb_complete_mismo_proyecto"   "=completed$"
check_result "pb_cargo_en_a1"               "=true$"
check_result "pb_retry_otro_proyecto"       "=U0110$"
check_result "pb_retry_mismo_proyecto"      "=replayed$"
check_result "pb_complete_a2"               "=completed$"
# UNO y UNO. El mismo texto en dos proyectos son dos operaciones, y cada cargo
# cae en el suyo.
check_result "pb_cargos_a1"                 "=1$"
check_result "pb_cargos_a2"                 "=1$"
# 2 de 5: el consumo se cuenta sobre la ORGANIZACIÓN, no sobre el proyecto.
check_result "pb_cuota_organizacional"      "=2\|5$"
check_result "pb_otro_actor"                "=U0102$"
check_result "pb_inventado"                 "=U0102$"
check_result "pb_otra_org"                  "=U0102$"

# --------------------------------------------------------------------------
say "10. Ataques con el OWNER — donde RLS no llega"
# --------------------------------------------------------------------------
set +e
LIVE_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL 2>&1
BEGIN;
SET ROLE uellix_owner;

DO \$o\$
DECLARE t char(64) := repeat('1', 64);
BEGIN
  -- CONTROL POSITIVO primero. Sin él, todos los rechazos de abajo serían igual
  -- de compatibles con «el trigger rechaza todo».
  INSERT INTO uellix_stella_ops.operation_tickets (
    ticket_id, organization_id, project_id, actor_id, category, status,
    charge_nonce, issued_at, expires_at)
  VALUES (t, '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'issued',
          repeat('2', 64), timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes');
  RAISE NOTICE 'RESULT owner_fila_valida=OK';

  -- Un ticket NACE emitido. Declararlo completado es la forja que se lo
  -- quedaría todo sin pagar nada.
  BEGIN
    INSERT INTO uellix_stella_ops.operation_tickets (
      ticket_id, organization_id, project_id, actor_id, category, status,
      query_hash, bound_at, completed_at, charge_nonce, issued_at, expires_at)
    VALUES (repeat('3', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'completed',
            '$H1', timezone('UTC', now()), timezone('UTC', now()),
            repeat('4', 64), timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes');
    RAISE NOTICE 'RESULT owner_nace_completado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_nace_completado=%', SQLSTATE; END;

  -- Proyecto que no pertenece a la organización nombrada.
  BEGIN
    INSERT INTO uellix_stella_ops.operation_tickets (
      ticket_id, organization_id, project_id, actor_id, category, status,
      charge_nonce, issued_at, expires_at)
    VALUES (repeat('5', 64), '$ORG_A', '$PROJ_B', '$USER_A', 'grounded_query', 'issued',
            repeat('6', 64), timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes');
    RAISE NOTICE 'RESULT owner_proyecto_cruzado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_proyecto_cruzado=%', SQLSTATE; END;

  -- Vigencia sin cota: la reserva que nunca se libera.
  BEGIN
    INSERT INTO uellix_stella_ops.operation_tickets (
      ticket_id, organization_id, project_id, actor_id, category, status,
      charge_nonce, issued_at, expires_at)
    VALUES (repeat('7', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'issued',
            repeat('8', 64), timezone('UTC', now()), timezone('UTC', now()) + interval '30 days');
    RAISE NOTICE 'RESULT owner_expiracion_infinita=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_expiracion_infinita=%', SQLSTATE; END;

  -- Mover el ticket de organización después de emitido.
  BEGIN
    UPDATE uellix_stella_ops.operation_tickets SET organization_id = '$ORG_B' WHERE ticket_id = t;
    RAISE NOTICE 'RESULT owner_mueve_org=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_mueve_org=%', SQLSTATE; END;

  -- Estirar la vigencia.
  BEGIN
    UPDATE uellix_stella_ops.operation_tickets
       SET expires_at = timezone('UTC', now()) + interval '10 minutes' WHERE ticket_id = t;
    RAISE NOTICE 'RESULT owner_estira_vigencia=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_estira_vigencia=%', SQLSTATE; END;

  -- Saltarse el bind: de emitido a completado.
  BEGIN
    UPDATE uellix_stella_ops.operation_tickets
       SET status = 'completed', completed_at = timezone('UTC', now()) WHERE ticket_id = t;
    RAISE NOTICE 'RESULT owner_salta_bind=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_salta_bind=%', SQLSTATE; END;

  -- Ahora se ata legítimamente, para poder atacar el digest ya fijado.
  UPDATE uellix_stella_ops.operation_tickets
     SET status = 'bound', query_hash = '$H1', bound_at = timezone('UTC', now())
   WHERE ticket_id = t;
  RAISE NOTICE 'RESULT owner_bind_legitimo=OK';

  -- Reescribir el digest: reutilizar el ticket para otra pregunta.
  BEGIN
    UPDATE uellix_stella_ops.operation_tickets SET query_hash = '$H2' WHERE ticket_id = t;
    RAISE NOTICE 'RESULT owner_reescribe_hash=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_reescribe_hash=%', SQLSTATE; END;

  -- Completar y luego tocar lo ya liquidado.
  UPDATE uellix_stella_ops.operation_tickets
     SET status = 'completed', completed_at = timezone('UTC', now()) WHERE ticket_id = t;
  BEGIN
    UPDATE uellix_stella_ops.operation_tickets
       SET status = 'aborted', aborted_at = timezone('UTC', now()), abort_reason = 'caller_abort',
           completed_at = NULL
     WHERE ticket_id = t;
    RAISE NOTICE 'RESULT owner_reabre_completado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_reabre_completado=%', SQLSTATE; END;

  -- Borrar lo cobrado.
  BEGIN
    DELETE FROM uellix_stella_ops.operation_tickets WHERE ticket_id = t;
    RAISE NOTICE 'RESULT owner_borra_completado=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_borra_completado=%', SQLSTATE; END;
END \$o\$;

-- session_replication_role = replica silencia los triggers ENABLE (tgenabled
-- 'O'). Los de esta tabla son ENABLE ALWAYS ('A'), así que siguen disparando —
-- y ésa es la diferencia entre un invariante y una convención.
--
-- El parámetro sólo lo puede fijar un superusuario, así que se suelta el rol
-- para ponerlo y se vuelve a tomar para atacar. El atacante sigue siendo
-- uellix_owner; lo que cambia es el modo de la sesión, que es exactamente el
-- escenario que ENABLE ALWAYS existe para cubrir.
RESET ROLE;
SET session_replication_role = 'replica';
SET ROLE uellix_owner;
DO \$o2\$
BEGIN
  BEGIN
    INSERT INTO uellix_stella_ops.operation_tickets (
      ticket_id, organization_id, project_id, actor_id, category, status,
      query_hash, bound_at, completed_at, charge_nonce, issued_at, expires_at)
    VALUES (repeat('9', 64), '$ORG_A', '$PROJ_A1', '$USER_A', 'grounded_query', 'completed',
            '$H1', timezone('UTC', now()), timezone('UTC', now()),
            repeat('0', 64), timezone('UTC', now()), timezone('UTC', now()) + interval '10 minutes');
    RAISE NOTICE 'RESULT owner_replica_forja=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT owner_replica_forja=%', SQLSTATE; END;

  -- El SQLSTATE de uellix_forbid_mutation es "insufficient_privilege" (42501),
  -- el MISMO que produciria una denegacion real de privilegio. Afirmar solo el
  -- codigo dejaria pasar como exito el caso en que el owner simplemente no
  -- pudiera truncar — que no es lo que aqui se quiere demostrar. Se discrimina
  -- por el mensaje: solo el trigger dice «append-only».
  BEGIN
    TRUNCATE uellix_stella_ops.operation_tickets;
    RAISE NOTICE 'RESULT owner_replica_truncate=UNEXPECTED_SUCCESS';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'RESULT owner_replica_truncate=%_%', SQLSTATE,
      CASE WHEN SQLERRM LIKE 'append-only%' THEN 'trigger' ELSE 'otro' END;
  END;
END \$o2\$;
RESET ROLE;
SET session_replication_role = 'origin';

ROLLBACK;
SQL
)
LIVE_STATUS=$?
set -e
[ "$LIVE_STATUS" -eq 0 ] || { echo "$LIVE_OUT"; fail "10: el script SQL terminó con código $LIVE_STATUS"; }
echo "$LIVE_OUT" | grep 'RESULT ' | sed 's/^NOTICE:  //'

check_result "owner_fila_valida"          "=OK$"
check_result "owner_nace_completado"      "=U0109$"
check_result "owner_proyecto_cruzado"     "=U0102$"
# 23514: violación de CHECK. La cota de vigencia es una constraint, no un
# trigger, así que no hay modo de sesión que la apague.
check_result "owner_expiracion_infinita"  "=23514$"
check_result "owner_mueve_org"            "=U0109$"
check_result "owner_estira_vigencia"      "=U0109$"
check_result "owner_salta_bind"           "=U0109$"
check_result "owner_bind_legitimo"        "=OK$"
check_result "owner_reescribe_hash"       "=U0107$"
check_result "owner_reabre_completado"    "=U0109$"
check_result "owner_borra_completado"     "=U0109$"
check_result "owner_replica_forja"        "=U0109$"
check_result "owner_replica_truncate"     "=42501_trigger$"

# --------------------------------------------------------------------------
say "11. Concurrencia real — dos sesiones"
# --------------------------------------------------------------------------
# Estas pruebas NO se pueden revertir: dos sesiones no comparten una
# transacción, así que la primera tiene que hacer COMMIT para que la segunda vea
# su fila. Por eso el §13 vuelve a restaurar el baseline.
#
# La organización B tiene cuota 50; se baja a 1 para que quede exactamente una
# unidad en disputa.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 1 WHERE id = '$ORG_B';" >/dev/null \
  || fail "no se pudo fijar la cuota de la organización B"

issue_for_b() {
  docker exec "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1 -c \
    "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT uellix_stella_ops.issue_operation_ticket('$ORG_B', '$PROJ_B', 'grounded_query');" \
    | tail -1
}

# --- 11a. Dos tickets DISTINTOS por la última unidad ------------------------
TA=$(issue_for_b); TB=$(issue_for_b)
[ -n "$TA" ] && [ -n "$TB" ] && [ "$TA" != "$TB" ] || fail "11a: no se emitieron dos tickets distintos"

docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >/tmp/tk11a_$$ 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S1=' || outcome FROM uellix_stella_ops.bind_operation_ticket('$TA', '$PROJ_B', '$H1');
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
SELECT 'S2=' || outcome FROM uellix_stella_ops.bind_operation_ticket('$TB', '$PROJ_B', '$H2');
COMMIT;
SQL
)
S2_STATUS=$?
set -e
T1=$(date +%s)
wait "$S1_PID" || true
ELAPSED=$((T1 - T0))
[ "$S2_STATUS" -eq 0 ] || { echo "$S2_OUT"; fail "11a: la sesión 2 falló"; }
S1_OUT=$(grep -oE 'S1=[a-z_]+' "/tmp/tk11a_$$" | head -1); rm -f "/tmp/tk11a_$$"
S2_RES=$(echo "$S2_OUT" | grep -oE 'S2=[a-z_]+' | head -1)
echo "  sesión 1 -> $S1_OUT"
echo "  sesión 2 -> $S2_RES  (esperó ${ELAPSED}s)"
assert_eq "11a sesión 1 reserva la última unidad" "S1=bound"           "$S1_OUT"
assert_eq "11a sesión 2 es rechazada"             "S2=quota_exceeded"  "$S2_RES"
# La espera es la evidencia de que hubo SERIALIZACIÓN y no una coincidencia de
# orden: sin el lock, la sesión 2 habría contado 0 reservas y respondido en
# milisegundos.
[ "$ELAPSED" -ge 2 ] || fail "11a: la sesión 2 respondió en ${ELAPSED}s — no esperó, el lock no serializó nada"
echo "  ok   la reserva excluye a la otra reserva (${ELAPSED}s de espera)"

# --- 11b. El MISMO ticket completado por dos sesiones ----------------------
docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >/tmp/tk11b_$$ 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S1=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$TA', '$PROJ_B', '$H1');
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
SELECT 'S2=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$TA', '$PROJ_B', '$H1');
COMMIT;
SQL
)
S2_STATUS=$?
set -e
T1=$(date +%s)
wait "$S1_PID" || true
ELAPSED=$((T1 - T0))
[ "$S2_STATUS" -eq 0 ] || { echo "$S2_OUT"; fail "11b: la sesión 2 falló"; }
S1_OUT=$(grep -oE 'S1=[a-z_]+' "/tmp/tk11b_$$" | head -1); rm -f "/tmp/tk11b_$$"
S2_RES=$(echo "$S2_OUT" | grep -oE 'S2=[a-z_]+' | head -1)
echo "  sesión 1 -> $S1_OUT"
echo "  sesión 2 -> $S2_RES  (esperó ${ELAPSED}s)"
assert_eq "11b sesión 1 completa"            "S1=completed" "$S1_OUT"
assert_eq "11b sesión 2 no vuelve a cobrar"  "S2=replayed"  "$S2_RES"
[ "$ELAPSED" -ge 2 ] || fail "11b: la sesión 2 no esperó al lock de fila"
assert_eq "11b una sola unidad cobrada en B" "1" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B' AND stella_role='grounded_query'")"
assert_eq "11b el ticket perdedor sigue emitido" "issued" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$TB'")"

# --- 11c. complete y abort concurrentes ------------------------------------
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 10 WHERE id = '$ORG_B';" >/dev/null
TC=$(issue_for_b)
docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TC', '$PROJ_B', '$H3');" >/dev/null \
  || fail "11c: no se pudo reservar"

docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >/tmp/tk11c_$$ 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S1=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$TC', '$PROJ_B', '$H3');
RESET ROLE;
SELECT pg_sleep(5);
COMMIT;
SQL
S1_PID=$!
sleep 2
set +e
S2_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -tA <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S2=' || uellix_stella_ops.abort_operation_ticket('$TC', '$PROJ_B', 'execution_failed');
COMMIT;
SQL
)
set -e
wait "$S1_PID" || true
S1_OUT=$(grep -oE 'S1=[a-z_]+' "/tmp/tk11c_$$" | head -1); rm -f "/tmp/tk11c_$$"
echo "  sesión 1 -> $S1_OUT"
echo "  sesión 2 -> $(echo "$S2_OUT" | grep -oE 'a completed operation cannot be aborted|S2=[a-z_]+' | head -1)"
assert_eq "11c complete gana"        "S1=completed" "$S1_OUT"
# Se busca el MENSAJE y no el SQLSTATE: psql sin `VERBOSITY verbose` no imprime
# el codigo, asi que un grep por 'U0109' no encuentra nada y el arnes acusaria
# de fallo justo el comportamiento correcto.
echo "$S2_OUT" | grep -q "a completed operation cannot be aborted"   || { echo "$S2_OUT"; fail "11c: el abort concurrente no fue rechazado"; }
echo "  ok   el abort concurrente se rechaza — un cobro no se deshace"
assert_eq "11c estado final determinista" "completed" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$TC'")"

# --- 11d. Caída simulada: la reserva se va con la transacción ---------------
# La sesión se mata a mitad de la reserva. Sin COMMIT no hay reserva, así que la
# cuota no queda comprometida por un proceso que ya no existe — y el mismo
# ticket vuelve a ser reservable.
TD=$(issue_for_b)
docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >/dev/null 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TD', '$PROJ_B', '$H4');
RESET ROLE;
SELECT pg_sleep(30);
COMMIT;
SQL
CRASH_PID=$!
sleep 3
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND query LIKE '%pg_sleep(30)%' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
wait "$CRASH_PID" 2>/dev/null || true
assert_eq "11d la reserva no sobrevivió a la caída" "issued" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$TD'")"
REBIND=$(docker exec "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1 -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TD', '$PROJ_B', '$H4');" | tail -1)
assert_eq "11d el mismo ticket vuelve a reservarse" "bound" "$REBIND"

# --- 11e. El ticket expira DURANTE la operación ----------------------------
# Se siembra con el owner una reserva ya vencida — la única forma de simular una
# operación que tardó más que su vigencia sin esperar quince minutos.
# En DOS pasos, y no por comodidad: el trigger de INSERT rechaza un ticket que
# NACE `bound` («a ticket is issued, not declared»), asi que ni el owner puede
# fabricar una reserva sin pasar por la transicion. Sembrarla exige emitirla y
# despues atarla — que es justo lo que el invariante pretende obligar.
EXPIRED_BOUND=$(seed_ticket "SET ROLE uellix_owner; INSERT INTO uellix_stella_ops.operation_tickets (ticket_id, organization_id, project_id, actor_id, category, status, charge_nonce, issued_at, expires_at) VALUES (repeat('5',64), '$ORG_B', '$PROJ_B', '$USER_B', 'grounded_query', 'issued', repeat('6',64), timezone('UTC', now()) - interval '1 hour', timezone('UTC', now()) - interval '50 minutes'); UPDATE uellix_stella_ops.operation_tickets SET status = 'bound', query_hash = '$H1', bound_at = timezone('UTC', now()) - interval '1 hour' WHERE ticket_id = repeat('5',64) RETURNING ticket_id")
[ -n "$EXPIRED_BOUND" ] || fail "11e: no se pudo sembrar la reserva vencida"
BEFORE=$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B'")
set +e
EXP_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -tA <<SQL 2>&1
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', false);
SET ROLE uellix_app;
SELECT outcome FROM uellix_stella_ops.complete_operation_ticket('$EXPIRED_BOUND', '$PROJ_B', '$H1');
SQL
)
set -e
# Por MENSAJE, no por SQLSTATE: psql no imprime el codigo sin VERBOSITY verbose.
echo "$EXP_OUT" | grep -q "the ticket is no longer live"   || { echo "$EXP_OUT"; fail "11e: completar una reserva vencida no fue rechazado"; }
echo "  ok   completar tras la expiración se rechaza"
assert_eq "11e no cobró nada" "$BEFORE" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B'")"

# --- 11f. Una reserva vencida no retiene cuota ------------------------------
# Con cuota 1 y la reserva vencida de §11e todavía en estado `bound`, un ticket
# nuevo tiene que poder reservar. Si `expires_at` no formara parte del predicado
# de vivacidad, esa fila muerta se habría quedado con la única unidad para
# siempre — y ningún cron la habría liberado, porque no hay cron.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 99 WHERE id = '$ORG_B';" >/dev/null
TF=$(issue_for_b)
FRESH=$(docker exec "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1 -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TF', '$PROJ_B', '$H2');" | tail -1)
assert_eq "11f una reserva vencida no bloquea" "bound" "$FRESH"
assert_eq "11f la reserva vencida sigue contada como no viva" "0" \
  "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$EXPIRED_BOUND' AND status='bound' AND expires_at > timezone('UTC', now())")"
# ...y la higiene la reconcilia sin cobrar nada.
SWEPT=$(docker exec "$BOX" psql -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1 -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT uellix_stella_ops.expire_operation_tickets();" | tail -1)
echo "  barridos por expire_operation_tickets: $SWEPT"
[ "$SWEPT" -ge 1 ] || fail "11f: la higiene no marcó ninguna reserva vencida"
assert_eq "11f la vencida quedó expirada" "expired" \
  "$(Q "SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id='$EXPIRED_BOUND'")"

# --- 11g. Cambio de proyecto CONCURRENTE ------------------------------------
# La sesión 1 sostiene el lock de la fila del ticket con un complete legítimo
# bajo su propio proyecto; la sesión 2 espera detrás y presenta el MISMO ticket
# bajo otro proyecto. Es la carrera que un solo test secuencial no puede
# expresar: si el proyecto se comprobara antes de tomar el lock, la sesión 2
# leería un estado previo al de la sesión 1 y decidiría sobre él.
#
# La organización B tiene un solo proyecto, así que el proyecto rival es el de
# la organización A — que la sesión de B no puede ver. Sirve igual: lo que se
# mide es que la comprobación ocurre DESPUÉS del lock y del scope, y que el
# perdedor no cobra.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c \
  "SET ROLE uellix_owner; UPDATE public.organizations SET stella_monthly_quota = 99 WHERE id = '$ORG_B';" >/dev/null
TG=$(issue_for_b)
docker exec "$BOX" psql -U supabase_admin -d postgres -q -tA -c \
  "SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_B\"}', false); SET ROLE uellix_app; SELECT outcome FROM uellix_stella_ops.bind_operation_ticket('$TG', '$PROJ_B', '$H3');" >/dev/null \
  || fail "11g: no se pudo reservar"
BEFORE=$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B'")

docker exec -i "$BOX" psql -U supabase_admin -d postgres -q >/tmp/tk11g_$$ 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S1=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$TG', '$PROJ_B', '$H3');
RESET ROLE;
SELECT pg_sleep(5);
COMMIT;
SQL
S1_PID=$!
sleep 2
T0=$(date +%s)
set +e
S2_OUT=$(docker exec -i "$BOX" psql -U supabase_admin -d postgres -tA <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$USER_B"}', true);
SET LOCAL ROLE uellix_app;
SELECT 'S2=' || outcome FROM uellix_stella_ops.complete_operation_ticket('$TG', '$PROJ_A1', '$H3');
COMMIT;
SQL
)
set -e
T1=$(date +%s)
wait "$S1_PID" || true
ELAPSED=$((T1 - T0))
S1_OUT=$(grep -oE 'S1=[a-z_]+' "/tmp/tk11g_$$" | head -1); rm -f "/tmp/tk11g_$$"
echo "  sesión 1 -> $S1_OUT"
echo "  sesión 2 -> $(echo "$S2_OUT" | grep -oE 'belongs to a different project|S2=[a-z_]+' | head -1)  (esperó ${ELAPSED}s)"
assert_eq "11g el proyecto correcto gana" "S1=completed" "$S1_OUT"
# Por MENSAJE y no por SQLSTATE: psql sin VERBOSITY verbose no imprime el
# código, así que un grep por 'U0110' no encontraría nada y el arnés acusaría de
# fallo justo el comportamiento correcto.
echo "$S2_OUT" | grep -q "belongs to a different project" \
  || { echo "$S2_OUT"; fail "11g: el complete concurrente cross-proyecto no fue rechazado"; }
echo "  ok   el complete concurrente bajo otro proyecto se rechaza"
[ "$ELAPSED" -ge 2 ] || fail "11g: la sesión 2 no esperó al lock de fila — decidió sobre un estado previo"
assert_eq "11g exactamente un cargo" "$((BEFORE + 1))" \
  "$(Q "SELECT count(*) FROM public.stella_interactions WHERE organization_id='$ORG_B'")"
assert_eq "11g el cargo cayó en el proyecto del ticket" "$PROJ_B" \
  "$(Q "SELECT project_id FROM public.stella_interactions WHERE organization_id='$ORG_B' ORDER BY created_at DESC LIMIT 1")"

# --------------------------------------------------------------------------
say "12. El rollback de stella_0014 SE NIEGA sobre tickets ya liquidados"
# --------------------------------------------------------------------------
SETTLED=$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE status='completed'")
[ "$SETTLED" -ge 1 ] || fail "12: la premisa no se cumple — no hay tickets completados"
echo "  tickets completados en la base: $SETTLED"
set +e
RBK_ERR=$("${PSQL[@]}" -1 -q -f "/stella_0014_rollback.sql" 2>&1 >/dev/null)
RBK_STATUS=$?
set -e
[ "$RBK_STATUS" -ne 0 ] \
  || fail "stella_0014_rollback corrió sobre tickets completados — los cargos habrían quedado sin atribución"
# Por el MOTIVO exacto. Con stella_0015 instalado, su DROP ROLE también habría
# fallado — y un arnés que sólo comprobara «falló» no distinguiría la negativa
# por atribución de un fallo por dependencia, que es otra propiedad y se mide
# aparte en el §14.
echo "$RBK_ERR" | grep -q "rollback refused" \
  || { echo "$RBK_ERR"; fail "12: stella_0014_rollback falló, pero NO por la negativa sobre tickets liquidados"; }
echo "  ok   se niega, y por el motivo correcto"
assert_eq "la tabla sigue ahí" "1" "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='uellix_stella_ops' AND tablename='operation_tickets'")"

# --------------------------------------------------------------------------
say "13. Base limpia otra vez — para medir el retorno EXACTO al baseline"
# --------------------------------------------------------------------------
restore_baseline
BASELINE2=$(state)
assert_eq "el segundo restore es el mismo baseline" "$BASELINE" "$BASELINE2"
apply_forward "${FORWARD[@]}"
FORWARD2=$(state)
assert_eq "la cadena reaplicada da el mismo estado" "$FORWARD_STATE" "$FORWARD2"

# --------------------------------------------------------------------------
say "14. El orden INVERSO también lo impone el SQL"
# --------------------------------------------------------------------------
# Sin tickets liquidados, el rollback de stella_0014 ya no tiene motivo para
# negarse por atribución — y aun así debe fallar, porque las cuatro funciones de
# stella_0015 son propiedad de uellix_cap_stella_ticket y su DROP ROLE no puede
# soltar un rol que todavía posee objetos. La transacción entera aborta y no se
# destruye nada. Un runbook que dijera el orden y no lo impusiera sería una
# convención; esto es una precondición.
assert_eq "no hay tickets liquidados en esta base" "0" \
  "$(Q "SELECT count(*) FROM uellix_stella_ops.operation_tickets WHERE status='completed'")"
if "${PSQL[@]}" -1 -q -f "/stella_0014_rollback.sql" >/dev/null 2>/dev/null; then
  fail "stella_0014_rollback corrió con las funciones de stella_0015 instaladas — el orden inverso no está impuesto"
fi
echo "  ok   stella_0014_rollback antes que el de stella_0015 aborta, como debe"
assert_eq "y no destruyó nada" "$FORWARD_STATE" "$(state)"

# --------------------------------------------------------------------------
say "15. Rollback en orden inverso"
# --------------------------------------------------------------------------
for f in "${ROLLBACKS[@]}"; do
  printf '  %-46s ' "$f"
  if "${PSQL[@]}" -1 -q -f "/$f.sql" >/dev/null 2>/tmp/tkerr_$$; then echo "OK"
  else echo "FAIL"; cat /tmp/tkerr_$$; exit 1; fi

  # LA ASERCIÓN DE ESTE TREN, y va justo después del primer rollback porque el
  # segundo se lleva el esquema entero y a partir de ahí «no hay firma
  # vulnerable» sería cierto por vacuidad.
  #
  # El rollback de stella_0015 NO restaura las firmas de dos argumentos. No es
  # una omisión: R2-INT no es un cuerpo que una versión nueva arregló, es la
  # AUSENCIA de un argumento — así que «restaurar la versión anterior» y
  # «republicar la vulnerabilidad» son la misma frase. Lo que queda es una
  # superficie CERRADA (issue y expire, ninguna de las cuales cobra), no una
  # degradada.
  if [ "$f" = "stella_0015_rollback" ]; then
    assert_eq "tras el rollback: cero firmas project-bound" "0" \
      "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND pg_get_function_arguments(p.oid) LIKE '%p\\_expected\\_project\\_id uuid%'")"
    assert_eq "tras el rollback: cero firmas SIN proyecto" "0" \
      "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops' AND p.proname IN ('bind_operation_ticket','complete_operation_ticket','abort_operation_ticket','inspect_operation_ticket')")"
    assert_eq "tras el rollback: lo de stella_0014 sigue en pie" "2" \
      "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")"
    assert_eq "tras el rollback: la tabla de tickets intacta" "1" \
      "$(Q "SELECT count(*) FROM pg_tables WHERE schemaname='uellix_stella_ops' AND tablename='operation_tickets'")"
    # ...y volver a aplicar stella_0015 sobre ese estado da EXACTAMENTE el
    # estado anterior al rollback. Convergencia medida, no prometida.
    "${PSQL[@]}" -1 -q -f "/stella_0015_project_bound_operation_tickets.sql" >/dev/null 2>&1 \
      || fail "15: stella_0015 no se pudo reaplicar tras su propio rollback"
    assert_eq "reaplicar stella_0015 devuelve el estado exacto" "$FORWARD_STATE" "$(state)"
    "${PSQL[@]}" -1 -q -f "/stella_0015_rollback.sql" >/dev/null 2>&1 \
      || fail "15: el rollback de stella_0015 no es repetible"
  fi
done
ROLLBACK_STATE=$(state)
echo "  estado tras rollback: $ROLLBACK_STATE"
assert_eq "vuelve exactamente al baseline" "$BASELINE" "$ROLLBACK_STATE"
assert_eq "el rol de ticket ya no existe" "0" "$(Q "SELECT count(*) FROM pg_roles WHERE rolname='uellix_cap_stella_ticket'")"
assert_eq "el esquema del ticket ya no existe" "0" "$(Q "SELECT count(*) FROM pg_namespace WHERE nspname='uellix_stella_ops'")"
assert_eq "la función de trigger ya no existe" "0" "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='uellix_check_operation_ticket_transition'")"

# --------------------------------------------------------------------------
say "16. Reaplicar — el estado debe ser idéntico al del paso 5c"
# --------------------------------------------------------------------------
apply_forward "${FORWARD[@]}"
REAPPLY_STATE=$(state)
assert_eq "reaplicado == aplicado" "$FORWARD_STATE" "$REAPPLY_STATE"

say "STELLA TICKET DRY RUN COMPLETO — contenedor destruido al salir"
echo "  imagen           : $IMAGE"
echo "  baseline         : $BASELINE"
echo "  forward          : $FORWARD_STATE"
echo "  rollback         : $ROLLBACK_STATE"
echo "  re-apply         : $REAPPLY_STATE"
echo "  (roles cap/esquemas/fn uellix_stella/fn uellix_stella_ops/tablas/policies/triggers/trigger fn en public/firmas con proyecto)"
