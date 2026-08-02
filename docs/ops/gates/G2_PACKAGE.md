# G2 — Paquete maestro de base de datos (Stella Fable Moonshot)

> Gate externo G2 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`). Dueño humano:
> **Lorenzo**. Nada de este paquete se aplica automáticamente: drizzle, CI y
> los agentes tienen prohibido tocarlo. Complementa — no sustituye —
> `docs/ops/SUPABASE_MIGRATION_GATE.md` y
> `docs/ops/SUPABASE_STAGING_MIGRATION_CHECKLIST.md`.

## Relación con la capa de seguridad de destino (2026-08-02)

El repositorio incorporó una arquitectura *fail-closed* de acceso a base de
datos (`db/safety/`, documentada en
[`docs/ops/DATABASE_TARGET_SAFETY.md`](../DATABASE_TARGET_SAFETY.md)). Qué
significa para este gate:

- **No cambia nada del procedimiento de G2.** Este paquete se sigue aplicando
  con `psql` sobre los archivos revisados de `db/prepared/`. Ningún comando de
  `package.json` escribe en un destino remoto, y las capacidades
  `controlled_remote_*` de la nueva capa **no las usa ningún entry point hoy**.
- **Sí cierra el riesgo lateral** que este gate arrastraba: los comandos
  ambiguos (`db:seed:proxies`, `db:seed:taxonomies`, `db:migrate`) ya no
  pueden alcanzar un destino remoto por accidente durante la preparación del
  gate. Están bloqueados y sus reemplazos son local-only por construcción.
- **La precondición humana del rol escritor de `stella_0003` sigue vigente
  e inalterada** (ver la sección siguiente). La nueva capa autoriza *dónde* se
  conecta un proceso; no puede observar *con qué rol* resuelve `DATABASE_URL`.

**Esto no declara G2 aprobado ni ejecutado.** G2 formal sigue exigiendo el
entorno remoto autorizado y las precondiciones humanas de este documento.

## Alcance

Aplicar (y saber revertir) contra **staging** — nunca producción directamente:

| Orden | Script | Rollback | Qué hace |
|-------|--------|----------|----------|
| 1 | `db/prepared/stella_0002_interactions_hardening.sql` | `db/prepared/stella_0002_rollback.sql` | Trigger append-only en `stella_interactions` + revoca `UPDATE/DELETE` de `authenticated` (bug de `0033:50`) + reconcilia el CHECK de `stella_role` al set de 6 roles |
| 1b | `db/prepared/stella_0002b_append_only_truncate_hardening.sql` | `db/prepared/stella_0002b_rollback.sql` — **deliberadamente NO reversible** | Cierra el hueco de `TRUNCATE` en las **cuatro** tablas append-only: revoca `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` de `authenticated` y además `UPDATE/DELETE` de `service_role`, y añade 4 triggers `BEFORE TRUNCATE FOR EACH STATEMENT` (única capa que alcanza al **owner**) |
| 2 | `db/prepared/stella_0003_suggestion_decisions.sql` | `db/prepared/stella_0003_rollback.sql` | Crea `stella_suggestion_decisions` (decisiones humanas sobre sugerencias) con RLS SELECT-only, `REVOKE ALL` previo a los grants y sus 2 triggers append-only |
| 3 | `db/prepared/grounding_0001_evidence_chunks.sql` | `db/prepared/grounding_0001_rollback.sql` | Ver addendum dedicado: `docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md` (tiene precondiciones propias: pgvector + decisión G5 P3) |
| — | `db/prepared/stella_0004_role_separation.sql` | `db/prepared/stella_0004_rollback.sql` | **FUERA DEL ALCANCE DE G2 REMOTO POR AHORA** — ver la sección siguiente |

## `stella_0004` — separación de roles: local sí, remoto bloqueado

`stella_0004_role_separation.sql` cierra RK-04c (los *default privileges*
globales) y traslada el ownership de los 46 objetos de `public` fuera del rol
del runtime. Está **ensayado y aplicado en local**, con dry-run desechable,
idempotencia, rollback y reaplicación verificados.

**No entra en G2 remoto todavía**, y la razón es concreta, no de prudencia
genérica:

| Bloqueador | Detalle |
|---|---|
| **RR-09** | `GRANT USAGE ON SCHEMA auth TO uellix_owner` **no es ejecutable como `postgres`** en Supabase gestionado: `auth` pertenece a `supabase_auth_admin` y `postgres` tiene `USAGE` sin `GRANT OPTION`. Sin ese grant, las 3 funciones `SECURITY DEFINER` que llaman a `auth.uid()` fallan con `permission denied for schema auth` **para todos los invocantes** — toda la RLS del producto. |
| **RR-03** | El `pg_default_acl` de `supabase_admin` (que concede los **8** privilegios a `anon` sobre toda tabla que ese rol cree en `public`) no es corregible desde hosted. |
| **RR-02** | En hosted, `postgres` retiene `ADMIN OPTION` sobre cualquier rol que cree, así que la separación owner/runtime es un obstáculo auditable, no una barrera. |

Contrato completo, matriz de privilegios y decisiones de compatibilidad:
[`docs/ops/DATABASE_ROLE_MODEL.md`](../DATABASE_ROLE_MODEL.md).

**Consecuencia operativa si algún día se aplica:** tras `stella_0004`, los
scripts 1, 1b y 2 de la tabla anterior ya **no** pueden ejecutarse como
`postgres` — emiten `REVOKE`, `GRANT`, `CREATE TRIGGER` y `ALTER TABLE`, y todo
eso exige ownership. Se ejecutan como `uellix_migrator` con `SET ROLE
uellix_owner` explícito. Sobre una base donde `0004` **no** se ha aplicado
(hoy: todas las remotas), el procedimiento de este documento no cambia en nada.

El orden 1→1b→2 importa: **1b exige que 1 ya esté aplicado** (su guarda de
precondición verifica el trigger `trg_stella_interactions_append_only`, además
de los otros tres triggers de fila). El paso 2 referencia `stella_interactions`,
que ya existe. El addendum de grounding (3) es independiente y puede aplicarse
en otra sesión.

**Por qué existe un `1b` en vez de modificar el `1`:** `stella_0002` ya fue
verificado y su evidencia (hash incluido) está publicada. Editarlo invalidaría
esa evidencia y obligaría a repetir su ensayo completo, sin ganar nada:
`stella_0002` hizo exactamente lo que declaraba. El hallazgo que `1b` repara
(RK-04b) es **preexistente y sistémico** — viene de los `ALTER DEFAULT
PRIVILEGES` de Supabase, no de `stella_0002`. Una unidad separada mantiene un
cambio por propósito y cada uno con su propio gate.

**Rollback de 1b:** política `SAFE_NON_REVERSING_ROLLBACK`. No vuelve a conceder
`TRUNCATE` ni borra los triggers: no hay regresión funcional de la que revertir
(ningún camino de código usa esos privilegios), así que lo único que lograría
revertir sería reabrir el hueco en una tabla audit-ready. Ver la cabecera del
propio archivo para las cuatro acepciones de "rollback" y la vía DBA explícita
para los casos reales.

## Precondición humana — rol escritor de `stella_0003`

**Esto no lo puede verificar ningún SQL.** `stella_0003` necesita saber con qué
rol se conecta la aplicación (`DATABASE_URL`), y esa información vive en el
entorno, no en la base. El script comprueba la parte estructural (owner, ACL
directa, `rolbypassrls`); confirmar la correspondencia es tarea del operador.

- [ ] Averiguar el rol de `DATABASE_URL` **sin imprimir la connection string**
      (basta el componente de usuario; en Supabase suele ser `postgres`).
- [ ] Declararlo al aplicar — **cómo hacerlo depende de la vía**; ver la tabla
      justo debajo de esta checklist. No todas las vías admiten un `SET` de
      sesión, y sin declararlo el gate **no** queda verificado.
- [ ] Confirmar tras aplicar que el `NOTICE` dice
      **`write path VERIFIED against declared writer role …`**.
      Si dice `stella.writer_role is UNSET — … ASSUMPTION, not a verification`,
      **el gate no está verificado**: se aplicó asumiendo que instalador y
      writer coinciden. Repetir declarando la variable.

Cómo declarar `stella.writer_role` según la vía de aplicación:

| Vía de aplicación | Cómo declarar el writer |
|---|---|
| `psql` (recomendada) | `psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -c "SET stella.writer_role='<rol>'" -f db/prepared/stella_0003_suggestion_decisions.sql` |
| `supabase db execute --file` | **No admite un `SET` previo en la misma sesión.** Fijarlo antes a nivel de base: `ALTER DATABASE <db> SET stella.writer_role = '<rol>';` (persiste; revertir después con `ALTER DATABASE <db> RESET stella.writer_role;`) |
| SQL Editor de Supabase | Igual: `ALTER DATABASE … SET` previo, o anteponer el `SET` como primera sentencia del mismo bloque pegado |

**Sin ninguna de estas, el script cae a la rama ASSUMPTION y el gate no queda
verificado.**

Motivo: la guarda anterior usaba `has_table_privilege(current_user, …)`, que
devuelve `true` para cualquier superusuario — era ciega justo cuando el script
se aplicaba con tooling como `supabase_admin`.

## Precondiciones (todas binarias)

- [ ] Migraciones base al día en staging: `0030_immutability.sql` aplicada
      (existe `public.uellix_forbid_mutation()` — `stella_0002` falla con un
      error explícito si no), `0033_public_api_grants.sql` aplicada, helpers
      RLS (`current_user_org_ids`, `current_user_is_super_admin`) creados y
      ejecutables (estado ≥ `0032` + `0039`).
- [ ] `db/policies/002_stella_interactions_rls.sql` aplicada (RLS activo en
      `stella_interactions` con solo la política SELECT).
- [ ] Backup de staging registrado y restaurable por un humano.
- [ ] Suite offline verde en el branch:
      `pnpm vitest run tests/prepared-stella-sql.test.ts lib/grounding`.
- [ ] `STELLA_DECISIONS_PERSISTENCE_ENABLED` **no** está seteada en ningún
      entorno (la action debe seguir dormida hasta después de verificar).

## Aplicación (staging)

**Método principal — psql con transacción única (preferido):**

```bash
# con el connection string de STAGING (¡verificar dos veces el host!)
# -1 = todo el script en UNA transacción: si algo falla no queda estado parcial
#      (rollback automático); como además los statements son idempotentes y
#      convergentes, re-ejecutar el script tras corregir también recupera.
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002_interactions_hardening.sql
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0003_suggestion_decisions.sql
```

**Alternativa — supabase CLI** (proyecto de staging linkeado). Verificar antes
que el proyecto linkeado es el correcto (`supabase projects list`):

```bash
supabase db execute --file db/prepared/stella_0002_interactions_hardening.sql
supabase db execute --file db/prepared/stella_0003_suggestion_decisions.sql
```

**Último recurso — SQL Editor de Supabase** (staging, rol admin): pegar y
ejecutar cada script completo, en orden. Solo si las dos vías anteriores no
están disponibles: el editor no garantiza por contrato la ejecución
transaccional del script completo, y un fallo a mitad podría dejar una tabla
creada con RLS aún sin habilitar. Si se usa esta vía, **verificar el estado
parcial explícitamente** con las consultas de "Verificaciones post-aplicación"
antes de continuar.

### Garantías de los scripts (endurecimiento pre-ejecución, 2026-07-31)

Los tres scripts preparados fueron endurecidos antes de este gate:

- `SET search_path = public;` y todos los objetos cualificados con `public.`;
- **guardas de precondición** que fallan con mensaje accionable si falta
  `uellix_forbid_mutation()`, una tabla referenciada o los helpers RLS;
- **guarda de forma**: si la tabla destino ya existe con columnas o tipos
  incompatibles, el script **aborta** listando las columnas discrepantes en
  lugar de hacer un no-op silencioso (los mensajes reportan nombres y tipos de
  columna, nunca datos de filas);
- **idempotencia convergente**: sobre una base ya endurecida, re-ejecutar
  reconcilia constraints, índices, grants, RLS y política;
- cero `CREATE INDEX CONCURRENTLY` → compatibles con `-1`.

Ver `db/prepared/README.md` y `docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md`.

## Verificaciones post-aplicación

```sql
-- 1. Trigger append-only adjunto a stella_interactions
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.stella_interactions'::regclass AND NOT tgisinternal;
-- esperado: trg_stella_interactions_append_only

