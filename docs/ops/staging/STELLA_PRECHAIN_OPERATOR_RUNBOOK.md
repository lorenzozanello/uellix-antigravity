# Runbook de operador — remediación prechain y arranque de la cadena

**Commit 5.4.** Cierra F-PS-05 (no había entrada de operador a la maquinaria de
remediación) y F-PS-02 (`chain:attempt:plan` podía autorizar T1 sin consultar
`authorizeGovernedT1`).

**Commit 5.6.** Cierra la ruptura entre la identidad de ejecución **certificada**
(`uellix_migrator`) y la del **operador** (`postgres`), que es el segundo
incidente real de T1 en staging. **Empieza por §0.0**: si te saltas esa sección,
todo lo demás está bien y la escritura falla igual.

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

Aquí no aparece ninguna DSN ni ninguna contraseña. Las conexiones viven en el
entorno del operador y ninguna herramienta de este repositorio las lee, las
imprime ni las persiste.

---

## 0.0 LAS DOS IDENTIDADES — leer antes de conectar

**Commit 5.6.** Esta sección existe porque T1 murió en staging por segunda vez y
la causa no fue el artefacto: fue *quién* sostenía la conexión.

Este runbook usaba **una sola** variable, `$UELLIX_STAGING_URL`, para todo. Hay
**dos** identidades de ejecución y no son intercambiables:

| | Conexión de **bootstrap/admin** | Conexión de **instalador de cadena** |
|---|---|---|
| Variable | `$UELLIX_STAGING_ADMIN_URL` | `$UELLIX_STAGING_INSTALLER_URL` |
| Principal | `postgres` | `uellix_migrator` |
| Aplica | PHASE_BASELINE (§1 de `STELLA_APPLY_IDENTITY_PROBE`), `stella_hosted_0001`, `stella_hosted_0002`, y las **tres unidades administrativas prechain** `stella_hosted_0003` → `0004` → `0005` (ver §0.0.3) | **T1–T11 gobernados, y sólo ellos** |
| Modo | directo o session pooler | **directo, obligatorio** — ver 0.0.2 |
| Por qué | `uellix_migrator` **no existe** hasta que `stella_hosted_0001` lo crea; antes de eso `postgres` es el único login administrativo | los nueve paquetes emiten `GRANT <cap> TO uellix_migrator WITH INHERIT FALSE, SET TRUE;` seguido de `SET ROLE <cap>;` |

### 0.0.1 Por qué `postgres` no puede aplicar la cadena

No es una convención. Está escrito en los bytes gobernados, que no se tocan:

```sql
-- grounding_0002_document_versions.governed.sql:997-998
GRANT uellix_cap_grounding TO uellix_migrator WITH INHERIT FALSE, SET TRUE;
SET ROLE uellix_cap_grounding;
```

El `GRANT` nombra a `uellix_migrator` **literalmente**; el `SET ROLE` lo ejecuta
la sesión. Bajo cualquier otro principal, el permiso se le entrega a un rol que
la sesión no es, y la sentencia siguiente se rechaza con
`permission denied to set role`. Son 22 pares como ése repartidos por los nueve
paquetes, y **cada paquete contiene al menos uno**: no es una propiedad de T1.

Dos consecuencias que conviene tener escritas:

1. **Conceder la pertenencia a `postgres` no arregla nada.** El paquete seguiría
   entregando el `SET` a `uellix_migrator` por nombre, y la topología de
   pertenencias que fijan las postcondiciones de cadena
   (`<cap> <- uellix_migrator`) no sería la producida.
2. **`SET ROLE uellix_migrator` desde `postgres` tampoco.** Los paquetes cierran
   cada ventana con `RESET ROLE`, que vuelve a `session_user`: la sesión caería
   de nuevo a `postgres` en `grounding_0002:273` y moriría en la misma
   sentencia, varios cientos de líneas después. Por eso el verificador exige
   `session_user = current_user = uellix_migrator`.

### 0.0.2 Por qué la conexión del instalador es **directa**

`projectRefFromPoolerUser` (`db/hosted/target-identity.ts`) deriva el ref del
proyecto del rol de login con la forma `postgres.<ref>`, y **sólo** con esa
forma. Una sesión de `uellix_migrator` por session pooler no tiene de dónde
sacar el ref y la corroboración del objetivo se rechaza.

Por conexión directa el ref sale del **host** (`db.<ref>.supabase.co`), que no
depende del rol de login. Ésa es la única forma en la que las dos exigencias
—corroborar el proyecto y ser el instalador— se satisfacen a la vez.

