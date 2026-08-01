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

1. **`G2_PACKAGE.md` §2 sigue usando `information_schema.role_table_grants`**
   para los grants de `stella_interactions`, la misma vista que §6 prohíbe con
   argumento. Peor: esa vista **no puede expresar `PUBLIC`** — medido en este
   stack, devuelve 0 filas con `grantee='PUBLIC'` mientras 195 relaciones sí
   tienen ACL de `PUBLIC`. Su expectativa *"para anon / PUBLIC: ninguna fila"*
   es, para `PUBLIC`, infalsificable. Es el defecto que MINOR-5 cerró para la
   tabla nueva, abierto aún para la preexistente.
2. **El rollback depende de banderas de `psql`.** La guarda (`DO $$`) y el
   `DROP TABLE IF EXISTS` son sentencias separadas: sin `-1 -v ON_ERROR_STOP=1`
   la excepción no impediría el `DROP`. Las cabeceras lo mandan; nada lo hace
   estructural.
3. **Falta un test automático de integridad estructural de los archivos de
   test.** El incidente de `String.replace` con `$'` está registrado como
   lección de proceso, pero nada lo fija contra recurrencia.
4. **El hash de evidencia no es portable.** El SHA-256 citado como "bytes
   ejecutados" es el del working tree con CRLF; en un checkout con LF o en CI
   Linux el mismo archivo hashea `ad22e22c…`. No hay `.gitattributes` que fije
   `eol` para `*.sql`.

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
