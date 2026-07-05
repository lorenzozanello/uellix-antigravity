# Uellix — Roadmap técnico-metodológico hacia una plataforma científica de impacto

**Fecha:** 2026-07-04
**Estado:** Documento de decisión, sin plan de implementación aprobado. No implica cambios de
código, de schema ni de dependencias por sí mismo.

## Contexto

Este documento parte de un diagnóstico técnico neutral del repositorio (código, schema, rutas,
servicios y documentación interna) realizado el mismo día. Ese diagnóstico confirmó que Uellix
**no es un prototipo**: el pipeline metodológico central (fuente → evidencia → proxy → cálculo →
revisión → reporte) está implementado, persistido con constraints, validado con Zod, protegido por
RLS y roles, y auditado con inmutabilidad forzada a nivel de base de datos
(`db/manual-migrations/002_append_only.sql`).

El objetivo de este roadmap es evolucionar esa base — sin reconstruirla — hacia una plataforma de
gestión de impacto, SROI, evidencia, proxies, teoría de cambio, sensibilidad, portafolios,
reporting audit-ready e IA metodológica. Cada fase parte de archivos, tablas o módulos reales del
repositorio, no de funcionalidad asumida.

## Non-goals

- No reconstruir la plataforma desde cero. El motor de cálculo (`lib/pipeline/sroi-calculation.ts`),
  el modelo de auditoría (`lib/audit/logger.ts` + triggers append-only) y el modelo de permisos
  (`lib/auth/*`) son cimientos maduros y **no se tocan salvo extensión aditiva**.
- No romper retrocompatibilidad de runs de cálculo existentes, proyectos con narrativa en texto
  libre, ni reportes ya bloqueados (`status: 'locked'`).
- No modificar archivos, hacer commits, instalar dependencias ni implementar nada como parte de
  este documento. Es material de planeación para priorizar sprints.
- No asumir funcionalidad no verificada en el código. Cada capacidad "no existe" fue confirmada por
  ausencia (grep, lectura de servicio, o comentario explícito del propio código) antes de listarse
  como brecha.

## 0. Línea base confirmada

| Capacidad | Estado | Evidencia |
|---|---|---|
| **Maduras (4–5)** | Auth/roles/RLS, evidencia (SHA-256 + verificación de integridad), proxies (ciclo de aprobación), motor de cálculo SROI (decimal.js, transacción atómica, evidence gate), auditoría append-only | `lib/auth/*`, `db/policies/001_initial_auth_rls.sql` (RLS cubre todas las tablas del pipeline, incluidas `sroi_*`), `lib/pipeline/evidence.ts`, `lib/pipeline/sroi-calculation.ts`, `db/manual-migrations/002_append_only.sql` |
| **Parciales (2–3)** | Portafolios (solo CRUD, sin agregación), comparación de runs (diff de 2, no sensibilidad), reportes (13 secciones editables, export = print de navegador), teoría de cambio (campo de texto libre) | `lib/portfolios/service.ts` (sin ninguna referencia a `sroi`/`aggregate`/`ratio`), `lib/pipeline/sroi-results.ts:104` (`compareCalculationRuns`), `lib/reports/report-sections.ts` |
| **No existen** | Sensibilidad paramétrica, tasa de descuento/NPV, taxonomías IRIS+/ODS/GRI/ESG/TNFD, agregación de portafolio, PDF real, roles adicionales de Stella | Ausencia confirmada en `lib/pipeline/sroi-calculation.ts` (comentario propio: *"No discount rate applied... FX conversion not supported"*); sin dependencia de PDF en `package.json` |
| **Documentadas pero no implementadas** | Multi-funder / in-kind / FX-a-USD (spec completo ya escrito, cero código), NPV (Subproyecto B, mencionado como diferido en el mismo spec), catálogo de proxies por tipología (Subproyecto C) | `docs/superpowers/specs/2026-07-03-multi-funder-investment-usd-design.md` — diseño detallado de tablas `funders`, `fx_rates`, `outcome_funder_allocations` y cambios a `sroi-calculation.ts`, sin implementación correspondiente |

