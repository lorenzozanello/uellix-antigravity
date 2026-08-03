# CAP-02 — Verificación pública de reporte mediante hash

**Estado:** DISEÑO. No aplicado. No habilitado.
**Paquete:** `db/prepared/stella_0007_public_verification_capability.sql`
**Rollback:** `db/prepared/stella_0007_rollback.sql`
**Modelo común:** [`../DATABASE_CAPABILITY_MODEL.md`](../DATABASE_CAPABILITY_MODEL.md)

---

## 1. Inventario del flujo actual (FASE 2)

| Aspecto | Realidad medida |
|---|---|
| Entry points | `app/(public)/verify/[hash]/page.tsx` y `app/(public)/verify/[hash]/pdf/route.ts` |
| Actor | Visitante anónimo — típicamente un auditor, financiador o regulador |
| Autenticación | **Ninguna**. No hay sesión, no hay `auth.uid()` |
| Información disponible | Sólo el hash, en la ruta |
| Contexto de BD | Ninguno: `getPublicVerifiedReport` llama a `db` sin abrir contexto |
| Tablas consultadas | `sroi_reports`, `projects`, `organizations`, `sroi_calculation_runs`, `sroi_report_sections`, `evidence_items`, `methodology_review_matrix`, + catálogos de taxonomías |
| Tablas modificadas | Ninguna |
| Servicios llamados | Ninguno |
| Efectos externos | Ninguno |
| Respuesta actual | `notFound()` / 404 — porque la consulta devuelve cero filas |
| **Por qué falla cerrado hoy** | Las cuatro tablas del `innerJoin` tienen policies `SELECT` acotadas por membresía y **ninguna policy anónima**. Como `uellix_app` llega sin claims, `current_user_org_ids()` es vacío y el `SELECT` devuelve cero filas. El comentario del módulo lo describe con exactitud: *el modelo se implementó en la aplicación y no lo hacía cumplir nada más, porque la conexión saltaba RLS*. |

### 1.1 El problema real no es que esté cerrado — es lo que devolvería si se abriera

`getPublicVerifiedReport` no devuelve una vista pública. Devuelve, para
cualquiera que tenga el hash:

* **la fila completa** de `sroi_reports` (incluidos `created_by`, `updated_by`,
  `locked_by` — tres UUID de personas — y `summary`, que es texto interno);
* **la fila completa** de `projects`;
* **la fila completa** de `organizations` (incluidos `stripe_customer_id`,
  `stripe_subscription_id`, `stella_monthly_quota` — datos de facturación);
* **la fila completa** de `sroi_calculation_runs`;
* **todas** las secciones del reporte;
* **todos los `evidence_items` del PROYECTO** — no del reporte: del proyecto
  entero, incluida evidencia que nunca formó parte de ningún reporte publicado;
* la matriz de revisión metodológica y los cruces de taxonomías.

Y el PDF público (`/verify/[hash]/pdf`) renderiza el manifiesto de evidencia,
el rastro FX, los line items y los anexos por variante.

> Restaurar esta capacidad "como estaba" sería la peor de las cinco decisiones
> posibles en este diseño. **Que hoy esté rota es una suerte.**

Por eso CAP-02 no es "devolver el acceso": es **rediseñar qué significa
verificar públicamente**.

---

## 2. Actor y frontera de confianza

```
   Visitante anónimo (auditor, financiador, regulador, buscador)
   ─────────────────────────────────────────────  frontera 1: HTTP
   Runtime Next.js
     · rate limit por IP
     · sin sesión, sin identidad
   ─────────────────────────────────────────────  frontera 2: conexión SQL
   uellix_app  (sin claims)
     · EXECUTE sobre verify_report(text) y record_verification_hit(text)
   ─────────────────────────────────────────────  frontera 3: SECURITY DEFINER
   uellix_cap_verification   (NOLOGIN, cero miembros)
     · SELECT por columna sobre 3-4 tablas. Cero acceso a evidence_items.
```

