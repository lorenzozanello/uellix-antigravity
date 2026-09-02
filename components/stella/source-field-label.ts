// components/stella/source-field-label.ts
// WS2 (Moonshot) — pure mapper from canonical dotted source-field paths to
// human-readable Spanish labels.
//
// The vocabulary mirrors lib/stella/context/canonical-source-field-paths.ts
// (path grammar + `.empty` sentinel) and lib/stella/context/types.ts
// (ContextualAdvisorContext keys and their nested ref shapes). This module is
// client-safe and dependency-free: it never imports server-only code.

import { EMPTY_COLLECTION_SENTINEL_SEGMENT } from '@/lib/stella/context/canonical-source-field-paths'

/** Spanish section labels for the top-level ContextualAdvisorContext keys. */
const ROOT_LABELS: Record<string, string> = {
  projectId: 'Identificador del proyecto',
  organizationId: 'Identificador de la organización',
  projectName: 'Nombre del proyecto',
  narrativeSummary: 'Resumen narrativo',
  outcomesSnapshot: 'Resultados',
  indicatorsSnapshot: 'Indicadores',
  stakeholderCount: 'Cantidad de grupos de interés',
  stakeholdersSnapshot: 'Grupos de interés',
  activitiesSummary: 'Actividades',
  evidenceMetadata: 'Evidencia',
  evidenceTotal: 'Total de evidencias',
  proxySummary: 'Proxies',
  filterSetsSummary: 'Filtros SROI',
  calculationSnapshot: 'Cálculo',
  calculationReadiness: 'Preparación del cálculo',
  reportSections: 'Secciones del reporte',
  projectCreatedAt: 'Fecha de creación del proyecto',
  lastUpdatedAt: 'Última actualización',
}

/** Spanish labels for known nested leaf/branch field names. */
const FIELD_LABELS: Record<string, string> = {
  id: 'identificador',
  name: 'nombre',
  title: 'título',
  description: 'descripción',
  type: 'tipo',
  status: 'estado',
  unit: 'unidad',
  baseline: 'línea base',
  outcomeId: 'resultado vinculado',
  indicatorId: 'indicador vinculado',
  stakeholderGroups: 'grupos de interés',
  createdAt: 'fecha de creación',
  contentHashTruncated: 'hash de contenido',
  relatedOutcomeTitle: 'resultado relacionado',
  relatedIndicatorName: 'indicador relacionado',
  relatedStakeholderName: 'grupo de interés relacionado',
  mimeTypeGeneral: 'tipo de archivo',
  source: 'fuente',
  value: 'valor',
  currency: 'moneda',
  confidenceLevel: 'nivel de confianza',
  methodologicalRisk: 'riesgo metodológico',
  isGlobalCatalog: 'catálogo global',
  referenceYear: 'año de referencia',
  territory: 'territorio',
  country: 'país',
  methodology: 'metodología',
  justification: 'justificación',
  territorialAdjustmentNotes: 'notas de ajuste territorial',
  assignmentId: 'asignación',
  deadweightPct: 'peso muerto (%)',
  attributionPct: 'atribución (%)',
  displacementPct: 'desplazamiento (%)',
  dropoffPct: 'decaimiento (%)',
  durationYears: 'duración (años)',
  totalInvestment: 'inversión total',
  grossSocialValue: 'valor social bruto',
  netSocialValue: 'valor social neto',
  sroiRatio: 'ratio SROI',
  lineItemCount: 'cantidad de partidas',
  version: 'versión',
  fundersBreakdown: 'desglose por financiador',
  unattributedNsvUsd: 'VSN no atribuido (USD)',
  funderId: 'financiador',
  funderName: 'nombre del financiador',
  funderType: 'tipo de financiador',
  investmentUsd: 'inversión (USD)',
  attributedNsvUsd: 'VSN atribuido (USD)',
  ready: 'lista para calcular',
  blockingReasons: 'razones bloqueantes',
  warnings: 'advertencias',
  latestCalculatedRunExists: 'existe una corrida calculada',
  activeProxyAssignmentCount: 'asignaciones de proxy activas',
  activeFilterSetCount: 'conjuntos de filtros activos',
  sectionType: 'tipo de sección',
  contentLength: 'longitud del contenido',
  readinessScore: 'puntaje de preparación',
}

type Segment = { kind: 'field'; name: string } | { kind: 'index'; index: number }

/**
 * Splits a canonical path (`root.field[2].leaf`) into segments. Returns null
 * when the path does not match the canonical grammar — the caller then falls
 * back to the raw path.
 */
function parseSegments(path: string): Segment[] | null {
  if (typeof path !== 'string' || path.length === 0) return null
  const segments: Segment[] = []
  const re = /([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(path)) !== null) {
    if (match.index !== consumed) {
      // Allow exactly one '.' between a field segment and the next field.
      if (!(path[consumed] === '.' && match.index === consumed + 1 && match[1] !== undefined)) return null
    }
    if (match[1] !== undefined) segments.push({ kind: 'field', name: match[1] })
    else segments.push({ kind: 'index', index: parseInt(match[2]!, 10) })
    consumed = match.index + match[0].length
  }
  if (consumed !== path.length || segments.length === 0) return null
  if (segments[0]!.kind !== 'field') return null
  return segments
}

function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name
}

/**
 * Translates one canonical dotted source-field path into a human-readable
 * Spanish label.
 *
 * - `outcomesSnapshot[0].name` → "Resultados › n.º 1 › nombre"
 * - `outcomesSnapshot.empty`   → "sin datos registrados en Resultados"
 * - Unknown roots or malformed paths fall back gracefully to the raw path.
 */
export function sourceFieldLabel(path: string): string {
  const segments = parseSegments(path)
  if (!segments) return path

  const root = segments[0] as { kind: 'field'; name: string }
  const rootLabel = ROOT_LABELS[root.name]
  if (!rootLabel) return path

  // `.empty` sentinel: absence itself is the citable fact (R1). The sentinel
  // is always the last segment; label the container it hangs off.
  const last = segments[segments.length - 1]
  if (last!.kind === 'field' && last!.name === EMPTY_COLLECTION_SENTINEL_SEGMENT && segments.length > 1) {
    const containerSegments = segments.slice(0, -1)
    const containerLabel = containerSegments
      .map((seg, i) => {
        if (seg.kind === 'index') return `n.º ${seg.index + 1}`
        return i === 0 ? rootLabel : fieldLabel(seg.name)
      })
      .join(' › ')
    return `sin datos registrados en ${containerLabel}`
  }

  return segments
    .map((seg, i) => {
      if (seg.kind === 'index') return `n.º ${seg.index + 1}`
      return i === 0 ? rootLabel : fieldLabel(seg.name)
    })
    .join(' › ')
}
