# Hallazgos adversariales — el lector de SQL

> **Alcance.** Esta ronda no ataca los paquetes: ataca **al que los lee**.
> Las rondas 1 y 2 ([`ADVERSARIAL_FINDINGS.md`](ADVERSARIAL_FINDINGS.md),
> [`ADVERSARIAL_FINDINGS_ROUND2.md`](ADVERSARIAL_FINDINGS_ROUND2.md))
> buscaban propiedades mal defendidas. Ésta busca **propiedades bien defendidas
> cuya defensa se puede rodear escribiendo lo mismo de otra manera.**
>
> Fecha: 2026-08-04. Unidad `CAPABILITY_PARSER_FAIL_CLOSED_HARDENING`.
> Sin base de datos, sin red, sin stack persistente.

## 1. La forma del defecto

`tests/helpers/sql-structure.ts` enmascaraba comentarios y literales y después
aplicaba expresiones regulares sobre la máscara. Es una arquitectura razonable
hasta que se le hace la única pregunta que importa en un gate de seguridad:

> ¿qué hace cuando **no** encuentra su patrón?

Respondía lo mismo que cuando la propiedad estaba bien: nada. **La ausencia de
match se interpretaba como ausencia de riesgo**, y esa inversión es la causa
raíz única de los ocho hallazgos de abajo. No son ocho errores; son ocho
síntomas.

Los cuatro mecanismos concretos por los que el lector divergía de PostgreSQL:

1. **Divergencia léxica.** Todo patrón de identificador era `[A-Za-z_][\w$]*`.
   PostgreSQL acepta además `"con comillas"`, con `""` como escape, y **suprime
   el plegado a minúsculas** cuando se entrecomilla — de modo que
   `"uellix_cap_lead"` es el mismo rol y `"RoleName"` es otro distinto. Ninguna
   de las dos cosas era expresable.
2. **Cuerpos ejecutables opacos.** Un `$$…$$` se enmascaraba entero para que sus
   `;` y `(` no desincronizasen la sentencia envolvente — necesario — pero eso
   dejaba el DDL de dentro **inexistente**, no ilegible.
3. **Descartes silenciosos.** `if (tailAt === -1) continue`,
   `if (!/^[A-Za-z_][\w$]*$/.test(member)) continue`, `if (!nameM) continue`.
   Una sentencia que el lector no terminaba de leer se convertía en una
   sentencia que no estaba.
4. **Dos modelos de «qué es código».** Comentarios de bloque **no** anidados
   frente a PostgreSQL, que **sí** los anida.

## 2. Las ocho evasiones confirmadas

Medidas contra los gates de `709914b`, sobre los ficheros reales, con la línea
base en `0 violaciones`.

| ID | Grafía | Propiedad que rompe | Mecanismo por el que no se veía | Gate que ahora la refuta |
|---|---|---|---|---|
| **E-01** | `DO $$ BEGIN GRANT SELECT … ; END $$;` | la capacidad *sólo-INSERT* de CAP-04 | el cuerpo se enmascaraba entero | `cap04-no-read`, `grant-extra` |
| **E-01c** | el mismo `GRANT` vía `EXECUTE format(…)` | la misma | sólo se recuperaba `EXECUTE '<literal>'` | `unparsed-security-statement` |
| **E-02** | `TO "uellix_app"` | el `UPDATE` acotado por columnas de CAP-01 | patrón de *grantee* sin comillas | `grant-extra` |
| **E-03** | `GRANT uellix_owner, uellix_writer TO uellix_cap_lead` | el aislamiento del definer, y con él la exención de RLS por propiedad | la lista de miembros exigía un identificador desnudo; se descartaba entera | `role-membership` |
| **E-04** | `ALTER TABLE "public"."t" DISABLE ROW LEVEL SECURITY` | **todas** las policies de la tabla a la vez | `ALTER TABLE ([\w.]+)` no lee un nombre entrecomillado | `rls-disabled` |
| **E-05** | `ALTER ROLE "uellix_cap_stripe" BYPASSRLS SUPERUSER;` como segunda sentencia | los siete atributos negativos que definen al rol | el gate se anclaba al nombre desnudo del rol | `role-attributes` |
| **E-06** | `REASSIGN OWNED BY uellix_owner TO uellix_cap_bootstrap` | la propiedad acotada: re-apropia **todo** el catálogo del dueño | no aparecía en ningún patrón, en ninguna dirección | `ownership-reassigned` |
| **E-07** | `CREATE POLICY "p" ON "public"."t" … TO "r"` | el inventario cerrado de policies | los cuatro identificadores eran ilegibles | `policy-inventory` |
| **E-08** | `/* outer /* inner */ REVOKE …; */` | el único `REVOKE` que hace de CAP-04 una reducción neta | PostgreSQL anida los comentarios de bloque; el enmascarador no | `cap04-net-reduction` |

