# Modelo de roles y privilegios de base de datos

**Estado:** ensayado y aplicado **sólo en el stack local** desde 2026-08-02.
**Alcance:** los objetos Uellix del esquema `public` de este worktree.
**Scripts:** `db/prepared/stella_0004_role_separation.sql` (+ rollback).
**Fuente canónica de verificación:** `pg_catalog` + `aclexplode`.
Nunca `information_schema.role_table_grants` — ver §9.

> Este documento **no** aprueba G2 remoto, **no** declara producción lista y
> **no** habilita grounding. Describe el contrato de privilegios y qué parte
> de él es reproducible en Supabase gestionado.

---

## 1. El problema que existía

Medido sobre el stack local (PostgreSQL 17.6) el 2026-08-02, antes de aplicar
nada:

| Hecho | Consecuencia |
|---|---|
| Las **38** tablas de `public` y las **8** funciones tenían `relowner`/`proowner` = `postgres` | `postgres` era el rol al que resolvía `DATABASE_URL`, es decir el **runtime de la aplicación**. El runtime era el owner. Desde el cutover (`stella_0005`) el runtime resuelve `UELLIX_RUNTIME_DATABASE_URL` y se autentica como `uellix_app`; ver [`DATABASE_RUNTIME_CUTOVER.md`](DATABASE_RUNTIME_CUTOVER.md). |
| El owner **no está sujeto a RLS** salvo `FORCE ROW LEVEL SECURITY`, y `relforcerowsecurity` era `false` en **38/38** | Las 104 policies no gobernaban al backend. Sólo protegían el camino PostgREST/navegador. |
| `postgres` tiene además `rolbypassrls = true` | Aunque dejara de ser owner, seguiría exento. Dos capas de exención, ninguna declarada. |
| `postgres` es miembro de `anon`, `authenticated`, `authenticator` y `service_role` **con `ADMIN OPTION`** | Podía `SET ROLE` a cualquiera de ellos y re-concederlos. |
| El owner podía `ALTER TABLE … DISABLE TRIGGER`, `DROP POLICY`, `DISABLE ROW LEVEL SECURITY`, `DROP TABLE` | Los **10** triggers append-only eran la única barrera contra el propio runtime, y el runtime podía apagarlos. |
| `pg_default_acl` de `postgres` en `public` concedía `MAINTAIN, REFERENCES, TRIGGER, TRUNCATE` a `authenticated` en **toda tabla futura** | `TRUNCATE` **no está sujeto a RLS**. Cerrado para 4 tablas por `stella_0002b`; abierto para las 34 restantes y para cualquier tabla nueva. |
| `pg_default_acl` de `supabase_admin` en `public` concedía los **8** privilegios a `anon` | Cualquier tabla creada por `supabase_admin` en `public` nacía con DML completo para el rol **no autenticado**. |
| `pg_default_acl` de `postgres` en `public` concedía `UPDATE` sobre secuencias a `anon` | `UPDATE` sobre una secuencia habilita `nextval()` y `setval()`. |
| Funciones nuevas: `proacl` nulo ⇒ `EXECUTE TO PUBLIC` implícito | Verificado: `has_function_privilege('anon', …, 'EXECUTE') = true` sobre una función recién creada. |
| Tipos y dominios nuevos: `typacl` nulo ⇒ `USAGE TO PUBLIC` implícito | Idem. |

Las dos últimas filas de `pg_default_acl` **no provienen de ninguna migración
de este repositorio**: las instala el bootstrap de Supabase. Son invisibles en
`db/migrations/`, en `db/policies/` y en el snapshot de Drizzle.

---

## 2. Los cinco roles

Prefijo `uellix_`. No colisiona con los espacios reservados `pg_*` ni
`supabase_*`.

### A. `uellix_owner` — object owner

```
NOLOGIN  NOINHERIT  NOBYPASSRLS  NOCREATEDB  NOCREATEROLE  NOREPLICATION
```

Propietario de los objetos Uellix de `public`. **No abre sesiones** (no tiene
`LOGIN`), así que no existe cadena de conexión que lo use. Sólo es alcanzable
por `SET ROLE` desde `uellix_migrator`, y por ningún otro rol.

Es el único rol que puede `ALTER`, `DROP`, `CREATE POLICY`, `DISABLE TRIGGER`
o `ALTER … DISABLE ROW LEVEL SECURITY` sobre esos objetos.

### B. `uellix_migrator` — migrador

```
LOGIN  NOINHERIT  NOBYPASSRLS  NOCREATEDB  NOCREATEROLE  NOREPLICATION
GRANT uellix_owner TO uellix_migrator WITH SET TRUE, INHERIT FALSE, ADMIN FALSE
```

`INHERIT FALSE` es deliberado y es el corazón del diseño: el migrador **no
tiene** los privilegios del owner mientras opera normalmente. Los adquiere sólo
tras un `SET ROLE uellix_owner` explícito, que queda en el log de la sesión y
en el script que lo ejecuta. Una conexión del migrador que no haga `SET ROLE`
es tan impotente como cualquier otra.

`ADMIN FALSE` impide que el migrador conceda `uellix_owner` a un tercero.

No sirve tráfico. No ejecuta seeds. No ejecuta resets.

### C. `uellix_app` — runtime de aplicación

```
LOGIN  NOINHERIT  NOBYPASSRLS  NOCREATEDB  NOCREATEROLE  NOREPLICATION
GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE, ADMIN FALSE
```

No es owner. No tiene `BYPASSRLS`. No tiene `CREATE` sobre `public`. No es
miembro de `uellix_owner` ni de `anon`/`authenticated`/`service_role`. No puede
`SET ROLE` a nada.

Todo su poder de escritura llega **heredado de `uellix_writer`**, de modo que
la superficie de escritura del runtime se lee en un solo lugar
(`aclexplode` filtrado por el OID de `uellix_writer`) en vez de en 38 ACL.

Queda **sujeto a RLS**: al no ser owner y no tener `BYPASSRLS`, las 104
policies se le aplican.

### D. `uellix_writer` — writer gobernado

