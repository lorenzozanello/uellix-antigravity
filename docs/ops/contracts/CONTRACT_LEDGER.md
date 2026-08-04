# Registro de contratos entre líneas

Índice único de los contratos publicados entre las cuatro líneas de trabajo
paralelo. Ver §8 de
[`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo. Una fila por contrato.

Estados: `solicitado` · `aceptado` · `incompatible`.

| ID | Solicitante | Propietario | Estado | Fecha | Documento |
|---|---|---|---|---|---|
| GR-001 | GROUNDING | CAPABILITIES | solicitado | 2026-08-04 | [`GR-001_evidence_chunks_provenance.md`](GR-001_evidence_chunks_provenance.md) |
| GR-002 | GROUNDING | CAPABILITIES | solicitado | 2026-08-04 | [`GR-002_document_version_history.md`](GR-002_document_version_history.md) |

## Notas

- Esta carpeta la crea la primera línea que publica un contrato (§8). La creó
  GROUNDING en la unidad `STELLA_GROUNDING_INGESTION_CORE_TRAIN_1`.
- Integración resuelve incompatibilidades y marca el estado final aquí.
- Ninguna línea distinta de la propietaria modifica las rutas que un contrato
  solicita. GROUNDING no ha tocado `db/**`, `supabase/**` ni `db/prepared/**`.