**Nueve variantes sobrevivían** (las ocho más `DROP OWNED BY`). Dos más —
`ALTER DEFAULT PRIVILEGES … EXECUTE TO PUBLIC` y `NO FORCE ROW LEVEL SECURITY` —
morían, pero por un **gate colateral**: la primera por `grant-extra`, que no
tiene nada que ver con los privilegios por defecto y habría dejado de dispararse
el día que alguien ajustase el contrato de privilegios. Es exactamente el caso
que la regla del `expectedGate` existe para señalar.

## 3. Lo que se construyó

`tests/helpers/sql-structure.ts` es ahora **un lexer y un escáner**, no una
máscara y unos regex.

**Lexer.** Una pasada, con las reglas léxicas de PostgreSQL: identificadores
plegados a minúsculas salvo entrecomillados, `""` como escape, comentarios de
línea, comentarios de bloque **anidados**, `'…'` con `''`, `E'…'` con escapes de
barra invertida (y el prefijo reconocido **sólo** cuando no es la cola de un
identificador), `U&`/`B`/`X`/`N`, y *dollar quoting* con y sin etiqueta. Los
comentarios **dentro** de un cuerpo `$$…$$` se borran, porque ahí son
comentarios: la prosa que describe una regla no puede confundirse con la regla.

**Escáner.** Reconoce aperturas de sentencia **en cualquier posición**, no sólo
tras un `;`. En PL/pgSQL una sentencia empieza también tras `THEN`, `ELSE`,
`LOOP` o `BEGIN`, y anclarse al `;` dejaba
`IF … THEN EXECUTE '…GRANT…'; END IF;` como una sola sentencia cuya primera
palabra era `IF`. Desciende a los cuerpos ejecutables: bloques `DO`, cuerpos de
función y literales llegados por `EXECUTE`. Cada registro lleva su `origin`
(`file` / `do-block` / `function-body` / `executed-literal`).

**Fail-closed.** Toda sentencia que *abre* como operación de seguridad y no
clasifica produce `unparsed-security-statement`, con fichero, línea, origen y
motivo (`unmodelled-form`, `dynamic-sql`, `incomplete-statement`,
`unterminated-body`). No existe camino desde «el lector no entendió esto» hasta
«aquí no hay nada». Casos que ahora **se rechazan** en lugar de ignorarse:

* `EXECUTE format(…)`, `EXECUTE v_sql`, `EXECUTE 'a' || b` — irresolubles desde
  el fichero, y la única lectura segura de una cadena DDL irresoluble es que
  podría ser la peligrosa;
* `ALTER POLICY` — reescribe en sitio una tupla que el contrato fija por su
  `CREATE`;
* `SECURITY LABEL`;
* un `ALTER ROLE` con un atributo que el modelo no conoce;
* un `CREATE POLICY` con una cláusula que el modelo no conoce;
* un `GRANT` sin `TO` (antes: `continue`);
* un `ALTER TABLE` que menciona `OWNER` en una forma que no sabe leer.

Los mensajes llevan **sólo palabras clave**. Nunca un literal: un hallazgo
termina en un log y una sentencia puede llevar un hash de token o una cadena de
conexión.

## 4. Hallazgo propio de esta unidad

