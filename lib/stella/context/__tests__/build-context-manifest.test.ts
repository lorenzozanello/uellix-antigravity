// lib/stella/context/__tests__/build-context-manifest.test.ts
// Etapa A1 (STL-A1-004)

import { describe, it, expect } from 'vitest'
import { buildContextManifest } from '../build-context-manifest'
import { buildContextHash } from '../build-context-hash'
import type { StellaProjectContext } from '../types'

const LEAK_MARKER = 'SECRET_MARKER_SHOULD_NEVER_APPEAR_IN_MANIFEST_9f3a'

function fullContext(overrides: Partial<StellaProjectContext> = {}): StellaProjectContext {
  return {
    projectId: 'proj-1',
    organizationId: 'org-1',
    narrativeSummary: `A project narrative that mentions ${LEAK_MARKER} inline.`,
    outcomesSnapshot: [
      { id: 'outcome-1', name: 'Health improvement', description: `desc with ${LEAK_MARKER}`, stakeholderGroups: [] },
    ],
    indicatorsSnapshot: [{ id: 'ind-1', outcomeId: 'outcome-1', name: 'Visits', unit: 'count' }],
    stakeholderCount: 3,
    evidenceMetadata: [
      {
        id: 'ev-1',
        title: 'Survey results',
        type: 'file',
        status: 'approved',
        contentHashTruncated: 'abcd1234',
        createdAt: '2026-01-01T00:00:00Z',
        outcomeId: 'outcome-1',
      },
    ],
    evidenceTotal: 1,
    proxySummary: [
      { id: 'proxy-1', name: 'Cost of treatment', source: 'HACT', value: '', currency: '', confidenceLevel: 'high' },
    ],
    filterSetsSummary: [{ assignmentId: 'assign-1', deadweightPct: 10, durationYears: 3 }],
    calculationSnapshot: {
      totalInvestment: 42000,
      grossSocialValue: 270000,
      netSocialValue: 158363.1,
      sroiRatio: 3.77,
      currency: 'USD',
      lineItemCount: 1,
      version: 1,
    },
    reportSections: [{ id: 'sec-1', sectionType: 'executive_summary', title: 'Resumen', contentLength: 0, status: 'draft' }],
    projectCreatedAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  }
}

describe('buildContextManifest', () => {
  it('never contains the actual narrative/description text, even though the context carries it', () => {
    const manifest = buildContextManifest(fullContext(), 'advisor')
    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toContain(LEAK_MARKER)
  })

  it('records one entity per outcome/indicator/evidence/proxy/filter/section, plus the project', () => {
    const manifest = buildContextManifest(fullContext(), 'composer')
    const types = manifest.entities.map((e) => e.type)
    expect(types.filter((t) => t === 'project')).toHaveLength(1)
    expect(types.filter((t) => t === 'outcome')).toHaveLength(1)
    expect(types.filter((t) => t === 'indicator')).toHaveLength(1)
    expect(types.filter((t) => t === 'evidence')).toHaveLength(1)
    expect(types.filter((t) => t === 'proxy')).toHaveLength(1)
    expect(types.filter((t) => t === 'filter_set')).toHaveLength(1)
    expect(types.filter((t) => t === 'calculation_run')).toHaveLength(1)
    expect(types.filter((t) => t === 'report_section')).toHaveLength(1)
  })

  it('every fieldsIncluded entry is a field NAME, never a value from the context', () => {
    const manifest = buildContextManifest(fullContext(), 'validator')
    for (const entity of manifest.entities) {
      for (const field of entity.fieldsIncluded) {
        // Field names are short, lowerCamelCase identifiers — never the long
        // narrative/description strings the context actually carries.
        expect(field).not.toContain(LEAK_MARKER)
        expect(field.length).toBeLessThan(40)
      }
    }
  })

  it('counts match the context arrays exactly', () => {
    const context = fullContext()
    const manifest = buildContextManifest(context, 'advisor')
    expect(manifest.counts.outcomes).toBe(context.outcomesSnapshot.length)
    expect(manifest.counts.indicators).toBe(context.indicatorsSnapshot.length)
    expect(manifest.counts.evidence).toBe(context.evidenceMetadata.length)
    expect(manifest.counts.proxies).toBe(context.proxySummary.length)
  })

  it('reuses buildContextHash so the manifest hash matches the audit column', () => {
    const context = fullContext()
    const manifest = buildContextManifest(context, 'advisor')
    expect(manifest.contextHash).toBe(buildContextHash(context))
  })

  it('flags narrative presence but never includes the narrative itself', () => {
    const manifest = buildContextManifest(fullContext(), 'advisor')
    expect(manifest.sensitivityFlags).toContain('narrative_text_present')
  })

  it('omits the narrative flag when narrative is empty', () => {
    const manifest = buildContextManifest(fullContext({ narrativeSummary: '', stakeholderCount: 0 }), 'advisor')
    expect(manifest.sensitivityFlags).not.toContain('narrative_text_present')
    expect(manifest.sensitivityFlags).not.toContain('stakeholder_count_present')
  })

  it('handles a null calculationSnapshot without adding a calculation_run entity', () => {
    const manifest = buildContextManifest(fullContext({ calculationSnapshot: null }), 'advisor')
    expect(manifest.entities.some((e) => e.type === 'calculation_run')).toBe(false)
  })

  it('records the role it was built for', () => {
    const manifest = buildContextManifest(fullContext(), 'evidence_reviewer')
    expect(manifest.role).toBe('evidence_reviewer')
  })

  // Etapa A2 (STL-A2-008, DR-001 approved 2026-07-25)
  describe('common PII flags', () => {
    it('flags an email found in the narrative, without including the email itself', () => {
      const manifest = buildContextManifest(fullContext({ narrativeSummary: 'Contact jane.doe@example.com for details.' }), 'advisor')
      expect(manifest.sensitivityFlags).toContain('possible_pii_email')
      expect(JSON.stringify(manifest)).not.toContain('jane.doe@example.com')
    })

    it('flags a phone number found in an outcome name', () => {
      const manifest = buildContextManifest(
        fullContext({ outcomesSnapshot: [{ id: 'o-1', name: 'Contact +1 555-123-4567 for follow-up', description: '', stakeholderGroups: [] }] }),
        'advisor',
      )
      expect(manifest.sensitivityFlags).toContain('possible_pii_phone')
    })

    it('does not add a PII flag when none is present', () => {
      const manifest = buildContextManifest(fullContext(), 'advisor')
      expect(manifest.sensitivityFlags.some((f) => f.startsWith('possible_pii_'))).toBe(false)
    })
  })

  // Etapa A2.3 (STL-A23-008, DR-002/DR-003 aprobados 2026-07-26)
  describe('sensitive-population flag', () => {
    it('does not flag ordinary narrative text with no sensitive population mention', () => {
      const manifest = buildContextManifest(fullContext(), 'advisor')
      expect(manifest.sensitivityFlags).not.toContain('sensitive_population_aggregate_present')
    })

    // A blocked mention never reaches buildContextManifest in practice (the
    // guardrail throws first) — this test only proves the flag mechanism
    // itself works when a context somehow contains an aggregate-style
    // mention, without asserting anything about whether such a context could
    // pass the guardrail today.
    it('flags an aggregate-style mention of a sensitive population if present in the context', () => {
      const manifest = buildContextManifest(
        fullContext({ narrativeSummary: 'The program served 50 niños in the last quarter.' }),
        'advisor',
      )
      expect(manifest.sensitivityFlags).toContain('sensitive_population_aggregate_present')
      expect(JSON.stringify(manifest)).not.toContain('50 niños')
    })
  })
})
