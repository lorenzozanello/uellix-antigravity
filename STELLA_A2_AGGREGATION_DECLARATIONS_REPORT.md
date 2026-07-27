# Stella — Etapa A2.3.1: Declaraciones verificadas de agregación para datos de menores y salud. Informe de implementación

**Fecha:** 2026-07-26

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172`. Sin cambios respecto a todas las sesiones anteriores de esta cadena de trabajo — ningún commit se ha creado en ninguna de ellas.

## 2. Estado inicial

`git status`/`git branch --show-current`/`git rev-parse HEAD` confirmaron el mismo working tree con el que cerró Etapa A2.3, sin commits de por medio (mismos archivos modificados/nuevos ya reportados en sesiones previas, ninguno adicional antes de empezar).

## 3. Corrección del estado previo

Etapa A2.3 reportó correctamente en su propio documento (`STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md`, sección "Riesgos residuales #1") que ningún *context builder* podía producir una `AggregateDataDeclaration` real. Sin embargo, `STELLA_DECISION_REGISTER.md` resumió el resultado como "DR-002/DR-003 **IMPLEMENTADA TÉCNICAMENTE**" sin esa salvedad — una sobre-simplificación que este encargo pedía corregir explícitamente. Se corrigió a `IMPLEMENTACIÓN PARCIAL — BLOQUEO FAIL-CLOSED COMPLETADO; CAMINO DE AGREGADOS VERIFICADOS PENDIENTE` en ambos documentos (`STELLA_DECISION_REGISTER.md`, `STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md#Corrección`) antes de iniciar el trabajo de esta sesión. Se corrigió también, en el mismo documento anterior, el formato ambiguo `105/1447` por `105 archivos` / `1.447 pruebas` / `1.447 aprobadas`, y "clasificador calibrado" por "clasificador determinista inicial ajustado contra la suite sintética actual" (no existe evidencia estadística de calibración real).

## 4. Inventario de estructuras reutilizables

Búsqueda exhaustiva de `groupSize`, `populationSize`, `beneficiaryCount`, `participantCount`, `headcount`, `sampleSize`, `denominator`, `aggregation`, `verifiedBy`, `verifiedAt`, `minor`, `health`, `sensitive` en todo el repositorio:

- `groupSize` solo existía dentro de `lib/stella/context/sensitive-population.ts` (el contrato `AggregateDataDeclaration`, nunca persistido).
- `aggregation` aparecía en `lib/portfolios/analytics.ts` (agregación de ratios SROI a nivel de portafolio) y en `pii-detection.ts` — ninguno reutilizable para este propósito.
- **`financial_proxies.review_status`** (`suggested → pending_review → approved/rejected`, con `reviewer_id`/`reviewed_at`) es el **único precedente real** de un flujo de verificación humana sobre una fila mutable en todo el esquema — se usó como referencia de diseño para el estado `pending → verified` de la nueva tabla.
- **`stella_ai_consent_events`** (DR-005) es el precedente de un registro versionado con cadena de sustitución (`supersedes_event_id`) — se adaptó ese patrón (`supersedes_declaration_id` / `superseded_by_declaration_id`) para la nueva tabla, aunque aquí se eligió una fila de estado mutable, no un log de eventos puro (ver §6).
- Ninguna abstracción polimórfica (`entity_type`/`entity_id`) existía previamente — se confirmó que había que construirla desde cero.

## 5. Alternativas de diseño evaluadas

- **Opción A (columnas por entidad):** habría requerido añadir `sensitivePopulationCategory`/`aggregationGroupSize`/etc. a `outcomes`, `indicators`, `stakeholder_groups`, `evidence_items` y `sroi_report_sections` — 5 conjuntos de columnas casi idénticas, sin historial uniforme, mezclando gobernanza con datos de negocio. Descartada.
- **Opción C (tabla por tipo de entidad):** 5 tablas casi idénticas (`outcome_aggregation_declarations`, `indicator_aggregation_declarations`, etc.) — FKs estrictas pero duplicación de esquema y de cada servicio/prueba por tabla. Descartada por sobre-ingeniería para 5 tipos de entidad hoy.
- **Opción B (tabla central polimórfica) — elegida.** Un único modelo, historial uniforme, aplicable a los 6 tipos de entidad reales. Compensada según exige el encargo: allowlist estricta de `entity_type` (CHECK en la migración + `ALLOWED_SENSITIVE_ENTITY_TYPES` en código), validación de existencia + organización + proyecto en `entity-validation.ts` (una consulta por tipo, nunca solo una FK), pruebas por cada tipo autorizado, e índice único parcial para la restricción de unicidad.