```
NOLOGIN  NOINHERIT  NOBYPASSRLS
```

Rol-paquete, sin sesión propia. Contiene exactamente los privilegios DML que
el producto necesita, partidos en dos clases de tabla:

| Clase | Tablas | Privilegios de `uellix_writer` |
|---|---|---|
| **Append-only** | `audit_logs`, `sroi_calculation_runs`, `sroi_calculation_line_items`, `stella_interactions`, `stella_suggestion_decisions` | `SELECT`, `INSERT` |
| **Operacional** | las **33** restantes | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |

Nunca `TRUNCATE`, `REFERENCES`, `TRIGGER` ni `MAINTAIN` sobre ninguna tabla.
No administra ACL, policies ni triggers: para eso hace falta ownership, y no
lo tiene.

La clase append-only queda protegida por **tres** capas independientes:
la ausencia de `UPDATE`/`DELETE` en la ACL, los 10 triggers `BEFORE UPDATE OR
DELETE` / `BEFORE TRUNCATE`, y la ausencia de `TRUNCATE` en la ACL.

### E. `uellix_auditor` — auditor read-only

```
LOGIN  NOINHERIT  NOBYPASSRLS
ALTER ROLE uellix_auditor SET default_transaction_read_only = on
```

`SELECT` sobre las 38 tablas, `USAGE` sobre `public`, y nada más. Cero
membresías, así que no hay privilegio alcanzable por herencia.

`default_transaction_read_only = on` es **defensa en profundidad, no la
barrera**: cualquier rol puede `SET default_transaction_read_only = off` en su
propia sesión. La barrera real es que el auditor no tiene ningún privilegio de
escritura que activar, no puede crear objetos en `public` (sin `CREATE`) y no
tiene `EXECUTE` sobre ninguna función `SECURITY DEFINER` que escriba.

---

## 3. Matriz de privilegios

Leyenda: `S`=SELECT `I`=INSERT `U`=UPDATE `D`=DELETE `T`=TRUNCATE
`R`=REFERENCES `Tg`=TRIGGER `M`=MAINTAIN (PG17) `X`=EXECUTE `Us`=USAGE
`C`=CREATE. `—` = ningún privilegio.

### 3.1 Atributos de rol

| Rol | LOGIN | INHERIT | BYPASSRLS | CREATEDB | CREATEROLE | REPLICATION | Owner |
|---|---|---|---|---|---|---|---|
| `uellix_owner` | no | no | no | no | no | no | **sí** |
| `uellix_migrator` | sí | no | no | no | no | no | no |
| `uellix_app` | sí | no | no | no | no | no | no |
| `uellix_writer` | no | no | no | no | no | no | no |
| `uellix_auditor` | sí | no | no | no | no | no | no |

### 3.2 Membresías

| Miembro | De | `ADMIN` | `INHERIT` | `SET` |
|---|---|---|---|---|
| `uellix_migrator` | `uellix_owner` | no | **no** | **sí** |
| `uellix_app` | `uellix_writer` | no | **sí** | **no** |
| **`postgres`** | **`uellix_writer`** | no | **sí** | **no** |

**Son tres, no dos, y la tercera es transitoria pero portante.** `db/client.ts`
sigue conectando como `postgres`, y `ALTER TABLE … OWNER TO` **no** deja atrás
la entrada ACL del owner anterior: la transfiere. Verificado sobre
`public.projects` — tras el cambio, `postgres` no conservaba **ningún**
privilegio directo. En 37 de las 38 tablas eso queda enmascarado porque
`postgres` hereda de `authenticated`, `service_role` y `pg_read_all_data`; pero
**no** en `stella_suggestion_decisions`, donde `authenticated` sólo tiene
`SELECT` y `service_role` no tiene nada. Sin esa membresía la aplicación
perdería la capacidad de persistir decisiones de Stella.

Concederle el **rol** en vez de privilegios sueltos es deliberado: el runtime
heredado acaba con **exactamente** la superficie de escritura gobernada,
definida en un solo sitio y demostrablemente sin `TRUNCATE`, `REFERENCES`,
`TRIGGER`, `MAINTAIN` ni capacidad de DDL sobre esas tablas.

Consecuencia que conviene decir en voz alta: la afirmación *"la superficie de
escritura de la app se lee en un solo rol"* pasa a describir también a
`postgres`. Es una propiedad del diseño, no un efecto colateral, y desaparece
cuando se cierre **DP-07**.

Ninguna otra membresía. En particular: `uellix_app` **no** es miembro de
`uellix_owner`, `uellix_auditor` no es miembro de nada, y ningún rol Uellix es
miembro de `anon`, `authenticated`, `authenticator` o `service_role`.

### 3.3 Tablas de `public` (38)

| Rol | Append-only (5) | Operacional (33) |
|---|---|---|
| `uellix_owner` | ownership (implícito) | ownership (implícito) |
| `uellix_migrator` | — (adquiere vía `SET ROLE`) | — (adquiere vía `SET ROLE`) |
| `uellix_writer` → `uellix_app` | `S I` | `S I U D` |
| `uellix_auditor` | `S` | `S` |
| `authenticated` | sin cambio en `S I U D`; **se revoca `T R Tg M`** | ídem |
| `service_role` | sin cambio en `S I U D`; **se revoca `T R Tg M`** | ídem |
| `anon` | — | — |
| `PUBLIC` | — | — |
| `postgres` | **pierde toda ACL directa** (se transfiere al nuevo owner) y **recibe `S I` heredado** de `uellix_writer` | ídem, pero `S I U D` |

La fila de `postgres` **no** es "sin cambio", y decirlo así sería el error más
fácil de cometer aquí. Cambian dos cosas a la vez y en direcciones opuestas:
pierde todas sus concesiones directas sobre las 38 tablas — incluidas
`TRUNCATE`, `REFERENCES`, `TRIGGER` y `MAINTAIN`, y la capacidad de `ALTER`,
`DROP`, `DROP POLICY`, `DISABLE ROW LEVEL SECURITY` y `DISABLE TRIGGER` que
venía del ownership — y gana, por membresía explícita, exactamente la
superficie de escritura gobernada. Ver §3.2.

