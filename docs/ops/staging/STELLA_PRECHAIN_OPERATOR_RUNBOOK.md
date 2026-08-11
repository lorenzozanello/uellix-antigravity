# Runbook de operador — remediación prechain y arranque de la cadena

**Commit 5.4.** Cierra F-PS-05 (no había entrada de operador a la maquinaria de
remediación) y F-PS-02 (`chain:attempt:plan` podía autorizar T1 sin consultar
`authorizeGovernedT1`).

Este documento describe **el único camino soportado**. Ninguna otra secuencia
está certificada, y las dos que la gente improvisa —derivar el testigo a mano
desde `db/prepared/prechain/observation.sql`, o correr `psql` sin intento
consumido— son exactamente las que el contrato forward-only prohíbe.

```
STAGING     bvyzblhqymxruxdguaee
PRODUCCIÓN  ctaxtgujyyprgynmnvtq     ← lista de denegación. Nunca.
```

`KNOWN_PRODUCTION_IDENTIFIERS` incluye también `uellix.com`, `app.uellix.com` y
`uellix-antigravity.vercel.app`. El veto de producción se comprueba **antes** que
cualquier otra señal: ninguna observación lo levanta.

Aquí no aparece ninguna DSN ni ninguna contraseña. La conexión vive en el
entorno del operador (`$UELLIX_STAGING_URL`) y ninguna herramienta de este
repositorio la lee, la imprime ni la persiste.

---

## 0. Antes de nada — el árbol y el pin

```bash
git rev-parse HEAD && git status --porcelain && pnpm remediation:verify
```

`REMEDIATION_VERIFY = PASS` es la afirmación de que el artefacto que se va a
aplicar es byte a byte el revisado. Si falla, **para**: no hay rollback para
este paquete y una edición no revisada es el único cambio que no se deshace
re-ejecutando nada.

Opcionalmente, para probar que los bytes gobernados no se movieron:

```bash
pnpm authority:verify && pnpm hosted:verify
```

---

## 1. Abrir UN intento de remediación

```bash
pnpm remediation:attempt:open
```

Imprime el `attemptId`, el pin, el digest del cuerpo certificado, y escribe la
sonda en `artifacts/hosted-remediation-witness-probe.sql`. La sonda **lleva ese
attemptId compilado como literal SQL**: la base de datos lo devuelve en el
documento, y por eso re-ejecutar la sonda de ayer no produce una observación
fresca sino un documento que nombra el intento de ayer.

Abrir otro intento retira éste. No mantengas dos abiertos.

---

## 2. Medir — READ ONLY

El operador ejecuta la sonda manualmente. No hay herramienta en este repositorio
que se conecte a staging.

```bash
psql "$UELLIX_STAGING_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-remediation-witness-probe.sql \
     > artifacts/hosted-remediation-witness.json
```

Sólo lee `pg_catalog`. No escribe, no toca ninguna tabla del producto y no
registra ninguna credencial. La salida es **una celda JSON**: guárdala tal cual,
sin editarla.

---

## 3. Planificar — el intento se consume aquí

```bash
pnpm remediation:attempt:plan --witness=artifacts/hosted-remediation-witness.json
```

| Testigo | Resultado |
|---|---|
| `ABSENT` | **AUTORIZA exactamente una escritura** y marca el intento `CONSUMED` |
| `INSTALLED` | `REMEDIATION_ALREADY_INSTALLED` — nunca se reaplica |
| `PARTIAL_OR_INCONSISTENT` | `REMEDIATION_PARTIAL_HUMAN_ONLY` — recuperación humana |

El intento se consume **antes** de que se te entregue el comando de escritura.
Ese es todo el contrato de ambigüedad: si algo muere después del plan, el libro
dice `CONSUMED`, el planificador se niega a reutilizarlo, y la única salida es un
intento nuevo con una medición nueva. Correcto en las dos direcciones — el commit
perdido se lee `INSTALLED` y no se reaplica; el rollback no observado se lee
`ABSENT` y autoriza un intento nuevo.

Sólo `stella_hosted_0002_prechain_authority_reconciliation` es seleccionable.
`stella_hosted_0001` está **PROHIBIDO** como segunda pasada (su §5 entrega el
esquema a `uellix_owner` y diecisiete de sus statements dejan de tener la
propiedad que necesitan). T1–T9 se rechazan aquí: son otra cosa.

---

## 4. Aplicar — manual, una transacción, entorno declarado

### 4.1 Antes de psql: los bytes autorizados, revalidados

**Obligatorio.** Entre que el plan imprime y tú ejecutas, el archivo es sólo un
archivo: una regeneración, un `stash pop`, un checkout o una edición a medias lo
cambian en silencio. El plan autoriza **bytes**, no un nombre de archivo.

