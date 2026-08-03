# CAP-01 — Aceptación de invitación mediante token

**Estado:** DISEÑO. No aplicado. No habilitado.
**Paquete:** `db/prepared/stella_0006_invitation_capability.sql`
**Rollback:** `db/prepared/stella_0006_rollback.sql`
**Modelo común:** [`../DATABASE_CAPABILITY_MODEL.md`](../DATABASE_CAPABILITY_MODEL.md)

---

## 1. Inventario del flujo actual (FASE 2)

| Aspecto | Realidad medida |
|---|---|
| Entry point | `app/invite/accept/page.tsx` (server component) → `lib/invitations/service.ts::acceptInvitation` |
| Actor | Persona invitada por correo |
| Autenticación | **Sí**: la página redirige a `/login` si `getCurrentUser()` devuelve `null` |
| Información disponible | El token crudo, por `searchParams.token`; la sesión Supabase |
| Contexto de BD | `withAuthenticatedDatabaseContext(...)` — identidad `uellix_app`, claims del usuario, **sin organización** |
| Tablas consultadas | `invitations` (por `token_hash`), `organization_members` (membresía previa), `users` (implícito vía sesión) |
| Tablas modificadas | `organization_members` (INSERT), `invitations` (UPDATE), `audit_logs` (2× INSERT) |
| Servicios llamados | Ninguno en el camino de aceptación (Resend sólo en la creación) |
| Efectos externos | Ninguno |
| Respuesta actual | `ErrorState` con uno de cuatro mensajes distinguibles |
| **Por qué falla cerrado hoy** | `invitations_select_member` exige `organization_id = ANY(current_user_org_ids())`. El invitado **no es miembro todavía**, luego lee **cero filas** y la función lanza `Invalid invitation`. Aunque leyera, `members_insert_admin` exige ser ya admin de esa organización, así que el INSERT también se negaría. |

### 1.1 Debilidades del flujo actual, independientes del cutover

Encontradas al leer el código; existirían aunque RLS no bloqueara nada:

1. **Sin bloqueo de fila.** `SELECT … WHERE token_hash = …` sin `FOR UPDATE`.
   Dos peticiones concurrentes con el mismo token leen ambas `status='pending'`
   y ambas insertan membresía. La segunda sólo falla si hay un índice único
   sobre `(user_id)` activo — y el comentario del propio servicio dice "el
   esquema impone una membresía activa por usuario", lo que protege contra
   *dos usuarios distintos* pero no describe el caso de dos peticiones del
   *mismo* usuario.
2. **Cuatro mensajes de error distinguibles** (§ inventario) = oráculo de
   enumeración: quien pruebe tokens puede distinguir "no existe" de "existe
   pero es de otro correo".
3. **No se registra quién aceptó** en la fila de la invitación. `accepted_at`
   sí; `accepted_by` **no existe como columna**. La atribución vive sólo en
   `audit_logs`.
4. **Expiración con efecto de escritura en el camino de lectura**: cuando el
   token está expirado, la función hace `UPDATE … SET status='expired'` y
   *después* lanza. Un atacante que envíe tokens expirados provoca escrituras.

Las cuatro se corrigen en el diseño.

---

## 2. Actor y frontera de confianza

```
   Navegador del invitado
   ─────────────────────────────────────────────  frontera 1: HTTP
   Runtime Next.js  (proceso de la aplicación)
     · sesión Supabase verificada  → auth.uid()
     · rate limit por IP y por sujeto
   ─────────────────────────────────────────────  frontera 2: conexión SQL
   uellix_app   (rol de base de datos, sujeto a RLS)
     · EXECUTE sobre accept_invitation(text) y nada más de CAP-01
   ─────────────────────────────────────────────  frontera 3: SECURITY DEFINER
   uellix_cap_invitation   (NOLOGIN, cero miembros)
     · grants por columna sobre 4 tablas
```

**Lo que se confía a cada frontera:**

* Frontera 1 confía en Supabase Auth para el `sub` del JWT. No confía en nada
  más del cliente: ni el `invitationId`, ni el correo, ni la organización.
* Frontera 2 confía en que la aplicación llama a la función con el token que
  recibió. No confía en que la aplicación haya validado nada.
* Frontera 3 **no confía en la frontera 2**: la función recomprueba
  `auth.uid()` desde `request.jwt.claims`, no desde un parámetro.

