// lib/stella/__tests__/model-target.test.ts
//
// G1-M0 — THE MODEL TARGET, AS A GATE.
//
// gemini-2.5-flash has an announced shutdown (2026-10-16), so certifying Stella
// against it would have produced a certification with an expiry date. This file
// pins the migration to gemini-3.6-flash in the three places it can silently
// regress:
//
//   1. the production default itself;
//   2. the sampling parameters that must NOT accompany it (temperature, top_p,
//      top_k are deprecated for 3.6 Flash);
//   3. the real-provider eval harness, which used to carry its own copy of the
//      default and could therefore certify a model production had left behind.
//
// It also re-pins the parts of the Advisor output contract the migration had to
// leave untouched. Those have their own suites; asserted again here because the
// question this gate answers is "did changing the model loosen anything?", and
// an answer spread across four files is an answer nobody reads.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stellaConfig, STELLA_DEFAULT_GEMINI_MODEL } from '../config'
import {
  AdvisorContextualOutputSchema,
  buildContextualResponseJsonSchema,
} from '../schemas/advisor-contextual-output'
import { decodeProviderSourceRefIndexes } from '../context/decode-provider-source-ref-indexes'

const REAL_RUNNER = path.resolve(
  process.cwd(),
  'tests',
  'eval',
  'stella-contextual-real',
  'run.ts'
)

describe('G1-M0 — production model target', () => {
  it('defaults to gemini-3.6-flash', () => {
    expect(STELLA_DEFAULT_GEMINI_MODEL).toBe('gemini-3.6-flash')
  })

  it('names no retired or sunsetting model as the default', () => {
    // gemini-2.0-flash returned 404 from Google; gemini-2.5-flash has an
    // announced shutdown. Neither may be the default again.
    expect(STELLA_DEFAULT_GEMINI_MODEL).not.toBe('gemini-2.0-flash')
    expect(STELLA_DEFAULT_GEMINI_MODEL).not.toBe('gemini-2.5-flash')
  })

  it('resolves geminiModel as GEMINI_MODEL override or the default', () => {
    // Stated as a RELATIONSHIP rather than a literal so the test is correct
    // whether or not the developer running it has GEMINI_MODEL exported.
    expect(stellaConfig.geminiModel).toBe(process.env.GEMINI_MODEL ?? STELLA_DEFAULT_GEMINI_MODEL)
  })
})

describe('G1-M0 — sampling parameters are absent from configuration', () => {
  it('exposes no temperature, topP or topK on stellaConfig', () => {
    // Removed from the config surface, not merely unsent: a knob that still
    // parses and no longer does anything is worse than an absent one.
    expect('temperature' in stellaConfig).toBe(false)
    expect('topP' in stellaConfig).toBe(false)
    expect('topK' in stellaConfig).toBe(false)
  })

  it('keeps the caps that are NOT sampling parameters', () => {
    expect(stellaConfig.maxOutputTokens).toBeGreaterThan(0)
    expect(stellaConfig.maxPromptChars).toBeGreaterThan(0)
    expect(stellaConfig.requestTimeoutMs).toBe(15000)
  })

  it('no longer reads STELLA_TEMPERATURE', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'lib', 'stella', 'config.ts'), 'utf8')
    // The name may appear in the explanatory comment; what must not appear is a
    // read of it.
    expect(source).not.toContain("process.env['STELLA_TEMPERATURE']")
    expect(source).not.toContain('process.env.STELLA_TEMPERATURE')
    expect(source).not.toContain("envTemperature('STELLA_TEMPERATURE'")
  })
})

describe('G1-M0 — harness/production parity', () => {
  const source = () => readFileSync(REAL_RUNNER, 'utf8')

  it('the real-provider runner hardcodes no Gemini model id', () => {
    // Three copies of `process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'` used to
    // live here. Any `gemini-<major>.<minor>-...` literal is a regression.
    expect(source()).not.toMatch(/['"]gemini-\d/)
  })

  it('the real-provider runner reads the model from production config', () => {
    const text = source()
    expect(text).toContain("from '@/lib/stella/config'")
    expect(text).toContain('stellaConfig.geminiModel')
  })

  it('the real-provider runner passes no sampling override to the adapter', () => {
    const text = source()
    expect(text).not.toMatch(/\btemperature\s*:/)
    expect(text).not.toMatch(/\btopP\s*:/)
    expect(text).not.toMatch(/\btopK\s*:/)
  })

  it('keeps the ONE deliberate divergence: the harness 60s timeout', () => {
    // Not an oversight and not parity debt — G1-A measures model behaviour, and
    // the production 15 s budget is exercised in G1-B. Pinned so that removing
    // it becomes a decision.
    expect(source()).toContain('timeoutMs: 60_000')
  })
})

describe('G1-M0 — the Advisor output contract survived the migration', () => {
  const valid = {
    step: 'stakeholders' as const,
    responseType: 'review' as const,
    summary: 'Resumen.',
    findings: [],
    suggestions: [],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true as const,
  }

  it('is still strict — an unknown property is rejected', () => {
    expect(() =>
      AdvisorContextualOutputSchema.parse({ ...valid, temperature: 0.2 })
    ).toThrow()
  })

  it('still requires requiresHumanReview to be literally true', () => {
    expect(AdvisorContextualOutputSchema.parse(valid).requiresHumanReview).toBe(true)
    expect(() => AdvisorContextualOutputSchema.parse({ ...valid, requiresHumanReview: false })).toThrow()
  })

  it('still bounds sourceRefIndexes to the catalog in the PROVIDER schema', () => {
    const schema = buildContextualResponseJsonSchema('stakeholders', ['a.b', 'c.d', 'e.f']) as {
      properties: { findings: { items: { properties: { sourceRefIndexes: unknown } } } }
    }
    expect(schema.properties.findings.items.properties.sourceRefIndexes).toEqual({
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 2 },
    })
  })

  it('still forbids any index when the catalog is empty', () => {
    const schema = buildContextualResponseJsonSchema('stakeholders', []) as {
      properties: { findings: { items: { properties: { sourceRefIndexes: unknown } } } }
    }
    expect(schema.properties.findings.items.properties.sourceRefIndexes).toEqual({
      type: 'array',
      maxItems: 0,
    })
  })

  it('still pins the step as a const in the provider schema', () => {
    const schema = buildContextualResponseJsonSchema('proxies', ['a.b']) as {
      properties: { step: unknown; requiresHumanReview: unknown }
    }
    expect(schema.properties.step).toEqual({ const: 'proxies' })
    expect(schema.properties.requiresHumanReview).toEqual({ const: true })
  })

  it('still rejects an out-of-range index at decode time', () => {
    const response = {
      ...valid,
      findings: [
        {
          id: 'f1',
          severity: 'info',
          title: 'T',
          explanation: 'E',
          sourceRefIndexes: [5],
        },
      ],
    }

    expect(() => decodeProviderSourceRefIndexes(response, ['a.b'], 'stakeholders')).toThrow()
  })
})
