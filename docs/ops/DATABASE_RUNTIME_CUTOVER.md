# Cutover del runtime: de `postgres` a `uellix_app`

**Estado:** aplicado **sólo en el stack local** `uellix-stella-g2-local-rehearsal`
(127.0.0.1:56322, PostgreSQL 17.6). Cero remoto. Cero grounding. Cero G2 formal.

**Fuente relacionada:** [`DATABASE_ROLE_MODEL.md`](DATABASE_ROLE_MODEL.md) (el modelo),
[`DATABASE_TARGET_SAFETY.md`](DATABASE_TARGET_SAFETY.md) (a qué base se conecta cada cosa),
[`db/prepared/README.md`](../../db/prepared/README.md) (registro de scripts).

---

## 1. Qué estaba mal, medido

`stella_0004` movió las 38 tablas y las 8 funciones de `public` a `uellix_owner`
y creó `uellix_app` / `uellix_migrator` / `uellix_auditor`. La reauditoría
independiente (`STELLA_DATABASE_PRIVILEGE_REAUDIT_BLOCKED_DDL_ESCALATION`)
encontró que el modelo era correcto **y no gobernaba nada**:

| Hecho medido (2026-08-02, PostgreSQL 17.6) | Consecuencia |
|---|---|
| `DATABASE_URL` resolvía a `postgres` | El runtime era el rol administrativo |
| `postgres` conserva `BYPASSRLS` | `row_security_active` = **false** en todas las consultas del producto |
| `postgres` conserva `CREATEROLE` | Cadena de escalada hacia `uellix_owner` demostrada |
| `postgres` conserva `CREATE` sobre `public` vía `pg_database_owner` | Creación de `SECURITY DEFINER` invocable por `anon` demostrada |
| `pnpm db:migrate:local` corría drizzle-kit como `postgres` | Todo objeto nuevo nacía propiedad del propio runtime |
| Los tres roles LOGIN no tenían credenciales | Nada podía usarlos aunque quisiera |

Las **104 policies eran decorativas** para el tráfico real. No estaban mal
escritas: no se evaluaban.

> **Afirmaciones anteriores que este documento corrige.** Tres cosas que la
> documentación daba por ciertas y no lo eran:
>
> 1. *"El runtime no podía hacer `DROP POLICY`."* Sí podía. Era el owner hasta
>    `stella_0004`, y después seguía siendo `postgres`, que puede escalar a
>    owner vía `CREATEROLE`.
> 2. *"Drizzle estaba mitigado."* No lo estaba. `db:migrate:local` conectaba
>    como `postgres` y `drizzle.__drizzle_migrations` seguía siendo suyo.
> 3. *"El modelo gobernaba el tráfico real."* No lo gobernaba. Ninguna prueba
>    preguntaba jamás al servidor con qué rol se había autenticado la
>    aplicación — esa ausencia es la razón de que el estado durase semanas.

---

## 2. Qué cambia

```
ANTES                                  DESPUÉS
────────────────────────────────       ──────────────────────────────────────────
DATABASE_URL ──> postgres              UELLIX_RUNTIME_DATABASE_URL  ──> uellix_app
  (runtime, migraciones y auditoría      UELLIX_MIGRATOR_DATABASE_URL ──> uellix_migrator
   con la misma cadena)                  UELLIX_AUDITOR_DATABASE_URL  ──> uellix_auditor
```

Una variable por capacidad, y —más importante— **una por fichero**:

| Variable | Fichero | ¿La lee Next.js? |
|---|---|---|
| `UELLIX_RUNTIME_DATABASE_URL` | `.env.local` | **Sí** |
| `UELLIX_MIGRATOR_DATABASE_URL` | `.env.migration.local` | **No** |
| `UELLIX_AUDITOR_DATABASE_URL` | `.env.audit.local` | **No** |

La separación es estructural, no una convención: esos dos nombres no están en la
lista de ficheros de entorno de Next.js. Comprobado en el arranque real del
servidor de desarrollo, que reporta `Environments: .env.local` y nada más.

`DATABASE_URL` ya no se lee para ninguna conexión. Si está definida, se emite un
aviso de que es inerte; nunca actúa como respaldo. Un respaldo "por si falta la
nueva" restauraría la conexión administrativa justo en el entorno donde alguien
se olvidó de configurarla.