```bash
pnpm artefact:verify --path=<PACKAGE_PATH> --digest=<el sha256 de PIN_STATUS>
```

Requerido: `ARTEFACT_DIGEST = PASS`. Si falla, **para**: no apliques, vuelve a
`authority:verify`, abre un intento nuevo y vuelve a medir.

El helper no conecta a nada, no lee entorno, no toca ningún libro y no autoriza
nada — sólo compara dos digests. El digest esperado lo pegas tú desde el plan;
no lo deduce él, porque un verificador que dedujera su propia expectativa
estaría de acuerdo consigo mismo.

### 4.2 Checkpoint humano

Mira `PACKAGE_PATH`, el objetivo y el entorno declarado, y decide. La secuencia
completa y sin atajos es:

```
PLAN AUTHORIZED → pnpm artefact:verify (PASS) → checkpoint humano → psql
```

### 4.3 psql

```bash
psql "$UELLIX_STAGING_URL" -X -1 -v ON_ERROR_STOP=1 \
     -c "SET uellix.bootstrap_environment = 'staging'" \
     -f db/prepared/stella_hosted_0002_prechain_authority_reconciliation.sql
```

`-1` envuelve todo en una transacción; `ON_ERROR_STOP=1` la aborta al primer
error. `uellix.bootstrap_environment` no tiene default: un entorno sin declarar
es un entorno ambiguo y §0 lo rechaza.

**No interpretes el código de salida como estado.** Sea cual sea —0, distinto de
0, o una conexión que muere sin responder— el paso siguiente es el mismo.

---

## 5. Volver a medir. Siempre

```bash
pnpm remediation:attempt:open
psql "$UELLIX_STAGING_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-remediation-witness-probe.sql \
     > artifacts/hosted-remediation-witness-post.json
pnpm remediation:attempt:plan --witness=artifacts/hosted-remediation-witness-post.json
```

Esperado: **`REMEDIATION_ALREADY_INSTALLED`**. Ese rechazo *es* la confirmación —
el testigo mide hechos de catálogo, no «se corrió el archivo», así que un
proyecto que llegó al estado destino por otra vía clasifica igual y correctamente
no se reaplica.

- `ABSENT` → la transacción hizo rollback. Hay un intento nuevo abierto: se puede
  volver al paso 3.
- `PARTIAL_OR_INCONSISTENT` → **para**. Recuperación humana. No hay reparación
  automática y no la habrá: este paquete no tiene rollback por diseño, y una
  reparación elegida por una máquina sería una conjetura sobre lo que pasó.

---

## 6. El gate prechain real — sin autorizar nada

```bash
pnpm chain:attempt:open
```

Escribe tres sondas, todas con el mismo `attemptId`. Ejecuta las dos que el gate
necesita:

```bash
psql "$UELLIX_STAGING_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-chain-t1-remediation-probe.sql > artifacts/t1-witness.json
psql "$UELLIX_STAGING_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-chain-t1-prechain-probe.sql > artifacts/t1-prechain.json

pnpm chain:attempt:gate --attempt=<attemptId> \
     --remediation-witness=artifacts/t1-witness.json \
     --prechain-observation=artifacts/t1-prechain.json
```

Requerido: **`PRECHAIN_AUTHORITY_GATE = PASS`**. `gate` invoca
`validateHostedPrechainAuthorityContract` y `authorizeGovernedT1` —los mismos que
`plan`— y **no escribe nada**: no consume el intento, no toca el libro y no
autoriza T1.

Si falla: **para**. No repares automáticamente. Un gate que falla sobre una
remediación `INSTALLED` significa que el proyecto se reconcilió y después derivó,
o que se reconcilió contra otro contrato.

---

## 7. PARADA DURA

Aunque `0002 = INSTALLED` y `PRECHAIN_AUTHORITY_GATE = PASS`:

```
SAFE_TO_WRITE_GOVERNED_T1 = false
T1_RETRY_AUTHORIZED       = false
```

T1 exige su propia autorización humana. El gate es una condición necesaria, no
una decisión.

---

## 8. Sólo después — plan de cadena

```bash
pnpm chain:attempt:plan --observation=<chain-observation.json> \
     --remediation-witness=artifacts/t1-witness.json \
     --prechain-observation=artifacts/t1-prechain.json
```

Cuando —y sólo cuando— la observación autoriza T1, el CLI exige los dos
documentos y llama a `authorizeGovernedT1`. La matriz completa:

| remediación | gate prechain | resultado |
|---|---|---|
| `ABSENT` | cualquiera | **REFUSED** `REMEDIATION_ABSENT` |
| `PARTIAL_OR_INCONSISTENT` | cualquiera | **REFUSED** `REMEDIATION_PARTIAL` |
| `INSTALLED` | FAIL | **REFUSED** `PRECHAIN_GATE_FAILED` |
| `INSTALLED` | PASS | **AUTORIZADO** (más la autorización normal de cadena) |
| documentos ausentes | — | **REFUSED** `CHAIN_T1_EVIDENCE_REQUIRED` |