No se «arregla» el parser del pooler para aceptar `uellix_migrator.<ref>`: es
contrato de identidad certificado, y nadie ha medido que el pooler enrute roles
distintos de `postgres`. Puerto **5432**, nunca 6543.

### 0.0.3 La credencial de `uellix_migrator`

`stella_hosted_0001` crea el rol `WITH LOGIN` y **no le fija contraseña**. Así
que hay una credencial que establecer, y este repositorio no participa en ella.

Procedimiento, ejecutado **por el operador** sobre la conexión de admin:

1. Genera la contraseña en tu gestor de contraseñas. **No la generes en una
   terminal con historial, ni en un chat, ni en un editor con telemetría.**
2. Fíjala con `psql` en modo interactivo usando `\password`, que la pide por
   `stdin` y **nunca la pone en la línea de comandos ni en el historial**:

   ```bash
   psql "$UELLIX_STAGING_ADMIN_URL" -X
   ```
   ```
   \password uellix_migrator
   ```

   `\password` construye el `ALTER ROLE ... PASSWORD` con el hash SCRAM ya
   calculado en el cliente, de modo que la contraseña en claro no viaja ni
   aparece en `pg_stat_activity` ni en los logs del servidor.
3. Componte `$UELLIX_STAGING_INSTALLER_URL` en tu gestor de secretos con el host
   **directo** de 0.0.2. Expórtala sólo en la sesión de shell donde vayas a
   aplicar.

Qué **no** ocurre nunca, y es comprobable:

- ninguna contraseña ni DSN entra al repositorio — ningún script lee `process.env`
  ni abre conexiones (test: «reads no environment variable and opens no connection»);
- ninguna entra al libro de intentos: sus registros son `attemptId`, `event`,
  `targetProjectRef`, `at`, `packageId`, `kind`, y nada más;
- ninguna entra a las evidencias: la sonda de identidad emite seis campos —dos
  nombres de rol y cuatro booleanos— y el documento no tiene sitio donde
  alojar otra cosa;
- ninguna entra a un prompt de Claude/Fable: no se pega una DSN en una
  conversación para «que la revise». Los refs de proyecto no son secretos; las
  credenciales sí.

Si `\password` es rechazado sobre el proyecto gestionado, **para**. Eso sería un
hecho nuevo sobre los privilegios de `postgres` en Supabase gestionado y hay que
medirlo y registrarlo, no rodearlo.

### 0.0.3 Las tres unidades administrativas prechain (M-2)

**Corrección de 2026-08-15.** La tabla de §0.0 decía «`stella_hosted_0001`,
`stella_hosted_0002`» y «T1–T9». Ambas cosas son falsas hoy: la cadena tiene
**once** eslabones, y la conexión administrativa aplica además **tres** unidades
prechain que la cadena no puede aplicarse a sí misma.

Van **con la conexión ADMIN** (`postgres`), **en este orden**, después de
`0001`/`0002` y **antes de T1**:

```
stella_hosted_0003_storage_helper_ownership.sql     ALTER FUNCTION … OWNER TO uellix_owner (×2)
stella_hosted_0004_storage_schema_usage.sql         GRANT USAGE ON SCHEMA storage TO uellix_owner
stella_hosted_0005_storage_helper_table_read.sql    GRANT SELECT ON public.organization_members TO uellix_owner
```

Cada una con `-1 -v ON_ERROR_STOP=1`, una transacción por archivo.

**No hace falta memorizar el orden: lo imponen los propios paquetes.** `0004`
§0.4 se niega si ningún helper SECURITY DEFINER es ya de `uellix_owner`; `0005`
§0.3 exige lo mismo **y** §0.4 exige el `USAGE` que concede `0004`. Aplicar
cualquiera fuera de orden es una **negativa**, no un reordenamiento silencioso.
Medido, 2026-08-15: con el `USAGE` revocado, `0005` aborta citando
`stella_hosted_0004`; con los helpers de `postgres`, aborta citando
`stella_hosted_0003`, y `stella_0019` §0.6 aborta también.

**Respecto al sentinel el orden es indiferente**, y conviene decirlo para que
nadie invente una restricción: ninguna de las tres lee
`uellix_bootstrap.staging_sentinel` (medido: cero referencias en los tres
archivos). Lo único vinculante es que estén **antes de T1**. Las certificaciones
canónicas escriben el sentinel primero y aplican el trío después; hacerlo al
revés produce el mismo estado final.

