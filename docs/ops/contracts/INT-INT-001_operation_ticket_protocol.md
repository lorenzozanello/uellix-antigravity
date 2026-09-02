# INT-INT-001 — Protocolo de tickets de operación gobernados

| Campo | Valor |
|---|---|
| **Solicitante** | INTEGRACIÓN |
| **Propietaria del contrato** | INTEGRACIÓN |
| **Responde** | CAPABILITIES (tren 4.1) |
| **Fecha** | 2026-08-05 |
| **Paquete** | [`db/prepared/stella_0014_operation_tickets.sql`](../../../db/prepared/stella_0014_operation_tickets.sql) · rollback [`stella_0014_rollback.sql`](../../../db/prepared/stella_0014_rollback.sql) |
| **Estado** | **DISEÑO — no aplicado a ninguna base.** Ningún server action lo llama. Cablearlo es la reconciliación de INTEGRACIÓN |

> Este documento **no** modifica `CONTRACT_LEDGER.md`. La fila de INT-INT-001
> sigue en `solicitado` hasta que integración acepte.

---

## 1. Qué reporta INT-INT-001, y por qué ninguna fuente existente lo cierra

`uellix_stella.consume_stella_quota` exige `idempotency_key`. La exigencia es
correcta —`uq_stella_interactions_idempotency` convierte «no cobrar dos veces un
reintento» en una propiedad de los **datos**— pero una clave sólo vale por la
distinción que traza, y debe trazar exactamente una:

```
reintento de una operación  ->  misma clave   (cobra una vez)
operación nueva             ->  clave nueva   (vuelve a cobrar)
```

**Reproducido, no argumentado.** El §7 de
[`scripts/stella-ticket-dry-run.sh`](../../../scripts/stella-ticket-dry-run.sh)
ejecuta las dos candidatas contra la función real, antes de instalar nada:

| Candidata | Resultado ejecutado | Lectura |
|---|---|---|
| `randomUUID()` por invocación | `consumed`, `consumed` → **2 filas** | el reintento **cobra dos veces** |
| digest de (usuario, proyecto, consulta) | `consumed`, `replayed` → **1 fila** | la segunda pregunta legítima sale **gratis** |

Buscado y **no encontrado** en esta aplicación (verificado en el tren 4.1):
tabla de tickets, tabla de reservas, outbox transaccional, `requestId` /
`correlationId` / `invocationId` canónico (no hay middleware), secreto de firma
de propósito general (sólo `STRIPE_*`, otro dominio). `app.request_id` existe
como GUC que lee el trigger de auditoría de `stella_0007`, pero **lo fija el
llamante**, nada del runtime lo pone, y un valor que elige el cliente no es una
identidad.

Conclusión: la identidad tiene que ser **emitida**, y emitida **antes** de que la
operación corra — que es justo lo que un digest del request nunca puede ser.

## 2. Por qué una tabla nueva, y por qué no `stella_interactions`

La estructura canónica se **reutiliza** donde puede: una unidad de cuota sigue
siendo **una fila de `public.stella_interactions`**, contada por
`checkStellaQuota`, escrita por `consume_stella_quota` y por nada más. El
paquete no añade un segundo ledger y **no tiene INSERT sobre el primero**.

Lo que no puede reutilizar es la **fila**. Un ticket tiene ciclo de vida, y
`trg_stella_interactions_append_only` (prepared `stella_0002`) rechaza `UPDATE`
y `DELETE` sobre esa tabla para **todo** rol incluido el dueño. Una máquina de
estados no cabe en una tabla donde ningún estado puede cambiar. No es una
preferencia: es la razón de que el ticket sea un objeto aparte.

**Esquema propio (`uellix_stella_ops`), y también medido.** `stella_0013`
afirma en su §7 (4)/(5), sobre **todo** el esquema `uellix_stella`, que cada
función de ahí es SECURITY DEFINER, con `search_path` vacío y propiedad de
`uellix_cap_stella_quota`. Poner las seis funciones nuevas en ese esquema hace
que **`stella_0013` aborte en su segunda aplicación** — observado en el pase 2
del arnés, no razonado. Ensanchar aquella aserción habría sido editar un
paquete publicado para hacerle sitio a otro, y cambiar un contrato exacto por
uno más débil. En su lugar se aplica el argumento que el propio `stella_0013`
escribió para no compartir `uellix_capability`: un esquema por familia.

## 3. La máquina de estados

