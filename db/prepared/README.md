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
| `stella_0003_suggestion_decisions.sql` | `stella_0003_rollback.sql` | G2 (`docs/ops/gates/G2_PACKAGE.md`); habilita `STELLA_DECISIONS_PERSISTENCE_ENABLED` recién después de aplicarlo | **tabla `stella_suggestion_decisions`** + 2 índices + 2 CHECK + grant SELECT + RLS + política `stella_suggestion_decisions_select` | PREPARADO |
| `grounding_0001_evidence_chunks.sql` | `grounding_0001_rollback.sql` | G2 addendum (`docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`) **+ decisión G5 P3** | extensión `vector`; **tabla `evidence_chunks`** + 2 índices + 3 CHECK + 1 UNIQUE + grant SELECT + RLS + política `evidence_chunks_select` | PREPARADO |

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
- **`stella_0003_suggestion_decisions.sql`**: crea la tabla
  `stella_suggestion_decisions` (decisiones humanas sobre sugerencias de
  Stella) con RLS SELECT-only org-scoped. La server action que la consume
  (`app/actions/stella/decisions.ts`) queda **dormida** detrás de
  `STELLA_DECISIONS_PERSISTENCE_ENABLED` (default `false`) hasta que este
  script pase G2. Invariante de privacidad: `previous_value_hash` guarda un
  SHA-256, nunca el texto previo en crudo.
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

Ambos requerirían un futuro `stella_0004` que **todavía no existe**.
