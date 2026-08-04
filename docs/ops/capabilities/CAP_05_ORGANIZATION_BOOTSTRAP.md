# CAP-05 — Alta autoservicio de organización

**Estado:** DISEÑO. No aplicado. No habilitado.
**Paquete:** `db/prepared/stella_0010_organization_bootstrap_capability.sql`
**Rollback:** `db/prepared/stella_0010_rollback.sql`
**Modelo común:** [`../DATABASE_CAPABILITY_MODEL.md`](../DATABASE_CAPABILITY_MODEL.md)

---

## 1. Inventario del flujo actual (FASE 2)

| Aspecto | Realidad medida |
|---|---|
| Entry point | `app/app/onboarding/actions.ts::createFirstOrganization` (server action) |
| Actor | Usuario autenticado **sin** membresía |
| Autenticación | **Sí**: `supabase.auth.getUser()`, redirige a `/login` si no hay |
| Información disponible | `FormData` con `name`, `slug`, `legalName`, `country`, `sector`; la sesión |
| Contexto de BD | `withAuthenticatedDatabaseContext(...)` — `uellix_app` con claims, sin organización |
| Tablas consultadas | `signup_allowlist` (allowlist), `organizations` (slug libre), `organization_members` (membresía previa) |
| Tablas modificadas | `organizations` (INSERT), `organization_members` (INSERT), `audit_logs` (2× INSERT) |
| Servicios llamados | Supabase Auth (`getUser`, `syncUserProfile`) |
| Efectos externos | Ninguno |
| Respuesta actual | Violación de RLS → la acción falla |
| **Por qué falla cerrado hoy** | Dos policies, y las dos son deliberadas: `orgs_insert_super_admin` exige `current_user_is_super_admin()`, y `members_insert_admin` exige ser ya admin de esa organización. El comentario de esta última **dice explícitamente** que no se añadió una excepción de auto-inserción porque *"permitiría a cualquier usuario unirse a cualquier organización"*. Además, `signup_allowlist` sólo la lee un super admin, así que el usuario corriente se estrella un paso antes, en la comprobación de allowlist. |

### 1.1 Lo que el flujo actual ya hace bien

Merece decirse, porque el diseño lo conserva en lugar de reinventarlo:

* **Todo el acceso a base va en una transacción** (`withAuthenticatedDatabaseContext`),
  y los `redirect()` van **fuera**, con un comentario que explica por qué:
  `redirect()` lanza, y lanzar dentro del callback revertiría la organización
  recién creada. Es exactamente el razonamiento correcto.
* El `owner` nunca lo elige el cliente: sale de `authUser.id`.
* El rol es constante (`ROLES.ORGANIZATION_ADMIN`), no un parámetro.
* La comprobación de membresía previa existe.

### 1.2 Lo que le falta

1. **No hay clave de idempotencia.** Un `POST` reenviado tras un timeout crea
   una **segunda** organización, con otro slug o fallando por slug tomado. No
   hay forma de que el segundo intento reconozca al primero.
2. **La unicidad de slug es *check-then-act*.** `SELECT … WHERE slug = …`
   seguido de `INSERT`. Existe `organizations_slug_unique`, así que el segundo
   `INSERT` falla — pero falla con un error de constraint que llega al usuario
   como error genérico, no como "ese slug está tomado".
3. **No hay denylist de slugs.** `/app`, `/api`, `/verify`, `/invite` y
   `/login` son rutas reales de la aplicación. Un slug `verify` o `api` es
   admisible hoy según `^[a-z0-9-]+$`.
4. **No se crea configuración inicial.** La organización nace sin más.

---

## 2. Actor y frontera de confianza

