// lib/portfolios/read-model.test.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — binds POS-SIZE-1, POS-SIZE-2,
// MUT-SIZE-1, NEG-PF3-SIZE-1, NEG-PF3-ARCH-1 and NEG-PF3-ARCH-2 to this file
// (TEST_CONTRACT.inherited_pf3_exclusive_controls / new_pf3_scoped_controls).
//
// Everything DB-bound here is either driven through a mocked db/client (for
// POS-SIZE-2's statement-count claim) or split into a pure function first
// (buildPortfolioReadModelFromSummaries) so the size/pagination/aggregate
// claims are tested without a database — the same DB-free-math pattern
// lib/portfolios/analytics.test.ts already establishes for aggregatePortfolioSroi.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EntrypointScanner } from '../../tests/helpers/entrypoint-scanner'
import { sroiCalculationRuns } from '@/db/schema'
import { aggregatePortfolioSroi, type ProjectRunSummary } from './analytics'
import {
  buildPortfolioReadModelFromSummaries,
  chunkArray,
  PORTFOLIO_COMPARISON_PAGE_SIZE,
  PORTFOLIO_READ_MODEL_CHUNK_SIZE,
  PORTFOLIO_SOFT_SIZE_THRESHOLD,
} from './read-model'

/* -------------------------------------------------------------------------- */
/* db/client mock — used only by the POS-SIZE-2 describe block below. Every   */
/* other describe block in this file exercises pure functions or the real    */
/* filesystem-based EntrypointScanner and never touches `db`.                */
/* -------------------------------------------------------------------------- */

const { fromCalls } = vi.hoisted(() => ({ fromCalls: [] as unknown[] }))

