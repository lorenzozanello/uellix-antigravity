# Certificación de motor PG 17.6 — cadena Stella gobernada

**Commit 5.1.** Resultado: **PASS**. La cadena gobernada `T1..T9` se aplica
completa sobre PostgreSQL 17.6 con la topología de roles de Supabase gestionado,
bajo el contrato de instalador resuelto, sin residuo de autoridad y con las diez
inyecciones de fallo revirtiendo por completo.

Commit 5 fue un **checkpoint diagnóstico**: `FAIL`, cadena 0/9, cuatro
hallazgos. Este documento lo reemplaza y conserva su historia.

Reproducir:

```bash
pnpm certify:pg176
```

Artefacto: `artifacts/pg176-certification/latest.json`.

---

## 1. El entorno, y qué NO prueba

| | |
|---|---|
| Imagen | `public.ecr.aws/supabase/postgres:17.6.1.143` |
| `server_version` / `_num` | `17.6` / `170006` |
| `createrole_self_grant` | `''` (vacío) |
| Sesión que provisiona | `postgres` — `rolsuper = false`, `CREATEROLE` |
| Sesión que aplica la cadena | **`uellix_migrator`**, por TCP a `127.0.0.1` |
| Red / montajes / contenedores al final | `none` / ninguno / **0** |
| Escrituras remotas | **0** |

**Superficie fiel** (no simulada): esquema `auth` propiedad de `supabase_admin`;
`auth.users` de `supabase_auth_admin`; `postgres` con `USAGE` sobre `auth` **sin**
poder crear en él — la asimetría exacta de RR-09.

**Simulado y declarado**: `storage.objects` + `storage.foldername()` (los crea el
*servicio* Storage, no la imagen); la fila del centinela de staging y la
contraseña del migrador, ambas pasos de provisión humana que el arnés ejecuta
explícitamente. La ausencia del centinela se **mide primero**: sin ella `T1` es
rechazado.

Hechos de clase C medidos en este motor: `postgres` no puede crear en `auth` ni
en `storage`, **sí** tiene `TRIGGER` sobre `auth.users`, y no es superusuario.

## 2. E-01 — contrato de propiedad prechain

```
E01_ROOT_CAUSE = HOSTED_PRECHAIN_CONTRACT_DEFECT
```

`stella_0004` transfiere 38 tablas y 8 funciones a `uellix_owner`;
`stella_hosted_0001` transfiere **una** —el ledger— y dice por qué: mover las
helpers de RLS a un rol que no puede recibir `USAGE` sobre `auth` rompería todas
las políticas (RR-09). Lo que faltaba es que otros seis objetos necesitan un
**privilegio**, no propiedad, y nada lo concedía.

El conjunto se **deriva** del mismo plan que usa el generador
(`db/hosted/authority/certification/prechain-requirements.ts`), no se transcribe:

```
PRECHAIN_OWNER_REQUIREMENTS = 8 objetos / 12 sentencias
```

| objeto | necesita | primer dependiente |
|---|---|---|
| `public.current_user_org_ids()` | `EXECUTE` **WITH GRANT OPTION** | T1[10] |
| `public.current_user_is_super_admin()` | `EXECUTE` **WITH GRANT OPTION** | T1[11] |
| `public.evidence_items` | `REFERENCES` + `SELECT` WGO | T1[12] |
| `public.organizations` | `REFERENCES` + `SELECT` WGO | T1[14] |
| `public.projects` | `REFERENCES` + `SELECT` WGO | T1[14] |
| `public.uellix_forbid_mutation()` | `EXECUTE` | T1[37] |
| `public.stella_interactions` | `OWNERSHIP` *(ya en §2c)* | T4[15] |
| `public.users` | `REFERENCES` | T5[20] |

Tres privilegios distintos sobre tres clases de objeto, **ninguno nombrado en la
sentencia que falla** — por eso se derivan en vez de enumerarse.

**Remediación** — `stella_hosted_0001` §5d: asserta que los siete son del
instalador (y **refusa** nombrando objeto y dueño si no), luego concede en
sentencias **literales**. Sin `EXECUTE format(...)`: `tests/prepared-stella-sql.test.ts`
lo prohíbe en un paquete preparado, y un contrato estático puede leer literales
pero no un bucle.

### Evidencia de staging usada

