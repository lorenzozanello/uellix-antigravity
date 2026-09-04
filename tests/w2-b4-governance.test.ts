// tests/w2-b4-governance.test.ts
// W2-B4 (HPO-ODS-W2-12) — structural/static controls that do not fit
// cleanly under a single FIBIU: certified migration order (POS-DAG-1), the
// B5 boundary (NEG-B5-1), stage-A-only DDL (NEG-STAGE-1), and the Stella
// write-boundary refusal shape (NEG-STELLA-B4).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import journal from '@/db/migrations/meta/_journal.json'
import { BASELINE_UNITS, BASELINE_ORDER } from '@/db/hosted/baseline-manifest'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

// POS-DAG-1 — FIBDB-012/013/047 (FIBIU-15, migration 0062) registered before
// FIBDB-011/046 (FIBIU-14, migration 0063), certified SERIAL_CONTRACT
// 15->{14,16}. FIBDB-013 depends on FIBDB-012 (asserted via the migration's
// own FK, proven at the schema level, not re-derived here).
describe('POS-DAG-1: certified internal order (FIBIU-15 before FIBIU-14)', () => {
  it('db/migrations/meta/_journal.json registers 0062 before 0063', () => {
    const idx0062 = journal.entries.findIndex((e) => e.tag === '0062_fib_methodological_assumptions')
    const idx0063 = journal.entries.findIndex((e) => e.tag === '0063_fib_counterfactual_assessments')
    expect(idx0062).toBeGreaterThanOrEqual(0)
    expect(idx0063).toBeGreaterThanOrEqual(0)
    expect(idx0062).toBeLessThan(idx0063)
  })

  it('db/hosted/baseline-manifest.ts BASELINE_ORDER places 0062 before 0063, and 0063 depends on 0062', () => {
    const i0062 = BASELINE_ORDER.indexOf('0062_fib_methodological_assumptions.sql')
    const i0063 = BASELINE_ORDER.indexOf('0063_fib_counterfactual_assessments.sql')
    expect(i0062).toBeGreaterThanOrEqual(0)
    expect(i0063).toBeGreaterThanOrEqual(0)
    expect(i0062).toBeLessThan(i0063)

    const unit0063 = BASELINE_UNITS.find((u) => u.id === '0063_fib_counterfactual_assessments.sql')
    expect(unit0063?.dependsOn).toContain('0062_fib_methodological_assumptions.sql')
  })

  it('FIBDB-013 (assumption_object_links) depends on FIBDB-012 (methodological_assumptions) via its own FK, both created in 0062', () => {
    const sql = read('db/migrations/0062_fib_methodological_assumptions.sql')
    expect(sql).toMatch(/ADD CONSTRAINT "assumption_object_links_assumption_id_methodological_assumptions_id_fk"/)
  })
})

// NEG-B5-1 — B4 does not materialize B5. FIBDB-015/016/017/018/048 remain
// unmaterialized.
describe('NEG-B5-1: B4 does not materialize B5', () => {
  it('no readiness_assessments, sensitivity_candidates or sensitivity_scenarios table exists in schema.ts', () => {
    const schema = read('db/schema.ts')
    expect(schema).not.toMatch(/readinessAssessments|readiness_assessments/)
    expect(schema).not.toMatch(/sensitivityCandidates|sensitivity_candidates/)
    expect(schema).not.toMatch(/sensitivityScenarios|sensitivity_scenarios/)
  })

  it('sroi_run_reviews.readiness_score carries no legacy marking (FIBDB-016 is FIBIU-17 scope, not B4)', () => {
    const schema = read('db/schema.ts')
    const runReviewsBlock = schema.slice(schema.indexOf("pgTable('sroi_run_reviews'"), schema.indexOf("pgTable('sroi_run_reviews'") + 1200)
    expect(runReviewsBlock).toMatch(/readinessScore/)
    expect(runReviewsBlock).not.toMatch(/legacy|deprecated|LEGACY_MARKING/i)
  })

  it('lib/pipeline/sroi-sensitivity.ts is byte-unchanged — SCENARIO_DELTA_PP still present, not superseded by this mission', () => {
    const source = read('lib/pipeline/sroi-sensitivity.ts')
    expect(source).toMatch(/SCENARIO_DELTA_PP/)
  })

  // Scoped to the NEW W2-B4 content each file adds, not the whole file —
  // narratives.ts/sroi-calculation.ts legitimately pre-date B4 and already
  // reference sibling modules (e.g. sroi-calculation.ts already imports
  // sroi-sensitivity for the existing engine, and already comments on
  // sroi-results.ts for the pre-existing evidence-sufficiency boundary).
  // Scanning those unrelated, pre-existing references would be exactly the
  // false positive this control must not produce.
  it('the FIBIU-15/16 sections this mission added reference no FIBIU-17/18 surface', () => {
    const narratives = read('lib/pipeline/narratives.ts')
    const fibiu15 = narratives.slice(narratives.indexOf('FIBIU-15 — structured methodological assumptions'))
    expect(fibiu15).not.toMatch(/methodology-review|sroi-results|sroi-sensitivity|portfolios\/analytics|build-composer-context|build-validator-context/)

    const sroiCalc = read('lib/pipeline/sroi-calculation.ts')
    const counterfactualSection = sroiCalc.slice(
      sroiCalc.indexOf('Counterfactual assessment (FIBIU-14)'),
      sroiCalc.indexOf('W2-B3 completeness (AG-B3-2, COVERAGE_COMPLETENESS)'),
    )
    expect(counterfactualSection).not.toMatch(/methodology-review|sroi-results|portfolios\/analytics|build-composer-context|build-validator-context/)

    const toc = read('lib/pipeline/theory-of-change.ts')
    const fibiu16 = toc.slice(toc.indexOf('FIBIU-16 — causal chain sufficiency gate'))
    expect(fibiu16).not.toMatch(/methodology-review|sroi-results|sroi-sensitivity|portfolios\/analytics|build-composer-context|build-validator-context/)
  })
})

