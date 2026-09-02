# STELLA — cierre del POST-INSTALL VALIDATION GATE de staging

**2026-08-11.** Proyecto `bvyzblhqymxruxdguaee`. HEAD de partida
`55fba11d2ca80019c487645c792ba0934abe7d32`.

> Este gate **no** habilita Stella. Valida que la infraestructura desplegada es la
> gobernada, que está completa, y que nada quedó a medias. Las nueve feature flags
> siguen en `false` y este documento no autoriza tocarlas.

Durante el gate **no se hizo ninguna escritura remota**: cero `chain:attempt:plan`,
cero intentos nuevos, cero SQL contra el objetivo, cero llamadas a Gemini, cero
bytes de SQL gobernado o pins modificados.

---

## 1. Veredicto

| | |
|---|---|
| `POST_INSTALL_VALIDATION_GATE` | **FULL_PASS** |
| `F_PI_01` | **CLOSED** — medido contra staging, §5.3 |
| `PENDING_EVIDENCE` | **0** |
| Hallazgos materiales | **0** |
| Hallazgos de endurecimiento | **3**, todos corregidos |
| `SAFE_TO_ENABLE_STELLA_FEATURES` | `false` |
| `SAFE_TO_TOUCH_PRODUCTION` | `false` |

El gate llega a `FULL_PASS` en tres commits: `86a8d17` cerró la instalación con la
evidencia de postura remota pendiente y clasificada; `05f47f9` construyó la ruta de
operador que la haría medible; este cierra el bloque con la medición tomada.

**`FULL_PASS` sigue sin habilitar nada.** Valida que la infraestructura desplegada es
la gobernada, que está completa, que nada quedó a medias y —ahora sí— que su postura
remota es la que el plan de autoridad exige. Las nueve feature flags siguen en
`false` y este documento no autoriza tocarlas.

---

## 2. El expediente congelado

La observación final es `att_1398309c556fb6cc9f997ebfc5dc0de6`, promovida verbatim a

```
docs/ops/staging/evidence/2026-08-11-att_1398309c-chain-final-observation.json
```

y **no se editó un solo byte**: el campo `digest` cubre `corroboration` entera, así
que redactar cualquier cosa la invalidaría, y una evidencia cuyo digest no cuadra no
es evidencia.

Se promovieron también los dos documentos de identidad del instalador ligados a
`att_0ca699d6…` (T9), que son la prueba de que el segundo incidente quedó cerrado:

```
2026-08-11-att_0ca699d6-installer-identity.json
2026-08-11-att_0ca699d6-installer-identity-recheck.json
```

### El estado NO se leyó del documento

Ese es el punto entero. `db/hosted/fresh-observation.ts` **deriva** el estado de
cada paquete a partir de los testigos crudos del catálogo
(`classifyAllPackages`), y nunca lo lee del JSON — un `"state": "INSTALLED"`
escrito a mano no tiene por dónde entrar. El gate llamó a los mismos evaluadores
que llama la ruta de escritura:

| evaluador | qué demostró |
|---|---|
| `parseChainAttemptLedger` + `attemptStatus` | `att_1398309c…` es el último `OPENED` y está **OPEN**: nunca se consumió |
| `parseFreshChainObservation` | digest válido, esquema, fase `PRE_WRITE`, eco del intento por el servidor |
| `observationDigest` (recomputado aparte) | `f33075a074749eb54d899a95438d9bf6a2d1e591d9fdedc42b5cc9f8d7d71eb1` |
| `verifyStagingTarget` | tres señales positivas + veto de producción |
| `classifyAllPackages` | 35 mediciones de testigo → 9 estados |
| `nextChainPackage` | `CHAIN_SEQUENCE_COMPLETE` |
| `authorizeChainWrite` | refusal en las diez formas en que un operador puede pedirlo |

### Escaneo de secretos

38 archivos de evidencia (`artifacts/**` + `docs/ops/staging/evidence/**`) contra
seis clases: DSN/cadena de conexión, `PGPASSWORD`, `password=`, JWT,
API keys (`sb*_`, `sk-`, `AIza`), bloques de clave privada, y literales
`service_role`/`anon key`.

