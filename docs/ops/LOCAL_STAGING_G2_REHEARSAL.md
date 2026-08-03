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

### 8b. G2 — `stella_0002b` (endurecimiento append-only)
```bash
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002b_append_only_truncate_hardening.sql
```
Cierra el hueco de `TRUNCATE` en las **cuatro** tablas append-only (RK-04b).
**Exige que el paso 8 ya haya corrido**: su guarda verifica los cuatro triggers
de fila antes de tocar nada. Verificar: 4 triggers `*_no_truncate`
(`BEFORE TRUNCATE`, `FOR EACH STATEMENT`), `authenticated` y `service_role` sin
`TRUNCATE/REFERENCES/TRIGGER/MAINTAIN`, `service_role` además sin
`UPDATE/DELETE`, y `TRUNCATE` bloqueado como `authenticated`, como
`service_role` **y como `postgres`** — este último solo lo detiene el trigger.

### 9. G2 — `stella_0003`
**Declara el rol escritor antes de aplicar** (si no, el script cae a
`current_user` y lo anuncia como *asunción*, no verificación):
```bash
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 \
  -c "SET stella.writer_role='postgres'" -f db/prepared/stella_0003_suggestion_decisions.sql
```
Debe imprimir `write path VERIFIED against declared writer role postgres` y
`verification passed — …`. Si aparece `stella.writer_role is UNSET`, el ensayo
no verificó el camino de escritura: repetir declarándolo.

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
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002b_rollback.sql
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0003_rollback.sql
psql "postgresql://postgres:postgres@127.0.0.1:56322/postgres" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002_rollback.sql
```
Verificar: trigger → 0 filas; `to_regclass('public.stella_suggestion_decisions')` → `NULL`.

**`stella_0002b_rollback.sql` va primero y no revierte nada** — es
`SAFE_NON_REVERSING_ROLLBACK`: verifica que las protecciones siguen en pie y
sale distinto de 0 si detecta un hueco. Se corre **aquí y no al final** porque es
el único archivo del paquete con PL/pgSQL no trivial (agregados, `UNION ALL`,
`has_table_privilege`) y, de otro modo, el ciclo no lo ejecutaría nunca.

**Orden importa:** correr `stella_0002_rollback.sql` después de haber aplicado
0002b deja `stella_interactions` asimétrica — protegida contra `TRUNCATE` pero
otra vez abierta a `UPDATE/DELETE` — y hace que reaplicar 0002b **aborte** por su
guarda 0c. Es deliberado: la protección de 0002b no debe caer por el rollback de
otra unidad. Ver la cabecera de `stella_0002_rollback.sql`.

### 12. Reconstrucción y segunda corrida
```bash
pnpm supabase stop --no-backup   # destruye SOLO el volumen de este worktree (project_id único)
pnpm supabase start
```
Repetir los pasos 2–11 íntegros. Si la segunda corrida diverge de la primera
en cualquier verificación, el ensayo se considera inválido — el ciclo es
desechable y reconstruible en minutos, por diseño.

## BASE BUILD — RUN 1

Primera construcción reproducible de la base local. **Ningún gate ejecutado**:
no se corrió `stella_0002`, `stella_0003`, `grounding_0001` ni G3.

| Campo | Valor |
|---|---|
| Fecha | 2026-08-01, 10:48 (hora local) |
| Branch | `codex/stella-g2-local-rehearsal` |
| Commit de partida | `91cc4ff` |
| Commit de aislamiento | `ed9ab97` — *chore(local): isolate Supabase G2 rehearsal stack* |
| Commit de clasificación | `ad559d8` — *docs(local): classify numeric migration for fresh builds* |
| `project_id` | `uellix-stella-g2-local-rehearsal` |
| Contenedor DB | `supabase_db_uellix-stella-g2-local-rehearsal` (`127.0.0.1:56322`) |
| Acceso remoto | ninguno — sin `login`/`link`/`db push`/`db pull` |

### Cadena aplicada

| Paso | Resultado |
|---|---|
| `supabase/migrations/` (2) | Aplicadas por `supabase start`; **no reaplicadas**. Verificadas: 2 triggers en `auth.users`, `public.handle_new_user()`, 3 policies en `storage.objects` |
| `db/migrations/` (40) | 40/40 aplicadas por `pnpm db:migrate:local`, de `0000_quick_husk` a `0039_grant_rls_helper_execution`. `drizzle.__drizzle_migrations` = 40 filas. 0 errores |
| `001_unique_constraints.sql` | Aplicada. PRECHECKs → 0 filas. Índices `uq_active_outcome_proxy_assignment` y `uq_sroi_run_project_version` presentes (ya creados por la cadena Drizzle; `IF NOT EXISTS` los preservó) |
| `002_append_only.sql` | Aplicada. `public.uellix_forbid_mutation()` + 3 triggers (`audit_logs`, `sroi_calculation_runs`, `sroi_calculation_line_items`) |
| `003_numeric_columns.sql` | **No aplicada — `ALREADY_SATISFIED_ON_FRESH_DRIZZLE_BUILD`.** 11/11 columnas ya en el estado objetivo por `0016`. Ver *MANUAL MIGRATION 003 DECISION* |
| `db/policies/` (8) | 8/8 aplicadas en orden, cada una en su propia transacción (`-1 -v ON_ERROR_STOP=1`). 0 errores |

### Estado RLS

- **37 tablas** con RLS habilitado, **103 policies** en total.
- `002_stella_interactions_rls.sql` aplicada: `stella_interactions.relrowsecurity = true`,
  1 policy `SELECT` (`stella_interactions_select_member_or_admin`). INSERT/UPDATE/DELETE
  quedan denegados por ausencia de policy — *deny-by-default*, no por omisión.
- `authenticated` tiene `EXECUTE` sobre `public.current_user_org_ids()` y
  `public.current_user_is_super_admin()` (verificado con `has_function_privilege`).

### Seeds

| Entidad | Conteo |
|---|---|
| Organizaciones sintéticas | 2 (habilita las pruebas RLS cross-org) |
| Usuarios sintéticos | 8 (todos en el dominio `test.com`; 1 super admin) |
| Membresías sintéticas | 6 |
| Proyectos sintéticos | 1 |
| Interacciones Stella sintéticas | 1 |
| Organizaciones con cuota Stella > 0 | 1 |

Propiedades de la interacción sintética: `stella_role=advisor`,
`pipeline_step=narrative`, `model_used=seed-synthetic` (ninguna llamada real a
Gemini), `risk_level=low`, `tokens_used=0`, `context_hash` de 64 caracteres,
`response_json.requiresHumanReview = true`. **Cero datos reales.**

**Idempotencia:** `pnpm db:seed:stella-local` ejecutado dos veces. Los conteos
de organizaciones, usuarios, membresías, proyectos e interacciones y el
`context_hash` resultaron idénticos byte a byte entre ambas corridas.

### Preflight estructural pre-G2

Presentes: `public.organizations`, `public.projects`, `public.users`,
`public.evidence_items`, `public.stella_interactions`,
`public.uellix_forbid_mutation()`, `public.current_user_org_ids()`,
`public.current_user_is_super_admin()`, `gen_random_uuid()`.

Correctamente **ausentes** (los crea G2, aún no ejecutado):

| Objeto | Estado |
|---|---|
| `public.stella_suggestion_decisions` | no existe |
| `public.evidence_chunks` | no existe |
| `trg_stella_interactions_append_only` | no existe |

### Pruebas

| Comando | Resultado |
|---|---|
| `pnpm typecheck` | verde, 0 errores |
| `pnpm lint` | 0 errores, 51 warnings preexistentes |
| `pnpm test:unit` | **134 archivos, 2373/2373 verdes**, 0 fallos, 0 omitidos |

2373 = 2326 del baseline previo + 47 de
`tests/manual-migration-003-classification.test.ts`. `pnpm test:rls` **no** se
ejecutó: sus dos `describe.skip` dependen de objetos que crea G2.

### Aislamiento

`uellix-antigravity` y `aforiq` permanecieron en marcha e intactos durante toda
la corrida. Ningún comando de esta unidad tocó otro stack ni el Supabase
remoto. `.env.local` (no rastreado, `.gitignore: .env*`) apunta solo a
`127.0.0.1` en los puertos `56321`/`56322` de este worktree.

## STELLA 0002 LOCAL REHEARSAL — RUN 1

> **Esto NO es la aprobación formal de G2.** Es un ensayo estructural sobre un
> stack local y desechable: demuestra que el script corre en un PostgreSQL
> real, que es idempotente y que sus verificaciones son ejecutables. Una base
> local no es staging. El gate G2 sigue **sin ejecutar** y sin aprobar; su
> ejecución formal exige el entorno remoto autorizado y las precondiciones
> humanas de `docs/ops/gates/G2_PACKAGE.md` (ver allí la *Aclaración sobre A1*).

| Campo | Valor |
|---|---|
| Fecha | 2026-08-01, 11:26–11:29 (hora local) |
| Branch | `codex/stella-g2-local-rehearsal` |
| Commit al aplicar | `fdb4cb4` — *docs(local): clarify structural G2 rehearsal scope* |
| `project_id` | `uellix-stella-g2-local-rehearsal` |
| Contenedor DB | `supabase_db_uellix-stella-g2-local-rehearsal` |
| Script | `db/prepared/stella_0002_interactions_hardening.sql` (117 líneas, 6442 bytes) |
| SHA-256 | `11b792159435ee91fe00634e85a687a4c6b7aff9496f403db18740ba778c05e6` |

### Aplicación

Ambas corridas con `psql -v ON_ERROR_STOP=1 -1` (transacción única) contra el
contenedor local, transmitiendo **solo** ese archivo, sin SQL adicional y sin
modificar el script (hash idéntico en las dos).

| Corrida | Exit | Duración | Notices | Errores |
|---|---|---|---|---|
| 1ª (aplicación) | 0 | ~850 ms | 1 — `trigger … does not exist, skipping` (esperado: `DROP TRIGGER IF EXISTS` sobre trigger inexistente) | 0 |
| 2ª (idempotencia) | 0 | ~766 ms | 0 (el trigger ya existía) | 0 |

Statements en ambas: `SET`, `DO` (guardas), `DROP TRIGGER`, `CREATE TRIGGER`,
`REVOKE`, `DO` (CHECK), `COMMENT`.

### Verificaciones estructurales (12/12)

| # | Verificación | Resultado |
|---|---|---|
| 1 | Trigger `trg_stella_interactions_append_only` | existe **exactamente 1**; 1 solo trigger no interno en la tabla |
| 2 | Definición | `BEFORE DELETE OR UPDATE … FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation()`; **no** cubre INSERT |
| 3 | `authenticated` conserva | `SELECT`, `INSERT` |
| 4 | `authenticated` pierde | `UPDATE`, `DELETE` (ambos `false` por `has_table_privilege`) |
| 5 | Grants para `anon` / `PUBLIC` | 0 filas |
| 6 | CHECK de `stella_role` | los 6 roles, **exactamente 6 literales** |
| 7 | ¿CHECK modificado? | **No** — `md5` de `pg_get_constraintdef` idéntico antes y después. El `DO` block fue un no-op convergente |
| 8 | RLS | sigue activo |
| 9 | Policy base | presente y sin cambios (`md5` de `qual` idéntico) |
| 10 | `stella_suggestion_decisions` | sigue ausente |
| 11 | `evidence_chunks` | sigue ausente |
| 12 | Interacciones sintéticas | sigue siendo 1 |

Convergencia con el modelo declarado: tras la aplicación, `stella_interactions`
tiene para `authenticated` **el mismo conjunto de grants** que `audit_logs`,
`sroi_calculation_runs` y `sroi_calculation_line_items`
(`INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE`) — que es justo lo que el
script declara replicar.

### Prueba de inmutabilidad

Ejecutada dentro de `BEGIN … ROLLBACK`, sobre la única fila sintética, como
`postgres` (dueño de la tabla, que ignora RLS y grants) — la ruta más
privilegiada posible, que es donde el trigger tiene que sostener la garantía.

| Operación | Resultado | SQLSTATE | Mensaje |
|---|---|---|---|
| `UPDATE` | **bloqueada por el trigger** | `42501` | `append-only: UPDATE on stella_interactions is not permitted` |
| `DELETE` | **bloqueada por el trigger** | `42501` | `append-only: DELETE on stella_interactions is not permitted` |

La sonda distinguía tres desenlaces (bloqueo por el trigger esperado / error no
relacionado / mutación exitosa) y ambas cayeron en el primero. Transacción
revertida.

Post-prueba: la fila sintética sigue existiendo, el conteo sigue en 1,
`tokens_used` sigue en 0 (no en el 999 que intentó el `UPDATE`) y el
`context_hash` no cambió.

### Conteos antes / después

| Métrica | Pre-0002 | Post-1ª | Post-2ª |
|---|---|---|---|
| Trigger append-only | 0 | 1 | 1 |
| Interacciones sintéticas | 1 | 1 | 1 |
| Policies en la tabla | 1 | 1 | 1 |
| `authenticated` UPDATE/DELETE | sí | no | no |
| `md5` del CHECK | igual | igual | igual |
| `md5` de la policy | igual | igual | igual |
| `context_hash` | igual | igual | igual |

### Pruebas

`pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts`
→ **2 archivos, 79/79 verdes** (48 + 31). `pnpm typecheck` → 0 errores.
`test:rls` **no** se ejecutó.

### Alcance

Cero acceso remoto. Cero `stella_0003`. Cero `grounding_0001`. Cero G3. Cero
rollbacks. Cero seeds. Cero resets. Otros stacks (`uellix-antigravity`,
`aforiq`) intactos. **Cero ejecución formal del gate G2.**

## APPEND-ONLY TRUNCATE HARDENING — RUN 1

> **No es la aprobación formal de G2.** Ensayo estructural sobre el stack local
> desechable. Una base local no es staging; el gate sigue sin ejecutar.

Cierra **RK-04b**. La auditoría previa demostró que
`SET LOCAL ROLE authenticated; TRUNCATE TABLE public.stella_interactions;`
**tenía éxito**: un trigger `FOR EACH ROW` no se dispara en `TRUNCATE` y RLS no
lo gobierna.

| Campo | Valor |
|---|---|
| Fecha | 2026-08-01, 12:16–12:17 (hora local) |
| Commits | `f28627b` (0002b), `58210c2` (0003), `4e3352b` (docs/tests) |
| Script | `db/prepared/stella_0002b_append_only_truncate_hardening.sql` |
| SHA-256 | `781e8b58fe2f512c4214016421199c853f9ed840fde0f27f701ddf247aace550` |
| 1ª aplicación | exit **0**, ~866 ms, auto-verificación superada |
| 2ª aplicación (idempotencia) | exit **0**, ~736 ms, mismo hash, sin duplicados |

### Matriz de privilegios — antes / después

Sobre las **cuatro** tablas append-only (`stella_interactions`, `audit_logs`,
`sroi_calculation_runs`, `sroi_calculation_line_items`):

| Rol | Antes | Después |
|---|---|---|
| `authenticated` | `SELECT, INSERT, REFERENCES, TRIGGER, TRUNCATE, MAINTAIN` | **`SELECT, INSERT`** |
| `service_role` | `SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE, MAINTAIN` | **`SELECT, INSERT`** |
| `anon` | nada | nada |
| `postgres` (owner) | todo | todo — **no acotable por grants**; lo detiene el trigger |

Conteos verificados tras la 2ª corrida: 4 triggers `*_no_truncate`, 4 triggers
`*_append_only`, **0 duplicados**, **0 privilegios peligrosos**, **16/16**
`SELECT`+`INSERT` preservados, 4 tablas con RLS, 1 interacción sintética.

### Pruebas de `TRUNCATE` por rol

En transacción con `ROLLBACK`, sin `CASCADE`, sobre la única fila sintética:

| Rol | Resultado | SQLSTATE | Origen del bloqueo |
|---|---|---|---|
| `authenticated` | bloqueado | `42501` | **privilegio** — `permission denied for table stella_interactions` |
| `service_role` | bloqueado | `42501` | **privilegio** — `permission denied for table stella_interactions` |
| `postgres` (owner) | bloqueado | `42501` | **trigger** — `append-only: TRUNCATE on stella_interactions is not permitted` |

Esto es exactamente el diseño de dos capas funcionando sobre poblaciones
distintas: los grants detienen a todo rol que no sea el owner; el trigger es la
**única** capa que alcanza al owner — y aquí importa, porque `db/client.ts`
conecta con `DATABASE_URL`, es decir, como `postgres`.

**Datos preservados:** la fila sintética sobrevivió a las tres pruebas
(`count = 1`, `context_hash` de 64 chars, `tokens_used = 0`).

`stella_0002b_rollback.sql` también se ejecutó (paso 11): reportó las tres
protecciones intactas y salió 0, sin modificar nada.

### Alcance

Cero acceso remoto. Cero `stella_0003` (endurecido pero **no aplicado**). Cero
`grounding_0001`. Cero G3. Otros stacks intactos. **Cero ejecución formal de
G2.** Los `ALTER DEFAULT PRIVILEGES` globales **no** se tocaron: siguen
concediendo `Dxtm` a toda tabla nueva (**RK-04c**, diferido a un gate
transversal).

## STELLA 0003 LOCAL REHEARSAL — RUN 1

> **No es la aprobación formal de G2.** Ensayo estructural sobre el stack local
> desechable. Una base local no es staging; el gate remoto sigue **sin
> ejecutar** y ninguna casilla de `docs/ops/gates/G2_PACKAGE.md` queda marcada
> por esta corrida.

Primera aplicación de `db/prepared/stella_0003_suggestion_decisions.sql` en un
PostgreSQL real. La ejecutó **manualmente el operador**, en una sola sesión
`psql`, declarando el rol escritor antes del script. Todo lo demás de esta
sección —postchecks, pruebas de camino de escritura, inmutabilidad, matriz de
roles y segunda aplicación— se hizo después, de forma independiente, sobre el
estado ya aplicado.

| Campo | Valor |
|---|---|
| Fecha | 2026-08-01 |
| Branch | `codex/stella-g2-local-rehearsal` |
| HEAD | `09a65fd22429c033cc3de970deb2913cd90752e3` |
| `project_id` (config.toml) | `uellix-stella-g2-local-rehearsal` |
| Contenedor | `supabase_db_uellix-stella-g2-local-rehearsal` |
| Motor | PostgreSQL 17.6 |
| Writer declarado | `SET stella.writer_role = 'postgres'` |
| Script | `db/prepared/stella_0003_suggestion_decisions.sql` (859 líneas, 49 253 bytes) |

### Identidad del artefacto — tres hashes distintos

Los tres identifican el **mismo** archivo y no deben confundirse entre sí:

| Identidad | Valor | Qué son esos bytes |
|---|---|---|
| SHA-256 working tree | `6caa5ca97acbc0e9b28a439a66dcfac9b0d15399e4172da886dffd9fc1d6b7d1` | bytes **CRLF** en disco — los que `psql` leyó realmente |
| SHA-256 canónico Git | `ad22e22c18f0bfb8c03987e05b76de45efe440fd994c2ae719a55bece778fab5` | contenido de `git show HEAD:<archivo>`, bytes **LF** |
| Git blob ID | `00c17b0491b26c195aa19822d8c80fed4874c202` | object id interno (SHA-1 de `blob <len>\0` + contenido LF) |

`git hash-object` sobre el working tree devuelve el mismo blob ID, y
`git status` para esa ruta está vacío: **el archivo no se modificó después de
la aplicación manual**. El hash del working tree es el que hay que citar como
"bytes ejecutados"; el canónico es el portable entre checkouts (ver pendiente
remoto 4).

### 1ª aplicación (manual, por el operador)

```bash
psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 \
  -c "SET stella.writer_role='postgres'" -f db/prepared/stella_0003_suggestion_decisions.sql