## 6. Diseño elegido — estado e historial

Fila mutable con `verification_status` (`pending → verified → (revoked | superseded)`), NO un log de eventos append-only puro (a diferencia de `stella_ai_consent_events`): esta tabla se consulta en caliente en **cada** llamada a Stella con mención agregada, así que una fila de estado vigente es la consulta más simple y rápida, sin necesitar una tabla de estado derivado separada. El historial completo se reconstruye siguiendo `supersedes_declaration_id`/`superseded_by_declaration_id`. Los campos materiales (`group_size`, `sensitive_category`, `dimensions`, `verified_by`, `verified_at`) nunca se modifican in place tras la verificación: el servicio no expone ninguna función de "editar" — un cambio material siempre crea una declaración nueva vía `supersedeSensitiveAggregationDeclaration()`, que marca la anterior `superseded` y preserva ambas filas.

## 7. Modelo de datos

Ver `db/migrations/0046_stella_sensitive_aggregation_declarations.sql` y `db/schema.ts` (`stellaSensitiveAggregationDeclarations`). Columnas: `id`, `organization_id`, `project_id`, `entity_type`, `entity_id`, `sensitive_category`, `aggregation_level` (solo `'aggregate'`), `group_size`, `group_size_bucket`, `dimensions` (`text[]`), `count_source_type`, `count_source_id`, `count_source_note`, `verification_status`, `declared_by`, `verified_by`, `verified_at`, `policy_version`, `minimum_group_size_applied`, `revoked_by`, `revoked_at`, `revocation_reason`, `supersedes_declaration_id`, `superseded_by_declaration_id`, `created_at`, `updated_at`. **Minimización verificada:** ningún campo almacena nombres, diagnósticos, testimonios, direcciones, contenido de fuentes ni payloads enviados a Stella — `dimensions` solo admite códigos de una taxonomía fija (`age_band`, `gender`, etc.), nunca valores.

## 8. Invariantes

CHECK constraints para cada enum fijo (`entity_type`, `sensitive_category`, `aggregation_level`, `group_size_bucket`, `verification_status`, `count_source_type`); `group_size > 0`; pares obligatorios (`verified` exige `verified_by`+`verified_at`+`minimum_group_size_applied`; `revoked` exige `revoked_by`+`revoked_at`). Índice único parcial `ssad_active_unique_idx` sobre `(organization_id, project_id, entity_type, entity_id, sensitive_category) WHERE verification_status IN ('pending','verified')` — a lo sumo una declaración activa por entidad+categoría, verificado por prueba de integración (rechaza duplicado activo, permite una nueva tras revocar la anterior).

## 9. Política versionada

`lib/stella/aggregation/policy.ts`: `SENSITIVE_AGGREGATION_POLICY_VERSION = 'v1'`, `MINIMUM_SENSITIVE_GROUP_SIZE = 10` (única fuente de verdad — `lib/stella/context/sensitive-population.ts` ahora la reexporta en vez de redeclararla), `MINIMUM_GROUP_SIZE_BY_POLICY_VERSION` (historial por versión), `ALLOWED_SENSITIVE_ENTITY_TYPES`, `ALLOWED_AGGREGATION_DIMENSIONS`, `MAX_AGGREGATION_DIMENSIONS = 2`, `HIGH_RISK_DIMENSION_COMBINATIONS`. El cliente nunca puede enviar la versión o el umbral que desea aplicar — `declaration-query.ts` reclasifica una fila `verified` contra la política ACTUAL en cada consulta (`below_threshold`/`invalid_dimensions`/`outdated_policy` si el umbral o la allowlist cambiaron desde la verificación), nunca confiando ciegamente en el resultado histórico.

## 10. Tamaño mínimo

Entero positivo obligatorio (`Number.isInteger` + `> 0`) tanto en la validación estructural (`isValidAggregateDeclaration`, reutilizada) como en el servicio de creación/verificación — decimales, cero, negativos y strings numéricos se rechazan. El bucket (`below_10`/`10_49`/`50_249`/`250_plus`) se calcula **siempre en servidor** (`computeGroupSizeBucket`); un bucket enviado por el cliente se ignora (probado explícitamente en la suite adversarial).

