# Roadmap de implementación de Stella

**Fecha:** 2026-07-24. Deriva de `STELLA_GAP_ANALYSIS.md`. La **fuente de verdad ejecutable es `STELLA_BACKLOG.csv`**; este documento explica las fases. Principio: *la IA propone y analiza; el sistema controla y calcula; las personas deciden y aprueban.*

Regla de secuencia: **ninguna capacidad de IA se enciende sin (a) las salvaguardas de la Fase 0 y (b) una pasada verde del arnés de evaluación.** Encender flags es una decisión de operación, no un efecto de merge.

---

## Fase 0 — Seguridad e integridad (bloqueadores)

**Objetivo:** cerrar lo que impide encender o ampliar Stella con seguridad.
**Alcance:** GAP-P0-1..5 + correcciones de deuda de riesgo. **Tareas:** `STL-P0-001..009`.
**Componentes:** `lib/stella/context/sanitize.ts`, `context/*`, `adapter/gemini-client.ts`, `db/migrations/*` (aditivas), `tests/integration/*`, un nuevo arnés de eval.
**Migraciones:** aditiva para persistir el payload enviado y la versión de prompt (`STL-P0-007`); aditiva para corregir el `DEFAULT` del modelo (`STL-P0-008`). Ninguna destructiva.
**APIs:** sin endpoints nuevos; se endurecen las server actions existentes.
**Interfaz:** sin cambios visibles (salvo avisos de PII si se detecta).
**Pruebas:** inyección, aislamiento RLS de `stella_interactions`, y el arnés de eval (≥10 casos por rol).
**Riesgos:** el eval requiere llamadas reales al modelo con cuota propia, fuera del CI normal.
**Dependencias:** el bootstrap local ya existe (estabilización P0 del proyecto).
**Criterios de salida:** injection neutralizada y probada; eval ejecutable con rúbrica; inventario de datos enviados + gate de PII + DPA documentado; test de aislamiento verde; el payload/prompt-version quedan auditables.

## Fase 1 — Stella contextual y gobernada

**Objetivo:** que Stella deje de ser genérica: prompts por paso, contexto real, procedencia, reformulación, sugerencias y Composer anclado al dato.
**Alcance:** GAP-P1-1..4. **Tareas:** `STL-P1-001..013`.
**Componentes:** `lib/stella/prompts/*`, `lib/stella/context/*`, `lib/stella/schemas/*` (esquema de sugerencia/reformulación), `app/actions/stella/*` (modos reformulate/suggest), `components/stella/*` (aceptar/descartar, diff), server actions de creación existentes (con marca de procedencia), `audit_logs`.
**Migraciones:** ninguna estructural nueva (procedencia en `audit_logs` para empezar).
**APIs:** server actions nuevas de reformulate y suggest por paso.
**Interfaz:** panel de sugerencias (aceptar/editar/descartar ítem a ítem), diff original vs reformulado, marca de "sugerido por Stella".
**Pruebas:** unitarias de prompts/esquemas; integración de aceptar→crear-fila-con-procedencia; guard numérico del Composer; mejora medible en el eval.
**Riesgos:** que el usuario sobreconfíe y acepte en lote — mitigar con aceptación ítem a ítem.
**Dependencias:** Fase 0 (injection, eval, payload).
**Criterios de salida:** cada paso tiene prompt propio con contexto real; el Composer prellena cifras del motor y no introduce números libres; el usuario acepta sugerencias con procedencia; advisor+composer se encienden en preview tras eval verde.

## Fase 2 — Evidence Intelligence

**Objetivo:** interpretar documentos, no solo almacenarlos.
**Alcance:** GAP-P2-1. **Tareas:** `STL-P2-001..008`.
**Componentes:** nuevo pipeline de extracción documental (server-side), almacenamiento de embeddings, recuperación semántica, UI de mapa de evidencia; `lib/pipeline/evidence.ts` (hooks).
**Migraciones:** `pgvector` + tabla/columnas de chunks y embeddings (`STL-P2-003`).
**APIs:** endpoints/acciones de extracción y recuperación.
**Interfaz:** mapa de evidencia; fragmentos citables ligados a outcomes.
**Pruebas:** extracción, aislamiento de contenido como dato (injection vía documento), recuperación, detección de contradicciones; casos de eval.
**Riesgos:** injection vía contenido de documento (nuevo vector) — por eso depende de la Fase 0.
**Dependencias:** Fase 0 (injection, PII).
**Criterios de salida:** de un PDF se extraen fragmentos citables ligados a un outcome, con fuente, sin ejecutar instrucciones incrustadas.

