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

`STELLA_GROUNDING_LOCAL_END_TO_END_TRAIN_4` — **completada**. Ver
[Tren 4](#tren-4--ingesta-orquestada-y-generador-extractivo-2026-08-05) al
final del documento.

## Unidad anterior

`STELLA_GROUNDING_RUNTIME_ORCHESTRATION_TRAIN_3` — **completada**. Ver
[Tren 3](#tren-3--versión-de-extracción-atribución-y-orquestación-2026-08-05).
Antes, `STELLA_GROUNDING_RETRIEVAL_AND_ISOLATION_TRAIN_2` — ver
[Tren 2](#tren-2--retrieval-y-aislamiento-2026-08-04).

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

---

## Tren 3 — versión de extracción, atribución y orquestación (2026-08-05)

`STELLA_GROUNDING_RUNTIME_ORCHESTRATION_TRAIN_3`. Dos commits sobre `4d59348`.
Sin push, sin acceso remoto, sin gates pesados, **cero cambios en `db/**`,
`supabase/**`, SQL y `components/**`**.

### GR-CAP-002 — `EXTRACTOR_VERSION` publicado

`EXTRACTOR_VERSION = 'extract-1'` en `lib/grounding/contracts/core.ts`,
exportado por el barrel de contratos e incorporado a `PIPELINE_VERSIONS`, que
pasa de tres campos a cuatro (`normalization`, `chunker`, `injectionScanner`,
`extractor`).

**El valor deriva del comportamiento real del extractor**, no es un nombre
arbitrario: `extract.ts` está en su primer contrato de extracción — CSV
RFC 4180-ish y `text/plain` verbatim, todo lo demás `unsupported` — y nunca ha
cambiado de forma observable, así que la primera versión es `-1`, igual que
`norm-1`, `chunk-1` e `inj-1`. La constante es **una por módulo, no una por
MIME type**: `extract.ts` registra varios formatos bajo un único contrato, y
versionar por formato inventaría una granularidad que el código no tiene.

`DocumentVersion` gana `extractorVersion`, y `ingestDocument` lo estampa. Lo que
**no** cambió, deliberadamente: `deriveVersionId` sigue siendo función de
`(evidenceId, rawContentHash)` únicamente. Ese es el punto del contrato, no un
descuido — re-extraer los mismos bytes bajo otro extractor debe conservar la
identidad de versión **y** hacer visible que el texto derivado cambió. Si el
extractor entrara en la preimagen, una reingesta bajo extractor nuevo se vería
como una versión distinta del documento, que es justo la confusión que
`evidence_document_versions.extractor_version` existe para evitar.

**Consecuencia para integración:**
`tests/cross-workstream/capabilities-to-grounding.test.ts` **falla ahora**, en
el caso «GROUNDING publishes no EXTRACTOR_VERSION yet». Es el disparo previsto
por el propio ledger: la prueba fija la ausencia como cable trampa y su comentario
dice que el día que GROUNDING publique la constante, fallar **es la señal para
cerrar el contrato, no para borrar la prueba**. Esta línea **no la tocó** — es
propiedad de CAPABILITIES.

### Contradicciones atribuidas por afirmación

El modelo del tren 2 no podía distinguir dos afirmaciones que citan **el mismo
chunk**: `sideA` y `sideB` son listas de `CitationReference`, y dos lecturas
opuestas de un mismo pasaje producen dos lados idénticos.

Extensión mínima y **aditiva**:

- `ContradictionClaimAttribution { claimId, assertionHash }` en
  `contracts/answer.ts`;
- `ContradictionMarker.sideAClaim` / `sideBClaim`, **opcionales y nulables**;
- `DraftContradictionSide { claimId, statement }` en el borrador.

Decisiones que conviene conocer:

- **Los campos son opcionales por compatibilidad estructural, no por comodidad.**
  `components/stella/grounding-adapter.ts` y
  `tests/cross-workstream/grounding-to-product.test.ts` construyen y consumen
  literales de `ContradictionMarker` con exactamente los cinco campos previos, y
  ninguno de los dos archivos es modificable por esta línea. Un campo requerido
  habría roto su compilación; uno opcional no. `sideA` / `sideB` conservan su
  forma, así que INTEGRATION-001 no se entera.
- **`assertionHash` se calcula aquí, nunca se transporta desde el borrador.**
  `attributionOf` aplica `hashContent(statement)` sobre el texto que el borrador
  declaró. Un generador no puede fabricar la huella de una afirmación que no
  hizo — es el mismo principio que ya rige las citas: los campos verificables no
  se toman del modelo.
- **Se guarda el hash y no la prosa.** La atribución no debe convertirse en un
  segundo sitio donde se almacena texto libre.
- **Ausente sigue significando ausente:** cuando el borrador no aporta
  atribución, el marcador sale con `null`, no con un `claimId` inventado.
- **Nada de esto deriva contradicciones.** Dos chunks que comparten cifras
  siguen sin ser una contradicción; sólo un `DraftContradiction` explícito lo es.

### Orquestador

`lib/grounding/retrieve/orchestrate.ts`. Raíz de composición, **no** sitio donde
se inventa política nueva:

```
scope + query
  → GroundingChunkRepository (inyectado, envuelto en enforceRepositoryScope)
  → retrieveGroundedChunks
  → AnswerDraftProvider (inyectado)
  → buildGroundedAnswer (construcción + validación de citas)
  → clasificación
```

**Cero imports de `db/**`**, cero `fetch`, cero proveedor. Las dos costuras
inyectables son `GroundingChunkRepository` —la interfaz que GR-001/GR-002
implementarán sobre SQL preparado, sin que este archivo cambie— y
`AnswerDraftProvider`, la única costura por la que entra un modelo real. Una
prueba lee el propio fuente del módulo y falla si aparece un import de `db/`,
`supabase`, `fetch`, `axios` o un SDK de proveedor.

Clasificación de seis valores: `grounded`, `partially_grounded`,
`contradictory`, `insufficient_evidence`, `abstention`, `provider_unavailable`.

**Es más fina que `GroundedOutcomeKind` en un punto, y a propósito.**
`buildGroundedAnswer` colapsa en `insufficient_evidence` toda abstención que no
sea contradicción ni proveedor caído — incluidas `content_quarantined`, que su
propia cabecera llama «un evento de seguridad», y `out_of_scope`. Colapsarlas en
la frontera del orquestador sería exactamente lo que ese módulo advierte que no
se haga: le diría al llamador «sube más documentos» cuando el problema real es
una señal de inyección o una frontera cruzada. Así que
`insufficient_evidence` queda para los códigos que de verdad significan «no hay
nada o nada es relevante» (`no_matching_evidence`, `below_relevance_threshold`,
`evidence_unreadable`) y todo lo demás abstenido cae en `abstention`.

**Dos superficies de fallo, tratadas distinto:**

- `GroundingScopeViolationError` y `RepositoryContractViolationError` **se
  relanzan**. Un repositorio que devuelve un chunk fuera de scope es un defecto
  de programación —un `WHERE` al que se le cayó un predicado—, y tragárselo como
  `provider_unavailable` escondería una rotura de frontera detrás de un estado
  que un llamador podría simplemente reintentar.
- Cualquier otro fallo del repositorio (conexión rechazada, timeout) es
  operativo, no una afirmación sobre la evidencia, y sale como
  `provider_unavailable`.

### R6 — decisión provisional: **un solo código**

`no_matching_evidence` cubre dos situaciones: (a) no había nada indexado que
coincidiera; (b) sí había pasajes y ninguna afirmación se fundamentó.

**Decisión: no se ensancha `AbstentionReasonCode`.** Las dos situaciones ya son
separables por datos publicados en el mismo objeto: dentro de
`no_matching_evidence`, `inspected.total === 0` es exactamente (a) y `> 0` es
exactamente (b). Las pruebas fijan esa partición como propiedad, no como
accidente del orden de las ramas. La unión la consumen INTEGRATION-001 y el
adaptador de PRODUCT; añadir una variante obligaría a cada consumidor a manejar
una distinción que ya puede hacer. Sin necesidad demostrada, no se ensancha.

**Lo que la investigación sí demostró fue un defecto en la explicación, no en el
código.** Un borrador con cero afirmaciones sobre pasajes recuperados salía con
«No indexed passage within scope addresses the question» mientras
`inspected.total` decía lo contrario: metadato y prosa en desacuerdo, y la prosa
es lo que lee el humano. La causa era el discriminante: `abstentionFor`
ramificaba por `claimsWereRejected`, y un borrador vacío no rechaza nada. Ahora
ramifica por **si se recuperaron pasajes**, que es la pregunta real. Es un cambio
de cadena, no de contrato.

Reproducido primero con una prueba que falla (`__tests__/r6.test.ts`). Si más
adelante se observa a consumidores ramificando por `inspected.total` o por el
texto para recuperar (a) frente a (b), **eso** es la necesidad demostrada y la
partición pasa a ser lo correcto. Hoy no lo está.

### R7 — decisión provisional: **conservar el suelo de dos fuentes**

`DEFAULT_MIN_DISTINCT_SOURCES = 2` puede desplazar al candidato mejor puntuado.
**Se conserva el comportamiento** —greedy con reparación, suelo efectivo
`min(minDistinctSources, topK)`— sin tocar `selectWithDiversity`. Lo que añade
este tren es el banco de seis escenarios que el tren pidió, en
`__tests__/r7.test.ts`, para que la próxima calibración compare contra casos
fijos en vez de volver a derivarlos:

| Escenario | Comportamiento observado |
|---|---|
| Una fuente excelente | No se fabrica una segunda; contenido irrelevante nunca se promueve |
| Dos fuentes medianas | El suelo ya se cumple; cero desplazamientos |
| Contradicción potencial | Sin el suelo el resultado es de fuente única y la contradicción **no puede existir**; con el suelo, sí |
| `topK: 1` | El suelo cede ante topK; no hay intercambio degenerado |
| `topK: 2` | Reparación real: se desplaza el chunk más débil de la fuente dominante, registrado |
| Una sola fuente disponible | El suelo se abandona antes que inventarse |

**No se declara óptima.** Sigue sin haber conjunto etiquetado, y el escenario de
contradicción es un argumento a favor del suelo, no una medición de calidad de
respuesta.

Dos fixtures de este banco fallaron primero por la razón equivocada, y ambas
enseñan algo sobre el scorer que conviene dejar escrito:

- un término de la consulta **ausente de todo el conjunto candidato** agranda
  igualmente el denominador normalizador de `LexicalChunkScorer` (`maximum` suma
  idf sobre todos los términos), deprimiendo todos los scores a la vez; la
  segunda fuente caía bajo `DEFAULT_RETRIEVAL_MIN_SCORE` y la prueba «mostraba»
  una sola fuente por un motivo que nada tenía que ver con diversidad;
- el desempate por `evidenceId.localeCompare` hacía que `ev-audit` precediera a
  `ev-report`, de modo que `topK: 2` **ya** devolvía dos fuentes y la premisa de
  «una fuente domina» era falsa para ese corpus.

### Pruebas ejecutadas

Focalizadas, según §11 (ningún gate pesado; sin `test:unit` completo, sin
`build`):

```
pnpm exec vitest run lib/grounding/  → 14 archivos, 271 pruebas, todas en verde
pnpm exec eslint lib/grounding       → limpio
pnpm exec tsc --noEmit               → limpio
```

De las 271, **34 son nuevas** de este tren: 3 de `EXTRACTOR_VERSION` (constante
estable, participación en `PIPELINE_VERSIONS`, identidad de pipeline distinta
con `versionId` idéntico), 2 de ingestión (estampado y conservación entre
reingestas), 3 de atribución de contradicciones (incluida la del **mismo chunk
sostenido por dos afirmaciones**), 12 de orquestador (scoped, cross-project,
cross-organización, cita inválida que **lanza**, dos rutas de
`provider_unavailable`, determinismo, cero proveedor externo, cuarentena como
`abstention`), 8 de R6 y 6 de R7.

El typecheck completo del proyecto está limpio, que es lo que demuestra que la
extensión de `ContradictionMarker` es realmente compatible: `components/**` y
`tests/cross-workstream/**` compilan sin tocarse.

### Riesgos

- **R1** (persistencia bloqueada por GR-001) y **R2** (cobertura de formatos)
  siguen abiertos sin cambio.
- **R3** (calibración del escáner) sin cambio.
- **R4** (umbrales sin calibrar) sin cambio: este tren no calibró nada contra
  datos etiquetados, porque siguen sin existir.
- **R5 — sin cableado al pipeline: sigue abierto, y ahora es más pequeño.** El
  orquestador es el punto de entrada que faltaba, pero nadie lo llama todavía:
  no hay ruta, job ni handler que lo invoque, y `AnswerDraftProvider` no tiene
  implementación real. Lo que queda es cableado de aplicación, no de esta línea.
- **R6 — cerrado como decisión provisional**, con el defecto de explicación
  corregido. Reabrir sólo con necesidad demostrada por uso real.
- **R7 — sigue abierto por diseño**, ahora con seis escenarios fijos y
  reproducibles. Cierra con evals, no con este tren.
- **R8 — nuevo. La clasificación del orquestador es una segunda taxonomía.**
  `GroundingOrchestrationClassification` y `GroundedOutcomeKind` conviven, y la
  primera reinterpreta a la segunda leyendo `AbstentionReasonCode`. Está probado
  y documentado por qué difieren, pero son dos vocabularios para una misma
  realidad: si aparece un tercer consumidor con su propio mapeo, la respuesta
  correcta es unificar, no añadir.

### Estado de entrega a integración

**Listo para integración.** Árbol limpio, dos commits locales, sin push, sin
acceso remoto, sin datos simulados en runtime, sin gates pesados. Ninguna ruta
prohibida ni `INTEGRATION-OWNED` fue modificada.

**Peticiones a integración:**

1. **Cerrar GR-CAP-002.** La constante está publicada y participa en
   `PIPELINE_VERSIONS`, `DocumentVersion` e ingestión. La fila del ledger pasa de
   `solicitado` a resuelto, y la aserción de ausencia en
   `tests/cross-workstream/capabilities-to-grounding.test.ts` debe invertirse
   —pasar a exigir la presencia y el valor— por **CAPABILITIES**, su propietaria.
   Esta línea la dejó fallando a propósito.
2. **Nota para PRODUCT:** `ContradictionMarker` gana dos campos opcionales. No
   hay acción obligatoria; el adaptador sigue compilando y funcionando sin
   leerlos. Si la UI quiere mostrar «qué afirmación sostiene cada lado», el dato
   está en `sideAClaim` / `sideBClaim`.

## Integración — tren 3 (2026-08-05)

`4d59348..65c6c2c`, merge `--no-ff`. Dos commits declarados, nada más.

### GR-CAP-002 — cerrado

`EXTRACTOR_VERSION = 'extract-1'`, declarado **una sola vez** en
`lib/grounding/contracts/core.ts`, presente en `PIPELINE_VERSIONS`,
transportado por `DocumentVersion.extractorVersion` y estampado por
`ingestDocument`. Cabe en `extractor_version varchar(32) NOT NULL` y satisface
la restricción de no-vacío del paquete de CAPABILITIES.

Corresponde al primer contrato observable del extractor (los MIME types que
`extract.ts` lee y cómo), y un cambio futuro de ese comportamiento exige
versión nueva: `contracts.test.ts` fija que dos `DocumentVersion` idénticos
salvo `extractorVersion` no son el mismo estado de pipeline. `versionId` no
incluye al extractor en su preimagen, que es exactamente el hueco que la
columna cierra.

Los **dos test-trampa** que fijaban su ausencia
(`tests/grounding-persistence-contract.test.ts`,
`tests/cross-workstream/capabilities-to-grounding.test.ts`) se **invirtieron,
no se borraron**: ahora afirman el contrato satisfecho y siguen fallando si la
constante desaparece o si aparece una segunda divergente.

### Contradicciones atribuidas

Verificado en el árbol integrado:

- `ContradictionClaimAttribution` = `{ claimId, assertionHash }`, opcional y
  aditivo — un marcador anterior sigue siendo válido;
- `assertionHash` se **deriva en el sistema** (`hashContent` dentro de
  `buildGroundedAnswer`); un hash enviado por el modelo nunca se almacena;
- `CitationReference[]` conservan su forma en `sideA` / `sideB`;
- `requires_human_resolution` sigue siendo unión de un solo miembro;
- dos afirmaciones que citan **el mismo chunk** siguen siendo distinguibles:
  `claimId` y `assertionHash` difieren aunque toda `CitationReference` sea
  idéntica. Probado explícitamente en `grounding-to-product.test.ts` §6 y en
  `StellaGroundedAnswerPanel.test.tsx`.

### Orquestador

- scope exacto obligatorio (`assertValidScope` primero);
- repository **inyectado**, envuelto en `enforceRepositoryScope`;
- **cero imports desde `db/`** en todo `lib/grounding/` — verificado;
- retrieval scoped, citas validadas;
- `provider_unavailable` separado de falta de evidencia;
- errores de scope (`GroundingScopeViolationError`,
  `RepositoryContractViolationError`) **rethrow**, no degradan;
- errores operativos degradan según contrato;
- cero proveedor externo.

### R6 — un solo código, conservado

`no_matching_evidence` sigue siendo único, y **la metadata distingue de forma
inequívoca** los dos casos: dentro de ese código, `inspected.total === 0` es
«no había nada indexado» y `> 0` es «había pasajes y ninguna afirmación quedó
fundamentada». El defecto real era la **prosa**, que contradecía a
`inspected.total`; se corrigió el texto, no el contrato. La unión no se
ensanchó porque la consumen otras líneas.

### R7 — piso de dos fuentes, provisional

Se conserva `DEFAULT_MIN_DISTINCT_SOURCES: 2` **provisionalmente**, con los
seis escenarios de `r7.test.ts` probando el comportamiento. **No se declara
calibración óptima**: no existe conjunto etiquetado. Los seis casos quedan como
referencia fija para la próxima pasada de calibración.

### R8 — vocabulario canónico en la frontera

**Decisión de integración:** en la frontera del server action el vocabulario
canónico es **`GroundingOrchestrationClassification`** (6 miembros).
`GroundedOutcomeKind` (5) es la decisión del constructor de respuestas y **no
se lee** en esa frontera — leer ambos sería el comienzo de un tercer
vocabulario, y no se creó ninguno.

El mapeo es **uno solo**: `CLASSIFICATION_IS_ANSWERABLE`, un
`Record<GroundingOrchestrationClassification, boolean>` en
`app/actions/stella/grounded-query.ts`, exhaustivo por construcción (tsc
rechaza una clave faltante). Product no aprende ninguno de los dos: recibe
`StellaGroundedQueryResult`, cuyo éxito lleva `GroundedAnswerView.status` y
cuyo error lleva la taxonomía de 12 códigos ya existente. Fijado por prueba en
`runtime-grounded-query.test.ts` §6.

### Contratos abiertos hacia esta línea

- **INT-GR-001** — se pide una función `STABLE` sin lock para resolver la
  versión activa en scope; hoy la única gobernada
  (`claim_active_document_version`) toma `FOR UPDATE` sobre la fila de
  evidencia, que es correcto para ingesta y caro para lectura.
- **INT-GR-002** — A-F1 sigue abierto: `validateAnswerCitations` compara sólo
  `organizationId`. El tren 3 **no lo cierra**; lo compensa declarando
  `project_id` explícitamente en el adaptador y una segunda vez dentro de
  `chunks_in_scope`, porque la policy RLS de `evidence_document_versions` es
  org-scoped y no project-scoped.

## Tren 4 — ingesta orquestada y generador extractivo (2026-08-05)

`STELLA_GROUNDING_LOCAL_END_TO_END_TRAIN_4`. Dos commits, sin push, sin acceso
remoto, sin gates pesados. HEAD inicial `6f3c543`.

El objetivo era cerrar las dos piezas que faltaban para un recorrido local
real: **orquestación de ingestión conectable a persistencia** y **un generador
fundamentado determinista, ejecutable y no simulado**. Proveedor generativo
real, embeddings remotos, pgvector y calibración quedan fuera por instrucción.

### Orquestador de ingestión

`lib/grounding/ingest/orchestrate-ingestion.ts` compone:

```
bytes -> claim histórico -> ingestDocument (extract, normalize, version,
chunk, scan) -> register version -> insert chunks -> finalize
```

No inventa ninguna etapa de pipeline: extracción, normalización, versionado,
troceado y escaneo siguen dentro de `ingestDocument`, sin tocar. Lo que añade
es el **orden**, la consulta de historia que `ingestDocument` se niega
deliberadamente a inventar, y el vocabulario de fallo.

**Interfaz de persistencia** — `lib/grounding/ingest/persistence.ts`,
`GroundingIngestionRepository`, cuatro operaciones que mapean **uno a uno**
contra la superficie gobernada de `grounding_0002` + `grounding_0003`:
`claimActiveDocumentVersion`, `registerDocumentVersion`,
`insertEvidenceChunks`, `finalizeDocumentIngestion`. Cuatro y no cinco porque
una quinta no sería implementable sin escribir SQL fuera del paquete.

Propiedades sostenidas:

- **scope obligatorio** (`assertValidScope` primero; una violación **lanza**);
- **el scope es expectativa aquí, nunca argumento allá.**
  `register_document_version` deriva organización y proyecto de
  `evidence_items` y se niega a aceptarlos.
  `RegisterDocumentVersionRequest.scope` existe para que un adaptador pueda
  reimponer localmente esa creencia, y el contrato prohíbe reenviarlo;
- `evidenceId`, MIME type y las **cuatro versiones de pipeline** estampadas;
- `chunk_id` **derivado con `deriveChunkId`**, la función del contrato, porque
  `insert_evidence_chunks` lo re-deriva en servidor con la misma preimagen y
  lanza U0104 ante cualquier desacuerdo. Una plantilla escrita a mano
  compilaría y fallaría en la base;
- **idempotencia y reingesta**: bytes idénticos convergen. Un replay
  re-registra (idempotente), reofrece los chunks (`ON CONFLICT DO NOTHING`
  inserta sólo los que falten) y re-finaliza (asserta el conteo). No es un
  no-op y no se reporta como tal: **es la ruta de reparación** de una ingesta
  que murió entre la escritura y el finalize;
- **error tipado** — `GroundingPersistenceError` con seis clases mapeadas a los
  SQLSTATE del paquete (U0100…U0104 y «cualquier otro» a `unavailable`). La
  tabla de mapeo vive en el contrato, no en el adaptador, para que las dos
  mitades de la frontera no puedan divergir;
- **cero imports desde la capa de base de datos**, verificado por prueba.

**Ninguna persistencia parcial silenciosa.** Todo fallo devuelto nombra la
etapa y **qué había quedado escrito** cuando ocurrió: `ref` no nulo en cuanto
la fila de versión existe, `insertedChunkCount` no nulo en cuanto el escritor
respondió. Y no hay catch-all que convierta un fallo de escritura en `skipped`
— saltar es una afirmación sobre el **documento**, fallar al escribir es una
afirmación sobre el **sistema**.

**Deriva de pipeline detectada antes de la escritura.** Si la versión activa
tiene el mismo `versionId` bajo otro extractor, otra normalización, otro
chunker o con otro hash normalizado, el orquestador falla en
`register_version` **sin llamar a `register_document_version`** y **nombra qué
hecho cambió**. La función gobernada levantaría U0101 con un mensaje que no
nombra ningún campo — deliberadamente, porque un error devuelto a un llamante
no confiable es un oráculo. De este lado de la frontera no hay tal restricción
y el operador necesita saber cuál cambió: una subida de normalización invalida
todos los offsets almacenados, una de extractor invalida el texto pero no el
espacio de coordenadas, y se reparan distinto.

### Generador extractivo

`lib/grounding/retrieve/extractive-generator.ts`.

- **Nombre y versión explícitos**: `grounding-local-extractive`,
  `extractive-1`, id `grounding-local-extractive/extractive-1`.
- Consume **únicamente `RetrievalCandidate` reales**; construye afirmaciones
  `evidence` citando los chunks de los que cortó el texto.
- `CitationReference` válidas por construcción: `buildGroundedAnswer` ya lee
  `quotedTextHash`, `versionId` y `location` **del chunk recuperado**, nunca
  del draft. El generador aporta prosa y `chunkIds`, y nada más.

**La invariante**, que es lo que hace segura toda la pieza:

> Toda afirmación emitida, quitadas sus comillas, es **subcadena exacta** del
> texto de al menos uno de los chunks que cita.

Comprobada por prueba, no afirmada en prosa. Porque una afirmación sólo puede
ser un corte de un pasaje recuperado:

- **no puede inventar causalidad** — no hay dónde escribir un «porque»;
- **no puede calcular un SROI, una razón ni ninguna cifra** que el documento no
  enuncie ya — la aritmética no tiene canal de salida. Fijado con el CSV de
  municipios: `0.77` es el promedio de `0.81`, `0.76` y `0.74`, no aparece en
  ningún documento y por tanto no puede aparecer en la respuesta;
- **no puede aprobar una metodología ni certificar un impacto** — una
  aprobación es una frase que ningún documento de evidencia contiene sobre esta
  petición;
- una cita no puede desligarse de su afirmación, porque la afirmación se cortó
  del texto citado.

**Abstención frente a fallo operativo.** Sin nada que fundamentar devuelve
**cero afirmaciones** y `buildGroundedAnswer` lo convierte en abstención.
**Nunca lanza por falta de evidencia** — un throw se convierte en
`provider_unavailable`, y lanzarlo cuando la evidencia simplemente calla le
diría a un revisor que el sistema se rompió cuando lo que pasó es que su
corpus no cubre la pregunta. Sólo lanza ante una violación de scope, que es un
defecto de composición.

**Contradicciones sólo desde markers.** El generador **no las detecta nunca**.
Decidir que dos pasajes no pueden ser ambos ciertos es un juicio semántico, y
un extractor léxico haciéndolo estaría inventando exactamente lo que este
módulo existe para evitar — dos documentos con cifras distintas pueden estar
midiendo cosas distintas. Llegan como `DeclaredContradiction` explícitas que
nombran dos `chunkId`, y el generador sólo las transporta;
`buildGroundedAnswer` exige independientemente que **ambos** lados resuelvan.
Probado en las dos direcciones: dos fuentes con 78 % y 62 % **no** producen
contradicción, y un marker declarado sí, atribuido a las dos afirmaciones que
citaron cada lado.

**Limitaciones, dichas sin adorno.** No es equivalente a un modelo generativo y
no debe presentarse como tal. No sintetiza, no resume, no compara, no traduce y
no responde a una pregunta cuya respuesta no esté literalmente escrita en uno
de los pasajes recuperados. Preguntado «¿por qué cayeron los resultados en
Q3?», devuelve las frases que mencionan resultados y Q3 — no una razón.

**No es un fallback.** No debe seleccionarse porque falle la base, falte el
paquete SQL, falle la autorización o lance el repositorio: son fallos
operativos, y responderlos con citas de una recuperación vacía o parcial
presentaría una avería del sistema como un hallazgo de evidencia. Es una
estrategia **explícita**, elegida por configuración, y es el **valor por
defecto** de `runGroundedQuery`.

### Atestación de scope (INT-GR-004)

`ChunkScopeAttestation` / `UnattestedChunkScope` en
`lib/grounding/retrieve/repository.ts`, más
`enforceRepositoryScope(repo, { requireScopeAttestation })`. El detalle y —lo
más importante— **lo que el tipo no demuestra** están en
[la respuesta a INT-GR-004](../contracts/INT-GR-004_scope_attestation_response.md).
Resumen: no prueba procedencia, hace el hueco **irrepresentable por silencio**,
y no se añadió ninguna cuarta comprobación decorativa.

### Recorrido de consulta

`lib/grounding/retrieve/grounded-query.ts`, `runGroundedQuery`. Compone
repositorio, retrieval, generador extractivo (por defecto), validación de
citas y clasificación, y **no define ningún vocabulario nuevo**: devuelve
`GroundingOrchestrationResult` tal cual y añade un solo campo, `provenance`,
porque «¿qué generador escribió esto?» es una pregunta que los tipos
existentes genuinamente no podían responder.

Conservado y fijado por prueba: R6 (un código, `inspected.total` separa los dos
casos), R7 (piso de dos fuentes, **provisional y sin calibrar**, reportado en
`provenance.minDistinctSources` en vez de asumido), R8 (una sola taxonomía),
contradicción atribuida, `provider_unavailable` separado de la falta de
evidencia, errores de scope **relanzados** —ahora también los que lance el
generador—, errores operativos degradados.

### INT-GR-001…004

| Contrato | Estado tras el tren 4 | Respuesta |
|---|---|---|
| INT-GR-001 | Parcialmente resuelto; SQL pendiente de CAPABILITIES | [respuesta](../contracts/INT-GR-001_active_document_version_read_response.md) |
| INT-GR-002 | **Ya resuelto en HEAD** — cerrado en `8b8693e`, antes del tren 3 | [respuesta](../contracts/INT-GR-002_project_isolation_response.md) |
| INT-GR-003 | Decidido por GROUNDING (persistir); dos columnas pendientes de CAPABILITIES | [respuesta](../contracts/INT-GR-003_chunk_location_line_range_response.md) |
| INT-GR-004 | Contrato preparado; dos columnas pendientes de CAPABILITIES | [respuesta](../contracts/INT-GR-004_scope_attestation_response.md) |

**Corrección al registro del tren 3.** La sección
«[Contratos abiertos hacia esta línea](#contratos-abiertos-hacia-esta-línea)»
de este documento —escrita por integración— afirma que A-F1 sigue abierto y que
`validateAnswerCitations` compara sólo `organizationId`. Eso dejó de ser cierto
en `8b8693e`, que es antepasado de `6f3c543`. Esta línea no reescribe el
registro histórico del tren 3, que es de integración; lo señala aquí y en la
respuesta a INT-GR-002.

### Pruebas ejecutadas

Sólo focalizadas, según §11 (ningún gate pesado, ni `test:unit` completo, ni
`build`):

```
pnpm exec vitest run lib/grounding/  → 18 archivos, 343 pruebas, todas en verde
pnpm exec tsc --noEmit               → limpio (proyecto completo)
pnpm exec eslint lib/grounding       → limpio, cero avisos
```

De las 343, **72 son nuevas** de este tren: 21 de orquestación de ingestión
(dos formatos, MIME no soportado, documento vacío, reingesta idéntica, versión
nueva, cambio de extractor, cambio de normalización, hash movido sin subida de
versión, cuatro rutas de persistencia parcial, identidad de chunk determinista,
deduplicación, frontera de scope, cero acceso a la capa de base de datos), 17
del generador (fuente única, varias fuentes corroborantes, fuentes discordantes
sin contradicción inventada, marker declarado, marker con lado no recuperado,
dos ramas de R6, CSV, sin aritmética, determinismo, cero proveedor, scope), 15
de atestación de scope y 19 del recorrido completo.

**Documentos de prueba, no respuestas preconstruidas.** `__tests__/corpus.ts`
contiene documentos —un informe, una nota de auditoría, un consolidado
regional, un CSV, un memorando ajeno— y cada prueba los **ingiere de verdad**
con el pipeline real antes de preguntar. `__tests__/fixtures.ts` (chunks a
mano) sigue existiendo donde el chunk **es** el fixture, que es lo correcto
para una prueba de retrieval que coloca un pasaje concreto en un scope
concreto.

`__tests__/ingestion-repository-double.ts` es un doble de la **base de datos**,
no del código bajo prueba: reproduce las garantías de `grounding_0002` y
`grounding_0003` (idempotencia, U0101, re-derivación de `chunk_id` con U0104,
`ON CONFLICT DO NOTHING`, aserción de conteo con U0103) para que una prueba que
pasa aquí pasara allí. No modela RLS, roles ni locks: no se pueden recrear en
TypeScript, y un doble que fingiera hacerlo dejaría afirmar una garantía que
esta capa no da.

**Cero datos simulados en runtime**, verificado por prueba: ningún módulo bajo
`lib/grounding/` fuera de `__tests__` importa un fixture de prueba, la capa de
base de datos o Supabase.

### Riesgos

- **R1 — persistencia bloqueada.** Cambia de forma: el orquestador y el puerto
  existen y están probados, pero `grounding_0002` / `grounding_0003` **no están
  aplicados en ninguna base**, así que el recorrido de ingestión no se ha
  ejecutado nunca contra Postgres. Lo que hoy está probado es que el pipeline y
  el contrato son correctos frente a las garantías declaradas del paquete.
- **R2 — cobertura de formatos.** Sin cambio: `text/plain` y `text/csv`. PDF,
  XLSX y DOCX siguen tras la decisión G5.
- **R3 — calibración del escáner.** Sin cambio.
- **R4 — umbrales sin calibrar.** Sin cambio, y **el generador añade dos más**:
  `minTermMatches` (1) y `maxSentencesPerClaim` (2). Ambos declarados de
  primera pasada y sin medir, como sus vecinos. No existe conjunto etiquetado.
- **R5 — sin cableado al pipeline.** Más pequeño y todavía abierto. Ya existen
  las dos piezas que faltaban; lo que queda es cableado de aplicación
  (INTEGRATION): montar `ingestEvidenceDocument` en la subida de evidencia y
  sustituir `absentAnswerDraftProvider` por el generador extractivo, si PRODUCT
  decide que la estrategia local es aceptable para el tren.
- **R6** cerrado como decisión provisional, sin cambio.
- **R7** abierto por diseño, sin cambio. Cierra con evals.
- **R8** resuelto en la frontera del server action por integración. Esta línea
  no añadió taxonomía.
- **R9 — nuevo. La estrategia extractiva puede confundirse con una respuesta.**
  Un lector que ve prosa entrecomillada y una cita puede leerla como una
  respuesta a su pregunta cuando es la frase más cercana a sus términos. La
  mitigación estructural existe (comillas angulares, `requiresHumanReview`
  literal, la invariante de subcadena), pero **la mitigación de producto no**:
  la UI no dice todavía «esta respuesta es un extracto, no una síntesis». Es
  una decisión de PRODUCT, no de esta línea.

### Estado de entrega a integración

**Listo para integración.** Árbol limpio, dos commits locales, sin push, sin
acceso remoto, sin llamadas a proveedor, sin datos simulados en runtime, sin
gates pesados. Ninguna ruta prohibida (`db/**`, `supabase/**`, `components/**`,
server actions INTEGRATION-OWNED) fue modificada; el diff completo vive bajo
`lib/grounding/**` más las cuatro respuestas de contrato y este documento.

**Peticiones a integración:**

1. **Mover la fila de INT-GR-002** a resuelto, citando `8b8693e`, y corregir la
   prosa del registro del tren 3.
2. **Enlazar las cuatro respuestas** desde `CONTRACT_LEDGER.md`. Esta línea no
   toca el ledger.
3. **Reenviar a CAPABILITIES** las dos peticiones de SQL que quedan: las dos
   columnas de `chunks_in_scope` (INT-GR-004) y las dos de `evidence_chunks`
   (INT-GR-003). Ambas son de una línea cada una y ambas convierten una
   comprobación decorativa o un centinela en algo portante.
4. **Decidir con PRODUCT** si la estrategia extractiva local se enciende en
   este tren, y con qué texto en la UI (R9). El cambio de código es sustituir
   `absentAnswerDraftProvider` por `createExtractiveAnswerProvider()`, o llamar
   directamente a `runGroundedQuery`, que ya la trae por defecto.