### 3.4 Esquemas

| Esquema | Rol | Privilegio |
|---|---|---|
| `public` | `uellix_owner` | `Us C` |
| `public` | `uellix_migrator` | `Us` |
| `public` | `uellix_app` | `Us` |
| `public` | `uellix_writer` | `Us` |
| `public` | `uellix_auditor` | `Us` |
| `public` | `PUBLIC` | `Us` (preexistente de Supabase; **sin `C`**, verificado) |
| `auth` | `uellix_owner` | **`Us`** — único privilegio concedido fuera de `public` |

El `USAGE` sobre `auth` es una consecuencia directa e inevitable del cambio de
owner, no una ampliación: ver §6. **No** incluye ningún privilegio sobre
ninguna tabla de `auth`, y el script lo verifica
(`has_table_privilege('uellix_owner','auth.users','SELECT') = false`).

### 3.5 Funciones de `public` (8)

Cambian de owner a `uellix_owner`, lo que altera el usuario efectivo de las 7
`SECURITY DEFINER` — ver §6. La ACL efectiva se preserva (`postgres` recupera
su `EXECUTE`, `PUBLIC` sigue sin ninguno) con **una** adición deliberada:

| Función | `authenticated` | `uellix_writer` → `uellix_app` | `uellix_auditor` |
|---|---|---|---|
| `current_user_org_ids()` | `X` (previo) | **`X` (nuevo)** | **`X` (nuevo)** |
| `current_user_is_super_admin()` | `X` (previo) | **`X` (nuevo)** | **`X` (nuevo)** |
| `current_user_role_in_org(uuid)` | `X` (previo) | **`X` (nuevo)** | **`X` (nuevo)** |
| `can_read_evidence_object(...)` | `X` (previo) | — | — |
| `can_write_evidence_object(...)` | `X` (previo) | — | — |
| `handle_new_user()` | — | **—** | **—** |
| `handle_update_user()` | — | **—** | **—** |
| `uellix_forbid_mutation()` | — | — | — |

**Por qué esos tres `EXECUTE` no son opcionales.** Evaluar una policy RLS exige
que el **rol invocante** tenga `EXECUTE` sobre cada función que la expresión de
la policy llama. Casi todas las 104 policies llaman a `current_user_org_ids()`
o a `current_user_is_super_admin()`. Sin esos grants, un `SELECT` de
`uellix_app` o `uellix_auditor` **no** devuelve cero filas: falla con
`permission denied for function current_user_org_ids`. `authenticated` ya los
tenía exactamente por la misma razón, así que esto es consistencia con el
modelo existente, no una concesión nueva.

Las **dos** funciones que escriben (`handle_new_user`, `handle_update_user`)
quedan fuera. Eso es lo que convierte "sin escritura indirecta mediante
funciones" en una afirmación comprobable: el script la verifica por nombre.

### 3.6 Default privileges (objetos futuros)

La tabla describe, para cada rol creador, **qué recibe realmente un objeto que
ese rol cree en `public`** — no qué sentencia se ejecutó. Es una distinción
que importa: una sentencia puede tener éxito y no cambiar nada (ver más abajo).

| Rol creador | Tabla nueva | Secuencia nueva | Función nueva | Tipo nuevo |
|---|---|---|---|---|
| `postgres` | sólo el owner | sólo el owner | owner **+ `PUBLIC`** ⚠️ | owner **+ `PUBLIC`** ⚠️ |
| `supabase_admin` | sólo el owner (local) | sólo el owner (local) | owner **+ `PUBLIC`** ⚠️ | owner **+ `PUBLIC`** ⚠️ |
| `uellix_owner` | **sólo el owner** | **sólo el owner** | **sólo el owner** | **sólo el owner** |
| `uellix_migrator` | **sólo el owner** | **sólo el owner** | **sólo el owner** | **sólo el owner** |

Las dos celdas con ⚠️ son el riesgo residual **RR-08** y **no** están cerradas:
la supresión del `PUBLIC` incorporado sólo funciona en su forma **global**, y
una entrada global para `postgres` o `supabase_admin` alcanzaría todo lo que
crean en `auth`, `storage`, `realtime` y `graphql`. La mitigación es que los
objetos Uellix los crea `uellix_owner`, y que toda migración que cree una
función siga llevando su propio `REVOKE … FROM PUBLIC`.

**"Ninguno implícito" es literal:** una tabla creada por `uellix_owner` nace
con `relacl = NULL`, que `acldefault('r', owner)` resuelve a "sólo el owner".
`uellix_app`, `uellix_writer`, `uellix_auditor`, `authenticated`, `anon`,
`service_role` y `PUBLIC` reciben **cero**. Cada tabla nueva exige un `GRANT`
explícito, y eso es el objetivo, no un inconveniente.

#### La trampa de `ALTER DEFAULT PRIVILEGES` sobre `PUBLIC`

Los `REVOKE … FROM PUBLIC` sobre funciones y tipos hacen falta porque el
default de PostgreSQL **no** es "nada": `acldefault('f', …)` es
`EXECUTE TO PUBLIC` y `acldefault('T', …)` es `USAGE TO PUBLIC`.

Pero la forma habitual de escribirlos **no funciona**. Medido en este stack
(PostgreSQL 17.6, 2026-08-02):

```
ALTER DEFAULT PRIVILEGES FOR ROLE r IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    → 0 filas en pg_default_acl. La función nueva tiene proacl = NULL y
      has_function_privilege('anon', …, 'EXECUTE') = TRUE.
      La sentencia reporta éxito y no hace nada.

ALTER DEFAULT PRIVILEGES FOR ROLE r
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    → 1 fila con defaclnamespace = 0. La función nueva tiene
      proacl = {r=X/r} y has_function_privilege('anon', …) = FALSE.
```

La razón es que una entrada **por esquema** se fusiona *encima* de
`acldefault()`, así que sólo puede **añadir** privilegios; sólo la entrada
**global** reemplaza la base. Una auditoría que diera por buena la forma por
esquema estaría leyendo un `ALTER` exitoso como un agujero cerrado.

