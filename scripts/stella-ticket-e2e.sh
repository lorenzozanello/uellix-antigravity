#!/usr/bin/env bash
# scripts/stella-ticket-e2e.sh
# INTEGRACIÓN — Tren 4.1, FASE 10. El recorrido completo de una consulta
# fundamentada contra una base REAL, con el protocolo de tickets instalado.
#
# ---------------------------------------------------------------------------
# QUÉ HACE ESTE GUION Y QUÉ NO
# ---------------------------------------------------------------------------
# Levanta un PostgreSQL DESECHABLE, restaura db/baseline/**, aplica los
# paquetes preparados que el recorrido necesita, siembra dos organizaciones /
# dos proyectos / dos actores / evidencia real, y a continuación ejecuta la
# batería `tests/e2e/stella-ticket-journey.e2e.test.ts` — que corre en Node y
# conduce el SERVER ACTION REAL, los ADAPTERS REALES y el GENERADOR EXTRACTIVO
# REAL contra esa base.
#
# El contenedor se destruye en el trap de salida, pase o falle. Cero
# volúmenes: `docker run` sin `-v` y sin `--mount`, así que el almacenamiento
# vive en la capa efímera del contenedor y desaparece con él.
#
# ---------------------------------------------------------------------------
# LA DESVIACIÓN DE `--network none`, DECLARADA
# ---------------------------------------------------------------------------
# `scripts/stella-ticket-dry-run.sh` corre con `--network none` y puede
# hacerlo porque conduce todo con `docker exec psql` DENTRO del contenedor.
# Esta batería no puede: su propósito es ejecutar el runtime de Node —
# `db/client`, el adaptador de tickets, el server action — y con
# `--network none` el contenedor no tiene interfaz alguna por la que Node
# pueda conectarse. Las dos exigencias no son simultáneamente satisfacibles.
#
# La sustitución es la más estrecha disponible, y se enuncia en vez de
# ocultarse:
#
#   -p 127.0.0.1:56322:5432   publicado SÓLO en loopback; nada fuera de este
#                             host puede alcanzarlo.
#
# Lo que `--network none` protege —que ningún proveedor externo sea llamado—
# se conserva por otras dos vías, y ambas se miden: el generador es el
# extractivo LOCAL (`createExtractiveAnswerProvider`, sin red), y la batería se
# invoca con `env -u GEMINI_API_KEY`, además de afirmar en la propia prueba que
# la variable no está definida.
#
# ---------------------------------------------------------------------------
# POR QUÉ EL PUERTO 56322 Y NO OTRO
# ---------------------------------------------------------------------------
# `db/safety/database-access.ts` exige, para la capacidad
# `local_integration_test`, que el puerto sea EXACTAMENTE `LOCAL_DB_PORT`
# (56322). No es una molestia: es la guarda que impide que esta batería
# apunte a una base remota o al stack de otro worktree. Si el stack persistente
# de ESTE worktree estuviera levantado, `docker run` fallaría por puerto
# ocupado — que es exactamente el fallo correcto, y la razón de que este guion
# no lo apague ni lo reutilice.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
BOX="uellix-stella-ticket-e2e-$$"
PORT=56322
BASE_DIR="db/baseline"

