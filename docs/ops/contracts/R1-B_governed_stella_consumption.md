# R1-B / R6-INT — Consumo Stella gobernado

**Línea propietaria:** CAPABILITIES
**Tren:** 4.3b
**Estado:** `IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE`
**Paquete:** [`db/prepared/stella_0017_governed_stella_consumption.sql`](../../../db/prepared/stella_0017_governed_stella_consumption.sql)
**Rollback:** [`db/prepared/stella_0017_rollback.sql`](../../../db/prepared/stella_0017_rollback.sql)
**Arnés:** [`scripts/stella-governed-consumption-dry-run.sh`](../../../scripts/stella-governed-consumption-dry-run.sh) → `STELLA_GOVERNED_CONSUMPTION_DRY_RUN_OK`

Complementa —no sustituye— [`R1`](./R1_reserved_quota_semantics.md) y cierra los
dos huecos que impedían aceptarlo:

1. cualquier rol runtime podía escribir directamente en `stella_interactions` y
   saltarse las reservas;
2. las cinco acciones Stella hermanas no tenían identidad de operación
   idempotente gobernada.

---

## 1. Lo que se midió, y por qué `stella_0016` lo empeoró

`stella_0016` instaló una aritmética correcta —`Consumed + Reserved <= Limit`— y
convirtió `complete` en una **conversión** que ya no vuelve a evaluar el límite,
porque la unidad se comprometió en el `bind`. Las dos decisiones son correctas.

Pero `uellix_writer` conserva `INSERT` sobre `public.stella_interactions`
(`db/baseline/stella_g2_schema.sql:11321`) y `uellix_app` lo **hereda**
(`GRANT uellix_writer TO uellix_app WITH INHERIT TRUE`,
`db/baseline/stella_g2_roles.sql:223`). Las cinco acciones hermanas cobran con
`db.insert` tras una lectura sin lock. Eso es R6-INT.

**Compuestos, ya no son R1. Son un sobreconsumo.** Reproducido contra las
funciones reales con la cadena `0013…0016` instalada y `stella_monthly_quota = 1`
(§6 del arnés):

| Paso | Resultado |
|---|---|
| `bind(ticket)` | `bound` — el ticket reserva la unidad |
| `checkStellaQuota` de la hermana | `used = 0` — la reserva es **invisible** |
| `db.insert` de la hermana | cobrado — se vende la unidad 1 de 1 |
| `complete(ticket)` | **`completed`** — la conversión no evalúa el límite |
| | **`Consumed = 2` contra `Limit = 1`** |

Bajo `stella_0015` la misma secuencia terminaba en `quota_exceeded` y el trabajo
se regalaba: malo, pero el tope aguantaba. Con la conversión instalada **no
aguanta**. Una aritmética exacta sobre una superficie de escritura no gobernada
es aritmética sobre un número que otro puede cambiar.

### 1b. El privilegio que había que retirar no es el del nombre obvio

Medido sobre un baseline restaurado, no leído de un `GRANT`:

```
entradas de uellix_app en stella_interactions.relacl ......... 0
has_table_privilege('uellix_app', …, 'INSERT') ............... true
```

`uellix_app` **no tiene nada** en esa tabla. Un `REVOKE … FROM uellix_app` habría
sido un no-op, y una verificación escrita sobre `relacl` habría reportado la
tabla limpia mientras el `INSERT` heredado seguía en pie. Por eso el §5 del
paquete pregunta con `has_table_privilege` —que **sigue la pertenencia de rol**—
y de forma **exhaustiva sobre `pg_roles`**, no sobre una lista de nombres.
La mutación **K-87** mata exactamente esa confusión.

---

## 2. Inventario de escrituras a `stella_interactions`

