# Local Staging — G2/G3 Rehearsal (worktree `codex/stella-g2-local-rehearsal`)

> Ensayo local, completamente offline y aislado, de los gates G2 y G3 antes de
> tocar el único proyecto Supabase remoto de Uellix (que soporta despliegue y
> pilotos — se trata como producción). No sustituye la ejecución real de G2/G3
> documentada en `docs/ops/gates/G2_PACKAGE.md` y `G3_PACKAGE.md`; solo prueba
> que los seis scripts de `db/prepared/` y las verificaciones post-apply
> funcionan como se espera, con datos 100% sintéticos, en un stack Docker
> desechable.
>
> Este worktree existe **exclusivamente** para este ensayo. Vive en
> `C:\Users\Lorenzo\Documents\uellix-stella-g2-local-rehearsal`, rama
> `codex/stella-g2-local-rehearsal`, creado desde el commit
> `91cc4ffbe0af211edc559d19f2cc3d7b0d8ced68` de
> `codex/stella-fable-moonshot`. El worktree fuente no fue tocado.

## Por qué existe un worktree separado

Este host ya corre **dos pilas Supabase locales simultáneas**: `aforiq`
(puertos 5432x, ajena a Uellix) y `uellix-antigravity` (puertos 5532x, de otro
worktree de este mismo repo). `supabase/config.toml` se hereda tal cual entre
worktrees al crear uno nuevo desde un commit — **mismo `project_id`, mismos
puertos** — así que sin aislamiento explícito, iniciar el stack aquí se
habría adjuntado a los contenedores/volumen ya vivos de `uellix-antigravity`
en lugar de crear uno nuevo, contaminando datos de otro worktree.

## Aislamiento aplicado (solo en este worktree)

| Archivo | Cambio | Motivo |
|---|---|---|
| `supabase/config.toml` | `project_id` → `uellix-stella-g2-local-rehearsal`; bloque de puertos 5532x → 5632x | Nombre de contenedor/volumen único; puertos verificados libres |
| `drizzle.local.config.ts` | `LOCAL_DB_URL` 55322 → 56322 | Sin este cambio, `pnpm db:migrate:local` migraría contra la base de `uellix-antigravity` |
| `scripts/seed-local.ts` | `dbUrl` 55322 → 56322 | Sin este cambio, `pnpm db:seed:local` escribiría usuarios sintéticos en la base de `uellix-antigravity` |
| `tests/integration/rls.test.ts` | fallback de `SUPABASE_URL` 55321 → 56321 | Solo cambia el comportamiento si `NEXT_PUBLIC_SUPABASE_URL` no está seteada en `.env.local` — de todos modos debe setearse explícitamente |

**Ninguno de estos cuatro cambios existe en el worktree fuente
(`uellix-stella-fable-moonshot`)** ni en ningún otro worktree — son locales a
esta copia de trabajo.

## Mapa de puertos

| Servicio | Puerto viejo (`uellix-antigravity`, NO usar aquí) | Puerto nuevo (este worktree) | Offset relativo (preservado) |
|---|---|---|---|
| `db.shadow_port` | 55320 | **56320** | +0 |
| `api.port` (Kong) | 55321 | **56321** | +1 |
| `db.port` (Postgres) | 55322 | **56322** | +2 |
| `studio.port` | 55323 | **56323** | +3 |
| `local_smtp.port` (Inbucket) | 55324 | **56324** | +4 |
| `analytics.port` | 55327 | **56327** | +7 |
| `db.pooler.port` | 55329 | **56329** | +9 |
| `edge_runtime.inspector_port` | 55383 | **56383** | (independiente) |

Verificado contra `docker ps` en el momento de la preparación: los únicos
puertos externos publicados en este host eran `54321–54324` (`aforiq`) y
`55321,55322,55324,55327` (`uellix-antigravity`, parcialmente arrancado).
El bloque `56320–56329` + `56383` no tenía ninguna coincidencia.

## Precondición manual — `.env.local`

