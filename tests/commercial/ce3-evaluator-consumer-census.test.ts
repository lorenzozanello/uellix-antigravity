// tests/commercial/ce3-evaluator-consumer-census.test.ts
// CE-3 / CE3-N-9 — THE ENFORCEMENT BOUNDARY (ENFORCEMENT_BOUNDARY_CE4).
//
// NOTHING CONSUMES THE EVALUATOR BEFORE CE-4. At the end of a conformant CE-3
// implementation, the set of files referencing the evaluator symbol is EXACTLY
// its defining module plus CE-3's own test files, and the count of NON-TEST
// consumers outside the defining module is ZERO.
//
// THIS IS NOT INCOMPLETENESS. It is the property that makes CE-3 safe to land
// BEFORE tenancy S3, S4 and S7: a relation nothing reads cannot leak across a
// tenant model that has not been frozen yet. Wiring the evaluator into any
// runtime path — a Stella quota check, Measure or Portfolio access, an API
// route, a billing page, generic capability gating, or the selected-organization
// principal — is mutation CE3-M-5 and must turn this file RED.
//
// ---------------------------------------------------------------------------
// A BARE GREP RETURNING ZERO IS NOT EVIDENCE
// ---------------------------------------------------------------------------
// CE3-N-9's SCOPING REQUIREMENT is explicit: the sweep "must not assert a bare
// zero over a pattern so broad that the zero is vacuous, and it must not be
// scoped to the implementer's working set". So this file:
//
//   1. WALKS THE REPOSITORY FROM ITS ROOT, not a hand-listed set of directories
//      and not the diff. A census scoped to what the implementer happened to
//      touch could never find a consumer the implementer forgot about, which is
//      the only interesting case.
//   2. CLASSIFIES every hit into DEFINING / TEST / CONSUMER rather than counting
//      them, so the assertion is about what the hits ARE.
//   3. PROVES THE INSTRUMENT FIRST. Before any zero is believed, the sweep must
//      find the hits it is KNOWN to contain — the defining module and this
//      node's own tests. A sweep that found nothing at all would otherwise
//      report a perfect score.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..')

/** The defining module — the ONE file allowed to contain the definition. */
const DEFINING_MODULE = 'lib/capabilities/entitlement-evaluator.ts'

/**
 * The symbols a consumer would have to name. Both the exported function and the
 * module path are swept: an import of the module is a consumption even when the
 * call is indirected, and a call without an import would be a global, which
 * would be stranger still.
 */
const SYMBOLS = ['evaluateEntitlement', 'entitlement-evaluator', 'entitlement_effective'] as const

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel'])
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.sql', '.json', '.yml', '.yaml', '.md'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (TEXT_EXT.has(path.extname(entry))) out.push(path.relative(ROOT, full).split(path.sep).join('/'))
  }
  return out
}

const ALL_FILES = walk(ROOT)

interface Hit {
  readonly file: string
  readonly symbols: readonly string[]
}

const HITS: Hit[] = ALL_FILES.flatMap((file) => {
  let content: string
  try {
    content = readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return []
  }
  const symbols = SYMBOLS.filter((s) => content.includes(s))
  return symbols.length > 0 ? [{ file, symbols }] : []
})

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

const isDefining = (f: string) => f === DEFINING_MODULE
const isTest = (f: string) => f.startsWith('tests/') || /\.test\.tsx?$/.test(f) || /\.spec\.tsx?$/.test(f)

/**
 * The migration, the schema, the catalogue and the generated corpus NAME the
 * relation and the SQL function — they are the node's own definition surface
 * spread across the files it is authorized to write, not runtime consumers.
 * They are enumerated EXPLICITLY rather than matched by a loose pattern, so a
 * new file quietly joining this list is a visible edit to this array.
 */
const DEFINITION_SURFACE = new Set([
  'db/schema.ts',
  'db/hosted/baseline-manifest.ts',
  'lib/capabilities/entitlement-catalogue.ts',
  'db/migrations/0073_commercial_account_ce3_entitlement_grants.sql',
  'db/migrations/meta/0073_snapshot.json',
  'db/prepared/journal/086_0073_commercial_account_ce3_entitlement_grants.sql',
  'db/prepared/checkpoint-b0/observation.sql',
  'docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_IMPLEMENTATION_TEST_MANIFEST_v1.0.0.json',
])

/**
 * AUTHORITY PROSE IS NOT A CONSUMER. docs/ops/** contains the frozen artifacts
 * that SPECIFIED this node — they name entitlement_grants and the evaluator
 * because they authorized them. Treating a specification as a runtime consumer
 * would make the control fire on the very documents that demanded the work.
 */
const isAuthorityProse = (f: string) => f.startsWith('docs/')

/** Anything left over is a real, non-test consumer — the thing CE3-N-9 forbids. */
const CONSUMERS = HITS.filter(
  (h) => !isDefining(h.file) && !isTest(h.file) && !DEFINITION_SURFACE.has(h.file) && !isAuthorityProse(h.file),
)

