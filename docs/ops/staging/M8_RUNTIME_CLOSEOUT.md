# M-8 — cierre de runtime en staging `bvyzblhqymxruxdguaee`

**Estado: CERRADO EN STAGING, MEDIDO POR EJECUCIÓN.**
`M8_STRUCTURAL = PASS` · `M8_RUNTIME = PASS` · `M8_CLOSED_IN_STAGING = true`.

Este documento **no autoriza nada**: no habilita una bandera, no permite una
escritura y no dice nada de Producción. Registra lo que se midió, con qué
instrumento y bajo qué identidad, y **retiene** las deudas que siguen abiertas
en vez de cerrarlas por decreto.

Léase junto a [`M8_CLAIM_LOCK_REMEDIATION.md`](./M8_CLAIM_LOCK_REMEDIATION.md)
(el defecto y su reparación T10) y
[`STELLA_STAGING_POST_INSTALL_GATE.md`](./STELLA_STAGING_POST_INSTALL_GATE.md)
(el gate de instalación de la cadena).

---

## 1. El veredicto, y por qué hizo falta ejecutarlo

`M8_STRUCTURAL` ya era `PASS` desde la instalación de T10: el catálogo mostraba
el `pg_advisory_xact_lock` con la clave del registrador, `FOR UPDATE` ausente del
cuerpo, propietario/ACL/`SECURITY DEFINER`/`search_path` intactos y
`uellix_cap_grounding` con `SELECT` y sin `UPDATE` sobre `public.evidence_items`.

Eso no bastaba, y el propio `grounding_0002` había escrito por qué:

> «a dry-run that inspects structure without INVOKING the functions cannot see
> that»

M-8 era una incompatibilidad **funcional** dentro de bytes correctos. Sólo
aparece cuando el principal de runtime —`uellix_app`, a través del rol de
capacidad— **ejecuta** la función. El cierre exigía por tanto una invocación
real, con una credencial real, y esa credencial no existía.

| | |
|---|---|
| Intento de runtime | `att_9d8c041227828ed2ea5dfe162c483225` |
| Intento de postura final | `att_9c885e6f165dbfa574998ca46643905a` |
| SQLSTATE final | **`U0102`** — `grounding: evidence item not found` |
| SQLSTATE prohibido | `42501` — **ausente** de la evidencia |
| Principal | `session_user = current_user = uellix_app`, `isRealLogin = true` |
| Base de datos | `postgres` |
| Bracket transaccional | `TRUE/TRUE` dentro → `FALSE/FALSE` tras `ROLLBACK` |
| Escrituras remotas persistentes | **5** (2 de ellas de este ciclo: alta y baja de credencial) |
| Ciclo de credencial #2 | **CERRADO** — `uellix_app` password = `NULL` |
| Postura post-credencial | `REMOTE_CHAIN_POSTURE = VERIFIED` |

### Por qué `U0102` prueba que la frontera se cruzó

El UUID sonda `00000000-0000-0000-0000-000000000000` es deliberadamente
inexistente. El recorrido dentro de `claim_active_document_version` es:

1. argumento no NULL (si no, `U0100`);
2. `pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))` — la
   reparación T10, que **no exige privilegio alguno**;
3. `SELECT e.organization_id FROM public.evidence_items` **como el definer** —
   la frontera M-8;
4. `v_org IS NULL` → `RAISE ... U0102`.

El cuerpo pre-M-8 hacía ese `SELECT ... FOR UPDATE`, y PostgreSQL evalúa el ACL
al **inicializar el executor**: moría con `42501` con cero filas igual que con
mil, antes de llegar al paso 4. Alcanzar `U0102` sitúa la ejecución aguas abajo
del paso 3. Los dos `RAISE U0102` del cuerpo comparten código y mensaje a
propósito (no dar un oráculo de tenencia), y eso **no** introduce ambigüedad
aquí: ambos están después de la lectura, así que cualquiera de los dos prueba lo
mismo.

---

## 2. El instrumento, y el defecto que tuvo la primera versión

`artifacts/hosted-m8-runtime-proof.sql` (**v1**) se ejecutó una vez y quedó
**INCONCLUSIVO**. Se conserva **byte a byte** como registro de lo que corrió, no
como instrumento vigente. Sus dos fallos, medidos y no razonados:

