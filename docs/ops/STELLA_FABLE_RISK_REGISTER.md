# STELLA FABLE MOONSHOT — Registro de Riesgos

> Última actualización: 2026-07-31 (bootstrap; auditoría base sobre `dd36a4e`)
> Severidad: P0 = bloquea el release candidate offline · P1 = degrada calidad/confianza · P2 = mejora.
> Estado: ABIERTO / MITIGADO / ACEPTADO (con firma de decisión en DECISIONS.md).

## P0 — Bloqueadores del Offline Release Candidate

| ID | Riesgo | Evidencia | Workstream | Estado |
|----|--------|-----------|------------|--------|
| RK-01 | **Paridad de contexto rota**: `buildAdvisorContext` nunca puebla 7 campos de `ContextualAdvisorContext` (`projectName`, `stakeholdersSnapshot`, `activitiesSummary`, `calculationReadiness`, `filterSetsSummary=[]`, `calculationSnapshot=null`, `reportSections=[]`); tipa por subtipado estructural. Los 28 casos de eval no certifican la forma real de producción | `lib/stella/context/build-advisor-context.ts:221-236`, `context/types.ts:139-158` | WS1 | ABIERTO |
| RK-02 | **R1–R6 abiertas en código** pese al cierre documental de B1.1C (colecciones vacías sin sentinela; sin validación de pertinencia; catálogo sin filtrar por step; fuga de índices sin post-proceso; fixtures `complete` incompletos; refusal condicional) | `canonical-source-field-paths.ts:21-23`, `validate-contextual-source-fields.ts:46`, `build-advisor-step-context.ts:32-38`, `advisor-contextual-system.ts:31-38`, `tests/eval/stella-contextual/cases.ts:9-10` | WS1 | ABIERTO |
| RK-03 | **Advisor contextual sin UI**: `getStellaContextualAdvisor` tiene cero consumidores fuera de tests; el panel montado usa el path legacy sin citas | `components/stella/StellaAdvisorPanel.tsx:9,40` | WS2 | ABIERTO |
| RK-04 | **`stella_interactions` no es append-only de verdad**: sin trigger `uellix_forbid_mutation` (0030 no la cubre) y `0033_public_api_grants.sql:50` concede UPDATE/DELETE a `authenticated`; cero tests del claim | `db/migrations/0030_immutability.sql:10-23`, `0033_public_api_grants.sql:50`, `db/policies/002_stella_interactions_rls.sql` | WS3 | ABIERTO |
| RK-05 | **Harness de evaluación con scores constantes**: safety/schema/numeric hardcodeados a 2; `adversarialCasesPassed` cuenta casos seleccionados, no aprobados; detectores sólo sobre `summary` | `tests/eval/stella-contextual/harness.ts:117-118`, `tests/eval/stella-contextual-real/runner.ts:167-168,222` | WS1/WS6 | ABIERTO |
| RK-06 | **Anti-regression con placeholders**: 3 tests `expect(true).toBe(true)` custodian los límites más críticos (no-import de cálculo, no-write DB, no-certificación) | `lib/stella/__tests__/anti-regression.test.ts:14,27,56` | WS3/WS4 | ABIERTO |
| RK-07 | **Prompt injection sin defensa en roles legacy**: advisor/validator/composer/reviewer interpolan texto de usuario sin delimitar (`markAsData()` es dead code); lista de patrones prohibidos sin marcadores de inyección; **cero tests de inyección** (el spec Sprint 9 exige `prompt-injection.test.ts` y no existe) | `advisor-system.ts:41-60`, `validator-system.ts:51-75`, `composer-system.ts:57-106`, `sanitize.ts:4-14,67-69` | WS3 | ABIERTO |
| RK-08 | **Poblaciones sensibles: 0% de salvaguardas** — sin flag de proyecto, sin revisión elevada, sin guardrail específico; `stakeholderGroups.type` se consulta y se descarta antes del prompt | grep repo-wide sin resultados; `build-advisor-context.ts:92` | WS3 | ABIERTO |
| RK-09 | **PII sin redacción**: narrativas libres llegan a Gemini sin redactar emails/teléfonos/IDs y el output completo se persiste indefinidamente en `response_json` sin política de retención | `sanitize.ts:46-52`, `db/schema.ts:628` | WS3 | ABIERTO |