# El orden es una dependencia real, no una preferencia. stella_0014 se NIEGA a
# aplicarse sin consume_stella_quota (stella_0013), y el lector atestiguado de
# chunks que el runtime exige (`requireScopeAttestation: true`) sólo existe
# después de grounding_0004.
# Es la lista de scripts/stella-train4-dry-run.sh, en su mismo orden, más
# stella_0014 al final.
#
# stella_0002 / stella_0002b NO están, y su ausencia es deliberada: el baseline
# ya trae `trg_stella_interactions_append_only` (se comprueba en §4b, no se
# supone), y reaplicar 0002b sobre él falla su propia verificación porque el
# baseline ya reorganizó los privilegios que aquel paquete espera encontrar
# intactos. Aplicar un paquete ya incorporado no es más seguridad; es una
# segunda fuente de verdad sobre el mismo hecho.
#
# TREN 4.2. `stella_0015` va AL FINAL y el orden es una dependencia dura, no un
# gusto: su §0 se niega si la tabla de tickets, el rol o `consume_stella_quota`
# no están, y REEMPLAZA cuatro de las seis funciones de `stella_0014` dejando
# caer las firmas que no recibían proyecto. La cadena canónica —
# `stella_0013` → `stella_0014` → `stella_0015`— está declarada como dato en
# `db/prepared-package-order.ts`, y la §4d de abajo comprueba el estado final
# contra esa misma lista en vez de contra una copia escrita aquí.
#
# TREN 4.3 — CIERRE. La cadena ya no se detiene en `stella_0015`. Los tres
# paquetes que siguen NO son opcionales para esta batería y ninguno se aplica
# «best-effort»:
#
#   stella_0016  la aritmética reservada — sin ella `bind` no cuenta reservas y
#                los casos de contención entre categorías medirían el defecto en
#                vez del arreglo.
#   stella_0017  el cierre de la escritura directa — sin ella las cinco acciones
#                hermanas todavía podrían filar el ledger con `db.insert`, y el
#                caso «INSERT directo rechazado» pasaría por accidente.
#   stella_0018  la ligadura de categoría y la retirada del consumo sin ticket —
#                sin ella un ticket de una capacidad liga y cobra por la ruta de
#                otra (R6a) y `uellix_app` puede cobrar sin ticket (R6b).
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
  # M-8. LAST, and it must be here or §17 measures nothing: without it
  # `claim_active_document_version` takes a row lock on public.evidence_items,
  # PostgreSQL requires UPDATE to take one, `uellix_cap_grounding` holds only
  # SELECT, and every governed ingestion call by `uellix_app` dies with 42501
  # before reading a version. The chain would install cleanly and be dead on the
  # write side — which is precisely the state §17 used to pin and now refutes.
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
say "0. Nada pesado en curso, y el puerto libre"
# --------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -q "uellix-stella-ticket-e2e-"; then
  fail "ya hay un contenedor de esta batería corriendo — no se ejecutan dos gates pesados a la vez"
fi

# --------------------------------------------------------------------------
say "1. Integridad del manifiesto de baseline"
# --------------------------------------------------------------------------
[ -f "$BASE_DIR/MANIFEST.sha256" ] || fail "no hay manifiesto de baseline"
(cd "$BASE_DIR" && sha256sum -c MANIFEST.sha256) >/dev/null \
  || fail "el baseline no coincide con su manifiesto — se lee, nunca se escribe"
echo "  ok   baseline íntegro"

# --------------------------------------------------------------------------
say "2. PostgreSQL desechable, sin volúmenes, loopback"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker run -d --name "$BOX" \
  -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -D /etc/postgresql \
    -c cron.database_name=template1 -c pg_net.database_name=template1 >/dev/null \
  || fail "no se pudo crear el contenedor (¿puerto $PORT ocupado por un stack persistente?)"
# `cron.database_name` / `pg_net.database_name` apuntan a template1 y no a
# postgres, que es la base que §3 suelta y recrea. Con el valor por defecto los
# workers de background de pg_cron y pg_net siguen aferrados a `postgres`,
# mueren cuando desaparece, y el postmaster derriba TODA la sesión de restore
# ("terminating connection because of crash of another server process"). El
# mismo ajuste que stella-ticket-dry-run.sh, por la misma razón.

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
[ "$ok" -ge 3 ] || { docker logs --tail 20 "$BOX"; fail "el servidor desechable nunca arrancó"; }

# Cero volúmenes, afirmado sobre el contenedor real en vez de sobre la línea de
# comandos que lo creó.
MOUNTS=$(docker inspect -f '{{len .Mounts}}' "$BOX")
[ "$MOUNTS" = "0" ] || fail "el contenedor tiene $MOUNTS montaje(s); esta batería no persiste nada"
echo "  ok   contenedor arriba, 0 montajes, publicado sólo en 127.0.0.1:$PORT"

