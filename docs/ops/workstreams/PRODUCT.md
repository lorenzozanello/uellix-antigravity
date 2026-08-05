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

**STELLA_PRODUCT_GROUNDING_ADAPTER_TRAIN_2** — ver
[§Tren 2](#tren-2--stella_product_grounding_adapter_train_2-2026-08-04) al
final de este documento. Lo que sigue en esta sección es el registro histórico
de la unidad del tren 1, ya integrada.

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
