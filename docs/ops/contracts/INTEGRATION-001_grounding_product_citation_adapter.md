# INTEGRATION-001 — Adaptador de citas GROUNDING → PRODUCT

**Línea solicitante:** INTEGRACIÓN
**Línea propietaria:** INTEGRACIÓN (implementación: PRODUCT, tren 2)
**Estado:** `solicitado` (2026-08-04)
**Resuelve:** [PRODUCT-001](PRODUCT-001_grounded-citation-provenance.md) →
`parcialmente satisfecho, pendiente de adaptador`

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

Ningún otro módulo del árbol define una segunda noción de "de dónde vino
esta afirmación".

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

### 7. `contradiction` proviene de `ContradictionMarker`, nunca de la UI

`ContradictionMarker` lleva `sideA` y `sideB` como tuplas **no vacías** de
`CitationReference`, `resolution: 'requires_human_resolution'` como literal
único y `severity: 'warning'`.

Ningún componente de `components/stella/**` infiere una contradicción
comparando textos, puntuaciones o etiquetas. `EvidenceSupportLevel:
'contradictory_evidence'` sólo se produce cuando existe un
`ContradictionMarker` real.

Esto ya es el estado actual del árbol y es deliberado: PRODUCT documentó que
ningún mapper de `grounding-model.ts` fabrica `'contradictory_evidence'`, y
que el estado sólo es alcanzable vía fixtures. Esta decisión lo convierte de
limitación temporal en regla.

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
