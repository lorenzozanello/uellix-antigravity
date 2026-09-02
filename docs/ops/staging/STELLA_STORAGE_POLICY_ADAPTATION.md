# STELLA — Adaptación de `20260716000001_storage_policies.sql` para Supabase gestionado

> Train 5C1. **Ninguna escritura hosted se ha realizado.** Este documento es una
> determinación y un diseño; no autoriza nada.
>
> Origen: la sonda de clase C `ownsStorageObjects` devolvió **FALSE** contra
> Uellix Staging el 2026-08-07. La sonda hizo exactamente aquello para lo que
> existe — encontrar la incompatibilidad **antes** de aplicar las primeras 40
> unidades, no después.

---

## 1. Clasificación de las tres sondas

| Sonda | Observado | Clasificación | Unidad afectada |
|---|---|---|---|
| `canCreateTriggerOnAuthUsers` | `TRUE` | **PASS** | `20260716000000_auth_trigger.sql` |
| `ownsStorageObjects` | `FALSE` | **BLOCKED** | `20260716000001_storage_policies.sql` |
| `evidenceBucketExists` | `FALSE` | **MISSING** | la misma — sus tres policies filtran por ese bucket |

**`ownsStorageObjects = FALSE` no es `REQUIRES_REHEARSAL`, y la distinción no es
terminológica.** `REQUIRES_REHEARSAL` significa «no lo sabemos hasta probarlo».
Aquí lo sabemos: el catálogo respondió. Degradarlo a «pendiente de ensayo»
convertiría una medición en una incógnita y devolvería el descubrimiento al
lugar del que la sonda lo sacó — la unidad 41 de 50, con 40 ya comprometidas.

Evidencia bruta: [`artifacts/class-c-probes/2026-08-07-uellix-staging.json`](../../../artifacts/class-c-probes/2026-08-07-uellix-staging.json).

---

## 2. Determinación: cómo se gestionan correctamente las policies sobre `storage.objects`

### 2.1 Lo que la plataforma establece

