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

> **M-8 AÑADE UN CUARTO ESLABÓN A ESTA REGLA.** La cadena completa es
> `grounding_0002 → 0003 → 0004 → 0005`. `grounding_0005` repara el candado de
> `claim_active_document_version`, y re-aplicar `grounding_0002` sobre él lo
> **reabre en silencio** — sin cambiar ninguna firma. El runner lo rechaza
> (`db/prepared-package-order.ts`), y el detalle está al final de este archivo,
> en «M-8 — reparación forward-only del candado de `claim`».

**Regla, por tanto:** aplicar `grounding_0002 → 0003 → 0004` **siempre como
unidad**, y `0005` inmediatamente después si `0002` se re-aplicó. Si hace falta re-aplicar `0003` por cualquier motivo, re-aplicar
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

## Operación local vigente — MSC-07B.8 R3.4

La autoridad local de la cadena Stella está cerrada por
`scripts/stella-r3-4-local-runner.ts`. Los únicos comandos de preparación son:

```bash
pnpm db:prepared:plan:local
pnpm db:prepared:apply:local
```

No aceptan nombres de archivo, rutas ni SQL arbitrario. El manifiesto fijo es:

```
0002 admin → 0002b admin → 0001 admin → 0003 migrator
→ 0004 admin → 0005b admin → 0005 migrator → 0005c migrator
```

Cada flecha es una transacción por archivo; no existe una transacción global.
`0001` es la única autoridad local para crear/reconciliar los cinco roles y
las tres membresías exactas de PostgreSQL 17; `0004` sólo reconcilia ownership,
ACL y RLS de objetos. `0003`, `0005` y `0005c` se autentican como
`uellix_migrator` y usan `SET LOCAL ROLE uellix_owner`; las demás fases exigen
un superusuario local, obtenido exclusivamente de
`UELLIX_LOCAL_ADMIN_DATABASE_URL` en `.env.migration.local`.

Los artefactos nuevos son `stella_0001_role_topology_bootstrap.sql` y
`stella_0001_role_topology_bootstrap_rollback.sql`. El rollback de `0001`
rechaza dependencias y es el único que puede retirar roles o membresías; el
rollback de `0004` devuelve sólo ownership/ACL de objetos y deja la topología
de `0001` intacta. `stella_0005d` es independiente y no forma parte del
manifiesto fresco.

Esta ruta es exclusivamente local. El bootstrap hosted
`stella_hosted_0001_managed_role_bootstrap.sql` conserva un modelo de
privilegios distinto y **no sustituye** `0001` local. Un cliente SQL genérico,
SQL Editor, `psql` o `supabase db execute` no son rutas autorizadas para esta
cadena.

## Reglas

1. **Nada de este directorio se ejecuta automáticamente.** Ni drizzle, ni CI,
   ni un agente. La aplicación es siempre manual, por Lorenzo, contra staging
   primero, siguiendo el checklist del gate.
2. **La autoridad de ejecución es el manifiesto local R3.4, no un cliente SQL
   genérico.** `pnpm db:prepared:plan:local` muestra hashes y fases; `pnpm
   db:prepared:apply:local` ejecuta únicamente la secuencia fijada arriba.
   No acepta un fichero, una ruta, una identidad ni SQL aportado por quien lo
   invoca. Las fases administrativas exigen superusuario local; las fases
   migrator autentican `uellix_migrator`, abren una transacción y ejecutan
   `SET LOCAL ROLE uellix_owner`. No autoriza un destino remoto. Para remoto
   hace falta una autorización humana separada y un procedimiento que conserve
   hash, identidad y verificaciones de catálogo.
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

### HPO-ODS-W2-03 — identidad de roles gestionados ANTES del baseline (`stella_hosted_0000`)

**Estado: DISEÑO. No aplicado a ninguna base hosted.** Ensayado en clúster
PostgreSQL desechable aislado (`pnpm baseline:rehearsal:local`).

Las unidades del baseline `0042_fib_audit_insert_policy.sql` (ordinal 53) y
`0045_fib_domain_object_version_lineage.sql` (ordinal 56) escriben
`CREATE POLICY … TO uellix_app`, así que los cinco roles tienen que existir
**antes de la unidad 1**. `stella_hosted_0001` no puede correr antes: su §0 E5
exige los helpers RLS de `0031`/`0039`, su §2c transfiere una tabla que crea
`0012` y su §5d concede sobre objetos del baseline. Por eso la **identidad**
(roles, atributos y las membresías que no necesitan tabla) se separa aquí y
`stella_hosted_0001` pasa a **afirmarla** (§0 E0) en vez de crearla.

Secuencia autoritativa: `PLATFORM_SUBSTRATE` → **`PHASE_MANAGED_ROLE_IDENTITIES`**
(`stella_hosted_0000`) → `PHASE_BASELINE` (64 unidades) → `PHASE_STELLA_BOOTSTRAP`
(`stella_hosted_0001`) → `PHASE_STELLA_CHAIN`. Modelo TypeScript único:
`db/hosted/managed-role-identities.ts` (pin SHA-256 del paquete, atributos,
membresías, comando de aplicación).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0000_managed_role_identity_bootstrap.sql` | `stella_hosted_0000_rollback.sql` | `PHASE_MANAGED_ROLE_IDENTITIES` (`db/hosted/hosted-provisioning-runner.ts`); exige clúster **sin ningún rol `uellix_*`** | Los **5** roles (`uellix_owner`/`migrator`/`app`/`writer`/`auditor`) con los mismos atributos literales que antes tenía `stella_hosted_0001` §2 (sólo `migrator` con `CREATEROLE`, nadie con `SUPERUSER`/`BYPASSRLS`/`CREATEDB`/`REPLICATION`); la concesión RR-02 (`uellix_owner` a `postgres` con `SET`); `COMMENT ON ROLE` ×5; las **2** membresías (`migrator → owner` SET-only, `app → writer` INHERIT-only). **No referencia ninguna tabla de aplicación, no transfiere propiedad, no concede privilegios de tabla/esquema, no depende de helpers RLS ni de migraciones.** Nada dinámico | **DISEÑO — ensayado en clúster desechable** |

> **Su rollback** revoca las dos membresías y elimina los cinco roles, y **se
> niega** mientras exista `uellix_bootstrap`, mientras cualquier rol posea un
> objeto o mientras conserve privilegios sobre `public` — es decir, hasta que
> `stella_hosted_0001_rollback` haya corrido antes.

### Train 5B — bootstrap de Supabase gestionado (`stella_hosted_0001`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.**
Cierra el bloqueador B1 del Train 5A: los diez paquetes de la cadena hosted
abortaban sin `rolsuper`, y Supabase gestionado no expone superusuario.
**HPO-ODS-W2-03:** ya **no define ningún rol** — afirma en §0 (E0) que los
cinco de `stella_hosted_0000` existen con la forma canónica y se niega si no.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0001_managed_role_bootstrap.sql` | `stella_hosted_0001_rollback.sql` | **G11/G12 propuestos** (`docs/ops/staging/STELLA_STAGING_GATE_PLAN.md`); exige `stella_hosted_0000` aplicado y el baseline completo | **Afirma** (no crea) los 5 roles de `stella_hosted_0000`; esquema `uellix_bootstrap`; `USAGE`/`CREATE` sobre `public` (§2b-bis); propiedad de `public.stella_interactions` → `uellix_owner` (§2c); `assert_hosted_capabilities(text)` (la precondición que sustituye a la guarda `rolsuper`); `hosted_capability_report()` (sólo lectura); tabla `staging_sentinel` (**fila no insertada** — la escribe el aprovisionamiento); `public.uellix_auth_uid()`, el shim `SECURITY DEFINER` que expone el actor de sesión a los roles de capacidad sin `USAGE ON SCHEMA auth` (RR-09); contrato de autoridad prechain E-01 (§5d). Su rollback ya **no elimina roles**: revoca los privilegios de esquema que concedió y deja los cinco a `stella_hosted_0000_rollback` | **DISEÑO — no aplicado** |

### Train 5B — remediación prechain forward-only (`stella_hosted_0002`)

**Estado: DISEÑO. No aplicado a ninguna base.**
`stella_hosted_0001` es **sólo de primera provisión**. Su §5 entrega
`uellix_bootstrap` a `uellix_owner`, así que a partir de la segunda aplicación
`postgres` ya no lo posee y **17 sentencias** del paquete la exigen: reproducido
en PG 17.6 con `ERROR: must be owner of schema uellix_bootstrap`, en su primer
`COMMENT ON SCHEMA`. **Su segunda pasada está PROHIBIDA.**

