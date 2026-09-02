# STELLA — Contrato forward-only de la cadena hosted

> `HOSTED_CHAIN_CONTRACT = FORWARD_ONLY`
>
> Documento **normativo**. Formaliza operativamente lo que
> `db/hosted/fresh-observation.ts` ya impone en código desde
> `1d1a650`. Si algún documento histórico contradice a éste en materia
> operativa hosted, gana éste — véase §10.

Cierra el hallazgo adversarial **RT-03** (contradicción documental: los
documentos históricos prometían una segunda aplicación idempotente que el
modelo managed ya no garantiza).

---

## 1. Las cuatro operaciones, que no comparten nombre

«Reaplicar» dejó de ser una palabra utilizable. Nombra cuatro cosas distintas y
tres de ellas tienen respuestas opuestas.

| # | Operación | Estado en la DB | Autorizada |
|---|---|---|---|
| **A** | `RETRY_AFTER_ROLLBACK` — el paquete abortó y su transacción revirtió | `ABSENT` | **Sí**, con intento nuevo y observación nueva |
| **B** | `REAPPLY_INSTALLED_PACKAGE` — volver a ejecutar un paquete comprometido | `INSTALLED` | **No.** Prohibido en hosted managed |
| **C** | `REPLAY_CHAIN_ON_FRESH_TARGET` — base nueva, cadena entera | `ABSENT` (todos) | **Sí** |
| **D** | `FORWARD_REPAIR` — corregir algo ya instalado | `INSTALLED` | **Sí**, mediante un paquete **nuevo** |

**A no es B.** Un paquete que falló bajo `psql -1` no llegó a instalarse: su
reintento es semántica de primer run, no una reaplicación. Confundir las dos es
lo que hacía que «reintentar» sonara inocuo en el caso en que no lo es.

**D no es B.** Una reparación no reescribe el paquete instalado; añade uno
posterior. La cadena avanza, nunca se corrige hacia atrás.

## 2. Fuente de verdad

| Pregunta | Fuente autoritativa |
|---|---|
| ¿En qué estado está el paquete? | **Catálogo `pg_catalog` + journal**, medidos por los witnesses de `db/hosted/package-witnesses.ts` |
| ¿Qué se midió y cuándo? | Artefactos de evidencia — **rastro de auditoría** |

Dos equivalencias falsas, y ambas fueron el defecto:

- **evidencia ausente ≠ paquete ABSENT.** La evidencia dice qué observó alguien,
  no qué contiene la base.
- **exit code distinto de cero ≠ transacción revertida.** El cliente puede
  perder la respuesta de un `COMMIT` que el servidor ya ejecutó.

Ante **cualquier** resultado ambiguo: **observación read-only fresca primero.**
Esto coincide exactamente con `authorizeChainWrite`, que deriva el estado de los
witnesses y jamás lo lee del documento.

## 3. El único workflow autorizado

```
pnpm chain:attempt:open
   ↓ mina el intento y escribe la sonda que lo lleva compilado dentro
ejecutar la sonda PRE_WRITE, read-only, contra el objetivo
   ↓
ensamblar la observación alrededor de su salida
   ↓
pnpm chain:attempt:plan --observation=<fichero>
   ↓ el intento queda CONSUMED aquí — antes de que corra ningún psql
EXACTAMENTE UN paquete autorizado
   ↓
el operador ejecuta ese psql -1, UNA vez
   ↓
observación POST fresca
   ↓
clasificar el estado real
   ↓
escribir/reconstruir la evidencia (pnpm chain:status:write --after=<paquete>)
   ↓
intento siguiente
```

### Regla SHALL

> Tras un **timeout**, una **pérdida de conexión**, una **ambigüedad de ACK**,
> una **caída del proceso** o un **fallo al escribir la evidencia**, el operador
> **NO DEBE** reutilizar el comando `psql` anterior.
>
> **DEBE** abrir un intento nuevo y obtener una observación fresca antes de
> cualquier decisión.

No es una recomendación. Un `psql` repetido tras un ACK perdido es exactamente
el camino por el que un paquete comprometido se aplica dos veces.

## 4. Modelo de amenaza — lo que el gate sí y no hace

El gate impide que **el workflow autorizado** reutilice estado rancio. Ésa es su
tarea completa.

