# CAP-03 — Procesamiento de webhook Stripe

**Estado:** DISEÑO. No aplicado. No habilitado.
**Paquete:** `db/prepared/stella_0008_stripe_webhook_identity.sql`
**Rollback:** `db/prepared/stella_0008_rollback.sql`
**Modelo común:** [`../DATABASE_CAPABILITY_MODEL.md`](../DATABASE_CAPABILITY_MODEL.md)

---

## 1. Inventario del flujo actual (FASE 2)

| Aspecto | Realidad medida |
|---|---|
| Entry point | `app/api/webhooks/stripe/route.ts` (`POST`) |
| Actor | **Stripe**, no una persona |
| Autenticación | Firma HMAC verificada por `stripe.webhooks.constructEvent()` |
| Información disponible | El evento firmado; `STRIPE_WEBHOOK_SECRET`; `STRIPE_SECRET_KEY` |
| Contexto de BD | **Ninguno** — y no puede haberlo: no hay sesión, no hay usuario |
| Tablas consultadas | `audit_logs` (dedupe), `organizations` (por `stripe_subscription_id`) |
| Tablas modificadas | `organizations` (UPDATE de cuota/plan), `audit_logs` (INSERT) |
| Servicios llamados | `stripe.subscriptions.retrieve()` — llamada saliente a Stripe |
| Efectos externos | Ninguno propio; el efecto ya ocurrió en Stripe |
| Respuesta actual | **503** tras verificar firma (`WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false`) |
| **Por qué falla cerrado hoy** | No existe identidad de base de datos posible: la organización se encuentra por `stripe_customer_id`, luego la fila no pertenece a la membresía de ningún usuario concreto, y `orgs_update_admin_or_super` está escrita para un admin humano. El handler **se niega explícitamente** en vez de escribir cero filas y devolver 200. |

### 1.1 Tres defectos del flujo actual que sobreviven al cutover

Existen con independencia de RLS y el diseño los corrige:

1. **La idempotencia usa `audit_logs.reason` y no es atómica.**
   `SELECT … WHERE reason = 'stripe_event:<id>'` seguido de la escritura es un
   *check-then-act*. Dos entregas concurrentes del mismo evento —que Stripe
   produce— pasan ambas la comprobación y aplican ambas. No hay constraint
   único que lo impida. Además convierte una tabla de auditoría en un almacén
   de claves de idempotencia, que no es lo que es.
2. **No hay máquina de estados.** No se distingue "recibido", "en proceso",
   "completado" y "fallido". Un evento que revienta a mitad no deja rastro de
   que se intentó, y el reintento de Stripe lo trata como nuevo.
3. **No hay transacción.** `UPDATE organizations` y `INSERT audit_logs` son
   sentencias separadas. Un fallo entre ambas deja la cuota cambiada sin
   registro de por qué — el peor estado parcial posible en facturación.

Y uno de confianza:

4. **`session.client_reference_id` se usa como `organizationId` sin verificar.**
   Lo fija quien crea la sesión de checkout. El diseño lo trata como una
   afirmación a comprobar, no como un hecho.

---

## 2. Actor y frontera de confianza

```
   Stripe  (servidor externo)
   ─────────────────────────────────  frontera 1: firma HMAC
   Runtime Next.js — handler del webhook
     · constructEvent() ANTES de cualquier acceso a BD
     · el secreto sólo lo lee ESTE handler
   ─────────────────────────────────  frontera 2: conexión SQL PROPIA
   uellix_stripe   (LOGIN, credencial exclusiva)
     · EXECUTE sobre exactamente 3 funciones
     · CERO privilegio sobre las 38 tablas de public, en los 4 modos DML
   ─────────────────────────────────  frontera 3: SECURITY DEFINER
   uellix_cap_stripe   (NOLOGIN, cero miembros)
     · SELECT/UPDATE por columna sobre organizations
     · SELECT/INSERT/UPDATE sobre stripe_webhook_events
     · INSERT sobre audit_logs
```

La frontera 1 es la **única** que autentica. Todo lo demás es contención.

---

## 3. Determinación: rol `LOGIN` **y** RPC `SECURITY DEFINER`

La FASE 6 pide decidir entre un rol `LOGIN`, una RPC definer, o ambos.
**Ambos**, y la justificación completa está en
[`../DATABASE_CAPABILITY_MODEL.md`](../DATABASE_CAPABILITY_MODEL.md) §4.
Resumen:

* **Sólo RPC desde `uellix_app`** → el `EXECUTE` de facturación cuelga del
  runtime general; la credencial no es rotable ni revocable por separado; el
  tráfico de facturación es indistinguible en `pg_stat_activity`.
* **Sólo rol `LOGIN` con grants directos** → necesitaría `UPDATE` sobre
  `organizations` (que no se puede acotar para impedir cambiar `name`, `slug`
  o `status` sin acotar por columna, y aun así abriría la puerta a mutaciones
  masivas) y `SELECT` sobre `organizations` (que **es** la lista de clientes).

