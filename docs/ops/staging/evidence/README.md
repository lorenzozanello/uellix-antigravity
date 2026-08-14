# Evidencia de operador — staging `bvyzblhqymxruxdguaee`

Mediciones **consumidas** que ya no se pueden volver a tomar. Cada archivo es la
salida verbatim de una sonda **read-only**, ligada al intento que la midió.

No es un directorio de trabajo: `artifacts/` lo es. Aquí sólo entra lo que
autorizó —o explicó— una escritura que realmente ocurrió.

## Por qué existe (y por qué con estos nombres)

Las herramientas escriben en rutas por defecto (`artifacts/hosted-remediation-witness.json`
y compañía). Dos intentos seguidos escriben el mismo archivo, y **el segundo pisa
al primero**: el testigo del intento `att_34fd431f` —el que autorizó el apply de
`stella_hosted_0002`— se perdió así. Sobrevive sólo su línea de libro. Por eso
todo lo que se conserva aquí lleva el intento en el nombre.

## Contenido

| archivo | intento | qué prueba |
|---|---|---|
| `2026-08-11-att_002b27c0-remediation-witness-post-apply.json` | `att_002b27c0…` | La remediación prechain leyó **INSTALLED** después de aplicar `stella_hosted_0002`. |
| `2026-08-11-att_6d9a8c1d-remediation-witness.json` | `att_6d9a8c1d…` | Testigo de remediación ligado al intento de cadena que autorizó T1. |
| `2026-08-11-att_6d9a8c1d-prechain-observation.json` | `att_6d9a8c1d…` | Observación prechain del mismo intento: gate PASS, 0 refusals, 8 contratos. |
| `2026-08-11-att_6d9a8c1d-chain-pre-write-observation.json` | `att_6d9a8c1d…` | La observación PRE_WRITE que autorizó la escritura de T1 — la que **falló**. 0 INSTALLED / 9 ABSENT. |
| `2026-08-11-att_996213d2-post-failure-probe-output.json` | `att_996213d2…` | Salida cruda de la sonda posterior al fallo: los 4 testigos de T1 en `false`, 9/9 ABSENT. **El rollback fue completo, medido.** |
| `2026-08-11-att_4b60e96a-remediation-witness.json` | `att_4b60e96a…` | Testigo de remediación del **segundo** intento de T1: `INSTALLED`. |
| `2026-08-11-att_4b60e96a-prechain-observation.json` | `att_4b60e96a…` | Observación prechain del mismo intento. `uellix_migrator {canLogin: true, createRole: true}`, `installerCanSetOwner: true`: **la base de datos estaba lista.** |
| `2026-08-11-att_9b68c33c-post-failure-probe-output.json` | `att_9b68c33c…` | Sonda posterior al segundo fallo: 35 mediciones de testigo, **9/9 ABSENT**. Rollback completo otra vez. Este intento se abrió y **nunca se consumió**: es evidencia, no autorización. |
| `2026-08-11-post-incident-operator-identity.txt` | *(ninguno)* | `session_user\|current_user\|rolsuper\|rolcreaterole` = `postgres\|postgres\|f\|t`. La identidad real de la conexión que ejecutó T1. |
| `2026-08-11-att_0ca699d6-installer-identity.json` | `att_0ca699d6…` | La sonda de identidad **del Commit 5.6**, corrida por la conexión que aplicó T9: `sessionUser = currentUser = uellix_migrator`, `isSuper: false`, `createRole: true`, `canSetOwner: true`. Es la fila de arriba, ya cerrada. |
| `2026-08-11-att_0ca699d6-installer-identity-recheck.json` | `att_0ca699d6…` | El re-check de `pnpm identity:verify` inmediatamente antes de la escritura. Idéntico al anterior: el plan comprueba la sesión que mediste, y la conexión que vas a usar es un hecho aparte. |
| `2026-08-11-att_1398309c-chain-final-observation.json` | `att_1398309c…` | La observación de **cierre**. 9/9 INSTALLED, 0 ABSENT, 0 PARTIAL, `CHAIN_SEQUENCE_COMPLETE`. Su intento se abrió y **nunca se consumió**: evidencia, no autorización. |
| `2026-08-11-att_d08da545-prechain-observation.json` | `att_d08da545…` | La observación prechain del intento que el ledger registra como `CONSUMED` para `grounding_0002_document_versions` — **el T1 que funcionó**. Ocho filas de membresía: la topología de roles de staging inmediatamente antes de que el primer paquete gobernado hiciera commit. |
| `2026-08-11-att_881c1c68-chain-posture-observation.json` | `att_881c1c68…` | **La medición de cierre de F-PI-01, y la canónica.** Postura remota completa: 27/27 traspasos de ownership, 3/3 contextos canónicos, 11 filas de membresía (8 prechain + las 3 de la delta), `capabilityReachableBy` vacío, 27 definers con `search_path` vacío, 118 políticas, cero residual de `CREATE`. Es la observación que `artifacts/hosted-chain-posture-status.json` juzga. |
| `2026-08-11-att_b7e47ab8-chain-posture-observation.json` | `att_b7e47ab8…` | La **primera** medición remota de postura, 64 minutos antes. También `VERIFIED`, también consumida por su propio `posture:status:write`. Byte-idéntica a la canónica salvo por su propio id de intento. |
| `2026-08-11-att_0ca699d6-chain-pre-write-observation.json` | `att_0ca699d6…` | La observación `PRE_WRITE` del intento que autorizó **T9** (`stella_0018`). Su par `OPENED`/`CONSUMED` está en el libro de cadena. |
| `2026-08-11-m8-structural-claim-observation.json` | *(ninguno)* | `M8_STRUCTURAL`. El catálogo tras T10: `claimForUpdateAbsent`, `claimAdvisoryLockPresent` con la clave del registrador, propietario/ACL/`SECURITY DEFINER`/`search_path` intactos, `capGroundingUpdateOnEvidenceItems: false`. Estructura, **no** ejecución: es exactamente lo que un dry-run no puede ver. |
| `2026-08-12-lifecycle1-m8-credential-authority.json` | *(ciclo #1)* | Autoridad medida antes de la primera credencial: `authorityToSetAppPassword`, `pgAuthidReadable`, `appPasswordSchemeBefore: null`. |
| `2026-08-12-lifecycle1-m8-app-identity.json` | *(ciclo #1)* | Primer login **real** como `uellix_app`: `sessionUser = currentUser`, `isRealLogin: true`. |
| `2026-08-12-lifecycle1-m8-credential-closure.json` | *(ciclo #1)* | Cierre del ciclo #1: `appPasswordSchemeAfter: null`. El runtime v1 fue **INCONCLUSIVO** —su SQLSTATE viajaba sólo por `NOTICE`— pero la credencial se cerró igual. |
| `2026-08-12-att_5613578342-chain-posture-observation-postcred.json` | `att_5613578342…` | Postura post-credencial del ciclo #1. Medida y **nunca consumida**: una apertura posterior la retiró. Byte-idéntica a la canónica del 12 salvo por su id — corroboración que no se puede fabricar. |
| `2026-08-12-att_9d8c0412-m8-credential-authority.json` | `att_9d8c0412…` | A0′ del ciclo #2, medido **en fresco** antes de la escritura persistente #4. Byte-idéntico al del ciclo #1: la topología admin no se movió entre ambos. |
| `2026-08-12-att_9d8c0412-m8-app-identity.json` | `att_9d8c0412…` | C′. La credencial temporal del ciclo #2 autentica al principal correcto, contra la base donde T10 existe y le es ejecutable. |
| `2026-08-12-att_9d8c0412-m8-runtime-observation.json` | `att_9d8c0412…` | **`M8_RUNTIME = PASS`.** Los dos documentos del probe v2: `sqlstate = U0102` bajo `session_user = current_user = uellix_app`, y el bracket `TRUE/TRUE → FALSE/FALSE` que prueba que la transacción se cerró. `42501` ausente. Irrepetible: la credencial que lo produjo ya no existe. |
| `2026-08-12-att_9d8c0412-m8-credential-closure.json` | `att_9d8c0412…` | Cierre del ciclo #2. Byte-idéntico al del ciclo #1 (`sha256 6b9d7e98…`): sólo se movió `rolpassword`. |
| `2026-08-12-att_9c885e6f-chain-posture-observation.json` | `att_9c885e6f…` | **La canónica actual.** Postura después de retirar la credencial del ciclo #2: 27/27, 3/3, membresías y `CREATE` temporales en cero, SD gate y motor RLS `PASS`. Es la que juzga `artifacts/hosted-chain-posture-status.json`. |

Los tres de `att_6d9a8c1d` son el expediente completo de la única escritura de
cadena que se intentó contra staging: por qué se autorizó y con qué evidencia.
El de `att_996213d2` es por qué el fallo no dejó residuo.

Los tres de `att_0ca699d6` y `att_1398309c` son el **cierre**: la identidad certificada
con la que se aplicó el último paquete, su re-check, y la observación que mide la
cadena completa. Léase junto a
[`../STELLA_STAGING_POST_INSTALL_GATE.md`](../STELLA_STAGING_POST_INSTALL_GATE.md).

El de `att_d08da545` es **el más antiguo en el tiempo y de los últimos en llegar**, y
está aquí por F-PI-01. Vivía sólo en `artifacts/t1-prechain.json`, que está en
`.gitignore` porque el próximo intento lo reescribe — exactamente la forma del defecto
que este directorio existe para cerrar. Ahora es la línea base declarada de la delta
de membresías (`PRECHAIN_TOPOLOGY_EVIDENCE`), y una línea base que un intento
posterior pudiera pisar no es una línea base.

Los dos de postura cierran F-PI-01 y **hay que leerlos como par**. `att_881c1c68` es
la canónica: es la que nombra `artifacts/hosted-chain-posture-status.json` y la que
`pnpm posture:status:verify` recalcula. `att_b7e47ab8` se conserva porque es
**corroboración independiente que no se puede fabricar**: dos sondas contra el mismo
proyecto, separadas por 64 minutos, devolvieron la misma postura byte a byte. Es una
medición consumida y completa —su intento tiene su par `OPENED`/`CONSUMED` en el
ledger— no un resto de una corrida a medias.

El ledger `artifacts/hosted-chain-posture-attempts.jsonl` guarda además dos intentos
abiertos y **nunca consumidos** (`att_e5df8de6…`, `att_1d78582f…`). Son intentos que
una apertura posterior retiró; quedan escritos porque el libro es append-only y su
valor es decir qué intentos existieron, no cuáles salieron bien.

Nota sobre `:verify`: el artefacto de status describe **un** intento, el canónico.
Pedirle que recalcule el de `att_b7e47ab8` da `DIVERGED`, y es correcto — está
comparando contra el veredicto de otra medición. **El canónico es ahora
`att_9c885e6f…`**, la postura medida después de retirar la credencial del ciclo
#2; las tres anteriores se conservan como el registro de que la postura no se
movió a lo largo de dos ciclos de credencial.

Los **doce de M-8** son el expediente del cierre de runtime, y hay que leerlos en
ese orden: estructura (`m8-structural-claim-observation`), ciclo #1 —autoridad,
identidad, cierre— y ciclo #2 —`att_9d8c0412…` completo, del A0′ fresco a la
observación de runtime y su cierre—. La pieza decisiva es
`…-m8-runtime-observation.json`: es la única que prueba M-8 por **ejecución** y no
por catálogo, y no se puede volver a tomar. Léanse junto a
[`../M8_RUNTIME_CLOSEOUT.md`](../M8_RUNTIME_CLOSEOUT.md), que registra el
predicado de aceptación —congelado **antes** de que existiera credencial alguna—
y las deudas que ese cierre deliberadamente NO cierra.

Sobre los dos ciclos de credencial: el password temporal nunca viajó en
argumentos, variables de entorno, archivos ni chat, y ninguno de estos documentos
contiene un hash. `appPasswordScheme*` deriva el **esquema** y aquí vale `null` en
todos. El cierre está probado dos veces por mecanismos que fallarían distinto: el
catálogo, y el rechazo de autenticación con el password que **sí** funcionaba.

Los de `att_4b60e96a` y `att_9b68c33c` son el **segundo** incidente, y hay que
leerlos juntos porque por separado cada uno parece decir que todo estaba bien:
la observación prechain dice que la base de datos tenía el instalador con LOGIN,
CREATEROLE y `SET` sobre el dueño, y aun así la escritura murió en
`permission denied to set role "uellix_cap_grounding"`. La pieza que lo explica
es la última de la tabla, y es la única que **no lleva intento**: se midió a mano,
después del fallo, porque hasta el Commit 5.6 no existía ninguna sonda que
preguntara quién sostenía la conexión. Que la evidencia decisiva no tuviera dónde
encajar es, exactamente, el defecto.

## Qué NO contienen

Verificado antes de versionar, con búsqueda de patrones sobre los bytes:

- **cero** DSNs, contraseñas, tokens, API keys, JWTs o claves privadas;
- **cero** cadenas de conexión.

Sólo hay metadatos y lecturas de catálogo: ids de intento, timestamps, el project
ref, estados de paquete y atributos de rol.

Una excepción declarada, y ahora en **dos** archivos —
`…-chain-pre-write-observation.json` y `…-chain-final-observation.json`—:
ambos incluyen el bloque
`connection` que el contrato A1 exige — `connectionHost`
(`aws-0-us-east-2.pooler.supabase.com`), `poolerUser` (`postgres.<ref>`) y
`connectionPort`. Es host, **nombre de usuario** y puerto: ni contraseña ni DSN,
y `target-identity.ts` documenta el pooler user como «A USERNAME — never a
password, never a DSN». El project ref es público en cada URL que sirve el
proyecto.

Se conserva **verbatim** y no redactado por una razón concreta: el campo `digest`
cubre `corroboration` entera, así que editar el bloque invalidaría el digest y el
archivo dejaría de verificar. Una evidencia cuyo digest no cuadra no es evidencia.

Los **dos de postura** no tienen esa excepción: no llevan bloque `connection`, ni
project ref, ni nada del lado del cliente. La sonda de postura lee catálogo y sólo
catálogo, así que el documento es nombres de objeto, nombres de rol y booleanos.
`service_role` aparece ocho veces en `functions[].executeGrantees`: es el **nombre de
un rol** de Supabase, no la clave de servicio —que es un JWT y no está aquí—.

## Qué no se versiona

Las **sondas** (`*.sql`) se regeneran por intento y están en `.gitignore`: una
sonda en disco es una sonda que alguien puede volver a correr mañana, que es
justo lo que la frescura existe para rechazar. Los archivos de trabajo por
intento bajo `artifacts/` tampoco: se sobrescriben en cada corrida.

Los **libros de intentos** sí se versionan, y viven donde las herramientas los
escriben:

```
artifacts/hosted-chain-attempts.jsonl
artifacts/hosted-remediation-attempts.jsonl
```

Append-only, nunca reescritos, nunca truncados.
