# Auditoría del estado actual de Stella

**Fecha:** 2026-07-24 · **Rama:** `feature/stella-generation-copilot` · **Método:** lectura directa del código, esquema, migraciones, RLS y pruebas. Ejecución local de solo lectura (typecheck + 383 pruebas unitarias mockeadas). **No** se activaron flags, **no** se tocó ninguna base remota, **no** se ejecutaron seeds ni migraciones.

> Regla de esta auditoría: nada se declara funcional por existir un archivo o una función. Cada afirmación lleva `archivo:línea`.

---

## 1. Resumen ejecutivo

Stella hoy es un **copiloto de un solo disparo, gobernado, que opera sobre METADATOS del proyecto**, íntegramente **detrás de feature flags desactivados por defecto**. Tiene tres roles operativos (`advisor`, `validator`, `composer`) y tres de revisión (`proxy_reviewer`, `evidence_reviewer`, `audit_assistant`) — los seis apagados por flag.

**Lo que está genuinamente bien construido** es la *infraestructura de gobernanza*: feature flags globales + por rol (`config.ts:15-22`), cuota mensual por organización con *fail-closed* y default 0 (`quota.ts:21-61`), rate-limit por hora con respaldo en memoria y *fail-closed* si el limitador distribuido cae (`rate-limit.ts:83-108`), validación Zod estricta con `requires_human_review: z.literal(true)` (`validator-output.ts`, `reviewer-output.ts`), guardarraíles compartidos en todos los prompts (`shared-guardrails.ts`), auditoría append-only con RLS (`0012_stella_interactions.sql`, `002_stella_interactions_rls.sql`), y contexto org-scoped que excluye rutas de archivo, valores financieros y PII.

**Lo que NO existe o es superficial** es la *inteligencia* en sí:

- **No hay comprensión de evidencia.** El modelo solo recibe el **título** de cada evidencia + estado + tipo + hash truncado (`build-advisor-context.ts:156-172`). No hay extracción de contenido, ni embeddings, ni recuperación semántica, ni detección de contradicciones. Verificado por ausencia total en grep.
- **No hay grounding ni búsqueda de proxies.** La llamada a Gemini no pasa `tools` (`gemini-client.ts:52-60`). Ninguna capacidad de búsqueda externa.
- **No hay drafting del pipeline.** El Advisor solo asesora; no reformula ni sugiere outcomes/indicadores/nodos. No existe esquema de sugerencia, ni flujo de aceptar/rechazar, ni persistencia de sugerencias.
- **Los prompts son genéricos y desaprovechan el contexto.** `buildAdvisorSystemPrompt(step)` interpola solo el nombre del paso (`advisor-system.ts:7-39`); el mensaje de usuario usa apenas `narrativeSummary.substring(0, 500)` + conteos (`advisor-system.ts:41-59`), aunque el context builder ensambla outcomes, indicadores, evidencia y proxies reales.
- **No hay procedencia a nivel de campo.** `stella_interactions` guarda la respuesta y un `context_hash`, pero **ninguna fila del pipeline queda vinculada** a la interacción de Stella que la originó. No se guarda el prompt ni el payload enviado al modelo.
- **No hay evaluación de calidad de IA.** Las 383 pruebas usan mock; ninguna ejercita la salida real del modelo (`anti-regression.test.ts:193-195`).

**Veredicto de una línea:** Stella es hoy **más que un chatbot** (es contextual, estructurada, tipada y gobernada) pero **muy lejos de una inteligencia metodológica**. Y está apagada.

---

## 2. Arquitectura real encontrada

