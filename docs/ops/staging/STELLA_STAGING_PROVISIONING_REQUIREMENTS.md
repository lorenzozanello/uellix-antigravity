# STELLA — Requisitos de aprovisionamiento de staging

> Lista ejecutable para **Lorenzo**. Ningún agente puede hacer nada de esto:
> exige crear un proyecto, leer un dashboard y manejar secretos.
>
> Cierra el bloqueador **B2** ([staging no aislado](STELLA_STAGING_RISK_REGISTER.md))
> cuando se complete. Hasta entonces, B2 sigue abierto.
>
> ---
>
> **ACTUALIZADO POR TRAIN 5C0 (2026-08-07).** La secuencia de §2, §3 y §7 era
> **circular** y se corrige aquí. Además, lo que §2 A1 llamaba «migraciones base
> `0000…0039`» **no era una secuencia ejecutable**: falta la mitad. Los dos
> cambios se resumen en §0 y se desarrollan en §2 y §7.
>
> **CHECKPOINT A0 (pre-bootstrap, read-only) = PASS**, ejecutado manualmente por
> el operador contra el nuevo proyecto Supabase Uellix Staging. Confirmado:
> sesión READ ONLY · versión PostgreSQL compatible · proyecto nuevo · `auth`
> presente · `auth.uid()` presente · `public` presente · `uellix_bootstrap`
> **ausente** · `uellix_stella` **ausente** · `public.stella_interactions`
> **ausente** · `staging_sentinel` **ausente** · **cero escrituras**.
> Ningún valor secreto se registra en este documento.

---

## 0. Las dos correcciones de Train 5C0

### 0.1 El centinela era precondición del paquete que crea su tabla

`§2 A5` exigía la fila de centinela «antes de aplicar nada». `§3` explica que
`stella_hosted_0001` **crea esa tabla**. Las dos frases no pueden ser ciertas a
la vez, y no era sólo un problema de redacción: `db/hosted/hosted-migrator.ts`
verificaba la identidad del objetivo **antes que nada**, y
`verifyStagingTarget()` exigía las tres señales incluida la fila. Una primera
provisión era por tanto **imposible de planificar**: devolvía
`HOSTED_TARGET_SENTINEL_MISSING` siempre.

La corrección está en `db/hosted/target-identity.ts` (`SentinelPolicy`) y en
`db/hosted/hosted-provisioning-runner.ts`. El centinela pasa de ser una
precondición a ser una **frontera**: separa la fase que lo crea de la fase que
lo exige. El detalle de por qué dos señales bastan **sólo** antes del bootstrap,
y qué las paga, está en §2.4.

### 0.2 `0000…0039` no es una secuencia ejecutable

`0039_grant_rls_helper_execution.sql` hace `GRANT EXECUTE` sobre
`public.can_read_evidence_object(text, uuid)` y
`public.can_write_evidence_object(text, uuid)`. Esas dos funciones se crean
**únicamente** en `supabase/migrations/20260716000001_storage_policies.sql`,
que no estaba ni en A1 ni en A2. Aplicar «0000…0039» a secas **aborta en la
última unidad** con `42883 undefined_function`.

Localmente nunca se notó porque nunca corre sola: `supabase/config.toml` declara
`[db.migrations] enabled = true`, así que `supabase start` aplica las dos
unidades de `supabase/migrations/` **antes** de que corra un solo archivo de
Drizzle. El pipeline local ocultaba el defecto.

Reproducido de forma ejecutable: `scripts/baseline-rehearsal-local.ts` corre el
orden ingenuo contra una base desechable y **debe fallar** en 0039; luego corre
el orden del manifiesto y aplica las 50 unidades limpias.

El baseline real son **50 unidades**, fijadas por hash y orden en
`db/hosted/baseline-manifest.ts`. Ver §2.2.

---

## 1. El proyecto

