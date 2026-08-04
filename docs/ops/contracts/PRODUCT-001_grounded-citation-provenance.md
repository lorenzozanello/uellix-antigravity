# PRODUCT-001 — Grounded citation & contradiction provenance

**Línea solicitante:** PRODUCT
**Línea propietaria:** GROUNDING
**Estado:** solicitado (2026-08-04)

## Por qué

[`components/stella/grounding-model.ts`](../../../components/stella/grounding-model.ts)
(PRODUCT) modela `EvidenceSupportLevel` incluyendo `'contradictory_evidence'`,
y `EvidenceReference` como una cita etiquetada. Hoy la única señal
evidenciaria real es `AdvisorContextualOutput.findings[].sourceFields` /
`.suggestions[].sourceFields` — rutas canónicas con puntos hacia el *objeto
de contexto que PRODUCT ya envió*, no referencias a documentos o pasajes
recuperados. No existe forma, con datos reales, de representar "esta
afirmación contradice a esta otra" — el pipeline de
retrieval/ranking/provenance de GROUNDING
(`docs/ops/workstreams/GROUNDING.md`) todavía no publicó un contrato.

Por eso, `classifyFindingSupport`/`classifySuggestionSupport` nunca producen
`'contradictory_evidence'` — el tipo existe y `StellaGroundingBadge` puede
renderizarlo, pero ningún mapper de este módulo lo fabrica. Es intencional:
PRODUCT no va a declarar disponible una capacidad cuyo backend todavía no
existe.

## Forma solicitada (TypeScript, para que PRODUCT la consuma)

```typescript
interface GroundingCitation {
  /** Id estable del documento/evidencia recuperado, NO una ruta de contexto. */
  documentId: string
  /** Extracto corto (ya truncado/redactado server-side) mostrado como cuerpo de la cita. */
  excerpt: string
  /** Dónde en el documento fuente vino este extracto (página, offset, sección — a criterio de GROUNDING). */
  location: string
  /** Confianza de GROUNDING en el match de retrieval, si la tiene. */
  relevance?: 'high' | 'medium' | 'low'
}

interface GroundingContradiction {
  claimId: string
  conflictingCitations: [GroundingCitation, GroundingCitation]
  description: string
}
```

## Decisión

_(a completar por integración cuando resuelva la solicitud)_
