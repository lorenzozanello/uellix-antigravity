// lib/reports/report-sections.ts
// Single source of truth for SROI report section metadata (labels, helper
// text, grouping and canonical order). Shared by the editable report detail
// view and the print / PDF export view so the two never drift.

export interface SectionMeta {
  label: string
  helper: string
}

export const SECTION_META: Record<string, SectionMeta> = {
  executive_summary: {
    label: 'Resumen ejecutivo',
    helper:
      'Narrativa de alto nivel del proceso SROI y hallazgos clave. Escrita para una audiencia ejecutiva no técnica.',
  },
  project_context: {
    label: 'Contexto del proyecto',
    helper:
      'Descripción de la organización, la iniciativa, el alcance geográfico y el período de medición.',
  },
  theory_of_change: {
    label: 'Teoría del cambio',
    helper:
      'Modelo lógico que conecta actividades → productos → resultados. Documenta explícitamente los supuestos y las rutas causales.',
  },
  stakeholders: {
    label: 'Grupos de interés',
    helper:
      'Identificación de los grupos de interés incluidos o excluidos, con justificación de las decisiones de alcance.',
  },
  outcomes: {
    label: 'Resultados',
    helper:
      'Lista de resultados sociales medidos, incluyendo la justificación de materialidad de cada resultado incluido en el análisis.',
  },
  evidence_summary: {
    label: 'Resumen de evidencia',
    helper: 'Métodos de recolección de datos, fuentes, tamaños de muestra y limitaciones de calidad.',
  },
  proxy_methodology: {
    label: 'Metodología de proxies',
    helper:
      'Proxies financieros seleccionados (valores SVI, fuentes de SROI Network o investigación propia) con atribución completa.',
  },
  sroi_filters: {
    label: 'Filtros SROI',
    helper:
      'Supuestos metodológicos documentados de deadweight, atribución, desplazamiento y decaimiento por resultado.',
  },
  calculation_results: {
    label: 'Resultados del cálculo',
    helper:
      'Resumen del ratio SROI y las cifras de valor social, vinculadas a la corrida de cálculo inmutable. Incluye notas de sensibilidad si aplica.',
  },
  limitations: {
    label: 'Limitaciones',
    helper:
      'Limitaciones materiales en la calidad de los datos, exclusiones de alcance, supuestos causales no probados o vacíos de medición.',
  },
  review_notes: {
    label: 'Notas de revisión',
    helper:
      'Comentarios del revisor metodológico, elementos pendientes de verificación humana o notas de auditoría.',
  },
  appendix: {
    label: 'Apéndice',
    helper:
      'Tablas de datos de soporte, fuentes de datos, registros de consentimiento de grupos de interés o evidencia complementaria.',
  },
}

export interface SectionGroup {
  id: string
  label: string
  description: string
  types: string[]
}

export const SECTION_GROUPS: SectionGroup[] = [
  {
    id: 'group-overview',
    label: 'Resumen',
    description: 'Narrativa ejecutiva y contexto del proyecto',
    types: ['executive_summary', 'project_context', 'theory_of_change'],
  },
  {
    id: 'group-evidence',
    label: 'Evidencia y datos',
    description: 'Grupos de interés, resultados, proxies y evidencia de origen',
    types: ['stakeholders', 'outcomes', 'evidence_summary', 'proxy_methodology'],
  },
  {
    id: 'group-calculation',
    label: 'Cálculo',
    description: 'Supuestos de filtros SROI y resultados finales',
    types: ['sroi_filters', 'calculation_results'],
  },
  {
    id: 'group-review',
    label: 'Revisión y apéndice',
    description: 'Limitaciones, notas del revisor y material de soporte',
    types: ['limitations', 'review_notes', 'appendix'],
  },
]

/** Canonical flat order of section types, derived from the group order. */
export const SECTION_ORDER: string[] = SECTION_GROUPS.flatMap((g) => g.types)