**Clasificación transversal** (aplicada en cada fase):

- **Deuda técnica** — algo inconsistente respecto al propio patrón del repo; hay que corregirlo, no
  diseñarlo.
- **Brecha metodológica** — algo que el estándar SROI / Social Value International exige y el motor
  no cubre aún.
- **Mejora de producto** — algo que ya funciona pero no es usable/visible como debería.
- **Evolución estratégica** — capacidad nueva que cambia lo que Uellix *es* (interoperabilidad
  internacional, IA activa a escala).

---

## Fase 0 — Hardening técnico inmediato

**Tipo:** deuda técnica.

1. **Objetivo:** eliminar inconsistencias y riesgos concretos antes de tocar el schema o el motor
   de cálculo, para no construir sobre una base con grietas conocidas.
2. **Capacidades nuevas:** ninguna — es saneamiento, no funcionalidad.
3. **Módulos afectados:**
   - `app/actions/stella/advisor.ts:119` — inserta `contextHash: ''` en `stellaInteractions` pese a
     que el schema lo declara `notNull()` de 64 caracteres. El hash de contexto no se está poblando
     en la ruta advisor.
   - `lib/stella/adapter/gemini-client.ts:112-113` — comentario propio: *"Singleton instance
     (dev/test only - production should create per-org instance)"*. Deuda auto-declarada por el
     propio autor, no una inferencia externa.
   - Drift de snapshot Drizzle + migración `0013_performance_indexes.sql` pendiente de aplicar en
     producción (registrado en memoria de proyecto).
   - `.claude/worktrees/stoic-fermi-dbbb71/` — worktree obsoleto con copia parcial y antigua del
     repo; contamina búsquedas y conteos de test.
   - `indicators.baselineValue/targetValue/actualValue` como `varchar` — inconsistente con el
     patrón `numeric(20,4)` ya establecido para dinero (`003_numeric_columns.sql`); bloquea
     cualquier análisis cuantitativo real de indicadores en Fase 1–2.
   - `lib/portfolios/service.ts:49` — genera `id: crypto.randomUUID()` manualmente cuando la
     columna ya tiene `.defaultRandom()`; inconsistente con el resto de servicios.
4. **Tablas/schema:** ninguna nueva. Posible migración de tipo (`varchar → numeric`) en
   `indicators`, a decidir, no a ejecutar en esta fase sin validar impacto en datos ya cargados.
5. **Riesgos técnicos:** bajos si se acota a lo listado; el riesgo real es *no* hacerlo y arrastrar
   el bug de `contextHash` hasta Fase 5 (Stella activa), donde el audit trail de IA empieza a
   importar de verdad.
6. **Riesgos metodológicos:** ninguno directo, pero el `contextHash` vacío rompe silenciosamente la
   trazabilidad de qué contexto exacto vio Stella en cada interacción.
7. **Dependencias:** ninguna — es el punto de partida de todo lo demás.
8. **Pruebas necesarias:** test que verifique que `stellaInteractions.contextHash` no queda vacío
   tras una llamada real al advisor; `drizzle-kit check` limpio contra la DB real; confirmación de
   que 0013 está aplicada en producción.
9. **Criterios de aceptación:** cero drift de schema, `contextHash` poblado y testeado, worktree
   obsoleto eliminado, decisión documentada sobre el tipo de columnas de `indicators`.
10. **Orden:** primero, bloqueante para todo lo siguiente.

---

## Fase 1 — Rigor SROI avanzado

**Tipo:** brecha metodológica, con una pieza de evolución estratégica ya diseñada (multi-funder/FX).

1. **Objetivo:** llevar el motor de cálculo de "determinista pero simplificado" a "metodológicamente
   defendible" — descuento temporal, sensibilidad, escenarios, y normalización de moneda (ya
   especificada en `docs/superpowers/specs/2026-07-03-multi-funder-investment-usd-design.md`).
2. **Capacidades nuevas:** NPV/tasa de descuento; sensibilidad paramétrica (variar
   deadweight/atribución/desplazamiento/decaimiento en rangos); escenarios
   conservador/base/optimista; registro estructurado de supuestos; normalización FX→USD
   (Subproyecto A, ya diseñado y listo para implementar sin diseño adicional).
