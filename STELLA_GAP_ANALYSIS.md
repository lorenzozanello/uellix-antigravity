# Análisis de brechas de Stella

**Fecha:** 2026-07-24. Compara el estado actual (ver `STELLA_CURRENT_STATE_AUDIT.md` y `STELLA_CAPABILITY_MATRIX.md`) con la visión objetivo: *Stella como capa de inteligencia metodológica, de evidencia, cálculo, reporte y portafolio*.

**Prioridades:** P0 bloquea seguridad/integridad/aislamiento · P1 bloquea el valor central de Stella · P2 aumenta calidad/escalabilidad · P3 capacidad avanzada/institucional.

Principio de gobernanza objetivo: **la IA propone y analiza; el sistema controla y calcula; las personas deciden y aprueban.** Toda brecha se evalúa contra ese principio.

---

## P0 — Seguridad, integridad y aislamiento (resolver antes de encender o ampliar)

### GAP-P0-1 · Defensa de prompt-injection y `markAsData` muerto
- **Objetivo:** el contenido del usuario (narrative, títulos) nunca debe poder actuar como instrucción para el modelo.
- **Actual:** sanitización mínima (control chars + blocklist de 9 patrones + truncado). `markAsData`, que envolvería el texto como `[DATA]:`, está exportado pero **nunca se usa**.
- **Evidencia:** `lib/stella/context/sanitize.ts:4-14,67`; grep sin usos.
- **Riesgo si no se resuelve:** un usuario (o, en Evidence Intelligence, un documento) inyecta instrucciones que desvían a Stella. En un producto de defendibilidad, una salida manipulada contamina la cadena.
- **Cambio necesario:** envolver todo texto de usuario con delimitadores de datos; ampliar/estructurar la sanitización; test de inyección.
- **Dependencias:** ninguna.
- **Complejidad:** baja.
- **Criterio de aceptación:** un contexto con "ignora tus instrucciones y..." se envía marcado como dato y una prueba verifica que la sanitización lo neutraliza; `markAsData` se aplica en todos los builders o se elimina.

### GAP-P0-2 · Sin arnés de evaluación de calidad de IA
- **Objetivo:** ninguna salida de Stella se habilita sin medir su calidad metodológica.
- **Actual:** 383 pruebas, todas con mock; **cero** ejercitan la salida real del modelo.
- **Evidencia:** `lib/stella/__tests__/anti-regression.test.ts:193-195`.
- **Riesgo si no se resuelve:** encender los flags = desplegar salidas no evaluadas en un producto que promete evidencia defendible.
- **Cambio necesario:** suite de evaluación (golden cases + rúbrica) que corre contra el modelo real de forma controlada (fuera del CI normal, con cuota propia), no en producción.
- **Dependencias:** ninguna (pero condiciona encender cualquier rol).
- **Complejidad:** media.
- **Criterio de aceptación:** existe un comando de eval con ≥10 casos por rol y una rúbrica de aprobado/reprobado; su resultado es requisito documentado para activar un flag.

### GAP-P0-3 · Gobernanza de datos enviados a Google (DPA, PII, retención)
- **Objetivo:** saber y controlar qué datos del cliente salen al proveedor de IA.
- **Actual:** narrative, títulos de outcomes/evidencia y ratios se envían a Gemini; sin DPA verificable en el repo, sin clasificación de PII, sin opción de retención cero.
- **Evidencia:** `app/actions/stella/advisor.ts:106`, `gemini-client.ts:52`.
- **Riesgo:** exposición de PII/datos sensibles (menores, salud) a un tercero sin base legal documentada.
- **Cambio necesario:** DPA con Google documentado; inventario de campos enviados; detección/aviso de PII antes de enviar; consentimiento por organización; decisión de región.
- **Dependencias:** ninguna.
- **Complejidad:** media (legal + técnica).
- **Criterio de aceptación:** documento que enumera exactamente qué se envía por rol; PII detectada se bloquea o anonimiza antes de salir; consentimiento registrado por organización.