**`EVIDENCE_SECRET_FINDINGS = 0`.**

Una sola aparición del ref de Production (`ctaxtgujyyprgynmnvtq`) en todo el corpus,
en `artifacts/hosted-chain-pre-write-probe.sql` (ignorado por git, generado por
intento) y dentro de la rama

```sql
IF v_ref IN ('ctaxtgujyyprgynmnvtq') THEN
  RAISE EXCEPTION 'A1 REFUSED: % is a PRODUCTION project ref…';
```

Es el **veto**, no un objetivo. Un denylist que no nombra lo que deniega no deniega
nada. El gate distingue las dos lecturas y exige que el veto esté presente.

---

## 3. Integridad de la cadena

```
T1  INSTALLED  grounding_0002_document_versions
T2  INSTALLED  grounding_0003_evidence_chunks
T3  INSTALLED  grounding_0004_runtime_attestation
T4  INSTALLED  stella_0013_grounded_query_quota
T5  INSTALLED  stella_0014_operation_tickets
T6  INSTALLED  stella_0015_project_bound_operation_tickets
T7  INSTALLED  stella_0016_reserved_quota_semantics
T8  INSTALLED  stella_0017_governed_stella_consumption
T9  INSTALLED  stella_0018_category_bound_operation_tickets

INSTALLED 9 · ABSENT 0 · PARTIAL_OR_INCONSISTENT 0 · CHAIN_SEQUENCE_COMPLETE true
```

`PARTIAL` no aparece por ausencia de evidencia: `evaluateFreshChainObservation`
**rechaza** con `CHAIN_OBSERVATION_PARTIAL_STATE` si algún paquete clasifica
`PARTIAL_OR_INCONSISTENT`. Que el evaluador aceptara el documento *es* la prueba de
que no hay ninguno.

### Ningún paquete es elegible para apply

`nextChainPackage` busca el primer `ABSENT` en orden de cadena. No hay ninguno, así
que rechaza:

> *every chain package measured INSTALLED. There is nothing to apply, and nothing
> to re-apply: an installed package is never written again.*

Y no queda ruta razonable de reaplicación. Se probó explícitamente
`authorizeChainWrite` con `requestedPackage` = cada uno de los nueve:

```
REFUSED CHAIN_SEQUENCE_COMPLETE  <- --package=grounding_0002_document_versions
…  (nueve refusals, ninguna autorización)
```

Hay tres capas encima de eso, y conviene nombrarlas porque cada una falla sola:

1. **`CHAIN_TARGET_ALREADY_INSTALLED`** — un paquete medido `INSTALLED` nunca se
   reescribe, aunque se pida por nombre.
2. **Frescura por ledger** — abrir un intento retira todos los anteriores.
   `att_1398309c…` es el último abierto, y cualquier observación vieja que un
   operador conserve ya no autoriza nada.
3. **Eco del servidor** — el id del intento se compila *dentro* de la sonda, así
   que «vuelve a correr la sonda de la semana pasada y pega la salida» falla en vez
   de pasar.

### Prechain `stella_hosted_0002`

`PRECHAIN_0002 = INSTALLED`. La medición fresca que lo sostiene es
`artifacts/t1-witness.json`, ligada a `att_d08da545…` — el intento que autorizó T1 —
con `capabilitiesBodyIsCertified: true`, `installerHasCreateRole: true`,
`installerCanSetOwner: true`, `ownerHoldsE01Grants: true`. Sin ese testigo
`planChainWriteForOperator` no habría autorizado T1, así que la instalación de la
cadena es *consecuencia* de que 0002 estuviera instalado, no una suposición sobre
ello.

`pnpm remediation:verify` re-confirma el pin del paquete
(`8616f433…15715286`) y que sigue **fuera** de los nueve paquetes con testigo: nunca
puede aparecer en `nextChainPackage`.

### Bootstrap y sentinela

