# Seguridad de destino de base de datos

**Estado:** vigente desde 2026-08-02.
**Alcance:** todo acceso a PostgreSQL y a la API HTTP de Supabase desde este
repositorio (aplicación, scripts, seeds, migraciones, tests, auditoría).
**Módulos:** `db/safety/*`, `db/client.ts`.

Este documento describe una arquitectura **fail-closed**: si el sistema no
puede clasificar un destino con confianza, o si falta cualquier señal de
autorización, la operación se **rechaza**. Nunca se degrada a "permitir".

> Este documento **no** aprueba G2 remoto, **no** declara producción lista y
> **no** habilita grounding. Describe únicamente el control de acceso.

---

## 1. El incidente que motivó el endurecimiento

Los scripts de fixtures locales (`db:seed:proxies`, `db:seed:taxonomies`)
resolvían su destino leyendo la variable de conexión del entorno mediante
`import 'dotenv/config'` seguido de `import { db } from '../db/client'`.

Eso produce una ambigüedad estructural en **ambas direcciones**:

- `dotenv` **no** sobrescribe una variable ya exportada, de modo que el
  operador que exportaba una URL local quedaba a salvo — pero por accidente,
  no por diseño;
- el operador que **no** exportaba nada recibía lo que hubiera en `.env`, que
  en una máquina de desarrollo es con frecuencia una cadena de conexión
  remota.

En los dos casos, la **intención** ("sembrar mi stack local") y el **destino**
los decidían cosas distintas. Las mismas teclas sembraban un portátil un día y
una base gestionada al siguiente.

Agravantes que existían en el repositorio:

| Debilidad | Consecuencia |
|---|---|
| `db/client.ts` construía el cliente en el cuerpo del módulo | 65 módulos lo importan; el destino se capturaba, sin guarda, **antes** de que un script pudiera comprobar nada. ESM evalúa los imports antes de la primera sentencia del módulo importador, así que "poner una guarda arriba del seed" era imposible por construcción. |
| Guardas por script, escritas a mano | `scripts/create-test-user.ts` caía a coincidencia de subcadenas (`url.includes('localhost')`) si el parseo fallaba: `https://localhost.atacante.example/` la pasaba. |
| Guardas que sólo validaban el **hostname** | Este host ejecuta varios stacks locales de Supabase en paralelo. Una URL loopback en el **puerto equivocado** apuntaba al stack de otro worktree y pasaba la validación. |
| `pnpm db:migrate` y `pnpm db:seed:*` | Comandos ambiguos: su nombre no declaraba el entorno de destino. |
| Protecciones procedimentales | Documentadas en checklists, no ejecutables. |

**Nunca se reproducen aquí la cadena de conexión ni la contraseña
involucradas.** Los ejemplos de este documento y de los tests son ficticios
(rangos de documentación RFC 5737 / RFC 3849, `example.com`, y una referencia
de proyecto inventada).

---

## 2. Arquitectura

Cuatro capas, cada una depende sólo de la anterior:

```
db/safety/local-stack.ts               hechos fijos de ESTE worktree
db/safety/database-target.ts           CLASIFICACIÓN: ¿qué clase de host es?
db/safety/resolve-local-database-url.ts RESOLUCIÓN: ¿qué URL usa un entry point local?
db/safety/database-access.ts           AUTORIZACIÓN: ¿puede esta capacidad correr aquí?
db/client.ts                           única fábrica que abre una conexión
```

**Clasificación y autorización son conceptos separados.** Que un destino sea
`local_loopback` no es un permiso, y que sea `managed_remote` no significa por
sí mismo "producción".

### 2.1 Clasificación de destinos

`classifyDatabaseTarget(url)` usa parseo **real** (`URL` de WHATWG), nunca
regex ni subcadenas. Devuelve una de estas clases:

| Clase | Significado |
|---|---|
| `local_loopback` | `localhost`, `127.0.0.0/8`, `::1` |
| `local_container` | hostname de contenedor **explícitamente** en la allow-list del llamador |
| `private_network` | RFC1918, link-local `169.254/16`, CGNAT `100.64/10`, ULA IPv6 `fc00::/7`, link-local IPv6 `fe80::/10` |
| `managed_remote` | host públicamente enrutable: Supabase, cualquier dominio o IP pública |
| `unknown` | parseable pero no categorizable con confianza — **siempre falla** |
| `invalid` | ausente, no parseable, esquema no soportado, sin hostname — **siempre falla** |

### 2.1.1 Autoridad ambigua — el hallazgo más grave de la revisión

La primera versión de esta capa era **evadible**. `URL` (WHATWG) termina el
*userinfo* en el **último** `@`; postgres-js re-parsea la cadena cruda por su
cuenta con `indexOf('@')` — el **primero** — y además trata la coma como una
lista **multihost**, conectando al primer elemento. Verificado contra
`postgres@3.4.9`:

```
postgresql://u:p@db.<ref>.supabase.co:5432,127.0.0.1@127.0.0.1:56322/postgres

  new URL(...).hostname  ->  127.0.0.1        (clasificaba local_loopback:56322)
  primer host del driver ->  db.<ref>.supabase.co
```

La guarda autorizaba un seed local y el driver marcaba un destino gestionado
remoto. Era alcanzable desde `UELLIX_LOCAL_DATABASE_URL` y desde
`DATABASE_URL`.

En vez de emular al driver — cuyo parser puede cambiar — se rechaza toda
autoridad que no sea inequívoca (`unknown` / `ambiguous_authority`):

- contiene un `#`;
- contiene una coma;
- contiene más de un `@`;
- su parte de host cambia bajo `decodeURIComponent`.

Ninguna cadena de conexión legítima de este repositorio tiene ninguna de las
cuatro.

