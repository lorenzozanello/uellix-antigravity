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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

/** Reads a repository file, or null when it cannot be read. */
type Reader = (file: string) => string | null

const readFromDisk: Reader = (file) => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}

/**
 * The sweep, as a FUNCTION over an injectable file list and reader.
 *
 * Extracted from a top-level constant for one reason: a detector that can only
 * ever be run against the repository as it happens to be CANNOT BE SHOWN to
 * fire. The mutation controls below re-run this exact pipeline over the REAL
 * population plus one synthetic runtime consumer, which is the only way to
 * prove the zero elsewhere is a measurement and not an artefact of the data.
 */
function sweep(files: readonly string[], read: Reader): Hit[] {
  return files.flatMap((file) => {
    const content = read(file)
    if (content === null) return []
    const symbols = SYMBOLS.filter((s) => content.includes(s))
    return symbols.length > 0 ? [{ file, symbols }] : []
  })
}

const HITS: Hit[] = sweep(ALL_FILES, readFromDisk)

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

  // ---------------------------------------------------------------------
  // THE HOSTED ADMINISTRATIVE SURFACES, added by CE-3 R4 (CE3-N-9 closure).
  //
  // WHAT THEY ARE. stella_hosted_0009 transfers the evaluator's ownership and
  // stella_hosted_0010 hardens the relation's ACL; the two db/hosted registries
  // DECLARE those packages (id, source path, sha256 pin, forward-only reason)
  // and db/prepared/README.md indexes them. Every one of the five NAMES the SQL
  // function because it administers the object the node defined. None of them
  // imports lib/capabilities/entitlement-evaluator, none is reachable from an
  // application entrypoint, and none evaluates an entitlement for anybody: the
  // ACTUAL_RUNTIME_CONSUMER count they belong in is ZERO.
  //
  // WHY THEY ARE ENUMERATED AND NOT IGNORED BY DIRECTORY. Excluding db/**,
  // db/prepared/** or db/hosted/** as CATEGORIES would close CE3-N-9 by making
  // the control blind: a real runtime consumer dropped into one of those trees
  // afterwards would never be seen again. Naming five files keeps the census
  // FAIL-CLOSED — a sixth file, anywhere, is a consumer until this array is
  // deliberately edited, and that edit is visible in review. The control
  // "an unenumerated file under db/prepared/ is still a consumer" below is the
  // executable form of that claim.
  'db/hosted/forward-only-packages.ts',
  'db/hosted/prechain-ownership.ts',
  'db/prepared/README.md',
  'db/prepared/stella_hosted_0009_entitlement_evaluator_ownership.sql',
  'db/prepared/stella_hosted_0010_entitlement_grants_acl_hardening.sql',
])

/** The five R4 added, kept separately so their own controls cannot drift. */
const R4_HOSTED_ADMINISTRATIVE_SURFACES = [
  'db/hosted/forward-only-packages.ts',
  'db/hosted/prechain-ownership.ts',
  'db/prepared/README.md',
  'db/prepared/stella_hosted_0009_entitlement_evaluator_ownership.sql',
  'db/prepared/stella_hosted_0010_entitlement_grants_acl_hardening.sql',
] as const

/**
 * AUTHORITY PROSE IS NOT A CONSUMER. docs/ops/** contains the frozen artifacts
 * that SPECIFIED this node — they name entitlement_grants and the evaluator
 * because they authorized them. Treating a specification as a runtime consumer
 * would make the control fire on the very documents that demanded the work.
 */
const isAuthorityProse = (f: string) => f.startsWith('docs/')

/**
 * THE CLASSIFICATION, STATED AS A TOTAL FUNCTION.
 *
 * Every file that carries a symbol lands in exactly one of five classes, and
 * the fifth is the one CE3-N-9 forbids. There is deliberately NO 'UNKNOWN'
 * member: a file this function does not recognise is a RUNTIME_CONSUMER, not a
 * definition surface and not a shrug. That is the fail-CLOSED direction, and it
 * is the whole reason the definition surfaces are a closed enumeration rather
 * than a pattern — a pattern grows silently, a list does not.
 */
type EvaluatorSurface =
  | 'DEFINING_MODULE'
  | 'TEST'
  | 'DEFINITION_OR_ADMIN_SURFACE'
  | 'AUTHORITY_PROSE'
  | 'RUNTIME_CONSUMER'

export function classifyEvaluatorSurface(file: string): EvaluatorSurface {
  if (isDefining(file)) return 'DEFINING_MODULE'
  if (isTest(file)) return 'TEST'
  if (DEFINITION_SURFACE.has(file)) return 'DEFINITION_OR_ADMIN_SURFACE'
  if (isAuthorityProse(file)) return 'AUTHORITY_PROSE'
  return 'RUNTIME_CONSUMER'
}

/** The forbidden class, over any population. */
const consumersIn = (hits: readonly Hit[]): Hit[] =>
  hits.filter((h) => classifyEvaluatorSurface(h.file) === 'RUNTIME_CONSUMER')

/** Anything left over is a real, non-test consumer — the thing CE3-N-9 forbids. */
const CONSUMERS = consumersIn(HITS)

/**
 * A synthetic runtime consumer: a real import of the defining module and a real
 * call. Used ONLY as the known-positive instrument, never written to disk.
 */
const SYNTHETIC_RUNTIME_CONSUMER =
  "import { evaluateEntitlement } from '@/lib/capabilities/entitlement-evaluator'\n" +
  'export async function gate(orgId: string) {\n' +
  "  return evaluateEntitlement(orgId, 'stella.grounded_query')\n" +
  '}\n'