### Credenciales

`scripts/rotate-local-role-credentials.ts` es lo único que llega a tener una
contraseña, y la tiene durante un proceso. Genera 32 bytes del CSPRNG por rol,
verifica cada una abriendo una conexión real y preguntando `session_user`, y
escribe la URL en el fichero que le corresponde.

Dos detalles que no son opcionales en este stack:

- corre con `log_statement = ddl`, y `ALTER ROLE ... PASSWORD` **es** DDL. La
  contraseña viaja como parámetro ligado de un `set_config()` y el `ALTER ROLE`
  lo construye un `EXECUTE` dentro de un bloque `DO`; `log_statement` sólo
  registra sentencias recibidas del cliente, no las que ejecuta un cuerpo
  PL/pgSQL;
- el GUC se fija con `is_local => true`, así que se descarta al cerrar la
  transacción aunque el proceso muera a mitad.

No se imprime ninguna contraseña. La única evidencia emitida es un SHA-256
truncado, suficiente para distinguir "tres secretos distintos" de "el mismo tres
veces".

---

## 3. Por qué conectar como `uellix_app` no bastaba

Toda la superficie RLS se reduce a una función:

```
104 policies
  ├── 98 llaman current_user_is_super_admin()
  ├── 33 llaman current_user_org_ids()
  └──  6 llaman auth.uid() directamente
…y las tres resuelven identidad vía auth.uid(), que es
COALESCE(current_setting('request.jwt.claim.sub'), claims->>'sub')
```

Sin claims, `auth.uid()` es NULL, `current_user_org_ids()` es un array vacío y
**toda** policy evalúa falso: la aplicación conecta perfectamente y ve cero
filas. Medido antes del cutover, no supuesto.

Un hallazgo colateral que ahorró un cambio innecesario: `uellix_app` **no**
tiene `USAGE` sobre el esquema `auth`, y aun así las 6 policies que llaman
`auth.uid()` directamente funcionan — los quals de policy se evalúan con
privilegios del dueño de la tabla. No hizo falta conceder nada sobre `auth`.

### El mecanismo: `withDatabaseIdentityContext`

```ts
await withDatabaseIdentityContext(
  { userId, organizationId, isSuperAdmin },
  async (db) => { /* consultas */ }
)
```

1. valida el formato de los UUID **antes** de tocar la base;
2. abre una transacción (`db.transaction()` de drizzle);
3. `set_config('request.jwt.claims', …, is_local => true)`;
4. **reconsulta a la base** para comprobar que la claim tomó efecto, que
   `organizationId` es una organización de la que el usuario es miembro activo y
   que `isSuperAdmin` es cierto según `current_user_is_super_admin()`;
5. ejecuta el callback con el contexto ligado;
6. `COMMIT` o `ROLLBACK` — y el `SET LOCAL` desaparece con cualquiera de los dos.

El paso 4 es lo que impide el IDOR clásico: un `organization_id` enviado por el
cliente no amplía nada, porque se contrasta contra las membresías reales.

**Por qué transacción y no sesión.** postgres-js entrega la misma conexión
física a la petición siguiente. Una `SET` de sesión filtraría la identidad de un
usuario a las consultas de otro — una lectura cross-tenant sin ninguna línea de
código a la que culpar. Fuera de una transacción, además, `SET LOCAL` es un
WARNING sin efecto: lo peor de ambos mundos.

**Por qué AsyncLocalStorage.** 54 módulos importan `{ db }` y lo usan directo.
Enhebrar un handle por sus grafos de llamada sería un cambio mecánico con un
modo de fallo silencioso en cada sitio que se olvidara. En su lugar, el proxy
`db` resuelve al handle de la transacción cuando hay contexto abierto, y al pool
sin claims cuando no lo hay. Dentro de contexto el código existente funciona sin
tocarlo; fuera **falla cerrado** (cero filas), que es exactamente la dirección
deseada. Antes del cutover ese mismo código devolvía las filas de todos los
inquilinos.

---

## 4. La ruta de migración

```
conectar como uellix_migrator      LOGIN, sin CREATE en ningún sitio, sin BYPASSRLS
  └── SET LOCAL ROLE uellix_owner  NOLOGIN, dueño de todo public
        └── ejecutar el DDL
```

