# Stella como copiloto de generación — Diseño

**Fecha:** 2026-07-24
**Estado:** aprobado en brainstorming; pendiente de revisión del spec antes del plan de implementación.
**Rama:** `feature/stella-generation-copilot`

---

## 1. Contexto y problema

Hoy Stella tiene tres roles operativos (`advisor`, `validator`, `composer`) y tres
desactivados (`proxy_reviewer`, `evidence_reviewer`, `audit_assistant`). Todo está
detrás de feature flags (`STELLA_*_ENABLED`, hoy en `false`), cuota por
organización (default 0), rate-limit, salidas validadas con Zod, y dos reglas
duras: **revisión humana obligatoria** y **nunca inventar datos**.

Limitaciones actuales:

- Los prompts son **genéricos**: `buildAdvisorSystemPrompt(step)` y
  `buildComposerSystemPrompt(sectionType)` usan el mismo esqueleto para todos los
  pasos/secciones, interpolando solo el nombre.
- El **contexto** que se le pasa es un resumen corto
  (`context.narrativeSummary.substring(0, 500)`), no los datos reales del paso.
- El **Advisor solo asesora**; no ayuda a *generar* el contenido de cada paso.
- El **Composer redacta** pero no aprovecha bien los datos reales del pipeline
  (se solapa con la tarea `F1-04` del backlog: "prellenado de secciones desde los
  datos del pipeline").

## 2. Objetivo

Convertir a Stella en un **copiloto de generación** a lo largo del pipeline y del
reporte: que ayude a redactar el contenido de cada paso y de cada elemento del
reporte, **sin violar nunca la regla de no inventar datos** y manteniendo la
revisión humana como frontera inviolable.

## 3. Principio rector — el gradiente factual

El permiso de Stella se gradúa según **cuán factual/verificable** sea lo que se
produce en cada paso:

- Cerca de **lenguaje o lógica de la propia organización** (narrativa, teoría del
  cambio, grupos, outcomes, indicadores) → puede **reformular y sugerir
  candidatos**.
- Cerca de **hechos y fuentes verificables** (evidencia, valores de proxy) → solo
  puede **reformular lo que el humano escribió**; nunca sugiere el hecho en sí.
- **Cifras calculadas** (paso de cálculo) → Stella **nunca las toca**.

Corolario para el reporte: **las cifras vienen del dato; la prosa viene de
Stella.** Stella nunca teclea un número que no esté ya calculado y persistido.

---

## 4. Sección A — Matriz por paso del pipeline

Los 8 pasos son: 1 Narrativa, 2 Grupos de interés, 3 Resultados, 4 Indicadores,
5 Evidencia, 6 Proxies, 7 Centro de confianza, 8 Cálculo.

| # | Paso | Asesora | Reformula lo del humano | Sugiere candidatos | Prohibido |
|---|------|:--:|:--:|:--:|-----------|
| 1 | Narrativa / Teoría del cambio | ✅ | ✅ | ✅ nodos, enlaces causales, supuestos a considerar | inventar las actividades reales del programa |
| 2 | Grupos de interés | ✅ | ✅ | ✅ grupos típicos del sector, a validar | afirmar que un grupo existe como hecho |
| 3 | Resultados (outcomes) | ✅ | ✅ descripción, justificación de materialidad | ✅ outcomes a considerar, marcados | fijar la materialidad por el humano; inventar magnitudes |
| 4 | Indicadores | ✅ | ✅ | ✅ indicador, unidad, fuente de datos a considerar | **inventar valores** (línea base, meta, real) |
| 5 | Evidencia | ✅ | ✅ título/descripción de lo subido | ❌ | inventar evidencia, fuentes o hashes |
| 6 | Proxies | ✅ | ✅ justificación escrita por el humano | ⚠️ **búsqueda externa con citación** (§4.1) | inventar un valor o fuente de proxy desde la memoria del modelo |
| 7 | Centro de confianza | ✅ | ❌ | ❌ | — |
| 8 | Cálculo | ✅ vía Validator | ❌ | ❌ | tocar los números. **Lanza el borrador del reporte** (§5) |

### 4.1 Paso 6 — Búsqueda externa de proxies con citación

Decisión: Stella **no** empareja solo con el banco existente, sino que **busca en
la web real** proxies útiles para el proyecto usando el *grounding de búsqueda de
Gemini*, y propone candidatos **nuevos**.

Salvaguardas inviolables:

- **Ningún valor de proxy puede venir de la memoria del modelo.** Cada valor
  propuesto debe trazar a una **URL de fuente oficial** que el grounding devolvió.
- Cada candidato entra como un `proxy_sources` (la fuente) + un `financial_proxies`
  con `reviewStatus = 'suggested'`, `createdBy` = el usuario, y la URL en el campo
  de fuente. **No es usable en ningún cálculo** hasta que un humano lo apruebe
  (`suggested → pending_review → approved`), que es el flujo actual.
- La respuesta de Stella incluye la **cita de grounding** (URL + fragmento) para
  que el revisor humano verifique antes de aprobar.

### 4.2 Paso 8 — Lanzamiento del borrador del reporte

Una vez existe una corrida de cálculo, el paso 8 ofrece **generar los borradores
de todos los elementos del reporte** (Sección B) usando toda la información
acumulada de los pasos 1-7. Es el punto de entrada natural a la Pieza 3.

---

## 5. Sección B — Mapeo del reporte

Las 12 secciones (`lib/reports/report-sections.ts`) se dividen en dos tratamientos.
En ambos, **las cifras se prellenan del dato real; Stella solo aporta prosa**.

**Ancladas al dato** (se construyen de las filas reales; Stella escribe la prosa
conectora, nunca las cifras):
`calculation_results`, `funder_breakdown`, `sroi_filters`, `outcomes`,
`stakeholders`, `evidence_summary`, `proxy_methodology`.

**De síntesis** (Stella redacta lenguaje, referenciando solo datos reales):
`executive_summary`, `project_context`, `theory_of_change`, `limitations`,
`review_notes`.

**Ensamblada** (del dato, mínima intervención de Stella): `appendix`.

Esto conecta el Composer a los datos reales del pipeline (resuelve `F1-04`).

---

## 6. Sección C — Frontera de revisión humana (invariante)

**Nada se persiste sin una acción explícita del usuario.** Cuatro patrones de UX:

| Patrón | Dónde | Comportamiento |
|--------|-------|----------------|
| Asesoría | pasos 1-8 | Panel de solo lectura (ya existe). |
| Reformular | pasos 1-6 (descripciones, justificaciones) | El texto propuesto aparece en el campo editable; el usuario edita y **guarda explícitamente**. Nunca autoguardado. |
| Sugerir candidatos | pasos 1-4 | Lista de propuestas; el usuario acepta/edita/descarta **ítem a ítem**. Aceptar crea la fila vía la server action existente, con `createdBy` = usuario y marca de procedencia "Stella". |
| Proxies | paso 6 | Candidatos con URL de fuente → entran como `suggested` → flujo de aprobación humana existente. No usables hasta aprobar. |
| Borrador de reporte | paso 8 / editor de reporte | Borrador por sección en el editor; el usuario revisa y guarda (patrón existente, mejorado). El bloqueo del reporte sigue exigiendo la compuerta de completitud (`F1-02`) y la revisión metodológica existente. |

## 7. Sección D — Gobernanza e infraestructura compartida

- **Sin cambios de gobernanza**: todo sigue detrás de los flags actuales (hoy
  `false`), cuota por organización y rate-limit. **Nada se enciende solo en
  producción.** Este trabajo construye/mejora la capacidad; encenderla es una
  decisión de operación aparte.
- **Prompts por paso y por modo**: se reemplazan los builders genéricos por
  builders específicos (`advise` / `reformulate` / `suggest` por paso; por sección
  en el reporte).
- **Contexto real**: nuevos context builders que pasan los datos reales del paso
  (no un `substring(0,500)`), respetando el `sanitize.ts` existente.
- **Esquema de sugerencia**: un esquema Zod nuevo, distinto del de asesoría, para
  las salidas de "sugerir candidatos" (lista de ítems propuestos con su
  justificación) y para los candidatos de proxy (con cita de grounding).
- **Procedencia**: se registra en `audit_logs` (sin cambiar el esquema para
  empezar) que una fila se originó de una sugerencia de Stella. `stella_interactions`
  ya registra cada llamada (rol, hash de contexto, respuesta) y se reutiliza.
- **Grounding en el adaptador**: `lib/stella/adapter/gemini-client.ts` se extiende
  para habilitar la herramienta de búsqueda de Gemini, solo para el rol de
  búsqueda de proxies. (Verificar en el plan la disponibilidad de la herramienta
  en la versión de `@google/genai` en uso.)

## 8. Componentes y archivos afectados

- `lib/stella/config.ts` — flags (posible flag nuevo para el rol de búsqueda de proxies).
- `lib/stella/prompts/*` — builders por paso/modo/sección (reemplazan advisor-system y composer-system genéricos).
- `lib/stella/context/*` — builders de contexto con datos reales por paso.
- `lib/stella/schemas/*` — esquema de sugerencia + esquema de candidato de proxy con cita.
- `lib/stella/adapter/gemini-client.ts` — grounding (fase 4).
- `app/actions/stella/*` — acciones nuevas: sugerir por paso, buscar proxies; ampliar composer.
- `components/stella/*` — paneles de sugerencia (aceptar/descartar) y de reporte.
- `app/app/projects/[projectId]/pipeline/*` — puntos de entrada por paso.
- `app/app/projects/[projectId]/report/*` — lanzamiento desde el paso 8 y editor.
- Server actions de creación existentes (stakeholders, outcomes, indicators, ToC,
  proxies) — reutilizadas para persistir lo que el usuario acepta; se añade la
  marca de procedencia.

## 9. Sección E — Fases de construcción (riesgo ascendente)

Un solo spec, construcción por fases. Cada fase es entregable por sí sola.

1. **Advisor afinado** — prompts por paso + contexto real. Riesgo bajo (solo
   asesoría, no toca datos). El más barato.
2. **Composer del reporte** — datos reales + prompts por sección, lanzado desde el
   paso 8. Es el "generar contenido del reporte por elemento" enfatizado por el
   usuario; resuelve `F1-04`.
3. **Drafting del pipeline** — reformular + sugerir candidatos (pasos 1-4) con UX
   de aceptar/editar/descartar + procedencia.
4. **Búsqueda externa de proxies** — grounding + citación + flujo de aprobación.
   La más compleja y delicada; al final.

## 10. Pruebas

- **Unitarias** por builder de prompt y de contexto (que el contexto incluye lo
  esperado y sanitiza lo sensible).
- **Esquemas Zod**: que una salida sin cita de fuente para un proxy se rechaza;
  que una sugerencia nunca trae valores numéricos donde no debe.
- **Anti-regresión** (existe `lib/stella/__tests__/anti-regression.test.ts`): las
  pruebas nunca llaman a Gemini real; el grounding se mockea.
- **Frontera de revisión humana**: que aceptar una sugerencia crea la fila con
  procedencia y `createdBy` = usuario; que un proxy sugerido entra como
  `suggested` y no es elegible en un cálculo hasta aprobarse.
- **Integración** (contra el stack local, con las guardas de host de F0-05): que
  un proxy `suggested` de Stella no puede usarse en una corrida.

## 11. No-objetivos (YAGNI)

- **No** se encienden los flags en producción como parte de este trabajo.
- **No** se añaden columnas de esquema para procedencia en la primera versión
  (se usa `audit_logs`); se puede reconsiderar después.
- **No** se automatiza la aprobación de proxies: la aprobación humana sigue siendo
  obligatoria.
- **No** se toca el motor de cálculo, las fórmulas, ni la estructura de reportes
  más allá de rellenar el contenido de las secciones.
- **No** se rediseñan los paneles de Stella existentes salvo lo necesario para los
  patrones de sugerencia.

## 12. Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| Alucinación de proxies (valores/fuentes inventados) | Grounding obligatorio con URL; entrada como `suggested`; aprobación humana; el revisor ve la cita. |
| Stella "inventa" outcomes/indicadores que el usuario acepta sin pensar | Marca clara de "sugerencia a validar"; aceptación ítem a ítem; procedencia registrada. |
| Coste/latencia de Gemini con contexto grande | Rate-limit y cuota existentes; contexto acotado y sanitizado. |
| El grounding no está disponible en la versión de `@google/genai` | Verificar en el plan; la fase 4 es la última y puede reprogramarse sin bloquear 1-3. |
| Cifras del reporte divergen del dato | Las cifras se prellenan del dato real; Stella solo escribe prosa; pruebas que verifican que no introduce números. |
