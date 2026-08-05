# Línea de trabajo: GROUNDING

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-grounding`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-grounding`
- **HEAD base:** `ff1ffb6` (`docs(ops): define parallel Stella workstreams`) —
  el commit de gobernanza sobre `c7c9736`, es decir `INTEGRATION_ROOT_HEAD`
- **Propietario:** sin asignar

## Rutas autorizadas

- **Módulo elegido:** `lib/grounding/**` (no `lib/stella/**`). La fundación ya
  traía `lib/grounding/` con `extract.ts`, `chunk.ts`, `embedding-provider.ts` y
  `retrieval.ts` procedentes de WS5 del Fable Moonshot; esta línea extiende ese
  módulo en lugar de abrir uno nuevo. `lib/stella/` queda intacto — es
  superficie caliente compartida con PRODUCT.
  - `lib/grounding/contracts/**` — contratos publicados (nuevo)
  - `lib/grounding/ingest/**` — núcleo de ingestión (nuevo)
  - `lib/grounding/__tests__/**` — pruebas focalizadas
- Extracción, normalización, hashing, chunking, clasificación documental,
  retrieval, ranking, provenance, citas, abstención.

## Rutas prohibidas

- `db/**`, `supabase/**`, `db/prepared/**` y cualquier migración, SQL preparado,
  policy, rol o función SQL — propiedad exclusiva de CAPABILITIES.
- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7.
- Composer, UI de la experiencia Stella (propiedad de PRODUCT).
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Toda necesidad de esquema, tabla, columna o función SQL depende de un contrato
  aceptado por CAPABILITIES (§8). Esta línea no crea SQL especulativo.
- PRODUCT depende de los contratos TypeScript publicados en
  `lib/grounding/contracts/index.ts`. **Ese barrel es la superficie publicada**:
  PRODUCT no debe importar desde `lib/grounding/ingest/**` ni desde los archivos
  de contrato individuales.

## Contratos requeridos

Registrados en [`docs/ops/contracts/`](../contracts/CONTRACT_LEDGER.md)
(carpeta creada por esta línea, §8 del documento de gobernanza).

| ID | Necesidad | Estado |
|---|---|---|
| [GR-001](../contracts/GR-001_evidence_chunks_provenance.md) | Seis columnas de provenance/versionado en `evidence_chunks` (`chunk_id`, `version_id`, `raw_content_hash`, `normalized_content_hash`, `normalization_version`, `chunker_version`), más aislamiento por proyecto, señales de inyección, `embedding_provider_id` y una constraint de deduplicación | solicitado |
| [GR-002](../contracts/GR-002_document_version_history.md) | Tabla append-only de historia de versiones de documento (`ordinal`, `supersedes`) | solicitado |

La más crítica de GR-001 es `normalized_content_hash`: sin ella, `char_start` /
`char_end` pueden resolverse contra un texto normalizado por otra versión del
pipeline, con offsets válidos apuntando al pasaje equivocado — un fallo
silencioso, no un error.

## Unidad actual

