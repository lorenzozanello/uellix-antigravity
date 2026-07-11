// lib/reports/report-variants.ts
// Fase 6b — report variants. A report's variant is chosen once at creation
// (immutable, like includeFunderBreakdown) and governs which sections are
// generated and which annexes render. The mandatory methodological disclaimer
// and the immutable calculation anchoring are present in every variant.

import { SECTION_ORDER, getInitialSectionTypes } from './report-sections'

export type ReportVariant = 'funder' | 'methodological' | 'audit'

export const REPORT_VARIANTS: ReportVariant[] = ['funder', 'methodological', 'audit']

export const REPORT_VARIANT_LABEL: Record<ReportVariant, string> = {
  funder: 'Financiador',
  methodological: 'Metodológico',
  audit: 'Auditoría',
}

export const REPORT_VARIANT_DESCRIPTION: Record<ReportVariant, string> = {
  funder: 'Ejecutivo para financiadores: impacto, retorno y desglose por financiador. Breve.',
  methodological: 'Técnico: todas las secciones metodológicas y supuestos. Detallado.',
  audit: 'Completo: todas las secciones y anexos de trazabilidad (hashes de evidencia).',
}

export function isReportVariant(value: string): value is ReportVariant {
  return (REPORT_VARIANTS as string[]).includes(value)
}

// Curated executive subset for the funder variant — impact-oriented, omits the
// deep methodology sections a donor audience does not need.
const FUNDER_SECTION_TYPES = [
  'executive_summary',
  'project_context',
  'outcomes',
  'calculation_results',
  'funder_breakdown',
  'limitations',
]

/** Section types a new report of this variant should be created with. */
export function getVariantSectionTypes(variant: ReportVariant, includeFunderBreakdown: boolean): string[] {
  if (variant === 'funder') {
    return FUNDER_SECTION_TYPES.filter(
      (type) => type !== 'funder_breakdown' || includeFunderBreakdown
    )
  }
  // methodological + audit get the full canonical set (funder_breakdown gated).
  return getInitialSectionTypes(includeFunderBreakdown).filter((type) => SECTION_ORDER.includes(type))
}

export type VariantAnnexes = {
  funderBreakdown: boolean
  evidenceManifest: boolean
  fxTrail: boolean
  lineItems: boolean
  standards: boolean
}

/** Which document annexes render for this variant. The raw FX conversion trail
 *  and calculation line items are audit-only traceability annexes. */
export function getVariantAnnexes(variant: ReportVariant): VariantAnnexes {
  switch (variant) {
    case 'funder':
      return { funderBreakdown: true, evidenceManifest: false, fxTrail: false, lineItems: false, standards: true }
    case 'methodological':
      return { funderBreakdown: false, evidenceManifest: false, fxTrail: false, lineItems: false, standards: true }
    case 'audit':
      return { funderBreakdown: true, evidenceManifest: true, fxTrail: true, lineItems: true, standards: true }
  }
}
