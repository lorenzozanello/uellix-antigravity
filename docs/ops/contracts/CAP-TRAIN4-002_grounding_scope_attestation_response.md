# CAP-TRAIN4-002 — Respuesta a INT-GR-004, INT-CAP-002, INT-CAP-003 e INT-CAP-004

| Campo | Valor |
|---|---|
| **Solicitante** | INTEGRACIÓN (revisión adversarial del tren 3, 2026-08-05) |
| **Propietaria** | CAPABILITIES |
| **Estado** | `aceptado` — **entregado como diseño**. `db/prepared/grounding_0004_runtime_attestation.sql`, no aplicado a ninguna base |
| **Fecha** | 2026-08-05 |
| **Contratos origen** | `docs/ops/contracts/CONTRACT_LEDGER.md` §§ INT-GR-004, INT-CAP-002, INT-CAP-003, INT-CAP-004 |

## 1. INT-GR-004 — el scope viaja en la fila

`chunks_in_scope` devuelve 13 columnas y ninguna es el scope de la fila, así
que el adaptador estampa el scope **que pidió la consulta** y
`enforceRepositoryScope` se compara consigo mismo.

Se publica `uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)`:
mismo filtrado, misma frontera, **17 columnas**. Las cuatro nuevas —
`organization_id`, `project_id`, `evidence_id`, `document_version_id` — se leen
`FROM ch`, nunca de los argumentos.

**Las cuatro no divulgan nada.** Tres son argumentos que el llamante acaba de
pasar; la cuarta la obtuvo de su propio lookup de versión para conseguir el
tercero. Devolverlas no añade información: permite comparar lo pedido contra lo
devuelto, que es justo lo que hoy no se puede.

`evidence_id` es la que más aporta, y no es la que el contrato nombra: deja
detectar un **desacuerdo entre el lookup de versión del adaptador y las filas
de chunk**, que es la clase de defecto que el guard tautológico nunca podría
ver.

### Por qué es una función NUEVA y no la misma con dos columnas más

`CREATE OR REPLACE FUNCTION` **no puede** cambiar el tipo de retorno de una
función (`42P13`, *cannot change return type of existing function*), y
`grounding_0003` crea `chunks_in_scope` con esa misma sentencia. Un paquete que
la sustituyera por `DROP`+`CREATE` bajo el mismo nombre haría que la cadena
forward `0002 → 0003 → 0004`, aplicada por segunda vez, **abortara dentro de
0003**.

La idempotencia de cadena es lo que mide el dry-run y lo que exige el encargo.
El precio elegido es una ruta de lectura deprecada que sigue siendo invocable;
el precio de la alternativa era una cadena que no se puede re-aplicar.

**No se revoca `EXECUTE` sobre `chunks_in_scope`.** Hacerlo rompería un
adaptador que funciona, en el mismo tren en que se prohíbe editarlo: es un
cambio coordinado, no unilateral. La deprecación se marca con `COMMENT ON
FUNCTION`, visible para quien lea el esquema vivo.

**Lo que INTEGRACIÓN tiene que hacer:** cambiar la llamada de
`db/grounding/grounding-chunk-repository.ts` a `chunks_in_scope_attested`, leer
las cuatro columnas en `toGroundingChunk` y comparar contra el scope de la
consulta. Sólo entonces `isSameScope` / `scopeContains` dejan de ser
tautológicas. Esta línea publica el contrato SQL; no toca TypeScript de
integración.

## 2. INT-CAP-002 — la superficie de lectura

El contrato ofrece dos salidas: «añadir el predicado de proyecto, o corregir la
cabecera». Se hace **una tercera cosa que cierra la consecuencia real**, y se
corrige la cabecera.

La consecuencia que INT-CAP-002 describe es que PostgREST expondría los chunks
de toda la organización, saltándose `chunks_in_scope` y su filtro
`canonical_chunk_id IS NULL` — lo único que impide citar un duplicado
suprimido. Un predicado de proyecto en la policy **no lo arregla**: RLS no tiene
noción de «el proyecto que el llamante está mirando», así que cualquier
predicado que se escriba ahí es implicado por el filtro de organización y no
estrecha nada.