```

Exit code exitoso. Auto-verificación del propio script superada, con sus dos
`NOTICE` finales:

```
stella_0003: write path VERIFIED against declared writer role postgres
             (owner: postgres, owner_is_writer: t).
stella_0003: verification passed — table owned by postgres, column contract
             exact (11 columns, no extras), PK, 4 FKs all NO ACTION, 0 UNIQUE,
             both CHECKs, RLS on (FORCE off) with 1 SELECT policy,
             2 append-only triggers, authenticated=SELECT only (not grantable),
             anon/service_role=none.
```

La rama `ASSUMPTION` **no** se activó: el writer fue declarado, así que la
guarda de §4b es una verificación real y no una suposición.

### Postchecks estructurales independientes

Reejecutados contra `pg_catalog` **sin confiar** en el `NOTICE` del script —
que es el propio script afirmando sobre sí mismo:

| Comprobación | Resultado |
|---|---|
| Columnas | **11 exactas**, cero adicionales, tipos/nulabilidad/defaults exactos |
| PK | `stella_suggestion_decisions_pkey` sobre `(id)`, solo esa columna |
| FKs | **4**, cero adicionales |
| Acciones ON DELETE | **4/4 `NO ACTION`** (`confdeltype='a'`), cero `CASCADE` |
| UNIQUE constraints | **0** |
| Índices UNIQUE no-PK | **0** |
| CHECK `decision` | exactamente `accepted`, `accepted_edited`, `rejected`, `undone` |
| CHECK `previous_value_hash` | `IS NULL OR ~ '^[0-9a-f]{64}$'` (anclado) |
| Índices | `(organization_id, decided_at)` y `(interaction_id)`, ambos no únicos; 3 en total con el de la PK |
| Owner | `postgres` |
| RLS | habilitado |
| FORCE RLS | **apagado** |
| Policies | **1**, `stella_suggestion_decisions_select`, `SELECT`, con `current_user_org_ids()` y `current_user_is_super_admin()`; **0** de INSERT/UPDATE/DELETE |
| ACL `authenticated` | **solo `SELECT`**, `is_grantable = false` |
| ACL `service_role` | **cero** privilegios directos |
| ACL `anon` | **cero** |
| ACL `PUBLIC` (grantee OID 0) | **cero** |
| Triggers no internos | **2** |
| Trigger de fila | `BEFORE UPDATE OR DELETE FOR EACH ROW` (`tgtype = 27`), sin INSERT |
| Trigger de statement | `BEFORE TRUNCATE FOR EACH STATEMENT` (`tgtype = 34`) |
| Función de ambos | `public.uellix_forbid_mutation()` |
| `evidence_chunks` | **ausente** |
| 4 tablas append-only previas | intactas, sus **8** triggers intactos |
| Interacción sintética | intacta (`count = 1`, mismo `created_at`) |
| Tablas en `public` | 38 (37 + la nueva) |
| Registro de migraciones | sin entradas nuevas — el script preparado no se auto-registra |

ACL leída con `aclexplode(COALESCE(relacl, acldefault('r', relowner)))`, nunca
con `information_schema.role_table_grants`.

### Camino de escritura — `INSERT ... RETURNING id`

En una transacción terminada siempre en `ROLLBACK`, como `postgres` (el rol al
que resuelve `DATABASE_URL`, es decir el owner). Los identificadores se
derivaron **dentro de SQL** desde la fila sintética; ninguno se imprimió.

| Comprobación | Resultado |
|---|---|
| `INSERT` | permitido (1 fila) |
| `RETURNING id` | permitido, `id` no nulo |
| `DEFAULT` de `decided_at` | aplicado |
| CHECK de `decision` (`accepted_edited`) | satisfecho |
| CHECK de hash (64 hex) | satisfecho |
| FK a `stella_interactions` | satisfecha |
| Tras `ROLLBACK` | **0 filas** — cero persistencia |

Cero errores de FK, CHECK, ACL, RLS o `RETURNING`.

### Inmutabilidad — como `postgres` (owner)

Transacciones separadas, todas revertidas. La fila sintética se creó dentro de
la misma transacción y desapareció con ella.

| Operación | Resultado | SQLSTATE | Origen |
|---|---|---|---|
| `UPDATE` | **bloqueado** | `42501` | trigger — `append-only: UPDATE on stella_suggestion_decisions is not permitted` |
| `DELETE` | **bloqueado** | `42501` | trigger — `append-only: DELETE on stella_suggestion_decisions is not permitted` |
| `TRUNCATE` (sin `CASCADE`) | **bloqueado** | `42501` | trigger — `append-only: TRUNCATE on stella_suggestion_decisions is not permitted` |

Ni grants ni RLS alcanzan al owner: el trigger es la única capa que lo detiene,
y aquí importa porque `db/client.ts` conecta con `DATABASE_URL`. Tras las tres
pruebas: tabla vacía, interacción sintética intacta, tablas dependientes sin
cambios.

### Matriz de roles cliente

`SET LOCAL ROLE`, en transacciones revertidas. No se concedió ningún privilegio
ni se creó ninguna policy para estas pruebas.

| Rol | SELECT | INSERT | UPDATE | DELETE | TRUNCATE |
|---|---|---|---|---|---|
| `authenticated` | **permitido**, 0 filas visibles (RLS org-scoped, sin claims) | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) |
| `service_role` | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) |
| `anon` | bloqueado (EXECUTE del helper RLS, y además ACL) | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) | bloqueado (ACL) |

Tres matices que conviene no perder:

- **`authenticated` lee pero no ve nada.** La ACL concede `SELECT`; la policy
  org-scoped filtra. Sin claims de JWT, `current_user_org_ids()` es vacío, así
  que el resultado legítimo es 0 filas. ACL y RLS son capas distintas y aquí se
  observan por separado.
- **`service_role` tiene `rolbypassrls = t` y aun así no lee.** Saltarse RLS no
  concede ACL: sin `GRANT SELECT` no hay lectura. Es exactamente la postura que
  §4 pretendía —`service_role` sin ningún privilegio— comprobada en ejecución.
- **`anon` es denegado por dos capas independientes.** El error observado es
  `permission denied for function current_user_org_ids`, no el de tabla, porque
  `current_user_org_ids()` es una función SQL `SECURITY DEFINER` y el planner
  comprueba su `EXECUTE` al inlinearla, **antes** del chequeo de ACL de tabla en
  el ejecutor. Verificado que ambas deniegan:
  `has_table_privilege('anon', …, 'SELECT') = f` **y**
  `has_function_privilege('anon','public.current_user_org_ids()','EXECUTE') = f`.
  El mismo comportamiento es preexistente en `stella_interactions`; no lo
  introduce `stella_0003`.

### 2ª aplicación — idempotencia y convergencia

Misma copia exacta del archivo (`sha256` verificado **dentro** del contenedor
antes de ejecutar), misma sesión única, mismo writer declarado:

| Campo | Valor |
|---|---|
| Bytes ejecutados | `6caa5ca9…7d1` (idéntico a la 1ª) |
| Exit code | **0** |
| Duración | ~898 ms |
| `NOTICE` | `write path VERIFIED …` + `verification passed …` (idénticos) |
| Warnings | **0** |
| Errores | **0** |

Los únicos mensajes adicionales son los `already exists, skipping` esperables de
`CREATE TABLE/INDEX IF NOT EXISTS`. La policy y los dos triggers se
`DROP`/`CREATE` por diseño (reconciliación convergente), no se duplican.

**Idempotencia medida, no supuesta.** Se capturó una huella estructural de 39
líneas —columnas, constraints, índices, policy, triggers, ACL, owner, flags RLS,
conteo de filas, triggers de las 4 tablas previas, interacción sintética,
número de tablas y ausencia de `evidence_chunks`— antes y después de la segunda
corrida:

```
sha256(huella_antes)  = 549b4084327b35f18756586ca0edc4a8571d1ea7f79a3396a6552f632a84d030
sha256(huella_despues)= 549b4084327b35f18756586ca0edc4a8571d1ea7f79a3396a6552f632a84d030
diff -u  ->  sin diferencias
```

Una tabla, 11 columnas, mismos constraints, dos índices no únicos, cero UNIQUE,
una policy, dos triggers, ACL idéntica, **cero filas**, cero duplicados, otros
objetos intactos.

Tras la segunda aplicación se reverificó **funcionalmente** que los triggers
recreados siguen disparando: `UPDATE`, `DELETE` y `TRUNCATE` volvieron a fallar
con `42501` desde `uellix_forbid_mutation()`, y la tabla quedó en 0 filas.

La copia temporal del script dentro del contenedor se eliminó al terminar; no
se tocó nada más.

> Nota operativa (Git Bash / MSYS): el primer intento de la 2ª aplicación falló
> con *"No such file or directory"* porque MSYS convirtió la ruta `/tmp/...` del
> contenedor a una ruta de Windows. `-1` hizo su trabajo: el `SET` corrió, el
> `-f` no encontró el archivo y **no se tocó la base** (verificado: 0 filas, 2
> triggers, 1 policy). Se repitió con `MSYS_NO_PATHCONV=1`.

### Pruebas offline

| Comando | Resultado |
|---|---|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | **188/188** en 2 archivos |
| `pnpm test:unit` | **2482/2482** en 134 archivos |
| `pnpm typecheck` | exit **0**, 0 errores |
| `pnpm lint` | exit **0**, **0 errores** (51 warnings preexistentes, ajenos a esta unidad) |
| `pnpm test:rls` | **NO EJECUTADA** — es G3 |

### Alcance

Cero acceso remoto. Cero `supabase login/link/db push/db pull`. Cero G3. Cero
`grounding_0001`. Cero seeds. Cero reset. **Rollback NO ejecutado.** Otros
stacks (`uellix-antigravity`, `aforiq`) intactos y healthy. **Cero ejecución
formal de G2.**

### Pendientes para el gate remoto (no bloquean el ensayo local)

Detectados en la reauditoría previa y todavía abiertos:

1. ~~**`G2_PACKAGE.md` §2 sigue usando `information_schema.role_table_grants`**
   para los grants de `stella_interactions`, la misma vista que §6 prohíbe con
   argumento. Peor: esa vista **no puede expresar `PUBLIC`** — medido en este
   stack, devuelve 0 filas con `grantee='PUBLIC'` mientras 195 relaciones sí
   tienen ACL de `PUBLIC`. Su expectativa *"para anon / PUBLIC: ninguna fila"*
   es, para `PUBLIC`, infalsificable.~~
   **CERRADO 2026-08-02** (bloque de separación de roles): `G2_PACKAGE.md` §2
   usa ahora `aclexplode(COALESCE(relacl, acldefault('r', relowner)))` con el
   caso `grantee = 0` explícito para `PUBLIC`, igual que §6. La expectativa
   sobre `PUBLIC` pasa de infalsificable a comprobable.
2. ~~**El rollback depende de banderas de `psql`.**~~ **CERRADO 2026-08-01** —
   ver *ENDURECIMIENTO ESTRUCTURAL DEL ROLLBACK DE `stella_0003`* más abajo.
   Guarda y `DROP` viven ahora en el mismo bloque `DO`; el defecto quedó
   demostrado empíricamente y la corrección verificada en 9 escenarios.
3. **Falta un test automático de integridad estructural de los archivos de
   test.** El incidente de `String.replace` con `$'` está registrado como
   lección de proceso, pero nada lo fija contra recurrencia.