---

## 3. Credencial / capability

**La capability es el token crudo**, 32 bytes aleatorios en hex (64 caracteres),
generado por `crypto.randomBytes(32)` en la creación. La base almacena
**únicamente** `sha256(token)`.

Decisión: **la función recibe el token crudo y hashea en la base**, no el hash.

*Por qué.* Si la aplicación enviara el hash, la firma de la función sería
`accept_invitation(token_hash text)` y cualquier cosa capaz de llamar a la
función con un hash arbitrario tendría el mismo poder que quien tiene el token.
Eso convierte un secreto de 256 bits en un identificador de 256 bits —
idéntico en la práctica, pero pierde la propiedad de que *la base nunca ve un
valor que sirva para autenticarse contra ella misma*. Con el hash calculado en
la base, `token_hash` sigue siendo un derivado no invertible y no reutilizable.

*El coste.* El token crudo cruza la frontera 2. Se registra como **RR-CAP-3**.
Mitigaciones: se pasa como parámetro ligado (`$1`), nunca interpolado, así que
`pg_stat_statements` lo normaliza; y el runbook exige comprobar que
`log_statement` no sea `'all'` antes de habilitar.

*Hash.* `pg_catalog.sha256()` (builtin desde PostgreSQL 11, verificado en este
stack: 64 hex). **No se usa `pgcrypto`**: vive en el esquema `extensions` y
obligaría a nombrar un esquema ajeno bajo `search_path = ''`.

---

## 4. La RPC

```
uellix_capability.accept_invitation(p_token text)
  RETURNS TABLE (organization_id uuid, member_role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
```

### 4.1 Cuerpo, paso a paso y por qué cada paso está donde está

| # | Paso | Razón |
|---|---|---|
| 1 | `SET LOCAL lock_timeout = '3s'` | Un `FOR UPDATE` sin límite es un vector de DoS: basta abrir una transacción que retenga la fila. Falla rápido y uniforme. |
| 2 | `v_subject := auth.uid()`; si es `NULL` → error uniforme | El sujeto **nunca** llega por parámetro. Si no hay JWT, no hay capacidad. |
| 3 | `v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex')` | Hash en servidor. `convert_to` fija la codificación: sin él, el resultado dependería de `client_encoding`. |
| 4 | Rechazar si `p_token` no es exactamente 64 caracteres hex | Barato, y evita gastar un `SELECT` indexado en basura. Mismo error uniforme. |
| 5 | `SELECT … FROM public.invitations WHERE token_hash = v_hash` — **sin `FOR UPDATE`** | Corregido tras el dry run. `SELECT … FOR UPDATE` se filtra por el `USING` de la policy de UPDATE, que aquí es `status = 'pending'`; una lectura con bloqueo de una fila **ya aceptada** devuelve `NOT FOUND`, con lo que el paso 7 era inalcanzable y recargar la página daba rechazo. |
| 6 | Si no hay fila → error uniforme | |
| 7 | **Camino idempotente**: si `status='accepted'` **y** `accepted_by = v_subject` → devolver `(organization_id, role)` y salir **sin escribir** | Replay del mismo sujeto = éxito. No necesita bloqueo porque no escribe. |
| 8 | Si `status <> 'pending'` → error uniforme | Cubre `revoked`, `expired`, y `accepted` por otro sujeto. |
| 9 | Si `expires_at <= now()` → error uniforme, **sin escribir** | Corrige la debilidad 4: la expiración deja de tener efecto de escritura. El barrido de expirados es un trabajo aparte (§9). |
| 10 | `SELECT email FROM public.users WHERE id = v_subject` y comparar con `lower(trim(invitation.email))`; si no casa → error uniforme | La comparación se hace contra la tabla, **no** contra `request.jwt.claims->>'email'`: el claim lo emite el IdP y puede ir sin verificar. |
| 11 | Si ya existe membresía activa para `v_subject` → error uniforme | Invariante de una membresía activa por usuario. |
| 11b | **Ahora sí**: `SELECT status … WHERE id = v_inv_id FOR UPDATE` y recomprobar `pending` | Todo lo anterior se decidió sobre una lectura sin bloqueo. Este es el punto en que una aceptación concurrente deja de ser posible. La fila sigue `pending`, así que el `USING` de la policy la admite. |
| 12 | `INSERT INTO public.organization_members (…)` con `role` tomado de **la fila**, nunca del parámetro | El rol es lo que escribió quien invitó. |
| 13 | `UPDATE public.invitations SET status='accepted', accepted_at=now(), accepted_by=v_subject` | Cierra la invitación y **registra quién**. Es la corrección de la debilidad 3. |
| 14 | Dos `INSERT` en `public.audit_logs` (invitación aceptada, membresía creada), con `actor_user_id = v_subject` | Cumple `audit_logs_insert_*` de `0005c`, que rechaza actor `NULL`. |
| 15 | `RETURN QUERY SELECT v_org, v_role` | Datos mínimos. Ni el id de la invitación, ni el correo, ni quién invitó. |

