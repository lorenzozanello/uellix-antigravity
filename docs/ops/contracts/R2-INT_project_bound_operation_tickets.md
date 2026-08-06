# R2-INT — Tickets de operación ligados al proyecto de ejecución

| Campo | Valor |
|---|---|
| **Solicitante** | INTEGRACIÓN (residual abierto al cerrar INT-INT-001) |
| **Propietaria del contrato** | INTEGRACIÓN |
| **Responde** | CAPABILITIES (tren 4.2) |
| **Fecha** | 2026-08-05 |
| **Paquete** | [`db/prepared/stella_0015_project_bound_operation_tickets.sql`](../../../db/prepared/stella_0015_project_bound_operation_tickets.sql) · rollback [`stella_0015_rollback.sql`](../../../db/prepared/stella_0015_rollback.sql) |
| **Estado** | **DISEÑO — no aplicado a ninguna base.** Ningún server action pasa todavía el argumento nuevo. Cablearlo es la reconciliación de INTEGRACIÓN |

> Este documento **no** modifica `CONTRACT_LEDGER.md`. La fila de R2-INT sigue
> como INTEGRACIÓN la dejó hasta que INTEGRACIÓN acepte.

---

## 1. Qué reporta R2-INT, y por qué `stella_0014` no podía contestarlo

Un ticket queda soldado a una organización, un proyecto y un actor al emitirse.
Tres de esas cuatro ataduras se **reimponen en cada llamada posterior**: el
actor por `auth.uid()` y las policies, la organización por
`current_user_org_ids()`. El **proyecto no** — porque `bind_operation_ticket` y
`complete_operation_ticket` no reciben ninguno.

La base, por tanto, no tiene con qué comparar. `complete` cobra
`consume_stella_quota(v_org, v_project, …)` con el proyecto del **TICKET**,
mientras el trabajo leyó su evidencia bajo el proyecto de la **ACCIÓN**.

**Reproducido, no argumentado.** El §5b de
[`scripts/stella-ticket-dry-run.sh`](../../../scripts/stella-ticket-dry-run.sh)
ejecuta el ataque contra las funciones reales, con `stella_0014` instalado y
`stella_0015` todavía no:

| Medido | Valor |
|---|---|
| `bind` bajo el proyecto A2 con un ticket de A1 | `bound` |
| `complete` bajo el proyecto A2 | `completed` |
| `project_id` de la fila cobrada = proyecto del **ticket** (A1) | `true` |
| `project_id` de la fila cobrada = proyecto del **trabajo** (A2) | `false` |
| `inspect` de un ticket de A1 desde la superficie de A2 | `completed` |
| funciones de bind/complete/abort/inspect con argumento de proyecto | **0** |

Una unidad, la organización correcta, el proyecto **equivocado**.

**Alcance.** No es un escape de cuota: el tope es organizacional y se cobra
exactamente una unidad. Es un defecto de **atribución y auditoría**, alcanzable
por cualquier miembro autenticado de la organización — cada export de un módulo
`'use server'` es un endpoint invocable por separado, así que el ticket acuñado
en la superficie de un proyecto puede presentarse a la acción montada sobre
otro. En un producto cuya salida entera es una cifra SROI auditable, una unidad
mal atribuida es peor que una no cobrada.

**Por qué hacía falta un paquete nuevo.** Añadir un argumento **cambia la
firma**, y `CREATE OR REPLACE FUNCTION` lo prohíbe (`42P13`). Editar
`stella_0014` en sitio no habría sido una edición: habría sido un paquete que
falla en toda base que ya tenga la forma antigua — que es justamente la
población que importa.

## 2. La firma, y qué verbo comprueba qué

```
issue_operation_ticket   (org, project, category)                        -- sin cambios
bind_operation_ticket    (ticket, expected_project, query_hash)           -- NUEVA
complete_operation_ticket(ticket, expected_project, query_hash)           -- NUEVA
abort_operation_ticket   (ticket, expected_project, reason)               -- NUEVA
inspect_operation_ticket (ticket, expected_project)                       -- NUEVA
expire_operation_tickets (max)                                            -- sin cambios
```

La invariante que impone el paquete:

```
ticket.project_id
  = expected_project_id recibido desde una superficie gobernada
  = proyecto al que se atribuye el cargo
```

**`issue` no cambia** porque es donde el vínculo se **crea**: ya recibe el
proyecto explícitamente y ya prueba que pertenece a la organización.

**`expire` tampoco**, y es una decisión y no un olvido: no nombra ningún ticket,
no revela el estado de ninguno, no libera ninguna reserva viva (su predicado es
`expires_at <= now()`, y un ticket vencido ya dejó de reservar) y no cobra. Un
argumento ahí sería un parámetro sin decisión detrás.

