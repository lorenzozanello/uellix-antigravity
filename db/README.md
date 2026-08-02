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
3. Ningún script ni config de drizzle lee `DATABASE_URL`.
4. Ninguna capacidad local acepta un destino que no sea loopback o un
   contenedor explícitamente permitido, en el puerto esperado.
5. Ningún mensaje de error contiene credenciales.

Las cinco están fijadas por `tests/database-target-safety.test.ts` y
`tests/database-entrypoint-safety.test.ts`, y las 1–3 también por el paso
*Validate Loopback URLs* del workflow `p1a-validation`.
