# STELLA — ¿Existe un canal de management plane para policies sobre `storage.objects`?

> Train 5C2. Este documento fue una **determinación desde fuentes**, y la sonda de
> capacidad del 2026-08-07 la corrigió en su conclusión final — ver §3.
>
> Escrituras hosted realizadas: **una sola**, la policy temporal de la sonda de
> capacidad, creada y eliminada, con `pg_policies` de vuelta a 0 filas. Ningún
> `SET ROLE`, ningún `GRANT`, ningún bucket, ninguna policy canónica, ningún
> baseline, ningún acceso a producción.

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
| psql (session pooler) | `postgres` | `postgres` | `on` ¹ | false | false | false |
| SQL Editor | `postgres` | `postgres` | `on` | false | false | false |

¹ Registrado inicialmente como **UNCONFIRMED** —el operador no retuvo el valor— y
suministrado después. La refutación por `UNCONFIRMED` se conserva descrita en el
artefacto: borrarla borraría la prueba de que el gate rechazó un valor no
retenido en lugar de adivinarlo.

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
SQL CHANNEL                     (psql · SQL Editor)
   └─ REJECTED / no privilegiado            ← medido
DASHBOARD STORAGE POLICIES
   ├─ desde el repositorio solo:  UNRESOLVED_REQUIRES_HOSTED_EVIDENCE
   └─ desde evidencia hosted:     VERIFIED  ← la sonda de capacidad, 2026-08-07
```

> ### ⚠️ ACTUALIZADO POR LA SONDA DE CAPACIDAD
>
> La sonda se ejecutó y **tuvo éxito**: el Dashboard creó una policy sobre
> `storage.objects` y la eliminó de nuevo. La inferencia de §2 sobre el código
> open source **no describía completamente el build desplegado**. Se deja escrita
> tal cual, con su conclusión corregida aquí, porque borrarla borraría la prueba
> de que la determinación se hizo con lo que había y se revisó cuando llegó
> evidencia mejor.
>
> Esto verifica **el canal**. No verifica las tres policies canónicas: siguen sin
> instalarse, y `MANAGED_BOUNDARY_VERIFIED` sigue en `false`.

**Por qué la fila «desde el repositorio solo» sigue diciendo `UNRESOLVED`.** Era —y
sigue siendo— la palabra exacta para lo que el repositorio puede concluir por sí
mismo: una inferencia sobre código open source, sobre un build desplegado que es
cerrado. Esa fila no se edita cuando llega evidencia hosted; la evidencia hosted
vive en la otra, derivada de `artifacts/hosted-capability-probe.json` por
`deriveManagementPlaneVerdict`. Mantener las dos visibles es lo que impide que una
conclusión editada a mano se lea como una medición.

**`MANAGED_BOUNDARY_DESIGNED ≠ MANAGED_BOUNDARY_VERIFIED`, y la sonda no cambia
eso.** La sonda verificó el **canal**. `MANAGED_BOUNDARY_VERIFIED` mide otra cosa:
las tres policies canónicas presentes en `pg_policies` con su superficie exacta.
Siguen sin instalarse, y ese flag sigue en `false`.

---

## 4. La frontera, redefinida: **sonda por ejecución**

Como sólo un intento puede resolverlo, y un intento es una **escritura**, la
frontera humana deja de ser «ejecuta estas tres policies» y pasa a ser:

```
SONDA DE CAPACIDAD                              [EJECUTADA 2026-08-07: ÉXITO]
  precondiciones (todas medidas, ver §5)
        ↓
  UNA policy TEMPORAL — uellix_tmp_capability_probe_20260807 —
  que no concede nada, por Dashboard → Storage → Policies
        ↓
  ┌── éxito ──→ el CANAL existe. → limpiar → verificar limpieza → PARAR.
  │             NO continuar con las canónicas: necesitan la PARTE A.
  └── fallo  ──→ el canal NO existe. NO reintentar por otro rol. Escalar a
                 soporte Supabase con la evidencia de §1 y §2.

        ⋯ (después: aplicar el baseline, que instala la PARTE A) ⋯

HUMAN_STORAGE_POLICY_BOUNDARY                   [NO ABIERTA — precondición falla]
  requiere partAState = UNIT_41_HELPERS_APPLIED
        ↓
  select_evidence · insert_evidence · delete_evidence
```

> ### ⚠️ CORREGIDO — una versión anterior de este diagrama decía, en la rama de
> éxito, «continuar con `insert_evidence` y `delete_evidence`».
>
> Eso venía del diseño previo, en el que la primera policy creada **era** la
> canónica `select_evidence`. Con la sonda temporal esa frase pasó a instruir una
> escritura que el propio programa prohíbe en este momento: las tres canónicas
> llaman `public.can_*_evidence_object`, que la PARTE A todavía no ha creado, así
> que cada evaluación levantaría `42883`. El paso 13 del guion del operador y
> `evaluateBoundaryPreconditions` ya lo refutaban; el diagrama no.
>
> Se deja la corrección visible en lugar de reescribir el párrafo en silencio.

Una policy y no tres, porque el objetivo de la sonda es *medir el canal*, no
instalar la superficie. Si el canal no existiera, tres intentos fallidos no
informarían más que uno y dejarían tres estados parciales que reconciliar.

El estado parcial está modelado para cuando la frontera **sí** se abra:
`UNIT_41_POLICIES_PENDING` con 1 de 3 mientras está abierta, `UNIT_41_FAILED` con
1 de 3 una vez cerrada. Hoy la unidad 41 está en `UNIT_41_NOT_STARTED`: la sonda
no creó ninguna de las tres.

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

**Acciones de operador — estado al 2026-08-07:**

| # | Acción | Estado |
|---|---|---|
| 1 | Sonda psql read-only para cerrar `transaction_read_only` | ✅ **HECHA** — valor `on`, ingerido en el artefacto |
| 2 | Sonda por ejecución del canal (policy temporal, crear + verificar + limpiar + verificar limpieza) | ✅ **HECHA** — `CAPABILITY_PROBE_COMPLETE` |
| 3 | Registrar en `2026-08-07-apply-identity.json` las `queries` literales ejecutadas y el `connectionHost` (sólo hostname) | ⛔ **PENDIENTE** — el gate refuta una atestación sin query, y esa refutación es verdadera |
| 4 | CHECKPOINT A0 e inventario de los nueve flags `STELLA_*` | ⛔ **PENDIENTE** |
| 5 | Bucket `uellix-evidence` (`public=false`, vacío) | ⛔ **PENDIENTE** — bloquea `STAGING_RUNTIME_GATE`, no el baseline |

Nada de lo anterior autoriza aplicar el baseline por sí solo: el veredicto vivo
está en `artifacts/hosted-apply-status.json` y lo imprime `pnpm apply:status`.
