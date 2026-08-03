# CAP-04 — Captura pública de lead

**Estado:** DISEÑO. No aplicado. No habilitado.
**Paquete:** `db/prepared/stella_0009_public_lead_capability.sql`
**Rollback:** `db/prepared/stella_0009_rollback.sql`
**Modelo común:** [`../DATABASE_CAPABILITY_MODEL.md`](../DATABASE_CAPABILITY_MODEL.md)

---

## 1. Inventario del flujo actual (FASE 2)

| Aspecto | Realidad medida |
|---|---|
| Entry point | `app/api/marketing/lead/route.ts` (`POST`) |
| Actor | Visitante anónimo de la landing / calculadora SROI |
| Autenticación | **Ninguna** |
| Información disponible | `email`, `companyName`, `sroiResult`, `source` — todo del cliente |
| Contexto de BD | Ninguno: `db.insert(marketingLeads)` sin abrir contexto |
| Tablas consultadas | Ninguna |
| Tablas modificadas | `marketing_leads` (INSERT) |
| Servicios llamados | Ninguno |
| Efectos externos | Ninguno hoy (no hay correo de seguimiento) |
| Respuesta actual | **503** tras validar el esquema (`LEAD_CAPTURE_POLICY_AVAILABLE = false`) |
| **Por qué falla cerrado hoy** | Las tres policies de la tabla nombran roles de base de datos: `{anon}` INSERT, `{authenticated}` INSERT, `{authenticated}` SELECT super-admin. El `TO` se compara contra el **rol de base de datos**, no contra `request.jwt.claims.role`. El runtime es `uellix_app`, que no es miembro de `anon` ni de `authenticated` — luego **ninguna policy aplica** y RLS deniega por defecto. |

### 1.1 El hecho que reorienta todo el diseño

Medido el 2026-08-03:

```
marketing_leads grants:
  service_role  : SELECT, INSERT, UPDATE, DELETE
  uellix_writer : SELECT, INSERT, UPDATE, DELETE
```

**`uellix_app` ya tiene el privilegio.** Hereda de `uellix_writer` el DML
completo sobre `marketing_leads`. Lo único que lo detiene es la ausencia de una
policy aplicable.

Esto invalida la reparación obvia — la opción **(a)** que el propio comentario
de la ruta propone: *"una policy INSERT para `{public}` sobre esta tabla"*.
Añadirla haría funcionar el endpoint, sí, y de paso dejaría al runtime entero
con `INSERT` público sobre la tabla. Y como el `SELECT`, `UPDATE` y `DELETE`
del `writer` siguen ahí, la única razón de que no se usen sería que nadie
escribió el código para usarlos.

El diseño de CAP-04 va en la dirección contraria y hace **dos** cosas:

1. Crea una capacidad estrecha (`submit_lead`) cuyo definer sólo puede
   `INSERT` columnas nombradas.
2. **Recorta el privilegio existente**: revoca de `uellix_writer` el
   `SELECT`, `INSERT`, `UPDATE` y `DELETE` sobre `marketing_leads`.

Tras el paquete, el runtime **no puede tocar la tabla de ninguna forma**. La
única vía es la función.

### 1.2 Hallazgo colateral: la lectura de super admin también está rota

`super_admins_read_marketing_leads` es `TO authenticated`. El runtime no es
`authenticated`. Un super admin que abra una lista de leads desde la aplicación
lee **cero filas** — igual que el INSERT, y por la misma razón, sin que nadie lo
haya registrado.

Se anota como **RR-CAP-6** en el modelo común. **No se arregla en este
paquete**: es una capacidad de lectura administrativa distinta, con su propio
modelo de amenaza (¿quién puede exportar la lista de correos?), y mezclarla con
la captura pública sería exactamente el agrupamiento que la FASE 0 prohíbe.

---

## 2. Actor y frontera de confianza

```
   Visitante anónimo — o un bot
   ─────────────────────────────────  frontera 1: HTTP
   Runtime Next.js
     · Zod + normalización + honeypot + rate limit
     · NO hay identidad que verificar. La frontera es antiabuso, no autenticación
   ─────────────────────────────────  frontera 2: conexión SQL
   uellix_app  (sin claims)
     · EXECUTE sobre submit_lead(...) y nada sobre marketing_leads
   ─────────────────────────────────  frontera 3: SECURITY DEFINER
   uellix_cap_lead   (NOLOGIN, cero miembros)
     · INSERT por columna. SIN SELECT. SIN UPDATE. SIN DELETE.
```

