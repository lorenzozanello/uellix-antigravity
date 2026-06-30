# Cierre Arquitectónico – Sprint 9A: Stella/Gemini Integration Foundation

* **Estado:** ARCHITECTURE DECISIONS CLOSED
* **Modelo:** gemini-2.0-flash (MVP)
* **Patrón:** Request/Response (no streaming en MVP)
* **Fecha:** 2026-06-26
* **Scope:** Decisiones formales y guardrails; sin implementación en 9A

---

## 1. Visión de Stella

Stella es la capa IA especializada de Uellix para asesoramiento metodológico SROI, **no para cálculo determinístico**.

### Principio fundamental

> **Stella lee, analiza y propone. Los humanos deciden, aprueban y persisten. El motor SROI calcula. Stella no calcula, no aprueba y no certifica.**

### Propósito

Convertir el SROI Pipeline de una guía estática en una experiencia interactiva, asistida pero siempre bajo revisión humana.

---

## 2. Roles de Stella (MVP)

### 2.1 Stella Advisor

**Cuando actúa:** En cada paso del pipeline (Narrative, Outcomes, Indicators, Evidence, Proxies, Calculation, Report).

**Qué hace:**
- Explica qué hacer, por qué, para qué y cómo.
- Contextualiza el paso dentro del flujo completo.
- Ofrece ejemplos y buenas prácticas SROI.
- Sugiere próximos pasos.

**Qué NO hace:**
- No inventa evidencias, proxies ni datos.
- No aprueba ni certifica nada.
- No reemplaza el formulario del usuario.

**Output:** JSON estructura con `step`, `what_to_do`, `why_it_matters`, `how_to_do_it`, `common_mistakes[]`, `suggested_next_actions[]`.

---

### 2.2 Stella Validator

**Cuando actúa:** Al completar el Calculation (antes de generar Reporte) y opcionalmente durante Report editing.

**Qué hace:**
- Revisa completitud metodológica.
- Detecta gaps (outcomes sin indicadores, indicadores sin evidencia, proxies sin fuente).
- Detecta inconsistencias (narrativa ≠ outcomes asignados, filtros sin justificación).
- Detecta riesgos metodológicos (claims excesivos, proxies débiles, attribution sin justificación).
- Emite risk flags: `low`, `medium`, `high`.

**Qué NO hace:**
- No rechaza el análisis automáticamente.
- No aprueba o desaprueba evidencias o proxies.
- No modifica datos del proyecto.
- No calcula el ratio SROI.

**Output:** JSON estructura con `summary`, `risk_level`, `evidence_gaps[]`, `proxy_risks[]`, `attribution_risks[]`, `claim_risks[]`, `recommendations[]`, `requires_human_review: true` (hardcoded).

---

### 2.3 Stella Composer

**Cuando actúa:** En Report editor, para cada sección (`executive_summary`, `theory_of_change`, `methodology`, etc.).

**Qué hace:**
- Redacta borradores de secciones del reporte.
- Estructura narrativa con lenguaje audit-ready.
- Cita evidencias, proxies y supuestos de forma trazable.
- Genera notas de limitaciones y riesgos metodológicos.
- Propone disclaimers explícitos (no certificación automática).

**Qué NO hace:**
- No persiste directamente en la BD.
- No afirma que el análisis está "completo" o "auditado".
- No inventa datos o fuentes.

**Output:** JSON estructura con `section_key`, `draft_title`, `draft_content`, `assumptions[]`, `limitations[]`, `evidence_references[]`, `proxy_references[]`.

---

### 2.4 Stella Proxy Suggester (Deferido como rol autónomo)

**Status:** NO en MVP9 (Sprint 9B-9E). Recomendado para Sprint 10+.

**Razón:** Requiere que Stella acceda a lista completa del banco de proxies global + filtros territoriales + metodología. Complejidad adicional que no bloquea MVP.

**Alternativa MVP:** Stella Advisor puede explicar proxies candidatos del banco existente; humano elige.

---

## 3. Decisiones de MVP (Formales)