- el SQLSTATE decisivo viajaba **sólo por `RAISE NOTICE`**, y ese canal no llegó
  al operador mientras el canal de resultados sí; `exit 0` no lo sustituye,
  porque psql sale 0 siempre que ningún error **escapa**, y el script captura por
  diseño;
- `pg_current_xact_id_if_assigned() IS NULL` era un testigo **vacuo**: PostgreSQL
  sólo asigna XID cuando la transacción **escribe**, y esta prueba no escribe
  nada, así que la función devuelve NULL dentro y fuera. El
  `M8_RUNTIME_TX_CLOSED=true` que v1 reportó no estableció nada.

`artifacts/hosted-m8-runtime-proof-v2.sql` (**v2**) mueve toda la evidencia al
canal de resultados, en dos documentos JSON de una línea capturables con `-o`.

### La corrección que decidió el ciclo

Dos revisiones adversariales independientes bloquearon la primera v2 por un
defecto **medido en la imagen de certificación 17.6.1.143**:

> una vez creado el placeholder de un GUC custom en la sesión, `ROLLBACK`
> revierte su **valor** pero el parámetro sigue visible como **cadena vacía**,
> no como NULL.

Es decir: `current_setting('uellix.m8_sqlstate', true) IS NOT NULL` seguía siendo
`true` después del rollback, y el bracket de cierre **nunca cerraba**. El
predicado quedó como

```sql
NULLIF(pg_catalog.current_setting('uellix.m8_sqlstate', true), '') IS NOT NULL
```

y la ejecución real lo confirmó en staging: `settingVisible` fue `true` dentro y
`false` después. Sin ese `NULLIF`, este ciclo de credencial se habría gastado en
un segundo INCONCLUSIVO.

Es la misma clase que el `search_path=""` entrecomillado de PG 17.6 que ya
registra `M8_CLAIM_LOCK_REMEDIATION.md` §6: **una comprobación que falla por su
propia forma y no por la propiedad que mide.**

### Atribución obligatoria y salida irrepetible

v2 **rehúsa correr** sin `-v m8_attempt_id` (misma forma que
`db/prepared/checkpoint-a1/corroboration.sql`): sin default, sin fallback. El id
lo acuña `pnpm m8:runtime:open`, que además liga la ruta de salida al intento y
**rehúsa** si ya existe — `psql -o` trunca, y destruir una medición que no se
puede repetir (la credencial que la produjo ya no existe) sería silencioso.

**v2 no debe volver a ejecutarse nunca.** Tres cosas lo impiden de forma
estructural, no por disciplina: la credencial está retirada, la ruta de salida
del intento ya existe, y una re-ejecución exigiría acuñar un intento nuevo.

---

## 3. El ciclo de credencial #2, y por qué el cierre se prueba dos veces

Ninguna de estas mediciones era obtenible sin una credencial viva para
`uellix_app`, cuyo password es `NULL` por diseño. El ciclo abrió una ventana
mínima y la cerró **incondicionalmente**.

| # | Paso | Evidencia |
|---|---|---|
| — | A0′ autoridad, en fresco | `2026-08-12-att_9d8c0412-m8-credential-authority.json` |
| **#4** | `\password uellix_app` (interactivo) | atestado por operador |
| — | C′ login **real** como `uellix_app` | `2026-08-12-att_9d8c0412-m8-app-identity.json` |
| — | runtime v2, **exactamente una vez** | `2026-08-12-att_9d8c0412-m8-runtime-observation.json` |
| **#5** | `ALTER ROLE uellix_app PASSWORD NULL` | atestado, exit 0 |
| — | cierre por catálogo | `2026-08-12-att_9d8c0412-m8-credential-closure.json` |
| — | E5′ control negativo | `FATAL: password authentication failed for user "uellix_app"`, exit 2 |
| — | postura post-credencial | `2026-08-12-att_9c885e6f-chain-posture-observation.json` |

**El password nunca viajó en argumentos, variables de entorno, archivos del
repositorio ni chat.** `\password` computa el verificador SCRAM del lado
**cliente**, así que el texto plano no aparece en el SQL transmitido, ni en
`pg_stat_activity`, ni en los logs del servidor. La retirada sí puede ir en la
línea de comandos precisamente porque `NULL` no es un secreto.