La combinación produce esta propiedad, que el paquete verifica en su
postcondición:

```
para cada una de las 38 tablas de public, y para SELECT/INSERT/UPDATE/DELETE:
  has_any_column_privilege('uellix_stripe', <tabla>, <modo>)  →  false
```

**Cero privilegio sobre cero tablas.** Un volcado de la credencial de
`uellix_stripe` no permite leer un solo dato SROI, ni la lista de clientes, ni
un nombre de organización.

> **Lo que NO se afirma.** Un borrador previo decía que `uellix_stripe`
> *"no tiene `USAGE` sobre `public` y no puede ni nombrar `public.projects`"*.
> Es falso: medido el 2026-08-03, el ACL de `public` contiene la entrada
> `=U/pg_database_owner` — grantee vacío, es decir **`PUBLIC`** —, así que todo
> rol nuevo hereda `USAGE` al crearse, y los ACL de PostgreSQL son aditivos: no
> hay forma de retirárselo sólo a él. Hacerlo cierto exigiría
> `REVOKE USAGE ON SCHEMA public FROM PUBLIC`, un cambio global que alcanza a
> roles internos de Supabase. Se registra como **RR-CAP-7** y **no** se toma en
> un paquete de capacidad. Poder nombrar una tabla sobre la que no se tiene
> ningún privilegio no sirve de nada; la propiedad efectiva se conserva.

### 3.1 Atributos de `uellix_stripe`

```
LOGIN  NOINHERIT  NOBYPASSRLS  NOCREATEDB  NOCREATEROLE  NOREPLICATION  NOSUPERUSER
sin membresías (cero filas en pg_auth_members)
ALTER ROLE uellix_stripe SET statement_timeout = '10s'
ALTER ROLE uellix_stripe SET idle_in_transaction_session_timeout = '15s'
```

Sin membresías ⇒ no hay `SET ROLE` posible, no hay herencia. Sus únicos
privilegios **concedidos** son `USAGE` sobre `uellix_capability` y `EXECUTE`
sobre tres funciones. Hereda además `USAGE` sobre `public` de `PUBLIC`, que no
se puede evitar (§3) y que no le sirve de nada: no tiene privilegio sobre
ninguna tabla de ese esquema.

Los dos timeouts son parte del contrato: un webhook que se cuelga con una
transacción abierta bloquearía filas de `organizations` indefinidamente.

---

## 4. La tabla de eventos

```
public.stripe_webhook_events
  event_id        text        PRIMARY KEY          -- la clave de idempotencia
  event_type      text        NOT NULL
  status          text        NOT NULL           -- sin DEFAULT: ver nota
  attempts        integer     NOT NULL DEFAULT 1
  received_at     timestamptz NOT NULL DEFAULT now()
  completed_at    timestamptz
  failed_at       timestamptz
  last_error_code text                             -- código, NUNCA mensaje ni payload
  organization_id uuid REFERENCES public.organizations(id)
  CHECK (status IN ('received','processing','completed','failed'))
```

`status` no tiene `DEFAULT`. La única inserción —en `stripe_begin_event`— escribe
siempre `'processing'`, así que un `DEFAULT 'received'` sería un estado que nada
puede alcanzar. Se conserva en el `CHECK` como valor reservado.

**`event_id` es la PRIMARY KEY**, y esa sola decisión sustituye al
*check-then-act* por una operación atómica: `INSERT … ON CONFLICT (event_id)`.
Dos entregas concurrentes compiten por la misma clave y el motor decide; no hay
ventana.

`last_error_code` es un **código**, no un mensaje. Un mensaje de error de
Postgres puede incluir el valor de una fila. Un código no.

**No hay columna de payload.** El evento completo de Stripe contiene datos de
pago y del cliente; conservarlo aquí sería duplicar información sensible que
Stripe ya custodia y que la aplicación no necesita.

### 4.1 ¿Es append-only?

**No**, y la excepción es deliberada: la máquina de estados necesita `UPDATE`
sobre `status`, `attempts`, `completed_at`, `failed_at`. Lo que sí se aplica es
la misma disciplina en forma acotada:

* `uellix_cap_stripe` tiene `UPDATE` **sólo** sobre esas cuatro columnas.
* No tiene `DELETE` sobre la tabla. La purga por retención (DP-CAP-07) sería
  un trabajo del migrador, no de la capacidad.
* No tiene `UPDATE` sobre `event_id` ni sobre `event_type`: una vez recibido,
  qué evento fue no se puede reescribir.

---

## 5. Las tres RPC

Tres y no una, para que cada paso tenga su propio límite de privilegio y su
propio punto de commit.

### 5.1 `stripe_begin_event(p_event_id text, p_event_type text) → text`