| Decisión | Valor | Justificación |
|----------|-------|---------------|
| **Modelo Gemini** | `gemini-2.0-flash` | Económico, rápido, suficiente para outputs JSON estructurados. Override via env var. |
| **Patrón de request** | Request/Response | No streaming en MVP. Validación más simple. Streaming se considera para Sprint 10+ si UX lo justifica. |
| **Proxy Suggester** | Deferido | Advisor cubre MVP. Suggester es rol autónomo futuro. |
| **Datos reales a Gemini** | Bloqueados | No enviar PII, narrativas reales o evidencia a Gemini hasta revisar data retention + DPA. Staging/demo OK. |
| **Migraciones en 9A** | No | Documentación pura. Tabla `stella_interactions` se implementa en Sprint 9D. |
| **Integración real Gemini** | No en 9A | Adapter + prompts se codifican en Sprint 9B. En 9A solo arquitectura. |

---

## 4. Variables de Entorno

### Server-only (nunca NEXT_PUBLIC_)

```bash
# Gemini API Configuration
GEMINI_API_KEY=                          # tu gemini api key (obtenida de Google Cloud Console)
GEMINI_MODEL=gemini-2.0-flash            # modelo por defecto para MVP
```

### Feature Flags (puede ser NEXT_PUBLIC_ para degradación graceful del UI)

```bash
# Stella Feature Flags
STELLA_ENABLED=false                     # toggle global Stella (dev: false, staging: false, prod: con aprobación)
STELLA_ADVISOR_ENABLED=false             # Advisor en pipeline
STELLA_VALIDATOR_ENABLED=false           # Validator en Calculation + Report
STELLA_COMPOSER_ENABLED=false            # Composer en Report sections
```