Dos hechos que conviene no confundir:

- **el cierre está probado por dos mecanismos que fallarían distinto**: el
  catálogo (`appPasswordSchemeAfter = null`, con `pgAuthidReadable = true` para
  que el null sea *medido* y no una lectura denegada) y el servidor de
  autenticación rechazando **el password que sí funcionaba**. Un control negativo
  con un password equivocado habría «pasado» sobre una credencial viva;
- **`uellix_app` conserva `canLogin = true`**, y eso es correcto: el atributo no
  se tocó. Lo que hace imposible la autenticación es `rolpassword IS NULL`
  (`stella_0004` §9.3).

El documento de cierre resultó **byte-idéntico** al del ciclo #1
(`sha256 6b9d7e98…`): mismos ocho atributos de rol, mismas dos membresías con sus
grantors, misma lista vacía de roles NOLOGIN con password. La justificación
entera del aprovisionamiento era «toca `rolpassword` y nada más», y eso queda
**medido a la salida**, no asumido.

---

## 4. Postura final

`pnpm posture:status:write` sobre `att_9c885e6f165dbfa574998ca46643905a`:

```
POSTURE_ATTEMPT_BINDING          BOUND
PRECHAIN_TOPOLOGY_BASELINE       MEASURED_REMOTELY
OWNER_TRANSFERS_REMOTE           27_OF_27_CORRECT
CANONICAL_OWNER_CONTEXT_REMOTE   3_OF_3_CORRECT
TEMP_MEMBERSHIPS                 ZERO
TEMP_CREATE_GRANTS               ZERO
PERSISTENT_ROLE_TOPOLOGY_REMOTE  EXPECTED
SD_GATE_REMOTE                   PASS
RLS_POLICY_ENGINE_REMOTE         PASS

REMOTE_CHAIN_POSTURE = VERIFIED
```