3. **Módulos afectados:** `lib/pipeline/sroi-calculation.ts` (núcleo — extender
   `runDeterministicCalc`), nuevo `lib/pipeline/sroi-sensitivity.ts`, `lib/pipeline/sroi-results.ts`
   (extender `compareCalculationRuns` o añadir función dedicada de sensibilidad), UI en
   `calculation/page.tsx` y `calculation/compare/page.tsx`.
4. **Tablas nuevas/cambios:**
   - De la spec ya escrita: `funders`, `fx_rates`, `outcome_funder_allocations`; columnas nuevas en
     `project_investments` (`funder_id`, `contribution_type`, `amount_usd`, `fx_rate_id`) y en
     `financial_proxies` (`value_usd`, `fx_rate_id`).
   - Nuevas, a diseñar: columna `discount_rate_pct` + `npv` en `sroi_calculation_runs`; tabla
     `sroi_assumptions` (tipo, racional, fuente) vinculada a `sroi_filter_sets`/`outcomes`; un
     mecanismo de "escenario" que **no viole el trigger append-only** — la recomendación es que un
     escenario sea un `sroi_calculation_runs` más (ya versionado, ya inmutable), etiquetado vía un
     campo `run_kind` (`'official' | 'scenario'`), nunca una tabla mutable en paralelo.
