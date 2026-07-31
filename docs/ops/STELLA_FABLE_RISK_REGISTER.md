# STELLA FABLE MOONSHOT — Registro de Riesgos

> Última actualización: 2026-07-31 (bootstrap; auditoría base sobre `dd36a4e`)
> Severidad: P0 = bloquea el release candidate offline · P1 = degrada calidad/confianza · P2 = mejora.
> Estado: ABIERTO / MITIGADO / ACEPTADO (con firma de decisión en DECISIONS.md).

## P0 — Bloqueadores del Offline Release Candidate

| ID | Riesgo | Evidencia | Workstream | Estado |
|----|--------|-----------|------------|--------|
| RK-01 | Paridad de contexto rota (7 campos nunca poblados) | merge `24b122c` | WS1 | **MITIGADO** (18/18 campos poblados con queries org-scoped; test de paridad estricto; readiness inyectable — wiring del action pendiente en coordinador) |
| RK-02 | R1–R6 abiertas en código | merge `24b122c` | WS1 | **MITIGADO OFFLINE** (R1 sentinelas, R3 slices por step, R4 validador de fugas ±corchetes, R5 fixtures completos, R6 refusal categórico; R2 pertinencia sigue siendo heurística — validación semántica plena queda para G1) |
| RK-03 | Advisor contextual sin UI | merge `0d0791a` | WS2 | **MITIGADO** (StellaContextualAdvisorPanel montado en los 7 steps con fuentes legibles y ciclo completo; convivencia con panel legacy pendiente de DP-03) |
| RK-04 | `stella_interactions` sin trigger append-only + grants UPDATE/DELETE | `db/prepared/stella_0002_*.sql`, `tests/integration/rls.test.ts` (casos staged) | WS3 | **PREPARADO** (SQL con rollback + tests RLS duales pre/post; la APLICACIÓN es gate externo G2 — ver G2_PACKAGE.md) |
| RK-05 | Harness con scores constantes y detectores sólo sobre summary | merge `24b122c` | WS1/WS6 | **MITIGADO** (scores computados de runs reales de detectores sobre todos los campos de texto; adversarialCasesPassed cuenta pases reales; limitación de short-circuit documentada en G1 §7) |
| RK-06 | Anti-regression con placeholders | merge `2ecd766` | WS3/WS4 | **MITIGADO** (scans fs reales incl. dynamic import/re-export/alias y tx/getDb; probados contra violaciones sintéticas) |
| RK-07 | Prompt injection sin defensa en roles legacy | merge `2ecd766` | WS3 | **MITIGADO** (sobre UNTRUSTED_PROJECT_DATA en los 4 builders — atacado por auditor y resistió; step/sectionType allowlisted tras exploit del auditor; corpus 18 payloads × 6 builders) |
| RK-08 | Poblaciones sensibles: 0% de salvaguardas | merge `c28c135` (`lib/stella/security/sensitive-populations.ts`) | WS3 | **MITIGADO** (detector 5 categorías ES/EN endurecimiento-monotónico, aviso estático en capa confiable fuera del sobre, metadata en audit; bordes de stems documentados fail-safe) |
| RK-09 | PII sin redacción en narrativas + retención indefinida | merges `2ecd766`+`3e967d0` | WS3 | **MITIGADO** (redactPii unicode pre-truncado en todos los caminos libres; retención: política DRAFT DP-04 pendiente de decisión de Lorenzo) |

## P1 — Degradan calidad o confianza