La ventana de credencial no dejó residuo topológico. La observación previa
(`att_5613578342…`, post-credencial del ciclo #1) es **idéntica byte a byte salvo
por su propio id de intento**: dos sondas separadas en el tiempo, contra el mismo
proyecto, devolviendo la misma postura. Es corroboración que no se puede
fabricar, y por eso se conserva.

---

## 5. Libros de intentos: qué evento existe y cuál NO se inventó

`artifacts/hosted-m8-runtime-attempts.jsonl` es el **cuarto** libro append-only,
con `kind: "hosted-m8-runtime"` y archivo propio. Está aislado por dos paredes
independientes: por archivo, y por tipo —`parseChainAttemptLedger` acepta sólo
`kind` ausente o `hosted-chain`, y el parser de postura exige positivamente
`hosted-chain-posture`—, así que un registro pegado en el libro equivocado sigue
siendo inerte. Es la lección **F-PS-04** aplicada en la dirección nueva.

**El intento de runtime queda `OPENED` y sin evento terminal, y eso es correcto,
no una omisión.** `scripts/m8-runtime-attempt.ts` no implementa `consume`, y este
libro es **atribución, no autoridad**: nada aguas abajo consulta «el último
OPENED» para decidir si algo puede ejecutarse —el id viaja explícito en la línea
de comandos y el servidor lo eco en ambas filas de evidencia—. Escribir a mano un
`CONSUMED` sería inventar una semántica que ninguna herramienta emite. El registro
terminal de este intento **es su observación**, ligada al intento y preservada.

El libro de postura sí tiene acto terminal, y se ejecutó: `posture:status:write`
escribe el veredicto, promueve la observación **verbatim** y sólo entonces añade
`CONSUMED`. Quedan en él dos intentos abiertos y nunca consumidos
(`att_3d939704…`, `att_5613578342…`), retirados por aperturas posteriores. Es el
comportamiento declarado del libro —append-only, su valor es decir qué intentos
existieron— y está documentado en
[`evidence/README.md`](./evidence/README.md), no corregido a posteriori.

---

## 6. Deudas RETENIDAS — este cierre no las toca

Se listan porque cerrarlas en silencio sería el defecto que este expediente
existe para no cometer. **Ninguna bloquea M-8; todas siguen abiertas.**

| Deuda | Estado |
|---|---|
| **POST_T10 `chain:status` canónico** | La evidencia canónica de cadena post-T10 sigue pendiente. El transcripto crudo `artifacts/hosted-chain-post-t10-probe.out` es una salida de trabajo ignorada, **no** el artefacto canónico. |
| **Cierre/certificación A1 de diez paquetes** | `artifacts/hosted-a1-corroboration.json` midió **nueve**; `grounding_0005` no existía cuando se tomó y **no se toca**. Refrescar A1 exige una medición nueva y extender `A1_OBSERVED_CHAIN` a diez preservando la corroboración de ruta fija. |
| **`remediation-certify.ts`: literales `installed === 9`** | Si siguen presentes, reportan `INCOMPLETE` sobre una cadena 10/10 correcta. Bloquea la re-certificación pre-RC, no M-8. |
| **Procedencia histórica 167 vs 177** | Sin resolver. |
| **Limpieza determinista de evidencia/ledgers** | Intentos abiertos y nunca consumidos en los libros de cadena y postura; el libro es append-only por diseño y la limpieza, si llega, es una decisión aparte. |
| **`EXIT_CODE_NOT_CAPTURED`** | El `$LASTEXITCODE` de runtime v2 y del probe de cierre no se transcribió. No recuperable. No debilita el veredicto: el predicado exige que **`exit 0` sea necesario y nunca suficiente**, y decide sobre las dos filas de evidencia; el cierre tiene además su testigo independiente en E5′. |

Un defecto **encontrado y corregido** en este cierre, en cambio, sí se cierra
aquí: `tests/hosted/authority/chain-posture-evidence.test.ts` localizaba la
evidencia promovida con la fecha `2026-08-11` escrita a mano, mientras
`posture:status:write` la deriva del registro `OPENED` del libro. La primera
postura medida en otro día promovió bien y **falló el test**, reportando ausente
un archivo que existe. Ahora se localiza por intento, sin suponer la fecha.

---

## 7. Predicado de aceptación, tal como se congeló ANTES de ejecutar

Fijado por revisión adversarial independiente antes de que existiera credencial
alguna, para que el resultado no pudiera redefinir su propio criterio:

- `exit 0` **necesario y nunca suficiente**;
- **exactamente 2** documentos;
- schemas `uellix.hosted.m8.runtime/1` y `uellix.hosted.m8.runtime-closure/1`;
- el **mismo** `attemptId` en ambos, igual al acuñado;
- línea 1: `sessionUser = currentUser = uellix_app`, `isRealLogin`,
  `currentDatabase = postgres`, `sqlstate = U0102`, `settingVisible`,
  `inExplicitTx`;
- línea 2: mismo principal, `settingVisible = false`, `inExplicitTx = false`;
- `42501` → **M-8 ABIERTO**; `U0100`, `NO_EXCEPTION_RAISED`, evidencia
  nula/ausente/malformada o cualquier otro SQLSTATE → **STOP**.

Medido: 2 documentos, ambos JSON válidos (17 y 9 claves), `attemptId` idéntico en
los dos, `capturedAt` ordenado (`13:17:08.842567Z` → `13:17:09.026453Z`, +184 ms),
`42501` ausente del archivo. **Todas las cláusulas se cumplen.**

Como subproducto, la observación mide `clientMinMessages = "notice"`: el servidor
**sí** emitía los NOTICE de v1, así que la pérdida fue del lado cliente. La
decisión de mover la evidencia al canal de resultados fue la correcta, y ahora se
sabe por qué.

---

## 8. Estado

| | |
|---|---|
| `M8_STRUCTURAL` | **PASS** |
| `M8_RUNTIME` | **PASS** |
| `M8_CLOSED_IN_STAGING` | **true** |
| Cadena gobernada T1–T10 | 10/10 `INSTALLED`, `PARTIAL_OR_INCONSISTENT = 0` |
| `REMOTE_CHAIN_POSTURE` | **VERIFIED** (`att_9c885e6f…`) |
| Ciclo de credencial #2 | **CERRADO**; ninguna credencial activa |
| Escrituras remotas persistentes | **5** |
| Bytes gobernados T1–T10 | **sin cambios** |
| Producción / Vercel / banderas / Gemini | **intactos**; llamadas a Gemini = 0 |
| Autoriza | **nada**. Ni una bandera, ni una escritura, ni Producción. |
