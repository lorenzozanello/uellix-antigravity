# `db/` — capa de datos

| Directorio | Qué contiene |
|---|---|
| `db/schema.ts` | schema drizzle, fuente de verdad del modelo |
| `db/client.ts` | **única** fábrica que abre una conexión PostgreSQL |
| `db/safety/` | clasificación de destinos y autorización de operaciones |
| `db/migrations/` | migraciones generadas por `drizzle-kit generate` |
| `db/manual-migrations/` | SQL aplicado a mano, fuera del flujo drizzle |
| `db/policies/` | políticas RLS |
| `db/prepared/` | paquetes SQL revisados para ejecución **remota controlada** (ver `db/prepared/README.md`) |
| `db/audit/` | consultas **read-only** de inspección de privilegios contra `pg_catalog` + `aclexplode` (`canonical_acl.sql`) |

---

## Modelo de roles

Los objetos Uellix de `public` **no** son propiedad del runtime. El contrato de
privilegios — quién es owner, quién migra, quién escribe y quién audita, qué
recibe una tabla que todavía no existe, y qué parte de todo eso es reproducible
en Supabase gestionado — está en
[`docs/ops/DATABASE_ROLE_MODEL.md`](../docs/ops/DATABASE_ROLE_MODEL.md).

Dos reglas que se olvidan con facilidad:

- **La ACL canónica se lee con `aclexplode(COALESCE(acl, acldefault(...)))`,
  nunca con `information_schema.role_table_grants`.** Esa vista expande
  privilegios alcanzados por **membresía** y **no puede expresar `PUBLIC`**, de
  modo que una expectativa del tipo *"para PUBLIC: ninguna fila"* es
  infalsificable con ella.
- **Un ACL nulo no significa "sin privilegios".** Significa el default del tipo
  de objeto, y para funciones ese default es `EXECUTE TO PUBLIC`.

---

## Regla operativa

**Ningún comando de `package.json` escribe en una base de datos remota.**

Todo acceso pasa por `db/safety/`, que es *fail-closed*: si el destino no se
puede clasificar con confianza, o si falta cualquier señal de autorización, la
operación se rechaza. No existe una variable global tipo `ALLOW_REMOTE=true`, y
no existe forma de ejecutar seeds sintéticos contra producción.

El documento operativo completo — clasificación de destinos, capacidades,
comandos permitidos y bloqueados, variables, confirmaciones exactas,
procedimiento local y procedimiento remoto futuro — es
[`docs/ops/DATABASE_TARGET_SAFETY.md`](../docs/ops/DATABASE_TARGET_SAFETY.md).

---

## Uso desde código

### Runtime de la aplicación

Sin cambios respecto a antes del endurecimiento:

```ts
import { db } from '@/db/client'

const rows = await db.select().from(projects)
```

`db` es un proxy perezoso: importarlo no abre nada. La conexión —y la guarda
`app_runtime` que la autoriza— se crean en el primer uso.

### Scripts locales

```ts
import { createLocalDatabaseClient } from '../db/client'

const client = createLocalDatabaseClient({ capability: 'local_seed' })
for (const warning of client.warnings) console.warn(warning)
console.log(client.decision.auditLine)

await client.db.insert(/* ... */)
await client.close()
```

`createLocalDatabaseClient` **ignora `DATABASE_URL`**. Resuelve la URL fija de
`db/safety/local-stack.ts` (o `UELLIX_LOCAL_DATABASE_URL`, que debe ser local y
estar en el puerto esperado) y evalúa la capacidad antes de conectar.

### Comprobar un destino sin conectar

```ts
import { assertDatabaseOperationAllowed } from '../db/safety/database-access'

const decision = assertDatabaseOperationAllowed({
  url,
  capability: 'local_migration',
  expectedLocalPort: LOCAL_DB_PORT,
})
```

Lanza `DatabaseSafetyError` con un `code` estable y un host **redactado**.
Nunca incluye la URL, el usuario, la contraseña ni la query string.