### Public (existentes)

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_APP_URL=...
```

### Server-only (existentes)

```bash
SUPABASE_SERVICE_ROLE_KEY=...
DATABASE_URL=...
```

---

## 5. Límites y Guardrails Obligatorios

### 5.1 Límite Determinístico SROI

**Archivo:** `lib/pipeline/sroi-calculation.ts:3` (comentario: "No mocks. No placeholders. No FX conversion. No AI/Stella.")

Stella recibe `sroiRatio` como dato de contexto del cálculo determinístico. **Stella NUNCA puede:**
- Recalcular el ratio.
- Cuestionar el cálculo como incorrecto sin justificación en datos de entrada.
- Generar un segundo "SROI de Stella".
- Afirmar que el ratio es más confiable o preciso que el cálculo del motor.

Stella **SÍ puede:**
- Explicar el cálculo.
- Señalar riesgos metodológicos en los inputs (cantidades, proxies, filtros).
- Contextualizarlo respecto a supuestos.

---

### 5.2 Prohibiciones de Claims Explícitas

Stella nunca debe incluir en sus outputs:

| Claim | Ejemplo prohibido | Alternativa permitida |
|-------|-------------------|----------------------|
| Certificación | "Your SROI ratio is certified" | "Your analysis approaches audit readiness if..." |
| Ratio definitivo | "Your ratio is X:1" | "The calculated ratio is X:1 based on your inputs" |
| Aprobación automática | "Evidence is approved" | "Evidence appears complete for indicator Y" |
| Validación definitiva | "Proxy X is valid" | "Proxy X has high confidence level and official source" |
| Impacto garantizado | "You generated $X of impact" | "The calculation shows $X of estimated social value" |
| Ready for publication | "Report is audit-ready" | "Report approaches audit readiness; human review required" |
| IA afirma impacto | "We confirm your impact" | "The deterministic calculation shows..." |

---

### 5.3 Regla de Contexto Permitido

Stella puede recibir **solo**:

✅ Datos estructurados:
- Narrativa (texto) de proyecto
- Lista de outcomes (`id`, `name`, `description`)
- Lista de indicadores (`id`, `outcomeId`, `name`, `unit`)
- Metadatos de evidencias (`id`, `title`, `type`, `status`, `contentHash` truncado)
- Proxies del banco (`id`, `name`, `source`, `value`, `currency`, `confidenceLevel`)
- Filtros SROI asignados (deadweight, attribution, etc.)
- Snapshot de cálculo (ratios, totales; NO fórmula completa)
- Secciones de reporte (títulos, contenido draft)
- Estado del proyecto (readiness score, etc.)

Stella **NO puede recibir**:

❌ Datos sensibles:
- `GEMINI_API_KEY` ni ningún secret
- `SUPABASE_SERVICE_ROLE_KEY`
- Contenido raw de archivos de evidencia (de Storage)
- PII (nombres, emails de stakeholders, documentos personales)
- Datos de otras organizaciones
- `snapshotJson` completo del cálculo (solo resumen)

---

### 5.4 Regla de Escritura en BD

Stella **nunca puede**:
- Escribir o modificar datos directamente.
- Cambiar status de evidencias, proxies o cálculos.
- Crear entradas de audit log directamente.
- Alterar cantidades, inversiones o filtros.

Stella **sí puede**:
- Retornar recomendaciones que el usuario manualmente implementa.
- Generar draft de report sections que el usuario edita y guarda.
- Sugerir review items que un humano confirma creando `sroiRunReviewItems`.

---

### 5.5 Regla de Fallback Graceful

Si `STELLA_ENABLED=false` o Gemini no responde:
- No renderizar panel Stella en UI.
- No mostrar error al usuario.
- Flujo SROI completo funciona sin Stella.
- Mensaje amigable: "AI assistance temporarily unavailable" (si está visible).

---

## 6. Arquitectura de Estructura de Carpetas (Propuesta para 9B+)

```
lib/stella/
├── adapter/
│   ├── gemini-client.ts        # Wrapper singleton de Gemini SDK (server-only, 'use server')
│   ├── gemini-client.test.ts   # Tests con mock Gemini
│   └── types.ts                # StellaRequest, StellaResponse, StellaRole
│
├── prompts/
│   ├── shared-guardrails.ts    # Texto de guardrails inyectado en todos los prompts
│   ├── advisor-system.ts       # Builder del system prompt Advisor
│   ├── validator-system.ts     # Builder del system prompt Validator
│   ├── composer-system.ts      # Builder del system prompt Composer
│   └── index.ts                # Re-exports
│
├── schemas/
│   ├── advisor-output.ts       # Zod schema para AdvisorOutput
│   ├── validator-output.ts     # Zod schema para ValidatorOutput
│   ├── composer-output.ts      # Zod schema para ComposerOutput
│   ├── context.ts              # StellaProjectContext
│   └── index.ts                # Re-exports
│
├── context/
│   ├── build-advisor-context.ts     # Armar contexto para Advisor desde proyecto
│   ├── build-validator-context.ts   # Armar contexto para Validator desde cálculo
│   ├── build-composer-context.ts    # Armar contexto para Composer desde reporte
│   └── index.ts                     # Re-exports
│
├── __tests__/
│   ├── anti-regression.test.ts       # Tests que Stella NUNCA calcula, NUNCA certifica, NUNCA escribe
│   ├── prompt-injection.test.ts      # Tests de sanitización de inputs
│   └── cross-org.test.ts             # Tests que Stella respeta boundaries de org
│
└── index.ts                          # Main export