| Archivo | Función / acción | Rol de base | Método | Categoría Stella | Identidad idempotente | Reparación |
|---|---|---|---|---|---|---|
| `app/actions/stella/advisor.ts:203` | `getStellaContextualAdvisor` | `uellix_app` (hereda `uellix_writer`) | `db.insert` directo | `advisor` | **ninguna** | ticket → `complete_operation_ticket` (7 args) |
| `app/actions/stella/advisor.ts:377` | `getStellaAdvisor` | íd. | `db.insert` directo | `advisor` | **ninguna** | íd. |
| `app/actions/stella/validator.ts:179` | `getStellaValidator` | íd. | `db.insert` directo | `validator` | **ninguna** | íd. |
| `app/actions/stella/composer.ts:218` | `getStellaComposer` | íd. | `db.insert` directo | `composer` | **ninguna** | íd. |
| `app/actions/stella/reviewer.ts:167` | `getStellaReviewer` (3 roles) | íd. | `db.insert` directo | `proxy_reviewer`, `evidence_reviewer`, `audit_assistant` | **ninguna** | íd. |
| `db/prepared/stella_0013…§6` | `uellix_stella.consume_stella_quota` | `uellix_cap_stella_quota` | función SQL gobernada | las siete | `p_idempotency_key` | ninguna |
| `db/prepared/stella_0016…§5` | `uellix_stella.settle_reserved_quota` | íd. | función SQL gobernada | las siete | derivada de ticket + nonce | pasa a **delegar** |
| `scripts/seed-stella-local.ts:124` | seed local | owner | `INSERT` crudo | `advisor` | **ninguna** | **pendiente de RELEASE** (§7) |
| `tests/**`, `db/baseline/**` | fixtures y restore | varios | `INSERT` | varias | ninguna | fuera de alcance |

Ninguna migración de `db/migrations/**` escribe filas en esa tabla.

---

## 3. Identidad de operación existente — el inventario, antes de inventar nada

Buscado en las cinco acciones hermanas y en sus superficies cliente y servidor:

| Candidato | Existe | Válido como idempotency key |
|---|---|---|
| `requestId` / `invocationId` / `operationId` / `correlationId` | **no** — no hay middleware que emita ninguno | — |
| `suggestionKey` | **sí**, en `app/actions/stella/decisions-schema.ts` | **no.** Es `z.string().min(1).max(300)` **elegida por el cliente**, identifica una *sugerencia dentro de una respuesta ya cobrada* (`advisor.suggested_next_actions[2]`), y `StellaGroundedQuerySection.tsx:94` ya registra por escrito que una respuesta grounded **no** es una sugerencia. No se emite en servidor, no se vincula a categoría, no distingue reintento de operación nueva y no expira. Su nombre encaja; su semántica no |
| `contextHash` (`lib/stella/context/build-context-hash.ts`) | **sí** | **no** como identidad: es un digest del **contenido**, así que dos preguntas legítimamente idénticas colapsan en un cargo. Sí sirve —y se usa— como `context_hash` de la fila |
| argumento enlazado por Next.js | **sí** | **no**: se fija en el *render*, y un render sirve muchas operaciones — constante justo donde tiene que variar |
| `app.request_id` (GUC) | **sí**, leída por el trigger de auditoría de `stella_0007` | **no**: la fija el **llamante**, y un valor que el cliente elige no es una identidad |
| secreto de firma de propósito general | **no** (sólo `STRIPE_*`) | — |

**Decisión: no existe identidad canónica válida.** La que sí existe —el
`operation_ticket` de `stella_0014`— cumple los nueve requisitos: emisión del
lado servidor, vínculo con actor, organización, proyecto y categoría, distinción
retry/operación nueva, imposibilidad de que el cliente elija la clave efectiva
(deriva de un `charge_nonce` que ninguna función devuelve), expiración y estados
terminales, y **cero** texto privado.

---

## 4. Extensión aditiva, no un sistema nuevo

**El ticket ya era multi-categoría.** Verificado antes de diseñar:
`operation_tickets_category_check` nombra las **siete** categorías,
`issue_operation_ticket` valida contra el mismo array, la categoría se suelda al
emitir y el trigger de transición rechaza un `UPDATE` que la cambie **para todos
los roles, incluido el owner**. `settle_reserved_quota` ya rehúsa (`U0111`) si la
categoría del ticket no es la que se le pide cobrar.

