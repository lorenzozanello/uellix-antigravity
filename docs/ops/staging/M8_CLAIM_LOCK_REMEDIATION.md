# M-8 — el candado que `claim_active_document_version` no podía tomar

> **SUPERADO POR LA EJECUCIÓN — 2026-08-12.** T10 se aplicó en staging (10/10
> `INSTALLED`) y M-8 quedó cerrado **por invocación real**, no por catálogo:
> `M8_RUNTIME = PASS`, `SQLSTATE = U0102` bajo `session_user = current_user =
> uellix_app`. Ver [`M8_RUNTIME_CLOSEOUT.md`](./M8_RUNTIME_CLOSEOUT.md).
>
> Lo que sigue se conserva **verbatim** como el registro del defecto, su análisis
> y su remediación en el momento en que se escribieron. El «Estado» de abajo era
> cierto entonces y no se reescribe: un documento de diseño corregido a posteriori
> deja de decir qué se sabía al decidir.

**Estado: REPARADO EN EL REPOSITORIO, NO INSTALADO EN NINGUNA BASE.**
`db/prepared/grounding_0005_claim_advisory_lock.sql` está escrito, derivado,
firmado y certificado contra PostgreSQL 17.6 desechable. **Staging sigue en
9/10**: el paquete no se ha aplicado allí y este documento no lo autoriza.

---

## 1. El defecto

`uellix_grounding.claim_active_document_version` derivaba el scope del llamante
de la fila de evidencia, y la tomaba bajo candado:

```sql
SELECT e.organization_id INTO v_org
FROM public.evidence_items e
WHERE e.id = p_evidence_id
FOR UPDATE;
```

PostgreSQL exige privilegio **UPDATE** sobre una tabla para tomar un **candado
de fila** en ella, no sólo `SELECT`. `grounding_0002` §219 concede a
`uellix_cap_grounding` exactamente un privilegio sobre esa tabla:

```sql
GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;
```

y el propio paquete es explícito en que eso es deliberado. Resultado medido:
toda llamada del principal de runtime moría con `42501`,
«permission denied for table evidence_items», **antes de leer una sola
versión**. El lado de escritura del corpus gobernado estaba funcionalmente
muerto.

### La asimetría es la prueba

El mismo `grounding_0002` encontró este defecto en la función **hermana**
`register_document_version` durante la revisión adversarial del tren 2, lo midió
en un contenedor desechable y sustituyó el candado de fila por
`pg_advisory_xact_lock` (§765-787). **La reparación nunca alcanzó a
`claim_active_document_version`**, y el `COMMENT ON FUNCTION` siguió afirmando
que ambas tomaban «el mismo candado de fila» — falso desde el momento en que la
hermana dejó de tomar uno.

---

## 2. Lo que la instalación hizo bien, y lo que no podía ver

Esto importa decirlo con precisión, porque la conclusión fácil —«el gate
post-instalación falló»— es falsa y llevaría a endurecer lo que ya funcionaba.

**La instalación y su validación fueron CORRECTAS respecto de los bytes
fijados.** La cadena 9/9 se aplicó, cada paquete verificó sus propias
postcondiciones, el catálogo se leyó objeto por objeto, y todo lo que el gate
afirmó era cierto: las funciones existen, los propietarios son los declarados,
los ACL son los declarados, las membresías temporales quedaron en cero.

**Lo que apareció después es una incompatibilidad FUNCIONAL dentro de esos
mismos bytes**, y sólo se manifiesta cuando el principal de aplicación
—`uellix_app`, a través del rol de capacidad— **ejecuta** la función. Un gate
que inspecciona estructura sin **invocar** no puede verla. El propio
`grounding_0002` lo había escrito, en el comentario de la reparación de su
hermana:

> «a dry-run that inspects structure without INVOKING the functions cannot see
> that»