-- 2. Grants reducidos.
--
--    CORREGIDO 2026-08-02. Esta verificación usaba
--    information_schema.role_table_grants, igual que la verificación 6 antes de
--    RK-04e. Es inservible como criterio de gate por DOS razones distintas, y
--    la segunda hacía que su expectativa declarada fuese literalmente
--    incomprobable:
--
--      (a) EXPANDE PRIVILEGIOS POR MEMBRESÍA. `postgres` es miembro de
--          `authenticated` y `service_role` con inherit=true, así que la vista
--          le atribuye privilegios que su ACL directa no contiene. Sobre
--          stella_interactions devolvía 11 filas frente a 4 concesiones reales.
--
--      (b) NO PUEDE EXPRESAR `PUBLIC`. El grantee PUBLIC es el OID 0, que no
--          es una fila de pg_roles, así que la vista sencillamente lo omite.
--          La línea "esperado para anon / PUBLIC: ninguna fila" era, para
--          PUBLIC, INFALSIFICABLE: se cumplía igual en una base donde PUBLIC
--          lo tuviera todo.
--
--    aclexplode() sobre relacl lee la ACL literalmente, y COALESCE con
--    acldefault() es obligatorio porque un relacl NULO no significa "sin
--    privilegios" sino "el default del tipo de objeto".
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
WHERE c.oid = to_regclass('public.stella_interactions')
ORDER BY 1, 2;
-- esperado para authenticated: INSERT, SELECT (sin UPDATE ni DELETE)
-- esperado para anon y para PUBLIC: ninguna fila — y ahora sí es comprobable
-- esperado para el owner: los 8 privilegios (es el owner, no una concesión)

