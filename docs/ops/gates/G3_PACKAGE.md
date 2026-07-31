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

## Criterio de aprobación (binario)

- [ ] `pnpm test:rls` verde contra el stack local con los skips **activados**
      (estado pre-G2) — línea base.
- [ ] G2 aplicado en staging (checklist `G2_PACKAGE.md` completo).
- [ ] Skips flipeados y `pnpm test:rls` verde contra staging — incluye los
      casos de trigger service-role y la tabla de decisiones.
- [ ] Resultado (fecha, entorno, hash del commit) registrado por Lorenzo en
      `docs/ops/STELLA_FABLE_STATUS.md`.
