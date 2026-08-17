# G1_B_GOVERNED_PREVIEW_RUNBOOK

> **Estado:** DISEÑO — NO EJECUTADO. Ninguna sección de este documento se ha
> corrido. Cero llamadas a Gemini, cero escrituras a staging.
>
> **Baseline:** `aaaa02ad225724dc7ee77505090db013f71b7b3b` + el delta local de
> G1-B PRECONDITIONS + el delta de FABLE FINDINGS FIX.
>
> **Objetivo:** certificar el path gobernado completo de Stella en Preview con
> un presupuesto de **exactamente 1 llamada a Gemini**.
>
> **Materializa:** los `FIX_BEFORE_LIVE` de la auditoría independiente de Fable.

---

## 0. Identidades y qué puede hacer cada una

Este runbook usa **tres** identidades y ninguna de ellas escribe.

| Identidad | Para qué | Restricción |
|---|---|---|
| Sesión de usuario en Preview | los health endpoints y las llamadas de producto | ninguna especial |
| `UELLIX_AUDITOR_DATABASE_URL` | lecturas sobre `public.*` (`stella_interactions`, `audit_logs`) | SELECT y nada más (`stella_hosted_0007` §3) |
| Identidad administrativa de lectura (`uellix_migrator` → `SET ROLE uellix_owner`) | lecturas sobre `uellix_stella_ops.operation_tickets` | **obligatorio** `SET default_transaction_read_only = on` |

**Por qué hace falta la tercera:** `stella_0014` §(8) **afirma como postcondición**
que ningún principal de runtime — `uellix_app`, `uellix_auditor`, `uellix_writer`,
`authenticated`, `anon`, `service_role` — tiene privilegio directo sobre
`operation_tickets`. El `charge_nonce` vive ahí. La lectura del contador de
tickets es por tanto una operación **administrativa**, y sus credenciales
**no deben existir en el runtime de Preview** (ver R1.8).

---

## 1. R1 — PRECONDICIONES (antes de cualquier llamada a Gemini)

Cada ítem es un **gate**: si falla, se aborta con coste cero. No hay ítems
"informativos".

### R1.1 — HEAD local == `origin/codex/stella-staging`

```bash
git fetch origin codex/stella-staging && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/codex/stella-staging)" && echo "R1.1 PASS" || echo "R1.1 FAIL"
```

### R1.2 — árbol trackeado limpio

```bash
test -z "$(git status --porcelain --untracked-files=no)" && echo "R1.2 PASS" || { echo "R1.2 FAIL"; git status --porcelain --untracked-files=no; }
```

Deliberadamente `--untracked-files=no`: `artifacts/` acumula evidencia sin
trackear y no es parte del árbol certificado.

### R1.3 — `/api/health/stella-preconditions` → 200

Requiere una sesión verificada (misma frontera que `runtime-identity`). Con la
cookie de sesión exportada en `$PREVIEW_COOKIE` y la URL del deploy en
`$PREVIEW_URL`:

```bash
curl -sS -o /tmp/g1b-pre.json -w '%{http_code}\n' -H "Cookie: $PREVIEW_COOKIE" "$PREVIEW_URL/api/health/stella-preconditions"
```

Debe imprimir `200`. Verificar el cuerpo:

```bash
jq '{ready, environment, master, model, rateLimit, advisor: .capabilities.advisor}' /tmp/g1b-pre.json
```

Esperado — **todos** deben cumplirse:

| Campo | Valor exigido |
|---|---|
| `ready` | `true` |
| `environment` | `"staging"` |
| `master.stellaEnabled` | `true` |
| `master.geminiApiKeyPresent` | `true` |
| `master.canUseStella` | `true` |
| `capabilities.advisor` | `null` |
| `model.matchesRepositoryTarget` | `true` |
| `model.requestTimeoutMs` | `15000` |
| `rateLimit.backend` | `"distributed"` |
| `rateLimit.distributedRequired` | `true` |
| `rateLimit.satisfied` | `true` |
| `rateLimit.presentVariables` | `["KV_REST_API_URL","KV_REST_API_TOKEN"]` |

Y **todas** las demás capabilities deben ser `"capability_disabled"`:

```bash
jq '.capabilities | to_entries | map(select(.key != "advisor")) | map(select(.value != "capability_disabled"))' /tmp/g1b-pre.json
```

Debe devolver `[]`.

### R1.4 — `/api/health/runtime-identity` → 200 y la identidad exacta

```bash
curl -sS -o /tmp/g1b-id.json -w '%{http_code}\n' -H "Cookie: $PREVIEW_COOKIE" "$PREVIEW_URL/api/health/runtime-identity"
jq '{sessionUser, currentUser, isSuperuser, bypassesRls, canCreateRole, canSetOwnerRole, canCreateInPublic, projectRefProven, verified}' /tmp/g1b-id.json
```

