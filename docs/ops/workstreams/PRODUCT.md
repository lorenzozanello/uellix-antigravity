# Línea de trabajo: PRODUCT

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-product`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-product`
- **HEAD base:** `INTEGRATION_ROOT_HEAD` (commit de gobernanza sobre
  `c7c9736` en `codex/stella-integration` — ver §1 y §4 del documento de
  gobernanza; el hash exacto queda registrado en el informe de entrega de
  esta unidad de bootstrap)
- **Propietario:** sin asignar

## Rutas autorizadas

- Composer y experiencia Stella (`lib/stella/advisor/**` en lo que sea
  presentación/orquestación de UI, no esquema).
- `components/**` salvo los componentes marcados `INTEGRATION-OWNED`
  (`components/marketing/Navbar.tsx`, `components/layout/MobileNav.tsx`).
- Formularios; estados de carga, error, vacío y abstención.
- UI de decisiones sobre sugerencias, evidencias, proxies.
- UI de reportes e historial (`app/**` bajo las rutas de reporte, no el
  esquema que las alimenta).
- Presentación de cuotas visibles (lectura de la cuota, no su definición
  en base de datos — eso es CAPABILITIES).

## Rutas prohibidas

- `db/**`, `supabase/**`, `db/prepared/**` y cualquier migración, SQL
  preparado, policy, rol o función SQL — propiedad exclusiva de CAPABILITIES.
- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7,
  incluyendo `app/layout.tsx` (shell de navegación raíz).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING) — PRODUCT consume sus contratos TypeScript, no
  reimplementa esa lógica.
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Depende de los contratos TypeScript publicados por GROUNDING para
  retrieval/citas/abstención en la UI.
- Depende de los contratos TypeScript publicados por CAPABILITIES para
  cuotas visibles y estado de decisiones.

## Contratos requeridos