-- 3. CHECK de stella_role EXACTAMENTE con los 6 roles (no un superset)
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.stella_interactions'::regclass
  AND conname = 'stella_interactions_stella_role_check';
-- esperado: contiene 'advisor','validator','composer','proxy_reviewer',
--           'evidence_reviewer','audit_assistant' Y NINGÚN otro literal.
--           Leer la definición completa: la guarda del script comprueba
--           presencia, no ausencia de roles extra.

-- 4. Mutación bloqueada INCLUSO para el rol admin/service (trigger).
--    Ejecutar y esperar el FALLO "append-only: UPDATE on stella_interactions
--    is not permitted":
-- UPDATE stella_interactions SET pipeline_step = 'x' WHERE false;
--    (con WHERE false no toca filas pero valida permisos de plan; para probar
--     el trigger de verdad, usar una fila sintética de staging:)
-- UPDATE stella_interactions SET pipeline_step = 'x'
--   WHERE id = '<id de fila de prueba>';   -- debe FALLAR
-- DELETE FROM stella_interactions
--   WHERE id = '<id de fila de prueba>';   -- debe FALLAR

-- 5. La tabla de decisiones existe con RLS activo y UNA política (SELECT)
SELECT relrowsecurity FROM pg_class WHERE relname = 'stella_suggestion_decisions'; -- t
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'stella_suggestion_decisions';
-- esperado: stella_suggestion_decisions_select | SELECT — y ninguna otra

