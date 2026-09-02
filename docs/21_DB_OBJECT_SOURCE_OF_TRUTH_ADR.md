# ADR 21 — Fuente de verdad para objetos de base de datos fuera del chain de Drizzle

> **Estado:** ACEPTADA · **Fecha:** 2026-07-31 · **Decide:** coordinador de campaña
> (implementación), ratificable por Lorenzo · **Reversible:** sí, mediante el
> procedimiento de promoción de §7.
>
> **Contexto de origen:** hallazgo R1 de `STELLA_G2_READINESS_AUDIT` (2026-07-31).
> Esta ADR se escribe **antes** de ejecutar G2, para que la decisión exista
> cuando los objetos lleguen a una base real.

## 1. Problema

El gate externo G2 aplicará manualmente tres scripts de `db/prepared/`:

| Script | Objetos que crea/altera |
|---|---|
| `stella_0002_interactions_hardening.sql` | trigger `trg_stella_interactions_append_only`, grants de `stella_interactions`, CHECK `stella_interactions_stella_role_check` |
| `stella_0003_suggestion_decisions.sql` | **tabla `stella_suggestion_decisions`** + índices + RLS + política |
| `grounding_0001_evidence_chunks.sql` | extensión `vector`, **tabla `evidence_chunks`** + índices + RLS + política |

Las **dos tablas nuevas no existen en `db/schema.ts`** ni en el snapshot de
Drizzle (`db/migrations/meta/`, 40 entradas, última `0039`). Tras G2, la base
viva contendrá objetos que la fuente de verdad declarada del repositorio
desconoce. La pregunta es qué hacer con esa divergencia.

## 2. Restricción dura

`drizzle-kit generate` compara `db/schema.ts` contra el **snapshot**, no contra
la base viva. Si se añaden las tablas a `schema.ts` y se genera una migración,
Drizzle emite DDL de creación **sin cláusula de existencia**. Evidencia directa
en este repositorio:

```
db/migrations/0000_quick_husk.sql:   CREATE TABLE "audit_logs" (
db/migrations/0001_noisy_chameleon.sql: CREATE TABLE "invitations" (
db/migrations/0004_thick_mentor.sql: CREATE TABLE "portfolios" (
```

Ninguna usa `IF NOT EXISTS`. Sobre un staging donde G2 ya aplicó
`stella_0003`, un `pnpm db:migrate` posterior fallaría con
`relation "stella_suggestion_decisions" already exists`, y además Drizzle no
tendría registro de la aplicación manual en su tabla de bookkeeping
`__drizzle_migrations`.

**Esto es exactamente el escenario que el mandato de esta tarea prohíbe.**

## 3. Alternativas evaluadas

### Opción A — Incorporarlas a `db/schema.ts` y reconciliar el estado de migraciones

| Criterio | Evaluación |
|---|---|
| Riesgo `drizzle-kit generate` | **Alto.** Emite `CREATE TABLE` sin `IF NOT EXISTS` (§2) |
| Riesgo de migración duplicada | **Alto.** Sobre una base G2-aplicada, la migración generada falla; requiere edición manual del archivo generado (frágil: se pierde en la siguiente regeneración) o marcar la migración como aplicada a mano en `__drizzle_migrations` de cada entorno |
| Tipado | Ganancia **nula hoy**: `app/actions/stella/decisions.ts` usa `db.execute(sql\`…\`)` crudo en sus 3 accesos (líneas 106, 120, 138); `lib/grounding/retrieval.ts` todavía no consulta `evidence_chunks` |
| Queries de aplicación | Sin cambio: el código actual no usa el query builder tipado para estas tablas |
| Mantenibilidad | Baja mientras el objeto sea gate-dependiente: `schema.ts` afirmaría que la tabla existe en todos los entornos, cuando existe solo donde G2 corrió |
| Producción | **Peligrosa**: producción y staging quedarían en estados distintos frente al mismo `schema.ts` |
| Rollback | Se complica: revertir la tabla exigiría además revertir el snapshot y el journal |
| Onboarding | Engañoso: un desarrollador nuevo asumiría que `pnpm db:migrate:local` reproduce el esquema completo |
| Detección de drift | Aparente, no real: el snapshot diría "existe" sin verificar nada |

**Descartada** por la restricción dura de §2.

### Opción B — Objetos administrados manualmente bajo `db/prepared/`, con registro autoritativo y pruebas de drift

| Criterio | Evaluación |
|---|---|
| Riesgo `drizzle-kit generate` | **Nulo.** Si no están en `schema.ts`, `generate` nunca los ve ni emite DDL para ellos |
| Riesgo de migración duplicada | **Nulo** por construcción |
| Tipado | Sin tipos generados; se compensa con SQL crudo revisado y las guardas de forma del propio script |
| Queries de aplicación | Ya es el patrón vigente (`db.execute(sql\`…\`)`) |
| Mantenibilidad | Aceptable **si** existe un registro autoritativo y pruebas que lo mantengan honesto |
| Producción | Coherente: el objeto existe donde el gate corrió, y el registro dice exactamente eso |
| Rollback | Simple: el rollback preparado del propio script, sin tocar snapshot ni journal |
| Onboarding | Requiere documentación explícita — es el punto débil que esta ADR cubre |
| Detección de drift | Requiere prueba automática — se añade en esta tarea |