## 11. Fuentes de conteo

`ALLOWED_COUNT_SOURCE_TYPES`: `project_record`, `indicator_measurement`, `stakeholder_record`, `verified_external_evidence`, `manual_verified_declaration`. La quinta categoría (declaración manual) no resuelve a una fila del sistema — de todas formas requiere verificación humana explícita (`organization_admin`) y solo admite una nota estructural corta (`count_source_note`, 255 caracteres), nunca el contenido del soporte.

## 12. Dimensiones y reidentificación

`ALLOWED_AGGREGATION_DIMENSIONS`: `age_band`, `gender`, `territory_level`, `program_period`, `education_level_band`, `condition_category` — códigos estructurales, nunca valores (verificado por prueba: cada código matchea `^[a-z_]+$`, nunca un nombre propio). Máximo 2 dimensiones simultáneas (`MAX_AGGREGATION_DIMENSIONS`). Combinaciones de alto riesgo bloqueadas aunque cada dimensión sea individualmente válida y estén dentro del máximo: `gender + territory_level`, `age_band + condition_category` — regla conservadora inicial, explicable, **no una garantía matemática de anonimización**.

## 13. Roles

`organization_admin` y `analyst` pueden **crear** (estado `pending`); solo `organization_admin` puede **verificar** o **revocar**, con coincidencia **EXACTA** de rol (sin bypass jerárquico de `super_admin` — mismo criterio que el gate de consentimiento de DR-005: un `super_admin` global sin membresía `organization_admin` explícita en la organización no puede aprobar datos sensibles en su nombre). `viewer`/`reviewer` no pueden crear ni verificar. Verificado explícitamente contra los roles reales de `lib/auth/roles.ts` antes de implementar.

## 14. RLS

`db/policies/011_stella_sensitive_aggregation_declarations_rls.sql`: SELECT para cualquier miembro activo de la organización (fila completa — sin separación por campo a nivel de RLS, documentado como decisión deliberada, no un descuido: la minimización de campos para `viewer` se resuelve en la capa de aplicación, ver §18); sin política de INSERT/UPDATE/DELETE (denegado por RLS); sin bypass general de `super_admin` (mismo criterio que DR-007).

## 15. Privilegios

`authenticated` = SELECT únicamente desde la creación de la tabla (migración `0046`); `anon` = ninguno; `service_role`/`postgres` = completo. Verificado con `has_table_privilege` antes y después de aplicar la política 011. Todas las escrituras legítimas pasan por `lib/stella/aggregation/declaration-service.ts` vía Drizzle sobre `DATABASE_URL` (rol `postgres`, bypasea RLS).

## 16. Servicios

`lib/stella/aggregation/`: `entity-validation.ts` (una consulta por tipo de entidad, valida existencia + organización + proyecto), `declaration-service.ts` (`createSensitiveAggregationDeclaration`, `verifySensitiveAggregationDeclaration`, `revokeSensitiveAggregationDeclaration`, `supersedeSensitiveAggregationDeclaration`), `declaration-query.ts` (`getSensitiveAggregationDeclarationStatus` — DTO mínimo sin actor/fechas de detalle; `findValidSensitiveAggregationDeclaration` — el que consulta `context-guardrails.ts`). Ningún rol, versión de política, umbral, bucket o timestamp de verificación se acepta nunca del cliente — todos se resuelven en el servicio.

## 17. Server actions

`app/actions/stella/aggregation-declarations.ts`: `createAggregationDeclaration`, `verifyAggregationDeclaration`, `revokeAggregationDeclaration`. Resuelven organización/actor vía `requireOrganizationAccess()`; delegan toda regla de negocio al servicio; registran auditoría content-free (`entityType`/`sensitiveCategory`/`reasonCode`, nunca `groupSize`/`dimensions` como valores) vía `logAuditAction()` con 3 acciones nuevas (`stella_sensitive_aggregation.{declared,verified,revoked}`).

## 18. Integración por context builder