La frontera 1 **no aporta identidad**. Toda la seguridad de CAP-02 vive en las
fronteras 2 y 3: qué función existe, y qué columnas puede leer su definer.

---

## 3. La capability es el hash — y eso obliga a dos cambios

El hash de verificación es un **bearer token**: quien lo tiene, lee. Ese modelo
es correcto para un certificado que se comparte en un informe anual. Pero
implica dos cosas que hoy no se cumplen:

### 3.1 Estar `locked` no puede ser suficiente

Hoy la condición es `status = 'locked'`. Bloquear un reporte es un acto
**interno** — significa "esto ya no se edita" —, no un acto de publicación.
Convertir "no se edita" en "el mundo puede leerlo" es un salto que nadie ha
autorizado explícitamente.

**El diseño introduce un acto de publicación separado y auditado:**

```
public.report_public_disclosures
  report_id        uuid PRIMARY KEY REFERENCES public.sroi_reports(id)
  approved_by      uuid NOT NULL REFERENCES public.users(id)
  approved_at      timestamptz NOT NULL DEFAULT now()
  revoked_at       timestamptz                       -- despublicar sin borrar
  public_summary   text                              -- redactado para publicar
  show_organization_name  boolean NOT NULL DEFAULT false
  show_report_title       boolean NOT NULL DEFAULT false
  show_headline_ratio     boolean NOT NULL DEFAULT false
  show_totals             boolean NOT NULL DEFAULT false
  disclosure_version      integer NOT NULL DEFAULT 1
```

**Sin fila → no verificable.** Con fila pero `revoked_at IS NOT NULL` → no
verificable. Cada campo visible es un booleano que alguien tuvo que poner en
`true`. Los cuatro nacen en `false`: **el defecto es no publicar nada**.

Esto convierte la pregunta "¿qué se muestra?" (DP-CAP-04, DP-CAP-05) de una
decisión de código a un dato por reporte, que además queda auditado.

### 3.2 El PDF público no puede seguir existiendo tal cual

`/verify/[hash]/pdf` llama a la misma función y renderiza el reporte completo.
Con el diseño nuevo esa llamada devolvería sólo la disclosure, con lo que el
PDF quedaría vacío de casi todo. **DP-CAP-06** decide entre retirarlo (defecto
propuesto) o reconstruirlo sobre los campos publicados. Mientras no se decida,
la ruta debe devolver 404 incondicionalmente.

---

## 4. Las dos RPC

Dos funciones y no una, y la separación es deliberada.

### 4.1 Lectura

```
uellix_capability.verify_report(p_hash text)
  RETURNS TABLE (
    verified              boolean,
    organization_name     text,      -- NULL si show_organization_name = false
    report_title          text,      -- NULL si show_report_title = false
    public_summary        text,      -- NULL si no se redactó
    issued_on             date,      -- fecha, NO timestamp
    report_variant        text,
    disclosure_version    integer,
    headline_ratio        numeric,   -- NULL salvo show_headline_ratio
    total_investment      numeric,   -- NULL salvo show_totals
    net_social_value      numeric,   -- NULL salvo show_totals
    currency              text       -- NULL salvo show_totals
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = ''
```

`STABLE` y `LANGUAGE sql`, no `plpgsql`. Las dos elecciones son sustantivas:

* **`STABLE`** hace que PostgreSQL rechace cualquier escritura dentro de la
  función. El camino de lectura pública es **estructuralmente** incapaz de
  escribir; no depende de que nadie añada un `INSERT` por descuido más
  adelante. Es la misma clase de garantía que el
  `default_transaction_read_only` del script de auditoría.
* **`LANGUAGE sql`** con un único `SELECT` significa que no hay ramas, ni
  variables, ni bucles. El cuerpo entero es inspeccionable de un vistazo, y no
  hay ningún camino de error que pueda diferir de otro — lo que elimina por
  construcción una clase de canal lateral de temporización.

El cuerpo:

```
SELECT
  true,
  CASE WHEN d.show_organization_name THEN o.name END,
  CASE WHEN d.show_report_title      THEN r.title END,
  d.public_summary,
  (r.locked_at AT TIME ZONE 'UTC')::date,
  r.report_variant,
  d.disclosure_version,
  CASE WHEN d.show_headline_ratio THEN run.sroi_ratio END,
  CASE WHEN d.show_totals THEN run.total_investment END,
  CASE WHEN d.show_totals THEN run.net_social_value END,
  CASE WHEN d.show_totals THEN run.currency END
FROM public.sroi_reports r
JOIN public.report_public_disclosures d ON d.report_id = r.id
JOIN public.organizations o ON o.id = r.organization_id
LEFT JOIN public.sroi_calculation_runs run ON run.id = r.calculation_run_id
WHERE r.verification_hash = p_hash
  AND r.status = 'locked'
  AND d.revoked_at IS NULL
```

**Cero filas** cuando el hash no existe, cuando el reporte no está `locked`,
cuando no hay disclosure, o cuando la disclosure está revocada. Los cuatro
casos son **indistinguibles**: el llamante recibe un conjunto vacío y el
endpoint responde 404. Eso no es una convención de la aplicación — es el
resultado del `JOIN`.

`issued_on` es **`date`, no `timestamp`**. Un `locked_at` con precisión de
microsegundos es un identificador casi único que permite correlacionar dos
reportes verificados por separado ("estos dos se bloquearon en el mismo
segundo, luego son de la misma organización"). La fecha basta para el propósito
— fechar el certificado — y no correlaciona.

### 4.2 Contador

```
uellix_capability.record_verification_hit(p_hash text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
```

Hace un `INSERT … ON CONFLICT (report_id, hit_date) DO UPDATE SET hit_count = hit_count + 1`
sobre:

```
public.capability_verification_hits
  report_id  uuid    REFERENCES public.sroi_reports(id)
  hit_date   date    NOT NULL
  hit_count  integer NOT NULL DEFAULT 1
  PRIMARY KEY (report_id, hit_date)
```

**Cero PII**: no hay IP, ni user agent, ni referer, ni sesión. La granularidad
es día × reporte. Se puede responder "¿cuántas veces se verificó este
certificado?" sin poder responder "¿quién lo verificó?", y eso es exactamente
la línea que se quiere.

La función es *best-effort*: el endpoint la llama **después** de haber
respondido la verificación, e ignora su error. Si el contador falla, la
verificación funciona igual. Separarla de `verify_report` es lo que hace
posible esa propiedad.

---

## 5. Grants mínimos

```
GRANT USAGE   ON SCHEMA uellix_capability TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.verify_report(text)            TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.record_verification_hit(text)  TO uellix_app;
REVOKE ALL    ON FUNCTION uellix_capability.verify_report(text)            FROM PUBLIC;
REVOKE ALL    ON FUNCTION uellix_capability.record_verification_hit(text)  FROM PUBLIC;
```

`uellix_cap_verification`, **por columna**:

| Tabla | Priv. | Columnas |
|---|---|---|
| `public.sroi_reports` | `SELECT` | `id, organization_id, calculation_run_id, title, status, report_variant, verification_hash, locked_at` |
| `public.report_public_disclosures` | `SELECT` | todas (la tabla existe sólo para esto) |
| `public.organizations` | `SELECT` | `id, name` |
| `public.sroi_calculation_runs` | `SELECT` | `id, sroi_ratio, total_investment, net_social_value, currency` |
| `public.capability_verification_hits` | `SELECT, INSERT, UPDATE` | `report_id, hit_date, hit_count` |

**Lo que NO está, y es el punto entero de la capacidad:**

| Tabla | Acceso del definer |
|---|---|
| `public.evidence_items` | **ninguno** |
| `public.sroi_report_sections` | **ninguno** |
| `public.projects` | **ninguno** |
| `public.sroi_calculation_line_items` | **ninguno** |
| `public.organization_members` | **ninguno** |
| `public.stella_interactions` | **ninguno** |
| `public.methodology_review_matrix` | **ninguno** |
| `organizations.stripe_*`, `stella_monthly_quota` | **ninguno** — el grant es por columna |
| `sroi_reports.summary`, `created_by`, `locked_by` | **ninguno** — grant por columna |

Un bug en el cuerpo de `verify_report` que intentara leer evidencia **no
compilaría**: `uellix_cap_verification` no tiene privilegio sobre esa tabla, y
la función se crea y valida bajo su propia propiedad.

---

## 6. Policies necesarias

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_verification_select_reports` | `sroi_reports` | `SELECT` | `USING (status = 'locked')` |
| `cap_verification_select_disclosures` | `report_public_disclosures` | `SELECT` | `USING (revoked_at IS NULL)` |
| `cap_verification_select_orgs` | `organizations` | `SELECT` | `USING (true)` |
| `cap_verification_select_runs` | `sroi_calculation_runs` | `SELECT` | `USING (true)` |
| `cap_verification_write_hits` | `capability_verification_hits` | `ALL` | `USING (true) WITH CHECK (true)` |

`report_public_disclosures` necesita además las policies para el camino
**interno** (quién crea y revoca una disclosure): un `organization_admin` de la
organización dueña del reporte. Esas policies son del modelo normal, no de la
capacidad, y el paquete las crea junto a la tabla.

`USING (status = 'locked')` en la policy es redundante con el `WHERE` de la
función y se pone igualmente: es la misma redundancia de dos capas que en
CAP-01. Si alguien reescribe el cuerpo, la policy sigue impidiendo que un
borrador se lea por esta vía.

---

## 7. Validaciones

| Validación | Dónde |
|---|---|
| El hash tiene forma `^[0-9a-f]{64}$` | Endpoint (rechaza sin tocar BD) |
| `status = 'locked'` | Función + policy |
| Disclosure existe y no revocada | Función (`JOIN`) + policy |
| Cada campo visible requiere su booleano | Función (`CASE`) |
| Rate limit por IP | Endpoint |

El chequeo de forma en el endpoint importa más de lo que parece: `verification_hash`
es `varchar(255)`, así que sin él un atacante podría enviar 255 caracteres
arbitrarios por petición. Rechazar por forma antes de llamar es la diferencia
entre un índice consultado y un índice consultado con basura.

---

## 8. Idempotencia

`verify_report` es `STABLE` y sin efectos: **la idempotencia es trivial y
estructural**. `record_verification_hit` es idempotente por día
(`ON CONFLICT DO UPDATE` incrementa; dos llamadas el mismo día producen 2, que
es la semántica correcta de un contador).

---

## 9. Rate limiting

| Límite | Valor propuesto | Ámbito |
|---|---|---|
| Peticiones por IP | 30 / min | Endpoint |
| Peticiones globales a `/verify/*` | 600 / min | Endpoint (protege el índice) |
| Rechazo por forma inválida | no consume cuota de BD | Endpoint |

Igual que en CAP-01, **el rate limit no defiende contra adivinación**: el hash
tiene 256 bits. Defiende contra (a) DoS sobre el índice único y (b) el uso del
endpoint como oráculo masivo si alguna vez se filtrara una lista parcial de
hashes.

---

## 10. Auditoría

* **Agregada y sin PII**: `capability_verification_hits`, día × reporte.
* **No** se escribe en `audit_logs`: una verificación pública no es un acto de
  un actor identificado, y `audit_logs` exige `actor_user_id NOT NULL` desde
  `stella_0005c`. Forzar un actor sintético ahí sería fabricar una identidad,
  que es exactamente lo que el cutover prohibió.
* La creación y la revocación de una **disclosure** sí van a `audit_logs`, con
  el admin que la aprobó como actor. Ese es el acto auditable.

---

## 11. Pruebas (suite `public-verification-capability`)

### 11.1 Estáticas

| # | Prueba |
|---|---|
| S1 | `verify_report` se declara `STABLE` (no `VOLATILE`, no `IMMUTABLE`) |
| S2 | El cuerpo de `verify_report` **no menciona** `evidence_items`, `sroi_report_sections`, `projects`, `line_items`, `stella_` |
| S3 | El paquete **no concede** ningún privilegio al definer sobre esas tablas |
| S4 | Los grants sobre `organizations` y `sroi_reports` son por columna, y `stripe_`/`summary`/`created_by` no están en la lista |
| S5 | `search_path = ''` en ambas funciones; todo cualificado |
| S6 | `REVOKE ALL … FROM PUBLIC` para ambas |
| S7 | `GRANT EXECUTE` sólo a `uellix_app` |
| S8 | El paquete crea `report_public_disclosures` con los cuatro booleanos `DEFAULT false` |
| S9 | `capability_verification_hits` no tiene ninguna columna de IP, UA o sesión |
| S10 | Precondiciones y rollback simétricos |

### 11.2 Vivas (stack desechable)

| # | Prueba | Debe |
|---|---|---|
| L1 | Reporte `locked` **sin** disclosure | 0 filas |
| L2 | Reporte `draft` **con** disclosure | 0 filas |
| L3 | Disclosure revocada | 0 filas |
| L4 | Hash inexistente | 0 filas — **respuesta idéntica a L1, L2 y L3** |
| L5 | Disclosure con todos los booleanos `false` | 1 fila con `verified=true` y **todo lo demás `NULL`** |
| L6 | `show_totals=true` | aparecen los tres importes, y **sólo** esos |
| L7 | El definer intenta `SELECT` sobre `evidence_items` | denegado |
| L8 | El definer intenta `SELECT organizations.stripe_customer_id` | denegado por columna |
| L9 | `anon` / `authenticated` intentan `EXECUTE` | denegado |
| L10 | `uellix_app` intenta `SELECT` directo sobre `sroi_reports` | 0 filas |
| L11 | `verify_report` intenta escribir (mutante) | falla por `STABLE` |
| L12 | El contador no acepta más columnas que las tres | por esquema |

---

## 12. Rollout

1. Dry-run en stack desechable; `L1..L12`.
2. Aplicar en local de ensayo. **La capacidad queda creada pero sin uso**: no
   existe todavía ninguna fila en `report_public_disclosures`, así que
   `/verify/[hash]` sigue devolviendo 404 para todo.
3. Resolver **DP-CAP-04**, **DP-CAP-05** y **DP-CAP-06**.
4. Construir la UI interna de aprobación de disclosure (fuera de esta unidad).
5. Reescribir `lib/reports/public-verify.ts` para llamar a la RPC.
6. Decidir el destino de la ruta PDF; mientras tanto, 404 incondicional.

**Propiedad importante del rollout:** aplicar el paquete **no publica nada**.
La superficie pública sigue devolviendo 404 hasta que un humano apruebe una
disclosure, reporte por reporte.

## 13. Rollback

Orden inverso: `REVOKE`, `DROP POLICY` ×5 (+ las internas), `DROP FUNCTION` ×2,
`DROP TABLE capability_verification_hits`, `DROP ROLE`, `DROP SCHEMA` si vacío.

`report_public_disclosures` **no se borra**: contiene decisiones humanas de
publicación con su autor y su fecha. Borrarla destruiría la prueba de quién
autorizó publicar qué. El rollback la deja con un `COMMENT` explicando que la
capacidad que la leía ya no existe.

Tras el rollback: `/verify/[hash]` vuelve a 404 para todo. Cero estado parcial.

---

## 14. Threat model (FASE 12)

| Amenaza | Severidad | Mitigación | Residual |
|---|---|---|---|
| **Token (hash) theft** | Baja por diseño | El hash **es** un bearer token y se comparte a propósito. Lo que protege es *qué* revela: sólo la disclosure aprobada | El titular del hash ve lo publicado. Es el propósito |
| **Replay** | Ninguna | Sin efectos | Ninguno |
| **Brute force** | Baja | 256 bits; rate limit; forma validada | Ninguno realista |
| **Enumeration** | **Crítica si se falla** | Los cuatro casos de fallo devuelven **el mismo conjunto vacío** por construcción del `JOIN`, no por una rama del código | **Timing**: `LANGUAGE sql` con un único `SELECT` hace que todos los caminos ejecuten el mismo plan. Es la razón de elegir `sql` sobre `plpgsql` |
| **Oráculo de existencia** | **Alta** | Un reporte `locked` sin disclosure es indistinguible de un hash inexistente. Publicar no confirma existir, y existir no confirma publicar | Ninguno |
| **Cross-org** | **Alta** | La función no acepta ningún filtro salvo el hash. No hay `LIMIT`, `OFFSET`, ni predicado de organización que un llamante pueda inyectar. **Por eso no es una vista** | Ninguno |
| **Confused deputy** | Media | El definer no puede leer nada que no esté en la lista de columnas | Ninguno |
| **Privilege escalation** | Alta | `STABLE` impide escribir; sin `INSERT`/`UPDATE`/`DELETE` en ninguna tabla salvo el contador | Ninguno |
| **Duplicate request** | Ninguna | Sin efectos | Ninguno |
| **Timeout / partial failure** | Baja | Lectura pura; el contador es best-effort y va aparte | Ninguno |
| **Log leakage** | Media | El hash **no es secreto** en el mismo sentido que un token de invitación: identifica un documento que se publicó a propósito. Aun así el endpoint no lo registra con la IP en la misma línea | Los logs de acceso HTTP del proveedor registran la ruta completa, que contiene el hash. **RR-CAP-02-A** |
| **SQL injection** | Alta | Un solo `SELECT` parametrizado, cero dinámico | Ninguno |
| **`search_path` injection** | Alta | `search_path=''`, todo cualificado | Ninguno |
| **Payload amplification** | **Media** | El flujo actual devolvía toda la evidencia del proyecto. El nuevo devuelve ≤11 escalares. La amplificación pasa de "un reporte completo por petición" a "una fila" | Ninguno |
| **Denial of service** | Media | Rate limit global y por IP; validación de forma antes de tocar el índice | Un ataque distribuido satura el endpoint HTTP, no la base |
| **Abuse automation** | Baja | Sin oráculo, sin listado, sin paginación | Ninguno |

### 14.1 RR-CAP-02-A — el hash viaja en la URL

`/verify/<hash>` pone la capability en la ruta, luego aparece en los logs de
acceso del proveedor, en el `Referer` si la página enlaza a un tercero, y en el
historial del navegador. Es inherente a que el certificado sea un enlace
compartible.

Mitigaciones incorporadas al diseño: la página **no enlaza a terceros**
(el único enlace saliente era el PDF, que DP-CAP-06 propone retirar), y se
recomienda `Referrer-Policy: no-referrer` en esa ruta —
`applySecurityHeaders` ya emite `strict-origin-when-cross-origin` globalmente,
que **no basta** aquí porque el origen se envía igualmente.

Severidad: **MINOR**, dado que lo que el hash desbloquea es, por diseño,
material aprobado para publicación.

---

## 15. Riesgos residuales

* **RR-CAP-02-A** — el hash en la URL (§14.1). MINOR.
* **RR-CAP-02-B** — la ruta PDF queda huérfana hasta DP-CAP-06. Debe devolver
  404 incondicional mientras tanto; si no se hace, seguirá llamando a la
  función vieja. **Es la única parte de CAP-02 que exige un cambio de código
  antes de aplicar el paquete.**
* **RR-CAP-02-C** — los reportes ya bloqueados **no** obtienen disclosure
  automáticamente. Los certificados emitidos antes dejarán de verificar hasta
  que alguien los apruebe uno a uno. Es el comportamiento correcto (nadie
  autorizó publicarlos) pero es una regresión visible y hay que comunicarla.
* **RR-CAP-02-D** — `organizations.name` se publica si el booleano está en
  `true`, y `name` es editable por la organización. Un nombre malicioso se
  publicaría tal cual. Mitigación: la aprobación de disclosure es un acto
  humano que ve el nombre en ese momento; no hay revalidación posterior.