Los valores de `anon key` / `service_role key` de un stack Supabase local son
generados por la CLI **al arrancar** (no existen antes de `supabase start`, y
no están en `config.toml`). Antes de correr `pnpm db:seed:local` o
`pnpm test:rls` en este worktree, crear `.env.local` (no rastreado) con:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:56321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<impreso por `pnpm supabase status` tras el arranque>
SUPABASE_SERVICE_ROLE_KEY=<impreso por `pnpm supabase status` tras el arranque>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:56322/postgres
```

`db/client.ts` (compartido con el resto de la app) lee `DATABASE_URL`
directamente del entorno, sin guarda de host — por eso es obligatorio que
`.env.local` de este worktree apunte siempre a `56322`, nunca a un valor
heredado de otro worktree.

## Ciclo completo, en orden

### 1. `supabase/migrations/` (automático)
Aplicado por la propia CLI al iniciar el stack sobre un volumen nuevo:
trigger `auth.users → public.users`, políticas de Storage. 2 archivos.

**No se ejecuta ningún comando para este paso.** Los 2 archivos ya fueron
aplicados por `pnpm supabase start` antes de que empezara el ciclo manual, y
**no deben reaplicarse** durante la construcción de la base. Estado verificado
en la base local (solo `SELECT`, sin reaplicar):

| Objeto | Origen | Estado |
|---|---|---|
| `auth.users` → trigger `on_auth_user_created` | `20260716000000_auth_trigger.sql` | presente |
| `auth.users` → trigger `on_auth_user_updated` | `20260716000000_auth_trigger.sql` | presente |
| `public.handle_new_user()` | `20260716000000_auth_trigger.sql` | presente |
| `storage.objects` → 3 policies (`select/insert/delete_evidence`) | `20260716000001_storage_policies.sql` | presentes |

### 2. `db/migrations/` (Drizzle — AUTO_APPLY_LOCAL)
```bash
pnpm db:migrate:local
```
Aplica los 40 archivos (`0000`…`0039`) contra `127.0.0.1:56322`.

### 3. `db/manual-migrations/` (MANUAL_REQUIRED_LOCAL)
Cada script trae su propio `PRECHECK` — correr y confirmar 0 filas antes de
aplicar:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -f db/manual-migrations/001_unique_constraints.sql
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -f db/manual-migrations/002_append_only.sql
```

**`003_numeric_columns.sql` es CONDICIONAL — no se aplica en una base fresca.**
Sobre una base reconstruida desde cero por el paso 2, la migración `0016` ya
dejó esas columnas en `numeric`, y el `PRECHECK` de 003 ni siquiera compila.
Ver *MANUAL MIGRATION 003 DECISION* más abajo antes de ejecutarlo.

### 4. `db/policies/` (MANUAL_REQUIRED_LOCAL)
En orden, los 8 archivos — `002_stella_interactions_rls.sql` es precondición
binaria explícita de G2:
```bash
for f in db/policies/00{1..8}_*.sql; do
  psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -f "$f"
done
```

### 5. Seed base
```bash
pnpm db:seed:local
```
2 organizaciones, 8 usuarios sintéticos con guarda de host activa.

### 6. Seed Stella (nuevo, este worktree)
```bash
pnpm db:seed:stella-local
```
1 proyecto + 1 interacción Stella sintéticos, deterministas, reconciliables
(`ON CONFLICT ... DO UPDATE`). Falla en seco si el paso 5 no corrió antes.
**`db:seed:proxies` y `db:seed:taxonomies` no se ejecutan en este ciclo** —
no tienen guarda de host y no son precondición de `stella_interactions`.

### 7. Baseline
```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```
Debe reproducir el mismo resultado que en `codex/stella-fable-moonshot`
(2313/2313, 0 errores de lint).

### 8. G2 — `stella_0002`
```bash
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002_interactions_hardening.sql
```
Verificaciones 1–4 de `docs/ops/gates/G2_PACKAGE.md` (trigger adjunto, grants
reducidos con `table_schema='public'` y todos los grantees, `CHECK` con los 6
roles vía `pg_get_constraintdef`, `UPDATE`/`DELETE` debe fallar sobre la fila
sintética).

### 9. G2 — `stella_0003`
```bash
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0003_suggestion_decisions.sql
```
Verificaciones 5–7 (RLS con una sola política, grants `SELECT`-only sin filas
para `anon`/`PUBLIC`, ambos `CHECK` por definición completa).