Auditados los 4 *context builders* (`advisor`, `composer`, `validator` — `reviewer` reutiliza `validator`). Ningún *builder* necesitó cambios: `StellaProjectContext` ya carga los IDs reales de cada entidad (`o.id`, `i.id`, `e.id`, `s.id`) y el `organizationId`/`projectId` a nivel de contexto — `context-guardrails.ts` deriva la entidad de origen de cada cadena escaneada combinando esa información ya presente, sin ampliar el contexto ni inventar una declaración a nivel de proyecto para cubrir todas las entidades. `narrativeSummary` se mapea a `entityType: 'project'` (es agregado de `impact_narratives`, a nivel de proyecto, no de una fila específica). Se decidió **bloquear la acción completa** (no excluir el campo y continuar) cuando una mención agregada no tiene declaración válida, consistente con el comportamiento fail-closed ya establecido en Etapa A2.3 — excluir silenciosamente el campo y continuar generaría una respuesta potencialmente engañosa sin que el usuario supiera que se omitió información.

**Hallazgo adicional del audit:** `context.reportSections[].title` nunca se escaneaba en `collectContextStrings()` desde Etapa A1 — brecha preexistente, ahora cerrada (`collectContextEntityStrings` la incluye).

## 19. Integración con `sensitive-population.ts`

`assertContextHasNoForbiddenData()` (ahora `async`) mantiene el orden exacto del encargo: señal individual o de reidentificación → bloqueo inmediato, **sin consultar ninguna declaración** (una declaración de agregación nunca legitima un dato individual); mención agregada sin veredicto → consulta `findValidSensitiveAggregationDeclaration()` acotada a `organizationId`+`projectId`+`entityType`+`entityId`+`sensitiveCategory` exactos; el resultado (declaración válida o `null`) se pasa de vuelta a `assessSensitiveData()`, reutilizando el 100% de su lógica existente de umbral/dimensiones/cotejo declarado-vs-mencionado, sin duplicarla.

## 20. Manifest

Sin cambios de forma — la bandera `sensitive_population_aggregate_present` (Etapa A2.3) ya cubre el caso permitido correctamente, porque `assessSensitiveData()` sigue devolviendo `category !== 'none'` para un agregado permitido, con o sin declaración real detrás. Verificado que la suite de manifiesto sigue en verde y que ningún valor de dimensión/tamaño exacto se filtra al manifiesto.

## 21. Errores

Sin códigos nuevos — los 5 códigos tipados de Etapa A2.3 (`SENSITIVE_GROUP_SIZE_REQUIRED`, etc.) ya cubren el resultado de una consulta de declaración fallida o ausente, porque `assessSensitiveData()` produce el mismo `reasonCode` sin importar si la causa es "nunca existió declaración" o "existía pero ya no es válida bajo la política actual". Se añadieron 3 acciones de auditoría nuevas para el ciclo de vida de la declaración misma (§17), no para el bloqueo de contexto.

## 22. UI

Se inspeccionaron las pantallas reales del producto: no existe hoy ninguna sección de configuración de proyecto para datos sensibles, ni una pantalla de administración de Stella más allá de `/admin/services` (cuotas). **No se inventó una sección grande.** Se dejaron listos los servicios y *server actions*; la UI queda documentada como tarea futura de producto (fila `STL-A231-023`, `Pending`, `DecisionRequired=Sí`). Esto significa que el flujo solo es operable desde código/consola hoy — afecta directamente el gate (§31).

## 23. Auditoría

`logAuditAction()` (tabla `audit_logs`, ya existente) registra creación/verificación/revocación de declaraciones con `entityType`/`sensitiveCategory`/`reasonCode` únicamente — nunca `groupSize`, `dimensions` como valores, ni el motivo de revocación como texto libre sensible (verificado por prueba: `JSON.stringify(auditArg)` no contiene el tamaño de grupo). Los bloqueos de contexto siguen auditándose igual que en Etapa A2.3 (`stella_sensitive_data.blocked`, sin cambios).

## 24. Pruebas

| Archivo | Casos |
|---|---|
| `lib/stella/aggregation/__tests__/policy.test.ts` | 18 |
| `lib/stella/aggregation/__tests__/entity-validation.test.ts` | 15 |
| `lib/stella/aggregation/__tests__/declaration-service.test.ts` | 39 |
| `lib/stella/aggregation/__tests__/declaration-query.test.ts` | 17 |
| `lib/stella/aggregation/__tests__/declaration-adversarial.test.ts` | 18 |
| `app/actions/stella/__tests__/aggregation-declarations.test.ts` | 9 |
| `lib/stella/context/__tests__/context-guardrails.test.ts` (ampliada) | 19 |
| `tests/integration/stella-sensitive-aggregation-declarations-rls.test.ts` (nueva) | 11 |
| `tests/integration/stella-sensitive-aggregation-e2e.test.ts` (nueva) | 3 |

