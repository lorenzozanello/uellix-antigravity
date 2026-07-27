# Matriz de capacidades de Stella

**Fecha:** 2026-07-24 · **Escala:** 0 inexistente · 1 esqueleto · 2 parcial/desconectada · 3 funcional básica · 4 funcional robusta · 5 audit-ready.
**Nota transversal:** los seis roles están **detrás de flags desactivados por defecto** (`config.ts:15-22`) y **ninguna prueba ejercita la salida real del modelo** (`anti-regression.test.ts:193`). Por eso ninguna capacidad de IA supera 3.

## Capacidades de producto (visión objetivo)

| Capacidad | Estado 0-5 | Existe | Funciona | Usa datos reales | Tiene controles | Tiene pruebas | Riesgo | Evidencia | Brecha principal |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|---|
| **Guide (Advisor)** | 3 | Sí | Sí (flag off) | Parcial — recibe contexto rico pero el prompt usa `substring(0,500)`+conteos | Flags, quota, rate-limit, Zod | Sí (estructura) | Medio | `advisor.ts`, `advisor-system.ts:41-59` | Prompt genérico por paso; desaprovecha el contexto real |
| **Interviewer** | 0 | No | No | No | — | No | — | ausencia total (grep) | No existe cuestionamiento adaptativo |
| **Structurer (reformular)** | 0 | No | No | No | — | No | — | no hay modo reformulate | No existe |
| **Drafter (pipeline)** | 0 | No | No | No | — | No | — | Advisor solo asesora | No existe drafting de contenido de pasos |
| **Suggestions (stakeholders/outcomes/indicadores/ToC/supuestos)** | 0 | No | No | No | — | No | — | no hay esquema de sugerencia ni persistencia | No existe |
| **Evidence Intelligence** | 1 | Rol sí (evidence_reviewer) | No (flag off) | **Solo metadatos** (título+estado+hash8) | Flags, quota | Sí (mock) | Alto | `build-advisor-context.ts:156-172`; grep sin extracción | Sin extracción, embeddings, recuperación, contradicciones |
| **Proxy Intelligence (búsqueda)** | 0 | No | No | No | — | No | Alto | `gemini-client.ts:52-60` sin `tools` | Sin grounding ni búsqueda externa |
| **Methodology Reviewer (IA)** | 3 | Sí (validator) | Sí (flag off) | Sí (snapshot + metadatos) | Flags, quota, Zod, `requires_human_review` | Sí (mock) | Medio | `validator.ts`, `validator-system.ts` | Reglas SROI genéricas en prompt; sin eval de calidad |
| **Methodology Reviewer (determinista)** | 4 | Sí | **Sí (activo)** | Sí | Constraints DB + readiness gate | Sí (reales) | Bajo | `sroi-calculation.ts` (checkCalculationReadiness); `methodology_review_matrix` | No es Stella; es código. Sólido |
| **Calculation Interpreter** | 3 | Sí (validator) | Sí (flag off) | Sí — recibe snapshot de la corrida | Guardarraíl "never recalculate" + sin write path | Sí (mock) | Medio | `build-validator-context.ts:250-290` | Sin análisis de sensibilidad ni comparación de escenarios por IA |
| **Report Composer** | 3 | Sí | Sí (flag off) | Sí — context builder rico | No auto-guarda; Zod; refs con IDs | Sí (mock) | Alto | `composer.ts`, `build-composer-context.ts` | Prompt genérico; cifras como texto libre; sin verificar refs |
| **Audit Assistant** | 1 | Rol sí | No (flag off) | Metadatos | Flags | Sí (mock) | Medio | `reviewer.ts`, `reviewer-system.ts` | Sin Audit Room, sin procedencia ni versionado de afirmaciones |
| **Portfolio Intelligence** | 0 | No (Stella) | No | No | — | No | — | context builders single-project | Sin razonamiento multi-proyecto por IA |

## Capacidades de infraestructura y gobernanza

| Capacidad | Estado 0-5 | Existe | Funciona | Usa datos reales | Tiene controles | Tiene pruebas | Riesgo | Evidencia | Brecha principal |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|---|
| **Context builder** | 4 | Sí | Sí | Sí (org-scoped, metadatos) | Validación de propiedad + filtros org | Sí | Bajo | `build-*-context.ts` | Relaciones perdidas (stakeholders `[]`); N+1 de fuentes |
| **Sanitization** | 2 | Sí | Parcial | — | blocklist de 9 + truncado | Sí | Medio | `sanitize.ts:4-14` | `markAsData` muerto; débil vs injection |
| **Grounding** | 0 | No | No | No | — | No | Alto (para Proxy Intel) | `gemini-client.ts:52` sin tools | No existe |
| **Output validation** | 4 | Sí | Sí | — | Zod + `literal(true)` | Sí | Bajo | `schemas/*` | Sin validación semántica (que las refs existan) |
| **Quotas** | 4 | Sí | Sí | Sí | fail-closed, default 0 | Sí | Bajo | `quota.ts:30-58` | Race sub-segundo en rollover de mes (documentada) |
| **Rate limiting** | 4 | Sí | Sí | Sí | Upstash + fallback, fail-closed | Sí | Bajo | `rate-limit.ts:95-104` | — |
| **Feature flags** | 4 | Sí | Sí | — | global + por rol, default off | Sí | Bajo | `config.ts:15-22` | — |
| **Audit logs (stella_interactions)** | 3 | Sí | Sí | Sí | append-only + RLS SELECT | Sí (unit) | Medio | `0012`, `002` | No guarda prompt/payload; sin vínculo al pipeline |
| **Human approval** | 3 | Sí | Sí | — | no auto-save; proxies con workflow | Sí | Medio | `StellaComposerPanel.tsx:4`; `financial_proxies.reviewStatus` | Sin accept/reject de sugerencias (no existen) |
| **Provenance** | 1 | Parcial | Apenas | — | createdBy en filas | No | Alto | §10 del audit | Sin linaje de campo/afirmación; IA↔humano indistinguible |
| **Versioning** | 2 | Parcial | Parcial | Sí (corridas) | corridas inmutables | Sí (corridas) | Medio | `sroi_calculation_runs.version` | Reporte/secciones no versionados; prompts no versionados |
| **Prompt evaluation** | 0 | No | No | No | — | No | Alto | ausencia | Sin suite de eval de calidad de IA |
| **AI security** | 2 | Parcial | Parcial | — | redacción de key, no bundle cliente | Sí (unit) | Medio | `gemini-client.ts:123`; `sanitize.ts` | Injection débil; sin DPA verificable; sin clasif. PII |

## Lectura de la matriz

- **Máximo de madurez** está en la **infraestructura** (flags, quota, rate-limit, output-validation: 4/5), no en la inteligencia.
- **La revisión metodológica DETERMINISTA (código, no Stella) es la pieza más fuerte** (4/5) y es la que hoy sostiene la defendibilidad — no la IA.
- **Cinco capacidades objetivo están en 0**: Interviewer, Structurer, Drafter, Suggestions, Portfolio, y la búsqueda de proxies.
- **Dos capacidades diferenciadoras están en 1**: Evidence Intelligence y Audit Assistant.
- **Provenance (1) y Prompt evaluation (0)** son los dos habilitadores que bloquean el objetivo "audit-ready" y "producción".
