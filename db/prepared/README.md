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

## AVISO OPERATIVO (tren 4) — la cadena de grounding se re-aplica ENTERA

Cada paquete se anuncia individualmente como «idempotente y convergente», y lo
es **respecto de su propio estado final**. Eso no es lo mismo que ser seguro de
re-aplicar aisladamente dentro de una cadena.

**`grounding_0003` re-aplicado solo revierte, en silencio, las dos reparaciones
de seguridad de `grounding_0004`.** Su §5 vuelve a conceder
`SELECT ON public.evidence_chunks TO authenticated` y su §6 recrea la policy
`evidence_chunks_select` con `TO authenticated, uellix_app, uellix_auditor` —
sin `uellix_cap_grounding`. El resultado:

1. **INT-CAP-002 reabierto** — PostgREST vuelve a leer el índice de chunks de
   toda la organización, esquivando el filtro `canonical_chunk_id IS NULL` que
   es lo único que impide citar un duplicado suprimido como si fuera el pasaje;
2. **el hallazgo RLS del tren 4 vuelve** — `uellix_cap_grounding` deja de estar
   nombrado por una policy SELECT permisiva, y como no tiene `BYPASSRLS`,
   **toda lectura gobernada devuelve el conjunto vacío en silencio**:
   `chunks_in_scope*` responde 0 filas, `finalize_document_ingestion` declara
   toda ingesta incompleta y `register_document_version` clava cada documento
   en `ordinal = 1`.

Ninguna autoverificación lo detecta, y por construcción: la §9 de
`grounding_0003` afirma **su** estado final, que es exactamente el que acaba de
producir. Un GRANT ausente lanza; una POLICY ausente calla.

**Regla, por tanto:** aplicar `grounding_0002 → 0003 → 0004` **siempre como
unidad**. Si hace falta re-aplicar `0003` por cualquier motivo, re-aplicar
`0004` inmediatamente después, en la misma ventana. `scripts/stella-train4-dry-run.sh`
§12 comprueba que `0003` se re-aplica con `0004` puesto y que `0004` vuelve a
cerrar la superficie; ese orden es el único ejercitado.

**Y el rollback, en orden inverso:** `0004 → 0003 → 0002`.
`grounding_0003_rollback` **se niega** si `chunks_in_scope_attested` sigue
instalada, porque dejarla viva impediría retirar `uellix_cap_grounding` y
bloquearía el rollback de `0002` de forma permanente.