La forma global es segura aquí precisamente porque está acotada **por rol**:
`uellix_owner` y `uellix_migrator` los crea este script y no crean nada fuera
de `public`. Además la entrada es **restrictiva** — quita un grant —, de modo
que su radio de acción está acotado aunque eso dejara de ser cierto.

`postgres` y `supabase_admin` quedan **excluidos** de la forma global: una
entrada global para ellos alcanzaría todo lo que crean en `auth`, `storage`,
`realtime` y `graphql`, fuera de la allowlist. Es el riesgo residual RR-08.

### 3.7 `MAINTAIN` (PostgreSQL 17)

`MAINTAIN` habilita `VACUUM`, `ANALYZE`, `CLUSTER`, `REINDEX`,
`REFRESH MATERIALIZED VIEW` y `LOCK TABLE` sobre la relación. `LOCK TABLE` en
manos de `authenticated` es una vía de denegación de servicio, y ninguna de las
seis operaciones la necesita el producto.

Se trata explícitamente en tres sitios: se revoca de la ACL existente de
`authenticated` y `service_role` en las 38 tablas, se elimina de los default
privileges de todos los roles creadores, y los tests lo comprueban por nombre.

El token `MAINTAIN` **no existe antes de PostgreSQL 17**: en un servidor
anterior es un error de sintaxis, y un error de sintaxis no lo evita un `IF`
alrededor de una sentencia que se parsea estáticamente. `stella_0002b` resolvió
eso con un guard de versión alrededor de un `EXECUTE`, porque debía poder
correr en servidores mixtos.

**`stella_0004` no usa ese guard, y es deliberado:** su sección 0 **aborta** si
`server_version_num < 170000`, así que nunca alcanza un servidor donde el token
no exista. Las sentencias siguen dentro de `EXECUTE` — para que el parseo
ocurra en tiempo de ejecución y no al definir la función — pero la barrera de
versión es el precondition, no un `IF` por sentencia. Una sola barrera,
declarada en un sitio.

---

## 4. Qué NO cambia, y por qué

| No se toca | Razón |
|---|---|
| `relforcerowsecurity` (sigue en 0/38) | `FORCE RLS` sometería a RLS a las 7 funciones `SECURITY DEFINER` propiedad del owner. `handle_new_user` inserta en `public.users` desde un trigger de `auth.users` sin claims JWT: con `FORCE RLS` el alta de usuarios fallaría. Activarlo es una decisión de producto separada. |
| Atributos del rol `postgres` | Es un rol interno de Supabase. `NOBYPASSRLS` sobre él rompería Studio, `pg_meta` y el pooler. Fuera de la allowlist. |
| `rolbypassrls` de `service_role` | Ídem: es el contrato de Supabase con PostgREST. |
| Ownership del esquema `public` (`pg_database_owner`) | Convención de Supabase. Cambiarlo rompe la resolución de `CREATE` para el owner de la base. |
| Esquemas `auth`, `storage`, `realtime`, `graphql*`, `vault`, `net`, `extensions`, `supabase_functions`, `pgbouncer`, `_realtime`, `supabase_migrations` | Internos de Supabase. Ningún objeto suyo entra en el cambio. |
| Esquema `drizzle` y su tabla `__drizzle_migrations` | Registro del migrador; se mantiene en `postgres` para no romper `drizzle-kit`. Ver §7. |
| ACL `S I U D` de `authenticated` y `service_role` | PostgREST las necesita y RLS las gobierna. Sólo se revoca `T R Tg M`. |
| Las 104 policies | Ninguna se crea, altera ni borra. |
| Los 10 triggers append-only | Ninguno se crea, altera ni borra. |
| Los datos | Ninguna sentencia del forward escribe filas. |

---

## 5. Compatibilidad con Supabase (Fase 5)

### 5.0 Este script, tal como está escrito, NO corre en Supabase gestionado

Antes de cualquier matiz: la sección 0 de
`stella_0004_role_separation.sql` **aborta** si `current_user` no tiene
`rolsuper`. En Supabase gestionado el rol más alto disponible es `postgres`, que
**no** es superusuario. El script no es "aplicable con precauciones" en remoto:
no arranca.

La razón por la que exige superusuario está en 5.2 y no es negociable — un rol
`CREATEROLE` no superusuario se auto-concede `ADMIN OPTION` sobre cada rol que
crea, y con esa `ADMIN OPTION` puede concederse `SET` sobre el owner. Además la
sección 9.11b hace `SET LOCAL ROLE uellix_owner`, que exige `set_option = true`;
la auto-membresía de un `CREATEROLE` es `admin=true, inherit=false, **set=false**`
(medido), así que ni siquiera esa comprobación pasaría.

**Una variante remota sería un script distinto**, con otro modelo de confianza
y su propia revisión. La tabla siguiente dice qué *operaciones* serían
reproducibles si ese script existiera; no dice que éste lo sea.

### 5.1 Qué operaciones serían reproducibles en remoto y cuáles no

| Elemento | Local | Supabase gestionado | Nota |
|---|---|---|---|
| Crear los 5 roles | **sí**, como `supabase_admin` | **sí**, como `postgres` (tiene `CREATEROLE`) | pero ver 5.2 |
| Transferir ownership de las 38 tablas | **sí** | **sí** | el owner actual debe ser miembro del nuevo owner |
| Revocar `T R Tg M` a `authenticated`/`service_role` | **sí** | **sí** | `postgres` es grantor de esas ACL |
| Corregir `pg_default_acl` **de `postgres`** | **sí** | **sí** | un rol siempre puede alterar sus propios default privileges |
| Corregir `pg_default_acl` **de `supabase_admin`** | **sí** | **NO** | `postgres` no es superusuario ni miembro de `supabase_admin` en hosted. **Limitación estructural.** |
| Suprimir el `EXECUTE`/`USAGE` a `PUBLIC` en objetos futuros de `uellix_owner` | **sí** | **sí** | entrada **global** de `pg_default_acl`, acotada por rol — §3.6 |
| `GRANT USAGE ON SCHEMA auth TO uellix_owner` | **sí** | **NO** | `auth` es de `supabase_auth_admin`; `postgres` tiene `USAGE` **sin** `GRANT OPTION`. **RR-09, bloqueante para G2 remoto.** |
| Impedir que `postgres` alcance el owner | **sí** | **NO** | ver 5.2 |