La propiedad no es "las migraciones funcionan", sino que el privilegio se
**alcanza** y nunca se **posee**: `uellix_owner` no tiene contraseña y su
membresía es `set_option = true, inherit_option = false` — sólo por `SET ROLE`,
nunca heredada. Una sesión de migrator que olvide el `SET ROLE` no tiene más
acceso que un desconocido; por eso `assertOwnerRoleActive` no es opcional (un
`SET LOCAL ROLE` fuera de transacción es un WARNING, no un error).

`db/migrator.ts` aplica un script preparado así: comprobar identidad → `BEGIN` →
`SET LOCAL ROLE` → comprobar que tomó → ejecutar el fichero completo con
protocolo simple (equivalente estructural de `ON_ERROR_STOP`) → **verificar
ownership y ACL antes del `COMMIT`** → confirmar o revertir entero. Se registra
el SHA-256 del fichero, nunca su contenido.

Comandos:

```bash
pnpm db:migrate:local                                    # cadena drizzle
pnpm db:prepared:apply:local stella_0005_runtime_cutover.sql
pnpm db:prepared:verify:local stella_0005_runtime_cutover.sql   # dry-run con rollback
```

**Excepción documentada.** `pnpm db:migrate:local` usa `SET ROLE` de sesión, no
`SET LOCAL`: `migrate()` de drizzle gestiona su propia transacción, así que no
hay transacción externa a la que atar un ajuste `LOCAL`. Los controles
compensatorios son que el pool tiene exactamente **una** conexión (`max: 1`),
que el proceso termina inmediatamente después y que `session_user` sigue siendo
`uellix_migrator` en todo momento.

---

## 5. El SQL: por qué son dos scripts

| Script | Corre como | Contiene |
|---|---|---|
| `stella_0005b_admin_bootstrap.sql` | **superusuario** | `ALTER ROLE … SET`, ownership del esquema `drizzle` |
| `stella_0005_runtime_cutover.sql` | `uellix_migrator` → `SET ROLE uellix_owner` | policies, `search_path` de funciones, default privileges |

No es estilo. `uellix_owner` no tiene `CREATEROLE` y no posee el esquema
`drizzle`, así que `ALTER ROLE … SET` y `ALTER SCHEMA … OWNER` **no pueden**
correr por la ruta del migrator. Meterlos en el mismo fichero habría obligado a
aplicar todo el cutover como administrador, y eso habría dejado sin comprobar
justo la afirmación central del script. `stella_0005` **se niega** a ejecutarse
si `current_user` no es `uellix_owner` y `session_user` no es `uellix_migrator`
— incluido cuando quien lo aplica es un superusuario.

### 104 → 107 policies

El único conteo que se movió, y se movió porque tenía que hacerlo.
`audit_logs`, `stella_interactions` y `stella_suggestion_decisions` tenían
policy de SELECT y **ninguna de INSERT**: cada escritura funcionaba únicamente
porque `postgres` hacía bypass de RLS. Bajo `uellix_app` el mismo INSERT falla
con *"new row violates row-level security policy"* — medido antes del cutover.
Sin las tres policies, Stella podría leer sus interacciones y no registrar
ninguna más.

Cada policy fija **dos** cosas, no una: la organización (impide escrituras
cross-tenant) y el actor (`created_by = auth.uid()`, impide que un miembro de la
organización correcta forje un registro a nombre de un colega). Un audit trail
append-only que cualquiera puede escribir con la identidad de otro no es un
audit trail.

### Default privileges para objetos futuros

`SELECT` + `INSERT` a `uellix_writer`, `SELECT` a `uellix_auditor`, y nada más.
**Append-only es el default**; `UPDATE`/`DELETE` son un opt-in explícito por
tabla que una migración tiene que escribir. Sin ninguna entrada, una tabla nueva
sería invisible para el runtime y el primer síntoma sería un 500; con una
entrada descuidada, toda tabla futura nacería mutable, incluida la siguiente
append-only.

---

## 6. Lo que NO se pudo arreglar

Un tipo compuesto o dominio creado en `public` por `postgres` o `supabase_admin`
sigue siendo `USAGE`-able por `PUBLIC`. Dos medidas, ambas tomadas al escribir
el script:

1. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE USAGE ON
   TYPES FROM PUBLIC` **no guarda nada**;
2. añadiendo antes un `GRANT USAGE ON TYPES TO postgres` **sí** guarda la fila —
   y la fila **nunca se consulta**. Un tipo creado después sale con
   `typacl = NULL` y `has_type_privilege('public', …, 'USAGE') = true`. El mismo
   par de sentencias **sin** `IN SCHEMA` funciona de inmediato.

Es la misma trampa que `stella_0004` ya había documentado para funciones: una
entrada acotada a esquema se fusiona **encima** de `acldefault()` y sólo puede
añadir. La forma que funciona es justamente la que no se puede acotar: una
entrada global sobre `postgres` gobernaría todo tipo que cree en `extensions`,
`storage`, `realtime` y cualquier esquema que añada una futura versión de
Supabase.

**No se declara arreglado.** La contención es operativa:

- todo DDL de Uellix se crea como `uellix_owner`, cuya entrada **global** de
  `stella_0004` sí deniega a `PUBLIC` (verificado contra un tipo realmente
  creado, en `tests/database-migrator-path.test.ts`);
- `pnpm db:migrate:local` es el único camino que puede aplicar DDL y rechaza
  cualquier sesión que no sea `uellix_migrator`;
- `tests/database-default-privileges.test.ts` falla ante **cualquier** objeto de
  `public` cuyo dueño sea `postgres` o `supabase_admin`, y también ante una fila
  de default TYPE a la que le hayan quitado `PUBLIC` — porque ese estado aparenta
  cerrar la brecha sin cerrarla.

---

## 7. De dónde sale la identidad: el retrofit de la aplicación

El cutover dejó el mecanismo listo y la aplicación sin usarlo. `uellix_app`
conectaba, RLS aplicaba, y **46 entry points ejecutaban consultas sin abrir
contexto**. Peor: `getCurrentUser()` consultaba `public.users` *para descubrir
quién era el usuario*, con lo que el login local dejó de funcionar. El ciclo:

```
para leer public.users necesitás claims
  → para fijar claims necesitás un userId
    → para obtener un userId leías public.users