4. **El hash de evidencia no es portable.** El SHA-256 citado como "bytes
   ejecutados" es el del working tree con CRLF; en un checkout con LF o en CI
   Linux el mismo archivo hashea `ad22e22c…`. No hay `.gitattributes` que fije
   `eol` para `*.sql`.

## G3 LOCAL REHEARSAL — RUN 1, CORRECTED INSTRUMENTATION

**2026-08-01 · worktree `codex/stella-g2-local-rehearsal` · HEAD `2d26319`
(inicial) · project_id `uellix-stella-g2-local-rehearsal` · contenedor
`supabase_db_uellix-stella-g2-local-rehearsal` (PostgreSQL 17.6).**

Primera ejecución de `pnpm test:rls` con los dos bloques post-G2 habilitados.
**Cero acceso remoto**, cero `supabase login/link/db push/db pull`, cero G2
formal, cero `grounding_0001`, cero rollback, cero reset.

### Respaldo pre-G3

`pg_dump -Fc` sobre `postgres` dentro del contenedor, copiado a una carpeta
temporal de Windows **fuera del repositorio** (no versionado, no subido).
581 736 bytes. SHA-256 `d46280c4261cc8b68896dd34b12f41d9334756a61f7a2f2a3c441aef5b436aeb`.
Validado con `pg_restore -l`: 1 155 entradas de TOC, 87 `TABLE DATA`, incluye
ambas tablas Stella con sus ACL y constraints. **No restaurado.**

### El falso rojo, y por qué no era un hallazgo de RLS

La 1ª ejecución dio **23/25**. Los dos rojos estaban en el bloque
`post-G2 (stella_0002)`, que aserta con
`expect(...).rejects.toThrow(/append-only/)`.

La base **sí** bloqueó ambas mutaciones. La sonda de diagnóstico mostró la
cadena real del error:

```
depth 0  DrizzleQueryError  code=undefined  message="Failed query: UPDATE public.stella_interactions …"
depth 1  PostgresError      code="42501"    message="append-only: UPDATE on stella_interactions is not permitted"
                                            severity=ERROR  routine=exec_stmt_raise  table_name=null
```

`DrizzleQueryError` (drizzle-orm 0.45.2, `errors.js:12`) construye su `message`
como `"Failed query: <sql>\nparams: "` y cuelga el error del driver en `.cause`.
`.rejects.toThrow(/regex/)` compara **sólo** contra `.message`, así que la
aserción nunca podía ver el mensaje del trigger. **Defecto de instrumentación,
independiente del entorno** — habría fallado igual contra staging.

Verificado en la base tras el intento: 2 interacciones, ambas con
`pipeline_step='narrative'`, **0 manipuladas**.

Nota: `PostgresError` hace `Object.assign(this, x)` con el notice crudo, pero
para un `RAISE EXCEPTION` de plpgsql **`table_name` queda `null`** (sólo se
rellena en violaciones de constraint). La tabla y la operación hay que
extraerlas del texto, que `public.uellix_forbid_mutation()` formatea de forma
estable: `'append-only: % on % is not permitted'` con `TG_OP` y `TG_TABLE_NAME`.

### Corrección — helper de desenvoltura, aserción más fuerte

`tests/helpers/append-only-error.ts` recorre la cadena `cause` con límite de
profundidad (10) y detección de ciclos, y exige **conjuntamente** SQLSTATE
`42501`, el texto `append-only`, la operación y la tabla. Rechaza
explícitamente un `42501` que no venga del trigger (p. ej.
`permission denied for table …`). Los dos tests además verifican ahora que la
fila quedó intacta.

`tests/append-only-error.test.ts`: **13 casos** — causa válida, causa anidada,
error sin causa, SQLSTATE erróneo, mensaje erróneo, operación errónea, tabla
errónea, cadena circular, cadena excesivamente profunda, y el caso de "la
consulta tuvo éxito" (que debe fallar ruidosamente).

### Idempotencia del residuo append-only

La 1ª corrida dejó una decisión persistente con la clave determinista
`g3-local-rehearsal.synthetic.advisor.suggested_next_actions[0]`, más la
interacción sintética asociada. Ninguna se puede borrar (triggers append-only)
y sus FK `ON DELETE NO ACTION` fijan organización, proyecto y usuario.

Para poder reejecutar sin multiplicar el residuo, el `beforeAll` raíz resuelve
la clave **antes** de escribir nada:

| Caso | Comportamiento |
|------|----------------|
| exactamente 1 | **REUSED** — reutiliza la fila y deriva de ella org, proyecto e interacción. Cero inserciones append-only |
| 0 | **CREATED** — crea exactamente una, como en la 1ª corrida |
| >1 | **Aborta** la suite con error explícito; no se elige una fila arbitrariamente |

Sin `ON CONFLICT` sin constraint, sin `UPDATE`, sin `DELETE`, sin `TRUNCATE`,
sin desactivar triggers, sin `session_replication_role`, sin `DROP TABLE`.

### Ejecución focalizada del arreglo

`vitest ... -t "via service role falla con insufficient_privilege"` →
**2 passed / 30 skipped**. La selección no ejecutó el bloque que crea la
decisión, y en modo REUSED el `beforeAll` de interacciones tampoco insertó.
Conteos idénticos antes y después.

### 2ª ejecución completa

`pnpm test:rls` → **1 archivo, 32 passed, 0 failed, 0 skipped, 11,79 s.**
Fixture append-only: **REUSED**. Warnings: 7 × `Multiple GoTrueClient
instances` (benigno; jsdom comparte la storage key entre clientes).

### Conteos antes / después de la 2ª ejecución

| Tabla | Antes | Después |
|-------|-------|---------|
| `stella_suggestion_decisions` | 1 | **1** |
| `stella_interactions` | 2 | **2** |
| `organizations` | 3 | 3 |
| `users` / `auth.users` | 9 / 9 | 9 / 9 |
| `projects` | 2 | 2 |
| `organization_members` | 7 | 7 |
| `storage.objects` | 0 | 0 |

Cero crecimiento del residuo append-only. Los fixtures desechables de la
corrida (7 usuarios + membresías, organización B, el proyecto creado por el
analyst y el objeto de Storage) fueron limpiados por `afterAll`, que propaga
errores de FK en vez de silenciarlos.

### Aislamiento y permisos demostrados

| Caso | Resultado |
|------|-----------|
| Organización A lee su decisión (clave y decisión exactas) | ✅ |
| Organización B no la ve (SELECT cruzado vacío) | ✅ |
| Usuario sin membresía no la lee | ✅ |
| Usuario sin membresía no puede insertar | `42501` |
| super_admin la lee | ✅ |
| super_admin **no** puede mutarla | `42501` |
| `authenticated` INSERT / UPDATE / DELETE | `42501` |
| `service_role` SELECT e INSERT directos | `42501` — sin grant de tabla, **`BYPASSRLS` no sustituye a la ACL** |
| `UPDATE` / `DELETE` como owner sobre `stella_interactions` | `42501`, `append-only: … is not permitted`, fila intacta |
| `TRUNCATE` de `stella_suggestion_decisions` (en transacción revertida) | `42501`, `append-only: TRUNCATE on stella_suggestion_decisions is not permitted`, fila superviviente |

### Postcheck estructural

RLS activo en ambas tablas · 104 policies · 10 triggers append-only ·
ACL de `stella_suggestion_decisions` = `authenticated: SELECT` + owner ·
`session_replication_role = origin` · `evidence_chunks` **ausente** ·
0 decisiones no sintéticas · 0 interacciones manipuladas · 0 emails fuera de
`@test.com` / `@test.local` · sin DDL · sin migraciones · `db/prepared`,
`db/schema.ts` y `db/migrations` intactos.

### Residuo deliberado y limpieza autorizada

Persisten, y **no pueden retirarse fila por fila**: 1 decisión sintética,
1 interacción sintética, y por FK `NO ACTION` la organización, el proyecto y el
usuario que referencian. La limpieza autorizada es el **reset/rebuild del stack
local desechable** — no se intentó `DELETE` ni `TRUNCATE`, ni se desactivó
ningún trigger.

**G3 remoto no queda autorizado por este ensayo:** requiere una estrategia no
contaminante propia (base efímera dedicada o gate de solo lectura sobre filas
ya existentes), todavía sin diseñar.

## ENDURECIMIENTO ESTRUCTURAL DEL ROLLBACK DE `stella_0003`

> **Unidad PREVIA al ensayo destructivo.** No se ejecutó el rollback, no se
> restauró el respaldo, no se reseteó el stack, no se tocó la base viva. Cambia
> únicamente `db/prepared/stella_0003_rollback.sql`, sus pruebas offline y esta
> documentación. **G2 sigue sin ejecutar y sin aprobar.**

**2026-08-01 · worktree `codex/stella-g2-local-rehearsal` · HEAD inicial
`a77948d`.** Cierra el pendiente remoto **2** de la sección anterior.

### El defecto

La guarda de autorización era un bloque `DO $$ … $$;` y la destrucción una
sentencia **top-level posterior e independiente**:

```sql
DO $$ ... IF n_rows > 0 AND NOT authorised THEN RAISE EXCEPTION ... $$;
DROP TABLE IF EXISTS public.stella_suggestion_decisions;   -- <-- separada
```

Entre ambas no había más barrera que dos banderas de línea de comandos:

| Bandera | Qué aporta | Qué pasa sin ella |
|---|---|---|
| `-v ON_ERROR_STOP=1` | `psql` **se detiene** tras una sentencia fallida | `psql` imprime el error y **envía la siguiente** — el `DROP` |
| `-1` | Todo en una transacción; un fallo revierte | Cada sentencia hace autocommit por su cuenta |

Son una **convención de invocación**, no una propiedad del archivo. La cabecera
las **mandaba**; nada las **imponía**. Y `G2_PACKAGE.md` admite explícitamente
tres vías de aplicación de las cuales **sólo una** las acepta: `psql`,
`supabase db execute --file` y el SQL Editor de Supabase.

### La corrección

Todo ocurre ahora en **un único bloque `DO`**: existencia, conteo, `NOTICE`,
autorización y el `DROP`. En PL/pgSQL un `RAISE EXCEPTION` termina el bloque de
inmediato y ninguna sentencia posterior *de ese bloque* corre — **semántica del
servidor dentro de una sola sentencia**, no del cliente entre dos. Ningún
cliente, bandera u orden de pegado puede volver a separarlas.

El `DROP` se emite como `EXECUTE 'DROP TABLE public.stella_suggestion_decisions'`
— literal fijo, **cero** concatenación, `format()`, `quote_ident()` o variables;
lo único que decide el código es **si** ejecutarlo, nunca **qué** dice. Sin
`IF EXISTS`: la existencia ya se probó en el mismo bloque, y conservarlo sólo
ocultaría una discrepancia entre la comprobación y el acto.

`-1 -v ON_ERROR_STOP=1` **siguen recomendadas** como defensa en profundidad
(atomicidad, y exit code ≠ 0 para un gate que lo lee — medido: `3`).

**Cambio colateral necesario.** El banner de `RAISE NOTICE` pasó de guiones a
`=`. Un `--` **dentro de un literal** ciega a todo analizador que quite
comentarios antes que cadenas —incluido el `stripCommentsAndStrings` del propio
lint offline—: truncaba el `NOTICE`, dejaba una comilla desbalanceada y a partir
de ahí leía el **contenido de las cadenas** del script como si fuera código. La
aserción "no hay `DROP TABLE` ejecutable" era, con guiones, infalsificable.

### Autorización — exacta, sin coerción

`COALESCE(current_setting('stella.confirm_destroy_decisions', true), '') = 'true'`.
El segundo argumento (`missing_ok`) evita que un GUC nunca declarado aborte con
*"unrecognized configuration parameter"* en vez del mensaje de la guarda; el
`COALESCE` convierte "sin declarar" en "no autorizado" en vez de en un `NULL`
que dejaría `NOT authorised` indeterminado y **ninguna** rama activa.

Rechazados y verificados uno por uno: `yes`, `y`, `1`, `TRUE`, `True`, `trUe`,
`on`, `t`, `'true '`, `' true'`. Sin `::boolean`, sin `lower()`, sin `trim()`.

**Límite honesto, medido en PostgreSQL 17.6.** `SET x = TRUE` con la palabra
clave **sin comillas** *sí* autoriza, y no es un hueco de la comparación: la
gramática de `SET` normaliza la palabra clave desnuda y **almacena la cadena
`'true'`**, byte a byte idéntica a la que produce `SET x = 'true'`. Para cuando
`current_setting()` la lee, la distinción ya no existe y ninguna guarda escrita
en SQL puede recuperarla. Lo que **sí** se rechaza es el literal entrecomillado
`'TRUE'` y todas las demás grafías. Se declara aquí en vez de afirmar una
estrictez mayor que la real — es el mismo tipo de "verificación declarada y no
realizada" que MAJ-B y MINOR-2 cerraron en otros puntos del paquete.

**Nota operativa.** En la imagen `supabase/postgres` el rol `postgres` **no** es
superusuario, así que `ALTER DATABASE … SET stella.confirm_destroy_decisions`
falla con *"permission denied to set parameter"*. La vía practicable es el `SET`
de sesión (`psql -c "SET …" -f …`). No se investigó más: excede esta unidad,
pero conviene tenerlo presente porque `G2_PACKAGE.md` propone `ALTER DATABASE`
como alternativa para declarar `stella.writer_role`.

### Dry-run — entorno desechable, base viva intacta

Contenedor **nuevo y aislado** (`--network none`, sin puertos publicados),
imagen `public.ecr.aws/supabase/postgres:17.6.1.143`, **PostgreSQL 17.6** — el
mismo motor que el stack del ensayo. Fixture mínima: la tabla, más las dos
triggers append-only para comprobar que tampoco detienen un `DROP`. Se ejecutó
el **archivo real**, con `sha256` verificado dentro del contenedor. El
contenedor se destruyó al terminar. **Cero contacto con
`supabase_db_uellix-stella-g2-local-rehearsal`.**