```
bootstrapSchemaPresent  true
sentinel                1 fila · environment=staging · projectRef=bvyzblhqymxruxdguaee
bootstrapVersion        stella_hosted_0001
rr02Present             true   (postgres conserva ADMIN OPTION sobre uellix_owner)
baselineJournal         50/50 unidades APPLIED, un solo projectRef, un solo environment
```

---

## 4. No-regresión local

| gate | resultado |
|---|---|
| `pnpm typecheck` | **PASS** (exit 0) |
| `pnpm lint` | **PASS** — 0 errores, 48 warnings preexistentes (`no-unused-vars`) |
| `pnpm remediation:verify` | **PASS** — 10/10 checks |
| `pnpm authority:verify` | **PASS** — 9 artefactos gobernados == regeneración determinista fresca |
| `pnpm hosted:verify` | **PASS** — 10 artefactos == sus fuentes |
| suite hosted (`vitest run tests/hosted`) | **PASS** — 49 archivos, 1897 pass, 1 skip |
| `pnpm certify:pg176` | **PASS** — verdict `COMPLETE` |

```
GOVERNED_BYTES_CHANGED = false
GOVERNED_PINS_CHANGED  = false
```

Medido por tres caminos independientes: `git diff HEAD -- db/` vacío,
`authority:verify` regenerando los nueve gobernados y obteniendo los mismos bytes, y
`hosted:verify` comparando los diez artefactos contra sus fuentes.

### `certify:pg176` sí era aplicable

Corre contra `public.ecr.aws/supabase/postgres:17.6.1.143` en contenedores
efímeros con `--network none`: no hay cadena de conexión, no hay variable de entorno
que pueda nombrar un objetivo, y no hay base remota alcanzable por esa vía. Es local
por construcción, así que no había razón para saltarla.

```
chain 9/9 installed
T1..T9  exit=0  state=INSTALLED  tempMemberships=0  tempCreate=0  provider=unchanged
F1..F10 failed=true rolledBack=true tempMem=0 tempCreate=0 owners=restored prior=intact
```

Y el artefacto `artifacts/pg176-certification/latest.json` salió **byte-idéntico**
al de HEAD. Una certificación determinista que reproduce el mismo documento es más
fuerte que un exit 0: no sólo pasó, pasó midiendo exactamente lo mismo.

---

## 5. Postcondiciones remotas — lo que está probado y lo que no

Esta es la parte que hay que leer con cuidado, porque es donde una lectura perezosa
convertiría «probado en el motor» en «medido en staging».

Cada afirmación de aquí en adelante lleva **una de tres etiquetas**, y no son
intercambiables:

| etiqueta | qué significa exactamente |
|---|---|
| `MEASURED REMOTELY` | PostgreSQL, en el proyecto `bvyzblhqymxruxdguaee`, respondió esto a una consulta read-only. |
| `ENGINE-PROVEN` | se midió sobre los **mismos bytes gobernados** y el **mismo motor** (PG 17.6, imagen Supabase), en un contenedor local. Es una propiedad de los bytes; **no** es una medición del proyecto remoto. |
| `OPERATOR-ATTESTED` | lo aportó el operador al ensamblar el documento, y un contrato lo valida. La base de datos no puede verlo y por tanto no lo dice. |

### 5.1 Lo que la observación final SÍ mide contra staging

| postcondición | clase | evidencia |
|---|---|---|
| objetos esperados presentes | `MEASURED REMOTELY` | 35 testigos de catálogo, 9/9 paquetes `INSTALLED` |
| funciones/tablas críticas presentes | `MEASURED REMOTELY` | los mismos testigos, por **firma completa** (la aridad es lo que separa las versiones) |
| el objetivo sigue siendo staging | `MEASURED REMOTELY` + `OPERATOR-ATTESTED` | tres señales: la sentinela sale del catálogo; `declaredProjectRef` y `poolerUser` los declara el operador y `verifyStagingTarget` los cruza |
| Production nunca fue tocado | `MEASURED REMOTELY` | veto por nombre antes de leer una sola fila de catálogo; ningún registro del ledger, ningún documento de evidencia nombra `ctaxtgujyyprgynmnvtq` |
| ownership de los 27 traspasos | `MEASURED REMOTELY` | §5.3, `att_881c1c68` |
| 3 contextos canónicos de dueño | `MEASURED REMOTELY` | §5.3 |
| `TEMP_MEMBERSHIPS = 0` | `MEASURED REMOTELY` | §5.3 |
| `TEMP_CREATE_GRANTS = 0` | `MEASURED REMOTELY` | §5.3 |
| topología de roles = prechain + 3 | `MEASURED REMOTELY` | §5.3, delta contra `att_d08da545` |
| `SECURITY DEFINER` / `search_path` | `MEASURED REMOTELY` | §5.3, 27 definers, 19 en alcance |
| RLS: 118 políticas, ninguna inerte | `MEASURED REMOTELY` | §5.3 |
| ninguna feature flag activada | `OPERATOR-ATTESTED` | ver abajo |