**La primera corrección de esto era, a su vez, evadible en un carácter.**
Cortaba la autoridad en `[/?#]` mientras el driver corta sólo en `[?/]`, así
que todo lo que siguiera a un `#` quedaba invisible para la comprobación:

```
# secret-scan-ok: la "contraseña" es un puerto y un '#' — la discrepancia de parsers, no una credencial.
postgresql://127.0.0.1:56322#@evil.example.com,127.0.0.1/postgres
  guarda -> local_loopback:56322                 (AUTORIZADO)
  driver -> host ["evil.example.com","127.0.0.1"]
```

La autoridad se corta ahora **exactamente donde la corta el driver**, y un `#`
en esa región se rechaza sin más: su sola presencia garantiza que los dos
parsers discrepan sobre dónde termina la autoridad.

### 2.1.2 Parámetros que anulan nuestros ajustes

postgres-js reenvía al paquete de arranque **toda** clave de la query que no
consuma como opción propia, y lo hace **después** del objeto `connection` del
llamador. Postgres aplica los GUC de arranque en orden, así que el último
gana. Eso anulaba el `default_transaction_read_only=on` que esta capa impone a
las capacidades de solo lectura:

```
?options=-c%20default_transaction_read_only%3Doff     ← primera vía detectada
?default_transaction_read_only=off                    ← misma consecuencia, más corta
```

Rechazar sólo `options` era insuficiente. La clasificación devuelve ahora
`injectedConnectionParameters` — los **nombres** (nunca los valores) de las
claves que el driver reenviaría — comparados contra una **allow-list** de las
opciones que postgres-js consume él mismo. La comparación es sensible a
mayúsculas porque la del driver lo es (`k in defaults`), de modo que `SSLMODE`
también se marca.

Se rechaza con `DB_URL_UNSAFE_PARAMETERS` en todas las capacidades **salvo
`app_runtime`**. Esa excepción es deliberada y es una cuestión de realidad de
despliegue: las cadenas gestionadas sí llevan parámetros legítimamente — el
pooler compartido de Supabase usa `?options=reference%3D<ref>` — y rechazarlas
rompería el producto al arrancar. `app_runtime` no fija ninguna opción de
conexión propia, así que un parámetro de la URL no anula ninguna garantía.

Reglas de diseño relevantes:

- **`postgresql:` es un esquema "no especial"** en el estándar URL. Su host se
  parsea como *opaque host*: sin IDNA, sin decodificación percent, sin pasar a
  minúsculas. Esto nos favorece —
  `postgresql://localhost:pw@db.ref.supabase.co/postgres` tiene hostname
  `db.ref.supabase.co`, y el `localhost` es el **username** — pero obliga a
  normalizar a minúsculas nosotros y a rechazar cualquier host que aún
  contenga `%`.
- **Una IP privada no es segura por defecto.** `private_network` no es un
  destino local autorizado para ninguna capacidad local.
- **Octetos ambiguos se rechazan.** `127.0.0.01` no es loopback: con cero a la
  izquierda, glibc y varios drivers lo leen como octal, así que la dirección
  que ve la guarda podría no ser la que marca el driver. Se clasifica
  `unknown`.
- `0.0.0.0`, `::` y las IPv6 mapeadas a IPv4 (`::ffff:127.0.0.1`) se clasifican
  `unknown`, no local.
- Un hostname sin puntos y sin entrada en la allow-list es `unknown`. La
  allow-list de contenedores está **vacía por defecto**.

### 2.2 Redacción

Ningún mensaje contiene la URL, sus credenciales ni su query string.

| Entrada | En el mensaje |
|---|---|
| `127.0.0.1`, `localhost`, `::1` | verbatim (no identifican nada) |
| `db.<ref-de-proyecto>.supabase.co` | `***.supabase.co` |
| `acme-prod.com` | `***.com` |
| `interno.acme-prod.io` | `***.io` |
| `203.0.113.10` | `203.0.x.x` |
| `10.1.2.3` | `10.1.x.x` |
| `2001:db8::1` | `2001:***` |
| ausente | `(no host)` |

Se enmascara todo lo que identifique a una organización, **sin importar el
número de etiquetas**: una versión anterior conservaba las dos últimas, lo que
devolvía `acme-prod.com` intacto. Los sufijos de proveedores gestionados
conocidos (`.supabase.co`, `.supabase.com`) sí se conservan, porque nombran un
servicio público y no a un cliente, y son útiles para diagnosticar.

El puerto sí se muestra: no es secreto y es la información que más ayuda a
diagnosticar un destino equivocado entre stacks locales.

### 2.2.1 El primer error DESPUÉS de la guarda

Los mensajes de la guarda están redactados por construcción. El riesgo real
era el error siguiente: postgres-js construye los fallos de conexión como
`'write ' + code + ' ' + host + ':' + port` y adjunta `address`, de modo que un
`console.error('Failed:', err)` imprimía el host remoto completo — y, en
Supabase, la referencia de proyecto.

`db/safety/redact-error.ts` expone `describeError()`, por el que pasa el
`catch` final de **todos** los entry points: reduce un error del driver a su
código más un host redactado, y deja pasar sin cambios los errores tipados de
la propia guarda.

---

## 3. Capacidades