### 5.2 La limitación de fondo del modelo remoto

Verificado empíricamente en este stack (PostgreSQL 17.6):

- Cuando un rol con `CREATEROLE` **no superusuario** ejecuta `CREATE ROLE x`,
  PostgreSQL 16+ le auto-concede la membresía en `x` con
  `admin_option = true, inherit_option = false, set_option = false`.
- Cuando un **superusuario** ejecuta `CREATE ROLE x`, no se crea ninguna
  membresía: `pg_auth_members` devuelve **0 filas**.

En Supabase gestionado el rol más alto disponible es `postgres`, que no es
superusuario. Por tanto **cualquier rol creado remotamente queda bajo la
`ADMIN OPTION` de `postgres`**, y `postgres` puede en cualquier momento
ejecutar `GRANT uellix_owner TO postgres WITH SET TRUE` y volverse el owner.

Consecuencia honesta: **en remoto la separación owner/runtime sólo tiene valor
real si el runtime deja de ser `postgres`.** Mientras `DATABASE_URL` remoto
apunte a `postgres`, la transferencia de ownership es un obstáculo auditable
(exige una sentencia explícita), no una barrera criptográfica.

Localmente el forward corre como `supabase_admin`, así que la barrera **sí** es
real: `postgres` no tiene ninguna vía hacia `uellix_owner`.

> **CORRECCIÓN (2026-08-02, tras la reauditoría independiente).** El párrafo
> anterior era correcto sobre `uellix_owner` y **prematuro** sobre el resto. La
> reauditoría midió que, con `stella_0004` instalado, el runtime local **seguía
> siendo `postgres`**: `DATABASE_URL` no había cambiado, `row_security_active`
> era `false` para todas las consultas del producto y `postgres` conservaba
> `BYPASSRLS`, `CREATEROLE` y `CREATE` sobre `public` vía `pg_database_owner`.
> Es decir: el modelo era correcto, estaba instalado, y **no gobernaba ni una
> sola consulta de la aplicación**.
>
> Tres afirmaciones que circulaban y eran falsas:
>
> - *"el runtime ya no podía hacer `DROP POLICY`"* — podía, escalando a owner
>   vía `CREATEROLE`;
> - *"Drizzle estaba mitigado"* — `db:migrate:local` seguía conectando como
>   `postgres` y `drizzle.__drizzle_migrations` seguía siendo suyo;
> - *"el modelo gobernaba el tráfico real"* — nada preguntaba jamás al servidor
>   con qué rol se autenticaba la aplicación, y esa ausencia de comprobación es
>   la razón de que el estado durase semanas.
>
> Lo resuelto en local está en
> [`DATABASE_RUNTIME_CUTOVER.md`](DATABASE_RUNTIME_CUTOVER.md). Lo de esta
> sección (§5) **sigue vigente para remoto**.

### 5.3 Impacto por componente

| Componente | Impacto | Estado |
|---|---|---|
| **PostgREST** | Ninguno. Conecta como `authenticator` y hace `SET ROLE` a `anon`/`authenticated`/`service_role`. Ninguno de los tres cambia de membresías ni pierde `S I U D`. Sólo pierden `T R Tg M`, que PostgREST no emite jamás. | verificado |
| **GoTrue / Auth** | Ningún objeto de `auth` cambia. Sí cambia el usuario efectivo de `handle_new_user`/`handle_update_user`, y las tres funciones que llaman a `auth.uid()` exigen `USAGE ON SCHEMA auth` para el nuevo owner — §6.1. Sin ese grant se rompe **toda** la RLS del producto. | verificado en el ensayo |
| **Storage** | Ninguno. `storage.objects` es de `supabase_storage_admin` y queda fuera. Las policies `select_evidence`/`insert_evidence`/`delete_evidence` sobre `storage.objects` llaman a `public.can_read_evidence_object()` / `can_write_evidence_object()`, cuyo `EXECUTE` para `authenticated` no cambia. | verificado |
| **Drizzle (`db:migrate:local`)** | **Rompe si no se ajusta.** `drizzle-kit` emite DDL sobre tablas que pasan a ser de `uellix_owner`. Se resuelve apuntando la config local al migrador — §7. | mitigado |
| **Scripts preparados 0002 / 0002b / 0003** | **Rompen si no se ajustan.** Emiten `REVOKE`, `GRANT`, `CREATE TRIGGER` y `ALTER TABLE`: todo requiere ownership. Su runbook pasa a exigir `uellix_migrator` + `SET ROLE uellix_owner`. | documentado |
| **Server-side services (`db/client.ts`)** | Ninguno **en este bloque**: el runtime sigue siendo `postgres`. Ver §8. | sin cambio |
| **Funciones `SECURITY DEFINER`** | Cambian de usuario efectivo. §6. | verificado |
| **RLS** | Ninguna policy se toca. Al dejar `postgres` de ser owner, las policies pasan a aplicarle salvo por su `BYPASSRLS`, que se conserva. | sin regresión |

---

## 6. Funciones `SECURITY DEFINER` tras el cambio de owner

Las 8 funciones de `public` pasan a `uellix_owner`. Siete son
`SECURITY DEFINER`, así que su usuario efectivo pasa de `postgres` a
`uellix_owner`.

