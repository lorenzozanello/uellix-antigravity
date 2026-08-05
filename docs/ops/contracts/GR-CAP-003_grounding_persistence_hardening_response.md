# GR-CAP-003 — Endurecimiento de la persistencia de grounding (tren 3)

| Campo | Valor |
|---|---|
| Emisor | CAPABILITIES (`codex/stella-capabilities`), tren 3 |
| Responde a | Riesgos locales confirmados en la integración de [GR-CAP-001](GR-CAP-001_grounding_persistence_response.md) |
| Estado declarado | **`IMPLEMENTED_PENDING_INTEGRATION_ACCEPTANCE`** |
| Fecha | 2026-08-05 |

> **Este documento no modifica `CONTRACT_LEDGER.md`.** No es un contrato
> nuevo — GR-001 y GR-002 ya están `aceptado`. Es la respuesta técnica al
> endurecimiento adicional que la integración del tren 2 pidió como trabajo de
> entrada de esta línea. El detalle vive también en
> `docs/ops/workstreams/CAPABILITIES.md`, sección «TRAIN 3».

## 1. Qué se entrega

Los mismos dos paquetes de GR-CAP-001, modificados en el sitio:

| Paquete | Rollback | Qué cambió |
|---|---|---|
| `db/prepared/grounding_0002_document_versions.sql` | `grounding_0002_rollback.sql` | + `evidence_document_versions_identity_unique`; + trigger `trg_evidence_document_versions_scope_check` + función `public.uellix_check_document_version_scope()`; `ENABLE ALWAYS` en los 3 triggers de la tabla |
| `db/prepared/grounding_0003_evidence_chunks.sql` | `grounding_0003_rollback.sql` | + `evidence_chunks_identity_scope_unique`; + FK `evidence_chunks_version_scope_fk` (reemplaza la FK simple inline de `document_version_id`); + FK `evidence_chunks_canonical_fk`; + trigger `trg_evidence_chunks_canonical_integrity` + función `public.uellix_check_canonical_chunk()`; `insert_evidence_chunks` deriva y verifica `chunk_id` server-side e inserta en dos pasadas; `ENABLE ALWAYS` en los 3 triggers de la tabla |

**Ninguno aplicado a ninguna base de datos.** Toda la evidencia de aplicación
es un contenedor Docker desechable (`--network none`), destruido al salir de
`scripts/grounding-dry-run.sh`.

Sin cambio de columnas: ambas tablas conservan 14 y 23 columnas
respectivamente. Todo lo nuevo es constraint, trigger o cuerpo de función.

## 2. Los siete riesgos, uno por uno

### 2.1 `canonical_chunk_id` sin FK

`evidence_chunks_canonical_fk` — FK compuesta `(canonical_chunk_id,
organization_id, project_id, evidence_id, document_version_id, content_hash)`
→ las mismas columnas de la propia tabla, respaldada por la nueva UNIQUE
`evidence_chunks_identity_scope_unique`. `ON DELETE CASCADE`, consistente con
que `evidence_chunks` es índice derivado.

### 2.2 Ciclos directos e indirectos

La FK anterior prueba existencia y scope, no que el objetivo sea a su vez
canónico — no basta contra un ciclo. `trg_evidence_chunks_canonical_integrity`
(`AFTER INSERT FOR EACH ROW`) exige que el objetivo tenga su propio
`canonical_chunk_id IS NULL`. Consecuencia: la relación es **como máximo un
nivel de indirección**, así que ninguna cadena de cualquier longitud —y por
tanto ningún ciclo de longitud 2 o mayor— es representable. No es una
comprobación que sólo detecte el caso directo: lo cierra por construcción.

`insert_evidence_chunks` inserta canónicos y duplicados en dos sentencias
separadas (misma transacción) precisamente para que este trigger, que no es
diferible, siempre vea el canónico ya insertado cuando evalúa un duplicado.

### 2.3 `chunk_id` sin rederivación de servidor

`insert_evidence_chunks` deriva `chunk_id = SHA256("grounding/chunk/v1\n" ||
version_id || "\n" || chunk_index || "\n" || content_hash)` — la misma fórmula
de `lib/grounding/contracts/chunks.ts#deriveChunkId` — con
`pg_catalog.sha256`/`convert_to` (sin `pgcrypto`). El valor almacenado es
SIEMPRE el derivado; el `chunk_id` del payload se compara y, si difiere,
`U0104`. Determinista, idempotente, verificable, compatible con reingesta
(vía `ON CONFLICT DO NOTHING`), sin colisión silenciosa salvo una colisión
SHA-256 real.