| # | Requisito | Por qué, y qué falla si no |
|---|---|---|
| P1 | **Proyecto Supabase nuevo y dedicado**, jamás una rama ni un esquema del de producción | El aislamiento debe ser de proyecto: credenciales, base y URL distintas |
| P2 | **PostgreSQL 17 o superior** | El paquete local `stella_0004` exige 17+ por el manejo de `MAINTAIN`. El bootstrap hosted no lo exige, pero el gate `hosted_capability_report()` lo reporta y el resto de la cadena asume el mismo servidor. Elegir 15 obliga a re-auditar |
| P3 | **Organización o cuenta separada de producción**, si el plan lo permite | Segunda señal de aislamiento independiente del nombre |
| P4 | **Cero datos de producción.** Ni restauración, ni copia, ni «sólo el esquema con unas filas» | Un staging con datos reales es producción con otro nombre |
| P5 | Anotar el **project ref** (20 letras minúsculas) | Lo necesitan el centinela, la declaración del operador y el veto de producción |

## 2. La secuencia — corregida

La numeración `A1…A5` queda **retirada**: mezclaba en una sola lista cosas que
ocurren en cuatro momentos distintos, y ese aplanamiento es lo que permitió que
el centinela apareciera antes que el paquete que lo hace posible.

### 2.1 PRE-BOOTSTRAP

| # | Requisito | Estado |
|---|---|---|
| **P0** | **CHECKPOINT A0** read-only con resultado PASS | **HECHO** — ver cabecera |
| **P1** | Proyecto Supabase nuevo, dedicado y aislado (§1 P1/P3) | del operador |
| **P2** | PostgreSQL 17+ (§1 P2) | del operador |
| **P3** | Cero datos productivos: ni restauración, ni copia, ni «el esquema con unas filas» | del operador |
| **P4** | Identidad **no secreta** registrada: el project ref de 20 letras (§1 P5) | del operador |
| **P5** | Denylist de producción rellenada — `KNOWN_PRODUCTION_IDENTIFIERS.projectRefs` en `db/hosted/target-identity.ts`, con el ref de **producción**, no el de staging (§6) | **HECHO** — 2026-08-07, ver §2.8 |
| **P6** | Los **nueve** flags `STELLA_*` en `false` en TODO entorno que apunte a esta base | del operador |

`P6` lo comprueba también el runner: `planProvisioningPhase()` refuta con
`PROVISIONING_FEATURE_FLAG_ENABLED` antes de mirar el objetivo, y trata
cualquier valor no reconocible como **encendido** — una errata que se leyera
como «apagado» es una errata que no encuentra nadie.

> **A3 del texto anterior** (backup restaurable por un humano) no desaparece: se
> reclasifica. Un proyecto vacío no tiene nada que restaurar, y para el baseline
> la estrategia de recuperación no es el backup sino
> `DESTROY_AND_REPROVISION` (§7.4). El backup vuelve a ser obligatorio antes del
> primer dato de piloto, no antes del primer DDL.

### 2.2 BASELINE

| # | Requisito |
|---|---|
| **B0** | Las **tres sondas de clase C**, read-only, ANTES de aplicar nada (§2.7) |
| **B1** | Migraciones `0000`…`0039` **más** las dos de `supabase/migrations/`, en el orden del manifiesto — no en el orden de los números |
| **B2** | `db/policies/001`…`008` |
| **B3** | Verificación del baseline: **CHECKPOINT B0**, read-only, 15 postcondiciones |

Fuente de verdad única: **`db/hosted/baseline-manifest.ts`**, 50 unidades con
hash SHA-256, orden, dependencias y clasificación. Verificable sin conectarse a
nada:

```bash
pnpm baseline:verify
```

El orden intercala las dos unidades de Supabase **entre 0038 y 0039**, y ninguno
de los dos extremos es arbitrario:

- **después de 0033**, porque 0033 hace `REVOKE EXECUTE ON ALL FUNCTIONS IN
  SCHEMA public FROM PUBLIC, anon, authenticated`. Un helper creado antes de esa
  barrida pierde el grant que su propio archivo emite;