```
lib/stella/
├── config.ts              flags + modelo + timeout + rate-limit (env-driven)
├── adapter/
│   ├── gemini-client.ts   generateContent JSON, SIN tools/grounding; redacción de la key en logs
│   └── types.ts           StellaRole = advisor|validator|composer|proxy_reviewer|evidence_reviewer|audit_assistant
├── context/
│   ├── build-advisor-context.ts      metadatos del proyecto (title/type/name/status)
│   ├── build-composer-context.ts     idem + filtros + snapshot de cálculo + secciones existentes
│   ├── build-validator-context.ts    idem + snapshot de cálculo (solo paso 'calculation')
│   ├── build-reviewer-context.ts     delega en validator-context
│   ├── sanitize.ts        control chars + blocklist de 9 patrones + truncado; markAsData NO usado
│   └── types.ts           StellaProjectContext
├── prompts/
│   ├── advisor-system.ts      genérico por paso
│   ├── composer-system.ts     genérico por sección
│   ├── validator-system.ts    fijo
│   ├── reviewer-system.ts     parametrizado (3 roles)
│   └── shared-guardrails.ts   7 prohibiciones absolutas
├── schemas/               advisor|composer|validator|reviewer (Zod)
├── quota.ts               cuenta filas de stella_interactions del mes UTC
├── rate-limit.ts          Upstash + fallback memoria
├── errors.ts, fallbacks.ts

app/actions/stella/        advisor.ts | composer.ts | validator.ts | reviewer.ts  (server actions)
components/stella/         StellaAdvisorPanel | StellaValidatorPanel | StellaComposerPanel | StellaReviewerPanel
db/migrations/0012 + 0027  tabla stella_interactions (0027 amplía el check a 6 roles)
db/policies/002            RLS append-only
```

**Modelo configurado:** `gemini-2.5-flash` por defecto (`config.ts:11`); el `DEFAULT` de la columna `model_used` en la tabla es `gemini-2.0-flash` (`0012:10`), un modelo **retirado por Google** (comentario en `config.ts:10`). Cosmético: la app siempre pasa el modelo explícito.

---

## 3. Flujo completo de una llamada (reconstruido de `advisor.ts`)

```
[1] UI: StellaAdvisorPanel (botón "Preguntar a Stella")
        components/stella/StellaAdvisorPanel.tsx  — nunca auto-invoca
        │  invoca la server action con (projectId, step)
        ▼
[2] Server action: getStellaAdvisor(projectId, step)   app/actions/stella/advisor.ts:37
        ▼
[7] Feature flags:  isEnabled && isAdvisorEnabled && canUseStella   advisor.ts:42  → DISABLED si no
        ▼
[3][4][5][6] Auth + org:  requireOrganizationAccess()   advisor.ts:53
        (redirige si no hay sesión; devuelve user + membership + organization)
        ▼
[8] Cuota:  checkStellaQuota(org.id)   advisor.ts:70 → quota.ts:21
        (default 0 = bloqueada; null = ilimitada; cuenta filas del mes UTC)
        ▼
[10] Contexto:  buildAdvisorContext(projectId, org.id, step)   advisor.ts:81
        (valida propiedad del proyecto → cross-org boundary; metadatos)
        ▼
[9] Rate-limit:  consumeStellaRateLimit(org.id)   advisor.ts:84 → rate-limit.ts:83
        (después de validar contexto, justo antes del modelo; fail-closed)
        ▼
[11] Sanitización:  dentro del context builder (sanitizeString/Narrative)   sanitize.ts
        ▼
[12] Prompt:  buildAdvisorSystemPrompt(step) + buildAdvisorUserMessage(step, ctx)   advisor.ts:100-101
[10.b] Hash:  buildContextHash(context)   advisor.ts:102 (SHA-256 truncado a 64)
        ▼
[13][14][15] Adaptador:  getGeminiAdapter().generate({role, systemPrompt, userMessage, contextHash})
        gemini-client.ts:52  — model=config.geminiModel, responseMimeType JSON, SIN tools/grounding
        ▼
[16] Validación:  adapter.parseResponse(raw, AdvisorOutputSchema)   advisor.ts:114
        (JSON.parse → Zod.parse; lanza StellaParseError si falla)
        ▼
[18][19] Persistencia + auditoría:  db.insert(stellaInteractions)   advisor.ts:119-129
        (org, project, createdBy, role, step, contextHash, responseJson, model, tokens)
        NO guarda el prompt ni el payload enviado; NO liga a ninguna fila del pipeline
        ▼
[17] Errores:  map a códigos tipados (DISABLED, UNAUTHORIZED, QUOTA_EXCEEDED,
        RATE_LIMITED, GEMINI_ERROR, PARSE_ERROR, TIMEOUT, AUDIT_ERROR)   advisor.ts:139-162
        ▼
[20] UI:  panel renderiza what_to_do/why/how/mistakes/next_actions (solo lectura)
        ▼
[21][22] Aceptación / efectos:  NINGUNO. El Advisor no escribe en los datos del proyecto.
        (El Composer devuelve un borrador que el usuario "usa" explícitamente en el editor;
         nunca auto-guarda — StellaComposerPanel.tsx:4 "Never auto-saves")
```