### Opción C — B + procedimiento de promoción documentado (**SELECCIONADA**)

Opción B, más un camino explícito y seguro para promover estos objetos al
chain de Drizzle **cuando dejen de ser gate-dependientes**, modelado sobre el
precedente real del repositorio: `db/migrations/0016_fat_mac_gargan.sql`
("snapshot reconciliation: fold the manual numeric-columns migration into the
drizzle-kit chain"), que ya resolvió exactamente este problema para
`db/manual-migrations/003_numeric_columns.sql`.

## 4. Decisión

**Se adopta la Opción C.**

`stella_suggestion_decisions` y `evidence_chunks` (y los objetos de
`stella_0002`) permanecen **fuera de `db/schema.ts` y fuera del snapshot de
Drizzle** mientras su aplicación dependa de un gate externo. Su fuente de
verdad es `db/prepared/` más el **registro autoritativo** de §5, sostenido por
pruebas automáticas offline.

Esta decisión **no es una excepción nueva**: el repositorio ya opera tres
categorías de SQL fuera del chain de Drizzle, todas aplicadas a mano.

| Directorio | Contenido | Aplicación | En snapshot |
|---|---|---|---|
| `db/migrations/` | 40 migraciones generadas | `drizzle-kit migrate` | Sí |
| `db/manual-migrations/` | 3 scripts (constraints, append-only, numeric) | Manual | No |
| `db/policies/` | 8 archivos de RLS | Manual | No |
| **`db/prepared/`** | **3 scripts + 3 rollbacks, gate-dependientes** | **Manual, tras gate** | **No** |

## 5. Registro autoritativo

`db/prepared/README.md` es el registro autoritativo de los objetos gestionados
fuera de Drizzle por esta campaña. Debe listar, por script: objetos creados,
gate que lo autoriza, rollback y estado. La prueba
`tests/prepared-sql-source-of-truth.test.ts` verifica que ese registro y la
realidad de los archivos no diverjan.

## 6. Salvaguardas automáticas (implementadas en esta tarea)

1. **`db/prepared/` nunca contiene un archivo aplicable por Drizzle** — se
   verifica que ningún `.sql` de `db/prepared/` esté también en
   `db/migrations/`, y que `drizzle.config.ts` siga apuntando `out` a
   `db/migrations`.
2. **Ausencia de `drizzle-kit push`** — `push` es el único comando de Drizzle
   que compara contra la base viva y propondría `DROP TABLE` sobre estos
   objetos. Una prueba falla si aparece un script `db:push` en `package.json`.
3. **Los objetos gate-dependientes no aparecen en `db/schema.ts`** — una prueba
   falla si `stella_suggestion_decisions` o `evidence_chunks` se añaden a
   `schema.ts` sin ejecutar antes el procedimiento de promoción de §7.
4. **El registro de `db/prepared/README.md` coincide con los archivos reales.**

## 7. Procedimiento de promoción (cuando dejen de ser gate-dependientes)

No ejecutar ninguno de estos pasos como parte de G2. Aplican solo cuando el
objeto exista en **todos** los entornos y ya no dependa de un gate:

1. Confirmar que el objeto está aplicado en local, staging y producción.
2. Añadir la tabla a `db/schema.ts`.
3. `pnpm db:generate` → produce una migración con `CREATE TABLE` **sin**
   `IF NOT EXISTS`.
4. **Editar a mano esa migración** para volverla idempotente
   (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, guardas para
   políticas), documentando la edición en el encabezado del archivo —
   exactamente como hizo `0016_fat_mac_gargan.sql`, que declara en su cabecera:
   *"REPARACIÓN HISTÓRICA EXCEPCIONAL… No debe ejecutarse manualmente contra
   producción. No se considera automáticamente un no-op en bases existentes."*
5. Verificar que `pnpm db:migrate:local` sobre una base limpia reproduce el
   esquema completo.
6. Retirar el objeto del registro de `db/prepared/README.md` y actualizar la
   prueba de salvaguarda 3.
7. Registrar la promoción en `docs/ops/STELLA_FABLE_TEST_LEDGER.md`.

## 8. Consecuencias

**Positivas**
- Cero riesgo de que `drizzle-kit generate` emita un `CREATE TABLE` que choque con un objeto ya aplicado.
- El rollback de cada script sigue siendo autocontenido.
- La divergencia queda declarada y probada, no implícita.

**Negativas (aceptadas)**
- Sin tipos de Drizzle para estas tablas: el acceso es SQL crudo revisado a mano. Mitigado porque ya es el patrón vigente y porque las políticas RLS y las guardas de forma viven en el propio script.
- `pnpm db:migrate:local` sobre una base limpia **no** reproduce estos objetos. Documentado aquí y en `db/prepared/README.md`.
- Requiere disciplina de mantenimiento del registro — de ahí las 4 salvaguardas automáticas.

## 9. Referencias

- `docs/ops/gates/G2_PACKAGE.md`, `docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md`
- `db/prepared/README.md` (registro autoritativo)
- `db/manual-migrations/README.md` (precedente de SQL manual)
- `db/migrations/0016_fat_mac_gargan.sql` (precedente de reconciliación de snapshot)
- `tests/prepared-sql-source-of-truth.test.ts` (salvaguardas)