**Las nueve feature flags no son una medición de PostgreSQL, y llamarlas así sería
falso.** Son variables de entorno del despliegue: el bloque `featureFlags` lo
ensambla el operador dentro del documento de corroboración, `parseA1Corroboration`
exige que estén las nueve declaradas en `STELLA_FEATURE_FLAGS` y `enabledFlagNames`
las normaliza contra un conjunto de valores apagados. Eso es **atestiguado por el
operador y validado por contrato** — el contrato garantiza que ninguna falta y que
ninguna se lee como encendida por accidente; **no** garantiza que el operador midió
el entorno correcto. Ninguna consulta puede corroborarlo: la base de datos no ve las
variables de entorno del proceso Next.js.

### 5.2 Lo que está probado en MOTOR, no en staging (`ENGINE-PROVEN`)

`certify:pg176` mide, sobre los **mismos bytes gobernados** (mismos digests) y el
**mismo motor** (PG 17.6, imagen Supabase):

- `temporaryMembershipsAfter = []` tras cada uno de los nueve paquetes;
- `schemaCreateResidualAfter = []` tras cada uno;
- `providerMembershipsUnchanged = true`;
- ownership, `SECURITY DEFINER` / `search_path`, políticas RLS, a través de
  `buildChainPostureSql` y sus seis evaluadores;
- y lo mismo tras **diez inyecciones de fallo**, todas revertidas.

Eso es una propiedad muy fuerte de los bytes. **No es una medición de staging.**

Sigue siendo verdad y sigue siendo valiosa: ahora que §5.3 mide lo mismo contra el
proyecto remoto, las dos coinciden, y **coincidir es el resultado**. Una postura
remota que difiriera de la del motor sobre los mismos bytes habría sido el hallazgo.

### 5.3 F-PI-01 — CERRADO. Medido contra staging.

```
F_PI_01                            = CLOSED
CANONICAL_POSTURE_ATTEMPT          = att_881c1c688d82077da32ba481c0482b74
REMOTE_CHAIN_POSTURE               = VERIFIED
REMOTE_TEMP_MEMBERSHIPS_MEASURED   = true
REMOTE_TEMP_CREATE_GRANTS_MEASURED = true
PENDING_EVIDENCE                   = 0
```

| veredicto | valor |
|---|---|
| `POSTURE_ATTEMPT_BINDING` | `BOUND` |
| `PRECHAIN_TOPOLOGY_BASELINE` | `MEASURED_REMOTELY` |
| `OWNER_TRANSFERS_REMOTE` | `27_OF_27_CORRECT` |
| `CANONICAL_OWNER_CONTEXT_REMOTE` | `3_OF_3_CORRECT` |
| `TEMP_MEMBERSHIPS` | `ZERO` |
| `TEMP_CREATE_GRANTS` | `ZERO` |
| `PERSISTENT_ROLE_TOPOLOGY_REMOTE` | `EXPECTED` |
| `SD_GATE_REMOTE` | `PASS` |
| `RLS_POLICY_ENGINE_REMOTE` | `PASS` |