| Capacidad | Destinos aceptados | Entornos | Señales exigidas |
|---|---|---|---|
| `app_runtime` | loopback, container, private, **managed_remote** | todos | ninguna extra; rechaza `unknown`/`invalid` |
| `readonly_audit` | loopback, container | dev, test, ci | puerto local esperado; sesión forzada a solo lectura |
| `local_seed` | loopback, container | dev, test, ci | puerto local esperado |
| `local_integration_test` | loopback, container | dev, test, ci | puerto local esperado |
| `local_migration` | loopback, container | dev, test, ci | puerto local esperado |
| `local_reset` | loopback, container | dev, test, ci | puerto + project id + confirmación exacta |
| `controlled_remote_migration` | managed_remote | **staging** | token propio + project ref + operación + confirmación exacta |
| `controlled_remote_read` | managed_remote | staging, production | token propio + project ref; sesión solo lectura |
| `controlled_remote_write` | managed_remote | **staging** | token propio + project ref + operación + confirmación exacta |

### 3.1 Aislamiento de capacidades

**No existe `ALLOW_REMOTE=true`.** Cada capacidad remota tiene su propia
variable, y el valor se compara con `===` contra un literal exacto — un valor
meramente "verdadero" como `true` o `1` **no** autoriza:

| Capacidad | Variable | Valor exacto exigido |
|---|---|---|
| `controlled_remote_migration` | `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION` | `controlled_remote_migration` |
| `controlled_remote_read` | `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ` | `controlled_remote_read` |
| `controlled_remote_write` | `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_WRITE` | `controlled_remote_write` |

Autorizar una **no** autoriza otra. Ninguna capacidad **local** declara
variable de autorización: no hay nada que exportar que permita a un seed
alcanzar un destino remoto.

### 3.2 Confirmaciones

Se comparan de forma **exacta**. Espacios alrededor, mayúsculas distintas o un
token truncado son un fallo.

| Capacidad | Forma de la confirmación |
|---|---|
| `local_reset` | `reset-local:<project-id>` |
| `controlled_remote_migration` | `controlled_remote_migration:<project-ref>:<operación>` |
| `controlled_remote_write` | `controlled_remote_write:<project-ref>:<operación>` |

La confirmación se **liga al project id declarado y a la operación exacta**,
de modo que un token acuñado para un stack u operación no confirma otra.

### 3.3 Códigos de error estables

`DatabaseSafetyError` expone `code`, `capability`, `targetKind`,
`redactedHost` y `port`:

`DB_TARGET_URL_MISSING`, `DB_TARGET_URL_INVALID`, `DB_TARGET_UNKNOWN`,
`DB_URL_UNSAFE_PARAMETERS`, `DB_OPERATION_NOT_ALLOWED`, `DB_LOCAL_PORT_REQUIRED`,
`DB_LOCAL_PORT_MISMATCH`, `DB_PROJECT_ID_REQUIRED`, `DB_PROJECT_ID_MISMATCH`,
`DB_REMOTE_AUTHORIZATION_MISSING`, `DB_ENVIRONMENT_NOT_ALLOWED`,
`DB_CONFIRMATION_REQUIRED`, `DB_CONFIRMATION_MISMATCH`,
`DB_OPERATION_DECLARATION_REQUIRED`, `DB_OPERATION_DECLARATION_MISMATCH`.

### 3.4 Resolución del entorno

`resolveEnvironment()` — sin coerción booleana:

1. `UELLIX_APP_ENV` gana si nombra un entorno conocido. **Si está definida
   pero no se reconoce, resuelve a `production`**, no al valor por defecto: la
   errata de un operador no debe convertirse en el entorno más permisivo.
2. `NODE_ENV=test` → `test`.
3. `CI` exactamente `true` o `1` → `ci`.
4. `NODE_ENV` ausente o `development` → `development`.
5. Cualquier otra cosa → `production`.

---

## 4. Comandos

### 4.1 Permitidos (locales)

| Comando | Qué hace | Requisitos |
|---|---|---|
| `pnpm db:migrate:local` | migraciones drizzle contra el stack local | stack levantado |
| `pnpm db:seed:local` | organizaciones y usuarios sintéticos | stack levantado |
| `pnpm db:seed:stella-local` | fixtures sintéticos de Stella | seed base ya aplicado |
| `pnpm db:seed:local:proxies` | proxies de sistema | un super admin existente |
| `pnpm db:seed:local:taxonomies` | catálogos ODS / IRIS+ | — |
| `pnpm db:test:integration:local` | suites de integración | stack levantado |
| `pnpm db:audit:readonly` | auditoría estructural, solo lectura | stack levantado |
| `pnpm db:setup:local` | migraciones + seed base | — |
| `pnpm db:reset:local` | **destructivo**: rebuild completo | confirmación exacta (§4.3) |
| `pnpm db:generate` | genera SQL desde el schema; **no conecta** | — |

`pnpm test:integration` y `pnpm test:rls` siguen existiendo con su nombre
histórico porque CI los invoca, y ahora pasan por la misma guarda.
`db:test:integration:local` es el alias que declara el entorno.

**Las suites de integración no se pueden ejecutar sin guarda.** La garantía
vivía sólo en `vitest.setup.integration.ts`, que carga únicamente
`vitest.integration.config.ts` — así que `pnpm test`, o apuntar vitest
directamente a uno de esos archivos, los ejecutaba con la config base: sin
comprobación de destino y con el `db` compartido todavía en `app_runtime`, que
sí admite remoto. Dos controles independientes lo cierran:

1. `vitest.config.ts` excluye `tests/integration/**`;
2. `tests/integration/_guard.ts` es el **primer** import de cada archivo de
   integración, de modo que la puerta depende del archivo y no de la config.

### 4.2 Bloqueados

| Comando | Reemplazo |
|---|---|
| `pnpm db:seed:proxies` | `pnpm db:seed:local:proxies` |
| `pnpm db:seed:taxonomies` | `pnpm db:seed:local:taxonomies` |
| `pnpm db:migrate` | `pnpm db:migrate:local` (local) o el paquete SQL revisado (remoto) |