```
   Usuario autenticado, recién registrado, sin organización
   ─────────────────────────────────  frontera 1: HTTP + Supabase Auth
   Runtime Next.js — server action
     · rate limit por auth.uid()
     · genera y persiste la clave de idempotencia en el formulario
   ─────────────────────────────────  frontera 2: conexión SQL
   uellix_app  (claims del usuario, sin organización)
     · EXECUTE sobre bootstrap_organization(...)
   ─────────────────────────────────  frontera 3: SECURITY DEFINER
   uellix_cap_bootstrap   (NOLOGIN, cero miembros)
     · INSERT acotado en organizations, organization_members, audit_logs
     · SELECT acotado en signup_allowlist
```

**Determinación (FASE 8): RPC `SECURITY DEFINER` estrecha, *no* una identidad
técnica de bootstrap.**

Un rol técnico `LOGIN` de bootstrap sería un rol capaz de crear organizaciones
y membresías **sin sujeto**. Su credencial, filtrada, permitiría fabricar
organizaciones y unir a cualquiera a cualquiera. La RPC no tiene ese problema
porque **no puede ejecutarse sin `auth.uid()`**: el sujeto viene del JWT que la
sesión ya verificó, no de un parámetro ni de una credencial. La capacidad está
atada a la identidad del solicitante por construcción.

Es exactamente la diferencia con CAP-03, donde **no hay** sujeto humano posible
y por eso allí sí hace falta una identidad técnica. La asimetría es la
justificación, no una inconsistencia.

---

## 3. La RPC

```
uellix_capability.bootstrap_organization(
    p_idempotency_key uuid,
    p_name            text,
    p_slug            text,
    p_legal_name      text,
    p_country         text,
    p_sector          text
  ) RETURNS TABLE (organization_id uuid, slug text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
```

### 3.1 Cuerpo

| # | Paso | Razón |
|---|---|---|
| 1 | `SET LOCAL lock_timeout = '3s'` | Igual que CAP-01: un bloqueo sin límite es un vector de DoS |
| 2 | `v_subject := auth.uid()`; `NULL` → error uniforme | **El sujeto nunca es parámetro.** Es la propiedad que sustituye a la identidad técnica |
| 3 | `p_idempotency_key` no nula | Sin clave no hay reintento seguro |
| 4 | **RECLAMAR LA CLAVE, PRIMERO.** `INSERT INTO capability_bootstrap_attempts (user_id, idempotency_key) … ON CONFLICT ON CONSTRAINT capability_bootstrap_attempts_pkey DO NOTHING RETURNING true` | Ésta es la sentencia que serializa. Un `INSERT` sobre una PK compuesta toma un bloqueo de tupla **que existe**, y el perdedor lo descubre en el acto |
| 5 | Si el `INSERT` no reclamó (`v_claimed` no es `true`): releer la fila **con `FOR UPDATE`**. Si tiene `organization_id` → replay idempotente, devolverlo y salir **sin escribir**. Si no lo tiene → error uniforme; el cliente reintenta con la misma clave | Aquí `FOR UPDATE` sí bloquea, porque **ahora la fila existe**. Ése es el orden que importa |
| 6 | Rechazar si ya hay membresía **activa** para `v_subject` | Invariante de una organización por usuario (**DP-CAP-13**) |
| 7 | Leer el correo del sujeto y comprobar la allowlist contra `public.signup_allowlist` | La allowlist sigue siendo la puerta (**DP-CAP-12**); el definer puede leerla, el usuario no |
| 8 | Validar `p_name`: 2..255 tras `btrim` | |
| 9 | Validar `p_slug` contra `^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$` y **denylist** | Cierra el defecto 3 |
| 10 | Normalizar `p_country` a 2 mayúsculas; truncar `p_legal_name`/`p_sector` | |
| 11 | `INSERT INTO public.organizations (…) ON CONFLICT ON CONSTRAINT organizations_slug_unique DO NOTHING RETURNING id` | **Atómico**: cierra el *check-then-act* del defecto 2. Si no devuelve fila, el slug está tomado → error **distinguible** `U0002`. **`ON CONSTRAINT`, no `ON CONFLICT (slug)`**: el `RETURNS TABLE` declara una variable de salida llamada `slug`, y un *conflict target* es contexto de expresión, donde plpgsql la sustituiría |
| 12 | `INSERT INTO public.organization_members` con `user_id = v_subject`, `role = 'organization_admin'`, `status = 'active'` | Ni el usuario ni el rol llegan por parámetro |
| 13 | *(no hay paso 13)* La configuración inicial **no se inserta**: en este esquema la configuración de una organización son sus propias columnas, y toda la que la capacidad no nombra toma el `DEFAULT` | Ése es el mecanismo por el que el bootstrap no puede elegir plan ni cuota: **no tiene grant sobre esas columnas**, así que nombrarlas fallaría (RR-CAP-05-C) |
| 14 | Dos `INSERT` en `public.audit_logs` con `actor_user_id = v_subject` | |
| 15 | `UPDATE capability_bootstrap_attempts SET organization_id = …, completed_at = now()` | **Sella** la clave reclamada en el paso 4 |
| 16 | `RETURN QUERY SELECT v_org_id, v_slug` | Datos mínimos |