`VOLATILE`, `SECURITY DEFINER`, `search_path = ''`.

```
INSERT INTO public.stripe_webhook_events (event_id, event_type, status)
VALUES (p_event_id, p_event_type, 'processing')
ON CONFLICT (event_id) DO UPDATE
  SET status   = 'processing',
      attempts = public.stripe_webhook_events.attempts + 1
  WHERE public.stripe_webhook_events.status IN ('failed','received')
RETURNING 'claimed'
```

Devuelve:

| Valor | Significado | El handler responde |
|---|---|---|
| `claimed` | Es nuestro; procesar | continúa |
| `duplicate` | Ya `completed` — el `ON CONFLICT` no actualizó nada | **200**, sin reprocesar |
| `in_progress` | Otro worker lo tiene en `processing` | **409/503** para que Stripe reintente |

El `ON CONFLICT DO UPDATE` reclama además cualquier fila en `processing` cuya
`received_at` sea anterior al *lease* de 15 minutos, y al reclamar limpia
`failed_at` **y** `last_error_code` — sin lo segundo, un evento re-reclamado
arrastraría el código del intento anterior hasta `completed`, y el `CHECK` lo
permite, así que nada más lo detectaría.

Hay un quinto estado, `ignored`, y existe porque `stripe_begin_event` mueve la
fila a `processing` **antes** de que el handler sepa si actúa sobre ese tipo de
evento. Sin un estado terminal para los que ignora, esas filas se quedarían en
`processing` para siempre y `idx_stripe_webhook_events_status` dejaría de
distinguir un worker muerto de tráfico rutinario. El handler las cierra con
`stripe_fail_event(id, 'not_applicable')`.

La distinción `duplicate` / `in_progress` se resuelve con un `SELECT status`
posterior dentro de la misma función cuando el `RETURNING` viene vacío.

### 5.2 `stripe_apply_subscription(...) → void`

Recibe los valores **ya derivados por el handler** a partir del evento firmado:

```
stripe_apply_subscription(
  p_event_id            text,
  p_match_kind          text,     -- 'customer' | 'subscription' | 'organization'
  p_match_value         text,
  p_stripe_customer_id  text,
  p_stripe_subscription_id text,
  p_stripe_price_id     text,
  p_quota               integer,
  p_plan_label          text
)
```

Cuerpo, en **una** transacción:

1. Comprobar que el evento está en `processing` y es el que dice ser. Si no →
   error uniforme.
2. Resolver **una** organización con `array_agg` + `array_length` (no `min()`:
   PostgreSQL no tiene `min(uuid)`). Si resuelven 0 o >1 → lanzar el error
   uniforme y **no marcar nada**: un `UPDATE … SET status='failed'` seguido de
   `RAISE` en la misma transacción lo revierte el propio `RAISE`. Marcar el
   fallo es tarea del handler, con `stripe_fail_event`, en su propia
   transacción.

   *El defecto 4 se cierra eliminando la vía, no guardándola.* `match_kind =
   'organization'` —el caso `checkout.session.completed`, que resuelve por
   `client_reference_id`— **ya no existe**. Las dos rondas adversariales
   llegaron a conclusiones opuestas sobre cómo guardarlo: una dijo que la
   guarda era demasiado estricta (una organización que cancela y vuelve a
   suscribirse queda rechazada para siempre, porque `stripe_customer_id` nunca
   se limpia), la otra que era demasiado laxa (una organización que **nunca** se
   suscribió tiene las columnas en `NULL`, así que la guarda pasa y cualquier
   `client_reference_id` puede reclamarla). Ambas tienen razón, y eso es la
   respuesta: ningún predicado sobre la fila actual distingue una primera
   suscripción legítima de una reclamación hostil, porque la única evidencia en
   cualquiera de los dos sentidos es el campo que elige el atacante. La
   capacidad se niega a ser el sitio donde una organización se ata por primera
   vez a un cliente de Stripe; esa atadura la debe registrar un flujo
   autenticado de primera parte **antes** de que llegue ningún webhook, y eso es
   **DP-CAP-15**.
3. Leer el estado previo (para `before_json`).
4. `UPDATE public.organizations SET …` — sólo las seis columnas concedidas.
5. `INSERT INTO public.audit_logs` con `action = 'stripe.subscription.*'`,
   `before_json`/`after_json` con **cuota, plan y price id**, nunca el payload.
6. `UPDATE public.stripe_webhook_events SET status='completed', completed_at=now()`.

Los seis pasos comparten transacción. **O todo, o nada.** Ese es el defecto 3
cerrado.

### 5.3 `stripe_fail_event(p_event_id text, p_error_code text) → void`

Marca `failed`, sella `failed_at`, guarda el **código**. `p_error_code` se
valida contra una lista fija (`signature`, `org_not_resolved`,
`price_unmapped`, `internal`) — no es texto libre, así que no puede
transportar un mensaje con datos.