### GAP-P0-4 · Aislamiento de `stella_interactions` no probado de forma independiente
- **Objetivo:** garantizar que una organización no lee interacciones de otra.
- **Actual:** RLS de SELECT existe (`002`), pero no hay prueba de integración específica que lo verifique contra un cliente `authenticated`.
- **Evidencia:** `db/policies/002_stella_interactions_rls.sql`; ausencia en `tests/integration/rls.test.ts`.
- **Riesgo:** una regresión en la política pasaría inadvertida.
- **Cambio necesario:** caso de integración que confirme aislamiento y negación de UPDATE/DELETE.
- **Dependencias:** el bootstrap local (ya existe tras la estabilización P0 del proyecto).
- **Complejidad:** baja.
- **Criterio de aceptación:** un test de integración verifica que org B no ve filas de org A y que UPDATE/DELETE fallan.

### GAP-P0-5 · La interacción no guarda el payload/prompt enviado
- **Objetivo:** poder reconstruir exactamente qué vio el modelo (integridad de auditoría).
- **Actual:** `stella_interactions` guarda `response_json` + `context_hash`, no el user-message ni la versión del prompt.
- **Evidencia:** `db/migrations/0012_stella_interactions.sql`; `advisor.ts:119-129`.
- **Riesgo:** ante una disputa metodológica, no se puede demostrar qué input produjo una salida.
- **Cambio necesario:** persistir el user-message enviado (o un blob referenciado) y la versión del prompt; decidir retención/PII en coherencia con GAP-P0-3.
- **Dependencias:** GAP-P0-3 (no guardar PII sin base legal).
- **Complejidad:** baja-media (migración aditiva).
- **Criterio de aceptación:** dada una fila de `stella_interactions`, se puede reproducir el input y saber qué prompt/version se usó.

---

## P1 — Valor central de Stella (contextual y gobernada)

### GAP-P1-1 · Prompts genéricos que desaprovechan el contexto
- **Objetivo:** orientación específica por paso, anclada en los datos reales del proyecto.
- **Actual:** `buildAdvisorSystemPrompt(step)` interpola solo el nombre; el user-message usa `narrativeSummary.substring(0,500)` + conteos, aunque el builder ensambla outcomes/indicadores/evidencia/proxies reales.
- **Evidencia:** `advisor-system.ts:7-59`; `build-advisor-context.ts` (contexto rico no usado).
- **Riesgo:** respuestas genéricas indistinguibles de un chatbot; se pierde el diferenciador.
- **Cambio necesario:** prompts por paso/modo/sección; user-messages que usen el contexto completo.
- **Dependencias:** GAP-P0-1 (sanitización), GAP-P0-2 (eval para validar mejora).
- **Complejidad:** media.
- **Criterio de aceptación:** cada paso tiene su prompt; el user-message incluye los datos reales relevantes; la suite de eval muestra mejora medible vs el genérico.

### GAP-P1-2 · Sin procedencia a nivel de campo
- **Objetivo:** distinguir contenido humano / sugerido por IA / reformulado / extraído / calculado, y ligar cada fila a la interacción que la originó.
- **Actual:** ninguna fila del pipeline se vincula a `stella_interactions`; `createdBy` = usuario siempre.
- **Evidencia:** §10 del audit; esquema de las tablas de pipeline (sin campo de procedencia).
- **Riesgo:** bloquea "audit-ready"; imposible auditar el origen de una afirmación.
- **Cambio necesario:** registrar procedencia (para empezar, en `audit_logs`; a futuro, columna/tabla de linaje) cuando el usuario acepta una sugerencia o guarda un borrador de Stella.
- **Dependencias:** GAP-P1-4 (drafting/sugerencias — es lo que crea filas atribuibles a Stella), GAP-P0-5.
- **Complejidad:** media.
- **Criterio de aceptación:** dado un outcome/indicador/sección creado desde Stella, se puede saber que fue sugerido por Stella y qué interacción lo originó.

