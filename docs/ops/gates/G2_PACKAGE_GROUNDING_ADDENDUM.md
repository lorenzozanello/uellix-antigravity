# G2 (addendum grounding) — Aplicación de `evidence_chunks` preparada

> Addendum del gate externo G2 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`) para
> el SQL preparado de WS5. Dueño humano: **Lorenzo**. Complementa — no
> sustituye — `docs/ops/SUPABASE_MIGRATION_GATE.md` y
> `docs/ops/SUPABASE_STAGING_MIGRATION_CHECKLIST.md`.

## Alcance

Aplicar (y saber revertir) contra **staging** — nunca producción directamente:

- `db/prepared/grounding_0001_evidence_chunks.sql`
- rollback: `db/prepared/grounding_0001_rollback.sql`

`evidence_chunks` contiene solo datos **derivados y regenerables** (índice de
grounding); el rollback no pierde fuente de verdad.

## Precondiciones (todas binarias)

- [ ] Decisión G5 registrada (`docs/ops/gates/G5_PACKAGE.md`) — en particular
      P3 (¿pgvector o fallback léxico?).
- [ ] pgvector confirmado disponible en el proyecto Supabase de staging
      (Dashboard → Database → Extensions → `vector`). Si NO está disponible y
      G5 P3 = fallback léxico: usar la variante sin `embedding` descrita en
      `db/prepared/README.md`.
- [ ] Migraciones base al día en staging: `evidence_items` y `organizations`
      existen y los helpers RLS (`current_user_org_ids`,
      `current_user_is_super_admin`) están creados y con `EXECUTE` concedido
      (estado equivalente a `0032` + `0033`, ver incidente en
      `SUPABASE_MIGRATION_GATE.md`).
- [ ] Backup de staging registrado y restaurable por un humano.
- [ ] Suite offline verde en el branch: `pnpm vitest run lib/grounding`.

## Ejecución separada — no forma parte de la corrida de `stella_0002`/`0003`

Este script se aplica **en una sesión propia**, después de los scripts
`stella_*` y solo cuando sus dos condiciones de gate estén cumplidas:

1. **Decisión G5 P3 registrada** (`docs/ops/gates/G5_PACKAGE.md`): pgvector vs.
   fallback léxico. **Sin esa decisión el script no se ejecuta.**
2. **pgvector confirmado disponible** en el proyecto de staging
   (Dashboard → Database → Extensions → `vector`).

`grounding_0001` no comparte precondiciones ni transacción con
`stella_0002`/`stella_0003`, y un aborto suyo **no** invalida la aplicación de
aquellos. Si G5 P3 eligió el fallback léxico y pgvector no está disponible,
aplicar la variante sin la columna `embedding` descrita en
`db/prepared/README.md` — la guarda de forma del script tolera ambas variantes.

## Aplicación (staging)

**Método principal — psql con transacción única (preferido):**

```bash
# con el connection string de STAGING (¡verificar dos veces el host!)
# -1 = todo el script en UNA transacción: un fallo no deja la tabla creada
#      con RLS todavía sin habilitar.
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/grounding_0001_evidence_chunks.sql
```

**Alternativa — supabase CLI** (verificar antes el proyecto linkeado con
`supabase projects list`):

```bash
supabase db execute --file db/prepared/grounding_0001_evidence_chunks.sql
```

**Último recurso — SQL Editor de Supabase** (staging, rol admin): pegar y
ejecutar el script completo. Solo si las vías anteriores no están disponibles:
el editor no garantiza por contrato la ejecución transaccional del script
entero, y un fallo entre el `CREATE TABLE` y el `ENABLE ROW LEVEL SECURITY`
dejaría `evidence_chunks` **sin RLS** — un estado parcial con impacto de
seguridad. Si se usa esta vía, ejecutar inmediatamente la verificación 3.

Después: ejecutar las verificaciones de abajo.

## Verificaciones post-aplicación

```sql
-- 1. La extensión existe (o fue omitida a propósito en la variante léxica)
SELECT extname FROM pg_extension WHERE extname = 'vector';

-- 2. La tabla existe con las columnas esperadas
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'evidence_chunks'
ORDER BY ordinal_position;