# --------------------------------------------------------------------------
say "3. Restore del baseline"
# --------------------------------------------------------------------------
for f in stella_g2_roles.sql stella_g2_schema.sql stella_g2_post_restore.sql; do
  docker cp "$(hp "$BASE_DIR/$f")" "$BOX:/$f" >/dev/null
done

# La base de fábrica que trae la imagen YA tiene los esquemas de Supabase, así
# que el dump del baseline colisiona con ellos ("schema auth already exists").
# Se recrea desde template0 — la misma maniobra que `restore_baseline` en
# stella-ticket-dry-run.sh — para que lo que se mida sea el baseline y no el
# baseline superpuesto a lo que la imagen trajera ese día.
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
[ "$dropped" = "1" ] || fail "no se pudo soltar la base postgres de fábrica"
docker exec "$BOX" psql -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE postgres TEMPLATE template0 OWNER postgres" >/dev/null \
  || fail "no se pudo recrear la base postgres"
"${PSQL[@]}" -q -f /stella_g2_roles.sql        >/dev/null || fail "restore de roles falló"
"${PSQL[@]}" -q -f /stella_g2_schema.sql       >/dev/null || fail "restore de schema falló"
"${PSQL[@]}" -q -f /stella_g2_post_restore.sql >/dev/null || fail "post-restore falló"
echo "  ok   baseline restaurado"

# --------------------------------------------------------------------------
say "4. Paquetes preparados, en orden de dependencia"
# --------------------------------------------------------------------------
# R2a — LA GUARDA DE ORDEN, EN EL CAMINO QUE DE VERDAD APLICA ESTOS PAQUETES.
#
# `db/prepared-package-order.ts` la impone en `applyPreparedScript`, que es el
# camino de `pnpm db:prepared:apply:local`. Ese camino NO puede aplicar
# `stella_0014` ni `stella_0015`: hace `SET LOCAL ROLE uellix_owner` y los dos
# paquetes exigen `rolsuper` en su §0. Lo señaló la revisión adversarial A y es
# exacto — la guarda estaba puesta donde no pasa el tren.
#
# La ruta real es `psql` como superusuario, que es lo que hace este guion y lo
# que dicen las cabeceras de los propios paquetes. Así que la precondición
# también vive AQUÍ, como una función de shell, y falla ANTES de aplicar el
# archivo: nada inseguro llega a publicarse.
#
# La regla es la MISMA que la del registro TypeScript, y no una copia que pueda
# derivar: `tests/cross-workstream/project-binding.test.ts` compara este guion
# contra `db/prepared-package-order.ts` y falla si dejan de coincidir.
#
# TREN 4.3. La regla dejó de ser una sola. `db/prepared-package-order.ts`
# registra SEIS supersesiones, y este guion las comprueba TODAS con la misma
# sonda que el registro declara — no con una copia abreviada. Cada entrada es
# «paquete : sonda del sucesor», y la sonda es literal, nunca compuesta.
package_order_guard() {
  local pkg="$1" installed probe superseder
  while IFS='|' read -r rule_pkg superseder probe; do
    [ "$rule_pkg" = "$pkg" ] || continue
    installed=$(Q "$probe")
    if [ "$installed" = "t" ]; then
      fail "DB_MIGRATOR_PACKAGE_ORDER_VIOLATION: $pkg.sql no puede aplicarse sobre una base que ya tiene $superseder.sql — ver db/prepared-package-order.ts"
    fi
  done <<'RULES'
stella_0014_operation_tickets|stella_0015_project_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL AS installed
stella_0015_project_bound_operation_tickets|stella_0016_reserved_quota_semantics|SELECT to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NOT NULL AS installed
stella_0015_project_bound_operation_tickets|stella_0017_governed_stella_consumption|SELECT to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL AS installed
stella_0016_reserved_quota_semantics|stella_0017_governed_stella_consumption|SELECT to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL AS installed
stella_0015_project_bound_operation_tickets|stella_0018_category_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL AS installed
stella_0016_reserved_quota_semantics|stella_0018_category_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL AS installed
stella_0017_governed_stella_consumption|stella_0018_category_bound_operation_tickets|SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL AS installed
grounding_0002_document_versions|grounding_0005_claim_advisory_lock|SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version' AND position('pg_advisory_xact_lock' in regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')) > 0) AS installed
RULES
}

