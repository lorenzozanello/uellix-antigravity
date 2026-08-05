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
