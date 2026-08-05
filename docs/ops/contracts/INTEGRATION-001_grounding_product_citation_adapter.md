# INTEGRATION-001 — Adaptador de citas GROUNDING → PRODUCT

**Línea solicitante:** INTEGRACIÓN
**Línea propietaria:** PRODUCT (implementación, tren 2)
**Estado:** `aceptado` (integración, tren 2, 2026-08-04). El entregable existe:
[`components/stella/grounding-adapter.ts`](../../../components/stella/grounding-adapter.ts),
verificado en el HEAD integrado con 331 pruebas focalizadas de
`components/stella` en verde. La única condición que quedaba abierta al
aceptarlo —la doble definición de umbrales— la resolvió integración y está
registrada en §6-bis.
**Resuelve:** [PRODUCT-001](PRODUCT-001_grounded-citation-provenance.md) →
`aceptado`

## Por qué existe esta decisión

PRODUCT y GROUNDING entregaron el mismo día, en worktrees separados, sin
verse. Ambas describieron "una cita fundamentada":

- **PRODUCT-001** pidió a GROUNDING un `GroundingCitation`
  (`documentId` / `excerpt` / `location: string` / `relevance: 'high'|'medium'|'low'`)
  y un `GroundingContradiction`.
- **GROUNDING** publicó, en `lib/grounding/contracts/`, un
  [`CitationReference`](../../../lib/grounding/contracts/answer.ts)
  (`chunkId` / `evidenceId` / `versionId` / `location: ChunkLocation` /
  `quotedTextHash`) y un `ContradictionMarker`.

No son la misma forma, y **no son dos propuestas entre las que integración
deba elegir por gusto**. Son dos niveles distintos: PRODUCT describió qué
necesita pintar en pantalla; GROUNDING describió qué hace verificable una
cita. La segunda es más estricta y contiene a la primera. Elegir la de
PRODUCT como forma canónica destruiría propiedades que la de GROUNDING
existe para garantizar; elegir la de GROUNDING sin adaptador deja a PRODUCT
sin nada que renderizar.

Por eso la resolución no es "gana una", sino: **una es canónica, la otra se
deriva de ella por una función pura**.

## Decisión

### 1. `lib/grounding/contracts/**` es la fuente técnica canónica de provenance

El barrel [`lib/grounding/contracts/index.ts`](../../../lib/grounding/contracts/index.ts)
es la superficie publicada. PRODUCT consume desde ahí y no importa desde
`lib/grounding/ingest/**` ni desde los archivos de contrato individuales.

**Canónica no significa única: hoy hay otras tres nociones de «de dónde vino
esta afirmación» en el árbol, y la revisión de integración las localizó.**
Enumerarlas es parte de la decisión, porque leer «es la fuente canónica» como
«es la única» es exactamente el error que haría daño:

1. `components/stella/grounding-model.ts` — `EvidenceReference`
   (`sourceField` + `label`), construida desde
   `AdvisorContextualOutput.sourceFields`. Es **presentación derivada de la
   salida del advisor**, no de `CitationReference`, y la §2 la permite
   mientras no se persista. El adaptador del tren 2 es lo que la reconcilia.
2. `lib/stella/context/decode-provider-source-ref-indexes.ts` — decodifica
   índices de referencia del proveedor a rutas canónicas. Es la vía por la que
   el advisor de hoy dice de dónde salió una afirmación, y seguirá existiendo
   mientras el advisor no consuma retrieval.
3. **`db/prepared/grounding_0001_evidence_chunks.sql` — y ésta es la
   peligrosa.** Es un paquete **preparado y no aplicado** que persiste
   `content_hash`, `page`, `char_start`, `char_end` **sin**
   `normalized_content_hash`, `version_id`, `chunk_id` ni versiones de
   pipeline. GR-001 §1 ya lo nombra como el hueco más grave de la forma
   actual.

   **Consecuencia operativa, dirigida a CAPABILITIES tren 2:** aplicar
   `grounding_0001` tal cual para desbloquear la persistencia de GROUNDING
   **no** satisface GR-001. Los offsets quedarían anclados sin espacio de
   coordenadas, y un cambio de `NORMALIZATION_VERSION` los re-resolvería
   contra un texto distinto — offsets en rango, pasajes equivocados, sin
   error. Es el fallo silencioso que `normalizedContentHash` existe para
   impedir. GR-001 debe resolverse **modificando** esa forma, no aplicándola.