---

## Invariantes que no deben romperse

1. `db/client.ts` no construye clientes en el cuerpo del módulo.
2. Existe exactamente **una** llamada al driver, dentro de
   `createDatabaseClient`, y siempre después de la guarda.
3. **Nada lee `DATABASE_URL`.** Ni scripts, ni configs de drizzle, ni el
   runtime. Esa variable significaba a la vez el runtime, el migrator y el
   auditor, y de tres lecturas siempre ganaba la más privilegiada: así fue como
   la aplicación acabó sirviendo tráfico como `postgres`. Cada capacidad lee
   ahora su propia variable, desde su propio fichero — ver
   `db/safety/resolve-capability-database-url.ts` y
   [`docs/ops/DATABASE_RUNTIME_CUTOVER.md`](../docs/ops/DATABASE_RUNTIME_CUTOVER.md).
4. Ninguna capacidad local acepta un destino que no sea loopback o un
   contenedor explícitamente permitido, en el puerto esperado.
5. Ningún mensaje de error contiene credenciales.
6. **El runtime pregunta al servidor quién es antes de servir tráfico.**
   `db/runtime-bootstrap.ts` comprueba `session_user`, `current_user`,
   `rolsuper`, `rolbypassrls`, `rolcreaterole`, si puede `SET ROLE` al owner y
   si puede `CREATE` en `public`. Si algo diverge, la inicialización aborta con
   un código estable y no se ejecuta ninguna consulta de negocio. El rol
   esperado es una constante importada, no un parámetro: una comprobación que
   quien llama puede reapuntar no es una comprobación.
7. **Toda consulta con datos de inquilino corre dentro de
   `withDatabaseIdentityContext`.** Fuera de un contexto, el cliente compartido
   no ve filas — falla cerrado. Antes del cutover ese mismo código devolvía las
   filas de todos los inquilinos.

Las siete están fijadas por `tests/database-target-safety.test.ts`,
`tests/database-entrypoint-safety.test.ts`,
`tests/database-runtime-identity.test.ts` y
`tests/database-runtime-rls.test.ts`; las 1–3 también por el paso
*Validate Loopback URLs* del workflow `p1a-validation`.

---

## De dónde sale la identidad

La invariante 7 dice *dentro de `withDatabaseIdentityContext`*. Quién decide el
`userId` es la otra mitad, y vive en la aplicación:

```
lib/auth/identity.ts          sujeto verificado por Supabase Auth   — no consulta la base
lib/auth/database-context.ts  principal + wrappers de entry point   — consulta dentro de contexto
db/identity-context.ts        claims, transacción, rollback         — el mecanismo
```

`getVerifiedAuthIdentity()` usa `supabase.auth.getUser()`, que valida el token
contra GoTrue. **No** `getSession()`, que decodifica la cookie en proceso: la
cookie es dato del atacante y su `sub` es exactamente el valor que toda policy
acaba creyendo.

Un entry point no construye `request.jwt.claims` a mano. Usa uno de:

| Wrapper | Ante fallo | Para |
|---|---|---|
| `runWithOrganizationAccess` | `redirect()` | páginas, layouts, server actions |
| `runWithAdminAccess` | `redirect()` | `/admin` |
| `runWithOptionalOrganizationAccess` | `cb(null)` | vistas que renderizan vacío |
| `withOrganizationDatabaseContext` | `AuthContextError` | route handlers, servicios |
| `withAuthenticatedDatabaseContext` | `AuthContextError` | trabajo de usuario sin organización |
| `withSuperAdminDatabaseContext` | `AuthContextError` | operaciones administrativas |

`tests/database-runtime-entrypoints.test.ts` reconstruye el grafo de imports de
`app/**` y falla si un entry point nuevo alcanza `db/client.ts` sin abrir
contexto. Detalle completo en
[`docs/ops/DATABASE_RUNTIME_CUTOVER.md`](../docs/ops/DATABASE_RUNTIME_CUTOVER.md)
§7–§8.
