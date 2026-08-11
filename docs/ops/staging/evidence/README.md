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

Los tres de `att_6d9a8c1d` son el expediente completo de la única escritura de
cadena que se intentó contra staging: por qué se autorizó y con qué evidencia.
El de `att_996213d2` es por qué el fallo no dejó residuo.

Los tres últimos son el **cierre**: la identidad certificada con la que se aplicó
el último paquete, su re-check, y la observación que mide la cadena completa. Léase
junto a [`../STELLA_STAGING_POST_INSTALL_GATE.md`](../STELLA_STAGING_POST_INSTALL_GATE.md).

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