### GAP-P1-3 · Composer emite cifras como texto libre
- **Objetivo:** las cifras del reporte vienen del motor; Stella nunca teclea un número.
- **Actual:** `draft_content` es texto libre; el prompt le pasa ratio/NSV, así que puede escribir un número (correcto o no) en prosa.
- **Evidencia:** `composer-output.ts:15`; `composer-system.ts:64-66`.
- **Riesgo:** una cifra mal escrita por el modelo entra a un reporte "defendible".
- **Cambio necesario:** secciones ancladas al dato que se prellenan de las filas reales; el prompt de Stella solo redacta prosa conectora; validación de que `draft_content` no introduce números fuera de los provistos.
- **Dependencias:** GAP-P1-1.
- **Complejidad:** media.
- **Criterio de aceptación:** las cifras de una sección provienen del snapshot de la corrida; una prueba verifica que el borrador no contiene números ausentes del contexto.

### GAP-P1-4 · Sin drafting del pipeline (reformular + sugerir)
- **Objetivo:** Stella reformula notas y sugiere candidatos (outcomes/indicadores/nodos/supuestos) que el usuario acepta ítem a ítem, con procedencia.
- **Actual:** el Advisor solo asesora; no hay modo reformulate ni suggest, ni esquema, ni flujo de aceptación, ni persistencia.
- **Evidencia:** solo existen advisor/composer/validator/reviewer; sin esquema de sugerencia.
- **Riesgo:** la mitad de la propuesta de valor ("ayudar a generar cada paso") no existe.
- **Cambio necesario:** modos `reformulate`/`suggest` por paso con el gradiente factual del spec `2026-07-24-stella-generation-copilot-design.md`; UX de aceptar/editar/descartar; persistencia vía las server actions existentes con marca de procedencia.
- **Dependencias:** GAP-P0-1, GAP-P1-1, GAP-P1-2.
- **Complejidad:** alta.
- **Criterio de aceptación:** en pasos 1-4, el usuario ve sugerencias, acepta una y se crea la fila con procedencia; nada se guarda sin acción explícita.

---

## P2 — Calidad y escalabilidad (diferenciadores)

### GAP-P2-1 · Evidence Intelligence (inexistente)
- **Objetivo:** interpretar documentos: extraer metadatos, fragmentos citables, relacionar con outcomes, detectar contradicciones, construir mapa de evidencia.
- **Actual:** solo metadatos (título, estado, hash8); sin extracción, embeddings ni recuperación.
- **Evidencia:** `build-advisor-context.ts:156-172`; grep sin `pdf/ocr/embedding/pgvector`.
- **Riesgo:** la promesa "evidencia defendible" descansa hoy en almacenamiento + hash, no en comprensión.
- **Cambio necesario:** pipeline de procesamiento documental (extracción → chunking → embeddings → recuperación), con estricta separación de contenido como dato (no instrucción).
- **Dependencias:** GAP-P0-1 (injection vía documento), GAP-P0-3 (PII en documentos).
- **Complejidad:** alta.
- **Criterio de aceptación:** de un PDF subido se extraen fragmentos citables ligados a un outcome, con la fuente y sin ejecutar instrucciones incrustadas.

### GAP-P2-2 · Proxy Intelligence con grounding y citación (inexistente)
- **Objetivo:** buscar en fuentes oficiales proxies candidatos, con URL/fecha/fragmento, que entran como `suggested` y requieren aprobación humana.
- **Actual:** sin grounding; la llamada a Gemini no pasa `tools`.
- **Evidencia:** `gemini-client.ts:52-60`.
- **Riesgo:** si se implementa mal (sin grounding), el modelo **inventa** valores/fuentes — exactamente lo que el producto promete evitar.
- **Cambio necesario:** habilitar grounding de búsqueda en el adaptador; exigir URL real por valor; entrada como `suggested`; flujo de aprobación existente; verificación de que el valor aparece en la fuente.
- **Dependencias:** GAP-P0-2 (eval), GAP-P2-1 (extracción para verificar la cita).
- **Complejidad:** alta.
- **Criterio de aceptación:** un proxy sugerido trae URL verificable, entra como `suggested`, no es usable en un cálculo hasta aprobarse, y una prueba confirma que sin cita se rechaza.