-- 3. RLS activo y con exactamente UNA política (solo SELECT)
SELECT relrowsecurity FROM pg_class WHERE relname = 'evidence_chunks'; -- t
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'evidence_chunks';
-- esperado: evidence_chunks_select | SELECT — y ninguna otra

-- 4. Índices y constraint de unicidad
SELECT indexname FROM pg_indexes WHERE tablename = 'evidence_chunks';
-- esperado: pkey, evidence_chunks_evidence_chunk_unique,
--           idx_evidence_chunks_organization_id, idx_evidence_chunks_evidence_id

-- 5. Append-consistency desde el rol authenticated (deben FALLAR las 3):
--    (ejecutar como usuario de prueba autenticado, no como service role)
-- INSERT INTO evidence_chunks (...) VALUES (...);   -- RLS: denegado
-- UPDATE evidence_chunks SET content = 'x';         -- RLS: denegado
-- DELETE FROM evidence_chunks;                      -- RLS: denegado

-- 6. Cascade: borrar una evidencia de prueba elimina sus chunks
--    (con datos sintéticos de staging, nunca reales)
```

Criterio de aprobación binario: **todas** las verificaciones 1–5 dan el
resultado esperado y la suite RLS de integración (`pnpm test:rls`, apuntando a
staging, autorizado por Lorenzo) pasa sin regresiones.

## Criterios de aborto (propios de este addendum)

Complementan —no reemplazan— los criterios A1–A8 de `G2_PACKAGE.md`.

| # | Causa de aborto | Cómo se detecta | Qué hacer |
|---|---|---|---|
| GA1 | **Decisión G5 P3 ausente** | No hay registro en `G5_PACKAGE.md` / `STELLA_FABLE_DECISIONS.md` | Detener. Este script no se ejecuta antes de G5. `stella_0002`/`0003` no se ven afectados |
| GA2 | **pgvector no disponible y no se eligió la variante léxica** | El script aborta: `pgvector is neither installed nor available on this instance` | Detener. Confirmar disponibilidad en el Dashboard o aplicar la variante sin `embedding` |
| GA2b | **pgvector instalado en un esquema fuera del `search_path`** | El script aborta: `pgvector is installed in schema "X" but the type "vector" is not resolvable`. En Supabase hosted lo normal es `extensions`, ya contemplado por el `SET search_path = public, extensions` del script | Añadir ese esquema al `SET search_path` del encabezado del script y re-ejecutar. Verificar antes con:<br>`SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector';` |
| GA3 | **Host equivocado** | Verificar destino antes de ejecutar | Detener. No ejecutar nada |
| GA4 | **`evidence_chunks` preexistente con forma incompatible** | El script aborta listando columnas discrepantes | Detener. No forzar; investigar el origen de esa tabla |
| GA5 | **Tabla creada sin RLS (estado parcial)** | Verificación 3 devuelve `f`, o `pg_policies` devuelve 0 filas | Detener. Re-ejecutar el script completo con `psql -1` (es convergente) y re-verificar. Si persiste, rollback |
| GA6 | **Fallo de cualquier verificación 1–5** | Sección anterior | Detener y evaluar rollback |

Como `evidence_chunks` contiene **solo datos derivados y regenerables**, el
rollback aquí es barato: no pierde fuente de verdad. Ante la duda, revertir.

## Rollback

1. Ejecutar `db/prepared/grounding_0001_rollback.sql`, preferentemente con
   `psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f ...`.
2. Verificar:

```sql
SELECT to_regclass('public.evidence_chunks'); -- NULL
SELECT policyname FROM pg_policies WHERE tablename = 'evidence_chunks'; -- 0 filas
```

3. La extensión `vector` NO se revierte en este paso (capacidad compartida de
   la instancia); si se quisiera, es una decisión separada con verificación de
   dependencias previa (ver comentario en el rollback SQL).

## Producción

Solo después de: staging verde + decisión explícita go/no-go de Lorenzo,
siguiendo la secuencia de aprobación de `SUPABASE_MIGRATION_GATE.md` (backup,
orden de aplicación revisado, verificaciones repetidas). Este addendum no
autoriza tocar producción.