`artifacts/hosted-s1-observation-post-sentinel.json` (proyecto real, sólo
lectura) fija: `uellix_migrator` **NOCREATEROLE**, `ledgerOwner = uellix_owner`,
`public.uellix_auth_uid()` propiedad de `postgres`, y la topología de
pertenencias. `STELLA_APPLY_IDENTITY_PROBE.md` fija que la identidad de aplicación
es `postgres`.

Lo que la evidencia **no** contiene son los dueños de los siete objetos. Por eso
la remediación **mide antes de conceder y refusa un tercer dueño** en vez de
suponer. Sonda de una sola pasada, pendiente antes de autorizar staging:

```bash
psql "$UELLIX_STAGING_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f db/prepared/prechain/observation.sql
```

```
STAGING_PRECHAIN_OWNER_REALITY = PARTIAL_FROM_EXISTING_EVIDENCE
  (contrato correcto bajo cualquier resultado; la sonda sólo dice qué rama toma)
```

## 3. E-02 — el contrato de instalador

```
E02_HOSTED_INSTALLER = uellix_migrator
E02_LOCAL_EMULATION  = el mismo rol, LOGIN por 127.0.0.1 dentro de --network none
```

| principal | LOGIN | CREATEROLE | SET→owner | identidad de sesión | miembro temporal | lo nombra el SQL generado |
|---|---|---|---|---|---|---|
| `postgres` | sí | sí | sí | ya no | **prohibido** (rol de proveedor) | no |
| `uellix_migrator` | sí | **sí** (nuevo) | sí (SET=t, INHERIT=f) | **sí** | sí | **sí** |
| `uellix_owner` | no | no | — | no | sólo destino de traspaso | sí |

El registro de roles siempre dijo que el instalador «Holds CREATEROLE»; el
bootstrap lo creaba `NOCREATEROLE`. **El bootstrap era la deriva.** `postgres` no
puede ocupar su lugar: nombrar un rol de proveedor en una sentencia de pertenencia
es `AUTHORITY_UNKNOWN_ROLE` por diseño.

**Medido y probado en cada corrida**: `postgres` es **RECHAZADO**,
`uellix_migrator` **aplica**. Un contrato con una identidad permitida sólo es un
contrato si la otra sigue fallando.

Cinco prerequisitos más del instalador, cada uno hallado por el motor:

| # | qué faltaba | dónde falló | remediación |
|---|---|---|---|
| 1 | `CREATEROLE` | T1, primera sentencia | §2 crea el rol con él |
| 2 | `CREATE ON DATABASE` | T1[268] `CREATE SCHEMA` | §5d, literal |
| 3 | `USAGE` en los esquemas de la cadena | T3, precondición | generador, fuera de toda ventana |
| 4 | `SELECT` para que `information_schema` **le muestre** columnas | T4/T8, precondición | §5d |
| 5 | `EXECUTE ... WITH GRANT OPTION` sobre el shim | T4[237] | §5c |

El nº 4 es el más traicionero: `information_schema.columns` **filtra por
privilegio**, así que a un instalador sin ninguno la columna le consta *ausente* —
un falso negativo idéntico a una migración faltante.

### La ventana de propietario ya no concede pertenencia

Evidencia de motor que contradice directamente a Commit 4, y por tanto autorizada:

```
ERROR: permission denied to grant role "uellix_owner"
DETAIL: Only roles with the ADMIN option on role "uellix_owner" may grant this role.
```

Hacerla ejecutable exigiría dar al instalador **ADMIN sobre `uellix_owner` de
forma permanente** —poder entregar el propietario a cualquiera, entre paquetes y
después del último— para abrir una ventana que §2b ya abre de forma persistente.
Ahora `ownerWindowPrimitive` emite `SET ROLE` / `RESET ROLE` y nada más. Lo que
garantiza que sea seguro se comprueba donde hay base de datos: el gate refusa
antes de `T1` si `pg_has_role(installer, uellix_owner, 'SET')` es falso.

## 4. E-04 — topología, no conteo

```
E04_MEMBERSHIP_PRECONDITION = TOPOLOGY_BASED
```

Medido en 17.6 con `createrole_self_grant` vacío: crear un rol deja
`cap ← instalador`, **grantor = superusuario de bootstrap**, `admin=t inherit=f
set=f`, y `pg_has_role(installer, cap, 'SET') = FALSE`. La propiedad protegida se
cumple; el conteo que la probaba no puede.