(Hallazgos de la revisión adversarial del tren 4, registrados aquí porque el
arreglo estructural exigiría editar `grounding_0003` por razones ajenas a su
rollback.)

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
| `grounding_0001_evidence_chunks.sql` | `grounding_0001_rollback.sql` | G2 addendum (`docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`) **+ decisión G5 P3** | extensión `vector`; **tabla `evidence_chunks`** + 2 índices + 3 CHECK + 1 UNIQUE + grant SELECT + RLS + política `evidence_chunks_select` | **SUPERSEDIDO por `grounding_0003` — NO APLICAR.** Nunca aplicado en ninguna base; se conserva byte a byte bajo su banner (ver «Disposición de `grounding_0001`») |
| `grounding_0002_document_versions.sql` | `grounding_0002_rollback.sql` | **ninguno todavía**; requiere `stella_0004` aplicado (roles) y decisión de integración sobre GR-002 | rol `uellix_cap_grounding` (NOLOGIN, cero miembros); esquema `uellix_grounding`; **tabla `evidence_document_versions`** (14 columnas) + 2 índices + 3 UNIQUE + 5 CHECK + 3 policies (1 SELECT, 1 INSERT `TO uellix_cap_grounding`, 1 `RESTRICTIVE`) + 2 triggers append-only + `register_document_version(...)` y `claim_active_document_version(uuid)` SECURITY DEFINER | **DISEÑO — no aplicado** |
| `grounding_0003_evidence_chunks.sql` | `grounding_0003_rollback.sql` | **ninguno todavía**; requiere `grounding_0002` aplicado **primero** | **tabla `evidence_chunks`** en la forma GR-001 (23 columnas) + 3 índices + 1 índice único **parcial** de deduplicación + 2 UNIQUE + 7 CHECK + 4 policies (1 SELECT, 1 INSERT, 1 DELETE, 1 `RESTRICTIVE`) + 2 triggers (`no_update`, `no_truncate`) + `insert_evidence_chunks(uuid, jsonb)`, `finalize_document_ingestion(uuid, integer)` y `chunks_in_scope(uuid, uuid, uuid)` SECURITY DEFINER. **Sin pgvector** | **DISEÑO — no aplicado** |
| `stella_0004_role_separation.sql` | `stella_0004_rollback.sql` | **local únicamente** por ahora; G2 remoto **bloqueado** por RR-09 (`docs/ops/DATABASE_ROLE_MODEL.md` §5) | 5 roles (`uellix_owner`/`migrator`/`app`/`writer`/`auditor`); ownership de las **38** tablas y **8** funciones de `public` → `uellix_owner`; revoca `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` a `authenticated` y `service_role` en las 38; repara `pg_default_acl` de `postgres` y `supabase_admin`; 4 entradas **globales** que suprimen `EXECUTE`/`USAGE` a `PUBLIC`; `USAGE ON SCHEMA auth` para el owner | PREPARADO — ensayado y aplicado **sólo en local** |
| `stella_0005_runtime_cutover.sql` | `stella_0005_rollback.sql` | **local únicamente**; se aplica con `pnpm db:prepared:apply:local`, que conecta como `uellix_migrator` y hace `SET LOCAL ROLE uellix_owner`. El script **se niega** a correr con cualquier otra identidad, incluido un superusuario | 3 políticas `INSERT` (`audit_logs`, `stella_interactions`, `stella_suggestion_decisions`) → **104 → 107**; `search_path=''` en las 3 funciones SECURITY DEFINER que aún estaban en `search_path=public`; 4 entradas de `pg_default_acl` para `uellix_owner` en `public` (SELECT+INSERT a `uellix_writer`, SELECT a `uellix_auditor`; **nunca** UPDATE/DELETE) | PREPARADO — ensayado en contenedor efímero y aplicado **sólo en local** |
| `stella_0005b_admin_bootstrap.sql` | `stella_0005b_rollback.sql` | **local únicamente**; requiere **superusuario** (en local, `supabase_admin`) y se aplica **antes** de `stella_0005` | `ALTER ROLE ... SET` (search_path, statement/lock/idle timeouts) para los 3 roles LOGIN; ownership del esquema `drizzle` y de `__drizzle_migrations` → `uellix_owner` + `USAGE` para `uellix_migrator`. Sobre el default de TYPES de `postgres` en `public`: el script lo **documenta y verifica**, pero **NO ejecuta un `REVOKE USAGE ON TYPES` efectivo** — un `REVOKE` solo no almacena nada en `pg_default_acl` y la fila que un `GRANT` previo guardaría **nunca se consulta** (ver el propio script, secciones "DELIBERATELY NOT CHANGED", y `docs/ops/DATABASE_RUNTIME_CUTOVER.md`). La contención real de TYPES son las 2 entradas **globales** de `stella_0004` para `uellix_owner`/`uellix_migrator` | PREPARADO — aplicado **sólo en local** |
| `stella_0005c_runtime_policy_scope.sql` | `stella_0005c_rollback.sql` | **local únicamente**; misma ruta que `stella_0005` (`pnpm db:prepared:apply:local`, `uellix_migrator → SET ROLE uellix_owner`) | Re-alcance de las 3 políticas `INSERT` append-only a **`TO uellix_app`** (antes `TO PUBLIC`, lo que reactivaba los grants `INSERT` pre-cutover de `authenticated`/`service_role` vía PostgREST — reauditoría M1); `REVOKE INSERT` a `authenticated` y `service_role` en `audit_logs` y `stella_interactions` (SELECT intacto); elimina la rama `actor_user_id IS NULL` y liga el actor a `auth.uid()` también para super admin. El conteo queda en **107** (3 reemplazadas, ninguna añadida) | PREPARADO — aplicado **sólo en local** (2026-08-02) |
| `stella_0005d_storage_definer_repair.sql` | `stella_0005d_rollback.sql` | **local únicamente**; requiere **superusuario** (en local, `supabase_admin`), como `0005b` | `GRANT USAGE ON SCHEMA storage TO uellix_owner` — y nada más. Repara las funciones SECURITY DEFINER `can_write_evidence_object`/`can_read_evidence_object` (propiedad de `uellix_owner` desde `stella_0004`) que fallaban dentro de `storage.foldername()` por falta de `USAGE`, con lo que su `EXCEPTION WHEN OTHERS RETURN false` negaba **toda** operación de objetos de evidencia. Medido: upload como analyst → «new row violates row-level security policy»; tras el grant, la suite de Storage pasa. Sin privilegios de tabla en `storage`; `uellix_app` no se toca | PREPARADO — aplicado **sólo en local** (2026-08-02) |

> **Por qué `stella_0005` viene partido en dos.** No es estilo: `uellix_owner` no
> tiene `CREATEROLE` y no posee el esquema `drizzle`, así que `ALTER ROLE ... SET`,
> `ALTER SCHEMA ... OWNER` y `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` **no
> pueden** ejecutarse por la ruta del migrator. Meterlos en el mismo fichero
> habría obligado a aplicar todo el cutover como administrador, y eso habría
> dejado sin comprobar justo la afirmación central del script: que la ruta
> `uellix_migrator → SET ROLE uellix_owner` funciona.
>
> **`stella_0005b` no tiene rollback completo.** `ALTER SEQUENCE ... OWNER TO`
> falla mientras la secuencia esté ligada a una tabla de otro dueño, así que el
> rollback cambia la **tabla primero** y la secuencia después. Se descubrió
> ejecutándolo, no revisándolo.

### Train 4 — runtime local de grounding (`stella_0013`, `grounding_0004`)