No se eliminaron: abortan con código 1 e indican el reemplazo, para que un
operador con memoria muscular reciba una instrucción y no un "command not
found".

### 4.3 Reset local

```bash
export UELLIX_DB_LOCAL_RESET_CONFIRM="reset-local:uellix-stella-g2-local-rehearsal"
pnpm db:reset:local
```

En PowerShell:

```powershell
$env:UELLIX_DB_LOCAL_RESET_CONFIRM="reset-local:uellix-stella-g2-local-rehearsal"
```

`db:reset:local` ejecuta primero `db:guard:local-reset`, que no conecta a
nada: sólo clasifica el destino y evalúa la capacidad `local_reset`. Si la
rechaza, sale con código 1 y la cadena `&&` se detiene antes de
`supabase stop`.

### 4.4 Variables

| Variable | Para qué | Notas |
|---|---|---|
| `DATABASE_URL` | **sólo** el runtime de la aplicación | Los entry points locales la **ignoran**. Si está definida, avisan (con host redactado) de que es inerte. |
| `UELLIX_LOCAL_DATABASE_URL` | apuntar a otro stack **local** | Debe clasificar local **y** estar en el puerto esperado, o la resolución falla. |
| `UELLIX_DB_LOCAL_RESET_CONFIRM` | confirmar el reset local | Comparación exacta. |
| `UELLIX_APP_ENV` | declarar el entorno | Valor no reconocido ⇒ `production`. |
| `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_*` | autorizar una capacidad remota | Una por capacidad; valor literal exacto. |

---

## 5. Procedimiento local

1. `pnpm supabase start` (puertos de este worktree: API 56321, DB 56322).
2. `pnpm db:migrate:local`
3. `pnpm db:seed:local`
4. Opcional: `pnpm db:seed:stella-local`, `pnpm db:seed:local:proxies`,
   `pnpm db:seed:local:taxonomies`
5. Verificación: `pnpm db:audit:readonly`

Los seeds no consultan `DATABASE_URL`. Toman la URL fija de
`db/safety/local-stack.ts`, que es a su vez la única fuente de verdad
contrastada contra `supabase/config.toml` por
`tests/database-target-safety.test.ts`.

---

## 6. Procedimiento remoto (futuro)

**Ningún comando de `package.json` escribe en un destino remoto.** Las
operaciones remotas siguen pasando por los paquetes SQL revisados de
`db/prepared/` y las checklists de `docs/ops/gates/`.

Las capacidades `controlled_remote_*` existen para el día en que una
herramienta TypeScript deba hacerlo. Hoy **ningún** entry point las usa. Para
que una llegara a ejecutarse harían falta, de forma simultánea:

1. destino clasificado `managed_remote`;
2. entorno permitido (`staging` para migración y escritura);
3. `expectedProjectId` coincidente con la referencia de proyecto de la URL;
4. la operación exacta declarada;
5. la confirmación exacta que combina capacidad, proyecto y operación;
6. la variable de autorización **de esa capacidad**, con su valor literal.

---

## 6.1 Riesgos residuales aceptados

Dos, ambos localizados en `app_runtime`, ambos conscientes y documentados —
no descubiertos tarde:

| Riesgo | Por qué se acepta | Qué haría falta para cerrarlo |
|---|---|---|
| `app_runtime` admite parámetros de query que el driver reenvía al paquete de arranque, incluido `options` (`-c row_security=off`, `-c search_path=…`) | (a) Rechazarlos rompería el arranque del producto: las cadenas gestionadas los llevan legítimamente. (b) **No hay escalada de privilegio bajo una premisa explícita**: quien fija `DATABASE_URL` es también quien posee la credencial que contiene, así que puede apuntar a una base propia y no gana nada añadiendo `-c`. **Ojo: la equivalencia depende de esa premisa, no de la naturaleza del parámetro** — `-c row_security=off` NO equivale a redirigir la URL: conserva la base real y desactiva RLS sobre la app viva. Si la plataforma llegara a tener un rol capaz de editar variables de entorno sin ver su valor, o si `DATABASE_URL` se ensamblara por partes, la premisa se rompe y este riesgo deja de ser aceptable | Conocer la cadena de producción real y sustituir la exención por una allow-list **por valor** (p. ej. `options` sólo si vale `reference=<ref>`) |
| `app_runtime` no fija TLS; lo decide la URL (`?sslmode=…`), y el valor por omisión de postgres-js es `ssl: false` | La postura TLS del runtime es configuración de despliegue existente. Cambiarla desde esta capa podría tumbar producción sin previo aviso | Confirmar la cadena de producción y añadir `requiresTls: true` a `app_runtime` para destinos `managed_remote` |

La exención ya no es silenciosa: cuando la URL lleva parámetros reenviables,
la línea de auditoría los enumera por **nombre** (`urlParams=[...]`, nunca sus
valores), de modo que un operador puede detectarlo sin riesgo de arranque.

Las capacidades `controlled_remote_*` **sí** fijan TLS, porque hoy no las usa
ningún entry point y por tanto no hay comportamiento de producción que romper.
Se fija `verify-full`, **no `require`**: en postgres-js,
`require`/`allow`/`prefer` ponen `rejectUnauthorized = false`, es decir,
cifrado **sin autenticación del servidor** — que un atacante en la ruta
derrota presentando cualquier certificado. Por eso la línea de auditoría dice
`tls=verified` y no algo que sólo *suene* fuerte.

## 6.2 Qué NO cubre esta capa: el rol de conexión

Esta capa responde **dónde** se conecta un proceso. No responde **con qué rol**,
y esa es una pregunta distinta con consecuencias distintas.

