// tests/methodological-assumptions.service.test.ts
// FIBIU-15 (FIBC-019, FIBDB-012/013/047). W2-B4 (HPO-ODS-W2-12,
// docs/ops/wave2/W2_B4_TEST_MANIFEST_v1.json). DB-free: schema validation and
// pure-logic controls only. Cross-tenant/RLS/CHECK controls (SEC-N1..N4,
// SEC-ACL-1, MUT-PG-1..4) run exclusively through tests/postgres/b4-*.ts
// (pnpm db:audit:disposable) — see security_and_tenancy_contract.

import { describe, it, expect } from 'vitest'
import {
  MethodologicalAssumptionSchema,
  ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES,
  type AssumptionBasisType,
} from '@/lib/pipeline/narratives'

const BASE = {
  formulation: 'Beneficiaries who complete the program are assumed to retain 80% of the skill gain after 12 months.',
  rationale: 'Based on comparable program follow-up studies in the same sector.',
  materialityFlag: 'material' as const,
}

describe('MethodologicalAssumptionSchema (FIBIU-15, FIBC-019)', () => {
  // POS-15-1 — the nine contracted minimum fields are all representable.
  it('POS-15-1: accepts a fully-populated evidence_or_external_source assumption', () => {
    const result = MethodologicalAssumptionSchema.safeParse({
      ...BASE,
      basisType: 'evidence_or_external_source',
      provenanceReference: 'https://example.org/follow-up-study-2024',
    })
    expect(result.success).toBe(true)
  })

  // POS-15-3 — documented_human_judgement is a LEGITIMATE basis requiring NO
  // external source and NO fabricated provenance_reference.
  it.each(['derived', 'documented_human_judgement'] as AssumptionBasisType[])(
    'POS-15-3: accepts basisType=%s with NO provenanceReference — no fictitious source is demanded',
    (basisType) => {
      const result = MethodologicalAssumptionSchema.safeParse({ ...BASE, basisType })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.provenanceReference).toBeUndefined()
    },
  )

  // NEG-15-3 — provenance IS enforced, but only where FIBDB-047 contracts it.
  it('NEG-15-3: refuses basisType=evidence_or_external_source with NO provenanceReference', () => {
    const result = MethodologicalAssumptionSchema.safeParse({
      ...BASE,
      basisType: 'evidence_or_external_source',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('provenanceReference'))).toBe(true)
    }
  })

  it('NEG-15-3: an empty-string provenanceReference does not satisfy the requirement either', () => {
    const result = MethodologicalAssumptionSchema.safeParse({
      ...BASE,
      basisType: 'evidence_or_external_source',
      provenanceReference: '',
    })
    expect(result.success).toBe(false)
  })

  it('refuses an unrecognized basisType — the vocabulary is closed (FIBDB-047)', () => {
    const result = MethodologicalAssumptionSchema.safeParse({ ...BASE, basisType: 'invented_basis' })
    expect(result.success).toBe(false)
  })

  it('refuses an unrecognized materialityFlag — the vocabulary is closed (FIBDB-047)', () => {
    const result = MethodologicalAssumptionSchema.safeParse({
      ...BASE,
      basisType: 'derived',
      materialityFlag: 'somewhat_material',
    })
    expect(result.success).toBe(false)
  })

  it('requires a non-empty formulation and rationale', () => {
    expect(MethodologicalAssumptionSchema.safeParse({ ...BASE, basisType: 'derived', formulation: '' }).success).toBe(false)
    expect(MethodologicalAssumptionSchema.safeParse({ ...BASE, basisType: 'derived', rationale: '' }).success).toBe(false)
  })
})

// FIBDB-013 — the closed affected-object-type vocabulary the polymorphic
// assumption_object_links table enforces via CHECK. Mirrored here so a
// vocabulary drift between the service layer and the migration's CHECK
// constraint is caught without Postgres.
describe('ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES (FIBDB-013)', () => {
  it('is the exact closed set the assumption_object_links CHECK constraint enumerates', () => {
    expect([...ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES].sort()).toEqual(
      ['indicator', 'outcome', 'project', 'sroi_calculation_run', 'theory_of_change_link', 'theory_of_change_node'].sort(),
    )
  })
})

// NEG-15-1 — legacy free text never auto-converts. A structural assertion:
// no function in this service module reads impactNarratives.assumptions or
// theoryOfChangeLinks.assumption as an input to methodologicalAssumptions.
describe('NEG-15-1: legacy free text never auto-converts (NPDD-03)', () => {
  it('recordMethodologicalAssumption/updateMethodologicalAssumption source does not reference impactNarratives or theoryOfChangeLinks', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(path.join(process.cwd(), 'lib/pipeline/narratives.ts'), 'utf8')
    // The whole file legitimately imports impactNarratives for the PRE-EXISTING
    // getNarrativeForProject/upsertNarrativeForProject functions above the
    // FIBIU-15 section — the control that matters is narrower and more
    // precise: no FIBIU-15 CODE reads impactNarratives.assumptions or
    // theoryOfChangeLinks.assumption as a value it persists. Comment lines
    // are stripped first: this file's own header prose NAMES the prohibition
    // ("impactNarratives.assumptions is NEVER auto-converted"), which would
    // otherwise self-defeat a naive substring match exactly the way it is
    // meant to defeat a real violation.
    const fibiu15Section = source.slice(source.indexOf('FIBIU-15 — structured methodological assumptions'))
    const fibiu15Code = fibiu15Section.replace(/^\s*\/\/.*$/gm, '')
    expect(fibiu15Code).not.toMatch(/impactNarratives\.assumptions/)
    expect(fibiu15Code).not.toMatch(/theoryOfChangeLinks\.assumption\b/)
  })
})