- **antes de 0039**, porque 0039 hace `GRANT EXECUTE` sobre esas funciones. Ésta
  es la restricción dura: violarla aborta la cadena con `42883`.

Lo que el inventario de Train 5C0 midió sobre las 50 unidades:

| Pregunta | Respuesta medida |
|---|---|
| ¿Dependencia de superusuario? | **cero** en las 50 |
| `CREATE`/`ALTER`/`DROP ROLE` | **cero** |
| `OWNER TO` | **cero** |
| `CREATE EXTENSION` | **cero** |
| `service_role` como *grantee* | **una** unidad: `0033_public_api_grants.sql` (§2.5) |
| DML | **una** unidad: `0018_redundant_firebird.sql`, 4 sentencias, **cero** con lista `VALUES` |
| Filas que escribe sobre una base vacía | **cero** — todo el DML deriva sus filas por `SELECT` |
| Unidades que se niegan a re-aplicarse | **una**: `db/policies/008_marketing_leads_rls.sql` |
| Clase D («no debe correr en staging nuevo») | **ninguna** |

> **A2 es casi por completo una re-aplicación.**
> `db/policies/001_initial_auth_rls.sql` es **byte-idéntico** a
> `db/migrations/0031_rls_core.sql` (mismo SHA-256 `e525b1ee…c054ef`), y
> `002…007` son un subconjunto sentencia-a-sentencia de `0032_rls_specialized.sql`.
> Es inofensivo porque las 103 `CREATE POLICY` de `001…007` llevan todas su
> `DROP POLICY IF EXISTS` delante — comprobado, no supuesto.
> **`008` es la excepción por partida doble**: es el único archivo con contenido
> que la cadena de migraciones nunca aplica, y el único cuyas tres
> `CREATE POLICY` no llevan guarda. Re-aplicarlo levanta `42710`.

**SQL que el baseline deja fuera a propósito**, con su evidencia, en
`BASELINE_DELIBERATE_EXCLUSIONS`. En particular `db/manual-migrations/**`, cuyo
contenido ya está plegado en la cadena (`001`→`0029`, `002`→`0030`,
`003`→`0016`), y `db/baseline/**`, que **no es el baseline** pese al nombre: es
un `pg_dump` de una base Supabase que el arnés E2E de Train 4 restaura. La
colisión de nombres es el peligro.

### 2.3 BOOTSTRAP DE STELLA

| # | Requisito |
|---|---|
| **S1** | Aplicar `stella_hosted_0001_managed_role_bootstrap`, **y sólo eso** |
| **S2** | El operador inserta la fila de `staging_sentinel` a mano (§3) |
| **S3** | Verificar el centinela |
| **S4** | **CHECKPOINT A1** post-bootstrap, read-only, con resultado PASS |

### 2.4 Por qué dos señales bastan antes del bootstrap, y qué las paga

El centinela responde a una pregunta: *¿es ésta la base que alguien
deliberadamente aprovisionó como staging, o una cuya cadena de conexión se pegó
desde la pestaña equivocada?* Antes del bootstrap hay otra respuesta a la misma
pregunta que producción **no puede dar**: la base está **vacía**.

| Fase | Señales de identidad | Control compensatorio | Refutación si falta |
|---|---|---|---|
| `PHASE_BASELINE` | 2 | **virginidad**: cero unidades del baseline aplicadas, sin esquema `uellix_bootstrap`, sin centinela | `PROVISIONING_TARGET_NOT_VIRGIN` |
| `PHASE_STELLA_BOOTSTRAP` | 2 | **vacuidad**: las 9 tablas de `REQUIRED_EMPTINESS_PROBES` presentes y **todas** con cero filas | `PROVISIONING_TARGET_NOT_EMPTY` |
| `PHASE_STELLA_CHAIN` | **3** | ninguno — ya no hace falta | `PROVISIONING_SENTINEL_REQUIRED` |

Tres cosas que la exención **no** concede, y que hay tests para cada una:

1. sólo excusa la **ausencia**. Un centinela que existe y contradice se refuta
   igual en toda fase;