### 2. La presentación de PRODUCT no persiste una segunda forma de provenance

`components/stella/grounding-model.ts` puede modelar lo que necesite para
pintar, pero ese modelo es **derivado y efímero**: no se escribe en base de
datos, no se serializa a una API pública como si fuera el registro de origen,
y no se acepta como entrada para reconstruir una cita.

La razón es concreta: `CitationReference` no lleva el texto de la cita, lleva
`quotedTextHash` — el SHA-256 del texto del chunk. Un `excerpt` persistido
junto a la cita es un segundo registro del mismo hecho que **puede divergir
del hash** (por una re-normalización, un truncado distinto, una corrección
editorial). En el momento en que diverge, el sistema tiene dos respuestas a
"¿qué dice el documento?" y la que un auditor lee en pantalla es la que no
está verificada. Un único registro que puede estar equivocado es un bug; dos
registros que se contradicen es un problema de credibilidad.

### 3. El tren 2 implementa un adaptador **puro**

Ubicación prevista: `components/stella/grounding-adapter.ts` (línea PRODUCT).
Sin I/O, sin acceso a base de datos, sin llamadas a proveedor. Entrada:

- `GroundingChunk`
- `ChunkLocation`
- `CitationReference`
- `RetrievalCandidate`

Salida: el modelo de presentación de PRODUCT.

No se implementa en esta integración: PRODUCT compila y sus pruebas pasan sin
él, así que la excepción "sólo si es estrictamente necesario para compilar" no
aplica. Escribirlo aquí sería añadir código de producto en un commit de
integración.

### 4. `excerpt` se deriva de `GroundingChunk.text`

No de `CitationReference`, que no lo lleva. El adaptador recibe el chunk, toma
`text`, y trunca para presentación. El truncado es una decisión de UI y **no
altera `contentHash`**: el hash sigue siendo el del texto completo del chunk.

Corolario: una cita que sólo tiene `CitationReference` y no su
`GroundingChunk` **no puede mostrar excerpt**. La UI debe poder representar
ese caso (cita verificable sin pasaje cargado) en vez de inventar un texto.

### 5. `location` se renderiza desde `ChunkLocation`, que no se aplana a texto

`ChunkLocation` es estructurado (`span`, `coordinateSpace`, `page`,
`sectionIndex`, `sectionLabel`, `lineStart`, `lineEnd`) y lo dice
explícitamente en su propia documentación: **el `span` es la autoridad, el
rango de líneas es derivado y para humanos**.

PRODUCT-001 pedía `location: string`. El adaptador puede producir esa cadena
("p. 4, líneas 12–18") **para mostrarla**, pero:

- la cadena nunca vuelve a entrar al sistema como ubicación;
- nada se re-resuelve parseándola;
- `coordinateSpace` (el hash del texto normalizado contra el que el `span`
  indexa) no se descarta al construirla — es lo que impide que un offset
  válido apunte al pasaje equivocado tras un cambio de versión del pipeline
  de normalización.

Convertir la ubicación estructurada en la fuente de verdad textual es
exactamente el fallo silencioso que `normalizedContentHash` existe para
prevenir (ver [GR-001](GR-001_evidence_chunks_provenance.md)).

### 6. `relevance` visual se deriva del score, con umbrales definidos y probados

`RetrievalCandidate.score` es un número, y su propio contrato advierte que es
**comparable sólo dentro de una consulta y una estrategia**. PRODUCT pidió
`'high' | 'medium' | 'low'`.

El adaptador puede producir esos buckets, con la condición de que:

- los umbrales estén declarados como constantes nombradas, no incrustados;
- tengan pruebas focalizadas, incluyendo los valores exactamente en el borde;
- el `score` original y la `strategy` viajen junto al bucket, no se sustituyan
  por él.

El bucket es una ayuda de lectura. Descartar el score dejaría al sistema sin
forma de recalibrar umbrales sobre datos históricos, y sin forma de detectar
que una estrategia de retrieval cambió de escala.