```
                 issue
                   |
                   v
              [ issued ] --------- abort ---------> [ aborted ]
                   |                                     ^
                bind (reserva)                           |
                   |                                     |
                   v                                     |
              [ bound ] ----------- abort ---------------+
                   |
              complete (cobra)
                   |
                   v
             [ completed ]        (terminal, no abortable)

  issued | bound  --- expires_at <= now() --->  [ expired ]
```

| Estado | Reserva cuota | Cobrado | Terminal |
|---|---|---|---|
| `issued` | no | no | no |
| `bound` | **sí**, mientras `expires_at > now()` | no | no |
| `completed` | no (ya convertida en fila del ledger) | **sí** | sí |
| `aborted` | no | no | sí |
| `expired` | no | no | sí |

### Los doce invariantes, y dónde vive cada uno

| # | Invariante | Dónde se impone |
|---|---|---|
| 1 | El ticket se emite sólo desde superficie gobernada | `issue_operation_ticket`, SECURITY DEFINER; la tabla no está concedida a ningún principal de runtime |
| 2 | Ligado a actor, organización y proyecto | columnas NOT NULL + trigger de inmutabilidad + 3 policies |
| 3 | Ligado a `grounded_query` (categoría gobernada) | CHECK `operation_tickets_category_check` + array de `issue` |
| 4 | Tiene expiración | CHECK `operation_tickets_expiry_window_check` (acotada a 15 min) |
| 5 | El query hash se fija una sola vez | trigger: `OLD.query_hash IS NOT NULL AND NEW.query_hash IS DISTINCT FROM OLD` |
| 6 | El mismo ticket no admite otro hash | `bind` y `complete` → `U0107` |
| 7 | Mismo ticket + mismo hash es idempotente | `bind` devuelve `bound`; `complete` devuelve `replayed` |
| 8 | Dos tickets ejecutan el mismo texto como consultas nuevas | no hay unicidad sobre `query_hash` — deliberado |
| 9 | Un ticket completado no cobra otra vez | `complete` corta en `completed`; y la clave derivada colisiona en `uq_stella_interactions_idempotency` |
| 10 | Un ticket abortado no queda cobrado | `abort` rechaza `completed` (`U0109`); el cobro ocurre **después** de la reserva |
| 11 | Un ticket de otro scope se rechaza | RLS (actor + organización) + trigger (proyecto↔organización) → `U0102` |
| 12 | Ningún estado ambiguo se lee como completado | transiciones enumeradas; lo no nombrado se rechaza |

**Ninguno depende sólo de RLS.** Esta línea decidió no activar
`FORCE ROW LEVEL SECURITY` (ver `CAPABILITIES.md`, «Decisión FORCE RLS»: haría
que el propio rollback contara 0 filas sobre una tabla poblada y mintiera sobre
cuánto destruye). Los invariantes que deben alcanzar al **dueño** viven por
tanto en CHECK constraints y en triggers `ENABLE ALWAYS` — que siguen
disparando bajo `session_replication_role = replica`, comprobado en vivo.

## 4. El protocolo de cuota

```
1. issue     -> ticket opaco. No reserva nada.
2. bind      -> fija el digest UNA vez y RESERVA la unidad, bajo el lock de
                advisory por organización, contando filas cobradas + otras
                reservas vivas. Sin margen: se REFUSA y la operación no corre.
3. ejecutar  -> FUERA de la transacción. Ningún lock de base queda abierto:
                la reserva es un ESTADO DE FILA.
4. complete  -> cobra exactamente una vez a través de consume_stella_quota.
5. abort     -> libera la reserva. No cobra, y no compensa en silencio.
```

Los cuatro fallos que la FASE 3 del despacho exige evitar simultáneamente:

| | Fallo | Cómo se evita | Evidencia |
|---|---|---|---|
| A | doble cobro en reintentos | clave derivada del ticket → `replayed` | §8 `complete_reintento`, §11b |
| B | sobreconsumo por concurrencia | reserva contada bajo el **mismo** lock que el cobro | §11a (la sesión 2 espera y es rechazada) |
| C | cobro de una operación fallida | el cobro ocurre **después** del trabajo; el fallo se aborta antes | §8 `filas_tras_fallo=1` |
| D | reutilizar un ticket para otra consulta | digest write-once | §8 `bind_otro_texto=U0107` |

### La reserva huérfana, y la ausencia de cron

**No hay `pg_cron` en este proyecto y el paquete no finge que lo haya.**
`expires_at > now()` forma parte del **predicado de vivacidad** dentro de
`bind`, así que un ticket abandonado por un proceso caído deja de reservar en el
instante en que expira, llame o no llame alguien a `expire_operation_tickets`.
Esa función existe para higiene y observabilidad; la garantía **no** depende de
ella. Comprobado en §11f: con una reserva vencida en estado `bound` y una sola
unidad de cuota, un ticket nuevo reserva sin problema.