for f in "${FORWARD[@]}"; do
  [ -f "db/prepared/$f.sql" ] || fail "falta db/prepared/$f.sql"
  package_order_guard "$f"
  docker cp "$(hp "db/prepared/$f.sql")" "$BOX:/$f.sql" >/dev/null
  "${PSQL[@]}" -q -f "/$f.sql" >/dev/null || fail "$f no aplicó"
  echo "  ok   $f"
done

# La afirmación que hace real al resto de la batería: las seis funciones
# gobernadas existen y la tabla de tickets también. Si esto falla, cualquier
# resultado posterior sería sobre una base que no tiene el protocolo.
FNS=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='uellix_stella_ops'")
[ "$FNS" = "8" ] || fail "se esperaban 8 funciones gobernadas en uellix_stella_ops, hay $FNS — ¿stella_0017 o stella_0018 no aplicaron?"
echo "  ok   8 funciones gobernadas presentes"

# 4a-bis. LA CADENA COMPLETA, COMPROBADA POR SUS OBJETOS Y NO POR EL HECHO DE
#         QUE EL ARCHIVO SE EJECUTÓ. Un paquete que se aplicó y cuya
#         verificación pasó igual podría no haber publicado lo que dice; se
#         pregunta al catálogo.
for sig in \
  'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)' \
  'uellix_stella.stella_capacity(uuid, character)' \
  'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)' \
  'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)' \
  'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)'
do
  [ "$(Q "SELECT to_regprocedure('$sig') IS NOT NULL")" = "t" ] \
    || fail "falta el objeto gobernado $sig — la cadena preparada está incompleta"
done
echo "  ok   los cinco objetos de la cadena 0013…0018 existen"

# 4b. El append-only del ledger viene del baseline, y se COMPRUEBA en vez de
#     suponerse: la batería cuenta cargos como deltas precisamente porque las
#     filas no se pueden retirar, y si el trigger no estuviera esa premisa
#     sería falsa sin que ninguna prueba lo notara.
APPEND_ONLY=$(Q "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_stella_interactions_append_only' AND NOT tgisinternal")
[ "$APPEND_ONLY" = "1" ] || fail "el ledger no es append-only en esta base (trigger encontrado: $APPEND_ONLY)"
echo "  ok   ledger append-only confirmado"

# 4d. R2-INT. Las CUATRO firmas ligadas al proyecto existen y las CUATRO ciegas
#     no. Se comprueba aquí, antes de que corra una sola prueba, porque toda la
#     batería de abajo mide atribución: contra una base con las firmas antiguas
#     invocables los casos cross-project «pasarían» describiendo el defecto en
#     vez del arreglo.
BOUND=$(Q "SELECT count(*) FROM (VALUES
  ('uellix_stella_ops.bind_operation_ticket(character, uuid, character)'),
  ('uellix_stella_ops.complete_operation_ticket(character, uuid, character)'),
  ('uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)'),
  ('uellix_stella_ops.inspect_operation_ticket(character, uuid)')
) AS f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL")
[ "$BOUND" = "4" ] || fail "se esperaban 4 firmas con proyecto de ejecución, hay $BOUND — ¿stella_0015 no aplicó?"

BLIND=$(Q "SELECT count(*) FROM (VALUES
  ('uellix_stella_ops.bind_operation_ticket(character, character)'),
  ('uellix_stella_ops.complete_operation_ticket(character, character)'),
  ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
  ('uellix_stella_ops.inspect_operation_ticket(character)')
) AS f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL")
[ "$BLIND" = "0" ] || fail "$BLIND firma(s) sin proyecto de ejecución siguen siendo invocables"

