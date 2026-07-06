# Teoría de cambio estructurada — Diseño (Fase 2a)

**Fecha:** 2026-07-05
**Estado:** Aprobado por Lorenzo, pendiente de plan de implementación.

## Contexto

Fase 2 del roadmap (`docs/superpowers/specs/2026-07-04-uellix-impact-science-roadmap.md`) propone evolucionar Uellix de campos de texto libre a un modelo científico estructurado y puntuable: teoría de cambio, score de confianza de evidencia, materialidad, y matriz de revisión metodológica generalizada. Es demasiado grande para un solo spec, así que se decidió empezar por la pieza de mayor superficie de diseño: **teoría de cambio estructurada**.

Estado actual: `impact_narratives.theoryOfChangeSummary` es un campo de texto libre. No existe ningún modelo de grafo (actividad→producto→resultado) en el schema.

## Goal

Permitir modelar la teoría de cambio de un proyecto como un grafo simple (actividades → productos → resultados) con supuestos explícitos por enlace, **sin reemplazar** el campo de texto libre existente y **sin romper** el modelo de `outcomes` que ya alimenta el cálculo SROI.

## Non-goals (explícitamente fuera de este slice)

- No reemplaza ni deprecia `impact_narratives.theoryOfChangeSummary` — coexisten; el texto libre sigue siendo válido por sí solo (proyectos existentes no requieren migración de datos ni re-captura).
- No se conecta automáticamente con la sección de reporte `theory_of_change` (que sigue siendo narrativa manual / Stella Composer). El grafo es un artefacto estructurado adicional, visible en la app, no inyectado al reporte en este slice.
- No hay editor visual tipo canvas (drag-and-drop). La construcción es tabular (formularios + listas), igual que Stakeholders/Outcomes/Indicadores.
- No hay validación de "grafo completo" (ej. exigir que todo outcome tenga al menos una actividad conectada aguas arriba). Eso es responsabilidad de revisión humana, no un bloqueo automático del sistema.
- No agrega un paso nuevo al Stepper del pipeline — vive dentro del paso Narrativa existente.

## Decisiones de diseño

1. **Nodo `outcome` referencia un `outcomes.id` real** (no una entidad paralela). Actividades y productos son nodos nuevos sin equivalente previo en el schema. Esto conecta el grafo con el pipeline real (evidencia, proxies, cálculo) en vez de dejarlo como narrativa aislada y desincronizable.
2. **Construcción tabular, no visual.** Consistente con el resto de la app — reduce esfuerzo y riesgo, y no introduce una dependencia nueva (ej. React Flow).
3. **Vive dentro del paso Narrativa**, como sección nueva debajo del texto libre existente — no es un paso propio del Stepper.
4. **Orden causal fijo en los enlaces**: `activity → output` o `output → outcome` únicamente. Cualquier otra combinación (mismo tipo, orden invertido, salto directo `activity → outcome`) se rechaza en el servicio. Un caso de "actividad con efecto directo" se documenta como supuesto en el enlace `output → outcome` correspondiente, no como una excepción al modelo.

## Data model

### New table: `theory_of_change_nodes`

```
theory_of_change_nodes
  id                uuid PK
  project_id        uuid FK -> projects.id, NOT NULL
  organization_id   uuid FK -> organizations.id, NOT NULL
  node_type         varchar(20) NOT NULL   -- check IN ('activity','output','outcome')
  outcome_id        uuid FK -> outcomes.id, nullable
                     -- NOT NULL when node_type = 'outcome', NULL otherwise — enforced by a DB
                     -- CHECK constraint (see below); that the referenced outcome actually belongs
                     -- to this project is validated in the service layer (FK alone can't express it).
  title             varchar(255) NOT NULL
  description       text
  status            varchar(20) NOT NULL default 'active'   -- check IN ('active','archived')
  created_by        uuid FK -> users.id, NOT NULL
  created_at        timestamp default now()
  updated_at        timestamp default now()
```