La propiedad que define esta capacidad:

> **La capacidad que escribe leads no puede leerlos.** No es una promesa del
> código: `uellix_cap_lead` no tiene `SELECT` sobre `marketing_leads`, y la
> función usa `ON CONFLICT DO NOTHING` **sin `RETURNING`**, así que no lo
> necesita. Comprometer el endpoint público no permite exfiltrar la lista.

---

## 3. La RPC

```
uellix_capability.submit_lead(
    p_email        text,
    p_company_name text,
    p_sroi_result  text,
    p_source       text
  ) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
```

**`RETURNS void`** es una decisión de seguridad, no de estilo: sin valor de
retorno no hay canal por el que la función pueda revelar si el correo ya
existía, si la inserción ocurrió, o cuántas filas hay. El llamante recibe lo
mismo siempre.

### 3.1 Cuerpo

| # | Paso | Razón |
|---|---|---|
| 1 | `v_email := pg_catalog.lower(pg_catalog.btrim(p_email))` | Normalización **en la base**, no sólo en Zod. La unicidad se define sobre el valor normalizado, así que normalizar en dos sitios distintos produciría duplicados. |
| 2 | Validar `v_email` contra `^[^@\s]+@[^@\s]+\.[^@\s]+$` y `length ≤ 255` | Defensa en profundidad: Zod ya lo hace, y la base lo vuelve a hacer porque la función es alcanzable sin pasar por Zod si alguien añade otro llamante. |
| 3 | `p_source` debe estar en una **lista fija** (`sroi_calculator`, `landing_hero`, `pricing`, `demo_request`, `contact_form`) | Es la corrección de un defecto real: hoy `source` es texto libre de hasta 100 caracteres, controlado por el cliente, y acaba en informes. Una lista fija cierra la inyección de contenido en el destino. |
| 4 | Truncar `p_company_name` a 255 y `p_sroi_result` a 50; `NULL` si quedan vacíos | Límites en la base, no sólo en el esquema. |
| 5 | `INSERT INTO public.marketing_leads (email, company_name, sroi_result, source, lead_status, consent_version) VALUES (…, 'new', …) ON CONFLICT (email, source) DO NOTHING` | `lead_status` **fijo a `'new'`**: no es parámetro. Sin `RETURNING`. |
| 6 | (nada) | La función no lee, no devuelve, no registra en `audit_logs`. |

### 3.2 Lo que la firma deliberadamente NO acepta

* `organization_id` — no existe en la tabla y no se añade: un lead público no
  pertenece a ninguna organización, y aceptarlo sería dejar que el cliente
  eligiera a quién se le atribuye.
* `lead_status` — fijo a `'new'`. Nadie desde fuera marca un lead como
  contactado o cualificado.
* `created_at` — lo pone la base.
* Cualquier campo de campaña, UTM o referer: si se quisieran, saldrían del
  servidor (§8, DP-CAP-08), no del cuerpo de la petición.

### 3.3 DDL que el paquete necesita

```
ALTER TABLE public.marketing_leads
  ADD COLUMN IF NOT EXISTS lead_status      varchar(20) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS consent_version  varchar(20);

ALTER TABLE public.marketing_leads
  ADD CONSTRAINT marketing_leads_status_check
  CHECK (lead_status IN ('new','contacted','qualified','discarded'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_leads_email_source
  ON public.marketing_leads (pg_catalog.lower(email), source);
```

`consent_version` nace **anulable** a propósito: hacerla `NOT NULL` exige
decidir qué texto de consentimiento se muestra (**DP-CAP-09**), y esa decisión
no se inventa aquí. El paquete crea la columna para que la decisión no requiera
otra migración; la función la rellena con el valor que le pase el endpoint
cuando exista.

El índice único es lo que hace posible la indistinguibilidad ante duplicados
(§6). El paquete comprueba que **no haya duplicados previos** y aborta si los
hay, indicando cuántos — sin mostrar ningún correo.

---

## 4. Grants mínimos y revocaciones

```
GRANT USAGE   ON SCHEMA uellix_capability TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.submit_lead(text,text,text,text) TO uellix_app;
REVOKE ALL    ON FUNCTION uellix_capability.submit_lead(text,text,text,text) FROM PUBLIC;
```

`uellix_cap_lead`:

| Tabla | Priv. | Columnas |
|---|---|---|
| `public.marketing_leads` | `INSERT` | `email, company_name, sroi_result, source, lead_status, consent_version` |

