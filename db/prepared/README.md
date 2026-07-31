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
4. Validación offline: `lib/grounding/__tests__/prepared-sql.test.ts` (scripts
   `grounding_*`) y `tests/prepared-stella-sql.test.ts` (scripts `stella_*`)
   hacen un lint estructural (paréntesis balanceados, sentencias terminadas,
   keywords esperadas/prohibidas). **No es un parse de Postgres** — la
   validación real contra una base es parte del checklist G2.

## Inventario

| Script | Rollback | Gate | Estado |
|--------|----------|------|--------|
| `grounding_0001_evidence_chunks.sql` | `grounding_0001_rollback.sql` | G2 (checklist: `docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`) + decisión G5 P3 para embeddings | PREPARADO |
| `stella_0002_interactions_hardening.sql` | `stella_0002_rollback.sql` | G2 (checklist: `docs/ops/gates/G2_PACKAGE.md`) | PREPARADO |
| `stella_0003_suggestion_decisions.sql` | `stella_0003_rollback.sql` | G2 (checklist: `docs/ops/gates/G2_PACKAGE.md`); habilita `STELLA_DECISIONS_PERSISTENCE_ENABLED` recién después de aplicarlo | PREPARADO |

## Notas por script

- **`stella_0002_interactions_hardening.sql`**: adjunta el trigger append-only
  existente (`uellix_forbid_mutation()`, de `0030_immutability.sql`) a
  `stella_interactions`, revoca `UPDATE/DELETE` del rol `authenticated`
  (corrige el grant CRUD completo que dejó `0033_public_api_grants.sql:50`) y
  reconcilia idempotentemente el CHECK de `stella_role` al set de 6 roles de
  `db/schema.ts`. Su rollback restaura un estado **bug-compatible** (ver
  comentarios en el propio rollback).
- **`stella_0003_suggestion_decisions.sql`**: crea la tabla
  `stella_suggestion_decisions` (decisiones humanas sobre sugerencias de
  Stella) con RLS SELECT-only org-scoped. La server action que la consume
  (`app/actions/stella/decisions.ts`) queda **dormida** detrás de
  `STELLA_DECISIONS_PERSISTENCE_ENABLED` (default `false`) hasta que este
  script pase G2. Invariante de privacidad: `previous_value_hash` guarda un
  SHA-256, nunca el texto previo en crudo.
