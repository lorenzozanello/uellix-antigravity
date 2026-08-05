# GR-CAP-001 — Respuesta de CAPABILITIES a GR-001 y GR-002

| Campo | Valor |
|---|---|
| Emisor | CAPABILITIES (`codex/stella-capabilities`), tren 2 |
| Responde a | [GR-001](GR-001_evidence_chunks_provenance.md) · [GR-002](GR-002_document_version_history.md) |
| Solicitante original | GROUNDING (`codex/stella-grounding`) |
| Estado declarado | **`IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE`** |
| Fecha | 2026-08-04 |

> **Este documento no modifica `CONTRACT_LEDGER.md`.** El estado del ledger lo
> fija integración (§8 de la gobernanza), no la línea propietaria. Aquí queda la
> respuesta técnica; GR-001 y GR-002 siguen `solicitado` en el ledger hasta que
> integración los evalúe. **No están `aceptado` y esta línea no puede
> declararlos así.**

---

## 1. Qué se entrega

| Paquete | Rollback | Objeto principal | Contrato |
|---|---|---|---|
| `db/prepared/grounding_0002_document_versions.sql` | `grounding_0002_rollback.sql` | `public.evidence_document_versions` | GR-002 |
| `db/prepared/grounding_0003_evidence_chunks.sql` | `grounding_0003_rollback.sql` | `public.evidence_chunks` | GR-001 |

**Ninguno aplicado a ninguna base de datos.** Ningún acceso a remoto, ningún
stack persistente levantado, ninguna bandera habilitada.

Orden forward: `stella_0004` (roles) → `grounding_0002` → `grounding_0003`.
Orden rollback: `grounding_0003` → `grounding_0002`.

---

## 2. `grounding_0001` queda supersedido

**No fue una decisión de estilo, y no era ampliable.** Tres razones, en orden de
peso:

1. **`UNIQUE (evidence_id, chunk_index)` es incompatible con GR-002, no sólo
   incompleta.** Con historia de versiones, la versión 2 de un documento
   colisiona con la 1 en `chunk_index = 0`: la segunda versión es
   **inalmacenable**. GR-001 no nombra este defecto; apareció al comparar las
   dos solicitudes entre sí. El alcance correcto es
   `(document_version_id, chunk_index)`, y la §2 del propio `grounding_0001` se
   niega —con razón— a soltar una garantía de unicidad.
2. **Su guarda de forma aborta ante columnas faltantes.** Es el comportamiento
   correcto, y por eso las seis columnas de GR-001 §2 no pueden añadirse con un
   `ALTER` posterior sin editar también la guarda: en ese punto el archivo es
   otro paquete llevando el número y la evidencia de gate del anterior.
3. **Acopla al gate G5 P3 (pgvector), que sigue sin decidirse**, mientras
   GR-001 §4 deja el trabajo vectorial fuera de la solicitud. `grounding_0003`
   **no usa pgvector**: `SET search_path = public` a secas, sin `CREATE
   EXTENSION`, sin tipo `vector`, sin índice ANN. Persistir provenance ya no
   espera a una decisión de retrieval de la que no depende.

El archivo se conserva **byte a byte** bajo un banner de comentario (el addendum
G2 lo referencia por nombre y `lib/grounding/__tests__/prepared-sql.test.ts`,
propiedad de GROUNDING, fija su contenido: 27 passed con el banner puesto). Si
alguien lo aplicó, `grounding_0001_rollback.sql` va **antes** de
`grounding_0003`, cuya guarda detecta la constraint heredada y lo dice por
nombre.

---

## 3. GR-001 — criterio de aceptación §5

> «GROUNDING considera el contrato aceptado cuando `db/prepared/` contiene una
> forma de `evidence_chunks` que incluye al menos las seis columnas de §2, y su
> guarda de forma las exige.»

Las seis, `NOT NULL`, y exigidas por la guarda:

| GR-001 §2 | Columna entregada | Tipo |
|---|---|---|
| `chunk_id` | `chunk_id` | `char(64)` |
| `version_id` | `version_id` | `char(64)` |
| `raw_content_hash` | `raw_content_hash` | `char(64)` |
| `normalized_content_hash` | `normalized_content_hash` | `char(64)` |
| `normalization_version` | `normalization_version` | `varchar(32)` |
| `chunker_version` | `chunker_version` | `varchar(32)` |

Las tres secciones **recomendadas** también se entregan: `project_id` (§2.1),
`signals` + `injection_scanner_version` (§2.2) y `embedding_provider_id` (§2.3).

`UNIQUE (evidence_id, version_id, content_hash)` de §3 se entrega como **índice
único parcial** `WHERE canonical_chunk_id IS NULL` — ver §5.3.