**Y nada más. Ni `SELECT`, ni `UPDATE`, ni `DELETE`, ni ninguna otra tabla.**

**Revocaciones del paquete** — la parte que distingue este diseño de "añadir la
policy que falta":

```
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer;
DROP POLICY IF EXISTS anon_insert_marketing_leads          ON public.marketing_leads;
DROP POLICY IF EXISTS authenticated_insert_marketing_leads ON public.marketing_leads;
```

Las dos policies se retiran porque describen un camino que ya no existe: la
escritura por PostgREST con el rol `anon` o `authenticated`. Dejarlas sería
mantener abierta una puerta para un rol que hoy no la usa pero que la usaría el
día que alguien reactivara PostgREST. Es la misma lección de `stella_0005c`:
*una policy sin uso no es inocua; es una autorización esperando un rol.*

`super_admins_read_marketing_leads` **se deja intacta** (RR-CAP-6): retirarla
sin diseñar su sustituta rompería una capacidad administrativa distinta.

---

## 5. Policies necesarias

Una sola:

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_lead_insert` | `marketing_leads` | `INSERT` | `TO uellix_cap_lead WITH CHECK (lead_status = 'new')` |

El `WITH CHECK` es la tercera capa sobre el mismo invariante (la función fija
`'new'`, el `DEFAULT` de la columna es `'new'`, y la policy lo exige). Tres
capas para un invariante trivial puede parecer excesivo; no lo es cuando la
capa que falla es la que un futuro cambio de código toca sin darse cuenta.

Tras el paquete, la tabla queda con **dos** policies: `cap_lead_insert` y
`super_admins_read_marketing_leads`.

---

## 6. Idempotencia e indistinguibilidad ante duplicados

`ON CONFLICT (lower(email), source) DO NOTHING` + `RETURNS void` produce:

| Escenario | Filas | Respuesta al cliente |
|---|---|---|
| Correo nuevo | +1 | `200 {success:true}` |
| Correo ya registrado con la misma `source` | 0 | `200 {success:true}` — **idéntica** |
| Correo ya registrado con otra `source` | +1 | `200 {success:true}` |
| Honeypot relleno | 0 (ni se llama a la función) | `200 {success:true}` — **idéntica** |
| Rate limit excedido | 0 | `429` — *distinguible, y es correcto*: es una señal operativa, no información sobre los datos |

**El endpoint no puede usarse para comprobar si un correo está en la lista.**
Es la propiedad que pide la FASE 7 y sale de tres piezas combinadas: el índice
único, el `DO NOTHING`, y el `void`.

Cuál es el precio, dicho claro: **no se puede informar al usuario de que ya se
había registrado**. Se le agradece igual. Es **DP-CAP-11**.

---

## 7. Antiabuso: rate limiting, honeypot, replay

| Control | Valor propuesto | Dónde |
|---|---|---|
| Por IP | 3 / 10 min | Endpoint (Upstash) |
| Global | 200 / min | Endpoint |
| Honeypot | campo señuelo oculto; si viene relleno → éxito falso | Endpoint |
| Tamaño del cuerpo | 8 KiB | Endpoint |
| Forma del correo | regex + longitud | Endpoint **y** función |
| `source` en lista fija | 5 valores | Endpoint **y** función |
| Replay | índice único ⇒ no-op | Base |

El honeypot es la única defensa aquí que un humano no nota y un bot ingenuo sí:
un campo de formulario oculto por CSS que ningún usuario rellena. Si llega
relleno, el endpoint responde éxito **sin llamar a la función**. Que la
respuesta sea indistinguible es lo que impide al operador del bot detectar que
fue filtrado y ajustar.

Ya existe `lib/marketing/demo-request-rate-limit.ts` y
`tests/rate-limit.test.ts`; el diseño reutiliza esa infraestructura en lugar de
introducir otra.

---

## 8. Privacidad, consentimiento y retención

Aquí el diseño se detiene y marca decisiones, porque son legales antes que
técnicas.

**Lo que el diseño ya decide (y son decisiones conservadoras):**

* **No se almacena la IP.** Ni cruda ni hasheada. Una IP es dato personal en
  la mayoría de los marcos aplicables y su única función aquí sería antiabuso —
  que se resuelve en el rate limiter, en memoria, con TTL corto, sin
  persistencia.
* **No se almacena user agent, referer ni fingerprint.**
* **No se escribe en `audit_logs`.** Un lead no es una acción de un actor
  identificado, y `audit_logs` es append-only: un correo escrito ahí no se
  puede borrar nunca, lo que colisiona de frente con cualquier derecho de
  supresión. Mantener los datos personales **fuera** de la tabla append-only
  es una decisión de diseño explícita.
* La observabilidad se limita a un contador (opcional, misma forma que CAP-02)
  y al log de la aplicación, que ya registra sólo `error.name`.

**Lo que queda por decidir:**

| ID | Decisión | Por qué no se inventa |
|---|---|---|
| **DP-CAP-08** | Qué campos se aceptan | Añadir UTM o campaña cambia el perfil de datos personales recogidos |
| **DP-CAP-09** | Texto de consentimiento y su versionado | Es una decisión legal; la columna existe y espera |
| **DP-CAP-10** | Retención | Sin ella no hay purga que programar |
| **DP-CAP-11** | Duplicados silenciosos | Compromiso entre privacidad y UX |

**Supresión.** `uellix_cap_lead` no tiene `DELETE`, y tras el paquete
`uellix_writer` tampoco. Atender una solicitud de supresión requiere al
migrador. Es incómodo a propósito: borrar leads es un acto administrativo con
huella, no una operación de runtime.

---

## 9. Auditoría

| Destino | Contenido |
|---|---|
| `marketing_leads` | La fila. Es el dato, no la auditoría |
| `audit_logs` | **Nada.** Ver §8 |
| Log de aplicación | `[marketing-lead]` + `error.name` en fallo. **Nunca** el correo — ya es el comportamiento actual y se conserva |
| Contador diario (opcional) | Envíos por día y `source`, sin PII |

---

## 10. Pruebas (suite `public-lead-capability`)

### 10.1 Estáticas

| # | Prueba |
|---|---|
| S1 | `uellix_cap_lead` recibe **sólo** `INSERT`, y por columna |
| S2 | El paquete **no** concede `SELECT`, `UPDATE` ni `DELETE` sobre `marketing_leads` a nadie |
| S3 | El paquete **revoca** los cuatro privilegios de `uellix_writer` sobre la tabla |
| S4 | El paquete elimina `anon_insert_marketing_leads` y `authenticated_insert_marketing_leads` |
| S5 | El paquete **no** elimina `super_admins_read_marketing_leads` |
| S6 | La función es `RETURNS void` |
| S7 | El cuerpo **no** contiene `RETURNING` |
| S8 | `lead_status` no aparece como parámetro de la función |
| S9 | La lista de `source` admitidos está en el SQL y tiene 5 valores |
| S10 | No hay ninguna columna de IP, UA, referer ni fingerprint en el DDL |
| S11 | `search_path=''`, todo cualificado, cero dinámico |
| S12 | `REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE` sólo a `uellix_app` |
| S13 | El índice único usa `lower(email)` |

### 10.2 Vivas (stack desechable)

| # | Prueba | Debe |
|---|---|---|
| L1 | Lead nuevo | +1 fila con `lead_status='new'` |
| L2 | Mismo correo y misma `source` | **0 filas nuevas**, misma respuesta |
| L3 | Mismo correo con distinta capitalización | 0 filas nuevas (normalización) |
| L4 | `source` fuera de la lista | error uniforme, 0 filas |
| L5 | `lead_status` inyectado en el JSON | ignorado; la fila sale `'new'` |
| L6 | El definer intenta `SELECT FROM marketing_leads` | **denegado** |
| L7 | El definer intenta `DELETE` | denegado |
| L8 | `uellix_app` intenta `INSERT` directo | denegado (grant revocado **y** sin policy) |
| L9 | `uellix_app` intenta `SELECT` directo | denegado |
| L10 | `anon` intenta `INSERT` por PostgREST | denegado (policy eliminada) |
| L11 | `authenticated` intenta `INSERT` | denegado |
| L12 | `PUBLIC` no tiene `EXECUTE` | falso |
| L13 | Correo de 300 caracteres | rechazado, 0 filas |

---

## 11. Rollout

1. Dry-run en desechable; `L1..L13`.
2. **Comprobar que no hay duplicados** `(lower(email), source)` en la tabla
   destino antes de aplicar. El paquete aborta si los hay.
3. Aplicar en local de ensayo.
4. `LEAD_CAPTURE_POLICY_AVAILABLE` sigue en **`false`**.
5. Resolver **DP-CAP-08/09/10/11**.
6. Reescribir la ruta para llamar a la RPC, añadir honeypot y rate limit.

> **Aviso de rollout:** el paso 3 **rompe** cualquier código que hoy lea o
> escriba `marketing_leads` como `uellix_app`. Medido: no existe ninguno —
> la única ruta es la que ya devuelve 503, y
> `super_admins_read_marketing_leads` ya estaba rota antes (RR-CAP-6). Aun así
> es un cambio de privilegio sobre una tabla existente y debe anunciarse como
> tal.

## 12. Rollback

`DROP POLICY cap_lead_insert` → `DROP FUNCTION` → `DROP ROLE uellix_cap_lead` →
**restaurar** `GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_leads TO
uellix_writer` → **recrear** las dos policies de `anon`/`authenticated` →
`DROP SCHEMA` si vacío.

Restaurar los grants y las policies retiradas es lo que hace que el rollback
devuelva el estado **exacto** previo, no un estado "parecido pero más seguro".
Un rollback que mejora la seguridad de paso es un rollback que no se puede
verificar por comparación de catálogo.

`lead_status`, `consent_version` y el índice único **no se revierten**: son
integridad de datos, no privilegio, y borrarlos destruiría información
(el estado de cada lead) o reintroduciría duplicados. Quedan con `COMMENT`.

---

## 13. Threat model (FASE 12)

| Amenaza | Severidad | Mitigación | Residual |
|---|---|---|---|
| **Token theft** | N/A | No hay credencial que robar: el actor es anónimo | N/A |
| **Replay** | Baja | Índice único ⇒ no-op idempotente | Ninguno |
| **Brute force** | N/A | No hay nada que adivinar | N/A |
| **Enumeration** | **Alta si se falla** | `RETURNS void` + `DO NOTHING` + honeypot con éxito falso ⇒ respuesta idéntica en todos los casos | **Timing**: un `INSERT` que inserta tarda algo más que uno que colisiona. Diferencia de microsegundos bajo un rate limiter de 3/10 min: **explotarla exigiría más peticiones de las que el límite permite**. MINOR |
| **Cross-org** | N/A | La tabla no tiene `organization_id` y el diseño no lo añade | Ninguno |
| **Confused deputy** | Media | El definer sólo inserta 6 columnas nombradas con estado fijo | Ninguno |
| **Privilege escalation** | **Alta** | El paquete **reduce** privilegio neto: revoca 4 de `uellix_writer` y añade 1 acotado al definer | Ninguno |
| **Duplicate request** | Baja | §6 | Ninguno |
| **Timeout / partial failure** | Baja | Un solo `INSERT`; sin transacción multi-paso | Ninguno |
| **Log leakage** | **Alta** (es PII) | Nunca se registra el correo; sólo `error.name`. Sin IP, sin UA, sin `audit_logs` | Los logs HTTP del proveedor registran la IP del envío, fuera del control de este diseño |
| **SQL injection** | Alta | Parámetros ligados, cero dinámico | Ninguno |
| **`search_path` injection** | Alta | `search_path=''`, todo cualificado | Ninguno |
| **Payload amplification** | Media | Cuerpo ≤ 8 KiB; longitudes truncadas en la base | Ninguno |
| **Denial of service** | **Media** | Rate limit por IP y global; la tabla no tiene FK que encarezcan el INSERT | Un ataque distribuido puede llenar la tabla dentro del límite global. Mitigación: alerta sobre el contador diario. **RR-CAP-04-A** |
| **Abuse automation (spam)** | **Alta** | Honeypot + rate limit + `source` de lista fija | Un bot bien hecho pasa el honeypot. Sin CAPTCHA, es el límite realista. **RR-CAP-04-B** |

---

## 14. Riesgos residuales

* **RR-CAP-04-A** — llenado distribuido de la tabla dentro del límite global.
  Mitigación operativa (alerta sobre el contador diario), no de diseño. MINOR.
* **RR-CAP-04-B** — sin CAPTCHA, un bot competente puede enviar leads
  válidos. Añadir CAPTCHA es una decisión de producto y de privacidad
  (implica un tercero) que no se toma aquí. MINOR.
* **RR-CAP-04-C** — `consent_version` anulable hasta DP-CAP-09. Mientras tanto
  los leads se guardan sin registro de consentimiento, que es exactamente lo
  que pasa hoy; el diseño no empeora nada, pero tampoco lo arregla.
* **RR-CAP-6** (global) — la lectura de super admin sigue rota.