El inventario de gates (`ALL_GATE_NAMES`, en `tests/capability-mutation.test.ts`)
se **deriva** casando `add('<literal>'` en el fuente de `capability-gates.ts`,
precisamente para que una lista escrita a mano no pueda omitir un nombre.

Tiene su propio punto ciego, y se materializó aquí: **un gate cuyo nombre se
calcule en tiempo de ejecución no lo ve nadie.** Dos gates escritos como
`add(o.verb === 'REASSIGN' ? 'ownership-reassigned' : 'ownership-dropped', …)`
disparaban correctamente y no figuraban ni en el inventario ni en la lista de
gates sin ejercitar — es decir, eran invisibles justo para la comprobación que
existe para hacer visible un gate no ejercitado.

Cerrado desde el otro extremo: todo gate que se **observe disparar** debe estar
en el inventario derivado, y los dos se reescribieron como llamadas literales.

## 5. El dry-run

`scripts/capability-dry-run.sh`, paso 4, terminaba en:

```
"${PSQL[@]}" -v ON_ERROR_STOP=1 -f /dryrun.sql 2>&1 | tail -n +2 | grep -Ev '…' || true
```

Dos pérdidas que se componen. La tubería entrega el estado de la ejecución a
`grep`, y el `|| true` descarta incluso ése: un `psql` saliendo 3 por
`ON_ERROR_STOP` era indistinguible de uno saliendo 0. Y la única comprobación
posterior preguntaba **cuántas aserciones habían fallado** — de modo que una
ejecución muerta tras treinta aserciones tenía treinta filas, ninguna fallida, y
se reportaba verde.

Corregido: el código de salida real se captura, la salida se examina en busca de
`ERROR:`, y el **recuento** se compara contra 72 y contra 6 de concurrencia. La
fase de teardown pasa de imprimir nueve números a **afirmarlos**.

## 6. La ronda adversarial CONTRA el parser nuevo

Dos revisores independientes de solo lectura, sin escritura y sin base de datos.
El revisor A atacó la semántica PostgreSQL del lector; el revisor B auditó el
arnés de mutación y el dry-run. Entre los dos: **3 BLOCKER, 6 MAJOR, 8 MINOR**,
todos con línea citada. Ninguno exigió imaginación, y los tres BLOCKER son de la
misma familia que las ocho evasiones — una grafía válida que producía SILENCIO.

### Revisor A — semántica PostgreSQL

| ID | Sev | Hallazgo | Corrección |
|---|---|---|---|
| **A-01** | BLOCKER | El decodificador de `E''` conocía sólo salto de línea, tabulador y retorno de carro, y descartaba la barra invertida del resto. `EXECUTE E'\x47RANT …'` se aplica como `GRANT` — `\x47` es la letra G — y el parser leía `x47RANT`, cuya primera palabra no abre nada: **ni sentencia ni hallazgo** | `decodeEscape` implementa las formas de PostgreSQL, incluidas las hexadecimales, octales y Unicode; `U&'…'` se marca **no decodificable**, porque una decodificación aproximada es peor que ninguna: el casi-acierto se relexa como palabra que no abre nada |
| **A-02** | BLOCKER | Un cuerpo de función escrito con comillas simples en vez de *dollar quoting* no se recorría; el gate de `SECURITY DEFINER` tampoco lo veía, porque su regex se ancla en la forma con `$$` | Se desciende a **todo** string de un `CREATE FUNCTION`, y la forma no dollar-quoted se **rechaza**: no es la forma que este contrato modela |
| **A-03** | BLOCKER | Las sentencias de rol sólo se comprobaban para los cinco roles de capacidad. `ALTER ROLE uellix_writer BYPASSRLS;` — que anula `cap_lead_deny_runtime` — y `CREATE ROLE backdoor LOGIN SUPERUSER` se parseaban y no los consumía ningún gate | Gates `role-foreign` y `role-dangerous-attribute` sobre **todos** los ficheros, forward y rollback, y sobre **todos** los roles |
| **A-04** | MAJOR | El tope de anidamiento de `descend()` volvía en silencio: cinco cuerpos ejecutables anidados ocultaban el sexto | Emite `unparsed-security-statement` |

### Revisor B — arnés de mutación y dry-run