Lo único que el recorrido grounded nunca tuvo que llevar es la **carga de
auditoría**. `response_json` es `NOT NULL`, `model_used` es `NOT NULL` y
`tokens_used` lo lee `lib/admin/stella-services.ts`. Una ruta gobernada que
archivara el literal fijo para una hermana cerraría R6-INT **destruyendo el
rastro de auditoría** que cinco acciones vivas producen hoy — y eso es una
decisión de producto, no de base de datos.

Así que el paquete añade **dos objetos y ninguna tabla, rol, esquema ni policy**:

| Objeto | Qué es |
|---|---|
| `uellix_stella.settle_reserved_quota(…10 args)` | la conversión, ahora **llevando la fila que archiva**. Es la ÚNICA implementación |
| `uellix_stella.settle_reserved_quota(…5 args)` | **se republica en el sitio como DELEGADOR** con carga `NULL`. Misma firma, mismo grant, misma fila byte a byte |
| `uellix_stella_ops.complete_operation_ticket(…7 args)` | el verbo de cierre para las categorías hermanas |

**Por qué la firma de cinco argumentos no se DROPea.**
`STELLA_0016_INSTALLED_PROBE` en `db/prepared-package-order.ts` está escrita
sobre ella; borrarla habría desarmado en silencio la guarda que impide reaplicar
`stella_0015` sobre `stella_0016` — es decir, habría reintroducido R1 por la
puerta de atrás. La mutación **K-103** mata esa versión.

**Carga `NULL` reproduce la fila de `stella_0016` exactamente**: literal fijo,
`not-applicable`, digest derivado, categoría como paso de pipeline. Medido columna
a columna en el §10 del arnés, no prometido.

---

## 5. Lo que cambia en el privilegio

```
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions
  FROM uellix_writer, uellix_app, uellix_reader, uellix_auditor,
       authenticated, anon, service_role, authenticator, PUBLIC;
```

Cada uno como literal fijo, guardado por existencia (`uellix_reader` no está en
el baseline restaurado y sí en otros entornos). Conservan escritura:
`uellix_cap_stella_quota` (`SELECT, INSERT`, nunca `UPDATE`/`DELETE`/`TRUNCATE`) y
el **owner**, que no es un rol de runtime y al que `uellix_migrator` sólo alcanza
con `SET ROLE` explícito (`INHERIT FALSE`).

**`COPY` cae con el mismo privilegio.** Medido: un rol sin `INSERT` recibe
`42501` antes de llegar a la segunda barrera. Esa segunda barrera existe
—PostgreSQL rechaza `COPY … FROM` sobre una relación con RLS activo, medido como
`COPY FROM not supported with row-level security` **antes** de aplicar este
paquete— y el §5 afirma que RLS sigue encendida para que no se pierda en silencio.

### El REVOKE no es toda la clausura

Un privilegio se puede volver a conceder: por un restore de baseline, por
`stella_0005c_rollback.sql` (que **concede `INSERT` a `authenticated` y
`service_role` por nombre**), o por cualquiera con autoridad para escribir un
`GRANT`. Así que la garantía se enuncia también donde ningún grant llega:

```sql
stella_interactions_governed_identity_check:
    CHECK (idempotency_key IS NOT NULL) NOT VALID
```

`NOT VALID` es **preciso, no laxo**: cada fila anterior a este paquete se archivó
por la ruta directa y no lleva clave, así que validar contra la historia fallaría
sobre exactamente las filas que el CHECK existe para impedir que se creen. Se
aplica en **cada** `INSERT` y `UPDATE` desde el momento en que se añade —incluido
el **owner**, cosa que RLS no hace, y bajo `session_replication_role = replica`,
cosa que un trigger no hace—. Declina afirmar nada sobre el pasado y afirma algo
absoluto sobre el futuro. Medido: `23514` para el owner en los dos casos.

---

## 6. Semántica publicada

| Regla | Dónde vive | Medido en |
|---|---|---|
| `Consumed + LiveReserved <= Limit` | `stella_capacity` (sin cambios) | §8, §12, §16 |
| una reserva viva es capacidad comprometida | `bind` → `stella_capacity` | §12 |
| ninguna operación roba una unidad reservada | `consume_stella_capacity` y `bind` | §12, §16 |
| `complete` **convierte**, no compite | `settle_reserved_quota` sin límite | §8, K-99 |
| `abort` y `expire` liberan | `abort_operation_ticket`, predicado de liveness | §12, §13 |
| el reintento no reserva ni cobra otra vez | replay sobre `status = 'completed'` | §11, §16 (duelo 4) |
| operación nueva → ticket nuevo → cargo nuevo | el `ticket_id` está en el preimagen de la clave | §11, K-96 |
| las siete categorías comparten el pool organizacional | `stella_capacity` no filtra por categoría | §9, §12 |