Exigido:

```
sessionUser        = "uellix_app"
currentUser        = "uellix_app"
isSuperuser        = false
bypassesRls        = false
canCreateRole      = false
canSetOwnerRole    = false
canCreateInPublic  = false
projectRefProven   = true
```

Cualquier `true` en las cinco negativas, o `projectRefProven=false`, **aborta
G1-B**. Un 503 aquí significa que el deployment no está sano, no que el probe
falló.

### R1.5 — evidencia de apply-time de `stella_hosted_0008` y `stella_0020`

Ambos paquetes **afirman su propia postcondición** al aplicarse y abortan la
transacción si no se cumple. La evidencia primaria es la salida del apply
(guardarla en `artifacts/`), donde deben aparecer:

```
NOTICE:  stella_hosted_0008: audit_logs_insert_member_or_admin INSERT TO uellix_app. OK.
NOTICE:  stella_0020: public.stella_interactions.model_used = NOT NULL, no default. OK.
```

Corroboración independiente, **sólo lectura**, con la identidad administrativa:

```sql
-- La policy existe, es de INSERT, y es la ÚNICA de escritura sobre la tabla.
SELECT policyname, cmd, roles::text
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'audit_logs'
ORDER BY policyname;
-- Esperado: exactamente dos filas —
--   audit_logs_insert_member_or_admin | INSERT | {uellix_app}
--   audit_logs_select_member_or_admin | SELECT | {public}

-- La columna no tiene default y sigue NOT NULL.
SELECT a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = 'public.stella_interactions'::regclass
  AND a.attname = 'model_used' AND NOT a.attisdropped;
-- Esperado: not_null = t, default_expr = NULL
```

**Si `stella_hosted_0008` no está aplicado, G1-B no puede arrancar:** la
aserción R3.B (la fila de auditoría) sería imposible de cumplir.

### R1.6 — el deploy Preview es el de `codex/stella-staging`

El commit y la rama del deployment deben coincidir con R1.1. Verificar en el
deployment de Vercel (`Git Branch` + `Commit`) **antes** de las llamadas.

> **Trampa conocida (memoria del proyecto):** el CLI de Vercel necesita metadata
> Git explícita para seleccionar variables branch-scoped. Y `NEXT_PUBLIC_*` se
> **inlinea en build**: cualquier cambio de esas variables exige **redeploy**,
> no basta con guardarlas.

### R1.7 — `STELLA_LEGACY_ADVISOR_ENABLED` ausente / `false`

No hay campo dedicado en el health payload (es la ausencia lo que se verifica).
El proxy observable es `capabilities.advisor === null` **junto con** la
comprobación directa de la variable en la configuración del proyecto Vercel para
el entorno Preview / rama `codex/stella-staging`.

Regla: **la variable no debe existir.** Si existe, su único valor aceptable es
`false`. Cualquier otro valor aborta G1-B.

### R1.8 — credenciales de migrator / auditor ausentes del runtime Preview

En la configuración de entorno del deployment Preview **no deben existir**:

```
UELLIX_MIGRATOR_DATABASE_URL
UELLIX_AUDITOR_DATABASE_URL
UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION
UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ
UELLIX_DB_ALLOW_CONTROLLED_REMOTE_WRITE
```

Corroboración desde dentro del proceso: R1.4 ya prueba que la conexión efectiva
es `uellix_app` sin `BYPASSRLS` — pero eso demuestra qué DSN se **usa**, no qué
DSN está **presente**. La verificación de presencia es en el dashboard, y es
manual a propósito: no existe (ni debe existir) un endpoint que enumere el
entorno.

### R1.9 — `GEMINI_MODEL` ausente o `gemini-3.6-flash`

```bash
jq '.model | {requested, repositoryTarget, matchesRepositoryTarget}' /tmp/g1b-pre.json
```

`matchesRepositoryTarget` debe ser `true`. Si es `false`, el deployment llamaría
a un modelo distinto del certificado en G1-A y **G1-B se aborta**.

### R1.10 — `KV_REST_API_URL` + `KV_REST_API_TOKEN` atestados

```bash
jq '.rateLimit.presentVariables' /tmp/g1b-pre.json
```

Debe ser exactamente `["KV_REST_API_URL","KV_REST_API_TOKEN"]`.