**No** pretende impedir que alguien con credenciales de la base ignore el sistema
y ejecute SQL a mano. Un operador con `psql` y la cadena de conexión puede
aplicar lo que quiera; ninguna comprobación del lado del planificador lo alcanza.

> `DIRECT_MANUAL_REEXECUTION_OUTSIDE_AUTHORIZED_PLAN = OPERATOR_PROCEDURE_VIOLATION`

El runbook debe hacer **difícil cometerlo por accidente**. No es una barrera
criptográfica frente a un administrador malicioso, y presentarla así sería
falsear lo que protege.

## 5. Ciclo de vida del intento — medido, no supuesto

Estados que el código realmente tiene (`attemptStatus`, `db/hosted/fresh-observation.ts`):

| Estado | Cuándo |
|---|---|
| `UNKNOWN` | el id no aparece como `OPENED` en el ledger |
| `OPEN` | es el **último** `OPENED` y no tiene `CONSUMED` |
| `CONSUMED` | tiene un registro `CONSUMED`, **o** un intento posterior fue abierto |

No hay más estados. `SUPERSEDED` y `ABANDONED` no existen como valores: ambos
casos colapsan en `CONSUMED`, porque para la autorización significan lo mismo —
este intento ya no puede autorizar nada.

### ¿En qué momento exacto una observación deja de ser reutilizable?

**Cuando `pnpm chain:attempt:plan` añade el registro `CONSUMED` al ledger**, es
decir en el momento de planificar, antes de que corra ningún `psql`.

Medido, con la precisión que el informe de Commit 1 no dio:

| llamada | ledger | resultado |
|---|---|---|
| 1ª y 2ª a `authorizeChainWrite` | sólo `OPENED` | **ambas autorizan** el mismo paquete |
| 3ª | tras `CONSUMED` | `CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN` |
| 4ª | intento posterior abierto | `CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN` |

La conclusión honesta, y el reparto exacto de la responsabilidad:

- el **gate puro** garantiza **un paquete por observación** — nunca nueve;
- el **ledger** garantiza **una planificación por observación**;
- juntos dan `EXACTLY_ONE_WRITE_PER_OBSERVATION` **dentro del workflow
  autorizado**.

`authorizeChainWrite` es una función pura y no puede auto-limitarse: no tiene
efectos. Un llamador que la invoque directamente y nunca registre `CONSUMED`
puede planificar dos veces — y eso es, por §4, una violación de procedimiento,
no un agujero del gate. `tests/hosted/forward-only-contract.test.ts` fija esta
frontera de forma ejecutable para que no vuelva a describirse de memoria.

## 6. Commit ambiguo — procedimiento por caso

Ninguno de estos estados se infiere del exit code. Todos exigen la sonda.

| Caso | Qué ocurrió | Observación fresca dice | Acción |
|---|---|---|---|
| **F12** | fallo antes del `COMMIT` | `ABSENT` | intento nuevo **puede** reintentar el paquete |
| **F13** | `COMMIT` en servidor, ACK perdido | `INSTALLED` | **no reaplicar**; reconstruir la evidencia POST; avanzar |
| **F14** | `COMMIT` correcto, falló escribir la evidencia | `INSTALLED` | idéntico a F13 |
| **F15** | `COMMIT` correcto, el proceso murió antes de la sonda | `INSTALLED` | idéntico a F13 |
| cualquiera | — | `PARTIAL_OR_INCONSISTENT` | **sin reintento, sin paquete siguiente**; recuperación humana |

`PARTIAL` no es «medio ABSENT». Aplicar encima y reintentar son ambos incorrectos,
así que el gate no autoriza ninguno de los dos (`CHAIN_OBSERVATION_PARTIAL_STATE`).

## 7. Reconstrucción de la evidencia

Cuando la base dice `INSTALLED` y falta la evidencia POST:

```
ejecutar db/prepared/checkpoint-a1/corroboration.sql read-only contra el objetivo
   ↓
guardar la observación ensamblada en el hueco del paso:
   artifacts/hosted-chain-t<N>-observation.json
   ↓ pnpm chain:status --after=<paquete>        valida prefijo, delta y unidad
   ↓ pnpm chain:status:write --after=<paquete>  deriva y escribe el veredicto
artifacts/hosted-chain-t<N>-status.json
```

