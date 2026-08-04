# Modelo de capacidades públicas y preautenticadas

**Estado:** **DISEÑO. Nada aplicado. Ninguna capacidad habilitada.**
**Fecha:** 2026-08-03.
**Rama:** `codex/stella-g2-local-rehearsal`.
**Alcance:** las cinco superficies que quedaron cerradas en falso tras el
cutover de runtime (`stella_0005`) y que no tienen hoy ninguna vía de acceso.
**Depende de:** [`DATABASE_ROLE_MODEL.md`](DATABASE_ROLE_MODEL.md),
[`DATABASE_RUNTIME_CUTOVER.md`](DATABASE_RUNTIME_CUTOVER.md),
[`DATABASE_TARGET_SAFETY.md`](DATABASE_TARGET_SAFETY.md).

> Este documento **no** habilita ninguna capacidad, **no** aprueba G2, **no**
> declara grounding ejecutado y **no** autoriza aplicar SQL a ningún stack.
> Describe un diseño y las decisiones humanas que faltan para poder
> implementarlo.

---

## 0. Qué se verificó antes de diseñar (2026-08-03, stack local)

Todo lo que sigue se midió, no se supuso. Lectura por la capacidad
`readonly_audit` (`default_transaction_read_only = on` impuesto por el
servidor, host loopback, cero remoto).

| Hecho | Valor | Por qué importa para el diseño |
|---|---|---|
| Tablas en `public` | 38 | Línea base de precondición de todo paquete |
| Policies en `public` | 107 | Idem; cada paquete declara cuántas añade |
| Triggers append-only | 10 (5 fila + 5 truncate) | Ninguna capacidad los toca |
| Runtime real | `uellix_app` | Ninguna capacidad se concede a él directamente |
| `uellix_app` es miembro de | `uellix_writer` y de nada más | Su superficie se lee en un solo rol |
| `anon` tiene `USAGE` sobre `public` | **sí** | Nada nuevo puede ser `GRANT … TO anon` ni `TO PUBLIC` |
| `auth.uid()` existe | sí | Es la fuente de sujeto para CAP-01 y CAP-05 |
| `pg_catalog.sha256(bytea)` | disponible, 64 hex | **CAP-01 no necesita `pgcrypto`** |
| `pgcrypto` | instalada, en el esquema `extensions` | Se evita: exigiría cualificar un esquema ajeno bajo `search_path` fijo |
| Esquema `uellix_capability` | **no existe** | Nombre libre; ningún objeto actual colisiona |
| Roles `uellix_cap_*` / `uellix_stripe` | **no existen** | Nombres libres |
| Funciones `SECURITY DEFINER` en `public` | 7, todas de `uellix_owner` | Ninguna capacidad reutiliza ni modifica ninguna |
| `sroi_reports.verification_hash` | `UNIQUE` presente | El lookup por hash es puntual e indexado |
| `invitations.accepted_by` | **no existe** | CAP-01 necesita DDL para registrar quién aceptó |
| `sroi_reports.public_summary` | **no existe** | CAP-02 necesita un campo de publicación explícita |
| `marketing_leads` — grants | `uellix_writer` tiene `SELECT, INSERT, UPDATE, DELETE` | **El runtime ya tiene el privilegio**; lo que falta es la policy |
| `marketing_leads` — policies | `{anon}` INSERT, `{authenticated}` INSERT, `{authenticated}` SELECT super-admin | Ninguna alcanza a `uellix_app`: por eso falla cerrado |
| `marketing_leads` — constraint único | **ninguno** | Hoy los duplicados son posibles |

Dos consecuencias de esa tabla merecen decirse en voz alta:

1. **CAP-04 no falla por falta de privilegio, falla por falta de policy.**
   `uellix_writer` ya tiene DML completo sobre `marketing_leads`. Un diseño que
   se limitara a "añadir la policy que falta" reabriría de golpe `SELECT`,
   `UPDATE` y `DELETE` públicos por la puerta del runtime. El diseño de CAP-04
   va en la dirección contraria: la policy se concede **sólo** al rol de
   capacidad, y el exceso de privilegio de `uellix_writer` sobre esa tabla se
   recorta en el mismo paquete.

2. **`super_admins_read_marketing_leads` también está roto**, por la misma
   razón y sin que nadie lo haya registrado: es `TO authenticated`, y el
   runtime no es `authenticated`. Un super admin que abra la lista de leads
   desde la aplicación lee cero filas. Queda anotado como hallazgo colateral de
   este diseño (**RR-CAP-6**), no como parte de ninguna capacidad.

---

## 1. La tesis: una capacidad no es un rol, y cinco capacidades no son un rol

El error que este documento existe para no cometer es el que ya se cometió una
vez en este repositorio y que `stella_0005c` tuvo que reparar: **una policy sin
`TO` es `TO PUBLIC`**, y una identidad técnica genérica es una policy sin `TO`
con otro nombre. La tentación aquí es evidente y hay que nombrarla para
descartarla: *"crea un rol `uellix_public` con lo que necesitan las cinco
superficies"*. Eso produce un rol que puede aceptar invitaciones, leer
reportes, mover cuotas de facturación, insertar leads y crear organizaciones.
Comprometer cualquiera de los cinco endpoints daría los cinco poderes.

El modelo es el opuesto:

> Una **capacidad** es una función con nombre propio, un rol propietario propio
> sin sesión, un conjunto de grants propio, y una lista de ejecutores propia.
> Habilitar una no habilita ninguna otra, y eso es demostrable por catálogo.

Las cinco capacidades no comparten **ningún** objeto salvo el esquema que las
contiene y la convención de errores. En particular no comparten rol, no
comparten función, no comparten policy y no comparten grant.

### 1.1 Las tres capas de una capacidad

```
  ┌──────────────────────────────────────────────────────────────┐
  │ 1. EJECUTOR — quién puede llamar                             │
  │    GRANT EXECUTE ON FUNCTION … TO <un solo rol>              │
  │    REVOKE ALL … FROM PUBLIC                                  │
  └──────────────────────────────────────────────────────────────┘
                             │ llama
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ 2. FUNCIÓN — qué se puede hacer exactamente                  │
  │    SECURITY DEFINER, search_path = '' , todo cualificado     │
  │    La NARROWNESS vive aquí: validación, bloqueo, unicidad,   │
  │    idempotencia, auditoría, error uniforme                   │
  └──────────────────────────────────────────────────────────────┘
                             │ se ejecuta como
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ 3. DEFINER — sobre qué recursos, con qué privilegio          │
  │    Rol NOLOGIN, cero miembros, sin BYPASSRLS                 │
  │    Grants a NIVEL DE COLUMNA sobre las tablas mínimas        │
  │    Sujeto a RLS: una policy por (tabla, rol, operación)      │
  └──────────────────────────────────────────────────────────────┘
```

