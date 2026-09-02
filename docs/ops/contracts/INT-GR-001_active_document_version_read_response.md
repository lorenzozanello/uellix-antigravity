# INT-GR-001 — Lectura gobernada de versión activa (respuesta de GROUNDING, tren 4)

| Campo | Valor |
|---|---|
| Emisor | GROUNDING (`codex/stella-grounding`), tren 4 |
| Responde a | [INT-GR-001](CONTRACT_LEDGER.md#int-gr-001--lectura-gobernada-de-versión-activa-tren-3), solicitado por INTEGRACIÓN |
| Estado declarado | **`PARCIALMENTE_RESUELTO_EN_GROUNDING`** — la mitad SQL sigue abierta con CAPABILITIES |
| Fecha | 2026-08-05 |

> Este documento **no modifica `CONTRACT_LEDGER.md`**. La fila la mueve
> integración.

## 1. Qué pedía la solicitud

Una función `STABLE` sin lock, del tipo
`active_document_versions_in_scope(org, project, evidence_id[])`, porque la
única función gobernada que devuelve un `document_version_id`
—`claim_active_document_version(evidence_id)`— toma `FOR UPDATE` sobre la fila
de evidencia. Es correcta para ingesta y cara para lectura: un lock de fila por
elemento de evidencia en cada pregunta.

## 2. Qué hizo GROUNDING

**No escribió SQL.** `db/**` y `supabase/**` están fuera de las rutas
autorizadas de esta línea, y una función nueva en el esquema
`uellix_grounding` es trabajo de CAPABILITIES. Lo que sí hizo es **separar las
dos rutas en el contrato**, que es la parte de la petición que sí es de esta
línea.

`lib/grounding/ingest/persistence.ts` publica
`GroundingIngestionRepository`, un puerto con cuatro operaciones que mapean
**uno a uno** contra la superficie gobernada de `grounding_0002` +
`grounding_0003`:

| Operación del puerto | Función gobernada | Ruta |
|---|---|---|
| `claimActiveDocumentVersion` | `claim_active_document_version` | **ingesta** |
| `registerDocumentVersion` | `register_document_version` | ingesta |
| `insertEvidenceChunks` | `insert_evidence_chunks` | ingesta |
| `finalizeDocumentIngestion` | `finalize_document_ingestion` | ingesta |

Las cuatro son de ingesta, y **ninguna aparece en la ruta de lectura**. El
recorrido de consulta (`lib/grounding/retrieve/grounded-query.ts`) sólo depende
de `GroundingChunkRepository`, que no conoce versiones: recibe `versionIds`
como filtro de autorización opcional y nada más.

Consecuencia concreta: **el orquestador de ingestión es hoy el único llamador
de `claim_active_document_version` en el diseño de esta línea**, y lo llama una
vez por documento ingerido, que es exactamente para lo que el lock existe.
El adaptador de lectura de integración no necesita esa función y no debe
adquirir el hábito de usarla — no porque esté prohibido, sino porque el puerto
de lectura no la expone.

## 3. Por qué eso no cierra la solicitud

El adaptador de lectura sigue resolviendo la versión activa con un `SELECT`
directo sobre `public.evidence_document_versions`, y por tanto sigue
**duplicando la definición de «versión activa»** (`ORDER BY ordinal DESC`)
fuera del paquete que la posee. Separar las rutas evita el coste del lock; no
evita la duplicación de la definición.

## 4. Qué sigue pendiente, y de quién

**CAPABILITIES:** la función `STABLE`, sin lock, tal como la solicitud la
describe. Cuando exista, el cambio en esta línea es de una sola pieza — añadir
al contrato de lectura una operación análoga a
`claimActiveDocumentVersion` pero sin efecto de lado, y el adaptador de
integración deja de necesitar el `SELECT` directo.

**Nota sobre la forma:** `claim_active_document_version` devuelve siete
columnas y **ninguna es `organization_id` ni `project_id`**.
`ActiveDocumentVersionState` en el puerto refleja esas siete y no inventa una
octava — véase la respuesta a [INT-GR-004](INT-GR-004_scope_attestation_response.md),
que es el mismo problema en la ruta de lectura. Si la función `STABLE` nueva
toma `(org, project, evidence_id[])` como pide la solicitud, **debería
devolver también el scope de la fila**, o la ruta de lectura heredará
exactamente la tautología que INT-GR-004 describe.