### 4.2 Lo que la función deliberadamente NO hace

* No lista invitaciones. No hay parámetro que produzca más de una fila: el
  `WHERE` es igualdad contra una columna con índice, y el resultado es
  `INTO`, no un cursor.
* No acepta `invitationId`, ni `organizationId`, ni `email`, ni `role`.
* No revela por qué falló. Un solo `RAISE` con `ERRCODE 'U0001'`.
* No escribe nada en el camino de rechazo. Ni siquiera para expirar.
* No envía correo, ni llama a nada externo.

### 4.3 DDL que el paquete necesita

```
ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES public.users(id);
```

Una columna, anulable, sin backfill (las invitaciones ya aceptadas quedan con
`NULL`, que es la verdad: no se registró). Además un índice único parcial:

```
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token_hash
  ON public.invitations (token_hash);
```

Hoy `idx_invitations_token_hash` es un índice **no único**. Hacerlo único es
defensa en profundidad: si dos invitaciones colisionaran en hash (colisión
SHA-256 o, mucho más probable, un bug de generación), el `SELECT … INTO`
tomaría una arbitrariamente. Con el índice único eso es imposible por
construcción. El paquete comprueba que no haya duplicados antes de crearlo y
aborta si los hay.

---

## 5. Grants mínimos

```
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.accept_invitation(text) TO uellix_app;
REVOKE ALL ON FUNCTION uellix_capability.accept_invitation(text) FROM PUBLIC;
```

Para `uellix_cap_invitation`, **por columna**:

| Tabla | Privilegio | Columnas |
|---|---|---|
| `public.invitations` | `SELECT` | `id, organization_id, email, role, status, token_hash, expires_at, accepted_by` |
| `public.invitations` | `UPDATE` | `status, accepted_at, accepted_by, updated_at` |
| `public.organization_members` | `INSERT` | `organization_id, user_id, role, status, invited_by, joined_at` |
| `public.organization_members` | `SELECT` | `user_id, status` |
| `public.users` | `SELECT` | `id, email` |
| `public.audit_logs` | `INSERT` | `organization_id, actor_user_id, entity_type, entity_id, action, after_json` |

Obsérvese lo que **no** está: `UPDATE` sobre `organization_members` (no puede
cambiar el rol de nadie), `DELETE` en ninguna tabla, `SELECT` sobre
`invitations.token_hash` es necesario pero `UPDATE` sobre `token_hash` **no**
se concede (no puede reescribir un token), y ningún acceso a `organizations`,
`projects` ni nada del pipeline SROI.

---

## 6. Policies necesarias

**Nueve** policies nuevas: seis `PERMISSIVE` y tres `RESTRICTIVE`, todas
`TO uellix_cap_invitation` y ninguna `TO PUBLIC`. El documento decía «seis»
mientras el paquete creaba nueve — las tres `RESTRICTIVE` llegaron con la
segunda ronda adversarial (F-02) y no se escribieron aquí. Están abajo, en
§6.1, y su ausencia de este documento era el mismo tipo de defecto que
describen: una afirmación de contención que nada comprobaba.

### 6.0 Las seis permisivas

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_invitation_select_invitations` | `invitations` | `SELECT` | `USING (true)` |
| `cap_invitation_update_invitations` | `invitations` | `UPDATE` | `USING (status = 'pending') WITH CHECK (status = 'accepted')` |
| `cap_invitation_insert_members` | `organization_members` | `INSERT` | `WITH CHECK (status = 'active' AND role <> 'super_admin')` |
| `cap_invitation_insert_audit` | `audit_logs` | `INSERT` | `WITH CHECK (actor_user_id IS NOT NULL AND entity_type IN ('invitation','organization_member'))` |

Faltan dos, y conviene nombrarlas porque un borrador de este documento decía
"cuatro" y el paquete crea seis:

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_invitation_select_members` | `organization_members` | `SELECT` | `USING (true)` |
| `cap_invitation_select_users` | `users` | `SELECT` | `USING (id = auth.uid())` |

