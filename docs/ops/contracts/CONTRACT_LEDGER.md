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
| GR-CAP-002 | CAPABILITIES | GROUNDING | `solicitado` | 2026-08-04 | [`EXTRACTOR_VERSION` canónico](#gr-cap-002--extractor_version-tren-3) (§ abajo) |

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
