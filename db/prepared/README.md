# db/prepared — SQL preparado (NUNCA auto-aplicado)

Este directorio contiene SQL **preparado pero NO aplicado**. Está fuera de
`db/migrations/` a propósito: drizzle-kit aplicaría cualquier archivo que
viviera allí, y la aplicación de estos scripts es un **gate externo (G2)** que
requiere acción humana explícita.

> **Registro autoritativo.** Este archivo es la fuente de verdad de los objetos
> de base de datos que esta campaña gestiona **fuera del chain de Drizzle**,
> según `docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md`. Las tablas listadas abajo
> **no** están en `db/schema.ts` ni en el snapshot de Drizzle, y eso es
> deliberado. No las agregues a `schema.ts` sin seguir el procedimiento de
> promoción de la ADR §7 — hacerlo generaría una migración con `CREATE TABLE`
> sin `IF NOT EXISTS` que fallaría contra una base donde G2 ya corrió.
>
> `tests/prepared-sql-source-of-truth.test.ts` verifica automáticamente que
> este registro y la realidad no diverjan.

## Reglas

1. **Nada de este directorio se ejecuta automáticamente.** Ni drizzle, ni CI,
   ni un agente. La aplicación es siempre manual, por Lorenzo, contra staging
   primero, siguiendo el checklist del gate.
2. **Ejecutar siempre en una sola transacción**, tanto los scripts forward como
   los rollbacks:
   ```
   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/<script>.sql
   ```

   > **`stella_0004` es la excepción en cuanto al ROL, no en cuanto a la
   > transacción.** Debe ejecutarse como **superusuario** (en local,
   > `supabase_admin` dentro del contenedor). Un rol `CREATEROLE` no
   > superusuario recibe `ADMIN OPTION` automáticamente sobre cada rol que crea
   > (PostgreSQL 16+, verificado en este stack), y con esa `ADMIN OPTION` puede
   > concederse `SET` sobre el owner — la separación quedaría en el papel. El
   > propio script lo comprueba y aborta.
   >
   > **Además, después de aplicar `stella_0004`, los scripts `stella_0002`,
   > `0002b` y `0003` ya no pueden ejecutarse como `postgres`:** emiten
   > `REVOKE`, `GRANT`, `CREATE TRIGGER` y `ALTER TABLE`, y todo eso exige
   > ownership. Se ejecutan como `uellix_migrator` con un `SET ROLE
   > uellix_owner` explícito. Lo mismo vale para `pnpm db:migrate:local` sobre
   > una base donde `0004` ya corrió; sobre una base **recién creada** el orden
   > normal (migraciones → `0002`/`0002b`/`0003` → `0004`) no se ve afectado.
   `-1` garantiza que un fallo no deje estado parcial. Ninguno de estos scripts
   usa `CREATE INDEX CONCURRENTLY`, así que todos son compatibles con el modo
   transaccional.
3. Antes de aplicar cualquier script de grounding: **confirmar la
   disponibilidad de pgvector** en el proyecto Supabase hosted
   (Dashboard → Database → Extensions → `vector`), y **la decisión G5 P3**
   (`docs/ops/gates/G5_PACKAGE.md`).

   **Variante léxica (G5 P3 = sin pgvector)** — borrar exactamente **dos**
   cosas de `grounding_0001_evidence_chunks.sql`:
   1. **la sección completa** delimitada por
      `===== BEGIN PGVECTOR SECTION =====` y `===== END PGVECTOR SECTION =====`
      (contiene las tres piezas que dependen de pgvector: comprobación de
      disponibilidad, instalación y guarda de resolubilidad);
   2. la columna `embedding vector(384),` del `CREATE TABLE`.

   Nada más cambia, y esto es verificable: **todas** las menciones a pgvector
   del script viven dentro de esa sección, y la guarda de forma no exige la
   columna `embedding`. La prueba
   `tests/prepared-sql-source-of-truth.test.ts` lo comprueba automáticamente.