**Estado: DISEÑO. Ninguno aplicado a ninguna base. Ninguna bandera habilitada.**
Cierran las cinco solicitudes que la revisión adversarial del tren 3 dejó
abiertas hacia esta línea: **INT-CAP-001** … **INT-CAP-004** e **INT-GR-004**
(`docs/ops/contracts/CONTRACT_LEDGER.md`, respuestas en
[`CAP-TRAIN4-001`](../../docs/ops/contracts/CAP-TRAIN4-001_grounded_query_quota_response.md)
y [`CAP-TRAIN4-002`](../../docs/ops/contracts/CAP-TRAIN4-002_grounding_scope_attestation_response.md)).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0013_grounded_query_quota.sql` | `stella_0013_rollback.sql` | **ninguno todavía**; requiere el baseline de migraciones (0012, 0030, 0031) y `stella_0004` para los roles | **INT-CAP-001.** Rol `uellix_cap_stella_quota` (NOLOGIN, cero miembros); esquema `uellix_stella`; columna `stella_interactions.idempotency_key` + 2 CHECK + índice único **parcial** `uq_stella_interactions_idempotency`; CHECK `stella_interactions_stella_role_check` ampliado a **7** valores (añade `grounded_query`); policy `stella_interactions_quota_definer_insert`; `consume_stella_quota(uuid, uuid, varchar, char)` SECURITY DEFINER — comprueba y **consume** una unidad en la transacción del llamante, bajo lock de advisory por organización, idempotente por `(organization_id, idempotency_key)` | **DISEÑO — no aplicado** |
| `grounding_0004_runtime_attestation.sql` | `grounding_0004_rollback.sql` | **ninguno todavía**; requiere `grounding_0002` y `grounding_0003` aplicados **en ese orden** | **INT-GR-004 + INT-CAP-002/003/004.** `chunks_in_scope_attested(uuid, uuid, uuid)` SECURITY DEFINER — mismas 13 columnas que `chunks_in_scope` **más** `organization_id`, `project_id`, `evidence_id`, `document_version_id` leídas **de la fila**; 3 CHECK nuevos sobre `evidence_chunks` (`content_hash` = `sha256(content)`; cota de span; derivación de `chunk_id`); `evidence_chunks_select` re-creada **sin** `authenticated` y `REVOKE SELECT ... FROM authenticated`; **y las dos policies de SELECT re-creadas para nombrar a `uellix_cap_grounding`** — sin ese rol, las seis funciones gobernadas leían el conjunto vacío | **DISEÑO — no aplicado** |

> **Por qué `chunks_in_scope_attested` es una función NUEVA y no la misma con
> dos columnas más.** `CREATE OR REPLACE FUNCTION` no puede cambiar el tipo de
> retorno (`42P13`), y `grounding_0003` crea `chunks_in_scope` con esa misma
> sentencia. Un paquete que la sustituyera por `DROP`+`CREATE` bajo el mismo
> nombre haría que la cadena forward `0002 → 0003 → 0004` **abortara dentro de
> 0003** al aplicarse por segunda vez, y la idempotencia de cadena es lo que
> mide el dry-run. El precio es una ruta de lectura deprecada que sigue siendo
> invocable hasta que el adaptador de repositorio se mueva; el precio de la
> alternativa era una cadena que no se puede re-aplicar.

> **El rol de capacidad no leía nada, y no lo dijo.** `uellix_cap_grounding`
> tenía `SELECT` sobre las dos tablas de grounding y no estaba nombrado por
> ninguna de las dos policies permisivas de SELECT. Sin `BYPASSRLS` y sin ser
> dueño de ninguna, RLS se le aplicaba entera: `chunks_in_scope` devolvía 0
> filas, `finalize_document_ingestion` declaraba toda ingestión incompleta, y
> `register_document_version` nunca veía la versión anterior, así que la
> **versión 2 de cualquier documento era inalmacenable**. Un GRANT ausente
> lanza; una POLICY ausente calla. Se reparó **re-creando** las dos policies
> bajo sus propios nombres, no añadiendo una quinta: `grounding_0002` §9 afirma
> exactamente 3 policies y `grounding_0003` §9 exactamente 4.

> **El rollback de `stella_0013` puede NEGARSE, y es correcto.** Estrechar el
> CHECK a seis valores sobre un ledger que ya registró filas `grounded_query`
> es imposible: `stella_interactions` es append-only para **todo** rol incluido
> el dueño (`trg_stella_interactions_append_only`), así que las filas no se
> pueden retirar para hacerle sitio a la constraint más estrecha. El script las
> cuenta primero y explica, en vez de dejar que el operador lea una violación
> de constraint cruda y adivine.

> **El rollback de `grounding_0004` REABRE INT-CAP-002 y lo anuncia con
> `RAISE WARNING`.** Volver al estado de `grounding_0003` significa devolver el
> `GRANT SELECT` y el rol `authenticated` a la policy — y quitar
> `uellix_cap_grounding` de las dos policies de lectura, con lo que las
> funciones gobernadas vuelven a leer el conjunto vacío. Dejar la superficie
> estrecha mientras se afirma un rollback limpio haría que la siguiente
> comparación aplicar/revertir se leyera como convergente sin serlo.

### Train 4.1 — tickets de operación gobernados (`stella_0014`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.
Ningún server action lo llama todavía** — cablearlo es la reconciliación de
INTEGRACIÓN. Cierra **INT-INT-001**
(`docs/ops/contracts/CONTRACT_LEDGER.md#int-int-001`, respuesta en
[`INT-INT-001`](../../docs/ops/contracts/INT-INT-001_operation_ticket_protocol.md)).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0014_operation_tickets.sql` | `stella_0014_rollback.sql` | **ninguno todavía**; exige `stella_0013` **ya aplicado** (precondición dura en §0: cobra *a través de* `consume_stella_quota` y no tiene INSERT sobre el ledger) | **INT-INT-001.** Rol `uellix_cap_stella_ticket` (NOLOGIN, cero miembros, **sin ningún privilegio de escritura sobre `stella_interactions`**); tabla `uellix_stella.operation_tickets` con **8** CHECK y **cero** columnas capaces de guardar un payload; índice parcial `ix_operation_tickets_live_reservation`; `public.uellix_check_operation_ticket_transition()` + **2** triggers `ENABLE ALWAYS`; RLS con **3** policies (select/insert/update, **sin** policy de DELETE); **6** funciones SECURITY DEFINER — `issue`, `bind`, `complete`, `abort`, `inspect`, `expire` | **DISEÑO — no aplicado** |

> **Por qué una tabla nueva y no `stella_interactions`.** La estructura canónica
> se reutiliza donde puede: una unidad de cuota sigue siendo **una fila de
> `stella_interactions`**, contada por `checkStellaQuota` y escrita por
> `consume_stella_quota` y por nada más. Este paquete **no** añade un segundo
> ledger y **no** tiene INSERT sobre el primero. Lo que no puede reutilizar es
> la fila: un ticket tiene ciclo de vida, y
> `trg_stella_interactions_append_only` rechaza `UPDATE` y `DELETE` sobre esa
> tabla para **todo** rol incluido el dueño. Una máquina de estados no cabe en
> una tabla donde ningún estado puede cambiar.

> **La clave de idempotencia deja de ser elegible por el llamante.** Se deriva
> dentro de `complete_operation_ticket` a partir del ticket **y de un
> `charge_nonce` que ninguna función devuelve y ningún rol de runtime puede
> leer** — `uellix_app`, `authenticated`, `anon` y `service_role` no tienen
> **ningún** privilegio directo sobre la tabla, y §7 (8) lo afirma como
> postcondición. Sin el nonce, quien tiene el ticket no puede calcular la clave
> ni cobrar fuera del protocolo.

> **Reservar y luego cobrar, nunca al revés.** `bind` fija el digest de la
> consulta **una sola vez** y reserva la unidad bajo el **mismo** lock de
> advisory que usa `stella_0013` (`stella/quota/<org>`), contando filas cobradas
> **más** otras reservas vivas. La operación se ejecuta **fuera** de esa
> transacción: la reserva es un **estado de fila**, no un lock abierto. Una
> operación que falla se `abort`a y no cobró nada, porque el cobro todavía no
> había ocurrido.

> **Una reserva huérfana no puede matar de hambre a una organización, y no hay
> cron.** `expires_at > now()` forma parte del **predicado de vivacidad** dentro
> de `bind`, así que un ticket abandonado deja de reservar en el instante en que
> expira, llame o no llame alguien a `expire_operation_tickets`. Esa función
> existe para higiene y observabilidad; la garantía **no** depende de ella. En
> este proyecto no hay `pg_cron` y el paquete no finge que lo haya.

> **El rollback de `stella_0014` puede NEGARSE, y es correcto.** Un ticket
> `completed` es el único registro de **qué** operación pagó una fila cobrada
> del ledger append-only. Soltar la tabla dejaría esos cargos sin atribución y
> su clave de idempotencia irrecuperable — de modo que un reintento posterior
> recibiría un ticket **nuevo** y se cobraría **por segunda vez**. Desinstalar
> el protocolo reintroduciría el defecto que el protocolo cierra.

> **Orden de rollback: `stella_0014` antes que `stella_0013`.** El rollback de
> `0013` suelta el esquema `uellix_stella` en cuanto no le quedan funciones, y
> este paquete pone seis ahí. Invertido, `0013` toma su rama «sigue teniendo N
> funciones de otro paquete» y deja esquema y rol en pie: una negativa segura,
> pero no el estado final que se pretendía.

### Train 4.2 — tickets ligados al proyecto de ejecución (`stella_0015`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.**
Cierra **R2-INT** (`docs/ops/contracts/CONTRACT_LEDGER.md#r2-int`, respuesta en
[`R2-INT`](../../docs/ops/contracts/R2-INT_project_bound_operation_tickets.md)).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0015_project_bound_operation_tickets.sql` | `stella_0015_rollback.sql` | **ninguno todavía**; exige `stella_0014` **ya aplicado** (precondición dura en §0) y `stella_0013` para el cobro | **R2-INT.** **No crea rol, tabla, trigger ni policy**: reemplaza **cuatro** de las seis funciones de `stella_0014` por firmas que reciben `p_expected_project_id uuid` **sin DEFAULT** — `bind(ticket, project, hash)`, `complete(ticket, project, hash)`, `abort(ticket, project, reason)`, `inspect(ticket, project)` — y **DROPea** las cuatro firmas antiguas que no recibían proyecto. SQLSTATE nuevo **`U0110`** («el ticket pertenece a otro proyecto»), levantado en cuanto la fila aparece: **antes** de vigencia, digest, estado y del cortocircuito `replayed`. `issue` y `expire` sin cambios. Postcondición propia: exactamente **6** funciones en `uellix_stella_ops`, todas `SECURITY DEFINER` con `search_path=''`, propiedad de `uellix_cap_stella_ticket`, **cero** `EXECUTE` para `PUBLIC` | **DISEÑO — no aplicado** |

> **La cadena canónica es `stella_0013` → `stella_0014` → `stella_0015`**, y el
> orden **no** es una preferencia de runbook: `stella_0015` §0 se niega si la
> tabla de tickets, el rol o `consume_stella_quota` no están.

> **REAPLICAR `stella_0014` DESPUÉS DE `stella_0015` ESTÁ BLOQUEADO POR EL
> RUNNER (R2a).** `stella_0014` es idempotente, así que volver a ejecutarlo solo
> **republicaría** las cuatro firmas sin proyecto —`SECURITY DEFINER`, con
> `EXECUTE` para `uellix_app`— junto al arreglo que las quitó. Ningún paquete
> SQL puede impedir que otro se ejecute después, así que la guarda vive donde sí
> puede: [`db/prepared-package-order.ts`](../prepared-package-order.ts) declara
> la supersesión y `applyPreparedScript` (`db/migrator.ts`) ejecuta la sonda
> **dentro de la transacción y antes del script**, de modo que la negativa hace
> rollback y las firmas inseguras no llegan a publicarse ni un instante.
> `pnpm db:prepared:apply:local stella_0014_operation_tickets.sql` sobre una base
> con `stella_0015` falla con `DB_MIGRATOR_PACKAGE_ORDER_VIOLATION`.

> **Orden de rollback: `stella_0015` antes que `stella_0014` antes que
> `stella_0013`.** Lo impone el propio SQL y no un runbook: las cuatro funciones
> nuevas son propiedad de `uellix_cap_stella_ticket`, así que el `DROP ROLE` del
> rollback de `stella_0014` **falla** mientras existan y su transacción entera
> aborta sin destruir nada.

> **El rollback de `stella_0015` deja una superficie CERRADA, no degradada.**
> Restaura `issue` y `expire` —ninguna de las dos cobra— y **no** vuelve a
> publicar las firmas sin proyecto. Una postcondición lo afirma: si una edición
> futura «restaurara» alguna, el rollback aborta.

### Campaña de capacidades públicas (`stella_0006` … `stella_0012`)

**Estado: DISEÑO. Ninguno aplicado a ningún stack. Ninguna capacidad
habilitada.** Fuente de verdad:
[`docs/ops/DATABASE_CAPABILITY_MODEL.md`](../../docs/ops/DATABASE_CAPABILITY_MODEL.md)
y un documento por capacidad en `docs/ops/capabilities/`.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0006_invitation_capability.sql` | `stella_0006_rollback.sql` | **ninguno todavía**; requiere DP-CAP-01 y DP-CAP-02 | rol `uellix_cap_invitation` (NOLOGIN); esquema `uellix_capability`; `accept_invitation(text)` SECURITY DEFINER; columna `invitations.accepted_by`; índice único `uq_invitations_token_hash`; **9** policies `cap_invitation_*` (6 permisivas + 3 `RESTRICTIVE`); grants por columna sobre 4 tablas | **DISEÑO — no aplicado** |
| `stella_0007_public_verification_capability.sql` | `stella_0007_rollback.sql` | **ninguno todavía**; requiere DP-CAP-04, 05 y 06 | rol `uellix_cap_verification`; **tablas `report_public_disclosures` (sin `organization_id`: la organización se deriva de `sroi_reports` en las policies) y `capability_verification_hits`**; `verify_report(text)` (STABLE) y `record_verification_hit(text)`; **7** policies `cap_verification_*` (5 permisivas + 2 `RESTRICTIVE`) + 3 `disclosures_*` internas `TO uellix_app` | **DISEÑO — no aplicado** |
| `stella_0008_stripe_webhook_identity.sql` | `stella_0008_rollback.sql` | **ninguno todavía**; requiere DP-CAP-07 y la credencial fuera de banda | roles `uellix_stripe` (**LOGIN, sin contraseña en el script**) y `uellix_cap_stripe`; **tabla `stripe_webhook_events`**; `stripe_begin_event`, `stripe_apply_subscription`, `stripe_fail_event`; 4 policies `cap_stripe_*` | **DISEÑO — no aplicado** |
| `stella_0009_public_lead_capability.sql` | `stella_0009_rollback.sql` | **ninguno todavía**; requiere DP-CAP-08 … 11 | rol `uellix_cap_lead`; `submit_lead(...)` (`RETURNS void`); columnas `marketing_leads.lead_status` y `.consent_version`; índice único `uq_marketing_leads_email_source`; policies `cap_lead_insert` y `cap_lead_deny_runtime` (`RESTRICTIVE`, `TO uellix_app`, `USING (false)` — la mitad **duradera** de la reducción neta); **revoca** los 4 privilegios de `uellix_writer` y **elimina** `anon_insert_marketing_leads` y `authenticated_insert_marketing_leads` | **DISEÑO — no aplicado** |
| `stella_0010_organization_bootstrap_capability.sql` | `stella_0010_rollback.sql` | **ninguno todavía**; requiere DP-CAP-12 y DP-CAP-13 | rol `uellix_cap_bootstrap`; **tabla `capability_bootstrap_attempts`**; `bootstrap_organization(...)`; **11** policies `cap_bootstrap_*` (8 permisivas + 3 `RESTRICTIVE`) | **DISEÑO — no aplicado** |
| `stella_0011_organization_column_acl.sql` | `stella_0011_rollback.sql` | **RR-CAP-10-A**: `lib/admin/stella-services.ts` y `lib/admin/organizations.ts` deben pasar a llamar a las dos funciones **antes** de aplicar | **RR-CAP-10.** `REVOKE UPDATE` de tabla completa sobre `public.organizations` a `authenticated`, `uellix_writer`, `anon` y `PUBLIC`; `GRANT UPDATE` por **ocho columnas** derivadas del código a `uellix_writer` y `authenticated`; rol `uellix_cap_platform`; `admin_set_stella_service(...)` y `admin_set_organization_status(...)`; **5** policies `cap_platform_*` (3 permisivas + 2 `RESTRICTIVE` que exigen `current_user_is_super_admin()` del **llamante**) | **DISEÑO — no aplicado** |
| `stella_0012_super_admin_column_acl.sql` | `stella_0012_rollback.sql` | ninguno; **se aplica con `stella_0011` y con el cambio de `lib/admin/**`** | **RR-CAP-15.** `REVOKE UPDATE` de tabla completa sobre `public.users` y `public.organization_members` a `authenticated`, `uellix_writer`, `anon` y `PUBLIC`; `GRANT UPDATE` de cuatro columnas de perfil y dos de pertenencia, sólo a `uellix_writer`. Cierra `UPDATE public.users SET is_super_admin = true WHERE id = auth.uid()`, que hacía decorativa la frontera de `stella_0011`. **No crea nada**: ni rol, ni función, ni policy, ni tabla | **DISEÑO — no aplicado** |