**Los pasos 4 a 15 comparten transacción**, no sólo del 11 al 15. Eso importa
más de lo que parece: la reclamación de la clave revierte con todo lo demás, de
modo que un fallo a mitad **libera la clave** en vez de dejarla ocupada por un
intento que nunca existió. O existen la organización, la membresía, las dos
auditorías y el sello, o no existe ninguna de las cinco cosas —
**y tampoco el intento**. No puede haber una organización parcial, que es el
requisito literal de la FASE 8.

**Por qué el orden del paso 4 es la propiedad, y no un detalle de
implementación.** Una revisión anterior abría con
`SELECT … FOR UPDATE` sobre `capability_bootstrap_attempts` y sólo tocaba la
clave primaria al final, como `ON CONFLICT DO UPDATE`. Ninguna de las dos
sentencias bloquea: `FOR UPDATE` sobre una fila que **todavía no existe** no
tiene nada que bloquear, y un `DO UPDATE` al final llega cuando la organización
ya está creada. Las dos llamadas concurrentes pasaban las dos, y la defensa
documentada no defendía. Reclamar por `INSERT`, **antes de cualquier otra
escritura**, es lo que convierte la afirmación en cierta: el perdedor no llega
a crear organización, y no deja intento residual porque su transacción entera
revierte.

### 3.2 El error de slug es la única excepción a la uniformidad

`U0002` (`capability_slug_taken`) es distinguible de `U0001`, a propósito.

*Por qué está justificado, cuando en CAP-01 la distinción se rechazó:* el
espacio de slugs es **público por diseño**. Si las organizaciones tienen URL
por slug, `GET /o/<slug>` ya revela cuáles existen. Ocultar "slug tomado"
degradaría la usabilidad de forma severa (el usuario no sabría qué corregir) a
cambio de ocultar algo que no está oculto. En CAP-01 la información sí era
secreta; aquí no lo es.

Si **DP-CAP-12** decidiera que las organizaciones no tienen URL pública por
slug, esta excepción debería revisarse. Queda anotado.

### 3.3 Denylist de slugs

```
'app','api','admin','www','auth','login','logout','signup','onboarding',
'verify','invite','dashboard','settings','billing','support','help',
'status','static','public','assets','_next','favicon','robots','sitemap',
'uellix','stella','null','undefined','new','edit','delete'
```

Un array constante en el cuerpo. No una tabla: una tabla sería configurable y
por tanto un objetivo. Es una lista fija que sólo cambia con una migración
revisada.

### 3.4 DDL que el paquete necesita

```
public.capability_bootstrap_attempts
  user_id         uuid        NOT NULL REFERENCES public.users(id),
  idempotency_key uuid        NOT NULL,
  organization_id uuid        REFERENCES public.organizations(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (user_id, idempotency_key)
```

La `PRIMARY KEY` compuesta es la clave de idempotencia. Que incluya `user_id`
importa: **una clave de idempotencia de un usuario no colisiona con la de
otro**, así que un atacante no puede envenenar el espacio de claves adivinando
UUID ajenos.

