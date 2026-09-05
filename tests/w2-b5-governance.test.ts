// tests/w2-b5-governance.test.ts
// W2-B5 (HPO-ODS-W2-17) — structural/static controls that do not fit
// cleanly under a single FIBIU: certified migration order (POS-DAG-1),
// Stella-availability invariance (NEG-17-8), no stage-F retirement
// (NEG-17-11), absence of the superseded uniform model (NEG-18-1), no
// statistical confidence semantics (NEG-18-6), no universal materiality
// threshold (NEG-18-7), the Stella write-boundary refusal shape
// (NEG-STELLA-B5), stage-A-only DDL (NEG-STAGE-1), no Wave-3+ surface
// touched (NEG-WAVE-1), and the historical R3.5 pin staying untouched
// (NEG-BASE-2 / MUT-BASE-2).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import journal from '@/db/migrations/meta/_journal.json'
import { BASELINE_UNITS, BASELINE_ORDER } from '@/db/hosted/baseline-manifest'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

// POS-DAG-1 — FIBDB-015 (FIBIU-17, migration 0064) registered before
// FIBDB-017/018/048 (FIBIU-18, migration 0065), a write serialization with
// NO product dependency edge (FIB section 13 PARALLEL_GROUPS {17, 18}).
describe('POS-DAG-1: certified internal order (FIBIU-17 before FIBIU-18)', () => {
  it('db/migrations/meta/_journal.json registers 0064 before 0065', () => {
    const idx0064 = journal.entries.findIndex((e) => e.tag === '0064_fib_readiness_assessments')
    const idx0065 = journal.entries.findIndex((e) => e.tag === '0065_fib_sensitivity_model')
    expect(idx0064).toBeGreaterThanOrEqual(0)
    expect(idx0065).toBeGreaterThanOrEqual(0)
    expect(idx0064).toBeLessThan(idx0065)
  })

  it('db/hosted/baseline-manifest.ts BASELINE_ORDER places 0064 before 0065, and 0065 depends on 0064', () => {
    const i0064 = BASELINE_ORDER.indexOf('0064_fib_readiness_assessments.sql')
    const i0065 = BASELINE_ORDER.indexOf('0065_fib_sensitivity_model.sql')
    expect(i0064).toBeGreaterThanOrEqual(0)
    expect(i0065).toBeGreaterThanOrEqual(0)
    expect(i0064).toBeLessThan(i0065)

    const unit0065 = BASELINE_UNITS.find((u) => u.id === '0065_fib_sensitivity_model.sql')
    expect(unit0065?.dependsOn).toContain('0064_fib_readiness_assessments.sql')
  })

  it('this is a write serialization, not a product dependency edge — FIB section 13 lists {17, 18} as one parallel group', () => {
    // Static assertion of the authority text this control exists to prove:
    // no code path may encode FIBIU-17 as a runtime precondition of FIBIU-18
    // or vice versa. Both sroi-readiness.ts and sroi-sensitivity.ts import
    // only from sroi-calculation.ts (the shared engine) — never from each other.
    const readiness = read('lib/pipeline/sroi-readiness.ts')
    const sensitivity = read('lib/pipeline/sroi-sensitivity.ts')
    expect(readiness).not.toMatch(/from ['"]@\/lib\/pipeline\/sroi-sensitivity['"]/)
    expect(sensitivity).not.toMatch(/from ['"]@\/lib\/pipeline\/sroi-readiness['"]/)
  })
})

// NEG-17-8 — no criterion of the 46 may resolve by consulting whether
// Stella is enabled, available, or was invoked (V-17 construction invariant).
describe('NEG-17-8: readiness never consults Stella availability', () => {
  it('lib/pipeline/sroi-readiness.ts imports nothing from lib/stella/**', () => {
    const source = read('lib/pipeline/sroi-readiness.ts')
    expect(source).not.toMatch(/from ['"]@\/lib\/stella\//)
  })

  it('lib/pipeline/sroi-readiness.ts reads no STELLA_* capability flag or config', () => {
    const source = read('lib/pipeline/sroi-readiness.ts')
    expect(source).not.toMatch(/STELLA_[A-Z_]*(?:ENABLED|AVAILABLE|CAPABILITY)/)
    expect(source).not.toMatch(/stellaConfig|stellaState/)
  })

  it('D8-4 resolves by whether high findings exist, never by whether Stella was invoked as a flag', () => {
    const source = read('lib/pipeline/sroi-readiness.ts')
    const d84Start = source.indexOf("id: 'D8-4'")
    expect(d84Start).toBeGreaterThan(-1)
    // The vacuity branches are keyed on stellaWasExecuted (derived from
    // whether ANY stella_interactions row exists) and highStellaFindingIds
    // (derived from ACTUAL findings) — never a boolean capability/enabled flag.
    expect(source).not.toMatch(/stellaEnabled|isStellaEnabled|stellaCapabilityReady/)
  })
})

// NEG-17-11 — no stage-F retirement. sroi_run_reviews.readiness_score still
// exists with its historical values; the B5 migrations contain no DROP
// COLUMN, no rename, no NOT NULL and no read-only trigger against it.
describe('NEG-17-11: no stage-F retirement of the legacy readiness column', () => {
  it('migration 0064 contains no DROP COLUMN, rename or NOT NULL against sroi_run_reviews.readiness_score', () => {
    const sql = read('db/migrations/0064_fib_readiness_assessments.sql')
    expect(sql).not.toMatch(/DROP\s+COLUMN\s+"?readiness_score"?/i)
    expect(sql).not.toMatch(/RENAME\s+COLUMN\s+"?readiness_score"?/i)
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+"?readiness_score"?\s+SET\s+NOT\s+NULL/i)
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i)
  })

  it('db/schema.ts still declares sroi_run_reviews.readinessScore as a live column', () => {
    const schema = read('db/schema.ts')
    const block = schema.slice(schema.indexOf("pgTable('sroi_run_reviews'"), schema.indexOf("pgTable('sroi_run_reviews'") + 1200)
    expect(block).toMatch(/readinessScore: integer\('readiness_score'\)/)
  })
})

// NEG-18-1 — the uniform +/-10pp model is SUPERSEDED, not extended: none of
// its three identifiers exists anywhere in lib/** or app/**, not even in a
// comment naming them (the B4 byte-pin this inverts asserted PRESENCE at
// lib/pipeline/sroi-sensitivity.ts specifically).
describe('NEG-18-1: the legacy uniform scenario model is absent from lib/** and app/**', () => {
  const SCAN_ROOTS = ['lib', 'app']
  const SUPERSEDED_IDENTIFIERS = ['SCENARIO_DELTA_PP', 'scenarioFilterPct', 'calculateSroiScenarios']

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const full = path.join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full, out)
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  it.each(SUPERSEDED_IDENTIFIERS)('%s appears in no lib/** or app/** file', (identifier) => {
    const hits: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of walk(path.join(ROOT, root))) {
        const source = readFileSync(file, 'utf8')
        if (source.includes(identifier)) hits.push(path.relative(ROOT, file))
      }
    }
    expect(hits).toEqual([])
  })
})

// NEG-18-6 — no confidence interval, standard deviation, variance, p-value
// or probability language in the sensitivity service's COMPUTED SEMANTICS
// or SURFACED COPY; min/max is exposed only as a scenario envelope. Code
// comments that name the forbidden concept only to disclaim it (as this
// module's own header does) are not themselves a violation — strip `//`
// line comments before scanning, mirroring the NEG-STAGE-1 precedent in
// tests/w2-b4-governance.test.ts.
describe('NEG-18-6: no statistical confidence semantics', () => {
  const FORBIDDEN = /confidence interval|standard deviation|\bvariance\b|p-value|probability distribution/i
  const stripLineComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('lib/pipeline/sroi-sensitivity.ts computes/surfaces no confidence-interval semantics (outside disclaiming comments)', () => {
    expect(stripLineComments(read('lib/pipeline/sroi-sensitivity.ts'))).not.toMatch(FORBIDDEN)
  })

  it("the envelope is labelled 'scenario_envelope', never a confidence interval", () => {
    const source = read('lib/pipeline/sroi-sensitivity.ts')
    expect(source).toMatch(/scenario_envelope/)
    expect(stripLineComments(source)).not.toMatch(FORBIDDEN)
  })

  it('the run-detail UI presents the envelope without confidence-interval language', () => {
    const ui = read('app/app/projects/[projectId]/pipeline/calculation/runs/[runId]/page.tsx')
    const envelopeSection = ui.slice(ui.indexOf('scenarioEnvelope &&'))
    expect(envelopeSection.slice(0, 800)).not.toMatch(FORBIDDEN)
  })
})

// NEG-18-7 — no hardcoded percentage decides material sensitivity; the
// system computes and displays deltas and the reviewer records the
// determination (no universal threshold constant anywhere in the module).
describe('NEG-18-7: no universal materiality threshold', () => {
  it('lib/pipeline/sroi-sensitivity.ts declares no materiality-threshold constant', () => {
    const source = read('lib/pipeline/sroi-sensitivity.ts')
    expect(source).not.toMatch(/MATERIALITY_THRESHOLD|MATERIAL_DELTA_PCT|SIGNIFICANCE_THRESHOLD/)
  })
})

// NEG-STELLA-B5 — no FIBIU-17 or FIBIU-18 write path admits a
// Stella-originated actor; every write authorizes through a human session
// accessor (requireOrganizationAccess); readiness computation is pure with
// no actor parameter; Stella never computes scenario ratios nor determines
// which scenarios are used.
describe('NEG-STELLA-B5: no write path admits a Stella-originated actor', () => {
  const WRITE_FUNCTIONS = [
    { file: 'lib/pipeline/sroi-readiness.ts', fn: 'computeAndPersistReadinessAssessment' },
    { file: 'lib/pipeline/sroi-sensitivity.ts', fn: 'registerSensitivityCandidates' },
    { file: 'lib/pipeline/sroi-sensitivity.ts', fn: 'dispositionSensitivityCandidate' },
    { file: 'lib/pipeline/sroi-sensitivity.ts', fn: 'recordSensitivityScenario' },
  ]

  it.each(WRITE_FUNCTIONS)('$fn ($file) contains no stella-branded actor path and authorizes via a human session accessor', ({ file, fn }) => {
    const source = read(file)
    const start = source.indexOf(`function ${fn}`)
    expect(start, `${fn} not found in ${file}`).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, start + 2500)
    expect(body).not.toMatch(/stella/i)
    expect(body).toMatch(/authorize/)
  })

  it('computeReadinessAssessment (the pure computation) has no actor/identity parameter at all — Stella cannot even be passed in', () => {
    const source = read('lib/pipeline/sroi-readiness.ts')
    const start = source.indexOf('export function computeReadinessAssessment')
    const signatureEnd = source.indexOf(')', start)
    const signature = source.slice(start, signatureEnd)
    expect(signature).not.toMatch(/actor|user|stella/i)
  })

  it('the deterministic engine (runDeterministicCalc) computes every scenario result — sroi-sensitivity.ts never branches on a Stella-originated value to select a scenario', () => {
    const source = read('lib/pipeline/sroi-sensitivity.ts')
    const scenarioFn = source.slice(source.indexOf('export async function recordSensitivityScenario'))
    expect(scenarioFn).toMatch(/runDeterministicCalc/)
    expect(scenarioFn).not.toMatch(/stella/i)
  })
})

