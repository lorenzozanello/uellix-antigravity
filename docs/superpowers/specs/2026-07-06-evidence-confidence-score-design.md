# Score de confianza calculado para evidencia — Diseño (Fase 2b)

**Fecha:** 2026-07-06
**Estado:** Aprobado por Lorenzo, pendiente de plan de implementación.

## Contexto

Fase 2 del roadmap (`docs/superpowers/specs/2026-07-04-uellix-impact-science-roadmap.md`) propone pasar de campos de texto libre/declarados a un modelo científico estructurado y puntuable. La primera pieza (Fase 2a, PR #36) fue la teoría de cambio estructurada. Esta es la segunda: un **score de confianza calculado** para `evidence_items`.

Estado actual: `evidence_items` no tiene ningún campo de confianza. (`indicators.confidenceLevel` y `financial_proxies.confidenceLevel` sí existen, pero son strings **declarados manualmente** por un humano — exactamente el patrón que Fase 2 busca reemplazar por algo calculado, determinista y auditable, al menos para evidencia.) El módulo de evidencia (`lib/pipeline/evidence.ts`) ya es maduro: hash SHA-256 en creación, verificación de integridad bajo demanda (`verifyFileEvidenceIntegrity`), ciclo de revisión humana (`draft`→`under_review`→`approved`/`rejected`→`archived`).

## Goal

Calcular automáticamente un score de confianza (0-100) por cada `evidence_item`, a partir de señales objetivas ya presentes en el sistema (tipo de evidencia, estado de revisión, vinculación a outcome/indicador, verificación de integridad de archivo), sin requerir que un humano lo declare manualmente y sin romper evidencia existente.

## Non-goals (explícitamente fuera de este slice)

- No reemplaza `confidenceLevel` en `indicators`/`financial_proxies` — esos siguen siendo campos declarados manualmente; esta feature es específica de `evidence_items`, tal como lo especifica el roadmap (punto 4 de Fase 2).
- No se integra con el reporte SROI (`report-sections.ts`) en este slice — igual que Fase 2a, es un slice enfocado en la página de Evidencia. La integración a reportes puede ser un follow-up posterior (mismo patrón que `funder_breakdown` en Fase 1f).
- No fuerza recálculo retroactivo masivo de evidencia existente — las filas ya creadas quedan con `confidence_score = NULL` hasta que ocurra un evento relevante sobre esa fila específica (cambio de estado, verificación de integridad, o una futura edición).
- No recalcula la señal de integridad de archivo automáticamente en cada lectura/listado — esa señal solo se actualiza cuando alguien dispara explícitamente la verificación (acción ya existente `verifyFileEvidenceIntegrity`, extendida para persistir su resultado).

## Decisiones de diseño

1. **Score numérico 0-100, no solo banda.** Más granular y auditable que un enum bajo/medio/alto; la UI puede seguir derivando una banda de color visual a partir del número, sin persistir la banda por separado.
2. **Función de cálculo pura y determinista** (`computeConfidenceScore`), separada de cualquier I/O — mismo patrón que `isValidLinkTransition` (Fase 2a) y `wouldExceedCap` (Fase 1c): fácil de testear exhaustivamente sin DB.
3. **Separación entre señales "baratas" (recalculadas automáticamente) y la señal de integridad (bajo demanda).** Tipo, estado de revisión y vinculación no requieren I/O — se recalculan en cada evento relevante (creación, cambio de estado). La verificación de integridad de archivo requiere descargar el archivo de Supabase Storage — cara — así que solo se incorpora al score cuando el usuario la dispara explícitamente, igual que hoy.
4. **Un mismatch de integridad invalida el score, no lo reduce.** Si `verifyFileEvidenceIntegrity` alguna vez detecta que el hash no coincide, el score final se fuerza a 0 sin importar los demás factores — es una señal de posible manipulación, cualitativamente distinta a "evidencia de baja calidad".
5. **`confidence_score = NULL` es un estado válido y distinto de 0.** Significa "nunca calculado" (evidencia legacy o recién creada antes del primer evento). La UI debe distinguir visualmente "sin calcular" de "confianza cero".

## Data model

### Extensión de `evidence_items` (todas las columnas nullable, sin backfill)

```
evidence_items
  ...(columnas existentes sin cambios)...
  confidence_score          integer NULL        -- 0-100
  confidence_calculated_at  timestamp NULL
  integrity_verified        boolean NULL        -- null = nunca verificado; solo aplica a type='file'
  integrity_verified_at     timestamp NULL
```

Constraint: `check`: `confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 100)`.

Migración puramente aditiva — sin `NOT NULL`, sin alterar filas existentes, sin riesgo de romper `createFileEvidenceForProject`/`createUrlEvidenceForProject`/`createTextEvidenceForProject` actuales. Segura para aplicar a prod en cualquier momento (mismo patrón que Fase 2a).

## Algoritmo de cálculo

`lib/pipeline/confidence-score.ts`, función pura:

```ts
export type ConfidenceScoreInput = {
  type: 'file' | 'url' | 'text'
  status: 'draft' | 'under_review' | 'approved' | 'rejected' | 'archived'
  hasLinkage: boolean          // outcomeId o indicatorId presente
  integrityVerified: boolean | null  // null = nunca verificado; solo relevante si type==='file'
}

export function computeConfidenceScore(input: ConfidenceScoreInput): number
```

Ponderación (suma 100 en el mejor caso posible):

| Señal | Valores |
|---|---|
| Tipo | `file`=35, `url`=20, `text`=10 |
| Estado de revisión | `approved`=35, `under_review`=15, `draft`=5, `rejected`=0, `archived`=0 |
| Vinculación | outcome o indicador presente: +10; ninguno: +0 |
| Integridad de archivo (solo `type==='file'`) | `null` (no verificado): +0; `true`: +20; `false`: **el resultado total se fuerza a 0**, ignorando los demás puntos |

`computeConfidenceScore` acepta `archived` como input válido (mismo `status` type que `EvidenceStatus`) y le asigna 0 puntos por esa señal, igual que `rejected` — esto la mantiene total y determinista para cualquier input, sin ramas condicionales especiales. En la práctica ese branch nunca se ejerce en producción: "congelar el score al archivar" **no** es un comportamiento de la función pura, sino una consecuencia de que la capa de servicio (`archiveEvidenceForProject`, ver "Disparadores" abajo) nunca invoca `recalculateConfidenceScore` al archivar — el valor persistido en la fila simplemente queda sin tocar.

Mejor caso posible: `file` + `approved` + vinculado + integridad verificada = 35+35+10+20 = **100**.

## Capa de servicio y disparadores de recálculo

`lib/pipeline/confidence-score.ts` también exporta:

```ts
export async function recalculateConfidenceScore(projectId: string, evidenceId: string): Promise<void>
```

- Lee la fila actual de `evidence_items` (type, status, outcomeId, indicatorId, integrityVerified).
- Llama a `computeConfidenceScore` con esos valores.
- Si el score calculado difiere del `confidence_score` almacenado (incluyendo el caso donde el almacenado es `NULL`), persiste el nuevo valor + `confidence_calculated_at = now()`, y registra `logAuditAction` con `AUDIT_ACTIONS.EVIDENCE_CONFIDENCE_SCORE_UPDATED` (`beforeJson: {confidenceScore: <viejo>}`, `afterJson: {confidenceScore: <nuevo>}`).
- Si el score no cambia, no escribe nada (ni el timestamp) — evita ruido de auditoría y escrituras innecesarias.

Disparadores en `lib/pipeline/evidence.ts` (agregando una llamada al final de cada función existente, sin cambiar sus firmas ni su contrato externo):

- `createFileEvidenceForProject` / `createUrlEvidenceForProject` / `createTextEvidenceForProject` → llaman a `recalculateConfidenceScore` después del insert (con `integrityVerified` aún `null`).
- `updateEvidenceReviewStatus` → llama a `recalculateConfidenceScore` después de actualizar `status`.
- `verifyFileEvidenceIntegrity` → se extiende: además de devolver `{verified, reason, storedHash, computedHash}` como hoy, ahora también persiste `integrity_verified = verified` + `integrity_verified_at = now()` en la fila, y luego llama a `recalculateConfidenceScore`. El shape de retorno no cambia — no rompe callers existentes.
- `archiveEvidenceForProject` → **no** dispara recálculo (archivar no es una señal de calidad).

## UI

En `app/app/projects/[projectId]/pipeline/evidence/page.tsx`, tabla existente de evidencia:

- Nueva columna "Confianza" entre "Estado de revisión" y "Hash SHA-256". Muestra el número 0-100 con una banda de color puramente visual derivada del rango (0-39 rojo, 40-69 ámbar, 70-100 verde) usando el componente `Badge` ya existente. Si `confidence_score` es `NULL`, muestra "—" (no "0"), para no sugerir falsamente confianza cero en evidencia nunca calculada.
- Para evidencia `type === 'file'`: junto al score, un botón "Verificar integridad" visible solo para roles `impact_manager`+ (reutiliza el `canReview` ya calculado en la página), que envía una nueva Server Action envolviendo `verifyFileEvidenceIntegrity` y revalida la página. Muestra la fecha de última verificación (`integrity_verified_at`) y un ✓/✗ como texto secundario bajo el score cuando existe.
- Para `type === 'url'` o `'text'`: sin botón de verificación — esa señal no aplica a esos tipos.

## Testing

Siguiendo TDD y los patrones ya establecidos (`tests/theory-of-change.service.test.ts`, `tests/evidence.service.test.ts`):

- `computeConfidenceScore`: tabla exhaustiva de casos puros — cada tipo × cada estado de revisión × con/sin vinculación × los 3 valores de `integrityVerified` para `type: 'file'` (para `url`/`text`, `integrityVerified` siempre se pasa como `null` y no debe afectar el resultado). Sin DB, mirror de `tests/allocations.service.test.ts`.
- `recalculateConfidenceScore`: tests de servicio (extienden el mock-DB de `tests/evidence.service.test.ts`) verificando: (a) el score persistido coincide con `computeConfidenceScore` sobre los mismos inputs, (b) se registra auditoría solo cuando el valor cambia, (c) no se escribe nada si el score recalculado es igual al almacenado.
- Disparadores en `evidence.ts`: verificar que `createFileEvidenceForProject`/`createUrlEvidenceForProject`/`createTextEvidenceForProject`/`updateEvidenceReviewStatus`/`verifyFileEvidenceIntegrity` efectivamente invocan el recálculo con los datos correctos; verificar que `archiveEvidenceForProject` NO lo hace.
- Caso legacy: una fila con `confidence_score: null` no rompe `listEvidenceForProject` ni el renderizado de la tabla.

## Migración y compatibilidad

Migración puramente aditiva: 4 columnas nullable + 1 check constraint en `evidence_items`. Sin backfill, sin `NOT NULL`, sin tocar filas existentes. Segura para aplicar a prod en cualquier momento — mismo patrón de riesgo que la migración 0021 de Fase 2a (tablas/columnas nuevas y vacías, ningún código existente las referencia hasta que este slice se despliegue).