| ID | Sev | Hallazgo | Corrección |
|---|---|---|---|
| **B-03** | MAJOR | `capability-mutation-audit.ts` no tenía manejador de señales. Un `Ctrl-C` durante una ejecución de 96 mutaciones deja un mutante en `db/prepared` sin aviso — y la nota de SEGURIDAD del propio script prometía lo contrario | Restauración en `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGBREAK` y en `uncaughtException`, con instrucción de recuperación si la escritura fallara |
| **B-06** | MAJOR | La razón `unterminated-body` estaba declarada y **no se emitía nunca**: un literal o un cuerpo sin cerrar se traga el resto del fichero, y el único respaldo era una paridad de `$$` que no ve una etiqueta ni una comilla simple, y que sólo corría sobre los forward | El lexer registra los no cerrados y `analyzeSecurity` los convierte en hallazgo; `mask-desync` pasa a correr sobre los diez ficheros |
| **B-07** | MAJOR | `CREATE SCHEMA … AUTHORIZATION <rol>` no se leía, y el comentario decía que sí. La propiedad de un esquema confiere `CREATE` y `DROP` sobre todo lo que contiene | Se parsea como ownership y se declara en `OWNERSHIP_CONTRACT` |
| **B-10** | MAJOR | El inventario de gates se deriva casando un literal; un nombre en comillas dobles, con mayúsculas, empujado sin el ayudante o **calculado en ejecución** es invisible para él | Test estructural: toda llamada debe tomar un literal en comillas simples, hay **un** reenviador documentado y contado, y ningún comentario puede contener una llamada fantasma |
| **B-11** | MAJOR | `UNEXERCISED_GATES` declaraba dos razones admisibles y cerraba con «cualquier otra cosa es un agujero con permiso»; por ese criterio **la mayoría de la lista son agujeros** | Comentario reescrito para decirlo, en vez de implicar que son excepciones justificadas |
| **B-13** | MAJOR | Los rollbacks no tenían gate de retirada de policies: un `DROP POLICY` de una policy ajena plantado en un rollback no lo comprobaba nadie | `policy-retired` se extiende a los rollbacks |
| **B-14** | MAJOR | Cuatro de las seis aserciones «concurrentes» se satisfacían con **una sola** sesión: la función de carrera terminaba tragándose el código de salida y corría con `ON_ERROR_STOP=0`, así que una sesión que nunca conectó era indistinguible de una que perdió legítimamente. «El solapamiento está diseñado, no esperado» era una afirmación sin comprobar | Cada sesión marca su sentencia contendida; un caso donde ambas no corrieron registra una fila **FALLIDA** |
| **B-12** | MINOR | `cap05-claim-first` era inalcanzable por construcción: ninguna mutación podía dispararlo, y figuraba en la lista como si sólo le faltara una | Mutación `A-07`, que restaura el modelo `FOR UPDATE`-primero que el gate existe para prohibir |
| **B-04**, **B-05**, **B-09**, **B-15**, **B-16**, **B-17** | MINOR | Medición no interpretable no distinguida de medición limpia; alcance del audit en disco no declarado; retornos silenciosos en el lector de ownership, de índices y de listas de nombres; rutas temporales fijas entre ejecuciones; rótulo del paso 4 en desacuerdo con la constante; cuatro gates documentales tautológicos | Corregidos uno a uno |

**No corregido, y por qué.** El revisor B observa (**B-01**) que el gate de
privilegios es una diferencia de conjuntos, de modo que *cualquier* edición de
una lista de columnas emite `grant-missing` **y** `grant-extra` a la vez: el
`expectedGate` no discrimina entre las dos mitades de esa propiedad. Es cierto y
queda como residual declarado — separarlas exigiría que el arnés comparase el
*detalle* de la violación y no sólo su nombre, y eso es un cambio de contrato
del arnés, no de esta unidad. Y (**B-02**) los gates colaterales inflan el
reparto: se añade una segunda comprobación de distribución sobre el gate
**declarado**, que es la estricta, sin retirar la anterior.

## 7. Lo que sigue abierto