`uellix_bootstrap.assert_capability_membership_topology()` (§5e), invocada por la
regla de reescritura `capability-member-count` en los cinco paquetes que lo
afirmaban, comprueba: **exactamente** la fila automática y ninguna otra, opciones
exactas, y —vía `pg_has_role`, que es transitivo (lab M4)— que **ningún** principal
no-superusuario alcanza la capacidad por `SET` ni por `INHERIT`. `count <= 1` fue
rechazado explícitamente: admitiría una segunda fila con `SET TRUE`.

## 5. E-03 — cerrado

`v_missing || 'literal'` resolvía `anyarray || anyarray` y enmascaraba **todo**
rechazo de capacidades como `malformed array literal`. Siete sitios ahora usan
`array_append`. Verificado en el motor: el rechazo por centinela ausente ahora
imprime su mensaje real.

## 6. Resultados de motor

```
PRECHAIN_AUTHORITY_GATE       PASS — 8 contratos de objeto, 0 rechazos, antes de T1
PRECHAIN                      CLEAN — 9/9 ABSENT
GOVERNED_T1_T9_ENGINE         9_OF_9_PASS
OWNER_TRANSFERS_ENGINE        27_OF_27_CORRECT
CANONICAL_OWNER_CONTEXT_ENGINE 3_OF_3_CORRECT
TRANSFER_MEMBERSHIP_CLEANUP   11_OF_11 (0 residuo tras cada paquete)
TEMP_SCHEMA_CREATE_RESIDUAL   ZERO
PERSISTENT_ROLE_TOPOLOGY      EXPECTED
SD_GATE_ENGINE_V2             PASS — 27 SECURITY DEFINER, 0 sin search_path vacío, 0 con EXECUTE a PUBLIC
RLS_POLICY_ENGINE             PASS — 164 políticas, 11 triggers, sin duplicados
PACKAGE_FAILURE_ATOMICITY     PASS_10_OF_10 — las diez ALCANZADAS
FORWARD_ONLY_ENGINE_CONTRACT  ENFORCED
PINNED_GOVERNED_INPUT         ENFORCED
UNGOVERNED_ARTIFACT_EXECUTION REFUSED
```

Los tres propietarios F-01 —`public.evidence_document_versions`,
`public.evidence_chunks`, `uellix_stella_ops.operation_tickets`— son
`uellix_owner`.

Topología persistente tras T9, exacta: las tres filas de capacidad
`cap ← uellix_migrator` (grantor `supabase_admin`, `admin=t inherit=f set=f`),
`uellix_owner ← uellix_migrator` (`set=t inherit=f`, §2b) y
`uellix_writer ← uellix_app` (`inherit=t set=f`). Ningún camino runtime→capacidad.

Las cuatro protecciones del runner gobernado siguen firmes: digest movido,
bytes no gobernados, ruta fuera de `/governed/`, paquete desconocido — todas
`REFUSED` **antes** de ejecutar SQL.

## 7. Bytes y plan

```
HOSTED_GOVERNED_BYTES = CHANGED (deliberado)
GOVERNED_PLAN_DIGEST  = 19a0ff5a962806f72a3285ea0542653ae9451fa1cd7a05ed7cc74470514634bf  (SIN CAMBIO)
51 ventanas / 59 segmentos / 11 traspasos / 27 funciones / 3 contextos de propietario  (SIN CAMBIO)
```

Los bytes se mueven por cuatro razones, todas registradas: dos reglas de
reescritura nuevas (`capability-member-count`, `auth-users-privilege-probe`), una
corregida (`auth-uid-precondition`, que en hosted era *inpreguntable*), y la
ventana de propietario que dejó de conceder pertenencia. **El plan de autoridad
no se movió** — ninguna ventana recuperada cambió de anclas, tamaño ni secuencia
de digests.

Por eso la reachability del instalador se emite en el **generador** y no como
regla de reescritura: junto al `GRANT USAGE ... TO uellix_app` habría caído
*dentro* de una ventana recuperada, alterando su conteo estructural — evidencia
que cuatro casos documentan uno a uno.

## 8. Pendiente

- Sonda de propiedad real de staging (§2), antes de autorizar `T1`.
- La derivación cubre las sentencias con ejecutor **no-instalador**; los cinco
  prerequisitos del instalador (§3) están en el bootstrap y en el gate, pero no
  se derivan aún. Extenderla es el siguiente endurecimiento natural.
- `F-C4-03..07`, endurecimiento diferido de Commit 4. La certificación no reveló
  que ninguno sea funcionalmente necesario.

```
SAFE_TO_WRITE_STAGING = false
T1_RETRY_AUTHORIZED   = false
```
