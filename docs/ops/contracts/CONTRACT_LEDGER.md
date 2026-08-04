# Contract Ledger

Índice único del protocolo de contratos definido en
[`../STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md) §8.

Una fila por contrato. El estado lo fija **integración**, no la línea
solicitante ni la propietaria. Una línea abre una fila; nadie más la reescribe.

**Estados:** `solicitado` · `aceptado` · `incompatible`

| ID | Solicitante | Propietaria | Estado | Fecha | Documento |
|---|---|---|---|---|---|
| CT-CAP-001 | CAPABILITIES | CAPABILITIES | `solicitado` | 2026-08-04 | [Contratos de aplicación CAP-01…CAP-05](CT-CAP-001_capability_application_contracts.md) |
| CT-CAP-002 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [Normalización de `RR-CAP-10-A-bis`](CT-CAP-002_rr_cap_10_a_bis_normalization.md) |
| CT-CAP-003 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [Fin de línea de `db/prepared/**`](CT-CAP-003_prepared_sql_line_endings.md) |
| CT-CAP-004 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [`UELLIX_STRIPE_DATABASE_URL` en `.env.example`](CT-CAP-004_stripe_capability_env_var.md) |
| GR-001 | GROUNDING | CAPABILITIES | `solicitado` | 2026-08-04 | [`GR-001_evidence_chunks_provenance.md`](GR-001_evidence_chunks_provenance.md) |
| GR-002 | GROUNDING | CAPABILITIES | `solicitado` | 2026-08-04 | [`GR-002_document_version_history.md`](GR-002_document_version_history.md) |

## Notas de uso

- **CT-CAP-001 es una publicación, no una petición.** CAPABILITIES es a la vez
  solicitante y propietaria porque el contrato lo publica quien lo posee; la
  fila existe para que PRODUCT y RELEASE tengan un punto único donde ver qué
  pueden consumir y desde qué momento. Integración marca `aceptado` cuando el
  tren de integración incorpore la unidad.
- **CT-CAP-002 a CT-CAP-004 sí son peticiones** y las tres tocan rutas que esta
  línea no puede modificar: el registro de riesgos y dos ficheros
  `INTEGRATION-OWNED` (§7). Ninguna se ha aplicado unilateralmente.
- **GR-001 y GR-002 son peticiones de GROUNDING a CAPABILITIES**, no
  publicaciones. GROUNDING no ha tocado `db/**`, `supabase/**` ni
  `db/prepared/**`: el núcleo de ingestión produce provenance completa pero no
  la persiste, precisamente porque la forma preparada de `evidence_chunks`
  todavía no puede almacenarla. CAPABILITIES Train 1 no las evaluó —
  su unidad fue CAP-03 (Stripe), no el esquema de evidencia. Siguen
  `solicitado`, y son el trabajo de entrada de CAPABILITIES Train 2.
- Integración resuelve incompatibilidades y marca el estado final aquí.
  Ninguna línea distinta de la propietaria modifica las rutas que un contrato
  solicita.
- Esta carpeta es la «ruta nueva prevista» de §8. CAPABILITIES y GROUNDING la
  crearon en paralelo en el mismo día, cada una con su propio índice;
  integración reconcilió ambos en este archivo sin alterar la autoría, la fecha
  ni el estado de ninguna fila.
