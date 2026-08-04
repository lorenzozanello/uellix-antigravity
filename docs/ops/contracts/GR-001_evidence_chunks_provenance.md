# GR-001 — Columnas de provenance y versionado en `evidence_chunks`

| Campo | Valor |
|---|---|
| Solicitante | GROUNDING (`codex/stella-grounding`) |
| Propietario | CAPABILITIES (`codex/stella-capabilities`) |
| Estado | solicitado |
| Fecha | 2026-08-04 |
| Origen | unidad `STELLA_GROUNDING_INGESTION_CORE_TRAIN_1` |

## 1. Qué existe hoy

`db/prepared/grounding_0001_evidence_chunks.sql` (preparado, **no aplicado**,
gate G2) define `public.evidence_chunks` con:

```
id, organization_id, evidence_id, chunk_index, content, content_hash,
page, char_start, char_end, embedding vector(384) NULL, created_at
```

Su guarda de forma (§0c del script) **aborta** si la tabla existe con columnas
faltantes, así que ampliar la forma es una edición del script preparado — ruta
de propiedad exclusiva de CAPABILITIES. GROUNDING no la ha tocado.

## 2. Qué necesita el núcleo de ingestión

El contrato TypeScript publicado en esta unidad
(`lib/grounding/contracts/`, ver `ProvenanceRecord` y `GroundingChunk`) produce
por cada chunk una cadena de verificación completa. Persistirla requiere seis
columnas que la forma actual no tiene. Sin ellas, la tabla puede almacenar
chunks pero **no puede responder si un chunk sigue siendo válido**.

| Columna propuesta | Tipo | Nulo | Por qué |
|---|---|---|---|
| `chunk_id` | `char(64)` | NO | Identidad direccionada por contenido, derivada de `(version_id, chunk_index, content_hash)`. Es lo que cita una respuesta de Stella. Hoy la PK es un uuid aleatorio, que no puede recomputarse desde el archivo sellado y por tanto no sirve como ancla de cita verificable. Añadir como columna + índice único; la PK uuid puede quedarse. |
| `version_id` | `char(64)` | NO | Identidad del estado de bytes del documento, derivada de `(evidence_id, raw_content_hash)`. Sin ella, dos ingestas del mismo archivo editado son indistinguibles en la tabla. |
| `raw_content_hash` | `char(64)` | NO | SHA-256 de los bytes originales, el mismo que sella `lib/pipeline/evidence.ts`. Cierra la cadena archivo → texto → ancla → pasaje. |
| `normalized_content_hash` | `char(64)` | NO | SHA-256 del texto normalizado. **`char_start`/`char_end` sólo tienen sentido contra este texto**: sin esta columna, un ancla producida bajo una versión de normalización puede resolverse silenciosamente contra otra, con offsets válidos apuntando al pasaje equivocado. Es el hueco más grave de la forma actual. |
| `normalization_version` | `varchar(32)` | NO | `'norm-1'` hoy. Un cambio invalida todos los offsets almacenados. |
| `chunker_version` | `varchar(32)` | NO | `'chunk-1'` hoy. Un cambio invalida las fronteras, no el espacio de coordenadas. |

### 2.1 Aislamiento (recomendado, no bloqueante)

| Columna | Tipo | Nulo | Por qué |
|---|---|---|---|
| `project_id` | `uuid` | SÍ | `GroundingScope` es `(organizationId, projectId)`. `project_id` es alcanzable por join contra `evidence_items`, así que esto es desnormalización deliberada: el mismo doble cinturón (RLS + filtro explícito) que ya usa el resto del pipeline, aplicado también al nivel de proyecto. Nulo = evidencia de alcance organizacional. |

### 2.2 Señales de inyección (recomendado)

| Columna | Tipo | Nulo | Por qué |
|---|---|---|---|
| `signals` | `jsonb` | NO, default `'[]'` | `PromptInjectionSignal[]` del chunk. Persistirlas evita reescanear en cada consulta y, más importante, permite auditar qué se cuarentenó y por qué. Alternativa aceptable: tabla `evidence_chunk_signals` aparte si se prefiere no meter jsonb en la tabla caliente. |
| `injection_scanner_version` | `varchar(32)` | NO | `'inj-1'` hoy. Permite identificar chunks escaneados con un escáner viejo y reescanearlos **sin re-extraer el documento**. |

### 2.3 Embeddings (una columna, no una tabla)

| Columna | Tipo | Nulo | Por qué |
|---|---|---|---|
| `embedding_provider_id` | `varchar(64)` | SÍ | La columna `embedding vector(384)` ya está prevista, pero sin registrar **qué proveedor** la produjo un cambio de proveedor es indetectable: el índice queda mezclando dos espacios vectoriales incomparables y el bug se manifiesta como "el retrieval empeoró", no como un error. Nulo mientras `embedding` sea nulo. |

## 3. Deduplicación

Constraint solicitada:

```sql
UNIQUE (evidence_id, version_id, content_hash)
```

La deduplicación por hash ya ocurre en memoria (`chunkNormalizedDocument`), y
es **por versión de documento**, nunca entre evidencias distintas: dos subidas
con el mismo anexo son dos piezas de evidencia y ambas deben poder citarse por
separado. La constraint hace que esa regla sobreviva a un reindex parcial o a
una escritura concurrente.

Nota: `chunk_index` **tiene huecos por diseño** donde se suprimió un duplicado.
Cualquier constraint o comprobación que asuma índices contiguos fallará.

## 4. Fuera de alcance de esta solicitud

- No se solicitan índices vectoriales ni `CREATE EXTENSION vector`: la decisión
  pgvector-vs-léxico es el gate G5 P3 y esta unidad no la toca.
- No se solicita `line_start`/`line_end`: son derivables del texto y el span, y
  almacenarlos sería duplicar estado que puede desincronizarse.
- No se solicita `section_label`: el núcleo no inventa etiquetas de sección
  (una marca de página dice dónde empieza una página y nada más).

## 5. Criterio de aceptación

GROUNDING considera el contrato aceptado cuando `db/prepared/` contiene una
forma de `evidence_chunks` que incluye al menos las seis columnas de §2, y su
guarda de forma las exige. Las secciones §2.1–§2.3 son recomendadas: su
ausencia no bloquea la persistencia, pero cada una convierte un fallo detectable
en un fallo silencioso.

## 6. Decisión de integración

_Pendiente._