4. Cada script tiene su rollback preparado en el mismo directorio.
5. **Todos los scripts fijan un `search_path` explícito** y cualifican cada
   objeto con `public.` — doble protección contra resolución ambigua. Los
   scripts `stella_*` usan `SET search_path = public;`;
   `grounding_0001` usa **`SET search_path = public, extensions;`** porque en
   Supabase hosted pgvector vive en el esquema `extensions` y sin él el tipo
   `vector(384)` no resolvería.
6. **Idempotencia convergente, no solo `IF NOT EXISTS`.** Cada script:
   - falla explícitamente si faltan sus precondiciones (funciones, tablas
     referenciadas, helpers RLS);
   - si la tabla ya existe con forma **incompatible**, **aborta** con la lista
     de columnas discrepantes en vez de hacer no-op silencioso;
   - si la tabla ya existe con la forma correcta, reconcilia constraints
     (comparando su **definición**, no solo el nombre), índices, grants, RLS y
     política.
   Los mensajes de las guardas `RAISE EXCEPTION` reportan **nombres y tipos de
   columna únicamente**, nunca datos de filas. Excepción conocida: si
   `evidence_chunks` preexistiera con filas duplicadas, el `ADD CONSTRAINT
   ... UNIQUE` produce el `DETAIL` nativo de Postgres, que incluye el par
   `(evidence_id, chunk_index)` conflictivo — son identificadores internos, no
   datos personales, y solo los ve el operador del gate.
7. Validación offline: `lib/grounding/__tests__/prepared-sql.test.ts` (scripts
   `grounding_*`), `tests/prepared-stella-sql.test.ts` (scripts `stella_*`) y
   `tests/prepared-sql-source-of-truth.test.ts` (invariantes transversales y
   salvaguardas de la ADR). **No es un parse de Postgres** — la validación real
   contra una base es parte del checklist G2.

## Inventario

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|--------|----------|------|-------------------------|--------|
| `stella_0002_interactions_hardening.sql` | `stella_0002_rollback.sql` | G2 (`docs/ops/gates/G2_PACKAGE.md`) | trigger `trg_stella_interactions_append_only`; grants de `stella_interactions`; CHECK `stella_interactions_stella_role_check` | PREPARADO |
| `stella_0002b_append_only_truncate_hardening.sql` | `stella_0002b_rollback.sql` (**no reversible**) | G2 (`docs/ops/gates/G2_PACKAGE.md`) | 4 triggers `*_no_truncate` (`BEFORE TRUNCATE FOR EACH STATEMENT`) sobre `stella_interactions`, `audit_logs`, `sroi_calculation_runs`, `sroi_calculation_line_items`; revoca `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` a `authenticated` y además `UPDATE/DELETE` a `service_role` | PREPARADO |
| `stella_0003_suggestion_decisions.sql` | `stella_0003_rollback.sql` | G2 (`docs/ops/gates/G2_PACKAGE.md`); habilita `STELLA_DECISIONS_PERSISTENCE_ENABLED` recién después de aplicarlo | **tabla `stella_suggestion_decisions`** + 2 índices + 2 CHECK + `REVOKE ALL` a los 3 roles + grant SELECT a `authenticated` + RLS + política `stella_suggestion_decisions_select` + 2 triggers append-only (fila y `TRUNCATE`) | PREPARADO |
| `grounding_0001_evidence_chunks.sql` | `grounding_0001_rollback.sql` | G2 addendum (`docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`) **+ decisión G5 P3** | extensión `vector`; **tabla `evidence_chunks`** + 2 índices + 3 CHECK + 1 UNIQUE + grant SELECT + RLS + política `evidence_chunks_select` | PREPARADO |
| `stella_0004_role_separation.sql` | `stella_0004_rollback.sql` | **local únicamente** por ahora; G2 remoto **bloqueado** por RR-09 (`docs/ops/DATABASE_ROLE_MODEL.md` §5) | 5 roles (`uellix_owner`/`migrator`/`app`/`writer`/`auditor`); ownership de las **38** tablas y **8** funciones de `public` → `uellix_owner`; revoca `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` a `authenticated` y `service_role` en las 38; repara `pg_default_acl` de `postgres` y `supabase_admin`; 4 entradas **globales** que suprimen `EXECUTE`/`USAGE` a `PUBLIC`; `USAGE ON SCHEMA auth` para el owner | PREPARADO — ensayado y aplicado **sólo en local** |

