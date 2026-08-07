# STELLA — ¿Existe un canal de management plane para policies sobre `storage.objects`?

> Train 5C2. **Ninguna escritura hosted se ha realizado.** Ninguna conexión, ningún
> DDL, ningún `SET ROLE`, ningún bucket. Este documento es una determinación.

---

## 0. La pregunta, planteada correctamente

Train 5C1 escribió que las policies debían crearse «por un canal cuya identidad sí
posea la tabla: el Dashboard de Supabase (Storage → Policies) o el SQL Editor».

La medición del operador del 2026-08-07 eliminó la segunda mitad de esa frase, y
la instrucción de Train 5C2 eliminó la primera como suposición:

> «No declares B viable sólo porque la interfaz existe.»

Quedaba entonces **una** pregunta contestable: ¿el Dashboard → Storage → Policies
ejecuta en un contexto de *management plane* distinto de la sesión SQL, o no?

---

## 1. Lo que la evidencia manual ya cerró

| Identidad | `current_user` | `session_user` | `transaction_read_only` | MEMBER | USAGE | SET |
|---|---|---|---|---|---|---|
| psql (session pooler) | `postgres` | `postgres` | **UNCONFIRMED** | false | false | false |
| SQL Editor | `postgres` | `postgres` | `on` | false | false | false |

Y en el SQL Editor, `pg_has_role(current_user, oid, 'SET')` devolvió catorce roles.
**`supabase_storage_admin` no está entre ellos.**

Dos consecuencias, y conviene no confundirlas:

1. **`PSQL_SET_ROLE_PATH = REJECTED`** y **`SQL_EDITOR_SET_ROLE_PATH = REJECTED`**.
   No «no probado»: refutado por catálogo. No hay lectura bajo la cual `SET ROLE`
   exista, y por eso `SET LOCAL ROLE` **no se intentó** — ejecutar una operación
   que el grant ya prohíbe no enseña nada que el catálogo no haya dicho.

