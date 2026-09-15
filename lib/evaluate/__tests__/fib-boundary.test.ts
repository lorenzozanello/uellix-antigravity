/**
 * N-08 from docs/ops/evaluate/EVALUATE_COMMERCIAL_V1_TEST_MANIFEST_v1.0.0.json.
 *
 * "Proves broad Evaluate is structurally Wave3-independent AND that the narrow
 *  surface was not annexed — the two halves of HD-15 in one control."
 *
 * The two halves are asserted separately below, because they fail in opposite
 * directions: the first half fails if Evaluate REACHES INTO the FIB surface,
 * the second if Evaluate QUIETLY EDITS it. A single assertion covering both
 * would be satisfiable by a change that did neither and touched nothing.
 *
 * This test file deliberately does not IMPORT lib/pipeline. Those modules
 * reach a database client at import time, and a boundary test that had to
 * stand up the thing it is fencing off would be testing the fence by climbing
 * it. Everything here is asserted over source text.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = process.cwd()

/**
 * The four modules W-EV-2 authorizes. The engine is exactly these.
 *
 * Loop variables over this list are named `modulePath`, never `module`:
 * @next/next/no-assign-module-variable is an ERROR in this repository's eslint
 * config, and it fires on the binding itself even inside a test file.
 */
const EVALUATE_MODULES = [
  'lib/evaluate/types.ts',
  'lib/evaluate/scoring.ts',
  'lib/evaluate/decision-policy.ts',
  'lib/evaluate/divergence.ts',
] as const

/** Read with line endings normalized, so .gitattributes/autocrlf cannot move a digest. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function importSpecifiers(source: string): string[] {
  const statements = [...source.matchAll(/(?:^|\n)\s*import[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const requires = [...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  return [...statements, ...dynamic, ...requires]
}

/**
 * Surfaces Evaluate's pure engine must not reach. `lib/pipeline` is N-08's
 * subject; the others are W-EV-2's own constraint list ("no db import") and the
 * lane's forbidden set, checked here because this is the file that owns
 * import-boundary evidence.
 */
const FORBIDDEN_PREFIXES = [
  'lib/pipeline/',
  'db/',
  'app/',
  'lib/auth/',
  'lib/audit/',
  'lib/stella/',
  'lib/capabilities/',
] as const