---

## 4. GR-002 — forma entregada

Las nueve columnas solicitadas, más tres.

| GR-002 §2 | Entregado |
|---|---|
| `id`, `organization_id`, `evidence_id`, `version_id`, `raw_content_hash`, `normalized_content_hash`, `normalization_version`, `ordinal`, `supersedes_version_id`, `created_at` | igual |
| `UNIQUE (evidence_id, version_id)` · `UNIQUE (evidence_id, ordinal)` | igual |

Añadidas: `project_id`, `extractor_version`, `chunker_version`, `mime_type`.
Añadida además `UNIQUE (evidence_id, supersedes_version_id)` — ver §5.2.

---

## 5. Desviaciones respecto de lo solicitado, y por qué

Cinco. Cada una es una decisión, no una omisión.

### 5.1 `project_id` es `NOT NULL`, no nulable

GR-001 §2.1 propone `project_id uuid NULL`, «nulo = evidencia de alcance
organizacional». **Ese caso no existe:** `evidence_items.project_id` es
`NOT NULL` en `db/schema.ts`. Una columna nulable invitaría a una fila que
ninguna pieza de evidencia puede producir, y obligaría a todo predicado con
alcance de proyecto a llevar una rama `OR IS NULL` que sólo puede **ensanchar**
la frontera.

Si GROUNDING necesita evidencia sin proyecto, es un cambio en `evidence_items` y
un contrato aparte, no una columna nulable aquí.

### 5.2 `UNIQUE (evidence_id, supersedes_version_id)` y el check de raíz

GR-002 no los pide. Sin ellos, **«una única versión activa» no es demostrable**:
dos registros concurrentes pueden declararse ambos sustitutos de la versión N y
la historia se bifurca.

La alternativa habitual —una columna `is_active boolean`— exige un `UPDATE` para
mover la bandera, y `UPDATE` es exactamente lo que una tabla append-only no
acepta. Así que la actividad es **derivada**, y cuatro constraints la vuelven
total:

```
UNIQUE (evidence_id, ordinal)                 -- no hay empates de rango
UNIQUE (evidence_id, version_id)              -- reingerir los mismos bytes es idempotente
UNIQUE (evidence_id, supersedes_version_id)   -- una versión se reemplaza a lo sumo una vez
CHECK  ((ordinal = 1) = (supersedes_version_id IS NULL))  -- exactamente una raíz
```

La historia es entonces una cadena **lineal y enraizada**, y «la versión activa»
es `max(ordinal)`, única por la primera constraint. Cero `UPDATE`.

### 5.3 La deduplicación es un índice único **parcial**, no una constraint

GR-001 §3 pide `UNIQUE (evidence_id, version_id, content_hash)`. Se entrega con
predicado `WHERE canonical_chunk_id IS NULL`, y el predicado es el punto: una
ocurrencia suprimida **comparte** `content_hash` con el chunk que sobrevivió
—eso es lo que significa «duplicado»—, así que una constraint total volvería la
relación de deduplicación inalmacenable y todo reindexado de un documento con
encabezado repetido fallaría.

Restringida al conjunto canónico, la garantía es exactamente la que GR-001
describe: **a lo sumo un chunk recuperable por (evidencia, versión, contenido)**.

Correlato: una ocurrencia suprimida **no guarda texto**. `content` es `NULL`
exactamente cuando `canonical_chunk_id` no lo es, por un `CHECK` bicondicional.
Una ocurrencia suprimida es una *localización*, no un pasaje: su texto es
idéntico al canónico por definición, y duplicarlo sería duplicar texto privado
sin ganancia informativa.

### 5.4 `extractor_version` — una columna que ningún contrato pide

**El hueco que ninguna de las dos solicitudes nombra.** `versionId` se deriva de
`(evidenceId, rawContentHash)` únicamente. El extractor **no está en esa
preimagen**, así que un cambio de extractor produce un
`normalized_content_hash` distinto **bajo el mismo `version_id`**. Con
`UNIQUE (evidence_id, version_id)`, la reingesta sería descartada como réplica y
los offsets almacenados quedarían obsoletos **sin señal alguna**.

Con la columna, `register_document_version` puede distinguir réplica de cambio
de pipeline y **levanta `U0101`** en vez de devolver el id anterior.

> **Petición de vuelta a GROUNDING.** `lib/grounding/contracts/core.ts` publica
> `NORMALIZATION_VERSION`, `CHUNKER_VERSION` e `INJECTION_SCANNER_VERSION`, pero
> **no** un `EXTRACTOR_VERSION`. La columna existe y es `NOT NULL`: quien llame
> debe declarar algo. Publicar la constante convierte «algo» en un valor
> gobernado. `tests/grounding-persistence-contract.test.ts` fija su ausencia
> actual, de modo que el día que aparezca la prueba falla y este documento se
> revisa.