2. el **veto de producción** sigue primero e incondicional;
3. una sonda de vacuidad que falte es `PROVISIONING_EMPTINESS_PROBE_MISSING`,
   no un aprobado. Una tabla no sondeada es *desconocida*, no *vacía*.

### 2.5 `service_role` en el baseline — registrado, no avalado

`0033_public_api_grants.sql` hace `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA
public TO service_role`. Es del baseline de producción y este train no lo toca.
Lo que sí hace es no esconderlo:

- §4.4 ya prohíbe **aprovisionar** `SUPABASE_SERVICE_ROLE_KEY`. Un privilegio
  como el que nadie puede autenticarse es un privilegio que nadie tiene;
- `stella_0017` revoca después la escritura del ledger a todo principal de
  runtime, incluido éste;
- la postcondición **B0-09** afirma que existen los tres roles de Supabase, y
  **B0-10** que `anon` no tiene privilegio de tabla alguno en `public`.

### 2.7 Las tres sondas que hay que correr antes de tocar nada

Dos unidades de las 50 actúan sobre objetos que **la plataforma posee**, y una
tercera pregunta depende de un objeto que ninguna unidad crea. Las tres son de
sólo lectura, cuestan una consulta cada una, y el runner refuta
`PHASE_BASELINE` sin ellas (`PROVISIONING_PRIVILEGE_PROBE_MISSING`) o con
cualquiera en `false` (`PROVISIONING_PRIVILEGE_UNAVAILABLE`).

| Sonda | Unidad que la necesita | Consulta |
|---|---|---|
| `canCreateTriggerOnAuthUsers` | 40 — `20260716000000_auth_trigger.sql` | `SELECT has_table_privilege(current_user, 'auth.users', 'TRIGGER');` |
| `ownsStorageObjects` | 41 — `20260716000001_storage_policies.sql` | `SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = 'storage.objects'::regclass;` |
| `evidenceBucketExists` | 41 — sus tres policies filtran por ese bucket | `SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uellix-evidence');` |

Las dos primeras son propiedad de `supabase_auth_admin` y
`supabase_storage_admin`. `CREATE POLICY` exige **ownership** de la tabla, que es
más estricto que el privilegio `TRIGGER` de la unidad 40 — por eso ambas son
clase **C** y ninguna es B.

La tercera **no es un privilegio y está aquí igual**: `supabase/config.toml`
declara `[storage.buckets.uellix-evidence]`, así que el stack local lo crea al
arrancar y **nada** lo crea en hosted. Un staging aprovisionado exactamente según
el plan tendría policies de evidencia protegiendo un bucket inexistente. Es la
misma asimetría local/hosted que ocultó el defecto de 0039, en un segundo sitio.

> Si el bucket es lo que falta, créalo en el dashboard y vuelve a sondear. Si lo
> que falta es un privilegio, la unidad necesita una adaptación **antes** de que
> se aplique ninguna de las 50 — descubrirlo en la unidad 40 cuesta 39 unidades
> comprometidas y una reprovisión.

### 2.8 P5 — CERRADO. Las dos identidades

Confirmadas manualmente por el operador desde el dashboard de Supabase,
2026-08-07. **Ningún project ref es secreto**: es público en toda URL que el
proyecto sirve, y `redactForHostedLog` lo conserva a propósito porque es lo más
útil que un operador puede ver al diagnosticar un objetivo equivocado.

| Rol | Project ref | Dónde vive |
|---|---|---|
| **PRODUCCIÓN** | `ctaxtgujyyprgynmnvtq` | `KNOWN_PRODUCTION_IDENTIFIERS.projectRefs` — **vetado antes que cualquier otra comprobación** |
| **STAGING** | `bvyzblhqymxruxdguaee` | `KNOWN_STAGING_PROJECT_REF` — **jamás en la denylist**; un test lo afirma |

