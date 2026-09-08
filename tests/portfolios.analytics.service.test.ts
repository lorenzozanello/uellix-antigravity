// tests/portfolios.analytics.service.test.ts
// PF1 (PORTFOLIO_PF1_EXECUTION_AUTHORITY_v1.0.0) — the SERVICE half of the
// portfolio aggregate: which run and which review getPortfolioAnalytics
// selects, in which order those two decisions are made, and what SQL
// predicates it actually builds.
//
// THREE KINDS OF CONTROL LIVE HERE, and they are labelled so a reader never
// mistakes one for another:
//
//   BEHAVIOURAL — the service runs against a table-dispatching fake of
//     `db.select()`. The fake applies NO WHERE clause of its own: it returns
//     exactly the rows the test hands it for a given table, so every selection
//     decision observed here is one the service made in TypeScript, never one
//     the fake made for it.
//   STRUCTURAL — the same fake captures the select fields, WHERE clause and
//     ORDER BY chunks the service builds, and they are rendered to real
//     PostgreSQL text with PgDialect. This is how the SQL-side predicates
//     (the approved-review EXISTS correlation, status = 'calculated',
//     the organization correlation on BOTH sides, the review ordering) are
//     asserted without a database.
//   STATIC — source-level assertions over the five PF1 authorized paths.
//
// The database-side behaviour of those predicates against real rows is proven
// in tests/postgres/portfolio-aggregate.pg.test.ts, not here.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

type Row = Record<string, unknown>

type QueryCapture = {
  table: string
  fields: Record<string, unknown> | undefined
  where: unknown[]
  orderBy: unknown[]
}

const harness = vi.hoisted(() => ({
  rowsByTable: new Map<string, Record<string, unknown>[]>(),
  calls: [] as {
    table: string
    fields: Record<string, unknown> | undefined
    where: unknown[]
    orderBy: unknown[]
  }[],
}))

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}))

vi.mock('@/db/client', async () => {
  const { getTableName } = await import('drizzle-orm')
  type Fake = {
    from(table: unknown): Fake
    where(clause: unknown): Fake
    orderBy(...args: unknown[]): Fake
    then(
      ok: (rows: Record<string, unknown>[]) => unknown,
      err?: (reason: unknown) => unknown
    ): Promise<unknown>
  }
  return {
    db: {
      select(fields?: Record<string, unknown>) {
        const call = {
          table: '',
          fields,
          where: [] as unknown[],
          orderBy: [] as unknown[],
        }
        const fake: Fake = {
          from(table: unknown) {
            call.table = getTableName(table as Parameters<typeof getTableName>[0])
            harness.calls.push(call)
            return fake
          },
          where(clause: unknown) {
            call.where.push(clause)
            return fake
          },
          orderBy(...args: unknown[]) {
            call.orderBy.push(...args)
            return fake
          },
          then(ok, err) {
            return Promise.resolve(harness.rowsByTable.get(call.table) ?? []).then(ok, err)
          },
        }
        return fake
      },
    },
  }
})

import { getPortfolioAnalytics } from '@/lib/portfolios/analytics'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

const ORG_ID = 'org-1'
const PORTFOLIO_ID = 'pf-1'