**Tablas gestionadas fuera de Drizzle (ADR 21):** `stella_suggestion_decisions`,
`evidence_chunks`. Consecuencia aceptada: `pnpm db:migrate:local` sobre una base
limpia **no** las reproduce.

**Desviación deliberada de tipos — no "arreglar":**
`stella_suggestion_decisions.decided_at` es `timestamptz`, mientras el resto de
`db/schema.ts` (incluido `stella_interactions.created_at`) usa `timestamp` sin
zona. `timestamptz` es la elección correcta para un audit trail; la
inconsistencia es un argumento para migrar el resto del esquema más adelante,
**no** para degradar esta columna. La app nunca escribe `decided_at` (tiene
DEFAULT), así que el tipo es indiferente para el código.

## Notas por script

- **`stella_0002_interactions_hardening.sql`**: adjunta el trigger append-only
  existente (`uellix_forbid_mutation()`, de `0030_immutability.sql`) a
  `stella_interactions`, revoca `UPDATE/DELETE` del rol `authenticated`
  (corrige el grant CRUD completo que dejó `0033_public_api_grants.sql:50`) y
  reconcilia idempotentemente el CHECK de `stella_role` al set de 6 roles de
  `db/schema.ts`. Su rollback restaura un estado **bug-compatible** (ver
  comentarios en el propio rollback) y **no** revierte el CHECK de 6 roles.
- **`stella_0002b_append_only_truncate_hardening.sql`**: cierra el hueco de
  `TRUNCATE` en la garantía append-only de las **cuatro** tablas protegidas. Un
  trigger `FOR EACH ROW` no se dispara en `TRUNCATE` y RLS tampoco lo gobierna,
  así que `SET LOCAL ROLE authenticated; TRUNCATE ...` **tenía éxito** (probado
  sobre PostgreSQL 17 real, 2026-08-01). **Causa raíz:** los
  `ALTER DEFAULT PRIVILEGES` de Supabase conceden `Dxtm`
  (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) a `authenticated` en toda tabla creada
  en `public` — 36 de 37 tablas lo heredan; ninguna migración de este repo lo
  concedió. Aplica **dos capas**: grants (detiene a todo rol que no sea el
  owner) y triggers de sentencia (única capa que alcanza al owner, que aquí
  importa porque `db/client.ts` conecta con `DATABASE_URL`, es decir, como
  `postgres`). `MAINTAIN` se revoca de forma **version-aware** (solo PG17+, vía
  `EXECUTE` de un literal fijo, porque el token no existe antes de 17). Su
  rollback es **deliberadamente no reversible** (`SAFE_NON_REVERSING_ROLLBACK`):
  solo verifica y explica, nunca vuelve a conceder `TRUNCATE`. Reparar los
  *default privileges* globales queda **diferido a un gate transversal** — este
  script no los toca.