- **PRODUCT-001** (solicitado a GROUNDING, 2026-08-04): provenance de citas a
  nivel documento/chunk (`documentId`/`excerpt`/`location`/`relevance`) y una
  señal explícita de contradicción entre dos evidencias. Ver
  [`docs/ops/contracts/PRODUCT-001_grounded-citation-provenance.md`](../contracts/PRODUCT-001_grounded-citation-provenance.md).
  Resuelto por integración en el tren 1 como
  `PARTIALLY_SATISFIED_PENDING_ADAPTER`; el adaptador que faltaba está
  implementado en el tren 2 de esta línea —
  **`PRODUCT-001_IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE`**, ver
  [§Tren 2](#tren-2--stella_product_grounding_adapter_train_2-2026-08-04).
  Esta línea no marca el contrato `aceptado`: la aceptación es de integración.

## Unidad actual

**STELLA_PRODUCT_CANONICAL_PROJECT_SURFACE_TRAIN_4** — ver
[§Tren 4](#tren-4--stella_product_canonical_project_surface_train_4-2026-08-05)
al final de este documento. Lo que sigue en esta sección es el registro
histórico de la unidad del tren 1, ya integrada.

## Unidad del tren 1 (histórico)

**STELLA_PRODUCT_GROUNDED_EXPERIENCE_TRAIN_1** — modelo de presentación
tipado para respuestas fundamentadas de Stella (grounded / partially
grounded / insufficient evidence / contradictory evidence / unavailable /
permission denied / quota reached / provider failure / user approval
required), construido enteramente sobre señales reales ya existentes
(`AdvisorContextualOutput.findings[].sourceFields`,
`.suggestions[].sourceFields`/`missingInformation`/`proposedText`,
`StellaPanelErrorCode`, `SuggestionDecisionAction`). Sin datos simulados como
estado normal del producto, sin cálculo SROI en cliente, sin tocar
`db/**`/SQL. Unidad completada — lista para integración.

## Últimos commits

- `21468ca` — `feat(stella): model grounded response states`
- (siguiente commit de esta unidad) — `feat(stella): render evidence and
  human decision workflow`

## Pruebas ejecutadas

- `node_modules/.bin/vitest run components/stella/__tests__/grounding-model.test.ts`
  — 30/30 verde.
- `node_modules/.bin/vitest run components/stella/__tests__/StellaGroundingBadge.test.tsx
  components/stella/__tests__/StellaEvidencePanel.test.tsx
  components/stella/__tests__/StellaAvailabilityNotice.test.tsx` — 15/15 verde.
- `node_modules/.bin/vitest run components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx`
  — 43/43 verde (39 preexistentes + 4 nuevas de badges de fundamentación).
- `node_modules/.bin/vitest run components/stella` (corrida focalizada
  completa del paquete) — 259/261 verde; 2 fallos preexistentes y no
  relacionados en `StellaAdvisorPanel.test.tsx` y
  `StellaValidatorPanel.test.tsx` (`does not read GEMINI_API_KEY env var` —
  el proceso de test hereda un `GEMINI_API_KEY` real del entorno; ver
  Riesgos). No introducidos por esta unidad.
- `pnpm typecheck` — sin errores, dos veces (después de cada tarea).
- Nota: `pnpm test:unit -- <ruta>` no filtra correctamente en este entorno
  (el `--` de pnpm llega como argumento literal a vitest en Git Bash/Windows
  y termina corriendo la batería completa); se usó
  `node_modules/.bin/vitest.CMD run <ruta>` directamente para las corridas
  focalizadas.

## Riesgos

- `StellaAdvisorPanel.test.tsx` y `StellaValidatorPanel.test.tsx` fallan un
  test cada uno (`does not read GEMINI_API_KEY env var`) por una variable de
  entorno real filtrándose al proceso de test en este worktree — preexistente,
  no relacionado a esta unidad, no corregido aquí (no toca ningún archivo de
  esta entrega). Integración debería confirmarlo en un entorno limpio.
- `EvidenceSupportLevel: 'contradictory_evidence'` queda sin productor real
  hasta que se resuelva PRODUCT-001 — es un estado alcanzable solo vía
  fixtures de prueba, nunca en runtime hoy.

## Estado de entrega a integración

Listo. Árbol limpio, dos commits (`feat(stella): model grounded response
states`, `feat(stella): render evidence and human decision workflow`), sin
push, sin tocar `db/**`/SQL/INTEGRATION-OWNED.

---

## Integración — tren 1 (2026-08-04)

**Fusionada.** HEAD integrado `9e57301`, commits `21468ca` y `9e57301`, merge
commit `fa3a13c` (`--no-ff`).

**Conflicto:** `docs/ops/contracts/CONTRACT_LEDGER.md` (add/add), el mismo
índice que CAPABILITIES y GROUNDING habían creado en paralelo. Resuelto
preservando `CT-CAP-001..004`, `GR-001`, `GR-002` y añadiendo `PRODUCT-001`.
Ningún otro archivo entró en conflicto.

### Pruebas focalizadas en el HEAD integrado

`vitest run components/stella` → 13 archivos, **261 passed, 0 failed**.

Los 2 fallos que esta línea reportó (`StellaAdvisorPanel.test.tsx` y
`StellaValidatorPanel.test.tsx`, «does not read GEMINI_API_KEY env var`) **eran
contaminación ambiental, confirmada por experimento controlado**: la misma
suite, en el mismo HEAD, entrega 259/261 con `GEMINI_API_KEY` en el entorno y
261/261 sin ella. Integración eliminó la variable únicamente del entorno del
proceso de prueba (`env -u`); no se modificó ningún archivo `.env`. La
sospecha de esta línea era correcta.

Confirmado en el árbol integrado:

- Componentes nuevos presentes: `StellaGroundingBadge`, `StellaEvidencePanel`,
  `StellaAvailabilityNotice`, más los badges en `StellaContextualAdvisorPanel`.
- Estados tipados presentes: `EvidenceSupportLevel` (5),
  `StellaAvailabilityState` (4), `StellaDecisionStatus` (5).
- Abstención visible: `insufficient_evidence` se produce desde señales reales
  (`sourceFields` vacío / sentinela de colección vacía), no desde un fixture.
- Citas no inventadas: `buildEvidenceReferences` sólo mapea rutas canónicas ya
  presentes en la salida del advisor.
- Flujo de decisión humana intacto: `StellaDecisionStatus` refleja
  `SuggestionDecisionAction` 1:1 menos `'copied'`.
- Cero cambios de base de datos y cero SQL.

### Contratos

**PRODUCT-001 → `PARTIALLY_SATISFIED_PENDING_ADAPTER`.**

GROUNDING publicó el mismo día, sin ver esta solicitud, contratos que cubren la
necesidad con una forma **distinta y más estricta**. Integración no eligió
arbitrariamente entre ambas: registró
[`INTEGRATION-001`](../contracts/INTEGRATION-001_grounding_product_citation_adapter.md),
que establece que `lib/grounding/contracts/**` es la fuente técnica canónica de
provenance y que la presentación **no persiste una segunda forma** de la misma.

Razón concreta, no estilística: `CitationReference` no lleva el texto de la
cita, lleva `quotedTextHash`. Un `excerpt` persistido junto a la cita es un
segundo registro del mismo hecho que puede divergir del hash; en cuanto diverge,
el sistema tiene dos respuestas a «¿qué dice el documento?» y la que se ve en
pantalla es la que no está verificada.

`EvidenceSupportLevel: 'contradictory_evidence'` sigue sin productor real, y eso
deja de ser una limitación temporal: por decisión de integración, sólo un
`ContradictionMarker` puede producirlo — nunca una inferencia hecha en un
componente de UI.

### Riesgos tras la integración

- El riesgo de `GEMINI_API_KEY` queda **cerrado como riesgo de esta línea**: era
  ambiental y está caracterizado. Sigue siendo una nota operativa para quien
  ejecute la batería en una shell con la variable presente.
- `'contradictory_evidence'` sin productor: abierto, ahora con una regla
  explícita que lo gobierna.

### Trabajo de entrada del tren 2

**Implementar el adaptador puro** de INTEGRATION-001, previsto en
`components/stella/grounding-adapter.ts`, bajo sus siete reglas: `excerpt`
derivado de `GroundingChunk.text`, `location` renderizado desde `ChunkLocation`
sin volver a entrar como ubicación, buckets de `relevance` con umbrales
nombrados y probados en el borde que **no** sustituyen al score, y
`contradiction` exclusivamente desde `ContradictionMarker`.

No se implementó aquí: PRODUCT compila y pasa sin él, así que la excepción
«sólo si es estrictamente necesario para compilar» no aplica. Verificado que
`components/**` no importa nada de `lib/grounding/**` en el HEAD integrado.

### Hallazgos de la revisión adversarial de integración

- **A-F3 — la regla de contradicción no está impuesta por nada.**
  INTEGRATION-001 §7 dice que sólo un `ContradictionMarker` puede producir
  `contradictory_evidence`. Hoy eso se cumple **por ausencia de código**:
  `StellaGroundingBadge` recibe `level` como prop libre sin validación, el badge
  y el tipo se re-exportan desde `components/stella/index.ts`, y `components/**`
  no importa nada de `lib/grounding/**`. Un mapper de tren 2 que dedujera la
  contradicción de dos `sourceFields` opuestos compilaría, renderizaría el badge
  rojo y pasaría CI. **El adaptador del tren 2 debe llevar una prueba focalizada
  que falle si ese valor se alcanza sin un `ContradictionMarker` de entrada.**
- **B-m4 (MINOR)** — ciclo entre `grounding-model.ts:22` y
  `StellaContextualAdvisorPanel.tsx:40`. Es **sólo de tipos**: el lado de tipos
  usa `import type` explícito y `tsconfig.json` fija `isolatedModules: true`, así
  que se borra en transform y no hay ciclo en runtime. Se convierte en uno real
  el día que alguien quite la palabra `type`.
- **Nota de cobertura, no defecto:** `StellaEvidencePanel`,
  `StellaAvailabilityNotice`, `buildEvidenceReferences` y `classifyAvailability`
  tienen **cero call sites fuera de `components/stella/`**. Están exportados,
  probados y montados en ninguna parte. Es coherente con el estado declarado
  (el adaptador no existe), pero significa que sus pruebas seguirían verdes
  aunque el pipeline nunca produjera un `EvidenceReference` — que es exactamente
  la situación de hoy.

---

## Tren 2 — STELLA_PRODUCT_GROUNDING_ADAPTER_TRAIN_2 (2026-08-04)

**HEAD base:** `597819b` (`TRAIN_2_ROOT_HEAD`, «chore(integration): prepare
shared Stella train 2 root»). Sin push.

Unidad: implementar el **adaptador puro** de
[INTEGRATION-001](../contracts/INTEGRATION-001_grounding_product_citation_adapter.md)
y conectar los contratos canónicos de GROUNDING con la presentación de Stella.

### Commits

- `42b68dc` — `feat(stella): adapt grounding provenance for presentation`
- (este commit) — `feat(stella): connect grounded citations to Stella experience`

### Adaptador

`components/stella/grounding-adapter.ts`. Entradas: `GroundingChunk`,
`ChunkLocation`, `CitationReference`, `RetrievalCandidate`,
`ContradictionMarker`. Salida: el modelo de presentación de PRODUCT
(`GroundedCitationView` / `GroundedClaimView` / `GroundedContradictionView` /
`GroundedAbstentionView` / `GroundedAnswerView`).

Puro: sin I/O, sin base de datos, sin proveedor, sin reloj, sin aleatoriedad.

**Todas las importaciones desde `@/lib/grounding/contracts` son `import type`,
y eso no es estilo.** `lib/grounding/contracts/core.ts` importa `node:crypto`
en scope de módulo; un solo import de runtime metería Node crypto en el bundle
de cliente de toda página que monte un panel de Stella. `isolatedModules: true`
borra los `import type` en transform, así que lo que se envía es un módulo sin
dependencia alguna de grounding. Una prueba escanea **todo**
`components/stella/**` y falla si alguien convierte uno en import de valor.

Costo asumido y anotado en el código: los helpers de runtime publicados
(`citationsOf`, `scopeContains`) no pueden llamarse. `citationsOf` se re-deriva
localmente — seis líneas sobre el discriminante, que el tipo unión rompe en
compilación si GROUNDING cambia qué campo lleva las citas. `scopeContains`
**no** se re-implementa: ver §Riesgos.

### Provenance canónica

`lib/grounding/contracts/**` sigue siendo la única fuente técnica. La
presentación **no persiste una segunda forma**: la vista es derivada y efímera,
no se escribe, no se serializa como registro de origen, y **no existe función
inversa** — no hay forma de reconstruir un `CitationReference` a partir de una
vista. `EvidenceReference` (`sourceField` + `label`, derivada de
`AdvisorContextualOutput.sourceFields`) sigue existiendo sin cambios como la
otra noción de presentación que INTEGRATION-001 §1 enumera; el adaptador no la
sustituye ni la mezcla: son dos modos disjuntos del mismo panel.

### Reglas §4–§7, y qué las sostiene

| Regla | Implementación | Prueba que falla si se rompe |
|---|---|---|
| `excerpt` desde `GroundingChunk.text` | `buildExcerpt`, truncado a `CITATION_EXCERPT_MAX_LENGTH` (280) | «derives the excerpt from GroundingChunk.text», «truncates … WITHOUT changing the hash» |
| Truncado no altera el hash | `quotedTextHash` se copia de la cita, nunca se recalcula | idem |
| Cita sin chunk no inventa texto | `availability: 'source_unavailable'`, `excerpt: null` | «represents a citation whose chunk was not loaded …» |
| `location` estructurada | `CitationLocationView` conserva `span` y `coordinateSpace`; `label` es sólo display | «keeps the structured location (rule 5) …» |
| `score` conservado | `RelevanceAssessment` lleva `score`, `strategy`, `rank`, `thresholdsVersion` | «keeps the numeric score, the strategy, the rank …» |
| Umbrales nombrados y versionados | `RELEVANCE_HIGH_MIN_SCORE` 0.6, `RELEVANCE_MEDIUM_MIN_SCORE` 0.3, `RELEVANCE_THRESHOLDS_VERSION` | 3 pruebas de frontera (valor exacto → bucket superior; un `Number.EPSILON` por debajo → inferior) |
| Contradicción sólo desde marcador | `contradictedChunkIds` se construye **únicamente** desde `state.contradictions` | «never infers a contradiction from opposing statements, opposing sources or diverging scores» + «does not turn an abstention CODED contradictory_evidence into a contradictory support level» |

**Sobre A-F3 del tren 1** («la regla de contradicción no está impuesta por
nada»): queda impuesta. El único camino hacia `'contradictory_evidence'` en el
adaptador es que una cita de la afirmación aparezca en un `ContradictionMarker`
de entrada. El cruce más plausible para colarlo —`AbstentionReasonCode` tiene
un miembro que **se escribe igual** pero significa otra cosa («retrieval vio
candidatos en conflicto», no «existe un marcador»)— tiene una prueba dedicada.

### Presentación

- `StellaEvidencePanel` gana un segundo modo (`citations`), disjunto del modo
  `references` existente. Un componente y no dos: responden la misma pregunta
  del lector y separarlos habría bifurcado el estado vacío, el contrato de
  navegación y la accesibilidad. `source_unavailable` es un estado de primera
  clase, con su propio texto, nunca relleno con texto sustituto.
- `StellaGroundedAnswerPanel` (nuevo) renderiza un `GroundedAnswerView`
  completo: nivel de soporte (badge), afirmaciones con su tipo
  (evidencia / inferencia / recomendación / ausencia), paso de razonamiento de
  las inferencias, citas navegables con página/sección/fragmento/score,
  contradicción con ambos lados y la negativa explícita a resolverla,
  abstención con el código y la explicación de GROUNDING, conteo de citas sin
  pasaje, y aprobación humana requerida. **No calcula nada**: renderiza un
  valor ya derivado por el adaptador. Cero aritmética SROI en cliente.
- `StellaContextualAdvisorPanel` gana la costura tipada
  `groundedAnswer` / `onNavigateCitation`. Se renderiza **fuera** del ciclo de
  la petición del advisor a propósito: esa acción no consume retrieval, y
  atarla a `panelState` afirmaría que la evidencia fundamentada vino de ahí.
  Nada la fabrica — sin retrieval real no hay `RetrievalCandidate` en runtime
  (INTEGRATION-001, «Qué NO decide este documento»), y **ningún fixture está
  cableado como runtime**.
- El barrel `components/stella/index.ts` publica el adaptador, sus tipos y sus
  constantes de umbral. También publica `stellaErrorPresentation` /
  `StellaPanelErrorCode`, que cierra la mitad de PRODUCT del hallazgo **B-M3**
  del tren 1 (RELEASE puede ahora mover su import al barrel; el cambio del lado
  de RELEASE es suyo, esta línea no toca `tests/eval/**`).

### Estados soportados

Cita navegable · página / sección · fragmento · nivel de soporte · score ·
contradicción · fuente no disponible · evidencia insuficiente · evidencia
parcial · abstención · aprobación humana. Todos con prueba.

«Evidencia parcial» tiene un productor real y explícito: el estado
`partially_grounded` del propio `GroundingAnswerState`, no una heurística de
UI.

### PRODUCT-001

**`PRODUCT-001_IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE`.**

Lo que el adaptador satisface de la forma pedida originalmente:

| Pedido en PRODUCT-001 | Cómo llega ahora |
|---|---|
| `GroundingCitation.documentId` | `GroundedCitationView.evidenceId` + `versionId` + `chunkId`, sin colapsarlos |
| `GroundingCitation.excerpt` | `CitationExcerpt` derivado de `GroundingChunk.text`, con `truncated` y `fullLength`; `null` cuando el pasaje no está cargado |
| `GroundingCitation.location: string` | `CitationLocationView.label` («p. 4 · Metodología · líneas 12–18»), con la ubicación estructurada intacta al lado |
| `GroundingCitation.relevance` | `RelevanceAssessment.bucket`, **acompañado** de `score` / `strategy` / `rank` / `thresholdsVersion` |
| `GroundingContradiction` | `GroundedContradictionView` desde `ContradictionMarker`, con `resolution` y `severity` |

**Esta línea no marca el contrato `aceptado`.** La aceptación es de
integración, y el ledger compartido (`docs/ops/contracts/CONTRACT_LEDGER.md`)
y los encabezados de `PRODUCT-001` / `INTEGRATION-001` **no fueron tocados**
por esta unidad: son propiedad del protocolo de contratos (§8), no de la línea
que implementa el entregable.

### Pruebas ejecutadas

- `vitest run components/stella/__tests__/grounding-adapter.test.ts` — **32/32**
  (adaptación completa, excerpt derivado, truncado sin tocar el hash, ubicación
  estructurada, formato de ubicación en 4 variantes, score conservado,
  relevance derivada, 3 pruebas de umbral fronterizo, score no finito, chunk
  ausente, cita inválida por hash, lookup mal indexado, cross-project rechazada
  por upstream, evidencia parcial, abstención, ausencia como afirmación,
  recomendación sin soporte, inferencia con su paso de razonamiento,
  contradicción con y sin marcador, y las 4 pruebas de pureza).
- `vitest run components/stella/__tests__/StellaGroundedAnswerPanel.test.tsx
  components/stella/__tests__/StellaEvidencePanel.test.tsx` — **31/31**
  (navegación, accesibilidad, estados de disponibilidad, contradicción).
- `vitest run components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx`
  — **48/48** (43 preexistentes + 5 de la costura del tren 2, incluida una que
  ejecuta accept → undo → reject con el panel fundamentado montado).
- `vitest run components/stella` (paquete focalizado completo) — **324/324**,
  15 archivos, 0 fallos. Ejecutado con `env -u GEMINI_API_KEY` siguiendo la
  práctica establecida por el tren 1; ningún archivo `.env` tocado.
- `tsc --noEmit` — limpio.
- `eslint components/stella` — 0 errores, 0 warnings.
- No se ejecutó `test:unit` completo ni `build` (§11: gates pesados los
  coordina integración).

### Riesgos

- **Sin productor de runtime.** El adaptador es verificable por pruebas y no
  observable en producto: no hay implementación de retrieval, así que no hay
  `RetrievalCandidate` real. Es exactamente lo que INTEGRATION-001 anticipó,
  pero significa que la nota de cobertura del tren 1 sigue vigente y ahora
  cubre más superficie: `StellaGroundedAnswerPanel` y el modo `citations` de
  `StellaEvidencePanel` no tienen call sites fuera de `components/stella/**`.
- **Umbrales sin calibrar.** 0.6 / 0.3 heredan la incertidumbre de
  `DEFAULT_RETRIEVAL_MIN_SCORE` (0.15), que GROUNDING declara marcador de
  posición (riesgo R4). Por eso están versionados: cuando exista retrieval
  real y se recalibren, se sube `RELEVANCE_THRESHOLDS_VERSION`.
- **El adaptador no es una compuerta de scope, y es deliberado.** El
  aislamiento organización/proyecto se decide upstream (scoping de retrieval y
  `validateAnswerCitations`). Re-implementarlo en un módulo de UI crearía una
  segunda respuesta, divergente, a «¿puede leerse esto?» — el mismo fallo que
  §2 prohíbe para provenance. Lo que esta línea garantiza es más estrecho y
  está probado: un chunk que no se le entregó **nunca** adquiere excerpt,
  etiqueta de fuente ni score. **Esto no cierra A-F1**
  (`validateAnswerCitations` compara sólo `organizationId`, así que una cita de
  otro proyecto de la misma organización se valida como correcta): sigue
  asignado a GROUNDING tren 2, y hasta que se cierre, una cita cross-project
  *entregada* por upstream se renderizaría con su pasaje.
- **B-m4 (ciclo sólo de tipos)** entre `grounding-model.ts` y
  `StellaContextualAdvisorPanel.tsx` sigue abierto y sin empeorar: el adaptador
  importa `grounding-model` como valor (`decisionStatusFromAction`) pero
  `grounding-model` no importa el adaptador, así que no se añadió ningún ciclo
  nuevo.

### Estado de entrega

**STELLA_PRODUCT_TRAIN_2_READY_FOR_INTEGRATION.** Árbol limpio, dos commits,
sin push. Cero cambios en `db/**`, `supabase/**`, SQL o archivos
`INTEGRATION-OWNED`; cero cambios en `lib/grounding/**`; cero cambios en el
ledger de contratos.

---

## Estado en el HEAD integrado del tren 2 (integración, 2026-08-04)

Sección añadida por **integración**, no por esta línea. No reescribe nada de lo
anterior: registra qué de lo que esta línea declaró queda confirmado sobre el
árbol fusionado, y qué cambió al cruzarlo con las otras tres.

**Contratos:** PRODUCT-001 → **`aceptado`** (vía adaptador),
INTEGRATION-001 → **`aceptado`**.

**Hallazgos:** A-F3 → **CLOSED**, B-M3 → **CLOSED** (los exports existen),
B-m4 → **CLOSED** (el ciclo es sólo de tipos y se borra en transform).

**Lo que integración cambió en esta línea, y por qué.**

Esta línea publicó su propio juego de umbrales de relevancia —
`product-relevance-v1`, `high >= 0.6`, `medium >= 0.3` — el mismo día en que
GROUNDING publicó `grounding-relevance-2026-08-local-1`, `0.4` / `0.2`. Ninguna
de las dos podía ver a la otra.

No era una diferencia cosmética. Un score de **0.42** —el caso principal de la
prueba de esta misma línea— era `medium` aquí y `high` allí. El sistema tenía dos
respuestas a «cuán relevante es este pasaje», y la que un auditor leería en
pantalla no era la que quedaría registrada junto al score: el mismo fallo de
credibilidad que INTEGRATION-001 §2 prohíbe para la provenance.

Retirado: `RELEVANCE_HIGH_MIN_SCORE`, `RELEVANCE_MEDIUM_MIN_SCORE` y la versión
propia, del módulo **y** del barrel. `relevanceBucket` pasa a ser una delegación
sin números propios; lo único que añade es el **tipo de error**, porque un panel
necesita distinguir un fallo de datos de un fallo de render — traducir el fallo
no es reclasificar la evidencia. `CitationRelevanceBucket` pasa a ser un **alias**
de `RelevanceBucket`, no una unión paralela que compilaría el día que GROUNDING
añadiera un cuarto bucket.

**La UI no perdió nada que le corresponda.** Lenguaje, icono e intensidad visual
siguen siendo decisión de esta línea. Lo que ya no es decisión suya es **a qué
bucket cae un score**, que es una clasificación semántica de la evidencia.

**Efecto colateral aceptado:** el borde se endurece. GROUNDING **lanza** ante un
score fuera de `[0, 1]`; esta línea sólo rechazaba `NaN` y devolvía `high` para
`1.5`. Heredar el rechazo es deseable: un score fuera de escala significa que el
scorer cambió y los umbrales no.

**Cuatro pruebas anti-regresión**, dos de ellas estructurales a propósito —cero
literales numéricos junto a `high|medium|low` en **todo** `components/stella/**`,
y `adaptRelevance` sin comparación propia—, porque una prueba de comportamiento
seguiría verde el día que alguien reimplemente la clasificación con números que
coincidan por accidente.

**Confirmado sin cambios:** imports type-only salvo la excepción auditada de
`calibration.ts`; `node:crypto` fuera del bundle de cliente, comprobado sobre
**todos** los archivos de `components/stella`; sin función inversa vista →
`CitationReference`; `excerpt` derivado del chunk y truncado sin tocar
`quotedTextHash`; `location` estructurada conservada; `contradictory_evidence`
con un único productor; accept/edit/reject/undo intacto.

**Pruebas focalizadas:** 331 passed (324 antes de la unificación, +7).

---

## Tren 3 — STELLA_PRODUCT_GROUNDED_RUNTIME_FLOW_TRAIN_3 (2026-08-05)

**HEAD base declarado en la orden:** `4d59348`
(`chore(integration): reconcile Stella train 2 contracts`).
**HEAD real al empezar esta corrida:** `556a57e` — el primer commit de la unidad
ya existía de una corrida anterior, con la tarea 2 sin commitear en el árbol. Se
registra en vez de corregirse: reescribir historia para que el hash coincidiera
con la orden habría destruido el commit que la orden pide producir. Sin push.

Unidad: llevar Stella desde una respuesta fundamentada hasta la revisión humana
**en runtime**, sin crear una segunda lógica de retrieval y sin tocar base de
datos.

### Commits

- `556a57e` — `feat(stella): model grounded runtime response flow`
- (este commit) — `feat(stella): connect grounded review experience`

### El hueco que cierra

El tren 2 dejó el adaptador completo y probado con **cero call sites fuera de
`components/stella/**`**. Era coherente con lo declarado —sin retrieval no hay
`RetrievalCandidate`— pero significaba que `StellaGroundedAnswerPanel` y el modo
`citations` de `StellaEvidencePanel` renderizaban un valor que nada producía, y
que sus pruebas seguirían verdes aunque el pipeline nunca emitiera una cita.

Faltaba el ciclo: nada preguntaba y esperaba una respuesta.
`StellaGroundedAnswerPanel` es un renderer puro sin ciclo de petición, y
`StellaContextualAdvisorPanel` recibe `groundedAnswer` como prop desde fuera de
su propio ciclo, a propósito.

### Contrato de presentación en runtime

[`components/stella/grounded-query.ts`](../../../components/stella/grounded-query.ts).
Describe **un** viaje de ida y vuelta y nada sobre cómo se produjo:

| Lo que la orden pedía representar | Cómo llega |
|---|---|
| respuesta, claims, citas, contradicciones atribuidas | `GroundedAnswerView`, sin cambios respecto del tren 2 |
| abstención | `GroundedAnswerView.abstention` |
| aprobación requerida | `GroundedAnswerView.requiresHumanReview`, literal `true` en el contrato de GROUNDING |
| disponibilidad, permiso, cuota, error de proveedor | la taxonomía `StellaPanelErrorCode` de 12 códigos que ya devuelven las cinco server actions de Stella |

La taxonomía de error se **reutiliza**, no se reinventa: un segundo vocabulario
obligaría a quien llame a aprender dos, y `StellaErrorNotice` ya renderiza éste
sin cambios.

El módulo tiene **un solo export de runtime** (un type guard) y no importa nada
de `@/lib/grounding`.

### Flujo real de UI

[`components/stella/StellaGroundedQueryPanel.tsx`](../../../components/stella/StellaGroundedQueryPanel.tsx).

**No hace retrieval, no valida scope y no llama a ningún modelo.** `runQuery` lo
suministra quien monta el panel y es la **única** costura por la que entra una
respuesta, una evidencia o un error. No existe implementación por defecto ni
fixture cableado como runtime en ninguna parte de `components/stella/**`: no hay
a qué caer si integración no entrega el punto de entrada, y eso es deliberado.

Estados conectados: `idle` · `loading` · `grounded` · `partially_grounded` ·
contradicción atribuida · evidencia insuficiente / abstención · fuente no
disponible · no disponible (`DISABLED`) · reintento · cuota agotada · permiso
denegado · error de proveedor.

**Respuesta completa, no streaming**, y es una lectura de la infraestructura
existente, no una preferencia: las cinco server actions de Stella devuelven una
`Promise` de un resultado ya validado contra un esquema (`AdvisorOutputSchema` y
compañía). No hay transporte incremental que consumir, y simularlo en el cliente
mostraría fragmentos que todavía no pasaron validación.

Cada cita de cada claim muestra: excerpt (derivado del chunk, `null` cuando el
pasaje no se cargó), fuente, ubicación estructurada, nivel de soporte, score
**junto** al bucket, y la contradicción cuando existe un `ContradictionMarker`.

### Revisión humana

`accept` · `accept con comentario` · `reject` con motivo opcional · `undo`.
El vocabulario es el de `decision-types.ts`, reutilizado, no uno paralelo.

Difiere del flujo de sugerencias en un punto en que los dos flujos son
genuinamente distintos: una sugerencia propone texto destinado a sobrescribir un
campo del informe, así que «editar» cambia ese texto. Los claims de una respuesta
fundamentada son evidencia verificada y anclada a un hash — editar su redacción
los desprendería en silencio de las citas que los respaldan, que es exactamente
lo que existe para impedir `grounding-adapter.ts`. Por eso aquí «aceptar con
comentario» adjunta el comentario del revisor junto a una respuesta **intacta**;
nunca reescribe un claim ni una cita.

`undo` es un estado terminal propio («Deshecha»), no un reset a «sin revisar» —
la misma regla que ya usa el ciclo de vida de sugerencias. Una decisión revertida
no es una decisión que nunca ocurrió.

**Nada se presenta como aprobado por defecto:** una respuesta recién llegada dice
«Requiere aprobación humana», incluso si abstuvo. Una abstención no es una
aprobación.

**No se persiste con el backend apagado, y no hizo falta código nuevo para eso.**
`recordStellaDecision` aplica `STELLA_DECISIONS_PERSISTENCE_ENABLED` **antes** de
tocar la base, y `persistStellaDecision` traga su `DISABLED` en silencio porque
es el resultado esperado hasta el gate G2. El panel emite `onDecision` y deja el
cableado a quien lo monta, igual que `StellaContextualAdvisorField`. Repetir la
decisión de persistencia dentro del componente crearía una segunda respuesta a
«¿esto se guardó?».

**Los cuatro registros quedan explícitamente distintos** en pantalla, con etiqueta
propia y `data-claim-kind`: evidencia (cita un documento), inferencia (declara su
paso de razonamiento, obligatorio en el contrato de GROUNDING), recomendación
(propone una acción y puede no citar nada), ausencia (estructuralmente incitable
— `citations?: never`). La decisión humana vive **fuera** de la lista de claims:
no es un quinto tipo de afirmación, y hay una prueba que lo fija.

### Banderas y cuota

Esta unidad **no crea ninguna bandera y no habilita ninguna capacidad**. El panel
acepta `enabled` (pasada por el servidor desde `lib/stella/config`) y con ella en
`false` queda inerte: botón y textarea deshabilitados y `runQuery` **nunca
llamado** — probado. Un `DISABLED` que llega post-click produce el mismo estado
inerte, no un cartel de error.

Cuota y permiso llegan como `QUOTA_EXCEEDED` / `UNAUTHORIZED` y se renderizan con
la presentación ya existente: ninguno de los dos ofrece «Reintentar», y el
mensaje de cuota se muestra **textual** porque lleva cuota, uso y fecha de
reinicio del servidor.

### Solicitud de integración

**[PRODUCT-002](../contracts/PRODUCT-002_grounded_query_orchestrator_entry_point.md)
— `solicitado`.** El otro extremo de la costura tiene que correr en el servidor,
leer el scope de la sesión autenticada y hablar con el orquestador de GROUNDING;
las tres cosas están fuera de las rutas autorizadas de PRODUCT, así que §12
aplica: no se modifica el archivo, se registra la solicitud.

Pide seis cosas verificables **sin retrieval real**: invocar el orquestador y
adaptar con `adaptGroundedAnswer` (nunca construir un `GroundedAnswerView` a
mano), obtener el scope de `requireOrganizationAccess` y no del argumento,
aplicar la bandera **antes** de llamar a nada, aplicar cuota y límite por hora,
devolver el `answerId` al que se ata la decisión humana, y sanitizar el error del
proveedor.

**El backend no se implementa dentro de ningún componente**, y esta línea no
escribió `CONTRACT_LEDGER.md`: el estado de la fila lo fija integración (§8).

### Pruebas

- `vitest run components/stella/__tests__/StellaGroundedQueryPanel.test.tsx` —
  **30/30**: grounded, parcial, contradicción atribuida, abstención, cita sin
  pasaje, loading, permiso, cuota, error de proveedor, `DISABLED` post-click,
  bandera apagada, reintento (con la query anterior, no el borrador actual),
  navegación, accept / accept-con-comentario / reject / undo, ausencia de
  decisión por defecto, los cinco datos de cada cita, los cuatro tipos de claim,
  decisión fuera de los claims, y las tres estructurales de abajo.
- `vitest run components/stella/__tests__/grounded-query.test.ts` — **2/2**.
- `vitest run components/stella` (paquete focalizado completo) — **363/363**,
  17 archivos, 0 fallos, con `env -u GEMINI_API_KEY` según la práctica del tren 1.
  Ningún archivo `.env` tocado.
- `tsc --noEmit` — limpio. `eslint components/stella` — 0 errores, 0 warnings.
- No se ejecutó `test:unit` completo ni `build` (§11: los gates pesados los
  coordina integración).

**Las tres pruebas estructurales, y la mutación que demuestra que muerden.** Una
prueba estructural que no puede fallar es peor que ninguna, porque afirma una
garantía que no sostiene — es el defecto M1 que la revisión adversarial del tren
2 encontró. Verificado por mutación real, no por lectura:

| Prueba | Mutación aplicada | Resultado |
|---|---|---|
| la petición lleva **sólo** `query` (se compara el conjunto de claves, no el contenido) | `runQuery({ query, projectId })` | falla |
| ni `organizationId` ni `projectId` ni `scope` aparecen en el código del flujo (comentarios excluidos) | `const projectId`, `const scope` en el panel | falla |
| cero retrieval, cero proveedor, cero I/O en **todo** `components/stella/**` | `fetch(...)` + `validateAnswerCitations()` en el panel | falla, con los 2 infractores nombrados |

La primera es de conjunto de claves y no de contenido a propósito:
`toHaveBeenCalledWith({ query })` seguiría verde ante una petición que además
llevara `organizationId`. La tercera se aplica al paquete entero y no sólo a este
flujo, también a propósito: la garantía no vale nada si el panel queda limpio
mientras un componente hermano empieza a recuperar y le pasa el resultado.

### Riesgos

- **Sigue sin productor de runtime, y ahora es la única pieza que falta.** La
  nota de cobertura del tren 1 —ampliada en el tren 2— queda acotada a una sola
  causa: existe el contenedor, existe el adaptador, existen los estados; no
  existe quien satisfaga `StellaGroundedQueryRunner`. Eso es PRODUCT-002. Hasta
  entonces `StellaGroundedQueryPanel` tampoco tiene call sites fuera de
  `components/stella/**`.
- **A-M (atribución de contradicción por co-cita) sigue abierto y no se toca
  aquí.** Una afirmación que cita un chunk nombrado por *cualquier*
  `ContradictionMarker` se pinta `contradictory_evidence` aunque la contradicción
  sea sobre otro dato del mismo chunk. No es reparable en presentación:
  `sideA`/`sideB` son `CitationReference[]` y dos afirmaciones sobre el mismo
  chunk producen la misma `CitationReference`. Sigue siendo petición a GROUNDING.
- **A-F1 sigue abierto en GROUNDING** (`validateAnswerCitations` compara sólo
  `organizationId`). Una cita cross-project *entregada* por upstream se
  renderizaría con su pasaje. PRODUCT no lo compensa en la UI, y es deliberado:
  una segunda compuerta de scope en presentación sería una segunda respuesta,
  divergente, a «¿puede leerse esto?».
- **Umbrales sin calibrar** — sin cambios respecto del tren 2: son de GROUNDING y
  están versionados.
- **Desvío de la orden, declarado:** la Fase 7 pedía actualizar «únicamente»
  `docs/ops/workstreams/PRODUCT.md`, y esta unidad además **crea**
  `docs/ops/contracts/PRODUCT-002_*.md`. La Fase 5 pedía publicar la solicitud,
  §8 dice que cada línea la publica en `docs/ops/contracts/`, el tren 1 sentó el
  precedente con PRODUCT-001, y el commit `556a57e` ya citaba esa ruta. Se
  interpretó «únicamente» como restricción sobre documentos **existentes**.
  `CONTRACT_LEDGER.md` no se tocó.

### Estado de entrega

**STELLA_PRODUCT_TRAIN_3_READY_FOR_INTEGRATION.** Árbol limpio, dos commits, sin
push. Cero cambios en `db/**`, `supabase/**`, SQL, `lib/grounding/**` o archivos
`INTEGRATION-OWNED`; cero cambios en `CONTRACT_LEDGER.md`; cero mocks como
runtime; cero aritmética SROI en cliente; cero capacidades habilitadas.

## Integración — tren 3 (2026-08-05)

`4d59348..61a36ba`, merge `--no-ff`. Dos commits declarados (`556a57e`,
`61a36ba`), **ningún tercer commit no declarado**, worktree limpio. La historia
previa no se reescribió.

### Verificado

- `StellaGroundedQueryRequest` contiene **sólo** `query` — fijado por una
  prueba que compara el conjunto de campos del contrato publicado, no su
  contenido;
- el cliente no envía `organizationId`, `projectId` ni `scope`; un payload que
  los lleve **no tiene lector**, y el SQL emitido sigue portando el scope de la
  sesión (probado con valores hostiles de otra organización y otro proyecto);
- `runQuery` permanece **inyectado**; no hay implementación por defecto en
  `components/stella/`;
- los componentes no hacen retrieval ni validan scope;
- `node:crypto` **no llega al bundle de cliente**: todos los imports de
  `@/lib/grounding/contracts` en `grounding-adapter.ts` son `import type`, y el
  único import de valor es `retrieve/calibration`, hoja sin dependencias de
  Node;
- `enabled={false}` evita toda ejecución;
- **no existe fallback mock** en ninguna capa.

### Reconciliación de contradicciones

PRODUCT cerró antes de recibir `sideAClaim` / `sideBClaim` / `claimId` /
`assertionHash`. Integración adaptó el modelo de presentación y la UI:

- `GroundedContradictionView` gana `sideAClaim` / `sideBClaim`, tipados
  `GroundedContradictionClaimView | null`;
- la atribución llega **verbatim del `ContradictionMarker`** — el adaptador no
  deriva ninguna parte de ella;
- **no se infiere por orden, texto ni coincidencia de citas.** Emparejar una
  claim publicada re-hasheando su statement sería exactamente la coincidencia
  de texto que el contrato prohíbe, y además exigiría `hashContent`, un import
  de valor que arrastraría `node:crypto` al cliente;
- `claimId` **no** es `GroundedClaimView.key` (`${kind}-${index}`, un índice de
  presentación) y no se pinta como si lo fuera;
- dos afirmaciones sobre el **mismo chunk** siguen diferenciándose en pantalla;
- la UI **degrada explícitamente** cuando un marcador histórico no lleva
  atribución: dice «Sin atribución de afirmación», no oculta la fila ni
  rellena con la primera claim;
- una atribución parcial (un lado sí, el otro no) es representable y no se
  redondea hacia arriba.

Pruebas cruzadas nuevas: 8 en `grounding-to-product.test.ts` §6 y 4 en
`StellaGroundedAnswerPanel.test.tsx`, más el fixture
`sameChunkContradictionAnswerView`, cuyo caso duro es el que cierra A-M: los
dos lados citan el mismo chunk.

### PRODUCT-002

**`IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE`.** Los seis criterios de
aceptación se cumplen y están probados. No se marca `aceptado` porque el punto
de entrada **no está montado**: siete páginas de pipeline montan Stella bajo
siete `AdvisorPipelineStep` distintos y ninguna es inequívocamente la
superficie canónica de una pregunta con alcance de proyecto. Integración no
inventó una octava página.

El único montaje pendiente está documentado línea a línea en
`docs/ops/contracts/PRODUCT-002_grounded_query_orchestrator_entry_point.md`.

### Decisiones humanas

`onDecision` **no se cableó**. No existe clave canónica de decisión para
respuestas fundamentadas: `recordStellaDecision` se ancla en `suggestionKey`, y
una respuesta fundamentada no es una sugerencia — una sugerencia propone texto
que sobrescribe un campo; una respuesta fundamentada lleva afirmaciones con
citas respaldadas por hash. El panel no muestra nada que afirme persistencia y
`STELLA_DECISIONS_PERSISTENCE_ENABLED` sigue `false`. Registrado como
**INT-PR-001**. No retrasó el query runtime, que es independiente.

---

## Tren 4 — STELLA_PRODUCT_CANONICAL_PROJECT_SURFACE_TRAIN_4 (2026-08-05)

**HEAD base:** `6f3c543` (`chore(integration): reconcile Stella train 3
runtime`). Sin push.

Unidad: cerrar PRODUCT-002 montando `StellaGroundedQuerySection` en una
superficie de proyecto real, no en un octavo paso metodológico.

### Superficie canónica elegida

`app/app/projects/[projectId]/page.tsx` — el resumen general del proyecto,
primera opción del orden de preferencia de la orden de trabajo.

**Por qué es canónica:**

- Es de alcance de **proyecto**, no de paso: no renderiza `<Stepper />`, no
  pertenece a `pipeline/**` y no tiene ningún `AdvisorPipelineStep` propio —
  exactamente el desajuste que dejó PRODUCT-002 sin aceptar (una pregunta
  fundamentada tiene alcance de proyecto, ninguna de las siete páginas de
  paso es inequívocamente canónica).
- No está marcada `INTEGRATION-OWNED` (verificado contra
  `docs/ops/STELLA_PARALLEL_WORKSTREAMS.md` §7 y una búsqueda literal del
  marcador en todo el repo).
- Es la única página que ya actúa como landing del proyecto (enlaza a
  `pipeline`, no al revés), consistente con "resumen general del proyecto"
  siendo la superficie de mayor jerarquía, no una entre siete equivalentes.
- Alternativas descartadas: `pipeline/page.tsx` (el hub) también calificaba
  por no ser un paso, pero el resumen general puntúa más alto en el orden de
  preferencia de la orden y evita cualquier cercanía visual con el
  `<Stepper />` que podría sugerir que la pregunta fundamentada es un octavo
  paso.

### Montaje

Una línea, sin lógica nueva de scope ni retrieval:

```tsx
<StellaGroundedQuerySection projectId={project.id} step="outcomes" />
```

`projectId` es el mismo valor server-resuelto (`project.id`, ya validado por
`getProjectByIdForCurrentOrganization`) que la página ya usaba para sus otros
enlaces — no se introduce un segundo canal para él. `StellaGroundedQuerySection`
(train 3, `IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE`) no se modificó: el
único cambio de esta unidad es el punto de montaje.

**`step`.** `AdvisorPipelineStep` no tiene variante de proyecto — es un tipo
publicado que esta línea no está autorizada a extender (no es
`components/stella/**` ni una página de proyecto propia). Hoy `step` sólo
etiqueta el registro de decisión humana, que en este montaje no se cablea
(ver abajo), así que la elección no tiene efecto en runtime. Se eligió
`"outcomes"` porque una pregunta fundamentada de SROI es, en esencia, sobre
evidencia de resultados. Documentado en un comentario junto al montaje para
que quien cablee `onDecision` en el futuro (si INT-PR-001 se cierra) lo
revise.

### Payload del cliente

Sin cambios respecto del contrato ya probado en train 3:
`StellaGroundedQueryRequest` sigue llevando únicamente `{ query }`. Esta
unidad no tocó `components/stella/grounded-query.ts` ni
`StellaGroundedQueryPanel.tsx`, y una prueba estructural nueva (ver abajo)
fija que el archivo de montaje tampoco nombra `organizationId` ni `scope`.

### Comportamiento de la bandera

Sin cambios: `StellaGroundedQuerySection` sigue leyendo
`stellaConfig.isEnabled && stellaConfig.isGroundedQueryEnabled &&
stellaState.canUseStella` y con la bandera apagada el panel queda inerte
(input y botón deshabilitados, `runQuery` nunca invocado) — comportamiento
ya probado en `StellaGroundedQueryPanel.test.tsx` (train 3) y no reprobado
aquí porque no se tocó esa lógica.

### Estados fundamentados

Sin cambios: los doce estados (`idle`, `loading`, `grounded`,
`partially_grounded`, contradicción atribuida, evidencia insuficiente,
abstención, cuota agotada, permiso denegado, proveedor no disponible, error
reintentable, bandera apagada) ya están conectados y probados por
`StellaGroundedQueryPanel` desde el tren 3. Esta unidad no reimplementa
presentación: monta el contenedor que ya la tiene.

### Decisión humana

`onDecision` **no se cablea** en este montaje — INT-PR-001 sigue abierto.
`StellaGroundedQueryPanel` ya declara en pantalla «Esta decisión no se
guardó: queda sólo en esta sesión y se pierde al recargar» cuando no hay
`onDecision`, así que el estado se mantiene local y honesto sin código nuevo.
La consulta fundamentada en sí **no** queda bloqueada por esta limitación:
sólo el paso de decisión carece de persistencia.

### Accesibilidad

Sin cambios funcionales: el formulario con label, el envío por teclado, el
`aria-busy`/`aria-live` de carga, los `role="note"`/`role="alert"` de errores
y notas, la navegación de citas y el foco tras respuesta ya están cubiertos
por `StellaGroundedQueryPanel.test.tsx` (train 3, describe «accessibility» +
«navigation»). Esta unidad no cambia el árbol de accesibilidad del panel,
sólo dónde vive en la página.

### Guardas estructurales nuevas

`app/app/projects/[projectId]/__tests__/grounded-query-mount.test.ts` — 7
pruebas, todas source-scanning (la página es un server component async
detrás de auth/DB que esta línea no está autorizada a fingir fuera de
`tests/cross-workstream/**`, propiedad de INTEGRACIÓN):

| Prueba | Mutación aplicada | Resultado |
|---|---|---|
| monta `StellaGroundedQuerySection` en la superficie canónica | (RED antes de implementar: no había mount) | fallaba, correctamente |
| no lo monta en ninguna página de `pipeline/**` ni `report/**` | `StellaGroundedQuerySection` insertado en `stakeholders/page.tsx` | falla |
| no cablea `onDecision` en el montaje | `onDecision={...}` añadido a la prop | falla |
| no nombra `organizationId` ni `scope` cerca del montaje | `const organizationId = '...'` añadido a la página | falla |
| la superficie sigue siendo server component (`'use client'` ausente) | no mutada (invariante estructural, no de negocio) | — |
| sin `node:crypto` en la superficie | no mutada | — |
| el inventario de páginas metodológicas no está vacío | guarda-la-guarda: evita que las aserciones "sin ofensores" pasen vacuamente | — |

Las tres primeras mutaciones se aplicaron, se confirmó el fallo, y se
revirtieron antes de continuar (no quedan en el árbol).

### Pruebas ejecutadas

- `vitest run "app/app/projects/[projectId]/__tests__/grounded-query-mount.test.ts"`
  — **7/7** verde.
- `vitest run components/stella "app/app/projects/[projectId]/__tests__/grounded-query-mount.test.ts"`
  con `env -u GEMINI_API_KEY` (misma práctica que trenes 1–3, la contaminación
  ambiental de `GEMINI_API_KEY` sigue confirmada y no relacionada con esta
  unidad) — **377/377**, 18 archivos, 0 fallos.
- `pnpm typecheck` (`tsc --noEmit`) — limpio.
- `eslint "app/app/projects/[projectId]/page.tsx" "app/app/projects/[projectId]/__tests__/grounded-query-mount.test.ts"`
  — 0 errores, 0 warnings.
- No se ejecutó `test:unit` completo ni `build` (§11: gates pesados los
  coordina integración).

### PRODUCT-002

El montaje pendiente que documentaba el contrato está hecho. Esta línea no
marca el contrato `aceptado` — eso es de integración (§8) — pero registra
aquí que el séptimo criterio informal («que alguien pueda alcanzarlo») ya
tiene una superficie real detrás.

### INT-PR-001

Sin cambios de estado: sigue `solicitado`, propiedad de integración. Esta
unidad respeta su alcance sin intentar cerrarlo — no inventa una clave de
decisión, no reutiliza `suggestionKey`, no cablea persistencia y no bloquea
la consulta por la ausencia de persistencia.

### Riesgos

- La elección de `step="outcomes"` es una decisión de producto sin efecto en
  runtime hoy, pero quedará "viva" el día que `onDecision` se cablee en este
  montaje. Documentado en el código y aquí para que ese trabajo futuro la
  revise explícitamente en vez de heredarla en silencio.
- Ningún cambio a `components/stella/**`, `app/actions/stella/**`,
  `lib/grounding/**`, `db/**`, `supabase/**` o `CONTRACT_LEDGER.md`.

### Estado de entrega

**STELLA_PRODUCT_TRAIN_4_READY_FOR_INTEGRATION.** Árbol limpio antes de
commitear, dos commits, sin push.

---

## Tren 4 — integración (2026-08-05)

**Estado: DISEÑO + RUNTIME LOCAL VERIFICADO PARCIALMENTE. Nada aplicado a
ninguna base persistente. Ninguna bandera habilitada en el repositorio.**

Resultado global: **`STELLA_PARALLEL_TRAIN_4_INTEGRATION_BLOCKED_IDEMPOTENCY`**.
El recorrido local completo se ejecuta y pasa; lo único que falta para
`local-runtime-ready` es INT-INT-001 — ver
[`CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).

### PRODUCT-002 — ACCEPTED

Los cuatro criterios se cumplen y están verificados:

* **superficie montada** — `app/app/projects/[projectId]/page.tsx`, la vista de
  proyecto, fuera de los siete pasos metodológicos;
* **server action conectado** — `runStellaGroundedQueryForProject.bind(null, projectId)`;
* **el E2E alcanza la superficie** — `adaptGroundedAnswer` produce la vista de
  Product sobre chunks realmente recuperados;
* **payload sigue siendo `{ query }`** — comprobado como propiedad del tipo, no
  como convención.

### El parámetro `step` es metadata inerte

Revisado sobre la pregunta explícita «¿esto hace que una consulta de proyecto
parezca limitada a outcomes?». La respuesta es **no**, y ahora es una propiedad
con pruebas (`__tests__/grounded-query-mount.test.ts`, «the step prop is
inert»), no un argumento:

* el server action **no tiene** parámetro `step` ni importa
  `AdvisorPipelineStep`, luego `step` no puede estrechar retrieval, scope,
  cuota, el conjunto de evidencia ni la auditoría — todos se computan allí;
* el panel lo lee en **un** sitio, `emitDecision`, y `onDecision` no está
  cableado en el montaje canónico;
* nunca se renderiza.

Existe sólo porque el panel comparte `SuggestionDecisionRecord` con el advisor
y ese `step` no es nulable. Es un marcador de posición, no una afirmación —
cuando INT-PR-001 cierre, este montaje debe dejar de tomar prestado un paso
metodológico.

### R9 — divulgación extractiva

`StellaGroundedQuerySuccess` lleva `answerStrategy: { generatorId, kind }`,
**obligatorio**: un campo opcional permitiría una respuesta sin estrategia
declarada, y el panel no pintaría nada — una divulgación ausente
indistinguible de una estrategia que no la necesita.

La **condición** viaja desde la provenance del run (el server action deriva
`kind` de `run.provenance.generatorId` con un prefijo sobre el NOMBRE, no una
igualdad con el id versionado, para que `extractive-2` no la apague en
silencio). El **texto** vive en Product. `components/stella/**` no conoce el id
del generador.

Se muestra **encima** de la respuesta (una advertencia que califica un texto y
aparece debajo llega tarde), con `role="note"`, y **desaparece** con cualquier
otra estrategia — probado en ambos sentidos.

### INT-PR-001 — sigue pendiente

Aceptar / comentar / rechazar / deshacer siguen siendo estado local. No se
persiste, no se reutiliza `suggestionKey`, y la UI lo **dice**: «Esta decisión
no se guardó». El E2E lo comprueba contando filas tras tomar una decisión real.


---

## Tren 4.1 — INT-INT-001 CERRADO (integración, 2026-08-05)

**`runtime-quota-charged` pasa a `true`** por evidencia ejecutada, no por
diseño: la causa única que lo bloqueaba —la clave de idempotencia sin fuente
canónica— está cerrada.

**`local-runtime-ready` NO se flipa en este tren, y la distinción importa.**
El gate de cuota exigido por INT-INT-001 está satisfecho y medido, pero la
lista de criterios del E2E incluye «ticket cross-project: rechazo, cero cargo»
y ese criterio **no se cumple**: `bind_operation_ticket` y
`complete_operation_ticket` no reciben el proyecto contra el que se ejecuta la
consulta, así que la base no puede compararlo con el del ticket. Es R2-INT.
Declarar `local-runtime-ready=true` afirmaría una propiedad que la propia
batería mide como falsa.

**Qué se cableó.** `db/prepared/stella_0014_operation_tickets.sql` aplicado a
una base desechable; `app/actions/stella/grounded-query.ts` reestructurado a
`issue → bind → ejecutar → complete | abort`; canonicalización en
`lib/stella/operation-ticket/canonical-query-hash.ts`; emisor real de los diez
eventos en `lib/stella/operation-ticket/ticket-observability.ts`; adaptador en
`db/stella/operation-tickets.ts`; el ticket viaja como **segundo argumento** del
runner y el payload funcional sigue siendo `{ query }`.

**Con qué se probó.** `scripts/stella-ticket-e2e.sh` — PostgreSQL desechable
(sin volúmenes, publicado sólo en loopback, destruido al salir), baseline +
`grounding_0002/0003/0004` + `stella_0013` + `stella_0014`, server action real,
adapters reales, generador extractivo local, **cero proveedor**
(`env -u GEMINI_API_KEY`, reafirmado dentro del proceso). 22 escenarios, todos
verdes. Cada cargo se mide como **delta de filas de `stella_interactions`**
leído por una conexión distinta de la del runtime.

**El gate.** `runtime-quota-charged` ya no acepta un informe de dos campos:
exige nueve pruebas medidas (primer cargo, reintento sin cargo, ticket nuevo con
cargo, abort sin cargo, cross-scope sin cargo, concurrencia, semántica explícita
del reintento post-cobro, observabilidad runtime limpia, teardown sin residuos),
y un control negativo comprueba que **retirar cualquiera de las nueve** lo hace
fallar.

**Lo que NO cambió.** Banderas en `false` en el repositorio. `staging-blocked` y
`hosted-blocked` siguen en `true`. `consume_stella_quota` no se tocó. La
política R1 sigue siendo la conservadora: nunca exceder cuota, nunca mostrar
como exitosa una respuesta no cobrada.

**Riesgos abiertos**: R1 (armonización entre acciones hermanas), R2-INT
(atribución cross-proyecto, MAJOR), R3-INT, R4-INT, R5-INT, R6-INT, R7-INT — los
siete detallados en
[`CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).
