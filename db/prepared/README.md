# db/prepared — SQL preparado (NUNCA auto-aplicado)

Este directorio contiene SQL **preparado pero NO aplicado**. Está fuera de
`db/migrations/` a propósito: drizzle-kit aplicaría cualquier archivo que
viviera allí, y la aplicación de estos scripts es un **gate externo (G2)** que
requiere acción humana explícita.

## Reglas

1. **Nada de este directorio se ejecuta automáticamente.** Ni drizzle, ni CI,
   ni un agente. La aplicación es siempre manual, por Lorenzo, contra staging
   primero, siguiendo el checklist del gate.
2. Antes de aplicar cualquier script de grounding: **confirmar la
   disponibilidad de pgvector** en el proyecto Supabase hosted
   (Dashboard → Database → Extensions → `vector`), según el proceso de
   `docs/ops/SUPABASE_MIGRATION_GATE.md`. Si pgvector no está disponible y G5
   eligió el fallback léxico, aplicar la variante sin columna `embedding`
   (quitar `CREATE EXTENSION ...;` y la línea `embedding vector(384),`).
3. Cada script tiene su rollback preparado en el mismo directorio.
4. Validación offline: `lib/grounding/__tests__/prepared-sql.test.ts` hace un
   lint estructural (paréntesis balanceados, sentencias terminadas, keywords
   esperadas/prohibidas). **No es un parse de Postgres** — la validación real
   contra una base es parte del checklist G2.

## Inventario

| Script | Rollback | Gate | Estado |
|--------|----------|------|--------|
| `grounding_0001_evidence_chunks.sql` | `grounding_0001_rollback.sql` | G2 (checklist: `docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`) + decisión G5 P3 para embeddings | PREPARADO |