## P1 — Degradan calidad o confianza

| ID | Riesgo | Evidencia | WS | Estado |
|----|--------|-----------|----|--------|
| RK-10 | Sin dedup ni tope de cardinalidad en referencias; cualquier problema de cita → PARSE_ERROR total (sin fallback contextual) | `decode-provider-source-ref-indexes.ts:45-48`, `lib/stella/fallbacks.ts` | WS1 | ABIERTO |
| RK-11 | Sin persistencia de decisiones (aceptar/rechazar/editar) ni historial ni undo; aplicar borrador Composer escribe DOM imperativo y destruye contenido sin confirmación | `StellaComposerPanel.tsx:70-75` | WS2/WS3 | ABIERTO |
| RK-12 | Invocaciones Stella invisibles en `audit_logs`/panel admin de logs; denegaciones (quota/rate-limit/parse) no dejan rastro | `lib/audit/logger.ts:36`, `app/actions/stella/advisor.ts:73-92` | WS3 | ABIERTO |
| RK-13 | Taxonomía de errores colapsada en paneles (RATE_LIMITED sin reset, TIMEOUT genérico); DISABLED desmonta el panel post-click | `StellaAdvisorPanel.tsx:47-57` | WS2 | ABIERTO |
| RK-14 | Documentos de evidencia son blobs write-only: sin extracción, sin retrieval, sin signed URL de descarga; `content_hash` mutable (fuera de 0030) debilita el manifiesto del PDF | `lib/pipeline/evidence.ts`, `db/migrations/0030_immutability.sql` | WS5/WS3 | ABIERTO |
| RK-15 | Precisión Decimal global sin fijar (`Decimal.set` inexistente) y sin golden test del ratio; `parseFloat` en porcentajes dentro del motor | `lib/pipeline/sroi-calculation.ts:79-83,643-654` | WS4 | ABIERTO |
| RK-16 | Composer no valida `evidence_references`/`proxy_references` contra el contexto (superficie de alucinación de IDs) | `lib/stella/schemas/composer-output.ts:20-37` | WS4/WS6 | ABIERTO |
| RK-17 | Roles reviewer comparten contexto del validator: prompts piden datos que el contexto no provee; flags ausentes de `.env.example` (inalcanzables); sin tests de panel ni de acción | `build-reviewer-context.ts:19`, `lib/stella/config.ts:20-22` | WS6 | ABIERTO |
| RK-18 | `risk_level=high` del validator no bloquea publicación de reportes (solo advisory) | `app/actions/stella/validator.ts` | WS4/WS6 | ABIERTO |
| RK-19 | `stepMismatch` del proveedor se descarta en producción sin métrica ni log | `decode-provider-source-ref-indexes.ts:82-87` | WS1/WS7 | ABIERTO |
| RK-20 | CHECK de roles desincronizado entre migración 0012 y `db/schema.ts:635` (reviewer roles) — el constraint desplegado puede no coincidir con el código (0027 lo amplía; verificar cadena aplicada) | `db/migrations/0012_stella_interactions.sql`, `0027_little_midnight.sql` | WS3 | VERIFICAR |
| RK-21 | **Cualquier miembro (incl. `viewer`) puede invocar Stella** y agotar la cuota de la org: no existe `canUseStella` en `lib/auth/permissions.ts`; sólo `requireOrganizationAccess` | `app/actions/stella/*.ts`, `lib/auth/permissions.ts` | WS3 | ABIERTO |
| RK-22 | **Sin control de gasto**: sin `maxOutputTokens`/temperature en el adapter, sin tope de tamaño de prompt (arrays sin límite), `tokens_used` se escribe pero jamás se lee/agrega; cuota cuenta requests, no tokens; llamadas fallidas no cuentan contra cuota | `gemini-client.ts:52-61`, `lib/stella/quota.ts:47` | WS3/WS7 | ABIERTO |
| RK-23 | **Fallos de Gemini invisibles para Sentry**: las server actions tragan todo error a resultado tipado; cero `Sentry.captureException` en app/lib/components; sin métricas ni request id | `app/actions/stella/advisor.ts:112-121`, grep Sentry | WS7 | ABIERTO |
| RK-24 | Rate limit con fallback en memoria por instancia (serverless ⇒ límite efectivo N×100/h) y sin aviso si faltan las vars KV | `lib/stella/rate-limit.ts:37-58` | WS3/WS7 | ABIERTO |
| RK-25 | Billing UI contradice el fail-closed: fallback hardcodeado `\|\| 10` de cuota vs default DB 0-bloqueado; texto admin dice "no hay pasarela" pero existe portal Stripe | `app/app/organization/billing/page.tsx:5,15`, `app/admin/services/page.tsx:22` | WS7 | ABIERTO |
| RK-26 | `artifacts/` no está en `.gitignore` — un `git add -A` accidental comitearía prompts/respuestas crudas de evaluaciones reales | `.gitignore` | WS3 | MITIGAR EN BOOTSTRAP |
| RK-27 | Fixtures realistas (`audit-fixtures/agua-segura`, generador determinista con seed) nunca conectados al harness de eval — las dos inversiones en realismo no se encuentran | `audit-fixtures/agua-segura/generate.mjs`, `tests/eval/stella-contextual/cases.ts` | WS1/WS6 | ABIERTO |
| RK-28 | Redacción de secretos por substring exacto (una key URL-encoded o truncada en el error del proveedor no matchea); `stellaState.missingApiKey` computado y nunca consumido | `gemini-client.ts:124-135`, `config.ts:34` | WS3 | ABIERTO |
| RK-29 | Harness real sólo cubre advisor contextual: validator/composer/reviewer sin harness de proveedor real; sin script pnpm para el runner | `tests/eval/stella-contextual-real/` | WS6 | ABIERTO |