Medido: **11 filas de membresía** contra las **8** de la línea base prechain. La delta
son exactamente las tres filas que el plan declara —
`uellix_cap_*<-uellix_migrator (admin=true inherit=false set=false)`— ninguna fila
retirada, y `capabilityReachableBy` **vacío** para los tres roles de capacidad.
`TEMP_MEMBERSHIPS = 0` es eso, no `membership_count = 0`: las ocho filas prechain
siguen ahí, incluida `uellix_owner<-uellix_migrator` **con SET**, y ninguna de ellas
es una fuga.

Ninguno de los tres pares `CREATE` que la cadena abre temporalmente sigue concedido.
27 funciones `SECURITY DEFINER`, 19 en los esquemas de la cadena, **todas** con
`search_path` vacío y **ninguna** con `EXECUTE` a `PUBLIC`. 118 políticas, cero
duplicadas, cero sobre una relación con row security desactivado.

El veredicto vive en `artifacts/hosted-chain-posture-status.json` y
`pnpm posture:status:verify` lo **recalcula desde la evidencia promovida** y compara
byte a byte. No es una cifra que un documento cite: es una cifra que un comando
reproduce.

#### Corroboración independiente

Hubo **dos** mediciones remotas completas, con 64 minutos de diferencia:

| intento | hora | resultado |
|---|---|---|
| `att_b7e47ab8…` | 16:04 → 16:08 | `VERIFIED` |
| `att_881c1c68…` | 17:08 → 17:12 | `VERIFIED` ← **canónica** |

Los dos documentos son **byte-idénticos salvo por su propio id de intento**, cada uno
haciendo eco sólo del suyo. Eso no es una repetición redundante: son dos sondas
independientes contra el mismo proyecto, separadas por una hora, que devuelven la
misma postura. Ambas se conservan.

El ledger registra además dos intentos abiertos y **nunca consumidos**
(`att_e5df8de6…`, `att_1d78582f…`). Son intentos retirados por apertura posterior, no
mediciones fallidas, y quedan en el libro append-only porque el libro es el registro
de qué intentos existieron.

#### La ruta, para la próxima vez

No añade **un solo byte de SQL nuevo**:

```bash
pnpm posture:observation
pnpm posture:status --attempt=<id> --observation=<file>.json
```

| pieza | qué es |
|---|---|
| generador | `buildChainPostureProbeSql` — la salida de `buildChainPostureSql` con **una clave inyectada**, el id del intento, por un ancla que debe aparecer exactamente una vez |
| parser | `parseChainPostureEvidence` → liga al intento y **delega el cuerpo a `parseChainPosture`**, el parser certificado, sin tocarlo |
| evaluadores | los seis `evaluate*` de `chain-postconditions.ts`, más dos residuales derivados del plan de autoridad |
| conexiones | **cero**. Ambos comandos declaran `CONNECTS TO NOTHING` y un test lo verifica sobre los bytes de los tres archivos |

**La sonda es SELECT-only y se comprueba antes de escribirse en disco**, no sólo en
un test: exactamente un `SET search_path = ''` y exactamente un `SELECT`, sin ninguna
palabra mutante fuera de un literal de cadena. Una sonda que creciera una segunda
sentencia se rechaza en el generador, en la máquina de quien está a punto de pegarla
en una sesión contra staging.

#### Por qué `TEMP_MEMBERSHIPS = 0` no es `membership_count = 0`

Es el punto donde una comprobación ingenua estaría **mal**, y en la dirección que
parece prudente. Staging lleva **ocho filas de membresía legítimas anteriores a la
cadena**, y una de ellas es `uellix_owner<-uellix_migrator` **con `SET`** — el
permiso que permite abrir la ventana de dueño. Un residual escrito como «ninguna
membresía con SET» **falla una corrida perfecta**.

Las dos afirmaciones se derivan del plan de autoridad, no se escriben:

- **`TEMP_MEMBERSHIPS`** — la cadena asume temporalmente cada **rol de capacidad**
  para poder `SET ROLE`. Después de T9 nadie puede alcanzarlos: `capabilityReachableBy`
  vacío, que es `pg_has_role(..., 'SET')` calculado por el servidor y **transitivo**,
  así que cierra también el camino por un rol intermedio que una inspección de filas
  no ve. La delta legítima es `admin=true inherit=false set=false`: confiere
  administración y ninguna capacidad de convertirse en el rol, y por eso no aparece
  aquí. `uellix_owner` queda **excluido** del conjunto derivado, y esa exclusión es la
  sustancia de la comprobación.