**Y una segunda cosa la ocultó:** el E2E sembraba el corpus con
`supabase_admin`, que es superusuario y **no evalúa privilegios**. La batería
medía por tanto un recuperador sano sobre un escritor muerto, y pasaba.

> **No se reescribe la historia.** El gate post-instalación no probó un camino
> de ejecución que no estaba escrito para probar, y no había ningún consumidor
> de aplicación que lo recorriera. Exigirle retroactivamente que lo detectara
> sería inventar una obligación que nadie le dio. Lo que sí queda como regla es
> la de arriba, y ya está aplicada: **el corpus del E2E ya no se siembra con
> superusuario.**

---

## 3. Cómo se encontró y cómo se confirmó

| | |
|---|---|
| **Encontrado** | Al cablear G-01, el primer camino de aplicación que ESCRIBE en el corpus. Commit `d5a5b3b` lo dejó **medido y no reparado** (SQL gobernado estaba fuera de su alcance) y fijó el 42501 en el E2E §17-18, con la nota de que esas pruebas fallarían el día que un paquete lo reparase. |
| **Confirmado** | Revisión adversarial independiente (Fable): dos reproducciones, `GRANT UPDATE` rechazado con cuatro razones medidas, y búsqueda de clase con resultado `SAME_FAILURE_CLASS_OCCURRENCES = 1`. |
| **Re-confirmado aquí** | Análisis propio del repositorio: cada `FOR UPDATE` de la cadena mapeado a su función contenedora y al rol que la ejecuta. Los otros once bloquean `uellix_stella_ops.operation_tickets`, y `stella_0014` L1385 concede `SELECT, INSERT, UPDATE` sobre esa tabla a `uellix_cap_stella_ticket`. Se comprobaron además las otras formas de candado (`FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`, `LOCK TABLE`): las únicas ocurrencias de `LOCK TABLE` están en scripts de rollback, ejecutados por el instalador, fuera de la cadena. **Un solo miembro de la clase.** |

---

## 4. La remediación

`grounding_0005_claim_advisory_lock` — **T10**, forward-only, el décimo eslabón.

Republica **en el sitio** `uellix_grounding.claim_active_document_version(uuid)`
con la misma firma, tipo de retorno, propietario, ACL, `SECURITY DEFINER` y
`search_path=''`, sustituyendo el candado de fila por

```sql
PERFORM pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0));
```

que es **la misma clave** que toma `register_document_version`. Corrige además
el `COMMENT ON FUNCTION` que afirmaba lo contrario.

**No concede UPDATE**, y no podría hacerlo por accidente: su §0 **aborta** si
`uellix_cap_grounding` ya lo tiene, y su §2 vuelve a afirmar que no lo tiene
después del cambio.

### Lo que deliberadamente NO emite

Ni `ALTER FUNCTION … OWNER TO`, ni `REVOKE ALL … FROM PUBLIC`, ni
`GRANT EXECUTE … TO uellix_app`. `CREATE OR REPLACE FUNCTION` **conserva**
propietario y ACL, así que los tres serían no-ops en el caso normal — y en el
caso que importa serían peores que no-ops: repararían en silencio una propiedad
o un grant que hubiera derivado, y el paquete reportaría éxito sobre una base
cuya postura habría cambiado sin decirlo. La §2 los **mide** con `aclexplode()`
en vez de re-emitirlos.

### La ventana de autoridad

Dos ventanas CAPABILITY de una sentencia cada una, derivadas por el planificador
canónico (`db/hosted/authority/forward-boundaries.ts`), no escritas a mano:

| Ventana | Sentencia | Membresía temporal | CREATE temporal |
|---|---|---|---|
| W52.S1 | `CREATE OR REPLACE FUNCTION claim(uuid)` | `uellix_cap_grounding` | `uellix_grounding` |
| W53.S1 | `COMMENT ON FUNCTION claim(uuid)` | `uellix_cap_grounding` | — |