Los escenarios críticos corrieron con **`psql` desnudo — sin `-1` y sin
`ON_ERROR_STOP`** — que es exactamente el caso para el que existe el
endurecimiento.

| # | Escenario | Invocación | Resultado |
|---|---|---|---|
| S1 | Tabla ausente | desnuda | exit 0, `NOTICE` de no-op, sin error |
| S2 | Tabla presente, **0 filas** | desnuda | exit 0, `DROP`, `NOTICE` de rollback técnico, **sin** `WARNING` |
| S3 | 1 fila, **sin** autorización | desnuda | aborta; **tabla, fila y 2 triggers sobreviven** |
| S4 | 1 fila, autorización incorrecta (11 valores) | desnuda | **11/11 rechazadas**; tabla y fila intactas en todas |
| S5 | 1 fila, autorización **exacta** `'true'` | desnuda | exit 0, `WARNING` de destrucción, `DROP`, conteo reportado |
| S6 | Segunda ejecución inmediata | desnuda | exit 0, no-op idempotente |
| S7 | S3/S5 con `-1 -v ON_ERROR_STOP=1` | completa | no autorizado → **exit 3** y tabla intacta; autorizado → exit 0 |
| S8 | **Regresión:** forma ANTERIOR, misma invocación desnuda | desnuda | la guarda lanzó la excepción **y la tabla fue destruida igualmente** |
| S9 | Forma NUEVA, invocación idéntica a S8 | desnuda | **tabla y fila sobreviven** |
| S10 | `FORCE RLS` on, owner sin `BYPASSRLS`, 1 fila | desnuda | aborta por la guarda de `FORCE`; **no** clasifica la tabla como vacía |
| S11 | Autorización **persistida** vía `ALTER DATABASE … SET` | desnuda | aborta; tabla y fila intactas. Tras `RESET` + `SET` de sesión → destruye |
| S12 | `client_min_messages=error` vía `PGOPTIONS`, autorizado | desnuda | el `WARNING` de destrucción **sigue visible** |
| S13 | Tabla vacía | desnuda | **no** imprime el banner de destrucción; sólo el mensaje de rollback técnico |
| S14 | 1 fila, rechazada | desnuda | tampoco imprime el banner: el log de un rechazo no se confunde con el de una destrucción |
| S15 | `FORCE` **sin** `ENABLE` (RLS deshabilitada), autorizado | desnuda | **no** hay rechazo falso: RLS no se aplica, el conteo es fiable, destruye |
| S16 | Persistido `'false'` en un rol ajeno, autorizado en sesión | desnuda | **no** bloquea: fuera de alcance y con valor que no autoriza |
| S17 | Persistido `'true'` vía `ALTER DATABASE` sobre esta base | desnuda | sigue bloqueando; tabla y fila intactas |
| S18 | Vista dependiente presente, autorizado | desnuda | aborta con el **mensaje nativo** de PostgreSQL (sin prefijo, **por diseño**), **sin destruir**; tras retirar la vista, destruye |
| S19 | Catálogo de provenance legible, comprobado explícitamente | desnuda | sin `permission denied` desnudo; destruye |
| S20 | `REPEATABLE READ`, 1 fila, autorizado | desnuda | aborta **con prefijo**, nombra el nivel; tabla y fila intactas |
| S21 | `SERIALIZABLE`, autorizado | desnuda | aborta igual; tabla intacta |
| S22 | `READ COMMITTED` (defecto), autorizado | desnuda | **sin rechazo falso**; destruye |
| S23 | `READ UNCOMMITTED`, autorizado | desnuda | **aceptado** (PostgreSQL lo implementa como `READ COMMITTED`); destruye |
| S24 | `REPEATABLE READ`, **tabla ausente** | desnuda | la guarda dispara igualmente → confirma que corre **primero** |

S8 y S9 son el par que prueba el defecto y su cierre: mismo motor, mismos bytes
de invocación, misma fila — resultado opuesto.

### Hallazgos de la revisión independiente (ronda 4) y su cierre

Un agente revisor de solo lectura evaluó el diff. **0 BLOCKER, 3 MAJOR**, todos
corregidos y reverificados; el detalle importa porque dos de ellos eran huecos
reales y uno traía una corrección propuesta **inaplicable**.

| # | Hallazgo | Cierre |
|---|---|---|
| **M1** | `count(*)` **está sujeto a RLS**. `FORCE ROW LEVEL SECURITY` quita el bypass del owner, así que un rol propietario **sin `rolbypassrls`** contaría **0** sobre una tabla poblada: el script habría anunciado *"table is empty — no audit data lost"* mientras destruía el audit trail. **Reproducido** en PG 17.6 (owner `NOBYPASSRLS`, policy `USING(false)`): `FORCE` off → 1, `FORCE` on → **0**, con la fila presente. **No** se reproduce como `postgres` sobre imagen Supabase porque ese rol tiene `rolbypassrls = true` — razón de más para no dejarlo al rol que el operador use | Guarda de `relforcerowsecurity` **antes** del conteo, simétrica con las §4b y §7 del script forward, que ya tratan `FORCE`-on como estado abortable. Verificado en **S10** |
| **M2** | La autorización podía venir de un `ALTER DATABASE … SET` / `ALTER ROLE … SET` **persistido**, pre-autorizando toda sesión futura — el mismo defecto que este cambio cierra, reubicado de las banderas de `psql` a la capa de GUC | La corrección **propuesta por el revisor** (`pg_settings.source`) es **inaplicable**: los GUC placeholder personalizados **no aparecen en `pg_settings`** (medido: 0 filas), así que el chequeo habría abortado siempre o nunca. Implementado sobre **`pg_db_role_setting`**, que **sí** registra ambas formas. Verificado en **S11**. Queda un límite honesto declarado en el archivo: un `SET` de sesión es todo lo que SQL puede exigir; que lo teclee un humano y no un script envolvente es **precondición del gate**, no del SQL — el mismo reparto en tres (guarda estructural / prueba offline / gate humano) que usa §4b del forward |
| **M3** | Las pruebas **no prohibían un `EXCEPTION WHEN`**. Un handler en el bloque —o en un sub-bloque anidado— traga el `RAISE` de la guarda y deja pasar el `DROP`, y **todas** las demás aserciones seguían en verde. Además es una edición *tentadora*, porque un fallo por objeto dependiente hoy sale sin el prefijo `stella_0003_rollback` | Aserciones que prohíben `EXCEPTION WHEN` y fijan **exactamente un `BEGIN` y un `RETURN`** dentro del bloque |

MINOR/NIT también cerrados: mensaje de irreversibilidad corregido —el DDL de
PostgreSQL es transaccional, así que bajo `-1` un `ROLLBACK` **sí** deshace todo
hasta el `COMMIT`, y decir lo contrario mandaba al operador a un respaldo que
todavía no necesita (**S12** aparte confirma que el aviso no puede silenciarse)—;
`SET client_min_messages = notice` para que el camino destructivo no corra en
silencio; `LOCK TABLE … ACCESS EXCLUSIVE` **antes** del conteo, cerrando el
TOCTOU por el que un `INSERT` concurrente podía añadir filas nunca contadas ni
autorizadas; banner de destrucción sólo en el camino con filas (**S13**), porque
imprimir *"irreversible"* y a continuación *"no audit data lost"* se
contradecía; el helper de comentarios de las pruebas ahora recorta también los
comentarios **al final de línea** respetando comillas (la justificación anterior
era falsa: `-- … EXECUTE 'DROP TABLE …'` tenía exactamente la forma que decía
imposible); y la autorización se fija ahora **byte a byte** sobre la expresión
aceptante en vez de enumerar literales rechazados, que sólo probaba la ausencia
de una *segunda* comparación y no habría detectado `IN ('true','on')`, `ILIKE`
ni `ANY(...)`.

**No adoptado, con motivo:** `SET LOCAL` para las GUC de sesión (imposible fuera
de una transacción, y bajo un pooler en modo transacción los `SET` y el `DO`
podrían caer en backends distintos — riesgo ambiental, anotado aquí en vez de
simulado).

### Ronda 2 de revisión — 2 MAJOR más, y dos bugs que sólo vio el dry-run

| # | Hallazgo | Cierre |
|---|---|---|
| **M4** | **El *armado* de las guardas no estaba probado.** Las aserciones comprobaban presencia de un nombre de catálogo, existencia de un mensaje y orden por `indexOf` — nunca que la guarda **lance**. El revisor lo demostró con mutantes: degradar el `RAISE EXCEPTION` de una guarda a `RAISE NOTICE`, invertir la condición de `FORCE`, o **neutralizar por completo la guarda de autorización** con `IF NOT authorised AND false THEN` dejaban la suite **entera en verde** — esta última porque `indexOf('RAISE EXCEPTION') < indexOf("EXECUTE 'DROP TABLE")` se satisfacía con la excepción de *otra* guarda | Cada guarda queda fijada como un **span único condición→`RAISE EXCEPTION`**, más el conteo total de excepciones y la exigencia de que todas lleven el prefijo `stella_0003_rollback aborted:`. Reverificado con **17 mutantes propios**, todos detectados |
| **M5** | **`pg_db_role_setting` podía no ser legible.** Es un catálogo compartido cuyo privilegio de `SELECT` depende del entorno; en un clúster restringido la consulta de provenance moriría con un `permission denied` **desnudo**, sin prefijo, en el camino de emergencia y después de haber anunciado que la destrucción estaba autorizada. **Medido en esta imagen: sí es legible** (`=r/supabase_admin`, concedido a PUBLIC) — pero eso es una propiedad del entorno, no del script | Chequeo explícito de `has_table_privilege` antes de la consulta: una guarda no verificable se trata como guarda fallida, con mensaje prefijado y accionable |

**Guarda añadida sobre la marcha.** Al mover el `LOCK TABLE` al frente (MINOR de
la ronda 1), un rol que no es dueño pasó a fallar en el `LOCK` con
`permission denied for table …` **sin prefijo**. Leer `pg_class` no exige
privilegio sobre la tabla, así que una **precondición de propiedad**
(`pg_has_role` contra `relowner`) va ahora primero: todo rechazo lleva el
prefijo del contrato del operador. Eran **seis** guardas en ese momento; la ronda 3 retiró la de dependientes y quedaron **cinco**.

**Dos bugs reales que ninguna prueba offline podía ver**, encontrados por el
dry-run contra un PostgreSQL de verdad:

1. **`operator is not unique: text || "char"`.** `pg_class.relkind` es del tipo
   `"char"`, no `text`, y la concatenación es ambigua. Rompía **todas** las
   corridas que llegaban al `DROP` — con 222 tests en verde.
2. **La consulta de objetos dependientes no veía las vistas.** Una vista **no**
   depende de la tabla directamente: depende su **regla de reescritura**
   (`classid = pg_rewrite`), así que un `JOIN pg_class ON d.objid` la perdía por
   completo. La guarda existía, no hacía nada, y reportaba éxito. Se reescribió
   sobre `pg_describe_object()` — y en la ronda 3 se retiró del todo, al
   descubrirse que esa segunda forma abortaba en toda ejecución (ver abajo).

Ambos son la justificación de la Fase 6: un lint estático sobre expresiones
regulares no puede resolver tipos ni recorrer catálogos.

### Ronda 3 — un BLOCKER, y una guarda que se retira en vez de arreglarse

| # | Hallazgo | Cierre |
|---|---|---|
| **B1** | **La guarda de objetos dependientes abortaba en TODA ejecución.** `CreatePolicy()` y las expresiones `CHECK` registran filas `DEPENDENCY_NORMAL` por **columna referenciada**, sin degradación de la auto-referencia — así que un filtro `deptype='n'` las clasifica como dependientes *ajenos*. **Reproducido** en PostgreSQL 17.6 contra el conjunto de objetos real de `stella_0003`: la guarda reportaba *"constraint … on table stella_suggestion_decisions, policy stella_suggestion_decisions_select on table stella_suggestion_decisions"* y **habría abortado siempre, incluso con la tabla vacía** — rompiendo el rollback por completo | **Guarda RETIRADA**, no arreglada por tercera vez. Ver abajo |
| **M6** | **El filtro de persistencia usaba `current_user`.** PostgreSQL aplica `pg_db_role_setting` al inicio de sesión vía `process_settings(databaseid, GetSessionUserId())`: se indexa por el rol de **login**, exacto, y **no consulta membresía**. Falla **abierto** justo donde importa: la guarda de propiedad le dice al operador que reejecute *"como el rol dueño"*, cosa que puede hacer con `SET ROLE` — dejando `session_user` como su rol de login; un `ALTER ROLE <login> SET … = 'true'` **sí** autorizó esa sesión y el filtro por `current_user` no lo vería. Y falla **cerrado** en la otra dirección: un ajuste sobre un rol del que la sesión sólo hereda nunca se aplicó, pero la membresía coincidiría | `s.setrole = (SELECT oid FROM pg_roles WHERE rolname = session_user)`, coincidencia exacta de OID |
| **M7** | **Cuatro mutantes más sobrevivían.** Las guardas quedaban fijadas, pero **no el flujo de datos que produce los valores que evalúan**: `IF n_rows > 0` → `IF n_rows > 1000000` (una tabla poblada y **sin autorizar** cae en la rama `ELSE`, registra *"no audit data lost"* y se destruye), un `authorised = true;` insertado (PL/pgSQL acepta `=` como asignación), un `n_rows := 0;`, y `SELECT NULL::text INTO persisted_at` | La **región de decisión** —conteo → asignación de autorización → `IF n_rows > 0 THEN`— fijada como **un único span adyacente verbatim**, más aserciones de escritura única sobre `n_rows`, `authorised` y `persisted_at` |

**Por qué se retira la guarda de dependientes en vez de arreglarla.** No estaba
en el encargo: se adoptó como NIT de la ronda 1. En dos intentos produjo dos
defectos reales —primero no veía las vistas, luego abortaba siempre— y le
quedaba un hueco conocido: los dependientes mediados por el **tipo compuesto**
de la tabla (una función `RETURNS SETOF` esta tabla se registra contra
`pg_type`, no `pg_class`). Su valor era exclusivamente el **prefijo del
mensaje**; no impedía ninguna destrucción. Re-derivar `findDependentObjects()`
de PostgreSQL en SQL no es tarea de este script: **una guarda sólo a veces
correcta sobre "¿fallaría el `DROP`?" es peor que ninguna, porque invita a
creerle.** Un fallo por objeto dependiente sale ahora con el mensaje nativo de
PostgreSQL, **no destruye nada**, y queda documentado en `G2_PACKAGE.md` como
uno de los pocos abortos que no llevan el prefijo. La tentación que justificaba
la guarda —añadir un `EXCEPTION` handler para recuperar el prefijo— se cierra
directamente: el test la prohíbe. Quedan **cinco** guardas.

**La fixture mínima fue lo que ocultó el BLOCKER.** Tenía sólo la tabla y los dos
triggers; sin política ni `CHECK`, el grafo de dependencias real nunca se
ejercitó. La fixture de dry-run replica ahora lo que `stella_0003` crea
realmente: tabla, ambos `CHECK`, índice, RLS con la política org-scoped y los
dos triggers append-only.