## P2 — Mejoras

| ID | Riesgo | WS |
|----|--------|-----|
| RK-30 | Reformulation declarativo (15%): sin prompt propio, sin trigger, sin UI, sin flag | WS6 |
| RK-31 | Confidence score mide higiene del registro, no calidad del contenido; fallos de recálculo silenciosos | WS5 |
| RK-32 | Búsqueda de proxies: 1 de 8 filtros del spec 15 implementado | WS5/WS7 |
| RK-33 | FX oracle no cableado a inversiones (EUR dead-end); comentario invertido en `rateToUsd` | WS4 |
| RK-34 | Accesibilidad: aria-live condicional, saltos de heading, hex hardcodeado | WS2 |
| RK-35 | Doble build de contexto en `buildAdvisorContextualUserMessage` (punto latente de divergencia) | WS1 |
| RK-36 | `build-composer-context.test.funder-breakdown.ts` puede no coincidir con el glob de vitest — verificar que ejecuta | WS4 |
| RK-37 | Mensajes de bloqueo del motor mezclan inglés/español | WS4 |

## Riesgos de campaña (proceso)

| ID | Riesgo | Mitigación |
|----|--------|-----------|
| RC-01 | Colisión de archivos entre workstreams paralelos | Zonas calientes con dueño único (DEPENDENCY_MAP §Reglas) |
| RC-02 | Agotar presupuesto dejando ramas incoherentes | Checkpoints por unidad atómica; regla 80 % (MOONSHOT §Presupuesto) |
| RC-03 | Operación remota accidental | Protecciones deny verificadas (FASE G) |
| RC-04 | Declarar éxito sin evidencia | RELEASE_CRITERIA C1–C18 con verificación por comando |
| RC-05 | Auto-auditoría del implementador | Auditor independiente obligatorio por fase (FASE F) |

*(Registro completo tras las 6 auditorías base del 2026-07-31. Fortalezas confirmadas que NO son riesgo: aislamiento organizacional ~90 % (orgId siempre de sesión, ownership check en cada builder), manejo de secretos ~85 % (import dinámico, sin singleton, redacción testeada), harness real con guards cuádruples y checkpointing transaccional ~85 %, motor SROI determinístico ~90 %.)*