**`complete` revalida por su cuenta, y no hereda de `bind`.** Los dos corren en
transacciones **distintas** — el protocolo lo exige (INT-INT-001 §4 paso 3: la
reserva es un estado de fila, no un lock sostenido). «Bind ya lo comprobó» es
una afirmación sobre un request que ya terminó, y es el **cobro**, no la
reserva, el que aterriza en un ledger append-only bajo un `project_id` que
nunca podrá corregirse.

**`abort` lo comprueba** para que la superficie de un proyecto no pueda soltar
la reserva que sostiene la operación de otro. No se cobra en ninguno de los dos
casos, así que no es un defecto de facturación: es una denegación de servicio
con nombre gobernado — el `complete` de la víctima encuentra después un ticket
abortado y descarta trabajo ya ejecutado.

**`inspect` lo comprueba** para no divulgar el ciclo de vida de un ticket
soldado a otro proyecto. No cobra y no escribe, que es exactamente por lo que
sobrevive a una revisión — pero es la mitad de reconocimiento de todos los
ataques que los otros tres rechazan.

### El orden de las comprobaciones

El proyecto se juzga **en cuanto la fila aparece**: después de `NOT FOUND`, y
antes de la vigencia, del digest y del estado.

- Después de `NOT FOUND`, para que «no existe» y «no es tuyo» sigan siendo la
  misma frase. Si el proyecto se comprobara antes, un llamante podría enumerar
  qué identificadores de 256 bits corresponden a tickets reales.
- Antes de la vigencia y del estado, para que un ticket de otro proyecto no sea
  distinguible como expirado, atado o liquidado — un ciclo de vida que ese
  llamante no puede leer.

En `complete`, además, **antes del cortocircuito de `replayed`**: contestar «esto
ya pasó y ya se cobró» a la superficie de otro proyecto es informarle de una
operación que no es suya.

## 3. El error contractual — `U0110`

```
U0100  entrada malformada, incluido un proyecto de ejecución ausente
U0102  fuera de scope: otra organización, otro actor, o ticket inexistente
U0106  categoría o razón de aborto fuera del vocabulario gobernado
U0107  el ticket está atado a OTRA consulta
U0108  el ticket ya no está vigente
U0109  el ticket ya está liquidado
U0110  el ticket pertenece a OTRO PROYECTO          <-- stella_0015
```

Seis causas, seis respuestas distintas. Plegar la sexta en la segunda dejaría a
la integración con la misma respuesta para un ataque, un cableado mal montado,
un ticket caducado y un inquilino ajeno — el rechazo seguiría ocurriendo, sólo
dejaría de ser accionable.

**Por qué un código distinguible no es un oráculo aquí.** `U0110` sólo se
levanta **después** de que la fila se encontró bajo RLS, y la policy de SELECT
exige `actor_id = auth.uid()`. El único que puede llegar a observar `U0110` es
el propio actor del ticket, sobre el proyecto de su propio ticket. Para
cualquier otro la misma llamada es `U0102`, indistinguible de un ticket que
nunca existió. Es el mismo argumento que `stella_0014` hace para comprobar la
vigencia sólo después del scope.

**Un proyecto ausente es `U0100`, no `U0110`.** Un argumento que falta no es un
argumento que no coincide, y el llamante actúa distinto en cada caso.

Ningún mensaje interpola un identificador. Un rechazo que devolviera el proyecto
que el llamante envió confirmaría cuál de sus conjeturas alcanzó una fila.

**En el borde de producto se colapsa, a propósito.**
`db/stella/operation-tickets.ts` mapea `U0110` a `out_of_scope`, que es la misma
frase `UNAUTHORIZED` que recibe cualquier otro fallo de scope. La distinción
sobrevive donde sirve —el SQLSTATE queda en el log de la base, y `stella_0015`
no lo levanta para nada más— y desaparece donde sería un oráculo.

## 4. Cómo se retira la firma antigua

En una sola transacción, y en este orden:

1. **REVOKE** `EXECUTE` de las cuatro firmas antiguas, a `PUBLIC` y a
   `uellix_app`. Se enuncia aparte aunque el `DROP` se llevaría la ACL: si el
   `DROP` fallara, se reordenara o se hiciera condicional, lo que queda es la
   concesión.
2. **CREATE** las cuatro firmas project-bound, `ALTER … OWNER`, `REVOKE ALL …
   FROM PUBLIC`, `GRANT EXECUTE … TO uellix_app`.
3. **DROP** las cuatro firmas antiguas, incondicionalmente.

No se conserva ningún overload. Mantener la llamada de dos argumentos «por
compatibilidad» dejaría el camino de R2-INT alcanzable **al lado de su propio
arreglo**, con una segunda puerta que se lee como deliberada.

El paquete lo **mide** en su propia verificación: las cuatro firmas antiguas
ausentes, ninguna otra sobrecarga de esos cuatro nombres, ningún `DEFAULT` en el
argumento nuevo (un argumento con default es un argumento que el llamante puede
omitir), los cuatro cuerpos comparando de verdad y levantando `U0110`, y
exactamente **seis** funciones en `uellix_stella_ops`.

