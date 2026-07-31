// tests/eval/stella-roles/fixture-grounded.ts
// WS6 (Fable Moonshot) U4 / RK-27: one eval case grounded in the seeded
// audit fixtures (audit-fixtures/agua-segura), extracted through the real
// document-grounding layer (lib/grounding/extract.ts, READ-ONLY import).
//
// This connects the two realism investments: the synthetic-but-realistic
// audit fixtures and the offline role evaluation. Everything here is
// deterministic (the fixtures are seeded and committed) and fully offline —
// local file reads only, no network, no DB.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDocument } from '@/lib/grounding/extract'
import type { ReviewerContext } from '@/lib/stella/context/build-reviewer-context'
import type { RoleEvalCase } from './cases'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'audit-fixtures', 'agua-segura')

export interface AguaSeguraExtraction {
  /** Number of household data rows in linea-base.csv (comment + header excluded). */
  householdRows: number
  /** Column names of the CSV header row. */
  headerColumns: string[]
  /** Number of "TESTIMONIO N" entries in testimonios.txt. */
  testimonioCount: number
  /** Deterministic confidence score derived from the CSV coverage. */
  lineaBaseConfidenceScore: number
}

/**
 * Extract the two text-format fixtures through lib/grounding/extract.ts and
 * derive the deterministic quantities the eval context is built from.
 * Throws (fail-closed) if the fixtures ever stop matching the expected shape,
 * so a fixture regeneration that breaks the derivation is caught loudly.
 */
export function extractAguaSeguraFixtures(): AguaSeguraExtraction {
  const lineaBase = extractDocument(readFileSync(join(FIXTURES_DIR, 'linea-base.csv')), 'text/csv')
  if (lineaBase.status !== 'extracted' || lineaBase.tables.length === 0) {
    throw new Error('fixture-grounded: linea-base.csv did not extract as CSV')
  }
  const rows = lineaBase.tables[0].rows
  // Row 0 is the synthetic-data disclaimer comment, row 1 is the header.
  const headerColumns = rows[1] ?? []
  for (const required of ['hogar_id', 'horas_semana_agua', 'gasto_mensual_cop', 'bienestar_pct']) {
    if (!headerColumns.includes(required)) {
      throw new Error(`fixture-grounded: linea-base.csv header lost required column "${required}"`)
    }
  }
  const householdRows = rows.slice(2).filter((row) => row.length > 1 && row[0].startsWith('HOG-')).length
  if (householdRows === 0) {
    throw new Error('fixture-grounded: linea-base.csv contains no household rows')
  }

  const testimonios = extractDocument(readFileSync(join(FIXTURES_DIR, 'testimonios.txt')), 'text/plain')
  if (testimonios.status !== 'extracted' || testimonios.text.length === 0) {
    throw new Error('fixture-grounded: testimonios.txt did not extract as plain text')
  }
  const testimonioCount = (testimonios.text.match(/TESTIMONIO \d+/g) ?? []).length
  if (testimonioCount === 0) {
    throw new Error('fixture-grounded: testimonios.txt contains no TESTIMONIO entries')
  }

  // Deterministic score: base 40 plus 1 point per 10 measured households,
  // capped at 95 — a plausible "coverage-derived" confidence, stable across
  // runs because the fixtures are seeded.
  const lineaBaseConfidenceScore = Math.min(95, 40 + Math.floor(householdRows / 10))

  return { householdRows, headerColumns, testimonioCount, lineaBaseConfidenceScore }
}

/**
 * Build the evidence_reviewer eval case from the extracted fixtures: the CSV
 * becomes verified file evidence linked to the time-access outcome; the
 * testimonies become unverified text evidence with no linkage — exactly the
 * kind of asymmetry the evidence_reviewer exists to flag.
 */