La clave la genera el **servidor** al renderizar el formulario de onboarding y
viaja como campo oculto. No la elige el cliente libremente: un `p_idempotency_key`
arbitrario sólo puede afectar a los intentos del propio sujeto (por la PK
compuesta), así que el peor caso es que un usuario se autobloquee su propia
clave — recuperable con recargar el formulario.

---

## 4. Grants mínimos

```
GRANT USAGE   ON SCHEMA uellix_capability TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.bootstrap_organization(uuid,text,text,text,text,text) TO uellix_app;
REVOKE ALL    ON FUNCTION … FROM PUBLIC;
```

`uellix_cap_bootstrap`, por columna:

| Tabla | Priv. | Columnas |
|---|---|---|
| `public.organizations` | `SELECT` | `id, slug` |
| `public.organizations` | `INSERT` | `name, slug, legal_name, country, sector, status` |
| `public.organization_members` | `SELECT` | `user_id, status` |
| `public.organization_members` | `INSERT` | `organization_id, user_id, role, status, joined_at` |
| `public.users` | `SELECT` | `id, email` |
| `public.signup_allowlist` | `SELECT` | las columnas de la regla |
| `public.audit_logs` | `INSERT` | `organization_id, actor_user_id, entity_type, entity_id, action, after_json` |
| `public.capability_bootstrap_attempts` | `SELECT, INSERT, UPDATE` | todas |

**Lo que no está:**

* `INSERT` sobre `organizations.stella_monthly_quota`, `stella_plan_label`,
  `stripe_*` — **el bootstrap no puede elegir plan ni cuota.** La cuota queda
  en el `DEFAULT` de la columna (0, según el contrato vigente). Es el requisito
  literal *"no permitir elegir plan, permisos o flags administrativos"*, y se
  cumple por grant de columna, no por confiar en que la función no lo intente.
* `UPDATE` sobre `organizations` u `organization_members` — no puede modificar
  nada existente, sólo crear.
* `DELETE` en ninguna tabla.
* Cualquier acceso a `projects`, `sroi_*`, `evidence_*`, `stella_*`,
  `invitations` o `marketing_leads`.

---

## 5. Policies necesarias

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_bootstrap_select_orgs` | `organizations` | `SELECT` | `USING (true)` |
| `cap_bootstrap_insert_orgs` | `organizations` | `INSERT` | `WITH CHECK (status = 'active')` |
| `cap_bootstrap_select_members` | `organization_members` | `SELECT` | `USING (true)` |
| `cap_bootstrap_insert_members` | `organization_members` | `INSERT` | `WITH CHECK (role = 'organization_admin' AND status = 'active')` |
| `cap_bootstrap_select_users` | `users` | `SELECT` | `USING (id = auth.uid())` — acotada a la propia fila, como la de CAP-01 |
| `cap_bootstrap_select_allowlist` | `signup_allowlist` | `SELECT` | `USING (true)` |
| `cap_bootstrap_insert_audit` | `audit_logs` | `INSERT` | `WITH CHECK (actor_user_id IS NOT NULL AND entity_type IN ('organization','organization_member'))` |
| `cap_bootstrap_rw_attempts` | `capability_bootstrap_attempts` | `ALL` | `USING (true) WITH CHECK (true)` |

`cap_bootstrap_insert_members` con `role = 'organization_admin'` es la
respuesta directa al comentario histórico de `members_insert_admin`. Aquella
policy temía que una excepción de auto-inserción *"permitiera a cualquier
usuario unirse a cualquier organización"*. Aquí eso es imposible por dos
razones acumuladas: la policy sólo admite el rol de admin fundador, y el
`organization_id` que la función inserta es el de la fila que **ella misma
acaba de crear** en la misma transacción — no un valor que el llamante pueda
nombrar.

`members_insert_admin` y `orgs_insert_super_admin` **se conservan sin tocar**.

### 5.1 Las tres RESTRICTIVE

Son **once** policies, no ocho. Las tres que faltaban en este documento:

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_bootstrap_only_founder` | `organization_members` | `INSERT` | `WITH CHECK (role = 'organization_admin' AND status = 'active')` |
| `cap_bootstrap_only_active` | `organizations` | `INSERT` | `WITH CHECK (status = 'active')` |
| `cap_bootstrap_only_self` | `users` | `SELECT` | `USING (id = auth.uid())` |