Lo que sí lo cierra: **`authenticated` no lee esta tabla**. Nada en el
repositorio la lee por esa vía — el adaptador conecta como `uellix_app`. Así
que se revoca el `SELECT` y se re-crea `evidence_chunks_select` sin ese rol.

Corrección de la cabecera: se emite como `COMMENT ON POLICY`, que vive en la
**base** y no sólo en el fuente. Dice lo que la policy hace — aislamiento de
organización, no de proyecto — y dónde reside la frontera de proyecto.

> **Nota sobre la policy `RESTRICTIVE`.** `evidence_chunks_scope_consistency`
> sigue nombrando `authenticated` y se deja así a propósito: una policy
> restrictiva se **conjunta** y sólo puede estrechar, así que nombrar a un rol
> ahí no concede nada. Exigir cero de las dos habría obligado a reescribir una
> policy de `grounding_0003` para satisfacer una aserción que mide la propiedad
> equivocada.

## 3. INT-CAP-003 e INT-CAP-004 — tres CHECK, no tres triggers

| Contrato | Constraint | Qué afirma |
|---|---|---|
| INT-CAP-003 | `evidence_chunks_content_hash_derivation_check` | `content IS NULL OR content_hash = encode(sha256(convert_to(content,'UTF8')),'hex')` |
| INT-CAP-003 | `evidence_chunks_span_length_check` | `length(content) <= char_end - char_start <= 2 * length(content)` |
| INT-CAP-004 (2) | `evidence_chunks_chunk_id_derivation_check` | `chunk_id` = SHA-256 de la preimagen del contrato |

**Por qué CHECK y no trigger.** Un CHECK ata al **dueño de la tabla**, que es
justo el adversario que INT-CAP-004 nombra, y a diferencia de un trigger no se
puede silenciar con `session_replication_role = replica` — el residual que esta
campaña ya tenía documentado para las FK compuestas. Todas las funciones que
usan (`encode`, `sha256`, `convert_to`, `length`, el cast `int4→text`) son
`IMMUTABLE`, que es lo que las hace legales en un CHECK.

**La cota del span es de dos lados, no una igualdad, y eso importa.**
`char_start`/`char_end` los produce `String.prototype.slice` de JavaScript, que
indexa **unidades de código UTF-16**; `length(text)` de PostgreSQL cuenta
**puntos de código**. Dentro del BMP coinciden; todo carácter fuera de él
(emoji, escrituras históricas, extensiones CJK) es un punto de código y **dos**
unidades. Una igualdad rechazaría un pasaje legítimo con un emoji, y una
constraint que falla sobre datos válidos enseña a un operador a quitarla. La
cota es tensa para texto BMP y sigue rechazando el ataque que INT-CAP-003
describe: un span de miles de caracteres para un pasaje de diez.

**INT-CAP-004 (1) — el rollback.** `grounding_0003_rollback.sql` anida sus tres
`DROP FUNCTION` dentro del `ELSE` de «si la tabla existe». Este paquete **no
edita ese fichero** (su evidencia de gate está atada a su texto), pero los dos
rollbacks de Train 4 sacan sus `DROP FUNCTION` de toda rama condicional, y el
gate `rollback-function-drop-unconditional` lo comprueba recorriendo la
profundidad `IF`/`END IF` — no por coincidencia de cadena. La reparación de
`grounding_0003_rollback` queda **abierta y registrada** en §6.

## 4. Hallazgo nuevo de Train 4: el rol de capacidad no leía nada

**No lo encontró una lectura del SQL. Lo encontró invocar la función con filas
sembradas.**

`uellix_cap_grounding` tiene `SELECT` sobre las dos tablas de grounding
(`grounding_0002` §5, `grounding_0003` §5) y **no está nombrado por ninguna de
las dos policies permisivas de SELECT**. No tiene `BYPASSRLS` y no es dueño de
ninguna de las dos tablas, así que RLS se le aplica entera y **toda lectura
devuelve el conjunto vacío**.