`cap_invitation_select_users` **sí** está acotada a la propia fila, como este
documento decía y una revisión anterior del SQL no hacía: el cuerpo sólo lee
`id = auth.uid()`, así que la policy puede llevar la restricción y la lleva.
La de `organization_members` no puede acotarse igual —la comprobación es
"¿existe alguna membresía activa de este sujeto?"— y se queda en `USING (true)`,
acotada por el grant por columna y por el cuerpo.

El `WITH CHECK` de `cap_invitation_update_invitations` es la pieza que impide
que un bug convierta la capacidad en una máquina de reabrir invitaciones: la
única transición admitida por la policy es `pending → accepted`. Revocar,
expirar o reabrir están fuera de su alcance aunque el cuerpo lo intentara.

El `role <> 'super_admin'` de `cap_invitation_insert_members` es redundante con
la validación de `createInvitation` (que ya rechaza invitar como super_admin) y
**se pone igualmente**: la redundancia está en dos capas distintas —
aplicación y base — y la de la base sobrevive a que alguien reescriba la de la
aplicación.

### 6.1 Las tres RESTRICTIVE, y por qué las seis de arriba no bastaban

| Nombre | Tabla | Cmd | Cláusula |
|---|---|---|---|
| `cap_invitation_only_accept` | `invitations` | `UPDATE` | `USING (status = 'pending') WITH CHECK (status = 'accepted' AND accepted_by IS NOT NULL)` |
| `cap_invitation_only_member` | `organization_members` | `INSERT` | `WITH CHECK (status = 'active' AND role <> 'super_admin')` |
| `cap_invitation_only_self` | `users` | `SELECT` | `USING (id = auth.uid())` |

Duplican literalmente el predicado de su gemela permisiva, y esa duplicación es
la corrección, no un descuido.

Las policies permisivas se combinan con **OR** — incluidas las **101** policies
`{public}` preexistentes, que aplican **también** a este definer. (101 es el
número de policies cuyo *grantee* es `{public}`; el 105 de las precondiciones
es otra cosa: la línea base contada EXCLUYENDO los prefijos de la campaña.
Confundirlos era un error de esta misma sección.) Sus
predicados llaman a `current_user_role_in_org()` y
`current_user_is_super_admin()`, que leen `auth.uid()`: una GUC **de sesión**
que `SECURITY DEFINER` **no** reinicia. Dentro del definer, por tanto, esas
funciones resuelven al **llamante**, no al conjunto vacío. Un llamante que sea
org-admin satisface la policy de línea base y **anula por OR** todos los límites
que las seis `cap_invitation_*` aparentan imponer.

Una policy `RESTRICTIVE` se combina con **AND** y no se puede anular por OR. Sin
estas tres, la única contención real era el ACL por columna, y cada frase de
este documento que dice «la policy acota esto aunque se reescriba el cuerpo»
**era falsa**. Con ellas, es cierta.

**Están fijadas por prueba, no sólo escritas.** El contrato de las nueve —
tabla, modo, comando, `TO`, `USING` y `WITH CHECK`— está en
`tests/helpers/capability-gates.ts` y se comprueba tupla a tupla. Cuatro
mutaciones del catálogo atacan exactamente estas tres policies (M-01 reapunta
el `TO`, M-03 relaja el `USING`, M-05 y M-22 vacían el `WITH CHECK`), y las
cuatro **sobrevivían** a la suite anterior.

---

## 7. Validaciones

| Validación | Dónde | Fail-closed |
|---|---|---|
| Token con forma `^[0-9a-f]{64}$` | Función (y endpoint) | sí |
| `auth.uid()` no nulo | Función | sí |
| Estado `pending` | Función + `USING` de la policy | sí |
| No expirada | Función | sí |
| Correo coincidente | Función, contra `public.users` | sí |
| Sin membresía activa previa | Función | sí |
| Rol válido y ≠ `super_admin` | Función + `WITH CHECK` | sí |
| Rate limit | Endpoint | sí |

---

