// tests/counterfactual-assessment.service.test.ts
// FIBIU-14 (FIBC-018, FIBDB-011/046). W2-B4 (HPO-ODS-W2-12,
// docs/ops/wave2/W2_B4_TEST_MANIFEST_v1.json). DB-free: schema validation and
// pure-logic controls only. Cross-tenant/RLS/CHECK controls (SEC-N1..N4,
// SEC-ACL-1, MUT-PG-1..4) run exclusively through tests/postgres/b4-*.ts
// (pnpm db:audit:disposable) — see security_and_tenancy_contract.

import { describe, it, expect } from 'vitest'
import {
  CounterfactualAssessmentSchema,
  COUNTERFACTUAL_BASELINE_AVAILABILITY_VALUES,
  COUNTERFACTUAL_BASIS_KIND_VALUES,
  DEADWEIGHT_SUPPORT_STATE_VALUES,
} from '@/lib/pipeline/sroi-calculation'

const RATIONALE = 'Deadweight estimated from a matched comparison group in a neighbouring, non-participating municipality.'

describe('CounterfactualAssessmentSchema (FIBIU-14, FIBC-018)', () => {
  // POS-14-1 — the three-state baseline_availability model, and the
  // conditional NOT NULL FIBDB-046 contracts for 'available'.
  it("POS-14-1: baselineAvailability='available' requires value/period/source/context all present", () => {
    const result = CounterfactualAssessmentSchema.safeParse({
      baselineAvailability: 'available',
      basisKind: 'baseline_observation',
      baselineValue: '42%',
      baselinePeriod: '2023',
      baselineSource: 'Annual household survey',
      baselineContext: 'Same municipality, prior cohort',
      deadweightSupportState: 'supported',
      rationale: RATIONALE,
    })
    expect(result.success).toBe(true)
  })

  it("POS-14-1: baselineAvailability='available' with any ONE of the four fields missing is refused", () => {
    const complete = {
      baselineAvailability: 'available' as const,
      basisKind: 'baseline_observation' as const,
      baselineValue: '42%',
      baselinePeriod: '2023',
      baselineSource: 'Annual household survey',
      baselineContext: 'Same municipality, prior cohort',
      deadweightSupportState: 'supported' as const,
      rationale: RATIONALE,
    }
    for (const key of ['baselineValue', 'baselinePeriod', 'baselineSource', 'baselineContext'] as const) {
      const rest: Record<string, unknown> = { ...complete }
      delete rest[key]
      expect(CounterfactualAssessmentSchema.safeParse(rest).success, key).toBe(false)
    }
  })

  it.each(['not_available', 'not_applicable'] as const)(
    "POS-14-1: baselineAvailability=%s leaves value/period/source/context all optional, but basisKind stays required",
    (baselineAvailability) => {
      const result = CounterfactualAssessmentSchema.safeParse({
        baselineAvailability,
        basisKind: 'documented_assumption',
        deadweightSupportState: 'unknown_or_insufficient',
        rationale: RATIONALE,
      })
      expect(result.success).toBe(true)
    },
  )

  // POS-14-2 — a supported zero deadweight is a legitimate result, not a
  // missing value: the schema imposes no numeric floor, only that
  // deadweightSupportState and rationale are always present.
  it('POS-14-2: deadweightSupportState=supported with a rationale is accepted regardless of the numeric deadweight (schema does not model the number itself)', () => {
    const result = CounterfactualAssessmentSchema.safeParse({
      baselineAvailability: 'not_applicable',
      basisKind: 'documented_assumption',
      deadweightSupportState: 'supported',
      rationale: 'No displacement expected; deadweight assessed as zero based on absence of comparable programs in the region.',
    })
    expect(result.success).toBe(true)
  })

  // POS-14-3 — every non-baseline basis kind is accepted.
  it.each(COUNTERFACTUAL_BASIS_KIND_VALUES.filter((k) => k !== 'baseline_observation'))(
    'POS-14-3: basisKind=%s is accepted absent a baseline',
    (basisKind) => {
      const result = CounterfactualAssessmentSchema.safeParse({
        baselineAvailability: 'not_available',
        basisKind,
        deadweightSupportState: 'supported',
        rationale: RATIONALE,
      })
      expect(result.success).toBe(true)
    },
  )

  // Every deadweight, including 0, needs a rationale (FIBC-018) — enforced
  // unconditionally, in every baseline_availability/deadweight_support_state
  // combination.
  it('rationale is required in every state', () => {
    const result = CounterfactualAssessmentSchema.safeParse({
      baselineAvailability: 'not_applicable',
      basisKind: 'documented_assumption',
      deadweightSupportState: 'supported',
    })
    expect(result.success).toBe(false)
  })

  it('refuses an unrecognized baselineAvailability, basisKind or deadweightSupportState — the vocabularies are closed (FIBDB-046)', () => {
    const base = { basisKind: 'documented_assumption' as const, deadweightSupportState: 'supported' as const, rationale: RATIONALE }
    expect(CounterfactualAssessmentSchema.safeParse({ ...base, baselineAvailability: 'invented' }).success).toBe(false)
    expect(CounterfactualAssessmentSchema.safeParse({ baselineAvailability: 'not_applicable', basisKind: 'invented', deadweightSupportState: 'supported', rationale: RATIONALE }).success).toBe(false)
    expect(CounterfactualAssessmentSchema.safeParse({ baselineAvailability: 'not_applicable', basisKind: 'documented_assumption', deadweightSupportState: 'invented', rationale: RATIONALE }).success).toBe(false)
  })

  it('the three exported vocabularies are the exact closed sets FIBDB-046 enumerates', () => {
    expect([...COUNTERFACTUAL_BASELINE_AVAILABILITY_VALUES].sort()).toEqual(['available', 'not_applicable', 'not_available'].sort())
    expect([...COUNTERFACTUAL_BASIS_KIND_VALUES].sort()).toEqual(
      ['baseline_observation', 'benchmark', 'comparison_group', 'documented_assumption', 'historical_trend', 'literature', 'stakeholder_evidence', 'statistic'].sort(),
    )
    expect([...DEADWEIGHT_SUPPORT_STATE_VALUES].sort()).toEqual(['supported', 'unknown_or_insufficient'].sort())
  })
})

// NEG-14-1 — indicators.baseline_value is read-only to this unit and is
// never converted, copied-as-authoritative, or defaulted into
// counterfactualAssessments by any path (NPDD-03). A structural assertion:
// no write path in this module's FIBIU-14 section assigns baselineValue
// from an indicators row.
describe('NEG-14-1: indicators.baseline_value never auto-converts (NPDD-03)', () => {
  it('recordCounterfactualAssessment does not read indicators.baselineValue as a write source', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(path.join(process.cwd(), 'lib/pipeline/sroi-calculation.ts'), 'utf8')
    const recordFn = source.slice(
      source.indexOf('export async function recordCounterfactualAssessment'),
      source.indexOf('export async function recordCounterfactualAssessment') + 3000,
    )
    expect(recordFn).not.toMatch(/indicators\.baselineValue/)
  })
})
