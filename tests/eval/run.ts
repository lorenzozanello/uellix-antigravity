// tests/eval/run.ts
// Etapa A1 (STL-A1-012). CLI entry point for the Stella eval harness.
//
// NEVER invoked by pnpm test / test:unit / test:integration / any CI
// workflow — only by `pnpm stella:eval`, a script a human runs deliberately.
// Does nothing (no network call, no file write) unless STELLA_EVAL_REAL_MODEL
// is the exact string 'true'. Does not import '@/db/client' anywhere in this
// file or in tests/eval/engine.ts/cases/index.ts/rubric.ts — this harness
// never touches a database, local or remote.

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getGeminiAdapter } from '@/lib/stella/adapter'
import { EVAL_CASES } from './cases'
import { isRealModelEnabled, getMaxCalls, runEval, compareRuns, renderMarkdownSummary } from './engine'
import type { EvalRunSummary } from './types'

const RESULTS_DIR = join(process.cwd(), 'tests', 'eval', 'results')

function loadMostRecentPreviousRun(): EvalRunSummary | null {
  try {
    const files = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
    if (files.length === 0) return null
    const latest = files[files.length - 1]
    return JSON.parse(readFileSync(join(RESULTS_DIR, latest), 'utf-8')) as EvalRunSummary
  } catch {
    return null
  }
}

async function main() {
  if (!isRealModelEnabled()) {
    console.log(
      '[stella:eval] STELLA_EVAL_REAL_MODEL is not "true" — skipping. ' +
        'This harness never calls the real model by default. Set STELLA_EVAL_REAL_MODEL=true to run it.',
    )
    return
  }

  const maxCalls = getMaxCalls()
  console.log(`[stella:eval] Running against the real model. Budget: ${maxCalls} calls max.`)

  const adapter = getGeminiAdapter()
  const previous = loadMostRecentPreviousRun()

  const summary = await runEval(
    EVAL_CASES,
    async ({ systemPrompt, userMessage, role }) => {
      const response = await adapter.generate({ role, systemPrompt, userMessage })
      return { rawOutput: response.rawOutput, modelUsed: response.modelUsed }
    },
    maxCalls,
  )

  const diffLines = compareRuns(previous, summary)
  const markdown = renderMarkdownSummary(summary, diffLines)

  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, `${summary.runId}.json`), JSON.stringify(summary, null, 2))
  writeFileSync(join(RESULTS_DIR, `${summary.runId}.md`), markdown)

  console.log(markdown)
  console.log(`[stella:eval] Result: ${summary.approved ? 'APROBADA' : 'REPROBADA'}`)

  process.exit(summary.approved ? 0 : 1)
}

main().catch((err) => {
  console.error('[stella:eval] Failed:', err)
  process.exit(1)
})