-- 6. Grants DIRECTOS de la tabla nueva.
--
--    NO uses information_schema.role_table_grants aquí. Esa vista expande los
--    privilegios que el rol de la sesión alcanza por MEMBRESÍA, y en Supabase
--    `postgres` es miembro de `authenticated` y de `service_role` (verificado:
--    pg_has_role('postgres','authenticated','MEMBER') = t). Devolvería filas del
--    owner y heredadas, y el gate se leería como fallo aunque el estado fuera
--    correcto — un falso rojo.
--
--    aclexplode() sobre pg_class.relacl lee la ACL LITERALMENTE: solo concesiones
--    directas, sin herencia y sin el atajo de superusuario.
SELECT g.rolname AS grantee, a.privilege_type
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
JOIN pg_roles g ON g.oid = a.grantee
WHERE c.oid = to_regclass('public.stella_suggestion_decisions')
  AND g.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY g.rolname, a.privilege_type;
-- esperado: EXACTAMENTE una fila -> authenticated | SELECT
--           anon y service_role: sin filas. PUBLIC no aparece (grantee = 0).

-- 6b. Y que PUBLIC no tenga nada (grantee 0 en la ACL):
SELECT count(*) AS public_grants
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
WHERE c.oid = to_regclass('public.stella_suggestion_decisions') AND a.grantee = 0;
-- esperado: 0

