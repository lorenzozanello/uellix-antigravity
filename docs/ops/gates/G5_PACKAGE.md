# G5 — Paquete de decisión: alcance del grounding documental

> Gate externo G5 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`). Tipo: decisión de
> producto. Dueño humano: **Lorenzo**. La decisión se registra en
> `docs/ops/STELLA_FABLE_DECISIONS.md`.
> Contexto técnico completo: `docs/19_DOCUMENT_GROUNDING_SPEC.md` (§13).

## Precondiciones

- WS5 offline mergeado o revisable en `moonshot/ws5-grounding`:
  extracción CSV/TXT, chunking con anclas, retrieval offline y SQL preparado
  ya existen y están testeados sin red.
- Ninguna dependencia npm nueva instalada todavía (a propósito).
- Nada aplicado en DB remota (eso es G2, gate separado).

## Preguntas binarias

### P1 — ¿Soportamos PDF en la primera ola?

- **SÍ** ⇒ autoriza instalar **una** librería de extracción PDF.
  Candidatos evaluados (ninguno instalado): `unpdf` (recomendado: serverless-
  friendly, mantenido, API simple), `pdf-parse` (simple pero poco mantenido),
  `pdfjs-dist` (máxima fidelidad de layout, peso alto en serverless).
- **NO** ⇒ los PDF siguen reportando `status: 'unsupported'` limpiamente
  (comportamiento actual, ya testeado con los fixtures reales). Nada se rompe.

### P2 — ¿Soportamos XLSX en la primera ola?

- **SÍ** ⇒ autoriza instalar `exceljs` (recomendado; la alternativa SheetJS
  distribuye fuera de npm desde 2023 — riesgo de supply chain).
- **NO** ⇒ XLSX sigue en `unsupported` limpio.

### P3 — ¿Habilitamos pgvector (embeddings semánticos) o lanzamos con el fallback léxico determinista?

- **pgvector** ⇒ requiere: confirmar disponibilidad de la extensión `vector`
  en el proyecto Supabase hosted, elegir proveedor de embeddings (candidato:
  Gemini `text-embedding-004`, misma cuenta que Stella), y aplicar el SQL
  preparado vía G2. Costo por token de embedding + reindex inicial.
- **Fallback léxico** (recomendado para lanzar) ⇒ `DeterministicHashEmbeddingProvider`
  ya implementado: cero infra, cero costo, cero red, determinista. La columna
  `embedding` queda NULL y se backfillea si después se cambia a pgvector.

### P4 — ¿Extracción en ingest o diferida?

- **Ingest-time** (recomendado) ⇒ hook en el Buffer ya presente en
  `lib/pipeline/evidence.ts:137`, sin round-trip a Storage. Para CSV/TXT el
  costo es despreciable. La extracción nunca bloquea el upload (falla ⇒ warning
  + evidencia igual guardada).
- **Diferida** ⇒ solo tiene sentido si P1/P2 = SÍ y los archivos grandes
  degradan la latencia del upload; se puede decidir después por formato.

## Tradeoffs resumidos

| Decisión | Riesgo si SÍ | Riesgo si NO |
|----------|--------------|--------------|
| P1/P2 (formatos) | +2 dependencias npm (superficie de ataque, peso bundle server) | La mayoría de la evidencia real (PDF) queda sin grounding; solo CSV/TXT citables |
| P3 pgvector | Extensión + costo embeddings + dependencia de proveedor | Recall solo léxico (sinónimos no matchean) |
| P4 ingest | Latencia de upload con formatos pesados futuros | Complejidad de cola/estado "pendiente de indexar" |

## Qué desbloquea cada respuesta

- P1/P2 = SÍ ⇒ WS5 implementa los extractores reales tras el mismo contrato
  `extractDocument` (tests de fixtures `acta-entrega.pdf`, `informe-continuidad.pdf`,
  `inversiones.xlsx` pasan de `unsupported` a snapshots reales).
- P3 = pgvector ⇒ activa la parte guardada del SQL preparado (extensión +
  columna embedding con índice ANN) dentro del paquete G2.
- P4 ⇒ define dónde se cablea la llamada (ingest hook vs job) — el cableado en
  `lib/pipeline/evidence.ts` es de coordinación central, no de WS5.

## Criterio de aprobación binario

El gate se considera decidido cuando `STELLA_FABLE_DECISIONS.md` registra una
respuesta SÍ/NO explícita para P1–P4 con fecha y firma de Lorenzo. Cualquier
combinación es válida; todas las recomendaciones son reversibles
(spec §13 — los chunks son derivados y regenerables).

## Rollback

Decisión de producto, sin efectos aplicados: revertir = registrar la nueva
decisión. Si ya se instaló una librería por P1/P2, quitarla devuelve el formato
a `unsupported` sin migración de datos (los chunks de ese formato se borran con
`removeEvidence`/DELETE derivado; hash y archivo originales intactos).