> ### ⚠️ LÍMITE EXACTO DE ESTA ATESTACIÓN
>
> `stellaRateLimitAttestation()` demuestra **PRESENCIA DE CONFIGURACIÓN**.
> **NO** demuestra que Upstash esté accesible, que el token sea válido, ni que
> el limiter sea «healthy» o «usable». No hace ninguna llamada de red.
>
> Un par URL/token **presente pero inválido** produce `satisfied: true` aquí y
> falla en el **primer uso real**.
>
> **Eso no es un agujero de seguridad.** Es una limitación de la atestación de
> readiness. Cuando el backend está configurado pero es inutilizable, el
> `catch` de `consumeStellaRateLimit` devuelve `reason: 'unavailable'`, y como
> el rate limit se consume en **emisión** — antes de `bind`, antes de reservar
> cuota y antes del proveedor — la ruta gobernada **falla cerrado**: sin ticket,
> sin unidad, sin llamada a Gemini. La diferencia entre «no configurado» y
> «configurado pero inservible» cambia el **diagnóstico del operador**, nunca lo
> que el llamador tiene permitido hacer.
>
> El caso N9 de R2 ejercita precisamente esa ruta.

---

## 2. Evidencia de llamadas al proveedor — qué se puede y qué no se puede probar

> **CORRECCIÓN (revisión de evidencia, posterior a la auditoría de Fable).**
> Una versión anterior de esta sección afirmaba:
>
> > ~~«nº de llamadas a Gemini ≤ Δ(tickets con `bound_at IS NOT NULL`)»~~
>
> **Esa inferencia es FALSA, y la refuta PB-01 de este mismo repositorio.** Un
> ticket ya `bound` admite entregas concurrentes, y cada una puede alcanzar al
> proveedor antes de que un `complete` gane la carrera:
>
> ```
> 1 ticket → 1 bind → N ejecuciones concurrentes → N llamadas Gemini → 1 settlement
> ```
>
> `bind` es condición **necesaria** para ejecutar contra el proveedor; **no hay
> relación 1:1**. `Δ(bound) = 1` no demuestra `providerCalls = 1`, y
> `bound_at` no es un contador de llamadas ni una cota superior de ellas.
>
> La sección se reescribe entera: lo que sigue distingue una propiedad que **sí**
> es válida (para los negativos) de una que **no tenemos hoy** (el conteo exacto
> del happy path).

### 2.1 Lo que `bound_at` SÍ permite afirmar

`uellix_stella_ops.operation_tickets.bound_at` es **monótono**: se fija en
`bind` y no se limpia nunca. Y en `runGovernedStellaOperation` la llamada a
`input.execute()` — la única ruta al proveedor — ocurre **estrictamente después**
de un `bind` con resultado `bound`.

De ahí se sigue **una sola** implicación, y va en la dirección negativa:

> **Si un ticket nunca alcanzó `bound_at`, ninguna ejecución suya alcanzó al
> proveedor.**

La contraria no se sigue: de `bound_at` fijado no se deduce cuántas ejecuciones
corrieron. Ésa es exactamente la asimetría que PB-01 describe.

**Consecuencia práctica:** `bound_at` sirve para probar **CERO** llamadas en un
camino que debe rechazar antes de `bind`. **No** sirve para contar llamadas, ni
para probar «exactamente una». Cualquier uso de esta observación fuera de esa
frontera es incorrecto.

### 2.2 Snapshot (identidad administrativa, sólo lectura)

```sql
SET default_transaction_read_only = on;
SELECT
  count(*) FILTER (WHERE bound_at     IS NOT NULL) AS ever_bound,
  count(*) FILTER (WHERE completed_at IS NOT NULL) AS ever_completed,
  count(*)                                          AS total_tickets,
  max(issued_at)                                    AS last_issued_at
FROM uellix_stella_ops.operation_tickets;
```

Guardar como `artifacts/g1b/tickets-PRE.json`, `-MID.json`, `-POST.json`.

### 2.3 Lo que estas cuentas NO son

`public.stella_interactions`, el ledger de cuota, `public.audit_logs` y
`completed_at` cuentan **LIQUIDACIONES**, una por ticket. Bajo PB-01 las cuatro
pueden marcar **1** mientras el proveedor recibió **N**. Son evidencia de que la
contabilidad de Uellix es correcta; **no** son evidencia de cuántas veces se
llamó a Gemini, y en este runbook no se usan para eso en ningún punto.

### 2.4 Precondición de AISLAMIENTO DE LA CORRIDA

Todo el razonamiento de §2.1 vale sólo si la corrida es la única actividad sobre
el objetivo. Antes del snapshot PRE hay que establecer y registrar:

1. **Ningún otro usuario** con sesión activa sobre las organizaciones de prueba
   durante toda la ventana.
2. **Ninguna otra pestaña, panel o cliente** del propio operador emitiendo
   tickets — el panel emite en `start` y **no** en `retry`, así que el vector es
   abrir la página dos veces, no reintentar.