Nota abierta: `DEFAULT_RETRIEVAL_MIN_SCORE` (0.15) es un marcador de posición
declarado por GROUNDING (riesgo R4), no un valor calibrado — no hay
implementación de retrieval con la que medirlo. Los umbrales del adaptador
heredan esa incertidumbre y deben revisarse cuando exista una.

### 6-bis. Resolución de la divergencia de umbrales (integración, tren 2)

El tren 2 entregó **dos** clasificaciones de relevancia, publicadas el mismo día
sin verse, exactamente como había pasado con la forma de la cita:

| | Umbral `high` | Umbral `medium` | Versión |
|---|---|---|---|
| GROUNDING (`lib/grounding/retrieve/calibration.ts`) | `>= 0.4` | `>= 0.2` | `grounding-relevance-2026-08-local-1` |
| PRODUCT (`components/stella/grounding-adapter.ts`) | `>= 0.6` | `>= 0.3` | `product-relevance-v1` |

No es una diferencia cosmética. Un score de **0.42** —el que la propia prueba de
PRODUCT usaba como caso principal— era `medium` para PRODUCT y `high` para
GROUNDING. El sistema tenía dos respuestas a «cuán relevante es este pasaje» y
la que un auditor leía en pantalla no era la que quedaría registrada junto al
score. Es el mismo fallo de credibilidad que §2 prohíbe para la provenance,
aplicado a la clasificación.

**Decisión: GROUNDING es la fuente única.** Concretamente:

1. `RELEVANCE_THRESHOLDS` y `RELEVANCE_THRESHOLDS_VERSION` de
   `lib/grounding/retrieve/calibration.ts` son canónicos. PRODUCT los
   **reexporta**; no los redefine.
2. `RELEVANCE_HIGH_MIN_SCORE` y `RELEVANCE_MEDIUM_MIN_SCORE` de PRODUCT quedan
   **retirados**, también del barrel `components/stella/index.ts`.
3. `relevanceBucket` de PRODUCT pasa a ser una delegación fina: no contiene
   ninguna comparación ni ningún número propio. Lo único que añade es el **tipo
   de error** (`GroundedCitationError`), porque un panel necesita distinguir un
   fallo de datos de un fallo de render. Traducir el fallo no es reclasificar la
   evidencia.
4. `CitationRelevanceBucket` pasa a ser un **alias** de `RelevanceBucket` de
   GROUNDING, no una unión paralela de tres literales: la unión duplicada
   compilaría el día que GROUNDING añadiera un cuarto bucket, y el adaptador
   estrecharía en silencio un valor que le fue entregado.
5. La UI conserva toda su libertad sobre **lenguaje, icono e intensidad
   visual**; pierde la de cambiar **a qué bucket cae un score**.
6. Los umbrales siguen declarados como **calibración local provisional, no
   óptima** — ver la cabecera de `calibration.ts`, que lo dice como estado y no
   como descargo. Recalibrar ahora es editar un archivo, no dos que puedan
   divergir.

#### Efecto colateral aceptado: el borde se endurece

`relevanceBucket` de GROUNDING **lanza** ante un score fuera de `[0, 1]`; el de
PRODUCT sólo rechazaba `NaN` y devolvía `high` para `1.5`. Al consumir el
canónico, PRODUCT hereda el rechazo. Es deseable: un score fuera de escala
significa que el scorer cambió y los umbrales no, y devolver `high` dejaría que
un retrieval descalibrado se viera confiado.

#### La excepción de import, y por qué es segura

El adaptador importa `@/lib/grounding/retrieve/calibration` **como valor**, no
como tipo, y **en profundidad**, no por el barrel de `retrieve`. Ambas cosas son
excepciones a §1 y a la regla de pureza, y ambas están medidas:

- El barrel `lib/grounding/retrieve/index.ts` reexporta el repositorio, el
  scorer y `buildGroundedAnswer`, que alcanzan `contracts/core.ts` — que importa
  `node:crypto` a nivel de módulo. Importarlo como valor metería Node crypto en
  el bundle de cliente de toda página que monte un panel de Stella. El barrel es
  **hostil al cliente**; no es una preferencia de estilo.
