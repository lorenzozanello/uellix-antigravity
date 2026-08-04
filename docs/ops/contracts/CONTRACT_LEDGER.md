# Contract Ledger

Índice único del protocolo de contratos definido en
[`../STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md) §8.

Una fila por contrato. El estado lo fija **integración**, no la línea
solicitante ni la propietaria. Una línea abre una fila; nadie más la reescribe.

**Estados:** `solicitado` · `aceptado` · `incompatible` ·
`parcialmente satisfecho`

`parcialmente satisfecho` lo añadió integración en el tren 1: describe un
contrato cuya necesidad **sí** está cubierta por la línea propietaria, pero
mediante una forma distinta de la que pidió la solicitante, de modo que hace
falta una capa de adaptación antes de poder consumirlo. No es `aceptado`
(la forma pedida no existe) ni `incompatible` (la necesidad está resuelta).

| ID | Solicitante | Propietaria | Estado | Fecha | Documento |
|---|---|---|---|---|---|
| CT-CAP-001 | CAPABILITIES | CAPABILITIES | `solicitado` | 2026-08-04 | [Contratos de aplicación CAP-01…CAP-05](CT-CAP-001_capability_application_contracts.md) |
| CT-CAP-002 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [Normalización de `RR-CAP-10-A-bis`](CT-CAP-002_rr_cap_10_a_bis_normalization.md) |
| CT-CAP-003 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [Fin de línea de `db/prepared/**`](CT-CAP-003_prepared_sql_line_endings.md) |
| CT-CAP-004 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [`UELLIX_STRIPE_DATABASE_URL` en `.env.example`](CT-CAP-004_stripe_capability_env_var.md) |
| GR-001 | GROUNDING | CAPABILITIES | `solicitado` | 2026-08-04 | [`GR-001_evidence_chunks_provenance.md`](GR-001_evidence_chunks_provenance.md) |
| GR-002 | GROUNDING | CAPABILITIES | `solicitado` | 2026-08-04 | [`GR-002_document_version_history.md`](GR-002_document_version_history.md) |
| PRODUCT-001 | PRODUCT | GROUNDING | `solicitado` | 2026-08-04 | [PRODUCT-001_grounded-citation-provenance.md](PRODUCT-001_grounded-citation-provenance.md) |
| INTEGRATION-001 | INTEGRACIÓN | INTEGRACIÓN | `solicitado` | 2026-08-04 | [Adaptador de citas GROUNDING → PRODUCT](INTEGRATION-001_grounding_product_citation_adapter.md) |

## Notas de uso

- **CT-CAP-001 es una publicación, no una petición.** CAPABILITIES es a la vez
  solicitante y propietaria porque el contrato lo publica quien lo posee; la
  fila existe para que PRODUCT y RELEASE tengan un punto único donde ver qué
  pueden consumir y desde qué momento.
- **CT-CAP-002 a CT-CAP-004 sí son peticiones** y las tres tocan rutas que
  CAPABILITIES no puede modificar: el registro de riesgos y dos ficheros
  `INTEGRATION-OWNED` (§7). Ninguna se aplicó unilateralmente.
- **GR-001 y GR-002 son peticiones de GROUNDING a CAPABILITIES**, no
  publicaciones. GROUNDING no ha tocado `db/**`, `supabase/**` ni
  `db/prepared/**`: el núcleo de ingestión produce provenance completa pero no
  la persiste, precisamente porque la forma preparada de `evidence_chunks`
  todavía no puede almacenarla. CAPABILITIES Train 1 no las evaluó — su unidad
  fue CAP-03 (Stripe), no el esquema de evidencia.
- **PRODUCT-001 y los contratos de GROUNDING se publicaron el mismo día, sin
  verse.** No son alternativas entre las que integración deba elegir: PRODUCT
  pidió una forma de presentación y GROUNDING publicó una forma de verificación
  más estricta que la cubre. La resolución está en **INTEGRATION-001**.
- Integración resuelve incompatibilidades y marca el estado final aquí.
  Ninguna línea distinta de la propietaria modifica las rutas que un contrato
  solicita.
- Esta carpeta es la «ruta nueva prevista» de §8. CAPABILITIES, GROUNDING y
  PRODUCT la crearon en paralelo el mismo día, cada una con su propio índice;
  integración reconcilió los tres en este archivo sin alterar la autoría, la
  fecha ni el estado de ninguna fila preexistente.