| Función | `search_path` fijado | Escribe | Efecto |
|---|---|---|---|
| `current_user_org_ids` | `public` | no | lee `organization_members`; `uellix_owner` es el owner ⇒ sin RLS. Igual que antes. |
| `current_user_is_super_admin` | `public` | no | ídem |
| `current_user_role_in_org` | `public` | no | ídem |
| `can_read_evidence_object` | `""` | no | ídem |
| `can_write_evidence_object` | `""` | no | ídem |
| `handle_new_user` | `""` | **sí** (`public.users`) | `uellix_owner` es owner de `public.users` ⇒ `INSERT` permitido. |
| `handle_update_user` | `""` | **sí** (`public.users`) | ídem |
| `uellix_forbid_mutation` | (ninguno) | no | `SECURITY INVOKER`: el cambio de owner no altera su ejecución. |

`uellix_forbid_mutation` es la única sin `search_path` fijado. No es
explotable — no resuelve ningún objeto, sólo hace `RAISE EXCEPTION` — pero
queda anotada como riesgo residual menor en el risk register.

**El auditor no puede escribir indirectamente:** `uellix_auditor` recibe
`EXECUTE` únicamente sobre las **tres** funciones de lectura que las policies
necesitan (§3.5), y **ninguna** de ellas escribe. Las dos que sí escriben
mantienen `EXECUTE` sólo para `postgres`.

### 6.1 El `USAGE` sobre el esquema `auth`

Tres de las ocho funciones (`current_user_org_ids`,
`current_user_is_super_admin`, `current_user_role_in_org`) llaman a
`auth.uid()`. Al pasar a `uellix_owner`, la búsqueda del esquema se hace **como
`uellix_owner`**, que no tenía nada sobre `auth`.

Sin corregirlo, **toda** policy que las llame falla con
`permission denied for schema auth` — un error, no "cero filas" — para
**todos** los invocantes, incluido `authenticated` a través de PostgREST. Es
decir, toda la superficie RLS del producto. Medido en el ensayo desechable el
2026-08-02, antes de tocar el stack vivo.

`auth.uid()` ya lleva `EXECUTE` para `PUBLIC`, así que lo único que faltaba era
la búsqueda del esquema. `GRANT USAGE ON SCHEMA auth TO uellix_owner` es el
mínimo que lo cierra.

**Limitación remota (RR-09):** el esquema `auth` pertenece a
`supabase_auth_admin`, y `postgres` tiene `USAGE` **sin** `GRANT OPTION`. En
Supabase gestionado, `postgres` no puede conceder ese `USAGE` a un rol nuevo:
haría falta que lo hiciera el soporte de Supabase. Localmente el script corre
como `supabase_admin` y sí puede.

---

## 7. Procedimiento local

### 7.1 Quién ejecuta qué

| Operación | Rol de conexión | Requiere `SET ROLE uellix_owner` |
|---|---|---|
| Forward `stella_0004` | `supabase_admin` (superusuario del contenedor) | no — es superusuario |
| Migraciones Drizzle | `uellix_migrator` | sí |
| Scripts preparados `stella_0002/0002b/0003` | `uellix_migrator` | sí |
| Runtime de la aplicación | `postgres` (hoy) / `uellix_app` (objetivo) | no |
| Auditoría read-only | `uellix_auditor` | no |
| Seeds | **bloqueados** por `db/safety` | — |

### 7.2 Aplicación

```
docker exec -i supabase_db_<project_id> \
  psql -U supabase_admin -d postgres -1 -v ON_ERROR_STOP=1 \
  -f db/prepared/stella_0004_role_separation.sql
```

`-1` envuelve todo en una transacción; `ON_ERROR_STOP=1` aborta al primer
error. **Ninguna de las dos es la barrera real**: el script verifica sus
propias precondiciones y postcondiciones con `RAISE EXCEPTION`, de modo que un
inventario que no coincida aborta aunque el operador olvide ambas banderas.

El script es **idempotente**: aplicarlo dos veces produce el mismo estado y la
segunda pasada no emite ningún cambio.

### 7.3 Rollback

`db/prepared/stella_0004_rollback.sql` exige la autorización
destructiva exacta, ligada a **esta** base de datos:

```
-v uellix_rollback_confirmation=rollback-0004:<nombre de la base>
```

**Es parcialmente NO reversor, a propósito.** Lo que sí deshace, siempre:

- devuelve el ownership de las 38 tablas y las 8 funciones a `postgres`;
- retira los grants de esquema, de tabla y de función de los 5 roles, incluido
  el `USAGE ON SCHEMA auth`;
- retira las 3 membresías y las 4 entradas globales de `pg_default_acl`;
- elimina los 5 roles.

Lo que **no** deshace por defecto:

- el `REVOKE` de `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` a `authenticated` y
  `service_role` sobre las 38 tablas;
- la reparación de `pg_default_acl` de `postgres` y `supabase_admin`.

Restaurar eso volvería a conceder a `authenticated` la capacidad de `TRUNCATE`
un audit trail append-only, y haría que toda tabla futura creada por
`supabase_admin` en `public` fuese escribible por el rol **no autenticado**
`anon`. Un rollback que reinstala una vulnerabilidad no es un rollback.

Quien de verdad necesite la restauración bit a bit debe pedirla una segunda vez
y por separado:

```
-v uellix_rollback_restore_unsafe_defaults=yes
```

Y aun así, los grants `Dxtm` **por tabla** no se restauran: su forma original
no era uniforme (28 tablas con el set completo, 6 con un subconjunto, 4 sin
nada), de modo que un re-grant en bloque sería una **ampliación**, no una
restauración. Para ese ACL exacto hay que ir al respaldo.

El rollback aborta si el inventario ha derivado.

Medido en el ensayo desechable: tras el rollback, **cero** filas nuevas
respecto del estado previo; el delta son exactamente 260 filas de ACL y 51 de
default ACL — las dos categorías `SAFE_NON_REVERSING` de arriba.

---

## 8. Riesgo residual explícito: el runtime sigue siendo `postgres`

Este bloque **no** cambia el rol de conexión de `db/client.ts`.

La razón es medible, no una omisión: las 104 policies dependen de
`auth.uid()`, que lee `request.jwt.claims` del ajuste de sesión. Una conexión
`postgres-js` desde Next.js no fija esos claims. Si el runtime pasara hoy a
`uellix_app` — no owner, sin `BYPASSRLS`, y por tanto sujeto a RLS — cada
consulta del servidor devolvería **cero filas**. La aplicación dejaría de
funcionar por completo.