3. La ventana temporal se acota con `issued_at`, de modo que un ticket ajeno
   quede identificable en vez de confundirse con los de la corrida:

```sql
SELECT ticket_id, category, status, issued_at, bound_at, completed_at, abort_reason
FROM uellix_stella_ops.operation_tickets
WHERE issued_at >= :t_pre
ORDER BY issued_at;
```

Si aparece **cualquier** ticket que la corrida no emitió, el bloque de evidencia
queda invalidado y se repite. Esta precondición no es una formalidad: sin ella,
`Δ = 0` podría significar «nadie ejecutó» o «alguien más ejecutó y ya cerró».

## 3. R2 — BLOQUE NEGATIVO (presupuesto: **0 llamadas a Gemini**)

Ejecutar entre el snapshot PRE y el POST de §2.

### 3.1 Orden, y la única dependencia real

N6 (ticket replayed) sólo tiene contenido contra un ticket **ya liquidado**, y
el único que existirá es el de R3. Por tanto el bloque negativo se parte en dos:

```
  §2.4  aislamiento de la corrida establecido y registrado
  snapshot PRE                  (t_pre)
  N1 N2 N3 N4 N5 N8             (Preview certificado)
  snapshot MID   ->  ZERO-CALL NEGATIVE-PATH EVIDENCE: 0 tickets nuevos bound
  R3             ->  la única llamada
  snapshot R3'                  (bound_at / completed_at del ticket de R3)
  N6                            (Preview certificado, reusando el ticket de R3)
  snapshot POST  ->  la fila de R3 INALTERADA respecto de R3'
  eventos de runtime en la ventana de R3 -> started=1 completed=1 failed=0
  N7 N9                         (deployment de descarte, contabilidad aparte)
```

**El snapshot POST no afirma `Δever_bound == +1` como prueba de nada sobre el
proveedor.** Bajo PB-01 un solo `bound` es compatible con N invocaciones; lo que
POST prueba es que **N6 no movió nada**. La evidencia de exactly-one son los
eventos `stella.provider_call.*`, y ninguna otra — ver §4.0.

Fabricar un ticket liquidado de otra forma costaría una segunda llamada al
proveedor, que es exactamente lo que el presupuesto prohíbe.

| # | Caso | Cómo se provoca | Resultado exigido | ¿`bind`? |
|---|---|---|---|---|
| N1 | anónimo | invocar la acción sin cookie de sesión | `UNAUTHORIZED` | **no** |
| N2 | rol no autorizado | usuario con membresía `viewer` en la org | `UNAUTHORIZED` | **no** |
| N3 | proyecto cross-tenant | usuario de org A pidiendo ticket para un proyecto de org B | `UNAUTHORIZED` | **no** |
| N4 | ticket forjado / inválido | ticket = 64 caracteres hex arbitrarios | `UNAUTHORIZED` («Esta operación ya no es válida») | **no** |
| N5 | ticket expirado | emitir y esperar > TTL (máx. 15 min, `CHECK` de `stella_0014`) | `UNAUTHORIZED` | **no** |
| N6 | ticket replayed | reusar el ticket que ya liquidó R3 — **se ejecuta DESPUÉS de R3**, ver §3.1 | `ALREADY_COMPLETED_RESULT_UNAVAILABLE` | **no** |
| N7 | ticket de otra categoría | **deployment de descarte** — ver abajo | `UNAUTHORIZED` (`category_mismatch`) | **SÍ** |
| N8 | cuota agotada | org con `quota` ya consumida | `QUOTA_EXCEEDED` | **no** |
| N9 | rate limit inutilizable | **deployment de descarte** — ver abajo | `RATE_LIMIT_UNAVAILABLE` | **no** |

### Dos casos NO se ejecutan contra el Preview certificado

**N7 y N9 exigen degradar la configuración que R1 acaba de fijar**, así que
correrlos en el Preview certificado invalidaría sus propias precondiciones:

- **N7** necesita un ticket de **otra** categoría, y la única forma de emitir
  uno es habilitar una segunda capability (`STELLA_VALIDATOR_ENABLED=true` para
  `issueStellaValidatorTicket`). R1.3 exige que **todas** las demás capabilities
  estén en `capability_disabled`.
- **N9** necesita `KV_REST_API_TOKEN` inválido. R1.10 exige que sea válido.

Ambos se ejecutan contra un **deployment de descarte de la misma rama**, con la
degradación concreta que cada uno necesita y nada más. Nunca contra el
deployment que corre R3.

### ZERO-CALL NEGATIVE-PATH EVIDENCE

Éste es el **único** nombre bajo el que se cita la observación de §2.1, y su
alcance es literal: prueba que **estos** caminos **no alcanzaron** al proveedor.
No es un contador y no dice nada del happy path.

