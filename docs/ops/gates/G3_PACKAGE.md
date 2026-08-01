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

### Advertencia — la suite NO limpia todas sus filas

Corregido 2026-08-01 tras el ensayo local: la redacción anterior sugería que
`afterAll` recogía el estado de prueba. **No lo hace, y no puede hacerlo.**

Los bloques post-G2 escriben en dos tablas **append-only**
(`stella_interactions` y `stella_suggestion_decisions`). Sus triggers
`*_append_only` / `*_no_truncate` rechazan `UPDATE`, `DELETE` y `TRUNCATE`
para **todos** los roles, incluido el dueño de la tabla — así que esas filas no
se pueden retirar una por una. Como además sus FK son `ON DELETE NO ACTION`, la
organización, el proyecto y el usuario que referencian quedan **fijados por
transitividad** y tampoco pueden borrarse.

Consecuencia operativa: **cada corrida completa de G3 deja una clausura
persistente** (1 decisión + 1 interacción + org + proyecto + usuario). Lo que
`afterAll` sí limpia, propagando errores en vez de silenciarlos, son los
fixtures sin dependencia append-only: usuarios desechables (auth + `public.users`
+ membresías), la organización B, los proyectos creados dentro de la suite y el
objeto de Storage.

La limpieza autorizada del residuo es el **reset/rebuild del stack**, no un
`DELETE` fila por fila. Por eso:

- **Local desechable:** admisible. La suite es idempotente (ver abajo): la
  segunda corrida y las siguientes **reutilizan** la clausura existente y no
  añaden ni una fila append-only.
- **Staging remoto:** **NO autorizado**. Requiere una estrategia distinta y no
  contaminante (base efímera dedicada, o un G3 de solo lectura sobre filas ya
  existentes). Pendiente de diseño.
- **Producción:** jamás.

## Qué prueba cada bloque (tests/integration/rls.test.ts)

| Bloque | Qué demuestra |
|--------|---------------|
| `Tablas Globales (organizations)` | Aislamiento org-scoped del SELECT + visión global de super_admin |
| `Proyectos (CRUD Cruzado)` | INSERT cruzado y por rol insuficiente → `42501` |
| `Storage` | Políticas de bucket org/proyecto (lectura, escritura, path inválido, delete de viewer) |
| `Stella Interactions (append-only)` | SELECT propio (incluye viewer: leer ≠ invocar), SELECT cruzado vacío, super_admin ve todo, INSERT de `authenticated` → `42501` (solo service role escribe), UPDATE/DELETE de `authenticated` denegados |
| `Stella Interactions → post-G2 (stella_0002)` | El trigger `uellix_forbid_mutation()` bloquea UPDATE/DELETE **incluso para el owner / service role**, y la fila queda verificada intacta |
| `Stella Suggestion Decisions (post-G2 stella_0003)` | SELECT org-scoped (con clave y decisión exactas), SELECT cruzado vacío, INSERT/UPDATE/DELETE de `authenticated` → `42501` (grant SELECT-only), super_admin lee pero no muta, usuario sin membresía ni lee ni inserta, `service_role` **ni lee ni inserta** (BYPASSRLS no sustituye a la ACL) y `TRUNCATE` rechazado por el trigger `BEFORE TRUNCATE` |

Detalle importante de los casos UPDATE/DELETE de `stella_interactions`: las
aserciones aceptan los **dos** estados válidos —

- **pre-G2**: sin política RLS, PostgREST reporta éxito con 0 filas (sin
  error) y el test verifica vía service client que la fila quedó intacta;
- **post-G2**: el grant revocado por `stella_0002` convierte el intento en un
  `42501` duro.

Así la suite es verde antes y después del gate G2, sin falsos rojos.

## Skip-gates (estado: flipeados en el ensayo local, 2026-08-01)

Los dos bloques post-G2 de `tests/integration/rls.test.ts` están **habilitados**
en esta rama porque `stella_0002`, `stella_0002b` y `stella_0003` ya están
aplicados en el stack local. Contra cualquier entorno que **no** los tenga hay
que devolverles el `.skip`:

1. `post-G2 (stella_0002): trigger blocks mutation even for service role`
   — requiere `db/prepared/stella_0002_interactions_hardening.sql`. Correrlo
   antes **mutaría de verdad** el audit trail (el service role bypassa RLS y sin
   trigger el UPDATE procede).
2. `Stella Suggestion Decisions (post-G2 stella_0003)`
   — requiere `db/prepared/stella_0003_suggestion_decisions.sql`; antes de ese
   gate la relación no existe y el bloque falla por tabla inexistente.

## Desenvoltura del error de PostgreSQL (obligatoria)

Las aserciones sobre triggers **no pueden apoyarse en `error.message`**.
`db.execute()` de drizzle-orm 0.45.2 lanza un `DrizzleQueryError` cuyo `.message`
es literalmente `"Failed query: <sql>\nparams: "`; el `PostgresError` real de
postgres-js 3.4.9 —con `code`, `severity` y el mensaje del trigger— queda en
`.cause`. Un `expect(...).rejects.toThrow(/append-only/)` compara sólo contra
`.message` y produce un **rojo falso** aunque la base sí haya bloqueado la
mutación (fue exactamente lo que ocurrió en la primera corrida local).

Usar siempre `tests/helpers/append-only-error.ts`, que recorre la cadena `cause`
con límite de profundidad y detección de ciclos, y exige de forma **conjunta**
SQLSTATE `42501`, el texto `append-only`, la operación y la tabla. No acepta
cualquier `42501`: un `permission denied for table …` (mismo SQLSTATE, otra
causa) se rechaza. Cubierto por `tests/append-only-error.test.ts` (13 casos,
incluidos causa ausente, SQLSTATE erróneo, mensaje erróneo, causa anidada y
ciclo de causas).

## Idempotencia del residuo append-only

La suite reconoce la clave determinista
`g3-local-rehearsal.synthetic.advisor.suggested_next_actions[0]` antes de
escribir nada:

- **REUSED** — existe exactamente una decisión con esa clave: se reutiliza y se
  **derivan de ella** la organización, el proyecto y la interacción sintética.
  No se inserta ninguna fila append-only. Todos los usuarios de la corrida pasan
  a ser desechables.
- **CREATED** — no existe: se crea exactamente una, como en la primera corrida,
  y se preserva el usuario que queda como `created_by` / `decided_by`.
- **>1** — la suite **aborta** con error explícito; no se elige una fila
  arbitrariamente.

Nunca se usa `ON CONFLICT` sin constraint, `UPDATE`, `DELETE`, `TRUNCATE`,
desactivación de triggers, `session_replication_role` ni `DROP TABLE`.

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

G3 es de **solo lectura estructural** sobre el esquema: no aplica cambios de
DDL, solo ejecuta la suite contra RLS/grants ya aplicados por G2. Pero **sí
escribe estado permanente** (ver la advertencia de arriba), así que el rollback
de G3 **no es una limpieza fila por fila** — esa limpieza es imposible por
diseño. En caso de fallo:

1. Revertir los `.skip` flipeados (volver a `describe.skip(...)`) si el
   fallo ocurrió tras flipearlos, para no dejar la suite roja en el repo.
2. **No intentar borrar la clausura append-only.** Un `DELETE`/`TRUNCATE`
   fallará con `42501`, y borrar la org/proyecto/usuario referenciados fallará
   por FK `NO ACTION`. La limpieza autorizada es el **reset/rebuild del stack
   local desechable**; en remoto, no hay limpieza y por eso G3 remoto no está
   autorizado.
3. Si el fallo reveló una política/grant real incorrecta, el rollback de
   **ese** hallazgo se ejecuta vía el rollback de G2 (`stella_0002_rollback.sql`
   / `stella_0003_rollback.sql`), no vía G3.
4. Si el fallo es de **instrumentación** (la base bloqueó, el test no supo
   leerlo), no se toca la base: se corrige la aserción. Ver la sección de
   desenvoltura de errores.

## Criterio de aprobación (binario)

- [x] `pnpm test:rls` verde contra el stack local con los skips **activados**
      (estado pre-G2) — línea base.
