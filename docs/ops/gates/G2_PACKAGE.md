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
| 1b | `db/prepared/stella_0002b_append_only_truncate_hardening.sql` | `db/prepared/stella_0002b_rollback.sql` — **deliberadamente NO reversible** | Cierra el hueco de `TRUNCATE` en las **cuatro** tablas append-only: revoca `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` de `authenticated` y además `UPDATE/DELETE` de `service_role`, y añade 4 triggers `BEFORE TRUNCATE FOR EACH STATEMENT` (única capa que alcanza al **owner**) |
| 2 | `db/prepared/stella_0003_suggestion_decisions.sql` | `db/prepared/stella_0003_rollback.sql` | Crea `stella_suggestion_decisions` (decisiones humanas sobre sugerencias) con RLS SELECT-only, `REVOKE ALL` previo a los grants y sus 2 triggers append-only |
| 3 | `db/prepared/grounding_0001_evidence_chunks.sql` | `db/prepared/grounding_0001_rollback.sql` | Ver addendum dedicado: `docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md` (tiene precondiciones propias: pgvector + decisión G5 P3) |

El orden 1→1b→2 importa: **1b exige que 1 ya esté aplicado** (su guarda de
precondición verifica el trigger `trg_stella_interactions_append_only`, además
de los otros tres triggers de fila). El paso 2 referencia `stella_interactions`,
que ya existe. El addendum de grounding (3) es independiente y puede aplicarse
en otra sesión.

**Por qué existe un `1b` en vez de modificar el `1`:** `stella_0002` ya fue
verificado y su evidencia (hash incluido) está publicada. Editarlo invalidaría
esa evidencia y obligaría a repetir su ensayo completo, sin ganar nada:
`stella_0002` hizo exactamente lo que declaraba. El hallazgo que `1b` repara
(RK-04b) es **preexistente y sistémico** — viene de los `ALTER DEFAULT
PRIVILEGES` de Supabase, no de `stella_0002`. Una unidad separada mantiene un
cambio por propósito y cada uno con su propio gate.

**Rollback de 1b:** política `SAFE_NON_REVERSING_ROLLBACK`. No vuelve a conceder
`TRUNCATE` ni borra los triggers: no hay regresión funcional de la que revertir
(ningún camino de código usa esos privilegios), así que lo único que lograría
revertir sería reabrir el hueco en una tabla audit-ready. Ver la cabecera del
propio archivo para las cuatro acepciones de "rollback" y la vía DBA explícita
para los casos reales.

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

**Método principal — psql con transacción única (preferido):**

```bash
# con el connection string de STAGING (¡verificar dos veces el host!)
# -1 = todo el script en UNA transacción: si algo falla no queda estado parcial
#      (rollback automático); como además los statements son idempotentes y
#      convergentes, re-ejecutar el script tras corregir también recupera.
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0002_interactions_hardening.sql
psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0003_suggestion_decisions.sql
```

**Alternativa — supabase CLI** (proyecto de staging linkeado). Verificar antes
que el proyecto linkeado es el correcto (`supabase projects list`):

```bash
supabase db execute --file db/prepared/stella_0002_interactions_hardening.sql
supabase db execute --file db/prepared/stella_0003_suggestion_decisions.sql
```

**Último recurso — SQL Editor de Supabase** (staging, rol admin): pegar y
ejecutar cada script completo, en orden. Solo si las dos vías anteriores no
están disponibles: el editor no garantiza por contrato la ejecución
transaccional del script completo, y un fallo a mitad podría dejar una tabla
creada con RLS aún sin habilitar. Si se usa esta vía, **verificar el estado
parcial explícitamente** con las consultas de "Verificaciones post-aplicación"
antes de continuar.

### Garantías de los scripts (endurecimiento pre-ejecución, 2026-07-31)

Los tres scripts preparados fueron endurecidos antes de este gate:

- `SET search_path = public;` y todos los objetos cualificados con `public.`;
- **guardas de precondición** que fallan con mensaje accionable si falta
  `uellix_forbid_mutation()`, una tabla referenciada o los helpers RLS;
- **guarda de forma**: si la tabla destino ya existe con columnas o tipos
  incompatibles, el script **aborta** listando las columnas discrepantes en
  lugar de hacer un no-op silencioso (los mensajes reportan nombres y tipos de
  columna, nunca datos de filas);
- **idempotencia convergente**: sobre una base ya endurecida, re-ejecutar
  reconcilia constraints, índices, grants, RLS y política;
- cero `CREATE INDEX CONCURRENTLY` → compatibles con `-1`.

Ver `db/prepared/README.md` y `docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md`.

## Verificaciones post-aplicación

```sql
-- 1. Trigger append-only adjunto a stella_interactions
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.stella_interactions'::regclass AND NOT tgisinternal;
-- esperado: trg_stella_interactions_append_only

-- 2. Grants reducidos. Filtrar por esquema y mirar TODOS los grantees:
--    un GRANT residual a anon o PUBLIC no se vería filtrando por
--    grantee='authenticated'.
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'stella_interactions'
ORDER BY grantee, privilege_type;
-- esperado para authenticated: INSERT, SELECT (sin UPDATE ni DELETE)
-- esperado para anon / PUBLIC: ninguna fila

-- 3. CHECK de stella_role EXACTAMENTE con los 6 roles (no un superset)
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.stella_interactions'::regclass
  AND conname = 'stella_interactions_stella_role_check';
-- esperado: contiene 'advisor','validator','composer','proxy_reviewer',
--           'evidence_reviewer','audit_assistant' Y NINGÚN otro literal.
--           Leer la definición completa: la guarda del script comprueba
--           presencia, no ausencia de roles extra.

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

-- 6. Grants de la tabla nueva, todos los grantees y filtrando por esquema
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'stella_suggestion_decisions'
ORDER BY grantee, privilege_type;
-- esperado: authenticated | SELECT (una sola fila); anon/PUBLIC sin filas

-- 7. CHECKs de la tabla nueva — leer la DEFINICIÓN, no solo el nombre.
--    Un CHECK con el nombre correcto y una definición obsoleta (p. ej. sin
--    'undone') pasaría un chequeo por nombre y rompería recordStellaDecision
--    en runtime, después de dar el gate por verde.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.stella_suggestion_decisions'::regclass AND contype = 'c'
ORDER BY conname;
-- esperado:
--   stella_suggestion_decisions_decision_check  -> incluye los 4 valores
--       'accepted', 'accepted_edited', 'rejected', 'undone'
--   stella_suggestion_decisions_prev_hash_check -> incluye [0-9a-f]{64}
```