**GATE DEFINITIVO — los eventos de runtime:**

```
PRE:   capturar el cursor/timestamp de logs del deployment  (T_PRE)
       ejecutar los negativos
POST:  consultar los runtime logs de ESE deployment en [T_PRE, T_POST]

PASS:  stella.provider_call.started == 0
```

Eso es la prueba. No se infiere de tickets, ni de interactions, ni del ledger.

**Evidencia complementaria — `bound_at`:** sigue registrándose porque prueba algo
DISTINTO y útil: que el camino rechazó **antes de `bind`**, es decir *dónde* se
detuvo, no sólo que no llamó al proveedor. Las dos mitades siguen siendo:

1. **Traza estática**: cada uno de estos caminos rechaza antes de `bind`, y
   `execute` está estrictamente después de un `bind` con resultado `bound`.
2. **Observación en la corrida**: `Δ(tickets nuevos con bound_at) == 0`, bajo la
   precondición de aislamiento de la sección 2.4.

Si el gate de eventos dice `started == 0` pero `bound_at` se movió, el negativo
llegó más lejos de lo esperado sin alcanzar al proveedor: no invalida el
presupuesto, pero sí la traza estática, y hay que entenderlo antes de seguir.

#### N1–N5 y N8 — Preview certificado

```
Δ(tickets con issued_at >= t_pre y bound_at IS NOT NULL) == 0
Δ(tickets con issued_at >= t_pre y completed_at IS NOT NULL) == 0
```

Nótese `issued_at >= t_pre`: se cuentan **tickets nuevos**, no el total
histórico, para que la aserción sea insensible a filas antiguas.

Punto de rechazo de cada uno, para que la traza estática sea auditable:

| Caso | Rechaza en | Emite ticket |
|---|---|---|
| N1 anónimo | `requireOrganizationAccess`, paso 1 de emisión | no |
| N2 rol no autorizado | `canUseStella(role)`, paso 4 de emisión | no |
| N3 cross-tenant | `issue_operation_ticket` en SQL | no |
| N4 ticket forjado | `bind` → `malformed`/`out_of_scope` | ticket ajeno; ninguno nuevo |
| N5 ticket expirado | `bind` → `expired` | sí, pero nunca alcanza `bound` |
| N8 cuota agotada | `bind` → `quota_exceeded` / `no_quota` | sí, queda en `issued` |

#### N6 — replay: NO se usa este método

N6 presenta un ticket **ya `bound` y `completed`** (el de R3), así que la
aserción «ningún ticket nuevo alcanzó `bound`» no dice nada sobre él. Su prueba
es **el estado concreto de esa fila, sin cambios**:

```sql
SELECT ticket_id, status, bound_at, completed_at, aborted_at, abort_reason
FROM uellix_stella_ops.operation_tickets
WHERE ticket_id = '<el ticket de R3>';
```

Exigido: `status='completed'`, y `bound_at` / `completed_at` **idénticos** a los
capturados justo después de R3 (comparación byte a byte del snapshot). Traza
estática: `bind` devuelve `already_completed` y `runGovernedStellaOperation`
**retorna ahí**, antes de `execute`. La fila inalterada es la evidencia; un
`completed_at` movido significaría que algo volvió a correr.

#### N7 — categoría equivocada: tampoco este método

N7 (deployment de descarte) **sí** llega a `bind`. La comparación de categoría
en Node corre después de `bind` a propósito, y la reserva se libera de inmediato
**antes** de que `input.execute()` corra:

```sql
SELECT ticket_id, status, abort_reason, bound_at IS NOT NULL AS bound, completed_at
FROM uellix_stella_ops.operation_tickets
WHERE ticket_id = '<el ticket de N7>';
-- Exigido: status='aborted', abort_reason='caller_abort', bound=t, completed_at=NULL
```

`abort_reason = 'caller_abort'` es aquí la evidencia, y es específica: es el
único punto del driver que aborta con ese código, y está situado antes de
`execute`. Un `no_result` o un `execution_failed` significaría que la ejecución
sí corrió — y **eso sí invalidaría** el presupuesto de cero llamadas para N7.

#### N9 — rate limit inutilizable

No llega a `bind` ni existe ticket: el rate limit se consume en **emisión**.
Aserción: `Δ(total_tickets con issued_at >= t) == 0` en ese deployment. Es la
prueba viva de que «presente pero inservible» falla cerrado (§R1.10).

---

## 4. R3 — LA ÚNICA LLAMADA (presupuesto: **exactamente 1**)

### 4.0 EXACTLY-ONE — la fuente autoritativa es el runtime

