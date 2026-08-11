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
| `POST_INSTALL_VALIDATION_GATE` | **PASS_WITH_HARDENING** |
| Hallazgos materiales | **0** |
| Hallazgos de endurecimiento | **2**, ambos corregidos en este commit |
| Evidencia remota pendiente | **1 bloque**, clasificada, no improvisada |
| `SAFE_TO_ENABLE_STELLA_FEATURES` | `false` |
| `SAFE_TO_TOUCH_PRODUCTION` | `false` |

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

### 5.1 Lo que la observación final SÍ mide contra staging

| postcondición | evidencia |
|---|---|
| objetos esperados presentes | 35 testigos de catálogo, 9/9 paquetes `INSTALLED` |
| funciones/tablas críticas presentes | los mismos testigos, por **firma completa** (la aridad es lo que separa las versiones) |
| ninguna feature flag activada | `featureFlags` 9× `false` |
| el objetivo sigue siendo staging | tres señales: `declaredProjectRef`, `poolerUser`, sentinela |
| Production nunca fue tocado | veto por nombre antes de leer una sola fila de catálogo; ningún registro del ledger, ningún documento de evidencia nombra `ctaxtgujyyprgynmnvtq` |

### 5.2 Lo que está probado en MOTOR, no en staging

`certify:pg176` mide, sobre los **mismos bytes gobernados** (mismos digests) y el
**mismo motor** (PG 17.6, imagen Supabase):

- `temporaryMembershipsAfter = []` tras cada uno de los nueve paquetes;
- `schemaCreateResidualAfter = []` tras cada uno;
- `providerMembershipsUnchanged = true`;
- ownership, `SECURITY DEFINER` / `search_path`, políticas RLS, a través de
  `buildChainPostureSql` y sus seis evaluadores;
- y lo mismo tras **diez inyecciones de fallo**, todas revertidas.

Eso es una propiedad muy fuerte de los bytes. **No es una medición de staging.**

### 5.3 Evidencia PENDIENTE, y por qué no se improvisó

`TEMP_MEMBERSHIPS` y `TEMP_CREATE_GRANTS` medidos **en el proyecto remoto**, junto
con ownership, RLS y la postura `SECURITY DEFINER`/`search_path` remota, quedan como

```
PENDING_OPERATOR_EVIDENCE
```

No por falta de sonda: `buildChainPostureSql` existe, es read-only, empieza por
`SET search_path = ''` y mide exactamente esos campos —
`transferredOwners`, `canonicalContextOwners`, `functions[].securityDefiner`,
`functions[].proconfig`, la alcanzabilidad `SET` de cada rol de capacidad, las
políticas y el residual de `CREATE` por esquema.

Lo que **no** existe es la ruta de operador. Hoy `buildChainPostureSql` sólo lo
invoca `scripts/remediation-certify.ts`, contra el contenedor, por `docker exec`.
No hay:

- un comando que emita la sonda de postura ligada a un intento (el análogo de lo que
  `chain:attempt:open` hace con las otras cinco), ni
- un `status` que consuma un documento de postura suministrado por el operador (el
  análogo de `a1:status` o `chain:status`).

Y no hay por dónde conectarse desde este repositorio: **todas** las herramientas
hosted declaran «CONNECTS TO NOTHING» por diseño, este árbol no tiene `.env` con
credenciales de staging (sólo `.env.example`), y `psql` no está en el PATH.

Improvisar una conexión o un SQL nuevo contra el objetivo habría sido exactamente el
tipo de acto que esta arquitectura gasta su presupuesto en impedir. Así que se
clasifica como pendiente y se nombra el trabajo que la cierra:

> **F-PI-01** — añadir `posture:observation` (emite `buildChainPostureSql` con el id
> del intento compilado dentro) y `posture:status` (parsea con `parseChainPosture`,
> evalúa con los seis `evaluate*` ya certificados). Ambos read-only, ambos sin
> conectar. Cierra 5.3 sin un solo byte de SQL nuevo.

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
- **No** cierra las postconditions remotas de §5.3. Hasta que exista F-PI-01, el
  `tempMemberships = 0` / `tempCreate = 0` de staging está **inferido del motor**,
  no medido en el objetivo. Quien lo cite como medido estará citando mal.

```
SAFE_FOR_FINAL_FABLE_EVIDENCE_REVIEW = true
SAFE_TO_ENABLE_STELLA_FEATURES       = false
SAFE_TO_TOUCH_PRODUCTION             = false
```
