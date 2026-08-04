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