Hasta 2026-08-02, `db/client.ts` resolvía a `postgres`, que era además el
**propietario** de las 38 tablas y las 8 funciones de `public`. Un destino
correctamente autorizado por esta capa seguía siendo, del otro lado del socket,
una sesión capaz de `DROP POLICY`, `ALTER TABLE … DISABLE ROW LEVEL SECURITY` y
`DISABLE TRIGGER` sobre las mismas tablas append-only que debía respetar.

Ese eje lo cubre el **modelo de roles**:
[`docs/ops/DATABASE_ROLE_MODEL.md`](DATABASE_ROLE_MODEL.md), implementado por
`db/prepared/stella_0004_role_separation.sql` y aplicado **sólo en local**.

Las dos capas son complementarias y ninguna sustituye a la otra:

| Pregunta | Capa | Módulo |
|---|---|---|
| ¿A qué host puede conectarse esta capacidad? | destino | `db/safety/` |
| ¿Qué puede hacer el rol una vez conectado? | privilegios | `db/prepared/stella_0004_*`, `db/audit/canonical_acl.sql` |

**Riesgo residual vigente (RR-01):** el runtime sigue siendo `postgres`, que
conserva `rolbypassrls`. Ya no es owner — así que no puede alterar estructura,
policies ni triggers — pero sigue exento de RLS. Rotarlo a `uellix_app` exige
propagar los claims JWT por transacción, como hace PostgREST; es un cambio de
aplicación, registrado como decisión **DP-07**.

## 7. Qué NO debe hacerse

- **No** añadir una variable que habilite varias capacidades a la vez.
- **No** añadir un bypass para ejecutar seeds sintéticos contra producción.
  No existe y no debe existir: es una decisión de diseño, no un parámetro.
- **No** clasificar destinos con `includes()`, regex o coincidencia de
  subcadenas. `localhost.atacante.example` contiene `localhost`.
- **No** asumir que una IP privada es segura, ni que una URL de Supabase es
  producción.
- **No** interpolar una URL, un usuario, una contraseña o una query string en
  un mensaje de error. Usar `redactHost`.
- **No** reintroducir efectos de import en `db/client.ts`.
- **No** exportar un comando cuyo nombre no declare su entorno.

---

## 8. Notas para quien mantenga tests

`db/client.ts` ya no construye su cliente al importarse: `db` es un proxy
perezoso. En consecuencia:

- `vi.mock('@/db/client')` **sin factory** (automock) produce un objeto vacío,
  porque no hay instancia viva de drizzle que el automocker pueda recorrer.
  Sirve para suites que asignan sus propios mocks (`vi.mocked(db).insert =
  ...`), pero **no** para suites que llaman `.mockReturnValue()` sobre métodos
  preexistentes. Ésas deben declarar una factory explícita — ver
  `tests/fx-rates.service.test.ts`.
- Inspeccionar el proxy es inerte; **usarlo** conecta. Las lecturas por
  símbolo y `__esModule` se responden desde el target vacío, porque son
  protocolo del lenguaje y del interop de módulos, no la API de consulta de
  drizzle. `JSON.stringify(db)` **sí** conecta: hace un `get` de `toJSON`.

---

## 9. Revisión adversarial

La arquitectura se sometió a revisión adversarial independiente de solo
lectura. **La primera ronda encontró 2 BLOCKER y 4 MAJOR reales** — todos
verificados de forma reproducible antes de corregirse, y todos cerrados con
una prueba que falla si la corrección se revierte:

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 1 | BLOCKER | Divergencia multihost / primer `@` entre `URL` y postgres-js: una cadena leída como `127.0.0.1:56322` hacía que el driver marcara primero un host remoto | `hasAmbiguousAuthority()` — se rechaza toda autoridad con coma, con más de un `@`, o cuyo host cambie bajo `decodeURIComponent` |
| 2 | BLOCKER | `pnpm test` ejecutaba las suites de integración con la config base, sin guarda alguna | Exclusión en `vitest.config.ts` **más** guarda por archivo en `tests/integration/_guard.ts` |
| 3 | MAJOR | `?options=` en la URL anulaba la imposición de solo lectura | `DB_URL_UNSAFE_PARAMETERS`, rechazado para todas las capacidades |
| 4 | MAJOR | `restrictDefaultDatabaseClient` podía **ampliar**; `resetDefaultDatabaseClientForTests` limpiaba la restricción desde código de producción | Restricción de un solo uso, rechaza `app_runtime`, y la función de reset se eliminó |
| 5 | MAJOR | `redactHost` devolvía verbatim cualquier host de dos etiquetas | Se enmascara siempre, salvo sufijos de proveedor conocidos |
| 6 | MAJOR | Los errores del driver posteriores a la guarda reimprimían el host sin redactar | `describeError()` en todos los `catch` finales |
| 7 | MINOR | `seed-stella-local` esquivaba el chokepoint llamando al driver directamente | Pasa por `createDatabaseClient`; se eliminó su guarda propia |
| 8 | MINOR | Las comprobaciones de CI eran greps por subcadena — la misma clase de bug que esta capa elimina | `scripts/ci-assert-local-targets.ts`, que usa el clasificador |