## 8. Idempotencia y replay

| Escenario | Resultado |
|---|---|
| El mismo usuario recarga `/invite/accept?token=…` | Paso 7: devuelve `(organization_id, role)` sin escribir. **200 idempotente.** |
| Dos peticiones concurrentes, mismo usuario | La primera toma el `FOR UPDATE`. La segunda ya pasó su lectura **sin bloqueo** viendo `pending`, así que espera en el `FOR UPDATE`; cuando la primera confirma, la recomprobación EPQ aplica el `USING (status='pending')` de la policy de UPDATE y la fila nueva **no** califica → `NOT FOUND`. Ahí entra la lectura de recuperación, **sin bloqueo** (un `FOR UPDATE` nunca podría ver la fila aceptada, por esa misma policy): ve `accepted` con `accepted_by` = ella misma y devuelve la organización. **Una sola membresía.** Verificado con dos sesiones solapadas en el dry run. Si la primera retiene el bloqueo más de `lock_timeout`, la segunda recibe `U0001` — que es el límite de DoS haciendo su trabajo, no un fallo de idempotencia. |
| Dos peticiones concurrentes, usuarios distintos | La segunda ve `accepted` con `accepted_by` ajeno → error uniforme. |
| Token robado y usado por un tercero | El correo no casa → error uniforme. El robo del token **no basta**: hace falta también controlar la cuenta de ese correo. |
| Token reutilizado tras expirar | Error uniforme, sin escritura. |

**La propiedad clave:** el token por sí solo no es suficiente. Es una capability
de *segundo factor* respecto a la identidad — hay que tener el token **y** la
cuenta del correo invitado. Eso es lo que hace defendible que el enlace viaje
por correo electrónico.

---

## 9. Rate limiting

| Límite | Valor propuesto | Ámbito |
|---|---|---|
| Intentos por IP | 10 / 10 min | Endpoint (Upstash, ya es dependencia) |
| Intentos por `auth.uid()` | 5 / 10 min | Endpoint |
| `lock_timeout` | 3 s | Función |
| `statement_timeout` de la llamada | 5 s | Endpoint |

**Sobre fuerza bruta:** el token tiene 256 bits de entropía. A 10 intentos por
minuto haría falta del orden de 10⁶⁷ años. **El rate limit aquí no existe para
impedir adivinación** — existe para impedir DoS y para acotar el coste de un
atacante que ya tenga una lista parcial de tokens filtrados. Decirlo al revés
sería vender una defensa que no es la que actúa.

**Barrido de expiradas** (sustituye a la escritura en el camino de rechazo):
un trabajo separado, ejecutado por el migrador o por un cron administrativo,
`UPDATE invitations SET status='expired' WHERE status='pending' AND expires_at <= now()`.
No forma parte de esta capacidad y **no se diseña aquí**; se registra como
tarea de operación.

---

## 10. Auditoría

Dos filas en `audit_logs` por aceptación exitosa, ambas con
`actor_user_id = auth.uid()`:

| `entity_type` | `action` | `after_json` |
|---|---|---|
| `invitation` | `invitation.accepted` | `{userId, role}` |
| `organization_member` | `membership.created` | `{userId, role}` |

**Los rechazos no escriben en `audit_logs`.** Escribir una fila por cada token
inválido convierte la tabla append-only en un vector de crecimiento no acotado
controlado por un anónimo. La observabilidad del rechazo vive en el log de la
aplicación (`console.error` con el motivo real y **sin** el token), que sí es
rotable y tiene retención.

---

## 11. Pruebas (suite `invitation-capability`)

### 11.1 Estáticas — implementables hoy, sin base de datos

| # | Prueba |
|---|---|
| S1 | El paquete declara `SET search_path = ''` en la función |
| S2 | Toda referencia del cuerpo va cualificada (`public.`, `pg_catalog.`, `auth.`) |
| S3 | `REVOKE ALL … FROM PUBLIC` aparece para la función |
| S4 | `GRANT EXECUTE` aparece exactamente una vez y sólo a `uellix_app` |
| S5 | Ningún `GRANT … TO anon` ni `TO PUBLIC` en el paquete |
| S6 | Ningún `EXECUTE` dinámico ni concatenación |
| S7 | Los grants de tabla del rol definer son **por columna** y las columnas están inventariadas |
| S8 | El paquete no concede `UPDATE` sobre `invitations.token_hash` |
| S9 | Sólo hay un `RAISE EXCEPTION` con mensaje literal, y usa `U0001` |
| S10 | Precondiciones (38 tablas / **105** policies de línea base EXCLUYENDO los prefijos de la campaña / 10 triggers) y `current_user = uellix_owner` presentes |
| S11 | El rollback deshace exactamente lo que el forward crea |