Los cuatro roles siguen exactamente este flujo (composer añade `reportId`, validator/reviewer persisten `riskLevel`+`riskFlags`).

---

## 4. Inventario de componentes

| Componente | Archivo | Estado | Evidencia |
|---|---|---|---|
| Adaptador Gemini | `lib/stella/adapter/gemini-client.ts` | Funcional, sin streaming ni tools | `:52-60` |
| Config/flags | `lib/stella/config.ts` | Funcional | `:15-22` |
| Cuota | `lib/stella/quota.ts` | Funcional, fail-closed | `:30-58` |
| Rate-limit | `lib/stella/rate-limit.ts` | Funcional, fail-closed | `:95-104` |
| Sanitización | `lib/stella/context/sanitize.ts` | Básica; `markAsData` **muerto** | `:4-14`, `:67` |
| Context (advisor) | `lib/stella/context/build-advisor-context.ts` | Metadatos reales | `:37-237` |
| Context (composer) | `lib/stella/context/build-composer-context.ts` | Rico (cálculo, filtros, secciones) | `:46-375` |
| Context (validator) | `lib/stella/context/build-validator-context.ts` | Rico; solo paso 'calculation' | `:43-323` |
| Prompts | `lib/stella/prompts/*` | Genéricos (advisor/composer) | ver §6 |
| Esquemas | `lib/stella/schemas/*` | Zod estricto | ver §6 |
| Acción advisor | `app/actions/stella/advisor.ts` | Completa | `:37-163` |
| Acción composer | `app/actions/stella/composer.ts` | Completa; `sectionId` no usado | `:41-47` |
| Acción validator | `app/actions/stella/validator.ts` | Completa; persiste risk | `:121-132` |
| Acción reviewer | `app/actions/stella/reviewer.ts` | Completa; por rol | `:53-144` |
| Paneles | `components/stella/*` | Solo lectura; composer no auto-guarda | `StellaComposerPanel.tsx:4` |
| Tabla | `db/migrations/0012` + `0027` | Append-only; 6 roles | `0027` |
| RLS | `db/policies/002` | SELECT org / deny UPDATE/DELETE | `:24-40` |

---

## 5. Inventario de roles

| Rol | Wired en | Flag | Salida | Persiste risk | Estado |
|---|---|---|---|---|---|
| `advisor` | 8 pasos del pipeline (todas las páginas) | `STELLA_ADVISOR_ENABLED` (off) | 6 campos accionables | No | Funcional básica, apagado |
| `composer` | página de reporte | `STELLA_COMPOSER_ENABLED` (off) | borrador + refs | No | Funcional básica, apagado |
| `validator` | página de cálculo | `STELLA_VALIDATOR_ENABLED` (off) | riesgos + recomendaciones | Sí (`validator.ts:131`) | Funcional básica, apagado |
| `proxy_reviewer` | página de proxies | `STELLA_PROXY_REVIEWER_ENABLED` (off) | findings + recs | Sí (`reviewer.ts:117`) | Esqueleto, apagado |
| `evidence_reviewer` | página de evidencia | `STELLA_EVIDENCE_REVIEWER_ENABLED` (off) | findings + recs | Sí | Esqueleto, apagado |
| `audit_assistant` | página de cálculo | `STELLA_AUDIT_ASSISTANT_ENABLED` (off) | findings + recs | Sí | Esqueleto, apagado |

Wiring verificado: `calculation/page.tsx:22,427`, `evidence/page.tsx:4,187`, `proxies/page.tsx:5,189`, `narrative|stakeholders|outcomes|indicators/page.tsx:3`, `report/[reportId]/page.tsx:11`.

---

## 6. Inventario de prompts

| Prompt | Rol/Paso | ¿Específico? | Guardarraíles | Prohíbe inventar | Lenguaje condicional | Esquema | Contexto usado en el user-message |
|---|---|---|---|---|---|---|---|
| `advisor-system.ts` | advisor / cualquier paso | **Genérico** (interpola nombre) `:7-39` | Sí (`SHARED_GUARDRAILS`) | Sí (`shared:19`) | Sí | AdvisorOutput | **`narrativeSummary.substring(0,500)` + 5 conteos** `:41-59` |
| `composer-system.ts` | composer / cualquier sección | **Genérico** (interpola sección) `:7-55` | Sí | Sí | Sí | ComposerOutput | outcomes-names + período + NSV + ratio + conteos; funder-detail solo para `funder_breakdown` `:57-106` |
| `validator-system.ts` | validator | Fijo (6 chequeos) `:7-49` | Sí | Sí | Sí | ValidatorOutput | outcomes list + evidence status list + proxies con confidence `:51-75` |
| `reviewer-system.ts` | 3 roles | Parametrizado por mandato `:56-95` | Sí | Sí | Sí | ReviewerOutput | detalle por rol (proxies/evidencia/outcomes) `:97-133` |

