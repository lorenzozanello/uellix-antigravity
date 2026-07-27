# Stella — Etapa A2.4: Retención diferenciada, purga y preservación del audit trail (DR-004). Informe de implementación

**Fecha:** 2026-07-26

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172`. Sin cambios respecto a todas las sesiones anteriores de esta cadena de trabajo — ningún commit se ha creado en ninguna de ellas, incluida esta.

## 2. Estado inicial

`git status --short` confirmó el mismo working tree con el que cerró Etapa A2.3.2, más los archivos nuevos/modificados de esta sesión (107 entradas en total al momento de escribir este informe). `git log --oneline` confirma que el HEAD no cambió. Migraciones pendientes antes de empezar: ninguna — la última migración aplicada era `0046_stella_sensitive_aggregation_declarations.sql`.

## 3. Inventario

Se leyeron completamente `STELLA_REVISED_MASTER_PLAN.md`, `STELLA_REVISED_BACKLOG.csv`, `STELLA_DECISION_REGISTER.md`, `STELLA_A2_OWNER_DECISION_FORM.md`, `STELLA_AI_DATA_GOVERNANCE_POLICY_DRAFT.md`, `STELLA_A2_PREPARATION_REPORT.md`, `STELLA_A2_DR005_IMPLEMENTATION_REPORT.md`, `STELLA_A2_DR007_IMPLEMENTATION_REPORT.md`, `STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md`, `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`, `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md`, `STELLA_THREAT_MODEL.md`. Se introspeccionó el esquema real de `stella_interactions`, `stella_ai_consent_events`, `stella_sensitive_aggregation_declarations`, `audit_logs`, `organizations`, `projects`, `organization_members` — vía `information_schema.columns`/`information_schema.tables` directamente contra el stack local, no solo `db/schema.ts`.

Se buscó en todo el repositorio: `retention`, `purge`, `legal_hold`, `data_deletion`, `organization_closure`, `account_termination`, `audit_outbox`, `cron`, `job`, `cleanup`, `archive`, `soft delete` — **ninguna estructura previa existía** para retención/purga/hold/outbox. El precedente más cercano de "ciclo de vida con estados y consistencia por pares" es `projects` (`deletionRequestedAt`/`deletedAt`, migración `0024`), reutilizado como referencia de patrón (CHECK de consistencia por pares), no de código.

**Hallazgo del inventario, no anticipado:** `db/migrations/meta/` no tenía los snapshots de las migraciones `0041`-`0046` (saltaba de `0040_snapshot.json` a nada hasta que esta sesión generó `0047_snapshot.json`). Esto significa que ninguna migración de las Etapas A1.8 a A2.3.2 dejó su snapshot comprometido — una brecha operativa preexistente de sesiones anteriores, no introducida aquí. Se documenta en §5 y en los riesgos residuales (§31); no se intentó reconstruir retroactivamente los snapshots faltantes (fuera de alcance de DR-004).

## 4. Política aprobada

El propietario aprobó la política técnica directamente en el encargo de esta etapa (no requirió un nuevo formulario de decisión): retención diferenciada por categoría — `response_json` 24 meses por defecto, configurable por organización; metadatos de auditoría, `context_manifest`, consentimientos y declaraciones de agregación conservados mientras la organización mantenga su cuenta activa y 5 años tras el cierre contractual (evento no disponible hoy, ver §5); ningún payload/documento completo se almacena en `stella_interactions` (ya cierto desde Etapa A1, sin cambios); cualquier almacenamiento futuro de contexto sanitizado requerirá tabla/acceso/retención propios y revisión legal — explícitamente no implementado aquí.

## 5. Brechas del ciclo contractual

`organizations` no tiene ninguna columna de cierre contractual, desactivación, ni fecha de terminación (confirmado por introspección: 19 columnas, ninguna con ese propósito). Por tanto, el período de 5 años posterior al cierre contractual **no se implementó como mecanismo ejecutable** — implementarlo habría exigido inventar un evento de cierre que no existe, violando la convención ya establecida en esta cadena de trabajo (documentar la brecha, no inventar metadatos — ver `STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md`). Las 5 categorías afectadas (metadatos, manifiesto, consentimientos, declaraciones, audit logs) se documentan con su intención de retención pero sin purga ejecutable. Se deja como tarea futura conectar esto al ciclo de vida organizacional real (fila `STL-A24-001` del backlog registra el hallazgo).

## 6. Categorías

`lib/stella/retention/policy.ts` define `StellaRetentionCategory` con las 6 categorías reales (ninguna inventada): `interaction_metadata`, `interaction_response_content`, `context_manifest`, `consent_events`, `aggregation_declarations`, `audit_logs`. Cada una documenta tabla, campos afectados, sensibilidad, período por defecto, evento disparador (`null` cuando no existe uno confiable), acción al expirar, si admite configuración organizacional, si admite hold, si preserva metadatos, y el tipo de borrado (`none`/`redaction`/`logical`/`physical`). Solo `interaction_response_content` tiene `actionOnExpiry !== 'none'` — es la única categoría con mecanismo de purga ejecutable en esta etapa.

## 7. Política versionada

`STELLA_RETENTION_POLICY_VERSION = 'v1'`; `DEFAULT_RESPONSE_RETENTION_MONTHS = 24`; `MIN_RESPONSE_RETENTION_MONTHS = 1`; `MAX_RESPONSE_RETENTION_MONTHS = 60`; `POST_CLOSURE_AUDIT_RETENTION_YEARS = 5` (documental, sin disparador ejecutable — ver §5). Interfaz `StellaRetentionPolicy` inyectable (mismo patrón que `SensitiveAggregationPolicy` de Etapa A2.3.2) — las pruebas nunca mutan `CURRENT_STELLA_RETENTION_POLICY`. El cliente nunca puede enviar la versión o el umbral; toda ejecución de purga registra la versión aplicada en `stella_retention_purge_runs.policy_version`.

## 8. Configuración organizacional

`stella_retention_settings`: un registro por organización (`UNIQUE organization_id`); ausencia de fila = usar el default global (nunca un `NULL` como "retención indefinida"). Rango 1-60 meses acotado por CHECK en la base de datos Y en el servicio (`isValidResponseRetentionMonths`). Solo `organization_admin` (coincidencia exacta, sin bypass de `super_admin`) puede cambiar el valor. El cambio **nunca purga en la misma petición** — `previewRetentionSettingsImpactAction` calcula cuántas interacciones pasarían a ser elegibles antes de que el administrador confirme una reducción, como acción separada.

## 9. Holds

`stella_retention_holds`: alcance explícito y limitado — `organization_id` obligatorio, `project_id`/`interaction_id` opcionales y validados contra la organización (y entre sí) antes de crear el hold. `hold_type` (5 valores fijos: `legal_hold`, `audit_investigation`, `dispute`, `contractual_obligation`, `authorized_preservation`) y `reason_code` (5 valores fijos) — sin campo de descripción libre. Solo `organization_admin` puede crear/liberar (documentado explícitamente como restricción conservadora pendiente de revisión legal antes de producción, no una regla aprobada formalmente). Un hold activo bloquea la purga a CUALQUIER nivel que aplique (organización > proyecto > interacción); liberar un hold no purga de inmediato, solo hace elegible la entidad en la siguiente ejecución.

## 10. Modelo de ejecuciones

`stella_retention_purge_runs`: `mode` (`dry_run`/`apply`), `status` (`pending`/`running`/`completed`/`completed_with_errors`/`failed`/`cancelled`), `cutoff_at` (calculado en servidor, nunca aceptado del cliente), `batch_size`, cursor (`cursor_created_at`+`cursor_id`, paginación estable por fecha+ID), conteos (`records_scanned`/`eligible`/`purged`/`skipped_hold`/`failed`), `error_code`, `idempotency_key` (UNIQUE). Ninguna columna admite contenido — solo IDs de ejecución y conteos agregados, nunca IDs individuales de filas purgadas (evaluado explícitamente y descartado por minimización: los conteos ya bastan para auditar la ejecución).

## 11. Modelo de purga

`lib/stella/retention/purge-service.ts` — `previewStellaRetentionPurge`/`executeStellaRetentionPurge`/`resumeStellaRetentionPurge`/`getPurgeRunStatus`. Cada lote corre en su propia transacción: `SELECT ... FOR UPDATE` sobre las filas candidatas (`organization_id` exacto + `response_purged_at IS NULL` + `created_at <= cutoff_at`, orden estable `created_at, id` ascendente), consulta batch de holds (una sola consulta por lote, nunca N+1), y — en modo `apply` — la redacción (`UPDATE ... SET response_json = NULL`) y la actualización de contadores del run se confirman en la MISMA transacción que el lote.

## 12. `response_json`

Se evaluaron las 3 opciones del encargo: (A) hacer `response_json` nullable + columnas de auditoría de purga; (B) tombstone estructural (`{"status":"purged"}`); (C) mover el contenido a tabla separada. **Se eligió A** — es la más simple que efectivamente elimina la prosa preservando trazabilidad, sin mezclar semántica de "estado" con "contenido real" (riesgo de B) ni la complejidad de una migración/tabla adicional (riesgo de C). Migración `0047`: `ALTER COLUMN response_json DROP NOT NULL` + `response_purged_at`/`response_purge_run_id` con CHECK de par consistente (`(purged_at IS NULL AND run_id IS NULL) OR (purged_at IS NOT NULL AND run_id IS NOT NULL)`) y CHECK de presencia (`response_json IS NOT NULL OR response_purged_at IS NOT NULL` — la fila nunca queda sin explicación de por qué no tiene respuesta).

## 13. Metadatos preservados

Una fila purgada conserva: `id`, `organizationId`, `projectId`, `createdBy`, `stellaRole`, `pipelineStep`, `contextHash`, `modelUsed`, `tokensUsed`, `riskLevel`, `riskFlags`, `promptTemplateId`, `promptVersion`, `promptContentHash`, `contextSchemaVersion`, `contextManifest`, `createdAt` — **todo excepto `response_json`**. `lib/stella/access/stella-interaction-reads.ts` (el único lector autorizado, DR-007) ahora expone `responseStatus: 'available' | 'purged' | 'never_generated'` explícito, en vez de forzar a cada consumidor a interpretar un `null` ambiguo.

## 14. Consentimientos

`stella_ai_consent_events` (DR-005) es un log append-only de gobernanza — ninguna función de este bloque lo modifica, lee más allá de su clasificación de categoría (documental), ni lo incluye en ningún camino de purga. Confirmado con una prueba de integración real: el conteo de filas no cambia tras una purga real de `response_json`.

## 15. Declaraciones de agregación

`stella_sensitive_aggregation_declarations` (DR-002/DR-003, Etapa A2.3.1/A2.3.2) es linaje metodológico — mismo tratamiento que consentimientos: sin purga, confirmado con una prueba de integración real. Se revisó `count_source_note` (255 caracteres, estructural) por el riesgo de contener PII residual — **no se implementó una nueva detección de contenido sobre este campo en esta sesión**: es una ampliación de alcance de un campo ya enviado a producción en una etapa anterior, no una tarea de retención por tiempo; se documenta como riesgo residual (§31), no como trabajo realizado.

## 16. Audit logs

`audit_logs` es append-only por disparador de inmutabilidad (ya existente, anterior a esta sesión) — ninguna función de retención lo purga; solo CRECE (los propios eventos de creación/liberación de holds y de inicio/fin de purga se auditan ahí). Confirmado con una prueba de integración real: el conteo nunca decrece tras una purga.

## 17. Auditoría transaccional/outbox

Se evaluaron las 3 opciones del encargo: (A) auditoría dentro de la misma transacción (requiere pasar el cliente transaccional); (B) outbox transaccional (`stella_audit_outbox` + procesador); (C) best-effort (ya usado en Etapa A2.3.2 para las declaraciones de agregación, insuficiente por sí solo para producción audit-ready). **Se eligió A** — la opción más simple y ya establecida en este repositorio: `logAuditAction` ahora acepta un segundo parámetro opcional `client: AuditQueryClient = db` (mismo patrón `TxClient`/`QueryClient` de `declaration-service.ts`, Etapa A2.3.2). `createRetentionHold`/`releaseRetentionHold`/`updateOrganizationRetentionSettings` pasan su propio `tx` — si el INSERT/UPDATE de negocio se revierte, el registro de auditoría se revierte con él, y viceversa. Se descartó el outbox explícitamente por ser infraestructura nueva (tabla, procesador, reintentos, clave de idempotencia) que convertiría DR-004 en un sistema genérico de eventos para toda la plataforma — fuera de alcance por instrucción expresa del encargo.

## 18. RLS

`db/policies/012_stella_retention_rls.sql`: SELECT habilitado para cualquier miembro activo de la organización (aislado por `organization_id`, mismo patrón de fila completa que `stella_ai_consent_events`/`stella_sensitive_aggregation_declarations` — sin split por campo a nivel de RLS); sin política de INSERT/UPDATE/DELETE en ninguna de las 3 tablas nuevas.

## 19. Privilegios

`authenticated` = SELECT únicamente desde la creación de las 3 tablas; `anon` = ninguno; `service_role`/`postgres` = completo. Verificado con `has_table_privilege` contra las 3 tablas. Todas las escrituras legítimas pasan por `lib/stella/retention/*.ts` vía Drizzle sobre `DATABASE_URL` (rol `postgres`, bypasea RLS).

## 20. Server actions

`app/actions/stella/retention.ts`: `getStellaRetentionOverview`, `previewRetentionSettingsImpactAction`, `updateRetentionSettingsAction`, `createRetentionHoldAction`, `releaseRetentionHoldAction`, `listRetentionHoldsAction`, `previewStellaRetentionPurgeAction`, `executeStellaRetentionPurgeAction`, `resumeStellaRetentionPurgeAction`, `listRecentStellaRetentionPurgeRunsAction`, `getStellaRetentionPurgeRunStatusAction`, `canManageStellaRetention`. Organización y actor siempre resueltos vía `requireOrganizationAccess()` — ningún `cutoffAt`/`policyVersion`/rol se acepta del cliente; `executeStellaRetentionPurgeAction` genera su propia `idempotencyKey` si el llamador no provee una.

## 21. UI

Se inspeccionó primero si existía una ubicación coherente: `app/app/organization/settings/page.tsx` ya existe y ya aloja configuración organizacional (blanco-etiquetado). Se montó ahí `StellaRetentionWrapper`/`StellaRetentionPanel` — política vigente, última ejecución (conteos, nunca contenido), dry-run, confirmación de purga en dos pasos, holds activos con creación/liberación (solo vocabulario fijo, sin campo de texto libre), advertencia explícita de que la política está pendiente de revisión legal A3. Nunca renderiza contenido de respuestas, IDs innecesarios, texto eliminado, ni datos sensibles — verificado con una prueba dedicada (ausencia de cualquier `<textarea>`).

## 22. Script local

`scripts/stella-retention-cli.ts` — `pnpm stella:retention:preview`/`pnpm stella:retention:purge` (con `--apply` explícito; sin él se comporta como dry-run). Guarda de host (`db/guard.ts`, mismo mecanismo que `seed-local.ts`) aborta si `DATABASE_URL` no resuelve a loopback. Nunca imprime secretos ni contenido de respuestas (no hay nada que imprimir: el motor nunca lee `response_json` como valor). Probado manualmente contra el stack local con una organización sintética.

## 23. Dry-run

Nunca muta `stella_interactions`; nunca devuelve contenido (no selecciona `response_json` en ningún punto del código); conteos exactos (`scanned`/`eligible`/`skippedHold`); cross-org excluido por construcción (`organization_id` fijo en cada consulta); holds contabilizados en `recordsSkippedHold`.

## 24. Idempotencia

`executeStellaRetentionPurge` exige `idempotencyKey`. Una segunda llamada con la MISMA clave golpea el índice único de `idempotency_key` y devuelve la ejecución YA existente (`alreadyExisted: true`) en vez de crear una segunda o reprocesar. Probado contra Postgres real: dos llamadas con la misma clave devuelven el mismo `run.id`; el conteo de filas con esa clave es exactamente 1.

## 25. Reanudación

`resumeStellaRetentionPurge` continúa desde `cursorCreatedAt`/`cursorId` persistidos, usando el `cutoffAt`/`policyVersion` ORIGINALES de la ejecución (nunca recalculados con la hora actual). Rechaza reanudar una ejecución que no esté en `running`/`failed`. Probado: una ejecución marcada `failed` con cursor persistido se retoma y termina correctamente, purgando exactamente las filas pendientes sin reprocesar las ya purgadas.

## 26. Concurrencia

Cada lote adquiere `SELECT ... FOR UPDATE` sobre las filas candidatas — dos ejecuciones (mismas o distintas claves de idempotencia) sobre la misma organización se serializan a nivel de fila bajo `READ COMMITTED`: la segunda transacción bloquea hasta que la primera confirma, luego re-evalúa su propio `WHERE response_purged_at IS NULL` contra el estado ya confirmado y excluye correctamente las filas que la primera ya purgó. Probado con `Promise.all` real contra Postgres local: dos ejecuciones concurrentes con claves distintas nunca purgan dos veces la misma fila; un hold creado DESPUÉS del dry-run pero ANTES del apply sigue bloqueando (revalidación en el momento de aplicar, no solo en la simulación).

## 27. Pruebas

| Archivo | Casos |
|---|---|
| `lib/stella/retention/__tests__/eligibility.test.ts` | 15 |
| `lib/stella/retention/__tests__/settings-service.test.ts` | 11 |
| `lib/stella/retention/__tests__/hold-service.test.ts` | 17 |
| `app/actions/stella/__tests__/retention.test.ts` | 15 |
| `components/retention/__tests__/StellaRetentionPanel.test.tsx` | 13 |
| `lib/stella/access/__tests__/stella-interaction-reads.test.ts` (ampliada, +2) | 10 |
| `tests/stella-interactions-access-anti-regression.test.ts` (ampliada, +1) | 4 |
| `tests/integration/bootstrap-invariants.test.ts` (actualizada a 42 tablas) | 11 |
| `tests/integration/stella-retention-rls.test.ts` (nueva) | 9 |
| `tests/integration/stella-retention-purge.test.ts` (nueva) | 19 |

**Total nuevas/ampliadas de esta etapa:** 126 pruebas en 10 archivos (71 unitarias nuevas de módulos de retención + 28 en archivos ampliados de otras etapas + 28 de integración nuevas).

## 28. Build

A diferencia de los bloques que no tocan rutas/UI (podían omitirlo), este bloque modifica `app/app/organization/settings/page.tsx` y añade dos componentes React nuevos — se requirió y se ejecutó un build de producción aislado. Un error real de compilación se detectó en el primer intento (`app/actions/stella/retention.ts` reexportaba constantes desde un archivo `'use server'`, lo cual Next.js prohíbe — solo se permiten funciones async) y se corrigió moviendo `ALLOWED_HOLD_TYPES`/`ALLOWED_HOLD_REASON_CODES` a `lib/stella/retention/policy.ts` (sin importaciones de base de datos, seguro para un componente cliente).

## 29. Comandos ejecutados

`npx drizzle-kit generate --config=drizzle.local.config.ts --name=stella_retention` (generó una migración con falsos positivos por snapshots faltantes — descartada) · introspección directa de `information_schema.tables`/`information_schema.columns` contra el stack local · migración `0047` escrita a mano y aplicada con `npx drizzle-kit migrate --config=drizzle.local.config.ts` · aplicación manual de `012_stella_retention_rls.sql` vía un script temporal con el paquete `postgres` (eliminado tras usarlo) · `npx tsc --noEmit -p tsconfig.json` (múltiples veces) · `npx eslint .` · `npx drizzle-kit check --config=drizzle.local.config.ts` · `npx vitest run` por archivo individual durante el desarrollo · `npx vitest run --exclude "tests/integration/**"` (suite unitaria completa, ejecutada 3 veces) · `npx vitest run --config vitest.integration.config.ts` (suite de integración completa, ejecutada 2 veces) · `npx next build` (build aislado, ejecutado 2 veces — la primera detectó el error de §28) · validación estructural del CSV (script Node temporal, eliminado tras usarlo).

## 30. Resultados exactos

- `tsc --noEmit`: limpio, 0 errores.
- Suite unitaria completa (`--exclude tests/integration/**`): **117 archivos**, **1.693 pruebas**, **1.693 aprobadas**, **0 fallidas**. (Una ejecución previa registró 1 fallo por timeout en `tests/stella-adversarial.test.ts` — confirmado transitorio/no relacionado: 21/21 aprobadas al re-ejecutar ese archivo en aislamiento.)
- Suite de integración (`--config vitest.integration.config.ts`): **11 archivos**, **132 pruebas**, **132 aprobadas**, **0 fallidas**.
- `npx next build`: compilación exitosa (Turbopack, Next.js 16.2.11), TypeScript del build finalizado sin errores, 44 páginas generadas, incluida la ruta modificada `/app/organization/settings`.
- `eslint .`: **0 errores**, **64 warnings** (línea base idéntica a la de Etapa A2.3.2 — un error nuevo de `prefer-const` se detectó y corrigió durante esta misma sesión, antes de este reporte final).
- `drizzle-kit check`: "Everything's fine" — sin drift.
- CSV: **188 filas de datos**, 18 columnas, 0 filas malformadas, 0 IDs duplicados, 0 valores de `RecommendedOrder` duplicados, secuencia 1..188 limpia, 0 dependencias colgantes, 0 inversiones de orden topológico. Bloque `STL-A24-001`..`STL-A24-033` (33 filas): 32 `Done`, 1 `Pending` (esta misma fila de validación final, que se marca `Done` al cierre de este informe).
- **Llamadas a Gemini real:** No.
- **Datos remotos:** No — todo el trabajo de esta sesión fue contra el stack local de Supabase (`127.0.0.1:55322`).
- **Migraciones remotas:** No — la migración `0047` se aplicó únicamente vía `drizzle.local.config.ts` (guarda de host hardcodeada a loopback).
- **Flags modificados:** No (`STELLA_ENABLED` y los 6 flags por rol permanecen en su valor por defecto).
- **Commits:** No.
- **Build con red deshabilitada:** No se deshabilitó físicamente — se afirma que el build no requiere red porque usa únicamente `node_modules` local y el stack de Supabase local, no una verificación de aislamiento forzada.
- **Tráfico saliente monitoreado:** No con una herramienta de red dedicada — afirmación basada en revisión del código y de los comandos ejecutados, no en una captura de tráfico independiente.
- **Servicios configurados localmente/sintéticamente:** Sí — Postgres local, organizaciones/proyectos/interacciones sintéticos creados y limpiados por cada suite de integración (las organizaciones con rastro de auditoría —inevitable, dado que este bloque genera auditoría real— quedan para `pnpm db:clean:test-data`, mismo patrón que toda suite anterior de esta sesión).
- **Contenido eliminado registrado en logs:** **No** — verificado explícitamente: el motor de purga nunca selecciona `response_json` como valor (solo lo escribe como `NULL`), y ninguna entrada de auditoría de purga/hold contiene el contenido de una respuesta.

## 31. Riesgos residuales

1. **Sin evento de cierre contractual/desactivación de organización confiable** (§5) — la retención de 5 años post-cierre para metadatos/consentimientos/declaraciones/audit-logs no tiene disparador ejecutable; documentado, no inventado.
2. **`count_source_note`** (declaraciones de agregación, Etapa A2.3.1) no fue sometido a una nueva detección de PII en esta sesión — riesgo heredado, ampliar su alcance queda fuera de un bloque de retención por tiempo.
3. **Los períodos de retención son política técnica inicial, no una garantía jurídica** — pendientes de validación contractual y legal en Etapa A3, tal como el encargo exige explícitamente.
4. **Ningún mecanismo de reconciliación automática de holds vencidos** (`expires_at` pasado con `status` todavía `'active'`) — el motor de purga calcula correctamente si un hold está vencido en el momento de la consulta (`expiresAt IS NULL OR expiresAt > now`), pero ninguna tarea programada transiciona la fila a `status = 'expired'`; es una lectura correcta bajo demanda, no un estado persistido incorrecto.
5. **La brecha preexistente de snapshots faltantes de `drizzle-kit` (migraciones 0041-0046, §3)** no se corrigió retroactivamente — fuera de alcance de DR-004; el snapshot `0047` generado en esta sesión sí es completo y correcto, por lo que futuras generaciones ya no sufrirán el mismo problema.
6. **Restricción de holds a `organization_admin` es conservadora, no una regla aprobada formalmente** — documentado explícitamente como pendiente de revisión legal antes de producción (§9).

## 32. Trabajo no realizado (fuera de alcance, expresamente)

Activación de `STELLA_ENABLED`/flags por rol, llamadas reales a Gemini, evaluaciones reales, bases de datos remotas, despliegue, push, commits, seeds, variables de Vercel, edición de migraciones ya aplicadas, Etapa A3, Etapa B, prompts por paso, sugerencias/reformulación, procesamiento de documentos reales, Evidence Intelligence, OCR/grounding/embeddings/RAG/pgvector, almacenamiento de payloads crudos, purga de `stella_ai_consent_events`/`stella_sensitive_aggregation_declarations`/`audit_logs` (sin regla explícita aprobada), un outbox genérico de eventos para toda la plataforma, conexión de la retención al ciclo de vida contractual real (evento inexistente hoy), cron/tarea programada de producción, modificación de infraestructura de Vercel.

## 33. Estado de DR-004

`APROBADO CON RESERVAS`. El backend (esquema, migraciones, RLS, elegibilidad, purga por lotes, idempotencia, reanudación, holds, auditoría transaccional) está completo y probado de punta a punta contra Postgres local. La UI está construida e integrada (build aislado exitoso, 13 pruebas de componente) pero no fue verificada visualmente en un navegador real (misma reserva heredada de Etapa A2.3.2 — complejidad de sesión autenticada local dentro de esta sesión). El período de 5 años post-cierre no tiene disparador ejecutable por falta de un evento real (§5) — una limitación de datos, no de diseño.

## 34. Gate

Criterio del encargo aplicado literalmente: existe una política central versionada (§7); las categorías tienen reglas diferenciadas (§6); `response_json` tiene retención de 24 meses por defecto (§7-8); el contenido narrativo se elimina preservando la fila (§12-13); los metadatos permanecen (§13); `context_manifest` permanece (§13); consentimientos y declaraciones de agregación no se eliminan con la política de respuestas (§14-15); existen dry-run y apply (§23, §11); existe idempotencia (§24); existe reanudación (§25); existen lotes (§11); cross-org está bloqueado (§26, probado); RLS y privilegios son mínimos (§18-19); existe hold/preservación y bloquea la purga (§9, §26); la ejecución registra conteos sin contenido (§10, §30); no se almacena el contenido eliminado (§30); dos ejecuciones concurrentes no corrompen estado (§26, probado); un cambio de política invalida un dry-run anterior (§11, probado); la auditoría de operaciones críticas está garantizada transaccionalmente (§17); Stella permanece apagada; sin llamadas a Gemini; sin datos remotos; las pruebas aplicables pasan (§27, §30); la documentación coincide con el código.

**Estado: `APROBADO CON RESERVAS`** — backend transaccional y seguro completo y probado; la UI existe y compila mas no fue verificada visualmente en navegador; el disparador de retención post-cierre depende de un evento organizacional que el producto todavía no modela.

## 35. Próximo bloque recomendado

**Etapa A3 (revisión legal y contractual).** DR-004 queda técnicamente cerrado en el sentido que el encargo exige: mecanismo de retención diferenciada, purga transaccional, idempotente, reanudable, con preservación legal, funcionando de punta a punta contra el stack local. Los períodos (24 meses, 5 años post-cierre) son política técnica inicial — Etapa A3 debe validarlos contra contratos reales, DPA, y legislación aplicable antes de comprometerlos con clientes. Alternativamente, si el propietario prioriza cerrar la reserva de verificación visual de la UI (heredada también de Etapa A2.3.2) antes de avanzar a temas legales, una sesión dedicada a credenciales de prueba locales sería el paso más directo. **No se continúa automáticamente** — se espera indicación explícita del propietario sobre cuál seguir.