**La segunda ronda encontró 1 BLOCKER y 2 MAJOR más** — dos de ellos
introducidos por las correcciones de la primera:

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 9 | BLOCKER | La corrección del hallazgo 1 era evadible en **un carácter**: cortaba la autoridad en `[/?#]` y el driver corta en `[?/]`, así que todo lo posterior a un `#` quedaba invisible | La autoridad se corta donde la corta el driver, y un `#` en esa región se rechaza |
| 10 | MAJOR | La corrección del hallazgo 2 hizo que la config de integración colectara **cero** archivos: `mergeConfig` **concatena** arrays, así que heredaba la exclusión y no podía estrecharla. CI habría fallado en cada PR | Listas compartidas en `vitest.shared.ts`; la config de integración **reemplaza** `exclude` después del merge, y hay una aserción **de comportamiento** para ambas configs |
| 11 | MAJOR | Rechazar sólo `options` era insuficiente: el driver reenvía **toda** clave de query que no consume, y `?default_transaction_read_only=off` llegaba igual | Allow-list de las claves que el driver consume; se rechaza cualquier otra, salvo en `app_runtime` |
| 12 | MINOR | `describeError` enmascaraba por lista de TLD, así que otros dominios e IPv6 se filtraban; los fallos de DNS llevan `hostname`, no `address` | Ante un errno de red se descarta el mensaje entero; se lee también `hostname` |
| 13 | MINOR | Un `catch {}` desnudo tragaba también el caso en que la restricción **no** se aplicó | Errores etiquetados con `code`; sólo se absorbe `DB_RESTRICTION_ALREADY_APPLIED` |
| 14 | MINOR | Varias garantías se verificaban por grep del código fuente | Las aserciones de config son ahora de comportamiento (resuelven ambas configs) |

Y uno encontrado fuera de las revisiones: `createDatabaseClient` aceptaba
`postgresOptions`, y postgres-js resuelve `o.hostname || o.host || ... ||
url.hostname` — un objeto de opciones **gana** sobre la cadena de conexión.
Ahora se rechazan todas las claves que determinan el destino.

**La tercera ronda encontró 0 BLOCKER, 4 MAJOR y 4 MINOR:**

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 15 | MAJOR | TLS se podía desactivar con `?sslmode=disable` en **cualquier** capacidad, incluida una lectura remota controlada contra producción; y el valor por omisión de postgres-js ya es `ssl: false` | `requiresTls` en la política; `db/client.ts` fija `ssl: 'require'` en el objeto de opciones, que gana sobre la URL. Aplicado a las tres `controlled_remote_*` |
| 16 | MAJOR | `postgresOptions.connection` podía sobrescribir la imposición de solo lectura, aunque el destino ya estuviera blindado | Se rechazan las claves que la guarda fija, y el flag pasa a ser un **parámetro de arranque directo** en vez de ir dentro de `options`: PostgreSQL procesa `cmdline_options` **antes** que la lista por parámetro, así que el par directo gana |
| 17 | MAJOR | **Ninguna prueba observaba la imposición de solo lectura**: el mock descartaba las opciones y la única aserción leía el valor de vuelta de la tabla de políticas. Borrar la imposición dejaba la suite entera en verde | El mock captura las opciones; se afirma lo que recibe el driver. Además `db:audit:readonly` ahora **falla** si el ajuste no es `on`, en vez de imprimirlo y salir 0 |
| 18 | MINOR | `sslrootcert` estaba en la allow-list de claves que el driver consume, pero el driver **sí** la reenvía | Retirada. Una allow-list sólo vale lo que valga su exactitud |
| 19 | MINOR | En los errores de postgres-js `address` es un **array**, así que la detección por `typeof === 'string'` nunca acertaba y todo dependía de la lista de errnos | `hostOf()` acepta cadena o array; la detección de error de red es **estructural**, no por nombre de errno |
| 20 | MINOR | La rama de `AggregateError` era inalcanzable si había `cause` | Se recorren ambas |
| 21 | MINOR | La comprobación de coma abarcaba el userinfo, rechazando una contraseña con coma — un falso rechazo sobre una credencial legítima | La coma se comprueba sólo en la región de host, que es la que mira el driver |

**La cuarta ronda encontró 0 BLOCKER, 1 MAJOR (latente) y 4 MINOR:**

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 22 | MAJOR (latente) | El TLS que yo había fijado, `ssl: 'require'`, pone `rejectUnauthorized = false` en postgres-js: cifrado **sin autenticar el servidor**. Además *degradaba* configuraciones más fuertes (`verify-full`, o un objeto con CA propia). Y la línea de auditoría decía `tls=pinned`, que se lee como "verificado" | Se fija `verify-full`; un objeto `ssl` del llamador se respeta en vez de sustituirse; la línea dice `tls=verified` |
| 23 | MINOR | Tres de las cuatro correcciones de `redact-error` de la ronda 3 **no las observaba ninguna prueba**: ningún test pasaba un `address` array, ni un errno fuera de la lista, ni `errors[]` junto a `cause` | Añadidos los tres casos, con la forma literal que construye el driver |
| 24 | MINOR | Tratar cualquier `errno` como error de red hacía que un fichero de fixture ausente se reportara como fallo de conexión — un diagnóstico inventado | La detección exige un campo con host, o un errno de clase *connect* |
| 25 | MINOR | La lista de TLD del scrubber seguía siendo estrecha (`.xyz`, `.de`, IPv6 se escapaban) | Un `code` que no sea SQLSTATE (5 alfanuméricos) implica que no controlamos sus convenciones de mensaje: se retiene el mensaje en vez de adivinar |
| 26 | MINOR | **Fuga real de datos personales**: los errores de query de Drizzle llevan en su propio mensaje `Failed query: <sql>\nparams: <valores ligados>`. No tienen `address` ni `errno`, así que caían en la rama genérica y se imprimían enteros — y los parámetros ligados contienen correos y demás | Se desenvuelve al `cause`; el SQL y los parámetros se descartan por completo |