> **Los cinco corren como superusuario y no dependen entre sí.** Superusuario
> porque cada uno crea un rol y `uellix_owner` es `NOCREATEROLE` por diseño —
> concederle `CREATEROLE` deshacía `stella_0004`, que comprueba y aborta
> exactamente eso.
>
> **Tres ventanas, y las fronteras son funcionales.** (1) superusuario:
> precondiciones, `CREATE ROLE`, esquema y sus grants; (2) `SET ROLE
> uellix_owner`: DDL sobre `public`, grants por columna del definer y policies;
> (3) superusuario de nuevo: **toda** la función — `CREATE OR REPLACE`, `ALTER
> … OWNER TO`, `COMMENT`, `REVOKE`, `GRANT` — y las postcondiciones.
>
> La ventana 3 no es estilo. `ALTER FUNCTION … OWNER TO R` exige que **R**
> tenga `CREATE` sobre el esquema, y los definers sólo tienen `USAGE`; y
> `CREATE OR REPLACE` en una segunda pasada exige propiedad resuelta por
> `has_privs_of_role`, que `INHERIT FALSE` niega. Con la transferencia hecha
> como superusuario **ningún rol necesita ser miembro del definer**, así que los
> cinco roles de capacidad tienen **cero miembros** — y eso cierra un agujero
> real: `SET ROLE` es transitivo, y `uellix_migrator` es un rol `LOGIN` que
> alcanza `uellix_owner`.
>
> **Los cinco están probados en ejecución**, no sólo leídos: contenedor
> desechable `--network none`, línea base 38/107 restaurada desde el baseline
> versionado de [`../baseline/`](../baseline/README.md) —verificado por SHA-256,
> sin tocar ningún stack—, aplicación doble convergente a **42 tablas / 141 policies**,
> **72 aserciones vivas** (los 67 casos `L*` de los cinco documentos, más 3 de
> aislamiento cruzado y 2 de concurrencia), **seis** pruebas de concurrencia con
> sesiones reales sincronizadas contra un instante común, rollback y
> reaplicación al mismo estado. El ensayo es re-ejecutable:
> `bash scripts/capability-dry-run.sh`. Nueve defectos salieron de la primera
> ronda y de ninguna otra parte; ver
> [`docs/ops/capabilities/ADVERSARIAL_FINDINGS.md`](../../docs/ops/capabilities/ADVERSARIAL_FINDINGS.md).
>
> Las cifras «132 policies» y «57 aserciones» que aparecían aquí eran de la
> ronda anterior y **ya no describen estos ficheros**: la segunda ronda
> adversarial añadió las policies `RESTRICTIVE` y los dos booleanos de
> publicación, y el recuento de casos vivos diseñados siempre fue 67
> (13+12+14+13+15). Medidas de nuevo el 2026-08-03.
>
> **Independencia comprobable:** las precondiciones cuentan una **línea base**
> que excluye todo lo que la campaña introduce — las cuatro tablas nuevas, los
> prefijos `cap_` y `disclosures_`, y las dos policies de `marketing_leads` que
> `stella_0009` retira. Son **38 tablas y 105 policies** en los cinco scripts,
> con independencia de cuáles se hayan aplicado. Un conteo global crudo los
> habría acoplado en un orden implícito que el diseño no tiene.
>
> **`stella_0009` reduce privilegio neto** y su rollback lo **restaura**, a
> propósito: un rollback que mejora la seguridad de paso produce un estado que
> no coincide ni con el anterior ni con el posterior, y el siguiente operador no
> puede saber cuál está mirando.
>
> **Cómo se leen estos ficheros (2026-08-04).** El contrato estático se evalúa
> con un **lexer** que implementa las reglas léxicas de PostgreSQL, no con
> regex sobre texto enmascarado. La diferencia es medible: una reauditoría
> independiente confirmó **ocho grafías válidas** que el lector anterior no veía
> —DDL escrito dentro de un bloque `DO`, identificadores y *grantees* entre
> comillas dobles, `GRANT a, b TO c`, `DISABLE ROW LEVEL SECURITY`, un segundo
> `ALTER ROLE` que revierte atributos seguros, `REASSIGN OWNED`, `CREATE POLICY`
> con los cuatro identificadores entrecomillados, y comentarios de bloque
> **anidados**, que PostgreSQL anida y el enmascarador no—. Ninguna era una
> propiedad nueva: eran ocho maneras de escribir propiedades ya cubiertas.
>
> Consecuencia práctica **al escribir un paquete nuevo**: el lector desciende a
> los cuerpos ejecutables (`DO`, cuerpos de función, literales de `EXECUTE`), de
> modo que un `GRANT` emitido desde dentro de un bloque cuenta igual que uno
> escrito fuera; y **un `EXECUTE format(…)`, de una variable o de una
> concatenación se rechaza** con la violación `unparsed-security-statement`, no
> se interpreta. Si un paquete necesita SQL dinámico, tiene que ser un literal
> autocontenido. Medido: **89 mutaciones catalogadas, 0 supervivientes,
> 0 sentencias no interpretables** en los diez ficheros.