-- 7. CHECKs de la tabla nueva — leer la DEFINICIÓN, no solo el nombre.
--    Un CHECK con el nombre correcto y una definición obsoleta (p. ej. sin
--    'undone') pasaría un chequeo por nombre y rompería recordStellaDecision
--    en runtime, después de dar el gate por verde.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.stella_suggestion_decisions'::regclass AND contype = 'c'
ORDER BY conname;
-- esperado:
--   stella_suggestion_decisions_decision_check  -> incluye los 4 valores
--       'accepted', 'accepted_edited', 'rejected', 'undone'
--   stella_suggestion_decisions_prev_hash_check -> incluye [0-9a-f]{64}
```

Después de las verificaciones SQL: correr el paquete G3
(`docs/ops/gates/G3_PACKAGE.md`) — `pnpm test:rls` contra staging con los
`describe.skip` post-G2 activados.

Criterio de aprobación binario: **todas** las verificaciones 1–7 dan el
resultado esperado y G3 pasa sin regresiones.

## Criterios de aborto

**Abortar** significa: no continuar con el siguiente script, no flipear flags,
no avanzar a G3. Si la transacción ya falló, `-1` garantiza que no quedó estado
parcial; si se usó el SQL Editor, verificar el estado antes de reintentar.

| # | Causa de aborto | Cómo se detecta | Qué hacer |
|---|---|---|---|
| A1 | **Host equivocado** — el connection string no apunta al proyecto de staging designado | Verificar el host **antes** de ejecutar (`echo "${STAGING_DATABASE_URL%%\?*}"` sin exponer credenciales, o `supabase projects list`). Producción y local nunca son destinos válidos de este paquete | Detener. No ejecutar nada. Corregir el destino y reiniciar el checklist desde las precondiciones |
| A2 | **Backup no verificable** — no existe backup de staging registrado, o no se puede confirmar que es restaurable | Precondición binaria del paquete, sin evidencia | Detener. Tomar y verificar el backup antes de cualquier DDL |
| A3 | **Migraciones base ausentes** — falta `uellix_forbid_mutation()`, falta una tabla referenciada, o faltan los helpers RLS | Los propios scripts abortan con `RAISE EXCEPTION` citando qué migración aplicar (`0030`, `0031`+`0039`) | Detener. Aplicar las migraciones base por su propio camino y volver a empezar |
| A4 | **Feature flag encendido** — `STELLA_DECISIONS_PERSISTENCE_ENABLED` está en `true` en algún entorno apuntando a esta base | Revisar env vars en Vercel (Preview y Production) antes de ejecutar | Detener. Apagar el flag primero: la action debe seguir dormida hasta que el gate esté verificado |
| A5 | **Forma incompatible de objetos preexistentes** — la tabla destino ya existe con columnas o tipos distintos | El script aborta con `... already exists with an INCOMPATIBLE shape. Missing or mismatched columns: ...` | Detener. **No** forzar. Investigar de dónde salió esa tabla; la resolución es manual y probablemente merece su propio gate |
| A6 | **Fallo de cualquier verificación post-apply** — alguna de las 7 consultas no devuelve el resultado esperado | Sección "Verificaciones post-aplicación" | Detener. Evaluar rollback (ver más abajo). No avanzar a G3 con una verificación en rojo |
| A7 | **Estado parcial detectado** — la tabla existe pero sin RLS, sin política, o con grants más amplios de lo esperado | Verificaciones 5, 6 y 2. Riesgo real solo si se usó el SQL Editor | Detener. Re-ejecutar el script completo con `psql -1` (es convergente) y volver a verificar. Si persiste, rollback |
| A8 | **Decisión G5 P3 ausente o pgvector no disponible** — solo aplica al addendum de grounding | El script `grounding_0001` aborta con mensaje explícito | Detener **solo el addendum**. `stella_0002`/`0003` no dependen de G5 y pueden continuar |

Regla transversal: ante cualquier duda sobre el destino o el estado,
**abortar es siempre la opción correcta** — estos scripts son convergentes y
re-ejecutables, así que detenerse nunca cuesta trabajo perdido.

### Aclaración sobre A1 — ensayo estructural local

A1 se refiere al destino de **la ejecución formal del gate**. Ni producción ni
una base local son jamás destinos válidos para **declarar G2 ejecutado**.

Existe, sin embargo, un procedimiento distinto y explícitamente acotado:
`docs/ops/LOCAL_STAGING_G2_REHEARSAL.md` permite aplicar estos scripts contra
un stack Supabase **local y desechable** exclusivamente como **ensayo
estructural** — comprobar que el SQL corre en un PostgreSQL real, que es
idempotente y que sus verificaciones son ejecutables, antes de tocar el entorno
autorizado.

Ese ensayo **no satisface, no aprueba y no adelanta G2**:

- una base local **no es staging** y no debe reportarse como tal;
- ninguna corrida local puede marcar las casillas de *Precondiciones* de este
  paquete ni habilitar el avance a G3;
- la ejecución formal exige el **entorno remoto autorizado** y las
  precondiciones humanas correspondientes (backup verificado, flags apagados,
  aprobación explícita).

Dicho de otro modo: el ensayo local responde *"¿el script funciona?"*; G2
responde *"¿estamos autorizados a cambiar el entorno real, y quedó verificado
allí?"*. Aprobar lo primero nunca implica lo segundo.

## Post-aplicación (flags)

Solo después de staging verde:

- [ ] Flip de los `describe.skip` en `tests/integration/rls.test.ts`
      (ver G3_PACKAGE.md) en un commit propio.
- [ ] Recién entonces se puede considerar `STELLA_DECISIONS_PERSISTENCE_ENABLED=true`
      en Preview (decisión separada de Lorenzo, nunca parte de este gate).

## Rollback

### `stella_0003_rollback.sql` es destructivo, y se protege solo

Es el único script del paquete que **borra un audit trail**. `DROP TABLE`
elimina la tabla **y sus dos triggers append-only en la misma sentencia**, así
que ninguna protección de base de datos puede detenerlo: los triggers prohíben
`UPDATE`/`DELETE`/`TRUNCATE`, no `DROP`.

**Autorización.** Con la tabla vacía el rollback es técnico y corre solo. Con
**una o más filas** aborta salvo que el operador declare, con la cadena
**exacta** `'true'`:

```bash
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET stella.confirm_destroy_decisions='true'" \
  -f db/prepared/stella_0003_rollback.sql