### GAP-P2-3 · Calculation Interpreter enriquecido
- **Objetivo:** explicar sensibilidad, variables de mayor impacto y escenarios.
- **Actual:** el Validator explica riesgos; la sensibilidad determinista existe en código (`lib/pipeline/sroi-sensitivity.ts`) pero Stella no la interpreta.
- **Evidencia:** `build-validator-context.ts` (snapshot sin sensibilidad).
- **Riesgo:** menor; es mejora de calidad.
- **Cambio necesario:** pasar el resultado de sensibilidad al contexto del validator y un modo de explicación de escenarios.
- **Dependencias:** GAP-P1-1.
- **Complejidad:** media.
- **Criterio de aceptación:** el validator explica qué supuesto mueve más el ratio, leyendo la sensibilidad ya calculada, sin recalcular.

### GAP-P2-4 · Versionado de secciones de reporte y de prompts
- **Objetivo:** poder regenerar una sección y conservar versiones; saber qué prompt produjo qué.
- **Actual:** secciones de reporte no versionadas; prompts sin versión registrada.
- **Evidencia:** `sroi_report_sections` (sin versión); `0012` (sin prompt_version).
- **Complejidad:** media. **Prioridad:** P2.
- **Criterio de aceptación:** una sección conserva histórico de borradores con su origen; `stella_interactions` registra la versión de prompt.

### GAP-P2-5 · Deuda técnica de contexto (N+1, orquestación)
- **Objetivo:** builders eficientes y una orquestación común.
- **Actual:** N+1 en fuentes de proxy; cuatro acciones casi idénticas.
- **Evidencia:** `build-advisor-context.ts:199-207`.
- **Complejidad:** baja-media. **Prioridad:** P2.
- **Criterio de aceptación:** las fuentes se resuelven en una query; existe un orquestador común de llamada.

---

## P3 — Avanzado / institucional

### GAP-P3-1 · Audit Room
- **Objetivo:** superficie que reconstruye decisiones, aprobaciones, versiones, fuentes y distingue contenido humano/generado/recuperado/calculado.
- **Actual:** existen las bases (`stella_interactions`, `audit_logs`, corridas inmutables) pero sin UI ni ensamblado.
- **Dependencias:** GAP-P1-2 (procedencia), GAP-P0-5, GAP-P2-4.
- **Complejidad:** alta. **Prioridad:** P3.
- **Criterio de aceptación:** dado un reporte, un revisor ve el linaje completo de cada afirmación.

### GAP-P3-2 · Portfolio Intelligence
- **Objetivo:** análisis multi-proyecto (outcomes recurrentes, calidad de evidencia, riesgos, proxies, resultados por territorio, aprendizaje institucional).
- **Actual:** analítica determinista de portafolio existe (`lib/portfolios/analytics.ts`), pero no hay razonamiento IA multi-proyecto; los context builders son single-project. El aislamiento multiempresa existe (org-scoping + RLS), así que el modelo de datos lo permite.
- **Dependencias:** GAP-P1-1, GAP-P2-1.
- **Complejidad:** alta. **Prioridad:** P3.
- **Criterio de aceptación:** Stella resume outcomes recurrentes y riesgos a través de proyectos de UNA organización, sin cruzar organizaciones.

---

## Resumen de brechas

| Prioridad | Brechas | Naturaleza |
|---|---|---|
| **P0** | 5 (injection, eval, DPA/PII, aislamiento, payload) | Deben cerrarse antes de encender o ampliar |
| **P1** | 4 (prompts+contexto, procedencia, cifras ancladas, drafting) | Valor central; Stella contextual y gobernada |
| **P2** | 5 (evidence, proxy grounding, calc interpreter, versionado, deuda) | Diferenciadores y escala |
| **P3** | 2 (Audit Room, Portfolio) | Institucional |
