# Línea de trabajo: CAPABILITIES

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-capabilities`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-capabilities`
- **HEAD base:** `ff1ffb6` (`docs(ops): define parallel Stella workstreams`) —
  el `INTEGRATION_ROOT_HEAD` de esta campaña
- **Propietario:** sin asignar

## Rutas autorizadas (exclusivas)

- `db/**`
- `supabase/**`
- `db/prepared/**`
- Cualquier migración, policy, rol, función SQL, esquema, grant o RLS en
  cualquier ubicación del repositorio.
- `docs/ops/capabilities/CAP_01_INVITATIONS.md` … `CAP_05_ORGANIZATION_BOOTSTRAP.md`
- El hallazgo de referencia `RR-CAP-10` (ver nota de numeración en el
  documento de gobernanza §3).
- **`lib/capabilities/**` — declarado en esta unidad.** Módulo dedicado de
  contratos TypeScript, por paridad con lo que §4 concede a GROUNDING
  («contratos TypeScript … o módulo dedicado que la línea defina»). Se registra
  aquí y en `docs/ops/contracts/CONTRACT_LEDGER.md` en vez de asumirse por
  propiedad tácita, que es lo que §7 prohíbe.

## Rutas prohibidas

- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7.
- Componentes de UI, Composer, experiencia Stella (propiedad de PRODUCT).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING) salvo el esquema/tabla que los soporte, que sí
  es de esta línea bajo contrato.
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Ninguna dependencia de entrada de otra línea.
- GROUNDING y PRODUCT dependen de los contratos de esquema que esta línea
  publique — ver "Contratos".

## Contratos