- `calibration.ts` es una **hoja**: sus dos únicos imports son `import type`, así
  que se borra en transform a un módulo sin dependencias. Esa propiedad es lo que
  hace segura la excepción, y por eso está fijada por su propia prueba
  (`imports a LEAF: calibration.ts must itself have zero runtime imports`): el día
  que alguien le añada un import de runtime, la excepción deja de ser segura
  **ruidosamente**.

#### Pruebas que impiden la regresión

En `components/stella/__tests__/grounding-adapter.test.ts`, bloque
`relevance thresholds have exactly one owner`:

| Prueba | Qué rompe |
|---|---|
| identidad de constantes (`toBe`, no `toEqual`) | una copia con los mismos números |
| `product-relevance` / `RELEVANCE_*_MIN_SCORE` ausentes del **código** (no de los comentarios) | resucitar los nombres retirados, en el módulo o en el barrel |
| cero literales numéricos junto a `high`/`medium`/`low` en **todo** `components/stella/**` | un umbral incrustado en cualquier panel, no sólo en el adaptador |
| `adaptRelevance` sin comparación ni literal de bucket propios | reimplementar la clasificación con números que hoy coincidan por accidente |

La tercera y la cuarta son estructurales a propósito: una prueba de
comportamiento seguiría verde el día que alguien reimplemente la comparación con
números que casualmente coincidan, y volvería a haber dos fuentes de verdad sin
que nada lo dijera.

### 7. `contradiction` proviene de `ContradictionMarker`, nunca de la UI

`ContradictionMarker` lleva `sideA` y `sideB` como tuplas **no vacías** de
`CitationReference`, `resolution: 'requires_human_resolution'` como literal
único y `severity: 'warning'`.

Ningún componente de `components/stella/**` debe inferir una contradicción
comparando textos, puntuaciones o etiquetas. `EvidenceSupportLevel:
'contradictory_evidence'` sólo debe producirse cuando existe un
`ContradictionMarker` real.

**Esta regla hoy no está aplicada por nada más que este documento, y decirlo
importa.** El estado del árbol es: ningún mapper de `grounding-model.ts`
fabrica `'contradictory_evidence'`, `components/**` no importa nada de
`lib/grounding/**`, y `StellaGroundingBadge` recibe `level` como prop libre
sin validación. Es decir, la regla se cumple **por ausencia de código**, no
por un tipo ni por un guard: un mapper de tren 2 que dedujera la
contradicción de dos `sourceFields` opuestos compilaría, renderizaría el
badge rojo y pasaría CI.

**Obligación del tren 2, no opcional:** el adaptador debe ser el *único*
productor de `'contradictory_evidence'`, y debe llevar una prueba focalizada
que falle si ese valor se alcanza sin un `ContradictionMarker` de entrada.
Hasta que esa prueba exista, esto es una convención documentada, no un
invariante.

> **Cumplido (integración, tren 2).** Ya es un invariante comprobado.
> `supportForClaim` construye `contradictedChunkIds` **exclusivamente** a partir
> de `state.contradictions`, así que ninguna otra entrada abre esa puerta: ni
> afirmaciones opuestas, ni scores divergentes, ni un `AbstentionReason` cuyo
> código se escribe igual. Las pruebas correspondientes están en
> `components/stella/__tests__/grounding-adapter.test.ts`, y con ellas se cierra
> **A-F3** del tren 1.

## Efecto sobre PRODUCT-001

`parcialmente satisfecho, pendiente de adaptador`.

- **Satisfecho:** la necesidad de provenance a nivel documento/chunk y de una
  señal explícita de contradicción está cubierta por contratos publicados y
  probados de GROUNDING.
- **Pendiente:** la forma concreta que PRODUCT pidió no existe y no se va a
  crear tal cual; llega vía el adaptador del tren 2.

## Qué NO decide este documento

- No decide dónde se persiste la provenance — eso es
  [GR-001](GR-001_evidence_chunks_provenance.md) /
  [GR-002](GR-002_document_version_history.md), pendientes de CAPABILITIES.
- No implementa retrieval. Sin retrieval real no hay `RetrievalCandidate` en
  runtime, así que el adaptador del tren 2 será verificable por pruebas antes
  de ser observable en producto.
- No habilita ninguna capacidad ni cambia ninguna bandera.
