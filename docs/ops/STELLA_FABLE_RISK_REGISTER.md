# STELLA FABLE MOONSHOT — Registro de Riesgos

> Última actualización: 2026-07-31 (bootstrap; auditoría base sobre `dd36a4e`)
> Severidad: P0 = bloquea el release candidate offline · P1 = degrada calidad/confianza · P2 = mejora.
> Estado: ABIERTO / MITIGADO / ACEPTADO (con firma de decisión en DECISIONS.md).

## P0 — Bloqueadores del Offline Release Candidate

| ID | Riesgo | Evidencia | Workstream | Estado |
|----|--------|-----------|------------|--------|
| RK-01 | Paridad de contexto rota (7 campos nunca poblados) | merge `24b122c` | WS1 | **MITIGADO** (18/18 campos poblados con queries org-scoped; test de paridad estricto; readiness inyectable — wiring del action pendiente en coordinador) |
| RK-02 | R1–R6 abiertas en código | merge `24b122c` | WS1 | **MITIGADO OFFLINE** (R1 sentinelas, R3 slices por step, R4 validador de fugas ±corchetes, R5 fixtures completos, R6 refusal categórico; R2 pertinencia sigue siendo heurística — validación semántica plena queda para G1) |
| RK-03 | **Advisor contextual sin UI**: `getStellaContextualAdvisor` tiene cero consumidores fuera de tests; el panel montado usa el path legacy sin citas | `components/stella/StellaAdvisorPanel.tsx:9,40` | WS2 | ABIERTO |
| RK-04 | `stella_interactions` sin trigger append-only + grants UPDATE/DELETE | `db/prepared/stella_0002_*.sql`, `tests/integration/rls.test.ts` (casos staged) | WS3 | **PREPARADO** (SQL con rollback + tests RLS duales pre/post; la APLICACIÓN es gate externo G2 — ver G2_PACKAGE.md) |
| RK-05 | Harness con scores constantes y detectores sólo sobre summary | merge `24b122c` | WS1/WS6 | **MITIGADO** (scores computados de runs reales de detectores sobre todos los campos de texto; adversarialCasesPassed cuenta pases reales; limitación de short-circuit documentada en G1 §7) |
| RK-06 | **Anti-regression con placeholders**: 3 tests `expect(true).toBe(true)` custodian los límites más críticos (no-import de cálculo, no-write DB, no-certificación) | `lib/stella/__tests__/anti-regression.test.ts:14,27,56` | WS3/WS4 | ABIERTO |
| RK-07 | **Prompt injection sin defensa en roles legacy**: advisor/validator/composer/reviewer interpolan texto de usuario sin delimitar (`markAsData()` es dead code); lista de patrones prohibidos sin marcadores de inyección; **cero tests de inyección** (el spec Sprint 9 exige `prompt-injection.test.ts` y no existe) | `advisor-system.ts:41-60`, `validator-system.ts:51-75`, `composer-system.ts:57-106`, `sanitize.ts:4-14,67-69` | WS3 | ABIERTO |
| RK-08 | **Poblaciones sensibles: 0% de salvaguardas** — sin flag de proyecto, sin revisión elevada, sin guardrail específico; `stakeholderGroups.type` se consulta y se descarta antes del prompt | grep repo-wide sin resultados; `build-advisor-context.ts:92` | WS3 | ABIERTO |
| RK-09 | **PII sin redacción**: narrativas libres llegan a Gemini sin redactar emails/teléfonos/IDs y el output completo se persiste indefinidamente en `response_json` sin política de retención | `sanitize.ts:46-52`, `db/schema.ts:628` | WS3 | ABIERTO |

## P1 — Degradan calidad o confianza