---

## 6. `audit_logs` y el actor nulo

`stella_0005c` ató `audit_logs.actor_user_id` a `auth.uid()` y prohibió el
actor `NULL` **para el runtime**. El comentario de aquel script anticipó
exactamente este caso:

> *"el único escritor que omite el actor es el webhook de Stripe — que se
> rechaza de entrada (503, sin identidad de base de datos) y escribirá a través
> de una identidad TÉCNICA cuando exista, no a través de `uellix_app` con
> claims de usuario."*

Este diseño cumple esa promesa. La policy nueva:

```
CREATE POLICY cap_stripe_insert_audit ON public.audit_logs
FOR INSERT TO uellix_cap_stripe
WITH CHECK (
  actor_user_id IS NULL
  AND entity_type = 'organization'
  AND action LIKE 'stripe.%'
);
```

`actor_user_id IS NULL` es **obligatorio**, no opcional: una fila de auditoría
de Stripe que llevara un usuario estaría atribuyendo una mutación de
facturación a una persona que no la hizo. La policy de `uellix_app` sigue
exigiendo lo contrario (actor no nulo). Las dos policies son disjuntas por rol
y por `action`, así que ninguna se relaja para acomodar a la otra.

---

## 7. Grants mínimos

```
GRANT USAGE   ON SCHEMA uellix_capability TO uellix_stripe;
GRANT EXECUTE ON FUNCTION uellix_capability.stripe_begin_event(text,text)        TO uellix_stripe;
GRANT EXECUTE ON FUNCTION uellix_capability.stripe_apply_subscription(...)       TO uellix_stripe;
GRANT EXECUTE ON FUNCTION uellix_capability.stripe_fail_event(text,text)         TO uellix_stripe;
REVOKE ALL ON FUNCTION … FROM PUBLIC;   -- las tres
```

**Y explícitamente NO:**

```
-- uellix_stripe NO recibe NINGÚN privilegio de tabla ni de columna.
-- uellix_app NO recibe EXECUTE sobre ninguna de las tres.
```

Que `uellix_app` **no** pueda llamar a estas funciones es tan importante como
que `uellix_stripe` sí pueda: impide que CAP-03 **añada** al runtime una vía
para mover cuotas.

> **Lo que esto NO afirma, corregido en la segunda ronda.** Un borrador decía
> que era *"lo que impide que un endpoint cualquiera de la aplicación mueva una
> cuota"*. Es falso, y el mecanismo es **preexistente**: `stella_0004` §6b
> concede `SELECT, INSERT, UPDATE, DELETE` **a nivel de tabla** sobre
> `organizations` a `uellix_writer`, `uellix_app` hereda, y
> `orgs_update_admin_or_super` es una policy `{public}` sin predicado de
> columna. Cualquier `organization_admin` puede escribir
> `stella_monthly_quota` por el ORM, hoy, sin CAP-03. Negar el `EXECUTE` no
> cierra esa vía porque esa vía nunca pasó por aquí.
>
> Registrado como **RR-CAP-10**. Cerrarlo exige acotar por columna el `UPDATE`
> de `uellix_writer` sobre `organizations`, que es un cambio a la superficie de
> escritura del runtime y no cabe en un paquete de capacidad.

`uellix_cap_stripe`, por columna:

| Tabla | Priv. | Columnas |
|---|---|---|
| `public.organizations` | `SELECT` | `id, stripe_customer_id, stripe_subscription_id, stripe_price_id, stella_monthly_quota, stella_plan_label` |
| `public.organizations` | `UPDATE` | `stripe_customer_id, stripe_subscription_id, stripe_price_id, stella_monthly_quota, stella_plan_label, updated_at` |
| `public.stripe_webhook_events` | `SELECT, INSERT` | todas |
| `public.stripe_webhook_events` | `UPDATE` | `status, attempts, completed_at, failed_at, last_error_code, organization_id` |
| `public.audit_logs` | `INSERT` | `organization_id, entity_type, entity_id, action, before_json, after_json, reason` |

**No tiene `SELECT` sobre `organizations.name`, `slug`, `status`, `country`
ni ninguna otra columna.** No puede listar clientes por nombre. No puede
cambiar el nombre ni el estado de una organización. Y no tiene absolutamente
nada sobre `projects`, `sroi_*`, `evidence_*`, `stella_*`, `outcomes`,
`stakeholders`, `financial_proxies` ni ninguna otra tabla del pipeline.

---