describe('CE3-N-9 — the census instrument is not vacuous', () => {
  it('the sweep actually walked the repository', () => {
    expect(ALL_FILES.length).toBeGreaterThan(500)
    expect(ALL_FILES).toContain('db/schema.ts')
    expect(ALL_FILES).toContain('package.json')
  })

  // KNOWN POSITIVES. If the sweep cannot find the files it is GUARANTEED to
  // contain, its zero elsewhere means nothing.
  it('finds the defining module', () => {
    expect(HITS.map((h) => h.file)).toContain(DEFINING_MODULE)
  })

  it('finds this node own test files', () => {
    const testHits = HITS.filter((h) => isTest(h.file)).map((h) => h.file)
    expect(testHits).toContain('tests/commercial/ce3-entitlement-grants.test.ts')
    expect(testHits).toContain('tests/postgres/ce3-entitlement-grants.pg.test.ts')
  })

  it('finds the migration that defines the SQL function', () => {
    expect(HITS.map((h) => h.file)).toContain('db/migrations/0073_commercial_account_ce3_entitlement_grants.sql')
  })

  it('every symbol in the sweep matches something, so no dead pattern inflates the pass', () => {
    for (const symbol of SYMBOLS) {
      const matching = HITS.filter((h) => h.symbols.includes(symbol))
      expect(matching.length, `symbol ${symbol} matched nothing — the pattern is dead`).toBeGreaterThan(0)
    }
  })
})

describe('CE3-N-9 — NON-TEST evaluator consumers outside the defining module', () => {
  it('NON_TEST_EVALUATOR_CONSUMERS_OUTSIDE_DEFINITION = 0', () => {
    expect(
      CONSUMERS.map((c) => `${c.file} [${c.symbols.join(', ')}]`),
      'a non-test consumer of the CE-3 evaluator exists before CE-4',
    ).toEqual([])
  })

  // THE FORBIDDEN SURFACES, NAMED. The count above would already catch these,
  // but naming them states the claim a reader actually cares about and makes a
  // failure legible without re-deriving the classification.
  it.each(['app/', 'components/', 'lib/stella/', 'lib/measure/', 'lib/portfolio/', 'lib/billing/', 'lib/auth/'])(
    'no file under %s references the evaluator',
    (prefix) => {
      const offending = HITS.filter((h) => h.file.startsWith(prefix) && !isTest(h.file)).map((h) => h.file)
      expect(offending).toEqual([])
    },
  )

  it('no API route consumes the evaluator', () => {
    const routes = HITS.filter((h) => /(^|\/)route\.tsx?$/.test(h.file) || h.file.includes('/api/')).map((h) => h.file)
    expect(routes).toEqual([])
  })

  it('the defining module is the ONLY file that declares the exported symbol', () => {
    // ANCHORED AT COLUMN ZERO (multiline). A real top-level declaration starts
    // the line; an occurrence INSIDE a test's own assertion pattern — e.g.
    // `expect(SOURCE).toMatch(/export async function evaluateEntitlement\(/)` —
    // is indented, and an unanchored sweep counted that test as a second
    // declaring file. A control that cannot tell a declaration from a quotation
    // of one reports the wrong number in both directions.
    const DECLARATION = /^export\s+(async\s+)?function\s+evaluateEntitlement\b/m
    const declaring = ALL_FILES.filter((f) => {
      try {
        return DECLARATION.test(readFileSync(path.join(ROOT, f), 'utf8'))
      } catch {
        return false
      }
    })
    expect(declaring).toEqual([DEFINING_MODULE])
  })

  it('the anchored declaration pattern still matches a real declaration and not a quoted one', () => {
    const DECLARATION = /^export\s+(async\s+)?function\s+evaluateEntitlement\b/m
    expect(DECLARATION.test('export async function evaluateEntitlement(\n')).toBe(true)
    expect(DECLARATION.test('  expect(SOURCE).toMatch(/export async function evaluateEntitlement\\(/)')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* The two entrypoint artifacts must be BYTE-UNCHANGED                        */
/* -------------------------------------------------------------------------- */

describe('CE-3 leaves the database-entrypoint inventory untouched', () => {
  // PINNED ON THE LF-NORMALIZED BYTES, not the raw ones. These files are CRLF in
  // a Windows working tree and LF in the stored blob (.gitattributes pins the
  // canonical form), so a raw-byte pin would pass on one platform and fail on
  // the other — a test that reports the developer's line endings rather than the
  // property under test.
  const PINNED: Record<string, string> = {
    'tests/database-entrypoint-inventory.json': 'ab719bc7a6b683d51248d89ea6f23a0efa32f94b10369003153e8344a11f0d61',
    'tests/database-runtime-entrypoints.test.ts': 'da6163b722304bfcffec780a3271f83ba0aa9ea7657e1e6bb883193181a01b3d',
  }

  it.each(Object.keys(PINNED))('%s is byte-unchanged by CE-3', (file) => {
    const lf = readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n')
    const digest = createHash('sha256').update(lf, 'utf8').digest('hex')
    expect(digest, `${file} changed; CE-3 is not authorized to touch it`).toBe(PINNED[file])
  })

  it('neither entrypoint artifact mentions the CE-3 evaluator', () => {
    for (const file of Object.keys(PINNED)) {
      const content = readFileSync(path.join(ROOT, file), 'utf8')
      expect(content).not.toMatch(/evaluateEntitlement|entitlement-evaluator|entitlement_effective/)
    }
  })
})