- **`TEMP_CREATE_GRANTS`** — la cadena abre `GRANT CREATE ON SCHEMA <s> TO <capacidad>`
  para exactamente los tres pares que declaran los segmentos del plan, y revoca cada
  uno. Ninguno de **esos** pares puede seguir concedido. Las concesiones `CREATE`
  legítimas anteriores no están en el conjunto derivado y por tanto nunca se leen como
  fuga.

Ninguna de las dos necesita línea base. Añade un segmento de transferencia en un
esquema nuevo y el conjunto esperado crece sin que nadie edite una lista.

#### La línea base de la delta de topología, y por qué es una medición

`evaluatePersistentRoleTopology` **sí** es una delta, y la postura anterior a T1 ya no
existe remotamente: la cadena está instalada. Había tres salidas y sólo una es
evidencia. La elegida es la medición que **sí se tomó**:

```
docs/ops/staging/evidence/2026-08-11-att_d08da545-prechain-observation.json
```

Es la observación de autoridad prechain del intento que el ledger registra como
`CONSUMED` para `grounding_0002_document_versions` — el T1 que funcionó — así que
describe la topología de roles de staging **inmediatamente antes** de que el primer
paquete gobernado hiciera commit. Se selecciona desde una **lista fijada**
(`PRECHAIN_TOPOLOGY_EVIDENCE`), última entrada vigente, por la misma razón que
`CLASS_C_SQL_EDITOR_EVIDENCE` es una lista y no un glob: la evidencia que gobierna un
veredicto no puede ser nombrable por quien pueda escribir en un directorio.

Es sólida porque el predicado de membresías de las dos sondas es **byte-idéntico**, y
eso está **asertado por un test**, no supuesto.

#### El defecto que este cierre encontró en su propia herramienta

`posture:status:verify` **no podía pasar nunca**, y lo demostró la primera medición
real. El juicio leía el ledger de intentos y rehusaba si el intento no estaba `OPEN`;
`posture:status:write` **consume** el intento después de calcular. Así que cualquier
recálculo posterior a una escritura correcta leía un intento gastado, producía un
refusal y `:verify` informaba `DIVERGED` — siempre, por construcción — culpando a «la
observación cambió, o el status se editó» cuando lo único que había cambiado era el
append del propio comando.

Un gate obligatorio que sólo puede decir que no es un gate inerte, que es exactamente
la clase de defecto que este repositorio gasta su presupuesto en cerrar. Corregido:

- el **juicio** es ahora función pura de la observación, la línea base declarada y el
  repositorio — los tres inmutables una vez escritos — así que un status registrado se
  recalcula mientras esos tres existan. El campo mutable `attemptStatus` sale del
  artefacto;
- la **frescura sigue igual de fuerte** y vive donde le corresponde: en el acto que
  registra y promueve. `posture:status:write` rehúsa un intento gastado antes de
  calcular nada;
- con una excepción declarada y estrecha: un intento ya consumido puede
  **re-materializar** el status que ya produjo, si y sólo si la evidencia promovida
  existe y es **byte-idéntica** a la observación suministrada. No es un juicio nuevo —
  es el mismo, sobre los mismos bytes. No promueve nada y no añade ninguna línea al
  ledger, así que no puede fabricar una medición ni gastar un intento dos veces.

Un test fija las dos mitades: que dos cálculos consecutivos coinciden byte a byte, y
que la cadena `POSTURE_ATTEMPT_NOT_OPEN` sigue estando en el camino de escritura.

#### Lo que queda

Nada de F-PI-01. El repositorio sigue sin poder conectarse — no hay `.env` con
credenciales de staging (sólo `.env.example`) y `psql` no está en el PATH — y eso no
es una limitación que se haya resuelto, es el diseño: la medición la tomó un humano y
la herramienta sólo la juzga.

---

## 6. Historial de incidentes