## Fase 3 — Proxy Intelligence

**Objetivo:** buscar proxies en fuentes oficiales con grounding y citación, entrando como `suggested`.
**Alcance:** GAP-P2-2. **Tareas:** `STL-P3-001..007`.
**Componentes:** `adapter/gemini-client.ts` (habilitar grounding de búsqueda), esquema de candidato con cita obligatoria, server action de búsqueda, `financial_proxies`/`proxy_sources` (flujo existente), UI de revisión.
**Migraciones:** aditivas para campos de comparabilidad metodológica del proxy (`STL-P3-005`).
**APIs:** acción de búsqueda de proxies con grounding.
**Interfaz:** revisión de candidatos con URL + fragmento; aprobación humana.
**Pruebas:** que sin cita se rechaza; que el valor aparece en la fuente; que un proxy `suggested` no es usable en un cálculo hasta aprobarse; casos de eval.
**Riesgos:** alucinación de valores/fuentes — mitigado por grounding obligatorio + verificación de cita + aprobación humana.
**Dependencias:** Fase 0 (eval), y la extracción de la Fase 2 para verificar la cita.
**Criterios de salida:** un proxy sugerido trae URL verificable, entra como `suggested`, requiere aprobación, y nunca proviene de la memoria del modelo.

## Fase 4 — Review, Calculation y Audit

**Objetivo:** revisión metodológica más fuerte, interpretación de sensibilidad, versionado y las bases del Audit Room.
**Alcance:** GAP-P2-3, GAP-P2-4, GAP-P2-5, GAP-P3-1. **Tareas:** `STL-P4-001..008`.
**Componentes:** `build-validator-context.ts` (sensibilidad), reglas SROI deterministas explícitas, `sroi_report_sections` (versionado), `stella_interactions` (versión de prompt), UI de Audit Room.
**Migraciones:** aditivas para versionado de secciones y versión de prompt.
**APIs:** modo de explicación de escenarios.
**Interfaz:** Audit Room que reconstruye el linaje de cada afirmación (humano/IA/recuperado/calculado).
**Pruebas:** que el validator lee la sensibilidad sin recalcular; que las secciones versionan; linaje reconstruible.
**Riesgos:** el Audit Room depende de que la procedencia (Fase 1) exista de verdad.
**Dependencias:** Fases 0-1 (procedencia, payload) + sensibilidad determinista ya existente.
**Criterios de salida:** un revisor ve el origen de cada afirmación de un reporte; el validator explica el supuesto de mayor impacto; secciones versionadas.

## Fase 5 — Portfolio Intelligence

**Objetivo:** análisis multi-proyecto dentro de una organización.
**Alcance:** GAP-P3-2. **Tareas:** `STL-P5-001..004`.
**Componentes:** context builder multi-proyecto org-scoped, rol de análisis de portafolio, UI de insights.
**Migraciones:** ninguna estructural (el modelo ya es org-scoped).
**APIs:** acción de análisis de portafolio.
**Interfaz:** insights de outcomes recurrentes, riesgos, proxies y resultados por territorio.
**Pruebas:** **aislamiento estricto** — nunca cruza organizaciones; casos de eval.
**Riesgos:** fuga cross-org si el builder no filtra bien — prueba de aislamiento obligatoria.
**Dependencias:** Fases 1 y 2.
**Criterios de salida:** Stella resume patrones a través de los proyectos de UNA organización, con aislamiento probado.

---

## Orden recomendado

Fase 0 → Fase 1 → (Fase 2 ∥ Fase 3, pueden solaparse tras la Fase 1) → Fase 4 → Fase 5.
Las Fases 2 y 3 comparten dependencia de la Fase 0 pero son independientes entre sí; la verificación de cita de la Fase 3 reutiliza la extracción de la Fase 2, así que si se solapan, empezar la 2 primero.

**Qué NO desarrollar todavía:** Evidence/Proxy/Portfolio (Fases 2-5) antes de cerrar Fase 0. Encender cualquier flag antes del eval verde.