El argumento es el de CAP-01 §6.1, y aquí muerde más fuerte que en ninguna otra
capacidad: las ocho permisivas de arriba se combinan con OR junto a las 105
policies `{public}` de la línea base, cuyos predicados llaman a
`current_user_role_in_org()` — que dentro del definer resuelve al **llamante**,
porque `auth.uid()` es una GUC de sesión que `SECURITY DEFINER` no reinicia. Un
llamante que ya fuese org-admin en alguna organización anularía por OR el
`role = 'organization_admin'` de `cap_bootstrap_insert_members` y podría
insertarse con cualquier rol que el ACL por columna admita.

`cap_bootstrap_only_founder` es lo que hace **cierta** la frase de §5 sobre
`members_insert_admin`. La mutación M-22 la vacía, y sobrevivía.

---

## 6. Idempotencia

| Escenario | Resultado |
|---|---|
| Primera llamada | Crea todo; sella `completed_at` |
| Reenvío con la **misma** clave | Paso 4 no reclama → paso 5 relee y devuelve la misma organización, **cero escrituras** |
| Reenvío con clave **distinta** | Paso 6: ya hay membresía activa → error uniforme. **No** crea una segunda organización |
| Dos llamadas concurrentes, **misma** clave | El `INSERT` del paso 4: sólo una reclama. La perdedora bloquea en el `FOR UPDATE` del paso 5 sobre una fila que **ya existe**, y al desbloquearse o devuelve la organización de la ganadora o se rechaza uniformemente. **Nunca crea una segunda organización, y no deja intento residual** |
| Dos llamadas concurrentes, claves **distintas** | Las dos reclaman su propia clave; la serialización real es el índice único parcial `user_single_active_membership`, cuyo `23505` el bloque `EXCEPTION` colapsa en `U0001`. La perdedora revierte entera |
| Timeout del cliente, éxito en el servidor | Reintento con la misma clave → paso 4 |
| Fallo a mitad | La transacción revierte **entera**, incluida la fila de intento. La clave queda libre para reintentar |
| Slug tomado | `U0002`; la fila de intento revierte; el usuario corrige y reintenta con la misma clave |

**La propiedad clave:** hay **dos** defensas contra la organización duplicada, y
son independientes. La clave de idempotencia cubre el reenvío del mismo
formulario; la comprobación de membresía activa cubre el envío de un formulario
nuevo. Ninguna de las dos depende de la otra.

---

## 7. Rate limiting

| Límite | Valor propuesto | Ámbito |
|---|---|---|
| Por `auth.uid()` | 5 / hora | Endpoint |
| Por IP | 10 / hora | Endpoint |
| `lock_timeout` | 3 s | Función |

Los límites son bajos a propósito: un usuario legítimo crea **una**
organización en su vida. Cinco intentos por hora cubre con holgura los errores
de validación y de slug tomado.

---

## 8. Auditoría

Dos filas por bootstrap exitoso, con `actor_user_id = auth.uid()`:

| `entity_type` | `action` | `after_json` |
|---|---|---|
| `organization` | `organization.created` | `{name, slug, sector, country}` |
| `organization_member` | `membership.created` | `{userId, role}` |

Los rechazos **no** escriben en `audit_logs` (mismo razonamiento que CAP-01:
crecimiento no acotado por un actor externo). Sí dejan huella en
`capability_bootstrap_attempts` mientras el intento vive, pero esa fila revierte
con la transacción si el bootstrap falla — lo cual es correcto: un intento
fallido no debe consumir su propia clave de idempotencia.