No hay bandera que sustituya a la evidencia. `--remediation-installed` y
`--prechain-pass` no existen y un test permanente comprueba que no aparezcan: el
estado de la base de datos no es algo que el operador declare.

### El artefacto es siempre el GOBERNADO

El plan imprime `PACKAGE_PATH` y `PACKAGE_DIGEST`, y `PACKAGE_PATH` está
**siempre** bajo `db/prepared/hosted/governed/` con sufijo `.governed.sql`. Se
resuelve con valla y pin **antes** de emitir el comando; si los bytes no
coinciden con `authority:verify`, no hay plan.

Y **antes de psql**, obligatorio, igual que en §4.1:

```bash
pnpm artefact:verify --path=<PACKAGE_PATH> --digest=<PACKAGE_DIGEST>
```

```
PLAN AUTHORIZED → pnpm artefact:verify (PASS) → checkpoint humano → psql
```

El pin del plan se comprueba cuando el plan se emite; éste se comprueba cuando
vas a ejecutar. Son dos momentos distintos y la ventana entre ellos es de un
humano.

> **Incidente T1 (Commit 5.5).** Antes de este commit el plan imprimía
> `db/prepared/hosted/<paquete>.hosted.sql`. Ese es el artefacto **intermedio**:
> una entrada de derivación que conserva la contabilidad canónica
> `SET ROLE`/`RESET ROLE` y por tanto asume superusuario. Aplicado a staging,
> T1 murió en:
>
> ```
> grounding_0002_document_versions.hosted.sql:915
> ERROR:  permission denied for schema uellix_grounding
> ```
>
> La decisión del plan era correcta; el archivo no. Nunca apliques un
> `.hosted.sql` a un proyecto gestionado: 54 statements repartidos por los nueve
> paquetes ejecutan DDL como el instalador dentro de esquemas de `uellix_owner`.
> El único `.hosted.sql` que se aplica es el bootstrap de primera provisión,
> que no tiene variante gobernada.

**T2–T9 no cambian.** No tienen prerequisito prechain —dependen de que su
predecesor esté `INSTALLED`, que los testigos de cadena ya establecen— y el gate
es inerte para ellos. Se planifican con `--observation` a secas.

El rechazo ocurre **antes** de emitir un plan autorizado: una negativa no lleva
línea de libro alguna, así que no hay rama en la que el CLI pueda registrar
`CONSUMED` para una escritura que nunca se autorizó.

---

## Los dos libros, y por qué son dos

```
artifacts/hosted-chain-attempts.jsonl          cadena
artifacts/hosted-remediation-attempts.jsonl    remediación prechain
```

Append-only, nunca reescritos, nunca truncados, y **versionados en git**: son el
rastro de auditoría durable de lo que se escribió contra staging. Están separados
porque son dos recursos serializados de forma independiente: abrir un intento de
cadena no debe retirar un intento de remediación que sigue siendo la medición
vigente de otra pregunta.

Commitea el libro después de cada `plan`. Sólo contienen `attemptId`, `event`,
`targetProjectRef`, `at`, `kind` y `packageId` — nunca una credencial.

Los documentos de trabajo por intento (`artifacts/*-witness.json`,
`artifacts/hosted-chain-pre-write-*.{json,out}`) **no** se versionan: la corrida
siguiente los sobrescribe. Lo que merece conservarse se promueve a
[`evidence/`](evidence/README.md) con el intento en el nombre — el testigo del
intento `att_34fd431f`, que autorizó el apply de `0002`, se perdió justamente por
no haberlo hecho.

Desde Commit 5.4 el rechazo es **simétrico** (F-PS-04): un registro que declara
`kind: "prechain-remediation"` pegado en el libro de la cadena se descarta, igual
que el libro de la remediación siempre descartó lo que no declara su tipo. Los
registros de cadena anteriores a 5.4 no llevan `kind` y se siguen aceptando —
rechazarlos vaciaría retroactivamente un libro cuyo valor entero es ser
append-only.

---

## Deuda declarada

- **F-PS-01** (MEDIUM) — el §4 de `stella_hosted_0002` cita un «check (7)» de §5
  que no existe. **No se toca**: cambiar los bytes fijados invalidaría la revisión
  y obligaría a repinear y recertificar. Corrección forward-only futura.
- **F-PS-03** (HARDENING) — tres definers baseline (`current_user_org_ids`,
  `current_user_is_super_admin`, `current_user_role_in_org`) con
  `search_path=public`. Diferido; no bloquea `0002`.