5. **Riesgos técnicos:** la spec de FX ya identifica el suyo propio (*"the exact COP TRM data
   source is unverified... first implementation task must include a live spike"*) — no asumir un
   endpoint no verificado. El descuento compuesto en `Decimal` debe probarse contra casos conocidos
   para evitar arrastre de error de precisión en potencias.
6. **Riesgos metodológicos:** introducir una tasa de descuento sin gate de revisión puede producir
   un ratio "más preciso en apariencia" pero cuestionable si el usuario la fija arbitrariamente —
   debe pasar por Stella Validator (Fase 5) antes de usarse externamente. Multiplicar escenarios sin
   distinción visual clara entre "oficial" y "exploratorio" reintroduce el riesgo de sobreestimación
   que el evidence gate ya combate.
7. **Dependencias:** Fase 0 completa (columnas numéricas estables). La spec de FX es independiente
   y puede implementarse en paralelo a NPV/sensibilidad.
8. **Pruebas necesarias:** recálculo de casos con NPV conocido a mano; tests de sensibilidad con
   rangos fijos; regresión que confirme que runs existentes (sin discount rate) se leen igual que
   antes; los tests de aislamiento cross-org y de constraint ya detallados en la sección "Testing"
   del spec de FX.
9. **Criterios de aceptación:** ningún run histórico cambia de valor; el discount rate es opcional
   y default = 0 (comportamiento actual preservado); un escenario nunca sobrescribe ni se confunde
   con un run oficial en la UI.
10. **Orden:** FX (Subproyecto A) primero por estar ya diseñado y ser prerrequisito duro de Fase 4
    (portafolio multi-moneda); NPV y sensibilidad después.

---

## Fase 2 — Modelo científico Uellix

**Tipo:** brecha metodológica.

1. **Objetivo:** pasar de campos de texto libre (`theoryOfChangeSummary`, `outcomeType`,
   `confidenceLevel` como string) a un modelo estructurado y puntuable, sin romper los proyectos
   existentes que ya usan el modelo actual.
2. **Capacidades nuevas:** teoría de cambio como grafo (actividad→producto→resultado con supuestos
   explícitos por enlace), score de confianza calculado (no solo declarado), materialidad con
   justificación estructurada, enlaces de causalidad, matriz de revisión metodológica extendida a
   todo el pipeline (hoy `sroi_run_review_items` solo cubre el run de cálculo).
3. **Módulos afectados:** `db/schema.ts` (extensión significativa), `lib/pipeline/narratives.ts`,
   `outcomes.ts`, `evidence.ts`, nuevo `lib/pipeline/theory-of-change.ts`, nuevo
   `lib/pipeline/confidence-score.ts`.
4. **Tablas nuevas:** `theory_of_change_nodes` + `theory_of_change_links` (con supuesto por
   enlace); extensión de `outcomes` con `materiality_score`/`materiality_rationale`; extensión de
   `evidence_items` con `confidence_score` calculado; generalización de `sroi_run_review_items` →
   `methodology_review_matrix_items` aplicable a cualquier paso del pipeline, no solo al cálculo.
5. **Riesgos técnicos:** migración de datos existentes sin pérdida — todo proyecto que hoy solo
   tiene `theoryOfChangeSummary` como texto debe seguir funcionando sin forzar re-captura.
6. **Riesgos metodológicos:** `docs/16_SROI_METHODOLOGY_SPEC.md` tiene una sección "Soporte para
   diversidad de proyectos" — formalizar de más puede romper esa flexibilidad. La estructura debe
   ser **opcional**, no un reemplazo obligatorio del texto libre.
7. **Dependencias:** Fase 1 debe estar estable (el modelo de evidencia/proxy ya es sólido y no
   requiere tocarse, solo extenderse).
8. **Pruebas necesarias:** tests de que proyectos "legacy" (solo narrativa en texto) siguen
   operando sin romperse; validación de que el score de confianza es determinista y auditable.
9. **Criterios de aceptación:** ningún proyecto existente pierde funcionalidad; adopción del
   modelo estructurado es opt-in por proyecto.
10. **Orden:** después de Fase 1; puede correr en paralelo con Fase 3.

---

## Fase 3 — Interoperabilidad internacional

**Tipo:** evolución estratégica.

1. **Objetivo:** permitir mapear outcomes/indicadores propios a estándares externos (IRIS+, ODS,
   GRI, ESG, TNFD) para comparabilidad frente a financiadores — hoy `outcomeType`/`indicatorType`
   son texto libre sin catálogo controlado.
2. **Capacidades nuevas:** catálogos de referencia versionados, mapeo (crosswalk) muchos-a-muchos
   entre outcomes propios y códigos estándar, visualización en reportes.
3. **Módulos afectados:** nuevo `lib/taxonomies/`, `lib/reports/report-sections.ts` (sección nueva
   o enriquecimiento de "outcomes"/"proxy_methodology"), UI admin siguiendo el patrón ya existente
   de `/admin/proxies`.
4. **Tablas nuevas:** `taxonomy_catalogs` (fuente + versión), `taxonomy_codes` (código, etiqueta,
   catálogo), `outcome_taxonomy_mappings` (outcome_id, taxonomy_code_id, confianza del mapeo,
   racional).
5. **Riesgos técnicos:** mantenimiento de catálogos a medida que IRIS+ y otros estándares se
   revisan periódicamente — requiere estrategia de versionado, no una carga única.
6. **Riesgos metodológicos:** el mayor riesgo es la falsa equivalencia — mapear un outcome propio a
   un código IRIS+ no debe presentarse como certificación, sino como referencia de comparabilidad.
   Debe quedar textualmente claro en el reporte, igual que el disclaimer ya existente hoy
   ("esto no constituye auditoría independiente") en `calculation/page.tsx:227`.
7. **Dependencias:** ninguna dura sobre Fase 2 — los mapeos pueden anclarse directamente a la
   tabla `outcomes` actual sin esperar el modelo estructurado, aunque se benefician de él.
8. **Pruebas necesarias:** integridad de datos semilla de catálogos, constraint de unicidad en
   crosswalks.
9. **Criterios de aceptación:** al menos IRIS+ y ODS sembrados y mapeables; el reporte muestra los
   códigos mapeados solo cuando existen, nunca los inventa ni los asume.
10. **Orden:** pista independiente, puede iniciar en paralelo a Fase 2.

---

## Fase 4 — Portafolio analítico

**Tipo:** mejora de producto, con una dependencia dura metodológica de Fase 1.

1. **Objetivo:** convertir `portfolios` (hoy: nombre, descripción, estado, sin ninguna lógica de
   agregación — confirmado en `lib/portfolios/service.ts`) en una capa analítica real.
2. **Capacidades nuevas:** agregación de SROI entre proyectos, comparación cross-project, rollup de
   riesgo metodológico de portafolio (a partir de `sroi_run_reviews.readinessScore`), análisis de
   concentración de outcomes/proxies, dashboard ejecutivo.
3. **Módulos afectados:** `lib/portfolios/service.ts` (extender), nuevo
   `lib/portfolios/analytics.ts`, `app/app/portfolios/[portfolioId]/page.tsx` (o dashboard
   dedicado), reutilización de primitivas de `sroi-results.ts`.
4. **Tablas nuevas:** ninguna estrictamente necesaria si la agregación se calcula al leer desde
   `sroi_calculation_runs`/`sroi_run_reviews` (recomendado — evita duplicar la fuente de verdad);
   solo si el costo de cómputo lo justifica a escala, considerar una tabla de snapshot cacheado.
5. **Riesgos técnicos:** performance de queries cross-project (relevante la migración 0013 de
   índices de Fase 0); portafolios con proyectos en distintas monedas — bloqueado hasta que la
   normalización USD de Fase 1 exista.
6. **Riesgos metodológicos:** el error clásico es promediar ratios SROI entre proyectos de tamaños
   distintos. La agregación correcta es `Σ valor_neto / Σ inversión`, **nunca**
   `promedio(ratio₁, ratio₂, ...)` — debe quedar como regla de implementación explícita, no a
   discreción de quien lo codee.
7. **Dependencias:** dependencia dura de Fase 1 (USD); dependencia blanda de Fase 0 (índices de
   performance).
8. **Pruebas necesarias:** test que verifique que la agregación usa suma ponderada y no promedio
   simple; tests de aislamiento cross-org en el dashboard.
9. **Criterios de aceptación:** el ratio de portafolio se calcula como suma/suma, no como promedio
   de ratios; portafolios con monedas mixtas se manejan vía normalización USD o muestran advertencia
   explícita, nunca un número silenciosamente incorrecto.
10. **Orden:** después de Fase 1 (dependencia dura de moneda); puede solaparse con Fase 3.

---

## Fase 5 — Stella como capa metodológica activa

**Tipo:** evolución estratégica, sobre una base de deuda técnica a resolver primero.

1. **Objetivo:** pasar de "Stella construida pero apagada" (flags en `false`, quota default 0) a un
   despliegue gobernado, y ampliar de 3 a 6 roles.
2. **Capacidades nuevas:** activación gobernada de Advisor/Validator/Composer (rollout de negocio,
   no de código); nuevos roles Proxy Reviewer, Evidence Reviewer, Audit Assistant.
3. **Módulos afectados:** `lib/stella/config.ts` (los flags ya soportan activación granular — no
   requiere cambio estructural), nuevos archivos en `lib/stella/prompts/`, `lib/stella/schemas/`
   (siguiendo el patrón exacto de `validator-output.ts`, que hardcodea
   `requires_human_review: z.literal(true)`), nuevas Server Actions en `app/actions/stella/`,
   nuevos paneles en `components/stella/`.
4. **Tablas/cambios de schema:** ampliar el `check` constraint `stella_interactions_stella_role_check`
   (hoy limitado a `advisor|validator|composer`) para incluir los nuevos roles. No se requieren
   tablas nuevas — el patrón de `stellaInteractions` ya es genérico por rol.
5. **Riesgos técnicos:** dos deudas ya auto-declaradas en el código deben resolverse antes de
   escalar el uso — el rate-limit en memoria (no distribuido, aceptado como *"accepted tradeoff"*
   pero solo válido a la escala actual) y el adaptador Gemini singleton (*"production should create
   per-org instance"*, `gemini-client.ts:112`).
6. **Riesgos metodológicos:** cada rol existente preserva el invariante de que la IA nunca decide,
   solo recomienda — el Validator fuerza `requires_human_review: true` por schema, el Advisor nunca
   se auto-invoca. Los nuevos roles deben heredar exactamente esa restricción: un "Proxy Reviewer" o
   "Evidence Reviewer" de IA no puede cambiar `reviewStatus`/`status` directamente en
   `financial_proxies`/`evidence_items` — solo puede sugerir, y la escritura sigue pasando por los
   endpoints humanos ya existentes (`updateEvidenceReviewStatus`, etc.), que ya exigen rol
   `impact_manager`+.
7. **Dependencias:** Fase 0 (bug de `contextHash`) debe resolverse antes de ampliar la dependencia
   de auditoría en Stella; Proxy/Evidence Reviewer se benefician del score de confianza de Fase 2
   pero no lo requieren estrictamente.
8. **Pruebas necesarias:** extender la suite ya existente
   `lib/stella/__tests__/anti-regression.test.ts` para cubrir los nuevos roles; validación de
   schema por rol nuevo.
9. **Criterios de aceptación:** ningún rol nuevo escribe directamente sobre
   `evidence_items`/`financial_proxies` — solo produce una recomendación que un humano con el rol
   adecuado ejecuta a través de los flujos ya existentes.
10. **Orden:** Proxy/Evidence Reviewer pueden salir apenas exista el score de confianza (Fase 2);
    Audit Assistant depende de las mejoras de reporte de Fase 6.

---

## Fase 6 — Reporting audit-ready

**Tipo:** mejora de producto (6a), con un componente de evolución estratégica (6b).

1. **Objetivo:** reemplazar el export "print del navegador" por generación real de PDF, y ampliar a
   variantes de reporte (financiador / metodológico / auditoría).
2. **Capacidades nuevas:** generador de PDF server-side, Impact Deck ejecutivo, anexos técnicos
   (line items crudos, rastro de auditoría FX una vez exista Fase 1, manifiesto de hashes de
   evidencia), bundle descargable de trazabilidad completa.
3. **Módulos afectados:** `app/app/projects/[projectId]/report/[reportId]/print/page.tsx`
   (reemplazar/extender), nuevo `lib/reports/pdf-generator.ts`, `package.json` (primera dependencia
   nueva que toca la ruta de reporte — no instalar en esta sesión, solo evaluar candidatos
   compatibles con Server Components de Next.js 16), `report-sections.ts` (sets de secciones
   dependientes de la variante de reporte).
4. **Tablas/cambios de schema:** `sroi_reports` gana un campo de variante (`report_variant`:
   funder/methodological/audit) siguiendo el patrón de enum ya usado en `status`; sin cambios
   destructivos.
5. **Riesgos técnicos:** es la primera vez que se introduce una dependencia de terceros en la ruta
   crítica de reporte — debe validarse compatibilidad con App Router server-side antes de adoptar
   cualquier librería.
6. **Riesgos metodológicos:** el PDF "audit-ready" no puede sonar más certero que la propia UI —
   los mismos disclaimers ya presentes hoy (*"esto no constituye certificación ni auditoría
   independiente"*, `calculation/page.tsx:227`) deben viajar textualmente al documento exportado.
   Un reporte con `status: 'locked'` debe renderizar exactamente lo que hay en DB, sin recomputar
   nada en el momento de exportar.
7. **Dependencias:** el valor completo del Impact Deck depende de Fase 1 (rastro FX), Fase 2
   (scores de confianza) y Fase 3 (códigos de taxonomía) — pero una exportación PDF real de lo que
   ya existe hoy puede salir de forma independiente (6a) sin esperar nada de eso.
8. **Pruebas necesarias:** tests basados en contenido (no diff de píxeles) que confirmen que un
   reporte bloqueado exporta siempre lo mismo; verificación de que las secciones ausentes (por
   falta de datos de fases posteriores) se omiten limpiamente, nunca se inventan.
9. **Criterios de aceptación:** el PDF se genera server-side, conserva los disclaimers, coincide
   exactamente con el contenido del reporte bloqueado, y degrada con gracia cuando faltan datos de
   fases 1–3.
10. **Orden:** 6a (PDF real de lo existente) puede iniciar apenas termine Fase 0; 6b (Impact Deck
    enriquecido) espera a 1, 2 y 3.

---

## Matriz final

| Capacidad | Estado actual | Fase | Prioridad | Complejidad | Riesgo | Impacto estratégico |
|---|---|---|---|---|---|---|
| Bug `contextHash` vacío | Deuda técnica confirmada | 0 | Alta | Baja | Bajo | Bajo (bloqueante) |
| Adaptador Gemini singleton | Deuda técnica auto-declarada | 0 | Alta | Media | Medio | Bajo |
| Drift migración 0013 | Deuda técnica | 0 | Alta | Baja | Medio | Bajo |
| Worktree obsoleto | Higiene de repo | 0 | Media | Baja | Bajo | Nulo |
| Tipos `varchar` en indicadores | Deuda técnica | 0 | Media | Media | Bajo | Medio (habilita Fase 2) |
| Normalización FX→USD (multi-funder) | Diseñado, no implementado | 1 | Alta | Alta | Medio | Alto |
| Tasa de descuento / NPV | No existe | 1 | Alta | Media | Medio | Alto |
| Sensibilidad paramétrica | No existe | 1 | Alta | Media | Medio | Alto |
| Escenarios conservador/base/optimista | No existe | 1 | Media | Media | Medio | Medio |
| Registro estructurado de supuestos | No existe | 1 | Media | Baja | Bajo | Medio |
| Teoría de cambio estructurada | Texto libre | 2 | Media | Alta | Medio | Alto |
| Score de confianza de evidencia | Declarado (string), no calculado | 2 | Media | Media | Bajo | Medio |
| Materialidad estructurada | Solo notas de texto | 2 | Baja | Media | Bajo | Medio |
| Matriz de revisión metodológica extendida | Solo cubre el run de cálculo | 2 | Media | Media | Bajo | Medio |
| Catálogo de proxies por tipología | Diseñado (Subproyecto C), no implementado | 2/3 | Baja | Media | Bajo | Medio |
| IRIS+ / ODS / GRI / ESG / TNFD | No existe en modelo de datos | 3 | Baja | Alta | Bajo | Alto (posicionamiento) |
| Agregación SROI de portafolio | No existe | 4 | Media | Media | Alto* | Alto |
| Comparación cross-project | No existe | 4 | Media | Media | Medio | Alto |
| Dashboard ejecutivo de portafolio | No existe | 4 | Media | Media | Bajo | Alto |
| Activación gobernada de Stella (3 roles existentes) | Construido, apagado por flags | 5 | Alta | Baja | Medio | Alto |
| Stella Proxy/Evidence Reviewer | No existe | 5 | Media | Media | Medio | Alto |
| Stella Audit Assistant | No existe | 5 | Baja | Media | Medio | Medio |
| PDF real (reemplazo de print) | No existe (solo print CSS) | 6a | Alta | Media | Bajo | Alto |
| Impact Deck / anexos enriquecidos | No existe | 6b | Baja | Alta | Medio | Alto |

*Riesgo "Alto" en agregación de portafolio = riesgo metodológico de mal cálculo (promedio vs. suma
ponderada), no riesgo técnico de implementación.

## Orden de ejecución global recomendado

Fase 0 → Fase 1 (FX primero, luego NPV/sensibilidad) → Fase 5a (activación gobernada de los 3 roles
ya construidos, la ganancia más barata disponible) en paralelo con Fase 2/3 → Fase 4 (una vez USD
normalizado) → Fase 6a (PDF real, en paralelo, no depende de nada más) → Fase 5b/6b como cierre.

## Open questions to flag in the plan

- El origen de datos TRM/COP para FX auto-fetch sigue sin verificarse (ya señalado en el spec de
  multi-funder); debe resolverse antes de comprometer fecha para Fase 1.
- No hay decisión tomada sobre qué librería de PDF usar en Fase 6 — requiere spike de compatibilidad
  con Server Components de Next.js 16 antes de estimar esfuerzo.
- La activación de Stella en producción (Fase 5a) es una decisión de negocio (rollout por
  organización, cuotas, pricing manual vía "intranet de manejo maestro" — ver
  `2026-07-02-stella-complete-quotas-design.md`), no solo técnica; no depende de código adicional
  para empezar.