Rotar el runtime exige propagar los claims JWT por transacción, como hace
PostgREST. Eso es un cambio de aplicación, no de privilegios, y se registra
como decisión pendiente **DP-07**.

Lo que este bloque **sí** consigue sin tocar la aplicación:

| Antes | Después |
|---|---|
| El runtime podía `ALTER`/`DROP` **las 38 tablas** | No puede: no es owner |
| El runtime podía `DROP POLICY` sobre ellas | No puede |
| El runtime podía `ALTER TABLE … DISABLE ROW LEVEL SECURITY` | No puede |
| El runtime podía `DISABLE TRIGGER` sobre las tablas append-only | No puede |
| El runtime podía `TRUNCATE` cualquiera de las 38 | No puede (perdió el privilegio con el ownership) |
| Toda tabla futura **creada por el owner** nacía con `Dxtm` para `authenticated` | Nace sin privilegios de terceros |
| Toda función futura **creada por el owner** nacía con `EXECUTE TO PUBLIC` | Nace sin `EXECUTE` para `PUBLIC` |

### 8.1 Lo que NO se consiguió, dicho con precisión

Una versión anterior de esta tabla afirmaba que *"una inyección SQL en el
runtime ya no escala a DDL"*. **Eso es falso y conviene corregirlo sin
rodeos.** Medido tras aplicar el cambio:

```
postgres tiene CREATE sobre public        = true   (es datdba → pg_database_owner)
función creada por postgres en public:  ejecutable por PUBLIC = true
                                        ejecutable por anon   = true
tipo    creado  por postgres en public:  usable por PUBLIC     = true
```

La cadena concreta que sigue abierta: inyección SQL en el runtime →
`CREATE FUNCTION public.x() … SECURITY DEFINER` propiedad de `postgres` →
ejecutable por `anon` a través de PostgREST `/rest/v1/rpc/` → ejecución con los
derechos de `postgres`, que tiene `rolbypassrls`. Es decir, **bypass total de
RLS sin autenticar**.

`postgres` obtiene ese `CREATE` por ser el dueño de la base de datos
(`pg_database_owner`), no por un `GRANT` que este script pudiera revocar;
quitárselo exigiría cambiar el propietario de la base, que es una decisión de
plataforma, no de esquema. Queda registrado como **RR-11**.

Lo que el cambio sí acota es el alcance sobre **los objetos que ya existen**:
las 38 tablas y sus policies y triggers dejan de estar al alcance del runtime.

Y lo que **sigue abierto** hasta DP-07: `postgres` conserva `rolbypassrls`, así
que el backend sigue exento de RLS. El aislamiento por organización en el
camino servidor sigue dependiendo de las comprobaciones explícitas en el código
de aplicación (p. ej. `app/actions/stella/decisions.ts`), que ya existen y
están documentadas allí.

---

## 9. Fuente canónica de ACL

`information_schema.role_table_grants` queda **prohibida como criterio de
gate**. Dos defectos, ambos medidos en este stack:

1. **Expande privilegios alcanzados por membresía.** `postgres` es miembro de
   `authenticated` y `service_role`, así que la vista atribuye a `postgres`
   privilegios que su ACL directa no contiene. Sobre `stella_interactions`
   devolvía **11** filas frente a **4** concesiones directas.
2. **No puede expresar `PUBLIC`.** El grantee `PUBLIC` es el OID 0, que no
   corresponde a ningún `pg_roles.rolname`, así que la vista simplemente no lo
   emite. Una expectativa del tipo *"para PUBLIC: ninguna fila"* es
   **infalsificable** con esa vista.

Adicionalmente, en PostgreSQL 17 la vista trata `MAINTAIN` de forma incompleta
respecto de `aclexplode`.

La fuente canónica es:

| Pregunta | Fuente |
|---|---|
| ACL de una relación | `aclexplode(COALESCE(pg_class.relacl, acldefault('r', relowner)))` |
| ACL de un esquema | `aclexplode(COALESCE(pg_namespace.nspacl, acldefault('n', nspowner)))` |
| ACL de una función | `aclexplode(COALESCE(pg_proc.proacl, acldefault('f', proowner)))` |
| ACL de un tipo | `aclexplode(COALESCE(pg_type.typacl, acldefault('T', typowner)))` |
| Default privileges | `aclexplode(pg_default_acl.defaclacl)` |
| Ownership | `pg_class.relowner`, `pg_proc.proowner`, `pg_namespace.nspowner`, `pg_type.typowner` |
| Membresías y sus opciones | `pg_auth_members` (`admin_option`, `inherit_option`, `set_option`) |
| Atributos de rol | `pg_roles` / `pg_authid` |
| Ajustes por rol | `pg_db_role_setting` |
| `PUBLIC` | `aclexplode(...).grantee = 0` |