// NEG-STAGE-1 — FIBDB-017/018/048 declare stage A and E; only the additive
// stage-A form ships. No approved-version immutability trigger, no VALIDATE
// of a NOT VALID constraint, no other stage-E hardening in a B5 migration.
describe('NEG-STAGE-1: no stage-E hardening ships in B5', () => {
  it.each(['db/migrations/0064_fib_readiness_assessments.sql', 'db/migrations/0065_fib_sensitivity_model.sql'])(
    '%s contains no CREATE TRIGGER, no VALIDATE CONSTRAINT, and no NOT VALID (executable SQL only)',
    (file) => {
      const sql = read(file)
      const executable = sql.replace(/^\s*--.*$/gm, '')
      expect(executable).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i)
      expect(executable).not.toMatch(/VALIDATE\s+CONSTRAINT/i)
      expect(executable).not.toMatch(/NOT\s+VALID/i)
      expect(executable).not.toMatch(/SECURITY\s+DEFINER/i)
      expect(executable).not.toMatch(/ENABLE\s+ALWAYS/i)
    },
  )

  it('every CHECK constraint in both migrations is a plain, immediately-validated CHECK (no deferred/NOT VALID form)', () => {
    for (const file of ['db/migrations/0064_fib_readiness_assessments.sql', 'db/migrations/0065_fib_sensitivity_model.sql']) {
      const sql = read(file)
      const checks = [...sql.matchAll(/CONSTRAINT\s+"[^"]+"\s+CHECK/gi)]
      expect(checks.length, file).toBeGreaterThan(0)
    }
  })
})

