# STELLA_RETENTION_POLICY — Borrador de política de retención (DP-04)

> **ESTADO: BORRADOR (DRAFT).** Todas las opciones de este documento son
> propuestas para decisión de **Lorenzo**; ninguna está aprobada ni
> implementada. Insumo para el ítem DP-04 del registro de riesgos
> (`docs/ops/STELLA_FABLE_RISK_REGISTER.md`). Redactado por WS3b (2026-07-31).

## 1. Qué se retiene hoy

### 1.1 `stella_interactions` (append-only, sin expiración)

Cada invocación exitosa de Stella (advisor legacy/contextual, validator,
composer, reviewer) persiste una fila con:

| Columna | Contenido | Sensibilidad |
|---------|-----------|--------------|
| `organization_id`, `project_id`, `created_by` | Identificadores internos | Baja (pseudónimos internos, pero `created_by` enlaza a una persona) |
| `stella_role`, `pipeline_step`, `model_used`, `tokens_used`, `created_at` | Metadatos operativos | Baja |
| `context_hash` | SHA-256 del contexto enviado | Baja (no reversible) |
| `risk_level`, `risk_flags` | Clasificación derivada | Baja |
| **`response_json`** | **Respuesta completa del modelo** | **Media-alta — ver 2** |

### 1.2 `audit_logs` (WS3b, append-only)

`stella.invoked` / `stella.denied` / `stella.integrity_rejected` /
`stella.decision_recorded` con metadatos únicamente (rol, paso, tokens,
códigos de razón, conteos). Sin contenido de prompt/respuesta por diseño —
riesgo de retención bajo; se rige por la política general de `audit_logs`.

### 1.3 `stella_suggestion_decisions` (post-G2, dormida)

`previous_value_hash` (SHA-256, nunca el texto previo), `applied_text` (texto
aplicado — pasa a ser contenido del proyecto de todos modos),
`rejection_reason` (texto libre corto), `decided_by`.

## 2. Implicaciones de PII en `response_json`

- Las narrativas se **redactan antes del prompt desde wave 1** (pipeline de
  redacción PII de WS3), así que el contexto que sale hacia Gemini ya viene
  filtrado.
- **PERO** la respuesta del modelo puede **parafrasear o hacer eco** de
  fragmentos del contexto (nombres de outcomes, descripciones de stakeholders,
  citas de evidencia) y esa respuesta se guarda **íntegra** en
  `response_json`. La redacción pre-prompt reduce, no elimina, la superficie.
- Conclusión operativa: tratar `response_json` como dato potencialmente
  personal a efectos de retención/borrado (GDPR-adyacente vía
  `0038_sprint_a_gdpr_users.sql` y compromisos con clientes), aunque el diseño
  apunte a metadatos.

## 3. Opciones de retención (todas DRAFT — elegir una)

| Opción | Descripción | Pros | Contras |
|--------|-------------|------|---------|
| **R-12** | Retención 12 meses de `response_json`; a los 12 meses se **pseudonimiza la fila** (ver 4.2) conservando metadatos | Ventana corta de exposición; suficiente para auditorías anuales | Pierde detalle para auditorías multi-año |
| **R-24** | Igual que R-12 con ventana de 24 meses | Cubre ciclos de reporte bienales de funders | Doble exposición temporal |
| **R-∞-meta** | `response_json` se pseudonimiza a los 12/24 meses, los **metadatos se conservan para siempre** (fila nunca se borra) | Máxima trazabilidad de auditoría con mínimo PII residual | Requiere el mecanismo G2 de 4.2 |

Nota: la elección 12 vs 24 debería alinearse con lo que prometa el DPA/contrato
tipo con las organizaciones cliente. Si no hay compromiso contractual aún, la
recomendación (DRAFT) del WS3b es **R-∞-meta con ventana de 12 meses**: es la
única que preserva intacta la cadena de auditoría append-only.

## 4. Mecánica de borrado bajo diseño append-only

Restricción dura: post-G2 (`stella_0002`), `UPDATE`/`DELETE` sobre
`stella_interactions` fallan **incluso para el service role** (trigger
`uellix_forbid_mutation()`). Cualquier mecánica de retención necesita su
**propio script preparado con gate G2**; no existe camino de aplicación
runtime y así debe seguir.

### 4.1 Opción A (DRAFT) — Particionado por rango de fechas

Reconstruir `stella_interactions` como tabla particionada por
`created_at` (mensual). La "eliminación" es `DETACH PARTITION` + archivo
(dump cifrado a Storage con retención propia) + `DROP` de la partición
desanclada. El trigger append-only vive en las particiones; el detach/drop es
DDL, no DML, así que no lo viola.

