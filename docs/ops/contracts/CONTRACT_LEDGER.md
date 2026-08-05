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
| CT-CAP-004 | CAPABILITIES | INTEGRACIÓN | `aceptado` (raíz tren 2) | 2026-08-04 | [`UELLIX_STRIPE_DATABASE_URL` en `.env.example`](CT-CAP-004_stripe_capability_env_var.md) |
| GR-001 | GROUNDING | CAPABILITIES | `aceptado` (tren 2) | 2026-08-04 | [`GR-001_evidence_chunks_provenance.md`](GR-001_evidence_chunks_provenance.md) |
| GR-002 | GROUNDING | CAPABILITIES | `aceptado` (tren 2) | 2026-08-04 | [`GR-002_document_version_history.md`](GR-002_document_version_history.md) |
| PRODUCT-001 | PRODUCT | GROUNDING | `aceptado` (tren 2, vía adaptador) | 2026-08-04 | [PRODUCT-001_grounded-citation-provenance.md](PRODUCT-001_grounded-citation-provenance.md) |
| INTEGRATION-001 | INTEGRACIÓN | PRODUCT | `aceptado` (tren 2) | 2026-08-04 | [Adaptador de citas GROUNDING → PRODUCT](INTEGRATION-001_grounding_product_citation_adapter.md) |
| GR-CAP-002 | CAPABILITIES | GROUNDING | `aceptado` (tren 3) | 2026-08-05 | [`EXTRACTOR_VERSION` canónico](#gr-cap-002--extractor_version-tren-3) (§ abajo) |
| PRODUCT-002 | PRODUCT | INTEGRACION | `aceptado` (tren 4: montado en la superficie de proyecto) | 2026-08-05 | [Punto de entrada del orquestador](PRODUCT-002_grounded_query_orchestrator_entry_point.md) |
| INT-GR-001 | INTEGRACION | CAPABILITIES | `solicitado` (tren 4: defecto acotado) | 2026-08-05 | [Lectura gobernada de version activa](#int-gr-001--lectura-gobernada-de-versión-activa-tren-3) (ver resolucion del tren 4, abajo) |
| INT-GR-002 | INTEGRACION | GROUNDING | `aceptado` (tren 4) | 2026-08-05 | [Aislamiento por proyecto en `validateAnswerCitations`](#int-gr-002--aislamiento-por-proyecto-a-f1-tren-3) |
| INT-GR-003 | INTEGRACION | CAPABILITIES | `solicitado` (decidido, SQL pendiente) | 2026-08-05 | [`ChunkLocation` no reconstruible desde persistencia](#int-gr-003--chunklocation-no-reconstruible-tren-3) |
| INT-PR-001 | INTEGRACIÓN | PRODUCT | `solicitado` | 2026-08-05 | [Clave canónica de decisión para respuestas fundamentadas](#int-pr-001--clave-canónica-de-decisión-tren-3) (§ abajo) |
| INT-CAP-001 | INTEGRACION | CAPABILITIES | `aceptado` (tren 4, `stella_0013`) | 2026-08-05 | [Rol `grounded_query` en el ledger de cuota](#int-cap-001--rol-grounded_query-en-el-ledger-de-cuota) |
| INT-CAP-002 | INTEGRACION | CAPABILITIES | `aceptado` (tren 4, `grounding_0004` 2b) | 2026-08-05 | [`evidence_chunks` concede SELECT directo a `authenticated`](#int-cap-002--evidence_chunks-concede-select-directo-a-authenticated) |
| INT-CAP-003 | INTEGRACION | CAPABILITIES | `aceptado` (tren 4, `grounding_0004` 1a/1b) | 2026-08-05 | [`content_hash` nunca se verifica contra `content`](#int-cap-003--content_hash-nunca-se-verifica-contra-content) |
| INT-CAP-004 | INTEGRACION | CAPABILITIES | `aceptado` (tren 4: 1c + rollback reparado) | 2026-08-05 | [Rollback incompleto y forja de `chunk_id` por el owner](#int-cap-004--rollback-incompleto-y-forja-de-chunk_id-por-el-owner) |
| INT-INT-001 | INTEGRACION | INTEGRACION | `solicitado` (BLOQUEANTE) | 2026-08-05 | [Clave de idempotencia sin fuente canonica](#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4) |
| INT-GR-004 | INTEGRACION | GROUNDING | `aceptado` (tren 4: SQL + adaptador atestado) | 2026-08-05 | [`chunks_in_scope` deberia devolver el scope de la fila](#int-gr-004--chunks_in_scope-debería-devolver-el-scope-de-la-fila) |

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

### CT-CAP-004 — `aceptado` (raíz tren 2)

**Aplicado** en la unidad de preparación de raíz compartida de tren 2, que sí
tiene `.env.example` entre sus rutas autorizadas. Se añadió únicamente el
nombre de variable, con valor vacío, en la sección «Stripe (Monetization &
Billing)»:

```dotenv
# CAP-03 — conexión exclusiva del handler del webhook de Stripe.
# Debe declarar el rol uellix_stripe. NO se comparte con ningún otro servicio.
# Sin aprovisionar: el handler devuelve 503 y no intenta nada.
# Ver docs/ops/capabilities/CAP_03_STRIPE.md §13.
UELLIX_STRIPE_DATABASE_URL=
```

No se reutilizó `DATABASE_URL`, no se usó `service_role`, no se afirmó que
Stripe esté habilitado y `WEBHOOK_DATABASE_IDENTITY_AVAILABLE` permanece en
`false`. La variable sigue sin aprovisionar: el resolutor devuelve `null` y el
handler contesta `unavailable` / 503 exactamente como antes. Este cambio es de
legibilidad operativa, no de desbloqueo.

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

## Resolución del tren 2 (integración, 2026-08-04)

HEAD integrado: cuatro merge commits `--no-ff` sobre `597819b`, sin cherry-pick
y sin reescribir ninguna rama.

### GR-001 — `aceptado`

Criterio de aceptación §5: «`db/prepared/` contiene una forma de
`evidence_chunks` que incluye al menos las seis columnas de §2, y su guarda de
forma las exige». Verificado en el HEAD integrado, no aceptado por declaración:
`tests/cross-workstream/capabilities-to-grounding.test.ts` comprueba las seis
columnas **en el cuerpo del `CREATE TABLE`** (no en un comentario), que las seis
son `NOT NULL`, y que la guarda de `grounding_0003` las nombra y aborta.

Las tres secciones recomendadas también se entregaron: `project_id` (§2.1),
`signals` + `injection_scanner_version` (§2.2) y `embedding_provider_id` (§2.3).

`grounding_0003` es **pgvector-free** —sin `CREATE EXTENSION`, sin tipo
`vector`, sin índice ANN—, así que persistir provenance ya no espera al gate
G5 P3. Comprobado sobre el código, con los comentarios retirados.

### GR-002 — `aceptado`

Las nueve columnas y las dos constraints de unicidad solicitadas, más
`project_id`, `extractor_version`, `chunker_version` y `mime_type`.

Append-only comprobado en el sentido fuerte: **ningún** `GRANT` sobre
`evidence_document_versions` lleva `UPDATE`, `DELETE`, `TRUNCATE` ni `ALL`, para
ningún principal, y hay triggers `BEFORE UPDATE OR DELETE` y `BEFORE TRUNCATE`
que alcanzan también al owner —a quien los `GRANT` no obligan—.

La asimetría con `evidence_chunks` (que **sí** admite `DELETE`) es el contrato,
no un descuido: los chunks son un índice derivado y regenerable; la historia de
versiones es cadena de custodia. Hay una prueba que fija la asimetría en ambas
direcciones, porque una que exigiera simetría estaría exigiendo que una de las
dos esté mal.

### PRODUCT-001 — `aceptado`

Vía el adaptador. La forma concreta que PRODUCT pidió no existe como tal y no se
creó: llega derivada por función pura desde `CitationReference` +
`GroundingChunk` + `RetrievalCandidate`, tal como decidió INTEGRATION-001.

### INTEGRATION-001 — `aceptado`

El entregable existe (`components/stella/grounding-adapter.ts`) y su condición
abierta —la doble definición de umbrales— la resolvió integración. Ver §6-bis de
ese documento.

### GR-CAP-002 — `EXTRACTOR_VERSION` (tren 3)

**Fila nueva, abierta por integración**, porque la petición existía sin registro:
`GR-CAP-001` §5.4 la formuló como «petición de vuelta a GROUNDING» dentro de un
documento de respuesta, y una petición que no está en el ledger no tiene dueño ni
fecha.

- **Solicitante:** CAPABILITIES · **Propietaria:** GROUNDING · **Estado:** `solicitado`
- **Qué se pide:** publicar un `EXTRACTOR_VERSION` canónico en
  `lib/grounding/contracts/core.ts`, incorporado a `PIPELINE_VERSIONS`.
- **Por qué:** `evidence_document_versions.extractor_version` es `NOT NULL`, así
  que quien llame **debe declarar algo**. Publicar la constante convierte «algo»
  en un valor gobernado.
- **El hueco es real, no teórico:** `versionId` se deriva de
  `(evidenceId, rawContentHash)` únicamente — el extractor no está en esa
  preimagen. Un extractor distinto sobre los mismos bytes produce otro
  `normalized_content_hash` bajo el **mismo** `version_id`; sin la columna, la
  reingesta se descartaría como réplica y todos los offsets almacenados
  quedarían obsoletos **sin señal**. Y `lib/grounding/extract.ts` tiene un
  registro real de extractores (`text/csv`, `text/plain`), así que la etapa
  existe.

**Integración no la publicó, y las tres razones importan:** (1) `lib/grounding/**`
es propiedad de GROUNDING; (2) `tests/grounding-persistence-contract.test.ts`
fija deliberadamente su **ausencia** como cable trampa, de modo que añadirla
aquí habría roto una prueba propiedad de CAPABILITIES para satisfacer una columna
que todavía nada escribe; (3) elegir `'extract-1'` habría sido inventar en
silencio el valor gobernado que el contrato pide gobernar.

`tests/cross-workstream/capabilities-to-grounding.test.ts` afirma la ausencia
**y la razón**: el día que GROUNDING publique la constante, esa prueba falla, que
es la señal para cerrar el contrato — no para borrar la prueba.

### Otros registros del tren 2

- **`grounding_0001` supersedido**, conservado byte a byte bajo un banner de
  comentario. Verificado mecánicamente: cola idéntica (15 279 B), cabecera
  preservada, 2 175 B insertados y **cero** líneas no comentario añadidas, cero
  eliminadas.
- **`grounding_0002` y `grounding_0003`**: preparados, **no aplicados a ninguna
  base**. Orden forward `stella_0004` → `0002` → `0003`; rollback `0003` → `0002`,
  y el orden lo impone el propio SQL (la guarda de `0003` aborta sin `0002`; el
  rollback de `0002` se niega mientras exista la FK de `evidence_chunks`).
- **Desvío `project_id NOT NULL`** (GR-001 §2.1 pedía nulable): aceptado. El caso
  «nulo = evidencia de alcance organizacional» **no existe** —
  `evidence_items.project_id` es `NOT NULL` en `db/schema.ts:228`— y una columna
  nulable obligaría a todo predicado con alcance de proyecto a llevar una rama
  `OR IS NULL` que sólo puede **ensanchar** la frontera. La prueba cruzada fija
  el **fundamento**, no sólo el desvío: si `evidence_items.project_id` se
  volviera nulable, la razón se evapora y la prueba dispara.
- **Umbrales canónicos**: `grounding-relevance-2026-08-local-1`, `high >= 0.4`,
  `medium >= 0.2`. Los de PRODUCT (`product-relevance-v1`, 0.6 / 0.3) quedan
  **retirados**, del módulo y del barrel. Ver INTEGRATION-001 §6-bis.
- **R7 (diversidad de fuentes)** y **R6 (`no_matching_evidence`)**: siguen
  **abiertos**, y con razón. R7 es el suelo de fuentes distintas de retrieval y
  R6 la distinción entre «no hay evidencia» y «la hay y no es relevante»; ambos
  se calibran contra scores reales, y no existe implementación de retrieval con
  datos con la que medirlos. Cerrarlos ahora sería declarar calibrada una
  heurística que nadie midió.
- **`command.test.ts`**: se **mantiene** en `pnpm test:unit`. Medido ~15.9 s (10
  casos, 2 subprocesos). No hay recursión: lanza `tsx scripts/eval-release-offline.ts`,
  no `vitest`. No duplica una batería: `harness.test.ts` mide los checks a nivel
  de módulo; esto mide el comando empaquetado (exit code, salida estructurada,
  determinismo entre procesos), que ningún test de módulo observa.

## Notas de uso

- Integración resuelve incompatibilidades y marca el estado final aquí.
  Ninguna línea distinta de la propietaria modifica las rutas que un contrato
  solicita.
- Esta carpeta es la «ruta nueva prevista» de §8. CAPABILITIES, GROUNDING y
  PRODUCT la crearon en paralelo el mismo día, cada una con su propio índice;
  integración reconcilió los tres en este archivo sin alterar la autoría, la
  fecha ni el texto de ninguna solicitud.

## Revisión adversarial del tren 2 (integración, 2026-08-04)

Dos revisores independientes de sólo lectura, uno sobre datos y aislamiento, otro
sobre contratos y producto. Ninguno pudo editar, ejecutar pruebas ni tocar una
base de datos.

**Resultado: 2 BLOCKER, 7 MAJOR, 12 MINOR.** Los 2 BLOCKER y 5 de los 7 MAJOR
quedan corregidos y verificados. Lo que no se corrigió está abajo, con su razón —
un hallazgo confirmado que se deja abierto tiene que decir por qué, o es un
hallazgo silenciado.

### BLOCKER — ambos corregidos, ambos probados en contenedor desechable

**B1 — los dos paquetes eran funcionalmente inertes.**
`register_document_version` hacía `SELECT … FROM public.evidence_items … FOR
UPDATE`, y `uellix_cap_grounding` —el dueño `SECURITY DEFINER`— no tenía
**ningún** privilegio sobre esa tabla. Medido con `has_table_privilege` sobre el
baseline restaurado: `SELECT` = falso, `UPDATE` = falso. Toda llamada moría con
`42501 permission denied`, así que ninguna versión de documento podía
registrarse y ningún chunk podía insertarse. Los paquetes **instalaban limpiamente
y no servían para nada**.

Reparado con `GRANT SELECT` (y sólo SELECT) sobre `evidence_items`, más la
sustitución del bloqueo de fila por `pg_advisory_xact_lock`. No se concedió
`UPDATE`: PostgreSQL lo exige para bloquear una fila, y ensanchar la superficie
de escritura de una tabla de negocio para que un bloqueo resulte cómodo es
exactamente lo que la §6 del propio paquete advierte que convierte una frontera
en decorativa. El bloqueo consultivo da la misma exclusión mutua sobre la misma
clave y no exige privilegio alguno.

**B2 — escritura cruzada en la historia de custodia.**
`register_document_version` era la **única** función definer de los dos paquetes
sin comprobación de la organización del llamante; las otras tres la tienen. Es
además la única entrada de **escritura** a la historia de versiones, su `EXECUTE`
está concedido al rol de runtime compartido `uellix_app`, y la tabla es
append-only sin ruta de `UPDATE` ni `DELETE` para nadie. Un inquilino con el
`evidence_items.id` de otra organización añadía a esa organización una fila
**permanente y elegida por él**, que `claim_active_document_version` devolvía
después como versión activa.

Reparado replicando la comprobación literal de las tres funciones hermanas.
Ahora hay además una prueba que la exige de **todas** las funciones definer, no
de una en una: el defecto era «una de cuatro se olvidó».

**Cómo se escaparon, y qué cambió para que no se repita.** El dry-run del tren 2
verificaba forma —existencia, propiedad, `search_path`, policies, grants— y no
**invocaba** nada. Un arnés así certifica que el paquete se instala, no que
funciona. `scripts/grounding-dry-run.sh` tiene ahora una etapa que llama a
`register_document_version` y discrimina por SQLSTATE: `42501` (el definer no
puede leer lo que necesita) frente a `U0102` (leyó y rechazó por alcance). Esa
etapa capturó, en la misma corrida que probó la corrección, que el nuevo
`GRANT SELECT` bloqueaba a su vez el `DROP ROLE` del rollback.

### MAJOR corregidos (5)

| # | Defecto | Reparación |
|---|---|---|
| M1 | El control negativo `nc-envelope-rejects-multiline-body` comparaba un literal consigo mismo y **nunca** llamaba al evaluador: borrar la regla del sobre dejaba el check verde y `tautologicalChecks` vacío | La inspección del sobre se extrajo a `inspectEnvelope`, que ahora comparten el check y el control; la mutación es un sobre real de dos líneas |
| M2 | `RelevanceAssessment` no llevaba `scorerId`, y `presentationInputFromRetrieval` recibía el `RetrievalResult` del contrato, que no lo tiene — la identidad del scorer **no podía** llegar a la UI, pese a que `calibration.ts` la declara imprescindible para notar un cambio de escala | Campo añadido, nulable, y un segundo argumento opcional para suministrarlo |
| M3 | La guarda «un solo dueño de los umbrales» exigía palabra de bucket **y** comparación decimal en la misma línea, y no era recursiva: `const HIGH_MIN = 0.6` en una línea y la comparación en otra la evadía por completo | Reescrita con dos vistas del archivo y demostrada contra ambas evasiones |
| M4 | `assertMetricsMatchMatrix` reconciliaba sólo los **nombres** de métrica; la pertenencia por check entre `matrix.ts` y `METRIC_CONTRIBUTORS` no se comprobaba en ninguna dirección | `assertContributorsMatchMatrix`, en ambas direcciones |
| M5 | `globExcludes` recortaba `*` finales y hacía `startsWith`, así que `**/capability-*.test.ts` —la grafía natural para excluir una familia de pruebas— era invisible y el check de superficie CAP seguía verde con las tres suites de regresión ya no recolectadas | Traducción glob→regex real, con 12 casos probados |

### MAJOR confirmados y NO corregidos (2), con su razón

**A-M «atribución de contradicción por co-cita».** Una afirmación que cita un
chunk nombrado por **cualquier** `ContradictionMarker` se pinta como
`contradictory_evidence`, aunque la contradicción sea sobre otro dato del mismo
chunk. El hallazgo es real. **No es reparable en el adaptador**: `sideA`/`sideB`
son `CitationReference[]`, y dos afirmaciones que citan el mismo chunk producen
la **misma** `CitationReference` — no existe información que las distinga.
Atribuir a nivel de afirmación exige que el marcador nombre afirmaciones, que es
un cambio del contrato de GROUNDING. Inventar la semántica aquí sería fabricar
precisión que el dato no tiene. **Queda como petición a GROUNDING para el tren 3**,
y la garantía real —más estrecha que la que sugería INTEGRATION-001 §7— queda
dicha aquí en lugar de implícita.

**A-M «bypass del dueño sobre el acuerdo de alcance».** El acuerdo
organización/proyecto entre un chunk y su versión padre vive sólo en RLS, y
ninguna de las dos tablas activa `FORCE ROW LEVEL SECURITY`, así que
`uellix_migrator` → `SET ROLE uellix_owner` puede insertar una fila con alcance
inconsistente. Confirmado. **No se corrige aquí** porque `FORCE ROW LEVEL
SECURITY` sobre estas tablas cambia el comportamiento de **todo** camino que
corra como dueño, incluidos los rollbacks —cuyo propio guardián se **niega** a
correr bajo FORCE, precisamente porque un dueño sin `rolbypassrls` contaría 0
filas sobre una tabla poblada y anunciaría que no se perdió historia mientras la
destruye. Activarlo sin rediseñar esa interacción cambia un fallo ruidoso por uno
silencioso. **Queda registrado para CAPABILITIES tren 3**, junto con la
alternativa más barata que el revisor no pidió pero que conviene evaluar: un
`CHECK` o un trigger que ate el alcance sin depender de RLS.

### MINOR registrados, no corregidos

Los doce quedan para sus líneas propietarias. Los que más pesan:
`canonical_chunk_id` sin clave foránea ni comprobación de ciclos (A→B/B→A en un
mismo lote se acepta y deja el texto en ninguna parte); `chunk_id` tomado
literalmente del payload sin re-derivarse de `(version_id, chunk_index,
content_hash)`, con `ON CONFLICT DO NOTHING` global; triggers append-only sin
`ENABLE ALWAYS`, evitables bajo `session_replication_role = replica`; y el hecho
de que `validateAnswerCitations` y `retrieveGroundedChunks` **no tienen ningún
llamante fuera de las pruebas** — los mecanismos que bloquean la cita cruzada son
hoy de biblioteca, no de ruta.

---

## Resolución del tren 3 (integración, 2026-08-05)

`INTEGRATION_ROOT_HEAD` = `4d59348`. Las cuatro líneas entregaron dos commits
cada una, las cuatro descendían del root sin commits intermedios no
declarados, y los cuatro worktrees estaban limpios. Merges explícitos
`--no-ff` en el orden CAPABILITIES → GROUNDING → PRODUCT → RELEASE.

### GR-CAP-002 — `aceptado`

GROUNDING publicó `EXTRACTOR_VERSION = 'extract-1'` en
`lib/grounding/contracts/core.ts`. Integración verificó, y **fijó como
prueba**, las seis condiciones de cierre:

| Condición | Evidencia |
|---|---|
| Existe **una sola vez** | `capabilities-to-grounding.test.ts` cuenta las declaraciones y exige exactamente 1 |
| Valor `extract-1` | pinned en dos suites |
| Forma parte de `PIPELINE_VERSIONS` | `PIPELINE_VERSIONS.extractor === EXTRACTOR_VERSION` |
| `DocumentVersion` lo transporta | campo `extractorVersion` |
| `ingestDocument` lo estampa | `ingest.test.ts`, incl. reingesta de bytes idénticos |
| Cabe en la columna SQL | `varchar(32) NOT NULL` + `extractor_version <> ''`, comprobado contra el literal |

**Los dos test-trampa se invirtieron, no se borraron.**
`tests/grounding-persistence-contract.test.ts` y
`tests/cross-workstream/capabilities-to-grounding.test.ts` fijaban la
**ausencia** de la constante como alarma. Ahora afirman el contrato
satisfecho y **siguen fallando** si la constante desaparece o si aparece una
segunda divergente — que es la propiedad que la trampa protegía.

Que un cambio futuro de comportamiento del extractor exige una versión nueva
está fijado por `contracts.test.ts`: dos `DocumentVersion` idénticos salvo
`extractorVersion` no son el mismo estado de pipeline. `versionId` **no**
incluye al extractor en su preimagen, y ése es precisamente el hueco que la
columna cierra.

### PRODUCT-002 — `IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE`

Los seis criterios de aceptación del documento se cumplen:

| # | Criterio | Dónde |
|---|---|---|
| 1 | Satisface `StellaGroundedQueryRunner` sin que `components/stella/**` lo importe | `app/actions/stella/grounded-query.ts`; la costura es una prop |
| 2 | Scope de `requireOrganizationAccess`, no del argumento | `runStellaGroundedQuery` paso 4 |
| 3 | `DISABLED` con la bandera apagada, sin llamar al orquestador | probado: cero SQL, cero auth, cero cuota |
| 4 | `QUOTA_EXCEEDED` con el mensaje del servidor intacto | probado |
| 5 | Ningún detalle de proveedor en `message` | probado contra un error real de driver (42P01) |
| 6 | `GroundedAnswerView` vía `adaptGroundedAnswer`, no a mano | `toProductResult` |

**No se marca `aceptado`, y el motivo es el séptimo criterio que el documento
no lista: nadie puede alcanzarlo.** Siete páginas de pipeline montan Stella,
cada una bajo un `AdvisorPipelineStep` distinto; no existe una superficie
canónica inequívoca para una pregunta de alcance de proyecto, e inventar una
octava página crearía una segunda experiencia de Stella. Integración
implementó el wrapper tipado
(`app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection.tsx`) y
**no lo montó**.

**El único montaje pendiente** es una línea en la página que PRODUCT designe
como canónica:

```tsx
<StellaGroundedQuerySection projectId={projectId} step="<el paso de esa página>" />
```

No requiere cambio de navegación global, ni ruta nueva, ni tocar el server
action. La decisión de *cuál* de las siete es de PRODUCT, no de integración.

### INT-GR-001 — Lectura gobernada de versión activa (tren 3)

**Solicitante:** INTEGRACIÓN · **Propietaria:** GROUNDING (con CAPABILITIES
para el SQL) · **Estado:** `solicitado`

`uellix_grounding.chunks_in_scope` toma un `document_version_id uuid`, y la
única función gobernada que lo devuelve es
`claim_active_document_version(evidence_id)` — que toma `FOR UPDATE` sobre la
fila de evidencia. Es la función de la ruta de **ingesta**; usarla para
responder una lectura tomaría un lock de fila por elemento de evidencia en
cada pregunta.

El adaptador lee por eso directamente de `public.evidence_document_versions`
con predicados explícitos de organización, proyecto y evidencia. Funciona y es
seguro, pero duplica la definición de «versión activa»
(`ORDER BY ordinal DESC NULLS LAST`) fuera del paquete que la posee.

**Se pide:** una función `STABLE`, sin lock, del tipo
`active_document_versions_in_scope(org, project, evidence_id[])`.

### INT-GR-002 — Aislamiento por proyecto (A-F1, tren 3)

**Solicitante:** INTEGRACIÓN · **Propietaria:** GROUNDING · **Estado:** `solicitado`

A-F1 sigue abierto: `validateAnswerCitations` compara sólo `organizationId`,
así que una cita de **otro proyecto de la misma organización** se valida como
correcta. El tren 3 **no lo cierra** y **no lo compensa en la UI** — hacerlo
crearía una segunda respuesta divergente a «¿puede leerse esto?».

Lo que sí hizo integración es **no delegar** el aislamiento por proyecto en esa
función: el adaptador declara `project_id` explícitamente en su `WHERE`, y
`chunks_in_scope` lo declara una segunda vez. Dos afirmaciones independientes
de la misma frontera. La policy RLS de `evidence_document_versions` es
**org-scoped, no project-scoped**, así que RLS no lo aporta y el predicado
explícito no es redundante.

### INT-GR-003 — `ChunkLocation` no reconstruible (tren 3)

**Solicitante:** INTEGRACIÓN · **Propietaria:** CAPABILITIES · **Estado:** `solicitado`

`evidence_chunks` almacena `char_start`/`char_end` (el span autoritativo),
`page` y `section_index`. **No** almacena `section_label`, `line_start` ni
`line_end`, que `ChunkLocation` declara. `sectionLabel` es nulable y se mapea a
`null` sin problema; el rango de líneas está tipado `number`.

El adaptador usa el centinela `0`, **fuera del dominio 1-based documentado**,
para que «no recuperable desde persistencia» sea distinguible de un número de
línea plausible pero equivocado — que es lo que sería cualquier valor dentro
del dominio. El contrato ya llama al rango de líneas «derivado, no
autoritativo».

**Se pide:** o persistir las dos columnas, o hacerlas nulables en el contrato.
Integración no eligió por las dos líneas.

### INT-PR-001 — Clave canónica de decisión (tren 3)

**Solicitante:** INTEGRACIÓN · **Propietaria:** PRODUCT · **Estado:** `solicitado`

`recordStellaDecision` se ancla en `suggestionKey`. Una respuesta fundamentada
**no es una sugerencia**: una sugerencia propone texto que sobrescribe un campo
del informe; una respuesta fundamentada lleva afirmaciones verificadas con
citas respaldadas por hash, y editarlas las desataría de su evidencia.
Reutilizar `suggestionKey` archivaría dos entidades distintas en una tabla y
haría que «¿esto se guardó?» tuviera dos respuestas divergentes.

Por eso el wrapper **no cablea `onDecision`**. El panel emite la decisión a
nadie, no muestra nada que afirme persistencia, y
`STELLA_DECISIONS_PERSISTENCE_ENABLED` sigue en `false`.

**Se pide:** una clave canónica de decisión para respuestas fundamentadas
—anclada en `answerId`, que el servidor ya genera— o una demostración de que
`suggestionKey` representa la misma entidad. No se retrasó el query runtime
por esta decisión, que es independiente.

---

## Revisión adversarial del tren 3 (integración, 2026-08-05)

Dos revisores independientes de sólo lectura, sin ejecutar nada:
**A — datos y seguridad** y **B — runtime y producto**. Se corrigieron
únicamente los BLOCKER y MAJOR **confirmados**; lo que pertenece a otra línea
se registra abajo como solicitud, no se edita durante integración (§12).

### Corregido en esta integración

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| A-F1 | **BLOCKER** | El adaptador seleccionaba `v.source_label`, columna que `evidence_document_versions` **no tiene** (14 columnas, y el paquete afirma el conteo). Toda consulta habría lanzado 42703 — y el sanitizador lo habría convertido en el **mismo** `provider_unavailable` que el estado esperado, haciendo el defecto invisible | `source_label` se une desde `evidence_items.title` bajo los mismos predicados de organización y proyecto. Cuatro pruebas cruzadas nuevas reconcilian **cada** columna que el adaptador nombra contra el DDL y contra la firma de `chunks_in_scope` |
| A-F3 | MAJOR | El guard de scope era **tautológico**: `chunks_in_scope` no devuelve `organization_id`/`project_id`, así que `chunk.scope` se estampaba desde la consulta y `enforceRepositoryScope` se comparaba consigo mismo | No se falsificó una comprobación. Se documenta exactamente dónde reside la imposición real (tres afirmaciones en SQL), se prohíbe explícitamente añadir una cuarta comprobación decorativa, y se abre **INT-GR-004** |
| A-F9 | MAJOR | `GroundingRepositoryContractError` extendía `Error`, así que `orchestrateGroundedResponse` lo degradaba a `provider_unavailable` — una ruptura de frontera reportada como una caída reintentable | Ahora extiende `RepositoryContractViolationError`, con lo que entra en la familia relanzada **por construcción**, no por una segunda lista que alguien deba recordar |
| A-F5 | MAJOR (impacto acotado) | Todo export de un módulo `'use server'` es un endpoint invocable, así que exportar la forma de dos argumentos publicaba un segundo endpoint cuyo `options` lo elige el cliente | Superficie reducida a **un** export. El proyecto se re-verifica contra la organización de la sesión igual que en `getStellaContextualAdvisor`; la pertenencia a la organización es la frontera de acceso a proyectos de este producto (no hay tabla de membresía por proyecto), así que nombrar un proyecto propio no es escalada |
| B-9 | MAJOR | La cuota se **lee** y nunca se **consume**: `checkStellaQuota` cuenta filas de `stella_interactions`, y esta acción no inserta ninguna | No se falsificó. `stella_interactions_stella_role_check` admite seis roles y `grounded_query` no está entre ellos; misfilarlo como `advisor` corrompería la atribución. Se escribe **ya** la mitad auditable (`STELLA_INVOKED`, sólo metadata), se abre **INT-CAP-001**, y el gate de release lista la cuota no consumida como evidencia faltante para `local-runtime-ready` |
| B-12 | MAJOR | El panel pintaba «Aceptada» / «Rechazada» idéntico a los flujos con persistencia real, sin `onDecision` conectado — y el comentario del wrapper afirmaba falsamente que «no muestra nada que afirme persistencia» | El panel **lo dice**: «Esta decisión no se guardó: queda sólo en esta sesión y se pierde al recargar», visible sólo cuando no hay sink. Comentario corregido. Tres pruebas nuevas |
| B-doc | MINOR | El wrapper afirmaba que el `projectId` ligado «nunca es parte de la petición que envía el navegador». Con `.bind`, Next.js sí lo transmite, cifrado | Comentario corregido: el navegador no puede leerlo ni forjarlo, y **la frontera real** es la re-verificación contra la organización de la sesión |

### Confirmado sin defecto

Ataques que **fallan**, verificados por el revisor A contra el código: cadena
canónica, ciclo de cualquier longitud, `canonical_chunk_id` inexistente,
bypass con `session_replication_role` desde cualquier superficie alcanzable
por la aplicación, escritura directa fuera de las funciones gobernadas,
identidad incorrecta en el adaptador, scope recibido desde el cliente en la
capa del adaptador. Y por el revisor B: tercer vocabulario, mapeo divergente,
atribución inferida, `node:crypto` en cliente, retrieval dentro de componente,
fallback mock alcanzable en runtime, bandera comprobada tarde, permiso
omitido, error interno expuesto, evento con prompt o evidencia,
`local-runtime-ready` satisfacible por mera existencia de archivos.

Sobre el último: el revisor B verificó que la degradación es **incondicional**
— `missingForLocalRuntime` añade sin filtro las líneas de persistencia sin
aplicar y de generador ausente, así que `localRuntimeReady` no puede ser
`true` mientras esos hechos sigan siendo hechos.

### INT-CAP-001 — Rol `grounded_query` en el ledger de cuota

**Solicitante:** INTEGRACIÓN · **Propietaria:** CAPABILITIES · **Estado:** `solicitado`

`checkStellaQuota` cuenta filas de `stella_interactions`;
`stella_interactions_stella_role_check` admite `advisor`, `validator`,
`composer`, `proxy_reviewer`, `evidence_reviewer`, `audit_assistant`. Una
consulta fundamentada no es ninguno de esos seis, así que la capacidad
**impone** una cuota mensual que no puede **cobrar**.

**Se pide:** añadir `grounded_query` al CHECK. Integración no lo hizo: es un
cambio de esquema en ruta de CAPABILITIES, y las dos alternativas locales
—misfilar como `advisor`, o ensanchar el CHECK unilateralmente— son peores que
la brecha. Bloquea `local-runtime-ready` y por tanto el encendido de la
bandera.

### INT-CAP-002 — `evidence_chunks` concede SELECT directo a `authenticated`

**Solicitante:** INTEGRACIÓN · **Propietaria:** CAPABILITIES · **Estado:** `solicitado`

`grounding_0003` §5 concede `SELECT` sobre `public.evidence_chunks` al rol
`authenticated`, y la policy `evidence_chunks_select` filtra **sólo**
`organization_id`. La cabecera de §6 dice «organization **and** project
isolation»; el código impone organización. Lo mismo en `grounding_0002` §RLS.

Consecuencia: con el paquete aplicado, PostgREST expondría los chunks de
**todos los proyectos de la organización** del llamante, saltándose
`chunks_in_scope` y su filtro `canonical_chunk_id IS NULL`, que es lo único
que impide citar un duplicado suprimido.

**Atenuante, no descargo:** este producto no tiene membresía por proyecto —
`buildAdvisorContext` autoriza un proyecto comprobando sólo que pertenezca a la
organización de la sesión— así que el alcance coincide con el que ya tiene
cualquier otra acción de Stella. Pero entonces la cabecera de §6 **sobreafirma**
y el adaptador está defendiendo una frontera que la base de datos no tiene.

**Se pide:** o añadir el predicado de proyecto, o corregir la cabecera. No
alcanzable hoy: el paquete no está aplicado en ninguna base.

### INT-CAP-003 — `content_hash` nunca se verifica contra `content`

**Solicitante:** INTEGRACIÓN · **Propietaria:** CAPABILITIES · **Estado:** `solicitado`

`insert_evidence_chunks` valida que `content_hash` sea 64-hex y **deriva**
`chunk_id` de él, pero nada calcula `sha256(content)` y compara; `char_start` /
`char_end` tampoco se contrastan contra el texto normalizado. El `chunk_id`
derivado en servidor certifica por tanto un digest **elegido por el llamante**,
y la comprobación de re-derivación del adaptador pasa porque re-deriva del
mismo valor sin verificar.

Esto no rompe el aislamiento, pero sí la afirmación de la cabecera del propio
paquete: que un tercero pueda re-normalizar, cortar el span declarado, hashear
y recuperar `content_hash`. No alcanzable desde la aplicación: ningún
TypeScript llama a `insert_evidence_chunks`.

### INT-CAP-004 — Rollback incompleto y forja de `chunk_id` por el owner

**Solicitante:** INTEGRACIÓN · **Propietaria:** CAPABILITIES · **Estado:** `solicitado`

Dos defectos menores del mismo paquete:

1. `grounding_0003_rollback.sql` condiciona **todos** sus `DROP FUNCTION` a que
   la tabla exista. Si `evidence_chunks` desapareció por otra vía, el rollback
   informa éxito y deja `insert_evidence_chunks`,
   `finalize_document_ingestion` y `chunks_in_scope` instaladas y ejecutables
   por `uellix_app`; el rollback de `0002` encuentra entonces funciones
   residuales y se niega permanentemente a soltar el esquema y el rol.
2. `evidence_chunks_hash_shape_check` sólo exige que `chunk_id` sea 64-hex; la
   derivación vive únicamente en el cuerpo de la función. §5 revoca de siete
   principales pero no de `uellix_owner`, que conserva INSERT y no está sujeto
   a RLS — así que un `chunk_id` forjado es representable por el owner. El
   impacto está acotado por la re-derivación del adaptador, que lanza… y al ser
   por consulta y no por fila, **una** fila corrupta mata la consulta entera.

### INT-GR-004 — `chunks_in_scope` debería devolver el scope de la fila

**Solicitante:** INTEGRACIÓN · **Propietaria:** GROUNDING (SQL: CAPABILITIES) · **Estado:** `solicitado`

`chunks_in_scope` devuelve 13 columnas y ni `organization_id` ni `project_id`
están entre ellas, así que el adaptador no puede leer el scope de la fila y lo
estampa desde la consulta. Consecuencia exacta: las comprobaciones
`isSameScope` / `scopeContains` de `enforceRepositoryScope` son
**tautológicas** contra el único repositorio de producción — sus
comprobaciones de `evidenceId` / `versionId` siguen siendo reales.

La imposición efectiva descansa en tres afirmaciones SQL independientes y en
cero de TypeScript. Es suficiente, pero **no es lo que un lector de
`enforceRepositoryScope` supondría**.

**Se pide:** devolver ambas columnas, para que el guard sea portante en vez de
decorativo. Integración documentó la situación en el adaptador y prohibió
explícitamente añadir una cuarta comprobación que leyera los campos
fabricados: parecería verificación y no verificaría nada.


---

## Resolución del tren 4 (integración, 2026-08-05)

Cuatro ramas fusionadas con `--no-ff`: `codex/stella-capabilities` (`e47b34f`),
`codex/stella-grounding` (`04f950e`), `codex/stella-product` (`19e8f5b`),
`codex/stella-release` (`a08bd7a`).

### Lo que cierra

**INT-CAP-001 → `aceptado`.** `db/prepared/stella_0013_grounded_query_quota.sql`
admite `grounded_query` en el CHECK del ledger e instala
`uellix_stella.consume_stella_quota`, que comprueba **y cobra** dentro de la
transacción del llamante bajo un lock de advisory por organización. Verificado
en vivo (`scripts/stella-train4-dry-run.sh`): primer consumo, agotamiento,
organización cruzada `U0102`, proyecto cruzado `U0102`, rol no gobernado
`U0106`, y dos sesiones reales disputando la última unidad.

**INT-CAP-002 / INT-CAP-003 → `aceptado`.** `grounding_0004` §2b retira el
`SELECT` de `authenticated` sobre `evidence_chunks` y lo saca de la policy;
§1a/§1b atan `content_hash = sha256(content)` y la cota del span con `CHECK`
—que alcanza al dueño y no lo silencia `session_replication_role`.

**INT-CAP-004 → `aceptado`, las dos partes.** §1c ata la derivación de
`chunk_id` como `CHECK`. La parte (1), el rollback, se reparó **en esta
integración**: los cuatro `DROP FUNCTION` de `grounding_0003_rollback.sql`
salieron del `ELSE` de «si la tabla existe» y son ahora incondicionales, con
una aserción posterior que verifica que ninguna sobrevivió. El defecto no era
cosmético: `uellix_cap_grounding` posee las tres funciones, PostgreSQL se niega
a retirar un rol que aún posee algo, y por tanto un rollback que reportaba
éxito dejaba el rollback de `grounding_0002` **permanentemente imposible**.
Vigilado por el gate `rollback-function-drop-unconditional` (extendido para
leer ese fichero) y por dos mutaciones nuevas, `T-61` y `T-62`. Convergencia
comprobada en vivo: `grounding-dry-run.sh` vuelve exactamente al baseline
`38/107/0/0/0/10` y la reaplicación da `40/114/1/5/1/16`.

**INT-GR-002 → `aceptado`.** El arreglo **ya existía** en `8b8693e`, anterior
al HEAD del tren 3; la descripción del contrato estaba desactualizada. Lo que
el tren 4 añadió es **validación E2E**, no implementación — no debe
describirse como trabajo hecho de nuevo.

**INT-GR-004 → `aceptado`.** `grounding_0004` §3 publica
`chunks_in_scope_attested` (17 columnas: las 13 más el scope real de la fila) y
`db/grounding/grounding-chunk-repository.ts` migró a ella: el scope de cada
chunk se lee **de la fila**, y el server action activa
`requireScopeAttestation: true`. La comparación de `enforceRepositoryScope`
dejó de ser tautológica. `chunks_in_scope` no se elimina —su rollback y su
reaplicación la necesitan— simplemente ya no la usa ninguna ruta de runtime.

**PRODUCT-002 → `aceptado`.** Montado en
`app/app/projects/[projectId]/page.tsx` — la superficie de proyecto, fuera de
los siete pasos metodológicos. Payload `{ query }`, scope derivado en
servidor, `onDecision` sin cablear.

### Lo que queda abierto

**INT-GR-001 — defecto acotado, propietaria reasignada a CAPABILITIES.**
`claim_active_document_version` reimpone la frontera de **organización**
(`v_org = ANY(current_user_org_ids())`) y **no filtra `project_id`**: su
predicado final es `v.evidence_id = p_evidence_id` a secas. Un `evidence_id` de
otro proyecto de la propia organización se responde. Además devuelve siete
columnas y ninguna es scope, así que el llamante tampoco puede detectarlo — el
gemelo de INT-GR-004 en la ruta de ingesta. **No se declara cerrado porque el
llamante conozca el scope.** Repararlo cambia el tipo de retorno, que
`CREATE OR REPLACE` prohíbe (`42P13`), luego exige un paquete nuevo. Mitigado,
no cerrado: `db/grounding/grounding-ingestion-repository.ts` reimpone el
proyecto localmente con un `SELECT` scoped antes de nombrar la evidencia.

**INT-GR-003 — pendiente explícito.** Se conserva la decisión de GROUNDING:
persistir `line_start`/`line_end` cuando exista el contrato SQL, **no**
hacerlos nulables, **no** inventarlos hoy. `LINE_RANGE_NOT_PERSISTED = 0` sigue
siendo explícito y fuera del dominio 1-based, de modo que «no recuperable desde
persistencia» es distinguible de un número plausible pero equivocado. No
bloquea el runtime local: la limitación está representada sin inventar datos.

**INT-PR-001 — pendiente.** Sin clave canónica de decisión; `suggestionKey` no
se reutiliza. La UI declara por escrito que la decisión no se guardó y el E2E
lo comprueba contando filas.

### INT-INT-001 — Clave de idempotencia sin fuente canonica (tren 4)

**Solicitante:** INTEGRACIÓN · **Propietaria:** INTEGRACIÓN ·
**Estado:** `solicitado`, **bloqueante de `local-runtime-ready`**.

`uellix_stella.consume_stella_quota` exige `idempotency_key`, y la exigencia es
correcta: `uq_stella_interactions_idempotency` convierte «no cobrar dos veces
un reintento» en una propiedad de los **datos** y no de quién llamó. Pero una
clave sólo vale por la distinción que traza, y debe trazar exactamente una:

```
reintento de una consulta  ->  misma clave   (cobra una vez)
consulta nueva             ->  clave nueva   (vuelve a cobrar)
```

Ninguna fuente alcanzable satisface ambos lados:

| Candidata | Falla |
|---|---|
| `randomUUID()` por invocación | el cliente no la influye, pero el reintento recibe clave nueva → **cobra dos veces** |
| digest de (usuario, proyecto, consulta) | estable en el reintento y **también** entre dos preguntas legítimas iguales → la segunda es gratis; prohibido explícitamente por el despacho |
| bucket temporal | el mismo colapso, con ventana arbitraria, y sin firma no protege reintentos |
| valor en el payload | `StellaGroundedQueryRequest` es `{ query }` y debe seguir siéndolo; una clave elegida por el cliente es un descuento elegido por el cliente |
| argumento vinculado (`bind`) | **inforjable** —Next.js lo sella en servidor y viaja cifrado— pero se fija en el **render**, y un render sirve muchas preguntas: es constante justo donde debe variar |

Buscado y **no encontrado** en esta aplicación: `requestId` / `correlationId` /
`invocationId` canónico (no hay middleware; `headers()` sólo se usa para la IP
del rate limit); secreto de firma de propósito general (sólo `STRIPE_*`, de
otro dominio); tabla de tickets de operación emitidos.
`lib/capabilities/contracts.ts` CAP-05 define el vocabulario `replayed` pero
está `enabled: false` y no emite claves.

**Decisión: no se llama a la función.** Llamarla con un uuid por invocación
parecería cerrar el hueco, pasaría una lectura ingenua del ledger y
**cobraría dos veces cada reintento** — un estado peor que el honesto, porque
el fallo sería invisible y aterrizaría en la factura del cliente. La cuota
sigue **impuesta** (la lectura rechaza una organización agotada) y el faltante
queda registrado aquí y en `QUOTA_LEDGER_NOT_CHARGED`
(`app/actions/stella/grounded-query.ts`).

**Qué lo cerraría** — cualquiera de las tres, todas fuera del alcance de una
integración:

1. un `requestId` de aplicación, emitido por middleware y estable entre
   reintentos de una misma invocación;
2. una tabla de tickets de un solo uso emitidos por servidor, con la
   **re-ejecución rechazada** sobre un ticket ya cobrado — lo que además evita
   que reutilizar un ticket consiga trabajo gratis;
3. un secreto de firma dedicado que permita un token opaco por consulta cuya
   integridad sea demostrable.