MINOR/NIT de la ronda 2 también cerrados: `LOCK TABLE` antes del chequeo de
`FORCE` (la misma carrera aplica al **flag** que decide si el conteo significa
algo); `FORCE` exige ahora **ambos** flags (`relrowsecurity AND
relforcerowsecurity`), porque `FORCE` sin `ENABLE` no aplica RLS y abortar sería
un rechazo falso; el filtro de persistencia acotado a la base actual, a los roles
de los que esta sesión es miembro y al valor `'true'` (un
`ALTER ROLE otro SET … = 'false'` no autoriza nada aquí y no debe bloquear una
erradicación de emergencia); banner de destrucción movido **debajo** de las
guardas, porque los `NOTICE` no se revierten y un rechazo dejaba un log que
parecía el de una destrucción; supuesto de aislamiento `READ COMMITTED`
declarado; alcance real del `client_min_messages` declarado (no puede hacer que
el SQL Editor de Supabase muestre lo que nunca muestra); los otros cuatro canales
de persistencia que este catálogo **no** cubre (`postgresql.conf`,
`ALTER SYSTEM SET`, `PGOPTIONS`, `options=-c` en la cadena de conexión) nombrados
en el límite honesto; y corregido el docstring del helper de lint, que afirmaba
detectar `EXECUTE 'x' || ident` cuando —medido— no lo detecta.

### Mensajes distinguibles

Cada camino emite un mensaje propio, de modo que el log basta para saber qué
pasó: `does not exist — nothing to do (idempotent no-op)` (ausente),
`table is empty — technical rollback before use, no audit data lost` (vacía),
`destroying N decision row(s) under explicit authorisation …` (`WARNING`,
destrucción autorizada) y `dropped (N row(s) destroyed)` (confirmación final).
El bloque de advertencia declara explícitamente que **ningún rollback SQL puede
recuperar filas append-only** una vez destruida la tabla, que sólo un **respaldo
verificado** puede, y que esto es desechable en el stack local pero no en un
entorno real.

### Pruebas

| Comando | Resultado |
|---|---|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | **237/237** en 2 archivos (antes 188 → **+49**) |
| `pnpm test:unit` | **135 archivos, 2544/2544** (antes 2495 → +49, los mismos) |
| `pnpm typecheck` | exit 0, 0 errores |
| `pnpm lint` | exit 0, **0 errores** (51 warnings preexistentes, sin cambio) |
| `pnpm test:rls` | **NO EJECUTADA** — es G3 |

Las pruebas nuevas fijan: ausencia de `DROP TABLE` top-level; `DROP` dentro del
mismo `DO` que la guarda y **después** del `RAISE EXCEPTION`; **ausencia de
`EXCEPTION WHEN`** y exactamente un `BEGIN` y un `RETURN` en el bloque; las
**seis guardas como spans condición→`RAISE EXCEPTION`**, su conteo exacto y su
prefijo común; el orden aislamiento → existencia → propiedad → `LOCK` → `FORCE` → conteo → `DROP`, con cada
offset exigido presente (una comparación `indexOf` pasa **vacuamente** cuando el
término falta); ambos flags de RLS; el filtro de alcance de `pg_db_role_setting`
como span único —con `session_user`, `split_part` en vez de `LIKE`, y el cuerpo del `EXISTS` incluido—; la **región de decisión** (conteo → asignación de autorización → `IF n_rows > 0 THEN`) como **span adyacente verbatim**, más escritura única de `n_rows`, `authorised` y `persisted_at`; la ausencia de `CASCADE` y de `pg_depend`; `EXECUTE` con literal fijo, **seguido
inmediatamente** de `;` o `INTO` (una sonda acotada a la línea no vería
`EXECUTE 'literal'\n || sufijo`); la expresión de autorización fijada **byte a
byte**; ausencia de `::boolean`, `lower()` y `trim()`; `missing_ok = true`; los
cuatro mensajes distinguibles; el aviso de audit trail en su forma
transaccionalmente correcta; los cuatro canales de persistencia no cubiertos;
`lock_timeout`; `client_min_messages`; `search_path`; cero `GRANT`, cero
`ALTER DEFAULT PRIVILEGES`, cero mención ejecutable a
0002/0002b/`evidence_chunks`; y que el archivo no contenga control de
transacción propio.

**Mutation testing.** Las aserciones se validaron contra **25 mutantes** del
propio script: degradar cada una de las cinco guardas a `NOTICE`/`WARNING`;
invertir la condición de `FORCE` y reducirla a un solo flag; `IF n_rows > 0` →
`IF n_rows > 1000000`; insertar `authorised = true;`, `n_rows := 0;` y
`SELECT true INTO authorised`; dejar `persisted_at` en `NULL`; revertir
`session_user` a `pg_has_role(current_user, …)`; quitar el `COALESCE` de la
guarda de propiedad; `AND false` dentro del `EXISTS`; ampliar el filtro de
alcance; eliminar el `LOCK`; sacar el `DROP` del bloque; añadir `CASCADE`;
añadir un `EXCEPTION WHEN OTHERS`; ampliar la autorización a `IN ('true','on')`;
y `IF false THEN` sobre la guarda de autorización; **intercambiar los cuerpos de
las ramas `THEN`/`ELSE`**; añadir un cuarto `SET` top-level de autoautorización
(`SET stella.confirm_destroy_decisions = 'true';`), uno de `lock_timeout = 0` y
uno de `client_min_messages = warning`; y concatenar el literal del `DROP` en la
línea siguiente. **Los 25 fueron detectados.**
El archivo se restauró byte a byte tras cada uno.

Vale la pena registrar el método: las tres primeras rondas de aserciones fijaban
**presencia** (un nombre de catálogo aparece, un mensaje existe, un `indexOf`
precede a otro) y todas resultaron insuficientes. Sólo fijar **spans verbatim
condición→efecto** y **escrituras únicas por variable** cerró la clase. Una
aserción de orden `indexOf(x) < indexOf(y)` además pasa **vacuamente** cuando
`x` falta (`-1 < n`), así que cada offset se exige presente antes de compararse.

### Ronda 4 — dos MAJOR más, ambos en las pruebas y ninguno en el SQL

| # | Hallazgo | Cierre |
|---|---|---|
| **M8** | **La lista de sentencias top-level no estaba acotada.** Ninguna aserción limitaba **cuántas** hay. Una sola línea añadida antes del `DO` derrota una guarda **desde fuera del bloque** — el único lugar al que el argumento estructural no llega: `SET stella.confirm_destroy_decisions = 'true';` hace que **toda ejecución se autoautorice** (`authorised` queda en `true`, `persisted_at` sigue en `NULL` porque un `SET` de sesión no está en `pg_db_role_setting`), y la suite entera seguía verde — el test que busca esa cadena es una aserción **positiva** ya satisfecha por el comentario de cabecera, así que no distingue prosa de sentencia ejecutable. Variantes igual de verdes: `SET lock_timeout = 0;` y `SET client_min_messages = warning;` | Se fija la **lista exacta** de cuatro sentencias top-level, más los literales leídos del fuente crudo, más la prohibición de cualquier `SET stella.` **ejecutable** (con cadenas blanqueadas: el mensaje de aborto sí menciona legítimamente ese `SET`) |
| **M9** | **Se fijaba la condición de la rama, no qué rama contiene qué comportamiento.** Intercambiar verbatim los cuerpos de `THEN` y `ELSE` dejaba la suite verde: una tabla poblada se anunciaba como *"table is empty — no audit data lost"*, se saltaban las tres guardas de autorización, el banner y el `WARNING`, y se destruía. Mismo desenlace que el mutante `IF n_rows > 1000000` de la ronda 3, alcanzado por una mutación que el span no veía | Se fija **qué arma cada rama**: las cinco guardas, el banner y el `WARNING` deben quedar entre `IF n_rows > 0 THEN` y `ELSE`; el `NOTICE` de rollback técnico, después del `ELSE` y antes del `DROP`; y debe haber exactamente **un** `ELSE` |

MINOR/NIT de esta ronda: el mensaje de la guarda de `FORCE` ofrecía reejecutar
con un rol `BYPASSRLS`, remedio que **no puede** levantar un rechazo que es
incondicional — reformulado; el chequeo de terminación de literales se **elevó a
helper compartido** y se aplica ahora a **todos** los scripts preparados (estaba
declarado "por archivo" mientras `stella_0002b`, que usa la misma construcción,
no lo tenía — una verificación declarada y no realizada, justo en el archivo que
persigue eso); el mensaje de la guarda de propiedad nombra ahora también la
posibilidad de que la tabla haya desaparecido entre medias; y se corrigió el
comentario que decía que *todo* lo posterior exige propiedad (sólo el `DROP` la
exige: el conteo necesita `SELECT` y en PG17 `LOCK … ACCESS EXCLUSIVE` acepta
además `MAINTAIN`).

**Un NIT rechazado con evidencia.** El revisor sostuvo que los `CHECK` registran
`deptype='a'`, no `'n'`, y que por tanto la explicación del BLOCKER de la ronda 3
estaba mal atribuida. **Remedido** sobre PostgreSQL 17.6: tanto los dos `CHECK`
como la política tienen filas `deptype='n'` (una por columna referenciada)
**además** de su fila `'a'`. La tabla medida quedó citada verbatim en el
comentario, de modo que la afirmación es ahora falsable.

**Coste honesto registrado.** Al retirar la guarda de dependientes, el `DROP`
pasó a ser el único fallo posible **después** del banner, y los `NOTICE` no se
revierten. Así que en el camino autorizado con un objeto dependiente el log
contiene el banner completo y *"destroying N decision row(s)"* para una
ejecución en la que **no se destruyó nada** — precisamente el "log de un rechazo
que parece un log de una destrucción" que el orden de las guardas evita. Es
inofensivo para los **datos**, no para el **registro**: queda declarado en el
script y en `G2_PACKAGE.md`.

### Ronda 5 — el cambio de método que cierra la clase

Dos MAJOR más, otra vez **enteramente en las pruebas**. Pero esta vez el hallazgo
importante no fue un mutante concreto sino el **diagnóstico**: en cinco rondas
seguidas se añadieron más aserciones de fragmento, y en cada ronda se coló una
mutación nueva.

| Ronda | Mutación que se escapó |
|---|---|
| 2 | `IF NOT authorised AND false THEN` — condición ampliada |
| 3 | `IF n_rows > 1000000` — el flujo de datos, no la condición |
| 4 | cuerpos de `THEN`/`ELSE` **intercambiados** — pertenencia de rama |
| 4 | `SET stella.… = 'true';` **top-level** — fuera del bloque `DO` |
| 5 | `IF false THEN` **envolviendo** una guarda ya fijada, una línea más afuera |
| 5 | `persisted_at := NULL;` insertado justo antes de su propia guarda |
| 5 | `PERFORM set_config('stella.confirm_destroy_decisions','true',true)` **dentro** del bloque, donde la lista de sentencias top-level no llega |

Cada fragmento fija una forma más y deja el complemento abierto. **La clase no se
cierra añadiendo fragmentos.** La única forma de aserción completa es fijar el
**cuerpo ejecutable entero** del bloque `DO`: todas las sentencias, en orden, con
su anidamiento.

Lo que se fija es el cuerpo con comentarios quitados, **literales blanqueados** y
espacios colapsados, comparado byte a byte contra una constante. Blanquear los
literales mantiene la aserción legible —los mensajes `RAISE` son la mayor parte
de los bytes del archivo— y separa las dos preocupaciones: esta prueba es dueña
de la **estructura**, y las pruebas por mensaje siguen siendo dueñas del
**texto**.

**El coste es deliberado.** Cualquier edición del SQL obliga a actualizar la
constante. Para un script que borra un audit trail, eso es exactamente lo que se
quiere: ningún cambio de lógica ejecutable puede entrar sin aparecer en un diff
que alguien tiene que aprobar.

MINOR/NIT de esta ronda: el helper de terminación de literales admite ahora
`EXECUTE '<literal>' USING …` (forma segura: pasa **parámetros**, no puede
alterar el texto de la sentencia); la tabla de medición de `pg_depend` declara
ahora su consulta exacta y su salida **completa** de 15 filas, en vez de un
extracto con un filtro no declarado; el script muestra por fin **la invocación
autorizada que funciona** (`psql -c "SET …" -f …`, una sola sesión) y explica por
qué un `psql -c` separado **no** sirve —es otra sesión— y por qué el atajo obvio
(`ALTER ROLE … SET`) queda rechazado por la guarda de persistencia; y se
corrigieron un antecedente contradictorio en el comentario de propiedad y la
mención obsoleta a un chequeo "por archivo" que ya es compartido.

**58 mutantes acumulados, los 58 detectados**, incluidos los siete de esta ronda
y `LOCK … NOWAIT`.

### Ronda 6 — el supuesto que estaba documentado en vez de impuesto

Dos MAJOR. El primero es el **primer defecto en el SQL desde la ronda 3**, y su
diagnóstico es incómodo por lo exacto: yo había **documentado** el supuesto de
aislamiento en un comentario y declarado "fuera de contrato" cualquier otra
cosa — que es **precisamente el defecto que este archivo dedica 400 líneas a
eliminar**, reintroducido un párrafo después de cerrarlo para las banderas de
`psql`.

| # | Hallazgo | Cierre |
|---|---|---|
| **M10** | **Aislamiento: documentado, no impuesto.** Bajo `REPEATABLE READ` o `SERIALIZABLE` el snapshot de la transacción se fija en su primera consulta con snapshot — bajo la invocación prescrita, la primera del bloque, **antes** del `LOCK`. Una fila confirmada por otra sesión en esa ventana es **invisible** para el conteo: `n_rows = 0`, rama `ELSE`, se saltan **las tres** guardas de autorización, y un audit trail poblado se destruye con un log que **certifica que no se perdió nada**. Y a diferencia de los cuatro canales de persistencia que sí son inobservables desde SQL, **éste sí lo es**: `current_setting('transaction_isolation')` no requiere privilegio | **Sexta guarda**, y la **primera** del bloque: `NOT IN ('read committed','read uncommitted')` → aborta con prefijo nombrando el nivel. Va primera porque bajo un snapshot fijo **todo** lo que el bloque lee es potencialmente rancio respecto al `LOCK`, no sólo el conteo. `READ UNCOMMITTED` se acepta porque PostgreSQL lo implementa **como** `READ COMMITTED` |
| **M11** | **La medición de `pg_depend` decía "Complete output (15 rows)" y no lo era.** Se había tomado contra una fixture **reducida** —sin las 4 FK y con un solo índice— y aun así se declaraba completa: el mismo defecto que el archivo descalifica en todas partes | Remedido contra el conjunto **completo** que crea el script forward (11 columnas, PK, 4 FK, 2 CHECK, 2 índices, política RLS, 2 triggers, 2 defaults) = **20 filas**, pegadas verbatim, con el subconteo anterior señalado explícitamente |

