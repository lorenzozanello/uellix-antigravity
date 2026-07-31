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

## Aplicación (staging)

1. Abrir el SQL Editor de Supabase (staging) con rol admin.
2. Pegar y ejecutar `db/prepared/grounding_0001_evidence_chunks.sql` completo.
3. Ejecutar las verificaciones de abajo.

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

## Rollback

1. Ejecutar `db/prepared/grounding_0001_rollback.sql` en el SQL Editor.
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