### 5.5 `mime_type`, y ninguna otra metadata

«Metadata mínima y no sensible» es exactamente una columna: el tipo MIME
normalizado, que selecciona qué contrato de extracción aplica cuando un tercero
re-deriva los chunks y no puede transportar texto de usuario.

El **`sourceLabel`** de `ProvenanceRecord` (nombre de archivo o URL) **no se
almacena**: es texto suministrado por el usuario que rutinariamente lleva datos
personales, y nada de la cadena de verificación lo necesita.

---

## 6. Aislamiento, ACL y RLS

Ningún rol puede leer chunks de otra organización ni de otro proyecto, insertar
con scope inconsistente, cambiar hashes tras la inserción, reasignar un chunk,
eliminar provenance ni modificar la historia de versiones. Cómo:

| Propiedad | Mecanismo |
|---|---|
| Aislamiento por organización | policy `SELECT` acotada por `current_user_org_ids()`, con cláusula `TO` explícita |
| Aislamiento por proyecto | `project_id NOT NULL` + policy `RESTRICTIVE FOR ALL` que ata la fila a su padre por `(organization_id, project_id, evidence_id)` |
| Scope consistente en inserción | policy `INSERT` `TO uellix_cap_grounding` con `WITH CHECK` contra `evidence_items` / la fila de versión, **y** derivación del scope dentro del definer |
| Hashes inmutables | trigger `BEFORE UPDATE` en ambas tablas → `public.uellix_forbid_mutation()`, que alcanza **también al owner** |
| Provenance no borrable | cero `GRANT DELETE/UPDATE/TRUNCATE` sobre `evidence_document_versions`, para cualquier rol; trigger `BEFORE TRUNCATE FOR EACH STATEMENT` |
| Historia inmodificable | append-only por ausencia de policy **y** por trigger |

**Sin `service_role` en ninguna parte. Sin `SELECT` amplio para resolver joins:**
un lector que necesita la versión de un chunk lee la tabla de versiones, que
tiene su propia policy con la misma frontera. Ensanchar el grant de una tabla
para que la consulta de otra sea cómoda es cómo una frontera se vuelve
decorativa.

`REVOKE ALL` precede a todo `GRANT` sobre las dos tablas y para los siete
principales. Enumerar privilegios a revocar pierde en silencio lo que añada una
versión futura de PostgreSQL o del bootstrap de Supabase — ese excedente
(`Dxtm` a `authenticated`) es el que dejó cuatro tablas de auditoría
`TRUNCATE`-ables y obligó a `stella_0002b`.

### Rol y esquema

`uellix_cap_grounding` (NOLOGIN, NOBYPASSRLS, **cero miembros**) posee las cinco
funciones `SECURITY DEFINER`. Cero miembros es la propiedad que impide alcanzar
el camino de escritura por `SET ROLE` desde una cadena de conexión real —
`uellix_migrator` es un rol `LOGIN` que ya alcanza `uellix_owner`.

Esquema propio `uellix_grounding`, **no** `uellix_capability`: los cinco
rollbacks de la campaña de capacidades eliminan ese esquema en cuanto queda
vacío, y compartirlo habría acoplado el orden de reversión de este paquete a una
campaña de la que no depende.

---

## 7. Funciones

Cinco, todas `SECURITY DEFINER` con `search_path = ''`, argumentos validados
antes de leer nada, scope derivado o comprobado, **cero SQL dinámico**, **cero
`SELECT *`** en el resultado, `REVOKE ALL … FROM PUBLIC` seguido de
`GRANT EXECUTE … TO uellix_app`, y errores saneados.

| Función | Papel |
|---|---|
| `register_document_version(...)` | registra una versión; scope derivado de `evidence_items`; idempotente en `version_id`; `U0101` si el pipeline difiere |
| `claim_active_document_version(uuid)` | versión activa bajo el mismo bloqueo de fila que toma el registrador |
| `insert_evidence_chunks(uuid, jsonb)` | inserta los chunks de una versión en una llamada; scope y versiones tomados de la fila de versión, nunca del payload |
| `finalize_document_ingestion(uuid, integer)` | falla la transacción si el número de chunks canónicos no coincide |
| `chunks_in_scope(uuid, uuid, uuid)` | chunks canónicos de una versión en un scope **exacto**, comprobado y no derivado |

`«no encontrado»` y `«no es tuyo»` son **el mismo error dentro de cada función**:
distinguirlos es un oráculo de tenencia. Ningún mensaje interpola un digest ni
texto del documento.