- [x] `stella_0002` + `0002b` + `0003` aplicados en el stack **local**.
- [x] Skips flipeados y `pnpm test:rls` verde contra el stack **local** —
      32/32, incluye los casos de trigger owner/service-role y la tabla de
      decisiones. Ver "G3 LOCAL REHEARSAL — RUN 1" más abajo.
- [ ] G2 aplicado en staging (checklist `G2_PACKAGE.md` completo).
- [ ] **Estrategia no contaminante de G3 remoto diseñada y autorizada** — no
      basta con reejecutar esta suite: dejaría residuo append-only irreversible
      en staging.
- [ ] `pnpm test:rls` verde contra staging bajo esa estrategia.
- [ ] Resultado (fecha, entorno, hash del commit) registrado por Lorenzo en
      `docs/ops/STELLA_FABLE_STATUS.md`.

## G3 LOCAL REHEARSAL — RUN 1, CORRECTED INSTRUMENTATION

**2026-08-01 · worktree `codex/stella-g2-local-rehearsal` · stack local
`uellix-stella-g2-local-rehearsal` (PostgreSQL 17.6, API `127.0.0.1:56321`,
DB `127.0.0.1:56322`) · cero acceso remoto.**

| Fase | Resultado |
|------|-----------|
| 1ª ejecución (instrumentación original) | **23/25** — 2 rojos falsos |
| Causa | `DrizzleQueryError.message` = `"Failed query: …"`; el `PostgresError` con `code='42501'` y `append-only: UPDATE on stella_interactions is not permitted` estaba en `.cause`. La base **sí** bloqueó; la fila quedó intacta |
| Corrección | `tests/helpers/append-only-error.ts` + 13 pruebas unitarias; aserción **fortalecida** (SQLSTATE + texto + operación + tabla, y verificación de que la fila no cambió) |
| Ejecución focalizada | `-t "via service role falla con insufficient_privilege"` → **2 passed / 30 skipped**, sin ejecutar el bloque que crea la decisión y sin crecimiento del residuo |
| 2ª ejecución completa | `pnpm test:rls` → **32/32 passed, 0 failed, 0 skipped**, 11,79 s |
| Fixture append-only | **REUSED** — la decisión de la 1ª corrida se reutilizó; org, proyecto e interacción derivados de ella |
| Residuo antes / después | decisiones **1 → 1**; interacciones **2 → 2**; organizaciones 3 → 3; usuarios 9 → 9; proyectos 2 → 2; `storage.objects` 0 → 0 |
| Postcheck | RLS activo en ambas tablas; 104 policies; 10 triggers append-only; ACL = `authenticated: SELECT` + owner; `session_replication_role = origin`; `evidence_chunks` ausente; 0 decisiones no sintéticas; 0 interacciones manipuladas; 0 emails no sintéticos |
| Regresiones | `prepared-stella-sql` + `prepared-sql-source-of-truth` 188/188 · `test:unit` 135 archivos / **2495** tests · `typecheck` 0 errores · `lint` 0 errores (51 warnings preexistentes) |

**Aislamiento demostrado:** organización A lee su decisión con clave y decisión
exactas; organización B no la ve; usuario sin membresía ni la lee ni la inserta;
super_admin la lee pero no puede mutarla; `authenticated` no puede insertar;
`service_role` **ni lee ni inserta** (sin grant directo, pese a `BYPASSRLS`);
`UPDATE`, `DELETE` y `TRUNCATE` bloqueados con `42501` y mensaje `append-only`.

**Alcance.** Cero remoto. Cero `supabase login/link/db push/db pull`. Cero
rollback. Cero reset. Cero restauración del respaldo. Cero `grounding_0001`.
**Cero ejecución formal de G2.** Otros stacks (`uellix-antigravity`, `aforiq`)
intactos. Existe respaldo local pre-G3 (`pg_dump -Fc`, fuera del repo,
SHA-256 `d46280c4…b436aeb`, validado con `pg_restore -l`, **no restaurado**).

**Limpieza futura:** reset/rebuild del stack local. No hay otra.