## 8. Policies necesarias

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_stripe_select_orgs` | `organizations` | `SELECT` | `USING (true)` |
| `cap_stripe_update_orgs` | `organizations` | `UPDATE` | `USING (true) WITH CHECK (true)` |
| `cap_stripe_rw_events` | `stripe_webhook_events` | `ALL` | `USING (true) WITH CHECK (true)` |
| `cap_stripe_insert_audit` | `audit_logs` | `INSERT` | ver §6 |

Las tres primeras son `USING (true)` y hay que decir por qué sin adornos: **una
policy no puede ver los argumentos de la función que la invoca**, así que no
puede expresar "sólo la organización que casa con este `stripe_customer_id`".
La restricción efectiva la dan (a) el grant por columna, (b) el cuerpo de la
función, y (c) el hecho de que `uellix_cap_stripe` es inalcanzable salvo a
través de esas tres funciones. Es contención en capas, no autorización por
policy, y llamarlo de otro modo sería mentir sobre lo que la policy hace.

---

## 9. Validaciones e idempotencia

| Validación | Dónde |
|---|---|
| Firma HMAC | Handler, **antes** de cualquier acceso a BD |
| `event_id` no vacío, ≤ 255 | Handler + función |
| `event_type` en la lista soportada | Handler |
| Estado del evento en `processing` | `stripe_apply_subscription` |
| Exactamente una organización resuelta | `stripe_apply_subscription` |
| Checkout no reasigna suscripción ajena | `stripe_apply_subscription` (defecto 4) |
| `p_error_code` en lista fija | `stripe_fail_event` |
| `p_quota >= 0` | Función |

**Idempotencia y reintentos:**

| Escenario | Resultado |
|---|---|
| Stripe reenvía un evento ya `completed` | `duplicate` → **200**, cero escrituras |
| Stripe reenvía mientras está `processing` | `in_progress` → **503**, Stripe reintenta |
| Un intento anterior quedó `failed` | `claimed` con `attempts+1` → se reprocesa |
| Dos entregas concurrentes del mismo evento | La `PRIMARY KEY` decide; sólo una obtiene `claimed` |
| La aplicación cae tras el commit, antes de responder | Stripe reintenta → `duplicate` → 200. **Correcto** |
| El commit falla | Stripe reintenta → `claimed` (seguía `processing`… ver §9.1) |

### 9.1 El caso feo: `processing` huérfano

Si el proceso muere entre `stripe_begin_event` (que **commitea** su propio
`INSERT`) y `stripe_apply_subscription`, el evento queda en `processing` para
siempre y todo reintento recibe `in_progress`. Stripe acaba rindiéndose y el
cambio de suscripción se pierde en silencio — el mismo fallo silencioso que el
handler actual se negó a cometer.

**Mitigación en el diseño:** `stripe_begin_event` trata como reclamable
cualquier fila en `processing` cuya `received_at` sea anterior a un umbral
(propuesto: 15 minutos, coherente con
`idle_in_transaction_session_timeout = 15s` y con los reintentos de Stripe):

```
WHERE status IN ('failed','received')
   OR (status = 'processing' AND received_at < pg_catalog.now() - interval '15 minutes')