**La contradicción documental que bloqueó P5, resuelta.** El repositorio
etiquetaba `ctaxtgujyyprgynmnvtq` de dos formas incompatibles: producción en
`docs/AUDIT_2026-07-06.md`, staging en
`docs/audits/2026-07-15-uellix-p1a-integration-rls.md`. El dashboard dirimió: es
**producción**, y el audit de julio estaba equivocado. Se le añadió una
corrección en cabecera, dejando el texto original intacto debajo — borrarlo
eliminaría la evidencia de que la etiqueta estuvo mal tres semanas, que es lo que
el próximo lector necesita saber. Ver [RR-24](STELLA_STAGING_RISK_REGISTER.md).

**Lo que la corrección cambia sobre un incidente pasado.** El `pnpm db:migrate`
accidental del 15 de julio no se conectó a un staging: se conectó a
**producción**. La verificación read-only de entonces sigue siendo válida y su
conclusión también —no hubo modificación—; lo que cambia es la gravedad de lo que
estuvo a punto de pasar, y es un argumento adicional para que el veto de refs no
vuelva a estar vacío.

**Por qué llenar la lista importa mecánicamente.** El veto de *hosts* atrapa una
conexión dirigida a un **dominio** de producción. No atrapa nada dirigido a la
**base** de producción, porque un host de base Supabase es
`db.<ref>.supabase.co` y el ref es la única parte que identifica el proyecto.
Hasta 2026-08-07 el veto que importaba no existía.

> **Y el gate lo exige de verdad.** `productionDenylistStatus()` reporta
> `loaded: false` ante una lista vacía o malformada, y **ambos planificadores**
> —`planProvisioningPhase` y `planHostedApply`— refutan `mode: 'apply'` en ese
> caso (`PROVISIONING_PRODUCTION_DENYLIST_EMPTY` /
> `HOSTED_PRODUCTION_DENYLIST_EMPTY`). Un dry-run no se ve afectado: una lista
> vacía retira un veto, no un gate. La revisión adversarial encontró que antes de
> esto el gate era **consultivo** —nada lo invocaba— y ambos planificadores
> emitían `writesPermitted: true` con el veto sin cargar. Ver
> [RR-26](STELLA_STAGING_RISK_REGISTER.md).

### 2.9 Tercera asimetría local/hosted: no hay registro de lo aplicado

Las dos primeras fueron `supabase/migrations` aplicadas implícitamente por
`config.toml` y el bucket `uellix-evidence`. La tercera: el plan hosted usa
`psql -1 -f` por unidad y **no escribe ningún journal**, mientras que
`pnpm db:migrate:local` usa el migrador de drizzle y sí crea
`drizzle.__drizzle_migrations`.

`TargetStateProbe.baselineUnitsInstalled` dice «lo que registra el ledger del
operador» — y ese ledger no lo crea nadie. Ver
[RR-25](STELLA_STAGING_RISK_REGISTER.md). No bloquea el apply: **CHECKPOINT B0
mide el estado resultante**, que es más fuerte que un journal, porque un journal
dice qué se intentó y B0 dice qué hay.

### 2.6 CADENA STELLA

| # | Paquete |
|---|---|
| **T1** | `grounding_0002_document_versions` |
| **T2** | `grounding_0003_evidence_chunks` |
| **T3** | `grounding_0004_runtime_attestation` |
| **T4** | `stella_0013_grounded_query_quota` |
| **T5** | `stella_0014_operation_tickets` |
| **T6** | `stella_0015_project_bound_operation_tickets` |
| **T7** | `stella_0016_reserved_quota_semantics` |
| **T8** | `stella_0017_governed_stella_consumption` |
| **T9** | `stella_0018_category_bound_operation_tickets` |

## 3. El centinela — el paso que sólo un humano puede dar

`stella_hosted_0001` crea la tabla y **deja la fila vacía a propósito**: un
bootstrap que acuñara su propio centinela se estaría certificando a sí mismo.

Después de aplicar el bootstrap, con el project ref leído del dashboard:

```sql
INSERT INTO uellix_bootstrap.staging_sentinel
  (environment, project_ref, bootstrap_version, owner_separation)
VALUES
  ('staging', '<project-ref-de-20-letras>', 'stella_hosted_0001',
   'auditable-obstacle: RR-02 applies, postgres retains ADMIN OPTION over uellix_owner');
```

No contiene ningún secreto: un project ref de Supabase es público en toda URL que
el proyecto sirve. Los tres CHECK de la tabla rechazan `environment <> 'staging'`,
un ref malformado y una segunda fila.

## 4. Variables de entorno

### 4.1 Las cuatro que `.env.example` NO declara y el runtime SÍ exige

Hallazgo **B4** del Train 5A, todavía abierto: `.env.example` declara
`DATABASE_URL`, que `db/safety/resolve-capability-database-url.ts:107-121`
**ignora con aviso**, y omite las que gobiernan de verdad desde el cutover de
identidad de 2026-08-02.

| Variable | Rol que debe declarar | Obligatoria |
|---|---|---|
| `UELLIX_RUNTIME_DATABASE_URL` | `uellix_app` | **sí** |
| `UELLIX_MIGRATOR_DATABASE_URL` | `uellix_migrator` | sólo para migrar con tooling |
| `UELLIX_AUDITOR_DATABASE_URL` | `uellix_auditor` | opcional |
| `UELLIX_APP_ENV` | — | **sí**, valor `staging`. Un valor no reconocido resuelve a **`production`** |

> Sincronizar `.env.example` es INTEGRATION-OWNED (`STELLA_PARALLEL_WORKSTREAMS.md` §7).
> Este train no lo tocó: la instrucción prohíbe modificar `.env*`.

### 4.2 Las que deben ser DISTINTAS de producción

| Variable | Riesgo si se comparte |
|---|---|
| `RESEND_API_KEY` | **correo real a destinatarios reales** desde staging |
| `STRIPE_SECRET_KEY` | una clave `live` **cobra de verdad**. Usar modo test |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | límites compartidos entre entornos |
| `NEXT_PUBLIC_SENTRY_DSN` | eventos de staging contaminando producción |

### 4.3 `NEXT_PUBLIC_SITE_URL` — obligatoria, y el motivo no es cosmético

**M10** del registro de riesgos. `lib/site.ts:16-27` cae en cadena a
`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` y por último al literal
`https://uellix-antigravity.vercel.app`. `siteUrl` alimenta `metadataBase`,
canonicals, OpenGraph, el JSON-LD de Organization, `robots.txt` y `sitemap.xml`.

Un staging sin esta variable **publicaría un sitemap y canonicals apuntando a
producción**. Declararla, y además servir `noindex`.

### 4.4 Prohibidas

| Variable | Motivo |
|---|---|
| `NEXT_PUBLIC_GEMINI_API_KEY` | cualquier valor se inlinea en el bundle del navegador |
| `SUPABASE_SERVICE_ROLE_KEY` | ninguna ruta de producto la necesita; `stella_0017` revoca el ledger a `service_role`. **No aprovisionar** |

## 5. Proveedor — bloqueado hasta la rotación

**B3** sigue abierto. Antes de cualquier llamada real (CHECKPOINT E / gate G1):

1. crear una clave Gemini **nueva y dedicada a staging**, con cuota propia;
2. guardarla en el gestor de secretos del entorno de staging, nunca en el repo;
3. no escribirla en ninguna terminal (usar el UI del gestor, no `export`);
4. **probar que la clave anterior ya no es válida** y archivar la evidencia;
5. dejar `STELLA_ENABLED=false` de todos modos: la clave no enciende nada.

## 6. Llenar el veto de producción

`db/hosted/target-identity.ts` → `KNOWN_PRODUCTION_IDENTIFIERS.projectRefs` está
**vacío** y un test lo fija así deliberadamente, para que llenarlo sea un acto
consciente con un test detrás.

Al aprovisionar, añadir el project ref del proyecto Supabase de **producción**
(no el de staging) y actualizar ese test. Una lista vacía retira un veto; no
retira ninguna de las tres señales positivas, que siguen siendo obligatorias.