```

Se rompe negándole a la base la respuesta. El sujeto viene de Supabase Auth y de
ningún otro sitio.

### Las tres capas

| Módulo | Responde | Consulta base |
|---|---|---|
| `lib/auth/identity.ts` | ¿Quién es el sujeto verificado? | **No** |
| `lib/auth/database-context.ts` | ¿Qué dice la base de él? + wrappers | Sí, dentro de contexto |
| `db/identity-context.ts` | Claims, transacción, rollback | Es el mecanismo |

`getVerifiedAuthIdentity()` usa `supabase.auth.getUser()`, **no**
`getSession()`. `getSession()` decodifica la cookie en proceso; la cookie es
dato del atacante, y su `sub` es exactamente el valor que toda policy termina
creyendo. `getUser()` lo valida contra GoTrue. Es un viaje de red por petición:
ese es el precio de la propiedad, y se memoiza — no se evita.

### El segundo ciclo, más pequeño

Un contexto con organización necesita un `organization_id` antes de abrirse, y
la única fuente fiable es `organization_members`, que está detrás de RLS.

Se resuelve abriendo primero un contexto **sin** organización (sólo sujeto),
leyendo perfil y membresía bajo él, y cerrándolo. El contexto organizacional se
abre una sola vez, con un id que dio la propia base. Ese *principal* se memoiza
por petición, así que el coste es una transacción corta extra por petición, no
una por servicio.

Es también por qué el anidamiento nunca se viola: cuando algo abre un contexto
organizacional, el principal ya está resuelto y ninguna llamada interna reentra
con otra organización.

### Por qué NO hubo que tocar 115 funciones de servicio

`lib/**` llama `getCurrentOrganizationContext()` / `requireOrganizationAccess()`
al principio de casi cada función — unas 115 veces. Esas funciones **no
cambiaron**: ahora son lectoras del principal memoizado y no consultan nada. Lo
que cambió son los entry points, que abren el contexto en el que esas consultas
corren.

| Wrapper | Vive en | Ante fallo | Para |
|---|---|---|---|
| `runWithOrganizationAccess` | `lib/auth/session.ts` | `redirect()` | páginas, layouts, server actions |
| `runWithAdminAccess` | `lib/auth/session.ts` | `redirect()` | `/admin` |
| `runWithOptionalOrganizationAccess` | `lib/auth/session.ts` | `cb(null)` | vistas que renderizan vacío |
| `withOrganizationDatabaseContext` | `lib/auth/database-context.ts` | `AuthContextError` | route handlers, servicios |
| `withAuthenticatedDatabaseContext` | `lib/auth/database-context.ts` | `AuthContextError` | trabajo de usuario sin organización |
| `withSuperAdminDatabaseContext` | `lib/auth/database-context.ts` | `AuthContextError` | operaciones administrativas |

`authContextErrorStatus()` mapea cada refuso a su respuesta: **401** para fallos
de identidad, **403** para autorización (a un usuario ya autenticado decirle que
inicie sesión es un bucle, no un arreglo) y **503** para Auth inalcanzable —
distinguir esos tres evita convertir una caída de GoTrue en un cierre de sesión
masivo.

### Decisiones de forma que no son cosméticas

- **La fase de datos se envuelve; el JSX no.** Cada página resuelve todo lo que
  consulta dentro del wrapper y devuelve valores; el JSX se construye después.
  La transacción **cierra antes del streaming**.
- **`redirect()` va fuera del contexto.** `redirect()` lanza, y lanzar dentro
  del callback hace ROLLBACK. Una acción que escribe y luego redirige, con el
  redirect dentro, **perdería la escritura**. Todas quedaron fuera.
- **Un `redirect()` no puede caer en un `catch`.** Donde una acción envuelve el
  servicio en `try/catch` para traducir errores a `?error=`, la comprobación de
  auth se movió **antes** del `try`: si no, un `NEXT_REDIRECT` se tragaría en un
  banner de error genérico.
- **Ninguna transacción abarca una llamada externa.** Las cinco acciones de
  Stella se dividen: contexto corto para leer, llamada al modelo **fuera**,
  contexto corto para persistir. La ruta PDF cierra su transacción antes de
  `renderToBuffer()`. Sostener una conexión del pool durante un viaje a Gemini
  es exactamente lo que la revisión pedía evitar.
- **Excepción: `decisions.ts`.** Ahí las dos comprobaciones de pertenencia y el
  INSERT comparten **una** transacción: separarlos dejaría una ventana en la que
  el proyecto deja de ser de esa organización entre el chequeo y la escritura.

### Cobertura medida

| | |
|---|---|
| Entry points inventariados (`app/**`) | 110 |
| Alcanzan `db/client.ts` (grafo de imports transitivo) | 93 |
| Abren contexto de identidad | 80 |
| En allowlist documentada | 13 |

`tests/database-runtime-entrypoints.test.ts` reconstruye el grafo de imports
—resolviendo `@/`, relativos, re-exports y `import()` dinámico, e ignorando
`import type` y módulos `'use client'`— y falla si un entry point alcanza
`db/client.ts` sin abrir contexto. No es un grep: casi ninguna página consulta
directo, todas llegan a la base a través de dos o tres servicios.

Lleva dos **controles negativos**: `lib/projects/service.ts` debe salir como
"alcanza la base y no abre contexto" (corre dentro del de su llamador) y
`lib/auth/roles.ts` como "no alcanza la base". Si cualquiera de los dos cambia,
la comprobación dejó de discriminar y la suite lo dice.

---

## 8. Operaciones bloqueadas por diseño

Cuatro caminos **funcionaban únicamente porque `postgres` hacía bypass de RLS**.
Ninguno recibió un bypass nuevo. Todos fallan cerrado y están documentados en el
código que los contiene.

| Camino | Por qué no puede pasar | Qué haría falta |
|---|---|---|
| Alta autoservicio de organización (`app/app/onboarding/actions.ts`) | `orgs_insert_super_admin` exige super admin; `members_insert_admin` exige ya ser admin de esa organización | policy acotada, o identidad técnica de bootstrap |
| Aceptar invitación (`lib/invitations/service.ts`) | mismo `members_insert_admin`: quien acepta todavía no es miembro | policy que exprese "invitación válida" en la base |
| Webhook de Stripe (`app/api/webhooks/stripe/route.ts`) | no hay sesión; la organización se busca por `stripe_customer_id`, no por membresía | identidad técnica de webhook con grant estrecho |
| Verificación pública por hash (`lib/reports/public-verify.ts`) | no hay policy de SELECT anónima sobre `sroi_reports` | policy de capacidad: reportes `locked`, por hash |
| Captura de lead público (`app/api/marketing/lead/route.ts`) | ver abajo | policy INSERT para `{public}` |

El comentario de `members_insert_admin` en `001_initial_auth_rls.sql` ya decía
que el onboarding *"usa el cliente Drizzle que hace bypass de RLS entera"* y que
la excepción de auto-inserción **no se añadió a propósito**, porque *"permitiría
a cualquier usuario unirse a cualquier organización"*. Ese cliente ya no existe.
La nota era correcta entonces y sigue siéndolo: la respuesta no es relajar la
policy, es expresar la capacidad real.

### `marketing_leads`: el hallazgo del `TO`

Es la **única** tabla de `public` cuyas policies nombran roles de base en vez de
aplicar a todos (medido: las otras 104 llevan `{public}`):

```
anon_insert_marketing_leads           TO anon           WITH CHECK (true)
authenticated_insert_marketing_leads  TO authenticated  WITH CHECK (true)
super_admins_read_marketing_leads     TO authenticated  USING (is_super_admin)
```

La cláusula `TO` se contrasta con el **rol de base**, no con el campo `role` de
`request.jwt.claims`. El runtime autentica como `uellix_app`, que **no es
miembro de `anon` ni de `authenticated`** — verificado: `pg_has_role` devuelve
falso para ambos. Ninguna policy aplica y el INSERT se rechaza.

Arreglarlo es una policy INSERT para `{public}` sobre esa tabla — la misma regla
"cualquiera puede enviar un lead", escrita contra el rol que de verdad conecta.
Lo que **no** es la respuesta es dar a `uellix_app` membresía en `authenticated`:
eso le entregaría todos los grants de ese rol en toda la base.

**Ninguna de las cinco se decide en esta unidad.** Son decisiones de privilegio.

### El webhook falla ruidosamente, no en silencio

Sin contexto, las lecturas del webhook devuelven cero filas y los UPDATE afectan
cero filas: falla cerrado, pero **en silencio**, y Stripe recibiría 200 con el
cambio de suscripción perdido para siempre. El handler rechaza con **503** —
después de verificar la firma, para que la rama no sea una sonda anónima de
disponibilidad — porque Stripe reintenta un 5xx con backoff y el operador ve el
fallo. Pedir prestada la identidad de "algún admin de esa organización" habría
atribuido una mutación de facturación a una persona que no la hizo, y la fila de
auditoría estaría mal exactamente donde más necesita estar bien.

---

## 9. Limitación local y adaptación remota pendiente

Esto se aplicó **sólo en local**. Para llevarlo a un proyecto Supabase
gestionado quedan por resolver, además de los bloqueos ya registrados en
`DATABASE_ROLE_MODEL.md` §5:

- **Bootstrap con superusuario.** `stella_0005b` requiere `rolsuper`. En Supabase
  gestionado no hay superusuario disponible para el cliente; `ALTER ROLE … SET` y
  `ALTER SCHEMA drizzle OWNER` necesitarán otra vía (o soporte de Supabase).
- **Provisión de credenciales.** El rotador escribe ficheros locales. En Vercel
  las tres variables tendrían que existir por entorno, y sólo
  `UELLIX_RUNTIME_DATABASE_URL` puede estar disponible al runtime.
- **Pooler.** `SET LOCAL` y las transacciones por petición son compatibles con el
  modo *transaction* de PgBouncer, pero hay que verificarlo contra el pooler real
  antes de asumirlo.

## 10. Rollback

`stella_0005_rollback.sql` y `stella_0005b_rollback.sql` revierten **sólo** lo
que sus mitades forward aplicaron. **No** revierten `stella_0004` (el ownership
se conserva) y **no** devuelven el runtime a `postgres`: revertir la conexión es
un cambio de configuración (`UELLIX_RUNTIME_DATABASE_URL`), no de esquema, y
confundir ambos permitiría que un rollback de SQL volviera a dar privilegios a
un proceso en marcha.

Revertir sólo el SQL deja a Stella capaz de leer sus interacciones e incapaz de
registrar nuevas. **Se revierten los dos, o ninguno.**