```

Es un lease, no un lock. Se documenta como tal: **RR-CAP-03-A**.

### 9.2 Divergencia entre el efecto externo y la transacción

El efecto ya ocurrió en Stripe antes de que llegue el webhook. La regla es
**resolver siempre a favor de Stripe**:

* Nunca 200 antes del commit. El `200` se emite después de que
  `stripe_apply_subscription` retorne.
* Ante duda, 5xx: Stripe reintenta con backoff y el evento no se pierde.
* `stripe.subscriptions.retrieve()` ocurre **fuera** de la transacción de base
  de datos, antes de llamar a `stripe_apply_subscription`. Una llamada saliente
  dentro de una transacción sostiene bloqueos de fila durante un viaje de red a
  un tercero — el mismo error que el propio repositorio ya corrigió en
  `createInvitation` con `deferInvitationEmail`.

---

## 10. Rate limiting

Stripe no se rate-limita: reintentar es su contrato y limitarlo produce el
fallo silencioso que se quiere evitar. Lo que sí se limita:

| Límite | Valor | Ámbito |
|---|---|---|
| `statement_timeout` de `uellix_stripe` | 10 s | Rol |
| `idle_in_transaction_session_timeout` | 15 s | Rol |
| Tamaño del cuerpo aceptado | 1 MiB | Handler |
| Peticiones **sin firma válida** por IP | 20 / min | Handler |

El último es el único límite por IP y es importante: sin él, el endpoint es un
oráculo de verificación de firma gratuito para cualquiera.

---

## 11. Auditoría y retención

**Se audita el tipo de evento y el resultado, nunca el payload:**

| Destino | Contenido |
|---|---|
| `stripe_webhook_events` | `event_id`, `event_type`, estado, intentos, marcas de tiempo, código de error |
| `audit_logs` | `action = 'stripe.subscription.{created,updated,deleted}'`, `before_json`/`after_json` con `{priceId, quota, label}`, actor `NULL` |
| Log de aplicación | `[stripe-webhook]` + `event.type`. **Nunca** el cuerpo, nunca la firma, nunca el secreto |

**Retención (DP-CAP-07, sin decidir):** el diseño **no** programa ninguna
purga. Se documenta la consulta de purga y se deja sin ejecutar:

```
DELETE FROM public.stripe_webhook_events
WHERE status = 'completed' AND completed_at < now() - interval '<N>';
```

`uellix_cap_stripe` **no tiene `DELETE`**, así que la purga sólo la puede
correr el migrador. Es deliberado: la capacidad que escribe eventos no puede
borrarlos, con lo que no puede borrar la prueba de lo que hizo.

---

## 12. Pruebas (suite `stripe-webhook-capability`)

### 12.1 Estáticas

| # | Prueba |
|---|---|
| S1 | El paquete **no** concede ningún privilegio de `public` a `uellix_stripe`, y su postcondición barre las 38 tablas × 4 modos |
| S2 | `uellix_stripe` no recibe ningún privilegio de tabla en el paquete |
| S3 | `uellix_stripe` se crea `NOBYPASSRLS NOCREATEROLE NOCREATEDB NOSUPERUSER` y sin `GRANT … TO uellix_stripe` de ningún rol |
| S4 | El paquete **no** contiene ninguna contraseña ni `PASSWORD` literal |
| S5 | `uellix_app` **no** recibe `EXECUTE` sobre ninguna función `stripe_*` |
| S6 | La policy de `audit_logs` exige `actor_user_id IS NULL` y `action LIKE 'stripe.%'` |
| S7 | `stripe_webhook_events` tiene `event_id` como `PRIMARY KEY` |
| S8 | El grant de `UPDATE` sobre `stripe_webhook_events` **no** incluye `event_id` ni `event_type` |
| S9 | El grant de `UPDATE` sobre `organizations` no incluye `name`, `slug` ni `status` |
| S10 | Ninguna tabla del pipeline SROI aparece en ningún `GRANT` del paquete |
| S11 | `search_path=''`, todo cualificado, cero SQL dinámico, en las tres funciones |
| S12 | El paquete no crea ninguna columna de payload en `stripe_webhook_events` |

### 12.2 Vivas (stack desechable)

| # | Prueba | Debe |
|---|---|---|
| L1 | Evento nuevo | `claimed`, y tras aplicar: cuota movida + 1 auditoría + `completed` |
| L2 | Reenvío del mismo evento | `duplicate`, **cero** escrituras nuevas |
| L3 | Dos `begin` concurrentes | exactamente uno recibe `claimed` |
| L4 | `apply` sin `begin` previo | error uniforme, cero escrituras |
| L5 | Organización no resuelta | `failed` con código, cero cambios en `organizations` |
| L6 | Checkout que intenta reasignar suscripción ajena | rechazado |
| L7 | `uellix_stripe` intenta `SELECT * FROM public.projects` | **denegado — cero privilegio sobre la tabla** (puede nombrarla; no puede leerla) |
| L8 | `uellix_stripe` intenta `SELECT` sobre `public.organizations` | denegado |
| L9 | `uellix_stripe` intenta `SET ROLE uellix_cap_stripe` | denegado |
| L10 | `uellix_app` intenta `EXECUTE stripe_apply_subscription` | denegado |
| L11 | El definer intenta `UPDATE organizations SET name = …` | denegado por columna |
| L12 | El definer intenta `DELETE FROM stripe_webhook_events` | denegado |
| L13 | Auditoría con `actor_user_id` no nulo | rechazada por la policy |
| L14 | Lease de `processing` caducado | reclamable tras 15 min |

---

## 13. Rollout

> ### PRECONDICIÓN BLOQUEANTE: RR-CAP-10 / `ORGANIZATION_QUOTA_COLUMN_HARDENING`
>
> **CAP-03 no puede declararse implementable mientras RR-CAP-10 siga abierto.**
>
> RR-CAP-10 no es un riesgo *de* CAP-03: es preexistente. `stella_0004` §6b
> concede `UPDATE` **a nivel de tabla** sobre `public.organizations` a
> `uellix_writer`, `uellix_app` hereda, y `orgs_update_admin_or_super` es una
> policy `{public}` sin predicado de columna. Cualquier `organization_admin`
> escribe `stella_monthly_quota` y `stella_plan_label` por el ORM **hoy**, sin
> que CAP-03 exista.
>
> Por qué bloquea de todas formas: la proposición que justifica esta capacidad
> es *«la cuota sólo se mueve por un evento firmado de Stripe»*. Con RR-CAP-10
> abierto esa proposición **es falsa**, y montar tres funciones
> `SECURITY DEFINER`, un rol `LOGIN` nuevo y una credencial adicional para
> defender una puerta que tiene otra abierta al lado no es una mejora de
> seguridad: es superficie nueva a cambio de nada. Habilitar CAP-03 antes
> convertiría una afirmación falsa en una afirmación falsa *documentada como
> verificada*, que es peor.
>
> **Cierre requerido — `ORGANIZATION_QUOTA_COLUMN_HARDENING`:** acotar por
> columna el `UPDATE` de `uellix_writer` sobre `public.organizations`, de modo
> que `stella_monthly_quota`, `stella_plan_label` y las tres columnas
> `stripe_*` queden fuera del alcance del runtime, **y** añadir el predicado de
> columna que hoy le falta a `orgs_update_admin_or_super`. Es un cambio a la
> superficie de escritura de la aplicación, con su propio análisis de impacto:
> **no cabe en un paquete de capacidad y no se intenta en esta unidad.**
>
> Estado: **ABIERTO**. Indexado en
> [`../STELLA_FABLE_RISK_REGISTER.md`](../STELLA_FABLE_RISK_REGISTER.md).

0. **Cerrar RR-CAP-10.** Sin esto, los pasos siguientes no deben ejecutarse.
1. Dry-run en stack desechable; `L1..L14`.
2. Generar la credencial de `uellix_stripe` **fuera del paquete** (el script no
   contiene contraseñas, igual que `stella_0004`) y guardarla como
   `UELLIX_STRIPE_DATABASE_URL`, disponible **sólo** para el handler del
   webhook.
3. Aplicar en local de ensayo.
4. `WEBHOOK_DATABASE_IDENTITY_AVAILABLE` sigue en **`false`**. La suite
   `tests/stripe-webhook-route.test.ts` fija esa constante y **debe seguir en
   verde**: cambiarla es un acto aparte, posterior y revisado.
5. Reescribir el handler para usar el pool de `uellix_stripe` y las tres RPC.
6. Resolver **DP-CAP-07** antes de acumular volumen.

## 14. Rollback

El orden real de `db/prepared/stella_0008_rollback.sql`, que **no** es el que
una versión anterior de esta sección describía:

1. `REVOKE ALL` sobre las tres funciones **desde `uellix_stripe`** (guardado por
   la existencia del rol: el script sobrevive a un rol ya eliminado).
2. `DROP FUNCTION` ×3, con la firma completa.
3. `DROP POLICY` ×4 — `cap_stripe_select_orgs`, `cap_stripe_update_orgs`,
   `cap_stripe_insert_audit`, `cap_stripe_rw_events`.
4. `REVOKE ALL` sobre `organizations`, `audit_logs` y `stripe_webhook_events`
   desde `uellix_cap_stripe`.
5. `REVOKE ALL ON SCHEMA uellix_capability FROM uellix_stripe`,
   **`ALTER ROLE uellix_stripe RESET ALL`** — que limpia los tres ajustes de
   sesión, para que un rol del mismo nombre creado después no los herede — y
   `DROP ROLE uellix_stripe`.
6. `REVOKE` de los tres *helpers* de RLS y del esquema desde
   `uellix_cap_stripe`, `REVOKE uellix_cap_stripe FROM uellix_owner`,
   `DROP ROLE uellix_cap_stripe`.
7. `DROP SCHEMA uellix_capability` **sólo si está vacío** — los cinco paquetes
   son independientes y otro puede tener objetos allí.

**Retención: qué queda y qué no.** La campaña crea cuatro tablas y sus
rollbacks retienen **dos**:

| Tabla | Paquete | Rollback | Por qué |
|---|---|---|---|
| `stripe_webhook_events` | 0008 | **RETENIDA** | Es el registro de qué eventos de facturación se aplicaron. Sin ella no se puede responder «¿se aplicó este cambio de plan?» en una disputa. Queda con `COMMENT` |
| `report_public_disclosures` | 0007 | **RETENIDA** | Cada fila es una decisión humana de publicar, con autor y fecha |
| `capability_verification_hits` | 0007 | eliminada | Contador agregado de la capacidad; sin ella no es evidencia de nada |
| `capability_bootstrap_attempts` | 0010 | eliminada | Sus filas completas duplican hechos ya en `audit_logs`; las incompletas son claves de idempotencia de una capacidad que deja de existir |

La retención **no es un descuido de simetría**: `tests/helpers/capability-gates.ts`
declara `RETAINED_TABLES` y `ROLLBACK_RETAINED_POLICIES`, y el gate
`rollback-retention` exige que el rollback *afirme* la supervivencia en su
postcondición, no que simplemente omita el `DROP`. Una omisión y una decisión
son indistinguibles si sólo se mira la ausencia de una sentencia.

**Además, fuera de banda:** revocar la credencial de `uellix_stripe`
(`UELLIX_STRIPE_DATABASE_URL`). `DROP ROLE` no invalida una cadena de conexión
que ya esté en un secreto de despliegue.

Tras el rollback el handler vuelve a 503 y Stripe vuelve a reintentar — el
mismo estado que hoy, que es fail-closed y ruidoso, no silencioso.

---

## 15. Threat model (FASE 12)

| Amenaza | Severidad | Mitigación | Residual |
|---|---|---|---|
| **Token theft** (fuga de `STRIPE_WEBHOOK_SECRET`) | **Crítica** | El secreto sólo lo lee este handler; no se comparte con otros webhooks; rotable en Stripe | Con el secreto, un atacante puede forjar eventos. Lo que **no** puede es leer nada: las RPC no devuelven datos |
| **Token theft** (fuga de `UELLIX_STRIPE_DATABASE_URL`) | **Alta** | El rol no tiene **ningún privilegio de tabla ni de columna** sobre las 38 relaciones de `public`, en los 4 modos DML (verificado por la postcondición del paquete); sólo `EXECUTE` sobre tres funciones que mueven cuota. Rotable sin tocar el runtime | Un atacante podría alterar cuotas. **No** puede leer clientes, proyectos ni evidencia. Nota: sí hereda `USAGE` sobre el esquema `public` de `PUBLIC` y eso no se puede evitar (§3, RR-CAP-7); nombrar una tabla sin privilegio sobre ella no sirve de nada |
| **Replay** | Media | `PRIMARY KEY (event_id)` + máquina de estados | Ninguno |
| **Brute force** | Baja | HMAC; rate limit sobre firmas inválidas | Ninguno |
| **Enumeration** | Media | Las RPC devuelven `claimed`/`duplicate`/`in_progress`, nunca si una organización existe. Un `org_not_resolved` se registra en la tabla, no se devuelve | Ninguno |
| **Cross-org** | **Alta** | La organización se resuelve **sólo** por `stripe_customer_id` o `stripe_subscription_id`, y ambas ramas exigen que *todos* los identificadores del evento concuerden con la fila que resolvieron. **La rama `client_reference_id` ya no existe** (DP-CAP-15): era el único camino por el que un valor elegido por el comprador llegaba a decidir a qué organización se aplica un plan | Si Stripe emitiera un evento con un `customer_id` ajeno, se aplicaría — pero eso exige comprometer Stripe. **Residual abierto: RR-CAP-10**, que es una vía preexistente por el ORM y no por esta capacidad |
| **Confused deputy** | **Alta** | `uellix_app` no tiene `EXECUTE`; ningún otro rol puede invocar la mutación de facturación | Ninguno |
| **Privilege escalation** | Alta | Sin `BYPASSRLS`, sin `CREATEROLE`, sin `CREATE`, sin membresías, sin `SET ROLE` | Ninguno |
| **Duplicate request** | Media | §9 | Ninguno |
| **Timeout** | **Media** | `statement_timeout=10s`, `idle_in_transaction_session_timeout=15s`; llamada a Stripe **fuera** de la transacción | El lease de 15 min (§9.1) |
| **Partial failure** | **Alta** | Los seis pasos de `apply` en una transacción. Nunca 200 antes del commit | Ninguno |
| **Log leakage** | **Alta** | Sin columna de payload; `last_error_code` es código, no mensaje; el log de la aplicación sólo emite `event.type` | Un `console.error(error)` con el objeto completo en el `catch` genérico del handler actual **sí** filtraría. Debe corregirse al reescribir: **RR-CAP-03-B** |
| **SQL injection** | Alta | Cero dinámico, todo parámetro ligado | Ninguno |
| **`search_path` injection** | Alta | `search_path=''`, todo cualificado | Ninguno |
| **Payload amplification** | Media | Cuerpo limitado a 1 MiB; el payload no se persiste | Ninguno |
| **Denial of service** | Media | Timeouts de rol; sin lock largo; sin llamada externa en transacción | Stripe puede inundar con reintentos legítimos |
| **Abuse automation** | Baja | Sin firma no se llega a la base | Ninguno |

---

## 16. Riesgos residuales

* **RR-CAP-03-A** — el lease de 15 min sobre `processing` (§9.1): un evento
  puede reprocesarse si un worker se cuelga más de 15 minutos con la
  transacción abierta. `idle_in_transaction_session_timeout = 15s` hace ese
  escenario muy improbable, pero el lease es una heurística, no una garantía.
  MINOR.
* **RR-CAP-03-B** — el `catch` genérico del handler actual registra el objeto
  de error completo. Debe pasar a registrar sólo `error.name` antes de
  habilitar, como ya hace la ruta de leads. MINOR, pero es **precondición de
  habilitación**.
* **RR-CAP-03-C** — DP-CAP-07 sin resolver: `stripe_webhook_events` crece sin
  límite. No es un riesgo de seguridad; es de coste.
* **RR-CAP-5** (global) — `uellix_stripe` es un rol `LOGIN` nuevo y Supabase
  gestionado puede no permitir crearlo. **No verificado**: prohibido acceder a
  remoto en esta unidad.