- Pros: borrado O(1), sin re-escritura de filas, auditoría del archivo.
- Contras: migración inicial invasiva (recrear la tabla), complejidad alta.

### 4.2 Opción B (DRAFT, recomendada) — Pseudonimización G2-gated

Script preparado (futuro `stella_0004_retention.sql`, gate G2) que:

1. `ALTER TABLE ... DISABLE TRIGGER trg_stella_interactions_append_only` en
   una transacción corta y auditada,
2. reemplaza `response_json` por
   `{"redacted": true, "redacted_at": ..., "original_hash": sha256(response_json)}`
   y anula `created_by` → usuario centinela (o lo conserva, según decisión
   DP-04b) en las filas más viejas que la ventana,
3. re-habilita el trigger y registra la corrida en `audit_logs`.

- Pros: conserva la fila y la cadena de hashes (el `original_hash` permite
  probar integridad histórica), tocando lo mínimo.
- Contras: es una excepción controlada al principio append-only — por eso
  SOLO como script G2 manual, nunca código de aplicación.

### 4.3 Opción C (DRAFT) — No retener `response_json` desde el origen

Cambiar las actions para guardar solo un resumen estructurado + hash de la
respuesta. Elimina el problema hacia adelante, no resuelve el stock existente
y degrada la reproducibilidad de auditoría (hoy un auditor puede releer
exactamente qué dijo Stella). Desaconsejada por WS3b salvo requerimiento
contractual explícito.

## 5. Borrado por solicitud del titular (GDPR/derecho de supresión)

- `stella_suggestion_decisions.decided_by` y
  `stella_interactions.created_by`: ante una solicitud de supresión de
  usuario, el camino DRAFT es el mismo mecanismo 4.2 acotado a
  `created_by = <usuario>` (pseudonimizar autor, conservar metadatos de org).
- `applied_text`/`rejection_reason` en decisiones: **NO existe ninguna cascada
  organizacional.** *(Corregido 2026-08-01: este documento afirmaba que estaban
  "cubiertos por el borrado del proyecto/org (cascada organizacional ya
  existente)". Es falso — describía un mecanismo que el esquema no implementa.)*

  **Semántica real de las FKs.** Las cuatro FKs de `stella_suggestion_decisions`
  (`organization_id`, `project_id`, `interaction_id`, `decided_by`) y las de
  `stella_interactions` se declaran **sin** `ON DELETE`, es decir `NO ACTION`.
  Consecuencia: estas filas **bloquean** el borrado de su organización,
  proyecto, interacción o usuario en vez de desaparecer con él. Un
  `DELETE FROM organizations …` fallará con
  `violates foreign key constraint`, no borrará nada en cascada.

  **Qué hay que hacer antes de borrar un proyecto u organización:**
  1. Exportar las decisiones e interacciones afectadas (son audit trail).
  2. Decidir explícitamente su destino — pseudonimizar (4.2) o conservar.
  3. Eliminarlas en orden hijo→padre, o el `DELETE` del padre fallará.

  **Qué debe conservarse por trazabilidad:** el vínculo
  decisión ↔ interacción ↔ proyecto ↔ organización es lo que hace auditable la
  cadena humano-IA. Borrar el padre y dejar huérfano al hijo destruiría esa
  trazabilidad, y por eso `NO ACTION` es **deliberado**, no un descuido.

  **Qué NO está automatizado:** no hay cascada, ni job de purga, ni tarea
  programada. Todo borrado de datos de retención es hoy una operación manual y
  deliberada. Además, desde `stella_0003` la vía 4.2 (pseudonimizar mediante
  `UPDATE`) queda **bloqueada por el trigger append-only incluso para el
  owner**: cualquier script futuro que la implemente deberá desactivar el
  trigger explícitamente y dejar registro de ello — lo que es exactamente la
  fricción que se buscaba.

  Cambiar las FKs a `ON DELETE CASCADE` **no** forma parte de esta unidad y
  requeriría su propio gate: convertiría un borrado accidental de organización
  en una pérdida silenciosa de audit trail.

## 6. Decisiones pendientes para Lorenzo (checklist DP-04)

- [ ] Ventana: 12 meses / 24 meses / otra (ver 3).
- [ ] Mecánica: particionado (4.1) vs pseudonimización G2 (4.2) vs origen (4.3).
- [ ] DP-04b: ¿`created_by` se pseudonimiza junto con `response_json` o se
      conserva hasta solicitud de supresión?
- [ ] Alinear el texto elegido con el DPA/contrato tipo y con
      `docs/ops/STELLA_FABLE_RELEASE_CRITERIA.md`.
- [ ] Si se elige 4.1 o 4.2: encargar el script preparado
      (`db/prepared/stella_0004_retention.sql` + rollback + lint + paquete G2).