Se conserva completo y por escrito. Los dos fallos de T1 no son ruido a limpiar:
son la prueba de que los controles detectaron y cerraron defectos reales antes de
que llegaran a Production.

El ledger `artifacts/hosted-chain-attempts.jsonl` es append-only y los contiene. Once
registros `CONSUMED`, no nueve — y esa diferencia es el punto:

> **Un registro `CONSUMED` significa «se autorizó una escritura», nunca «un paquete
> quedó instalado».** Los dos primeros consumieron su intento y murieron a mitad de
> escritura. Lo que dice qué está instalado es la observación, no el ledger.

| # | qué pasó |
|---|---|
| 1 | **Primer T1 fallido.** `att_6d9a8c1d…` consumido; se aplicó el artefacto **intermedio** `.hosted.sql`, que asume superusuario. Murió en línea 258: `permission denied for schema uellix_grounding`. |
| 2 | **Rollback total medido.** `att_996213d2…` abierto y **nunca consumido** — evidencia, no autorización: 4 testigos de T1 en `false`, **9/9 ABSENT**. Sin residuo. |
| 3 | **Fix de selección gobernada** (2290504). Los runners operacionales pasan a resolver por `db/hosted/governed-artefact.ts`, con la ruta vallada en `/governed/` y cada archivo fijado por digest. Sin tocar un byte de SQL. |
| 4 | **Segundo T1 fallido.** `att_4b60e96a…` consumido; artefacto correcto, pero aplicado como `postgres` en vez de `uellix_migrator`. Murió en línea 998: `permission denied to set role "uellix_cap_grounding"`. Los gates medían la **base**; nadie medía la **sesión**. |
| 5 | **Rollback total medido.** `att_9b68c33c…` abierto y nunca consumido: 35 mediciones de testigo, **9/9 ABSENT**. Completo otra vez. |
| 6 | **Identity binding** (55fba11). `buildInstallerIdentitySql` mide quién sostiene la conexión; `identity:verify` es fail-closed contra `CERTIFIED_CHAIN_INSTALLER`; `buildInstallerIdentityGuardSql` aborta la transacción **antes de cualquier DDL** si el principal es el equivocado. |
| 7 | **Conexión directa `uellix_migrator` validada.** `installer-identity.json` y su re-check: `sessionUser = currentUser = uellix_migrator`, `isSuper: false`, `createRole: true`, `canSetOwner: true`. El pooler sólo deriva el ref de `postgres.<ref>`; el instalador va directo. |
| 8 | **T1→T9 ejecutados** con artefacto gobernado, digest binding, `uellix_migrator`, identity guard, transacción única (`psql -1`), y **observación fresca entre paquetes** — nueve mediciones para nueve escrituras, nunca un plan de nueve desde una medición. |
| 9 | **9/9 INSTALLED**, `CHAIN_SEQUENCE_COMPLETE`. |

Ambos incidentes están además **reproducidos en laboratorio** dentro de
`artifacts/pg176-certification/latest.json`, lo que los convierte en regresiones
detectables y no en anécdotas:

```jsonc
"installerProbe": [
  { "installer": "postgres",         "applied": false,
    "firstRefusal": "…:998: ERROR:  permission denied to set role \"uellix_cap_grounding\"",
    "leftT1": "ABSENT" },
  { "installer": "uellix_migrator",  "applied": true,  "firstRefusal": null,
    "leftT1": "INSTALLED" }
],
"ungovernedArtefactProbe": {
  "relativePath": "db/prepared/hosted/grounding_0002_document_versions.hosted.sql",
  "firstRefusal": "…:258: ERROR:  permission denied for schema uellix_grounding",
  "t1StateAfter": "ABSENT",
  "temporaryMembershipsAfter": 0, "schemaCreateResidualAfter": 0
}
```

---

## 7. Sin habilitación de features