# Y ningún DEFAULT EN LOS CUATRO VERBOS LIGADOS AL PROYECTO: un argumento con
# DEFAULT es un argumento que el llamante puede omitir, y la garantía tiene que
# ser que la FIRMA rechace la llamada.
#
# Acotado a esos cuatro y no al esquema entero, que es lo que la primera versión
# de esta línea hacía y por lo que falló: `expire_operation_tickets` sí declara
# un DEFAULT (su cota de barrido), no nombra ningún ticket, no revela estado, no
# libera reservas vivas y no cobra — stella_0014 §2f. Exigirle lo mismo que a
# `bind` habría sido una aserción que sólo se puede satisfacer cambiando un
# paquete publicado por una razón que no existe. Es la misma cota que la propia
# verificación de stella_0015 (§4, 3b) se impone.
DEFAULTS=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='uellix_stella_ops'
    AND p.proname IN ('bind_operation_ticket','complete_operation_ticket',
                      'abort_operation_ticket','inspect_operation_ticket')
    AND p.pronargdefaults > 0")
[ "$DEFAULTS" = "0" ] || fail "$DEFAULTS función(es) declaran DEFAULT: el proyecto de ejecución puede omitirse"

PUB=$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE n.nspname='uellix_stella_ops' AND a.grantee = 0")
[ "$PUB" = "0" ] || fail "PUBLIC tiene EXECUTE sobre $PUB función(es) de uellix_stella_ops"
echo "  ok   4 firmas con proyecto, 0 ciegas, 0 DEFAULT, 0 EXECUTE para PUBLIC"