La capa 3 merece una defensa explícita, porque a primera vista parece débil:
las policies que admiten al rol definer son necesariamente amplias (no pueden
ver los argumentos de la función, así que un `USING (true)` es habitual). La
respuesta es que **la policy no es la frontera**: el rol definer es `NOLOGIN`,
tiene cero miembros, y ningún rol del sistema puede `SET ROLE` a él salvo
nadie: los roles de capacidad tienen **cero miembros**, así que no existe
cadena de conexión, sesión ni JWT que resuelva a uno de ellos, ni directamente
ni por transitividad. (Un superusuario siempre puede, inherentemente.) **La única forma de
ejecutar con sus privilegios es atravesar el cuerpo de la función**, y el
cuerpo de la función es la frontera real.

Lo que sí hace la capa 3 es acotar el daño de un fallo en la capa 2: si el
cuerpo de la función tuviera un bug lógico, el rol definer sigue sin poder
tocar una tabla sobre la que no tiene grant, ni una columna sobre la que no
tiene grant. Por eso los grants son **a nivel de columna** siempre que la
operación lo permita. Es contención, no autorización.

### 1.2 Por qué RLS se deja activa para los roles de capacidad

Sería más simple hacer que cada rol de capacidad fuera owner de las tablas que
toca, o darle `BYPASSRLS`. Ninguna de las dos se hace:

* **Owner** implicaría que el rol puede `DROP POLICY`, `DISABLE TRIGGER` y
  `ALTER TABLE`. La capacidad de aceptar invitaciones no debe poder apagar los
  triggers append-only de `audit_logs`.
* **`BYPASSRLS`** convierte la ausencia de una policy en un permiso silencioso.
  El repositorio ya vivió esa forma de fallo (`service_role` local con
  `BYPASSRLS`, cerrado por `stella_0005c`) y la lección quedó escrita: *para
  ese rol el texto de la policy nunca fue la valla; el GRANT lo era*.

Con RLS activa, olvidar una policy hace que la capacidad **falle cerrada** en
vez de funcionar de más. Ese es el comportamiento que se quiere en un diseño
que aún no ha sido probado contra un stack real.

---

## 2. El modelo común de decisión (FASE 3)

Las doce preguntas, respondidas por capacidad. Esta tabla es el resumen; cada
fila está desarrollada en el documento de su capacidad.

| # | Pregunta | CAP-01 Invitación | CAP-02 Verificación | CAP-03 Stripe | CAP-04 Lead | CAP-05 Bootstrap |
|---|---|---|---|---|---|---|
| 1 | ¿Quién presenta la capacidad? | El invitado, autenticado, con el token del enlace | Cualquier visitante, con el hash | Stripe, con la firma del webhook | Cualquier visitante, sin nada | Un usuario autenticado sin membresía |
| 2 | ¿Cómo se valida? | SHA-256 del token comparado en BD contra `token_hash` | Igualdad exacta contra `verification_hash` (único, indexado) | `constructEvent()` **antes** de tocar BD | Sólo esquema + antiabuso; no hay credencial | `auth.uid()` + allowlist leída por el definer |
| 3 | ¿Qué operación exacta permite? | Crear **una** membresía y cerrar **esa** invitación | Leer los campos **publicados** de **un** reporte | Mover cuota/plan de **una** organización por `stripe_*_id` | Insertar **una** fila de lead | Crear **una** organización con su membresía owner |
| 4 | ¿Sobre qué recurso? | La fila cuyo `token_hash` coincide | La fila `locked` **con disclosure aprobada** | La organización que casa por `stripe_customer_id`/`stripe_subscription_id` | `marketing_leads` | Una organización nueva + su membresía |
| 5 | ¿Durante cuánto tiempo? | Hasta `expires_at` (7 días hoy) | Mientras la disclosure siga aprobada y el reporte `locked` | Vida del evento en Stripe | N/A (un solo uso) | Vida de la clave de idempotencia (24 h) |
| 6 | ¿Puede reutilizarse? | **No** para crear una segunda membresía; **sí** de forma idempotente por el mismo sujeto | Sí, ilimitadamente — es de sólo lectura | Sí: el reintento es el contrato de Stripe | No: colisión → no-op | Sí con la misma clave → devuelve la misma organización |
| 7 | ¿Cómo se evita replay? | `FOR UPDATE` + estado `pending` + `accepted_by` | No aplica (sin efecto) | `PRIMARY KEY (event_id)` con `INSERT … ON CONFLICT` atómico | Índice único `(lower(email), source)` | Índice único `(user_id, idempotency_key)` |
| 8 | ¿Cómo se limita? | Por IP y por sujeto, en el endpoint | Por IP, en el endpoint | Por firma; no hay límite por IP (Stripe reintenta) | Por IP + honeypot + límite global | Por sujeto (`auth.uid()`), muy bajo |
| 9 | ¿Qué queda auditado? | `audit_logs`: invitación aceptada + membresía creada | Contador diario agregado, sin PII | `stripe_webhook_events` + `audit_logs` con **tipo**, nunca payload | Sólo un contador diario | `audit_logs`: organización + membresía |
| 10 | ¿Qué ocurre en retry? | Mismo sujeto → éxito idempotente; otro sujeto → error uniforme | Misma respuesta | `duplicate` → 200 sin reprocesar | No-op → misma respuesta de éxito | Misma organización, sin duplicar |
| 11 | ¿Y si el efecto externo y la transacción divergen? | El correo ya salió; el token sigue siendo válido hasta expirar | No hay efecto externo | Se resuelve a favor de Stripe: 5xx y reintento; nunca 200 sin commit | El correo de marketing se dispara **después** del commit | Sin efecto externo dentro de la transacción |
| 12 | ¿Qué datos mínimos devuelve? | `organization_id`, `role` | Los campos de disclosure y nada más | `claimed` / `duplicate` / `failed` | `void` | `organization_id`, `slug` |

### 2.1 La regla de error uniforme

Las cinco capacidades comparten **una convención**, no una implementación:

> Toda condición de rechazo que un atacante podría usar para distinguir
> "no existe" de "existe pero no es tuyo" devuelve **el mismo** `SQLSTATE` y
> **el mismo** mensaje. La distinción se escribe en la auditoría del servidor,
> nunca en la respuesta.

`SQLSTATE` reservado: `U0001` (`capability_denied`), con mensaje fijo
`capability request denied`. No lleva detalle, ni `HINT`, ni el argumento que
falló.