**Total nuevas:** 149 pruebas en 9 archivos.

## 25. Comandos ejecutados

`npx tsc --noEmit` (múltiples veces durante el desarrollo) · `npx eslint .` · `npx drizzle-kit check` (antes y después de aplicar la migración) · `npx drizzle-kit migrate --config=drizzle.local.config.ts` (aplicación al stack local, config con guarda de host hardcodeada a loopback) · aplicación manual de la política 011 vía un script temporal con el paquete `postgres` (eliminado tras usarlo) · `npx vitest run lib/stella/aggregation/__tests__/*` · `npx vitest run app/actions/stella/__tests__/aggregation-declarations.test.ts` · `npx vitest run lib/stella/context/__tests__/context-guardrails.test.ts` (y el resto de la suite de `sensitive-population`) · `npx vitest run --config vitest.integration.config.ts` (suite completa, x3 durante el desarrollo) · `npx vitest run --exclude "tests/integration/**"` (suite unitaria completa) · validación estructural del CSV (script temporal, eliminado tras usarlo).

## 26. Resultados exactos

- `tsc --noEmit`: limpio, 0 errores.
- `eslint .`: 0 errores, **56 warnings** (línea base sin cambio respecto a Etapa A2.3 — ninguna advertencia nueva introducida por este bloque).
- `drizzle-kit check`: "Everything's fine", sin drift, antes y después de la migración `0046`.
- Suite unitaria completa (`--exclude tests/integration/**`): **111 archivos**, **1.569 pruebas**, **1.569 aprobadas**, **0 fallidas**.
- Suite de integración (`--config vitest.integration.config.ts`): **8 archivos**, **92 pruebas**, **92 aprobadas**, **0 fallidas**.
- CSV: 129 filas de datos, 18 columnas, 0 filas malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden topológico.
- **Llamadas a Gemini real:** No.
- **Datos remotos:** No — toda escritura/lectura de esta sesión fue contra el stack local de Supabase (`127.0.0.1:55322`), con `drizzle.local.config.ts` validando explícitamente el host antes de migrar.
- **Acceso externo observado:** No.
- **Build con red deshabilitada:** No ejecutado — no se tocó ninguna ruta, componente ni configuración de Next.js en este bloque (solo `lib/`, `app/actions/stella/`, `db/`, tests), misma condición usada en bloques anteriores para omitirlo.
- **Flags modificados:** No (`STELLA_ENABLED` y los 6 flags por rol permanecen en su valor por defecto).
- **Migraciones remotas:** No — solo `db:migrate:local`, contra el stack local.
- **Commits:** No.

## 27. Riesgos residuales

1. **Sin UI operativa para crear/verificar declaraciones** — el flujo solo es alcanzable desde código/consola hoy. Este es el motivo directo por el que el gate se marca `APROBADO CON RESERVAS`, no `APROBADO`.
2. **`MINIMUM_GROUP_SIZE_BY_POLICY_VERSION` tiene una sola entrada hoy** (`v1: 10`) — la reclasificación `outdated_policy`/`below_threshold` por cambio de política es una capacidad construida y probada, pero no tiene ningún caso real que la dispare todavía (no ha habido un cambio de umbral).
3. **`count_source_note` para `manual_verified_declaration` depende de que el humano que la escribe respete la convención de "nunca contenido sensible"** — el campo es estructuralmente corto (255 caracteres) pero no hay una validación de contenido más allá de eso; documentado como límite de un control basado en convención, no en verificación de contenido.
4. **`supersedeSensitiveAggregationDeclaration` no usa una transacción de base de datos** de dos escrituras — un fallo entre la creación de la nueva declaración y la marca de "superseded" en la anterior podría, en teoría, dejar ambas activas momentáneamente. Riesgo bajo (acción administrativa de baja frecuencia, no una ruta caliente), documentado explícitamente en el código, no oculto.
5. **La lista de dimensiones/combinaciones de alto riesgo es conservadora e inicial**, no una resolución matemática de k-anonimato — mismo límite ya documentado para el módulo de clasificación de texto en Etapa A2.3.