| ID | Riesgo | Evidencia | WS | Estado |
|----|--------|-----------|----|--------|
| RK-10 | Sin dedup/tope de referencias ni fallback contextual | merge `24b122c` | WS1 | **MITIGADO** (dedup orden-preservante, tope 8 distintas fail-closed, fallback contextual schema-válido sólo en ContextualIndexTokenLeakError; índices inválidos siguen PARSE_ERROR por contrato congelado del action) |
| RK-11 | Sin persistencia de decisiones (aceptar/rechazar/editar) ni historial ni undo; aplicar borrador Composer escribe DOM imperativo y destruye contenido sin confirmación | `StellaComposerPanel.tsx:70-75` | WS2/WS3 | ABIERTO |
| RK-12 | Invocaciones/denegaciones Stella invisibles en `audit_logs` | merge `3e967d0` | WS3 | **MITIGADO** (STELLA_INVOKED/DENIED/INTEGRITY_REJECTED/DECISION_RECORDED, metadata-only con canaries de fuga, fire-and-forget) |
| RK-13 | Taxonomía de errores colapsada en paneles (RATE_LIMITED sin reset, TIMEOUT genérico); DISABLED desmonta el panel post-click | `StellaAdvisorPanel.tsx:47-57` | WS2 | ABIERTO |
| RK-14 | Documentos de evidencia son blobs write-only: sin extracción, sin retrieval, sin signed URL de descarga; `content_hash` mutable (fuera de 0030) debilita el manifiesto del PDF | `lib/pipeline/evidence.ts`, `db/migrations/0030_immutability.sql` | WS5/WS3 | ABIERTO |
| RK-15 | Precisión Decimal global sin fijar y sin golden test del ratio; `parseFloat` en el motor | `lib/pipeline/decimal-config.ts` + goldens | WS4 | **MITIGADO** (merge `5ffbf52`: pin explícito importado por sroi-*/fx-*, goldens exactos re-derivados por auditor, parseNum Decimal con paridad caracterizada) |
| RK-16 | Composer no valida referencias ni cifras contra contexto (alucinación) | `lib/stella/schemas/composer-numeric-guard.ts` | WS4/WS6 | **PARCIAL** (guard construido y endurecido post-auditoría; WIRING pendiente en composer.ts — coordinador) |
| RK-17 | Roles reviewer comparten contexto del validator: prompts piden datos que el contexto no provee; flags ausentes de `.env.example` (inalcanzables); sin tests de panel ni de acción | `build-reviewer-context.ts:19`, `lib/stella/config.ts:20-22` | WS6 | ABIERTO |
| RK-18 | `risk_level=high` del validator no bloquea publicación de reportes (solo advisory) | `app/actions/stella/validator.ts` | WS4/WS6 | ABIERTO |
| RK-19 | `stepMismatch` del proveedor se descarta en producción sin métrica ni log | `decode-provider-source-ref-indexes.ts:82-87` | WS1/WS7 | ABIERTO |
| RK-20 | CHECK de roles desincronizado entre migración 0012 y `db/schema.ts:635` (reviewer roles) — el constraint desplegado puede no coincidir con el código (0027 lo amplía; verificar cadena aplicada) | `db/migrations/0012_stella_interactions.sql`, `0027_little_midnight.sql` | WS3 | VERIFICAR |
| RK-21 | **Cualquier miembro (incl. `viewer`) puede invocar Stella** y agotar la cuota de la org: no existe `canUseStella` en `lib/auth/permissions.ts`; sólo `requireOrganizationAccess` | `app/actions/stella/*.ts`, `lib/auth/permissions.ts` | WS3 | ABIERTO |
| RK-22 | **Sin control de gasto**: sin `maxOutputTokens`/temperature en el adapter, sin tope de tamaño de prompt (arrays sin límite), `tokens_used` se escribe pero jamás se lee/agrega; cuota cuenta requests, no tokens; llamadas fallidas no cuentan contra cuota | `gemini-client.ts:52-61`, `lib/stella/quota.ts:47` | WS3/WS7 | ABIERTO |
| RK-23 | Fallos de Gemini invisibles para Sentry | merge `3e967d0` (`lib/stella/observability.ts`) | WS7/WS3b | **MITIGADO** (captureException con tags/fingerprint por rol+código, mensaje truncado 200c con stack reconstruido — sin fragmentos de prompt) |
| RK-24 | Rate limit con fallback en memoria por instancia (serverless ⇒ límite efectivo N×100/h) y sin aviso si faltan las vars KV | `lib/stella/rate-limit.ts:37-58` | WS3/WS7 | ABIERTO |
| RK-25 | Billing UI contradecía el fail-closed (`\|\| 10` falso) | merge `de860ca` | WS7 | **MITIGADO** (3 estados veraces alineados con quota.ts; misma fuente/ventana que enforcement; Stripe relabel) |
| RK-26 | Riesgo de staging accidental de `artifacts/` (prompts/respuestas crudas de evaluaciones reales). NO se mitiga vía `.gitignore` ni `.git/info/exclude`: los artifacts deben seguir visibles en `git status` para auditoría local (D-006). Mitigación: deny del harness sobre `git add artifacts*`/`git add .`/`-A`/`--all`/`-f` + regla de rutas explícitas | `.claude/settings.local.json` (local) | WS3 | MITIGADO (harness, verificado) |
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
| RK-36 | ~~Test muerto de funder-breakdown~~ **RESUELTO** en `5ffbf52`: renombrado al glob correcto y reescrito para invocar `buildComposerContext` real (la versión previa nunca llamaba a la función) | WS4 |
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