```

`yes`, `y`, `1`, `TRUE`, `True`, `on`, `t` y cualquier variante con espacios se
**rechazan**: borrar un audit trail no debe depender de la coerción booleana de
un cliente. Quién autorizó, cuándo y por qué va en el registro del gate.
**Exportar las filas antes** (`SELECT * FROM public.stella_suggestion_decisions
ORDER BY decided_at;`).

**La autorización debe ser de ESTA corrida.** El script aborta si detecta el
ajuste **persistido** vía `ALTER DATABASE … SET` o `ALTER ROLE … SET` (lo lee de
`pg_db_role_setting`): una autorización permanente pre-aprueba toda sesión
futura y no deja ningún acto humano por corrida que registrar. Si aparece ese
error, hacer `ALTER DATABASE … RESET stella.confirm_destroy_decisions` y
autorizar con un `SET` de sesión.

- [ ] **Precondición humana:** el `SET` de sesión lo teclea el operador en la
      sesión que ejecuta el rollback. SQL puede exigir que la autorización sea
      de sesión; **no** puede distinguir a un operador de un script envolvente.
      Ese último tramo es responsabilidad del gate, igual que la correspondencia
      entre `DATABASE_URL` y `stella.writer_role`.

**Precondiciones estructurales** (el script aborta, con mensaje prefijado, si
alguna falla):

- `transaction_isolation` en `READ COMMITTED` (o `READ UNCOMMITTED`, que
  PostgreSQL implementa igual). Bajo `REPEATABLE READ` o `SERIALIZABLE` el
  snapshot se fija **antes** del `LOCK`, el conteo puede no ver filas
  confirmadas en esa ventana, y el script clasificaría una tabla poblada como
  vacía. Si un rol o base lleva `default_transaction_isolation` distinto,
  limpiarlo o usar `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
- ser **dueño** de la tabla, o tener sus privilegios **heredados** — si no, no
  puede ni bloquearla ni borrarla;
- `FORCE ROW LEVEL SECURITY` **apagado** (el estado que `stella_0003` verifica),
  porque `count(*)` está sujeto a RLS: un rol propietario sin `rolbypassrls`
  contaría 0 sobre una tabla poblada y el rollback la trataría como vacía;
- poder leer `pg_catalog.pg_db_role_setting`, el único catálogo que revela una
  autorización persistida. Si no se puede leer, el script **rehúsa** en vez de
  saltarse la comprobación.

**Un aborto que NO llevará el prefijo.** Si alguna vez existe una vista o una FK
entrante hacia esta tabla, el `DROP` falla con el mensaje nativo de PostgreSQL
(*"cannot drop table … because other objects depend on it"*). Es **inofensivo**:
nada se destruye, la transacción aborta y la tabla queda intacta. No hay
pre-chequeo para convertirlo en un mensaje prefijado, y eso es **deliberado** —
ver `db/prepared/stella_0003_rollback.sql`, sección *NO DEPENDENT-OBJECT
PRE-CHECK*: dos intentos de re-derivar la resolución de dependencias de
PostgreSQL en SQL produjeron dos defectos reales, el segundo de los cuales
habría abortado **todas** las ejecuciones. Resolver la dependencia por su propio
gate y reejecutar. (2) Un rol sin `USAGE` sobre el esquema `public` falla dentro
de `to_regclass` con `permission denied for schema public`, antes de leer o
bloquear nada. Ambos son **inofensivos**: cierran en falso y no destruyen.

### La protección es estructural, no depende de las banderas de `psql`

**Defecto corregido el 2026-08-01.** La guarda era un `DO $$ … $$;` y el
`DROP TABLE IF EXISTS` una sentencia top-level **posterior e independiente**.
Sin `-v ON_ERROR_STOP=1`, `psql` reporta el error de la guarda y **envía la
siguiente sentencia** — el `DROP`; sin `-1`, tampoco hay transacción que
revierta. Demostrado empíricamente sobre PostgreSQL 17.6 en un contenedor
desechable: con `psql` desnudo, la forma anterior **destruyó la tabla y su fila
pese a que la guarda lanzó la excepción**.

Eso importa aquí más que en otros scripts porque este paquete admite tres vías
de aplicación y **sólo la primera acepta esas banderas**: `psql`,
`supabase db execute --file` y el SQL Editor de Supabase (ver *Aplicación*).

Hoy guarda y `DROP` viven en **un único bloque `DO`**: un `RAISE EXCEPTION`
termina el bloque y ninguna sentencia posterior *de ese bloque* se ejecuta —
semántica del servidor dentro de una sola sentencia. `-1 -v ON_ERROR_STOP=1`
siguen **recomendadas** (atomicidad y exit code no-cero para un gate que lo
lee), pero ya **no son la única barrera**.

### Ensayo destructivo controlado — RUN 1 (2026-08-02)