**Periodo — la regla de `stella_0016` se conserva y se prueba.** Una reserva
**viva** se cuenta en el periodo en el que se hace la pregunta; `Reserved` no
filtra por mes a propósito. El §14 del arnés lo ejerce con una reserva cuyo
`period_month` es el mes **anterior** y que sigue viva ahora: `reserved = 1` en el
mes nuevo, `complete` convierte, y el cargo se atribuye al **mes actual**
(`created_at = now()`). `period_month` sigue siendo `GENERATED ALWAYS` desde
`bound_at` y no lo escribe nadie. Es conservador como mucho por el número de
reservas vivas en una ventana de quince minutos, y ser conservador ahí sólo puede
**rechazar** una unidad que iba justa, nunca vender una de más.

**El escenario `sibling consume → grounded complete refusa` deja de ser un caso
exitoso.** Con `stella_0017` no es alcanzable: la hermana no puede escribir. Si
apareciera, es una instalación legacy o un ataque, y el §6 del arnés lo mide como
tal antes de cerrarlo.

---

## 7. Lo que INTEGRACIÓN tiene que hacer

El paquete es **DISEÑO. No aplicado. Ninguna bandera habilitada.** Aplicarlo
**rompe las cinco acciones hermanas** hasta que se migren — por privilegio y por
constraint. Eso es la clausura, no un efecto colateral.

Por acción, el cambio es el mismo:

```
issue_operation_ticket(orgId, projectId, '<categoría>')       -- antes del modelo
bind_operation_ticket(ticket, projectId, contextHash)         -- reserva; si
                                                              -- devuelve
                                                              -- quota_exceeded,
                                                              -- no se llama al modelo
<ejecutar el modelo, fuera de toda transacción>
complete_operation_ticket(ticket, projectId, contextHash,
    pipelineStep, modelUsed, tokensUsed, responseJson)        -- cobra 1 unidad
abort_operation_ticket(ticket, projectId, '<razón>')          -- si falla
```

| Acción | Categoría | Fichero |
|---|---|---|
| `getStellaContextualAdvisor` | `advisor` | `app/actions/stella/advisor.ts` |
| `getStellaAdvisor` | `advisor` | `app/actions/stella/advisor.ts` |
| `getStellaValidator` | `validator` | `app/actions/stella/validator.ts` |
| `getStellaComposer` | `composer` | `app/actions/stella/composer.ts` |
| `getStellaReviewer` | `proxy_reviewer` / `evidence_reviewer` / `audit_assistant` | `app/actions/stella/reviewer.ts` |

`db/stella/operation-tickets.ts` necesita el adaptador de la nueva aridad. Esta
línea **no lo ha tocado**: el brief del tren prohíbe expresamente modificar los
server actions todavía, y cambiar el adaptador sin ellos rompe `tsc`.

`checkStellaQuota` (`lib/stella/quota.ts`) sigue leyendo sólo filas cobradas.
Debe pasar a `uellix_stella.stella_capacity`, o las cinco acciones seguirán
mostrando disponibilidad que una reserva viva ya se llevó — sin sobrevender, pero
mintiendo en la UI.

`scripts/seed-stella-local.ts:124` archiva una fila sin clave y **deja de
funcionar** al aplicar el paquete. Es de RELEASE; se registra aquí en vez de
editarlo.

### Aserciones de un fichero INTEGRATION-OWNED que ahora fallan

`tests/cross-workstream/project-binding.test.ts` afirma que
`STELLA_TICKET_PACKAGE_CHAIN` tiene **tres** elementos y que
`supersessionsFor('stella_0015…')` tiene **cero** reglas. Las dos **ya fallaban
antes de este tren** —`stella_0016` llevó la cadena a cuatro y añadió la primera
regla sobre `stella_0015`— y este tren las ensancha: la cadena tiene **cinco** y
`stella_0015` tiene **dos** reglas. El fichero es de INTEGRACIÓN y esta línea no
lo modifica.