Ledger: [`docs/ops/contracts/CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md)
(ruta creada por esta unidad; era la «ruta nueva prevista» de §8).

| ID | Dirección | Estado |
|---|---|---|
| CT-CAP-001 | CAPABILITIES **publica** los contratos de aplicación CAP-01…CAP-05 | `solicitado` |
| CT-CAP-002 | CAPABILITIES **pide** a integración normalizar `RR-CAP-10-A-bis` | `solicitado` |
| CT-CAP-003 | CAPABILITIES **pide** a integración `db/prepared/** text eol=lf` en `.gitattributes` | `solicitado` |
| CT-CAP-004 | CAPABILITIES **pide** a integración documentar `UELLIX_STRIPE_DATABASE_URL` en `.env.example` | `solicitado` |
| GR-001 | GROUNDING **pide** a CAPABILITIES provenance y versionado en `evidence_chunks` | `IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE` (tren 2) |
| GR-002 | GROUNDING **pide** a CAPABILITIES historia append-only de versiones | `IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE` (tren 2) |

> **Estados desactualizados.** Esta tabla registra los estados *en el momento
> de la entrega*. Tras el tren 1 de integración, CT-CAP-001, CT-CAP-002 y
> CT-CAP-003 están `aceptado` y sólo CT-CAP-004 sigue `solicitado`. La fuente
> de verdad es [`CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md); el
> detalle está en §Integración — tren 1 al final de este documento.

## Unidad actual

**TRAIN 1 — `CAP-03`: escrituras de capacidad por funciones gobernadas, y
publicación de contratos.** Entregada.

### Qué se cerró

Los **tres `UPDATE` directos sobre `organizations`** de
`app/api/webhooks/stripe/route.ts`. Estaban muertos detrás de
`WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false` y aun así había que quitarlos:
`stella_0011` sacó `stella_monthly_quota`, `stella_plan_label` y las tres
columnas `stripe_*` de todo grant `UPDATE` del runtime, de modo que esas
sentencias levantarían **42501** en cuanto alguien encendiera la bandera — un
fallo cuya causa (un ACL aplicado semanas antes) no está cerca de la línea que
falla.

Además eran el último sitio del árbol donde sobrevivía la **forma** del diseño
antiguo: leer la organización con el ORM, decidir en TypeScript a qué fila
pertenece un evento de Stripe, y escribirla. Todo el argumento de tenencia de
CAP-03 depende de que esa decisión **no** se tome ahí.

### Identificador canónico del riesgo

**`RR-CAP-10-A`** (registro de riesgos, línea 273). `RR-CAP-10-A-bis` **no
existe** en el registro: sus únicas dos apariciones en el árbol son la nota de
la propia gobernanza §3 y un comentario de prosa en
`lib/admin/organization-administration.ts:11`. Los tres `UPDATE` del webhook son
el **resto no cerrado de `RR-CAP-10-A`**, que la edición anterior dejó fuera
explícitamente. Solicitud de normalización: **CT-CAP-002**.

### Forma nueva

```
route.ts  →  lib/capabilities/stripe-webhook.ts  →  db/capabilities/stripe-capability-executor.ts
   |                    |                                        |
firma HMAC        plan + disposición                     conexión uellix_stripe
   |              (puro, sin driver)                     → las 3 funciones de stella_0008
   +-- gate: WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false ------------------+
```

- **Ninguna escritura directa sobre `organizations`.** El route no importa
  `@/db/client` ni la tabla; la capa tipada tampoco.
- **La organización se deriva de la correlación validada.** La capa transporta
  los dos identificadores emitidos por Stripe; la fila la resuelve
  `stripe_apply_subscription` bajo `cap_stripe_only_claimed_read` /
  `cap_stripe_only_claimed_org`. **La rama `client_reference_id` desaparece del
  árbol** (DP-CAP-15) en vez de «validarse»: ningún predicado sobre la fila
  actual distingue una primera suscripción legítima de una reclamación hostil,
  porque la única evidencia en ambos sentidos es el campo que elige el atacante.
- **Sin atajo por la clave elevada de Supabase** (RR-CAP-10-C). La conexión es
  `uellix_stripe`, con su propia variable, y el rol declarado se valida antes de
  abrir socket.
- **`U0003` conserva semántica reintentable**: 503, sin marcar el evento como
  fallido — la subtransacción se deshizo y la fila sigue reclamable.
- **Los errores inesperados siguen fallando.** Sólo `U0001` y `U0003` se mapean
  a disposiciones; cualquier otro SQLSTATE se propaga y el route contesta 500.
- **La bandera sigue apagada** y sigue evaluándose antes de que nada pueda
  alcanzar la base de datos. `stella_0008` no está aplicado en ninguna parte y
  `UELLIX_STRIPE_DATABASE_URL` no está aprovisionada: sin credencial el
  resolutor devuelve `null` y el handler contesta `unavailable` / 503.
- **Ninguna declaración de disponibilidad en entorno alojado.**

De paso se cierra **RR-CAP-03-B**: el `catch` genérico registraba el objeto de
error completo, y un error del driver puede citar el valor de la fila que falló
—aquí, datos de pago—. Ahora registra sólo `error.name`, como la ruta de leads.

## Pruebas ejecutadas

Focalizadas (§11), nunca en paralelo con otra línea. Sin gates pesados, sin
Docker, sin `supabase start`, sin remoto.

| Suite | Resultado |
|---|---|
| `tests/stripe-webhook-capability.test.ts` (nueva, 32 casos) | **verde** |
| `tests/stripe-webhook-route.test.ts` (9 casos, 2 reescritos) | **verde** |
| `tests/capability-isolation.test.ts` | verde salvo 1 fallo preexistente (ver riesgos) |
| `tests/database-{runtime-entrypoints,target-safety,role-safety,runtime-identity}.test.ts` | **verde** |
| `tests/capability-documentation.test.ts`, `tests/database-ddl-containment.test.ts`, `tests/prepared-sql-source-of-truth.test.ts`, `tests/admin-organization-administration.test.ts`, `tests/marketing-lead-route.test.ts`, `tests/database-migrator-path.test.ts` | **verde** |
| `pnpm typecheck` | **verde** |
| `pnpm lint` (focalizado a los ficheros tocados) | **verde** |

Lo que la suite nueva demuestra: cero `UPDATE` directo alcanzable; bandera
apagada y evaluada primero; correlación de organización sin `client_reference_id`;
`U0003` reintentable sin marcar fallo; error inesperado no absorbido; contratos
exportados y exhaustivos (con guarda `never`); ausencia de la clave elevada;
compatibilidad de firmas, SQLSTATEs, códigos de fallo y estados de reclamación
contra `db/prepared/stella_0008_stripe_webhook_identity.sql`.

## Riesgos

- **CT-CAP-003 — `db/prepared/**` se materializa en CRLF y rompe cuatro suites.**
  `.gitattributes` fija `eol=lf` para `db/baseline/**` y para los scripts de
  shell, y no para `db/prepared/**`; con `core.autocrlf=true` el checkout
  reescribe los 32 `.sql` a CRLF y cuatro suites que anclan en `\n` fallan
  (`capability-isolation`, `prepared-stella-sql`, `capability-policy-contract`,
  `capability-mutation`). **Medido, no deducido:** normalizando a LF en el
  worktree las cuatro entregan `687 passed`; restaurando con
  `git checkout -- db/prepared/` vuelven los cuatro fallos. Preexistente en
  `ff1ffb6`, ajeno a los ficheros de esta unidad, y **no reparable desde esta
  línea** porque `.gitattributes` es `INTEGRATION-OWNED`.
- **`tests/database-entrypoint-safety.test.ts` — la suite de integración
  colecciona 0 de 49 tests.** El worktree no tiene `.env.local`, así que
  `resolveRuntimeDatabaseUrl()` aborta en el guard al importar. Ambiental y
  preexistente; levantarlo exigiría el stack local, prohibido en esta unidad.
- **Precio no mapeado — acoplamiento a un centinela.** `mapStripePriceToQuota`
  devuelve la cuota gratuita para un precio desconocido, lo que como valor por
  defecto de una lectura es inocuo y como entrada de un `UPDATE` de
  `stella_monthly_quota` es **una degradación silenciosa de un cliente que
  paga** cada vez que se añade un precio en Stripe antes que en el entorno.
  `stripePlanResolverFrom` lo convierte en `price_unmapped`, pero la única
  señal que expone el mapeo actual es la etiqueta `'Custom'`. Hacer que el mapeo
  devuelva un «no mapeado» explícito toca `lib/stripe/client.ts`, que tiene
  otros *call sites* (facturación, UI), y pertenece a habilitar la capacidad.
- **`lib/admin/organization-administration.ts` tiene ahora un comentario falso**
  («still contains three … statements»). No se corrige aquí porque va atado a la
  resolución de **CT-CAP-002**.
- **RR-CAP-14-A sigue abierto e inherente**: la base de datos no puede verificar
  una firma de Stripe. La credencial de `uellix_stripe` **es** la frontera de
  confianza. Nada de esta unidad lo cambia y nada de esta unidad lo insinúa.

## Estado de entrega a integración

**Entregado. Árbol limpio.** Dos commits locales sobre `ff1ffb6`, sin push:

1. `refactor(app): route capability writes through governed functions`
2. `feat(app): publish capability application contracts`

Nada aplicado a ninguna base de datos. Ningún acceso a remoto. Ningún paquete
`db/prepared/**` modificado ni aplicado. Ninguna capacidad habilitada.

**Ficheros solicitados a integración** (no modificados por esta línea):
`.gitattributes` (CT-CAP-003), `.env.example` (CT-CAP-004),
`docs/ops/STELLA_FABLE_RISK_REGISTER.md` y
`lib/admin/organization-administration.ts` (CT-CAP-002).

---

## Integración — tren 1 (2026-08-04)

**Fusionada.** HEAD integrado `4c40a8e`, commits `7002f86` y `4c40a8e`, merge
commit `95ce36b` (`--no-ff`). Primera de las cuatro en entrar, sin conflictos.

### Pruebas focalizadas en el HEAD integrado

16 archivos: **1184 passed, 61 skipped, 0 failed**. Incluye las 32 pruebas
nuevas de `stripe-webhook-capability` y las 9 de `stripe-webhook-route`.

Confirmado en el árbol integrado, no reafirmado desde el documento de entrega:

- `WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false` y se evalúa antes de que nada
  alcance la base de datos (`route.ts:58`, `:113`).
- Cero `db.update(organizations)` alcanzable. Ni el route ni la capa tipada
  importan `@/db/client`.
- `client_reference_id` sobrevive **sólo en prosa** que explica su retirada:
  ningún camino de código lo lee.
- `U0003` → `retry` sin escribir fila `failed`; `U0001` → `refused` con
  `org_not_resolved`; cualquier otro SQLSTATE se propaga.
- `db/prepared/**` y `db/baseline/**` sin un solo cambio de contenido.
- Ninguna base de datos modificada.

### Contratos

- **CT-CAP-001 → `aceptado`.** El tren incorporó la unidad, que era la
  condición declarada. Aceptarlo no habilita ninguna capacidad.
- **CT-CAP-002 → `aceptado`, opción A.** Alias retirado; `RR-CAP-10-A` es el
  identificador canónico. Comentario falso de
  `lib/admin/organization-administration.ts` reescrito y cierre del resto del
  webhook anotado en el registro de riesgos.
- **CT-CAP-003 → `aceptado`.** `.gitattributes` recibió
  `db/prepared/** text eol=lf`. La renormalización produjo **cero blobs
  nuevos** — los `.sql` ya estaban en LF en el índice; era el checkout el que
  los materializaba en CRLF. Las cuatro suites afectadas entregan **687
  passed**, la misma cifra que esta línea midió a mano.
- **CT-CAP-004 → sigue `solicitado`.** No aplicado: la unidad de integración
  tiene prohibido modificar archivos `.env`. No es un rechazo; es trabajo de
  entrada del primer tren con `.env.example` entre sus rutas.

### Riesgos de esta línea tras la integración

- **CT-CAP-003 — cerrado.** Ya no es un riesgo.
- **`tests/database-entrypoint-safety.test.ts` — sigue abierto, ambiental.**
  Reproducido en el worktree de integración: la suite colecta **0 de 49**
  porque no hay `.env.local` y `resolveRuntimeDatabaseUrl()` aborta al importar.
  Los cinco archivos implicados tienen **0 commits desde `ff1ffb6`**. No es
  regresión de integración y no se corrige aquí (exigiría crear un archivo de
  entorno, prohibido en esta unidad).
- **Precio no mapeado → cuota gratuita** — abierto, atado a habilitar CAP-03.
- **RR-CAP-14-A** — abierto e inherente: la base de datos no puede verificar
  una firma de Stripe.

### Trabajo de entrada del tren 2

Evaluar **GR-001** y **GR-002** (peticiones de GROUNDING sobre
`evidence_chunks` e historia de versiones). Son el bloqueo R1 de esa línea: sin
ellas, cualquier persistencia de grounding perdería los campos que hacen
verificable una cita. Y **CT-CAP-004**, si la unidad recibe `.env.example`.

### Hallazgos de la revisión adversarial de integración

- **A-F2 (MAJOR, abierto) — `unavailable` tiene dos definiciones de
  retryabilidad dentro de CT-CAP-001.** `capabilityUnavailable`
  (`lib/capabilities/contracts.ts:466`) devuelve
  `retryable: reason !== feature_flag_disabled`, con el razonamiento escrito
  en `:156-160`. `stripeCapabilityUnavailable` pasa por `result()`
  (`stripe-webhook.ts:329`), donde `unavailable` es **siempre** retryable con
  503. `route.ts:66-68` afirma que la regla «está declarada en un solo sitio y
  no puede divergir»; ya divergió.

  **El comportamiento de CAP-03 es el correcto** y no debe cambiarse a la
  ligera: contestar 200 a un evento de Stripe con la bandera apagada haría que
  Stripe abandonara la entrega, y una suscripción no llegaría nunca. Lo que
  está mal es el contrato genérico, que documenta lo contrario.

  Agravante: `capabilityUnavailable` **tiene cero llamadas** en todo el árbol, y
  `tests/stripe-webhook-capability.test.ts:176` sólo ejercita
  `database_identity_unavailable` — el único motivo en que ambas reglas
  coinciden. `feature_flag_disabled`, el único alcanzable hoy en producción,
  es justo el caso divergente sin prueba.

  **Caveat sobre la aceptación de CT-CAP-001:** el contrato se aceptó porque el
  tren incorporó la unidad, no porque sea internamente coherente. Reconciliar
  las dos reglas es trabajo de entrada de CAPABILITIES tren 2.

- **A-F9 (MINOR, abierto)** — `tests/capability-isolation.test.ts` recorre
  `lib/` y `app/`, no `db/`. Las tres invocaciones literales
  `uellix_capability.stripe_*` viven en
  `db/capabilities/stripe-capability-executor.ts:137,147,160`, fuera del
  escaneo. Una cuarta invocación añadida ahí no rompería el invariante que el
  propio comentario del test declara.

---

# TRAIN 2 — GR-001 y GR-002: persistencia de grounding

**HEAD inicial `597819b`. Entregada. Árbol limpio. Sin push.**

## Unidad

Resolver los dos contratos que GROUNDING dirigió a esta línea, y cerrar los
hallazgos adversariales asignados a CAPABILITIES.

Respuesta técnica completa:
[`GR-CAP-001`](../contracts/GR-CAP-001_grounding_persistence_response.md).
**No se editó `CONTRACT_LEDGER.md`** — el estado lo fija integración (§8), no la
línea propietaria. Los dos contratos quedan declarados
`IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE`, **nunca `ACCEPTED`**.

### Qué se entregó

| Paquete | Rollback | Objeto | Contrato |
|---|---|---|---|
| `db/prepared/grounding_0002_document_versions.sql` | `grounding_0002_rollback.sql` | `evidence_document_versions` (14 col.) + rol `uellix_cap_grounding` + esquema `uellix_grounding` + 2 funciones | GR-002 |
| `db/prepared/grounding_0003_evidence_chunks.sql` | `grounding_0003_rollback.sql` | `evidence_chunks` (23 col.) + 3 funciones | GR-001 |

Forward: `stella_0004` → `grounding_0002` → `grounding_0003`.
Rollback: `grounding_0003` → `grounding_0002`.

**Nada aplicado a ninguna base.** Sin remoto, sin stack persistente, sin Docker,
sin banderas, sin `service_role`.

### `grounding_0001` queda supersedido, no ampliado

El hallazgo que decidió el diseño, y que **ninguno de los dos contratos
nombra**: `UNIQUE (evidence_id, chunk_index)` no está incompleta, es
**incompatible** con GR-002. Con historia de versiones, la versión 2 de un
documento colisiona con la 1 en `chunk_index = 0` — la segunda versión es
inalmacenable. Sumado a que su guarda de forma **aborta** ante columnas
faltantes (correcto, y por eso no ampliable con un `ALTER`) y a que acopla al
gate G5 P3 que sigue sin decidirse, la sustitución era la única salida.

`grounding_0003` es **pgvector-free**: persistir provenance ya no espera a una
decisión de retrieval de la que no depende. El archivo antiguo se conserva byte
a byte bajo un banner de comentario, porque la evidencia del addendum G2 lo
referencia por nombre y porque `lib/grounding/__tests__/prepared-sql.test.ts`
—propiedad de GROUNDING— fija su contenido: **27 passed** con el banner puesto.

### El segundo hallazgo: `extractor_version`

`versionId = hash(evidenceId, rawContentHash)` **no incluye el extractor**. Un
cambio de extractor produce un `normalized_content_hash` distinto bajo el mismo
`version_id`, y `UNIQUE (evidence_id, version_id)` haría que la reingesta se
descarte como réplica, conservando offsets obsoletos en silencio. La columna
convierte ese fallo silencioso en `U0101`.

**Petición de vuelta a GROUNDING:** `lib/grounding/contracts/core.ts` no publica
`EXTRACTOR_VERSION`. Su ausencia queda fijada por prueba, para que publicarlo
sea un acto visible.

### Aislamiento y camino de escritura

Cero `INSERT`/`UPDATE`/`DELETE` alcanzable por `uellix_app`, `authenticated`,
`anon`, `service_role`, `uellix_writer` o `uellix_auditor` en ninguna de las dos
tablas. Las escrituras pasan por cinco funciones `SECURITY DEFINER` con
`search_path = ''`, propiedad de un rol con **cero miembros**, en su propio
esquema `uellix_grounding` (no `uellix_capability`, para no acoplar el orden de
rollback a la campaña de capacidades). El scope se **deriva** en ingestión y se
**comprueba** en lectura; una policy `RESTRICTIVE FOR ALL` repite el invariante
para todo comando y todo rol.

La historia de versiones no tiene `GRANT DELETE` para **nadie**, ni siquiera
para el definer: es cadena de custodia, no índice derivado. Los chunks sí lo
tienen, porque un reindexado es `DELETE` + `INSERT`.

## Pruebas ejecutadas

Focalizadas (§11). Sin gates pesados, sin Docker, sin remoto, sin `test:unit`
completo.

| Suite | Resultado |
|---|---|
| `tests/grounding-persistence-contract.test.ts` (nueva, 47 casos) | **verde** |
| `tests/grounding-persistence-mutation.test.ts` (nueva, 65 casos; **53 mutaciones, 0 supervivientes**) | **verde** |
| `capability-isolation`, `prepared-stella-sql`, `capability-policy-contract`, `capability-mutation` | **687 passed** |
| `stripe-webhook-capability` (+5 casos, cierre de A-F2), `stripe-webhook-route`, `prepared-sql-source-of-truth`, `capability-policy-parser`, `capability-documentation`, `database-ddl-containment` | **349 passed / 18 skipped** |
| `lib/grounding/__tests__/prepared-sql.test.ts` (GROUNDING, **no modificada**) | **27 passed** |
| `tsc --noEmit`, `eslint` focalizado | **verde** |

Cada mutación declara el gate que **debe** rechazarla. Tres defectos de los
propios gates salieron de esa exigencia y de ninguna otra parte: tres
comprobaciones buscaban su fragmento **en todo el archivo** y quedaban
satisfechas por la copia del bloque de reconciliación mientras la constraint
había desaparecido de la definición de la tabla.

## Hallazgos adversariales — cierre

- **A-F2 (MAJOR) — cerrado.** Reproducido: `capabilityUnavailable` devuelve
  `retryable: false` para `feature_flag_disabled` y `stripeCapabilityUnavailable`
  devuelve `true` con 503. **El comportamiento de CAP-03 es el correcto** y no
  se cambió: contestar 200 o 4xx a Stripe hace que abandone la entrega, y una
  suscripción no llega nunca. Lo que estaba mal era el contrato genérico, que
  documentaba lo contrario, y la afirmación de `route.ts` de que la regla
  «está declarada en un solo sitio y no puede divergir».

  Reparación mínima, sin cambio de comportamiento: las dos preguntas quedan
  **nombradas y distinguidas** en la documentación de ambas funciones (la de
  planificación del llamante frente a la de transporte), `capabilityUnavailable`
  recibe **su primer call site del árbol** dentro de `stripeCapabilityUnavailable`
  —cerrando el agravante de «cero llamadas»—, y cinco pruebas nuevas fijan
  **ambas** respuestas para `feature_flag_disabled`, el único motivo alcanzable
  hoy en producción y justo el que no tenía prueba. Colapsarlas más adelante
  exige ahora un test en rojo delante.

- **A-F9 (MINOR) — cerrado.** `tests/capability-isolation.test.ts` recorre ahora
  `db/` además de `lib/` y `app/`, con el wrapper en la lista de permitidos. Y
  una aserción más de la que el hallazgo no habla: el wrapper **contiene** las
  tres invocaciones, exactamente esas tres — sin ella el escaneo seguiría verde
  el día que el ejecutor se vaciara o se renombrara, que es el mismo punto ciego
  un nivel más adentro.

## Riesgos

- **Finales de línea de `db/prepared/**` — reparado en el worktree, causa
  ambiental.** 31 de los 36 `.sql` estaban materializados en CRLF pese a que
  `.gitattributes` ya declara `db/prepared/** text eol=lf` (CT-CAP-003,
  `aceptado` en el tren 1): el atributo se añadió después de que este worktree
  los sacara. Consecuencia medida: `capability-isolation` fallaba en
  `verify_report is STABLE`, cuyo patrón ancla en `\nSTABLE\n`. Normalizados a
  LF en el worktree, las cuatro suites entregan **687 passed**. **La
  normalización es neutra en contenido**: los blobs del índice ya eran LF, y
  `git add` de cualquiera de esos 31 archivos produce cero cambio.
- **`register_document_version` rechaza la reingesta bajo pipeline distinto**
  (`U0101`) en vez de abrir un ordinal nuevo. Es la lectura estricta y está
  argumentada en GR-CAP-001 §7; la alternativa es una decisión de producto y
  está confinada a esa función y a una prueba.
- **`EXTRACTOR_VERSION` no existe en `lib/grounding`.** La columna es `NOT NULL`
  y quien llame debe declarar algo; publicar la constante lo convierte en un
  valor gobernado. Petición registrada en GR-CAP-001 §5.4.
- **Ninguno de los dos paquetes ha corrido contra una base.** Toda la evidencia
  es estática. La validación real es un gate externo, y este tren tiene
  prohibido ejecutarlo.
- **`tests/database-entrypoint-safety.test.ts`** — sigue abierto y ambiental
  (sin `.env.local`, colecta 0 de 49). Sin cambios desde el tren 1.
- **Precio no mapeado → cuota gratuita** y **RR-CAP-14-A** — abiertos, sin
  relación con esta unidad.

## Estado de entrega a integración

**Entregado.** Dos commits locales sobre `597819b`, sin push:

1. `feat(db): add append-only document version history`
2. `feat(db): persist grounded evidence provenance`

El orden de los mensajes está **invertido** respecto del enunciado de la unidad,
y es deliberado: `grounding_0003` tiene una clave foránea a la tabla que crea
`grounding_0002`, así que el orden inverso dejaría el primer commit referenciando
una tabla que no existe. §10 exige que cada commit sea verde de forma
independiente; con este orden lo son.

**Ficheros solicitados a integración** (no modificados por esta línea):
`docs/ops/contracts/CONTRACT_LEDGER.md` — actualizar las filas GR-001 y GR-002
tras evaluar [`GR-CAP-001`](../contracts/GR-CAP-001_grounding_persistence_response.md).

---

## Estado en el HEAD integrado del tren 2 (integración, 2026-08-04)

Sección añadida por **integración**, no por esta línea. No reescribe nada de lo
anterior: registra qué de lo que esta línea declaró queda confirmado sobre el
árbol fusionado, y qué cambió al cruzarlo con las otras tres.

**Contratos:** GR-001 → **`aceptado`**, GR-002 → **`aceptado`**. El criterio de
aceptación de GR-001 §5 se comprueba mecánicamente en
`tests/cross-workstream/capabilities-to-grounding.test.ts`, sobre el cuerpo del
`CREATE TABLE` y no sobre el archivo entero — una columna nombrada en un
comentario no es una columna.

**Hallazgos:** A-F2 → **CLOSED**, A-F9 → **CLOSED**.

**Confirmado sobre el árbol integrado:**

- `grounding_0001` conservado **byte a byte** bajo el banner: cola idéntica
  (15 279 B), cabecera preservada, 2 175 B insertados, **cero** líneas no
  comentario añadidas y **cero** eliminadas.
- Orden forward y rollback impuesto por el propio SQL, no por documentación: la
  guarda de `0003` aborta sin `0002`; el rollback de `0002` se niega mientras
  exista la FK de `evidence_chunks`.
- Cinco funciones `SECURITY DEFINER`, todas con `search_path = ''` y owner
  `uellix_cap_grounding` (cero miembros).
- Cero `SELECT *` en proyección — los dos hits son `SELECT * INTO` sobre
  `%ROWTYPE`. Cero SQL dinámico — todo `EXECUTE` es literal fijo; `format(` sólo
  construye mensajes de error. Cero `service_role` salvo en `REVOKE`.
- **Cero SQL aplicado a ninguna base.** Ningún stack persistente usado.

**Desvío `project_id NOT NULL` aceptado con su fundamento.** La prueba cruzada no
fija sólo el desvío: fija que `evidence_items.project_id` sigue `NOT NULL` en
`db/schema.ts`. Si eso cambiara, la razón del desvío se evapora y la prueba
dispara.

**Petición devuelta, ahora registrada:** la solicitud de `EXTRACTOR_VERSION` de
GR-CAP-001 §5.4 vivía dentro de un documento de respuesta, sin fila propia. Es
ahora **GR-CAP-002** en el ledger, dirigida a GROUNDING tren 3. Integración no
publicó la constante: `lib/grounding/**` no es suyo, y elegir un valor habría
sido inventar en silencio lo que el contrato pide gobernar.

**Decisión abierta que sigue abierta:** `register_document_version` **rechaza**
(`U0101`) una reingesta del mismo `version_id` bajo un pipeline distinto, en vez
de crear un ordinal nuevo. Es la lectura estricta y es defendible; la
alternativa también. Es una decisión de producto, no de esquema, y sigue sin
tomarse.

---

# TRAIN 3 — endurecimiento de la persistencia de grounding

**HEAD inicial `4d59348`. Entregada. Árbol limpio. Sin push.**

## Unidad

Cerrar siete riesgos locales confirmados durante la integración del tren 2,
todos sobre `grounding_0002`/`grounding_0003`: `canonical_chunk_id` sin FK,
ciclos directos e indirectos en esa relación, `chunk_id` aceptado del llamador
sin rederivación, triggers append-only sin `ENABLE ALWAYS`, bypass del owner
sobre el acuerdo de scope, y la elección explícita entre `FORCE ROW LEVEL
SECURITY` y validación mediante funciones/constraints/triggers.

### 1–2. `canonical_chunk_id`: FK compuesta + trigger de aciclicidad

Dos mecanismos, cada uno cerrando la mitad que el otro no puede:

- **`evidence_chunks_canonical_fk`** (FK compuesta, `ON DELETE CASCADE`):
  `(canonical_chunk_id, organization_id, project_id, evidence_id,
  document_version_id, content_hash)` → las mismas columnas de la propia fila.
  Prueba existencia y que canonical/duplicate comparten organización,
  proyecto, evidence item, document version y content hash — los cinco
  requisitos de la Fase 2. Se apoya en una UNIQUE nueva,
  `evidence_chunks_identity_scope_unique`, porque PostgreSQL exige que el lado
  referenciado de una FK esté respaldado por una UNIQUE/PK sobre exactamente
  esas columnas.
- **`trg_evidence_chunks_canonical_integrity`** (`AFTER INSERT FOR EACH ROW`,
  función `public.uellix_check_canonical_chunk()`): una FK sólo prueba que el
  objetivo EXISTE y coincide en scope, nunca que el objetivo es a su vez
  canónico. Este trigger exige que `canonical_chunk_id` señale una fila cuyo
  propio `canonical_chunk_id` sea `NULL` — así que la relación sólo puede tener
  **un nivel de indirección**, nunca una cadena, y por construcción ningún
  ciclo de longitud 2 o mayor es representable (no sólo "no detectado":
  **irrepresentable**). El autorreferencia (`A -> A`) sigue excluida por el
  `CHECK canonical_chunk_id <> chunk_id` ya existente.

`insert_evidence_chunks` se reescribió para insertar en **dos pasadas**
(canónicos primero, duplicados después) dentro de la misma transacción: el
trigger es `AFTER INSERT` inmediato por fila (no una `CONSTRAINT TRIGGER`
diferible), así que sin ese orden un duplicado podría procesarse antes de que
su canónico exista en un único `INSERT` multi-fila. Las dos FK compuestas no
tienen ese problema — PostgreSQL las comprueba al final de cada sentencia, no
por fila.

**Probado en vivo, no sólo por inspección** (`scripts/grounding-dry-run.sh`
§6-ter): canónico inexistente, autorreferencia, cross-project,
cross-organización, hash distinto, versión distinta, ciclo de dos nodos (dos
filas mutuamente referenciadas en el mismo `INSERT`, ninguna existente aún) y
cadena/ciclo largo (un duplicado intentando apuntar a otro duplicado) — los
nueve, rechazados, con cero filas persistidas para el ciclo de dos nodos.

## 3. `chunk_id` de servidor

`insert_evidence_chunks` ya no confía en el `chunk_id` del payload para
almacenar. Lo deriva con la MISMA fórmula que
`lib/grounding/contracts/chunks.ts#deriveChunkId` —
`SHA-256("grounding/chunk/v1\n<version_id>\n<chunk_index>\n<content_hash>")`,
hex minúscula — usando `pg_catalog.sha256`/`pg_catalog.convert_to` (builtin,
sin `pgcrypto`, la misma construcción que el hash de token de
`stella_0006_invitation_capability.sql`). El `chunk_id` del payload se sigue
exigiendo y se **compara**: una discrepancia levanta `U0104` en vez de
almacenarse en silencio o de corregirse sin decirlo. Resultado:
determinista, idempotente (misma entrada ⇒ mismo id, siempre), verificable
por un tercero, compatible con reingesta (vía el `ON CONFLICT DO NOTHING`
existente) y sin colisión silenciosa posible salvo una colisión SHA-256 real.

**Por qué la derivación usa exactamente `(version_id, chunk_index,
content_hash)` y no más:** es la firma que el propio contrato TypeScript
publica. Añadir `evidence_id` o el scope a la fórmula la haría divergir de lo
que `lib/grounding/ingest/chunk-document.ts` ya computa client-side, rompiendo
la promesa central de GR-001 — que un `chunk_id` citado siga resolviendo a la
fila que esta función almacena.

## 4–5. Append-only, `ENABLE ALWAYS`, y el bypass del owner

**El owner podía violar el acuerdo de scope directamente.** RLS —incluida la
policy `RESTRICTIVE` que repite el invariante de scope— no ata al dueño de la
tabla salvo con `FORCE ROW LEVEL SECURITY`. Antes de este tren,
`SET ROLE uellix_owner; INSERT INTO evidence_chunks ...` (o
`evidence_document_versions`) podía escribir una fila con scope inconsistente
sin que nada lo impidiera.

Cerrado con **constraints y triggers explícitos, nunca `FORCE RLS`**:

| Tabla | Mecanismo nuevo | Cierra |
|---|---|---|
| `evidence_chunks` | `evidence_chunks_version_scope_fk` (FK compuesta, 9 columnas, `ON DELETE CASCADE`) | scope/provenance vs. su propia document version — **antes** sólo la policy RESTRICTIVE lo afirmaba |
| `evidence_document_versions` | `trg_evidence_document_versions_scope_check` (`BEFORE INSERT`, función `public.uellix_check_document_version_scope()`) | scope vs. `evidence_items` — no se pudo usar una FK compuesta porque `evidence_items` es tabla base fuera de esta línea (no se le añadió una UNIQUE nueva) |

**Por qué no `FORCE ROW LEVEL SECURITY`:** habría quitado la excepción del
owner de forma indiscriminada — incluyendo la del propio definer, que corre
como `SECURITY DEFINER` pero no tiene `BYPASSRLS` y necesita su propio INSERT
sin obstáculos — y el propio rollback de grounding_0002 ya documentaba (desde
el tren 2) que un owner sin `rolbypassrls` bajo FORCE cuenta 0 sobre una tabla
poblada. La alternativa —constraint o trigger dirigido exactamente al riesgo—
cierra el mismo hueco sin ese efecto secundario, y es lo que se aplicó.

**`ENABLE ALWAYS` en los seis triggers de ambas tablas** (los cuatro que ya
existían más los dos nuevos de arriba): sin él, `tgenabled='O'` no dispara bajo
`session_replication_role = replica`, que sólo puede fijar un superusuario pero
que de otro modo desactivaría el append-only y el chequeo de scope
silenciosamente. Probado en vivo bajo replica: seis intentos de owner
(`UPDATE`/`DELETE`/`TRUNCATE` en ambas tablas) rechazados igual que en modo
normal.

**Hallazgo no pedido, y riesgo remanente documentado:** las FOREIGN KEY
también se implementan como triggers internos en PostgreSQL
(`RI_ConstraintTrigger_*`), y **también** respetan
`session_replication_role` — se reprodujo en vivo (una FK compuesta que
rechazaba correctamente en modo normal dejó de hacerlo bajo replica). A
diferencia de los triggers propios de este paquete, el nombre de ese trigger
interno es un OID generado por base y sólo es alcanzable con SQL dinámico
(`EXECUTE format(...)`) — que el contrato estático de esta línea prohíbe
(`tests/helpers/sql-structure.ts` lo reporta como `unparsed-security-statement`
antes que dejarlo pasar sin juzgarlo). Dado que fijar
`session_replication_role` ya exige ser superusuario —quien de todos modos
puede `ALTER TABLE ... DROP CONSTRAINT` sin este rodeo—, se deja como riesgo
residual aceptado en vez de forzar SQL dinámico sobre un nombre no
determinista.

## Pruebas ejecutadas

Focalizadas (§11). Sin gates pesados, sin `test:unit` completo, sin build.

| Suite | Resultado |
|---|---|
| `tests/grounding-persistence-contract.test.ts`, `tests/grounding-persistence-mutation.test.ts` | **126 passed** |
| `tests/cross-workstream/capabilities-to-grounding.test.ts`, `grounding-to-product`, `grounding-product-to-release` | **verde** |
| `tests/capability-isolation`, `capability-mutation`, `capability-policy-contract`, `capability-policy-parser`, `capability-documentation`, `prepared-stella-sql`, `prepared-sql-source-of-truth`, `database-ddl-containment` | **771 passed** |
| `lib/grounding/__tests__/prepared-sql.test.ts` (GROUNDING, **no modificada**) | **verde** |
| `scripts/grounding-dry-run.sh` (contenedor desechable, `--network none`) | **completo**: aplicar ×2 (idempotente), 6 aserciones estructurales nuevas, §6-ter con datos reales (17 escenarios), rollback en orden inverso, reaplicar == aplicado |
| `pnpm tsc --noEmit`, `pnpm eslint` (focalizado a los ficheros tocados) | **verde** |

**11 mutaciones nuevas** (`G-54`…`G-65`, salteando `G-53` ya usado), cada una
con `expectedGate` exacto: FK canónica y su UNIQUE objetivo, FK de
scope-consistencia y su UNIQUE objetivo, el `CHECK` de autorreferencia, la
derivación y la verificación de `chunk_id` (por separado), `ENABLE ALWAYS` en
ambas tablas, el trigger de scope-check, el trigger de aciclicidad canónica y
su temporización (`BEFORE` en vez de `AFTER`). `G-30` (search_path) se
realineó a la nueva declaración de variables de `insert_evidence_chunks`, sin
cambiar lo que comprueba.

## Ficheros modificados

`db/prepared/grounding_000{2,3}_*.sql` y sus rollbacks;
`scripts/grounding-dry-run.sh`; `tests/helpers/grounding-{gates,mutations}.ts`;
`tests/grounding-persistence-contract.test.ts`. Ninguno fuera de las rutas
autorizadas de esta línea.

## Riesgos

- **`session_replication_role` y las FOREIGN KEY** — ver arriba. Residual,
  aceptado, requiere superusuario para siquiera intentarse.
- **Los mismos riesgos heredados del tren 2** siguen abiertos y ajenos a esta
  unidad: `EXTRACTOR_VERSION` no publicada en `lib/grounding` (ahora
  `GR-CAP-002`), la decisión producto de `register_document_version` sobre
  reingesta bajo pipeline distinto, y `tests/database-entrypoint-safety.test.ts`
  ambiental (sin `.env.local`).
- **Ninguno de los dos paquetes ha corrido contra una base persistente.** Toda
  la evidencia de aplicación es el contenedor desechable de
  `grounding-dry-run.sh`; la validación en un entorno real es un gate externo,
  prohibido en esta unidad.

## Estado de entrega a integración

**Entregado. Árbol limpio.** Dos commits locales sobre `4d59348`, sin push:

1. `fix(db): enforce canonical grounding chunk integrity`
2. `fix(db): harden grounding append-only boundaries`

Nada aplicado a ninguna base de datos, local o remota. Ningún acceso a
remoto. Ningún stack persistente. Ninguna bandera habilitada. Ningún uso de
`service_role`.

**Ficheros solicitados a integración:** ninguno. Esta unidad no editó
`CONTRACT_LEDGER.md`; no hay contrato nuevo que registrar, sólo el
endurecimiento de dos ya aceptados.

## Integración — tren 3 (2026-08-05)

`4d59348..6e3cbee`, merge `--no-ff`. Dos commits declarados, nada más.

**GR-CAP-003 aceptado en su totalidad.** Las siete reparaciones se verificaron
en el árbol integrado y con datos reales en contenedor desechable.

| Riesgo | Cierre | Verificado por |
|---|---|---|
| `canonical_chunk_id` sin FK | `evidence_chunks_canonical_fk` (6 columnas: identidad + scope + `content_hash`) | dry-run §6-ter + prueba cruzada |
| Cadenas y ciclos | `trg_evidence_chunks_canonical_integrity` exige que el destino tenga su propio `canonical_chunk_id IS NULL` → **profundidad máxima 1 por construcción**; ninguna cadena de ninguna longitud, luego ningún ciclo | dry-run + `U0105` |
| `chunk_id` no derivado | `insert_evidence_chunks` lo deriva con la preimagen del contrato y sólo **verifica** el del payload (`U0104`) | prueba cruzada nueva que compara la fórmula SQL con `deriveChunkId` componente a componente |
| Triggers sin `ENABLE ALWAYS` | los 6 en las 2 tablas | dry-run §13 bajo modo replica → 42501 |
| Bypass del owner sobre el scope | FK compuesta de 9 columnas + `trg_evidence_document_versions_scope_check` | dry-run §6-ter con `SET ROLE uellix_owner` |
| `FORCE RLS` | **no activado**, con razón técnica | ver abajo |
| Rollbacks | cada uno dropea su propia función de trigger, **después** de la tabla | dry-run §7–§9 |

### Revisión crítica del residual declarado

CAPABILITIES señaló que las `FOREIGN KEY` también se implementan como triggers
internos (`RI_ConstraintTrigger_*`) y por tanto también respetan
`session_replication_role`. **Integración confirma la clasificación como riesgo
de superusuario y la acepta.** La verificación fue:

- `session_replication_role` es un GUC `SUSET`: sólo un superusuario puede
  fijarlo. No existe ningún `GRANT SET ON PARAMETER` en el árbol.
- **Ningún rol accesible a la aplicación puede explotarlo.** `uellix_owner`,
  `uellix_app`, `uellix_writer`, `uellix_migrator`, `uellix_auditor` y
  `uellix_cap_grounding` están declarados `NOSUPERUSER NOBYPASSRLS
  NOREPLICATION` (`stella_0004:321-325`, `grounding_0002:189`).
- Ninguna función `SECURITY DEFINER` del paquete fija ese GUC; todas fijan
  `search_path = ''` y nada más.
- `tests/database-ddl-containment.test.ts:73` ya prohíbe fijar el modo replica
  en superficie de runtime.
- Quien puede fijarlo puede además `ALTER TABLE ... DROP CONSTRAINT`, así que
  endurecer las FK no cambiaría la postura frente a ese adversario.

**No necesita gate adicional y no requiere Train 4.** Endurecerlas exigiría SQL
dinámico sobre nombres OID no deterministas, camino que la instrucción de
integración prohíbe expresamente. Queda como **riesgo residual aceptado y
documentado**, no como omisión.

### Decisión FORCE RLS

**No se activó, y integración lo sostiene.** `FORCE ROW LEVEL SECURITY` quita
la excepción del dueño de forma indiscriminada —incluida la del definer, que no
tiene `BYPASSRLS`— y haría que el propio rollback de `grounding_0002` contara
0 filas sobre una tabla poblada, mintiendo sobre cuánta historia destruye. Los
constraints y triggers dirigidos cierran el mismo hueco sin ese efecto.

### Estado de aplicación

**`grounding_0002` y `grounding_0003` siguen preparados y sin aplicar a
ninguna base persistente.** Toda la evidencia de este tren viene de
`scripts/grounding-dry-run.sh` en contenedor desechable sin red, destruido al
salir.

### Contratos abiertos hacia esta línea

- **INT-GR-003** — `evidence_chunks` no almacena `section_label`, `line_start`
  ni `line_end`, que `ChunkLocation` declara. El adaptador de repositorio usa
  el centinela `0`, fuera del dominio 1-based, para que «no recuperable desde
  persistencia» sea distinguible de un valor plausible pero equivocado.

---

## Train 4 — runtime local de grounding (2026-08-05)

**Estado: DISEÑO. Nada aplicado a ninguna base. Ninguna bandera habilitada.**

Cierra las cinco solicitudes que la revisión adversarial del tren 3 dejó
abiertas hacia esta línea. Dos paquetes preparados, dos rollbacks, un arnés
desechable nuevo.

| Contrato | Estado | Dónde |
|---|---|---|
| **INT-CAP-001** — `grounded_query` en el ledger de cuota | cerrado | `stella_0013` · [respuesta](../contracts/CAP-TRAIN4-001_grounded_query_quota_response.md) |
| **INT-CAP-002** — `evidence_chunks` concede SELECT a `authenticated` | cerrado | `grounding_0004` §2b · [respuesta](../contracts/CAP-TRAIN4-002_grounding_scope_attestation_response.md) |
| **INT-CAP-003** — `content_hash` nunca verificado contra `content` | cerrado | `grounding_0004` §1a/§1b |
| **INT-CAP-004** — forja de `chunk_id` por el owner | cerrado (parte 2) | `grounding_0004` §1c |
| **INT-CAP-004** — rollback incompleto de `grounding_0003` | **abierto** | ver «Lo que queda abierto» |
| **INT-GR-004** — `chunks_in_scope` no devuelve el scope de la fila | cerrado en SQL | `grounding_0004` §3 · falta el cambio de adaptador (INTEGRACIÓN) |

### Lo que cambia, en una frase cada uno

**`stella_0013_grounded_query_quota.sql`** — el CHECK del ledger admite siete
roles en vez de seis, y una función gobernada
(`uellix_stella.consume_stella_quota`) comprueba **y cobra** una unidad dentro
de la transacción del llamante, bajo un lock de advisory por organización,
idempotente sobre `(organization_id, idempotency_key)`.

**`grounding_0004_runtime_attestation.sql`** — publica
`chunks_in_scope_attested` (17 columnas: las 13 más el scope real de cada
fila), ata tres invariantes de integridad con `CHECK` en vez de con trigger
—porque un CHECK alcanza al dueño y no lo silencia el modo replica—, y cierra
la lectura directa de PostgREST sobre el índice de chunks.

### El hallazgo que sólo aparece invocando

`uellix_cap_grounding` tenía `SELECT` sobre las dos tablas de grounding y **no
estaba nombrado por ninguna de las dos policies permisivas de SELECT**. Sin
`BYPASSRLS` y sin ser dueño de ninguna, RLS se le aplica entera: **toda lectura
devolvía el conjunto vacío**.

No era una función degradada, era la superficie completa —`chunks_in_scope`
devolvía 0 filas, `finalize_document_ingestion` declaraba toda ingestión
incompleta, y `register_document_version` nunca veía la versión anterior, así
que `ordinal` era siempre 1 y **la versión 2 de cualquier documento era
inalmacenable**.

Misma clase que el hallazgo del tren 2 (el definer sin privilegio sobre
`evidence_items`, 42501 en toda llamada) y estrictamente peor: **un GRANT
ausente lanza; una POLICY ausente calla.** Reparado re-creando las dos policies
bajo sus propios nombres con un rol más — reemplazo y no adición, porque
`grounding_0002` §9 afirma exactamente 3 policies y `grounding_0003` §9
exactamente 4, y una quinta rompería la re-aplicabilidad de la cadena.

### Evidencia

`scripts/stella-train4-dry-run.sh` — contenedor desechable, `--network none`,
destruido en el trap de salida. Aplica `0002 → 0003 → 0013 → 0004` dos veces,
siembra dos organizaciones y dos proyectos, **invoca** las funciones, y mide:

| Vector | Valor |
|---|---|
| baseline | `38/107/0/0/0/10/13/0` |
| forward | `40/115/2/7/2/16/14/0` |
| rollback | `38/107/0/0/0/10/13/0` |
| re-apply | `40/115/2/7/2/16/14/0` |

*(tablas / policies / roles de capacidad / funciones / esquemas / triggers /
columnas de `stella_interactions` / grants de `authenticated` en `evidence_chunks`)*

Aserciones vivas que pasan: primer consumo, reintento con la misma clave
(`replayed`), clave distinta, agotamiento, organización cruzada `U0102`,
proyecto cruzado `U0102`, rol no gobernado `U0106`, clave malformada `U0100`,
cero residuo tras los rechazos, **dos sesiones reales disputando la última
unidad** (la segunda espera al COMMIT de la primera y recibe `quota_exceeded`),
scope pedido comparado contra scope devuelto fila a fila, y tres ataques de
escritura con `SET ROLE uellix_owner` rechazados con `23514` junto a un control
positivo que sí entra.

Estática: `tests/train4-persistence-mutation.test.ts` — **60 mutaciones**, cada
una rechazada por el gate que posee la propiedad, baseline limpio, y un único
gate sin ejercitar (`source-missing`) declarado por escrito.

### Dos decisiones que conviene conocer

**`chunks_in_scope_attested` es una función NUEVA.** `CREATE OR REPLACE` no
puede cambiar el tipo de retorno (`42P13`), y `grounding_0003` crea
`chunks_in_scope` con esa sentencia. Sustituirla por `DROP`+`CREATE` bajo el
mismo nombre haría que la cadena forward, aplicada dos veces, abortara dentro
de `0003`. El precio es una ruta deprecada invocable hasta que el adaptador
migre; el de la alternativa era una cadena no re-aplicable.

**El rollback de `stella_0013` se niega sobre un ledger ya cobrado.** La tabla
es append-only para todo rol incluido el dueño, así que las filas
`grounded_query` no se pueden retirar para hacer sitio al CHECK de seis
valores. El script las cuenta y explica, en vez de dejar que el operador lea
una violación de constraint cruda.

### Lo que queda abierto

1. **`grounding_0003_rollback.sql`** sigue con sus tres `DROP FUNCTION` dentro
   del `ELSE` de «si la tabla existe» — INT-CAP-004 (1). Repararlo exige editar
   un fichero cuyo texto ancla once mutaciones del arnés del tren 3; se hace en
   un paquete propio con su re-anclaje, no de paso.
2. **El adaptador de repositorio sigue llamando a `chunks_in_scope`.**
   Migrarlo a `chunks_in_scope_attested` y comparar las cuatro columnas es
   trabajo de INTEGRACIÓN; hasta entonces `enforceRepositoryScope` sigue siendo
   tautológico y esta línea no lo puede cerrar sola.
3. **`app/actions/stella/grounded-query.ts` no llama a la función de cuota.**
   La constante `QUOTA_LEDGER_ROLE_MISSING` ya no describe un bloqueo: describe
   una llamada pendiente.
4. **Las FOREIGN KEY internas siguen respetando `session_replication_role`** —
   riesgo de superusuario aceptado en el tren 3. Los tres `CHECK` nuevos de
   `grounding_0004` **no** comparten esa debilidad.

---

## Tren 4 — integración (2026-08-05)

**Estado: DISEÑO + RUNTIME LOCAL VERIFICADO PARCIALMENTE. Nada aplicado a
ninguna base persistente. Ninguna bandera habilitada en el repositorio.**

Resultado global: **`STELLA_PARALLEL_TRAIN_4_INTEGRATION_BLOCKED_IDEMPOTENCY`**.
El recorrido local completo se ejecuta y pasa; lo único que falta para
`local-runtime-ready` es INT-INT-001 — ver
[`CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).

### Qué cerró la integración de esta línea

| Contrato | Estado tras el tren 4 |
|---|---|
| INT-CAP-001 | **ACCEPTED** — `stella_0013` instala `consume_stella_quota`, verificado en vivo |
| INT-CAP-002 | **ACCEPTED** — `grounding_0004` §2b |
| INT-CAP-003 | **ACCEPTED** — `grounding_0004` §1a/§1b |
| INT-CAP-004 | **ACCEPTED, las dos partes** — §1c, y el rollback reparado aquí |

### El rollback de `grounding_0003`, reparado

La parte (1) de INT-CAP-004 quedaba abierta porque repararla exigía editar un
fichero cuyo texto ancla mutaciones del arnés del tren 3. Se hizo en esta
integración, con su reanclaje:

* los cuatro `DROP FUNCTION` salieron del `ELSE` de «si la tabla existe» y son
  incondicionales, **después** del `END IF` (el orden importa: el trigger
  `trg_evidence_chunks_canonical_integrity` referencia a
  `public.uellix_check_canonical_chunk()` y PostgreSQL no deja retirar una
  función que un trigger vivo nombra);
* una aserción posterior falla la transacción si alguna sobrevivió;
* el gate `rollback-function-drop-unconditional` de
  `tests/helpers/train4-gates.ts` ahora **lee ese fichero**
  (`ROLLBACK.CHUNKS_T3`), y dos mutaciones nuevas —`T-61` reintroduce el
  anidamiento, `T-62` mete un `CASCADE`— demuestran que el gate va rojo;
* las mutaciones y aserciones del tren 3 que anclan en ese texto siguen
  pasando **sin debilitarse**: `G-43`, `G-44`, `G-45` y las siete aserciones de
  `tests/grounding-persistence-contract.test.ts` (`dropped()` sigue dando
  exactamente los cinco mismos objetos, sin duplicados).

**Por qué importaba.** `uellix_cap_grounding` posee las tres funciones, y
PostgreSQL se niega a retirar un rol que aún posee algo. Un rollback que
reportaba éxito dejando funciones vivas hacía el rollback de `grounding_0002`
**permanentemente imposible**.

### Evidencia ejecutada

* `scripts/grounding-dry-run.sh` — baseline `38/107/0/0/0/10`, forward
  `40/114/1/5/1/16`, **rollback == baseline**, re-apply == forward.
* `scripts/stella-train4-dry-run.sh` — baseline `38/107/0/0/0/10/13/0`,
  forward `40/115/2/7/2/16/14/0`, rollback == baseline, re-apply == forward.
* `tests/train4-persistence-mutation.test.ts` — 62 mutaciones, todas rechazadas
  por su gate exacto; único gate sin ejercitar: `source-missing`, declarado.
* `scripts/grounding-rollback-defect-path.sh` — **la ruta del defecto**, que
  ningún otro arnés recorre. El dry-run de grounding sólo ejercita la rama en
  la que `evidence_chunks` existe; este script la retira por otro camino
  (el escenario que INT-CAP-004 (1) describe: restore parcial, `DROP` manual,
  forward muerto a medias) y comprueba que el rollback reparado retira las
  cuatro funciones igualmente **y** que `grounding_0002_rollback` vuelve a
  completarse, retirando el rol y el esquema. Antes de la reparación esa
  segunda parte era imposible: el rol seguía poseyendo tres funciones.

---

## Tren 4.1 — tickets de operación gobernados (2026-08-05)

**Cierra INT-INT-001**, el único bloqueante de `local-runtime-ready` que quedaba
abierto tras el tren 4. Respuesta completa:
[`INT-INT-001_operation_ticket_protocol.md`](../contracts/INT-INT-001_operation_ticket_protocol.md).

| Contrato | Estado | Unidad |
|---|---|---|
| **INT-INT-001** — clave de idempotencia sin fuente canónica | cerrado | `stella_0014` |

**Estado de aplicación: DISEÑO. No aplicado a ninguna base. Ninguna bandera
habilitada. Ningún server action lo llama** — cablearlo es la reconciliación de
INTEGRACIÓN, explícitamente fuera del alcance de este tren.

### El bloqueo, reproducido antes de cerrarlo

`consume_stella_quota` exige una `idempotency_key` y ninguna fuente derivable
del request traza la distinción que hace falta. El §7 del arnés lo **ejecuta**
contra la función real, en vez de argumentarlo:

| Candidata | Ejecutado | Lectura |
|---|---|---|
| `randomUUID()` por invocación | `consumed`, `consumed` → 2 filas | el reintento **cobra dos veces** |
| digest de (usuario, proyecto, consulta) | `consumed`, `replayed` → 1 fila | la segunda pregunta legítima es **gratis** |

Un arnés que sólo instalara el paquete certificaría que la solución se aplica,
no que había un problema.

### Lo que cambia, en una frase

**`stella_0014_operation_tickets.sql`** — emite una identidad **opaca de
servidor** soldada a actor, organización, proyecto, categoría y vigencia; fija
el digest de la consulta **una sola vez**; **reserva** la unidad al atar y la
**cobra al completar** a través de `consume_stella_quota`, bajo una clave
derivada de un `charge_nonce` que ninguna función devuelve.

### Tres decisiones que conviene conocer

**No es un segundo ledger.** Una unidad de cuota sigue siendo una fila de
`stella_interactions`, y el rol de ticket **no tiene ningún privilegio de
escritura sobre ella**: su único camino al ledger es *llamar* a la función de
`stella_0013`. Que «la única forma de cobrar es la ruta gobernada» sea un hecho
sobre privilegios, y no una afirmación sobre un cuerpo de función, es lo que
impide que una edición futura lo deshaga.

**La tabla no podía ser `stella_interactions`.** Un ticket tiene ciclo de vida y
`trg_stella_interactions_append_only` rechaza `UPDATE` y `DELETE` ahí para todo
rol incluido el dueño. Una máquina de estados no cabe en una tabla donde ningún
estado puede cambiar.

**Esquema propio, y no por orden: por defecto medido.** `stella_0013` afirma
sobre **todo** `uellix_stella` que cada función es propiedad de
`uellix_cap_stella_quota`. Con las seis nuevas ahí, `stella_0013` **aborta en su
segunda aplicación** — la cadena forward deja de ser idempotente, y el primer
`apply` de ambos paquetes sigue pasando, así que el fallo es invisible salvo
para un arnés que aplique dos veces. Observado en el pase 2, no revisado.
`uellix_stella_ops` aplica el argumento que el propio `stella_0013` escribió
para no compartir `uellix_capability`.

### Reservar y luego cobrar

Los invariantes que deben alcanzar al **dueño** viven en CHECK y en triggers
`ENABLE ALWAYS`, no en RLS — se sostiene la «Decisión FORCE RLS» del tren 3, con
un argumento más: con FORCE, el propio rollback contaría 0 tickets completados
sobre una tabla poblada y **se dejaría desinstalar justo cuando no debe**.

Una reserva huérfana no puede matar de hambre a nadie: `expires_at > now()`
forma parte del predicado de vivacidad dentro de `bind`, así que un ticket
abandonado deja de reservar al expirar **llame o no llame alguien** a
`expire_operation_tickets`. En este proyecto no hay `pg_cron` y el paquete no
finge que lo haya.

### Lo que queda abierto

**El ledger puede refusar al completar.** Si una acción Stella hermana cobra
entre `bind` y `complete`, `consume_stella_quota` puede devolver
`quota_exceeded` sobre trabajo ya ejecutado. El paquete **lo reporta y no lo
tapa**: el ticket queda `bound` y abortable, y nunca se cobran más unidades de
las vendidas. Si ese trabajo debe regalarse o la cuota debe excederse en uno es
una decisión de facturación, no de base de datos.

### Evidencia ejecutada

* `scripts/stella-ticket-dry-run.sh` — contenedor desechable, `--network none`,
  sin volumen, destruido al salir. Baseline `0/0/0/0/0/0/0/0`, forward
  `2/2/1/6/1/3/2/1`, **rollback == baseline**, re-apply == forward.
  15 secciones: reproducción del bloqueo, protocolo invocado (reintento,
  consulta nueva con el mismo texto, fallo, aborto, cuota agotada), 13 ataques
  de aislamiento, 13 ataques de OWNER incluido
  `session_replication_role = replica`, y **seis** pruebas de concurrencia con
  dos sesiones reales: dos tickets por la última unidad, el mismo ticket
  completado dos veces, `complete` contra `abort`, reintento tras completar,
  caída simulada a mitad de la reserva, y expiración durante la operación.
* `tests/stella-ticket-persistence-mutation.test.ts` — 39 mutaciones, todas
  rechazadas **por su gate propietaria**; los gates sin ejercitar están escritos
  por nombre en el propio fichero.

### Dos defectos que el arnés encontró y la revisión no

**`stella_0013` deja de ser re-aplicable si se comparte su esquema.** Descrito
arriba. Se reparó moviendo los objetos nuevos, **sin tocar el paquete
histórico**.

**El detector de `DROP FUNCTION` condicional tenía un punto ciego.** El lector
heredado del tren 4 reconoce `IF to_regclass(...) THEN` pero no
`IF tbl_oid IS NOT NULL THEN` — que es exactamente como este rollback escribiría
el anidamiento, porque guarda el oid en una local para reutilizarlo. Un mutante
que **sobrevivió** lo hizo visible; el lector ahora sigue la variable hasta su
asignación. INT-CAP-004 (1) volvía a ser reintroducible sin que ninguna gate lo
notara.


---

## Tren 4.1 — INT-INT-001 CERRADO (integración, 2026-08-05)

**`runtime-quota-charged` pasa a `true`** por evidencia ejecutada, no por
diseño: la causa única que lo bloqueaba —la clave de idempotencia sin fuente
canónica— está cerrada.

**`local-runtime-ready` NO se flipa en este tren, y la distinción importa.**
El gate de cuota exigido por INT-INT-001 está satisfecho y medido, pero la
lista de criterios del E2E incluye «ticket cross-project: rechazo, cero cargo»
y ese criterio **no se cumple**: `bind_operation_ticket` y
`complete_operation_ticket` no reciben el proyecto contra el que se ejecuta la
consulta, así que la base no puede compararlo con el del ticket. Es R2-INT.
Declarar `local-runtime-ready=true` afirmaría una propiedad que la propia
batería mide como falsa.

**Qué se cableó.** `db/prepared/stella_0014_operation_tickets.sql` aplicado a
una base desechable; `app/actions/stella/grounded-query.ts` reestructurado a
`issue → bind → ejecutar → complete | abort`; canonicalización en
`lib/stella/operation-ticket/canonical-query-hash.ts`; emisor real de los diez
eventos en `lib/stella/operation-ticket/ticket-observability.ts`; adaptador en
`db/stella/operation-tickets.ts`; el ticket viaja como **segundo argumento** del
runner y el payload funcional sigue siendo `{ query }`.

**Con qué se probó.** `scripts/stella-ticket-e2e.sh` — PostgreSQL desechable
(sin volúmenes, publicado sólo en loopback, destruido al salir), baseline +
`grounding_0002/0003/0004` + `stella_0013` + `stella_0014`, server action real,
adapters reales, generador extractivo local, **cero proveedor**
(`env -u GEMINI_API_KEY`, reafirmado dentro del proceso). 22 escenarios, todos
verdes. Cada cargo se mide como **delta de filas de `stella_interactions`**
leído por una conexión distinta de la del runtime.

**El gate.** `runtime-quota-charged` ya no acepta un informe de dos campos:
exige nueve pruebas medidas (primer cargo, reintento sin cargo, ticket nuevo con
cargo, abort sin cargo, cross-scope sin cargo, concurrencia, semántica explícita
del reintento post-cobro, observabilidad runtime limpia, teardown sin residuos),
y un control negativo comprueba que **retirar cualquiera de las nueve** lo hace
fallar.

**Lo que NO cambió.** Banderas en `false` en el repositorio. `staging-blocked` y
`hosted-blocked` siguen en `true`. `consume_stella_quota` no se tocó. La
política R1 sigue siendo la conservadora: nunca exceder cuota, nunca mostrar
como exitosa una respuesta no cobrada.

**Riesgos abiertos**: R1 (armonización entre acciones hermanas), R2-INT
(atribución cross-proyecto, MAJOR), R3-INT, R4-INT, R5-INT, R6-INT, R7-INT — los
siete detallados en
[`CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).



---

## Tren 4.2 — tickets ligados al proyecto de ejecución (2026-08-05)

**Cierra R2-INT**, el residual MAJOR que quedó abierto al cerrar INT-INT-001 y
el criterio que mantiene `local-runtime-ready` en `false`. Respuesta completa:
[`R2-INT_project_bound_operation_tickets.md`](../contracts/R2-INT_project_bound_operation_tickets.md).

| Contrato | Estado | Unidad |
|---|---|---|
| **R2-INT** — atribución cross-proyecto del cargo | cerrado en base | `stella_0015` |

**Estado de aplicación: DISEÑO. No aplicado a ninguna base. Ninguna bandera
habilitada. Ningún server action pasa todavía el argumento nuevo** — cablearlo
es la reconciliación de INTEGRACIÓN, explícitamente fuera del alcance de este
tren.

### El defecto, reproducido antes de cerrarlo

Un ticket queda soldado a organización, proyecto y actor al emitirse. Tres de
esas cuatro ataduras se reimponen en cada llamada posterior; el **proyecto no**,
porque `bind` y `complete` no reciben ninguno. La base no tiene con qué
comparar, así que `complete` cobra bajo el proyecto del **TICKET** mientras el
trabajo leyó su evidencia bajo el proyecto de la **ACCIÓN**.

El §5b del arnés lo **ejecuta** con `stella_0014` instalado y `stella_0015`
todavía no — el arnés se aplica en dos etapas justamente para poder medirlo:

| Medido | Valor |
|---|---|
| `bind` y `complete` bajo el proyecto A2 con un ticket de A1 | `bound`, `completed` |
| cargo archivado en el proyecto del **ticket** (A1) | `true` |
| cargo archivado en el proyecto del **trabajo** (A2) | `false` |
| funciones de bind/complete/abort/inspect con argumento de proyecto | **0** |

Una unidad, la organización correcta, el proyecto equivocado. No es un escape de
cuota —el tope es organizacional y se cobra exactamente una unidad— sino de
atribución y auditoría, y en un producto cuya salida entera es una cifra SROI
auditable una unidad mal atribuida es peor que una no cobrada.

### Lo que cambia, en una frase

**`stella_0015_project_bound_operation_tickets.sql`** — `bind`, `complete`,
`abort` e `inspect` reciben un `p_expected_project_id` **sin `DEFAULT`**, lo
comparan contra el proyecto que el ticket lleva soldado desde su emisión, y
levantan **`U0110`** cuando difieren; las cuatro firmas que no tomaban proyecto
quedan **revocadas y eliminadas**, así que no sobrevive ninguna ruta ejecutable
que se salte la comprobación.

### Cuatro decisiones que conviene conocer

**Un paquete nuevo, no una edición.** Añadir un argumento cambia la firma y
`CREATE OR REPLACE` lo prohíbe (`42P13`). Editar `stella_0014` en sitio habría
producido un paquete que falla en toda base que ya tenga la forma antigua — que
es justamente la población que importa.

**`complete` revalida por su cuenta.** `bind` y `complete` corren en
transacciones distintas, porque el protocolo lo exige: la reserva es un estado
de fila y no un lock sostenido. «Bind ya lo comprobó» es una afirmación sobre un
request que ya terminó — y es el cobro, no la reserva, el que aterriza en un
ledger append-only bajo un `project_id` que nunca podrá corregirse.

**El proyecto se juzga en cuanto la fila aparece**: después de `NOT FOUND`, para
que «no existe» y «no es tuyo» sigan siendo la misma frase; y antes de la
vigencia, del digest y del estado, para que un ticket de otro proyecto no sea
distinguible como expirado, atado o liquidado. En `complete`, además, **antes
del cortocircuito de `replayed`**: contestar «esto ya pasó y ya se cobró» a otra
superficie es informarle de una operación que no es suya.

**`U0110` es distinguible en la base y se colapsa en el producto.** Seis causas
—otra organización, otro actor, ticket inexistente, expirado, otra consulta,
otro proyecto— necesitan seis respuestas distintas para un operador. Sólo puede
observarlo el propio actor del ticket, porque se levanta después de que RLS
encontró la fila, así que no es un oráculo de existencia. El adaptador lo mapea
a `out_of_scope`, la misma frase `UNAUTHORIZED` que recibe cualquier otro fallo
de scope.

### El rollback se NIEGA a restaurar

`stella_0015_rollback.sql` retira las cuatro firmas nuevas y **no recrea las
antiguas**. R2-INT no es un cuerpo que una versión nueva arregló: es la ausencia
de un argumento, así que «restaurar la versión anterior» y «republicar la
vulnerabilidad» son la misma frase. Lo que queda —`issue` y `expire`, ninguna de
las cuales cobra— es una superficie **cerrada**, no una degradada, y una
postcondición aborta el rollback si una edición futura reintroduce alguna firma
sin proyecto.

El orden inverso lo impone el SQL: las cuatro funciones nuevas son propiedad de
`uellix_cap_stella_ticket`, así que el `DROP ROLE` del rollback de `stella_0014`
falla mientras existan y su transacción entera aborta sin destruir nada.

### Evidencia ejecutada

* `scripts/stella-ticket-dry-run.sh` — contenedor desechable, `--network none`,
  sin volumen, destruido al salir. Baseline `0/0/0/0/0/0/0/0/0`, etapa 1
  `2/2/1/6/1/3/2/1/0`, forward `2/2/1/6/1/3/2/1/4`, **rollback == baseline**,
  re-apply == forward. La novena componente del vector es de este tren: sin ella
  no distinguiría «0014 aplicado» de «0014 + 0015 aplicados», porque las dos
  publican seis funciones.
  16 secciones: reproducción de R2-INT sobre `stella_0014` solo, cadena completa
  aplicada dos veces, **20 aserciones cross-proyecto** (mismatch en `bind`,
  `complete`, `abort`, `inspect` y en el reintento post-cobro; proyecto de otra
  organización; proyecto ausente; cero cargo ante mismatch; la reserva sobrevive
  a un `abort` ajeno; dos proyectos con el mismo texto cobran uno cada uno; la
  cuota sigue contándose sobre la organización; actor ajeno, ticket inventado y
  organización ajena siguen dando `U0102` y no `U0110`), **siete** pruebas de
  concurrencia —las seis del tren 4.1 más un `complete` concurrente bajo otro
  proyecto, que espera al lock de fila y es rechazado con cero cargo—, negativa
  del rollback de `stella_0014` por el motivo correcto, orden inverso impuesto,
  rollback de `stella_0015` con reaplicación idéntica, y retorno exacto al
  baseline.
* `tests/stella-project-ticket-mutation.test.ts` — **14 mutaciones**
  (K-40…K-53), todas rechazadas **por su gate propietaria**: el argumento
  retirado de cada uno de los cuatro verbos, la comparación retirada de `bind` y
  de `complete` por separado, un `DEFAULT` en el argumento, la firma antigua sin
  eliminar, el `EXECUTE` antiguo sin revocar, el error de mismatch lavado en
  `U0102`, el cargo archivado bajo un proyecto elegido por una consulta, la
  comprobación movida por encima de `NOT FOUND`, el rollback restaurando la
  firma vulnerable y el rollback dejando una función nueva viva. Los gates sin
  ejercitar están escritos por nombre en el propio fichero.

### Dos cosas que el arnés encontró y la revisión no

**Una gate verde por accidente.** `ticket-project-check-order` comparaba
posiciones de `v_hash`, `v_expires` y `v_status` dentro del cuerpo — y las tres
se DECLARAN al principio, antes de todo, así que la gate se disparaba sobre su
propio baseline en tres de los cuatro verbos. Anclarla en el `IF` que
**realiza** cada comprobación es la diferencia entre medir el orden y medir el
bloque `DECLARE`.

**Una aserción demasiado ancha.** «El proyecto no tiene `DEFAULT`» escrita sobre
todo el esquema fallaba por `expire_operation_tickets(p_max integer DEFAULT
1000)` — un tamaño de lote, de `stella_0014`, que no decide a quién se cobra.
Acotarla a los cuatro verbos la devuelve a la propiedad que dice medir.

### Lo que queda abierto

**El cableado.** Ningún server action pasa el proyecto todavía, y hasta que lo
haga la ruta gobernada **falla cerrada**: el adaptador declara el parámetro
opcional en TypeScript y lo exige de hecho, rechazando en Node antes del viaje a
la base. No se hizo obligatorio en el tipo porque sería un error de compilación
en un módulo que este tren no posee, y ponerle por defecto el proyecto del
ticket sería el defecto mismo escrito como comodidad.

**Reaplicar `stella_0014` solo, después de `stella_0015`, republica las firmas
sin proyecto** (R2a). Es la misma clase de precondición de orden que
`stella_0014` ya tiene con `stella_0013`, y no es reparable desde `stella_0015`:
ningún paquete puede impedir que otro se ejecute después. La cadena completa
aplicada en orden converge, medido en los dos pases del §5c.

**R3-INT sigue sin tocar** — reordenar vigencia y estado terminal dentro de
`bind` es un cambio distinto, y mezclarlo con una firma nueva habría hecho que
un solo paquete moviera dos propiedades a la vez.

---

## Integración — tren 4.2 (`STELLA_TRAIN_4_2_PROJECT_BINDING_INTEGRATION`)

**Fusionadas** `codex/stella-capabilities` (`6db4cbd`) y `codex/stella-release`
(`d4f8395`) sobre `b6a11cd`, con dos merges `--no-ff` y **un** commit de
reconciliación. `codex/stella-grounding` y `codex/stella-product` quedaron en
`b6a11cd`: ninguna entregó commits en este tren y ninguna se fusionó.

### Qué se aceptó

**R2-INT → `ACCEPTED`.** La invariante que cierra:

```
ticket.project_id = projectId derivado por el server action
                  = projectId usado por el repositorio de Grounding
                  = project_id de la fila de stella_interactions
```

Detalle completo en
[`CONTRACT_LEDGER.md#r2-int--accepted-integración-tren-42`](../contracts/CONTRACT_LEDGER.md).

### Qué cambió fuera de las dos ramas

| Ruta | Cambio |
|---|---|
| `db/stella/operation-tickets.ts` | el proyecto pasa de opcional-en-el-tipo a **obligatorio y en la posición del SQL**; omitirlo es un error de `tsc` |
| `app/actions/stella/grounded-query.ts` | una sola derivación + tipo *branded* `ExecutionProjectId`; los cuatro verbos y el scope de retrieval se alcanzan por `ExecutionProject`, cuyos miembros **no toman proyecto** |
| `db/prepared-package-order.ts` (nuevo) | registro declarativo de supersesiones — la respuesta operativa a **R2a** |
| `db/migrator.ts` | `assertPreparedPackageOrder` como **precondición dentro de la transacción**, antes del script; `DB_MIGRATOR_PACKAGE_ORDER_VIOLATION` |
| `db/prepared/README.md` | registra `stella_0015`, la cadena canónica y el orden inverso de rollback — cierra **R2c**, que rompía `pnpm test:unit` |
| `tests/helpers/source-text.ts` (nuevo) | lector único que normaliza `CRLF → LF` antes de buscar anclas multilínea |
| `tests/eval/stella-release/local-release-gate.ts` | `LocalRuntimeEvidence`: las dos entradas **incondicionales** de `missingForLocalRuntime` pasan a ser satisfacibles **sólo** por una ejecución real contra base desechable |
| `tests/e2e/stella-ticket-journey.e2e.test.ts` | tercer proyecto con evidencia propia; casos de atribución positiva; orden de paquetes; los dos gates de runtime |
| `scripts/stella-ticket-e2e.sh` | `stella_0015` en la cadena y §4d: 4 firmas con proyecto, 0 ciegas, 0 DEFAULT, 0 `EXECUTE` para `PUBLIC` |

### CRLF — tres casos, medidos y cerrados

No deducidos: se volcó a CRLF **todo** archivo LF del árbol y se volvió a correr
la suite. Fueron a rojo exactamente tres casos, en dos archivos
(`ticket-idempotency.test.ts` ×2, `runtime-grounded-query.test.ts` ×1). El
tercero es el que importa: cortaba el cuerpo de una función en `'\n}\n'`, y bajo
CRLF ese `indexOf` devuelve `-1`, así que `slice(start, -1)` entregaba casi todo
el archivo y la aserción juzgaba bytes a los que nadie la había apuntado.

Corregido en el **lector**, nunca en los archivos de producción. Se demuestra
que las gates muerden bajo LF, bajo CRLF, con `p_expected_project_id` eliminado
y con una firma antigua reintroducida.

### Gates

`runtime-project-attribution-verified` → **true**, con siete pruebas contra base
real y siete controles negativos matando.
`local-runtime-ready` → **true**, y **sólo** con la evidencia de runtime: sin
ella el reductor devuelve, verbatim, las mismas dos razones que antes del 4.2.

**Staging y hosted siguen bloqueados.** Banderas en `false`. `INT-GR-001`,
`INT-GR-003`, `INT-PR-001` y `R1` siguen pendientes.