Van separadas a propósito. El segmentador concede CREATE a **todo** el segmento
cuando cualquiera de sus miembros crea algo, así que una sola ventana de dos
sentencias habría mantenido `CREATE ON SCHEMA uellix_grounding` abierto mientras
se escribía un comentario. Dos ventanas cuestan un ciclo extra de apertura y
cierre, y dejan el grant acotado a la única sentencia que no puede proceder sin
él. Es el mismo molde que T8/W44 y T9/W49.

**Cero topología persistente nueva.** Estado final medido: `TEMP_MEMBERSHIPS=0`,
`TEMP_CREATE_GRANTS=0`, propietario sin cambios, ACL sin cambios, postura
SELECT-only sin cambios.

### Sin rollback, y por qué no es una omisión

Lo que este paquete retira es un **defecto**, no una prestación: «restaurar la
versión anterior» y «republicar un candado que ningún principal puede tomar» son
la misma frase. Es el razonamiento que `stella_0016` y `stella_0017` ya
registran para R1 y R6-INT. La ausencia está **tipada** en
`db/hosted/forward-only-packages.ts` con su motivo, no dejada a la lectura, y
`tests/prepared-sql-source-of-truth.test.ts` la exige allí.

El fallo **en vuelo** es otra cuestión y sí está medido: ver §5.

---

## 5. Lo medido, no lo razonado

**Certificación PG 17.6** (`pnpm certify:pg176`, contenedor desechable,
`--network none`, un paquete por transacción):

```
verdict = COMPLETE
chain   = 10/10 INSTALLED
```

**Quince inyecciones de fallo**, cinco de ellas nuevas y todas dentro de T10, en
cada frontera de autoridad que el paquete abre:

| Id | Punto de muerte |
|---|---|
| F11 | tras el `GRANT CREATE` temporal, sin membresía todavía |
| F12 | tras la membresía temporal, con CREATE ya abierto |
| F13 | **tras REEMPLAZAR el cuerpo de la función**, con ambos privilegios abiertos |
| F14 | tras devolver CREATE, con la membresía **todavía abierta** |
| F15 | dentro de la SEGUNDA ventana, que tiene membresía y **no** tiene CREATE |

Resultado de las quince: `failed=true rolledBack=true tempMem=0 tempCreate=0
owners=restored prior=intact`.

> **F13 es la que ninguna inyección anterior cubría.** Todos los demás paquetes
> de la cadena **crean** objetos, así que un rollback correcto se veía como un
> objeto desapareciendo. Aquí el objeto existe **igual** antes y después; lo que
> tiene que deshacerse es un **cuerpo**. Una implementación que dejara el cuerpo
> nuevo detrás pasaría todos los witnesses de «el paquete está ausente» de este
> harness, porque esos miden objetos.

**E2E de recorrido completo** — el corpus de A4 **no se siembra**; todo lo que
existe bajo esa evidencia lo escribió `uellix_app` a través de las funciones
gobernadas. Se mide la cadena entera: ingesta → T1/T2 → recuperación atestada →
respuesta fundamentada → ticket y cuota liquidados, más la aserción negativa
`has_table_privilege('uellix_cap_grounding','public.evidence_items','UPDATE') =
false` y la igualdad del dominio de candado entre `register` y `claim`.

---

## 6. Un defecto propio, encontrado por la certificación

La primera versión del paquete **no instaló**: su §0 abortaba con
«does not carry `SET search_path = ''`» sobre una función que sí lo lleva.

PostgreSQL 17.6 almacena el valor vacío **entrecomillado** en `proconfig`
(`search_path=""`), no en la forma desnuda que la precondición asumía.
`grounding_0002` §9 ya lo había medido y lo documenta; la precondición lo dio
por supuesto. Acepta ahora las dos formas.

Se registra porque es la misma clase que M-8, una vuelta más arriba: **una
comprobación de seguridad que falla por su propia forma y no por la propiedad
que mide**. Habría instalado limpio en cualquier motor que use la forma desnuda
y habría abortado en staging.

