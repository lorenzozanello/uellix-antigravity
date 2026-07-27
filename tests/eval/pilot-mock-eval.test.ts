// tests/eval/pilot-mock-eval.test.ts
// Etapa B0 (modo piloto restringido) — runs the EXISTING eval harness
// (tests/eval/engine.ts + tests/eval/rubric.ts, unchanged) against the
// REAL StellaPilotMockProvider (lib/stella/pilot/mock-provider.ts), not a
// throwaway test double. This is the harness's mock-only pass: proof the
// pilot's synthetic provider produces output the rubric accepts, BEFORE any
// real Gemini call is ever considered (see §20/preflight).
//
// Scope: only the 'advisor' cases — B0's DEFAULT_PILOT_ENABLED_ROLES is
// ['advisor'] only (lib/stella/pilot/config.ts). Running validator/composer/
// reviewer cases through this provider would be meaningless: the mock always
// returns an advisor-shaped payload (see mock-provider.ts), and those roles
// are not reachable through the pilot in B0 regardless.
//
// Never imports tests/eval/run.ts or lib/stella/adapter/gemini-client's real
// Gemini branch — only the pilot's own mock provider. Never sets
// STELLA_EVAL_REAL_MODEL.

import { describe, it, expect } from 'vitest'
import { runEval } from './engine'
import { EVAL_CASES } from './cases'
import { StellaPilotMockProvider } from '@/lib/stella/pilot/mock-provider'
import type { EvalModelCaller } from './types'

function pilotMockCaller(): EvalModelCaller {
  const provider = new StellaPilotMockProvider({ scenario: 'success' })
  return async ({ systemPrompt, userMessage, role }) => {
    const response = await provider.generate({ role, systemPrompt, userMessage })
    return { rawOutput: response.rawOutput, modelUsed: response.modelUsed }
  }
}

describe('Etapa B0 — eval harness mock-only pass (StellaPilotMockProvider, advisor only)', () => {
  const advisorCases = EVAL_CASES.filter((c) => c.role === 'advisor')

  it('the advisor case subset is non-empty (guards against a silently-empty filter)', () => {
    expect(advisorCases.length).toBeGreaterThan(0)
  })

  it('runs every advisor case through the real pilot mock provider and every case passes the rubric', async () => {
    const summary = await runEval(advisorCases, pilotMockCaller(), advisorCases.length)

    expect(summary.casesRun).toBe(advisorCases.length)
    expect(summary.casesSkippedBudget).toBe(0)
    expect(summary.modelUsed).toBe('stella-pilot-mock')
    expect(summary.failedCases).toBe(0)
    expect(summary.approved).toBe(true)
  })

  it('the fixed synthetic response is immune to the adversarial cases by construction — it never reflects prompt content, so role-change and unauthorized-action attempts cannot influence it', async () => {
    const adversarialCases = advisorCases.filter((c) => c.type === 'adversarial')
    expect(adversarialCases.length).toBeGreaterThan(0)

    const summary = await runEval(adversarialCases, pilotMockCaller(), adversarialCases.length)
    for (const result of summary.results) {
      expect(result.passed).toBe(true)
      for (const check of result.checks) {
        if (check.check === 'noRoleChange' || check.check === 'noUnauthorizedAction') {
          expect(check.passed).toBe(true)
        }
      }
    }
  })

  it('every response is labeled as synthetic — never mistaken for a real model answer', async () => {
    const summary = await runEval(advisorCases, pilotMockCaller(), advisorCases.length)
    // rawOutput isn't retained on EvalCaseResult, so re-derive directly from the provider to assert the labeling invariant.
    const provider = new StellaPilotMockProvider({ scenario: 'success' })
    const sample = await provider.generate({ role: 'advisor', systemPrompt: 's', userMessage: 'u' })
    expect(sample.rawOutput).toContain('SINTÉTICO')
    expect(summary.modelUsed).toBe('stella-pilot-mock')
  })

  it('this file never imports the real-model CLI entry point or sets the real-model env var', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8')
    expect(/from\s+['"]\.\/run['"]/.test(source)).toBe(false)
    expect(/process\.env\.STELLA_EVAL_REAL_MODEL\s*=/.test(source)).toBe(false)
  })
})