### 2.4 Triggers append-only sin `ENABLE ALWAYS`

Los 4 triggers de inmutabilidad ya existentes, más los 2 nuevos de esta
unidad (scope-check, aciclicidad canónica) — los 6, en ambas tablas, ahora
`ENABLE ALWAYS`. Sin él, `tgenabled='O'` no dispara bajo
`session_replication_role = replica`.

### 2.5 Bypass del owner sobre el scope

Cerrado con la FK de 2.1/2.2 más una pieza nueva: `evidence_chunks_version_scope_fk`
(scope de un chunk vs. su document version) y
`trg_evidence_document_versions_scope_check` (scope de una versión vs. su
evidence item — trigger, no FK, porque `evidence_items` es tabla base fuera
de esta línea y no se le añadió una UNIQUE nueva). Ambos alcanzan al owner;
RLS no.

### 2.6 `FORCE RLS` vs. validación explícita

**Decisión: no se activó `FORCE ROW LEVEL SECURITY` en ninguna tabla.**
Habría quitado la excepción del propio dueño de forma indiscriminada —
incluida la del definer, que no tiene `BYPASSRLS`— y el propio rollback de
`grounding_0002` (desde el tren 2) ya documenta que un owner sin
`rolbypassrls` bajo FORCE cuenta 0 filas sobre una tabla poblada, lo que haría
mentir a ese mismo rollback sobre cuánta historia destruye. Constraints y
triggers dirigidos exactamente a cada riesgo cierran el mismo hueco sin ese
efecto secundario.

**Hallazgo no pedido:** las FOREIGN KEY se implementan como triggers internos
(`RI_ConstraintTrigger_*`) y por tanto también respetan
`session_replication_role` — reproducido en vivo. Su nombre es un OID no
determinista, así que endurecerlas exigiría SQL dinámico
(`EXECUTE format(...)`), que el contrato estático de esta línea
(`tests/helpers/sql-structure.ts`) rechaza como `unparsed-security-statement`.
Dado que fijar ese GUC ya exige ser superusuario —quien de todos modos puede
`ALTER TABLE ... DROP CONSTRAINT`—, se deja como riesgo residual aceptado, no
como omisión.

### 2.7 Rollbacks

Ambos rollbacks actualizados: cada uno ahora también dropea la función de
trigger que su propio forward script creó (`public.uellix_check_canonical_chunk`,
`public.uellix_check_document_version_scope`) — nunca
`public.uellix_forbid_mutation()`, que es baseline y compartida. El drop de la
función va **después** del drop de la tabla en ambos casos: el trigger que la
referencia vive en la tabla, y PostgreSQL rehúsa borrar una función que un
trigger todavía usa. Verificado en vivo: rollback en orden inverso, y
reaplicar produce el mismo estado que la primera aplicación.

## 3. Evidencia

Ver la sección «Pruebas ejecutadas» de `docs/ops/workstreams/CAPABILITIES.md`
§TRAIN 3. En resumen: 126 casos nuevos/afectados en los tests de contrato y
mutación de persistencia, 771 en las suites de capability/cross-workstream ya
existentes, `tsc`/`eslint` focalizados verdes, y `grounding-dry-run.sh`
completo — incluida una sección nueva (§6-ter) que siembra datos reales bajo
`SET ROLE uellix_owner` y ejercita los 7 riesgos con INSERT/UPDATE/DELETE/
TRUNCATE directos, dentro de una transacción que termina en `ROLLBACK` para
no afectar las aserciones de rollback/reaplicación existentes.

## 4. Lo que esta línea NO hizo

- No aplicó SQL a ninguna base, local o remota.
- No levantó el stack persistente ni Docker con red.
- No habilitó ninguna bandera.
- No usó `service_role`.
- No modificó `CONTRACT_LEDGER.md` ni ningún archivo `INTEGRATION-OWNED`.
- No modificó `lib/grounding/**` (propiedad de GROUNDING).
- No modificó `db/baseline/**` ni `evidence_items` (tabla base fuera de esta
  línea) — el riesgo de bypass del owner contra esa tabla se cerró con un
  trigger, no con una FK compuesta, precisamente para no tocarla.
- No hizo push.

## 5. Decisión de integración

_Pendiente._