Evaluación:
- **Duplicación:** advisor/composer/validator/reviewer comparten el mismo esqueleto `You are Stella X ... ## Output Format ... JSON`.
- **Genéricos:** advisor y composer no diferencian el prompt por paso/sección más allá de interpolar el nombre.
- **Guardarraíles fuertes:** 7 prohibiciones absolutas (`shared-guardrails.ts:11-25`), lenguaje condicional obligado (`:34-39`), revisión humana no negociable (`:41-45`).
- **Debilidad de reglas SROI:** el validator lista 6 chequeos genéricos; **no** hay reglas explícitas sobre doble conteo, contrafactual, drop-off sin evidencia, etc. (esos viven, si acaso, en el criterio del modelo, no en el prompt).
- **Versionado:** ninguno. No hay versión de prompt registrada en `stella_interactions`.
- **Pruebas de prompt:** `composer-system.test.ts` (303 líneas), `reviewer-output.test.ts`, `anti-regression.test.ts` verifican **estructura** y ausencia de secretos, no calidad de salida.
- **Riesgo de prompt injection:** el narrative del usuario, los títulos de outcomes/indicadores/evidencia SÍ se envían al modelo tras sanitización mínima. `markAsData` (que envolvería el contenido como `[DATA]:`) **existe pero nunca se usa** (`sanitize.ts:67`; grep confirma solo re-exports). Los documentos NO se envían (solo metadatos), así que la inyección vía contenido de archivo **no es vector hoy** — lo será en Evidence Intelligence.

---

## 7. Contexto por rol y paso (qué recibe realmente Stella)

**Campos incluidos** (los tres builders son casi idénticos):
- `narrativeSummary`: narrative + theory_of_change concatenados, `sanitizeNarrative` → máx **2000 chars**, filtrado por blocklist (`sanitize.ts:46-52`).
- `outcomesSnapshot`: `id`, `title`→`name` (máx 200), `outcomeType`→`description` (máx 100). **Solo `status='active'`** (`build-advisor-context.ts:107`).
- `indicatorsSnapshot`: `id`, `outcomeId`, `name` (200), `unit` (50). **Sin valores** (línea base/meta/real excluidos).
- `evidenceMetadata`: `id`, `title` (150, o `[Evidence item]` si dispara blocklist), `type`, `status`, `contentHashTruncated` (8 chars), `createdAt`, `outcomeId`, `indicatorId`. **Sin `filePath`, sin contenido** (`:146`).
- `proxySummary`: `id`, `name` (200), `source` (nombre público, 150), `confidenceLevel`, `methodologicalRisk`. **`value` y `currency` vacíos siempre** (`:214-216`).
- `filterSetsSummary` (composer/validator): deadweight/attribution/displacement/dropoff/duration como números.
- `calculationSnapshot` (composer/validator): `totalInvestment`, `grossSocialValue`, `netSocialValue`, `sroiRatio`, `currency`, `lineItemCount`, `version`. **`snapshotJson` NUNCA se incluye directo** (composer extrae solo `fundersBreakdown` de él, `build-composer-context.ts:287-309`).
- `reportSections` (composer): tipo, título, `contentLength`, `status`.
- `readinessScore` (composer/validator).

**Campos excluidos deliberadamente:** rutas de Storage, contenido de archivos, hash completo, valores de proxy, valores de indicadores, emails/PII de stakeholders (solo se cuenta), `snapshotJson` crudo.

**Problemas de contexto:**
- **Contexto rico, prompt pobre.** El builder ensambla datos que el user-message del advisor/composer **descarta**. Es un desperdicio y una inconsistencia (§6).
- **Pérdida de relaciones:** outcomes ↔ stakeholders no se envía (`stakeholderGroups: []` hardcoded, `:113`). El vínculo outcome↔indicador sí (via `outcomeId`).
- **N+1:** los nombres de fuentes de proxy se consultan en bucle, una query por fuente (`build-advisor-context.ts:199-207`).
- **Sin historial:** cada llamada es *stateless*; no se pasa el historial de interacciones previas.
- **Contaminación cross-org:** mitigada estructuralmente — cada builder valida `project.organizationId === organizationId` antes de cualquier fetch (`:63-65`), y todas las queries filtran por `organizationId`. No detecté fuga.