- **Endurecimiento previo a la primera aplicación de `stella_0003`
  (2026-08-01).** Tres MAJOR de la reauditoría, cerrados antes de que el script
  tocara ninguna base:
  - **MAJ-A — guarda de escritura vacua.** Usaba
    `has_table_privilege(current_user, …)`, que devuelve `true` para **cualquier
    superusuario** y además probaba el rol *instalador*, no el de la
    aplicación. Sustituida por una guarda basada en hechos auditables: rol
    escritor **declarado** (`stella.writer_role`), propietario real de la tabla,
    y ACL **directa** vía `aclexplode` (sin herencia por membresía ni atajo de
    superusuario). Condición: *el writer es owner* **o** *tiene INSERT+SELECT
    directos y `rolbypassrls`* — porque RLS está activo sin policy de INSERT, y
    `INSERT … RETURNING id` también exige SELECT.
    **Límite honesto:** ningún SQL puede observar a qué rol resuelve
    `DATABASE_URL`. La garantía se reparte en tres: guarda estructural (el
    script), prueba offline del camino de escritura del código (`tests/`), y
    precondición humana del gate remoto (`G2_PACKAGE.md`). Con
    `stella.writer_role` **sin declarar**, el script cae a `current_user` y lo
    anuncia como **ASUNCIÓN, no verificación** — el chequeo de owner sería
    tautológico. Declararlo es lo que lo convierte en una comprobación real.
  - **MAJ-B — sin auto-verificación.** Añadida al final del forward, en la
    **misma transacción**: 18 comprobaciones sobre `pg_catalog` (tabla, owner,
    columnas/tipos/defaults/nulabilidad **y sin columnas extra**, PK, 4 FKs
    exactas y todas `NO ACTION`, ausencia de UNIQUE **constraint e índice**,
    ambos CHECK — el de `decision` con **exclusividad**, no solo presencia —,
    RLS activo **y `FORCE` apagado**, 1 sola policy SELECT org-scoped, los 2
    triggers con sus eventos exactos, y privilegios directos por `aclexplode`
    incluyendo `PUBLIC`). Aborta ante privilegios residuales **y ante
    sobre-revocación**.
    **Dos comprobaciones fueron retiradas en la ronda 2 de revisión** y no
    deben reintroducirse: `evidence_chunks` ausente (rompía la convergencia —
    `grounding_0001` la crea legítimamente bajo su propio gate G5 P3) y
    "default privileges intactos" (era **infalsificable**: `defaclacl` es
    `aclitem[]` y nunca contiene nombres de tabla, así que la comprobación no
    podía dispararse jamás mientras se contaba como verificada). Ambos
    invariantes son **estáticos** y los fija el test offline.
  - **MAJ-C — sin guarda de roles.** Añadida antes de crear nada.
  - **MIN-A** — `LIKE '%''accepted_edited''%'` reemplazado por `position()`:
    `_` es comodín de `LIKE` y habría aceptado `'acceptedXedited'`.
- **`stella_0003_suggestion_decisions.sql`**: crea la tabla
  `stella_suggestion_decisions` (decisiones humanas sobre sugerencias de
  Stella) con RLS SELECT-only org-scoped. La server action que la consume
  (`app/actions/stella/decisions.ts`) queda **dormida** detrás de
  `STELLA_DECISIONS_PERSISTENCE_ENABLED` (default `false`) hasta que este
  script pase G2. Invariante de privacidad: `previous_value_hash` guarda un
  SHA-256, nunca el texto previo en crudo.