**La quinta ronda (verificación acotada) encontró 0 BLOCKER y 0 MAJOR.** Se
cerraron además sus MINOR/NIT:

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 27 | MINOR | `ssl` quedó como la **única** clave que un llamador podía **degradar**: `?? 'verify-full'` sólo protegía contra `undefined`, así que `ssl: false` (texto plano) o `'require'` pasaban — y la línea de auditoría seguía diciendo `tls=verified` | `ssl` sólo se puede **subir**: se acepta un objeto que mantenga la verificación, y se rechaza cualquier cadena o `false` |
| 28 | MINOR | La rama de desenvoltura del error de ORM imprimía el mensaje del `cause` aunque su `code` no fuera SQLSTATE — y un fallo de TLS o DNS llega envuelto, con el host dentro | `describeError` **recursa**, así que el `cause` queda sujeto exactamente a las mismas reglas |
| 29 | MINOR | Un envoltorio anidado imprimía el SQL interno | La desenvoltura itera con tope de profundidad |
| 30 | MINOR | El añadido `urlParams=[…]` no tenía prueba | Añadida, incluida la de que no aparece ningún valor |
| 31 | NIT | Los errores propios con código `DB_*` perdían su mensaje explicativo | Se dejan pasar, como los tipados de la guarda |
| 32 | NIT | El scrubber redactaba dos veces una URL (`***.***.co`) | La sustitución de URL va la última |
| 33 | NIT | Un **nombre** de parámetro puede ser a su vez un host | Sólo se imprime si tiene forma de identificador; si no, `(unnamed)` |

**La sexta ronda (reauditoría independiente posterior a la publicación de este
documento) encontró 0 BLOCKER, 0 MAJOR y clasificó 1 mutación superviviente
como cierre obligatorio.** El gate de la reauditoría exige que toda mutación
de seguridad superviviente se trate como MAJOR o BLOCKER, así que se cerró
antes de continuar, junto con dos huecos de cobertura relacionados
identificados en la misma pasada:

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 34 | MAJOR (mutación superviviente) | El orden del *merge* de `postgresOptions.connection` en `db/client.ts` (spread del llamador, luego `default_transaction_read_only = 'on'`) era correcto, pero **ninguna prueba fallaba si se invertía**: `GUARD_OWNED_CONNECTION_KEYS` ya rechaza que el llamador incluya esa clave, así que ningún test que pasara por `createDatabaseClient` podía alcanzar el *merge* con un valor en conflicto. Ningún caller actual usa `postgresOptions.connection`, pero la garantía exportada por la API dependía de una capa sin prueba propia | Extraída como `mergeGuardedConnectionOptions()`, exportada y probada **directamente**, sin pasar por la refusal anterior — así la prueba sí depende del orden del spread. Confirmado con 3 mutaciones independientes (spread invertido, asignación protegida eliminada, `Object.assign` en orden inseguro), las 3 detectadas |
| 35 | MINOR (hueco de cobertura) | La comparación de `GUARD_OWNED_CONNECTION_KEYS` era case-sensitive (`suppliedConnection[key] !== undefined`), pero los nombres de GUC de Postgres son case-insensitive: `DEFAULT_TRANSACTION_READ_ONLY` habría llegado al servidor como el mismo ajuste que la forma en minúsculas, sin que la guarda lo detectara | Las claves del llamador se normalizan a minúsculas sobre un `Set` derivado — nunca se muta el objeto original — antes de comparar. Probado con minúsculas, mayúsculas, mixed case, múltiples claves a la vez, una clave permitida (`application_name`) y un objeto vacío |
| 36 | MINOR (hueco de cobertura) | `sslrootcert` estaba correctamente excluido de `DRIVER_CONSUMED_QUERY_KEYS` desde la ronda 3 (hallazgo 18), pero ninguna prueba fijaba **por qué**: ni que se clasifica como parámetro reenviado, ni que el reenvío no tiene ningún camino hacia el objeto `ssl` que de verdad controla la verificación del certificado | Verificado empíricamente contra el `postgres@3.4.9` instalado (`src/index.js` `parseOptions`, `src/connection.js` `secure()`): `sslrootcert` se reenvía al paquete de arranque (no está en `defaults`) pero **nunca se lee** para construir las opciones de `tls.connect` — sólo el `ssl` de nivel superior llega ahí. Añadidas pruebas que fijan ambos hechos por separado, más una prueba de nivel `db/client.ts` que confirma que `sslrootcert` en `postgresOptions.connection` no cambia el `ssl` fijado |

Mutaciones adicionales probadas sobre el mismo cierre, las 8 detectadas:
invertir el spread; eliminar el valor protegido; `Object.assign` inseguro;
comparación case-sensitive; quitar sólo la normalización a minúsculas;
permitir explícitamente `DEFAULT_TRANSACTION_READ_ONLY`; reclasificar
`sslrootcert` como consumida por el driver; y dejar que `sslrootcert` degrade
`verify-full`. Cada mutación se aplicó, se confirmó que al menos una prueba
fallaba, y el archivo se restauró byte a byte (verificado por SHA-256) antes
de la siguiente.

7. **Una refusal que precede a un *merge* no prueba el *merge*.** Que
   `GUARD_OWNED_CONNECTION_KEYS` rechace una clave en conflicto no dice nada
   sobre si el orden del *merge* posterior sería correcto si esa refusal
   desapareciera. Las dos capas son garantías **independientes**; cada una
   necesita su propia prueba, alcanzable sin pasar por la otra.
8. **Case-sensitivity es una superficie de bypass silenciosa cuando el
   sistema protegido no la tiene.** Postgres no distingue mayúsculas en sus
   GUC; una guarda que sí las distingue dentro de ese dominio no está
   cerrada, sólo lo parece contra la entrada que alguien pensó en probar.

### Lecciones

1. **Una guarda que reimplementa el parseo de otro componente no es una
   guarda.** Donde no se pueda garantizar que ambos leen lo mismo, hay que
   rechazar la entrada, no adivinarla. Los hallazgos 1 y 9 son el mismo error
   cometido dos veces, la segunda al intentar arreglarlo.