Esta ronda no cierra nada del diseño. Siguen **abiertos**, sin cambios de
severidad:

| ID | Estado |
|---|---|
| **RR-CAP-10** | ABIERTO — precondición bloqueante de CAP-03, degrada CAP-05 |
| **RR-CAP-12** | MITIGADO, no cerrado — 56 de 123 gates sin mutación que los ejercite |
| **RR-CAP-13** | ABIERTO — asimetría de diseño en `sroi_calculation_runs` y `organizations` |
| **RR-CAP-14** | ABIERTO — CAP-03 sin ninguna policy `RESTRICTIVE`; alcance cross-organization |
| **RR-CAP-02-F** | ABIERTO — publicación y revocación sin auditoría; bloquea *habilitar*, no *aplicar* |

Y el residual de fondo no cambia de naturaleza: «0 de 96 supervivientes» sigue
siendo acuerdo entre el catálogo y los gates, dos ficheros escritos por la misma
mano. Lo que ha cambiado es que el lector ya no puede quedarse callado.


---

## Anexo 2026-08-04 — el lector detuvo su propia reparación

Esto no lo encontró un revisor: lo encontró el parser, contra el commit que lo
estaba usando.

El cierre de **RR-CAP-02-F** añade tres `CREATE TRIGGER` a `stella_0007`. El
lector los devolvió como **`unparsed-security-statement`** y
`tests/capability-policy-contract.test.ts` se puso en rojo antes de que ninguna
prueba nueva llegara a ejecutarse. La regla que lo hizo es la misma que este
documento describe: *una sentencia que abre como operación de seguridad y no
clasifica es un hallazgo, no un silencio*. `CREATE TRIGGER` estaba en la lista
de rechazos junto a `CREATE RULE` porque **ningún paquete creaba triggers** y un
trigger sobre una tabla protegida ejecuta código con la autoridad del
propietario.

**La tentación era relajar la negativa a un salto. Habría sido RR-CAP-12b otra
vez**, y por el mismo mecanismo exacto: la ausencia de match interpretada como
ausencia de riesgo. Lo que se hizo en su lugar:

* `ParsedTrigger` modela nombre, tabla, momento, lista de eventos, nivel
  (`ROW`/`STATEMENT`), `WHEN` y la función ejecutada. Cada uno de esos campos es
  una propiedad de seguridad: reapuntar la **tabla** hace que el rastro siga a
  las filas equivocadas; cambiar `AFTER` por `BEFORE` escribe la auditoría de un
  cambio que aún no ha ocurrido; borrar `FOR EACH ROW` convierte un `UPDATE` de
  diez certificados en **un** evento; sustituir la función hace que el trigger
  siga existiendo y registre lo que la nueva función quiera.
* `parseTriggerStatement` **sigue fallando cerrado**: `UPDATE OF <columnas>`,
  `CREATE CONSTRAINT TRIGGER`, `REFERENCING`, un `FOR` que no nombra `ROW` ni
  `STATEMENT`, y un `EXECUTE` ilegible son hallazgos. Hay control negativo por
  cada uno en `tests/capability-policy-parser.test.ts`.
* `DROP TRIGGER` se lee también, porque un rollback que se olvida de uno deja
  código llamando a una función que ese mismo rollback borra.
* `TRIGGER_CONTRACT` fija los tres triggers como tuplas completas, y ocho gates
  nuevos (`trigger-extra`, `trigger-shape`, `trigger-when`, `trigger-missing`,
  `trigger-not-convergent`, `rollback-trigger`, `rollback-trigger-retained`,
  `rollback-trigger-created`) tienen once mutaciones que los ponen en rojo.
* `CREATE RULE` **sigue rechazado sin más**: nada lo usa, y una regla de
  reescritura cambia sobre qué se aplica RLS.

El residual de fondo tampoco cambia aquí: sigue siendo acuerdo entre el
catálogo y los gates. Lo que este anexo añade es una observación sobre el
método, no sobre la cobertura — **el único momento en que un lector fail-closed
demuestra su valor es cuando te detiene a ti**, y la respuesta correcta es
modelar, no silenciar.