**`grounding_0001` queda excluido de todo este ciclo — bloqueado por G5 P3,
sin excepción.**

### 10. G3
```bash
# En este worktree únicamente: flip temporal de los 2 describe.skip en
# tests/integration/rls.test.ts (post-G2), en un commit LOCAL de este
# worktree — nunca en codex/stella-fable-moonshot.
pnpm test:rls
# Revertir el flip antes de cerrar el ensayo.
```

### 11. Rollback
```bash
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0003_rollback.sql
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002_rollback.sql
```
Verificar: trigger → 0 filas; `to_regclass('public.stella_suggestion_decisions')` → `NULL`.

### 12. Reconstrucción y segunda corrida
```bash
pnpm supabase stop --no-backup   # destruye SOLO el volumen de este worktree (project_id único)
pnpm supabase start
```
Repetir los pasos 2–11 íntegros. Si la segunda corrida diverge de la primera
en cualquier verificación, el ensayo se considera inválido — el ciclo es
desechable y reconstruible en minutos, por diseño.

## MANUAL MIGRATION 003 DECISION

**Clasificación: `CONDITIONAL_LEGACY_ONLY`.**
**Decisión para esta base: `ALREADY_SATISFIED_ON_FRESH_DRIZZLE_BUILD`.**
**El bloque `APPLY` de 003 no se ejecutó** — ni total ni parcialmente.

### Error observado

Al correr el `PRECHECK` de `db/manual-migrations/003_numeric_columns.sql`
(consulta de solo lectura, sin tocar datos) contra la base local recién
migrada:

```
ERROR:  operator does not exist: numeric !~ unknown
LINE 3:   FROM project_investments WHERE amount !~ '^-?[0-9]+(\.[0-9...
HINT:  No operator matches the given name and argument types.
```

### Causa

El `PRECHECK` busca valores no convertibles con el operador regex `!~`, que en
PostgreSQL **solo está definido para tipos text-like**. Que no compile no es un
fallo de la base: es la prueba de que las columnas ya **no** son `varchar`.

El historial del repositorio lo explica por completo:

1. `0007` / `0009` / `0010` crean esas columnas como `varchar(255)`, con CHECKs
   escritos en forma textual — p. ej.
   `CHECK (cast(nullif(quantity,'') as numeric) > 0)`.
2. `db/manual-migrations/003_numeric_columns.sql` convierte a `numeric` fuera
   de banda. Drizzle nunca lo capturó en un snapshot.
3. `db/migrations/0016_fat_mac_gargan.sql` — *"snapshot reconciliation: fold
   the manual numeric-columns migration into the drizzle-kit chain"* — pliega
   003 dentro de la cadena, **añadiendo cláusulas `USING` explícitas** para que
   una base limpia pueda hacer el cast. Su propia cabecera lo declara: *"A
   fresh environment applying 0000..0015 through drizzle (which never converts
   to numeric) reaches the numeric state here instead of needing 003
   separately."*

`docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md` §3 lo registra como precedente:
0016 *"ya resolvió exactamente este problema para
`db/manual-migrations/003_numeric_columns.sql`"*.

### Matriz de columnas y comparación triple

- **A** = estado objetivo declarado por `003_numeric_columns.sql`
- **B** = estado declarado por `db/schema.ts` + `meta/0016_snapshot.json`
- **C** = estado real en `supabase_db_uellix-stella-g2-local-rehearsal`

| # | Tabla | Columna | A (003) | B (schema/snapshot) | C (PostgreSQL real) | Nulabilidad (B = C) | Veredicto |
|---|---|---|---|---|---|---|---|
| 1 | `project_investments` | `amount` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | NOT NULL | `EXACT_MATCH` |
| 2 | `financial_proxies` | `value` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 3 | `sroi_assignment_inputs` | `quantity` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | NOT NULL | `EXACT_MATCH` |
| 4 | `sroi_calculation_runs` | `total_investment` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 5 | `sroi_calculation_runs` | `gross_social_value` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 6 | `sroi_calculation_runs` | `net_social_value` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 7 | `sroi_calculation_runs` | `sroi_ratio` | **`numeric(20,6)`** | **`numeric(20,6)`** | **`numeric(20,6)`** | nullable | `EXACT_MATCH` |
| 8 | `sroi_calculation_line_items` | `quantity` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 9 | `sroi_calculation_line_items` | `proxy_value` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 10 | `sroi_calculation_line_items` | `gross_value` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |
| 11 | `sroi_calculation_line_items` | `adjusted_value` | `numeric(20,4)` | `numeric(20,4)` | `numeric(20,4)` | nullable | `EXACT_MATCH` |