## 28. Trabajo no realizado (fuera de alcance, expresamente)

Activación de `STELLA_ENABLED`/flags por rol, llamadas reales a Gemini, evaluaciones reales, bases de datos remotas, despliegue, push, commits, seeds, variables de Vercel, edición de migraciones ya aplicadas, DR-004 (retención), modificaciones a DR-005/DR-007 más allá de lo ya cerrado, Etapa A3, prompts por paso, sugerencias/reformulación, procesamiento de documentos reales, Evidence Intelligence, OCR/grounding/RAG/embeddings/pgvector, opción de "enviar de todos modos", reducción del umbral de 10, UI de gestión de declaraciones (diseñada a nivel de servicio, no implementada — §22).

## 29. Estado final de DR-002

`APROBADO CON RESERVAS`. El bloqueo fail-closed (Etapa A2.3) y el camino de agregados verificados (esta sesión) están ambos implementados y probados de punta a punta contra el stack local. Reserva: sin UI operativa (§22, §27.1).

## 30. Estado final de DR-003

`APROBADO CON RESERVAS`, misma base y misma reserva que DR-002 (mecanismo compartido).

## 31. Gate

Se cumplen los 24 criterios de la sección 31 del encargo: fuente estructurada de tamaño de grupo vinculada a una entidad real (§7-8); misma organización/proyecto verificados en cada creación (§4 de `entity-validation.ts`, probado); tamaño verificado por actor autorizado con coincidencia exacta de rol (§13); umbral resuelto en servidor, nunca del cliente (§10, probado en la suite adversarial); política versionada (§9); una declaración antigua puede invalidarse por cambio de política (§9, capacidad construida y probada aunque hoy no tiene caso real — riesgo #2); estados `pending`/`verified`/`revoked`/`superseded` existentes y probados (§6); histórico conservado vía `supersedes`/`superseded_by` (§6, §16); privilegios mínimos (§15); RLS aísla organizaciones (§14, probado); un cliente no se autoaprueba (RLS deniega INSERT/UPDATE directo, probado con `42501`); los 4 *context builders* consultan declaraciones reales de forma acotada (§18-19); prueba end-to-end local con grupo 10 permitido (§24, `stella-sensitive-aggregation-e2e.test.ts`); prueba con grupo 9 bloqueado (mismo archivo); una declaración nunca justifica información individual (§19, probado — la rama individual nunca consulta una declaración); una declaración cross-org o de otra entidad nunca se reutiliza (probado en la suite adversarial e integración); sin consumo de cuota/rate-limit/modelo ante declaración inválida (heredado del orden ya probado en Etapa A2.3, sin cambios); manifest sin valores sensibles (§20); DR-001/DR-005/DR-007 sin regresión (suite completa en verde); documentación coincide con el código.

**Único criterio no alcanzable en su forma completa:** una UI operativa para que un `organization_admin` cree/verifique declaraciones sin tocar código — explícitamente permitido por el encargo como motivo de `APROBADO CON RESERVAS` en vez de `REPROBADO`, siempre que la seguridad de backend esté completa (lo está).

**Estado: `APROBADO CON RESERVAS`.**

## 32. Próximo bloque recomendado

`DR-004` (política de retención de `stella_interactions`/`context_manifest`), ahora que DR-002/DR-003 tienen un camino de agregados verificados realmente operativo a nivel de backend. Alternativamente, la UI de gestión de declaraciones (§22, `STL-A231-023`) si el propietario prioriza hacer el flujo operable para usuarios de producto antes de continuar con nuevas decisiones de gobernanza. **No se continúa automáticamente** — se espera indicación explícita del propietario sobre cuál seguir.

---

## Adenda — Etapa A2.3.2 (2026-07-26): cierre de las reservas operativas

**No se reescribe el contenido anterior de este documento** — permanece como registro fiel de lo que era cierto el 2026-07-26 antes de este bloque. Esta adenda documenta qué cambió.

Las 8 reservas operativas identificadas para este bloque, y su cierre concreto:

1. **UI operativa (§22, §27.1, `STL-A231-023`)** — cerrada. `components/aggregation/OutcomeSensitiveAggregationWrapper.tsx` (servidor, resuelve rol exacto) + `components/aggregation/OutcomeSensitiveAggregationPanel.tsx` (cliente: resumen, historial, crear/verificar/revocar/sustituir), montado por-outcome en `app/app/projects/[projectId]/pipeline/outcomes/page.tsx`. 23 pruebas de componente (`components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx`). `STL-A231-023` permanece `Pending` en el CSV histórico de Etapa A2.3.1 (no se reescribe); el cierre real queda registrado en el bloque `STL-A232-*`.
2. **Sustitución (supersede) transaccional (§27.4)** — cerrada. `supersedeSensitiveAggregationDeclaration` ahora corre dentro de `db.transaction`, con `SELECT ... FOR UPDATE` sobre la fila anterior y reversión completa ante cualquier fallo interno (probado con una colisión de índice único real y con una entidad inexistente — ninguna fila huérfana queda atrás en ningún caso). Bug real encontrado y corregido durante esta prueba: el orden original (insertar antes de marcar `superseded`) colisionaba consigo mismo cuando ambas filas comparten entidad+categoría.
3. **Cambio de política real v1→v2 (§27.2)** — cerrada sin tocar la constante productiva. `SensitiveAggregationPolicy` (interfaz inyectable) + `resolveDeclarationStatus(row, policy)` permiten una prueba real con una política v2 ficticia (umbral 15): una declaración v1/grupo=10 pasa a `below_threshold`/`outdated_policy`, `CURRENT_SENSITIVE_AGGREGATION_POLICY` nunca cambia de valor en la prueba.
4. **Restricción de unicidad a nivel de base de datos** — ya existía (`ssad_active_unique_idx`, migración `0046`, §8); esta sesión no añadió una migración nueva, solo confirmó (con 2 pruebas de concurrencia reales) que es efectivamente el respaldo correcto para colisiones de CREATE concurrente y de sustitución concurrente.
5. **Concurrencia probada contra Postgres real** — cerrada. 6 escenarios reales vía `Promise.all` en `tests/integration/stella-sensitive-aggregation-transactions.test.ts`: doble verificación, verificar-vs-revocar, doble creación, sustituir-vs-revocar, doble sustitución — cada uno con exactamente un ganador y un estado final consistente.
6. **Patrón N+1 en el guardarrail** — cerrado. `findValidSensitiveAggregationDeclarations` (batch, `inArray`, tope `MAX_BATCH_ENTITIES=200`) sustituye la consulta por-mención; `context-guardrails.ts` ahora clasifica todas las cadenas en una pasada síncrona y resuelve todas las menciones agregadas pendientes en **una** consulta, nunca N.
7. **Mensajes de bloqueo + operabilidad desde producto** — cerrada. Los 5 mensajes de `SENSITIVE_DATA_BLOCK_MESSAGES` reescritos como instrucción accionable (nunca solo descripción del problema); el ciclo completo (crear/verificar/revocar/sustituir/ver historial) es ahora operable desde la UI del producto, no solo desde código/consola.
8. **Prueba end-to-end completa (acción administrativa → guardarrail)** — cerrada. `tests/integration/stella-sensitive-aggregation-e2e.test.ts` ampliada con un cuarto caso: declaración verificada desbloquea → sustituir crea sucesora `pending` (re-bloquea) → verificar la sucesora desbloquea → la anterior `superseded` no puede re-verificarse. Los 3 casos ya existentes (grupo 10 permitido, grupo 9 bloqueado, entidad distinta no desbloquea) se re-confirmaron sin cambios de comportamiento.

**Riesgos residuales de §27 — estado actualizado:** #1 (sin UI) cerrado — ver punto 1. #2 (una sola entrada de política) sigue siendo cierto en el sentido literal (`MINIMUM_GROUP_SIZE_BY_POLICY_VERSION` todavía solo tiene `v1`), pero la CAPACIDAD de reclasificación ante un cambio real ya está probada con una política inyectada (punto 3) — el riesgo restante es solo "nunca ocurrió en producción", no "no está probado". #3 (`count_source_note` depende de convención humana) sigue vigente, sin cambios. #4 (supersede sin transacción) cerrado — ver punto 2. #5 (dimensiones conservadoras, no k-anonimato matemático) sigue vigente, sin cambios — documentado, no oculto.

**Gate de este bloque:** ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md` para el detalle completo (arquitectura, comandos ejecutados, resultados exactos, y el veredicto formal `APROBADO`/`APROBADO CON RESERVAS`/`REPROBADO`).