app/actions/stella/
├── advisor.ts                  # Server action: getStellaAdvisor(projectId, step)
├── validator.ts                # Server action: runStellaValidation(projectId, runId?)
├── composer.ts                 # Server action: composeStellaReportSection(projectId, reportId, sectionType)
└── index.ts                    # Re-exports
```

---

## 7. Output Schemas (JSON Estructurado)

### 7.1 AdvisorOutput (Zod)

```typescript
const AdvisorOutputSchema = z.object({
  step: z.string().describe('nombre del paso del pipeline'),
  what_to_do: z.string().describe('qué debe hacer el usuario en este paso'),
  why_it_matters: z.string().describe('por qué es metodológicamente importante'),
  how_to_do_it: z.string().describe('cómo hacerlo de forma rigurosa'),
  common_mistakes: z.array(z.string()).describe('errores comunes a evitar'),
  suggested_next_actions: z.array(z.string()).describe('próximos pasos'),
})
```

### 7.2 ValidatorOutput (Zod)

```typescript
const ValidatorOutputSchema = z.object({
  summary: z.string().describe('resumen ejecutivo de la validación'),
  risk_level: z.enum(['low', 'medium', 'high']).describe('nivel de riesgo metodológico'),
  evidence_gaps: z.array(z.string()).describe('outcomes/indicadores sin evidencia'),
  proxy_risks: z.array(z.string()).describe('proxies débiles o sin fuente'),
  attribution_risks: z.array(z.string()).describe('riesgos de atribución detectados'),
  claim_risks: z.array(z.string()).describe('overclaiming o lenguaje no audit-ready'),
  recommendations: z.array(z.string()).describe('recomendaciones para mejorar'),
  requires_human_review: z.literal(true).describe('SIEMPRE true — hardcoded'),
})
```

### 7.3 ComposerOutput (Zod)

```typescript
const ComposerOutputSchema = z.object({
  section_key: z.string().describe('tipo de sección: executive_summary, theory_of_change, etc.'),
  draft_title: z.string().describe('título propuesto de la sección'),
  draft_content: z.string().describe('contenido draft en markdown/texto plano'),
  assumptions: z.array(z.string()).describe('supuestos metodológicos explícitos'),
  limitations: z.array(z.string()).describe('limitaciones del análisis'),
  evidence_references: z.array(z.object({
    evidenceId: z.string(),
    title: z.string(),
    context: z.string().describe('cómo se cita en el reporte'),
  })).describe('evidencias referenciadas'),
  proxy_references: z.array(z.object({
    proxyId: z.string(),
    name: z.string(),
    context: z.string().describe('cómo se cita en el reporte'),
  })).describe('proxies referenciados'),
})
```

---

## 8. Testing Strategy (9B+)

### 8.1 Unit Tests: Prompt Builders

```
lib/stella/prompts/__tests__/
├── advisor-system.test.ts
├── validator-system.test.ts
├── composer-system.test.ts
└── shared-guardrails.test.ts
```

**Cobertura:**
- Prompt nunca incluye secretos
- Prompt incluye guardrails en todo caso
- Contexto está bien formateado JSON
- Longitud de prompt dentro de límites Gemini

### 8.2 Adapter Tests (Mock Gemini)

```
lib/stella/adapter/__tests__/
├── gemini-client.test.ts
└── rate-limiter.test.ts
```

**Cobertura:**
- Parsing correcto de output JSON
- Fallback on malformed response
- Rate limiting funciona
- Error handling no expone secretos

### 8.3 Anti-Regression Tests (CRÍTICOS)

```
lib/stella/__tests__/anti-regression.test.ts
```

**Tests que NUNCA deben fallar:**

```typescript
it('NEVER: Stella calculates SROI ratio', () => {
  // Assert geminiClient mock never calls sroi-calculation functions
})

it('NEVER: Stella output contains certification claims', () => {
  // Assert output.summary doesn't match /certified|approved|audited/i
})

it('NEVER: Stella writes to DB without explicit user action', () => {
  // Assert no DB mutations inside stella adapter calls
})

it('NEVER: GEMINI_API_KEY appears in client bundle', () => {
  // Build-time analysis: GEMINI_API_KEY must be absent from .next/static
})

it('ALWAYS: requires_human_review is true in ValidatorOutput', () => {
  // Assert ValidatorOutputSchema has literal(true)
})