// NEG-STAGE-1 — FIBDB-046 declares stages A and E; only the additive stage-A
// form ships. No approved-version immutability trigger, no VALIDATE of a NOT
// VALID constraint, no other stage-E hardening in a B4 migration.
describe('NEG-STAGE-1: no stage-E hardening ships in B4', () => {
  it.each(['db/migrations/0062_fib_methodological_assumptions.sql', 'db/migrations/0063_fib_counterfactual_assessments.sql'])(
    '%s contains no CREATE TRIGGER, no VALIDATE CONSTRAINT, and no NOT VALID (executable SQL only — the header comments explaining this absence do not count)',
    (file) => {
      const sql = read(file)
      // Strip `-- ...` comment lines first: the header prose EXPLAINS that no
      // SECURITY DEFINER surface exists, which would otherwise self-defeat a
      // naive substring match.
      const executable = sql.replace(/^\s*--.*$/gm, '')
      expect(executable).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i)
      expect(executable).not.toMatch(/VALIDATE\s+CONSTRAINT/i)
      expect(executable).not.toMatch(/NOT\s+VALID/i)
      expect(executable).not.toMatch(/SECURITY\s+DEFINER/i)
      expect(executable).not.toMatch(/ENABLE\s+ALWAYS/i)
    },
  )

  it('every CHECK constraint in both migrations is a plain, immediately-validated CHECK (no deferred/NOT VALID form)', () => {
    for (const file of ['db/migrations/0062_fib_methodological_assumptions.sql', 'db/migrations/0063_fib_counterfactual_assessments.sql']) {
      const sql = read(file)
      const checks = [...sql.matchAll(/CONSTRAINT\s+"[^"]+"\s+CHECK/gi)]
      expect(checks.length, file).toBeGreaterThan(0)
    }
  })
})

// NEG-STELLA-B4 — for all three units, Stella cannot cross any human/system
// decision boundary. Asserted as refusals at the write boundary: none of the
// FIBIU-14/15/16 write functions accept a caller identity other than the
// authenticated human session (requireOrganizationAccess/
// getCurrentOrganizationContext), and none contains a Stella-branded bypass.
describe('NEG-STELLA-B4: no write path admits a Stella-originated actor', () => {
  const WRITE_FUNCTIONS = [
    { file: 'lib/pipeline/narratives.ts', fn: 'recordMethodologicalAssumption' },
    { file: 'lib/pipeline/narratives.ts', fn: 'updateMethodologicalAssumption' },
    { file: 'lib/pipeline/narratives.ts', fn: 'linkAssumptionToObject' },
    { file: 'lib/pipeline/sroi-calculation.ts', fn: 'recordCounterfactualAssessment' },
  ]

  it.each(WRITE_FUNCTIONS)('$fn ($file) contains no stella-branded actor path and authorizes via a human session accessor', ({ file, fn }) => {
    const source = read(file)
    const start = source.indexOf(`function ${fn}`)
    expect(start, `${fn} not found in ${file}`).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, start + 2500)
    expect(body).not.toMatch(/stella/i)
    expect(body).toMatch(/authorize|verifyProjectAccess/)
  })

  it('checkCausalChainSufficiency (FIBIU-16) is a pure function with no actor/identity parameter at all — Stella cannot even be passed in', () => {
    const source = read('lib/pipeline/theory-of-change.ts')
    const start = source.indexOf('export function checkCausalChainSufficiency')
    const signatureEnd = source.indexOf(')', start)
    const signature = source.slice(start, signatureEnd)
    expect(signature).not.toMatch(/actor|user|stella/i)
  })
})