const ORG_CONTEXT = {
  user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
  organization: { id: ORG_ID, name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
  membership: { id: 'mem-1', organizationId: ORG_ID, userId: 'user-1', role: 'impact_manager', status: 'active' },
}

const PORTFOLIO_ROW: Row = { id: PORTFOLIO_ID, organizationId: ORG_ID, name: 'PF', description: null, status: 'active' }

const at = (iso: string) => new Date(iso)

type ProjectRow = { id: string; name: string; governanceRegime: string | null }
type RunRow = {
  id: string
  projectId: string
  version: number
  calculatedAt: Date
  methodologyVersion: string | null
  currency: string | null
  totalInvestment: string | null
  netSocialValue: string | null
  sroiRatio: string | null
  hasApprovedReview: boolean
}
type ReviewRow = { id: string; calculationRunId: string; readinessScore: number | null; createdAt: Date }

function project(id: string, governanceRegime: string | null = 'pc01b'): ProjectRow {
  return { id, name: id.toUpperCase(), governanceRegime }
}

function run(over: Partial<RunRow> & Pick<RunRow, 'id' | 'projectId'>): RunRow {
  return {
    version: 1,
    calculatedAt: at('2026-01-01T00:00:00Z'),
    methodologyVersion: 'v1.0.0',
    currency: 'USD',
    totalInvestment: '100.0000',
    netSocialValue: '300.0000',
    sroiRatio: '3.000000',
    hasApprovedReview: true,
    ...over,
  }
}

function review(over: Partial<ReviewRow> & Pick<ReviewRow, 'id' | 'calculationRunId'>): ReviewRow {
  return {
    readinessScore: null,
    createdAt: at('2026-01-01T00:00:00Z'),
    ...over,
  }
}

function loadWorld(world: { projects: ProjectRow[]; runs: RunRow[]; reviews: ReviewRow[]; portfolio?: Row | null }) {
  harness.rowsByTable.clear()
  harness.calls.length = 0
  const portfolio = world.portfolio === undefined ? PORTFOLIO_ROW : world.portfolio
  harness.rowsByTable.set('portfolios', portfolio === null ? [] : [portfolio])
  harness.rowsByTable.set('projects', world.projects as unknown as Row[])
  harness.rowsByTable.set('sroi_calculation_runs', world.runs as unknown as Row[])
  harness.rowsByTable.set('sroi_run_reviews', world.reviews as unknown as Row[])
}

async function analyticsOf(world: Parameters<typeof loadWorld>[0]) {
  loadWorld(world)
  const result = await getPortfolioAnalytics(PORTFOLIO_ID)
  if (!result) throw new Error('expected the portfolio to resolve')
  return result.aggregate
}

const reasonOf = (aggregate: { excluded: { projectId: string; reason: string }[] }, projectId: string) =>
  aggregate.excluded.find((e) => e.projectId === projectId)?.reason

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ORG_CONTEXT as never)
  harness.rowsByTable.clear()
  harness.calls.length = 0
})

// ── BEHAVIOURAL ───────────────────────────────────────────────────────────────