---

## 9. Pruebas (suite `organization-bootstrap-capability`)

### 9.1 Estáticas

| # | Prueba |
|---|---|
| S1 | La firma **no** tiene parámetro de usuario, owner, rol, plan, cuota ni flag |
| S2 | El grant de `INSERT` sobre `organizations` **no** incluye `stella_monthly_quota`, `stella_plan_label` ni `stripe_*` |
| S3 | El definer no recibe `UPDATE` ni `DELETE` sobre `organizations` ni `organization_members` |
| S4 | La policy de `organization_members` fija `role = 'organization_admin'` |
| S5 | La denylist de slugs está en el SQL y contiene al menos `app`, `api`, `verify`, `invite` |
| S6 | `capability_bootstrap_attempts` tiene PK compuesta `(user_id, idempotency_key)` |
| S7 | El cuerpo usa `ON CONFLICT ON CONSTRAINT organizations_slug_unique DO NOTHING`, no un `SELECT` previo **y no un *conflict target* por columna**, que pondría la variable de salida `slug` en contexto de expresión (gate `cap05-slug-atomic`) |
| S8 | La clave de idempotencia se reclama con `INSERT … ON CONFLICT ON CONSTRAINT capability_bootstrap_attempts_pkey DO NOTHING` **antes** de crear la organización, y ningún `FOR UPDATE` la precede (gates `cap05-claim-order`, `cap05-claim-first`, `cap05-claim-atomic`) |
| S9 | Las **once** policies coinciden con el contrato en tabla, modo, comando, `TO`, `USING` y `WITH CHECK`, incluidas las tres `RESTRICTIVE` de §5.1 (gates `policy-*`) |
| S10 | La firma no admite `actor`, `owner`, `user_id`, `role`, `plan`, `quota` ni `flag`, y el sujeto sale de `auth.uid()` (gates `cap05-no-authority-param`, `cap05-subject`, `cap05-no-actor`) |
| S8 | `search_path=''`, todo cualificado, cero dinámico |
| S9 | `REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE` sólo a `uellix_app` |
| S10 | El paquete **no** crea ningún rol `LOGIN` |
| S11 | `members_insert_admin` y `orgs_insert_super_admin` no se tocan |

### 9.2 Vivas (stack desechable)

| # | Prueba | Debe |
|---|---|---|
| L1 | Bootstrap feliz | 1 organización + 1 membresía admin + config + 2 auditorías |
| L2 | Reintento con la misma clave | mismo `organization_id`, cero escrituras |
| L3 | Segundo bootstrap con clave nueva | error uniforme; **una sola** organización |
| L4 | Dos llamadas concurrentes, misma clave | una sola organización |
| L5 | Slug tomado | `U0002`; cero filas nuevas en las tres tablas |
| L6 | Slug de la denylist (`api`) | error uniforme |
| L7 | Correo fuera de la allowlist | error uniforme |
| L8 | Sin `auth.uid()` | error uniforme |
| L9 | Intentar fijar `stella_monthly_quota` desde el cuerpo (mutante) | **falla por grant de columna** |
| L10 | Intentar crear con `role='super_admin'` (mutante) | rechazado por la policy |
| L11 | Fallo inyectado tras crear la organización | **cero** filas: revierte todo, incluida la de intento |
| L12 | `uellix_app` intenta `INSERT` directo en `organizations` | denegado |
| L13 | El definer intenta `SELECT` sobre `public.projects` | denegado |
| L14 | El definer intenta `UPDATE organizations` | denegado |
| L15 | `anon`/`authenticated` intentan `EXECUTE` | denegado |

`L11` es la prueba que demuestra la atomicidad exigida por la FASE 8 y es la
más importante de la suite.

---

## 10. Rollout

1. Dry-run en desechable; `L1..L15`.
2. Aplicar en local de ensayo.
3. La server action **no cambia todavía**: sigue fallando cerrada.
4. Resolver **DP-CAP-12** (quién puede crear la primera organización) y
   **DP-CAP-13** (¿una organización por sujeto?).