Constraints:
- `check`: `node_type IN ('activity', 'output', 'outcome')`
- `check`: `status IN ('active', 'archived')`
- `check`: `(node_type = 'outcome' AND outcome_id IS NOT NULL) OR (node_type != 'outcome' AND outcome_id IS NULL)`
- `unique index` on `(project_id, outcome_id)` WHERE `outcome_id IS NOT NULL` AND `status = 'active'` — an active outcome-type node is unique per outcome per project (an outcome doesn't get modeled twice in the same graph). Archiving one frees the slot for a new node referencing the same outcome.
- Indexes: `project_id`, `organization_id`, `outcome_id`.

### New table: `theory_of_change_links`

```
theory_of_change_links
  id                uuid PK
  project_id        uuid FK -> projects.id, NOT NULL
  organization_id   uuid FK -> organizations.id, NOT NULL
  from_node_id      uuid FK -> theory_of_change_nodes.id, NOT NULL
  to_node_id        uuid FK -> theory_of_change_nodes.id, NOT NULL
  assumption        text   -- optional, like sroi_filter_sets.justification
  status            varchar(20) NOT NULL default 'active'   -- check IN ('active','archived')
  created_by        uuid FK -> users.id, NOT NULL
  created_at        timestamp default now()
  updated_at        timestamp default now()
```

Constraints:
- `check`: `status IN ('active', 'archived')`
- `check`: `from_node_id != to_node_id` (no self-links)
- Indexes: `project_id`, `organization_id`, `from_node_id`, `to_node_id`.
- **Link-type validity is NOT a DB constraint** (would require a self-join/subquery CHECK, not portable) — enforced in the service layer instead: `from.node_type = 'activity' AND to.node_type = 'output'`, or `from.node_type = 'output' AND to.node_type = 'outcome'`. Any other combination is rejected with a descriptive error before insert.

## RLS

Mirrors the org-scoped pattern in `db/policies/001_initial_auth_rls.sql` / `004_fx_tables_rls.sql`: `analyst`+ write, org-scoped read via `current_user_org_ids()`, no DELETE (archive via UPDATE only). New file: `db/policies/005_theory_of_change_rls.sql`.

## Service layer (`lib/pipeline/theory-of-change.ts`)

- `listNodesForProject(projectId)` / `listLinksForProject(projectId)` — read, org-scoped.
- `createNode(projectId, input)` — validates: if `node_type='outcome'`, `outcomeId` must be provided and belong to an active outcome in the project, and must not already have an active node (unique constraint backstop). Role: `analyst`+.
- `archiveNode(projectId, nodeId)` — soft-delete; does NOT cascade-archive links (a node with active links can be archived, same as elsewhere in the codebase — e.g. archiving a proxy doesn't retroactively touch past calculation runs). `listLinksForProject`'s "active graph" view joins each link to its `from`/`to` nodes and excludes any link where the link itself, or either endpoint node, is not `active` — so a link pointing to a since-archived node stops appearing without needing its own archive action.
- `createLink(projectId, input)` — validates both nodes belong to the project, are active, and the type-pair is one of the two allowed transitions. Pure validation function extracted and unit-tested in isolation (mirrors `lib/pipeline/allocations.ts`'s `wouldExceedCap` pattern): `isValidLinkTransition(fromType, toType): boolean`.
- `archiveLink(projectId, linkId)` — soft-delete.

## UI

New section "Teoría de cambio estructurada" on the existing Narrativa page (`app/app/projects/[projectId]/pipeline/narrative/page.tsx`), below the free-text `theoryOfChangeSummary` textarea — not replacing it.

- Three lists (Actividades / Productos / Resultados), each with an inline add-form. The "Resultados" list is a dropdown of the project's active `outcomes` rows (not a free-text title — enforces the outcome-reference rule at the UI level too, not just the DB).
- A link-creation form: select "from" node (activities or outputs), select "to" node (outputs or outcomes, filtered by valid transition given the "from" selection), optional assumption text.
- Read view: three columns (Actividades → Productos → Resultados) each listing their nodes, with active outgoing links shown as annotations under each node (e.g. "→ Producto X" with the assumption text if present) — no canvas/graph rendering library.

## Testing

Following the project's established patterns (TDD, mirrors `tests/allocations.service.test.ts`):

- Pure validation function `isValidLinkTransition` — unit tests for both valid transitions, both invalid same-type cases, the invalid reverse-order cases, and the invalid direct activity→outcome case.
- Service tests: creating an outcome-node without a real project outcome rejects; creating a second active outcome-node for an already-modeled outcome rejects; archiving frees the outcome for re-modeling; creating a link with an invalid type-pair rejects at the service layer (defense in depth, not just UI-level filtering); archiving a node does not cascade-archive its links (view-level filtering only).
- No engine tests needed — this feature does not touch `sroi-calculation.ts` or the calculation engine in any way (the `outcome_id` reference is read-only from this feature's perspective).

## Migration & backward compatibility

Two new, empty tables — purely additive, safe to apply to production at any time (no existing table alterations, no NOT NULL additions to populated tables). No backfill needed. Existing projects show empty lists for all three node types until a user opts in.