it('NEVER: Stella accesses cross-org data', () => {
  // Assert all Stella actions require organizationAccess + projectId ownership
})
```

### 8.4 Security Tests

```
lib/stella/__tests__/security.test.ts
```

- Prompt injection con narrativa adversarial
- Cross-org project context leakage
- Storage secret exposure
- Service role key exposure

---

## 9. Rate Limiting & Cost Control

### 9.1 Rate Limit por Organización

Implementar counter en DB (`stella_interactions` tabla, implementada en Sprint 9D):

```
SELECT COUNT(*) FROM stella_interactions 
WHERE organization_id = ? AND created_at > NOW() - interval '1 hour'
```

Si excede `STELLA_RATE_LIMIT_PER_HOUR` (default: 100):
- Retornar `StellaRateLimitError`
- UI muestra: "Stella assistance limit reached. Try again in X minutes."

### 9.2 Cost Visibility

Aunque Gemini Flash es económico, documentar en Sprint 9B:
- Costo estimado por request (token counting)
- Costo acumulado por organización (mensual)
- Opciones para orgs de bajo costo: cache de responses, cached context re-use

---

## 10. No está implementado en Sprint 9A

| Aspecto | Status |
|--------|--------|
| Gemini SDK installation | ❌ No |
| `gemini-client.ts` adapter | ❌ No |
| Server actions `/stella/*` | ❌ No |
| DB migration `stella_interactions` | ❌ No |
| UI components Stella panel | ❌ No |
| Feature flags en código | ❌ No (vars documentadas, no en app) |
| Real Gemini calls | ❌ No |
| Integration tests contra Gemini API | ❌ No |
| Production deployment | ❌ No |

**Todo lo anterior se implementa en Sprints 9B-9E.**

---

## 11. Documentos relacionados (Referencia)

- `docs/13_STELLA_AI_SPEC.md` — Spec original de roles y comportamiento
- `docs/14_TRUST_LAYER_SPEC.md` — Trazabilidad y metadatos
- `docs/16_SROI_METHODOLOGY_SPEC.md` — Fórmula y cálculo (determinístico)
- `docs/09_API_AND_INTEGRATIONS.md` — Integración Gemini (v1)
- `lib/pipeline/sroi-calculation.ts` — Engine determinístico (inviolable)

---

## 12. Recomendación para Sprint 9B

**Primer bloque implementable:** Gemini Adapter + Guardrails

**Tareas de Sprint 9B:**
1. `lib/stella/adapter/gemini-client.ts` con mock tests
2. `lib/stella/prompts/shared-guardrails.ts` + builders (advisor, validator, composer)
3. `lib/stella/schemas/` — Zod schemas de output
4. `lib/stella/__tests__/anti-regression.test.ts` — Tests sin implementación aún
5. Rate limiter boilerplate (sin tabla DB todavía)
6. Documentación de prompts (templates, ejemplos)

**Decisiones pendientes antes de 9B:**
- ¿Qué proveedor caching para contextos grandes? (Redis, Postgres JSON, memoria)
- ¿Logging nivel de detalle (solo hash, o full snapshots)?
- ¿Cómo manejar timeout de Gemini (< 5s, 5-15s, > 15s)?

---

## 13. Estado de aprobación

| Aspecto | Aprobado | Fuente |
|---------|----------|--------|
| Arquitectura general | ✅ | Sprint 9 Scout Report |
| Roles Advisor/Validator/Composer | ✅ | Sprint 9 Scout Report |
| Proxy Suggester deferido | ✅ | Decisión 9A |
| Modelo gemini-2.0-flash | ✅ | Decisión 9A |
| Request/response MVP | ✅ | Decisión 9A |
| Variables de entorno | ✅ | Documentado aquí |
| Guardrails de claims | ✅ | Prohibitions list |
| Testing strategy | ✅ | Sección 8 |
| No datos reales a Gemini en MVP | ✅ | Decisión 9A |

---

## 14. Conclusión

Sprint 9A cierra formalmente:
- **Arquitectura:** Definida y documentada
- **Decisiones:** Tomadas y registradas
- **Guardrails:** Establecidos como requisitos
- **Testing:** Estrategia escrita (implementación en 9B+)
- **Riesgos:** Identificados y mitigados

**Sprint 9B está autorizado para comenzar con la implementación del Gemini Adapter + Guardrails.**