---

## 8. Estado de la base de datos

**Tabla `stella_interactions`** (`0012_stella_interactions.sql`):
- Campos: `id`, `organization_id` (FK), `project_id` (FK), `created_by` (FK), `stella_role`, `pipeline_step`, `context_hash` (64), `response_json` (jsonb), `model_used` (default `gemini-2.0-flash` — retirado), `tokens_used`, `risk_level`, `risk_flags` (text[]), `created_at`.
- CHECK: `stella_role IN (6 roles)` tras `0027`; `risk_level IN (low|medium|high)`.
- Índices: org+created, project+role, created_by+created, context_hash, risk_level parcial (`0012:37-45`).
- **RLS** (`002`): SELECT para miembros de la org o super_admin; **sin** políticas de INSERT/UPDATE/DELETE → append-only (los inserts entran vía Drizzle como `postgres`, que salta RLS).

**Lo que la tabla NO guarda:** el prompt enviado, el user-message (payload) enviado al modelo, la versión del prompt, ni un vínculo a la fila del pipeline resultante. `context_hash` permite detectar "mismo contexto" pero **no reconstruir** qué se envió.

**Tablas relacionadas usadas por el contexto** (solo lectura): `projects`, `impact_narratives`, `stakeholder_groups`, `outcomes`, `indicators`, `evidence_items`, `outcome_proxy_assignments`, `financial_proxies`, `proxy_sources`, `sroi_filter_sets`, `sroi_calculation_runs`, `sroi_calculation_line_items`, `sroi_run_reviews`, `sroi_reports`, `sroi_report_sections`.

**Aprobación de proxies (determinista, no-Stella):** `financial_proxies.reviewStatus` con CHECK `IN (suggested, pending_review, approved, rejected, archived)` y `approved_proxy_check` que exige `value_usd` para aprobar (`db/schema.ts`). Este flujo humano existe y funciona; Stella no lo toca.

---

## 9. Seguridad y privacidad

| # | Riesgo | Sev | Prob | Evidencia | Recomendación |
|---|---|---|---|---|---|
| SEC-S1 | **Defensa de prompt-injection débil**: narrative y títulos del usuario se envían al modelo con sanitización mínima (control chars + blocklist de 9 patrones + truncado); `markAsData` no se usa | Media | Media | `sanitize.ts:4-14`, `:67`; grep sin usos | Envolver todo texto de usuario con delimitadores de datos; blocklist ampliada; considerar detección de instrucciones |
| SEC-S2 | **Datos de proyecto a un tercero (Google)**: narrative, títulos de outcomes/evidencia, ratios se envían a Gemini. Sin DPA verificable en el repo, sin opción de retención cero | Media | Alta | `advisor.ts:106`, `gemini-client.ts:52` | Verificar DPA con Google; documentar qué se envía; consentimiento por organización; considerar región de datos |
| SEC-S3 | **Sin provenance del payload**: `stella_interactions` guarda la respuesta pero no lo enviado; imposible auditar exactamente qué vio el modelo | Media | Alta | `0012`, `advisor.ts:119-129` | Guardar (o hashear con sal + almacenar) el user-message; versionar prompt |
| SEC-S4 | Flags apagados por defecto | — (control positivo) | — | `config.ts:15-22` | Mantener; encender solo tras eval |
| SEC-S5 | Secretos redactados en logs de error de Gemini | — (control positivo) | — | `gemini-client.ts:123-134` | Mantener |
| SEC-S6 | Aislamiento cross-org por validación estructural + RLS de SELECT | — (control positivo) | — | `build-advisor-context.ts:63-65`, `002` | Mantener; añadir test de aislamiento específico de stella_interactions |
| SEC-S7 | **PII de menores/salud**: si el usuario pega datos sensibles en narrative/títulos, se envían al modelo sin clasificación | Media | Media | `sanitize.ts` (no clasifica PII) | Detección/aviso de PII antes de enviar; política de datos sensibles |

No se muestran secretos en este informe.

---