### 11.2 Vivas — **ejecutadas** el 2026-08-03 en contenedor desechable

Los trece casos están implementados en `scripts/capability-dry-run.sql` (L6 en
`scripts/capability-dry-run-concurrency.sh`, que necesita dos sesiones) y
pasaron 13/13. El texto anterior decía «no se ejecutan en esta unidad»: era
cierto en la ronda 1 y dejó de serlo sin que nadie lo actualizara. CAP-02…CAP-05
ya lo habían corregido; CAP-01 no.

| # | Prueba | Debe |
|---|---|---|
| L1 | Aceptación feliz | crear 1 membresía, cerrar la invitación, escribir 2 filas de auditoría |
| L2 | Replay del mismo sujeto | devolver lo mismo, **cero** escrituras nuevas |
| L3 | Replay de otro sujeto | `U0001` |
| L4 | Token inexistente vs. token de otro correo | **mensaje y SQLSTATE idénticos** |
| L5 | Token expirado | `U0001` y **cero** escrituras |
| L6 | Dos llamadas concurrentes | exactamente una membresía |
| L7 | `uellix_app` intenta `SELECT` directo sobre `invitations` de otra organización | 0 filas |
| L8 | `authenticated` intenta `EXECUTE` de la función | denegado |
| L9 | `anon` intenta `EXECUTE` | denegado |
| L10 | `PUBLIC` no tiene `EXECUTE` | `has_function_privilege` falso |
| L11 | El definer intenta `UPDATE invitations SET token_hash = …` | denegado por grant de columna |
| L12 | El definer intenta `SELECT` sobre `public.projects` | denegado |
| L13 | Un `SET ROLE uellix_cap_invitation` desde `uellix_app` | denegado |

---

## 12. Rollout

1. Aplicar `stella_0006` en un stack **desechable** y correr `L1..L13`.
2. Aplicar en el stack local de ensayo. Re-correr.
3. La aplicación **no cambia todavía**: `acceptInvitation` sigue como está y
   sigue fallando cerrado.
4. Sólo cuando **DP-CAP-01** y **DP-CAP-02** estén resueltas se reescribe
   `lib/invitations/service.ts::acceptInvitation` para llamar a la RPC.
5. Gate: los trece casos `L*` de §11.2 en verde en el contenedor desechable
   (`bash scripts/capability-dry-run.sh`), y en verde offline
   `capability-isolation`, `capability-policy-contract`, `capability-mutation` y
   `capability-documentation`. **No existe una suite `vitest` llamada
   `invitation-capability`** y este punto la nombraba: los casos vivos están
   implementados en `scripts/capability-dry-run.sql`, no como fichero de test,
   porque necesitan una base y `vitest.config.ts` excluye todo lo que la
   necesita.

**En ningún momento de este diseño se aplica el paquete a un stack vivo.**

## 13. Rollback

`stella_0006_rollback.sql` revierte en orden inverso: `REVOKE`, `DROP POLICY`
×5, `DROP FUNCTION`, `DROP ROLE uellix_cap_invitation`, y `DROP SCHEMA
uellix_capability` **sólo si queda vacío**.

**No revierte** dos cosas, y es deliberado:

* `invitations.accepted_by` — borrar la columna destruiría la atribución de
  toda invitación aceptada mientras la capacidad estuvo activa. El rollback
  la deja, vacía de significado pero íntegra. Lleva un `COMMENT` que lo dice.
* El índice único sobre `token_hash` — es una restricción de integridad que
  era correcta antes y sigue siéndolo.

Estado tras el rollback: la capacidad no existe, y `acceptInvitation` vuelve a
fallar cerrado exactamente como antes. **Cero estado parcial**: el rollback
corre en una sola transacción.

---

## 14. Threat model (FASE 12)