/** Re-runs the REAL sweep with one extra file planted at `at`. */
function sweepWithInjectedConsumer(at: string): Hit[] {
  return consumersIn(
    sweep([...ALL_FILES, at], (file) => (file === at ? SYNTHETIC_RUNTIME_CONSUMER : readFromDisk(file))),
  )
}

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

describe('CE3-N-9 — the classifier discriminates rather than merely exempting', () => {
  // KNOWN NEGATIVES. The five hosted administrative surfaces must be seen by
  // the sweep AND classified out of the consumer count. Both halves matter: an
  // exemption for a file the sweep never finds is a dead entry that would
  // silently cover a real consumer appearing at that path later.
  it.each(R4_HOSTED_ADMINISTRATIVE_SURFACES)(
    '%s is a LIVE hit and classifies as a definition/admin surface',
    (file) => {
      expect(HITS.map((h) => h.file), `${file} is exempted but the sweep never found it`).toContain(file)
      expect(classifyEvaluatorSurface(file)).toBe('DEFINITION_OR_ADMIN_SURFACE')
    },
  )

  it('every enumerated definition surface EXISTS — no fabricated exemption', () => {
    for (const file of DEFINITION_SURFACE) {
      expect(existsSync(path.join(ROOT, file)), `${file} is exempted but does not exist`).toBe(true)
    }
  })

  it('the defining module and this node own tests are NOT called consumers', () => {
    expect(classifyEvaluatorSurface(DEFINING_MODULE)).toBe('DEFINING_MODULE')
    expect(classifyEvaluatorSurface('tests/postgres/ce3-entitlement-grants.pg.test.ts')).toBe('TEST')
    expect(classifyEvaluatorSurface('tests/postgres/ce3-acl-hardening.pg.test.ts')).toBe('TEST')
  })

  it('authority prose is NOT called a consumer', () => {
    expect(
      classifyEvaluatorSurface(
        'docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json',
      ),
    ).toBe('AUTHORITY_PROSE')
  })

  // KNOWN POSITIVES. A classifier that only ever exempts has not been shown to
  // discriminate.
  it.each([
    'lib/stella/grounded-query-quota.ts',
    'app/api/entitlements/route.ts',
    'components/billing/PlanBanner.tsx',
    'lib/auth/selected-organization.ts',
  ])('%s classifies as a RUNTIME CONSUMER', (file) => {
    expect(classifyEvaluatorSurface(file)).toBe('RUNTIME_CONSUMER')
  })

  // THE ANTI-DIRECTORY-IGNORE CONTROL. CE3-N-9 was NOT closed by excluding
  // db/**, db/prepared/** or db/hosted/** as categories, and this is the
  // executable proof: an UNENUMERATED file in each of those trees is still a
  // consumer. A future attempt to broaden the exemption into a directory rule
  // turns these red.
  it.each([
    'db/prepared/stella_hosted_0011_not_enumerated.ts',
    'db/hosted/some-new-runtime-helper.ts',
    'db/runtime-entitlement-gate.ts',
  ])('%s is NOT exempted just for living in an administrative tree', (file) => {
    expect(classifyEvaluatorSurface(file)).toBe('RUNTIME_CONSUMER')
  })

  it('an unrecognised path is a CONSUMER, never an UNKNOWN and never a definition surface', () => {
    // FAIL-CLOSED, asserted rather than described. The classifier has no
    // 'UNKNOWN' member at all, so there is no value for an unclassified file to
    // hide behind.
    expect(classifyEvaluatorSurface('some/path/nobody/anticipated.ts')).toBe('RUNTIME_CONSUMER')
    expect(classifyEvaluatorSurface('')).toBe('RUNTIME_CONSUMER')
    const codomain = new Set(
      [
        DEFINING_MODULE,
        'tests/x.test.ts',
        'db/prepared/README.md',
        'docs/anything.md',
        'lib/anything.ts',
      ].map(classifyEvaluatorSurface),
    )
    expect(codomain.has('UNKNOWN' as never)).toBe(false)
    expect(codomain.size).toBe(5)
  })
})

describe('CE3-N-9 — the census GOES RED when a real runtime consumer appears', () => {
  // THE NON-VACUITY PROOF. Run over the REAL repository population plus one
  // synthetic file that imports the defining module and calls it.
  it('a runtime-shaped consumer under lib/ is DETECTED', () => {
    expect(sweepWithInjectedConsumer('lib/stella/grounded-query-quota.ts').map((c) => c.file))
      .toEqual(['lib/stella/grounded-query-quota.ts'])
  })

  it('an API route consumer is DETECTED', () => {
    expect(sweepWithInjectedConsumer('app/api/entitlements/route.ts').map((c) => c.file))
      .toEqual(['app/api/entitlements/route.ts'])
  })

  // The same injection placed INSIDE the administrative trees. If CE3-N-9 had
  // been closed with a directory ignore, this consumer would escape; it does
  // not, because the exemption is five named files.
  it.each(['db/prepared/runtime-consumer.ts', 'db/hosted/runtime-consumer.ts', 'db/runtime-consumer.ts'])(
    'a consumer planted at %s cannot hide behind the administrative exemption',
    (at) => {
      expect(sweepWithInjectedConsumer(at).map((c) => c.file)).toEqual([at])
    },
  )

  it('and the same pipeline reports ZERO on the UNMUTATED repository', () => {
    // Both directions from one instrument: the detector that just fired is the
    // detector reporting the zero below.
    expect(consumersIn(sweep(ALL_FILES, readFromDisk))).toEqual([])
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