export function buildFixtureGroundedEvidenceReviewerCase(): RoleEvalCase {
  const extraction = extractAguaSeguraFixtures()

  const context: ReviewerContext = {
    projectId: 'project-agua-segura-fixture',
    organizationId: 'organization-1',
    reviewerRole: 'evidence_reviewer',
    narrativeSummary:
      'Agua Segura y Bienestar Comunitario — Isla Esperanza: filtros comunitarios reducen el tiempo de acarreo, el gasto mensual en agua y mejoran el bienestar percibido de los hogares.',
    outcomesSnapshot: [
      { id: 'out-tiempo', name: 'Reducción del tiempo semanal de acceso a agua', description: 'social', stakeholderGroups: [] },
      { id: 'out-gasto', name: 'Reducción del gasto mensual en agua', description: 'economic', stakeholderGroups: [] },
      { id: 'out-bienestar', name: 'Mejora del bienestar percibido', description: 'wellbeing', stakeholderGroups: [] },
    ],
    indicatorsSnapshot: [
      { id: 'ind-horas', outcomeId: 'out-tiempo', name: 'Horas semanales dedicadas a buscar agua', unit: 'horas' },
      { id: 'ind-gasto', outcomeId: 'out-gasto', name: 'Gasto mensual en agua por hogar', unit: 'COP' },
      { id: 'ind-bienestar', outcomeId: 'out-bienestar', name: 'Bienestar percibido', unit: '%' },
    ],
    stakeholderCount: 3,
    evidenceMetadata: [
      {
        id: 'ev-linea-base',
        title: 'Línea base de hogares (linea-base.csv)',
        type: 'file',
        status: 'approved',
        createdAt: '2026-02-01T00:00:00.000Z',
        outcomeId: 'out-tiempo',
        indicatorId: 'ind-horas',
      },
      {
        id: 'ev-testimonios',
        title: 'Testimonios de hogares y comité (testimonios.txt)',
        type: 'text',
        status: 'under_review',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ],
    evidenceTotal: 2,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    reportSections: [],
    projectCreatedAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-06-01T00:00:00.000Z',
    evidenceDetails: [
      {
        id: 'ev-linea-base',
        title: `Línea base de hogares (${extraction.householdRows} hogares medidos)`,
        type: 'file',
        status: 'approved',
        integrityVerified: true,
        integrityVerifiedAt: '2026-02-02T00:00:00.000Z',
        confidenceScore: extraction.lineaBaseConfidenceScore,
        outcomeId: 'out-tiempo',
        indicatorId: 'ind-horas',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'ev-testimonios',
        title: `Testimonios de hogares y comité (${extraction.testimonioCount} testimonios)`,
        type: 'text',
        status: 'under_review',
        integrityVerified: null,
        integrityVerifiedAt: null,
        confidenceScore: null,
        outcomeId: null,
        indicatorId: null,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ],
  }

  return {
    caseId: 'roles-evidence_reviewer-fixture-grounded',
    role: 'evidence_reviewer',
    category: 'fixture-grounded',
    expectation: 'pass',
    context,
    output: {
      summary: `La línea base cubre ${extraction.householdRows} hogares con integridad verificada; los testimonios carecen de verificación y de vínculo con outcomes. Este análisis requiere revisión humana antes de cualquier uso externo.`,
      risk_level: 'medium',
      findings: [
        `[LOW RISK] La línea base de hogares tiene integridad verificada, puntaje de confianza documentado y vínculo con el outcome de tiempo de acceso.`,
        `[MEDIUM RISK] Los ${extraction.testimonioCount} testimonios siguen en under_review, sin verificación de integridad ni puntaje de confianza, y no están vinculados a ningún outcome.`,
        '[MEDIUM RISK] Los outcomes de gasto mensual y de bienestar percibido no tienen evidencia vinculada que los respalde.',
        '[LOW RISK] El testimonio del centro de salud describe una mejora sin registro formal; corresponde tratarlo como percepción, no como atribución.',
      ],
      recommendations: [
        'Verificar la integridad de los testimonios o documentar por qué no aplica a evidencia de tipo texto.',
        'Vincular evidencia a los outcomes de gasto y bienestar (la línea base ya contiene columnas de gasto y bienestar aprovechables).',
        'Que la persona responsable resuelva el estado under_review de los testimonios.',
      ],
      requires_human_review: true,
    },
  }
}