vi.mock('@/db/client', () => {
  function makeChain(): Record<string, unknown> {
    const resolved = Promise.resolve([] as unknown[])
    const chain: Record<string, unknown> = {}
    chain.from = (table: unknown) => {
      fromCalls.push(table)
      return chain
    }
    chain.where = () => chain
    chain.orderBy = () => chain
    chain.then = (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
      resolved.then(onFulfilled, onRejected)
    chain.catch = (onRejected: (e: unknown) => unknown) => resolved.catch(onRejected)
    return chain
  }
  return { db: { select: () => makeChain() } }
})

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const FIXTURE_PORTFOLIO = {
  id: 'portfolio-1',
  organizationId: 'org-1',
  name: 'Test portfolio',
  description: null,
  status: 'active',
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as const

function approvedSummary(index: number): ProjectRunSummary {
  return {
    projectId: `project-${index}`,
    projectName: `Project ${index}`,
    governanceRegime: 'pc01b',
    selection: 'approved',
    run: {
      currency: 'USD',
      totalInvestment: 1000 + index,
      netSocialValue: 2000 + index,
      sroiRatio: 2 + index * 0.001,
    },
    selected: {
      runId: `run-${index}`,
      runVersion: 1,
      reviewId: `review-${index}`,
      methodologyVersion: 'v1',
    },
    legacyManualReadinessScore: null,
  }
}

function excludedSummary(index: number): ProjectRunSummary {
  return {
    projectId: `excluded-${index}`,
    projectName: `Excluded ${index}`,
    governanceRegime: null,
    selection: 'no_approved_run',
    run: null,
    selected: null,
    legacyManualReadinessScore: null,
  }
}

/* -------------------------------------------------------------------------- */
/* chunkArray                                                                  */
/* -------------------------------------------------------------------------- */

describe('chunkArray', () => {
  it('splits into chunks of the requested size, preserving order', () => {
    const items = Array.from({ length: 7 }, (_, i) => i)
    expect(chunkArray(items, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]])
  })

  it('returns a single chunk when size >= length', () => {
    expect(chunkArray([1, 2], 500)).toEqual([[1, 2]])
  })

  it('returns no chunks for an empty array', () => {
    expect(chunkArray([], 500)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* POS-SIZE-1 / NEG-PF3-SIZE-1 / MUT-SIZE-1                                    */
/* -------------------------------------------------------------------------- */

describe('buildPortfolioReadModelFromSummaries — SIZE_CONTRACT', () => {
  it('POS-SIZE-1: the aggregate is byte-identical across every requested page, and always describes ALL members', () => {
    const summaries = Array.from({ length: 63 }, (_, i) => approvedSummary(i))
    const unpaginated = aggregatePortfolioSroi([...summaries])

    const page1 = buildPortfolioReadModelFromSummaries(FIXTURE_PORTFOLIO as never, summaries.length, summaries, 1)
    const page2 = buildPortfolioReadModelFromSummaries(FIXTURE_PORTFOLIO as never, summaries.length, summaries, 2)
    const page3 = buildPortfolioReadModelFromSummaries(FIXTURE_PORTFOLIO as never, summaries.length, summaries, 3)

    expect(page1.aggregate).toEqual(unpaginated)
    expect(page2.aggregate).toEqual(unpaginated)
    expect(page3.aggregate).toEqual(unpaginated)
    expect(page1.aggregate.projectCount).toBe(63)
    expect(page1.aggregate.includedCount).toBe(63)

    // The comparison view, unlike the aggregate, DOES vary by page.
    expect(page1.comparisonPage.rows).toHaveLength(PORTFOLIO_COMPARISON_PAGE_SIZE)
    expect(page2.comparisonPage.rows).toHaveLength(PORTFOLIO_COMPARISON_PAGE_SIZE)
    expect(page3.comparisonPage.rows).toHaveLength(63 - 2 * PORTFOLIO_COMPARISON_PAGE_SIZE)
    expect(page1.comparisonPage.rows[0].projectId).not.toBe(page2.comparisonPage.rows[0].projectId)
  })

  it('NEG-PF3-SIZE-1: at and above the soft threshold, the aggregate and excluded list stay COMPLETE and nothing is refused', () => {
    const included = Array.from({ length: PORTFOLIO_SOFT_SIZE_THRESHOLD }, (_, i) => approvedSummary(i))
    const excluded = Array.from({ length: 5 }, (_, i) => excludedSummary(i))
    const summaries = [...included, ...excluded]

    const model = buildPortfolioReadModelFromSummaries(FIXTURE_PORTFOLIO as never, summaries.length, summaries, 1)

    // The notice fires...
    expect(model.softSizeWarning).toBe(true)
    // ...but nothing is truncated, refused, or altered.
    expect(model.aggregate.projectCount).toBe(summaries.length)
    expect(model.aggregate.includedCount).toBe(included.length)
    expect(model.aggregate.excluded).toHaveLength(excluded.length)
    expect(model.comparisonPage.totalMembers).toBe(summaries.length)

    // Just below the threshold: no warning, same completeness guarantees.
    const belowThreshold = buildPortfolioReadModelFromSummaries(
      FIXTURE_PORTFOLIO as never,
      PORTFOLIO_SOFT_SIZE_THRESHOLD - 1,
      included.slice(0, PORTFOLIO_SOFT_SIZE_THRESHOLD - 1),
      1
    )
    expect(belowThreshold.softSizeWarning).toBe(false)
  })

  it('MUT-SIZE-1: feeding the paginated row set into aggregatePortfolioSroi instead of the full member set changes the result', () => {
    const summaries = Array.from({ length: 63 }, (_, i) => approvedSummary(i))
    const model = buildPortfolioReadModelFromSummaries(FIXTURE_PORTFOLIO as never, summaries.length, summaries, 1)

    // The mutation this control exists to catch: aggregating only the
    // DISPLAYED PAGE instead of the whole portfolio.
    const mutantAggregate = aggregatePortfolioSroi(model.comparisonPage.rows)

    expect(mutantAggregate.projectCount).not.toBe(model.aggregate.projectCount)
    expect(mutantAggregate.projectCount).toBe(PORTFOLIO_COMPARISON_PAGE_SIZE)
    expect(model.aggregate.projectCount).toBe(63)
    expect(mutantAggregate.totalInvestmentUsd).not.toBe(model.aggregate.totalInvestmentUsd)
  })
})

/* -------------------------------------------------------------------------- */
/* POS-SIZE-2 — chunked statement count, independent of member count          */
/* -------------------------------------------------------------------------- */

describe('buildPortfolioProjectRunSummaries — POS-SIZE-2', () => {
  it('issues a bounded, ceil(N/chunk)-shaped number of statements — never one per project', async () => {
    fromCalls.length = 0
    const { buildPortfolioProjectRunSummaries } = await import('./read-model')

    const memberCount = 1_237
    const memberProjects = Array.from({ length: memberCount }, (_, i) => ({
      id: `project-${i}`,
      name: `Project ${i}`,
      governanceRegime: null,
    }))

    await buildPortfolioProjectRunSummaries(memberProjects, 'org-1')

    const expectedChunks = Math.ceil(memberCount / PORTFOLIO_READ_MODEL_CHUNK_SIZE)
    const runsCalls = fromCalls.filter((t) => t === sroiCalculationRuns).length

    // The mocked runs query always returns zero rows, so no run ids exist to
    // drive the (conditional) reviews query — this asserts the ALWAYS-ISSUED
    // half of the chunked read: one runs statement per chunk, bounded by
    // ceil(N / PORTFOLIO_READ_MODEL_CHUNK_SIZE), never by N.
    expect(runsCalls).toBe(expectedChunks)
    expect(runsCalls).toBeLessThan(memberCount)
  })
})

/* -------------------------------------------------------------------------- */
/* NEG-PF3-ARCH-1 / NEG-PF3-ARCH-2 — components/portfolios/** architecture     */
/* -------------------------------------------------------------------------- */

// Reconstructed verbatim from tests/database-runtime-entrypoints.test.ts's own
// SCANNER_OPTIONS (a prohibited path — PF3 may not edit or import from it, so
// the configuration is reproduced here rather than imported). Any drift
// between the two copies would show up as a quadruple mismatch below, which
// is exactly the failure mode this duplication is meant to surface rather
// than hide. Allowlist VALUES are irrelevant to classification (only the
// KEYS gate the 'allowlisted' tally), so they are elided here.
const CONTEXT_OPENERS = [
  'runWithOrganizationAccess',
  'runWithAdminAccess',
  'runWithOptionalOrganizationAccess',
  'withOrganizationDatabaseContext',
  'withAuthenticatedDatabaseContext',
  'withSuperAdminDatabaseContext',
  'withOptionalDatabaseIdentityContext',
  'withDatabaseIdentityContext',
] as const

const ALLOWLIST: Record<string, string> = {
  'app/(public)/login/page.tsx': '',
  'app/app/organization/billing/actions.ts': '',
  'app/app/layout.tsx': '',
  'app/admin/layout.tsx': '',
  'app/(authenticated)/layout.tsx': '',
  'app/(authenticated)/app/onboarding/page.tsx': '',
  'app/api/health/runtime-identity/route.ts': '',
  'app/(public)/login/actions.ts': '',
  'app/auth/callback/route.ts': '',
  'app/api/webhooks/stripe/route.ts': '',
  'app/api/marketing/lead/route.ts': '',
  'app/(public)/verify/[hash]/page.tsx': '',
  'app/(public)/verify/[hash]/pdf/route.ts': '',
  'app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action.ts': '',
  'app/app/projects/[projectId]/pipeline/evidence/verifyEvidenceIntegrity.action.ts': '',
  'app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action.ts': '',
}

const ROOT = process.cwd()
const COMPONENTS_PORTFOLIOS_DIR = path.join(ROOT, 'components', 'portfolios')

const ENTRY_POINT_PATTERNS = [
  /^page\.tsx?$/,
  /^layout\.tsx?$/,
  /^route\.tsx?$/,
  /^default\.tsx?$/,
  /\.action\.tsx?$/,
  /\.actions\.tsx?$/,
  /^actions\.tsx?$/,
  /^template\.tsx?$/,
  /^not-found\.tsx?$/,
  /^error\.tsx?$/,
  /^sitemap\.tsx?$/,
  /^manifest\.tsx?$/,
]

/**
 * A PF3-owned value-import reachability walker — genuinely independent of
 * any client/server directive, unlike EntrypointScanner.reachesDatabase().
 *
 * MEASURED DEFECT IN THE SHARED INSTRUMENT: EntrypointScanner.reachesDatabase()
 * (tests/helpers/entrypoint-scanner.ts:435) short-circuits to `false` the
 * moment the STARTING module's own `info.isClient` is true — BEFORE it ever
 * inspects that module's value-imports. Calling `scanner.reachesDatabase()`
 * directly on a 'use client' file therefore can NEVER observe form B RED,
 * regardless of what that file imports — it does not merely inherit
 * listCheckedModules()'s documented isClient gap, it carries the identical
 * gap itself. NEG-PF3-ARCH-2 requires a walk "independently of the scanner's
 * isClient short-circuit", which the scanner's own public API cannot provide
 * for this specific check. PF3 does not edit the scanner (a prohibited path)
 * — it closes the gap in its OWN test surface here, exactly as the authority
 * anticipates (NEG-PF3-ARCH-2.pf3_disposition).
 *
 * Scope: relative and `@/`-aliased specifiers only (walked and resolved to
 * .ts/.tsx/index files); bare package specifiers (react, next/link, class-
 * variance-authority, drizzle-orm, postgres, …) are treated as non-reaching
 * — no third-party package in this repository re-exports our own
 * db/client.ts. Type-only imports (`import type {...}`) are excluded from
 * the walk, matching COMPONENTS_ENTRYPOINT_DISCIPLINE.type_only_imports_are_permitted.
 */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const importRegex = /import\s+(type\s+)?(?:[\w*${},\s]+\s+from\s+)?['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source))) {
    const isTypeOnly = Boolean(match[1])
    if (isTypeOnly) continue
    specifiers.push(match[2])
  }
  return specifiers
}

function resolveSpecifier(root: string, fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) {
    base = path.join(root, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier)
  } else {
    return null // bare package specifier — not walked into node_modules
  }
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return null
}

function reachesDbClientIndependentOfClientDirective(
  root: string,
  dbClientAbs: string,
  file: string,
  visited: Set<string> = new Set()
): boolean {
  const abs = path.resolve(file)
  if (abs === dbClientAbs) return true
  if (visited.has(abs)) return false
  visited.add(abs)
  let source: string
  try {
    source = readFileSync(abs, 'utf8')
  } catch {
    return false
  }
  for (const specifier of valueImportSpecifiers(source)) {
    const resolved = resolveSpecifier(root, abs, specifier)
    if (!resolved) continue
    if (reachesDbClientIndependentOfClientDirective(root, dbClientAbs, resolved, visited)) return true
  }
  return false
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) out.push(...walkFiles(abs))
    else out.push(abs)
  }
  return out
}

describe('NEG-PF3-ARCH-1 — components/portfolios/** does not move the AST entrypoint pins', () => {
  // A real AST parse of app/+components/+lib/+db/ (hundreds of files) can
  // exceed vitest's default 5000ms under load — measured to time out inside
  // ods:poststate's own composed test run, which offers no CLI override for
  // testTimeout. An explicit per-test timeout is the correct fix: this is a
  // slow REAL scan, not a hang, and the assertions below are otherwise
  // unchanged.
  it('the real scanner reports the unchanged 144/120/104/16 quadruple, with components/portfolios/** populated', () => {
    const scanner = new EntrypointScanner({
      root: ROOT,
      scanDirs: ['app', 'components', 'lib', 'db'],
      checkedDirs: ['app', 'components'],
      contextOpeners: [...CONTEXT_OPENERS],
      contextModulePaths: ['lib/auth/session.ts', 'lib/auth/database-context.ts', 'db/identity-context.ts'],
      allowlist: ALLOWLIST,
    })

    const result = scanner.scan()

    let contextualized = 0
    let allowlisted = 0
    for (const classification of result.classified.values()) {
      if (classification === 'contextualized') contextualized += 1
      if (classification === 'allowlisted') allowlisted += 1
    }

    expect({
      checkedModules: result.checkedModules.length,
      databaseReaching: result.databaseReaching.length,
      contextualized,
      allowlisted,
    }).toEqual({ checkedModules: 144, databaseReaching: 120, contextualized: 104, allowlisted: 16 })

    const portfoliosFiles = walkFiles(COMPONENTS_PORTFOLIOS_DIR)
    expect(portfoliosFiles.length).toBeGreaterThan(0)
  }, 30_000)
})

describe('NEG-PF3-ARCH-2 — no direct or transitive DB reach from components/portfolios/**, independent of isClient', () => {
  it('every real file under components/portfolios/** is unreachable to db/client, carries no use-server directive, and no entrypoint-like basename', () => {
    const dbClientAbs = path.join(ROOT, 'db', 'client.ts')
    const files = walkFiles(COMPONENTS_PORTFOLIOS_DIR).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      expect(
        reachesDbClientIndependentOfClientDirective(ROOT, dbClientAbs, file),
        `${path.relative(ROOT, file)} must not reach db/client.ts`
      ).toBe(false)

      const source = readFileSync(file, 'utf8')
      const basename = path.basename(file)
      expect(
        source.includes("'use server'") || source.includes('"use server"'),
        `${basename} must not carry the 'use server' directive`
      ).toBe(false)
      expect(
        ENTRY_POINT_PATTERNS.some((pattern) => pattern.test(basename)),
        `${basename} must not have an entrypoint-like basename`
      ).toBe(false)
    }
  })

  it('NON_VACUITY_EVIDENCE_OBLIGATION: form A (leaky server) RED, form B (leaky use-client) RED, form C (type-only) GREEN — in that order', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pf3-arch-mutants-'))
    try {
      // Minimal repo shape the scanner needs: a db/client.ts driver-touching
      // module, and a components/portfolios-fixture/ directory holding the
      // three fixtures. Temporary — never committed, per
      // NON_VACUITY_EVIDENCE_OBLIGATION.fixture_placement.
      mkdirSync(path.join(fixtureRoot, 'db'), { recursive: true })
      writeFileSync(
        path.join(fixtureRoot, 'db', 'client.ts'),
        "import postgres from 'postgres'\nexport const db = postgres('postgres://fixture')\nexport type FixtureRow = { id: string }\n"
      )
      const componentsDir = path.join(fixtureRoot, 'components', 'portfolios-fixture')
      mkdirSync(componentsDir, { recursive: true })

      // Form A — leaky Server Component: expected RED.
      writeFileSync(
        path.join(componentsDir, 'LeakyServer.tsx'),
        "import { db } from '../../db/client'\nexport async function LeakyServer() {\n  const rows = await db`select 1`\n  return <div>{rows.length}</div>\n}\n"
      )
      // Form B — leaky 'use client' component: expected RED (the gap the
      // scanner's own isClient short-circuit leaves open).
      writeFileSync(
        path.join(componentsDir, 'LeakyClient.tsx'),
        "'use client'\nimport { db } from '../../db/client'\nexport function LeakyClient() {\n  db`select 1`\n  return <div />\n}\n"
      )
      // Form C — type-only importer: expected GREEN.
      writeFileSync(
        path.join(componentsDir, 'TypeOnlyWidget.tsx'),
        "import type { FixtureRow } from '../../db/client'\nexport function TypeOnlyWidget({ rows }: { rows: FixtureRow[] }) {\n  return <div>{rows.length}</div>\n}\n"
      )

      const dbClientAbs = path.join(fixtureRoot, 'db', 'client.ts')
      const leakyServer = path.join(componentsDir, 'LeakyServer.tsx')
      const leakyClient = path.join(componentsDir, 'LeakyClient.tsx')
      const typeOnly = path.join(componentsDir, 'TypeOnlyWidget.tsx')

      // Collection-count evidence: three fixtures named and observed, never a
      // collected-zero run silently reading as a pass.
      const collected = [leakyServer, leakyClient, typeOnly]
      expect(collected).toHaveLength(3)

      // Red before green — both leaky forms are observed failing BEFORE the
      // clean form is accepted as passing. Uses the PF3-owned walker, not
      // scanner.reachesDatabase() — see that function's own doc comment for
      // the measured defect (the scanner's isClient short-circuit fires on
      // the STARTING module too, so it could never observe form B RED).
      expect(reachesDbClientIndependentOfClientDirective(fixtureRoot, dbClientAbs, leakyServer)).toBe(true) // A — RED
      expect(reachesDbClientIndependentOfClientDirective(fixtureRoot, dbClientAbs, leakyClient)).toBe(true) // B — RED (closes the isClient gap)
      expect(reachesDbClientIndependentOfClientDirective(fixtureRoot, dbClientAbs, typeOnly)).toBe(false) // C — GREEN
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