describe('PF1 service — approved-run population (BEHAVIOURAL)', () => {
  it('includes a project through its approved calculated run and reports the full traceability tuple', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [run({ id: 'r1', projectId: 'p1', version: 3 })],
      reviews: [review({ id: 'rev1', calculationRunId: 'r1', readinessScore: 80 })],
    })

    expect(aggregate.includedCount).toBe(1)
    expect(aggregate.excluded).toEqual([])
    expect(aggregate.included[0]).toEqual({
      projectId: 'p1',
      projectName: 'P1',
      runId: 'r1',
      runVersion: 3,
      reviewId: 'rev1',
      methodologyVersion: 'v1.0.0',
      sroiRatio: 3,
      totalInvestment: 100,
      netSocialValue: 300,
    })
    expect(aggregate.portfolioSroiRatio).toBe(3)
    // The readiness value comes from the SELECTED approved review.
    expect(aggregate.averageLegacyManualReadinessScore).toBe(80)
    expect(aggregate.readinessSource).toBe('LEGACY_NON_AUTHORITATIVE')
  })

  it('a calculated run with no approved review excludes the project as no_approved_run, never as no_run', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      // The project HAS a calculated run; only draft/archived reviews exist for
      // it, so the approved-review EXISTS correlation is false.
      runs: [run({ id: 'r1', projectId: 'p1', hasApprovedReview: false })],
      reviews: [],
    })

    expect(reasonOf(aggregate, 'p1')).toBe('no_approved_run')
    expect(reasonOf(aggregate, 'p1')).not.toBe('no_run')
    expect(aggregate.includedCount).toBe(0)
    expect(aggregate.portfolioSroiRatio).toBeNull()
  })

  it('a project with no calculated run at all is excluded as no_run', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [],
      reviews: [],
    })
    expect(reasonOf(aggregate, 'p1')).toBe('no_run')
  })

  // PF1-MUT-ORDER-1 — the ordering-of-operations control. On this fixture the
  // two orderings disagree ARITHMETICALLY, not merely by inspection:
  // filtering approval AFTER the latest-run choice would pick v3, discard it
  // as unapproved, report no_approved_run and lose the project entirely
  // (includedCount 0, ratio null).
  it('an older APPROVED run is never displaced by a newer unapproved one', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [
        run({
          id: 'r-v3',
          projectId: 'p1',
          version: 3,
          calculatedAt: at('2026-06-01T00:00:00Z'),
          hasApprovedReview: false,
          totalInvestment: '1000000.0000',
          netSocialValue: '0.0000',
          sroiRatio: '0.000000',
        }),
        run({
          id: 'r-v2',
          projectId: 'p1',
          version: 2,
          calculatedAt: at('2026-03-01T00:00:00Z'),
          hasApprovedReview: true,
        }),
      ],
      reviews: [review({ id: 'rev-v2', calculationRunId: 'r-v2' })],
    })

    expect(aggregate.includedCount).toBe(1)
    expect(aggregate.excluded).toEqual([])
    expect(aggregate.included[0].runId).toBe('r-v2')
    expect(aggregate.included[0].runVersion).toBe(2)
    expect(aggregate.included[0].reviewId).toBe('rev-v2')
    // The unapproved v3 run contributed to neither side of the ratio.
    expect(aggregate.totalInvestmentUsd).toBe(100)
    expect(aggregate.portfolioSroiRatio).toBe(3)
  })

  it('among APPROVED runs the highest version wins, regardless of the order rows arrive in', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [
        run({ id: 'r-v2', projectId: 'p1', version: 2, calculatedAt: at('2026-09-01T00:00:00Z') }),
        run({
          id: 'r-v5',
          projectId: 'p1',
          version: 5,
          calculatedAt: at('2026-02-01T00:00:00Z'),
          totalInvestment: '200.0000',
          netSocialValue: '1000.0000',
          sroiRatio: '5.000000',
        }),
        run({ id: 'r-v4', projectId: 'p1', version: 4, calculatedAt: at('2026-08-01T00:00:00Z') }),
      ],
      reviews: [
        review({ id: 'rev-v2', calculationRunId: 'r-v2' }),
        review({ id: 'rev-v5', calculationRunId: 'r-v5' }),
        review({ id: 'rev-v4', calculationRunId: 'r-v4' }),
      ],
    })

    expect(aggregate.included[0].runId).toBe('r-v5')
    expect(aggregate.included[0].runVersion).toBe(5)
    expect(aggregate.included[0].sroiRatio).toBe(5)
    expect(aggregate.totalInvestmentUsd).toBe(200)
  })

  // PF1-POS-TIEBREAK-1 — created_at DESC, then id DESC.
  it('with several approved reviews on the selected run, the newest created_at wins and an identical created_at is broken by id DESC', async () => {
    const sameInstant = at('2026-05-05T00:00:00Z')
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [run({ id: 'r1', projectId: 'p1' })],
      reviews: [
        // Oldest created_at. In the live pre-PF1 tree this row was the one
        // that won, because it is the row whose reviewed_at is NULL and
        // PostgreSQL sorts NULLs FIRST under DESC.
        review({ id: 'rev-oldest', calculationRunId: 'r1', createdAt: at('2026-01-01T00:00:00Z'), readinessScore: 99 }),
        review({ id: 'rev-aaa', calculationRunId: 'r1', createdAt: sameInstant, readinessScore: 10 }),
        review({ id: 'rev-zzz', calculationRunId: 'r1', createdAt: sameInstant, readinessScore: 20 }),
      ],
    })

    expect(aggregate.included[0].reviewId).toBe('rev-zzz')
    // The readiness value belongs to the SAME review the reviewId names.
    expect(aggregate.averageLegacyManualReadinessScore).toBe(20)
    expect(aggregate.averageLegacyManualReadinessScore).not.toBe(99)
  })

  it('a run the approved-review correlation admits but for which no approved review row comes back is not selected', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [
        run({ id: 'r-v2', projectId: 'p1', version: 2 }),
        run({ id: 'r-v9', projectId: 'p1', version: 9, totalInvestment: '999.0000' }),
      ],
      // r-v9 has no approved review row — only r-v2 does.
      reviews: [review({ id: 'rev-v2', calculationRunId: 'r-v2' })],
    })

    expect(aggregate.included).toHaveLength(1)
    expect(aggregate.included[0].runId).toBe('r-v2')
    expect(aggregate.included[0].reviewId).toBe('rev-v2')
  })

  it('excludes a pre_pc01b project as legacy_non_authoritative even though its run is approved', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1', 'pre_pc01b')],
      runs: [run({ id: 'r1', projectId: 'p1' })],
      reviews: [review({ id: 'rev1', calculationRunId: 'r1' })],
    })
    expect(reasonOf(aggregate, 'p1')).toBe('legacy_non_authoritative')
    expect(aggregate.includedCount).toBe(0)
  })

  it('excludes a selected run whose methodology_version is NULL as legacy_non_authoritative', async () => {
    const aggregate = await analyticsOf({
      projects: [project('p1')],
      runs: [run({ id: 'r1', projectId: 'p1', methodologyVersion: null })],
      reviews: [review({ id: 'rev1', calculationRunId: 'r1' })],
    })
    expect(reasonOf(aggregate, 'p1')).toBe('legacy_non_authoritative')
  })

  it('excludes a null, zero or negative total_investment as zero_or_invalid_investment', async () => {
    const aggregate = await analyticsOf({
      projects: [project('pNull'), project('pZero'), project('pNeg')],
      runs: [
        run({ id: 'rNull', projectId: 'pNull', totalInvestment: null }),
        run({ id: 'rZero', projectId: 'pZero', totalInvestment: '0.0000' }),
        run({ id: 'rNeg', projectId: 'pNeg', totalInvestment: '-250.0000' }),
      ],
      reviews: [
        review({ id: 'revNull', calculationRunId: 'rNull' }),
        review({ id: 'revZero', calculationRunId: 'rZero' }),
        review({ id: 'revNeg', calculationRunId: 'rNeg' }),
      ],
    })

    expect(aggregate.excluded.map((e) => e.reason)).toEqual([
      'zero_or_invalid_investment',
      'zero_or_invalid_investment',
      'zero_or_invalid_investment',
    ])
    expect(aggregate.totalInvestmentUsd).toBe(0)
    expect(aggregate.portfolioSroiRatio).toBeNull()
  })

  it('produces all six frozen exclusion reasons, in their frozen order, from one real population', async () => {
    const aggregate = await analyticsOf({
      projects: [
        project('p1'),
        project('p2'),
        project('p3', 'pre_pc01b'),
        project('p4'),
        project('p5'),
        project('p6'),
      ],
      runs: [
        run({ id: 'r2', projectId: 'p2', hasApprovedReview: false }),
        run({ id: 'r3', projectId: 'p3' }),
        run({ id: 'r4', projectId: 'p4', currency: 'COP' }),
        run({ id: 'r5', projectId: 'p5', sroiRatio: null }),
        run({ id: 'r6', projectId: 'p6', totalInvestment: '0.0000' }),
      ],
      reviews: [
        review({ id: 'rev3', calculationRunId: 'r3' }),
        review({ id: 'rev4', calculationRunId: 'r4' }),
        review({ id: 'rev5', calculationRunId: 'r5' }),
        review({ id: 'rev6', calculationRunId: 'r6' }),
      ],
    })

    expect(aggregate.excluded.map((e) => e.reason)).toEqual([
      'no_run',
      'no_approved_run',
      'legacy_non_authoritative',
      'non_usd_currency',
      'no_sroi_ratio',
      'zero_or_invalid_investment',
    ])
    expect(aggregate.includedCount).toBe(0)
    expect(aggregate.portfolioSroiRatio).toBeNull()
  })

  it('aggregates Σ net / Σ investment over the included subset only, never an average of ratios', async () => {
    const aggregate = await analyticsOf({
      projects: [project('a'), project('b'), project('c')],
      runs: [
        run({ id: 'ra', projectId: 'a', totalInvestment: '100.0000', netSocialValue: '300.0000', sroiRatio: '3.000000' }),
        run({ id: 'rb', projectId: 'b', totalInvestment: '900.0000', netSocialValue: '900.0000', sroiRatio: '1.000000' }),
        run({ id: 'rc', projectId: 'c', hasApprovedReview: false, totalInvestment: '5000.0000', netSocialValue: '5000.0000', sroiRatio: '1.000000' }),
      ],
      reviews: [review({ id: 'reva', calculationRunId: 'ra' }), review({ id: 'revb', calculationRunId: 'rb' })],
    })

    expect(aggregate.totalInvestmentUsd).toBe(1000)
    expect(aggregate.totalNetSocialValueUsd).toBe(1200)
    expect(aggregate.portfolioSroiRatio).toBe(1.2)
    // The average of the two included ratios would be 2.0.
    expect(aggregate.portfolioSroiRatio).not.toBe(2)
  })

  it('an empty portfolio and a portfolio the organization does not own are handled without a run query', async () => {
    const empty = await analyticsOf({ projects: [], runs: [], reviews: [] })
    expect(empty.projectCount).toBe(0)
    expect(empty.portfolioSroiRatio).toBeNull()
    expect(harness.calls.some((c) => c.table === 'sroi_calculation_runs')).toBe(false)

    loadWorld({ projects: [], runs: [], reviews: [], portfolio: null })
    expect(await getPortfolioAnalytics(PORTFOLIO_ID)).toBeNull()
  })

  it('refuses to run without an organization context', async () => {
    loadWorld({ projects: [], runs: [], reviews: [] })
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(null as never)
    await expect(getPortfolioAnalytics(PORTFOLIO_ID)).rejects.toThrow('Unauthenticated')
  })
})

