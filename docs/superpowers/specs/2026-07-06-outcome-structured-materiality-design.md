# Materialidad estructurada para outcomes — Diseño (Fase 2c)

**Fecha:** 2026-07-06
**Estado:** Aprobado por Lorenzo, pendiente de plan de implementación.

## Contexto

Tercera pieza de Fase 2 (`docs/superpowers/specs/2026-07-04-uellix-impact-science-roadmap.md`), después de la teoría de cambio estructurada (Fase 2a) y el score de confianza calculado de evidencia (Fase 2b). El roadmap pide "extensión de `outcomes` con `materiality_score`/`materiality_rationale`" para reemplazar el juicio de materialidad puramente en texto libre por algo estructurado y defendible.

Estado actual: `outcomes.materialityNotes` es un campo de texto libre opcional. `outcomes` no tiene ninguna función de edición hoy — solo `listOutcomesForProject`, `createOutcomeForProject` y `getOutcomeByIdForProject` (`lib/pipeline/outcomes.ts`). Todos los demás campos de un outcome (título, descripción, tipo, etc.) solo se fijan al crear; no existe ningún flujo de actualización.

## Goal

Permitir declarar la materialidad de un outcome como un score 1-5 + justificación textual obligatoria, tanto al crear el outcome como después (edición dirigida, solo para estos dos campos), sin romper proyectos existentes que solo usan `materialityNotes`.

## Non-goals (explícitamente fuera de este slice)

- No reemplaza ni deprecia `materialityNotes` — coexisten, igual que el patrón ya usado en Fase 2a (grafo de teoría de cambio + `theoryOfChangeSummary`) y Fase 2b (confidence score + `confidenceLevel` declarado en otras tablas).
- **No es un score calculado.** A diferencia del confidence score de evidencia (Fase 2b), la materialidad es un juicio metodológico humano — "qué tan importante es este outcome para los stakeholders/la organización" — no se deriva de señales objetivas del sistema. La "estructura" viene de forzar una escala + justificación obligatoria, no de una fórmula.
- No agrega edición general de outcomes. Los demás campos (título, descripción, tipo, grupo de interés, estado) siguen siendo solo-en-creación; esta es la primera y única función de edición que gana `outcomes`, y está deliberadamente acotada a los dos campos de materialidad.
- No se conecta con el reporte SROI ni con el cálculo — es un juicio metodológico documentado, visible en la app, sin efecto downstream en este slice (igual que Fase 2a no tocó el cálculo).

## Decisiones de diseño

1. **Score 1-5, declarado por un humano.** Escala Likert estándar para juicio cualitativo — más apropiada que 0-100 (que sugeriría una precisión numérica falsa para algo subjetivo) y consistente con frameworks de materialidad de doble relevancia.
2. **Score y justificación son un par atómico.** No puede existir un score sin justificación (un número sin sustento no es "estructurado") ni una justificación huérfana sin score. Se asignan y se limpian juntos.
3. **Editable después de la creación**, a diferencia de todos los demás campos de un outcome — es la única excepción deliberada, porque un juicio de materialidad puede revisarse legítimamente sin necesitar recrear el outcome completo.
4. **Coexiste con `materialityNotes`**, sin migrarlo ni tocarlo — ningún proyecto existente pierde funcionalidad ni requiere re-captura, cumpliendo el criterio de aceptación de Fase 2.

## Data model

### Extensión de `outcomes` (columnas nullable, sin backfill)

```
outcomes
  ...(columnas existentes sin cambios, incluida materiality_notes)...
  materiality_score      integer NULL   -- 1-5
  materiality_rationale  text NULL      -- obligatoria si hay score
```

Constraints:
- `check`: `materiality_score IS NULL OR (materiality_score >= 1 AND materiality_score <= 5)`
- `check`: `(materiality_score IS NULL AND materiality_rationale IS NULL) OR (materiality_score IS NOT NULL AND materiality_rationale IS NOT NULL)` — par atómico, aplicado también a nivel DB, no solo en la capa de servicio.

Migración puramente aditiva — sin `NOT NULL`, sin alterar filas existentes. Segura para aplicar a prod en cualquier momento, mismo patrón que las migraciones de Fase 2a/2b.

## Capa de servicio (`lib/pipeline/outcomes.ts`)

- **`createOutcomeForProject`** (existente, extendida): el schema Zod de input gana `materialityScore: z.number().int().min(1).max(5).optional()` y `materialityRationale: z.string().min(1).optional()`, con una validación `.refine(...)` que exige: si `materialityScore` está presente, `materialityRationale` también debe estarlo (y viceversa). Ambos ausentes es válido (materialidad no evaluada aún, compatibilidad retro total).
- **`setOutcomeMateriality(projectId, outcomeId, input)`** (nueva) — la primera función de edición de `outcomes`. Firma:
  - `input: { materialityScore: number | null, materialityRationale: string | null }`.
  - Misma validación de par atómico que la creación (vía el mismo schema Zod o uno equivalente).
  - Mismo umbral de rol que `createOutcomeForProject` (analyst+).
  - Reutiliza el patrón `verifyProjectAccess(projectId)` ya establecido en el archivo, más una verificación de que `outcomeId` pertenece a `projectId` (mismo patrón que `getOutcomeByIdForProject`).
  - `materialityScore: null` limpia ambos campos (des-asignar materialidad; `materialityRationale` se fuerza a `null` también, sin importar lo que el caller haya pasado ahí, para que el par atómico nunca pueda romperse desde este único punto de escritura).
  - Registra auditoría con una nueva constante `AUDIT_ACTIONS.OUTCOME_MATERIALITY_UPDATED` (`beforeJson`/`afterJson` con los valores viejo/nuevo de ambos campos).

## UI (`app/app/projects/[projectId]/pipeline/outcomes/page.tsx`)

- El formulario "Agregar resultado" gana dos campos nuevos: un `<select>` con las opciones 1-5 (más "Sin evaluar" como default) y un `<textarea>` de justificación, visible/requerido solo cuando se elige un score distinto de "Sin evaluar" (validación en el server action, no solo en el cliente).
- Cada outcome ya registrado en la lista muestra su materialidad actual (el score con una etiqueta corta, o "Sin evaluar" si es `NULL`) y un formulario inline pequeño (`<select>` + `<textarea>` + botón "Guardar") para asignarla o editarla — mismo espíritu que el patrón ya usado en Evidencia para el score de confianza, pero aquí el control es de entrada humana, no un botón que dispara un cálculo.

## Testing

Extiende `tests/outcomes.service.test.ts` (ya existente):
- Validación Zod (a través de `createOutcomeForProject`): rechaza score fuera de 1-5; rechaza score sin rationale; rechaza rationale sin score; acepta ambos `null`/ausentes; acepta ambos presentes.
- `setOutcomeMateriality`: persiste el par correctamente; `score: null` limpia ambos campos aunque se pase una rationale; registra auditoría con `beforeJson`/`afterJson`; rechaza rol insuficiente; rechaza un `outcomeId` que no pertenece al `projectId` dado (regresión IDOR, mismo patrón que los tests ya existentes de `evidence.service.test.ts`/`theory-of-change.service.test.ts`).
- `createOutcomeForProject`: sigue aceptando creación sin materialidad (compatibilidad retro) y con ella.

## Migración y compatibilidad

Migración puramente aditiva: 2 columnas nullable + 2 check constraints en `outcomes`. Sin backfill, sin `NOT NULL`, sin tocar filas existentes ni `materialityNotes`. Segura para aplicar a prod en cualquier momento, mismo patrón de riesgo que las migraciones 0021 (Fase 2a) y 0022 (Fase 2b).