`STELLA_GROUNDING_RETRIEVAL_AND_ISOLATION_TRAIN_2` — **completada**. Ver
[Tren 2](#tren-2--retrieval-y-aislamiento-2026-08-04) al final del documento.

## Unidad anterior

`STELLA_GROUNDING_INGESTION_CORE_TRAIN_1` — **completada**.

Alcance entregado:

1. **Contratos de grounding** (`lib/grounding/contracts/`). La separación
   central — evidencia / inferencia / recomendación / ausencia de evidencia —
   está codificada como una unión discriminada con tuplas no vacías, de modo que
   "una afirmación de evidencia sin cita" y "una abstención que cita algo" no
   compilan. `ContentHash` es un tipo marcado; `GroundingScope` viaja en cada
   registro; `ContradictionMarker.resolution` es el literal único
   `'requires_human_resolution'`.
2. **Núcleo de ingestión determinista** (`lib/grounding/ingest/`):
   normalización versionada e idempotente con contabilidad por paso, hashing
   estable, versionado direccionado por contenido, chunking con anclas
   reconstruibles, localización de página, deduplicación por hash con registro
   de las ocurrencias suprimidas, provenance por chunk y detección estructural
   de instrucciones embebidas en dos etapas (`raw` y `normalized`).

Decisiones de diseño que conviene conocer antes de tocar este código:

- **La detección de inyección nunca muta el texto.** Borrar una frase
  sospechosa rompería el invariante de reconstrucción de toda cita a ese
  documento, justo en los documentos que un auditor más necesita revisar.
- **El escaneo se parte en dos etapas** porque los caracteres ocultos
  (zero-width, overrides bidi) dejan de existir un paso después de la limpieza;
  si el escáner corriera sólo al final, el ataque que un revisor humano no puede
  ver sería el único indetectable.
- **`chunkIndex` tiene huecos por diseño** donde se suprimió un duplicado.
  Renumerar haría que el id de un chunk dependiera de qué más contenía el
  documento.
- **La deduplicación es por versión de documento, nunca entre evidencias.** Dos
  subidas con el mismo anexo son dos piezas de evidencia y ambas deben citarse
  por separado.
- **No se inventa estructura.** Un salto de página dice dónde empieza una
  página; `DocumentSection.label` queda en `null` en lugar de derivar un título
  de la línea siguiente.
- Los límites de los chunks se ensanchan para no partir pares suplentes UTF-16:
  un surrogate suelto no es UTF-8 válido y Postgres lo rechazaría al insertar.

Fuera de alcance de esta unidad, por instrucción: embeddings y retrieval remoto.
El módulo `retrieval.ts` en memoria de WS5 queda como estaba; los contratos
`RetrievalQuery` / `RetrievalCandidate` / `RetrievalResult` definen la forma que
implementará una unidad posterior.

## Últimos commits

- `7020288` — `feat(stella): define grounding and provenance contracts`
- `HEAD` — `feat(stella): implement deterministic ingestion core`

## Pruebas ejecutadas

Focalizadas, según §11 (ningún gate pesado):

```
pnpm exec vitest run lib/grounding/     → 6 archivos, 145 pruebas, todas en verde
pnpm exec eslint lib/grounding/contracts lib/grounding/ingest ...  → limpio
tsc --noEmit sobre lib/grounding/**     → limpio
```

De las 145, 69 son nuevas de esta unidad (29 de contratos, 40 de ingestión). Las
76 preexistentes de WS5 (`chunk`, `extract`, `retrieval`, `prepared-sql`) siguen
en verde sin modificación.

Las pruebas de contratos incluyen bloques `@ts-expect-error`: **sólo cumplen su
función cuando se ejecuta el typecheck**, no bajo `vitest` sola. Un cambio que
afloje la unión de afirmaciones pasaría la suite y fallaría el typecheck.

Nota de entorno: este worktree no traía `node_modules`. Se instaló con
`pnpm install --offline --frozen-lockfile --ignore-scripts` desde el store local
de pnpm — sin red y sin modificar `pnpm-lock.yaml` (INTEGRATION-OWNED).

## Riesgos

- **R1 — Persistencia bloqueada por GR-001.** El núcleo produce provenance
  completa, pero la forma preparada de `evidence_chunks` no puede almacenarla.
  Hasta que CAPABILITIES acepte GR-001, cualquier persistencia perdería
  precisamente los campos que hacen verificable una cita. Mitigación: la
  ingestión es pura y regenerable; no hay presión para persistir antes de tiempo.
- **R2 — Cobertura de formatos.** `extract.ts` sólo lee CSV y TXT reales; PDF,
  XLSX y DOCX devuelven `unsupported` a la espera del gate G5. En un corpus real
  de evidencia, la mayoría de los documentos hoy se saltarían la ingestión. No
  es un defecto de esta unidad, pero limita su valor hasta que G5 se resuelva.
- **R3 — Calibración del escáner de inyección.** Las severidades están afinadas
  para no destruir prosa legítima (un anexo metodológico que discute criterios
  de aprobación sigue siendo citable). Esa elección acepta falsos negativos a
  cambio de falsos positivos bajos. La defensa real sigue siendo el envelope de
  datos no confiables de `lib/stella/context/sanitize.ts`; estas reglas son
  defensa en profundidad, y el documento no debería tratarlas como la barrera
  principal.
- **R4 — Umbrales de abstención sin decidir.** `DEFAULT_RETRIEVAL_MIN_SCORE`
  (0.15) y `DEFAULT_RETRIEVAL_TOP_K` (8) son marcadores de posición razonables,
  no valores calibrados: no hay implementación de retrieval con la que medirlos.
  Deben revisarse cuando exista una.
- **R5 — Sin cableado al pipeline.** `lib/pipeline/evidence.ts` no se ha tocado:
  es superficie compartida y el enganche real depende de G5. El núcleo está
  listo para llamarse desde el `Buffer` que ya existe en memoria en el punto de
  hashing (`evidence.ts:156`), sin round-trip a Storage.

## Estado de entrega a integración

**Listo para integración.** Árbol limpio, dos commits locales, sin push, sin
acceso remoto, sin gates pesados ejecutados. Ninguna ruta prohibida ni
`INTEGRATION-OWNED` fue modificada.

---

## Integración — tren 1 (2026-08-04)

**Fusionada.** HEAD integrado `0698937`, commits `7020288` y `0698937`, merge
commit `24dc14d` (`--no-ff`).

**Conflicto:** `docs/ops/contracts/CONTRACT_LEDGER.md` (add/add). Esta línea y
CAPABILITIES crearon el índice el mismo día, cada una con su cabecera.
Integración lo reconcilió preservando las cuatro filas `CT-CAP-*` y añadiendo
GR-001 y GR-002 **sin cambiar su autoría, su fecha ni su estado**. Ningún otro
archivo entró en conflicto.

### Pruebas focalizadas en el HEAD integrado

`vitest run lib/grounding/` → 6 archivos, **145 passed**. Idéntico a lo
declarado por la línea. Las 69 nuevas y las 76 preexistentes de WS5, todas en
verde. El typecheck integrado (`tsc --noEmit`, limpio) es el que da valor real
a los bloques `@ts-expect-error` de las pruebas de contratos.

Confirmado en el árbol integrado:

- **Cero cambios en `db/**` y `supabase/**`** desde esta línea. El diff completa
  contra `ff1ffb6` no toca ninguna de esas rutas.
- Provenance y hashing conservados: `ProvenanceRecord` mantiene los seis campos
  de la cadena de verificación (`rawContentHash`, `normalizedContentHash`,
  `normalizationVersion`, `chunkerVersion`, `injectionScannerVersion`,
  `versionId`).
- Detección de instrucciones embebidas conservada, en dos etapas (`raw` y
  `normalized`), sin mutar el texto.

### Contratos

- **GR-001 y GR-002 → siguen `solicitado`.** CAPABILITIES no las evaluó en el
  tren 1: su unidad fue CAP-03 (Stripe), no el esquema de evidencia.
  Integración **no las resuelve por su cuenta** — decidir sobre `db/**` está
  reservado a la línea propietaria, y suplantarla sería exactamente lo que §8
  impide. Son el trabajo de entrada de CAPABILITIES tren 2.
- **PRODUCT-001 → `parcialmente satisfecho`.** PRODUCT pidió a esta línea un
  `GroundingCitation` con `excerpt`, `location: string` y `relevance` en
  buckets. Los contratos publicados aquí cubren la necesidad con una forma más
  estricta (`CitationReference` con `quotedTextHash` y `ChunkLocation`
  estructurado; el score numérico en `RetrievalCandidate`). Integración decidió
  que **estos contratos son la fuente técnica canónica de provenance** y que la
  adaptación es responsabilidad de PRODUCT — ver
  [`INTEGRATION-001`](../contracts/INTEGRATION-001_grounding_product_citation_adapter.md).
  Esta línea **no** debe añadir `excerpt` ni buckets a sus contratos.

### Riesgos tras la integración

R1 (persistencia bloqueada por GR-001) **sigue abierto y sin cambio**: es la
consecuencia directa de que GR-001 siga `solicitado`. R2 (cobertura de
formatos), R3 (calibración del escáner), R4 (umbrales de abstención sin
calibrar) y R5 (sin cableado al pipeline) siguen abiertos tal como se
declararon.

R4 gana una consecuencia nueva: los umbrales de `relevance` del adaptador de
INTEGRATION-001 heredan esa incertidumbre y deben revisarse cuando exista
retrieval real.

### Trabajo de entrada del tren 2

Implementación de retrieval y calibración de `DEFAULT_RETRIEVAL_MIN_SCORE` /
`DEFAULT_RETRIEVAL_TOP_K` sobre datos medidos. Sin retrieval real no hay
`RetrievalCandidate` en runtime, así que el adaptador de PRODUCT será
verificable por pruebas antes de ser observable en producto.

### Hallazgo de la revisión adversarial de integración — A-F1 (MAJOR, abierto)

**`validateAnswerCitations` no comprueba el aislamiento por proyecto.**
`lib/grounding/contracts/answer.ts:248` tipa `availableChunks` como
`ReadonlyMap<ContentHash, { contentHash; organizationId }>` — `projectId` no
puede siquiera suministrarse — y el predicado de `citation_out_of_scope`
(`:273`) compara sólo `chunk.organizationId !== state.query.scope.organizationId`.

`GroundingChunk` lleva un `GroundingScope` completo y `scopeContains` existe
exactamente para esto (`core.ts:87`), pero **tiene cero llamadas en producción**:
sus únicas apariciones son el barrel y `__tests__/contracts.test.ts:77-83`.

Contradice la cabecera del propio módulo (`core.ts:11-14`), que promete que un
chunk fuera de scope es «un defecto comprobable en runtime» en vez de una fuga
silenciosa. A nivel de proyecto no lo es. `contracts.test.ts:288` sólo cubre el
caso cross-organización, así que la suite sigue verde.

**Escenario:** una organización con dos proyectos. Una consulta con
`scope = {org, proj-confidencial}` recupera un chunk de
`{org, proj-publico}`. `validateAnswerCitations` devuelve una lista vacía, la
respuesta sale `grounded` y el `quotedTextHash` verifica — todas las señales de
honestidad dicen que la cita es sólida.

**No corregido por integración**, y es deliberado: cambiar la firma de un
contrato publicado es una decisión de diseño de esta línea, no de integración.
Hoy es inalcanzable (cero productores de `GroundingAnswerState` en runtime, sin
retrieval); **pasa a BLOCKER en cuanto el tren 2 cablee retrieval**. Es trabajo
de entrada de GROUNDING tren 2, junto con la prueba cross-proyecto que falta.

**Estado: CERRADO en el tren 2.** Ver
[A-F1 — reproducción y reparación](#a-f1--reproducción-y-reparación).

---

## Tren 2 — retrieval y aislamiento (2026-08-04)

`STELLA_GROUNDING_RETRIEVAL_AND_ISOLATION_TRAIN_2`. Dos commits sobre
`597819b`. Sin push, sin acceso remoto, sin gates pesados, **cero cambios en
`db/**` y `supabase/**`**.

### A-F1 — reproducción y reparación

**Reproducido primero, con una prueba que falla.** La primera versión de esa
prueba pasó por la razón equivocada: el chunk de fixture no llevaba
`organizationId`, así que `undefined !== 'org-aaaa'` disparaba
`citation_out_of_scope` por accidente. Corregida para satisfacer la
comprobación vieja y violar sólo la que faltaba, devolvió `[]` — respuesta
`grounded`, cita de otro proyecto, ninguna señal de alarma. Ése es A-F1.

**La causa no era un `if` olvidado, era una firma demasiado pobre.**
`availableChunks` estaba tipado como
`ReadonlyMap<ContentHash, { contentHash; organizationId }>`: el `projectId` no
estaba sin comprobar, estaba **sin poder suministrarse**. Ningún cuidado en el
punto de llamada podía haberlo aportado, y por eso `scopeContains` llevaba
desde el tren 1 con cero llamadas en producción.

La reparación ensancha el contrato publicado:

- nuevo `CitableChunkRecord` (`chunkId`, `contentHash`, `scope` completo,
  `evidenceId`, `versionId`, `location`);
- `toCitableChunkRecord(chunk)` lo deriva de un `GroundingChunk`, para que
  nadie copie los seis campos a mano — cada campo copiado a mano es un campo
  que se puede copiar del sitio equivocado, y estos son el límite de
  aislamiento;
- `validateAnswerCitations` usa `scopeContains` real y verifica la cadena
  completa: **organización, proyecto, documento, versión, chunk, hash y
  ubicación**;
- cuatro códigos nuevos: `citation_evidence_mismatch`,
  `citation_version_mismatch`, `citation_location_mismatch`,
  `citation_duplicated`.

Decisiones que conviene conocer:

- **Se reportan todas las violaciones de una cita, no la primera.** Una cita
  falsificada rompe varios eslabones a la vez; truncar haría que el registro de
  auditoría describiera un problema más estrecho que el real.
- **`coordinateSpace` se compara con el mismo rigor que los offsets.** Dos
  spans con enteros idénticos en espacios de coordenadas distintos no son el
  mismo pasaje: resuelven en rango y citan otra cosa.
- **La duplicación se evalúa por afirmación, no globalmente.** Dos
  afirmaciones apoyadas en el mismo pasaje son corroboración normal; una
  afirmación que cuenta el mismo pasaje dos veces infla su respaldo aparente.

**Pruebas de ataque** (`__tests__/isolation.test.ts`, 16): misma organización
y otro proyecto; degradación silenciosa; organización ajena; organización
ajena con `projectId` que colisiona; evidence item falso; versión ajena; hash
desplazado; chunk no recuperado; span movido; espacio de coordenadas ajeno;
cita duplicada; contradicción con un lado fuera de scope.

### Contrato de repositorio

`lib/grounding/retrieve/repository.ts`. Interfaz pura: **no importa `db/**`**,
no abre conexión, no conoce SQL. Consulta por `scope`, `evidenceIds`
autorizados, `versionIds`, texto y `limit`.

`evidenceIds` y `versionIds` son filtros de **autorización**, no preferencias:
la autorización puede ser más estrecha que el límite de aislamiento — un
revisor asignado a tres documentos de un proyecto no debe recuperar el cuarto.

**El repositorio se trata como NO CONFIABLE respecto del scope**, porque filtrar
de menos es exactamente el aspecto que tiene un `WHERE` al que se le cayó un
predicado. `enforceRepositoryScope` verifica cada chunk devuelto y **lanza**:

- un guard que filtra produce una respuesta correcta desde un repositorio roto,
  con lo cual la rotura nunca se observa y llega a producción;
- un guard que lanza convierte la misma rotura en una petición fallida con el
  límite nombrado en el mensaje.

También verifica que `chunk.scope` y `chunk.provenance.scope` coincidan. Se
escriben en momentos distintos de la ingestión; si discrepan, una de las dos
escrituras fue incorrecta y no hay forma de saber cuál.

Compatible con GR-001 y GR-002 sin depender de ellas: la implementación
persistida y `InMemoryChunkRepository` son intercambiables, y el aislamiento se
prueba una vez para ambas.

### Retrieval

`lib/grounding/retrieve/retrieve.ts`. Estrategia local determinista:

```
fetch (con guard de scope) → cuarentena → score → umbral → ranking
  → deduplicación → tope por documento → top-k → diversidad de fuentes
```

**Sin proveedores, sin embeddings remotos, sin red.** `ChunkScorer` es la
interfaz por la que entrará un scorer semántico después **sin cambiar el
contrato de respuesta**: es `async` aunque la implementación léxica no lo
necesite, porque hacerla síncrona obligaría a cambiar todas las firmas
superiores el día que se añada un proveedor real.

`LexicalChunkScorer` (`lexical-idf-tf-v1`): idf sobre el conjunto candidato,
ponderado por frecuencia de término saturada, normalizado a `[0, 1]`.

- **La saturación existe** para que un pasaje con relleno de palabras clave no
  supere al pasaje que responde la pregunta.
- **El idf se calcula sobre el conjunto candidato, no sobre un corpus global.**
  Mantiene la función pura, al precio de que los scores no sean comparables
  entre consultas. El contrato ya decía exactamente eso (`score` es «comparable
  sólo dentro de una consulta y una estrategia»), así que la implementación
  cumple la garantía publicada en lugar de excederla en silencio.

**Toda etapa sólo puede quitar candidatos, y toda eliminación queda registrada
con su razón** (`RetrievalExclusion`): `below_min_score`, `quarantined`,
`duplicate_content`, `over_document_limit`, `beyond_top_k`,
`displaced_for_source_diversity`. Un candidato que desaparece sin razón
registrada es indistinguible de uno que nunca estuvo, y las dos situaciones
exigen respuestas distintas.

`displaced_for_source_diversity` se nombra en vez de esconderse: marca un chunk
que puntuó **más alto** que otro que sí se conservó. Quien no vea eso no puede
distinguir ranking de política.

Decisiones de ranking:

- **La cuarentena ocurre antes del scoring**, para que el contenido retenido
  tampoco influya en el idf.
- **Los empates se rompen por `(evidenceId, chunkIndex, chunkId)`**, nunca por
  orden de entrada: el orden en que el repositorio enumera no debe ser el
  ranking.
- **La deduplicación es posterior al ranking**, para que la ocurrencia que
  sobrevive sea la determinista y no la que llegó primero.
- **Diversidad: greedy con reparación, no round-robin.** Round-robin
  reordenaría todos los resultados para servir un piso que la mayoría de
  consultas ya cumple. La reparación sólo toca el resultado cuando el piso se
  incumple de verdad.
- **El piso efectivo es `min(minDistinctSources, topK)`.** Un resultado de k
  chunks no puede apoyarse en más de k fuentes; pedir más no es una política
  más estricta sino una insatisfacible. Sin ese tope, el bucle intercambiaba la
  única plaza hasta agotar candidatos y perdía por el camino las exclusiones
  `beyond_top_k` — lo detectó una prueba, no una revisión.

`DEFAULT_MIN_DISTINCT_SOURCES` es 2 y no 1 porque una respuesta de fuente única
no puede aflorar una contradicción, y una respuesta que no puede aflorar
contradicciones reporta la primera cifra que encuentra como si no estuviera
disputada. Es un piso, no una cuota: se abandona antes que fabricarse.

### Respuesta grounded

`lib/grounding/retrieve/grounded-answer.ts`. Estados:
`sufficient_evidence`, `partial_evidence`, `contradictory_evidence`,
`insufficient_evidence` y **`provider_unavailable` como estado separado**.

`provider_unavailable` no es una afirmación sobre la evidencia. «Tu evidencia
no responde a esto» y «no pudimos mirar» son hechos distintos sobre cosas
distintas; colapsarlos le dice a un revisor que su documentación carece de algo
que puede muy bien contener. `providerUnavailableOutcome` se construye aquí y
no en el llamador, para que no pueda recibir afirmaciones, un `inspected` no
nulo ni una explicación con sabor a evidencia.

**El mecanismo central: un borrador nunca aporta una cita.** Aporta una frase y
un `chunkId`. Todos los campos verificables — evidence item, versión, hash,
ubicación — se **leen del chunk recuperado**. Un modelo que emita un `versionId`
o un hash plausibles no consigue nada, porque esos campos no se toman de él
jamás.

Esto es más fuerte que validar: validar detecta una cita falsificada después de
que existe; construir no deja dónde ponerla. La validación se ejecuta igual
como segunda línea — cubre el caso en que el `ScopedRetrievalResult` y el scope
de su propia query discrepan, que la construcción no puede ver.

`ContradictionMarker` proviene de la evidencia y nunca de la UI. Una
contradicción con un lado que no resuelve a un chunk recuperado **se descarta
entera**: no es evidencia más débil de un conflicto, es ninguna evidencia de
uno, y emitirla dejaría a la UI mostrando un conflicto apoyado en un chunk que
nadie puede abrir. Dos chunks con cifras distintas no son una contradicción;
sólo un `ContradictionMarker` explícito lo es.

### Calibración

`lib/grounding/retrieve/calibration.ts`.

**Los umbrales son una primera calibración local. NO son óptimos y NO han sido
evaluados.** Se eligieron leyendo la escala que produce el scorer léxico, no
midiendo calidad de respuesta contra un conjunto etiquetado, porque tal
conjunto no existe todavía. Es el mismo estado que R4 declara sobre
`DEFAULT_RETRIEVAL_MIN_SCORE` y que INTEGRATION-001 §6 anticipa para el
adaptador. **Pendientes de evals.**

`RELEVANCE_THRESHOLDS_VERSION = 'grounding-relevance-2026-08-local-1'`;
`high >= 0.4`, `medium >= 0.2`. Referencia de escala para quien recalibre: un
chunk con todos los términos de la consulta una vez cae cerca de 0.45; con la
mitad, cerca de 0.23.

Lo que sí está diseñado y no adivinado:

- **el conjunto está versionado**, de modo que un bucket almacenado se puede
  rastrear hasta la calibración que lo produjo y una recalibración se ve en los
  datos en vez de reinterpretar el histórico en silencio;
- **el bucket nunca sustituye al score.** `presentRelevance` devuelve ambos más
  la estrategia y el scorer. Descartar el número dejaría al sistema sin forma de
  recalibrar sobre datos históricos ni de notar que una estrategia cambió de
  escala;
- **un score fuera de `[0, 1]` lanza en vez de recortarse**, porque significa
  que el scorer cambió y los umbrales no.

### Pruebas ejecutadas

Focalizadas, según §11 (ningún gate pesado; sin `test:unit` completo, sin
`build`):

```
pnpm exec vitest run lib/grounding/  → 11 archivos, 237 pruebas, todas en verde
pnpm exec eslint lib/grounding       → limpio
pnpm exec tsc --noEmit               → limpio
```

De las 237, **92 son nuevas** de este tren (16 de aislamiento, 13 de
repositorio, 32 de retrieval, 24 de respuesta grounded, 10 de calibración,
más las de fixtures compartidos). Las 145 del tren 1 siguen en verde; dos
archivos preexistentes se actualizaron a la firma nueva de
`validateAnswerCitations`.

Escritas antes que la implementación y vistas fallar: la reproducción de A-F1,
las 31 de retrieval y las 31 de respuesta/calibración. Dos defectos reales los
encontró ese ciclo y no una revisión: el falso verde de la fixture de A-F1 y el
bucle degenerado de diversidad con `topK: 1`.

### Riesgos

- **R1** (persistencia bloqueada por GR-001) sigue abierto. El contrato de
  repositorio está diseñado para que GR-001/GR-002 lo implementen sin cambiar
  nada de retrieval, pero hasta entonces no hay repositorio persistido.
- **R2** (cobertura de formatos) y **R5** (sin cableado al pipeline) siguen
  abiertos sin cambio.
- **R3** (calibración del escáner de inyección) sin cambio. Retrieval respeta
  la política existente: sólo `critical` pone en cuarentena, `warning` sigue
  siendo citable.
- **R4 — parcialmente atendido, no cerrado.** Ya existe retrieval con el que
  medir, y los umbrales de presentación están versionados y probados en sus
  bordes. Pero **siguen sin calibrar contra datos**: `RELEVANCE_THRESHOLDS`,
  `DEFAULT_RETRIEVAL_MIN_SCORE`, `DEFAULT_MAX_PER_DOCUMENT` y
  `DEFAULT_MIN_DISTINCT_SOURCES` son todos de primera pasada. Cierra con evals,
  no con este tren.
- **R6 — nuevo. `no_matching_evidence` cubre dos situaciones distintas.**
  Cuando se recuperan pasajes pero ninguna afirmación del borrador logra
  fundamentarse, la abstención sale con `code: 'no_matching_evidence'` aunque sí
  hubiera evidencia relevante. La `explanation` lo dice explícitamente y
  `inspected.total` lo delata, pero el código por sí solo se lee como «tu
  evidencia no contiene nada sobre esto». No se añadió un código nuevo a la
  unión publicada para no ensanchar un contrato ya consumido por INTEGRATION-001
  sin necesidad demostrada. Revisar si aparece en uso real.
- **R7 — nuevo. La diversidad de fuentes puede desplazar al mejor candidato.**
  Es intencionado y queda registrado como `displaced_for_source_diversity`,
  pero significa que el pasaje mejor puntuado no siempre aparece. Sin evals no
  hay forma de saber si el intercambio mejora las respuestas.

### Estado de entrega a integración

**Listo para integración.** Árbol limpio, dos commits locales, sin push, sin
acceso remoto, sin datos simulados en runtime, sin gates pesados. Ninguna ruta
prohibida ni `INTEGRATION-OWNED` fue modificada.

Nota para PRODUCT: el barrel nuevo es `lib/grounding/retrieve/index.ts`
(`lib/grounding/contracts/index.ts` sigue siendo la superficie de contratos).
`presentRelevance` es el punto previsto para los buckets de INTEGRATION-001 §6,
y ya cumple su condición: score y estrategia viajan junto al bucket.

---

## Estado en el HEAD integrado del tren 2 (integración, 2026-08-04)

Sección añadida por **integración**, no por esta línea. No reescribe nada de lo
anterior: registra qué de lo que esta línea declaró queda confirmado sobre el
árbol fusionado, y qué cambió al cruzarlo con las otras tres.

**Hallazgo:** A-F1 → **CLOSED**.

`CitableChunkRecord` lleva `scope: GroundingScope` completo, y `scopeContains`
se evalúa **antes** que cualquier otra comprobación — así una cita fuera de
frontera se reporta como tal y nunca se degrada a un issue más suave sobre su
contenido. `toCitableChunkRecord` es la proyección publicada, y existe porque
cada campo copiado a mano es un campo que puede copiarse del sitio equivocado, y
los campos en cuestión **son** la frontera de aislamiento.

Esa decisión de publicar el helper es la que salvó la integración: RELEASE
construía ese mapa a mano contra la firma anterior. El harness compilaba en su
worktree y lanzaba en la primera corrida integrada.

**Confirmado sobre el árbol integrado:**

- retrieval filtra scope **en la fuente** (guarda del repositorio), no al final:
  `fetch (scope-guarded) → quarantine → score → threshold → rank`;
- **cero** imports desde `db/**` en `lib/grounding/**`;
- **cero** proveedores, `fetch` o embeddings remotos en el runtime;
- el score numérico sobrevive junto al bucket, la estrategia y la identidad del
  scorer;
- las contradicciones sólo se emiten si **ambos** lados resuelven a chunks
  recuperados.

**`calibration.ts` pasó a ser canónico para todo el árbol.** PRODUCT había
publicado un segundo juego de umbrales; integración lo retiró. Consecuencia para
esta línea: `RELEVANCE_THRESHOLDS` y `RELEVANCE_THRESHOLDS_VERSION` son ahora
superficie consumida por `components/stella`, y recalibrar es editar **un**
archivo. El módulo se importa como valor desde el cliente, lo cual sólo es seguro
porque es una **hoja** —sus dos imports son `import type`—; esa propiedad tiene
ahora su propia prueba, así que dejará de ser cierta ruidosamente.

**Contrato de vuelta, para el tren 3: GR-CAP-002 — `EXTRACTOR_VERSION`.**
`evidence_document_versions.extractor_version` es `NOT NULL`. El hueco es real:
`versionId` se deriva de `(evidenceId, rawContentHash)` y el extractor no está en
esa preimagen, así que un extractor distinto sobre los mismos bytes produce otro
`normalized_content_hash` bajo el **mismo** `version_id`. Y
`lib/grounding/extract.ts` ya tiene un registro real de extractores. Integración
**no** eligió el valor.

**Sigue abierto, correctamente:** R4 (umbrales sin calibrar — no hay conjunto
etiquetado), R6 (`no_matching_evidence` frente a «hay evidencia y no es
relevante»), R7 (suelo de diversidad de fuentes). Los tres se calibran contra
scores reales de un retrieval con datos, que no existe.