// ── STRUCTURAL ────────────────────────────────────────────────────────────────

const dialect = new PgDialect()
const renderSql = (chunk: unknown): string => dialect.sqlToQuery(chunk as SQL).sql
const renderParams = (chunk: unknown): unknown[] => dialect.sqlToQuery(chunk as SQL).params

/** Collapse whitespace so multi-line SQL can be matched as one string. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

function callFor(table: string): QueryCapture {
  const call = harness.calls.find((c) => c.table === table)
  if (!call) throw new Error(`no query was built against ${table}`)
  return call
}

describe('PF1 service — the SQL the service actually builds (STRUCTURAL)', () => {
  beforeEach(async () => {
    await analyticsOf({
      projects: [project('p1')],
      runs: [run({ id: 'r1', projectId: 'p1' })],
      reviews: [review({ id: 'rev1', calculationRunId: 'r1' })],
    })
  })

  it('the run query carries an EXISTS correlation to an APPROVED review of the SAME organization', () => {
    const fields = callFor('sroi_calculation_runs').fields
    expect(fields).toBeDefined()
    const existsSql = flat(renderSql(fields!.hasApprovedReview))
    expect(existsSql).toMatch(/^EXISTS \(/)
    expect(existsSql).toContain('"sroi_run_reviews"')
    // correlated on the run id …
    expect(existsSql).toContain('"sroi_run_reviews"."calculation_run_id" = "sroi_calculation_runs"."id"')
    // … on the organization, on BOTH sides, never only on the run side …
    expect(existsSql).toContain('"sroi_run_reviews"."organization_id" = "sroi_calculation_runs"."organization_id"')
    // … and on a CURRENTLY approved status.
    expect(existsSql).toContain(`"sroi_run_reviews"."status" = 'approved'`)
  })

  it('the run query is scoped to calculated runs of the caller organization and the portfolio projects', () => {
    const call = callFor('sroi_calculation_runs')
    const where = flat(renderSql(call.where[0]))
    const params = renderParams(call.where[0])
    expect(where).toContain('"sroi_calculation_runs"."project_id" in')
    expect(where).toContain('"sroi_calculation_runs"."organization_id" =')
    expect(where).toContain('"sroi_calculation_runs"."status" =')
    expect(params).toContain(ORG_ID)
    expect(params).toContain('calculated')
  })

  it('the run query orders by version DESC then calculated_at DESC', () => {
    const order = callFor('sroi_calculation_runs').orderBy.map((c) => flat(renderSql(c)))
    expect(order).toEqual(['"sroi_calculation_runs"."version" desc', '"sroi_calculation_runs"."calculated_at" desc'])
  })

  it('the review query is filtered to APPROVED reviews of the caller organization', () => {
    const call = callFor('sroi_run_reviews')
    const where = flat(renderSql(call.where[0]))
    const params = renderParams(call.where[0])
    expect(where).toContain('"sroi_run_reviews"."calculation_run_id" in')
    expect(where).toContain('"sroi_run_reviews"."organization_id" =')
    expect(where).toContain('"sroi_run_reviews"."status" =')
    expect(params).toContain(ORG_ID)
    expect(params).toContain('approved')
  })

  // PF1-POS-TIEBREAK-1 / PF1-NEG-TIEBREAK-1 at the SQL level.
  it('the review query orders by created_at DESC then id DESC — and by nothing else', () => {
    const order = callFor('sroi_run_reviews').orderBy.map((c) => flat(renderSql(c)))
    expect(order).toEqual(['"sroi_run_reviews"."created_at" desc', '"sroi_run_reviews"."id" desc'])
  })

  it('the project query carries the governance regime the FIBC-042 exclusion reads', () => {
    const fields = callFor('projects').fields
    expect(fields).toBeDefined()
    expect(Object.keys(fields!)).toContain('governanceRegime')
  })
})

// ── STATIC ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..')

/** The five paths PF1 is authorized to write, and the only paths these controls claim anything about. */
const PF1_AUTHORIZED_PATHS = [
  'lib/portfolios/analytics.ts',
  'lib/portfolios/analytics.test.ts',
  'tests/portfolios.analytics.service.test.ts',
  'tests/postgres/portfolio-aggregate.pg.test.ts',
  'tests/postgres/portfolio-aggregate.probes.json',
] as const