| ID | Riesgo | Evidencia | WS | Estado |
|----|--------|-----------|----|--------|
| RK-10 | Sin dedup/tope de referencias ni fallback contextual | merge `24b122c` | WS1 | **MITIGADO** (dedup orden-preservante, tope 8 distintas fail-closed, fallback contextual schema-válido sólo en ContextualIndexTokenLeakError; índices inválidos siguen PARSE_ERROR por contrato congelado del action) |
| RK-11 | Sin persistencia de decisiones ni historial/undo; Composer con DOM imperativo destructivo | merges `0d0791a`+`3e967d0`+`c28c135` | WS2/WS3 | **MITIGADO OFFLINE** (undo LIFO global con staleness-confirm; composer controlado con confirmación; persistencia: acción dormante + adapter cableado, activación = G2+flag; interactionId aún sin cablear en el field — nota G2) |
| RK-13b | Taxonomía de errores colapsada / DISABLED desmonta panel | merge `0d0791a` | WS2 | **MITIGADO** (12 códigos con mensajes distintos, reset humanizado, DISABLED como prop inerte) |
| RK-34b | Accesibilidad (aria-live condicional, headings, hex) | merge `0d0791a` | WS2 | **MITIGADO** (live regions persistentes, foco gestionado, jerarquía corregida, tokens) |
| RK-12 | Invocaciones/denegaciones Stella invisibles en `audit_logs` | merge `3e967d0` | WS3 | **MITIGADO** (STELLA_INVOKED/DENIED/INTEGRITY_REJECTED/DECISION_RECORDED, metadata-only con canaries de fuga, fire-and-forget) |
| RK-13 | Taxonomía de errores colapsada en paneles (RATE_LIMITED sin reset, TIMEOUT genérico); DISABLED desmonta el panel post-click | `StellaAdvisorPanel.tsx:47-57` | WS2 | ABIERTO |
| RK-14 | Documentos de evidencia write-only; `content_hash` mutable | `lib/grounding/**`, spec §12 | WS5/WS3 | **PARCIAL** (extracción csv/txt + chunking + retrieval implementados offline; ingest hook y PDF/XLSX = decisión G5; PENDIENTES para G2: signed URL de descarga y trigger de inmutabilidad de `evidence_items.content_hash` — añadir a un futuro stella_0004) |
| RK-15 | Precisión Decimal global sin fijar y sin golden test del ratio; `parseFloat` en el motor | `lib/pipeline/decimal-config.ts` + goldens | WS4 | **MITIGADO** (merge `5ffbf52`: pin explícito importado por sroi-*/fx-*, goldens exactos re-derivados por auditor, parseNum Decimal con paridad caracterizada) |
| RK-16 | Composer no valida referencias ni cifras contra contexto (alucinación) | `lib/stella/schemas/composer-numeric-guard.ts` | WS4/WS6 | **PARCIAL** (guard construido y endurecido post-auditoría; WIRING pendiente en composer.ts — coordinador) |
| RK-17 | Roles reviewer con contexto prestado y flags indescubribles | merge `8f39d2a` | WS6 | **MITIGADO** (contextos por rol con linkage de outcomes; contract test prompt⊆contexto; flags en .env.example; tests de acción y builder) |
| RK-18 | `risk_level=high` del validator no bloquea publicación (advisory) | DP-06 en DECISIONS.md | WS4/WS6 | **DECISIÓN DE PRODUCTO** (elevado a Lorenzo como DP-06; dato persistido y auditado, enforcement sería un check en publicación) |
| RK-19 | `stepMismatch` del proveedor se descartaba sin métrica ni log | merge `c28c135` | WS1/WS7 | **MITIGADO** (surfaced en resultado + console.warn + metadata en audit_logs) |
| RK-20 | CHECK de roles desincronizado 0012↔schema | `db/prepared/stella_0002` | WS3 | **PREPARADO** (DO block idempotente de reconciliación con literales entrecomillados; aplicación = G2) |
| RK-21 | Cualquier miembro (incl. viewer) podía invocar Stella | merge `2ecd766` | WS3 | **MITIGADO** (`canUseStella` set-inclusion en las 5 acciones, antes de cuota; denegación auditada) |
| RK-22 | Sin control de gasto | merges `2ecd766`+`de860ca` | WS3/WS7 | **MITIGADO PARCIAL** (maxOutputTokens/temperature/maxPromptChars activos; tokens+costo estimado visibles en admin; PENDIENTE: cuota por tokens en vez de requests y tope duro de gasto por org — G9 calibra primero) |
| RK-23 | Fallos de Gemini invisibles para Sentry | merge `3e967d0` (`lib/stella/observability.ts`) | WS7/WS3b | **MITIGADO** (captureException con tags/fingerprint por rol+código, mensaje truncado 200c con stack reconstruido — sin fragmentos de prompt) |
| RK-24 | Rate limit con fallback en memoria por instancia sin aviso | merge `c28c135` | WS3/WS7 | **MITIGADO PARCIAL** (warn once-per-process al caer al fallback; la limitación per-instance en serverless persiste por diseño — alerta A2 del plan la cubre; fix estructural requiere KV configurado = operación) |
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