MINOR/NIT: tres comentarios citaban un banner con la palabra *"irreversible"*
que el propio archivo había **eliminado** por inexacta —el DDL es transaccional
y `ROLLBACK` sí deshace hasta el `COMMIT`—, de modo que la justificación del
orden de las guardas descansaba sobre texto retirado por falso; el resumen del
helper de terminación no mencionaba `USING`; el antecedente *"miembro del rol
dueño"* contradecía el propio párrafo sobre `NOINHERIT` (un miembro `NOINHERIT`
**es** miembro y aun así falla la prueba `'USAGE'`, correctamente); la redacción
del snapshot decía "la primera consulta del bloque" cuando es la primera **de la
transacción**; y la referencia a una "sección 4" apuntaba en realidad al script
forward — este rollback no tiene secciones numeradas.

**Escenarios nuevos (S20–S24):** `REPEATABLE READ` y `SERIALIZABLE` abortan con
prefijo y la fila sobrevive; `READ COMMITTED` y `READ UNCOMMITTED` proceden sin
rechazo falso; y bajo `REPEATABLE READ` la guarda dispara **incluso con la tabla
ausente**, lo que confirma que corre primero. **40 mutantes acumulados, los 40
detectados**, incluidos cinco contra la guarda nueva.

### Ronda 7 — una premisa que se resuelve midiendo, no añadiendo guarda

Un MAJOR, y su resolución es instructiva porque **no** consistió en endurecer más.

**El hallazgo.** La guarda de propiedad admite deliberadamente **más** que el
dueño exacto: `pg_has_role(…, 'USAGE')` también deja pasar a un rol que
**hereda** los privilegios del dueño — y eso es correcto, porque es el mismo
predicado que usa `DROP TABLE`. Pero la guarda de `FORCE` concluye de ahí que,
con `FORCE` apagado, el conteo es fiable, y **esa** conclusión se había medido
sólo para el dueño exacto. El bypass de RLS del owner y la comprobación de
propiedad de `DROP` son rutas de código distintas: su coincidencia **no puede
asumirse**. Si no coincidieran, un miembro del rol dueño pasaría la guarda de
propiedad, pasaría la de `FORCE`, contaría **0** por la política org-scoped sin
JWT, y destruiría la tabla bajo el log de *"no audit data lost"* — sin `FORCE`
encendido en ningún momento.

**La resolución: medirlo.** Sobre PostgreSQL 17.6, `FORCE` apagado, RLS activa,
política `USING(false)`, una fila presente:

| Rol | `count(*)` |
|---|---|
| dueño exacto (`NOBYPASSRLS`) | **1** |
| miembro `INHERIT` del dueño (`NOBYPASSRLS`) | **1** |
| `pg_has_role(miembro, dueño, 'USAGE')` | `true` |

El bypass de RLS **sí sigue la membresía**, con el mismo predicado que la guarda.
Los dos conjuntos **coinciden**, así que ningún llamador puede pasar la guarda de
propiedad y leer un conteo filtrado por RLS. Un miembro `NOINHERIT` es rechazado
antes, por la propia guarda de propiedad, y nunca llega al conteo. **No se añadió
una séptima guarda**: se sustituyó una premisa afirmada por una premisa medida, y
la medición quedó registrada junto a la de `FORCE`.

**Un error de sintaxis SQL introducido y detectado en el acto.** Al reformular el
mensaje de la guarda de propiedad escribí `owning role's privileges` **dentro de
un literal entrecomillado**: el apóstrofe cierra la cadena. La suite offline lo
detectó de inmediato —ocho aserciones en rojo, porque el desbalance de comillas
propaga— y quedó corregido a `''`. Verificación posterior: **47 literales en el
archivo, todos balanceados; los 3 con apóstrofe, correctamente escapados**, y el
script vuelve a parsear y ejecutar contra un PostgreSQL vivo.

MINOR/NIT: el mensaje de la guarda de propiedad decía *"no es miembro del rol
dueño"*, que su propio comentario contradice (un miembro `NOINHERIT` **sí** es
miembro y aun así falla, correctamente) — reformulado a *"no hereda los
privilegios"* con la salida real (`SET ROLE <owner>`); el listado de `pg_depend`
se reetiquetó como **transcripción** (nombres elididos, filas plegadas, orden
impuesto) nombrando la fixture de forma completa que lo produjo; el argumento
`%` del mensaje de aislamiento quedó fijado hasta
`, current_setting('transaction_isolation');` —sin eso, cambiarlo por
`default_transaction_isolation` dejaba la suite verde y producía un rechazo que
se contradice a sí mismo—; *"todo lo que el bloque lee"* se acotó a *"lee **a
través de una consulta**"* (las búsquedas de syscache usan el snapshot de
catálogo, que es más fresco, no más rancio); y la línea de idempotencia de la
cabecera menciona ahora la precondición de aislamiento.

**50 mutantes acumulados, los 50 detectados.**

### Ronda 8 — una estrechez que resulta ser portante

Un MAJOR, sutil: mi comentario afirmaba que `DROP TABLE` pasa por
`object_ownercheck → has_privs_of_role()`. Es **incompleto**.
`RangeVarCallbackForDropRelation` hace una **segunda** comprobación y admite
también al **dueño del esquema**. La guarda es por tanto más **estrecha** que la
regla real de `DROP` — cerrada por defecto, sin riesgo inmediato — pero eso
significa que el comentario afirma algo falso **y**, peor, que la estrechez es
**portante** sin que nada lo registre: un lector futuro que "corrigiera" la
guarda para igualarla a la regla documentada reintroduciría el MAJOR de la ronda
7.

**Medido** en PostgreSQL 17.6 (esquema de `sch_owner`, tabla de `tbl_owner`, RLS
activa, `FORCE` apagado, política `USING(false)`, una fila):

| Comprobación | Resultado |
|---|---|
| `pg_has_role('sch_owner','tbl_owner','USAGE')` | **false** |
| `SELECT count(*)` como `sch_owner` | **permission denied** |
| `DROP TABLE` como `sch_owner` | **ejecutado sin error** |

Es decir: **el dueño del esquema puede DESTRUIR la tabla sin poder CONTARLA.**
Ampliar la guarda lo dejaría llegar al conteo, obtener 0 (o un error de permisos
sin prefijo), tomar la rama *"table is empty — no audit data lost"* y destruir un
audit trail poblado — sin `FORCE` encendido en ningún momento. Queda registrado
en el script con el mismo tratamiento de *"anotado para que no lo 'arreglen'
luego"* que ya tenía la decisión de retirar la guarda de dependientes, y un
mutante que la amplía al dueño del esquema ahora se detecta.