- **`stella_0003_rollback.sql` — endurecimiento estructural (2026-08-01).**
  **Defecto anterior:** la guarda de autorización era un bloque `DO $$ … $$;` y
  el `DROP TABLE IF EXISTS` era una **sentencia top-level posterior e
  independiente**. Entre una y otra no había más barrera que dos banderas de
  línea de comandos:
  - sin `-v ON_ERROR_STOP=1`, `psql` **reporta** el error de la guarda y
    **envía la siguiente sentencia** — el `DROP`;
  - sin `-1`, no hay transacción envolvente que revierta nada.

  Esas banderas son una **convención de invocación**, no una propiedad del
  archivo. Ningún otro consumidor de un `.sql` las aporta por defecto: el SQL
  Editor de Supabase, `supabase db execute`, un cliente gráfico o un pegado en
  una sesión `psql` abierta. La cabecera las **exigía**; nada las **imponía**.

  **Corrección:** todo ocurre ahora en **un único bloque `DO`** — comprobación
  de existencia, conteo de filas, `NOTICE` al operador, prueba de autorización y
  el `DROP` mismo. En PL/pgSQL un `RAISE EXCEPTION` termina el bloque de
  inmediato y ninguna sentencia posterior *de ese bloque* se ejecuta: es
  semántica del **servidor** dentro de una sola sentencia, no del **cliente**
  entre dos. `-1 -v ON_ERROR_STOP=1` siguen **recomendadas** (atomicidad y
  código de salida distinto de 0 para un gate que lo lee), pero ya **no son la
  única barrera**.

  El `DROP` se emite como `EXECUTE '<literal fijo>'` — la misma construcción que
  `stella_0002b` usa para su `REVOKE MAINTAIN` version-aware. **Cero
  composición:** sin `||`, sin `format()`, sin `quote_ident()`, sin variables.
  Lo único que decide el código circundante es **si** ejecutarlo, nunca **qué**
  dice. Va sin `IF EXISTS` a propósito: la existencia ya quedó probada unas
  líneas antes, en el mismo bloque.

  Comportamiento fijado por `tests/prepared-stella-sql.test.ts` (bloques *review
  round 4*): tabla ausente → `NOTICE` y no-op; tabla vacía → rollback técnico;
  tabla con filas sin autorización → aborta y la tabla **sobrevive**; sólo la
  cadena **exacta** `'true'` autoriza (`yes`, `y`, `1`, `TRUE`, `True`, `on`,
  `t`, `' true '` son todas rechazadas); segunda ejecución → no-op.

  **Tres MAJOR de la revisión independiente, cerrados en la misma unidad:**
  - **M1 — el conteo era indigno de confianza bajo `FORCE ROW LEVEL SECURITY`.**
    `count(*)` está sujeto a RLS; `FORCE` quita el bypass del owner, así que un
    propietario sin `rolbypassrls` contaría **0** sobre una tabla poblada y el
    script habría anunciado *"no audit data lost"* mientras la destruía.
    Reproducido en PG 17.6. Añadida guarda de `relforcerowsecurity` **antes**
    del conteo, simétrica con §4b/§7 del forward.
  - **M2 — la autorización podía ser del entorno, no de la corrida.** Un
    `ALTER DATABASE/ROLE … SET` persistido pre-autoriza toda sesión futura: el
    mismo defecto, reubicado de las banderas de `psql` a la capa de GUC. **Ojo:**
    `pg_settings` **no** expone GUCs placeholder personalizados (0 filas), así
    que la provenance se lee de **`pg_db_role_setting`**. Límite honesto
    declarado en el archivo: SQL puede exigir que sea de sesión, no puede
    distinguir a un humano de un script — eso es precondición del gate.
  - **M3 — las pruebas no prohibían un `EXCEPTION WHEN`.** Un handler traga el
    `RAISE` de la guarda y deja pasar el `DROP` con todas las demás aserciones
    en verde. Prohibido explícitamente, más exactamente un `BEGIN` y un `RETURN`.

  Además: `LOCK TABLE … ACCESS EXCLUSIVE` antes del conteo (cierra el TOCTOU con
  un `INSERT` concurrente), `SET client_min_messages = notice` (el camino
  destructivo no puede correr en silencio) y el aviso de irreversibilidad
  reformulado — el DDL de PostgreSQL es transaccional, así que bajo `-1` un
  `ROLLBACK` deshace todo **hasta el `COMMIT`**; decir "irreversible" antes de
  eso mandaba al operador a un respaldo que aún no necesitaba.

  **Ronda 3 — un BLOCKER, y una guarda que se retira en vez de arreglarse.** El
  pre-chequeo de objetos dependientes que se había añadido abortaba en **toda**
  ejecución contra la tabla real: `CreatePolicy()` y las expresiones `CHECK`
  registran filas `DEPENDENCY_NORMAL` por columna referenciada, sin degradación
  de la auto-referencia, así que un filtro `deptype='n'` clasificaba la **propia
  política y el propio `CHECK` de la tabla** como dependientes ajenos. La
  fixture mínima de dry-run —sólo tabla y triggers— era la causa de que no se
  viera. **Retirada, no arreglada por tercera vez:** su valor era exclusivamente
  el prefijo del mensaje, no impedía ninguna destrucción, y le quedaba un hueco
  conocido (dependientes vía el tipo compuesto de la tabla, registrados contra
  `pg_type`). Re-derivar `findDependentObjects()` de PostgreSQL en SQL no es
  tarea de este script: **una guarda sólo a veces correcta es peor que ninguna,
  porque invita a creerle.** Quedan **cinco** guardas, y `G2_PACKAGE.md` registra
  que un fallo por objeto dependiente sale con el mensaje nativo de PostgreSQL y
  no destruye nada.

  También en esa ronda: el filtro de persistencia pasó a **`session_user`**
  —PostgreSQL aplica `pg_db_role_setting` por rol de **login**, no por
  `current_user`, y la variante anterior fallaba **abierto** justo cuando el
  operador reejecuta con `SET ROLE`—, y la **región de decisión** quedó fijada
  como span verbatim, tras descubrirse que `IF n_rows > 0` → `IF n_rows >
  1000000` bastaba para que una tabla poblada y **sin autorizar** se destruyera
  con la suite entera en verde.

  **Rondas 4–6 — seis MAJOR más, y un cambio de método.** Las rondas 4 y 5
  fueron **enteramente pruebas**: la lista de sentencias top-level no estaba
  acotada (una línea añadida antes del `DO` hacía que toda ejecución se
  autoautorizara), y las aserciones de fragmento seguían dejando escapes —
  intercambiar los cuerpos de las ramas, envolver una guarda en `IF false THEN`,
  insertar `PERFORM set_config(...)` **dentro** del bloque. Se cerró fijando el
  **cuerpo ejecutable entero** del bloque `DO` byte a byte: cualquier sentencia
  insertada, eliminada, reordenada o re-anidada falla. Editar el SQL obliga a
  actualizar esa constante — deliberado, para que ningún cambio de lógica entre
  sin aparecer en un diff que alguien apruebe.

  La ronda 6 encontró el **primer defecto de SQL desde la ronda 3**: el supuesto
  de aislamiento estaba **documentado, no impuesto**. Bajo `REPEATABLE READ` el
  snapshot se fija antes del `LOCK`, el conteo puede no ver filas confirmadas en
  esa ventana, y el script destruiría un audit trail poblado bajo un log que
  certifica que no se perdió nada. A diferencia de los canales de persistencia
  inobservables, **éste sí se puede consultar** — de ahí una **sexta guarda**,
  la primera del bloque. Regla que queda: *un supuesto declarado en un
  comentario no es una guarda, y la prueba de si debería serlo es si SQL puede
  observarlo.*

  Verificado en **24 escenarios** sobre un contenedor PostgreSQL 17.6 desechable
  con fixture realista (tabla, ambos `CHECK`, ambos índices, RLS con la política
  org-scoped y los dos triggers), los críticos con `psql` **desnudo**, incluido
  el par regresión/cierre; y **58 mutantes destructivos y estructurales del
  script, los 58 detectados** (condiciones invertidas o eliminadas, guardas
  degradadas a `NOTICE`/`WARNING`, ramas intercambiadas, ausencia de
  aislamiento, autorización vacua, `EXCEPTION WHEN` insertado, y las demás
  clases descritas en las rondas 2–6 de arriba). Esta cifra pertenece al
  endurecimiento previo a la primera ejecución y **no implica cobertura
  universal de toda mutación posible** — es la evidencia de que el conjunto de
  mutaciones intentado, hasta ahora, fue detectado en su totalidad. La
  reauditoría independiente posterior (2026-08-02) propuso una clase
  adicional, no destructiva: mutaciones **sólo de los seis mensajes de
  aborto** (tramos medios eliminados o invertidos, remedio cambiado, mensajes
  intercambiados o duplicados) — cerrada aparte por
  `describe('MIN-1 closure — the six abort messages, pinned end to end', ...)`
  en `tests/prepared-stella-sql.test.ts`, sin tocar la lógica ejecutable ni
  esta cifra de 58/58.
  **Este rollback sigue SIN ejecutarse contra ninguna base.**
- **`grounding_0001_evidence_chunks.sql`**: se aplica **por separado** de los
  dos anteriores y **nunca antes de G5 P3**. Contiene solo datos derivados y
  regenerables, por lo que su rollback no pierde fuente de verdad. La extensión
  `vector` **no** se revierte en el rollback (capacidad compartida de la
  instancia).

## Trabajo futuro que NO forma parte de G2

Estos ítems se mencionan en `RK-14` del registro de riesgos y **no tienen
script preparado**; no son parte del gate G2 actual:

- signed URL de descarga de evidencia;
- trigger de inmutabilidad de `evidence_items.content_hash`.

Ambos requerirían un script preparado propio que **todavía no existe**. El
número `stella_0004` ya está tomado por la separación de roles (ver el
inventario), así que un futuro paquete para RK-14 sería `stella_0005`.