/**
 * The prohibited ordering column, assembled from fragments.
 *
 * PF1-NEG-TIEBREAK-1 scans all five authorized paths, and this file is one of
 * them: writing the column name as a literal here would make the control fail
 * on its own source. The fragments are the same two identifiers the scan looks
 * for, in the snake_case and camelCase spellings the SQL and the ORM use.
 */
const PROHIBITED_ORDER_COLUMNS = ['reviewed' + '_at', 'reviewed' + 'At']

const readAuthorized = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

/** Strip `//` and block comments so a prose mention of a prohibited column is never read as code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every `.orderBy( … )` argument list in a TypeScript source, parenthesis-balanced. */
function orderByCallArguments(source: string): string[] {
  const found: string[] = []
  // Assembled from fragments so the scanner does not match its own needle.
  const needle = '.order' + 'By('
  let from = 0
  for (;;) {
    const start = source.indexOf(needle, from)
    if (start === -1) return found
    let depth = 0
    let i = start + needle.length - 1
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    found.push(source.slice(start, i + 1))
    from = i + 1
  }
}

/**
 * Every `ORDER BY …` in SQL text, plus the 200 characters that follow it.
 *
 * A fixed window rather than a clause delimiter on purpose: a delimiter that
 * fails to match (a multi-statement CREATE VIEW has no `;` for hundreds of
 * characters) would silently skip the ordering it was meant to inspect. Over-
 * capturing is the conservative direction — it can only add findings.
 */