> **ACTUALIZACIÓN.** Una versión anterior de esta sección declaraba
> `EXACT_PROVIDER_CALL_COUNT_NOT_CURRENTLY_OBSERVABLE` y ponía la consola del
> proveedor como **gate A0**. Ambas cosas quedan **derogadas**: el runtime ahora
> emite un evento por invocación (`lib/stella/adapter/provider-call-log.ts`), y
> **ése** es el gate. La consola del proveedor pasa a ser corroboración de
> facturación **opcional**, nunca requisito de G1-B.

Cada invocación del SDK de Gemini emite JSON estructurado en una línea, desde el
único chokepoint por el que pasa toda ruta al proveedor
(`StellaGeminiAdapter.generateWithTimeout`, pegado a
`ai.models.generateContent`):

| Evento | Cuándo |
|---|---|
| `stella.provider_call.started` | **inmediatamente antes** de la llamada, sin ningún `await` intermedio |
| `stella.provider_call.completed` | cuando la Promise de esa invocación **resuelve** |
| `stella.provider_call.failed` | cuando **rechaza** (`failureCategory` en `TIMEOUT` / `PROVIDER_ERROR` / `UNKNOWN_PROVIDER_ERROR`) |

Todos llevan `invocationId`, un UUID **nuevo por invocación** — no por ticket, ni
por adapter, ni por request. Ésa es la propiedad que hace contable PB-01.

**Por qué `started` va ANTES de la llamada.** Hace que un `started` sea condición
**necesaria** de la invocación:

> `0 started` implica `0 invocaciones`

que es la dirección de la que depende el bloque negativo. Emitirlo después de
obtener la Promise leería marginalmente «más cierto» en el happy path y rompería
esa implicación: una excepción síncrona de validación dentro del SDK invocaría el
método sin emitir nada. El coste de elegir ANTES es la imagen especular, y es el
aceptable: como mucho **sobre-cuenta uno**, y no en silencio — ese caso emite
`failed` con el mismo `invocationId`, así que `started == failed` y el par es
visible.

#### La propiedad que se certifica, enunciada con precisión

> **«el runtime de Uellix invocó el SDK de Gemini exactamente una vez»**

**NO** «Google aceptó una petición», **NO** «Google facturó una», **NO** «Google
completó una». Ésos son hechos del lado del proveedor y esta instrumentación no
los reclama. Lo que PB-01 pone en riesgo es la frase de arriba, y es la frase que
se mide.

#### `latencyMs` — frontera, y por qué NO es la métrica de G1-A

`latencyMs` dentro de un evento `stella.provider_call.*` mide **desde la emisión
del `started` hasta que esa misma Promise se resuelve o rechaza**.

**No es el `latencyMs` de G1-A.** Los 11.970 ms de G1-A se midieron alrededor de
`adapter.generate()` por el runner de eval con proveedor real, y esa frontera
contiene además los topes de payload, la pasada de redacción model-bound, el
`import` dinámico de `@google/genai` y la construcción del cliente. Este número
es estrictamente menor y estrictamente más estrecho. **Lo que los desambigua es
el nombre del evento**: un `latencyMs` dentro de un `stella.provider_call.completed`
es siempre éste. La decisión de timeout de la sección 5 sigue usando la métrica
de G1-A.

#### Consulta operativa

Sobre los runtime logs **del deployment Preview concreto**, acotados a la ventana:

```bash
vercel logs "$PREVIEW_DEPLOYMENT_URL" --since "$T_PRE" --until "$T_POST" \
  | grep -o '{"event":"stella.provider_call[^}]*}' > artifacts/g1b/provider-calls.jsonl

jq -r 'select(.event=="stella.provider_call.started")   | .invocationId' artifacts/g1b/provider-calls.jsonl | sort -u > /tmp/started.ids
jq -r 'select(.event=="stella.provider_call.completed") | .invocationId' artifacts/g1b/provider-calls.jsonl | sort -u > /tmp/completed.ids
jq -r 'select(.event=="stella.provider_call.failed")    | .invocationId' artifacts/g1b/provider-calls.jsonl | sort -u > /tmp/failed.ids
wc -l /tmp/started.ids /tmp/completed.ids /tmp/failed.ids
diff /tmp/started.ids /tmp/completed.ids && echo "IDS MATCH"
```

Si el mecanismo de recolección de logs del deployment no es `vercel logs` en el
momento de correr esto, se usa el que sea — la única exigencia es que la fuente
sean los **runtime logs de ese deployment** y que la ventana esté acotada.

#### Contrato de cardinalidad

| Bloque | PASS |
|---|---|
| **R2 negativos** | `\|started\| = 0` |
| **R3 happy path** | `\|started\| = 1` · `\|completed\| = 1` · `\|failed\| = 0` · `startedIds == completedIds` |
| **PB-01 disparado** | `\|started\| > 1` aunque ticket = 1, interaction = 1, settlement = 1 |