Después de las verificaciones SQL: correr el paquete G3
(`docs/ops/gates/G3_PACKAGE.md`) — `pnpm test:rls` contra staging con los
`describe.skip` post-G2 activados.

Criterio de aprobación binario: **todas** las verificaciones 1–7 dan el
resultado esperado y G3 pasa sin regresiones.

## Criterios de aborto

**Abortar** significa: no continuar con el siguiente script, no flipear flags,
no avanzar a G3. Si la transacción ya falló, `-1` garantiza que no quedó estado
parcial; si se usó el SQL Editor, verificar el estado antes de reintentar.

| # | Causa de aborto | Cómo se detecta | Qué hacer |
|---|---|---|---|
| A1 | **Host equivocado** — el connection string no apunta al proyecto de staging designado | Verificar el host **antes** de ejecutar (`echo "${STAGING_DATABASE_URL%%\?*}"` sin exponer credenciales, o `supabase projects list`). Producción y local nunca son destinos válidos de este paquete | Detener. No ejecutar nada. Corregir el destino y reiniciar el checklist desde las precondiciones |
| A2 | **Backup no verificable** — no existe backup de staging registrado, o no se puede confirmar que es restaurable | Precondición binaria del paquete, sin evidencia | Detener. Tomar y verificar el backup antes de cualquier DDL |
| A3 | **Migraciones base ausentes** — falta `uellix_forbid_mutation()`, falta una tabla referenciada, o faltan los helpers RLS | Los propios scripts abortan con `RAISE EXCEPTION` citando qué migración aplicar (`0030`, `0031`+`0039`) | Detener. Aplicar las migraciones base por su propio camino y volver a empezar |
| A4 | **Feature flag encendido** — `STELLA_DECISIONS_PERSISTENCE_ENABLED` está en `true` en algún entorno apuntando a esta base | Revisar env vars en Vercel (Preview y Production) antes de ejecutar | Detener. Apagar el flag primero: la action debe seguir dormida hasta que el gate esté verificado |
| A5 | **Forma incompatible de objetos preexistentes** — la tabla destino ya existe con columnas o tipos distintos | El script aborta con `... already exists with an INCOMPATIBLE shape. Missing or mismatched columns: ...` | Detener. **No** forzar. Investigar de dónde salió esa tabla; la resolución es manual y probablemente merece su propio gate |
| A6 | **Fallo de cualquier verificación post-apply** — alguna de las 7 consultas no devuelve el resultado esperado | Sección "Verificaciones post-aplicación" | Detener. Evaluar rollback (ver más abajo). No avanzar a G3 con una verificación en rojo |
| A7 | **Estado parcial detectado** — la tabla existe pero sin RLS, sin política, o con grants más amplios de lo esperado | Verificaciones 5, 6 y 2. Riesgo real solo si se usó el SQL Editor | Detener. Re-ejecutar el script completo con `psql -1` (es convergente) y volver a verificar. Si persiste, rollback |
| A8 | **Decisión G5 P3 ausente o pgvector no disponible** — solo aplica al addendum de grounding | El script `grounding_0001` aborta con mensaje explícito | Detener **solo el addendum**. `stella_0002`/`0003` no dependen de G5 y pueden continuar |

Regla transversal: ante cualquier duda sobre el destino o el estado,
**abortar es siempre la opción correcta** — estos scripts son convergentes y
re-ejecutables, así que detenerse nunca cuesta trabajo perdido.

### Aclaración sobre A1 — ensayo estructural local

A1 se refiere al destino de **la ejecución formal del gate**. Ni producción ni
una base local son jamás destinos válidos para **declarar G2 ejecutado**.

Existe, sin embargo, un procedimiento distinto y explícitamente acotado:
`docs/ops/LOCAL_STAGING_G2_REHEARSAL.md` permite aplicar estos scripts contra
un stack Supabase **local y desechable** exclusivamente como **ensayo
estructural** — comprobar que el SQL corre en un PostgreSQL real, que es
idempotente y que sus verificaciones son ejecutables, antes de tocar el entorno
autorizado.

Ese ensayo **no satisface, no aprueba y no adelanta G2**:

- una base local **no es staging** y no debe reportarse como tal;
- ninguna corrida local puede marcar las casillas de *Precondiciones* de este
  paquete ni habilitar el avance a G3;
- la ejecución formal exige el **entorno remoto autorizado** y las
  precondiciones humanas correspondientes (backup verificado, flags apagados,
  aprobación explícita).

Dicho de otro modo: el ensayo local responde *"¿el script funciona?"*; G2
responde *"¿estamos autorizados a cambiar el entorno real, y quedó verificado
allí?"*. Aprobar lo primero nunca implica lo segundo.

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