**Tablas gestionadas fuera de Drizzle (ADR 21):** `stella_suggestion_decisions`,
`evidence_chunks`, `evidence_document_versions`, y —cuando la campaña de
capacidades se aplique— `report_public_disclosures`,
`capability_verification_hits`, `stripe_webhook_events` y
`capability_bootstrap_attempts`. Consecuencia aceptada:
`pnpm db:migrate:local` sobre una base limpia **no** las reproduce.

## Disposición de `grounding_0001` (2026-08-04)

`grounding_0001_evidence_chunks.sql` queda **supersedido** por
`grounding_0003_evidence_chunks.sql` al resolverse los contratos
[GR-001](../../docs/ops/contracts/GR-001_evidence_chunks_provenance.md) y
[GR-002](../../docs/ops/contracts/GR-002_document_version_history.md). Respuesta
completa en
[`GR-CAP-001`](../../docs/ops/contracts/GR-CAP-001_grounding_persistence_response.md).

**No fue una ampliación porque no podía serlo.** Tres razones, en orden de peso:

1. `UNIQUE (evidence_id, chunk_index)` no está incompleta: es **incompatible**
   con GR-002. Con historia de versiones, la versión 2 de un documento colisiona
   con la 1 en `chunk_index = 0`, así que la segunda versión es inalmacenable.
   El alcance correcto es `(document_version_id, chunk_index)` — y la §2 del
   propio script se niega, con razón, a soltar una garantía de unicidad.
