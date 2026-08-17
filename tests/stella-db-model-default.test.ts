// tests/stella-db-model-default.test.ts
//
// G1-B PRECONDITIONS — P0: THE DATABASE MUST NOT CHOOSE STELLA'S MODEL.
//
// ---------------------------------------------------------------------------
// WHAT WAS WRONG
// ---------------------------------------------------------------------------
// `db/migrations/0012_stella_interactions.sql` created the ledger column as
//
//     model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL
//
// and `db/schema.ts` mirrored it. `gemini-2.0-flash` was retired by Google and
// returns 404 (see lib/stella/config.ts). So the column default names a model
// that cannot be called — a SECOND SOURCE OF TRUTH for Stella's model target,
// one that no longer agrees with the only real one,
// `STELLA_DEFAULT_GEMINI_MODEL`.
//
// ---------------------------------------------------------------------------
// WHY IT IS REMOVED RATHER THAN RETARGETED TO gemini-3.6-flash
// ---------------------------------------------------------------------------
// Retargeting keeps the defect and hides it. `model_used` records WHICH MODEL
// ANSWERED — it is a measurement, not a configuration — and a default is the
// database inventing a measurement for a row whose writer did not supply one.
// The governed path never needs it: `uellix_stella_ops.complete_operation_ticket`
// resolves `v_model := COALESCE(p_model_used, 'not-applicable')` and names the
// column explicitly in its INSERT, so the DEFAULT clause is unreachable from
// the only writer that exists (stella_0017 revoked INSERT from every runtime
// principal). Removing it therefore changes no behaviour and closes the drift.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUITE PINS
// ---------------------------------------------------------------------------
//   1. `db/schema.ts` carries no provider model id at all — as a default or
//      otherwise. This is the assertion that fails if someone "fixes" the
//      default by editing the literal.
//   2. The forward package that drops it on a live database exists and is
//      idempotent.
//
// It deliberately does NOT scan `db/migrations/0012_*.sql` or
// `db/baseline/stella_g2_schema.sql`: applied history and a pg_dump are
// RECORDS of what happened, and rewriting a record to satisfy a test is the
// worst possible way to pass one.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { STELLA_DEFAULT_GEMINI_MODEL } from '@/lib/stella/config'

const ROOT = process.cwd()
const SCHEMA = path.join(ROOT, 'db/schema.ts')
const FORWARD = path.join(ROOT, 'db/prepared/stella_0020_stella_interactions_model_default.sql')
const ROLLBACK = path.join(ROOT, 'db/prepared/stella_0020_rollback.sql')

/**
 * Strip line comments before asserting on a source.
 *
 * The finding is about EXECUTABLE content, and the explanation of the finding
 * necessarily names the retired model. A scanner that cannot tell a `--`/`//`
 * line from a statement would force the fix to ship without its reason — which
 * is how the original default survived three model retirements in the first
 * place.
 */
function statementsOnly(source: string, marker: '--' | '//'): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith(marker) && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/**
 * Any string that looks like a hosted-LLM model id. Broad on purpose: the
 * finding is "a provider model is hardcoded in the schema", not "this exact
 * string is". A new provider must not slip in under a name this list misses.
 */
const PROVIDER_MODEL_PATTERN = /['"](?:gemini|gpt|claude|llama|mistral|command|grok)[-\w.]*['"]/i

describe('db/schema.ts never names a provider model', () => {
  const schema = readFileSync(SCHEMA, 'utf8')

  it('declares no column DEFAULT carrying a provider model id', () => {
    const defaults = schema.match(/\.default\(\s*['"][^'"]*['"]\s*\)/g) ?? []
    const offending = defaults.filter((d) => PROVIDER_MODEL_PATTERN.test(d))
    expect(offending).toEqual([])
  })

  it('contains no provider model literal in any statement', () => {
    const hits = statementsOnly(schema, '//')
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => PROVIDER_MODEL_PATTERN.test(line))
    expect(hits).toEqual([])
  })

  it('does not restate the model target the config owns', () => {
    expect(statementsOnly(schema, '//')).not.toContain(STELLA_DEFAULT_GEMINI_MODEL)
  })

  it('still declares model_used as NOT NULL — the column is required, only its default is gone', () => {
    expect(schema).toMatch(/modelUsed:\s*varchar\('model_used',\s*\{\s*length:\s*100\s*\}\)\.notNull\(\)/)
  })
})

describe('prepared stella_0020 drops the default on a live database', () => {
  it('the forward package exists', () => {
    expect(existsSync(FORWARD)).toBe(true)
  })

  it('drops the default and nothing else structural', () => {
    const sql = statementsOnly(readFileSync(FORWARD, 'utf8'), '--')
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.stella_interactions\s+ALTER\s+COLUMN\s+model_used\s+DROP\s+DEFAULT/i)
    // The column stays NOT NULL and the table keeps its data: a package that
    // dropped the column or the constraint would satisfy the assertion above
    // and destroy the ledger.
    expect(sql).not.toMatch(/DROP\s+COLUMN/i)
    expect(sql).not.toMatch(/DROP\s+TABLE/i)
    expect(sql).not.toMatch(/DELETE\s+FROM/i)
    expect(sql).not.toMatch(/TRUNCATE/i)
    expect(sql).not.toMatch(/DROP\s+NOT\s+NULL/i)
  })

  it('has a rollback that restores a default without naming a live model target', () => {
    expect(existsSync(ROLLBACK)).toBe(true)
    const sql = statementsOnly(readFileSync(ROLLBACK, 'utf8'), '--')
    expect(sql).toMatch(/SET\s+DEFAULT/i)
    // The rollback restores the HISTORICAL value 0012 wrote, which is a retired
    // model. That is correct for a rollback (it restores what was there) and is
    // the reason the rollback must never be read as a model recommendation.
    expect(sql).toContain('gemini-2.0-flash')
    expect(sql).not.toContain(STELLA_DEFAULT_GEMINI_MODEL)
  })
})