---

## 7. Consecuencia sobre la evidencia grabada

Añadir un décimo paquete cambia lo que el runner puede planificar, y eso alcanza
a un artefacto ya registrado.

`artifacts/hosted-a1-corroboration.json` es la **medición** que un operador tomó
contra staging el 2026-08-11, antes de aplicar la cadena. Observó **nueve**
paquetes porque nueve existían. **No se toca**: añadirle una décima observación
sería fabricar una medición —una sesión de operador, fechada antes de que
`grounding_0005` se escribiera, reportándolo ausente—.

Lo que sí se recomputó es el **veredicto derivado**
(`artifacts/hosted-a1-status.json`, cuyo propio encabezado dice
`generatedBy: pnpm a1:status:write`), y su respuesta cambió:

```
checkpointPassed: false
blocker: HOSTED_PROBE_MISSING — no probe result supplied for
         grounding_0005_claim_advisory_lock, which supersedes
         grounding_0002_document_versions
warning: this corroboration covers 9 of 10 chain packages; grounding_0005
         did not exist when it was measured and is therefore NOT covered
```

**Esto es el sistema funcionando, no una regresión.** Planificar la aplicación
de `grounding_0002` exige saber si su sucesor está instalado, y nadie lo ha
mirado. «No sondeado es desconocido, no ausente.» El checkpoint A1 de staging
requiere una **medición nueva** antes de poder planificar la cadena de diez.

La cadena observada queda declarada en `A1_OBSERVED_CHAIN` con una guarda que
exige que sea **prefijo** de la cadena declarada: un prefijo no puede saltarse un
paquete, ni reordenarlo, ni nombrar uno que la cadena nunca tuvo.

---

## 8. La supersesión que faltaba

Hallazgo propio, no reportado por la revisión externa:

**Re-aplicar `grounding_0002` sobre `grounding_0005` republica el `FOR UPDATE` y
reabre M-8.** `grounding_0002` es idempotente, así que volver a ejecutarlo solo
**funciona** — y ninguna firma cambia, así que ningún witness, ninguna
comprobación de aridad y ninguna postcondición posterior lo notaría. Es R2a en
una tercera forma, y la más silenciosa de las tres.

La regla está en `db/prepared-package-order.ts`. Su sonda es la primera del
registro que no es una llamada a `to_regprocedure`: lee el **cuerpo** de la
función, quitándole los comentarios primero — porque `pg_get_functiondef`
devuelve la fuente verbatim y el cuerpo de `register_document_version` explica su
propia reparación nombrando los tokens que se buscan. Una sonda sobre el texto
crudo respondería «sí, advisory» para una función que sigue tomando el candado
de fila, en el único sitio donde un falso positivo hace que el runner **permita**
la regresión que existe para rechazar.

Consecuencia operativa: si la unidad de grounding se re-aplica entera
(`0002 → 0003 → 0004`), hay que aplicar `grounding_0005` **inmediatamente
después, en la misma ventana**.

---

## 9. Estado

| | |
|---|---|
| `EXISTING_T1_MODIFIED` | **false** — ni un byte de `grounding_0002` |
| `EXISTING_GOVERNED_BYTES_CHANGED` | **false** — los nueve `.governed.sql` regeneran con digests idénticos |
| `NEW_FORWARD_PACKAGE_ADDED` | **true** — T10 |
| `GOVERNED_PLAN_DIGEST` | `19a0ff5a…` → `a889a726…` (el plan cubre 53 ventanas y 61 segmentos; **11 transferencias, sin cambio**) |
| Cadena gobernada | **10** paquetes + bootstrap = **11** artefactos hosted |
| Instalado en staging | **NO.** 9/10. Este documento no autoriza el décimo. |
| Banderas | sin cambios, todas en false |