| Hecho | Fuente |
|---|---|
| `storage.objects` pertenece a `supabase_storage_admin`; el esquema `storage`, a `supabase_admin` | `db/baseline/stella_g2_schema.sql:5061` y `:122` |
| La propiedad **no es transferible** a `postgres` | [supabase/discussions#38474](https://github.com/orgs/supabase/discussions/38474) |
| RLS **ya está activo** sobre `storage.objects`; intentar activarlo es rechazado a propósito | Colaborador de Supabase en [#38474](https://github.com/orgs/supabase/discussions/38474): «RLS should already be enabled for storage.objects. You should just add your policies, not enable it which Supabase is not allowing because they don't want you to turn it off» |
| `CREATE POLICY` sobre `storage.objects` **falla por conexión directa** como `postgres`, y la misma sentencia **funciona en el SQL Editor** | [supabase/supabase#41126](https://github.com/supabase/supabase/issues/41126) |
| El mismo fallo bloquea migraciones del CLI | [supabase/cli#96](https://github.com/supabase/cli/issues/96), [supabase/supabase#36418](https://github.com/supabase/supabase/issues/36418) |
| La documentación oficial presenta `create policy … on storage.objects` como la vía normal, **sin mencionar requisito de propiedad** | [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control) |

Esa última fila es la que explica por qué esto no se detectó antes: la
documentación describe la sintaxis y calla el contexto operativo. El requisito
de propiedad sólo aparece cuando la sentencia se envía por el canal equivocado.

### 2.2 Una cosa que ya hacíamos bien

La causa más frecuente en los reportes es `ALTER TABLE storage.objects ENABLE
ROW LEVEL SECURITY`. **Nuestra unidad no lo hace** — verificado: sólo emite
cuatro `DROP POLICY IF EXISTS` y tres `CREATE POLICY`. El error que Supabase
rechaza por diseño no es el nuestro. El nuestro es el más difícil: el requisito
de propiedad de `CREATE POLICY` en sí.

### 2.3 La conclusión

**Las policies sobre `storage.objects` no pueden formar parte del conjunto que
se aplica por `psql`.** Deben crearse por un canal cuya identidad sí posea la
tabla: el Dashboard de Supabase (Storage → Policies) o el SQL Editor.

Esto no relaja ninguna garantía. Las policies siguen siendo obligatorias, siguen
siendo las mismas tres, y **B0-08 sigue exigiéndolas** — su sonda ya se amplió a
`schemaname IN ('public','storage')` en Train 5C0. Lo único que cambia es el
canal; la verificación se queda donde estaba.

---

## 3. Un defecto en la sonda que diseñé, y que este resultado destapó

`ownsStorageObjects` está mal especificada de dos formas que un `FALSE` no
distingue:

**No registra quién preguntó.** `current_user` es quien ejecute la consulta. El
operador la ejecutó en el SQL Editor; el baseline lo aplicará `psql` por conexión
directa, con otro rol. [#41126](https://github.com/supabase/supabase/issues/41126)
documenta exactamente esa asimetría. Una sonda ejecutada en una identidad no dice
nada fiable sobre la otra — el mismo fallo «una consulta distinta responde a una
pregunta distinta» que el gate de autorización ya refuta en las atestaciones.

**Mide `USAGE`, y `USAGE` no decide si `SET ROLE` está disponible.** La
comprobación de propiedad de PostgreSQL respeta `INHERIT`, así que `USAGE=false`
predice correctamente que un `CREATE POLICY` directo falla. No predice nada sobre
`SET ROLE`.

> ### ⚠️ CORREGIDO EN TRAIN 5C2
>
> Una redacción anterior de este párrafo decía que `SET ROLE` «requiere
> `MEMBER`». **Es falso.** PostgreSQL 16 separó `MEMBER`, `USAGE` y `SET`, y el
> privilegio que permite `SET ROLE` es **`SET`**. `MEMBER` sólo expresa
> pertenencia: `GRANT r TO u WITH SET FALSE, INHERIT FALSE` da `MEMBER=true` sin
> ninguna capacidad. El desarrollo correcto está en §6.1, y la sonda se corrigió
> en `CLASS_C_PROBES`.
>
> Se deja la corrección visible en lugar de reescribir el párrafo en silencio, por
> la misma razón que en el audit de julio: borrar el error borra la prueba de que
> existió.

> **El veredicto BLOCKED no cambia, y es conservador.** Según #41126 la identidad
> de conexión directa es la **más** restringida de las dos, así que una medición
> en el momento del apply sólo puede salir igual o peor. Lo que sigue sin saberse
> es **cuál** de las dos adaptaciones corresponde.

El bloque canónico de sondas está en
[`STELLA_APPLY_IDENTITY_PROBE.md`](STELLA_APPLY_IDENTITY_PROBE.md) y mide los
tres privilegios por separado, más la operación `SET LOCAL ROLE`.

---

## 4. La adaptación

### 4.1 Dónde parte la unidad

El archivo se divide limpiamente, y la frontera no es arbitraria:

| Líneas | Contenido | Esquema | Aplicable por `psql` |
|---|---|---|---|
| 1 – 86 | `public.can_read_evidence_object`, `public.can_write_evidence_object`, y sus `REVOKE`/`GRANT` | `public` | **SÍ** — objetos nuestros |
| 88 – 124 | 4 × `DROP POLICY IF EXISTS` + 3 × `CREATE POLICY` sobre `storage.objects` | `storage` | **NO** — bloqueado |

La mitad superior es exactamente de la que depende `0039`
(`GRANT EXECUTE` sobre esas dos funciones), y es la razón por la que la unidad
está donde está en el orden. **Esa dependencia se conserva intacta.**

### 4.2 Forma de la adaptación

Sigue el patrón que Train 5B ya estableció y que este repositorio usa para los
diez paquetes hosted: **el archivo canónico permanece byte-idéntico**, y la
variante hosted se **deriva** de él con un conteo fijado.

```
supabase/migrations/20260716000001_storage_policies.sql   ← canónico, sin tocar
        │
        ├─► variante hosted derivada: omite el bloque de storage.objects
        │   (regla de reescritura nueva, con conteo esperado = 7 sentencias)
        │
        └─► paso de operador: las mismas 3 CREATE POLICY, por Dashboard/SQL Editor
```

Por qué derivada y no un archivo partido: `supabase/migrations/**` lo aplica
también el CLI local y **el proyecto de producción ya registró esta migración**
en su historial. Partir o renombrar el archivo produciría un desajuste de
historial en cualquier `supabase db push` futuro contra producción. Derivar no
toca nada de eso.

### 4.3 Consecuencia sobre las fases

Aparece una **segunda frontera humana** dentro de `PHASE_BASELINE`, de la misma
naturaleza que la del centinela:

```
PHASE_BASELINE            unidades 1…50, con la 41 en su variante sin policies
   ↓
── FRONTERA HUMANA ──     el operador crea el bucket uellix-evidence
                          y las 3 policies, por Dashboard/SQL Editor
   ↓
CHECKPOINT B0             B0-08 exige las policies · B0-15 exige el bucket
```

El orden interno de las 50 no cambia, y `0039` sigue funcionando: sólo necesita
las funciones, no las policies.

### 4.4 Lo que la adaptación NO hace

Enumerado porque cada línea fue una tentación que la instrucción del operador
descartó, y porque un lector futuro merece saber que se consideraron:

| No se hace | Por qué |
|---|---|
| `ALTER TABLE storage.objects OWNER TO …` | Supabase no lo permite y no debería |
| `ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY` | rechazado por la plataforma, e **innecesario**: ya está activo |
| conceder `BYPASSRLS` | debilitaría el aislamiento que las policies existen para imponer |
| usar `service_role` | prohibido; y §4.4 prohíbe además aprovisionar su clave |
| `SET ROLE supabase_storage_admin` | **todavía no**: la sonda 5 aún no se ha ejecutado. Hacerlo ahora sería asumir un permiso no observado |
| crear el bucket `uellix-evidence` | diferido por instrucción del operador |

---

## 5. Estado

`PHASE_BASELINE` **no está autorizada.** El gate
`hosted-baseline-apply-authorized` refuta por `class-c-probes-affirmative`, y
ahora con una medición real detrás en lugar de una ausencia.

**Siguiente paso, y es sólo uno:** ejecutar las sondas 4 y 5 de §3 **en la
identidad que aplicará el baseline** — no en el SQL Editor. Su respuesta decide
entre las dos adaptaciones y no debe inferirse.

---

## 6. Train 5C2 — corrección de semántica, y lo que queda por medir

### 6.1 `MEMBER` no responde la pregunta

La sonda que Train 5C1 añadió preguntaba `pg_has_role(…, 'MEMBER')`. **Estaba
mal.** PostgreSQL 16 dividió la pertenencia a un rol en tres privilegios
independientes y 17 los mantiene separados:

| Privilegio | Significa | No significa |
|---|---|---|
| `MEMBER` | perteneces al rol | nada sobre qué puedes hacer con él. `GRANT r TO u WITH SET FALSE, INHERIT FALSE` da esto y sólo esto |
| `USAGE` | tienes sus privilegios **sin** `SET ROLE` | es lo que consulta la comprobación de propiedad — de ahí que `ownsStorageObjects=FALSE` prediga bien el fallo de un `CREATE POLICY` directo |
| `SET` | **puedes ejecutar `SET ROLE`** | — |

Sólo `SET` decide si la Rama A existe. Usar `MEMBER` en su lugar es el mismo
error del marcador por subcadena que la revisión adversarial ya tumbó: un
casi-sinónimo ocupando el sitio de la propiedad realmente exigida. Corregido en
`CLASS_C_PROBES`, que ahora registra los tres por separado — la **combinación**
es diagnóstica: `MEMBER=true` con `SET=false` es un `WITH SET FALSE`
deliberado, y significa algo distinto de no ser miembro.

### 6.2 Y el catálogo tampoco es la operación

`SET=true` dice que el *grant* lo permite. Sólo ejecutar `SET LOCAL ROLE` dentro
de una transacción READ ONLY demuestra que nada más lo rechaza. **La Rama A
exige las dos**, y el gate `hosted-storage-set-role-ready` refuta si falta
cualquiera — o si la demostración muestra que `session_user` también cambió, que
sería una sesión escalada y no una transacción que asume un rol.

### 6.3 Corrección sobre el bucket

`storage.buckets` aparece **0 veces** en la unidad 41: las policies filtran por
la *columna* `bucket_id`, no consultan la tabla. El bucket es por tanto
prerrequisito **de runtime**, no de apply-time. Los dos prerrequisitos son
independientes y pueden satisfacerse en cualquier orden.

### 6.4 STORAGE_PREREQUISITE

| Campo | Valor |
|---|---|
| Bucket | `uellix-evidence` |
| Entorno | staging (`bvyzblhqymxruxdguaee`) |
| Contenido inicial | **vacío**. No se copia nada de producción |
| Público | **no** (`public = false`, como en `supabase/config.toml`) |
| Mecanismo más auditable | **Dashboard → Storage → New bucket**, que deja registro en el proyecto y no requiere credencial en ninguna terminal |
| Estado | **`evidenceBucketExists = false`**, sin corregir en esta unidad por instrucción |
| Cierre | una segunda sonda real tras crearlo |

### 6.5 Orden operativo — dependencias reales, no el ejemplo

`0039` depende **sólo de la PARTE A** (las dos funciones `public.can_*`), no de
las policies. Verificado: sus cinco `GRANT EXECUTE` no nombran `storage.objects`.
Por eso la frontera de la PARTE B **no** tiene que caer antes de 0039, y el
orden de las 50 unidades no cambia.

```
STORAGE_PREREQUISITE      bucket uellix-evidence, vacío, por Dashboard
   ↓  (sonda: bucket = true)
PHASE_BASELINE (psql)     unidades 1…50 en el orden del manifiesto
                          la 41 aporta la PARTE A; 0039 sólo necesita eso
   ↓
── FRONTERA PARTE B ──    Rama A: en banda, bajo SET LOCAL ROLE
                          Rama B: canal gestionado, artefacto verificado
   ↓
CHECKPOINT B0             B0-08 exige las 3 policies · B0-15 exige el bucket
```

Si la Rama A se demuestra, la frontera desaparece y la PARTE B corre dentro de
la unidad 41. Ésa es la única diferencia estructural entre las dos ramas.

### 6.6 RR-25 sigue abierto y sigue bloqueando

El gate `hosted-baseline-journal-ready` exige una procedencia verificable para
`baselineUnitsInstalled`. Con `journalProvenance = null` refuta, así que
**aunque Storage quede adaptado, `hosted-baseline-apply-authorized` permanece
`false`** — que es exactamente lo que la Fase 11 ordena.

Las tres procedencias admitidas, y la única que el gate valida en detalle:

| Tipo | Requisito |
|---|---|
| `hosted-journal` | registra `package_id`, `phase`, `sha256`, `applied_at`, `status`, y **se escribe sólo tras el commit** de la unidad. Un journal escrito antes registraría como aplicada una unidad que hizo rollback — una mentira en la única dirección que importa |
| `catalog-derived` | derivación determinista desde el catálogo + hashes |
| `equivalent-fail-closed` | mecanismo equivalente, declarado |

---

## 7. Train 5C2 — corrección final del canal

> ### ⚠️ §2.3 Y §4.3 ESTÁN SUPERADOS
>
> Este documento dijo dos veces que las policies «deben crearse por un canal cuya
> identidad sí posea la tabla: el Dashboard de Supabase (Storage → Policies) o el
> SQL Editor».
>
> **Ambas mitades son falsas**, y se dejan visibles en vez de reescribirlas en
> silencio, por la misma razón que la corrección de §3: borrar el error borra la
> prueba de que existió.
>
> - **El SQL Editor no es privilegiado.** Medido el 2026-08-07:
>   `current_user = postgres`, MEMBER/USAGE/SET = false contra
>   `supabase_storage_admin`, y ese rol **no aparece** entre los SETtables.
> - **El Dashboard tampoco es un management plane.** Supabase Studio compila el
>   formulario de Storage Policies a `CREATE POLICY` en texto y lo envía por el
>   mismo `executeSql` que usa el SQL Editor. Fuente primaria, dos archivos.
>
> La determinación completa, con las fuentes y sus grados de evidencia, está en
> [STELLA_STORAGE_MANAGEMENT_CHANNEL.md](STELLA_STORAGE_MANAGEMENT_CHANNEL.md).

### 7.1 Lo que sí quedó cerrado

| Elemento | Estado |
|---|---|
| `PSQL_SET_ROLE_PATH` | **REJECTED** — refutado por catálogo, no «no probado» |
| `SQL_EDITOR_SET_ROLE_PATH` | **REJECTED** — misma identidad, misma ausencia de pertenencia |
| `SET_ROLE_PATH_VERIFIED` | `false` literal, sin setter, y `storageExecutionReadiness()` no admite parámetro que lo reintroduzca |
| División de la unidad 41 | un origen canónico → PARTE A (psql) + PARTE B (canal gestionado), regeneradas y comparadas byte a byte |
| Máquina de estados | seis estados; `UNIT_41_POLICIES_APPLIED_UNVERIFIED` es el que faltaba |
| DAG | `0039` depende de PARTE A y **no** de PARTE B; el bucket no es dependencia de apply-time |
| RR-25 | **implementado** — 51 wrappers, INSERT dentro de la transacción de la unidad |

### 7.2 Lo que sigue abierto

`MANAGEMENT_PLANE_PATH = UNRESOLVED_REQUIRES_HOSTED_EVIDENCE`. La refutación es
una inferencia sobre código open source; el build desplegado es cerrado. Sólo un
intento lo resuelve, y un intento es una escritura — por eso la frontera humana
se redefine como **sonda por ejecución de una sola policy**.

`applyAuthorized = false`. `baselineApplied = false`. `stagingApplied = false`.
`evidenceBucketExists = false`.