5. Reescribir `createFirstOrganization` para: generar la clave de idempotencia
   al renderizar el formulario, llamar a la RPC, y mapear `U0002` a
   `?error=slug_taken` (el mapeo que ya existe).
6. Gate: la suite de la capacidad y `capability-isolation` en verde.

## 11. Rollback

`DROP POLICY` ×8 → `DROP FUNCTION` → `DROP ROLE uellix_cap_bootstrap` →
`DROP TABLE capability_bootstrap_attempts` → `DROP SCHEMA` si vacío.

`capability_bootstrap_attempts` **sí se borra**: sólo contiene claves de
idempotencia de una capacidad que deja de existir, y sus filas completadas ya
están reflejadas en `audit_logs` y en las organizaciones creadas. No se pierde
información con valor probatorio.

Ninguna organización creada mientras la capacidad estuvo activa se toca. Tras
el rollback, `createFirstOrganization` vuelve a fallar cerrada. Cero estado
parcial.

---

## 12. Threat model (FASE 12)

| Amenaza | Severidad | Mitigación | Residual |
|---|---|---|---|
| **Token theft** (sesión robada) | **Alta** | Con la sesión el atacante crearía **una** organización a nombre de la víctima. No puede crearla a nombre de un tercero: el sujeto sale de `auth.uid()` | El robo de sesión ya compromete la cuenta entera |
| **Replay** | Media | Clave de idempotencia + membresía activa | Ninguno |
| **Brute force** | Baja | No hay secreto que adivinar; la clave de idempotencia está en el espacio del propio usuario (PK compuesta) | Ninguno |
| **Enumeration** | **Media** | El error de slug es distinguible **a propósito** (§3.2). Todo lo demás — allowlist, membresía previa, sujeto ausente — es uniforme | Un atacante puede enumerar slugs existentes. Justificado en §3.2; **revisar si DP-CAP-12 cambia el modelo de URL** |
| **Cross-org** | **Crítica si se falla** | El `organization_id` de la membresía es el de la fila creada en la misma transacción, jamás un parámetro. La policy exige `role='organization_admin'` | Ninguno |
| **Confused deputy** | **Alta** | El definer no puede `UPDATE` ni `DELETE`; sólo crear. No puede unir a nadie a una organización preexistente porque no puede nombrar un `organization_id` ajeno | Ninguno |
| **Privilege escalation** | **Crítica si se falla** | Rol constante en el cuerpo **y** en la policy; sin grant sobre las columnas de plan/cuota/Stripe; sin `UPDATE` | Ninguno |
| **Duplicate request** | Media | §6, dos defensas independientes | Ninguno |
| **Timeout** | Media | `lock_timeout=3s`; el reintento con la misma clave es idempotente | Ninguno |
| **Partial failure** | **Crítica si se falla** | Una función = una transacción; `L11` lo prueba | Ninguno |
| **Log leakage** | Baja | Sólo nombre y slug, que serán públicos | Ninguno |
| **SQL injection** | Alta | Parámetros ligados; la denylist es un array constante | Ninguno |
| **`search_path` injection** | Alta | `search_path=''`, todo cualificado | Ninguno |
| **Payload amplification** | Baja | Seis escalares, todos truncados en la base | Ninguno |
| **Denial of service** | Media | 5/hora por sujeto **en la capa de aplicación, no en el SQL**: `stella_0010` no implementa rate limiting, y el único límite por sujeto que la base impone es la guarda de membresía activa única (DP-CAP-13). La cifra es una propuesta de DP-CAP-14, no una medida vigente; `lock_timeout` | Un atacante con muchas cuentas allowlisted podría crear muchas organizaciones. La allowlist es la defensa. **RR-CAP-05-A** |
| **Abuse automation** | Media | La allowlist (DP-CAP-12) es la puerta real | Si DP-CAP-12 abriera el alta, haría falta CAPTCHA y verificación de correo. **No está en el diseño porque el defecto es la allowlist** |