## 7. Orden de aplicación

### 7.1 Las tres fases

```
PHASE_BASELINE          50 unidades, en el orden de db/hosted/baseline-manifest.ts
                        (pnpm baseline:order las lista)
   ↓
CHECKPOINT B0           read-only, 13 postcondiciones
   ↓
PHASE_STELLA_BOOTSTRAP  SET uellix.bootstrap_environment = 'staging'
                        1 paquete: stella_hosted_0001, y sólo ése
   ↓
── FRONTERA HUMANA ──   el INSERT de §3. Ninguna automatización la cruza
   ↓
CHECKPOINT A1           read-only
   ↓
PHASE_STELLA_CHAIN      los nueve artefactos de db/prepared/hosted/
```

Un archivo por invocación, `psql -1 -v ON_ERROR_STOP=1` **siempre**. Se midió que
ninguna de las 50 unidades contiene una sentencia que PostgreSQL rechace dentro
de una transacción — ni `CREATE INDEX CONCURRENTLY`, ni `VACUUM`, ni
`ALTER TYPE … ADD VALUE` — así que `-1` da atomicidad **por unidad**. La
**secuencia** no es atómica; de ahí §7.4.

### 7.2 Lo que el runner refuta

`db/hosted/hosted-provisioning-runner.ts`, todo antes de proponer un solo paso:

| Intento | Código |
|---|---|
| Stella sin el baseline completo | `PROVISIONING_BASELINE_INCOMPLETE` |
| Cadena sin centinela | `PROVISIONING_SENTINEL_REQUIRED` |
| Cadena sin bootstrap | `PROVISIONING_BOOTSTRAP_MISSING` |
| Escribir el centinela como paso automático | `PROVISIONING_SENTINEL_IS_NOT_A_MIGRATION` |
| Baseline sobre una base que no está virgen | `PROVISIONING_TARGET_NOT_VIRGIN` |
| Bootstrap sobre una base con filas | `PROVISIONING_TARGET_NOT_EMPTY` |
| Sonda de vacuidad ausente | `PROVISIONING_EMPTINESS_PROBE_MISSING` |
| Hash, orden, archivo omitido, archivo duplicado, huérfano | `PROVISIONING_BASELINE_MANIFEST_INVALID` |
| Objetivo que no se declara staging | `HOSTED_TARGET_ENVIRONMENT_NOT_STAGING` |
| Objetivo de producción | `HOSTED_TARGET_IS_PRODUCTION` |
| Cualquier flag `STELLA_*` no-falso | `PROVISIONING_FEATURE_FLAG_ENABLED` |
| Un apply que abarque bootstrap **y** cadena | `HOSTED_SENTINEL_BOUNDARY_CROSSED` |
| Aplicar la cadena sin observación PRE_WRITE | `CHAIN_OBSERVATION_REQUIRED` |
| Observación de un intento ya consumido o superado | `CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN` |
| Documento editado tras ensamblarse | `CHAIN_OBSERVATION_DIGEST_INVALID` |
| Paquete medido `INSTALLED` | `CHAIN_TARGET_ALREADY_INSTALLED` |
| Paquete medido `PARTIAL_OR_INCONSISTENT` | `CHAIN_OBSERVATION_PARTIAL_STATE` |
| Apply directo por `planHostedApply` sin autorización | `HOSTED_CHAIN_WRITE_UNAUTHORIZED` |

Los trece están cubiertos por la matriz de ataques de
`tests/hosted/hosted-provisioning-runner.test.ts`.

### 7.3 La regla «las diez o ninguna», enmendada

Train 5B exigía que una primera provisión aplicase los diez paquetes o ninguno.
Esa regla y la frontera humana del centinela **no pueden cumplirse a la vez** en
una sola invocación. La preocupación sigue siendo válida — un staging cuyos
flags nombran tablas inexistentes está inacabado, no minimizado — así que la
obligación no se retira: **se traslada** a la secuencia por fases. El runner no
reporta `sequenceComplete` hasta que la cadena alcanza `stella_0018`.