function orderByClauses(sql: string): string[] {
  const found: string[] = []
  const pattern = /order\s+by/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) found.push(sql.slice(match.index, match.index + 200))
  return found
}

/** Strip `--` line comments from SQL, so a prose mention is never read as a clause. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ')
}

/** The SQL a committed probe manifest carries, comments removed. */
function probeSql(raw: string): string {
  const manifest = JSON.parse(raw) as { probes: { sql: string }[] }
  return manifest.probes.map((p) => stripSqlComments(p.sql)).join('\n')
}

describe('PF1-NEG-TIEBREAK-1 — the prohibited review column is never an ordering input on any PF1 path (STATIC)', () => {
  it.each(PF1_AUTHORIZED_PATHS)('%s contains no ordering over the prohibited column', (rel) => {
    const raw = readAuthorized(rel)
    const source = rel.endsWith('.json') ? probeSql(raw) : stripSqlComments(stripComments(raw))
    const clauses = rel.endsWith('.json')
      ? orderByClauses(source)
      : [...orderByCallArguments(source), ...orderByClauses(source)]
    // The two paths that DO order rows must be seen to order rows, otherwise a
    // scan that found nothing would be indistinguishable from a passing one.
    if (rel === 'lib/portfolios/analytics.ts' || rel.endsWith('.probes.json')) {
      expect(clauses.length, `${rel} declares no ordering at all — the scan is vacuous`).toBeGreaterThan(0)
    }
    for (const clause of clauses) {
      for (const column of PROHIBITED_ORDER_COLUMNS) {
        expect(clause.toLowerCase()).not.toContain(column.toLowerCase())
      }
    }
  })

  it('the application query orders the approved reviews by created_at and id, and by nothing else', () => {
    const source = stripComments(readAuthorized('lib/portfolios/analytics.ts'))
    const clauses = orderByCallArguments(source)
    const reviewOrdering = clauses.find((c) => c.includes('sroiRunReviews'))
    expect(reviewOrdering, 'the approved-review query has no ORDER BY at all').toBeDefined()
    expect(reviewOrdering!).toContain('sroiRunReviews.createdAt')
    expect(reviewOrdering!).toContain('sroiRunReviews.id')
  })
})