2. **Una corrección de seguridad puede romper otra cosa en silencio.** El
   hallazgo 10 no era un agujero: era CI en rojo — y sólo se detectó porque la
   revisión comprobó el lado *positivo*. Una aserción que sólo mira el lado
   negativo pasa en verde cuando la funcionalidad desaparece.
3. **Enmascarar por patrón no puede ser exhaustivo.** Cuando el mensaje
   *se construye a partir* del dato sensible, se descarta el mensaje.
4. **Una prueba que verifica la configuración en vez del efecto no es una
   prueba.** La única aserción que decía cubrir la imposición de solo lectura
   leía el valor de vuelta de la tabla de políticas, y el mock descartaba las
   opciones: borrar la imposición entera dejaba la suite en verde.
5. **Un nombre que suena fuerte no es una garantía.** `ssl: 'require'` desactiva
   la verificación del certificado. La línea de auditoría debe decir lo que de
   verdad ocurrió, no lo que el nombre sugiere.
6. **El dato sensible no siempre es la credencial.** La fuga más concreta de
   toda la unidad fue el mensaje de error de un ORM, que incrusta el SQL y los
   **parámetros ligados** — datos personales — en texto plano.

## 10. Cobertura ejecutable

| Suite | Tests | Qué fija |
|---|---|---|
| `tests/database-target-safety.test.ts` | 139 | clasificación (local, remoto, privado, adversarial, inválido), redacción, matriz de capacidades, aislamiento, seguridad de mensajes, resolución de entorno, contraste de las constantes locales contra `supabase/config.toml`, y la clasificación de `sslrootcert` como parámetro reenviado (hallazgo 36) |
| `tests/database-entrypoint-safety.test.ts` | 122 | ausencia de efectos de import, guarda antes del driver, superficie de `package.json`, regresión de dotenv, procesos hijo reales que verifican que los scripts abortan **antes** de conectar, el orden del *merge* de `postgresOptions.connection` probado directamente vía `mergeGuardedConnectionOptions()` (hallazgo 34), la comparación case-insensitive de `GUARD_OWNED_CONNECTION_KEYS` (hallazgo 35), que `sslrootcert` no influye en el `ssl` fijado (hallazgo 36), y — desde el cierre 2026-08-02 — que el gate de integración resuelve `UELLIX_RUNTIME_DATABASE_URL` (nunca `DATABASE_URL`), rechaza rol/target/puerto incorrectos y colecta las 49 pruebas de integración |

Ambas se ejecutan en `pnpm test:unit` y en el workflow `p1a-validation`.

---

## 11. Cobertura del retrofit de identidad (2026-08-02)

Las dos suites de §10 responden *a qué base se conecta cada cosa*. Después del
cutover hay una segunda pregunta, con el mismo modo de fallo silencioso: *¿esa
consulta lleva identidad?* Como `uellix_app`, una consulta sin contexto no
lanza — devuelve **cero filas**.

| Suite | Tests | Qué fija |
|---|---|---|
| `tests/authenticated-database-context.test.ts` | 33 | de dónde sale la identidad: sesión válida, ausente, rechazada, sujeto malformado, Auth caído (503 ≠ logout), usuario Auth sin perfil, cuenta con `deleted_at`, organización propia vs. ajena, super-admin sólo desde servidor, anidamiento, limpieza tras COMMIT y tras ROLLBACK, reutilización del pool, **dos peticiones concurrentes con identidades distintas**, y los flujos de login/logout/dashboard/cross-org/Stella/append-only |
| `tests/database-runtime-entrypoints.test.ts` | 187 | cobertura estructural en dos capas: la capa regex reconstruye el grafo de imports de `app/**` y falla si un entry point alcanza `db/client.ts` sin abrir contexto; la capa AST (cierre 2026-08-02) extiende la cobertura a `components/**`, componentes JSX de servidor y las diez formas indirectas que sobrevivieron a la regex (alias, namespace, import dinámico, helper transitivo, reexport, wrapper decorativo/condicional, driver propio, `db` reasignado), con inventario versionado y 10 fixtures mutantes |
| `tests/database-insert-policy-scope.test.ts` | 19 | alcance de las policies INSERT append-only tras `stella_0005c`: roles de policy `{uellix_app}`, `authenticated`/`anon`/`service_role`/`PUBLIC` sin INSERT efectivo, actor ligado a `auth.uid()` sin rama NULL, sondas en vivo con ROLLBACK |

La segunda no es un grep. Casi ningún entry point consulta directo: llegan a la
base a través de dos o tres servicios, así que la comprobación resuelve
`@/`, relativos, re-exports y `import()` dinámico, e ignora `import type` y los
módulos `'use client'` — un componente de navegador no puede abrir una
transacción, y contar sus imports de tipo marcaría cada página que sólo nombra
el tipo de una fila.

Lleva dos **controles negativos**, porque una comprobación que siempre pasa no
prueba nada: `lib/projects/service.ts` debe salir como "alcanza la base **y no**
abre contexto" (corre dentro del de su llamador) y `lib/auth/roles.ts` como "no
alcanza la base". Un tercero comprueba que los ocho nombres de wrapper siguen
exportados: renombrar uno convertiría el archivo entero en un no-op.

La allowlist de **13** entry points no es una supresión: cada entrada lleva su
motivo, y la suite falla si el archivo desaparece, deja de ser entry point o
deja de alcanzar la base (una fila que nunca se consulta es decoración). La
misma allowlist gobierna la capa AST.

Ambas se ejecutan en `pnpm test:unit`. Las partes que necesitan base viva se
saltan solas cuando el stack local no está levantado, igual que las suites de
catálogo.