Un proyecto ya bootstrapeado que necesite la autoridad prechain certificada en
el Commit 5.1 usa este paquete, y sólo este.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0002_prechain_authority_reconciliation.sql` | **ninguno, a propósito** (`db/hosted/prechain-remediation.ts`) | `PRECHAIN_AUTHORITY_GATE` + testigo `INSTALLED` | `uellix_migrator` gana `CREATEROLE`, `CREATE ON DATABASE` y los `SELECT` de visibilidad; `uellix_owner` gana los 12 privilegios prechain E-01 con opción de concesión donde la cadena los re-concede; `uellix_bootstrap.assert_capability_membership_topology()` se crea y `assert_hosted_capabilities()` se reemplaza por el cuerpo certificado. **No crea ningún rol de capacidad y no transfiere ninguna propiedad.** | **DISEÑO — no aplicado** |

> **Por qué no lleva rollback.** Deshacer una reconciliación de autoridad ya
> confirmada significaría revocar privilegios de los que la cadena puede ya
> depender y quitar `CREATEROLE` a un rol que puede ya haber creado roles de
> capacidad — correcto sólo bajo suposiciones sobre lo que pasó desde entonces,
> que es justo lo que el contrato forward-only prohíbe. La recuperación es:
> un fallo previo al commit revierte (medido), un resultado ambiguo se clasifica
> por observación fresca, `INSTALLED` nunca se reaplica, y una corrección es un
> paquete forward-only **nuevo**.

> **NO sustituye a `stella_0004`, y se niega donde `stella_0004` es aplicable.**
> Su §0 (E2) aborta si `current_user` ES superusuario: instalar en silencio el
> modelo más débil sobre una base capaz de sostener el fuerte sería una
> degradación que nadie eligió.

> **Lo que es más débil, dicho antes que el código.** RR-02: un CREATEROLE no
> superusuario recibe `ADMIN OPTION` automática sobre cada rol que crea, así que
> `postgres` puede volverse `uellix_owner` con una sentencia. La separación es
> aquí un **obstáculo auditable**, no una barrera. El paquete lo emite como
> `RAISE NOTICE` y el centinela lo registra en `owner_separation`.

> **Los nueve paquetes de la cadena NO se editan.** Sus variantes hosted se
> **generan** (`pnpm hosted:generate`) a `db/prepared/hosted/*.hosted.sql` por
> cuatro reglas enumeradas, con el SHA-256 del fuente y el conteo exacto de cada
> regla fijados en `db/hosted/hosted-package-manifest.ts`. Editar un canónico sin
> regenerar da `HOSTED_SOURCE_SHA_MISMATCH`; aflojar una regla sin tocar el
> canónico da `HOSTED_REWRITE_COUNT_MISMATCH`. Detalle en
> `docs/ops/staging/STELLA_MANAGED_SUPABASE_COMPATIBILITY.md`.

## Inventario

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|--------|----------|------|-------------------------|--------|
| `stella_local_0000_local_role_identity_bootstrap.sql` | *(sin rollback — pendiente adjudicación de autoridad HPO-ODS-W2-11; ver `docs/ops/p1a/P1A_FULL_BOOTSTRAP_EVIDENCE_v1.0.0.json` hallazgo bloqueante)* | **local/CI únicamente**, `PHASE_LOCAL_ROLE_IDENTITY` + `PHASE_BOOTSTRAP_PRIVILEGE` (`docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json`); exige el sustrato de imagen fijada desechable (`postgres` CREATEROLE-no-superusuario, `supabase_admin` superusuario real), **sin ningún rol `uellix_*`** | Los **5** roles con los mismos atributos finales que `stella_0001` (`migrator` SIN `CREATEROLE`, a diferencia de `stella_hosted_0000`); **2** membresías (`migrator → owner` SET-only, `app → writer` INHERIT-only); `GRANT USAGE, CREATE ON SCHEMA public TO uellix_owner` + `REVOKE ... PUBLIC`; reconexión `\connect` a `supabase_admin` para la ÚNICA escritura de privilegio bajo ese actor, `GRANT USAGE ON SCHEMA auth TO uellix_owner`. **No referencia ninguna tabla de aplicación, no transfiere propiedad, no concede privilegio de base de datos.** Nada dinámico. **Rechaza una segunda aplicación** (precondición de estado prístino) — no es convergente como sus dos hermanos | DISEÑO — ensayado contra la imagen fijada desechable (`sha256:80d7b27c…`), ver evidencia P1A |
| `stella_0001_role_topology_bootstrap.sql` | `stella_0001_role_topology_bootstrap_rollback.sql` | **local únicamente**, fase administrativa del manifiesto R3.4 | Autoridad exclusiva de cinco roles y tres membresías PostgreSQL 17 (`migrator → owner` SET-only; `app → writer` y `postgres → writer` INHERIT-only); verifica grantor **por `oid` fijo del superusuario bootstrap (10), nunca por nombre de rol** (`DATABASE_ROLE_MODEL.md` §3.2), cardinalidad, flags y ausencia de ruta SET a owner; ejecutor exigido: sesión superusuario cruda (`session_user = current_user`, `rolsuper`), sin nombre fijo; **desde HPO-ODS-W2-11, AFIRMA (no concede) CREATE de `public` y USAGE de `auth`** — establecidos por `stella_local_0000_local_role_identity_bootstrap.sql` cuando el sustrato es el disponible desechable; fija default privileges globales de owner/migrator | PREPARADO — no aplicado por esta actualización |
| `stella_0002_interactions_hardening.sql` | `stella_0002_rollback.sql` | G2 (`docs/ops/gates/G2_PACKAGE.md`) | trigger `trg_stella_interactions_append_only`; grants de `stella_interactions`; CHECK `stella_interactions_stella_role_check` | **Su trigger SUPERSEDIDO por Drizzle — FIBIU-28/FIBDB-034 (`db/migrations/0044_fib_audit_hardening_supersession.sql`). RETIRED_DO_NOT_APPLY sobre una base sin la aplicación histórica en G2.** Grants/CHECK de §2-3 sin tocar |
| `stella_0002b_append_only_truncate_hardening.sql` | `stella_0002b_rollback.sql` (**no reversible**) | G2 (`docs/ops/gates/G2_PACKAGE.md`) | 4 triggers `*_no_truncate` (`BEFORE TRUNCATE FOR EACH STATEMENT`) sobre `stella_interactions`, `audit_logs`, `sroi_calculation_runs`, `sroi_calculation_line_items`; revoca `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` a `authenticated` y además `UPDATE/DELETE` a `service_role` | **Sus 4 triggers SUPERSEDIDOS por Drizzle — FIBIU-28/FIBDB-034 (`db/migrations/0044_fib_audit_hardening_supersession.sql`, que añade el quinto hermano de `stella_suggestion_decisions`). RETIRED_DO_NOT_APPLY sobre una base sin la aplicación histórica en G2.** Revocaciones de §1-3 sin tocar |
| `stella_0003_suggestion_decisions.sql` | `stella_0003_rollback.sql` | G2 (`docs/ops/gates/G2_PACKAGE.md`); sólo por la ruta gobernada `uellix_migrator → SET LOCAL ROLE uellix_owner`; habilita `STELLA_DECISIONS_PERSISTENCE_ENABLED` recién después de aplicarlo | **tabla `stella_suggestion_decisions`** propiedad de `uellix_owner` + 2 índices + 2 CHECK + `REVOKE ALL` + ACL directa `authenticated: SELECT` y `uellix_writer: SELECT, INSERT`; RLS con SELECT y el INSERT canónico `TO uellix_app`, ligado a `app.organization_id`, membresía vigente y `auth.uid()`; 2 triggers append-only (fila y `TRUNCATE`) | PREPARADO — contrato R3.2 pendiente de verificación controlada |
| `grounding_0001_evidence_chunks.sql` | `grounding_0001_rollback.sql` | G2 addendum (`docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`) **+ decisión G5 P3** | extensión `vector`; **tabla `evidence_chunks`** + 2 índices + 3 CHECK + 1 UNIQUE + grant SELECT + RLS + política `evidence_chunks_select` | **SUPERSEDIDO por `grounding_0003` — NO APLICAR.** Nunca aplicado en ninguna base; se conserva byte a byte bajo su banner (ver «Disposición de `grounding_0001`») |
| `grounding_0002_document_versions.sql` | `grounding_0002_rollback.sql` | **ninguno todavía**; requiere `stella_0004` aplicado (roles) y decisión de integración sobre GR-002 | rol `uellix_cap_grounding` (NOLOGIN, cero miembros); esquema `uellix_grounding`; **tabla `evidence_document_versions`** (14 columnas) + 2 índices + 3 UNIQUE + 5 CHECK + 3 policies (1 SELECT, 1 INSERT `TO uellix_cap_grounding`, 1 `RESTRICTIVE`) + 2 triggers append-only + `register_document_version(...)` y `claim_active_document_version(uuid)` SECURITY DEFINER | **DISEÑO — no aplicado** |
| `grounding_0003_evidence_chunks.sql` | `grounding_0003_rollback.sql` | **ninguno todavía**; requiere `grounding_0002` aplicado **primero** | **tabla `evidence_chunks`** en la forma GR-001 (23 columnas) + 3 índices + 1 índice único **parcial** de deduplicación + 2 UNIQUE + 7 CHECK + 4 policies (1 SELECT, 1 INSERT, 1 DELETE, 1 `RESTRICTIVE`) + 2 triggers (`no_update`, `no_truncate`) + `insert_evidence_chunks(uuid, jsonb)`, `finalize_document_ingestion(uuid, integer)` y `chunks_in_scope(uuid, uuid, uuid)` SECURITY DEFINER. **Sin pgvector** | **DISEÑO — no aplicado** |
| `stella_0004_role_separation.sql` | `stella_0004_rollback.sql` | **local únicamente** por ahora; G2 remoto **bloqueado** por RR-09 (`docs/ops/DATABASE_ROLE_MODEL.md` §5) | Verifica la topología ya establecida por `0001`; ownership de las **38** tablas y **8** funciones de `public` → `uellix_owner`; reconcilia ACL/RLS y verifica el inventario post-`0003` de 103 policies base + SELECT/INSERT de decisiones = 105. No crea ni altera roles, membresías ni default privileges globales. Su rollback devuelve sólo objetos | PREPARADO — ensayado y aplicado **sólo en local** |
| `stella_0005_runtime_cutover.sql` | `stella_0005_rollback.sql` | **local únicamente**; se aplica con `pnpm db:prepared:apply:local`, que conecta como `uellix_migrator` y hace `SET LOCAL ROLE uellix_owner`. El script **se niega** a correr con cualquier otra identidad, incluido un superusuario | Verifica que el INSERT canónico de decisiones ya existe en `0003`; añade sólo 2 políticas `INSERT` (`audit_logs`, `stella_interactions`) → **105 → 107**; `search_path=''` en las 3 funciones SECURITY DEFINER que aún estaban en `search_path=public`; 4 entradas de `pg_default_acl` para `uellix_owner` en `public` (SELECT+INSERT a `uellix_writer`, SELECT a `uellix_auditor`; **nunca** UPDATE/DELETE) | PREPARADO — ensayado en contenedor efímero y aplicado **sólo en local** |
| `stella_0005b_admin_bootstrap.sql` | `stella_0005b_rollback.sql` | **local únicamente**; requiere **superusuario** (en local, `supabase_admin`) y se aplica **antes** de `stella_0005` | `ALTER ROLE ... SET` (search_path, statement/lock/idle timeouts) para los 3 roles LOGIN; ownership del esquema `drizzle` y de `__drizzle_migrations` → `uellix_owner` + `USAGE` para `uellix_migrator`. Sobre el default de TYPES de `postgres` en `public`: el script lo **documenta y verifica**, pero **NO ejecuta un `REVOKE USAGE ON TYPES` efectivo** — un `REVOKE` solo no almacena nada en `pg_default_acl` y la fila que un `GRANT` previo guardaría **nunca se consulta** (ver el propio script, secciones "DELIBERATELY NOT CHANGED", y `docs/ops/DATABASE_RUNTIME_CUTOVER.md`). La contención real de TYPES son las 2 entradas **globales** de `stella_0004` para `uellix_owner`/`uellix_migrator` | PREPARADO — aplicado **sólo en local** |
| `stella_0005c_runtime_policy_scope.sql` | `stella_0005c_rollback.sql` | **local únicamente**; misma ruta que `stella_0005` (`pnpm db:prepared:apply:local`, `uellix_migrator → SET ROLE uellix_owner`) | Re-alcance de las **2** políticas `INSERT` de `0005` a **`TO uellix_app`** (`audit_logs`, `stella_interactions`); preserva y verifica sin reescribir la policy canónica de decisiones creada por `0003`; `REVOKE INSERT` a `authenticated` y `service_role` en ambas tablas (SELECT intacto); elimina la rama `actor_user_id IS NULL` y liga el actor a `auth.uid()` también para super admin. El conteo queda en **107** (2 reemplazadas, ninguna añadida) | PREPARADO — aplicado **sólo en local** (2026-08-02) |
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
> aplicar `stella_0014_operation_tickets.sql` sobre una base
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

### Train 4.3 — semántica de cuota reservada (`stella_0016`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.**
Cierra **R1** (`docs/ops/contracts/CONTRACT_LEDGER.md#r1`, respuesta en
[`R1`](../../docs/ops/contracts/R1_reserved_quota_semantics.md)).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0016_reserved_quota_semantics.sql` | `stella_0016_rollback.sql` | **ninguno todavía**; exige `stella_0013`, `stella_0014` y `stella_0015` **ya aplicados** (precondiciones duras en §0, incluida la ausencia de las firmas sin proyecto) | **R1.** **No crea rol, esquema ni tabla.** Tres funciones nuevas en `uellix_stella` (propiedad de `uellix_cap_stella_quota`): `stella_capacity(uuid, char(64))` — la aritmética canónica `Limit − Consumed − Reserved`; `consume_stella_capacity(uuid, uuid, varchar(50), char(64))` — la superficie para consumidores **sin ticket**, concedida a `uellix_app`; y `settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))` — la **conversión**, que cobra **sin evaluar el límite** y está concedida **sólo** a `uellix_cap_stella_ticket`. Republica **en el sitio** `bind` y `complete` (mismas firmas). Columna `operation_tickets.period_month` **`GENERATED ALWAYS`** desde `bound_at`; **cuarta** policy `operation_tickets_capacity_select` — organización, **no** actor; grant de SELECT **por columna** que excluye `charge_nonce` y `query_hash`. SQLSTATE nuevo **`U0111`** («la reserva no está viva») | **DISEÑO — no aplicado** |

> **La cadena canónica es `stella_0013` → `stella_0014` → `stella_0015` →
> `stella_0016`.** `stella_0016` §0 se niega si las firmas de tres argumentos no
> están **y** se niega si alguna firma sin proyecto sobrevive: republica dos
> cuerpos, y un `CREATE OR REPLACE` sobre una firma inexistente la **acuña** en
> vez de reemplazarla.

> **REAPLICAR `stella_0015` DESPUÉS DE `stella_0016` ESTÁ BLOQUEADO POR EL
> RUNNER.** Es R2a en la otra dirección y es peor de ver: `stella_0015` es
> idempotente y las firmas **no cambian**, así que reejecutarlo republica `bind`
> y `complete` con la aritmética que cuenta **sólo filas cobradas** sin que
> ninguna comprobación de firma lo note. La supersesión está declarada en
> [`db/prepared-package-order.ts`](../prepared-package-order.ts) y la premisa
> —que reaplicarlo de verdad reintroduce el defecto— se **mide** en el §14 de
> `scripts/stella-reserved-quota-dry-run.sh`.

> **`stella_0014` deja de ser reaplicable, y es deliberado.** Su §7 afirma
> exactamente **3** policies sobre `operation_tickets`, y este paquete añade la
> cuarta. La alternativa era ampliar la aserción de un paquete publicado para
> hacer sitio a uno posterior — el intercambio que el tren 4.2 rechazó. La
> supersesión `stella_0014 → stella_0015` ya vigente lo cubre: `stella_0016`
> exige `stella_0015`, así que la sonda de aquella regla es verdadera aquí
> también.

> **Orden de rollback: `stella_0016` antes que `stella_0015` antes que
> `stella_0014` antes que `stella_0013`.** Lo impone el propio SQL: las tres
> funciones nuevas son propiedad de `uellix_cap_stella_quota`, así que el
> `DROP ROLE` del rollback de `stella_0013` **falla** mientras existan.

> **El rollback de `stella_0016` deja una superficie CERRADA, no degradada.**
> **DROPea** `bind` y `complete` en vez de revertirlos —R1 es la *ausencia* de
> aritmética consciente de reservas, así que «restaurar la versión anterior» y
> «republicar la vulnerabilidad» son la misma frase— y deja `issue`, `abort`,
> `inspect` y `expire`, ninguna de las cuales cobra. **Ningún cargo se borra.**
> Consecuencia declarada: para volver a aplicar `stella_0016` hay que reaplicar
> `stella_0015` primero, y `stella_0016` §0 lo exige en vez de sugerirlo.

### Train 4.3b — consumo Stella gobernado (`stella_0017`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.**
Cierra el residual de **R1** y **R6-INT**
(`docs/ops/contracts/CONTRACT_LEDGER.md#r6-int`, respuesta en
[`R1-B`](../../docs/ops/contracts/R1-B_governed_stella_consumption.md)).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0017_governed_stella_consumption.sql` | `stella_0017_rollback.sql` | **ninguno todavía**; exige `stella_0013`, `stella_0014`, `stella_0015` y `stella_0016` **ya aplicados** (precondiciones duras en §0, incluida la ausencia de las firmas sin proyecto) | **R6-INT.** **No crea rol, esquema, tabla ni policy.** (1) `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions` de `uellix_writer` —el titular real: `uellix_app` no tiene **ninguna** entrada propia en `relacl` y escribe por herencia— y de `uellix_app`, `uellix_reader`, `uellix_auditor`, `authenticated`, `anon`, `service_role`, `authenticator` y `PUBLIC`. (2) CHECK `stella_interactions_governed_identity_check` (`idempotency_key IS NOT NULL`, **`NOT VALID`**): ata al **owner** y no lo silencia `session_replication_role`. (3) `settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb)` — la conversión que **lleva la fila de auditoría**; la firma de cinco argumentos pasa a **delegar** en ella (mismo nombre, misma firma, mismo grant). (4) `complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb)` — el verbo de cierre para las **cinco categorías hermanas**, concedido a `uellix_app`. **Séptima** función en `uellix_stella_ops` | **DISEÑO — no aplicado** |

> **La cadena canónica es `stella_0013` → `stella_0014` → `stella_0015` →
> `stella_0016` → `stella_0017`.** El §0 de `stella_0017` se niega si falta
> cualquiera de los cuatro y si sobrevive alguna firma sin proyecto.

> **El privilegio que había que retirar no es el del nombre obvio.** Medido
> sobre un baseline restaurado: `uellix_app` tiene **0** entradas en
> `stella_interactions.relacl` y `has_table_privilege('uellix_app', …, 'INSERT')`
> es **`true`**. Todo su `INSERT` viene de
> `GRANT uellix_writer TO uellix_app WITH INHERIT TRUE`. Un `REVOKE … FROM
> uellix_app` habría sido un no-op silencioso, y una verificación escrita sobre
> `relacl` habría reportado la tabla limpia. Por eso el §5 pregunta con
> `has_table_privilege` —que **sigue la pertenencia de rol**— y de forma
> **exhaustiva sobre `pg_roles`**, no sobre una lista de nombres.

> **`COPY` cae con el mismo privilegio**, y además PostgreSQL rechaza
> `COPY … FROM` sobre una relación con RLS activo. El §5 afirma que RLS sigue
> encendido para que esa segunda barrera no se pierda en silencio.

> **REAPLICAR `stella_0015` O `stella_0016` DESPUÉS DE `stella_0017` ESTÁ
> BLOQUEADO.** Los dos afirman `count(*) = 6` sobre `uellix_stella_ops` y este
> paquete publica la séptima función, así que los dos **abortan solos** — que es
> fail-closed. Las supersesiones declaradas en
> [`db/prepared-package-order.ts`](../prepared-package-order.ts) convierten un
> fallo de aserción que nombra un número en una negativa que nombra el motivo.

> **La firma de cinco argumentos de `settle_reserved_quota` NO se DROPea**, y es
> deliberado: `STELLA_0016_INSTALLED_PROBE` está escrita sobre ella, y borrarla
> habría desarmado en silencio la guarda que impide reaplicar `stella_0015`
> sobre `stella_0016`. Pasa a ser un **delegador**, así que este esquema sigue
> teniendo **un** `INSERT` al ledger, alcanzado por dos aridades.

> **Orden de rollback: `stella_0017` antes que `stella_0016` antes que
> `stella_0015` antes que `stella_0014` antes que `stella_0013`.** Lo impone el
> propio SQL en los dos extremos: el §1 del rollback de `stella_0017` **se niega**
> si `stella_capacity` ya no existe (restauraría un cuerpo que la llama), y la
> conversión de diez argumentos es propiedad de `uellix_cap_stella_quota`, así
> que dejarla atrás hace fallar el `DROP ROLE` del rollback de `stella_0013`.

> **El rollback de `stella_0017` NO restaura la escritura directa y NO retira el
> CHECK.** La escritura directa no es una función que este paquete reemplazó: es
> el defecto que cerró, y sobre `stella_0016` compone en un sobreconsumo medido
> (`Consumed = 2` contra `Limit = 1`). El estado final es **cerrado, no
> degradado**: el recorrido grounded queda exactamente como lo dejó
> `stella_0016`, y las categorías hermanas pueden emitirse, reservarse, abortarse
> e inspeccionarse pero ya no completarse — ni cobrarse por fuera del protocolo.
> **Ningún cargo se borra.**

### Train 4.3 — cierre: ligadura de categoría y retirada del consumo sin ticket (`stella_0018`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.**
Cierra **R6a** y **R6b**, los dos residuales que el cierre de evidencia del tren
4.3 **midió** sobre una base con la cadena `0013`…`0017` instalada.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0018_category_bound_operation_tickets.sql` | `stella_0018_rollback.sql` | **ninguno todavía**; exige `stella_0013`, `stella_0014`, `stella_0015`, `stella_0016` y `stella_0017` **ya aplicados** (precondiciones duras en §0) | **R6a + R6b.** **No crea rol, esquema, tabla ni policy.** (1) `bind_operation_ticket(char(64), uuid, char(64), varchar(50))` — el bind que **reimpone la capacidad esperada en SQL**, antes del lock consultivo y antes de leer capacidad; `U0112` cuando la superficie no es aquella para la que se emitió el ticket. **Octava** función en `uellix_stella_ops`, concedida a `uellix_app`. (2) La firma de **tres** argumentos pasa a **delegar** en ella con `NULL` (sin expectativa) y se le **REVOCA** `EXECUTE` a `uellix_app`: sobrevive la firma, no la ruta. (3) `REVOKE EXECUTE ON uellix_stella.consume_stella_capacity(...) FROM uellix_app` — el consumo **sin ticket**, con categoría y clave de idempotencia elegidas por el llamante, deja de ser alcanzable desde el runtime | **DISEÑO — no aplicado** |

> **Los dos defectos se MIDIERON, no se dedujeron.** Con `0013`…`0017`
> instalados y como `uellix_app`: (a) un ticket emitido para `advisor`, ligado y
> completado por la **ruta grounded** (verbo de tres argumentos) produce una fila
> con `stella_role = 'advisor'` y `pipeline_step = 'advisor'` para una consulta
> fundamentada — atribución falsa en una tabla **append-only**; (b)
> `consume_stella_capacity(org, project, 'composer', <64 hex a elección>)`
> devuelve `consumed` con **cero** tickets emitidos.

> **Por qué en `bind` y no en `complete`.** `complete` corre **después** de la
> llamada al proveedor: negarse ahí es negarse sobre trabajo ya hecho, que es la
> forma exacta de R1 que esta campaña gastó dos paquetes en quitar. `bind` es el
> único punto en el que negarse es gratis.

> **Por qué el `REVOKE` y no sólo la búsqueda de llamantes.** `consume_stella_capacity`
> no tiene ningún llamante en `app/**`, `lib/**`, `scripts/**` ni `db/**` — las
> cinco acciones hermanas migraron al protocolo de tickets, que es estrictamente
> más fuerte. Pero mientras `uellix_app` conserve `EXECUTE`, la ruta existe y una
> acción futura la alcanza sin que ninguna prueba lo note. La función **no se
> DROPea**: `stella_0016_rollback` espera encontrarla y borrar una función
> publicada desde un paquete posterior es la edición destructiva que esta línea
> rechaza. Conserva su dueño, así que sigue siendo alcanzable desde otro
> `SECURITY DEFINER` de `uellix_cap_stella_quota` — encapsulada, no alcanzable.

> **REAPLICAR `stella_0015`, `stella_0016` O `stella_0017` DESPUÉS DE
> `stella_0018` ESTÁ BLOQUEADO.** Los tres afirman un conteo sobre
> `uellix_stella_ops` (seis, seis y siete) y este paquete lo lleva a **ocho**, así
> que los tres **abortan solos**. Además `stella_0016` §7 (3) afirma que
> `uellix_app` **puede** ejecutar `consume_stella_capacity` — exactamente el grant
> que este paquete retira—, así que su aborto es **por diseño**. Las tres
> supersesiones están declaradas en
> [`db/prepared-package-order.ts`](../prepared-package-order.ts).

> **Orden de rollback: `stella_0018` antes que `stella_0017`.** El rollback
> restaura el cuerpo autocontenido de `stella_0016` §6a en la firma de tres
> argumentos **antes** de DROPear la de cuatro, porque el delegador la referencia.
> Declarado sin adornos: **el rollback reabre R6a y R6b.** Existe porque un
> paquete que no se puede retirar es un paquete que nadie puede aplicar con
> seguridad, no porque retirarlo sea seguro.

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
- **Remediación R3.2 de `stella_0003` (2026-08-27).** La autoridad de escritura
  no se infiere de `current_user`, de una GUC declarada por el operador ni de
  `has_table_privilege` efectivo. El paquete exige la topología completa antes
  de tocar objetos: sesión `uellix_migrator`, `SET LOCAL ROLE uellix_owner`,
  aplicación LOGIN/NOBYPASSRLS que hereda directamente de `uellix_writer`, y
  migrator que puede asumir al owner sólo mediante `SET ROLE`. El owner es
  dueño de la tabla; el writer NOLOGIN recibe la ACL directa `SELECT, INSERT`;
  `uellix_app` no recibe ACL directa ni puede asumir al owner.
  La auto-verificación de la misma transacción inspecciona `pg_roles`,
  `pg_auth_members`, `pg_class`, `pg_policy` y `aclexplode`: exige exactamente
  SELECT de `authenticated`, SELECT+INSERT de `uellix_writer`, cero grants a
  `uellix_app`/`anon`/`service_role`/`PUBLIC`, y prohíbe UPDATE/DELETE.
  No afirma probar configuración remota ni credenciales: antes de cualquier
  aplicación controlada se revalida la topología, ownership, ACL y el runtime.
- **`stella_0003_suggestion_decisions.sql`**: crea la tabla
  `stella_suggestion_decisions` (decisiones humanas sobre sugerencias de
  Stella) con RLS de lectura por organización y exactamente un INSERT
  `TO uellix_app`. El `WITH CHECK` fija a la vez
  `organization_id = current_setting('app.organization_id', true)::uuid`, la
  membresía de `current_user_org_ids()` y `decided_by = auth.uid()`; no hay
  rama de superadministrador para escribir. La server action obtiene tanto el
  actor como la organización desde la identidad validada y abre el contexto
  con `SET LOCAL`; no acepta esos valores del cliente. Sigue **dormida** detrás
  de `STELLA_DECISIONS_PERSISTENCE_ENABLED` (default `false`) hasta que el
  gate controlado la verifique. Invariante de privacidad:
  `previous_value_hash` guarda un SHA-256, nunca texto previo en crudo.
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

`stella_0005` + `stella_0005b` dejan el runtime como `uellix_app` con RLS
activa. En la forma R3.2, `stella_0003` instala el INSERT canónico de
`stella_suggestion_decisions` y deja el catálogo en 105 policies; `stella_0005`
añade sólo las dos restantes (`audit_logs`, `stella_interactions`) para llegar
a 107. La mitad de aplicación —de dónde salen el `userId` y la organización
que esas policies comparan con `auth.uid()` y `app.organization_id`— se obtiene
de la identidad validada, no de argumentos de cliente.

**Ningún script preparado se añadió ni se modificó en esa unidad.** Cinco
caminos quedaron bloqueados por diseño (alta de organización, aceptar
invitación, webhook de Stripe, verificación pública por hash, captura de lead
público) y **ninguno recibió una policy nueva ni un privilegio nuevo**:
resolverlos es una decisión de privilegio con su propio script y su propia
revisión. Ver
[`docs/ops/DATABASE_RUNTIME_CUTOVER.md`](../../docs/ops/DATABASE_RUNTIME_CUTOVER.md)
§8.

## Nota del cierre de compatibilidad (2026-08-02, tarde)

La reauditoría encontró que las dos policies `INSERT` creadas en `0005`, al no
llevar cláusula `TO`, aplicaban a `PUBLIC` y **reactivaban** los grants `INSERT`
pre-cutover de `authenticated`/`service_role` sobre `audit_logs` y
`stella_interactions` (escritura directa por PostgREST con un JWT válido).
`stella_0005c` re-alcanza sólo esas dos a `TO uellix_app` y revoca esos grants;
la policy de decisiones ya nace canónica en `0003` y `0005c` la verifica sin
reescribirla. `stella_0005d` repara la ruta SECURITY DEFINER de Storage que
`stella_0004` dejó sin `USAGE` sobre el esquema `storage`. Distribución medida
tras el cierre: **107 policies = 101 `{public}` + 3 `{uellix_app}` + 2
`{authenticated}` + 1 `{anon}`**. Verificación ejecutable:
`tests/database-insert-policy-scope.test.ts` (catálogo + sondas en vivo con
ROLLBACK).


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

---

## M-8 — reparación forward-only del candado de `claim` (`grounding_0005`)

**Estado: DISEÑO. No aplicado a ninguna base. Ninguna bandera habilitada.**

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `grounding_0005_claim_advisory_lock.sql` | **ninguno, a propósito** (`db/hosted/forward-only-packages.ts`) | **ninguno todavía**; exige `grounding_0002` aplicado y su reparación de train 2 presente en `register_document_version` | **No crea rol, esquema, tabla, policy ni trigger, y no concede ni revoca nada.** Republica **en el sitio** `uellix_grounding.claim_active_document_version(uuid)` — misma firma, mismo tipo de retorno, mismo propietario, mismo ACL, mismo `SECURITY DEFINER`, mismo `search_path=''` — sustituyendo `SELECT … FROM public.evidence_items … FOR UPDATE` por `pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))`, la **misma clave** que toma `register_document_version`. Corrige además el `COMMENT ON FUNCTION` que afirmaba lo contrario | **DISEÑO — no aplicado** |

> **El defecto.** PostgreSQL exige privilegio **UPDATE** sobre una tabla para
> tomar un **candado de fila** en ella, no sólo `SELECT`. `grounding_0002` §219
> concede a `uellix_cap_grounding` exactamente `GRANT SELECT ON
> public.evidence_items`, y lo hace a propósito. Así que **toda** llamada de
> `uellix_app` a `claim_active_document_version` moría con `42501` antes de leer
> una sola versión: los paquetes instalaban limpios y quedaban **funcionalmente
> muertos por el lado de escritura**.

> **La asimetría es la prueba.** El mismo `grounding_0002` encontró este defecto
> en la función **hermana** `register_document_version` durante la revisión
> adversarial del tren 2, lo midió en un contenedor desechable y sustituyó el
> candado de fila por el advisory lock (§765-787). La reparación **nunca alcanzó
> a `claim_active_document_version`**, y el `COMMENT` siguió diciendo que ambas
> tomaban «el mismo candado de fila».

> **Por qué NO es `GRANT UPDATE`.** El propio §6 de `grounding_0002` lo nombra:
> ensanchar la superficie de escritura de una tabla de negocio para que un
> candado dentro de otra función resulte cómodo es cómo una frontera deja de
> significar algo. El rol pasaría a poder **cambiar** filas de cadena de
> custodia para poder **esperar** en una. La §2 del paquete vuelve a afirmar,
> después del cambio, que el privilegio sigue ausente.

> **Por qué no lleva rollback.** Lo que retira es un **defecto**, no una
> prestación: «restaurar la versión anterior de `claim_active_document_version`»
> y «republicar un candado que ningún principal puede tomar» son la misma frase.
> Es el mismo razonamiento que `stella_0016` y `stella_0017` registran para R1 y
> R6-INT. La reversión honesta, si de verdad se quiere, son los rollbacks de la
> propia unidad: `grounding_0004` → `grounding_0003` → `grounding_0002`.

> **REAPLICAR `grounding_0002` DESPUÉS DE `grounding_0005` ESTÁ BLOQUEADO POR EL
> RUNNER.** `grounding_0002` es idempotente, así que volver a ejecutarlo solo
> **funcionaría** — y republicaría `claim_active_document_version` con el
> `FOR UPDATE` dentro, reabriendo M-8 junto a su propio arreglo. **Ninguna firma
> cambia**, así que ninguna comprobación posterior lo notaría. La supersesión
> está declarada en [`db/prepared-package-order.ts`](../prepared-package-order.ts).
>
> Consecuencia operativa para el **AVISO OPERATIVO** de arriba: si la unidad de
> grounding se re-aplica entera (`0002 → 0003 → 0004`), hay que aplicar
> `grounding_0005` **inmediatamente después, en la misma ventana**. La cadena
> completa es `0002 → 0003 → 0004 → 0005`.

> **Lo que el paquete deliberadamente NO emite.** Ni `ALTER FUNCTION … OWNER
> TO`, ni `REVOKE ALL … FROM PUBLIC`, ni `GRANT EXECUTE … TO uellix_app`.
> `CREATE OR REPLACE FUNCTION` **conserva** propietario y ACL, así que los tres
> serían no-ops en el caso normal — y en el caso que importa serían **peores**
> que no-ops: repararían en silencio una propiedad o un grant que hubiera
> derivado, y el paquete reportaría éxito sobre una base cuya postura habría
> cambiado sin decirlo. La §2 los **mide** con `aclexplode()` en vez de
> re-emitirlos, y se niega.

---

## M-2 — la lista de roles de escritura en Storage (`stella_0019`)

**Estado: DISEÑO. No aplicado a ninguna base hosted. Ninguna bandera
habilitada.** Probado por ejecución en contenedor desechable sobre el baseline
versionado de [`../baseline/`](../baseline/README.md).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_0019_storage_write_roles.sql` | `stella_0019_rollback.sql` | **ninguno todavía**; exige el BASELINE (unidad 41), `stella_0004`/`stella_hosted_0001` para el owner y `stella_0005d` para el `USAGE` sobre el esquema `storage` | **No crea rol, esquema, tabla, policy ni trigger, y no concede ni revoca nada.** Republica **en el sitio** `public.can_write_evidence_object(text, uuid)` — misma firma, mismos nombres de argumento, mismo propietario, mismo ACL, mismo `SECURITY DEFINER`, mismo `search_path=''` — sustituyendo `om.role IN ('organization_admin','analyst')` por los **cuatro** roles canónicos `('super_admin','organization_admin','impact_manager','analyst')` | **DISEÑO — no aplicado en hosted** |

> **El defecto.** Uellix tiene **una** frontera de permiso para «este miembro
> puede adjuntar evidencia a este proyecto», escrita en tres sitios que deberían
> coincidir: `canUploadEvidence()` en `lib/auth/permissions.ts`
> (`hasRole(role,'analyst')`, es decir los cuatro roles con `ROLE_HIERARCHY >=
> 40`), la policy `evidence_items_insert` de `db/migrations/0031_rls_core.sql`
> (los mismos cuatro, deletreados), y este helper — que nombraba **dos**. La
> consecuencia no es simétrica: la tabla acepta la fila y Storage rechaza el
> objeto. Un `impact_manager` crea los metadatos de una evidencia y **no puede
> subir el fichero que describen**; lo que ve es «new row violates row-level
> security policy» sobre una operación que el propio helper de permisos de la
> aplicación ya había autorizado.
>
> **Medido, no deducido**, sobre el baseline restaurado y a través de la policy
> real `insert_evidence` como `authenticated`: con el cuerpo de la unidad 41,
> `can_read_evidence_object` responde **true** para `impact_manager` y el
> `INSERT` en `storage.objects` **falla**. Con `stella_0019`, ambos pasan.

> **Por qué NO es una edición de la unidad 41.**
> `supabase/migrations/20260716000001_storage_policies.sql` y su mitad derivada
> `db/prepared/storage/20260716000001_part_a_helpers.psql.sql` son bytes de
> **baseline**: instalados, fijados por hash en `db/hosted/baseline-manifest.ts`
> y parte de un manifiesto **congelado en 50 unidades**; además la mitad derivada
> se **genera**, y `pnpm storage:verify` rechaza una edición a mano. Es el mismo
> razonamiento que `grounding_0005` registra para `grounding_0002`: la
> reparación es un **eslabón nuevo**, no una reescritura de uno instalado.

> **Por qué SÍ lleva rollback, cuando las tres reparaciones anteriores no.**
> `grounding_0005`, `stella_0016` y `stella_0017` son forward-only porque
> revertirlos **reabriría una vulnerabilidad**. Aquí la dirección es la
> contraria: el forward **amplía** una autorización de dos roles a cuatro, y el
> rollback la **estrecha** de vuelta a dos. Una base revertida rechaza **más**
> que un momento antes, nunca menos, y no existe entrada bajo la cual el
> rollback conceda nada a nadie. Es exactamente la condición en que la regla 4
> de este README aplica sin excepción, así que la excepción no se toma y
> `db/hosted/forward-only-packages.ts` **no se toca**. El rollback **reabre M-2 y
> lo anuncia con `RAISE WARNING`** — un rollback cuyas postcondiciones afirmaran
> un estado más seguro que aquello que revierte no restauraría nada.

> **Lo que el paquete deliberadamente NO hace.** No añade
> `OR public.current_user_is_super_admin()`. Las dos policies de
> `evidence_items` llevan ese escape y **los dos helpers de Storage no** —
> `can_read_evidence_object` tampoco. Añadirlo aquí daría a un super admin de
> **plataforma sin pertenencia activa** el derecho a escribir objetos en el
> bucket de una organización: una capacidad que hoy no existe en el contrato de
> Storage y que nadie pidió a este paquete. La asimetría entre la tabla y el
> bucket es real y queda **registrada como hallazgo**, no cerrada por un paquete
> cuyo asunto es una lista de roles.
>
> Tampoco emite `ALTER FUNCTION … OWNER TO`, `REVOKE` ni `GRANT`:
> `CREATE OR REPLACE FUNCTION` conserva propietario y ACL, así que los tres
> serían no-ops en el caso normal y **peores que no-ops** en el que importa. La
> §2 los **mide** —capturando el ACL en la §0 y comparándolo después, no
> fijándolo, porque una pila donde la unidad 41 corrió como `postgres` conserva
> una entrada residual `postgres=X` que una instalada por `uellix_migrator`
> nunca tuvo, y **ambas son correctas**.

> **`M2-COMP-01` NO se cierra aquí, y es deliberado.** El `DELETE`
> compensatorio de `lib/pipeline/evidence.ts` puede afectar **cero filas** en
> silencio: `evidence_items` no tiene policy de `DELETE` (la unidad de RLS la
> omite a propósito — el archivado es un `UPDATE` a `status='archived'`), así
> que RLS lo niega sin error. `stella_0019` hace ese camino **menos frecuente**
> (dos roles dejan de fallar) y **no más correcto** (los roles que siguen
> fallando por otros motivos siguen dejando la fila huérfana). Confundir las dos
> cosas dejaría que una lista de roles cerrara sobre el papel un defecto de
> integridad transaccional.

> **PELIGRO DE REAPLICACIÓN, para el operador.** Reaplicar la mitad de Storage
> del **baseline** sobre este paquete republicaría el cuerpo de dos roles junto a
> su propio arreglo, **sin cambiar ninguna firma** y sin que nada posterior lo
> note. No está declarado en [`db/prepared-package-order.ts`](../prepared-package-order.ts)
> porque **no es alcanzable**: `db/prepared/storage/` está fuera del directorio
> contra el que `scripts/db-migrate-local.ts` resuelve por `basename`, y el
> baseline es una instalación prechain que no reejecuta una unidad aislada. Una
> sonda de supersesión que no puede dispararse nunca es una guarda que enseña al
> operador a confiar en una comprobación que no está corriendo, así que el
> peligro se registra **aquí, para el humano**, en vez de allí.
>
> La dirección normal sí converge: `stella_0019` es idempotente, su §0 acepta
> explícitamente el estado ya reparado y **rechaza** un tercer estado editado a
> mano en vez de sobrescribirlo.

> **BLOQUEADOR DE PUBLICACIÓN EN HOSTED, MEDIDO DOS VECES (2026-08-15).**
> `pnpm certify:pg176` y `pnpm certify:remediation` aplican la cadena gobernada
> sobre la forma **gestionada** —bootstrap + las 50 unidades de baseline— y
> `stella_0019` **se niega ahí**, en su propia guarda §0.6:
>
> ```
> stella_0019 aborted: can_write_evidence_object is owned by postgres,
> not uellix_owner.
> ```
>
> No es un defecto del paquete: es la guarda funcionando. La hipótesis de
> propiedad que planteó la auditoría M-2 **es cierta en hosted y falsa en
> local**, y sólo una medición local no podía verlo:
>
> | | dueño de los dos helpers |
> |---|---|
> | local (post-`stella_0004`) | `uellix_owner` |
> | gestionado (baseline + `stella_hosted_0001`) | **`postgres`** |
>
> Tres hechos independientes lo confirman, y ninguno es del arnés:
> `BASELINE_GLOBAL_INVARIANTS.ownershipStatements = 0` —las 50 unidades no
> transfieren propiedad de nada—; `stella_hosted_0001` sólo transfiere
> `stella_interactions` y su propio esquema, **no** las 38 tablas y 8 funciones
> que mueve `stella_0004`; y `posture.functionOwners` del artefacto de
> certificación ahora **registra** `owner: postgres` para ambos helpers con
> `baselineApplied: 50`. Esa propiedad **nunca se había medido**: ningún
> artefacto de staging committeado la recoge.
>
> **Por qué ningún mecanismo existente lo cierra.** `stella_hosted_0001`
> concede `uellix_owner` **a** `postgres` (§297) y **a** `uellix_migrator`
> (§423), pero nunca `postgres` a `uellix_migrator`. El patrón de T10 —membresía
> temporal emitida por el generador gobernado— sólo alcanza roles que
> `uellix_migrator` creó y sobre los que tiene ADMIN; `postgres` no es uno. Así
> que el instalador gobernado **no puede** reemplazar una función de `postgres`,
> y T11 no llega a staging por la cadena.
>
> **El precedente para la resolución no es la cadena.**
> `stella_hosted_0002_prechain_authority_reconciliation` es gobernado,
> forward-only, se aplica en gestionado **como `postgres`** y **no** está en
> `HOSTED_CHAIN`. `postgres` posee los helpers **y** puede `SET ROLE
> uellix_owner`, así que un T11 ejecutado por `postgres` sí funciona ahí — que
> es exactamente la forma que toma `stella_0005d` en local para estas dos mismas
> funciones. La decisión entre (a) mover T11 a esa vía administrativa y (b)
> añadir una normalización de propiedad hosted previa **no se ha tomado**.
>
> **El cierre LOCAL no se ve afectado y sigue medido:** 31/31 en la matriz de
> roles sobre el cuerpo de T11 y 31/31 sobre el de la unidad 41 tras el
> rollback, idempotencia, ACL y las tres policies sin cambios.

### M-2 — reconciliación de propiedad prechain (`stella_hosted_0003`)

**Estado: DISEÑO. No aplicado a ninguna base hosted.** Probado por ejecución en
contenedor desechable y por las dos certificaciones canónicas.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0003_storage_helper_ownership.sql` | **ninguno, a propósito** (`db/hosted/prechain-ownership.ts`) | **ninguno todavía**; exige el BASELINE (unidad 41) y `stella_hosted_0001` (para que exista `uellix_owner` y para la membresía que el traspaso necesita) | **No crea rol, esquema, tabla, policy ni función, y no concede ni revoca nada.** Emite exactamente **dos** sentencias: `ALTER FUNCTION public.can_read_evidence_object(text, uuid) OWNER TO uellix_owner` y la misma para `can_write_evidence_object` | **DISEÑO — no aplicado en hosted** |

> **Es la única operación que no se puede delegar.** `ALTER FUNCTION … OWNER TO`
> exige pertenencia al dueño **actual**. En gestionado ese dueño es `postgres`, y
> `uellix_migrator` no es miembro suyo: `stella_hosted_0001` concede
> `uellix_owner` **a** `postgres` (§297) y **a** `uellix_migrator` (§423), nunca
> `postgres` a nadie. El patrón de T10 —membresía temporal emitida por el
> generador gobernado— sólo alcanza roles que el propio `uellix_migrator` creó y
> sobre los que tiene ADMIN OPTION. Por eso el traspaso lo hace `postgres` y
> **nada más** lo hace: el cambio funcional (los cuatro roles) se queda en T11,
> en la ruta gobernada, aplicado por `uellix_migrator` **sin ningún privilegio
> administrativo**. Medido: tras la reconciliación, `CREATE OR REPLACE` bajo
> `uellix_migrator` (`rolsuper = false`) + `SET LOCAL ROLE uellix_owner` **tiene
> éxito**.

> **Por qué los DOS helpers y no sólo el que T11 republica.** No es simetría:
> `stella_0019` §0.6 afirma el dueño de **ambos** («the two helpers were
> published and transferred together; a split ownership is a state this package
> cannot account for»). Normalizar sólo el de escritura dejaría a T11
> negándose en la guarda siguiente. Además el §0.3 de este paquete **rechaza**
> una propiedad partida, porque es un estado que ni el baseline ni `stella_0004`
> ni `stella_hosted_0001` producen.

> **Lo único que no puede dejar intacto, dicho antes del código.**
> `ALTER … OWNER TO` reescribe la entrada de ACL **del dueño**. Medido en
> PG 17.6, dirección forward, sobre la forma hosted:
> `{postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}` →
> `{uellix_owner=X/uellix_owner, authenticated=X/uellix_owner, service_role=X/uellix_owner}`.
> La entrada implícita del dueño viejo desaparece, la del nuevo se crea, y **todo
> otro concesionario se conserva**. Así que «el ACL no cambia» sería **falso** y
> fallaría en toda ejecución correcta; lo que la §2 afirma es que el conjunto de
> pares (concesionario, privilegio) **no-dueño** es idéntico antes y después.
> **Consecuencia declarada:** `postgres` pierde su EXECUTE implícito salvo que
> tuviera además uno explícito — ninguna ruta de runtime llama a estos helpers
> como `postgres`, y es exactamente la postura que `stella_0004` produce en
> local.

> **Por qué NO está en `HOSTED_CHAIN`.** Dos razones, y la segunda es la que
> pesa. (1) Es una **precondición**, no un eslabón: un miembro de la cadena
> adquiere testigos, aparece en `nextChainPackage` y pasa a ser algo que a un
> operador se le puede decir que aplique «a continuación». (2) **Lo aplica un
> principal distinto**: cada eslabón de `HOSTED_CHAIN` lo aplica
> `uellix_migrator`, y éste no puede — ésa es toda su razón de existir. Contarlo
> como miembro haría que el conteo de la cadena fuera un número que **ninguna
> identidad puede producir por sí sola**.

> **Por qué reutiliza la FORMA prechain pero no el LEDGER de intentos.** El
> protocolo de `remediation-attempt.ts` existe porque `stella_hosted_0002` tiene
> un resultado **ambiguo** que sólo una observación fresca puede clasificar, así
> que nunca debe reintentarse a ciegas. `ALTER FUNCTION … OWNER TO` no tiene ese
> resultado: es idempotente y convergente, y re-aplicarlo sobre un par ya movido
> es un no-op cuyo ACL queda byte a byte igual (medido). Un paquete al que
> reintentar no puede dañar no necesita un mecanismo cuyo único fin es impedir
> el reintento.

> **Orden prechain (completo):** `stella_hosted_0000` (identidad de roles,
> HPO-ODS-W2-03) → baseline (64 unidades) → `stella_hosted_0001` →
> [`stella_hosted_0002` si el proyecto ya estaba bootstrapeado] →
> **`stella_hosted_0003`** → **`stella_hosted_0004`** → **`stella_hosted_0005`**
> → sentinel → `HOSTED_CHAIN` T1…T11.
>
> Los tres paquetes `0003`/`0004`/`0005` son **unidades administrativas
> prechain**: no son miembros de `HOSTED_CHAIN`, no toman testigo de cadena, y
> los aplica la identidad administrativa (`postgres`), no `uellix_migrator`. El
> orden entre ellos lo imponen **sus propias precondiciones**, no el runbook.

### RT-01 — contrato runtime de los helpers RLS en hosted (`stella_hosted_0006`)

**Estado: DISEÑO. No aplicado a ninguna base hosted.** Cuarta unidad prechain, y
la primera cuyo argumento no es «otra clase de objeto» sino **otro ACTOR**: el
contrato de autoridad prechain de `stella_hosted_0001` §5d se deriva del plan de
autoridad de la **cadena**, así que modela al **instalador** (`uellix_owner`) y
nunca al **runtime** (`uellix_app`).

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0006_runtime_rls_helper_contract.sql` | **ninguno, a propósito** (`db/hosted/prechain-ownership.ts`; la asimetría se argumenta en `forwardOnlyNoRollbackReason`) | **ninguno todavía**; exige los 5 roles y la membresía `uellix_app → uellix_writer` con `INHERIT TRUE` (§0.5/§0.6), y que el ejecutor **posea** las tres funciones (§0.4) | `CREATE OR REPLACE` de las **3** funciones (`current_user_org_ids`, `current_user_is_super_admin`, `current_user_role_in_org(uuid)`) a la forma de `stella_0005` — `search_path=''` + `public.*` cualificado — y **un** `GRANT EXECUTE` sobre las tres `TO uellix_writer, uellix_auditor`. Ni un objeto nuevo, ni un rol, ni una policy, ni un `REVOKE` | **DISEÑO — no aplicado** |

> **Por qué las dos mitades viajan juntas.** Medido en PG 17 por
> `scripts/runtime-helper-contract-dry-run.sh`: los cuerpos hospedados son
> SECURITY DEFINER **propiedad de un superusuario** con `search_path=public` y
> referencias **sin cualificar**. PostgreSQL busca `pg_temp` antes que cualquier
> esquema del path, y todo rol tiene TEMP sobre la base por defecto, así que
> `CREATE TEMP TABLE users(is_super_admin=true)` hace que
> `current_user_is_super_admin()` devuelva **true** — el disyunto de super-admin
> de **89** policies, evaluado con privilegios de superusuario. El arnés mide
> `PG_TEMP_ESCALATION_PRE_FIX=true` y `POST_FIX=false`. Conceder EXECUTE sin
> endurecer entregaría esa primitiva al principal de runtime.

> **Por qué el ejecutor es el dueño y no `uellix_owner`.** `CREATE OR REPLACE
> FUNCTION` exige **propiedad**, y ningún GRANT la confiere. Eso además **disuelve**
> el hueco de autoridad sobre `current_user_role_in_org(uuid)`: `uellix_owner` no
> tiene EXECUTE sobre ella —ni con GRANT OPTION— así que un T12 gobernado jamás
> habría podido emitir ese tercer grant. No se escala autoridad a nadie, no se
> cambia ningún dueño y no se añade ningún eslabón a `HOSTED_CHAIN`.

> **Por qué `search_path=''` y no sólo cualificar.** Medidas las cuatro
> combinaciones en PG 17: cualificar **ya** basta para frenar el sombreado, y
> `pg_catalog, pg_temp` también. Se elige el path vacío porque es el único que
> hace el defecto **inescribible** — son funciones `LANGUAGE sql`, parseadas al
> crearse, así que una referencia sin cualificar bajo `search_path=''` ni siquiera
> se crea (`ERROR: relation "users" does not exist`). La segunda capa impide que
> se retire la primera.

> **`uellix_app` no es grantee.** Alcanza las tres por herencia de
> `uellix_writer` (`stella_hosted_0001` §3), igual que en el modelo local. El §3
> del paquete aserta el privilegio **efectivo** de `uellix_app` por separado del
> grant: aserta sólo el grant pasaría en una base donde la membresía se hubiera
> perdido, entregando un contrato que no alcanza a nadie.

### RT-02 — contrato runtime de ACL de TABLA en hosted (`stella_hosted_0007`)

**Estado: DISEÑO. No aplicado a ninguna base hosted.** Quinta unidad prechain, y
la **otra mitad** de RT-01: `stella_0004` §6 tiene cuatro partes y
`stella_hosted_0006` sólo trajo una (§6b-bis, el EXECUTE de los tres helpers).
§6a/§6b/§6c —los privilegios de **tabla**— se quedaron atrás.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0007_runtime_table_acl_contract.sql` | **ninguno, a propósito** (`db/hosted/prechain-ownership.ts`) | **ninguno todavía**; exige los roles y la membresía `uellix_app → uellix_writer` con `INHERIT TRUE` (§0.2/§0.3), **que `stella_hosted_0006` ya esté aplicado** (§0.3b), que existan las 37 tablas del contrato (§0.4) y que el ejecutor pueda conceder sobre cada una (§0.5/§0.5b) | **Ni un objeto.** Sólo `GRANT`: `SELECT, INSERT` sobre 3 tablas append-only; `SELECT` sobre `stella_interactions`; `SELECT, INSERT, UPDATE, DELETE` sobre 33 operacionales; `SELECT` a `uellix_auditor` sobre las 37. Ningún `REVOKE`, ninguna policy, ningún rol, ningún cambio de dueño | **DISEÑO — no aplicado** |

> **Por qué era invisible hasta que RT-01 aterrizó.** El check de
> `db/identity-context.ts:190` llama a `current_user_is_super_admin()` **antes**
> de cualquier sentencia de negocio. Mientras faltaba ese EXECUTE toda petición
> moría ahí y **ninguna llegaba a tocar una tabla**, así que el 42501 de tabla
> era inalcanzable detrás del 42501 de función. Cerrar el primero es lo que hizo
> observable el segundo: el retest F1 midió entonces
> `42501 permission denied for table users` en las dos mitades del login —el
> SELECT de `loadCurrentUserWithinContext` y el upsert de `syncUserProfile`.
> Medido en hosted: **`uellix_writer` tenía 0 privilegios de tabla** sobre las 39.

> **NO es §6a/§6b copiado.** Dos paquetes **instalados en la cadena hospedada**
> han superado partes del canon, y copiarlo sin enmendar los regresaría:
> `stella_0017` §339/§342 revoca `INSERT, UPDATE, DELETE, TRUNCATE` sobre
> `public.stella_interactions` a `uellix_writer` **y** a `uellix_app` (R6-INT) —
> el ledger se cobra por el protocolo de tickets como `uellix_cap_stella_quota`—
> así que su clase enmendada es **SELECT y nada más**; y `grounding_0002/0003`
> revocan **ALL al writer por nombre** sobre `evidence_document_versions` y
> `evidence_chunks` y conceden SELECT **directamente a `uellix_app`**, así que
> ambas son **CAPABILITY_ONLY** y el paquete no las nombra en ningún GRANT. La
> regla que aplica cabe en una frase: *el contrato hospedado es `stella_0004`
> §6, enmendado sólo donde un paquete instalado después dice otra cosa.*

> **Dos dueños, y por eso hay un `SET ROLE`.** Medido: 36 de las 37 tablas son de
> `postgres` y `public.stella_interactions` es de `uellix_owner`. `postgres` no
> puede conceder sobre ella (`pg_has_role(...,'USAGE')`=false, sin GRANT OPTION)
> pero **sí puede `SET ROLE uellix_owner`** (`INHERIT FALSE, SET TRUE`, la misma
> puerta que usó `stella_hosted_0003`). §4 emite ese único grant bajo
> `SET LOCAL ROLE` y §6(1) aserta que la sesión volvió.

> **`stella_suggestion_decisions`: CONDICIONAL, no ignorada.** Está en §6a del
> canon pero **no existe en hosted**, y no por drift: ninguna unidad de
> `db/migrations` la crea, no aparece en `baseline-manifest.ts` ni en
> `hosted-package-manifest.ts`, y su escritor está tras
> `STELLA_DECISIONS_PERSISTENCE_ENABLED` (default `false`). Clasificación:
> **PACKAGE_NOT_INSTALLED**. §5 concede el par append-only **si y sólo si**
> existe, y emite un NOTICE nombrándola cuando no.

> **Rehúsa un tercer estado en vez de normalizarlo.** A diferencia de
> `stella_0004` §6 no emite **ningún** `REVOKE` de convergencia: el prestate
> hospedado medido está **vacío**, así que no hay nada legítimo que retirar y
> cualquier privilegio hallado lo puso algo ajeno a este repositorio. Rehúsa
> ante posturas parciales, widening append-only, privilegio estructural
> (`TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN`), grant directo a `uellix_app` y
> relación en `public` propiedad de un rol de runtime. Verificado en PG 17 por
> `scripts/runtime-table-acl-dry-run.sh` (`pnpm dry-run:runtime-table-acl`), que
> reproduce el 42501 previo y mide los cinco rehúses.

### M-2 — USAGE sobre el esquema `storage` en hosted (`stella_hosted_0004`)

**Estado: DISEÑO. No aplicado a ninguna base hosted.** Es la **segunda mitad** del
par prechain, y es un paquete aparte por la misma razón por la que
`stella_0005d` es un script aparte de `stella_0004` en local.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0004_storage_schema_usage.sql` | **ninguno, a propósito** (`db/hosted/prechain-ownership.ts`) | **ninguno todavía**; exige `stella_hosted_0003` **ya aplicado** (precondición dura en §0.4) | **Una sola sentencia:** `GRANT USAGE ON SCHEMA storage TO uellix_owner`. Nada más | **DISEÑO — no aplicado** |

> **Por qué hacen falta los dos.** Medido: con `stella_hosted_0003` aplicado y
> éste ausente, T11 **sigue negándose** — en su §0.7 en vez de su §0.6:
> «uellix_owner has no USAGE on schema storage, so both helpers already return
> false for every caller (stella_0005d)». Los cuerpos de los dos helpers llaman
> a `storage.foldername(name)` y son SECURITY DEFINER, así que esa llamada
> resuelve con los privilegios del **dueño**. En cuanto el dueño pasa a ser
> `uellix_owner` y ése no tiene USAGE sobre `storage`, la referencia cualificada
> lanza **dentro** del definer, el `EXCEPTION WHEN OTHERS THEN RETURN false` del
> propio cuerpo se la traga, y toda operación de objetos de evidencia se niega
> **en silencio para todos los roles**. Es exactamente el agujero que
> `stella_0005d` cerró en local, reabierto en hosted por el traspaso.

> **Por qué `postgres` puede hacerlo sin superusuario.** El esquema `storage` es
> de la plataforma y `stella_0005d` exige superusuario en local. Gestionado no
> expone ninguno — y no le hace falta: **medido** sobre la imagen de
> certificación, `postgres` tiene `U*` sobre ese esquema (USAGE **WITH GRANT
> OPTION**, concedido por `supabase_admin`), que es justo el derecho a pasarlo a
> otro rol. La §0.3 lo **pregunta** en vez de asumirlo.

> **El orden es vinculante y lo impone el paquete, no el runbook.** La §0.4 de
> `stella_hosted_0004` se niega si no hay ya un helper SECURITY DEFINER
> propiedad de `uellix_owner`. Aplicarlo primero es una **negativa**, no un
> reordenamiento silencioso.

> **CORRECCIÓN (M-2, 2026-08-15).** Este apartado decía que el prechain era un
> **par**. Era falso, y la frase «con `stella_hosted_0003` aplicado y éste
> ausente, T11 sigue negándose» describía **el primero** de dos agujeros, no el
> último. Con `0003` y `0004` aplicados la superficie **seguía muerta**, y lo
> cerró un tercer paquete: `stella_hosted_0005`. El prechain es un **trío**.

### M-2 — SELECT de tabla para el definer en hosted (`stella_hosted_0005`)

**Estado: DISEÑO. No aplicado a ninguna base hosted.** Es la **tercera** unidad
prechain y la última prerequisito de los helpers de Storage.

| Script | Rollback | Gate | Objetos que crea/altera | Estado |
|---|---|---|---|---|
| `stella_hosted_0005_storage_helper_table_read.sql` | **ninguno, a propósito** (`db/hosted/prechain-ownership.ts`) | `STORAGE_HELPER_FUNCTIONAL_PROBE` en ambas certificaciones; exige `stella_hosted_0003` **y** `stella_hosted_0004` ya aplicados (§0.3 y §0.4) | **Una sola sentencia:** `GRANT SELECT ON TABLE public.organization_members TO uellix_owner`. Sin `WITH GRANT OPTION`, sin INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, sin tocar cuerpo, dueño ni ACL de ninguna función, sin recrear ninguna policy | **DISEÑO — no aplicado** |

> **Por qué hacía falta un tercero.** Medido sobre la forma gestionada (baseline
> 50 → `stella_hosted_0001` → `0003` → `0004`), 2026-08-15: dueño de ambos
> helpers `uellix_owner`, `USAGE` sobre `storage` **true**, `SELECT` sobre
> `public.projects` **true**, `SELECT` sobre `public.organization_members`
> **FALSE**. Los dos cuerpos leen **dos** relaciones en la misma sentencia
> (`FROM public.projects p JOIN public.organization_members om …`), y como son
> SECURITY DEFINER esa lectura ocurre con los privilegios del **dueño**. Falta
> el `SELECT` → `permission denied for table` **dentro** del definer → el
> `EXCEPTION WHEN OTHERS THEN RETURN false` del propio cuerpo se lo traga → se
> niega **en silencio**. Ejecutado contra las policies reales de
> `storage.objects` como `authenticated` con `request.jwt.claim.sub` real, los
> **nueve** casos de la matriz de roles daban DENY, en escritura **y en
> lectura**.

> **Por qué UNA tabla y no dos.** `public.projects` ya está cubierta por
> `stella_hosted_0001` §7 (`GRANT SELECT, REFERENCES ON TABLE public.projects TO
> uellix_owner WITH GRANT OPTION`). Esa lista deriva de otra pregunta —la propia
> negativa del bootstrap lo dice: «the governed chain runs twelve statements
> against these objects as uellix_owner»— y es correcta para la cadena.
> `organization_members` no está en ella porque **ningún paquete de la cadena
> toca esa tabla**: cuando se escribió la lista los helpers eran de `postgres`,
> que es dueño de ambas tablas y no necesita concesión. `stella_hosted_0003`
> cambió **quién ejecuta** esos cuerpos y con ello metió una relación en el
> conjunto de lecturas requeridas que ninguna lista recalculó. La §0.5 de este
> paquete **afirma** `projects` en vez de concederla.

> **La otra mitad de la superficie de lectura: RLS, que no es una concesión.**
> Medido: ambas tablas tienen RLS **habilitada**, ambas son de `postgres` en
> hosted, y `uellix_owner` no tiene `BYPASSRLS` — así que sus policies de SELECT
> se evalúan **también para el definer**, y leen
> `organization_id = ANY (current_user_org_ids()) OR current_user_is_super_admin()`.
> Esas dos funciones son SECURITY DEFINER de `postgres` y `stella_hosted_0001`
> §7 ya concede `EXECUTE` sobre ambas a `uellix_owner`, así que el filtro
> resuelve bien y no hace falta nada de aquí. La §0.6 lo **afirma** en vez de
> asumirlo.

> **Por qué la sonda no llama a la función.** Consecuencia directa de lo
> anterior: `current_user_org_ids()` resuelve `auth.uid()`, es decir
> `request.jwt.claim.sub`. Una sesión administrativa sin claim no ve **ninguna**
> fila a través de esas policies, así que
> `SELECT public.can_write_evidence_object(…)` devuelve **false** en una base
> perfectamente sana. Medido en ambos sentidos: sin claim `false`, con claim
> `true`. Una certificación que sondease la función así reportaría DENY-para-
> todos sobre una base que funciona, y no podría distinguirlo del apagón real.
> Por eso `STORAGE_HELPER_FUNCTIONAL_PROBE` se hace `authenticated`, fija un
> claim real y deja decidir a la **policy** de `storage.objects`.

> **Por qué la certificación tuvo que cambiar, no sólo los paquetes.** Todo lo
> anterior era invisible para los testigos: T11 se medía `INSTALLED` —función
> presente, cuatro roles en el cuerpo, dueño y ACL intactos, las tres policies
> sin tocar— sobre una base donde **toda** subida se negaba. `COMPLETE` es ahora
> una conjunción que incluye la sonda funcional, y `stella_0019` §0.7b/§0.7c se
> **niega** si el definer no puede leer lo que une. Hacen falta los dos: la
> guarda impide que ocurra, la sonda impide que ocurra **en silencio** si alguna
> edición futura quita la guarda.

---

## G1-B — la mitad hosted de la policy de INSERT en `audit_logs` (`stella_hosted_0008`)

| Script | Rollback | Aplicado | Qué hace | Estado |
|---|---|---|---|---|
| `stella_hosted_0008_audit_log_write_capability.sql` | `stella_hosted_0008_rollback.sql` | **ninguno todavía** | **Ni un GRANT.** Crea **una** policy: `audit_logs_insert_member_or_admin ON public.audit_logs FOR INSERT TO uellix_app`, con el `WITH CHECK` de `stella_0005c` **carácter por carácter** | **SUPERSEDIDO por Drizzle — FIBIU-28/FIBDB-035 (`db/migrations/0042_fib_audit_insert_policy.sql`) — NO APLICAR.** Nunca aplicado en ninguna base. El archivo permanece byte a byte sin tocar (pinneado por digest en `db/hosted/prechain-ownership.ts`); esta fila y `db/prepared-package-order.ts` son el registro de la disposición |

> **Canal:** unidad administrativa **prechain**, registrada y pinada por
> SHA-256 en `db/hosted/prechain-ownership.ts`
> (`PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY`). **No** es eslabón de `HOSTED_CHAIN`.
> Se aplica por la conexión **administrativa** (`$UELLIX_STAGING_ADMIN_URL`),
> una transacción, `-1 -v ON_ERROR_STOP=1`. Procedimiento de operador:
> `docs/ops/staging/STELLA_PRECHAIN_OPERATOR_RUNBOOK.md` §0.0.3.

> ### ⚠️ Corrección de identidad (G1-B)
>
> La **primera** revisión de este paquete exigía `current_user = 'uellix_owner'`
> y llamaba a ese rol «el dueño de las policies de `public.audit_logs`». Eso es
> cierto **en local** —`stella_0004` transfiere todo `public` a `uellix_owner`—
> y **falso en hosted**: la misma observación de catálogo que el paquete cita
> dice `{ "relation": "public.audit_logs", "owner": "postgres" }`, porque
> `stella_hosted_0001` §399 transfiere **una sola** relación y
> `stella_hosted_0007` verifica que ningún dueño se movió.
>
> El paquete era por tanto **INAPLICABLE por los dos lados**: como
> `uellix_owner` el DDL de policy da `42501 must be owner of relation
> audit_logs`; como la identidad que **sí** es dueña, abortaba su propia
> precondición.
>
> **Qué lo sustituye:** la forma que `stella_hosted_0007` ya probó —
> *sesión administrativa → dueño MEDIDO (`pg_class.relowner`, nunca un literal)
> → DDL de policy bajo la identidad que PostgreSQL exige → identidad
> administrativa restaurada y comprobada*. Dos resultados admitidos
> (`SESSION_IS_OWNER`, `OWNER_ASSUMABLE`) y **rechazo fail-closed** de cualquier
> otro, nombrando el dueño medido. **No transfiere propiedad**: mover
> `public.audit_logs` a `uellix_owner` arreglaría la aplicabilidad cambiando la
> topología de propiedad que `stella_hosted_0007` acaba de certificar.
>
> **Segunda pared, encontrada por el dry-run:** `CREATE POLICY` analiza su
> `WITH CHECK` al crearse y éste nombra `auth.uid()`. En Supabase gestionado el
> esquema `auth` lo posee `supabase_admin` y su ACL admite a `postgres`, **no** a
> los roles `uellix_*`. La §0.7 lo comprueba **por adelantado**, nombrando el
> privilegio que falta, en vez de morir dentro del DDL.
>
> **Medido, no afirmado:** `scripts/audit-capability-identity-dry-run.sh`
> recorre ambas ramas, el caso fail-closed, la idempotencia, el rechazo de una
> segunda policy de escritura y los dos rollbacks, sobre PostgreSQL 17.6
> desechable (`--network none`).

> **El hallazgo, medido.** En el proyecto hosted de staging `public.audit_logs`
> tiene RLS **habilitada** y **exactamente una** policy —
> `audit_logs_select_member_or_admin`, de `SELECT` — según
> `artifacts/hosted-chain-posture-observation-postcred.json`. No hay policy de
> `INSERT`. `uellix_app` es `NOBYPASSRLS` y no es dueño de la tabla, así que
> **todo** append del runtime al rastro de auditoría es negado por RLS.

> **Y es negado a pesar de que el privilegio de tabla está bien.**
> `stella_hosted_0007` §1 concede `SELECT, INSERT ON public.audit_logs TO
> uellix_writer`, y `stella_hosted_0001` §433 concede `uellix_writer TO
> uellix_app WITH INHERIT TRUE`. El `GRANT` está; la **policy** no está. La
> postura resultante es **segura** (nadie no autorizado escribe) y
> **funcionalmente muerta** (nadie autorizado escribe tampoco):
> `SAFE_BUT_FUNCTIONALLY_BLOCKED`.

> **Por qué hosted nunca la recibió.** La policy existe en local, creada por
> `stella_0005c_runtime_policy_scope.sql` (y antes por `stella_0005`). Ambos son
> paquetes **LOCAL-ONLY** que se aplican con `pnpm db:prepared:apply:local`;
> ninguno es miembro de `HOSTED_CHAIN` ni figura en
> `db/hosted/hosted-package-manifest.ts`. Es exactamente la misma clase de
> omisión que `stella_hosted_0006` cerró para la capa de **funciones** y
> `stella_hosted_0007` para la de **tablas**: ésta es la capa de **policies**,
> y la última que el runtime necesita.

> **Por qué el predicado se copia y no se adapta.** Una policy hosted meramente
> *parecida* a la local significaría **dos** reglas de tenancy que revisar en vez
> de una, y la diferencia entre ambas viviría en la cabeza de nadie.
> `tests/stella-audit-log-write-capability.test.ts` compara los dos cuerpos
> normalizando espacios y falla si divergen.

> **Lo que el paquete NO hace.** No concede nada a nadie —el privilegio de tabla
> ya existe—; no crea policy para `authenticated`, `service_role`, `anon` ni
> `PUBLIC` (una policy sin `TO` es `TO PUBLIC` y reabriría el hallazgo M1 que
> `stella_0005c` cerró); no habilita, deshabilita ni fuerza RLS; no toca la
> policy de `SELECT`, el trigger append-only, ninguna otra tabla, ningún rol y
> ningún dueño.

> **Sus guardas.** §0.3 se **niega** si RLS no está habilitada en la tabla —una
> policy permisiva sobre una tabla sin RLS no concede nada y **oculta** ese
> hecho—; §0.4 se niega si `uellix_app` no tiene ya `INSERT` (habría que aplicar
> `stella_hosted_0007` antes); §0.5 se niega si no puede `EXECUTE` los helpers
> que el predicado invoca (`stella_hosted_0006`). La postcondición afirma además
> que **no existe una segunda** policy de escritura: las permisivas se combinan
> con `OR`, así que una policy extra derrotaría el binding de actor y de
> organización mientras todas las demás afirmaciones seguirían pasando.

---

## G1-B — el modelo del proveedor deja de ser un DEFAULT de columna (`stella_0020`)

| Script | Rollback | Aplicado | Qué hace | Estado |
|---|---|---|---|---|
| `stella_0020_stella_interactions_model_default.sql` | `stella_0020_rollback.sql` | **ninguno todavía** | Una sola sentencia: `ALTER TABLE public.stella_interactions ALTER COLUMN model_used DROP DEFAULT`. La columna **sigue** `NOT NULL` | **DISEÑO — no aplicado** |

> ### ⚠️ Corrección de canal (G1-B)
>
> La cabecera decía que la variante hosted «se genera y autoriza por el canal
> normal (`pnpm hosted:generate` / el runbook de operador)». **Era falso y era
> load-bearing:** el paquete no está en `db/hosted/hosted-package-manifest.ts`,
> así que `hosted:generate` no producía artefacto y `hosted:verify` no lo
> cubría. Un operador siguiendo esa frase no habría encontrado artefacto y
> habría aplicado el canon directamente — un apply **no gobernado**, que es la
> clase del incidente T1.
>
> **Y ese manifiesto no es el sitio.** `HOSTED_CHAIN` **es** el manifiesto
> (`HOSTED_CHAIN = HOSTED_PACKAGE_MANIFEST.map(e => e.name)`) y
> `WITNESSED_PACKAGES` es esa lista menos el bootstrap: una entrada allí es un
> **eslabón gobernado de cadena** —número `Tn` en
> `db/hosted/authority/window-plan.ts`, ventana de autoridad, testigo,
> `.governed.sql`, y `uellix_migrator` como única identidad aplicadora— y
> además movería `A1_EXPECTED_PACKAGE_COUNT`, que es `HOSTED_CHAIN.length - 1`,
> reclasificando como incompleta una instalación ya certificada y registrada en
> 11/11.
>
> **Canal correcto:** unidad administrativa **prechain**, registrada y pinada
> por SHA-256 en `db/hosted/prechain-ownership.ts`
> (`PRECHAIN_LEDGER_MODEL_DEFAULT`), aplicada por la conexión **administrativa**
> en hosted o por `pnpm db:prepared:apply:local` en local. **El propio archivo
> es el artefacto**: no hay nada que derivar — ni grant sobre el esquema `auth`,
> ni precondición de superusuario, ni creación de roles.
>
> **Identidad:** el mismo contrato de dueño **medido** que
> `stella_hosted_0008`, con las mismas dos ramas admitidas y el mismo rechazo
> fail-closed. En local `scripts/db-migrate-local.ts` ya abre
> `SET ROLE uellix_owner`, así que clasifica `SESSION_IS_OWNER`; en hosted la
> tabla es de `uellix_owner` y la sesión administrativa la asume, así que
> clasifica `OWNER_ASSUMABLE`. Ambas ramas están **medidas** en
> `scripts/audit-capability-identity-dry-run.sh`.

> **El hallazgo.** `db/migrations/0012_stella_interactions.sql` creó
> `model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL`.
> `gemini-2.0-flash` fue **retirado** por Google y devuelve 404 (ver el bloque
> MODEL HISTORY en `lib/stella/config.ts`). El default es por tanto una
> **segunda fuente de verdad** del modelo de Stella que **no coincide** con la
> única real, `STELLA_DEFAULT_GEMINI_MODEL`.

> **Por qué se elimina y no se reapunta a `gemini-3.6-flash`.** `model_used`
> registra **qué modelo respondió**: es una *medición*, no una configuración, y
> un default de columna es la base de datos **inventando** una medición para una
> fila cuyo escritor no la aportó. Reapuntar el literal conservaría exactamente
> esa propiedad y la haría **más difícil de ver**, porque el valor inventado
> pasaría a parecer plausible.

> **Por qué no cambia ningún comportamiento.** Desde `stella_0017` hay
> exactamente **un** escritor de `public.stella_interactions`:
> `uellix_stella.settle_reserved_quota`, llamada por
> `uellix_stella_ops.complete_operation_ticket`. Esa función resuelve
> `v_model := COALESCE(p_model_used, 'not-applicable')` y **nombra** la columna
> en su lista de `INSERT`, así que la cláusula `DEFAULT` es inalcanzable desde
> ella. La §0.3 del paquete **demuestra** esa afirmación contra el catálogo —se
> niega si algún principal fuera de la capability tiene `INSERT`— en vez de
> asumirla.

> **El rollback restaura un modelo retirado, a propósito.** Un rollback restaura
> lo que había; no lo mejora. Por eso `stella_0020_rollback.sql` escribe
> `gemini-2.0-flash` y **nunca** `gemini-3.6-flash`, y por eso no debe leerse
> como una recomendación de modelo.