# 4e. R6-INT — NINGÚN PRINCIPAL DE RUNTIME ESCRIBE EL LEDGER.
#
#     Se pregunta con `has_table_privilege`, que SIGUE la pertenencia de rol,
#     y no leyendo `relacl`, que no la sigue: el defecto que stella_0017 cierra
#     es precisamente que `uellix_app` no tiene ninguna entrada propia y escribe
#     igual, por herencia de `uellix_writer`. Un guion que leyera `relacl`
#     informaría «cerrado» sobre una base abierta.
WRITERS=$(Q "SELECT count(DISTINCT r.rolname) FROM pg_roles r CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) AS p(priv)
  WHERE NOT r.rolsuper AND r.rolname <> 'uellix_owner' AND r.rolname <> 'uellix_cap_stella_quota'
    AND r.rolname NOT LIKE 'pg\\_%'
    AND has_table_privilege(r.oid, to_regclass('public.stella_interactions'), p.priv)")
[ "$WRITERS" = "0" ] || fail "$WRITERS principal(es) de runtime todavía pueden escribir stella_interactions — stella_0017 §1 no cerró"

# La segunda barrera, que no depende de ningún GRANT: sin identidad gobernada no
# hay fila, ni siquiera para el OWNER y ni siquiera bajo replica.
[ "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='stella_interactions_governed_identity_check' AND conrelid='public.stella_interactions'::regclass")" = "1" ] \
  || fail "falta stella_interactions_governed_identity_check — una fila sin identidad gobernada podría existir"

# COPY FROM cae con el privilegio INSERT, y además PostgreSQL lo rechaza sobre
# una relación con RLS activo. Se afirma la segunda barrera para que no se
# pierda en silencio si alguien devolviera la primera.
[ "$(Q "SELECT relrowsecurity FROM pg_class WHERE oid='public.stella_interactions'::regclass")" = "t" ] \
  || fail "RLS está desactivado sobre stella_interactions — COPY FROM dejaría de estar bloqueado por la relación"
echo "  ok   0 escritores de runtime, CHECK de identidad presente, RLS activo"

# 4f. R6a / R6b — LAS DOS RUTAS QUE stella_0018 RETIRA DEL RUNTIME.
#
#     No basta con que no haya llamantes en el código: mientras `uellix_app`
#     conserve EXECUTE, la ruta existe y una acción futura la alcanza sin que
#     ninguna prueba lo note.
#     Y son TRES superficies, no dos. `consume_stella_capacity` es la envoltura
#     de stella_0016 y nunca tuvo llamante; `consume_stella_quota` es la que esa
#     envoltura LLAMA, está concedida a uellix_app por stella_0013 §7, ningún
#     paquete de la cadena 0014→0017 la retira, y cuenta SÓLO filas cobradas —
#     así que es un cobro sin ticket que además es ciego a una reserva viva.
for pair in \
  "uellix_stella_ops.bind_operation_ticket(character, uuid, character)|el bind SIN categoría esperada (R6a)" \
  "uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)|el consumo SIN ticket (R6b)" \
  "uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)|el cargo SIN ticket ni reserva (R6b)"
do
  sig="${pair%%|*}"; label="${pair##*|}"
  UNSAFE=$(Q "SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) FROM pg_roles r
    WHERE r.rolname IN ('uellix_app','authenticated','anon','service_role','uellix_writer','uellix_reader','uellix_auditor','authenticator')
      AND has_function_privilege(r.oid, to_regprocedure('$sig'), 'EXECUTE')")
  [ -z "$UNSAFE" ] || fail "$UNSAFE puede ejecutar $label — stella_0018 no cerró esa superficie"
done
# ...y la ruta que el runtime SÍ necesita, o no se puede ligar nada.
[ "$(Q "SELECT has_function_privilege('uellix_app','uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)','EXECUTE')")" = "t" ] \
  || fail "uellix_app no puede ejecutar el bind ligado a categoría — ninguna operación podría reservar"
echo "  ok   0 rutas de runtime hacia el bind sin categoría y hacia el consumo sin ticket"

# 4c. Credenciales para las DOS conexiones de la batería.
#
# `POSTGRES_HOST_AUTH_METHOD=trust` sólo cubre el arranque de la imagen; el
# pg_hba que el baseline deja exige contraseña para conexiones por TCP, que es
# como Node se conecta. Se fijan AQUÍ, después del restore, porque el restore
# recrea los roles y borraría cualquier contraseña puesta antes.
#
# El valor es un literal efímero de este contenedor: no es un secreto, no sale
# de loopback, y el contenedor se destruye al salir. No se lee de .env ni se
# escribe en ninguna parte.
E2E_PASSWORD='e2e-disposable'
# `supabase_admin` y no `postgres`: en esta imagen `postgres` NO es
# superusuario y no tiene privilegio sobre las tablas que `uellix_owner` posee
# (evidence_document_versions, evidence_chunks). La conexión privilegiada de la
# batería siembra esas tablas, así que necesita el rol que el propio §4 usa
# para aplicar los paquetes.
"${PSQL[@]}" -q -c "ALTER ROLE supabase_admin WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
"${PSQL[@]}" -q -c "ALTER ROLE uellix_app     WITH PASSWORD '${E2E_PASSWORD}'" >/dev/null
echo "  ok   credenciales efímeras fijadas para supabase_admin y uellix_app"

# --------------------------------------------------------------------------
say "5. Batería de runtime (Node, server action real)"
# --------------------------------------------------------------------------
# `env -u GEMINI_API_KEY`: la clave no se lee, no se imprime y no está en el
# entorno del proceso hijo. La prueba vuelve a afirmarlo desde dentro.
# `MSYS_NO_PATHCONV=1` está puesto arriba para que Git Bash no convierta las
# rutas `/archivo.sql` que van DENTRO del contenedor. Aquí estorba: corrompe la
# ruta de Windows con la que corepack localiza pnpm. Se desactiva sólo para
# esta invocación en vez de globalmente, porque las secciones de docker de
# arriba sí la necesitan.
set +e
UELLIX_RUNTIME_DATABASE_URL="postgresql://uellix_app:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_TICKET_E2E_ADMIN_URL="postgresql://supabase_admin:${E2E_PASSWORD}@127.0.0.1:${PORT}/postgres" \
UELLIX_TICKET_E2E=1 \
  env -u MSYS_NO_PATHCONV -u GEMINI_API_KEY \
  pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/stella-ticket-journey.e2e.test.ts --reporter=verbose
RESULT=$?
set -e

# --------------------------------------------------------------------------
say "6. Teardown"
# --------------------------------------------------------------------------
docker rm -f "$BOX" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -qx "$BOX"; then
  fail "el contenedor sobrevivió al teardown"
fi
echo "  ok   contenedor eliminado, cero residuos"

exit $RESULT
