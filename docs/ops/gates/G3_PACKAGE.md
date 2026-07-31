# G3 — Verificación RLS (Stella Fable Moonshot)

> Gate externo G3 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`). Dueño humano:
> **Lorenzo**. Verifica con la suite de integración que la postura RLS/grants
> de las tablas Stella es la declarada — primero contra el stack **local**,
> después contra **staging**. Ningún agente ejecuta `test:rls`; requiere una
> base real y credenciales que solo maneja Lorenzo.

## Qué se corre

```bash
# 1. Stack local de Supabase (supabase start) con migraciones + policies al día
pnpm test:rls        # = vitest --config vitest.integration.config.ts tests/integration/rls.test.ts

# 2. Staging (autorizado por Lorenzo; exportar las env del proyecto de staging)
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
NEXT_PUBLIC_SUPABASE_ANON_KEY=... DATABASE_URL=... pnpm test:rls
```

Advertencia: la suite crea organizaciones, usuarios y filas de prueba (limpia
usuarios en `afterAll`, no todas las filas). Correr solo contra local/staging,
**jamás** contra producción.

## Qué prueba cada bloque (tests/integration/rls.test.ts)

| Bloque | Qué demuestra |
|--------|---------------|
| `Tablas Globales (organizations)` | Aislamiento org-scoped del SELECT + visión global de super_admin |
| `Proyectos (CRUD Cruzado)` | INSERT cruzado y por rol insuficiente → `42501` |
| `Storage` | Políticas de bucket org/proyecto (lectura, escritura, path inválido, delete de viewer) |
| `Stella Interactions (append-only)` | SELECT propio (incluye viewer: leer ≠ invocar), SELECT cruzado vacío, super_admin ve todo, INSERT de `authenticated` → `42501` (solo service role escribe), UPDATE/DELETE de `authenticated` denegados |
| `Stella Interactions → describe.skip post-G2 (stella_0002)` | El trigger `uellix_forbid_mutation()` bloquea UPDATE/DELETE **incluso para el service role** |
| `Stella Suggestion Decisions (describe.skip post-G2 stella_0003)` | SELECT org-scoped, SELECT cruzado vacío, INSERT/UPDATE/DELETE de `authenticated` → `42501` (grant SELECT-only) |

Detalle importante de los casos UPDATE/DELETE de `stella_interactions`: las
aserciones aceptan los **dos** estados válidos —

- **pre-G2**: sin política RLS, PostgREST reporta éxito con 0 filas (sin
  error) y el test verifica vía service client que la fila quedó intacta;
- **post-G2**: el grant revocado por `stella_0002` convierte el intento en un
  `42501` duro.

Así la suite es verde antes y después del gate G2, sin falsos rojos.

## Skip-gates a flipear (después de aplicar G2)

En `tests/integration/rls.test.ts`, en un commit propio y solo cuando el
entorno contra el que se corre ya recibió los scripts:

1. `describe.skip('post-G2 (stella_0002): trigger blocks mutation even for service role', ...)`
   → quitar el `.skip` después de aplicar
   `db/prepared/stella_0002_interactions_hardening.sql`. Correrlo antes
   **mutaría de verdad** el audit trail (el service role bypassa RLS y sin
   trigger el UPDATE procede).
2. `describe.skip('Stella Suggestion Decisions (post-G2 stella_0003)', ...)`
   → quitar el `.skip` después de aplicar
   `db/prepared/stella_0003_suggestion_decisions.sql` (antes, la relación no
   existe y el bloque falla por tabla inexistente).

## Criterios de aborto

Abortar la ejecución (no continuar, no flipear skips) si ocurre cualquiera de:

- `pnpm test:rls` falla contra el stack **local** con los skips en su estado
  pre-G2 — la línea base debe ser verde antes de tocar staging.
- El proyecto de staging usado no es el designado por Lorenzo (verificar
  `NEXT_PUBLIC_SUPABASE_URL` contra el proyecto correcto antes de exportar
  credenciales) — riesgo de correr contra el proyecto equivocado.
- Cualquier fallo deja filas de prueba sin limpiar más allá de lo que
  `afterAll` recoge, o toca una tabla fuera de las 6 listadas en "Qué prueba
  cada bloque".
- G2 no está aplicado en staging pero se intenta flipear los skips post-G2
  (el bloque fallaría por relación/columna inexistente — señal de secuencia
  incorrecta, no un hallazgo de RLS).

## Rollback

Este gate es de **solo lectura estructural**: no aplica cambios de esquema,
solo ejecuta la suite de tests contra RLS/grants ya aplicados por G2. No hay
rollback de datos que ejecutar — el "rollback" de G3 es, en caso de fallo:

1. Revertir los `.skip` flipeados (volver a `describe.skip(...)`) si el
   fallo ocurrió tras flipearlos, para no dejar la suite roja en el repo.
2. No se requiere ninguna acción sobre la base de staging: G3 no escribe
   estado permanente fuera de las filas de prueba que la propia suite limpia.
3. Si el fallo reveló una política/grant real incorrecta, el rollback de
   **ese** hallazgo se ejecuta vía el rollback de G2 (`stella_0002_rollback.sql`
   / `stella_0003_rollback.sql`), no vía G3.

## Criterio de aprobación (binario)

- [ ] `pnpm test:rls` verde contra el stack local con los skips **activados**
      (estado pre-G2) — línea base.
- [ ] G2 aplicado en staging (checklist `G2_PACKAGE.md` completo).
- [ ] Skips flipeados y `pnpm test:rls` verde contra staging — incluye los
      casos de trigger service-role y la tabla de decisiones.
- [ ] Resultado (fecha, entorno, hash del commit) registrado por Lorenzo en
      `docs/ops/STELLA_FABLE_STATUS.md`.