## 10. Gobernanza y trazabilidad

**Lo que SÍ puede saberse:**
- Quién disparó una interacción de Stella y cuándo (`stella_interactions.created_by`, `created_at`).
- Qué rol/paso y qué modelo (`stella_role`, `pipeline_step`, `model_used`).
- La respuesta completa del modelo (`response_json`).
- Un hash del contexto (`context_hash`) — permite detectar repetición, no reconstruir.
- Para el pipeline en general: `audit_logs` (separado) registra mutaciones con `before/after`, actor, IP; las corridas de cálculo son inmutables por disparador.

**Lo que NO puede saberse (brechas de linaje):**
- **Ninguna fila del pipeline** (outcome, indicador, proxy, sección de reporte) queda vinculada a la interacción de Stella que la sugirió o redactó. No hay campo de procedencia.
- Si un texto fue *ingresado por humano*, *sugerido por Stella*, *reformulado* o *extraído de un documento*: **no distinguible**. Todo se persiste igual, con `createdBy` = usuario.
- Qué prompt exacto y qué payload se enviaron al modelo.
- Qué elementos del proyecto dependen de una interacción concreta.

**Linaje disponible por nivel:** Proyecto ✅ · Entidad ⚠️ (via audit_logs, no via Stella) · **Campo ❌** · **Afirmación ❌** · Documento ⚠️ (hash + integridad en `evidence.ts`, no via Stella) · Cálculo ✅ (corridas versionadas e inmutables) · **Sección de reporte ❌** (no versionada, sin procedencia).

---

## 11. Interfaz

- **Ubicación:** panel por paso. Advisor en los 8 pasos; Validator + Audit-assistant en cálculo; Reviewer en evidencia/proxies; Composer en el reporte.
- **Invocación:** manual, nunca auto (`StellaComposerPanel.tsx:4`). Botón "Preguntar a Stella".
- **Estados:** el panel tiene `idle/loading/error/data` (`StellaComposerPanel.tsx:44`).
- **Propuesta vs hecho:** el Composer marca claramente que es un borrador y **no auto-guarda**; el usuario "usa" el borrador explícitamente (`:155`). Advisor/Validator/Reviewer son **solo lectura** (no producen datos persistibles).
- **Citas:** el Composer emite `evidence_references`/`proxy_references` con IDs (`composer-output.ts:26-38`), pero **no** hay verificación de que esos IDs existan realmente en el proyecto antes de mostrarlos.
- **Riesgo mostrado:** Validator/Reviewer emiten `risk_level`; Advisor/Composer no.
- **Aceptación masiva riesgosa:** no aplica hoy (no hay sugerencias de pipeline que aceptar en lote).
- **Comparar original vs reformulación:** no existe (no hay reformulación).
- **Identificación de contenido IA:** en el panel sí (es obviamente Stella); pero una vez el borrador del Composer entra al editor y se guarda, **se pierde la marca de que fue generado por IA** (no hay procedencia).
- **Sobreconfianza:** riesgo real — los guardarraíles piden lenguaje condicional, pero nada estructural impide que el usuario acepte un borrador con una cifra mal escrita por el modelo, porque `draft_content` es texto libre (§13, riesgo R3).

---

## 12. Pruebas

**Ejecutadas localmente (mockeadas, seguras):** `pnpm exec vitest run lib/stella app/actions/stella components/stella tests/stella-quota.test.ts` → **15 archivos, 383 pruebas, todas pasan.**

| Tipo | Archivos | Qué cubren | Limitación |
|---|---|---|---|
| Unitarias adaptador | `adapter/gemini-client.test.ts` | timeout, parse, mock | No llama a Gemini real |
| Unitarias contexto | `context/__tests__/*` (3) | campos incluidos/excluidos, sanitización | — |
| Unitarias prompt | `prompts/composer-system.test.ts` | estructura del prompt | No evalúa calidad |
| Esquemas | `schemas/reviewer-output.test.ts` | validación Zod | — |
| Acciones (server) | `app/actions/stella/__tests__/*` (3) | flags, quota, rate-limit, errores | Mock provider |
| Componentes | `components/stella/__tests__/*` (3) | estados de UI | Mock action |
| Anti-regresión | `__tests__/anti-regression.test.ts` | **prohíbe llamadas reales**, sin secretos | `:193-195` |
| Cuota | `tests/stella-quota.test.ts` | ventana mensual | — |