### El caso que el protocolo **no** resuelve solo

Si una acción Stella hermana cobra el ledger **entre** `bind` y `complete`,
`consume_stella_quota` puede devolver `quota_exceeded` sobre una operación ya
ejecutada. El paquete **lo reporta y no lo tapa**: el ticket queda `bound`, el
llamante puede abortarlo con `quota_refused`, y nunca se cobran más unidades de
las vendidas. Si el trabajo debe regalarse o la cuota debe excederse en uno es
una **decisión de facturación**, no de base de datos; el SQL se niega a tomarla
en silencio. Ver §8 de Riesgos.

## 5. Identidad y hash

### `ticket_id` — opaco, emitido por servidor

```
ticket_id = sha256_hex('stella/ticket/id/v1' || LF || uuid4() || LF || uuid4())
```

Dos extracciones independientes de `pg_catalog.gen_random_uuid()` (122 bits
cada una, `pg_strong_random`), plegadas a 64 hex. El digest no es la entropía —
los dos uuid lo son — pero da una forma fija que el CHECK puede enunciar y que
ningún consumidor puede confundir con un uuid que quiera parsear o re-derivar.
`§0` aborta si `gen_random_uuid()` no resuelve en `pg_catalog`.

### La clave de cuota — **no elegible ni calculable por el llamante**

```
charge_nonce   = sha256_hex('stella/ticket/nonce/v1' || LF || uuid4() || LF || uuid4())
                 -- generado en issue, NUNCA devuelto por ninguna función

idempotency_key = sha256_hex('stella/ticket/charge/v1' || LF || ticket_id || LF || charge_nonce)
                 -- derivado dentro de complete_operation_ticket
```

Ninguna función devuelve el nonce (afirmado sobre `pg_get_function_result`, §6
del arnés) y **ningún** principal de runtime —`uellix_app`, `authenticated`,
`anon`, `service_role`, `uellix_writer`, `uellix_reader`, `uellix_auditor`—
tiene privilegio directo sobre la tabla. Sin el nonce, quien tiene el ticket no
puede calcular la clave, así que no puede cobrar fuera del protocolo ni
pre-cobrar para que el `complete` posterior devuelva `replayed`.

### `query_hash` — la canonicalización, que es trabajo de INTEGRACIÓN

**El texto de la consulta nunca cruza la frontera de la base.** La tabla no
tiene una sola columna capaz de guardarlo (afirmado estructuralmente en §7 (12)
del paquete y medido en §8 del arnés: `columnas_de_payload=0`), y **no se
publica ninguna función que acepte texto** — precisamente para que no exista una
superficie por la que la consulta pueda llegar a los logs del servidor.

La canonicalización vive por tanto en la aplicación. El contrato es:

```
canonical(q) = collapse_ws(trim(NFC(q)))
    NFC          normalización Unicode NFC
    trim         quita blanco inicial y final
    collapse_ws  toda secuencia de blanco interna -> un solo U+0020
    NO hay plegado de mayúsculas

query_hash = sha256_hex(utf8('stella/query/v1' || LF || canonical(q)))
```

**Por qué sin plegado de mayúsculas.** El trabajo del digest aquí es detectar
que un reintento lleva la MISMA consulta. Un reintento automático reenvía bytes
idénticos, así que distinguir mayúsculas no cuesta nada — y sólo puede hacer que
dos cosas sean distintas, nunca que sean erróneamente idénticas. El plegado
depende del locale y podría fundir dos preguntas distintas; conservador es
correcto.

**Por qué sí colapsar blanco.** Protege contra diferencias triviales de
re-serialización sin poder fundir dos preguntas semánticamente distintas.

Lo que la base **sí** impone, y el arnés comprueba: forma de 64 hex minúsculas
(`U0100` si no), write-once, y rechazo de un digest distinto sobre el mismo
ticket (`U0107`).

## 6. Superficie gobernada