2. Su guarda de forma **aborta** ante columnas faltantes. Es el comportamiento
   correcto, y por eso las seis columnas de GR-001 §2 no pueden añadirse con un
   `ALTER` en un script posterior sin editar también la guarda: en ese momento
   el archivo es otro paquete llevando este número y su evidencia de gate.
3. Acopla a la decisión **G5 P3** (pgvector vs. léxico), que sigue sin tomarse,
   mientras GR-001 §4 deja el trabajo vectorial **fuera** de la solicitud.
   `grounding_0003` no usa pgvector — `SET search_path = public` a secas, sin
   extensión y sin tipo `vector` — de modo que persistir provenance ya no espera
   a una decisión de retrieval de la que no depende. La columna
   `embedding vector(N)` llega de forma aditiva en su propio paquete bajo G5 P3;
   `embedding_provider_id` viaja **ya** en `grounding_0003` para que ese paquete
   pueda añadir el vector y su invariante de emparejamiento a la vez.

El archivo **se conserva byte a byte** bajo un banner de comentario: la evidencia
del addendum G2 lo referencia por nombre y
`lib/grounding/__tests__/prepared-sql.test.ts` —propiedad de la línea
GROUNDING— fija su contenido. Sólo se añadieron comentarios; esa suite entrega
**27 passed** con el banner puesto.