No es la degradación de una función. Es la superficie gobernada completa:

| Función | Comportamiento real antes de esta reparación |
|---|---|
| `chunks_in_scope` | 0 filas para todo llamante |
| `chunks_in_scope_attested` | habría hecho lo mismo |
| `finalize_document_ingestion` | cuenta 0 chunks almacenados → `U0103` en cada llamada |
| `claim_active_document_version` | nunca encuentra una versión → `U0102` en cada llamada |
| `register_document_version` | nunca ve la versión existente (no detecta re-registro) ni la anterior (`ordinal` siempre 1, `supersedes_version_id` siempre NULL) → **la versión 2 de cualquier documento es inalmacenable** contra `UNIQUE (evidence_id, ordinal)` |

Es la misma clase que el hallazgo del tren 2 —el definer no tenía privilegio
sobre `evidence_items` y toda llamada moría con 42501— y estrictamente peor:
**un GRANT ausente lanza; una POLICY ausente calla.** Un dry-run estructural no
puede ver ninguno de los dos, que es por qué éste siembra filas y llama a las
funciones.

**Reparación:** las dos policies de SELECT se re-crean bajo sus propios nombres
con el mismo predicado y un rol más. Reemplazo y no adición, y eso es forzado:
`grounding_0002` §9 afirma **exactamente 3** policies en la tabla de versiones y
`grounding_0003` §9 **exactamente 4** en la de chunks; una quinta haría que
re-aplicar cualquiera de los dos fallara su propia postcondición.

Añadir el rol **no ensancha** lo que un usuario alcanza: el predicado no cambia
y `current_user_org_ids()` lee el `auth.uid()` del **llamante** —
`SECURITY DEFINER` cambia el rol que ejecuta, no las claims de la sesión. El
definer ve exactamente las organizaciones del llamante, y la comprobación
explícita dentro de cada función pasa a estar respaldada por RLS en vez de
sostenerse sola.

Verificado en vivo: `scripts/stella-train4-dry-run.sh` §7 —
`scope_lector_0003_filas=1` y `finalize_cuenta_correcta=OK`, ambas a través del
mismo rol.

## 5. Evidencia

- **Estática:** `tests/train4-persistence-mutation.test.ts` — 60 mutaciones, gate declarado por propiedad, baseline limpio.
- **Viva:** `scripts/stella-train4-dry-run.sh` en contenedor desechable sin red:
  - §7 — scope pedido comparado contra scope devuelto fila a fila (`scope_fuera_de_alcance=0`), proyecto cruzado (0 filas), evidencia de otro tenant (0 filas), organización cruzada (`U0102`).
  - §8 — con `SET ROLE uellix_owner`, donde RLS no llega: `chunk_id` forjado, `content_hash` que no deriva de `content`, y span absurdo → los tres `23514`; y el **control positivo**, una fila bien derivada que sí entra. Sin él, los tres rechazos serían igual de compatibles con «el CHECK rechaza todo».
- **Convergencia:** aplicar ×2 idéntico, rollback == baseline, reaplicar == aplicado. `grounding_0003` sigue siendo re-aplicable con `grounding_0004` puesto (§12).

## 6. Abierto hacia esta línea, no cerrado en este tren

1. **`grounding_0003_rollback.sql` sigue con sus tres `DROP FUNCTION`
   condicionados a la existencia de la tabla** (INT-CAP-004 (1)). Repararlo
   exige editar un fichero cuyo texto es el ancla de once mutaciones del arnés
   del tren 3; se hace en un paquete propio con su re-anclaje, no de paso.
2. **`chunks_in_scope` sigue invocable por `uellix_app`.** Se revoca cuando el
   adaptador haya migrado (§1).
3. **Las FOREIGN KEY internas siguen respetando `session_replication_role`.**
   Riesgo de superusuario ya aceptado y documentado por integración en el tren
   3; los tres CHECK nuevos de este paquete **no** comparten esa debilidad.