**Ninguna de las tres es miembro de `HOSTED_CHAIN`**, ninguna toma testigo de
cadena y ninguna cuenta para `CHAIN_INSTALLED`. Son prerequisitos, y las aplica
un principal que no es el instalador de la cadena — que es precisamente por lo
que existen.

**Las tres son forward-only y ninguna trae `_rollback.sql`.** Las razones están
tipadas en `db/hosted/forward-only-packages.ts`; la común es que lo que quitan es
el motivo por el que la superficie no funciona, así que «restaurar el estado
anterior» y «devolver Storage a negar a todo el mundo sin decirlo» son la misma
frase.

**Por qué `0005` existe, medido.** Con `0003` y `0004` aplicados y `0005`
ausente, T11 se instala limpiamente **y todas las subidas siguen negándose**:
los dos cuerpos SECURITY DEFINER unen `public.projects` **y**
`public.organization_members`, `uellix_owner` sólo tenía `SELECT` sobre la
primera, la lectura lanza dentro del definer y el `EXCEPTION WHEN OTHERS THEN
RETURN false` del propio cuerpo se la traga. Los nueve casos de la matriz de
roles daban DENY, en escritura y en lectura, con los once testigos en verde. Hoy
`stella_0019` §0.7b **se niega** en ese estado y `STORAGE_HELPER_FUNCTIONAL_PROBE`
impide que una certificación diga `COMPLETE` sobre él.

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
psql "$UELLIX_STAGING_ADMIN_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
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
psql "$UELLIX_STAGING_ADMIN_URL" -X -1 -v ON_ERROR_STOP=1 \
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
psql "$UELLIX_STAGING_ADMIN_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
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

Escribe **cuatro** sondas y un guard, todos con el mismo `attemptId`. Ejecuta las
dos que el gate prechain necesita:

```bash
psql "$UELLIX_STAGING_ADMIN_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-chain-t1-remediation-probe.sql > artifacts/t1-witness.json
psql "$UELLIX_STAGING_ADMIN_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-chain-t1-prechain-probe.sql > artifacts/t1-prechain.json

pnpm chain:attempt:gate --attempt=<attemptId> \
     --remediation-witness=artifacts/t1-witness.json \
     --prechain-observation=artifacts/t1-prechain.json
```

### 6.1 La sonda de identidad — por la conexión del INSTALADOR

Ésta es la única que **no** se mide por la conexión de admin, y medirla por la
conexión equivocada es exactamente el incidente:

```bash
psql "$UELLIX_STAGING_INSTALLER_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-chain-installer-identity-probe.sql \
     > artifacts/installer-identity.json
```

Read-only: dos palabras clave de sesión y una lectura de `pg_catalog`. No hace
`SET ROLE`, no altera nada y no imprime ninguna credencial — los seis campos que
emite son dos nombres de rol y cuatro booleanos.

Las tres sondas anteriores miden **la base de datos** y dan lo mismo desde
cualquier conexión. Ésta mide **la sesión**, y por eso es la única que tiene que
salir de la conexión con la que vas a escribir. Si la ejecutas por la conexión de
admin obtendrás `postgres` y el plan te rechazará — que es el comportamiento
correcto y la razón de que exista.

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
     --installer-identity=artifacts/installer-identity.json \
     --remediation-witness=artifacts/t1-witness.json \
     --prechain-observation=artifacts/t1-prechain.json