MINOR: la afirmación *"aplicado a TODOS los scripts preparados"* era falsa —
medido, se invocaba desde cuatro `describe` y **no** desde los rollbacks de
0002/0002b; ahora hay un **barrido de directorio** sobre los seis scripts
`stella_*`, y el comentario declara que los `grounding_*` pertenecen a otro
archivo de pruebas y **no** están cubiertos. Y la suite fijaba la estructura por
completo pero el **registro operativo** sólo en parte: sobrevivía un mutante que
dejaba todas las guardas armadas e **invertía lo que el log dice** sobre la
destrucción (*"nada de valor se borra; esta ejecución es totalmente
reversible"*). Los cuatro mensajes operativos quedan ahora fijados **byte a
byte**.

NIT: se corrigieron dos afirmaciones sobre internals que el propio archivo
contradecía —que las rutas de RLS y `DROP` "no pueden asumirse coincidentes"
(resuelven al mismo predicado; lo que faltaba era la **evidencia**, no el
argumento) y que los conjuntos "COINCIDEN" (sólo se midió, y sólo hace falta, la
contención *admitidos ⊆ que evaden RLS*: cualquier rol `rolbypassrls` evade sin
ser miembro del dueño)—; y la fixture de 20 filas se declara construida **ad
hoc** y no versionada, con receta para recrearla.

**54 mutantes acumulados, los 54 detectados.**

### Ronda 9 — cierre

**0 BLOCKER, 0 MAJOR.** El revisor declara el SQL entregado listo y, explícitamente,
**no logra construir ninguna mutación que cambie lo que el script *hace* dejando
la suite verde**. Verificó además, de forma independiente, que el conjunto de
llamadores que admite la guarda de propiedad es *idéntico* al predicado de
`object_ownercheck` de PostgreSQL menos el brazo del esquema, excluido a
propósito.

Los dos MINOR restantes eran sobre el **registro** y el **harness**, no sobre la
lógica destructiva, y se corrigieron igualmente:

- **el banner de destrucción era el último texto operativo sin fijar** en el
  camino destructivo. El skeleton fija el *número* de `RAISE NOTICE`, así que no
  se podía borrar una línea — pero sí **reemplazar su texto**: convertir *"only a
  verified restore can, so one must exist"* en *"…though one is rarely needed"*
  dejaba la suite entera verde. Es la precondición de toda la operación
  invertida, en el camino de emergencia, en el texto que el operador lee justo
  cuando decide. Las **13 líneas** del banner quedan fijadas verbatim, y también
  la **cláusula de remedio** de los seis abortos;
- **el "barrido de directorio" de la ronda 8 era una lista fija.** Leía el
  directorio, pero sólo para una comprobación de igualdad de conjuntos; el
  `it.each` iteraba un array codificado a mano. Un `stella_0004` nuevo habría
  fallado *sólo* esa igualdad, la reparación natural es añadirlo a **ese** array,
  y el script habría salido sin barrer mientras el comentario del SQL seguía
  afirmando cobertura — el MINOR de la ronda 8 reinstalado en forma latente
  dentro de su propio arreglo. Ahora el `it.each` itera el listado del
  directorio y la igualdad queda como **tripwire**.

**58 mutantes acumulados, los 58 detectados.**

### Alcance

**Cero escrituras en la base viva** (verificado antes y después: tabla presente,
**1** decisión, **2** interacciones, **10** triggers append-only, **104**
policies, `evidence_chunks` ausente, ACL `authenticated: SELECT`). Cero acceso
remoto. **Rollback NO ejecutado.** Respaldo pre-G3 **no restaurado** y con
SHA-256 sin cambio (`d46280c4…b436aeb`). Cero reset. Cero G3. Cero
`grounding_0001`. Cero cambios en `db/schema.ts`, `db/migrations`,
`stella_0002` o `stella_0002b`. Otros stacks (`uellix-antigravity`, `aforiq`)
intactos. **Cero ejecución formal de G2.**

**Siguiente paso:** ensayo destructivo controlado del rollback contra el stack
local desechable — ejecutado el 2026-08-02, ver
[STELLA 0003 ROLLBACK REHEARSAL — RUN 1](#stella-0003-rollback-rehearsal--run-1).

## STELLA 0003 ROLLBACK REHEARSAL — RUN 1

> **No es la aprobación formal de G2.** Ensayo destructivo controlado sobre el
> stack local desechable. Ninguna casilla de `docs/ops/gates/G2_PACKAGE.md`
> queda marcada por esta corrida, y el gate remoto sigue **sin ejecutar**.

Primera ejecución real de `db/prepared/stella_0003_rollback.sql` contra un
PostgreSQL vivo. Hasta esta corrida el rollback sólo estaba verificado
*estructuralmente* (246 pruebas sobre el texto del archivo, 58 mutantes
detectados en 9 rondas de revisión adversarial): nunca había borrado nada.

| Campo | Valor |
|---|---|
| Fecha | 2026-08-02 |
| Branch | `codex/stella-g2-local-rehearsal` |
| HEAD inicial | `12715d8916b0613fdae1ccf76f25ead6fb56c4b0` |
| `project_id` (config.toml) | `uellix-stella-g2-local-rehearsal` |
| Contenedor | `supabase_db_uellix-stella-g2-local-rehearsal` |
| Motor | PostgreSQL 17.6 |
| API / DB locales | `127.0.0.1:56321` / `127.0.0.1:56322` |
| Script | `db/prepared/stella_0003_rollback.sql` (590 líneas, 39 498 bytes) |

### Respaldo — verificado, duplicado, **no** restaurado

El rollback destruye un audit trail append-only: después del `COMMIT` sólo un
restore lo recupera. Por eso el respaldo se validó *antes* de tocar nada, y se
duplicó fuera de `TEMP` para que la limpieza automática del sistema no pueda
dejar la evidencia sin copia.

| Campo | Valor |
|---|---|
| Respaldo original | `%TEMP%\uellix-g3-local-backup\pre_g3_local.dump` |
| Tamaño | 581 736 bytes (exacto al esperado) |
| SHA-256 original | `d46280c4261cc8b68896dd34b12f41d9334756a61f7a2f2a3c441aef5b436aeb` |
| Segunda copia estable | `%LOCALAPPDATA%\uellix-stella-evidence\pre_g3_local.dump` |
| SHA-256 segunda copia | `d46280c4261cc8b68896dd34b12f41d9334756a61f7a2f2a3c441aef5b436aeb` |
| Coincidencia | **sí**, byte a byte |
| `pg_restore -l` | 1155 entradas TOC · 87 `TABLE DATA` (exacto a lo esperado) |
| Restauración | **NO ejecutada** (ni original ni copia) |

La segunda copia vive fuera del repositorio, fuera de `TEMP` y fuera de
cualquier carpeta sincronizada (`%LOCALAPPDATA%` está excluido de OneDrive por
diseño). El listado del TOC se hizo por `stdin` hacia un `pg_restore` dentro del
contenedor: lectura pura, sin ruta de escritura hacia la base.

### Identidad del artefacto ejecutado

A diferencia de `stella_0003_suggestion_decisions.sql` (CRLF en disco, tres
hashes distintos), el rollback está en **LF** en el working tree: los bytes que
`psql` leyó y los que Git almacena son los mismos, y dos de las tres identidades
colapsan en un solo valor.

| Identidad | Valor |
|---|---|
| SHA-256 working tree | `e9498d02493ca1fb8eacad8084e0930a783530fcf40d7cf2295008bfb4c12e4b` |
| SHA-256 canónico Git | `e9498d02493ca1fb8eacad8084e0930a783530fcf40d7cf2295008bfb4c12e4b` (idéntico — archivo LF) |
| Git blob ID | `812112309bfd1dc306cace47925e7b9b646224de` |
| Blob registrado en `HEAD` | `812112309bfd1dc306cace47925e7b9b646224de` (coincide) |
| `git diff HEAD` sobre la ruta | vacío — cero modificaciones posteriores |
| SHA-256 recalculado **dentro del contenedor** | `e9498d02…c4b12e4b` (coincide antes de ejecutar) |

Estructura re-verificada sobre el archivo, no sobre el recuerdo de las pruebas:

- **4 sentencias top-level**: `SET search_path`, `SET lock_timeout='5s'`,
  `SET client_min_messages=notice`, y un único bloque `DO $$ … $$`;
- **cero `DROP` top-level**. El único `DROP` es
  `EXECUTE 'DROP TABLE public.stella_suggestion_decisions'` (línea 587),
  **dentro** del `DO` y detrás de las seis guardas;
- **literal fijo, cero SQL construido**: sin `format()`, sin `quote_ident`, sin
  concatenación de identificadores en ningún `EXECUTE`;
- **autorización exacta**:
  `current_setting('stella.confirm_destroy_decisions', true) = 'true'`;
- **6 guardas / 6 mensajes de aborto** (aislamiento, tabla ausente → no-op,
  propiedad, FORCE RLS, autorización, autorización persistida).

### Preflight — precondiciones confirmadas por `SELECT`

Working tree limpio, staging vacío, sin operación Git en curso, historial del
segmento de ensayo lineal (`98f21f4..HEAD` sin merges), HEAD exacto al esperado.
Contenedor `healthy`, PostgreSQL 17.6, `session_replication_role = origin`.

| Precondición | Estado pre-rollback |
|---|---|
| `public.stella_suggestion_decisions` | presente |
| filas en decisions | **1** |
| filas en `stella_interactions` | **2** |
| `public.evidence_chunks` | ausente (`to_regclass` → `NULL`) |
| RLS decisions | activo |
| FORCE RLS decisions | apagado |
| policy `stella_suggestion_decisions_select` | presente (1, `SELECT`) |
| ACL decisions | `authenticated = SELECT` únicamente |
| `service_role` / `anon` / `PUBLIC` sobre decisions | sin privilegios |
| triggers append-only (`uellix_forbid_mutation`) | **10** |
| config persistida `stella.confirm_destroy_decisions` | **0 entradas** en `pg_db_role_setting` |

Línea base capturada en un solo script de solo lectura (tablas, policies,
triggers, flags RLS, ACL, índices, constraints, funciones, migraciones, filas
relevantes y `pg_stat_user_tables`) — **1166 líneas, cero escrituras**.

| Contador | Pre |
|---|---|
| tablas `public` | 38 |
| policies `public` | 104 |
| triggers de usuario `public` | 10 (todos append-only) |
| índices `public` | 119 |
| constraints `public` | 230 |
| funciones `public` | 8 |
| migraciones (`supabase_migrations`) | 2 |
| grants no-owner | 461 |

### 1ª ejecución — destructiva, autorizada

Un solo proceso `psql`, una sola conexión, una sola transacción externa (`-1`).
La autorización se declaró **en la misma sesión** que el archivo, vía `-c` que
precede al `-f`:

```bash
psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 \
  -c "SET stella.confirm_destroy_decisions = 'true';" \
  -f /tmp/stella_0003_rollback.sql
```

Sin `ALTER ROLE`, sin `ALTER DATABASE`, sin `PGOPTIONS`, sin ninguna
configuración persistente: la guarda de `pg_db_role_setting` habría abortado la
corrida si la autorización hubiera sido permanente en lugar de por sesión.

| Registro | Valor |
|---|---|
| Inicio / fin (UTC) | `2026-08-02T08:19:30Z` → `2026-08-02T08:19:31Z` |
| Duración | ~1 s |
| Hash ejecutado | `e9498d02…c4b12e4b` |
| Código de salida | **0** |
| `stdout` | `SET` ×4 (1 de `-c` + 3 del archivo), `DO` |
| Filas detectadas | **1** |
| Banner destructivo | presente, 13 líneas verbatim |
| `WARNING` | presente (1) |
| `NOTICE` final | `public.stella_suggestion_decisions dropped (1 row(s) destroyed). Re-running this file is now a no-op.` |
| Resultado del `DROP` | tabla eliminada, transacción confirmada |

### Postchecks — el delta es cerrado

Comparación línea base pre/post. **Cada línea que cambió pertenece a
`stella_suggestion_decisions` o es un contador que refleja exactamente esa
remoción.** Ningún otro objeto desapareció.

| Contador | Pre | Post | Δ |
|---|---|---|---|
| tablas `public` | 38 | 37 | **−1** |
| policies `public` | 104 | 103 | **−1** |
| triggers append-only | 10 | 8 | **−2** |
| índices `public` | 119 | 116 | **−3** |
| constraints `public` | 230 | 223 | **−7** |
| grants no-owner | 461 | 460 | **−1** |
| funciones `public` | 8 | 8 | 0 |
| migraciones | 2 | 2 | 0 |

Confirmado por `SELECT` tras el `DROP`:

- `to_regclass('public.stella_suggestion_decisions')` → `NULL`; cero relaciones
  con ese nombre, cero índices y cero constraints con ese prefijo;
- su policy, sus 2 triggers append-only, sus 3 índices, sus 7 constraints y su
  grant `authenticated=SELECT` ya no existen;
- sus filas ya no existen **porque la tabla fue eliminada**, no por `DELETE` —
  los triggers append-only prohíben `UPDATE`/`DELETE`/`TRUNCATE` pero no `DROP`,
  que se los lleva por delante junto con la tabla;
- `public.stella_interactions` presente, **2** filas, RLS y policy intactas;
- las otras 4 tablas append-only intactas, con **8** triggers restantes;
- `uellix_forbid_mutation()` intacta; `evidence_chunks` sigue ausente;
- `organizations` **3**, `users` **9**, `projects` **2**,
  `organization_members` **7** — sin cambio. Las FKs de decisions eran
  *salientes*; el `DROP` sin `CASCADE` se llevó al hijo, nunca a los padres.

**Sólo se perdió el audit trail de suggestion decisions, que es exactamente lo
autorizado.**

### 2ª ejecución — idempotencia, sin autorización

Sesión nueva, **sin** declarar `stella.confirm_destroy_decisions`:

```bash
psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 \
  -f /tmp/stella_0003_rollback.sql
```

| Registro | Valor |
|---|---|
| Código de salida | **0** |
| `stdout` | `SET` ×3, `DO` |
| Salida | `NOTICE: … does not exist — nothing to do (idempotent no-op).` |
| Banner destructivo | **ausente** (0 ocurrencias) |
| `WARNING` | **ausente** (0 ocurrencias) |
| Modificaciones adicionales | ninguna |

Línea base re-capturada tras la segunda corrida: **idéntica byte a byte** a la
del postcheck. La guarda de tabla ausente devuelve antes de llegar a cualquier
comprobación de autorización, que es por qué el no-op no exige permiso
destructivo — no hay nada que destruir.

### Pruebas offline

| Suite | Resultado |
|---|---|
| `tests/prepared-stella-sql.test.ts` + `tests/prepared-sql-source-of-truth.test.ts` | **246 / 246** (2 archivos) |
| `pnpm test:unit` | **2553 / 2553** (135 archivos) |
| `pnpm typecheck` | limpio |
| `pnpm lint` | **0 errores**, 51 warnings preexistentes |

Las 246 pruebas focalizadas siguen verdes **después** del `DROP`: son pruebas de
*fuente de verdad* sobre el texto del SQL (hash, sentencias top-level, guardas,
mensajes de aborto verbatim), no sobre el estado de la base. No se ejecutaron
`pnpm test:rls`, `pnpm test:integration`, G3 ni `grounding`.

### Alcance

**Cero acceso remoto** — todo por `docker exec` contra el contenedor local; sin
`supabase login`, `link`, `push` ni `pull`. **Cero restore** (ni del original ni
de la copia). **Cero reset** del stack y del volumen. **Cero G3.** **Cero
`grounding_0001`.** **Cero rollback de `stella_0002` / `stella_0002b`.** Sin
cambios en default privileges, sin desactivar triggers, sin tocar
`session_replication_role` (`origin` antes y después). Sin `push` ni PR. Otros
stacks (`uellix-antigravity`, `aforiq`) intactos. **Cero ejecución formal de
G2.**

**Riesgo residual:** el ensayo prueba el rollback contra un esquema local con
volumen mínimo (1 decisión, 2 interacciones). No mide contención de bloqueo
bajo carga concurrente: `lock_timeout='5s'` frente a un `ACCESS EXCLUSIVE` sobre
una tabla activa es un comportamiento aún no observado. Tampoco valida el camino
en el que el dueño de la tabla **no** es el rol de conexión.

**Siguiente paso:** auditoría post-rollback independiente. El RUN 2 (FULL
REBUILD) **no** queda autorizado por esta corrida.

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

## STELLA FULL REBUILD — RUN 2

> **Sigue sin ser G2 formal.** RUN 2 destruye el stack local desechable, lo
> reconstruye desde cero y vuelve a aplicar `stella_0002`, `stella_0002b` y
> `stella_0003` sobre un volumen nuevo, para demostrar que RUN 1 es
> **reproducible** y no un artefacto de un estado heredado. Cero remoto, cero
> restore, cero `grounding_0001`, cero G2 formal.

| Campo | Valor |
|---|---|
| Fecha | 2026-08-02, 03:44–04:03 (hora local) · `2026-08-02T08:44Z`–`09:03Z` |
| Branch | `codex/stella-g2-local-rehearsal` |
| HEAD inicial | `92d7c61014fef455ff49553d0d89a284e5796b49` |
| Working tree al arrancar | limpio · staging vacío · sin operaciones Git en curso |
| Historial | lineal desde el merge de integración `c28c135`; el ensayo no introduce merges |
| `project_id` | `uellix-stella-g2-local-rehearsal` |
| API / DB local | `127.0.0.1:56321` / `127.0.0.1:56322` |
| Acceso remoto | ninguno — sin `login`/`link`/`db push`/`db pull`; `supabase/.temp` sin `project-ref` |

### Preflight — respaldos reverificados, no restaurados

| Comprobación | Resultado |
|---|---|
| Respaldo original | `%TEMP%\uellix-g3-local-backup\pre_g3_local.dump` — presente, 581 736 B |
| Copia estable | `%LOCALAPPDATA%\uellix-stella-evidence\pre_g3_local.dump` — presente, 581 736 B |
| SHA-256 (ambos) | `d46280c4261cc8b68896dd34b12f41d9334756a61f7a2f2a3c441aef5b436aeb` |
| Ubicación | fuera del repositorio · no versionados · `git check-ignore` confirma que están fuera del árbol · cero `*.dump` dentro del repo |
| `pg_restore -l` | **1155 entradas TOC · 87 `TABLE DATA`** — exacto |
| Aislamiento del listado | contenedor efímero `--network none`; el dump entró por `stdin`, el contenedor nunca recibió un descriptor de fichero al archivo |
| SHA-256 tras la lectura | idéntico — el respaldo no fue tocado |
| Restore | **NO EJECUTADO** |

> El bind-mount read-only no era viable: Docker Desktop no expone
> `AppData\Local` en su file-sharing y el montaje aparece vacío dentro del
> contenedor. La vía por `stdin` es estrictamente más restrictiva y es la
> misma que usó RUN 1.

### Línea base final de RUN 1 (capturada antes de destruir)

Un único script de solo lectura — tablas, columnas, constraints, índices,
policies, ACL vía `aclexplode`, triggers con `tgtype`/`tgenabled`, funciones con
hash de cuerpo, migraciones y conteos. **1878 líneas, cero escrituras**,
conservada fuera del repositorio en `%LOCALAPPDATA%\uellix-stella-evidence\run1\`.
Sin identificadores ni contenido de filas.

| Contador (RUN 1, post-rollback) | Valor |
|---|---|
| tablas `public` | 37 |
| policies `public` | 103 |
| índices `public` | 116 |
| constraints `public` | 223 |
| triggers append-only | 8 |
| `stella_suggestion_decisions` | ausente |
| `evidence_chunks` | ausente |
| organizations / users / projects / memberships | 3 / 9 / 2 / 7 |
| `stella_interactions` | 2 |
| `uellix_forbid_mutation()` SHA-256 | `cd918f70…73cb98f` |

### Identidad de los tres scripts

| Script | SHA-256 working tree | SHA-256 canónico Git | Blob |
|---|---|---|---|
| `stella_0002_interactions_hardening.sql` | `11b79215…78c05e6` ✔ documentado | `bdf5f8dc…24858cd` | `0a830f4f…` |
| `stella_0002b_append_only_truncate_hardening.sql` | `781e8b58…7aace550` ✔ documentado | `781e8b58…7aace550` (idéntico) | `869a54de…` |
| `stella_0003_suggestion_decisions.sql` | `6caa5ca9…fd1c6b7d1` ✔ documentado | `ad22e22c…ce778fab5` ✔ documentado | `00c17b04…` |

`git diff HEAD` vacío sobre las tres rutas. Los tres archivos están en **CRLF**
en el working tree; el blob de `0002b` también, por eso dos de sus tres
identidades colapsan.

### Inventario de destrucción

Allowlist construida por **label Docker**, no por prefijo de nombre —
`com.supabase.cli.project=uellix-stella-g2-local-rehearsal`. Es la distinción
que importa: `supabase_db_uellix-antigravity` y
`supabase_db_uellix-stella-g2-local-rehearsal` comparten prefijo pero nunca
label.

| Clase | Conteo | Recursos |
|---|---|---|
| Contenedores | 10 | `supabase_{db,kong,auth,rest,realtime,storage,studio,pg_meta,edge_runtime,inbucket}_uellix-stella-g2-local-rehearsal` |
| Volúmenes | 3 | `supabase_{db,storage,edge_runtime}_uellix-stella-g2-local-rehearsal` |
| Redes | 1 | `supabase_network_uellix-stella-g2-local-rehearsal` |

Ningún volumen objetivo estaba compartido: verificado con
`docker ps --filter volume=<nombre>` — cada uno sólo lo usaba un contenedor del
propio stack objetivo.

Denylist explícita: todo recurso de `uellix-antigravity`, de `aforiq`, y los
volúmenes ajenos `supabase_db_AlumniGraph`, `supabase_db_we4u-platform`,
`supabase_storage_*` de esos proyectos, `supabase_edge_runtime_` (sufijo vacío),
el volumen huérfano por hash y el contenedor `uellix-db`.

### Destrucción — `pnpm supabase stop --no-backup`

Sin `docker system prune`, sin `docker volume prune`, sin wildcards, sin
borrado por prefijo. Un solo comando, acotado por el `project_id` del
`config.toml` del directorio de trabajo.

| Verificación posterior | Resultado |
|---|---|
| Contenedores del stack objetivo | **0** (por label y por nombre) |
| Volumen de DB objetivo | ausente |
| Volúmenes `storage` / `edge_runtime` objetivo | ausentes |
| Red objetivo | ausente |
| Puerto 56321 / 56322 | cerrados |
| `uellix-antigravity` | **mismos IDs de contenedor, mismos estados** que antes |
| `aforiq` | **mismos IDs de contenedor, mismos estados** que antes |
| Respaldos | tamaño y SHA-256 idénticos tras la destrucción |
| Repositorio | `git status` vacío, HEAD sin cambios |

> Anomalías **preexistentes y ajenas** registradas antes de tocar nada, para que
> no se lean como daño colateral: `supabase_edge_runtime_uellix-antigravity`
> ya estaba `Exited (255)`, `supabase_vector_uellix-antigravity` ya estaba en
> `Restarting`, y `uellix-db` llevaba 2 semanas parado. Los tres siguen igual.

### Stack limpio

`pnpm supabase start` desde `supabase/config.toml`. Mismo `project_id`, mismos
puertos, analytics/vector/imgproxy/pooler deshabilitados por configuración
(la CLI los reporta como *Stopped services*). Cero link, cero pull, cero datos
restaurados, cero datos copiados del stack anterior.

| Verificación | Resultado |
|---|---|
| PostgreSQL | **17.6** (`x86_64-pc-linux-gnu`) |
| Contenedores | 10, todos healthy, **IDs nuevos** (volumen nuevo) |
| API / DB / Studio | `56321` / `56322` / `56323` en escucha |
| Auth / Storage | healthy |
| `public` en el arranque | **0 tablas** — base genuinamente nueva |
| `supabase/migrations/` | 2 aplicadas por la CLI: 2 triggers en `auth.users`, `public.handle_new_user()`, 3 policies en `storage.objects` |
| `.env.local` | válido **sin editar** — la CLI local deriva `anon`/`service_role` de un *JWT secret* de demo fijo, no de un valor por volumen |

### Base build desde cero

| Paso | Resultado |
|---|---|
| `pnpm db:migrate:local` | 40/40 Drizzle, `drizzle.__drizzle_migrations` = 40 filas, 0 errores |
| `001_unique_constraints.sql` | aplicada; ambos `PRECHECK` → 0 filas; índices ya presentes por la cadena Drizzle (`IF NOT EXISTS` los preservó) |
| `002_append_only.sql` | aplicada; `uellix_forbid_mutation()` + 3 triggers |
| `003_numeric_columns.sql` | **NO aplicada** — `ALREADY_SATISFIED_ON_FRESH_DRIZZLE_BUILD`, igual que RUN 1 |
| `db/policies/` (8) | 8/8, cada una en su propia transacción (`-1 -v ON_ERROR_STOP=1`), 0 errores |
| `pnpm db:seed:local` | 2 orgs, 8 usuarios sintéticos (guarda de host activa) |
| `pnpm db:seed:stella-local` | 1 proyecto + 1 interacción sintéticos |
| `db:seed:proxies` / `db:seed:taxonomies` | **NO ejecutados** |
| `grounding_0001` | **NO ejecutado** |

Contrato base verificado **antes** del endurecimiento Stella:

| Contador | Esperado | Obtenido |
|---|---|---|
| organizaciones sintéticas | 2 | 2 ✔ |
| usuarios sintéticos | 8 | 8 ✔ |
| membresías sintéticas | 6 | 6 ✔ |
| proyectos sintéticos | 1 | 1 ✔ |
| interacciones Stella sintéticas | 1 | 1 ✔ |
| `stella_suggestion_decisions` | ausente | ausente ✔ |
| `evidence_chunks` | ausente | ausente ✔ |
| datos reales | 0 | 0 ✔ |
| tablas / policies / índices / constraints | 37 / 103 / 116 / 223 | idénticos a RUN 1 pre-0003 ✔ |
| `uellix_forbid_mutation()` SHA-256 | `cd918f70…73cb98f` | idéntico a RUN 1 ✔ |

### `stella_0002`

Aplicada dos veces, `docker exec … psql -1 -v ON_ERROR_STOP=1`, archivo exacto
por `stdin`, sin modificar. Salida idéntica salvo los `NOTICE` de
*does not exist, skipping* de la primera pasada. **Idempotente.**

`stella_interactions`, `audit_logs`, `sroi_calculation_runs` y
`sroi_calculation_line_items` intactas · 4 triggers `UPDATE/DELETE` ·
`authenticated` sin `UPDATE/DELETE` · `anon`/`PUBLIC` sin grants · RLS y
policies intactas · datos sintéticos preservados.

### `stella_0002b`

Aplicada dos veces. Ambas pasadas imprimen
`verification passed — 4 TRUNCATE triggers attached, 0 residual dangerous grants, SELECT/INSERT preserved`.
**Idempotente.**

| Verificación | Resultado |
|---|---|
| Triggers `TRUNCATE` | 4 (`tgtype=34` = `BEFORE TRUNCATE FOR EACH STATEMENT`) |
| Triggers append-only totales | 8 |
| `UPDATE` / `DELETE` / `TRUNCATE` | bloqueados, **SQLSTATE `42501`**, mensaje `append-only: … is not permitted` |
| `TRUNCATE` como `postgres` | bloqueado — sólo lo detiene el trigger |
| `authenticated` / `service_role` | exactamente `SELECT`+`INSERT` en las 4 tablas |
| `anon` / `PUBLIC` | 0 grants |
| Datos persistentes generados por pruebas | 0 (`audit_logs`, `sroi_*` en 0 filas) |

### `stella_0003`

Aplicada dos veces en **una sola sesión** con el rol escritor declarado por
`-c "SET stella.writer_role = 'postgres'"` antes del `-f`. Sin `ALTER ROLE`,
sin `ALTER DATABASE`. Ambas pasadas imprimen
`write path VERIFIED against declared writer role postgres` y
`verification passed`. **Idempotente.**

Contrato pre-G3 verificado de forma **independiente al propio script**:

| Verificación | Esperado | Obtenido |
|---|---|---|
| Tabla presente | sí | sí ✔ |
| Filas | 0 | 0 ✔ |
| Columnas | 11 exactas | 11 ✔ |
| FKs | 4, todas `NO ACTION` | 4, `confupdtype/confdeltype = a/a` ✔ |
| `UNIQUE` | 0 | 0 ✔ |
| Índices no únicos | 2 | 2 (+ el PK único) ✔ |
| RLS / FORCE | on / off | on / off ✔ |
| Policies | 1 `SELECT` | 1 ✔ |
| `authenticated` | `SELECT` no grantable | `SELECT`, `is_grantable=false` ✔ |
| `service_role` / `anon` / `PUBLIC` | 0 | ausentes del ACL ✔ |
| Triggers nuevos | 2 | 2 ✔ |
| Triggers append-only totales | 10 | 10 ✔ |
| `evidence_chunks` | ausente | ausente ✔ |

### G3 — modo CREATED

Precondiciones confirmadas: 0 decisiones con la `suggestion_key` determinista
`g3-local-rehearsal.synthetic.advisor.suggested_next_actions[0]`,
`stella_suggestion_decisions` = 0, `stella_interactions` = 1, API y DB
exclusivamente locales, cero remoto.

`pnpm test:rls` ejecutado **una sola vez**:

| Registro | Valor |
|---|---|
| Resultado | **1 archivo, 32 passed, 0 failed, 0 skipped**, 11,37 s |
| Fixture append-only | **CREATED** — el modo se *resuelve* contando filas con la clave determinista, y sobre volumen nuevo no había ninguna |
| Decisiones creadas | 1 (ninguna segunda) |
| Interacciones creadas | 1 adicional |
| Residuo inesperado | ninguno |

Verificaciones funcionales cubiertas por las 32: organización A lee,
organización B no lee, usuario sin membresía ni lee ni inserta, superadmin lee
y no muta, `service_role` no lee ni inserta la tabla de decisiones,
`authenticated` no inserta, `UPDATE`/`DELETE`/`TRUNCATE` bloqueados con
SQLSTATE `42501` y el mensaje append-only correcto.

> Que RUN 1 diera 32/32 en modo `REUSED` y RUN 2 dé 32/32 en modo `CREATED` es
> evidencia **más fuerte** que dos corridas idénticas: las 32 aserciones se
> sostienen por el contrato de seguridad, no por el estado heredado.

### Postcheck RUN 2

| Contador | Esperado | Obtenido |
|---|---|---|
| tablas `public` | 38 | 38 ✔ |
| policies `public` | 104 | 104 ✔ |
| triggers append-only | 10 | 10 ✔ |
| índices `public` | 119 | 119 ✔ |
| constraints `public` | 230 | 230 ✔ |
| funciones `public` | 8 | 8 ✔ |
| organizations | 3 | 3 ✔ |
| users `public` / `auth.users` | 9 / 9 | 9 / 9 ✔ |
| projects | 2 | 2 ✔ |
| memberships | 7 | 7 ✔ |
| `stella_interactions` | 2 | 2 ✔ |
| `stella_suggestion_decisions` | 1 | 1 ✔ |
| `storage.objects` | 0 | 0 ✔ |
| `evidence_chunks` | ausente | ausente ✔ |
| `session_replication_role` | `origin` | `origin` ✔ |
| duplicados de `suggestion_key` | 0 | 1 clave distinta de 1 fila ✔ |
| datos reales | 0 | 0 ✔ |

Residuo final, **todo sintético y etiquetado como tal**: 8 usuarios `@test.com`
del seed base + 1 `test-rls-…@test.local` del fixture G3; orgs
`Organización A`/`Organización B` + `RLS Org A`; interacciones `seed-synthetic`
y `test-model`; decisión con `suggestion_key` bajo el prefijo
`g3-local-rehearsal.synthetic.`.

### Comparación RUN 1 vs RUN 2

Diff canónico entre la línea base de RUN 1 (post-rollback) y la de RUN 2
(final): **61 líneas**, descompuestas en 7 contadores actualizados y 34 líneas
que pertenecen **todas** a `stella_suggestion_decisions`. Ninguna línea de
ningún objeto preexistente cambió.

| Dimensión | Resultado |
|---|---|
| Hashes de `0002` / `0002b` / `0003` | idénticos a los documentados |
| Columnas, PK, FKs, acciones `ON DELETE`, `CHECK`s | sin diferencias fuera de la tabla que crea 0003 |
| Índices, policies | ídem |
| ACL vía `aclexplode` | única diferencia no-owner: **+1** (`authenticated SELECT` sobre la tabla nueva) |
| Triggers, `tgtype`, `tgenabled` | sin diferencias fuera de los 2 triggers de 0003 (`tgtype` 27 y 34, `tgenabled=O`) |
| Cuerpo y hash de `uellix_forbid_mutation()` | `cd918f70…73cb98f` — **idéntico** |
| RLS / FORCE RLS | sin diferencias |
| Migraciones registradas | 2 Supabase + 40 Drizzle — idénticas |
| Fixtures sintéticos | mismos conteos base (2/8/6/1/1) y mismo residuo final (3/9/2/7/2/1) |
| Conteos finales | 38 / 104 / 119 / 230 / 10 — coinciden con los documentados de RUN 1 |
| G3 | RUN 1 **32/32 REUSED** · RUN 2 **32/32 CREATED** |
| Pruebas offline | 246/246 y 2553/2553 en ambos |
| `evidence_chunks` | ausente en ambos |
| Remoto | ausente en ambos |

**Clasificación de diferencias**

| Diferencia | Clase | Justificación |
|---|---|---|
| Los 34 objetos de `stella_suggestion_decisions` y los 7 contadores | **esperada** | Es exactamente lo que `stella_0003` debe crear |
| Modo de fixture `REUSED` → `CREATED` | **esperada** | RUN 2 corre sobre volumen nuevo; el modo se resuelve por estado, por diseño |
| Grants no-owner: 526 (RUN 2) vs 461 (documentado RUN 1) | **cosmética** | Diferencia de *definición de medida*, no de estado: `MAINTAIN` es un privilegio nuevo de PostgreSQL 17. Excluyéndolo, RUN 2 da **461** exacto. El delta real RUN 1→RUN 2 es **+1**, el mismo `−1` que registró el rollback |
| IDs de contenedor y UUID de fixtures | **cosmética** | Identificadores aleatorios; no se comparan como si debieran coincidir |
| Deriva estructural | **cero** | — |
| Deriva de seguridad | **cero** | — |
| Deriva funcional | **cero** | — |
| BLOCKER | **ninguno** | — |

### Pruebas

| Comando | Pre-G3 | Post-G3 |
|---|---|---|
| `tests/prepared-stella-sql.test.ts` + `tests/prepared-sql-source-of-truth.test.ts` | **246 / 246** | **246 / 246** |
| `pnpm test:unit` | **2553 / 2553** (135 archivos) | **2553 / 2553** (135 archivos) |
| `pnpm typecheck` | verde | verde |
| `pnpm lint` | 0 errores, 51 warnings preexistentes | 0 errores, 51 warnings |
| `pnpm test:rls` | — | **32/32**, ejecutada **una sola vez** |

### Desviación de herramienta

No hay `psql` en el `PATH` del host. RUN 2 aplicó los tres scripts por
`docker exec -i supabase_db_… psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f -`,
con el archivo exacto por `stdin`. Es una conexión local dentro del contenedor:
cambia la herramienta de transporte, no el procedimiento ni las garantías
(`-1`, `ON_ERROR_STOP=1`, una sola sesión, archivo sin modificar).

### Lo que RUN 2 **no** hizo

- No restauró ninguno de los dos respaldos.
- No accedió al Supabase remoto ni usó `login`/`link`/`push`/`pull`.
- No ejecutó `grounding_0001` ni creó `evidence_chunks`.
- No ejecutó G2 formal.
- No cambió *default privileges* globales.
- No modificó `db/schema.ts`, `db/migrations` ni ningún script preparado.
- No usó `docker system prune`, `docker volume prune` ni patrones amplios.
- No detuvo ni eliminó `uellix-antigravity` ni `aforiq`.
- No hizo push ni PR.

**Resultado del gate:** `FULL_REBUILD_RUN_2_EXECUTED_VERIFIED_READY_FOR_REAUDIT`.
G2 formal sigue **sin ejecutar**; RUN 2 es evidencia de reproducibilidad local,
no una aprobación.

---

## Compatibilidad del runtime — identidad en los entry points (2026-08-02)

Continuación directa del cutover, sobre `b6787a5`. Sin SQL, sin migraciones, sin
seeds, sin resets.

### Estado vivo confirmado (leído como `uellix_app`, sin `SET ROLE`)

| | |
|---|---|
| `session_user` / `current_user` | `uellix_app` / `uellix_app` |
| Miembro de `anon` / `authenticated` / `service_role` | false / false / false |
| Tablas en `public` | 38 |
| Policies | 107 |
| Triggers append-only | 10 |
| Decisiones Stella | 1 |
| Interacciones Stella | 2 |
| `evidence_chunks` | ausente |

### Lo que esta unidad hizo

- Añadió `lib/auth/identity.ts` y `lib/auth/database-context.ts`.
- Reescribió `lib/auth/session.ts`: los helpers dejan de consultar y pasan a
  leer un *principal* memoizado que se resuelve **dentro** de un contexto.
- Envolvió la fase de datos de 80 entry points de `app/**`.
- Añadió `tests/authenticated-database-context.test.ts` (33) y
  `tests/database-runtime-entrypoints.test.ts` (163).
- Actualizó las suites que mockeaban `@/lib/auth/session` sin conocer los
  wrappers nuevos (11 archivos, 206 tests) — ninguna falla era del producto.

### Lo que esta unidad **no** hizo

- No aplicó SQL ni creó policies: los cinco caminos de bootstrap quedaron
  **bloqueados por diseño**, sin bypass.
- No ejecutó `grounding_0001` ni creó `evidence_chunks`.
- No ejecutó G2 formal ni G3 (`test:rls`) ni integración remota.
- No accedió al Supabase remoto.
- No dejó escrituras permanentes: toda escritura de prueba termina en ROLLBACK,
  verificado contando `stella_interactions` antes y después.
- No tocó los respaldos ni los otros stacks locales.
- No hizo push ni PR.

**Resultado:** `STELLA_RUNTIME_CUTOVER_HARDENED_READY_FOR_REAUDIT`. G2 formal
sigue **sin ejecutar**.