**Si alguien lo aplicó**, `grounding_0001_rollback.sql` va **antes** de
`grounding_0003`: la guarda de forma de ese paquete detecta la constraint
heredada y lo dice por nombre en vez de reportar un desajuste genérico.

### Orden de aplicación y de reversión

| Sentido | Orden |
|---|---|
| Forward | `stella_0004` (roles) → `grounding_0002` → `grounding_0003` |
| Rollback | `grounding_0003` → `grounding_0002` |

`grounding_0002_rollback` **se niega** a correr mientras `evidence_chunks`
mantenga su clave foránea, y `grounding_0003_rollback` **aborta** si al terminar
`evidence_document_versions` ya no existe: la cadena de custodia no puede
desaparecer por un `CASCADE` que alguien añada al `DROP`.

**Asimetría deliberada de los dos rollbacks.** El de `grounding_0002` exige
`SET grounding.rollback_confirm = 'true'` de sesión cuando la tabla tiene filas
—la historia de versiones **no** es regenerable desde Storage— y rechaza la
autorización persistida vía `ALTER DATABASE/ROLE`. El de `grounding_0003` **no
pide confirmación**: cada fila es reproducible desde el archivo sellado y
`lib/grounding` en las versiones de pipeline que la propia fila registra, y un
prompt aquí entrenaría al operador a teclear la misma confirmación en el sitio
donde sí se pierde evidencia.

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