`scripts/stella-ticket-e2e.sh` lleva un `package_order_guard()` en shell que
`project-binding.test.ts` compara contra el registro TypeScript. Es de
INTEGRACIÓN/RELEASE; las dos reglas nuevas hay que reflejarlas ahí.

---

## 8. Con qué se probó

`scripts/stella-governed-consumption-dry-run.sh` — PostgreSQL desechable
(`--network none`, sin volumen, destruido en el trap de salida), dos etapas, dos
organizaciones, tres proyectos, tres actores, las **siete** categorías.
Reproducción del sobreconsumo por el nombre y por el privilegio **heredado**;
cierre; recorrido hermano completo con carga real; paridad byte a byte de la fila
grounded; reintento frente a operación nueva; semántica de reserva entre
hermanas y con el consumidor sin ticket; expiración lógica **sin cron**; **cruce
de periodo**; quince ataques en vivo; **cinco duelos de concurrencia real** con
dos conexiones (`pg_stat_database.deadlocks = 0`); rollback sobre una base
**liquidada** (10 cargos y 9 tickets intactos) y sobre una **limpia**;
reaplicación idéntica ×3; orden de rollback impuesto en los dos extremos.
Salida: `STELLA_GOVERNED_CONSUMPTION_DRY_RUN_OK`.

`tests/stella-governed-consumption-mutation.test.ts` — **26 mutantes**
(`K-86` … `K-111`), cada uno muerto por **su** gate propietaria, ninguno por
`unparsed`.

`tests/prepared-stella-sql.test.ts`, `tests/prepared-sql-source-of-truth.test.ts`,
y las tres suites de mutación anteriores (`K-01`…`K-85`): **404 pruebas, todas
verdes**. `tsc --noEmit` y `eslint` sobre los ficheros tocados: limpios.

---

## 9. Lo que NO cambió

`consume_stella_quota`, `stella_capacity`, `consume_stella_capacity`,
`bind_operation_ticket`, `complete_operation_ticket(char, uuid, char)`,
`abort_operation_ticket`, `inspect_operation_ticket`, `issue_operation_ticket` y
`expire_operation_tickets` están **intactos**. Ningún rol, esquema, tabla ni
policy nuevos. `app/actions/**`, `components/**` y `lib/grounding/**` sin tocar.
Banderas en `false`. Cero acceso remoto, cero push, cero stack persistente.

## 10. Riesgos residuales

| # | Riesgo | Severidad | Estado |
|---|---|---|---|
| R6a | Las cinco acciones no han migrado; aplicar el paquete las rompe | MAJOR | **Declarado.** Es la clausura, y la solicitud de integración está en el §7 |
| R6b | `checkStellaQuota` sigue contando sólo filas cobradas | MINOR | Abierto. Sin sobreventa; la UI muestra disponibilidad que una reserva ya tomó |
| R6c | `scripts/seed-stella-local.ts` archiva sin clave y dejará de funcionar | MINOR | Abierto, de RELEASE |
| R6d | Un operador con autoridad de `GRANT` puede reabrir el `INSERT`; el CHECK aguanta, el privilegio no | MINOR | Aceptado y **medido**: el CHECK es la mitad que un grant no deshace |
| R6e | `stella_0005c_rollback.sql` concede `INSERT` a `authenticated`/`service_role` por nombre | MINOR | Abierto. Ningún paquete puede impedir que otro se ejecute después; K-88 mata la versión que no lo previene |
| R6f | Las dos aserciones de `project-binding.test.ts` siguen rojas | MINOR | **Preexistente**, ensanchado. Fichero INTEGRATION-OWNED |
| R6g | La guarda de orden en `scripts/stella-ticket-e2e.sh` no conoce las reglas nuevas | MINOR | Abierto, de INTEGRACIÓN/RELEASE |
| R3-INT, R4-INT, R5-INT, R7-INT | del tren 4.1/4.2 | MINOR | Sin cambios |
