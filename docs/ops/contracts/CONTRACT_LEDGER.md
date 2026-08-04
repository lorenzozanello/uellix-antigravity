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
| CT-CAP-001 | CAPABILITIES | CAPABILITIES | `aceptado` (tren 1) | 2026-08-04 | [Contratos de aplicación CAP-01…CAP-05](CT-CAP-001_capability_application_contracts.md) |
| CT-CAP-002 | CAPABILITIES | INTEGRACIÓN | `aceptado` (tren 1, opción A) | 2026-08-04 | [Normalización de `RR-CAP-10-A-bis`](CT-CAP-002_rr_cap_10_a_bis_normalization.md) |
| CT-CAP-003 | CAPABILITIES | INTEGRACIÓN | `aceptado` (tren 1) | 2026-08-04 | [Fin de línea de `db/prepared/**`](CT-CAP-003_prepared_sql_line_endings.md) |
| CT-CAP-004 | CAPABILITIES | INTEGRACIÓN | `solicitado` | 2026-08-04 | [`UELLIX_STRIPE_DATABASE_URL` en `.env.example`](CT-CAP-004_stripe_capability_env_var.md) |
| GR-001 | GROUNDING | CAPABILITIES | `solicitado` | 2026-08-04 | [`GR-001_evidence_chunks_provenance.md`](GR-001_evidence_chunks_provenance.md) |
| GR-002 | GROUNDING | CAPABILITIES | `solicitado` | 2026-08-04 | [`GR-002_document_version_history.md`](GR-002_document_version_history.md) |
| PRODUCT-001 | PRODUCT | GROUNDING | `parcialmente satisfecho` (pendiente de adaptador) | 2026-08-04 | [PRODUCT-001_grounded-citation-provenance.md](PRODUCT-001_grounded-citation-provenance.md) |
| INTEGRATION-001 | INTEGRACIÓN | PRODUCT | `solicitado` (decisión registrada; implementación pendiente) | 2026-08-04 | [Adaptador de citas GROUNDING → PRODUCT](INTEGRATION-001_grounding_product_citation_adapter.md) |

## Resolución del tren 1 (integración, 2026-08-04)

### CT-CAP-001 — `aceptado`

Es una **publicación**, no una petición: CAPABILITIES es a la vez solicitante y
propietaria porque el contrato lo publica quien lo posee. Integración lo marca
`aceptado` porque el tren 1 incorporó la unidad — que es exactamente la
condición que la propia fila declaraba. `lib/capabilities/contracts.ts` está en
la rama de integración y PRODUCT y RELEASE pueden consumirlo desde ahora.

Aceptar el contrato **no habilita ninguna capacidad**:
`WEBHOOK_DATABASE_IDENTITY_AVAILABLE` sigue en `false`, `stella_0008` sigue sin
aplicar en ninguna base y `UELLIX_STRIPE_DATABASE_URL` sigue sin aprovisionar.

### CT-CAP-002 — `aceptado`, opción A

Integración retiró el alias. **`RR-CAP-10-A` es el identificador canónico** del
resto del webhook; no se creó una entrada `RR-CAP-10-A-bis`, porque nunca
existió en `STELLA_FABLE_RISK_REGISTER.md` y crearla ahora daría existencia
registral a un identificador acuñado en un comentario.

Aplicado en dos sitios:

- `lib/admin/organization-administration.ts` — la cabecera afirmaba que el
  webhook «still contains three `db.update(organizations)` statements». Era
  falso tras el tren 1 de CAPABILITIES. Reescrita.
- `docs/ops/STELLA_FABLE_RISK_REGISTER.md`, entrada `RR-CAP-10-A` — anotado el
  cierre del resto del webhook, con el camino nuevo y con la constancia de que
  el código retirado era **inalcanzable** (muerto tras la bandera) y aun así
  había que quitarlo.

### CT-CAP-003 — `aceptado`

`.gitattributes` (INTEGRATION-OWNED, §7) recibió `db/prepared/** text eol=lf`.