### 7.4 Si algo falla — decidido de antemano

`db/hosted/baseline-recovery.ts`. Los tres hechos medidos que sostienen la
decisión:

1. cada unidad es atómica bajo `psql -1`; la secuencia no lo es;
2. el baseline tiene **cero** scripts de rollback, frente a 26 de la cadena
   preparada;
3. **28 de las 40** unidades Drizzle contienen alguna sentencia sin forma
   `IF NOT EXISTS` — y `ADD CONSTRAINT` no tiene ninguna en PostgreSQL.

| Situación | Estrategia |
|---|---|
| Fallo de transporte (no llegó SQL al servidor) | `RETRY_UNIT`, tras re-sondear |
| Fallo en la **unidad 1** del baseline | `RETRY_UNIT` — la base sigue virgen |
| Fallo en **cualquier unidad posterior** | **`DESTROY_AND_REPROVISION`** |
| Resultado indeterminado | **`DESTROY_AND_REPROVISION`** |
| Unidad aplicada **sin** `psql -1` | `HALT_AND_ESCALATE` |
| Fallo del bootstrap | `DESTROY_AND_REPROVISION` |
| Fallo en la cadena Stella | **Primero §7.5**: observación fresca. Sólo si mide `INSTALLED` y se decide revertir, `ROLLBACK_SQL` — esos paquetes sí tienen rollback y se niegan en vez de degradar. Si mide `ABSENT`, no hay nada que revertir |
| El proyecto guarda algo irreemplazable | `HALT_AND_ESCALATE` |

### 7.5 La cadena Stella — un write por medición

La tabla de §7.4 decide por **unidad del baseline**. La cadena tiene además una
regla propia, y es la que gobierna cualquier resultado ambiguo:

> **Ningún reintento se decide por el exit code.** Tras un timeout, una conexión
> perdida, un ACK ambiguo, una caída del proceso o un fallo al escribir la
> evidencia, el operador **DEBE** abrir un intento nuevo y obtener una
> observación read-only fresca **antes** de decidir nada. Reutilizar el `psql`
> anterior es el camino por el que un paquete ya comprometido se aplica dos veces.

Fresca dice `ABSENT` → el paquete puede reintentarse (su transacción revirtió).
Fresca dice `INSTALLED` → **no se reaplica**; se reconstruye la evidencia POST y
se avanza. Fresca dice `PARTIAL_OR_INCONSISTENT` → ni reintento ni paquete
siguiente; recuperación humana.

El flujo autorizado es `pnpm chain:attempt:open` → sonda → `pnpm
chain:attempt:plan`, que autoriza **exactamente un paquete**. El contrato
completo, con el ciclo de vida del intento y los casos F12-F15, está en
`STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md` — documento normativo para todo esto.

`DESTROY_AND_REPROVISION` es el **valor por defecto**, no el último recurso, y la
inversión es deliberada. El instinto de tratar la destrucción como escalada está
calibrado para bases que contienen algo. Ésta no contiene nada: es un proyecto
nuevo, con cero filas, cuyo contenido íntegro es reproducible desde 50 archivos
de este repositorio. Recrearlo cuesta un *project-create*. Una reparación manual
equivocada cuesta un staging que **difiere** del manifiesto en silencio, y todas
las verificaciones posteriores pasan a medir contra un baseline que no es el
descrito.

Se destruye el **proyecto**, no los esquemas: un esquema recreado conserva roles,
extensiones, grants y privilegios por defecto que un proyecto nuevo no tendría, y
son exactamente las cosas que el baseline supone estar encontrando por primera
vez.

## 8. Qué NO hace este documento

No autoriza aplicar nada. Aplicar exige, además de todo lo anterior, la
inspección hosted de sólo lectura (CHECKPOINT A / gate G12) con resultado PASS y
la aprobación explícita de Lorenzo.