**Sin embeddings remotos.** Ninguna función sale del proceso de PostgreSQL.

### Decisión abierta, marcada como tal

`register_document_version` **rechaza** (`U0101`) una reingesta del mismo
`version_id` bajo un pipeline distinto, en vez de crear un ordinal nuevo. Es la
lectura estricta: mismos bytes con espacio de coordenadas distinto significa que
todo offset almacenado para esa versión es sospechoso, y devolver el id anterior
los deja en su sitio. **La alternativa** —un ordinal nuevo para los mismos bytes
bajo un pipeline nuevo— es defendible y es una decisión de producto, no de
esquema. Si integración o GROUNDING la prefieren, el cambio está confinado a esa
función y a `tests/grounding-persistence-contract.test.ts`.

---

## 8. Rollbacks

Ambos hacen **todo** dentro de un único bloque `DO`: en PL/pgSQL un
`RAISE EXCEPTION` termina el bloque y ninguna sentencia posterior *de ese bloque*
se ejecuta. Es semántica del servidor dentro de una sola sentencia, no del
cliente entre dos — así que el editor SQL de Supabase, `supabase db execute` o
un cliente gráfico no pueden separar la guarda del `DROP`. Es el defecto contra
el que se endureció `stella_0003_rollback`.

**Son asimétricos a propósito.** El de `grounding_0002` exige
`SET grounding.rollback_confirm = 'true'` de sesión cuando la tabla tiene filas
(sólo la cadena exacta `'true'`), rechaza la autorización persistida vía
`ALTER DATABASE/ROLE`, y se niega a correr bajo `FORCE ROW LEVEL SECURITY` —
donde un owner sin `rolbypassrls` contaría 0 sobre una tabla poblada y el script
anunciaría «no se perdió historia» mientras la destruye.

El de `grounding_0003` **no pide confirmación**: cada fila es reproducible desde
el archivo sellado y `lib/grounding` en las versiones de pipeline que la propia
fila registra. Un prompt ahí entrenaría al operador a teclear la misma
confirmación en el sitio donde sí se pierde evidencia.

Además: `grounding_0002_rollback` se **niega** mientras `evidence_chunks`
mantenga su clave foránea, y `grounding_0003_rollback` **aborta** si al terminar
`evidence_document_versions` ya no existe.

---

## 9. Evidencia

Todo offline. Sin base de datos, sin red, sin Docker, sin stack local.

| Suite | Resultado |
|---|---|
| `tests/grounding-persistence-contract.test.ts` (nueva, 47 casos) | **verde** |
| `tests/grounding-persistence-mutation.test.ts` (nueva, 65 casos; **53 mutaciones, 0 supervivientes**) | **verde** |
| `tests/capability-isolation`, `prepared-stella-sql`, `capability-policy-contract`, `capability-mutation` | **687 passed** |
| `tests/stripe-webhook-capability` (+5 casos de cierre de A-F2), `stripe-webhook-route`, `prepared-sql-source-of-truth`, `capability-policy-parser`, `capability-documentation`, `database-ddl-containment` | **verde** |
| `lib/grounding/__tests__/prepared-sql.test.ts` (propiedad de GROUNDING, **no modificada**) | **27 passed** |
| `tsc --noEmit`, `eslint` focalizado | **verde** |

Las 53 mutaciones se evalúan con la **misma función pura** que juzga los archivos
en disco, y cada una declara el gate que **debe** rechazarla: que «algo» objete
es una afirmación mucho más débil de lo que parece, porque un gate ajeno sigue
disparando el día que se debilita el propio.

Tres defectos salieron de esa exigencia y de ninguna otra parte:
`history-linearity`, `version-scoped-unique` y `no-duplicate-text` comprobaban
la presencia del fragmento **en todo el archivo**, y quedaban satisfechos por la
copia que vive en el bloque de reconciliación —donde no restringe nada— mientras
la constraint había desaparecido de la definición de la tabla. Ahora se
comprueban contra el cuerpo del `CREATE TABLE`.

---

## 10. Lo que esta línea NO hizo

- No aplicó SQL a ninguna base, local o remota.
- No levantó el stack persistente ni Docker.
- No habilitó ninguna bandera.
- No usó `service_role` como solución en ningún punto.
- No modificó `CONTRACT_LEDGER.md` ni ningún archivo `INTEGRATION-OWNED`.
- No modificó `lib/grounding/**` (propiedad de GROUNDING), incluida la prueba de
  esa línea que fija `grounding_0001`.
- No implementó embeddings ni índices vectoriales: es el gate G5 P3 y GR-001 §4
  lo deja fuera.
- No hizo push.

## 11. Decisión de integración

_Pendiente._