La renormalización de `db/prepared/**` produjo **cero blobs nuevos**: los 32
`.sql` ya estaban en LF **en el índice**; era el checkout, bajo
`core.autocrlf=true`, quien los materializaba en CRLF. La diferencia era
exclusivamente de final de línea, no semántica. `db/baseline/**` no se tocó.

Evidencia del cierre, medida en el HEAD integrado: las cuatro suites que
CAPABILITIES reportó en rojo (`capability-isolation`, `prepared-stella-sql`,
`capability-policy-contract`, `capability-mutation`) entregan **687 passed**,
exactamente la cifra que esa línea midió al normalizar a mano en su worktree.

### CT-CAP-004 — sigue `solicitado`

**No aplicado.** La instrucción de esta unidad de integración prohíbe modificar
archivos `.env`, y la petición es precisamente añadir
`UELLIX_STRIPE_DATABASE_URL` a `.env.example`.

No es un rechazo del contrato: la petición es razonable y no expone ningún
secreto (documenta un **nombre** de variable, no un valor). Queda como trabajo
de entrada del primer tren que tenga `.env.example` entre sus rutas
autorizadas. Mientras tanto, la variable está documentada en
`db/capabilities/stripe-capability-executor.ts` y en CT-CAP-004, y su ausencia
es fail-closed: sin credencial el resolutor devuelve `null` y el handler
contesta `unavailable` / 503.

### GR-001 y GR-002 — siguen `solicitado`

Son peticiones de GROUNDING **a CAPABILITIES**, y CAPABILITIES no las evaluó en
el tren 1: su unidad fue CAP-03 (Stripe), no el esquema de evidencia. Ninguna
línea distinta de la propietaria puede tocar `db/**`, así que integración **no
las resuelve por su cuenta** — hacerlo sería inventar la decisión que el
protocolo reserva a la línea propietaria.

Consecuencia registrada: el núcleo de ingestión de GROUNDING produce provenance
completa y **no la persiste**. Es el riesgo R1 de esa línea, y es correcto que
siga abierto: persistir antes de GR-001 perdería precisamente los campos que
hacen verificable una cita.

Son el trabajo de entrada de **CAPABILITIES tren 2**.

### PRODUCT-001 — `parcialmente satisfecho, pendiente de adaptador`

PRODUCT y GROUNDING publicaron el mismo día, sin verse, dos descripciones de
«una cita fundamentada». No son alternativas entre las que integración deba
elegir: la de GROUNDING es más estricta y contiene a la de PRODUCT. La
resolución completa está en
[INTEGRATION-001](INTEGRATION-001_grounding_product_citation_adapter.md).

### INTEGRATION-001 — `solicitado`

La **decisión** está tomada y registrada; lo que sigue `solicitado` es su
**implementación**, y la propietaria de ésa es PRODUCT, no integración.

Integración **no** marca `aceptado` una petición que se hizo a sí misma y cuyo
entregable (`components/stella/grounding-adapter.ts`) no existe en el árbol.
La revisión adversarial señaló con razón que hacerlo sería aceptar trabajo
propio sin ningún gate externo, y que un lector del resumen de gobernanza
concluiría que el adaptador ya está entregado y no lo escribiría.

El adaptador no se implementó aquí: PRODUCT compila y sus 261 pruebas pasan sin
él, así que la excepción «sólo si es estrictamente necesario para compilar» no
aplica. Verificado: `components/**` no importa nada de `lib/grounding/**` en el
HEAD integrado.

## Notas de uso

- Integración resuelve incompatibilidades y marca el estado final aquí.
  Ninguna línea distinta de la propietaria modifica las rutas que un contrato
  solicita.
- Esta carpeta es la «ruta nueva prevista» de §8. CAPABILITIES, GROUNDING y
  PRODUCT la crearon en paralelo el mismo día, cada una con su propio índice;
  integración reconcilió los tres en este archivo sin alterar la autoría, la
  fecha ni el texto de ninguna solicitud.