| Amenaza | Severidad si no se mitiga | Mitigación en este diseño | Residual |
|---|---|---|---|
| **Token theft** (correo comprometido, enlace en historial, referrer) | **Alta** | El token no basta: hace falta autenticarse con el correo invitado (paso 10) | Si el atacante controla el buzón, controla la cuenta de todos modos |
| **Token replay** | Media | Paso 7 idempotente por sujeto; `FOR UPDATE`; `accepted_by` | Ninguno |
| **Brute force** | Baja | 256 bits de entropía; rate limit para DoS, no para adivinación | Ninguno realista |
| **Enumeration** | **Alta** en el flujo actual | Error uniforme `U0001` desde un único punto; sin escritura diferencial | **Timing**: el camino que compara correo hace un `SELECT` extra sobre `users`. Un atacante con medición precisa podría distinguir "token válido, correo distinto" de "token inexistente". Mitigación propuesta: ejecutar siempre el `SELECT` de `users` antes de ramificar. **Registrado como RR-CAP-01-A** |
| **Cross-org** | **Alta** | La organización sale de la fila de la invitación, jamás de un parámetro | Ninguno |
| **Confused deputy** | Alta | El definer sólo puede insertar membresías `active` con rol ≠ super_admin, y sólo puede mover invitaciones `pending → accepted` | Ninguno |
| **Privilege escalation** | **Alta** | El rol se toma de la fila; la policy prohíbe `super_admin`; sin `UPDATE` sobre `organization_members` | Quien crea la invitación elige el rol — eso es correcto y es una decisión de admin, no de la capacidad |
| **Duplicate request** | Media | Ver §8 | Ninguno |
| **Timeout** | Media | `lock_timeout = 3s` → error uniforme; el cliente reintenta; el reintento es idempotente | Ninguno |
| **Partial failure** | Alta | Todo el cuerpo es una función = una transacción. O hay membresía + invitación cerrada + 2 auditorías, o no hay nada | Ninguno |
| **Log leakage** | **Media** | El endpoint nunca registra el token; los errores de la aplicación registran el motivo real sin el token | **RR-CAP-3**: `log_statement='all'` en el servidor registraría el parámetro. Comprobación de runbook |
| **SQL injection** | Alta | Cero SQL dinámico, cero concatenación, todo parámetro ligado | Ninguno |
| **`search_path` injection** | **Alta** | `search_path = ''` + todo cualificado. Sin `pg_temp` no hay nada que sombrear | Ninguno |
| **Payload amplification** | Baja | Un `text`; se rechaza si no mide 64 caracteres antes de tocar índice | Ninguno |
| **Denial of service** | Media | `lock_timeout`, rate limit por IP y sujeto, cero escritura en el rechazo | Un atacante con muchas IP puede saturar el endpoint — problema de la capa HTTP, no de la capacidad |
| **Abuse automation** | Baja | Rate limit; sin oráculo que automatizar | Ninguno |

### 14.1 RR-CAP-01-A — canal lateral de temporización

**El único hallazgo del threat model de esta capacidad que el diseño no cierra
por completo.** El camino "token válido, correo distinto" ejecuta un `SELECT`
sobre `public.users` que el camino "token inexistente" no ejecuta. La
diferencia es de microsegundos y está enterrada bajo la latencia de red y del
rate limiter, pero **existe**.

Mitigación propuesta (incorporada al SQL del paquete): resolver el correo del
sujeto **antes** de mirar la invitación, de modo que ambos caminos ejecuten el
mismo número de consultas. Coste: un `SELECT` por índice primario incluso
cuando el token es basura — despreciable, y ya se paga la protección de forma
del paso 4.

Severidad tras la mitigación: **MINOR**. No se declara cerrado porque la
igualdad exacta de temporización no se ha medido y no se puede medir sin
ejecutar.

---

## 15. Riesgos residuales

* **RR-CAP-01-A** — canal lateral de temporización (§14.1). MINOR.
* **RR-CAP-01-B** — DP-CAP-02 sin resolver: si producto elige mensajes
  distinguibles, el oráculo de enumeración vuelve. El diseño lo permite pero
  no lo recomienda; la decisión quedaría registrada como aceptación explícita
  de riesgo.
* **RR-CAP-01-C** — el barrido de invitaciones expiradas no forma parte de esta
  capacidad. Sin él, las filas `pending` caducadas se acumulan. No es un
  riesgo de seguridad (la función comprueba `expires_at`), es de higiene.
* **RR-CAP-3** (global) — el token crudo cruza a la base.
