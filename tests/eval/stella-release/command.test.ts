// tests/eval/stella-release/command.test.ts
// RELEASE line — end-to-end test of the OFFICIAL command
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fase 4).
//
//   pnpm test:stella:release-eval
//
// wiring.test.ts pins the package.json string. This runs it. The difference
// matters: a script entry can point at a file that exists, parse fine, and
// still exit non-zero, print nothing structured, or vary between runs. None of
// that is visible from the manifest.
//
// package.json is INTEGRATION-OWNED (§7) and is NOT modified here — the
// command already exists, added by the train 2 shared-root preparation unit.
//
// This spawns pnpm on purpose rather than reimplementing the command as a
// direct tsx call: reimplementing it would test a command nobody runs. If pnpm
// is not on PATH the test FAILS rather than skipping — a silently skipped
// end-to-end test reports coverage it is not providing.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(__dirname, '..', '..', '..')
const COMMAND = 'pnpm run test:stella:release-eval'

interface StructuredOutput {
  version: { harness: string; matrix: string; fixtures: string }
  results: {
    checkId: string
    fixtureId: string
    result: 'pass' | 'fail'
    outcome: string
    detail: string
    negativeControls: { controlId: string; property: string; detected: boolean; detail: string }[]
  }[]
  metrics: {
    metric: string
    measurable: boolean
    value: number | null
    nullReason: { code: string; gate: string | null; detail: string } | null
    detail: string
  }[]
  totals: Record<string, unknown>
}

function runOfficialCommand(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(COMMAND, { cwd: ROOT, encoding: 'utf8', shell: true })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The one deterministic block; everything else may carry timings or warnings. */
function extractStructured(stdout: string): StructuredOutput {
  const line = stdout.split('\n').find((l) => l.includes('[eval:release] json '))
  if (!line) throw new Error(`no structured output block in:\n${stdout}`)
  return JSON.parse(line.slice(line.indexOf('[eval:release] json ') + '[eval:release] json '.length)) as StructuredOutput
}

describe('pnpm test:stella:release-eval (official command)', () => {
  const first = runOfficialCommand()

  it('exits zero', () => {
    expect(first.status, `stderr:\n${first.stderr}\nstdout tail:\n${first.stdout.split('\n').slice(-15).join('\n')}`).toBe(0)
  })

  it('is the command package.json declares, unmodified by this test', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:stella:release-eval']).toBe('tsx scripts/eval-release-offline.ts')
  })

  it('reports harness, matrix and fixture versions', () => {
    const { version } = extractStructured(first.stdout)
    expect(version.harness).toMatch(/^\d+\.\d+\.\d+$/)
    expect(version.matrix).toMatch(/^\d+\.\d+\.\d+$/)
    expect(version.fixtures).toMatch(/^\d+\.\d+\.\d+$/)
    expect(first.stdout).toContain(`harness v${version.harness}, matrix v${version.matrix}, fixtures v${version.fixtures}`)
  })

  it('emits a fixture id and a result for every check', () => {
    const { results } = extractStructured(first.stdout)
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.checkId).toBeTruthy()
      expect(result.fixtureId, `${result.checkId} has no fixtureId`).toBeTruthy()
      expect(['pass', 'fail']).toContain(result.result)
      expect(['pass', 'abstention-response', 'system-error', 'isolation-violation']).toContain(result.outcome)
    }
  })

  it('distinguishes a legitimate abstention from a system error in the emitted outcomes', () => {
    const { results } = extractStructured(first.stdout)
    const outcomes = new Set(results.map((r) => r.outcome))
    expect(outcomes).toContain('abstention-response')
    expect(outcomes).not.toContain('system-error')
    expect(outcomes).not.toContain('isolation-violation')
  })

  it('emits every negative control with its verdict, and all of them detected', () => {
    const { results } = extractStructured(first.stdout)
    const controls = results.flatMap((r) => r.negativeControls)
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.filter((c) => !c.detected)).toEqual([])
    for (const control of controls) {
      expect(control.property, `${control.controlId} declares no property`).toBeTruthy()
    }
  })

  it('emits every metric, with a structured reason behind every null', () => {
    const { metrics } = extractStructured(first.stdout)
    const byName = new Map(metrics.map((m) => [m.metric, m]))
    for (const name of ['citation-precision', 'citation-coverage', 'unsupported-claim-rate', 'abstention-correctness', 'isolation-violations', 'structural-regression']) {
      expect(byName.get(name)?.value, `${name} must carry a value`).not.toBeNull()
    }
    for (const name of ['latency', 'token-usage', 'estimated-provider-cost']) {
      const metric = byName.get(name)!
      expect(metric.measurable).toBe(false)
      expect(metric.value).toBeNull()
      expect(metric.nullReason).not.toBeNull()
      expect(metric.nullReason!.code).toBeTruthy()
    }
    expect(byName.get('latency')!.nullReason!.gate).toBe('G1')
    expect(byName.get('estimated-provider-cost')!.nullReason!.gate).toBe('G9')
  })

  it('makes no provider call and says so', () => {
    const { totals } = extractStructured(first.stdout)
    expect(totals.providerCalls).toBe(0)
  })

  it('produces byte-identical structured output on a second process', () => {
    const second = runOfficialCommand()
    expect(second.status).toBe(0)
    const a = first.stdout.split('\n').find((l) => l.includes('[eval:release] json '))
    const b = second.stdout.split('\n').find((l) => l.includes('[eval:release] json '))
    expect(b).toBe(a)
  })

  it('keeps the non-deterministic wall-clock observation outside the deterministic block', () => {
    expect(first.stdout).toMatch(/observation \(non-deterministic\): harnessWallClockMs=\d+/)
    expect(extractStructured(first.stdout)).not.toHaveProperty('harnessWallClockMs')
  })
}, 180_000)
