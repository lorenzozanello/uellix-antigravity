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

import { describe, it, expect, vi, afterEach } from 'vitest'
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

})

// F-EU-1 — `??` IS THE WRONG OPERATOR FOR THIS RESOLUTION, AND WAS A BUG.
//
// The PR109/R1 version of this suite asserted
// `stellaConfig.geminiModel === (process.env.GEMINI_MODEL ?? DEFAULT)` — a
// tautology that mirrors whatever operator config.ts actually uses on both
// sides of the comparison, so it passed whether config.ts used `??` (wrong:
// an empty string is not nullish, so `''` survived instead of falling back)
// or the fixed `.trim() || default`. It could never have caught the bug it
// was meant to guard.
//
// This suite instead pins each input to a LITERAL expected output, computed
// independently of config.ts's own operator, against a freshly loaded module
// instance per case (vi.resetModules — stellaConfig is computed once at
// import time from process.env, so re-exercising it requires a fresh import).
describe('F-EU-1 — GEMINI_MODEL resolution treats empty/whitespace as absent', () => {
  const ORIGINAL_GEMINI_MODEL = process.env.GEMINI_MODEL

  afterEach(() => {
    if (ORIGINAL_GEMINI_MODEL === undefined) {
      delete process.env.GEMINI_MODEL
    } else {
      process.env.GEMINI_MODEL = ORIGINAL_GEMINI_MODEL
    }
    vi.resetModules()
  })

  async function resolveGeminiModel(value: string | undefined): Promise<string> {
    if (value === undefined) {
      delete process.env.GEMINI_MODEL
    } else {
      process.env.GEMINI_MODEL = value
    }
    vi.resetModules()
    const mod = await import('../config')
    return mod.stellaConfig.geminiModel
  }

  it('env var absent (undefined) resolves to the default', async () => {
    expect(await resolveGeminiModel(undefined)).toBe('gemini-3.6-flash')
  })

  it('env var empty string resolves to the default', async () => {
    expect(await resolveGeminiModel('')).toBe('gemini-3.6-flash')
  })

  it('env var whitespace-only resolves to the default', async () => {
    expect(await resolveGeminiModel('   ')).toBe('gemini-3.6-flash')
    expect(await resolveGeminiModel('\t\n')).toBe('gemini-3.6-flash')
  })

  it('env var with a custom id resolves to that id, trimmed', async () => {
    expect(await resolveGeminiModel('gemini-4.0-pro')).toBe('gemini-4.0-pro')
    expect(await resolveGeminiModel('  gemini-4.0-pro  ')).toBe('gemini-4.0-pro')
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

// F-ED-1 — .env.example is a DEPLOYMENT ARTIFACT, not just documentation. A
// concrete model id there silently overrides STELLA_DEFAULT_GEMINI_MODEL the
// moment this file is copied into a deployment's real env — so it must ship
// with GEMINI_MODEL empty, and every STELLA_*/GEMINI_* var config.ts actually
// reads must be represented, or an operator has no idea the knob exists.
describe('F-ED-1 — .env.example never overrides the production model default', () => {
  const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example')
  const CONFIG_PATH = path.resolve(process.cwd(), 'lib', 'stella', 'config.ts')

  // CRLF/LF safe: .env.example is not pinned to LF in .gitattributes, so a
  // Windows checkout may materialize it as CRLF while the stored blob (or a
  // contributor's editor) may be LF. Split on either before trimming.
  function parseEnvExample(raw: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const rawLine of raw.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      map.set(line.slice(0, eq).trim(), line.slice(eq + 1))
    }
    return map
  }

  // Derived from config.ts source, not a hardcoded list — a var added there
  // without an .env.example entry must fail this test, not require someone
  // to remember to update a second list by hand.
  //
  // Two read shapes are present in config.ts: a direct `process.env.NAME` /
  // `process.env['NAME']`, and an indirect read through the envPositiveInt(name,
  // fallback) helper, where `process.env[name]` uses the parameter — so the
  // literal that identifies the var lives at the call site, not at the
  // process.env access itself.
  function stellaGeminiVarsReadByConfig(): Set<string> {
    const source = readFileSync(CONFIG_PATH, 'utf8')
    const names = new Set<string>()
    const directPattern = /process\.env(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g
    const helperPattern = /envPositiveInt\(\s*['"]([A-Z0-9_]+)['"]/g
    for (const pattern of [directPattern, helperPattern]) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(source)) !== null) {
        const name = match[1] ?? match[2]
        if (name.startsWith('STELLA_') || name.startsWith('GEMINI_')) {
          names.add(name)
        }
      }
    }
    return names
  }

  it('GEMINI_MODEL is present in .env.example and empty', () => {
    const vars = parseEnvExample(readFileSync(ENV_EXAMPLE_PATH, 'utf8'))
    expect(vars.has('GEMINI_MODEL')).toBe(true)
    expect(vars.get('GEMINI_MODEL')).toBe('')
  })

  it('never pins a concrete Gemini model id to GEMINI_MODEL', () => {
    const vars = parseEnvExample(readFileSync(ENV_EXAMPLE_PATH, 'utf8'))
    expect(vars.get('GEMINI_MODEL')).not.toMatch(/gemini-\d/)
  })

  it('represents every STELLA_*/GEMINI_* var config.ts reads from process.env', () => {
    const readByConfig = stellaGeminiVarsReadByConfig()
    // Sanity: the extraction itself must find the known surface, or the
    // regex (or config.ts) drifted silently and the completeness check below
    // would pass vacuously.
    expect([...readByConfig].sort()).toEqual(
      [
        'GEMINI_API_KEY',
        'GEMINI_MODEL',
        'STELLA_ADVISOR_ENABLED',
        'STELLA_AUDIT_ASSISTANT_ENABLED',
        'STELLA_COMPOSER_ENABLED',
        'STELLA_DECISIONS_PERSISTENCE_ENABLED',
        'STELLA_ENABLED',
        'STELLA_EVIDENCE_REVIEWER_ENABLED',
        'STELLA_GROUNDED_QUERY_ENABLED',
        'STELLA_LEGACY_ADVISOR_ENABLED',
        'STELLA_MAX_OUTPUT_TOKENS',
        'STELLA_MAX_PROMPT_CHARS',
        'STELLA_PROXY_REVIEWER_ENABLED',
        'STELLA_RATE_LIMIT_PER_HOUR',
        'STELLA_VALIDATOR_ENABLED',
      ].sort()
    )

    const declaredInEnvExample = parseEnvExample(readFileSync(ENV_EXAMPLE_PATH, 'utf8'))
    const missing = [...readByConfig].filter((name) => !declaredInEnvExample.has(name)).sort()
    expect(missing).toEqual([])
  })

  it('parses .env.example identically whether its line endings are CRLF or LF', () => {
    const raw = readFileSync(ENV_EXAMPLE_PATH, 'utf8')
    const asLf = raw.replace(/\r\n/g, '\n')
    const asCrlf = asLf.replace(/\n/g, '\r\n')

    const lfVars = parseEnvExample(asLf)
    const crlfVars = parseEnvExample(asCrlf)

    expect(crlfVars.size).toBe(lfVars.size)
    expect(crlfVars.get('GEMINI_MODEL')).toBe('')
    expect(lfVars.get('GEMINI_MODEL')).toBe('')
    for (const [key, value] of lfVars) {
      expect(crlfVars.get(key)).toBe(value)
    }
  })
})
