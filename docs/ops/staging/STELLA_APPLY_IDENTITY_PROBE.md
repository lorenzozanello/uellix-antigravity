# STELLA — Sonda de identidad de aplicación (PHASE_BASELINE)

> Train 5C2, Fase 4. **Read-only. Cero escrituras.** Este documento no autoriza
> nada y no crea nada.
>
> Existe porque las tres sondas §2.7 se ejecutaron en el **SQL Editor**, y el
> baseline lo aplicará **otra identidad**. Una sonda que no fija su identidad
> responde a una pregunta que nadie hizo.

---

## 1. Qué identidad aplica PHASE_BASELINE, y por qué

La respuesta está determinada por una restricción que suele pasarse por alto:

> **`uellix_migrator` todavía NO EXISTE cuando empieza el baseline.**
> Lo crea `stella_hosted_0001_managed_role_bootstrap`, que corre en
> `PHASE_STELLA_BOOTSTRAP` — **después** de las cincuenta unidades.

De modo que el rol de login con el que se aplica el baseline no puede ser
ninguno de los cinco roles `uellix_*`. Sobre un proyecto gestionado recién
creado, el único rol de login administrativo disponible es `postgres`.

| Campo | Valor |
|---|---|
| **Expected login role** | `postgres` por conexión directa; `postgres.bvyzblhqymxruxdguaee` por session pooler — es el **mismo** rol, y el sufijo es cómo el pooler enruta (§1.2) |
| **Connection mode** | conexión **directa** a `db.bvyzblhqymxruxdguaee.supabase.co:5432`, o **session pooler** (`aws-0-us-east-2.pooler.supabase.com:5432`). **NO** transaction pooler (`:6543`): el baseline usa `psql -1` y necesita transacciones de sesión completa |
| **Cuándo existe** | desde la creación del proyecto; es el rol administrativo que Supabase provee |
| **Por qué es el correcto** | es el único que existe y tiene `CREATE` sobre `public` antes del bootstrap. La separación de roles de Uellix comienza *después*, y ése es precisamente su diseño: `uellix_owner` es `NOLOGIN` y sólo se alcanza por `SET ROLE` desde `uellix_migrator`, ninguno de los cuales existe todavía |

### 1.1 Lo que la identidad de aplicación NO es

Cada línea es una confusión concreta que invalidaría la medición:

| No es | Por qué importa |
|---|---|
| **el SQL Editor** | ejecuta con otra identidad efectiva. [supabase/supabase#41126](https://github.com/supabase/supabase/issues/41126) reporta la MISMA `CREATE POLICY` fallando por conexión directa y funcionando en el SQL Editor. Es exactamente la asimetría que hay que medir, no asumir |
| **el transaction pooler** | `SET LOCAL ROLE` y `psql -1` necesitan afinidad de sesión. Medir ahí respondería sobre un modo de conexión que el apply no usará |
| **`service_role`** | prohibido como migrator, y §4.4 prohíbe aprovisionar su clave |
| **`uellix_migrator`** | no existe aún. Medir con él es imposible ahora y sería la identidad de las fases *posteriores*, no de ésta |

### 1.2 Un contrato de identidad, dos mecanismos de derivación

Este documento declaraba desde el principio que ambos modos de conexión son
válidos. El código no. Una auditoría independiente lo midió:

```
planProvisioningPhase(host = aws-0-us-east-2.pooler.supabase.com)
  → REFUSED  HOSTED_TARGET_HOST_NOT_SUPABASE
planProvisioningPhase(host = db.bvyzblhqymxruxdguaee.supabase.co)
  → PLAN OK, 51 steps
```

**La autorización apuntaba a una conexión que el planificador rechazaba.** El
gate de apply corroboró el objetivo por el rol de login del pooler y dio PASS;
`verifyStagingTarget` — la comprobación que usa el runner — rechazaba ese host
de plano. Dos contratos de identidad dentro de una misma decisión. Fail-closed,
y aun así inservible: *una autorización sobre la que nadie puede actuar no
autoriza nada*.

La corrección **no** es aceptar el host del pooler. Es reconocer que hay **un
solo contrato** con **dos mecanismos de derivación**, porque el ref del proyecto
vive en sitios distintos según el modo:

| | Conexión directa | Session pooler |
|---|---|---|
| Host | `db.<ref>.supabase.co` — **nombra** el proyecto | `aws-0-<región>.pooler.supabase.com` — **regional y compartido**, no nombra a nadie |
| De dónde sale el ref | del host | del **rol de login**, `postgres.<ref>` |
| Puerto | 5432 | 5432 sesión · 6543 transacción → **rechazado** |
| Si falta la fuente del ref | el host siempre está | **rechazo**, nunca aceptación por el hostname |

Lo que **no** cambia entre los dos mecanismos, porque es el contrato y no el
mecanismo:

1. La **denylist de producción tiene precedencia absoluta**, y se aplica sobre
   *todos* los refs candidatos a la vez — declarado, centinela, rol de login y
   host — antes que cualquier otra comprobación. Un conjunto de campos
   internamente perfecto no la sobrevive.
2. El ref derivado debe coincidir **exactamente** con el proyecto fijado. Un ref
   sintácticamente válido de *otro* proyecto se rechaza
   (`HOSTED_TARGET_NOT_EXPECTED_PROJECT`).
3. Si hay **más de una** fuente de identidad, **todas** deben coincidir. Una
   contradicción es `HOSTED_TARGET_IDENTITY_CONTRADICTION`; nunca se elige una
   fuente en silencio por encima de otra.
4. Entrada ambigua, parcial o contradictoria se **rechaza**. Nunca se acepta por
   región, por sufijo DNS ni por «parece un pooler».

El rol de login se trata como **nombre de usuario y nada más**:
`projectRefFromPoolerUser` rechaza cualquier valor con `:`, `@`, `/` o espacios
en vez de parsear a su alrededor, de modo que un DSN pegado donde iba un usuario
se rechaza en lugar de almacenarse.

Dónde vive esto, y dónde se refuta:

| | |
|---|---|
| Contrato | `db/hosted/target-identity.ts` — `deriveConnectionIdentity`, `verifyStagingTarget`, `projectRefFromPoolerUser` |
| Los catorce ataques | `tests/hosted/identity-contract.test.ts` |
| Que el plan de 51 pasos existe por ambos modos | `tests/hosted/hosted-provisioning-runner.test.ts`, §«ACTIONABILITY» |

---

## 2. El bloque canónico — SONDA 1

Ejecutar con **exactamente** la misma conexión y el mismo rol que se usarán para
`PHASE_BASELINE`. No en el SQL Editor.

```sql
BEGIN READ ONLY;

SELECT
  current_user,
  session_user,
  version(),
  current_setting('transaction_read_only');

SELECT
  pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER') AS is_member,
  pg_has_role(current_user, 'supabase_storage_admin', 'USAGE')  AS inherits_privileges,
  pg_has_role(current_user, 'supabase_storage_admin', 'SET')    AS can_set_role;

ROLLBACK;
```

### 2.1 Por qué las tres columnas, y no una

PostgreSQL 16 dividió la pertenencia a un rol en **tres privilegios
independientes**, y 17 los mantiene separados. Confundirlos es el error que este
bloque existe para evitar:

| Privilegio | Qué significa | Qué NO significa |
|---|---|---|
| `MEMBER` | perteneces al rol | **no** implica poder usarlo ni asumirlo. `GRANT r TO u WITH SET FALSE, INHERIT FALSE` da esto y nada más |
| `USAGE` | tienes sus privilegios **sin** `SET ROLE` (INHERIT) | es lo que consulta la comprobación de propiedad de PostgreSQL — por eso `ownsStorageObjects=FALSE` predice bien que un `CREATE POLICY` directo falla |
| `SET` | **puedes ejecutar `SET ROLE`** | — |

**`SET` es el único que decide si la Rama A existe.** Una versión anterior de
esta sonda preguntaba `MEMBER`, y `MEMBER` no responde a la pregunta.

### 2.2 Evidencia requerida

Sólo estos seis valores. Nada más, y en particular **ninguna cadena de conexión
y ninguna contraseña**:

```
current_user         = ?
session_user         = ?
transaction_read_only= ?
is_member            = ?
inherits_privileges  = ?
can_set_role         = ?
```

---

## 3. SONDA 2 — sólo si `can_set_role = TRUE`

El catálogo dice que el *grant* lo permite. Sólo la operación demuestra que nada
más lo rechaza. La Rama A exige **las dos**.

```sql
BEGIN READ ONLY;

SET LOCAL ROLE supabase_storage_admin;

SELECT
  current_user,
  session_user,
  current_setting('transaction_read_only');

RESET ROLE;

ROLLBACK;
```

Debe demostrar, y las cuatro cosas son verificables en su salida:

1. `SET ROLE` funciona — la sentencia no levanta error;
2. `current_user` **cambia** a `supabase_storage_admin`;
3. `session_user` **permanece** en la identidad de conexión — la sesión no
   escaló, sólo asumió un rol dentro de una transacción;
4. `transaction_read_only` sigue en `on` — cero escrituras posibles.

Si cualquiera falla: **`SET_ROLE_PATH_BLOCKED`**. No se sustituye por `MEMBER`,
ni por `USAGE`, ni por lo que ocurra en otro proyecto.

---

## 4. Matriz de decisión

Ninguna rama puede elegirse antes de las dos sondas.

| `can_set_role` | `SET LOCAL ROLE` | Rama | Significado |
|---|---|---|---|
| `TRUE` | demostrado | **A — `SET_ROLE_PATH_CANDIDATE`** | la PARTE B puede correr por `psql` bajo `SET LOCAL ROLE`, con las seis condiciones locales de la Fase 6 aún por demostrar |
| `TRUE` | falla | **D** | el catálogo y la operación discrepan; nada es fiable hasta entenderlo |
| `FALSE` | no se ejecuta | **B — `SET_ROLE_PATH_REJECTED`** | la PARTE B necesita un canal gestionado separado, gobernado como artefacto |
| no medido | — | **AWAITING** | estado actual |

---

## 5. Estado

**`AWAITING_APPLY_IDENTITY_PROBE`.**

Lo ya medido se conserva **sin sobrescribir**, porque son preguntas distintas
sobre identidades distintas:

| Identidad | Sonda | Resultado |
|---|---|---|
| **SQL Editor** | `canCreateTriggerOnAuthUsers` | `TRUE` |
| **SQL Editor** | `ownsStorageObjects` | `FALSE` |
| **SQL Editor** | `evidenceBucketExists` | `FALSE` |
| **psql apply identity** | `current_user` / `session_user` | *pendiente* |
| **psql apply identity** | `MEMBER` / `USAGE` / `SET` | *pendiente* |
| **psql apply identity** | `SET LOCAL ROLE` | *pendiente* |