```
STELLA_ENABLED                        false
STELLA_ADVISOR_ENABLED                false
STELLA_COMPOSER_ENABLED               false
STELLA_VALIDATOR_ENABLED              false
STELLA_GROUNDED_QUERY_ENABLED         false
STELLA_DECISIONS_PERSISTENCE_ENABLED  false
STELLA_PROXY_REVIEWER_ENABLED         false
STELLA_EVIDENCE_REVIEWER_ENABLED      false
STELLA_AUDIT_ASSISTANT_ENABLED        false
```

Nueve declaradas, nueve en `false`, ninguna tocada. Esta fase valida
**infraestructura y arquitectura desplegada**. No es activación funcional de Stella.

`OPERATOR-ATTESTED`, **no** `MEASURED REMOTELY`, y la distinción importa: estas nueve
líneas salen del bloque `featureFlags` que el operador ensambla en el documento de
corroboración, no de una consulta. Lo que el contrato garantiza es que **están las
nueve** —`parseA1Corroboration` rechaza un documento al que le falte una— y que
ninguna se lee como encendida por accidente: `enabledFlagNames` normaliza contra un
conjunto de valores apagados, así que `"FALSE "` o `"off"` cuentan como apagadas y
cualquier otra cosa cuenta como **encendida**. Lo que el contrato **no** puede
garantizar es que el operador leyó el entorno correcto. Ninguna consulta puede: la
base de datos no ve las variables de entorno del proceso Next.js.

---

## 8. Hallazgos

Ninguno material. Dos de endurecimiento, ambos corregidos aquí.

### H-1 · Dos sondas ligadas a intento quedaron versionables

`.gitignore` documenta por qué una sonda por intento no se commitea: *«una sonda en
disco es una sonda que alguien puede volver a correr mañana, que es justo lo que la
frescura existe para rechazar»*. Y lista cuatro. El Commit 5.6 añadió dos emisores
más en `scripts/chain-attempt.ts` —
`artifacts/hosted-chain-installer-identity-probe.sql` y
`…-installer-identity-guard.sql` — y **no** las reglas correspondientes.

Las dos compilan `att_<32 hex>` como literal. El guard es el caso peor: prependido a
un paquete gobernado bajo `psql -1`, un guard viejo en disco afirmaría el rol
correcto para la **medición equivocada**.

Corregido en `.gitignore`. La regla que lo atrapó es genérica —*todo `*.sql` bajo
`artifacts/` que contenga un id de intento debe estar ignorado*— así que atrapa
también al próximo emisor que alguien añada.

### H-2 · Banner de estado obsoleto

`STELLA_HOSTED_MIGRATION_JOURNAL.md` seguía abriendo con «Ninguna escritura hosted
se ha realizado», falso desde el 2026-08-11. Corregido en el sitio, con puntero a
este documento.

---

## 9. Qué NO autoriza este gate

- **No** autoriza habilitar ninguna feature flag de Stella.
- **No** autoriza ninguna escritura contra staging: la cadena está completa y un
  paquete instalado no se vuelve a escribir.
- **No** autoriza absolutamente nada contra Production (`ctaxtgujyyprgynmnvtq`).
- **No** convierte `REMOTE_CHAIN_POSTURE = VERIFIED` en un permiso. Dice que la
  postura remota es la que el plan de autoridad exige, y nada más: no habilita una
  flag, no permite una escritura y no dice nada sobre Production. Ninguno de los nueve
  veredictos de §5.3 se llama `AUTHORIZED`, y un test lo fija.
- **No** valida ningún comportamiento funcional de Stella. Esta fase mide
  infraestructura y postura de autoridad. Que la cadena esté instalada y su postura
  sea correcta es la precondición de una integración funcional, no su resultado.

```
POST_INSTALL_VALIDATION_GATE              = FULL_PASS
F_PI_01                                   = CLOSED
PENDING_EVIDENCE                          = 0
SAFE_FOR_FINAL_FABLE_EVIDENCE_REVIEW      = true
SAFE_TO_CLOSE_POST_INSTALL_PHASE          = true
SAFE_TO_BEGIN_FUNCTIONAL_STAGING_INTEGRATION = true   (con las 9 flags en false)
SAFE_TO_ENABLE_STELLA_FEATURES            = false
SAFE_TO_TOUCH_PRODUCTION                  = false
```