| Función | Devuelve | Errores |
|---|---|---|
| `issue_operation_ticket(org, project, category)` | `char(64)` | `U0100` malformado · `U0102` fuera de scope · `U0106` categoría no gobernada |
| `bind_operation_ticket(ticket, query_hash)` | `(outcome, used, quota)` con `outcome ∈ {bound, quota_exceeded, no_quota}` | `U0100` · `U0102` · `U0107` otro digest · `U0108` expirado · `U0109` liquidado |
| `complete_operation_ticket(ticket, query_hash)` | `(outcome, used, quota)` con `outcome ∈ {completed, replayed, quota_exceeded, no_quota}` | `U0100` · `U0102` · `U0107` · `U0108` · `U0109` |
| `abort_operation_ticket(ticket, reason)` | `text` (`aborted` / `expired`) | `U0100` · `U0102` · `U0106` razón no gobernada · `U0109` ya completado |
| `inspect_operation_ticket(ticket)` | `(status, category, expires_at, has_query_hash)` | `U0100` · `U0102` |
| `expire_operation_tickets(max)` | `integer` | `U0100` · `U0102` |

Las seis: SECURITY DEFINER, `search_path = ''`, propiedad de
`uellix_cap_stella_ticket` (NOLOGIN, **cero miembros**, `NOBYPASSRLS`,
`NOINHERIT`), `REVOKE ALL … FROM PUBLIC` **antes** de `GRANT EXECUTE … TO
uellix_app`, sin SQL dinámico, sin `SELECT *`, sin interpolar argumentos en
mensajes de error.

**El aislamiento de privilegio que sostiene todo.** El rol de ticket **no tiene
INSERT, UPDATE, DELETE ni TRUNCATE sobre `stella_interactions`**. Su único
camino al ledger es *llamar* a `consume_stella_quota`. Que «la única forma de
cobrar es la función gobernada» sea un hecho sobre **privilegios** y no una
afirmación sobre un cuerpo de función es lo que hace que una edición futura no
pueda deshacerlo.

**Orden de locks, uno solo en todo el paquete:** fila del ticket
(`SELECT … FOR UPDATE`) → lock de advisory por organización. Nunca al revés. Y
la clave del advisory es **deliberadamente la misma** que usa `stella_0013`
(`hashtextextended('stella/quota/' || org, 0)`): la reserva y el cobro tienen
que excluirse mutuamente, y dos claves serían dos mutex distintos.

## 7. Qué le queda a INTEGRACIÓN

1. Implementar `canonicalQueryHash(query)` en Node según §5 y probar
   estabilidad, sensibilidad e irreversibilidad.
2. Cablear `app/actions/stella/grounded-query.ts`:
   `issue → bind → (ejecutar) → complete | abort`, retirando
   `QUOTA_LEDGER_NOT_CHARGED`.
3. Decidir la política del caso de §4 («el ledger refusa al completar»).
4. Aplicar `stella_0013` y después `stella_0014` en el stack local, con el
   `uellix_migrator` que exige `stella_0004`.

## 8. Riesgos residuales

| # | Riesgo | Estado |
|---|---|---|
| R1 | Una acción Stella hermana cobra entre `bind` y `complete` y el cobro se refusa sobre trabajo ya hecho | **declarado, no tapado**: el ticket queda `bound` y abortable; nunca se cobra de más. Decisión de producto pendiente |
| R2 | Las reservas vivas no se filtran por mes, así que una tomada a las 23:58 del último día cuenta en ambos | conservador por diseño: puede refusar una unidad justa, nunca vender de más. Ventana máxima 15 min |
| R3 | `expire_operation_tickets` no la llama nadie | por diseño: la garantía no depende de ella (§4). Sólo afecta a la legibilidad de la tabla para un operador |
| R4 | El rollback se **niega** si hay tickets completados | correcto y deliberado (§ README de `db/prepared`): desinstalar reintroduciría el doble cobro |
| R5 | El paquete no está aplicado a ninguna base | por diseño de este tren; ninguna bandera habilitada |

## 9. Evidencia

- [`scripts/stella-ticket-dry-run.sh`](../../../scripts/stella-ticket-dry-run.sh) —
  contenedor desechable, `--network none`, sin volumen, destruido al salir.
  15 secciones: reproducción del bloqueo, protocolo invocado, aislamiento,
  ataques de owner (incl. `session_replication_role = replica`), 6 pruebas de
  concurrencia con dos sesiones reales, negativa del rollback, retorno exacto al
  baseline y reaplicación idéntica.
- [`tests/helpers/stella-ticket-gates.ts`](../../../tests/helpers/stella-ticket-gates.ts) —
  contrato estático como función pura.
- [`tests/stella-ticket-persistence-mutation.test.ts`](../../../tests/stella-ticket-persistence-mutation.test.ts) —
  39 mutaciones, cada una con su gate propietaria; los gates no ejercitados
  están escritos por nombre.
