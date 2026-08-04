# GR-002 — Historia de versiones de documento

| Campo | Valor |
|---|---|
| Solicitante | GROUNDING (`codex/stella-grounding`) |
| Propietario | CAPABILITIES (`codex/stella-capabilities`) |
| Estado | solicitado |
| Prioridad | menor que [GR-001](GR-001_evidence_chunks_provenance.md) |
| Fecha | 2026-08-04 |

## 1. El hueco

`DocumentVersion` (`lib/grounding/contracts/documents.ts`) tiene dos campos que
el núcleo de ingestión **deja deliberadamente en `null`**:

- `ordinal` — posición 1-based en la historia del documento;
- `supersedes` — `versionId` de la versión reemplazada.

Son nulables a propósito: sólo puede rellenarlos quien tenga la historia previa,
y el núcleo de ingestión es puro (sin base de datos, sin reloj). Inventar una
historia que puede estar equivocada es peor que declararla desconocida.

Hoy nadie guarda esa historia. `evidence_items` tiene una fila por evidencia con
un único `content_hash`: cuando se re-sube un archivo corregido, la versión
anterior desaparece.

## 2. Qué se solicita

Una tabla append-only de versiones, o el conjunto de columnas equivalente:

```
evidence_document_versions
  id                        uuid    PK
  organization_id           uuid    NOT NULL
  evidence_id               uuid    NOT NULL   -- FK evidence_items
  version_id                char(64) NOT NULL  -- derivado, único por evidencia
  raw_content_hash          char(64) NOT NULL
  normalized_content_hash   char(64) NOT NULL
  normalization_version     varchar(32) NOT NULL
  ordinal                   integer NOT NULL
  supersedes_version_id     char(64) NULL
  created_at                timestamp NOT NULL

  UNIQUE (evidence_id, version_id)
  UNIQUE (evidence_id, ordinal)
```

Semántica append-only, igual que `audit_logs` / `runs` / `line_items`: una
versión nunca se modifica ni se borra. Es registro de cadena de custodia, no
índice derivado — a diferencia de `evidence_chunks`, que sí es regenerable y sí
puede borrarse.

## 3. Por qué importa

Sin historia de versiones, una cita emitida contra la versión N de un documento
queda huérfana en cuanto se sube la versión N+1: los chunks se regeneran, los
`chunk_id` cambian (dependen de `version_id`) y una cita antigua en un informe
ya emitido deja de resolver, sin que nada indique que el documento cambió.

Con la tabla, esa cita resuelve a "versión 1 de este documento, reemplazada por
la versión 2 el <fecha>" — que es exactamente lo que un auditor necesita leer.

## 4. Qué NO se solicita

- Retener el archivo de cada versión en Storage. Eso es política de retención
  (`docs/ops/STELLA_RETENTION_POLICY.md`) y una decisión de producto, no un
  requisito del contrato de grounding.
- Reindexado automático al detectar una versión nueva: es orquestación, no
  esquema.

## 5. Decisión de integración

_Pendiente._
