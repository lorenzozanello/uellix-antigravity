# G2 — Paquete maestro de base de datos (Stella Fable Moonshot)

> Gate externo G2 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`). Dueño humano:
> **Lorenzo**. Nada de este paquete se aplica automáticamente: drizzle, CI y
> los agentes tienen prohibido tocarlo. Complementa — no sustituye —
> `docs/ops/SUPABASE_MIGRATION_GATE.md` y
> `docs/ops/SUPABASE_STAGING_MIGRATION_CHECKLIST.md`.

## Alcance

Aplicar (y saber revertir) contra **staging** — nunca producción directamente:

| Orden | Script | Rollback | Qué hace |
|-------|--------|----------|----------|
| 1 | `db/prepared/stella_0002_interactions_hardening.sql` | `db/prepared/stella_0002_rollback.sql` | Trigger append-only en `stella_interactions` + revoca `UPDATE/DELETE` de `authenticated` (bug de `0033:50`) + reconcilia el CHECK de `stella_role` al set de 6 roles |
| 2 | `db/prepared/stella_0003_suggestion_decisions.sql` | `db/prepared/stella_0003_rollback.sql` | Crea `stella_suggestion_decisions` (decisiones humanas sobre sugerencias) con RLS SELECT-only |
| 3 | `db/prepared/grounding_0001_evidence_chunks.sql` | `db/prepared/grounding_0001_rollback.sql` | Ver addendum dedicado: `docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md` (tiene precondiciones propias: pgvector + decisión G5 P3) |

El orden 1→2 importa solo débilmente (2 referencia `stella_interactions`, que
ya existe); el addendum de grounding (3) es independiente y puede aplicarse en
otra sesión.

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

Opción A — SQL Editor de Supabase (staging, rol admin): pegar y ejecutar cada
script completo, en orden.

Opción B — psql / supabase CLI:

```bash
# con el connection string de STAGING (¡verificar dos veces el host!)
# -1 = todo el script en UNA transacción: si algo falla no queda estado parcial
#      (rollback automático); como además los statements son idempotentes,
#      re-ejecutar el script tras corregir también recupera.
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002_interactions_hardening.sql
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0003_suggestion_decisions.sql

# o vía supabase CLI apuntando al proyecto de staging linkeado:
supabase db execute --file db/prepared/stella_0002_interactions_hardening.sql
supabase db execute --file db/prepared/stella_0003_suggestion_decisions.sql
```

## Verificaciones post-aplicación

```sql
-- 1. Trigger append-only adjunto a stella_interactions
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.stella_interactions'::regclass AND NOT tgisinternal;
-- esperado: trg_stella_interactions_append_only

-- 2. Grants de authenticated reducidos a SELECT, INSERT
SELECT privilege_type FROM information_schema.role_table_grants
WHERE table_name = 'stella_interactions' AND grantee = 'authenticated'
ORDER BY privilege_type;
-- esperado: INSERT, SELECT (sin UPDATE ni DELETE)

-- 3. CHECK de stella_role con los 6 roles
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.stella_interactions'::regclass
  AND conname = 'stella_interactions_stella_role_check';
-- esperado: incluye 'advisor','validator','composer','proxy_reviewer',
--           'evidence_reviewer','audit_assistant'

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

-- 6. Grants de la tabla nueva: authenticated solo SELECT
SELECT privilege_type FROM information_schema.role_table_grants
WHERE table_name = 'stella_suggestion_decisions' AND grantee = 'authenticated';
-- esperado: SELECT (una sola fila)

-- 7. CHECKs de la tabla nueva
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.stella_suggestion_decisions'::regclass AND contype = 'c';
-- esperado: stella_suggestion_decisions_decision_check,
--           stella_suggestion_decisions_prev_hash_check
```

Después de las verificaciones SQL: correr el paquete G3
(`docs/ops/gates/G3_PACKAGE.md`) — `pnpm test:rls` contra staging con los
`describe.skip` post-G2 activados.

Criterio de aprobación binario: **todas** las verificaciones 1–7 dan el
resultado esperado y G3 pasa sin regresiones.

## Post-aplicación (flags)

Solo después de staging verde:

- [ ] Flip de los `describe.skip` en `tests/integration/rls.test.ts`
      (ver G3_PACKAGE.md) en un commit propio.
- [ ] Recién entonces se puede considerar `STELLA_DECISIONS_PERSISTENCE_ENABLED=true`
      en Preview (decisión separada de Lorenzo, nunca parte de este gate).

## Rollback

1. Ejecutar en orden inverso:
   `db/prepared/stella_0003_rollback.sql` (¡exportar filas antes si hubo
   decisiones registradas! — ver comentario en el script), luego
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