El `COALESCE` con `acldefault` importa: una ACL nula **no** significa "sin
privilegios", significa "los del default del tipo de objeto". Leer `relacl IS
NULL` como "cero grants" es exactamente cómo se pasa por alto un
`EXECUTE TO PUBLIC`.

`pg_has_role` y `has_*_privilege` se usan **sólo como verificación
complementaria**, nunca como fuente: responden "¿puede?", que agrega
ownership, superusuario, `BYPASSRLS`, herencia y `PUBLIC` en un único booleano
y por tanto no distingue las cinco causas.

`db/audit/canonical_acl.sql` implementa estas consultas. La vista
`information_schema.role_table_grants` puede conservarse en documentación
**sólo** marcada como informativa.

---

## 10. Evidencia y tests

| Test | Cubre |
|---|---|
| `tests/database-role-safety.test.ts` | atributos de los 5 roles, membresías y sus opciones, ownership de las 38 tablas y 8 funciones, ACL exacta por rol, `SET ROLE` denegado, `BYPASSRLS` ausente, no-owner del runtime |
| `tests/database-default-privileges.test.ts` | `pg_default_acl` de todos los roles creadores, `MAINTAIN`, ausencia de `Dxtm`, objetos futuros (tabla, secuencia, función, tipo) creados y revertidos en transacción |
| `tests/database-target-safety.test.ts` | destino de conexión (preexistente) |
| `tests/database-entrypoint-safety.test.ts` | entrypoints bloqueados (preexistente) |
| `tests/prepared-stella-sql.test.ts` | invariantes offline de los scripts preparados |

---

## 11. Riesgos residuales

| Id | Riesgo | Severidad | Estado |
|---|---|---|---|
| RR-01 | El runtime sigue siendo `postgres` y conserva `BYPASSRLS` | MAJOR | abierto — **DP-07** |
| RR-02 | En Supabase gestionado, `postgres` retiene `ADMIN OPTION` sobre cualquier rol que cree | MAJOR | abierto por diseño de la plataforma — §5.2 |
| RR-03 | El `pg_default_acl` de `supabase_admin` no es corregible desde hosted | MAJOR | abierto en remoto, cerrado en local |
| RR-04 | `uellix_forbid_mutation()` no fija `search_path` | MINOR | aceptado — no resuelve objetos |
| RR-05 | `FORCE ROW LEVEL SECURITY` sigue apagado en 38/38 | MINOR | aceptado — §4 |
| RR-06 | `PUBLIC` conserva `TEMPORARY` y `CONNECT` sobre la base, así que `uellix_auditor` puede `CREATE TEMP TABLE` | MINOR | aceptado. Revocarlo de `PUBLIC` afectaría a roles internos de Supabase. Mitigado: bajo el `default_transaction_read_only=on` del auditor, `CREATE TEMP TABLE` falla con `25006` (verificado). Un `SET default_transaction_read_only=off` explícito lo levanta; una tabla temporal no es una escritura sobre datos Uellix |
| RR-07 | El modelo está ensayado **sólo en local**; nunca se ha aplicado en remoto | BLOCKER para G2 remoto | abierto |
| RR-08 | Funciones y tipos creados en `public` por `postgres` o `supabase_admin` siguen naciendo con `EXECUTE`/`USAGE` para `PUBLIC`: la supresión global no se les aplica porque alcanzaría los esquemas internos de Supabase | MAJOR | aceptado y acotado. Mitigación: los objetos Uellix los crea `uellix_owner`, y toda migración que cree una función debe llevar su propio `REVOKE … FROM PUBLIC` — como ya hacen las 8 existentes |
| RR-09 | En Supabase gestionado, `postgres` no puede conceder `USAGE ON SCHEMA auth` a un rol nuevo (`USAGE` sin `GRANT OPTION`, esquema de `supabase_auth_admin`) | BLOCKER para G2 remoto | abierto — §6.1. Requiere intervención del soporte de Supabase, o no transferir el owner de las 3 funciones que llaman a `auth.uid()` |
| RR-10 | `uellix_auditor` no ve **ninguna fila**: es no-owner y sin `BYPASSRLS`, y las policies dependen de `auth.uid()`, nulo en una conexión directa | Por diseño | Es un auditor de **estructura y privilegios**, no de datos. Darle visibilidad de filas exigiría `BYPASSRLS` o policies dedicadas — decisión **DP-08** |
| RR-11 | **`postgres` conserva `CREATE` sobre `public`** por ser el dueño de la base (`pg_database_owner`), y todo lo que cree ahí nace ejecutable/usable por `PUBLIC` (RR-08). Cadena abierta: inyección SQL en el runtime → `CREATE FUNCTION … SECURITY DEFINER` propiedad de `postgres` → invocable por `anon` vía PostgREST `/rpc/` → ejecución con `rolbypassrls` | MAJOR | **ABIERTO.** No es un `GRANT` revocable: quitarlo exige cambiar el propietario de la base de datos, decisión de plataforma. Se cierra de raíz con **DP-07** (el runtime deja de ser `postgres`). Ver §8.1 |
| RR-12 | El script **no corre** en Supabase gestionado: exige `rolsuper` y allí el rol más alto (`postgres`) no lo es | BLOCKER para G2 remoto | **ABIERTO.** Una variante remota sería un script distinto, con otro modelo de confianza y su propia revisión — §5.0 |

---

## Apéndice — el modelo aplicado al tráfico real (2026-08-02)

Este documento describe **roles y privilegios**. Cerrada la unidad de
compatibilidad, la parte que faltaba —cómo llega una identidad de usuario a una
conexión de `uellix_app`— está en
[`DATABASE_RUNTIME_CUTOVER.md`](DATABASE_RUNTIME_CUTOVER.md) §7–§8. Tres
consecuencias que sí pertenecen al modelo de roles:

**1. `uellix_app` no es miembro de `anon` ni de `authenticated`.** Medido:
`pg_has_role` devuelve false para ambos, y para `service_role`. Es lo correcto
—esa membresía le entregaría todos los grants de esos roles— pero tiene un
efecto que el modelo no había registrado: **una policy con cláusula `TO` que
nombre esos roles no aplica al runtime**. `marketing_leads` es la única tabla de
`public` en esa situación (las otras 104 policies llevan `{public}`), y su
INSERT público quedó cerrado. La corrección es una policy INSERT para
`{public}`, no una membresía de rol.

**2. La claim `role: 'authenticated'` que fija el contexto no es un rol de
base.** Vive dentro del JSON de `request.jwt.claims` y sólo la leen las
funciones que lo inspeccionan. `TO` se contrasta contra `current_user`. Confundir
ambas cosas es el error que produjo el punto anterior.

**3. Las operaciones de bootstrap no tienen identidad de usuario.** Alta de
organización, aceptar invitación, webhook de facturación y verificación pública
por hash escriben o leen filas que ninguna membresía justifica. Antes pasaban
por el bypass de `postgres`. Hoy fallan cerrado y esperan una decisión de
privilegio: policy acotada o identidad técnica separada. **Ninguna se resolvió
inventando una claim** — ver RC-05 a RC-08 en
[`STELLA_FABLE_RISK_REGISTER.md`](STELLA_FABLE_RISK_REGISTER.md).