## 5. La estrategia de rollback — se niega a restaurar

`stella_0015_rollback.sql` revoca y retira las cuatro firmas nuevas, y **no
recrea las antiguas**. La negativa es la estrategia, no una omisión:

> R2-INT no es un cuerpo que una versión nueva arregló. Es la **ausencia de un
> argumento**. «Restaurar la versión anterior» y «republicar la vulnerabilidad»
> son la misma frase.

En una base que sólo **instaló** el paquete las dos serían además
indistinguibles de inofensivas — pero el script no puede saber en cuál corre, y
la que importa es la que tiene tickets y cargos reales.

**Cómo queda la base.** `issue` y `expire` siguen siendo llamables y ninguna de
las dos cobra: se puede acuñar un ticket y abandonarlo, y no se puede reservar,
liquidar, abortar ni inspeccionar nada. Es una superficie **cerrada**, no una
degradada — el estado honesto para «deshacer el arreglo sin reabrir el hueco».
Cualquier ticket que quedara en `bound` suelta su reserva por sí solo en
`expires_at`, acotado a quince minutos por el CHECK de `stella_0014`.

Una postcondición lo convierte en aserción de máquina: si una edición futura
«restaura» alguna de las firmas sin proyecto, el rollback **aborta**.

**El orden inverso lo impone el SQL, no un runbook.** Las cuatro funciones
nuevas son propiedad de `uellix_cap_stella_ticket`, así que el `DROP ROLE` del
rollback de `stella_0014` falla mientras existan: su transacción entera aborta y
no se destruye nada. Medido en el §14 del arnés.

## 6. Qué le queda a INTEGRACIÓN

1. Pasar el `projectId` resuelto en servidor —el mismo argumento enlazado que
   `issueOperationTicket` ya recibe— a `bindOperationTicket`,
   `completeOperationTicket` y `abortOperationTicket` en
   `app/actions/stella/grounded-query.ts`.
2. Aplicar `stella_0013` → `stella_0014` → `stella_0015` en el stack local, en
   ese orden, con el `uellix_migrator` que exige `stella_0004`.
3. Reevaluar el criterio «ticket cross-project: rechazo, cero cargo» del E2E, y
   con él `local-runtime-ready`.

**Mientras tanto la ruta gobernada falla CERRADA.** El adaptador
(`db/stella/operation-tickets.ts`) declara el parámetro como opcional en
TypeScript y lo exige de hecho: una llamada que lo omite se rechaza en Node
antes de llegar a la base. El parámetro no se hizo obligatorio en el tipo porque
eso sería un error de compilación en un módulo que este tren no posee, y
ponerle por defecto el proyecto del ticket sería el defecto mismo escrito como
comodidad.

## 7. Riesgos residuales

| # | Riesgo | Estado |
|---|---|---|
| R2a | Reaplicar `stella_0014` **solo**, después de `stella_0015`, republica las cuatro firmas sin proyecto | Abierto, y es la misma clase de precondición de orden que `stella_0014` ya tiene con `stella_0013`. La cadena completa aplicada en orden converge — medido en los dos pases del §5c. No es reparable desde `stella_0015`: ningún paquete puede impedir que otro se ejecute después |
| R2b | `expire_operation_tickets` sigue sin recibir proyecto | Deliberado (§2). Barre los tickets vencidos del propio llamante, no libera ninguna reserva viva y no cobra |
| R3-INT | Un reintento post-cobro que llega >15 min tarde recibe `U0108` en vez de la divulgación explícita | **Sin tocar.** Es un reordenamiento dentro de `bind` que este paquete no hace, para no mezclar dos cambios en una firma nueva |
| R2c | `db/prepared/README.md` no menciona `stella_0015` ni el orden de rollback de tres eslabones | Abierto. Fuera del alcance documental de este tren (FASE 11 limita las ediciones a `CAPABILITIES.md`). El orden está impuesto por el SQL, así que la omisión confunde pero no puede producir un resultado equivocado |

## 8. Evidencia

- [`scripts/stella-ticket-dry-run.sh`](../../../scripts/stella-ticket-dry-run.sh) —
  contenedor desechable, `--network none`, sin volumen, destruido al salir. 16
  secciones en **dos etapas**: reproducción de R2-INT sobre `stella_0014` solo,
  cierre sobre la cadena completa, 20 aserciones cross-proyecto, siete pruebas
  de concurrencia con dos sesiones reales, negativa del rollback, orden inverso
  impuesto, retorno exacto al baseline y reaplicación idéntica.
- [`tests/helpers/stella-project-ticket-gates.ts`](../../../tests/helpers/stella-project-ticket-gates.ts) —
  contrato estático como función pura.
- [`tests/stella-project-ticket-mutation.test.ts`](../../../tests/stella-project-ticket-mutation.test.ts) —
  14 mutaciones (K-40…K-53), cada una rechazada por su gate propietaria; los
  gates sin ejercitar están escritos por nombre.