La última fila es la razón de existir de esta instrumentación: sin ella, PB-01 es
indistinguible del happy path desde cualquier cifra del ledger.

#### Corroboración opcional del proveedor

La consola del proveedor puede consultarse **después**, para conciliar
facturación. **No es un gate de G1-B** y su ausencia o su falta de granularidad
no bloquea nada. Si discrepa con los eventos de runtime, se investiga; no se
detiene el gate por ello.

### 4.1 Precondiciones del caso

Usuario autenticado con rol en `{super_admin, organization_admin, impact_manager,
analyst, reviewer}` · organización correcta · proyecto de esa organización ·
**ticket de advisor recién emitido** · categoría `advisor` · cuota disponible ·
contexto construible (el proyecto tiene datos).

### 4.1b Gate de invocación — el que cuenta las llamadas

```
PRE:   capturar el cursor/timestamp de logs del deployment
       ejecutar UNA operación autorizada, SIN concurrencia
POST:  consultar los runtime logs en esa ventana

PASS:  started = 1 · completed = 1 · failed = 0 · mismo invocationId
```

Cada grupo de evidencia de R3 prueba una propiedad **distinta**, y ninguno
sustituye a otro:

| Grupo | Prueba |
|---|---|
| eventos `stella.provider_call.*` | **cuántas veces se invocó al proveedor** |
| `stella_interactions` +1 | que se archivó una fila de ledger |
| settlement = 1 | que la cuota de Uellix cobró una vez |
| `audit_logs` fila `stella.invoked` | que existe rastro de auditoría |
| `model_used = gemini-3.6-flash` | qué modelo respondió |
| `requiresHumanReview = true` | que el contrato estricto se cumplió |

### 4.2 Ejecución

Una sola invocación del **advisor contextual** (`getStellaContextualAdvisor`)
desde `StellaContextualAdvisorPanel` en una página del pipeline. **No** usar el
advisor legacy: está desmontado y su flag es `false`.

Registrar: `t0`, `t1`, y el `latencyMs` observado.

### 4.3 Verificaciones en el resultado

- respuesta `ok: true`
- valida contra `AdvisorContextualOutputSchema` (`.strict()`)
- **`requiresHumanReview === true`**
- `sourceFields` resuelven contra el catálogo del paso
- `step` coincide con el solicitado

### 4.4 A — `stella_interactions` (DSN de auditor)

```sql
SELECT id, organization_id, project_id, created_by, stella_role, pipeline_step,
       model_used, tokens_used, created_at
FROM public.stella_interactions
ORDER BY created_at DESC
LIMIT 3;
```

Exigido sobre la fila nueva:

| Campo | Valor |
|---|---|
| `organization_id` | la organización de la sesión |
| `project_id` | el proyecto de la llamada |
| `created_by` | el usuario de la sesión |
| `stella_role` | `advisor` |
| `model_used` | **`gemini-3.6-flash`** |

`model_used` es la aserción que `stella_0020` hace comprobable: **ya no existe
un DEFAULT que pudiera rellenarla**, así que ese valor sólo puede venir del
adapter.

Y **exactamente una LIQUIDACIÓN**:

```sql
SELECT count(*) AS ever_completed
FROM uellix_stella_ops.operation_tickets
WHERE completed_at IS NOT NULL;
```

`Δever_completed == +1` y `Δinteractions == +1` respecto del snapshot posterior
al bloque negativo.

> **Esto demuestra que la CONTABILIDAD DE UELLIX cobró exactamente una vez. NO
> demuestra que Gemini recibiera exactamente una llamada.** Bajo PB-01 ambas
> cifras pueden valer 1 con N invocaciones al proveedor. La evidencia de
> exactly-one son los eventos `stella.provider_call.*` (§4.0), y ninguna otra.

### 4.5 B — `audit_logs` (**la aserción que puede hacer fallar G1-B**)

```sql
SELECT id, organization_id, actor_user_id, entity_type, entity_id, action,
       after_json, created_at
FROM public.audit_logs
WHERE action = 'stella.invoked'
ORDER BY created_at DESC
LIMIT 3;
```

**DEBE existir** la fila esperada, con:

| Campo | Valor |
|---|---|
| `action` | `stella.invoked` |
| `actor_user_id` | el usuario de la sesión (**no** NULL) |
| `organization_id` | la organización de la sesión |
| `entity_type` / `entity_id` | `project` / el `projectId` de la llamada |
| `after_json->>'stellaRole'` | `advisor` |
| `after_json->>'pipelineStep'` | el paso solicitado |
| `after_json->>'contextHash'` | presente, 64 hex — el identificador correlacionable con `stella_interactions.context_hash` |
| `after_json->>'quotaLedger'` | presente |