**11 `EXACT_MATCH` / 0 `COMPATIBLE_BUT_DIFFERENT` / 0 `MISMATCH` / 0 `UNKNOWN`.**
`sroi_ratio` es la única columna con escala 6 — verificada por separado, no
asumida igual al resto.

### Evidencia SQL (solo lectura)

`information_schema` y `pg_catalog` coinciden en las 11 columnas:

```
 financial_proxies           | value              | numeric(20,4) | nullable
 project_investments         | amount             | numeric(20,4) | NOT NULL
 sroi_assignment_inputs      | quantity           | numeric(20,4) | NOT NULL
 sroi_calculation_line_items | adjusted_value     | numeric(20,4) | nullable
 sroi_calculation_line_items | gross_value        | numeric(20,4) | nullable
 sroi_calculation_line_items | proxy_value        | numeric(20,4) | nullable
 sroi_calculation_line_items | quantity           | numeric(20,4) | nullable
 sroi_calculation_runs       | gross_social_value | numeric(20,4) | nullable
 sroi_calculation_runs       | net_social_value   | numeric(20,4) | nullable
 sroi_calculation_runs       | sroi_ratio         | numeric(20,6) | nullable
 sroi_calculation_runs       | total_investment   | numeric(20,4) | nullable
```

Cero columnas objetivo con tipo `varchar` / `text` / `char` / `json` / `jsonb`
(consulta explícita → 0 filas). Ningún sustituto numérico en otra columna.

Los CHECK re-añadidos están en **forma nativa numérica**, no en la forma
textual de la era `varchar` — la huella que solo deja 0016:

```
 project_investments_amount_check      | CHECK ((amount > (0)::numeric))
 sroi_assignment_inputs_quantity_check | CHECK ((quantity > (0)::numeric))
```

### Qué obligaría a ejecutar 003 en otra base

003 **no está deprecada** y no debe borrarse. Sigue siendo obligatoria cuando:

- la base es **legacy** y sus columnas objetivo aún son `varchar`/`text` —
  típicamente un restore de un dump anterior a 0016 (jul-2026);
- la base aplicó `0000`…`0015` pero **no** `0016` (journal sin
  `0016_fat_mac_gargan`);
- el `PRECHECK` **sí compila** — si `!~` es aceptado, las columnas son
  text-like y la conversión está pendiente.

Regla operativa: **si el `PRECHECK` de 003 falla con
`operator does not exist: numeric !~`, la migración ya está satisfecha y no
debe ejecutarse. Si el `PRECHECK` corre, debe ejecutarse.**

No se omitió en silencio ni se evadió el `PRECHECK`: se clasificó con
evidencia y quedó fijada por `tests/manual-migration-003-classification.test.ts`.

## Comandos de gestión del stack

```bash
pnpm supabase start     # crear/arrancar el stack de este worktree
pnpm supabase status    # health check + imprime anon/service_role keys locales
pnpm supabase stop      # detener, conservando el volumen
pnpm supabase stop --no-backup   # detener y destruir el volumen (reset limpio)
pnpm supabase logs      # logs del stack completo
```

**Ninguno de estos comandos afecta `uellix-antigravity` ni `aforiq`** — cada
uno opera exclusivamente sobre los contenedores cuyo nombre deriva del
`project_id` del `config.toml` presente en el directorio de trabajo actual.

## Qué NO hace este documento

- No aplica nada contra el proyecto Supabase remoto.
- No usa `supabase login`, `link`, `db push` ni `db pull`.
- No declara `PRODUCTION_READY` ni `STELLA_OFFLINE_RELEASE_CANDIDATE_READY` —
  este ensayo es evidencia de que los scripts *funcionan estructuralmente* en
  un Postgres real, no una aprobación de ningún gate.
- No prepara ni ejecuta `grounding_0001` — permanece bloqueado por G5 P3.
