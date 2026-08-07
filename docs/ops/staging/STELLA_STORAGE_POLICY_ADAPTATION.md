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

**Mide `USAGE`, no `MEMBER`.** La comprobación de propiedad de PostgreSQL respeta
`INHERIT`, así que `USAGE = false` predice correctamente que un `CREATE POLICY`
directo falla. No predice si `SET ROLE supabase_storage_admin` está disponible,
que requiere `MEMBER`. Una pertenencia `NOINHERIT` da `USAGE = false` y
`MEMBER = true`, y esos dos mundos piden adaptaciones distintas.

> **El veredicto BLOCKED no cambia, y es conservador.** Según #41126 la identidad
> de conexión directa es la **más** restringida de las dos, así que una medición
> en el momento del apply sólo puede salir igual o peor. Lo que sigue sin saberse
> es **cuál** de las dos adaptaciones corresponde.

Dos sondas nuevas, ambas read-only, resuelven la ambigüedad — añadidas a
`CLASS_C_PROBES`:

```sql
-- 4. ¿Quién soy? Ejecutar EN LA IDENTIDAD QUE APLICARÁ EL BASELINE.
SELECT current_user, session_user, version();

-- 5. ¿Está disponible SET ROLE? (MEMBER, no USAGE.)
SELECT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER');
```

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