**El rollback de `stella_0003` NO ha sido ejecutado contra staging ni contra
producción.** Sí se ejecutó **una vez**, de forma controlada, contra el stack
**local desechable** `uellix-stella-g2-local-rehearsal` (PostgreSQL 17.6,
`127.0.0.1:56322`), en el worktree `codex/stella-g2-local-rehearsal`, HEAD
`12715d8`. Registro completo en
`docs/ops/LOCAL_STAGING_G2_REHEARSAL.md` §*STELLA 0003 ROLLBACK REHEARSAL —
RUN 1* y en `docs/ops/STELLA_FABLE_TEST_LEDGER.md` (2026-08-02).

**Esto NO marca ninguna casilla de este paquete.** Una base local no es
staging: el gate remoto sigue sin ejecutar, y ni la aplicación de `stella_0002`,
`stella_0002b` o `stella_0003` ni su rollback quedan aprobados por esta corrida.
Lo que aporta es evidencia de comportamiento, que hasta ahora no existía: el
rollback estaba verificado sobre su **texto** (246 pruebas de fuente de verdad,
58 mutantes detectados) y nunca había destruido nada.

Qué se observó, en el orden en que un DBA lo repetiría:

1. **Respaldo primero.** `pre_g3_local.dump` validado en tamaño (581 736 bytes)
   y SHA-256 (`d46280c4…b436aeb`), `pg_restore -l` en solo lectura → **1155**
   entradas TOC y **87** `TABLE DATA`, y duplicado a una ubicación estable fuera
   de `TEMP`, del repositorio y de carpetas sincronizadas, con hash idéntico.
   **Ninguno restaurado.**
2. **Identidad del artefacto.** SHA-256 `e9498d02…c4b12e4b` en el working tree,
   idéntico al canónico Git (el archivo está en LF), blob ID coincidente con el
   registrado en `HEAD`, `git diff HEAD` vacío, y el hash **recalculado dentro
   del contenedor** antes de ejecutar.
3. **Autorización por sesión, no persistente.** Un solo `psql`, una conexión,
   una transacción (`-1 -v ON_ERROR_STOP=1`), con
   `-c "SET stella.confirm_destroy_decisions = 'true';"` **precediendo** al
   `-f`. Sin `ALTER ROLE`, `ALTER DATABASE` ni `PGOPTIONS`: la guarda de
   `pg_db_role_setting` habría abortado si la autorización hubiese sido
   permanente.
4. **Ejecución destructiva.** Exit **0**, ~1 s. **1** fila detectada, banner de
   13 líneas verbatim, **1** `RAISE WARNING`, tabla eliminada, transacción
   confirmada.
5. **Delta cerrado.** Comparación de línea base pre/post: **−1** tabla, **−1**
   policy, **−2** triggers append-only (10 → **8**), **−3** índices, **−7**
   constraints, **−1** grant — y **nada más**. Funciones 8 → 8, migraciones
   2 → 2, `stella_interactions` con sus **2** filas, y
   `organizations`/`users`/`projects`/`organization_members` sin cambio: las FKs
   de la tabla eran salientes, así que el `DROP` sin `CASCADE` no alcanzó a los
   padres. `uellix_forbid_mutation()` intacta.
6. **Idempotencia.** Segunda corrida en sesión nueva y **sin** autorización:
   exit 0, `NOTICE` de tabla ausente, no-op, **cero** banner y **cero**
   `WARNING`; línea base idéntica byte a byte a la del postcheck.

**Lo que este ensayo NO cubre.** Volumen mínimo (1 decisión): no mide contención
de `lock_timeout='5s'` frente a un `ACCESS EXCLUSIVE` sobre una tabla activa
—el escenario de staging bajo carga—, ni el camino en el que el dueño de la
tabla **no** es el rol con el que se conecta. Ambos siguen sin observar. La
verificación 3 de esta sección (exportar las filas antes de destruirlas) tampoco
se ejercitó: en el ensayo se destruyó la fila deliberadamente.

### Orden

1. Ejecutar en orden inverso:
   `db/prepared/stella_0003_rollback.sql` (¡exportar filas antes si hubo
   decisiones registradas! — ver arriba y el comentario en el script), luego
   `db/prepared/stella_0002_rollback.sql`.
2. Tener presente que el rollback de `stella_0002` restaura un estado
   **bug-compatible** (grants CRUD de `0033:50` sobre una tabla documentada
   append-only) y NO revierte el CHECK de 6 roles — ambos documentados en el
   propio script.
3. Verificar:

```sql
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.stella_interactions'::regclass AND NOT tgisinternal; -- 0 filas
SELECT to_regclass('public.stella_suggestion_decisions'); -- NULL
```

## Producción