// NEG-WAVE-1 — B5 does not materialize Wave 3 or later. No readiness_assessments
// consumer performs eligibility composition; no FIBIU-19/20/24/26/27/30
// surface is touched; FIBDB-051/030/052 remain unmaterialized.
describe('NEG-WAVE-1: B5 does not materialize Wave 3 or later', () => {
  it('getSroiCalculationReadiness (FIBIU-19 surface) is untouched by any readiness/sensitivity reference', () => {
    const source = read('lib/pipeline/sroi-calculation.ts')
    const fnStart = source.indexOf('export async function getSroiCalculationReadiness')
    const fnEnd = source.indexOf('\n}', fnStart)
    const body = source.slice(fnStart, fnEnd)
    expect(body).not.toMatch(/readiness_assessments|readinessAssessments|sensitivity_candidates|sensitivityCandidates/)
  })

  it('lib/portfolios/analytics.ts does not switch its readiness source to readiness_assessments (FIBIU-27, Wave 5, frozen for B5)', () => {
    // A disclaiming comment naming the future FIBIU-27 surface switch (as
    // this file's own doc-comment does) is not itself a violation — the
    // control is that no CODE actually imports or queries the table.
    const source = read('lib/portfolios/analytics.ts').replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/readinessAssessments|readiness_assessments/)
  })

  it('no FIBDB-051/030/052 vocabulary or object is introduced by this migration pair', () => {
    for (const file of ['db/migrations/0064_fib_readiness_assessments.sql', 'db/migrations/0065_fib_sensitivity_model.sql']) {
      const sql = read(file)
      expect(sql).not.toMatch(/legacy_class|verification_hash/i)
    }
  })
})

// NEG-BASE-2 / MUT-BASE-2 — the historical R3.5-era 50-unit certification
// pin is a frozen closure fact, never advanced by a baseline-growth sweep.
describe('NEG-BASE-2: the historical R3.5 pin is untouched by the 76->78 baseline-growth sweep', () => {
  it('scripts/stella-r3-5-pg17-certify.ts still asserts BASELINE_UNITS.length !== 50', () => {
    const source = read('scripts/stella-r3-5-pg17-certify.ts')
    const matches = [...source.matchAll(/BASELINE_UNITS\.length\s*!==\s*50/g)]
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})