2. **La asimetría de [supabase/supabase#41126](https://github.com/supabase/supabase/issues/41126)
   no se reproduce aquí.** Ese reporte —un usuario, sin respuesta de mantenedor—
   fue el origen de la suposición «el SQL Editor es privilegiado» que este train
   tuvo que quitar. Se conserva registrado como **pista**, con grado `hint`, nunca
   como prueba.

Que `service_role` y `supabase_privileged_role` aparezcan en la lista de roles
SETtables **no los convierte en ruta autorizada**, y la arquitectura de Uellix no
depende de escalar hacia ellos. Están explícitamente prohibidos en
`db/hosted/managed-policy-channel.ts` y una prueba negativa lo verifica.

---

## 2. Lo que dice la fuente primaria sobre el Dashboard

Supabase Studio es open source, y el editor de policies está a dos archivos de
profundidad:

**`apps/studio/data/database-policies/database-policy-create-mutation.ts`**

```ts
const { sql } = pgMeta.policies.create(payload)
await executeSql({ projectRef, connectionString, sql, queryKey: ['policy', 'create'] })
```

**`apps/studio/components/interfaces/Storage/StoragePolicies/StoragePolicies.utils.ts`**

```ts
`CREATE POLICY "${name}" ON "${schema}"."${table}"`
`AS PERMISSIVE FOR ${command}`
`TO ${roles.join(', ')}`
```

La UI de Storage Policies **compila un formulario a SQL crudo** y lo envía por
`executeSql` — el mismo helper que usa el SQL Editor, contra la misma cadena de
conexión del proyecto.

**Conclusión: no es un management plane. Es el canal SQL vestido de formulario.**
Y por tanto ejecuta en la identidad que ya medimos: un `postgres` que no posee
`storage.objects` y no puede convertirse en quien lo posee.

### 2.1 Lo que la documentación oficial *no* dice

| Fuente | Qué dice | Qué **no** resuelve |
|---|---|---|
| [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control) | presenta `create policy … on storage.objects …` como la vía normal | no dice **dónde** ejecutarlo, y no reconoce que la propiedad de la tabla pueda rechazarlo |
| [Ownership](https://supabase.com/docs/guides/storage/security/ownership) | habla del `owner_id` de un objeto (claim `sub` del JWT) | **no** habla de la propiedad de la *tabla*, que es nuestro problema |
| [Roles, superuser access and unsupported operations](https://supabase.com/docs/guides/database/postgres/roles-superuser) | enumera operaciones no soportadas (`COPY … FROM PROGRAM`, `ALTER USER … WITH SUPERUSER`) | no menciona `supabase_storage_admin` ni policies sobre tablas gestionadas |
| [Management API Reference](https://supabase.com/docs/reference/api/introduction) | — | **no existe endpoint** que cree o altere una policy RLS |

### 2.2 La única respuesta oficial, y por qué no nos cubre

En [supabase/supabase discussion #36611](https://github.com/orgs/supabase/discussions/36611),
un mantenedor (`sweatybridge`, 2025-09-18) responde:

> «Due to recent permission changes on postgres platform, altering tables in
> storage schema is no longer possible. Since row level security is now enabled by
> default on storage.objects table, you can safely delete or comment out the
> offending statement from your migration file.»

Esa respuesta es sobre **`ALTER TABLE`**. La unidad 41 **no emite ningún
`ALTER TABLE storage.objects`** —verificado, y el generador se niega a producir
artefactos si alguna vez lo adquiere—. Leerla como si cubriera `CREATE POLICY`
sería el error del marcador por subcadena otra vez: una respuesta parecida
ocupando el lugar de la respuesta exigida.

---

## 3. Veredicto

```
SQL CHANNEL                     (psql · SQL Editor · Dashboard Storage Policies)
   └─ REJECTED / no privilegiado
SUPABASE MANAGEMENT-PLANE       (un canal realmente distinto)
   └─ UNRESOLVED_REQUIRES_HOSTED_EVIDENCE
```

**Por qué `UNRESOLVED` y no `REJECTED`.** La refutación anterior es una inferencia
sobre un repositorio open source. El build desplegado de la plataforma es cerrado,
y la posibilidad de que `/pg-meta/{ref}/query` enrute la mutación de policies de
otro modo **no puede refutarse desde aquí**. Llamarlo `REJECTED` reclamaría una
medición que no tomamos; llamarlo `CANDIDATE` ignoraría dos fuentes primarias.
`UNRESOLVED` es la palabra exacta — y bloquea exactamente igual de fuerte.

**`MANAGED_BOUNDARY_DESIGNED ≠ MANAGED_BOUNDARY_VERIFIED`.** Este documento y el
código producen el primero. El segundo exige evidencia hosted que todavía no
existe.

---

## 4. La frontera, redefinida: **sonda por ejecución**

Como sólo un intento puede resolverlo, y un intento es una **escritura**, la
frontera humana deja de ser «ejecuta estas tres policies» y pasa a ser:

```
HUMAN_STORAGE_POLICY_BOUNDARY
  precondiciones (todas medidas, ver §5)
        ↓
  el operador crea UNA policy — select_evidence — por Dashboard → Storage → Policies
        ↓
  ┌── éxito ──→ el canal EXISTE. Continuar con insert_evidence y delete_evidence.
  └── fallo  ──→ el canal NO existe. NO reintentar por otro rol. Escalar a
                 soporte Supabase con la evidencia de §1 y §2.
```

Una policy y no tres, porque el objetivo del primer paso es *medir el canal*, no
instalar la superficie. Si el canal no existe, tres intentos fallidos no informan
más que uno y dejan tres estados parciales que reconciliar.

El estado intermedio está modelado: `UNIT_41_POLICIES_PENDING` con 1 de 3 mientras
la frontera está abierta, `UNIT_41_FAILED` con 1 de 3 una vez cerrada.

### 4.1 El operador no redacta SQL

`deriveManagedPolicySpec()` deriva, del **mismo origen canónico**, los campos
exactos que el formulario pide: `policyname`, `schema`, `table`, `PERMISSIVE`,
`cmd`, `roles`, `USING`, `WITH CHECK`. Y se niega a emitirlos si difieren de
`EXPECTED_STORAGE_POLICY_SURFACE` — la constante que B0-16 verificará después.

Ese pin es lo que hace la frontera **falsable**: si la especificación entregada y
la expectativa comprobada pudieran divergir, B0-16 estaría verificando un contrato
distinto del que se ejecutó.

Prohibido copiar predicados desde documentación independiente.

---

## 5. `HUMAN_STORAGE_POLICY_BOUNDARY` — precondiciones

Todas se evalúan en `evaluateBoundaryPreconditions()`; ninguna es un booleano que
alguien escribe:

| Precondición | Refuta si |
|---|---|
| `stagingProjectRef` | no tiene la forma de 20 minúsculas, **o está en la denylist de producción** |
| `productionDenylistPass` | falso |
| `artifactSourceShaPass` | el origen canónico no regenera a su hash fijado |
| `derivedShaPass` | el artefacto PARTE B no regenera byte a byte |
| `securitySurfaceDigestPass` | el digest de superficie derivó |
| `expectedPolicyCount` | ≠ 3 |
| `rlsAlreadyEnabledOnStorageObjects` | `false`, **o `null`** — no medido es rechazado |
| `targetTable` | ≠ `storage.objects` |
| `partAState` | ≠ `UNIT_41_HELPERS_APPLIED` |

> La comprobación de la denylist se hace **dentro** de la función, contra
> `KNOWN_PRODUCTION_IDENTIFIERS`, no leyendo el booleano que le pasan. La primera
> versión sí confiaba en el booleano, y su propia prueba la rompió en una línea:
> un project ref de producción con `productionDenylistPass: true` abría la
> frontera, porque un ref de producción también son veinte minúsculas. Era el
> «self-asserted boolean» que el gate de apply rechaza en todos los demás sitios,
> reentrando por la puerta de atrás.

---

## 6. Postcondición: la superficie, no los nombres

`B0-16` compara, con **igualdad normalizada**, y para las tres policies:

`schemaname` · `tablename` · `policyname` · `permissive` · `roles` · `cmd` ·
`qual` · `with_check`

- No usa `EXISTS(policyname)`.
- No usa coincidencia por subcadena.
- **No ignora policies extra**: cualquier policy sobre `storage.objects` que este
  repositorio no genere es un hallazgo, porque las policies PERMISSIVE se
  combinan con OR y una sola `USING (true)` abre todos los objetos de todos los
  buckets mientras las tres esperadas verifican perfectamente.
- Distingue A (Uellix esperadas) de C (extra inesperada). Para B (policies
  preexistentes legítimas de Supabase): hoy la plataforma no envía ninguna sobre
  esta tabla, así que «no es nuestra» es la prueba completa. Si algún día añade
  una, se añade a una allowlist **por nombre y con motivo escrito** — no
  ensanchando la regla.

---

## 7. Estado

| Elemento | Valor |
|---|---|
| `SET_ROLE_PATH_VERIFIED` | `false`, literal sin setter; `storageExecutionReadiness()` no acepta parámetro que lo reintroduzca |
| `MANAGEMENT_PLANE_PATH` | `UNRESOLVED_REQUIRES_HOSTED_EVIDENCE` |
| `MANAGED_BOUNDARY_VERIFIED` | `false` |
| Storage readiness | **BLOCKED** |
| `applyAuthorized` | `false` |
| `baselineApplied` | `false` |
| `stagingApplied` | `false` |
| `evidenceBucketExists` | `false` (frontera independiente, sin tocar) |

**Acción de operador requerida, en este orden:**

1. **Sonda psql read-only** (§19 de la instrucción), por la misma identidad Session
   Pooler, para cerrar `transaction_read_only = UNCONFIRMED`:
   ```
   BEGIN READ ONLY;
   SELECT current_setting('transaction_read_only');
   ROLLBACK;
   ```
2. **Sonda por ejecución del canal**: una sola policy `select_evidence` por
   Dashboard → Storage → Policies, con los campos que emite
   `deriveManagedPolicySpec()`, y registrar si el canal la acepta o la rechaza.