describe('NEG-READINESS-1 — no canonical readiness-table dependency on the PF1 path (STATIC)', () => {
  it.each(PF1_AUTHORIZED_PATHS)('%s neither reads the canonical readiness table nor calls its accessor', (rel) => {
    const raw = readAuthorized(rel)
    const source = rel.endsWith('.json') ? raw : stripComments(raw)
    expect(source).not.toContain('readiness' + '_assessments')
    expect(source).not.toContain('readiness' + 'Assessments')
    expect(source).not.toContain('getReadiness' + 'Assessment')
  })

  it('the four B5 legacy readiness symbols are preserved, and none is relabelled as canonical readiness', () => {
    const source = readAuthorized('lib/portfolios/analytics.ts')
    for (const symbol of [
      'legacyManualReadinessScore',
      'averageLegacyManualReadinessScore',
      'legacyManualReadinessCoverage',
      "readinessSource: 'LEGACY_NON_AUTHORITATIVE'",
    ]) {
      expect(source).toContain(symbol)
    }
    // The pre-B5 names must not come back AS DECLARED FIELDS. The check is
    // scoped to the exported type declarations, because
    // sroi_run_reviews.readiness_score remains the legitimate SOURCE column
    // and its Drizzle accessor necessarily appears in the query below them.
    const declarations = stripComments(
      source.slice(
        source.indexOf('export type ParsedRunTotals'),
        source.indexOf('export function aggregatePortfolioSroi')
      )
    )
    expect(declarations).toContain('legacyManualReadinessScore')
    expect(declarations).not.toMatch(/\breadinessScore\b/)
    expect(declarations).not.toMatch(/\baverageReadinessScore\b/)
    expect(declarations).not.toMatch(/\breadinessCoverage\b/)
  })
})

// NEG-AGG-4 is shared with the other Portfolio nodes; PF1 discharges its own
// share of it — that a non-USD run is excluded rather than converted, and that
// no PF1 path reads an FX rate to do the converting.
describe('NEG-AGG-4 — a non-USD run is excluded, never converted (STATIC)', () => {
  it.each(PF1_AUTHORIZED_PATHS)('%s reads no FX rate', (rel) => {
    const raw = readAuthorized(rel)
    const source = rel.endsWith('.json') ? raw : stripComments(raw)
    // Assembled from fragments: this file is itself one of the scanned paths.
    for (const needle of ['fx' + 'Rates', 'fx' + '_rates', 'getOrCreate' + 'FxRate', 'fetchHistorical' + 'RateToUsd', 'lib/pipeline/' + 'fx']) {
      expect(source, `${rel} reaches an FX surface via ${needle}`).not.toContain(needle)
    }
  })

  it('the aggregate excludes a non-USD run instead of converting it', () => {
    const source = stripComments(readAuthorized('lib/portfolios/analytics.ts'))
    expect(source).toContain("run.currency !== 'USD'")
    expect(source).toContain("exclude('non_usd_currency')")
  })
})

describe('PF1 — the exclusion vocabulary stays a closed six-member literal union (STATIC)', () => {
  it('declares exactly the six frozen reasons, in the frozen order, and never widens to string', () => {
    const source = readAuthorized('lib/portfolios/analytics.ts')
    const union = source.slice(source.indexOf('export type ExcludedProject'))
    const head = union.slice(0, union.indexOf('}'))
    const literals = head.match(/'[a-z_]+'/g) ?? []
    expect(literals).toEqual([
      "'no_run'",
      "'no_approved_run'",
      "'legacy_non_authoritative'",
      "'non_usd_currency'",
      "'no_sroi_ratio'",
      "'zero_or_invalid_investment'",
    ])
    expect(head).not.toMatch(/reason\s*:\s*string/)
  })
})