Solo después de: staging verde + G3 verde + decisión explícita go/no-go de
Lorenzo, siguiendo la secuencia de `SUPABASE_MIGRATION_GATE.md` (backup, orden
revisado, verificaciones repetidas). Este paquete no autoriza tocar producción.

## STELLA FULL REBUILD — RUN 2 (2026-08-02) — evidencia local para G2

> **Esto no es la ejecución de G2.** G2 sigue **sin ejecutar** y sin aprobar.
> RUN 2 es un segundo ensayo estructural, sobre un stack local desechable
> reconstruido desde cero, de los tres scripts que G2 aplicaría. Refuerza la
> confianza en el paquete; no sustituye ninguna precondición del gate ni la
> *Aclaración sobre A1*.

| Campo | Valor |
|---|---|
| Fecha | 2026-08-02 |
| Branch / HEAD inicial | `codex/stella-g2-local-rehearsal` / `92d7c61` |
| `project_id` | `uellix-stella-g2-local-rehearsal` — API `127.0.0.1:56321`, DB `127.0.0.1:56322` |
| PostgreSQL | 17.6, volumen creado desde cero en esta corrida |
| Acceso remoto | ninguno |

### Identidad de los artefactos aplicados

| Script | SHA-256 working tree | SHA-256 canónico Git |
|---|---|---|
| `stella_0002_interactions_hardening.sql` | `11b792159435ee91fe00634e85a687a4c6b7aff9496f403db18740ba778c05e6` | `bdf5f8dc…24858cd` |
| `stella_0002b_append_only_truncate_hardening.sql` | `781e8b58fe2f512c4214016421199c853f9ed840fde0f27f701ddf247aace550` | idéntico (archivo LF en el blob) |
| `stella_0003_suggestion_decisions.sql` | `6caa5ca97acbc0e9b28a439a66dcfac9b0d15399e4172da886dffd9fc1d6b7d1` | `ad22e22c18f0bfb8c03987e05b76de45efe440fd994c2ae719a55bece778fab5` |

`git diff HEAD` vacío sobre las tres rutas. Cada script aplicado **dos veces**,
en una sola transacción externa (`-1`), con `ON_ERROR_STOP=1`, archivo exacto,
sin modificaciones. `stella_0003` con el rol escritor declarado en la misma
sesión vía `-c "SET stella.writer_role = 'postgres'"` — sin `ALTER ROLE`, sin
`ALTER DATABASE`.

### Verificaciones 1–7 sobre base reconstruida

| # | Verificación | Resultado |
|---|---|---|
| 1 | Trigger `trg_stella_interactions_append_only` adjunto | presente, `tgtype=27`, `tgenabled=O` |
| 2 | Grants reducidos (`table_schema='public'`, todos los grantees) | `authenticated` y `service_role` = `SELECT`+`INSERT`; `anon`/`PUBLIC` = 0 |
| 3 | `CHECK` con los 6 roles vía `pg_get_constraintdef` | intacto |
| 4 | `UPDATE`/`DELETE` sobre la fila sintética | bloqueados, SQLSTATE `42501` |
| 4b | `TRUNCATE` en las 4 tablas append-only, incluido como `postgres` | bloqueado, SQLSTATE `42501`; 4 triggers `tgtype=34` |
| 5 | RLS de `stella_suggestion_decisions` con una sola política | RLS on, FORCE off, 1 policy `SELECT` |
| 6 | Grants `SELECT`-only, sin filas para `anon`/`PUBLIC` | `authenticated SELECT` no grantable; `service_role`/`anon`/`PUBLIC` ausentes del ACL |
| 7 | Ambos `CHECK` por definición completa | `decision` con los 4 valores; `previous_value_hash` con el patrón de 64 hex |

Contrato estructural adicional verificado **fuera** del propio script: 11
columnas exactas, PK, 4 FKs todas `NO ACTION` (`confupdtype/confdeltype = a/a`),
0 `UNIQUE`, 2 índices no únicos, 2 triggers nuevos, 10 append-only totales,
`evidence_chunks` ausente.

### Estado final

38 tablas · 104 policies · 119 índices · 230 constraints · 10 triggers
append-only · 8 funciones. Grants no-owner = 461 con la definición del registro
original (526 si se cuenta `MAINTAIN`, privilegio nuevo de PostgreSQL 17).
`uellix_forbid_mutation()` con SHA-256 `cd918f70…73cb98f`, **idéntico** al de
RUN 1.

### Qué sigue faltando para G2

Nada de lo anterior sustituye: entorno remoto autorizado, ventana de cambio,
respaldo remoto verificado, aprobación humana y la *Aclaración sobre A1*. RUN 2
sólo demuestra que los tres scripts hacen lo que dicen sobre un PostgreSQL 17.6
real y que lo hacen de forma reproducible e idempotente. **G2 formal: NO
EJECUTADO.**