**Sin cobertura:** calidad de salida del modelo (no hay suite de **eval**), grounding (no existe), extracción documental (no existe), **integración/RLS específica de `stella_interactions`** (no hay test que verifique el aislamiento de esa tabla contra un cliente authenticated), end-to-end de un flujo Stella real.

**Falsa sensación de cobertura:** 383 pruebas verdes sugieren madurez, pero **ninguna ejercita el comportamiento real del modelo**; validan el *andamiaje* (flujo, tipos, guardarraíles-en-prompt), no la *inteligencia*.

---

## 13. Riesgos críticos

| ID | Riesgo | Sev | Evidencia |
|---|---|---|---|
| R1 | **Cero procedencia de campo**: no se puede reconstruir el origen de una afirmación ni distinguir texto humano/IA. Bloquea el objetivo "audit-ready" | **Alto** | §10 |
| R2 | **Sin evaluación de calidad de IA**: encender los flags sería desplegar salidas no evaluadas a un producto que promete defendibilidad | **Alto** | §12 |
| R3 | **Cifras como texto libre en el Composer**: `draft_content` puede contener números escritos por el modelo; nada los ancla al motor | **Alto** | `composer-output.ts:15` |
| R4 | **Evidence/Proxy intelligence inexistentes**: dos de las seis dimensiones objetivo están en 0-1 | **Alto** (producto) | grep; §1 |
| R5 | **Prompt-injection débil + `markAsData` muerto** | Medio | `sanitize.ts:67` |
| R6 | **Datos a Google sin DPA verificable** | Medio | §9 SEC-S2 |
| R7 | **Contexto rico desaprovechado por prompts genéricos** | Medio (calidad) | §6, §7 |

---

## 14. Deuda técnica

- `markAsData` exportado y **nunca usado** (`sanitize.ts:67`) — código muerto con implicación de seguridad.
- `sectionId` recibido y no usado en `getStellaComposer` (`composer.ts:41-47`).
- `step` recibido y no usado en `buildAdvisorContext` (`build-advisor-context.ts:40-43`).
- `DEFAULT 'gemini-2.0-flash'` en la columna `model_used` (modelo retirado) — `0012:10`.
- N+1 en resolución de fuentes de proxy (`build-advisor-context.ts:199-207`).
- Cuatro roles con estructura de acción casi idéntica (advisor/composer/validator/reviewer) — oportunidad de un orquestador común (no urgente).
- `db/policies/002` describe los inserts como "service-role client" cuando en realidad usan `DATABASE_URL` (rol `postgres`, bypass RLS) — impreciso.

---

## 15. Funciones declaradas pero no operativas

- **Roles de revisión** (`proxy_reviewer`, `evidence_reviewer`, `audit_assistant`): construidos, wired a páginas, pero **apagados por flag** y sin eval. Operan solo sobre metadatos.
- **`markAsData`**: declarada, exportada, **nunca invocada**.
- **`risk_flags`/`risk_level`**: poblados solo por validator/reviewer; advisor/composer los dejan null.
- **Toda la capa Stella**: detrás de `STELLA_ENABLED=false` por defecto. La memoria del proyecto afirma "Stella live in Production, all 3 roles enabled in Preview+Prod" — **no verificable desde el repo** y **contradice** el default de `config.ts:15`. El estado real en producción depende de las env vars de Vercel, fuera del alcance de esta auditoría.

---

## 16. Contradicciones documentación ↔ código

1. **`model_used DEFAULT 'gemini-2.0-flash'`** (`0012:10`) vs modelo retirado y default real `gemini-2.5-flash` (`config.ts:10-11`).
2. **RLS 002 "inserts via service-role client"** vs inserts reales vía `DATABASE_URL`/`postgres` que salta RLS (`002:17-19` vs `advisor.ts:16`).
3. **Memoria "Stella live in Production, 3 roles enabled"** vs `config.ts:15` default `false`. No verificable en el repo.
4. **Mi propio spec del 2026-07-24** afirmó que el Composer "no usa bien los datos reales": matiz — el **context builder** SÍ ensambla datos ricos (`build-composer-context.ts`); es el **user-message del prompt** el que los desaprovecha (`composer-system.ts:57-106`). Corregido aquí.
5. Comentarios "Sprint 9B/9C/9D" y "Fase 5b" sugieren capacidades entregadas; en realidad todas están **flag-off** y sin eval.
