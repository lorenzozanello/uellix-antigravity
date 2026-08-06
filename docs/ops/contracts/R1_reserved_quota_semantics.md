# R1 — semántica única y gobernada de capacidad reservada

**Contrato:** `R1` — «una acción Stella hermana cobra entre `bind` y `complete`»
([`CONTRACT_LEDGER.md`](CONTRACT_LEDGER.md#riesgos-residuales-abiertos-tras-el-cierre)).
**Línea propietaria:** CAPABILITIES.
**Unidad:** `db/prepared/stella_0016_reserved_quota_semantics.sql` +
`db/prepared/stella_0016_rollback.sql`.
**Estado de aplicación:** **DISEÑO. No aplicado a ninguna base. Ninguna bandera
habilitada. Ningún server action llama a nada de esto** — cablearlo es la
reconciliación de INTEGRACIÓN y está explícitamente fuera del alcance.

---

## 1. El defecto, reproducido antes de cerrarlo

`§5b` de `scripts/stella-reserved-quota-dry-run.sh`, contra las funciones
reales, con la cuota restante en **1**:

| Paso | Resultado medido |
|---|---|
| `bind(ticket)` | `bound` — el ticket **reserva** la única unidad |
| la hermana lee el ledger | `used = 0`, `quota = 1` → **cree que puede** |
| la hermana escribe | cobra la unidad con `db.insert` directo |
| `complete(ticket)` | **`quota_exceeded`** |
| ticket | queda `bound`, sin liquidar |
| cargos `grounded_query` | **0** |

El trabajo grounded corrió, produjo una respuesta utilizable y **se regaló**.
No se excedió la cuota —el tope aguantó— pero la reserva no le compró nada al
ticket, y `complete` perdió una unidad que su propio `bind` había apartado.

### Dos causas independientes, y sólo nombrar las dos explica por qué arreglar una no basta

**(1) `consume_stella_quota` cuenta SÓLO FILAS COBRADAS.** Es la función por la
que `complete` cobra, así que `complete` vuelve a entrar en la competencia que
su reserva debía haber zanjado. Las cinco acciones hermanas ni siquiera llegan
ahí: leen un `count` en TypeScript y luego hacen `db.insert` sobre el ledger a
través del grant permanente de `uellix_writer` (**R6-INT**). Ninguna de las dos
rutas puede ver una reserva, porque una reserva no es una fila de esa tabla y
nunca podrá serlo — una reserva tiene que ser **liberable** y el ledger es
append-only.

**(2) EL CONTEO DE RESERVAS ESTABA LIGADO AL ACTOR.** Esto **no** estaba en el
ledger de contratos; apareció al reproducir (1). `bind` contaba con
`SELECT count(*) FROM uellix_stella_ops.operation_tickets` ejecutado como
`uellix_cap_stella_ticket` — un rol sin `BYPASSRLS`, sujeto a la policy
`operation_tickets_definer_select` de `stella_0014 §5`, cuyo predicado es
`actor_id = auth.uid()`. Así que **cada actor contaba sólo sus propias
reservas**. Medido en `§5c`:

| Paso | Resultado |
|---|---|
| actor A: `bind` | `bound` |
| actor C: `bind` (misma organización, misma última unidad) | **`bound`** |
| reservas vivas contra cuota 1 | **2** |

El tren 4.2 midió «dos tickets por la última unidad» con **un** actor, y por eso
leyó verde.

---

## 2. El contrato de capacidad, derivado y no inventado

Todo sale de lo que ya existía; nada se inventa.

| Dimensión | Valor | De dónde sale |
|---|---|---|
| Nivel de cuota | **organización** | `organizations.stella_monthly_quota` |
| Categoría | **una sola bolsa**, compartida por los 7 roles | `checkStellaQuota` cuenta *todas* las filas de la organización sin filtrar por `stella_role` |
| Ventana | mes natural | `date_trunc('month', …)` |
| Timezone | **UTC** | `startOfCurrentUtcMonth()` en TS; `timezone('UTC', now())` en SQL |
| Corte | primer instante del mes UTC | ídem |
| Unidad | **una fila de `public.stella_interactions`** | `stella_0013`, y ya cierto para las cinco hermanas |

Formalmente:

```
Consumed(org, period) = filas de stella_interactions de esa organización
                        cuyo created_at cae en el periodo
Reserved(org)         = tickets de esa organización en estado `bound`
                        cuyo expires_at sigue en el futuro
Available(org, period) = Limit - Consumed - Reserved
```

y la invariante, enunciada una vez y aplicada en un solo sitio:

```
Consumed + Reserved <= Limit
```

### La pertenencia al periodo, y por qué `Reserved` NO lleva filtro de mes

`expires_at` está acotado a quince minutos (`stella_0014 §3g`), así que una
reserva tomada a las 23:58 del último día todavía puede convertirse a las 00:03
del siguiente. El `created_at` de la fila cobrada es `now()`, así que el cargo
cuenta contra el **periodo nuevo** — el que nunca la reservó.

**La regla, enunciada en vez de dejada a una consulta sin filtro:** una reserva
**viva** se cuenta en el periodo en que se hace la pregunta. `Reserved` no lleva
filtro de mes, deliberadamente. Así el periodo nuevo ya apartó la unidad antes de
que llegue la conversión, y la invariante aguanta el cruce **sin que nadie
antedate una fila de cumplimiento**. Es conservador como mucho por el número de
reservas vivas en una ventana de quince minutos, y ser conservador aquí sólo
puede **rechazar** una unidad que iba justa, nunca vender una de más.

`period_month` se añade para que la pertenencia sea un **hecho registrado** y no
una inferencia: columna `GENERATED ALWAYS` derivada de `bound_at`. La aritmética
no ramifica sobre ella; `§7 (7)` afirma que no se puede escribir. Medido en `§9`
del arnés: una reserva viva cuyo `period_month` es un mes anterior **sí** cuenta,
rechaza a la hermana, y su conversión aterriza en el mes actual contra la unidad
que el mes actual ya había apartado.

### Cuando un admin baja el tope a mitad de una reserva

Una reserva es un compromiso adquirido bajo el límite vigente cuando se tomó.
Bajar `stella_monthly_quota` después **no anula compromisos ya adquiridos**: esos
tickets convierten. Sí rechaza toda reserva **nueva** hasta que `Consumed` vuelva
por debajo del tope nuevo. Se declara porque la alternativa —descartar trabajo ya
ejecutado para satisfacer un número que cambió después— es una compensación
silenciosa, y esta línea no hace de esas.

---

## 3. Las tres superficies

| Función | Esquema | Dueño | `EXECUTE` para | Qué hace |
|---|---|---|---|---|
| `stella_capacity(uuid, char(64))` | `uellix_stella` | `uellix_cap_stella_quota` | `uellix_app`, `uellix_cap_stella_ticket` | La aritmética canónica. **Sin lock, sin escritura.** |
| `consume_stella_capacity(uuid, uuid, varchar(50), char(64))` | `uellix_stella` | `uellix_cap_stella_quota` | `uellix_app` | La superficie para consumidores **sin ticket**. Lock → replay → capacidad → cobro **a través de** `consume_stella_quota`. |
| `settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))` | `uellix_stella` | `uellix_cap_stella_quota` | **sólo `uellix_cap_stella_ticket`** | La **conversión**. Cobra **sin evaluar el límite**. |

`bind_operation_ticket` y `complete_operation_ticket` se **republican en el
sitio** — mismos nombres, mismos nombres de argumento, mismos tipos — así que
`CREATE OR REPLACE` los acepta, no se dropea ninguna firma, no se reemite ningún
grant, y el recuento de funciones en `uellix_stella_ops` sigue siendo **6**.

### Por qué `settle_reserved_quota` puede saltarse el límite, y por qué eso no es un hueco

Una reserva no es una pista: es capacidad **ya comprometida**. Volver a
comprobar el límite en la conversión contaría la misma unidad dos veces —una
como `Reserved` mientras el trabajo corría, otra como `Consumed` cuando
aterriza— y es esa segunda cuenta la que hace que `complete` pierda contra una
hermana que llegó en medio. Así que la comprobación se mueve a donde el
compromiso se **adquiere** (`bind`, y ahora todo consumidor sin ticket) y la
conversión no lleva ninguna decisión.

Tres cosas, no una, impiden que sea una puerta trasera:

1. **El GRANT.** `uellix_cap_stella_ticket` y nadie más — ni `uellix_app`, ni
   `PUBLIC`. `§7 (3)` afirma **las dos** mitades: quién sí y quién no.
2. **La PRUEBA.** Relee la fila del ticket por su cuenta y se niega (`U0111`)
   salvo que sea `bound`, no expirada, y soldada exactamente a la organización,
   el proyecto y la categoría que se le pide cobrar. No se fía de su llamador en
   ninguna de las cuatro.
3. **La IDENTIDAD.** La clave de idempotencia sigue llegando del llamador y
   sigue aplicada por `uq_stella_interactions_idempotency`, así que una segunda
   conversión del mismo ticket es un replay y no una segunda unidad — como
   propiedad de los **DATOS**, no de quién llamó a qué.

---

## 4. Por qué las funciones nuevas viven en `uellix_stella`

**MEDIDO, no preferido.** `stella_0015 §4` afirma `count(*) = 6` sobre
`uellix_stella_ops`; una séptima función ahí hace que `stella_0015` aborte en su
siguiente aplicación — la misma clase de defecto que `stella_0014 §1` registró
cuando se negó a compartir `uellix_stella`. `stella_0013 §7` **no** cuenta las de
`uellix_stella`: afirma que todas son `SECURITY DEFINER` con `search_path` vacío,
propiedad de `uellix_cap_stella_quota` y sin `EXECUTE` para `PUBLIC`. Las tres
nuevas cumplen las cuatro, así que `stella_0013` sigue siendo idempotente sobre
este paquete — y `§7 (2)` lo afirma, y `§13d` del arnés lo **ejecuta**.

## 5. Lo único que este paquete sí mueve, y la guarda

La aritmética necesita ver **todo** el conjunto de reservas vivas de la
organización, y la única policy que deja a un definer leer `operation_tickets`
está ligada al actor. Así que se añade una **cuarta** policy —
`operation_tickets_capacity_select`, sólo para `uellix_cap_stella_quota`,
**scope de organización y NO de actor**.

`stella_0014 §7 (5)` afirma `count(*) = 3` policies, así que **después de este
paquete `stella_0014` deja de ser reaplicable**. Está registrado como
supersesión en `db/prepared-package-order.ts` y `db/migrator.ts` rechaza la
reaplicación **dentro** de la transacción que la haría. La alternativa era
ampliar la aserción de `stella_0014` — editar un paquete publicado para hacer
sitio a uno posterior, el intercambio que el tren 4.2 rechazó.

**Lo que la policy nueva NO concede.** Va emparejada con un grant de `SELECT`
**por columna** que nombra siete. `charge_nonce` y `query_hash` **no** están
entre ellas, así que «cuenta las reservas de la organización» y «puede leer la
mitad secreta de una clave de idempotencia» siguen siendo dos frases distintas,
impuestas por el sistema de privilegios y no por la disciplina de los cuerpos.

---

## 6. Evidencia ejecutada

`scripts/stella-reserved-quota-dry-run.sh` — PostgreSQL desechable
(`--network none`, sin volumen, destruido en el trap de salida), baseline +
`stella_0013/0014/0015` (etapa 1, donde se **reproduce** R1 y R1b) +
`stella_0016` (etapa 2). Dos organizaciones, tres proyectos, tres actores.

| § | Qué mide | Resultado |
|---|---|---|
| 4 | `stella_0016` sin su cadena aborta | ok |
| 5b | **R1 reproducido** | la hermana ignora la reserva; `complete` → `quota_exceeded`; 0 cargos grounded |
| 5c | **R1b reproducido** | dos actores, dos reservas, cuota 1 |
| 7 | **R1 cerrado** | `available = 0`; hermana → `quota_exceeded`; `complete` → `completed`; reintento → `replayed`; 1 unidad vendida |
| 7b | **R1b cerrado** | el actor C ve la reserva de A y es rechazado |
| 8a | `abort` libera en el acto | `reserved 1 → 0`; la hermana consume; `complete` tras abort → `U0109` |
| 8b | expiración **lógica**, sin cron | reserva vencida no cuenta; hermana consume; `complete` → `U0108`; `expire` materializa después |
| 9 | **cambio de periodo** | reserva viva de otro mes sí cuenta; rechaza a la hermana; convierte en el mes actual; nunca se excede el límite |
| 10a–10h | **concurrencia real**, dos conexiones | 8 duelos; la espera medida (≥2 s) prueba serialización; `Consumed + Reserved <= Limit`; **0 deadlocks** |
| 11 | ataques | `settle` inalcanzable para el runtime (`42501`); `SELECT` directo denegado (`42501`); cross-org/cross-proyecto `U0102`; categoría inválida `U0106`; `settle` con ticket inventado / expirado / ya convertido `U0111` |
| 11b–11d | superficie | 0 `EXECUTE` para `PUBLIC`; 0 firmas sin proyecto; el rol de capacidad no escribe tickets; la policy no mira el actor; `session_replication_role = replica` no desarma la máquina de estados (`U0109`); `period_month` inescribible (`428C9`) |
| 12 | **rollback sobre base liquidada** | 9 cargos y 10 tickets (completed/aborted/expired/issued/bound) **intactos**; `bind` inalcanzable (fail-closed); el rollback de `stella_0014` **se niega** ante tickets `completed`, como debe |
| 13 | rollback sobre base limpia + **reaplicación** | retorno EXACTO al baseline; doble aplicación converge; `stella_0013` reaplica sobre `stella_0016` |
| 14 | **guarda de orden** | reaplicar `stella_0015` **sí** reintroduce R1 — la premisa del registro, medida |
| 15 | teardown | retorno EXACTO al baseline; 0 roles residuales |

Salida final: `STELLA_RESERVED_QUOTA_DRY_RUN_OK`.

**Mutaciones.** `tests/stella-reserved-quota-mutation.test.ts` — **32 mutantes**
(`K-54` … `K-85`), cada uno muerto por **su** gate propietaria, sobre una
copia en memoria. La lista de gates que ninguna mutación ejercita está escrita,
para que crecer no sea un acto silencioso.

---

## 7. Solicitud de integración

**R1 no está cerrado sólo porque el `complete` grounded funcione.** La superficie
existe; migrar a ella es de INTEGRACIÓN.

### 7.1 Consumidores que deben migrar

Cada uno hace hoy `checkStellaQuota(org)` —una lectura sin lock que cuenta sólo
filas cobradas— seguida de `db.insert(stellaInteractions)` —una escritura sin
lock, sin clave de idempotencia y sin pasar por ninguna función gobernada.

| Consumidor | Ruta | Categoría | Cuenta reservas hoy | Riesgo de sobreventa |
|---|---|---|---|---|
| `getStellaContextualAdvisor` | `app/actions/stella/advisor.ts:77` | `advisor` | **no** | **sí** |
| `getStellaAdvisor` | `app/actions/stella/advisor.ts:252` | `advisor` | **no** | **sí** |
| `getStellaValidator` | `app/actions/stella/validator.ts:69` | `validator` | **no** | **sí** |
| `getStellaComposer` | `app/actions/stella/composer.ts:63` | `composer` | **no** | **sí** |
| `getStellaReviewer` | `app/actions/stella/reviewer.ts:74` | `proxy_reviewer` \| `evidence_reviewer` \| `audit_assistant` | **no** | **sí** |
| `runStellaGroundedQueryForProject` | `app/actions/stella/grounded-query.ts:990` | `grounded_query` | sí (vía ticket) | cerrado por este paquete |

`recordStellaDecision` (`app/actions/stella/decisions.ts:77`) **no** consume
cuota: no llama a `checkStellaQuota` ni escribe `stella_interactions`.

### 7.2 El cambio, por consumidor

Sustituir el par lectura-sin-lock + `db.insert` por **una** llamada:

```
SELECT outcome, used, quota
  FROM uellix_stella.consume_stella_capacity($org, $project, $category, $idempotencyKey)
```

`outcome` habla el vocabulario que `lib/stella/quota.ts` ya conoce —
`consumed` / `replayed` / `no_quota` / `quota_exceeded` — así que la capa de
presentación no aprende nada nuevo. Lo que sí hace falta decidir es **de dónde
sale `$idempotencyKey`** en cada acción hermana: es el mismo problema que
`INT-INT-001` resolvió para grounded con un ticket, y las hermanas no tienen uno.
Mientras no lo tengan, `consume_stella_capacity` sigue siendo correcta —
rechaza cuando no hay capacidad— pero un reintento cobra una segunda unidad,
exactamente como hoy.

`lib/stella/quota.ts` debería además leer `uellix_stella.stella_capacity` en vez
de reconstruir el `count`, para que lo que la UI muestra y lo que la base impone
sean el mismo número.

### 7.3 Tres aserciones de un fichero INTEGRATION-OWNED que ahora fallan

`tests/cross-workstream/project-binding.test.ts` afirma que el registro de
supersesiones tiene **exactamente una** regla. Añadir la segunda —que FASE 8
exige— la contradice por construcción. Esta línea **no ha modificado ese
fichero**. Las dos aserciones a reconciliar:

| Aserción | Línea | Reparación |
|---|---|---|
| `expect(STELLA_TICKET_PACKAGE_CHAIN).toEqual([...3 paquetes])` | `~170` | añadir `'stella_0016_reserved_quota_semantics'` |
| `expect(supersessionsFor('stella_0015…')).toHaveLength(0)` y `expect(PREPARED_PACKAGE_SUPERSESSIONS).toHaveLength(1)` | `~206` | seleccionar la regla por `packageName` en vez de por posición, y esperar **2** |

La regla de `stella_0014` se dejó **primera** en el array a propósito, para que
`const [rule] = PREPARED_PACKAGE_SUPERSESSIONS` siga refiriéndose a ella y las
otras dos aserciones de ese fichero sigan verdes.

---

## 8. Riesgos residuales

| # | Riesgo | Severidad | Estado |
|---|---|---|---|
| R1a | Las cinco acciones hermanas **siguen** escribiendo el ledger con `db.insert`. La superficie que las ve existe; nadie la llama todavía | MAJOR | Abierto — §7 es la solicitud. Es **R6-INT** con una salida |
| R1b | Las hermanas no tienen fuente canónica de clave de idempotencia, así que un reintento suyo cobra dos veces | MAJOR | Preexistente, fuera del alcance de un paquete SQL: la identidad tiene que emitirse antes de la operación (`INT-INT-001`) |
| R1c | `stella_0014` deja de ser reaplicable (cuarta policy). Cubierto por el runner, no por SQL | MINOR | Aceptado y registrado |
| R1d | Bajar el tope a mitad de una reserva deja `Consumed + Reserved > Limit` hasta que las reservas vivas convierten o expiran | MINOR | **Declarado, no tapado**: un compromiso adquirido bajo el límite vigente no se anula retroactivamente |
| R1e | `abort` no toma el advisory lock, así que una hermana ya en vuelo no ve la liberación hasta que commitea | MINOR | Medido en `§10d`. Aislamiento transaccional, dirección conservadora: rechaza de más, nunca vende de más |
| R3-INT, R4-INT, R5-INT, R7-INT | sin cambios | — | Siguen exactamente como el tren 4.2 los dejó |