> **Precisión (revisión adversarial).** Un borrador afirmaba que cada capacidad
> emite el error *"desde exactamente un punto de su cuerpo, para que no haya dos
> rutas de error con latencias distintas"*. **Es falso**, y la conclusión no se
> seguía de la premisa aunque lo fuera. `accept_invitation` lanza `U0001` desde
> siete puntos y `bootstrap_organization` desde seis, a profundidades distintas.
> Lo que sí se afirma, y se verifica, es: **el mismo SQLSTATE y el mismo mensaje
> desde todos los puntos de rechazo**, sin `HINT` ni `DETAIL`. El número de
> sentencias ejecutadas antes del rechazo se iguala **sólo** donde el documento
> de la capacidad lo dice (CAP-01 §14.1, RR-CAP-01-A).

Además, cada función `plpgsql` lleva un bloque `EXCEPTION` que colapsa en
`U0001` cualquier SQLSTATE que produzca el motor. Sin él la uniformidad valía
sólo para los caminos que el autor enumeró, no para los que produce PostgreSQL:
un `23505` llega al llamante con su `DETAIL`, y el `DETAIL` **cita valores de
fila** — un id de usuario real, o un identificador de suscripción de Stripe.

Esto tiene un coste de usabilidad real y no se oculta: hoy `acceptInvitation`
distingue cuatro casos ("inválida", "ya no es válida", "expirada", "otro
correo") y esa distinción es útil para el usuario legítimo. Convertirla en un
único mensaje es una **decisión de producto** (DP-CAP-02), no una elección
técnica que se pueda tomar aquí.

---

## 3. Estándar `SECURITY DEFINER` (FASE 9)

Todo objeto propuesto en este diseño cumple, sin excepción:

| # | Regla | Cómo se verifica |
|---|---|---|
| 1 | El owner es un rol `NOLOGIN`, sin `BYPASSRLS`, sin `CREATEROLE`, sin `CREATEDB`, sin `SUPERUSER` | `pg_roles` |
| 2 | El owner tiene **cero miembros, sin excepción** | `pg_auth_members` (la postcondición aborta si hay uno) |
| 3 | `SET search_path = ''` en la propia función | `pg_proc.proconfig` |
| 4 | **Toda** referencia va cualificada por esquema, incluidos `pg_catalog` y `public` | Lint estático sobre el SQL |
| 5 | `REVOKE ALL ON FUNCTION … FROM PUBLIC` inmediatamente tras crearla | `pg_proc.proacl` |
| 6 | `GRANT EXECUTE` a **exactamente un** rol nombrado | `aclexplode` |
| 7 | Cero SQL dinámico: ningún `EXECUTE` que no sea `EXECUTE FUNCTION` de un trigger | Lint estático |
| 8 | Cero concatenación de identificadores | Lint estático |
| 9 | Ni `organization_id` ni el actor llegan por parámetro cuando pueden derivarse | Revisión de firma |
| 10 | Validación de `auth.uid()` donde aplique, con rechazo uniforme si es `NULL` | Cuerpo |
| 11 | La función es `STABLE` si no escribe, `VOLATILE` si escribe — nunca `IMMUTABLE` | `pg_proc.provolatile` |
| 12 | Errores por `RAISE EXCEPTION … USING ERRCODE = 'U0001'`, mensaje fijo | Cuerpo |

### 3.1 Por qué `search_path = ''` y no `search_path = public, pg_temp`

`SET search_path = public, pg_temp` es el consejo habitual y **no es
suficiente** aquí. Con `pg_temp` en la ruta, un llamante que pueda crear
objetos temporales puede plantar una función o un operador temporal que
sombree a uno del esquema `public`, y la función `SECURITY DEFINER` lo
ejecutaría con los privilegios del definer. La ruta vacía elimina `public` de
la resolución.

> **Precisión (segunda ronda).** Un borrador decía que la ruta vacía deja "nada
> que sombrear". No es exacto: PostgreSQL **nunca** busca `pg_temp` para
> nombres de función ni de operador —esa es una regla del motor, no de la
> ruta—, y en cambio **sí** lo consulta, implícitamente y en primer lugar, para
> nombres de relación y de tipo. Lo que cierra la clase que este documento
> describe es esa regla del motor más la disciplina de cualificar **toda**
> relación; la ruta vacía añade la eliminación de `public`. Queda como
> superficie residual el nombre de tipo sin cualificar (`text`, `uuid`,
> `jsonb`) en los `DECLARE` y los casts, resoluble por un llamante con `TEMP`
> sobre la base — explotabilidad muy baja, pero la afirmación anterior era más
> fuerte de lo que la construcción sostiene.

`pg_catalog` sigue siendo alcanzable implícitamente, pero se cualifica de todas
formas (`pg_catalog.sha256`, `pg_catalog.now`, `pg_catalog.lower`), porque la
regla "todo cualificado" es verificable por lint y "casi todo cualificado" no
lo es.

Consecuencia práctica que hay que aceptar: **los operadores también se
resuelven por `search_path`**. Con la ruta vacía, `a = b` sobre tipos no
built-in fallaría. Las cinco capacidades sólo comparan `uuid`, `text`,
`varchar`, `timestamp` y `boolean`, todos de `pg_catalog`, así que el operador
resuelve. Cualquier extensión futura de estas funciones a un tipo de extensión
(por ejemplo `citext` o `vector`) **rompería**, y eso es deseable: rompe en
tiempo de aplicación del paquete, no en producción.

### 3.2 Por qué `SECURITY DEFINER` y no otra cosa, capacidad por capacidad

No se usa por defecto. Se usa donde la alternativa es peor, y se dice cuál era
la alternativa:

| Capacidad | ¿Definer? | Alternativa descartada y por qué |
|---|---|---|
| CAP-01 | **Sí** | Una policy que permitiera a `authenticated` leer invitaciones por `token_hash` obligaría a exponer `token_hash` al cliente para que filtrara — es decir, a convertir la tabla en enumerable |
| CAP-02 | **Sí** | Una vista con RLS `TO uellix_app USING (status='locked')` permitiría `SELECT … WHERE organization_id = …` y `LIMIT/OFFSET`: un oráculo de listado sobre todos los reportes publicados |
| CAP-03 | **Sí**, y además rol `LOGIN` propio | Ver §4 |
| CAP-04 | **Sí** | Una policy `INSERT` sobre `marketing_leads` para el runtime reabre la tabla al runtime entero, que ya tiene `SELECT/UPDATE/DELETE` |
| CAP-05 | **Sí** | Una policy de auto-inserción en `organization_members` es exactamente lo que el comentario de `members_insert_admin` rechazó en su día: *"permitiría a cualquier usuario unirse a cualquier organización"* |

---

## 4. CAP-03: la única capacidad con identidad de conexión propia

Las otras cuatro se ejecutan **desde `uellix_app`**: el usuario llega por HTTP
al runtime, y el runtime llama a la función. Stripe es distinta y merece la
justificación explícita que pide la FASE 6.

**Determinación: hacen falta las dos cosas — un rol `LOGIN` separado *y* una
RPC `SECURITY DEFINER`.** Ninguna de las dos por sí sola basta:

* **Sólo la RPC (llamada desde `uellix_app`)** no basta porque entonces el
  `EXECUTE` sobre la mutación de facturación cuelga del runtime general.
  Cualquier ruta con RCE en la aplicación, o cualquier futuro endpoint que se
  olvide de comprobar algo, hereda la capacidad de mover cuotas y planes. La
  credencial de facturación no sería rotable ni revocable por separado, y en
  `pg_stat_activity` el tráfico de facturación sería indistinguible del resto.

* **Sólo el rol `LOGIN` (con grants directos)** no basta porque para actualizar
  `organizations` necesitaría `UPDATE` sobre esa tabla, y `UPDATE` sobre
  `organizations` no se puede acotar por columna de forma que impida cambiar
  `name`, `slug` o `status`. Además necesitaría `SELECT` para encontrar la
  organización por `stripe_customer_id`, y `SELECT` sobre `organizations` es
  la lista completa de clientes.

La combinación sí funciona, y produce una propiedad verificable:

> `uellix_stripe` no tiene **ningún** privilegio —ni de tabla ni de columna—
> sobre ninguna relación de `public`, en ninguno de los siete modos. Sus únicos
> privilegios **concedidos** son `USAGE` sobre `uellix_capability` y `EXECUTE`
> sobre tres funciones. Un volcado de su credencial no permite leer un solo
> dato SROI.
>
> *Alcance de la verificación, corregido en la segunda ronda:* la postcondición
> barre `public` y `uellix_capability`. **No** barre `extensions`, `storage`,
> `auth`, `realtime` ni `vault`, donde las funciones de extensión nacen con
> `EXECUTE TO PUBLIC` y el rol las hereda igual que hereda `USAGE` sobre
> `public` (§4.1). La propiedad efectiva —cero acceso a datos SROI o de
> cliente— se sostiene; la literal "en toda la base" no estaba verificada y se
> retira.

*Verificación:* `has_any_column_privilege` sobre las 38 tablas, para los cuatro
modos DML, más `aclexplode` sobre `uellix_capability`.

### 4.1 Una afirmación más fuerte que NO es cierta, y por qué se descarta

Un borrador previo de este documento afirmaba que `uellix_stripe` *"no tiene
`USAGE` sobre `public` y literalmente no puede nombrar `public.projects`"*.
**Es falso**, y conviene dejar escrito por qué para que nadie lo reintroduzca.

Medido el 2026-08-03, el ACL del esquema `public` es:

```
{pg_database_owner=UC/…, =U/…, postgres=U/…, anon=U/…, authenticated=U/…,
 service_role=U/…, uellix_owner=UC/…, uellix_migrator=U/…, uellix_app=U/…,
 uellix_writer=U/…, uellix_auditor=U/…}
```

La entrada `=U/…` —grantee vacío— **es `PUBLIC`**. Todo rol nuevo, incluido
`uellix_stripe`, hereda `USAGE` sobre `public` en el momento de crearse. Y los
ACL de PostgreSQL son **aditivos**: no existe un "deny" por rol, así que no se
puede retirar a un rol concreto lo que `PUBLIC` concede.

La única forma de hacer cierta aquella frase sería
`REVOKE USAGE ON SCHEMA public FROM PUBLIC`. Es técnicamente viable —los once
roles nombrados tienen ya un grant explícito, así que ninguno lo perdería—
pero alcanzaría a los roles internos de Supabase que **no** aparecen en la
lista (`supabase_auth_admin`, `supabase_storage_admin`, `authenticator`,
`dashboard_user`, `pgbouncer`…) y que hoy dependen de la entrada `PUBLIC`.
Eso es un cambio de privilegio global sobre el esquema entero.

**No se toma en un paquete de capacidad.** Se registra como hardening candidato
(**RR-CAP-7**), con su propio análisis de impacto, fuera de esta unidad. La
propiedad que sí se afirma —cero privilegio sobre cero tablas— es más débil en
la forma pero igual de efectiva en el fondo: poder nombrar una tabla sobre la
que no se tiene ningún privilegio no sirve de nada.

---

## 5. Matriz de roles y grants (FASE 10)

Leyenda: `S`=SELECT `I`=INSERT `U`=UPDATE `D`=DELETE `X`=EXECUTE `Us`=USAGE
`—`=nada. «col» = grant restringido a columnas nombradas.
**Ningún** rol de esta matriz recibe `TRUNCATE`, `REFERENCES`, `TRIGGER`,
`MAINTAIN`, `CREATE`, `BYPASSRLS`, `CREATEROLE` ni `SET ROLE` a otro rol.

### 5.1 Atributos de los roles nuevos

| Rol | LOGIN | Miembros | BYPASSRLS | CREATEROLE | Owner de | Alcanzable por |
|---|---|---|---|---|---|---|
| `uellix_cap_invitation` | **no** | **ninguno** | no | no | las funciones de CAP-01 | sólo la función |
| `uellix_cap_verification` | **no** | **ninguno** | no | no | las funciones de CAP-02 | sólo la función |
| `uellix_cap_stripe` | **no** | **ninguno** | no | no | las funciones de CAP-03 | sólo la función |
| `uellix_cap_lead` | **no** | **ninguno** | no | no | las funciones de CAP-04 | sólo la función |
| `uellix_cap_bootstrap` | **no** | **ninguno** | no | no | las funciones de CAP-05 | sólo la función |
| `uellix_stripe` | **sí** | ninguno | no | no | nada | su propia cadena de conexión |

**Ningún rol es miembro de un rol de capacidad. Ninguno.**

Un borrador de este documento —y de los cinco paquetes— concedía
`uellix_cap_* TO uellix_owner WITH INHERIT FALSE, SET TRUE`, para que el owner
pudiera transferirles la propiedad de cada función. La revisión adversarial
mostró por qué eso era un agujero y no un detalle: **`SET ROLE` es
transitivo**. `uellix_migrator` es un rol `LOGIN`, alcanza `uellix_owner` por
`SET ROLE`, y desde ahí habría alcanzado los cinco roles de capacidad en dos
sentencias — mientras este documento afirmaba que ninguna cadena de conexión
resuelve a un rol de capacidad. La postcondición de entonces sólo miraba
miembros **directos**, así que pasaba.

La transferencia de propiedad se hace ahora en la ventana de superusuario, con
lo que **nadie necesita ser miembro**, y las cinco postcondiciones abortan si
encuentran uno. La afirmación de §1.1 pasa a ser cierta.

> Un operador que implementara la versión anterior de esta regla **abortaría el
> paquete**: `IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = <cap>)
> THEN RAISE EXCEPTION '… has a member; it must have none.'`

### 5.2 Objeto por objeto

#### CAP-01 — invitaciones

| Objeto | `anon` | `authenticated` | `uellix_app` | `uellix_stripe` | `uellix_cap_invitation` | otros `uellix_cap_*` | `uellix_owner` | `uellix_migrator` | `uellix_auditor` | `PUBLIC` |
|---|---|---|---|---|---|---|---|---|---|---|
| esquema `uellix_capability` | — | — | `Us` | `Us` | `Us` | `Us` | owner | — | — | **—** |
| `uellix_capability.accept_invitation(text)` | — | — | **`X`** | — | — | — | — | — | — | **—** |
| `public.invitations` | — | (preexistente) | (preexistente vía writer) | — | `S`«col» + `U`«col» | — | owner | — | `S` | — |
| `public.organization_members` | — | (preexistente) | (preexistente vía writer) | — | `I`«col» | — | owner | — | `S` | — |
| `public.audit_logs` | — | sin INSERT (0005c) | `S,I` vía writer | — | `I`«col» | — | owner | — | `S` | — |
| `public.users` | — | (preexistente) | (preexistente) | — | `S(id,email)` | — | owner | — | `S` | — |
| RLS sobre las cuatro | activa | activa | activa | activa | **activa** | activa | activa (no forzada) | — | activa | — |

#### CAP-02 — verificación pública

| Objeto | `anon` | `authenticated` | `uellix_app` | `uellix_stripe` | `uellix_cap_verification` | otros `uellix_cap_*` | `PUBLIC` |
|---|---|---|---|---|---|---|---|
| `uellix_capability.verify_report(text)` | — | — | **`X`** | — | — | — | **—** |
| `uellix_capability.record_verification_hit(text)` | — | — | **`X`** | — | — | — | **—** |
| `public.sroi_reports` | — | (preex.) | (preex.) | — | `S`«col» | — | — |
| `public.report_public_disclosures` (nueva) | — | — | — | — | `S`«col» | — | — |
| `public.organizations` | — | (preex.) | (preex.) | — | `S(id,name,slug)` | — | — |
| `public.projects` | — | (preex.) | (preex.) | — | **—** | — | — |
| `public.sroi_calculation_runs` | — | (preex.) | (preex.) | — | `S`«col» *sólo si DP-CAP-05 lo aprueba* | — | — |
| `public.evidence_items` | — | (preex.) | (preex.) | — | **— nunca** | — | — |
| `public.capability_verification_hits` (nueva) | — | — | — | — | `I,U`«col» *(sólo `record_…`)* | — | — |

#### CAP-03 — Stripe

| Objeto | `anon` | `authenticated` | `uellix_app` | **`uellix_stripe`** | `uellix_cap_stripe` | otros `uellix_cap_*` | `PUBLIC` |
|---|---|---|---|---|---|---|---|
| esquema `uellix_capability` | — | — | `Us` | **`Us`** | `Us` | `Us` | — |
| esquema `public` | `Us` (preex.) | `Us` (preex.) | `Us` (preex.) | `Us` **heredado de PUBLIC — ver §4.1** | `Us` | `Us` | `Us` (preex.) |
| `uellix_capability.stripe_begin_event(text,text)` | — | — | — | **`X`** | — | — | — |
| `uellix_capability.stripe_apply_subscription(...)` | — | — | — | **`X`** | — | — | — |
| `uellix_capability.stripe_fail_event(text,text)` | — | — | — | **`X`** | — | — | — |
| `public.organizations` | — | (preex.) | (preex.) | **—** | `S(id,stripe_*)` + `U(stripe_price_id, stella_monthly_quota, stella_plan_label, stripe_customer_id, stripe_subscription_id, updated_at)` | — | — |
| `public.stripe_webhook_events` (nueva) | — | — | — | **—** | `S,I,U`«col» | — | — |
| `public.audit_logs` | — | sin INSERT | `S,I` | **—** | `I`«col» | — | — |
| `public.projects`, `sroi_*`, `evidence_*`, `stella_*` | — | (preex.) | (preex.) | **— ningún privilegio de tabla ni de columna** (tiene `USAGE` sobre `public` heredado de `PUBLIC`, §4.1 / RR-CAP-7) | **—** | — | — |

#### CAP-04 — lead público

| Objeto | `anon` | `authenticated` | `uellix_app` | `uellix_cap_lead` | otros `uellix_cap_*` | `PUBLIC` |
|---|---|---|---|---|---|---|
| `uellix_capability.submit_lead(text,text,text,text)` | — | — | **`X`** | — | — | **—** |
| `public.marketing_leads` | INSERT por policy *(se retira)* | INSERT por policy *(se retira)* | **`I` revocado; `S`/`U`/`D` revocados** | **`I`«col» y nada más** | — | — |
| policy `cap_lead_insert` | — | — | — | **única aplicable** | — | — |

`uellix_cap_lead` **no tiene `SELECT`** sobre `marketing_leads`. La función usa
`ON CONFLICT DO NOTHING` sin `RETURNING`, así que no necesita leer. La
capacidad que escribe leads no puede enumerarlos: eso es una propiedad del
grant, no una promesa del código.

#### CAP-05 — bootstrap de organización

| Objeto | `anon` | `authenticated` | `uellix_app` | `uellix_cap_bootstrap` | otros `uellix_cap_*` | `PUBLIC` |
|---|---|---|---|---|---|---|
| `uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)` | — | — | **`X`** | — | — | **—** |
| `public.organizations` | — | (preex.) | (preex.) | `S(id,slug)` + `I`«col» | — | — |
| `public.organization_members` | — | (preex.) | (preex.) | `S(user_id,status)` + `I`«col» | — | — |
| `public.signup_allowlist` | — | (preex. super-admin) | (preex.) | `S`«col» | — | — |
| `public.audit_logs` | — | sin INSERT | `S,I` | `I`«col» | — | — |
| `public.capability_bootstrap_attempts` (nueva) | — | — | — | `S,I,U`«col» | — | — |

### 5.3 La demostración de aislamiento

La matriz anterior demuestra la propiedad que pide la FASE 10 — *habilitar una
capacidad no habilita otra* — por cuatro vías independientes, y cada una se
comprueba con una consulta de catálogo distinta:

1. **Disyunción de ejecutores.** `uellix_stripe` tiene `EXECUTE` sobre las tres
   funciones de CAP-03 y sobre **ninguna** otra. `uellix_app` tiene `EXECUTE`
   sobre las de CAP-01, 02, 04 y 05 y sobre **ninguna** de CAP-03.
   *Verificación:* `aclexplode(proacl)` sobre `uellix_capability`.

2. **Disyunción de definers.** Cinco roles distintos, cada uno propietario de
   las funciones de una sola capacidad. Ningún rol de capacidad es miembro de
   otro. *Verificación:* `pg_proc.proowner` × `pg_auth_members`.

3. **Disyunción de grants.** La intersección de las tablas alcanzables por dos
   roles de capacidad cualesquiera es vacía o está restringida a columnas
   disjuntas. El caso no vacío es `audit_logs` — tres capacidades insertan en
   él —, y ahí el aislamiento lo dan tres `WITH CHECK` mutuamente excluyentes
   por **`entity_type`, prefijo de `action` y nulidad de `actor_user_id`**
   (`cap_stripe_insert_audit` exige actor `NULL` y `action` con prefijo
   `stripe.`; las otras dos exigen actor **no** nulo y listas de acciones
   disjuntas). *Verificación:* `aclexplode(relacl)` + `pg_attribute` ACL +
   `pg_policies.with_check`.

   > **Precisión (revisión adversarial).** Un borrador decía que ese aislamiento
   > lo da un `WITH CHECK` que *"ata la fila a la organización que la función
   > acaba de tocar"*. Ninguna de las tres policies menciona `organization_id`,
   > y no puede: una policy no ve las variables locales de la función que la
   > invoca. La atadura a la organización vive en el cuerpo. Por eso el punto 4
   > de esta lista se limita a lo que **sí** es comprobable por catálogo.

4. **Cero privilegio del actor externo.** `uellix_stripe` no tiene ningún
   privilegio, de tabla ni de columna, sobre ninguna de las 38 tablas de
   `public`, en ninguno de los cuatro modos DML. Tiene `USAGE` sobre `public`
   heredado de `PUBLIC` y eso no se puede evitar (§4.1), pero nombrar una tabla
   sobre la que no se tiene privilegio no sirve de nada.
   *Verificación:* `has_any_column_privilege` × 38 tablas × 4 modos.

Los puntos 1, 2 y 4 no dependen de leer el cuerpo de ninguna función: son
propiedades del catálogo. El punto 3 lo es en su parte de grants; su parte de
`audit_logs` se apoya en tres `WITH CHECK` disjuntos, que también están en el
catálogo — pero la atadura de cada fila a **su** organización vive en el cuerpo
de la función, y eso se dice aquí en vez de dejarlo implícito.

---

## 6. Lo que este diseño NO hace

Enumerado para que la ausencia sea deliberada y no un olvido:

* No concede membresía de `uellix_app` en `authenticated`, ni al revés.
* No usa `service_role` como identidad de nada.
* No crea ninguna policy ni grant `TO PUBLIC` ni `TO anon` sobre tablas internas.
* No concede acceso directo a tabla a ningún actor externo: **todo** pasa por
  una función.
* No toca los 10 triggers append-only, ni las 107 policies existentes, salvo
  las **dos** de `marketing_leads` que CAP-04 retira explícitamente
  (`anon_insert_marketing_leads` y `authenticated_insert_marketing_leads`). La
  tercera, `super_admins_read_marketing_leads`, se conserva a propósito y la
  postcondición del paquete falla si desaparece (RR-CAP-6 / RC-13).
* No aplica nada a ningún stack. Los paquetes viven en `db/prepared/` y son
  inertes por construcción (`tests/prepared-sql-source-of-truth.test.ts`).
* No habilita ninguna capacidad: los cinco paquetes dejan su superficie
  **deshabilitada** y las constantes de la aplicación
  (`WEBHOOK_DATABASE_IDENTITY_AVAILABLE`, `LEAD_CAPTURE_POLICY_AVAILABLE`)
  siguen en `false`.

---

## 7. Índice de capacidades

| ID | Documento | Paquete forward | Rollback | Estado |
|---|---|---|---|---|
| CAP-01 | [`capabilities/CAP_01_INVITATIONS.md`](capabilities/CAP_01_INVITATIONS.md) | `stella_0006_invitation_capability.sql` | `stella_0006_rollback.sql` | diseñado, no aplicado |
| CAP-02 | [`capabilities/CAP_02_PUBLIC_VERIFICATION.md`](capabilities/CAP_02_PUBLIC_VERIFICATION.md) | `stella_0007_public_verification_capability.sql` | `stella_0007_rollback.sql` | diseñado, no aplicado |
| CAP-03 | [`capabilities/CAP_03_STRIPE.md`](capabilities/CAP_03_STRIPE.md) | `stella_0008_stripe_webhook_identity.sql` | `stella_0008_rollback.sql` | diseñado, no aplicado |
| CAP-04 | [`capabilities/CAP_04_PUBLIC_LEADS.md`](capabilities/CAP_04_PUBLIC_LEADS.md) | `stella_0009_public_lead_capability.sql` | `stella_0009_rollback.sql` | diseñado, no aplicado |
| CAP-05 | [`capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md`](capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md) | `stella_0010_organization_bootstrap_capability.sql` | `stella_0010_rollback.sql` | diseñado, no aplicado |

### 7.1 Dependencias entre paquetes

```
  stella_0005c (aplicado, local)
        │
        ├── stella_0006  CAP-01   independiente
        ├── stella_0007  CAP-02   independiente
        ├── stella_0008  CAP-03   independiente
        ├── stella_0009  CAP-04   independiente
        └── stella_0010  CAP-05   independiente
```

**No hay dependencias entre los cinco.** Es una propiedad buscada: cada uno
declara como precondición el estado post-`0005c` (38 tablas, 107 policies,
10 triggers) y **no** el estado post-otro-paquete. Se pueden aplicar en
cualquier orden, o sólo algunos, o revertir uno sin tocar los demás. El precio
es que cada paquete crea el esquema `uellix_capability` con
`CREATE SCHEMA IF NOT EXISTS` y el rollback **no** lo borra salvo que quede
vacío — detalle desarrollado en cada rollback.

---

## 8. Decisiones de producto pendientes (FASE 14)

**Ninguna de estas se inventa aquí.** El diseño está construido para que la
respuesta *más cerrada* sea la que funciona por defecto, de modo que una
decisión no tomada nunca abre nada.

| ID | Decisión | Opciones | Por defecto en el diseño | Bloquea |
|---|---|---|---|---|
| **DP-CAP-01** | ¿El invitado debe estar autenticado antes de aceptar? | (a) sí, como hoy; (b) el token preautentica y crea la cuenta | **(a)** | CAP-01 |
| **DP-CAP-02** | ¿Error uniforme o mensajes distinguibles al aceptar? | (a) uniforme; (b) distinguible; (c) uniforme + código de soporte | **(a)** | CAP-01 |
| **DP-CAP-03** | Expiración del token de invitación | hoy 7 días | 7 días, sin cambiar | CAP-01 |
| **DP-CAP-04** | ¿Qué se muestra en la verificación pública? | título, nombre de organización, resumen, fecha | **nada sin disclosure aprobada** | CAP-02 |
| **DP-CAP-05** | ¿Las cifras SROI son públicas? | (a) ninguna; (b) sólo el ratio; (c) ratio + totales | **(a)** | CAP-02 |
| **DP-CAP-06** | ¿El PDF público sigue existiendo? | (a) se retira; (b) se reduce a los campos publicados | **(a)** | CAP-02 |
| **DP-CAP-07** | Retención de `stripe_webhook_events` | 90 días / 1 año / indefinido | **sin purga automática**; se diseña la función, no se programa | CAP-03 |
| **DP-CAP-08** | Campos admitidos del lead | los 4 actuales / + consentimiento | **los 4 actuales** | CAP-04 |
| **DP-CAP-09** | Consentimiento y base legal del lead | texto + versión almacenada / nada | **columna `consent_version` creada y `NOT NULL` diferido** | CAP-04 |
| **DP-CAP-10** | Retención de leads | 12/24 meses / indefinido | **sin purga automática** | CAP-04 |
| **DP-CAP-11** | ¿Duplicados de lead se colapsan? | (a) sí, silenciosamente; (b) se acumulan | **(a)** | CAP-04 |
| **DP-CAP-12** | ¿Quién puede crear la primera organización? | allowlist (hoy) / abierto / invitación | **allowlist, sin cambios** | CAP-05 |
| **DP-CAP-13** | Límite de organizaciones por sujeto | 1 (hoy) / N | **1** | CAP-05 |
| **DP-CAP-14** | Política de rate limiting (valores concretos) | — | **valores propuestos, no fijados** | las 5 |
| **DP-CAP-15** | ¿Cómo se vincula por primera vez una organización a un cliente de Stripe? | (a) un flujo *first-party* autenticado registra el vínculo **antes** de que llegue ningún webhook; (b) el webhook lo infiere de `session.client_reference_id`; (c) alta manual por un super admin | **(a) — pero no está implementado.** Mientras no lo esté, `checkout.session.completed` **no tiene camino** por `stripe_apply_subscription`, y el handler no debe inventarse uno | **CAP-03** |

**Son quince, no catorce.** DP-CAP-15 nació de la segunda ronda adversarial y
es la única decisión que **elimina** una rama en vez de configurarla. El caso
`organization` de `stripe_apply_subscription` resolvía la organización desde
`session.client_reference_id`, que un Payment Link acepta como parámetro
suministrado por el comprador y que este repositorio no restringe en ningún
`checkout.sessions.create` propio. Las dos rondas llegaron a conclusiones
opuestas sobre cómo comprobar ese valor —una dijo que la guarda era demasiado
estricta, la otra que demasiado laxa— y **ambas tenían razón**: ningún predicado
sobre la fila actual distingue una primera suscripción legítima de una
reclamación hostil, porque la única evidencia en cualquiera de los dos sentidos
es el propio campo suministrado por el atacante. La respuesta no es una guarda
mejor: es que la capacidad **se niega a ser el sitio donde ese vínculo se crea
por primera vez**. Eso es DP-CAP-15, y no se decide aquí.

Consecuencias que ya están fijadas por prueba:
`p_match_kind` admite exactamente `('customer','subscription')`
(gate `cap03-match-kind`), y la cadena `client_reference_id` no aparece en
`stella_0008` en ninguna forma (gate `cap03-client-reference`).

---

## 9. Riesgos residuales del modelo (no de una capacidad concreta)

* **RR-CAP-0 — ACTUALIZADO tras el dry run.** Ya no dice "todo es SQL leído".
  Los cinco paquetes se aplicaron **dos veces** (convergentes), pasaron 72
  aserciones vivas y seis pruebas de concurrencia con sesiones reales, se
  revirtieron y se reaplicaron — en un contenedor desechable **sin red**,
  sembrado desde un volcado *schema-only* del stack local. Nueve defectos
  salieron de ahí y de ninguna revisión. Lo que queda abierto es más pequeño y
  distinto: **el ensayo no es Supabase gestionado** (ver RR-CAP-5 y RR-09).
* **RR-CAP-1 — CERRADO.** Decía: *"`uellix_owner` puede `SET ROLE` a los cinco
  roles de capacidad; es necesario para transferirles la propiedad de las
  funciones"*. Lo era, y era peor de lo que el riesgo describía: `SET ROLE` es
  transitivo y `uellix_migrator` es `LOGIN`, así que la cadena llegaba desde una
  credencial real. La transferencia se hace ahora como superusuario, los cinco
  roles tienen **cero miembros** y las postcondiciones lo comprueban.
* **RR-CAP-2 — las policies de los roles de capacidad son amplias por
  construcción.** La narrowness vive en el cuerpo de la función (§1.1). Un bug
  en el cuerpo no lo detiene la policy; lo detiene el grant por columna.
* **RR-CAP-3 — el token en claro cruza la frontera de la aplicación a la base.**
  CAP-01 recibe el token crudo para hashearlo en el servidor. Como parámetro
  ligado, `pg_stat_statements` lo normaliza, pero `log_statement = 'all'` lo
  registraría. Mitigación operativa, no de diseño.
* **RR-CAP-4 — cinco roles nuevos son cinco cosas más que auditar.** El coste
  del aislamiento es superficie de gestión. Se compensa con el test de
  aislamiento (`capability-isolation`), que falla si aparece un rol
  `uellix_cap_*` no inventariado.
* **RR-CAP-12 — una suite verde no es una suite que detecte.**
  `tests/capability-isolation.test.ts` pasaba 220/220 mientras **22 mutaciones
  de seguridad sobrevivían**: reapuntar el `TO` de una policy `RESTRICTIVE`,
  sustituir su `USING` por `true`, vaciar un `WITH CHECK`, fusionar
  `GRANT INSERT (…), SELECT` en una sola sentencia, devolver el `match_kind`
  `organization` a CAP-03, o mover la reclamación de la clave de idempotencia
  de CAP-05 detrás de la creación de la organización. Ninguna cambiaba un
  conteo, y la suite sólo comprobaba conteos y existencia.

  El riesgo **no** era que faltasen pruebas: era que nadie había demostrado que
  las que había pudieran ponerse en rojo. Cerrado por construcción, no por más
  aserciones: el contrato vive en `tests/helpers/capability-gates.ts` como
  **función pura** sobre el texto de los paquetes, y
  `tests/capability-mutation.test.ts` lo ejecuta contra copias deliberadamente
  rotas exigiendo que cada una produzca al menos una violación **y que la
  produzca el gate correcto**. `scripts/capability-mutation-audit.ts` mide lo
  mismo **en disco** y contra la suite antigua, con SHA-256 antes y después.

  Estado medido (2026-08-03): **22/22 sobreviven a la suite antigua, 0/67
  sobreviven a los gates nuevos, 67/67 restauradas intactas.**

  **No está cerrado, y la razón importa.** «0/67» mide que el catálogo y los
  gates coinciden — dos ficheros escritos a la vez, por la misma mano. Dos
  revisores adversariales de solo lectura encontraron **once escapes reales en
  una sesión**: propiedad de la función (`OWNER TO`), RLS sin habilitar en las
  tablas nuevas, un segundo `ALTER ROLE` con `BYPASSRLS`, `INHERIT`, policies y
  grants plantados dentro de un *rollback*, un séptimo booleano de publicación,
  el rol fundador satisfecho por el payload de auditoría, los flags que
  `verify_report` no estaba obligado a leer, la denylist de slugs, el privilegio
  concreto del `REVOKE`, y borrar una policy ajena. Ninguno exigió imaginación y
  varios eran de la misma clase que mutaciones ya presentes. Todos están ahora
  catalogados y en rojo.

* **RR-CAP-12b — el lector divergía de PostgreSQL, y la divergencia era
  silenciosa.** (2026-08-04.) Una reauditoría independiente confirmó **ocho
  formas de escribir en PostgreSQL una operación de seguridad que el parser no
  veía**. No eran ocho propiedades nuevas: eran ocho **grafías** de propiedades
  que el catálogo ya cubría.

  | # | Grafía | Por qué no se veía |
  | --- | --- | --- |
  | E-01 | DDL/DCL dentro de un bloque `DO` | el cuerpo `$$…$$` se enmascaraba entero; la sentencia no era ilegible, era **inexistente** |
  | E-02 | *grantee* entre comillas dobles | todo patrón de identificador era `[A-Za-z_][\w$]*` |
  | E-03 | `GRANT a, b TO c` | la lista de miembros exigía un identificador desnudo y se descartaba con un `continue` |
  | E-04 | `DISABLE ROW LEVEL SECURITY` con tabla cualificada y entrecomillada | `ALTER TABLE ([\w.]+)` no lee `"public"."t"` |
  | E-05 | segundo `ALTER ROLE` con el rol entrecomillado | el gate se anclaba al nombre desnudo del rol |
  | E-06 | `REASSIGN OWNED` | no aparecía en ningún patrón, en ninguna dirección |
  | E-07 | `CREATE POLICY` con nombre, esquema, tabla y rol entrecomillados | ninguno de los cuatro identificadores era legible |
  | E-08 | comentario de bloque **anidado** | PostgreSQL los anida; el enmascarador no, así que creía que el `REVOKE` sobrevivía |

  La causa raíz es una sola y se nombra sin adornos: **la ausencia de match se
  interpretaba como ausencia de riesgo.** Un gate que no encuentra su patrón
  informaba lo mismo que un gate satisfecho.

  Cerrado por construcción: `tests/helpers/sql-structure.ts` es ahora un
  **lexer** con las reglas léxicas de PostgreSQL (identificadores normalizados,
  comillas dobles con escape, comentarios anidados, `E''`, *dollar quoting* con
  y sin etiqueta) y un **escáner** que desciende a los cuerpos ejecutables —
  bloques `DO`, cuerpos de función y literales llegados por `EXECUTE`. Toda
  sentencia que **abre** como operación de seguridad y no clasifica produce la
  violación `unparsed-security-statement` con fichero, línea, origen y motivo,
  y nunca un silencio. El `EXECUTE` de un `format(…)`, de una variable o de una
  concatenación no se interpreta: se **rechaza**.

  Estado medido (2026-08-04): **96 mutaciones catalogadas (22 M + 45 N + 8 E +
  14 F + 7 A), 0 supervivientes, 0 detectadas por un gate ajeno a su propiedad,
  restauración verificada por SHA.** Las 8 evasiones tienen además un control
  negativo independiente a nivel de parser en
  `tests/capability-policy-parser.test.ts`, para que una regresión del lector se
  vea antes de que un gate se ponga verde por accidente.

  El residual se declara en cifras, no en adjetivos: **56 de 123 gates no los
  ejercita ninguna mutación**, y están listados en `UNEXERCISED_GATES` con un
  test que falla si esa lista cambia sin que alguien lo escriba. Un gate que
  nunca se ha puesto en rojo es indistinguible de un gate que no puede.

  Y el inventario de gates tiene a su vez un punto ciego que ahora se comprueba:
  se deriva casando `add('<literal>'` en el código fuente, así que **un gate
  cuyo nombre se calcule en tiempo de ejecución es invisible para la propia
  comprobación de cobertura**. Ocurrió durante esta unidad — dos gates escritos
  con un ternario disparaban correctamente y no figuraban en ninguna de las dos
  listas. Se cierra desde el otro extremo: todo gate que se observe disparar
  debe estar en el inventario derivado.
* **RR-CAP-5 — Supabase gestionado puede no admitir todo esto.** Las mismas
  tres limitaciones que bloquearon `stella_0004` en remoto
  (ver `DATABASE_ROLE_MODEL.md` §8) aplican a `uellix_stripe`, que es un rol
  `LOGIN` nuevo. **No verificado contra remoto** — está prohibido en esta
  unidad.
* **RR-CAP-7 — `PUBLIC` tiene `USAGE` sobre el esquema `public`.** Todo rol
  nuevo lo hereda, así que ningún rol técnico puede quedar sin capacidad de
  *nombrar* objetos de `public` (§4.1). Retirarlo es viable pero es un cambio
  global que alcanza a roles internos de Supabase; queda como hardening
  candidato con análisis propio, fuera de esta unidad.
* **RR-CAP-6 — `super_admins_read_marketing_leads` está roto desde el cutover.**
  Hallazgo colateral: es `TO authenticated` y el runtime no lo es. No forma
  parte de ninguna capacidad; se registra aquí para que no se pierda.