```

`--installer-identity` es obligatorio **para los nueve paquetes**, no sólo para
T1: el gate prechain es inerte para T2–T9, y el de identidad no, porque cada uno
de los nueve abre al menos una ventana de capacidad a nombre de
`uellix_migrator`.

Cuando —y sólo cuando— la observación autoriza T1, el CLI exige además los dos
documentos prechain y llama a `authorizeGovernedT1`. La matriz completa:

| identidad | remediación | gate prechain | resultado |
|---|---|---|---|
| ausente | cualquiera | cualquiera | **REFUSED** `INSTALLER_IDENTITY_REQUIRED` |
| `postgres` | cualquiera | cualquiera | **REFUSED** `INSTALLER_IDENTITY_WRONG_PRINCIPAL` |
| asumida por `SET ROLE` | cualquiera | cualquiera | **REFUSED** `INSTALLER_IDENTITY_ROLE_ASSUMED` |
| de otro intento | cualquiera | cualquiera | **REFUSED** `INSTALLER_IDENTITY_ATTEMPT_MISMATCH` |
| `uellix_migrator` | `ABSENT` | cualquiera | **REFUSED** `REMEDIATION_ABSENT` |
| `uellix_migrator` | `PARTIAL_OR_INCONSISTENT` | cualquiera | **REFUSED** `REMEDIATION_PARTIAL` |
| `uellix_migrator` | `INSTALLED` | FAIL | **REFUSED** `PRECHAIN_GATE_FAILED` |
| `uellix_migrator` | `INSTALLED` | PASS | **AUTORIZADO** (más la autorización normal de cadena) |
| `uellix_migrator` | documentos ausentes | — | **REFUSED** `CHAIN_T1_EVIDENCE_REQUIRED` |

El gate de identidad corre **el último**, a propósito: un operador conectado mal
*y* sin evidencia de remediación debe seguir enterándose de lo de la evidencia,
que es el rechazo ya certificado. Ninguno de los dos oculta al otro.

No hay bandera que sustituya a la evidencia. `--remediation-installed`,
`--prechain-pass`, `--installer=<rol>` y `--skip-identity` no existen y un test
permanente comprueba que no aparezcan: ni el estado de la base de datos ni la
identidad de la sesión son algo que el operador declare.

### El artefacto es siempre el GOBERNADO

El plan imprime `PACKAGE_PATH` y `PACKAGE_DIGEST`, y `PACKAGE_PATH` está
**siempre** bajo `db/prepared/hosted/governed/` con sufijo `.governed.sql`. Se
resuelve con valla y pin **antes** de emitir el comando; si los bytes no
coinciden con `authority:verify`, no hay plan.

Y **antes de psql**, obligatorio, igual que en §4.1:

```bash
pnpm artefact:verify --path=<PACKAGE_PATH> --digest=<PACKAGE_DIGEST>
pnpm identity:verify --attempt=<CHAIN_ATTEMPT_ID> --identity=artifacts/installer-identity.json
```

```
PLAN AUTHORIZED
  → pnpm artefact:verify (PASS)          ¿son éstos los bytes?
  → pnpm identity:verify (PASS)          ¿soy yo quien los va a aplicar?
  → checkpoint humano
  → psql
```

El pin del plan se comprueba cuando el plan se emite; éstos se comprueban cuando
vas a ejecutar. Son dos momentos distintos y la ventana entre ellos es de un
humano — una terminal distinta, un `PGSERVICE` distinto, una variable que se
expande a otra cosa.

### 8.1 El guard, dentro de la misma transacción

Por eso el comando que imprime el plan lleva **dos** `-f`:

```bash
psql "$UELLIX_STAGING_INSTALLER_URL" -X -1 -v ON_ERROR_STOP=1 \
     -f artifacts/hosted-chain-installer-identity-guard.sql \
     -f <PACKAGE_PATH>
```

Bajo `-1` los dos archivos corren en **una sola transacción**, en orden. El guard
es la primera sentencia: si el principal es el correcto no hace nada, y si no lo
es aborta la transacción **antes de que exista un solo objeto que deshacer**. Es
lo único que puede rechazar en el instante de la escritura, y es la única defensa
frente a «medí la identidad por una conexión y escribí por otra».

No está fijado por `artefact:verify`, deliberadamente: manipularlo sólo puede
hacerlo más permisivo, y el gate que decide de verdad es el del plan. No lo
sustituyas por el `-f` a secas «porque ya verifiqué».

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

> **Segundo incidente T1 (Commit 5.6).** Con el artefacto ya corregido, T1 volvió
> a morir:
>
> ```
> PACKAGE_PATH    db/prepared/hosted/governed/grounding_0002_document_versions.governed.sql
> artefact:verify PASS
> ERROR:  permission denied to set role "uellix_cap_grounding"
> session_user = current_user = postgres · rolsuper = f · rolcreaterole = t
> ```
>
> Ni el plan ni el artefacto estaban mal esta vez. `artifacts/t1-prechain.json`
> del intento fallido registra `uellix_migrator {canLogin: true, createRole:
> true}` e `installerCanSetOwner: true`: **la base de datos estaba lista**. Todos
> los gates que existían medían el objetivo, y ninguno había preguntado nunca
> quién sostenía la conexión.
>
> Un gate que mide el destino y nunca al que llama tiene un punto ciego del
> ancho exacto de la terminal del operador. §0.0 y §6.1 son ese punto ciego,
> cerrado.

**T2–T9 no cambian *en lo prechain*.** No tienen ese prerequisito —dependen de
que su predecesor esté `INSTALLED`, que los testigos de cadena ya establecen— y
el gate prechain es inerte para ellos. Se planifican con `--observation` y
`--installer-identity`: la identidad **no** es inerte para ninguno.

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