---

## Nota de compatibilidad (2026-08-02)

`stella_0005` + `stella_0005b` dejaron el runtime como `uellix_app` con RLS
activa. Las **tres policies de INSERT** que llevaron el conteo de 104 a 107
(`audit_logs`, `stella_interactions`, `stella_suggestion_decisions`) son la
mitad SQL de ese cambio; la mitad de aplicación —de dónde sale el `userId` que
esas policies comparan con `auth.uid()`— se cerró después, sin SQL nuevo.

**Ningún script preparado se añadió ni se modificó en esa unidad.** Cinco
caminos quedaron bloqueados por diseño (alta de organización, aceptar
invitación, webhook de Stripe, verificación pública por hash, captura de lead
público) y **ninguno recibió una policy nueva ni un privilegio nuevo**:
resolverlos es una decisión de privilegio con su propio script y su propia
revisión. Ver
[`docs/ops/DATABASE_RUNTIME_CUTOVER.md`](../../docs/ops/DATABASE_RUNTIME_CUTOVER.md)
§8.

## Nota del cierre de compatibilidad (2026-08-02, tarde)

La reauditoría encontró que esas tres policies `INSERT`, al no llevar cláusula
`TO`, aplicaban a `PUBLIC` y **reactivaban** los grants `INSERT` pre-cutover de
`authenticated`/`service_role` sobre `audit_logs` y `stella_interactions`
(escritura directa por PostgREST con un JWT válido). `stella_0005c` las
re-alcanza a `TO uellix_app` y revoca esos dos grants; `stella_0005d` repara la
ruta SECURITY DEFINER de Storage que `stella_0004` dejó sin `USAGE` sobre el
esquema `storage`. Distribución medida tras el cierre: **107 policies = 101
`{public}` + 3 `{uellix_app}` + 2 `{authenticated}` + 1 `{anon}`**. Verificación
ejecutable: `tests/database-insert-policy-scope.test.ts` (19 pruebas, catálogo +
sondas en vivo con ROLLBACK).


---

## `stella_0011` no es una sexta capacidad

Es lo contrario: **estrecha** un ACL que ya existía. Está en la misma lista, se
aplica **el último** y se revierte **el primero**, y la razón del orden es
concreta: crea un *definer* en el esquema compartido `uellix_capability`, y los
otros cinco rollbacks eliminan ese esquema en cuanto queda vacío. Revertirlo
después de ellos encontraría el esquema ya borrado.

Su rollback **reabre a propósito el riesgo que el paquete cierra**, y lo dice en
un `RAISE NOTICE` al terminar. Un rollback cuyas postcondiciones afirman un
estado *más seguro* que aquello que revierte es un rollback que no restaura
nada; la asimetría sería el defecto, no la simetría.

### Lo que un autor de paquetes debe saber sobre el lector, a partir de esta unidad

`CREATE TRIGGER` **ya no es un `unparsed-security-statement`**: está modelado
(`ParsedTrigger`, `TRIGGER_CONTRACT`) porque `stella_0007` crea tres. Modelarlo
no relajó nada — las formas que la campaña no usa (`UPDATE OF <columnas>`,
`CREATE CONSTRAINT TRIGGER`, `REFERENCING`, un `EXECUTE` ilegible) **siguen
siendo hallazgos**, y cada trigger que un paquete cree debe estar en
`TRIGGER_CONTRACT` con su tabla, su momento, sus eventos, su nivel y su función,
precedido de su propio `DROP TRIGGER IF EXISTS`. `CREATE RULE` sigue rechazado
sin más.


---

## `stella_0012` y el orden de aplicación

Se aplica **el último** y se revierte **el primero**, igual que `stella_0011`,
aunque por una razón distinta: no comparte esquema con nadie, no crea objetos y
es independiente de la campaña. El orden es una convención para que las
postcondiciones de `stella_0011` corran contra el ACL que describen.

**Lo que sí es obligatorio:** `stella_0011`, `stella_0012` y el cambio de
`lib/admin/stella-services.ts` / `lib/admin/organizations.ts` /
`lib/admin/organization-administration.ts` son **un solo despliegue**. Ninguno
de los tres funciona sin los otros dos:

| Se despliega | Falta | Síntoma |
|---|---|---|
| código | paquetes | `42883 function uellix_capability.admin_set_stella_service does not exist` |
| paquetes | código | `42501 permission denied for table organizations` en las dos pantallas de plataforma |
| `0011` sin `0012` | — | la cuota queda detrás de un predicado que cualquier usuario puede poner a `true` |

Su rollback **reabre una escalada de privilegio** y lo anuncia con
`RAISE WARNING`. No es un defecto del rollback: un rollback cuyas
postcondiciones afirman un estado más seguro que aquello que revierte no
restaura nada.