`chain:status:write` **se niega** si el fichero de observación no está
(`… is absent, so there is nothing to derive a verdict from`): el veredicto se
deriva de una medición o no se escribe.

**Nunca** «volver a correr el paquete para regenerar la evidencia». Eso convierte
un problema de registro en una segunda escritura.

`scripts/chain-status.ts` ya deriva el veredicto de la observación y lo escribe
en el hueco del paso; no hace falta maquinaria nueva. La condición sigue siendo
la del registro: el delta debe ser exactamente un `ABSENT → INSTALLED` respecto
de la evidencia anterior.

> `EVIDENCE_RECONSTRUCTION_PATH = AVAILABLE`
>
> Con una salvedad medida: la ruta reutiliza la sonda de A1, que **no** lleva el
> intento compilado dentro. La reconstrucción es una operación de **auditoría**,
> no de autorización, y ninguna escritura depende de ella — por eso la ausencia
> del eco no la invalida. Si en el futuro la evidencia POST llegara a autorizar
> algo, necesitaría la misma ligadura que la PRE_WRITE.

## 8. Recuperación ante desastre

| Escenario | Procedimiento |
|---|---|
| **Objetivo nuevo** | bootstrap (rama IF) → baseline/prechain → cadena inmutable T1…T9 desde `ABSENT` |
| **Objetivo existente** | jamás reparar reproduciendo un paquete instalado |
| **Reparación** | paquete forward nuevo |
| **Restauración de snapshot** | **observar el estado real primero**; jamás deducir el estado del paquete de los ficheros de evidencia |
| **Clon/restauración con roles preexistentes** | **bloqueado** por la deuda del segundo paso del bootstrap (§9) hasta remediarla |

La restauración de un snapshot es el caso donde la equivalencia falsa de §2
resulta más tentadora: los artefactos de evidencia viajan con el repositorio y el
estado de la base no.

## 9. Bootstrap — alcance, no arreglo

`stella_hosted_0001` tiene un defecto conocido y reproducido en su rama `ELSE`
(las `ALTER ROLE` de las líneas 209-237 fallan con `permission denied` bajo un
installer managed).

| Escenario | Rama | ¿Funciona en managed? | Impacto |
|---|---|---|---|
| Cadena actual en staging | no se re-ejecuta | **sí** | ninguno |
| Primera provisión, objetivo fresco sin roles | `IF` | **sí** | ninguno |
| Primera provisión en producción | `IF` | **sí** | ninguno |
| Re-ejecución del bootstrap | `ELSE` | **no** | bloquea verificación por reaplicación |
| Reprovisión / clon con roles preexistentes | `ELSE` | **no** | bloquea DR por reprovisión |

> **No bloquea la cadena actual ni el retry futuro de T1.**
>
> `BOOTSTRAP_SECOND_PASS = DEFERRED_WITH_EXPLICIT_GATE`
>
> Cierre exigido **antes de declarar preparada la reprovisión de preprod y antes
> de producción**. No antes de T1.

## 10. Jerarquía documental

Cuando dos documentos discrepan en materia **operativa hosted**, gana el de
número menor:

1. **este contrato** y `STELLA_STAGING_PROVISIONING_REQUIREMENTS.md` — contrato
   operativo y runbook;
2. el modelo de autoridad hosted;
3. la verificación de los paquetes generados (`pnpm hosted:verify`, pins);
4. evidencia histórica de ensayo y auditoría.

Un documento histórico **no puede** contradecir operativamente al runbook actual.
Lo que sí conserva es su valor probatorio: midió algo, en un ciclo de vida
concreto, y ese registro no se reescribe.

## 11. El caso T1, hoy

```
T1_FIRST_ATTEMPT = FAILED_AND_ROLLED_BACK_CONFIRMED
```

El estado observado históricamente fue `T1 = ABSENT`. Es el caso **A** de §1.

Eso **no autoriza el retry hoy**. Una observación de agosto no viaja: antes de
cualquier reintento hacen falta intento nuevo, observación fresca y `T1`
medido `ABSENT` **en esa observación**.

```
T1_RETRY_AUTHORIZED = false
```