Correlación explícita entre las dos filas:

```sql
SELECT i.id AS interaction_id, i.context_hash, a.id AS audit_id
FROM public.stella_interactions i
JOIN public.audit_logs a
  ON a.action = 'stella.invoked'
 AND a.organization_id = i.organization_id
 AND a.entity_id = i.project_id
 AND a.after_json->>'contextHash' = i.context_hash
ORDER BY i.created_at DESC
LIMIT 1;
```

> ### CRITERIO DE FALLO, SIN MATICES
>
> **Si la interaction existe y la fila de audit NO existe: G1-B = FAIL.**
>
> Un evento en Sentry (`AUDIT_ERROR`) **no** sustituye a la fila. Sentry
> demuestra que el fallo fue *visto*; la fila es lo que la auditoría *es*. El
> reporte a Sentry se añadió precisamente para que este fallo dejara de ser
> silencioso — no para que fuera aceptable.
>
> El diagnóstico más probable en ese caso es que `stella_hosted_0008` no está
> aplicado (R1.5).

### 4.6 Telemetría

Capturar de `providerMetadata`: `modelVersion`, `responseId`, `finishReason`,
`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`,
`totalTokenCount`, `usageAvailable`. Guardar junto a `latencyMs` en
`artifacts/g1b/`.

---

## 5. R4 — DECISIÓN DE TIMEOUT

**Se mantiene `requestTimeoutMs = 15000`.** No se cambia en G1-B.

| `latencyMs` observado | Veredicto |
|---|---|
| ≤ 10.500 (70%) | `KEEP_15S` candidate |
| 10.500 < x ≤ 12.750 | **banda ambigua** — requiere n ≥ 3 mediciones |
| > 12.750 (85%) | `CHANGE_TIMEOUT` candidate |

G1-A midió **11.970 ms**, así que **ya estamos en banda ambigua** antes de
empezar. La única llamada de G1-B suma la segunda medición, no la tercera.

> **G1-B PUEDE CERRARSE EN VERDE** con el timeout marcado como
> `NEEDS_ADDITIONAL_MEASUREMENT_BEFORE_PILOT`, siempre que la única llamada
> termine correctamente. **No se hacen llamadas extra sólo para resolver la
> banda**; sólo si son necesarias para diagnosticar un fallo real.

Disparadores inmediatos de `CHANGE_TIMEOUT` aunque la latencia caiga en banda:
`finishReason = MAX_TOKENS`, o cualquier `TIMEOUT` observado.

---

## 6. Aborto y limpieza

- **Cualquier gate de R1 que falle** ⇒ abortar. Coste: 0 llamadas.
- **Un negativo de R2 que devuelva algo distinto de lo exigido** ⇒ abortar antes
  de R3. Coste: 0 llamadas.
- **Fallo en R3** ⇒ no reintentar por reflejo. Lo que hace un reintento con el
  **mismo** ticket depende del estado en que quedó la fila, y conviene leerlo
  antes de tocar nada (`stella_0016`, cuerpo de `bind`):

  | Estado del ticket | `bind` responde | ¿Llama al proveedor? |
  |---|---|---|
  | `completed` (R3 tuvo éxito) | `completed` → el driver retorna `already_completed` | **no** |
  | `aborted` (R3 falló y el driver liberó) | `U0109` «already settled» → rechazo | **no** |
  | `bound` (nadie liberó: proceso caído, entrega en vuelo) | `bound`, **idempotente** | **SÍ — otra vez.** Es PB-01 |

  Un ticket **nuevo** es una operación nueva y **gasta una segunda llamada**.
  Cualquier reintento se registra en la evidencia y se recuenta contra el gate
  de invocación (§4.0): un reintento que sí llegue al proveedor aparece como un
  `stella.provider_call.started` adicional, con su propio `invocationId`. Nada
  aquí se asume por su tipo.
- Nada de este runbook escribe. La única escritura del ejercicio es la que
  produce la propia llamada de R3, a través del protocolo gobernado.

---

## 7. Bloqueadores de piloto conocidos antes de empezar

Ver `docs/ops/G1_B_POST_GATE_PILOT_BLOCKERS.md`.

En particular **`PROVIDER_CALL_CONCURRENCY_PER_TICKET`**: un ticket ya `bound`
admite entregas concurrentes, y cada una puede alcanzar al proveedor antes de
que un `complete` gane. G1-B es de **una sola llamada secuencial**, así que no
lo ejercita y **no lo bloquea** — pero debe resolverse o aceptarse
explícitamente **antes de tráfico piloto**.