function normalizeSpecifier(specifier: string): string {
  return specifier.replace(/^@\//, '').replace(/^(\.\.\/)+/, '')
}

describe('N-08 half 1 — broad Evaluate is structurally Wave3-independent', () => {
  it('scans a non-empty set of modules (denominator)', () => {
    expect(EVALUATE_MODULES).toHaveLength(4)
    for (const modulePath of EVALUATE_MODULES) {
      expect(readSource(modulePath).length).toBeGreaterThan(0)
    }
  })

  it('the import scanner is not vacuous (positive control)', () => {
    const impure = [
      "import { getMethodologyReview } from '@/lib/pipeline/methodology-review'",
      "import { db } from '../../db/client'",
      "const x = await import('lib/stella/adapter')",
      "const y = require('lib/audit/writer')",
    ].join('\n')
    const flagged = importSpecifiers(impure)
      .map(normalizeSpecifier)
      .filter((s) => FORBIDDEN_PREFIXES.some((p) => s.startsWith(p)))
    expect(flagged).toHaveLength(4)
    expect(flagged).toContain('lib/pipeline/methodology-review')
  })

  it('no Evaluate module imports lib/pipeline, db, app, auth, audit, stella or capabilities', () => {
    for (const modulePath of EVALUATE_MODULES) {
      const specifiers = importSpecifiers(readSource(modulePath)).map(normalizeSpecifier)
      const violations = specifiers.filter((s) =>
        FORBIDDEN_PREFIXES.some((prefix) => s.startsWith(prefix))
      )
      expect({ modulePath, violations }).toEqual({ modulePath, violations: [] })
    }
  })

  it('the engine imports nothing but its own siblings and node:crypto', () => {
    const permitted = new Set(['./types', './scoring', './decision-policy', 'node:crypto'])
    for (const modulePath of EVALUATE_MODULES) {
      for (const specifier of importSpecifiers(readSource(modulePath))) {
        expect({ modulePath, specifier, permitted: permitted.has(specifier) }).toEqual({
          modulePath,
          specifier,
          permitted: true,
        })
      }
    }
  })

  it('reuses no readiness symbol', () => {
    // EV-01 permits readiness a DIFFERENT governed-N/A arithmetic, and
    // SCORING.readiness_is_a_different_domain forbids refactoring the two into
    // a shared helper "on the assumption that they agree".
    const readinessSymbols = ['computeReadinessScore', 'SEVERITY_WEIGHT', 'STATUS_CREDIT', 'ScorableItem']
    for (const modulePath of EVALUATE_MODULES) {
      const source = readSource(modulePath)
      for (const symbol of readinessSymbols) {
        // `computeReadinessScore` appears in scoring.ts PROSE, contrasting the
        // two domains. Only a code-shaped occurrence counts: an identifier in
        // an import, a call, or a type position — never a word in a comment.
        const codeShaped = new RegExp(`(?:import[^\\n]*\\b${symbol}\\b|\\b${symbol}\\s*[(<])`)
        expect({ modulePath, symbol, used: codeShaped.test(source) }).toEqual({
          modulePath,
          symbol,
          used: false,
        })
      }
    }
  })

  it('the two N/A arithmetics are observably different, not merely separate files', () => {
    const readiness = readSource('lib/pipeline/methodology-review.ts')
    const scoring = readSource('lib/evaluate/scoring.ts')

    // Readiness returns a number OR null and rounds onto 0-100.
    expect(readiness).toMatch(/export function computeReadinessScore\([^)]*\): number \| null/)
    expect(readiness).toMatch(/Math\.round\(/)

    // Evaluate returns a DISCRIMINATED result and never rounds. ZD-02 forbids
    // exactly readiness's "number plus a nullable" shape, so importing it would
    // import the shape the control exists to exclude.
    expect(scoring).toMatch(/export function computeScore\([\s\S]*?\): ScoreResult/)
    expect(scoring).not.toMatch(/Math\.round\(/)
    expect(scoring).not.toMatch(/\): number \| null/)
  })
})

/**
 * HALF 2 — the narrow FIB run-review surface is BYTE-UNCHANGED.
 *
 * Digests are taken over the EOL-normalized function body at this HEAD
 * (891f869f). `assertRunMethodologyApprovalAllowed` is module-private in
 * sroi-results.ts, so it is pinned by source rather than by import — which is
 * the only way to pin a symbol that is not exported.
 *
 * If one of these goes red, the correct response is to establish WHY the
 * function changed and whether Evaluate caused it. It is never to repin the
 * digest to make the control green; that would convert the sentinel into a
 * record of whatever happened last.
 */
const FIB_SENTINELS = [
  {
    symbol: 'assertRunMethodologyApprovalAllowed',
    file: 'lib/pipeline/sroi-results.ts',
    start: /^async function assertRunMethodologyApprovalAllowed\(/,
    sha256: '99bbfe7f0d6d2cdc569086b492efecd94f7c2f03483ca7958ccdb238c059d70f',
    lines: 55,
  },
  {
    symbol: 'isInReviewSet',
    file: 'lib/auth/permissions.ts',
    start: /^export function isInReviewSet\(/,
    sha256: '17fe53989edf9dae9cd1f0c28b228d5ebceaf2abe7f59eca854d7aafaad682fe',
    lines: 3,
  },
  {
    symbol: 'canApproveRunMethodology',
    file: 'lib/auth/permissions.ts',
    start: /^export function canApproveRunMethodology\(/,
    sha256: 'a32befc9d2ccda04648adb14aae0e47774cd55281ab0eccafd0c99599e753543',
    lines: 3,
  },
] as const

/** Slice a top-level function: its signature line to the next column-0 `}`. */
function extractTopLevelFunction(file: string, start: RegExp): string {
  const lines = readSource(file).split('\n')
  const first = lines.findIndex((line) => start.test(line))
  if (first < 0) throw new Error(`N-08: ${String(start)} not found in ${file}`)
  const last = lines.findIndex((line, index) => index > first && line === '}')
  if (last < 0) throw new Error(`N-08: no column-0 close for ${String(start)} in ${file}`)
  return lines.slice(first, last + 1).join('\n')
}

describe('N-08 half 2 — the narrow FIB run-review surface was not annexed', () => {
  it.each(FIB_SENTINELS)('$symbol is byte-unchanged', (sentinel) => {
    const body = extractTopLevelFunction(sentinel.file, sentinel.start)
    expect(body.split('\n')).toHaveLength(sentinel.lines)
    expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(sentinel.sha256)
  })

  it('the extractor really reads the function (positive control)', () => {
    // A digest check passes trivially if the extractor returns a constant. One
    // altered character must move the digest.
    const body = extractTopLevelFunction(FIB_SENTINELS[1].file, FIB_SENTINELS[1].start)
    const tampered = `${body} `
    expect(createHash('sha256').update(tampered, 'utf8').digest('hex')).not.toBe(
      FIB_SENTINELS[1].sha256
    )
    expect(body).toContain('isInReviewSet')
  })

  it('no Evaluate module names the sroi_run_reviews relation', () => {
    for (const modulePath of EVALUATE_MODULES) {
      expect(readSource(modulePath)).not.toMatch(/sroi_run_reviews/)
    }
  })
})

/**
 * DEFERRED, not discharged.
 *
 * "no Evaluate relation carries a foreign key to any FIBIU-19 or FIBIU-20
 *  object" — W-EV-2 authors no DDL, so there is no Evaluate relation at this
 *  HEAD to carry or not carry a foreign key. A green assertion over zero
 *  relations would be the empty-grep pass this repository's own resolver
 *  rules call an INVALID pass rather than a clean one.
 *
 * "the existing methodology-review suite is green" is discharged by the
 * repository-wide `pnpm test` run recorded in this lane's report, not
 * re-executed from inside this file.
 */
describe.todo('N-08 (deferred) no Evaluate relation FKs a FIBIU-19/20 object — requires Evaluate DDL')