---

## 13. Riesgos residuales

* **RR-CAP-05-A** — si DP-CAP-12 abre el alta más allá de la allowlist, el
  perfil de abuso cambia por completo y este diseño **no** es suficiente:
  haría falta verificación de correo, CAPTCHA y probablemente cuarentena de
  organizaciones nuevas. El diseño actual asume allowlist. **Es la dependencia
  más fuerte de esta capacidad respecto a una decisión de producto.**
* **RR-CAP-05-B** — el error de slug distinguible permite enumerar slugs.
  Justificado mientras los slugs sean públicos (§3.2); debe revisarse si dejan
  de serlo.
* **RR-CAP-05-C — CERRADO.** No existe tabla de settings en este esquema: la
  configuración de una organización **son sus propias columnas**. Toda la que
  la capacidad no nombra en su `INSERT` toma el `DEFAULT` de la columna, cuota
  incluida — y ese es exactamente el mecanismo por el que el bootstrap no puede
  elegir plan ni cuota: no tiene grant sobre esas columnas, así que nombrarlas
  fallaría. Un borrador de este documento describía un `INSERT` en "la tabla de
  settings correspondiente"; esa tabla no existe y el paquete nunca la tocó.
* **RR-CAP-05-D** — `syncUserProfile` sigue ocurriendo **fuera** de la RPC, en
  la server action. Si falla, el `SELECT` de `public.users` del paso 7 no
  encuentra al sujeto y el bootstrap devuelve error uniforme. Es fail-closed y
  correcto, pero produce un error opaco para un usuario legítimo cuyo perfil no
  se sincronizó. Mitigación: el endpoint debe llamar a `syncUserProfile` y
  comprobar su resultado **antes** de llamar a la RPC.


---

## Cómo se lee este paquete (2026-08-04)

El contrato estático de arriba lo evalúa un **lexer** con las reglas léxicas de
PostgreSQL, no expresiones regulares sobre texto enmascarado. La diferencia es
medible: una reauditoría independiente confirmó **ocho grafías válidas** que el
lector anterior no veía —DDL dentro de un bloque `DO`, identificadores y
*grantees* entre comillas dobles, `GRANT a, b TO c`,
`DISABLE ROW LEVEL SECURITY`, un segundo `ALTER ROLE` que revierte atributos
seguros, `REASSIGN OWNED`, `CREATE POLICY` con identificadores entrecomillados y
comentarios de bloque **anidados**—. Ninguna era una propiedad nueva: eran ocho
maneras de escribir propiedades que este documento ya declaraba.

Consecuencias al editar este fichero `.sql`:

* un `GRANT`, `CREATE POLICY` o `ALTER TABLE` emitido **desde dentro** de un
  bloque `DO`, del cuerpo de una función o de un literal de `EXECUTE` cuenta
  exactamente igual que uno escrito fuera;
* `EXECUTE format(…)`, `EXECUTE <variable>` y `EXECUTE 'a' || b` **se rechazan**
  con `unparsed-security-statement`: si un paquete necesita SQL dinámico, tiene
  que ser un literal autocontenido;
* `"Rol"` y `rol` son **roles distintos** — entrecomillar suprime el plegado a
  minúsculas — y el contrato compara la forma normalizada.

Detalle completo en
[`ADVERSARIAL_FINDINGS_PARSER.md`](ADVERSARIAL_FINDINGS_PARSER.md).

**Riesgos abiertos que alcanzan a esta capacidad:** **RR-CAP-10** la *degrada*
sin bloquearla. El argumento «el bootstrap no elige plan» es cierto dentro del
paquete —ninguna columna de facturación aparece en la firma, en el cuerpo ni en
el `GRANT INSERT`— y falso en el sistema, porque el `organization_admin` recién
creado puede escribir `stella_monthly_quota` por el ORM al minuto siguiente.
