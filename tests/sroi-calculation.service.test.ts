// tests/sroi-calculation.service.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/db/client';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { financialProxies } from '@/db/schema';

// Mock authentication/session utilities
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
  getCurrentOrganizationContext: vi.fn(),
  // Pass-through: the service guards are what this suite exercises.
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) => cb(undefined),
}));

// Mock permission checks
vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>();
  return { ...actual, logAuditAction: vi.fn() };
});

// Mock DB client with simple in‑memory structures
const mockDb = {
  projects: [] as any[],
  outcomes: [] as any[],
  projectInvestments: [] as any[],
  outcomeProxyAssignments: [] as any[],
  sroiAssignmentInputs: [] as any[],
  sroiFilterSets: [] as any[],
  financialProxies: [] as any[],
  financialProxyVersions: [] as any[],
  sroiCalculationRuns: [] as any[],
  sroiCalculationLineItems: [] as any[],
  sroiRunReviews: [] as any[],
  outcomeMonetizationDispositions: [] as any[],
  evidenceItems: [] as any[],
  funders: [] as any[],
  outcomeFunderAllocations: [] as any[],
  domainObjectVersions: [] as any[],
  // FIBIU-02 — calculateAndPersistSroiRun resolves the run version identity
  // triple from this registry before persisting; seeded with the same two
  // rows the real deploy-time seed (0040_governed_model_registry.sql)
  // carries, so the happy path resolves without every test having to know
  // about FIBIU-02.
  governedModelRegistry: [
    { modelId: 'PC01B_HUMAN_METHODOLOGY_AUTHORITY', version: '1.0.0', effectiveFrom: new Date('2026-01-01') },
    { modelId: 'SROI_CALCULATION_ENGINE', version: '1.0.0', effectiveFrom: new Date('2026-01-01') },
  ] as any[],
};

function getTableData(table: any): any[] {
  const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
  if (!pgName) return [];
  const camelName = pgName.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase());
  return (mockDb as any)[camelName] ?? (mockDb as any)[pgName] ?? [];
}

// getLatestDomainObjectVersion (used by both the fingerprint builder and
// detectRunInputDrift) depends on a REAL where()-filter and a real
// most-recent-ordinal ordering — every other table's mock below is a
// permissive passthrough (`where`/`orderBy`/`limit` are no-ops), which would
// make every domain_object_versions lookup collapse to "whatever was pushed
// first", indistinguishable across different (objectType, objectId) pairs.
// This extracts the two eq() values from FIBIU-03's exact query shape
// (and(eq(objectType, x), eq(objectId, y))) and filters/sorts for real.
function extractEqValues(val: any): string[] {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val.flatMap(extractEqValues);
  const res: string[] = [];
  if (val.value !== undefined) {
    if (typeof val.value === 'string') res.push(val.value);
    else if (Array.isArray(val.value)) res.push(...val.value.flatMap(extractEqValues));
    else res.push(...extractEqValues(val.value));
  }
  if (val.right !== undefined) res.push(...extractEqValues(val.right));
  if (val.left !== undefined) res.push(...extractEqValues(val.left));
  if (Array.isArray(val.conditions)) res.push(...val.conditions.flatMap(extractEqValues));
  if (Array.isArray(val.queryChunks)) res.push(...val.queryChunks.flatMap(extractEqValues));
  return res;
}

vi.mock('@/db/client', () => {
  const dbMock: any = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table) => {
        const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
        let data = getTableData(table);
        const queryResult = {
          where: vi.fn().mockImplementation((cond: any) => {
            if (pgName === 'domain_object_versions' && cond) {
              const eqValues = extractEqValues(cond);
              data = data.filter((row: any) => eqValues.includes(row.objectType) && eqValues.includes(row.objectId));
            }
            return queryResult;
          }),
          limit: vi.fn().mockImplementation(() => queryResult),
          orderBy: vi.fn().mockImplementation(() => {
            if (pgName === 'domain_object_versions') {
              data = [...data].sort((a: any, b: any) => b.ordinal - a.ordinal);
            }
            return queryResult;
          }),
          then: (cb: any) => Promise.resolve(cb(data)),
        };
        return queryResult;
      }),
    })),
    insert: vi.fn().mockImplementation((table) => ({
      values: vi.fn().mockImplementation((vals) => ({
        returning: vi.fn().mockImplementation(() => {
          const valsArray = Array.isArray(vals) ? vals : [vals];
          const inserted = { ...valsArray[0], id: crypto.randomUUID() };
          const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
          if (pgName) {
            const camelName = pgName.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase());
            const targetArray = (mockDb as any)[camelName] ?? (mockDb as any)[pgName];
            if (targetArray) {
              targetArray.push(inserted);
            }
          }
          return Promise.resolve([inserted]);
        }),
      })),
    })),
    update: vi.fn().mockImplementation((table) => ({
      set: vi.fn().mockImplementation((values) => ({
        where: vi.fn().mockImplementation(() => {
          const data = getTableData(table);
          if (data.length > 0) {
            Object.assign(data[0], values);
          }
          return {
            returning: vi.fn().mockImplementation(() => Promise.resolve([data[0]])),
          };
        }),
      })),
    })),
  };
  // The calculation engine persists inside db.transaction(cb); run the callback
  // against the same mock so select/insert/update (and their spies) behave
  // identically inside and outside the transaction.
  dbMock.transaction = vi.fn().mockImplementation(async (cb: any) => cb(dbMock));
  return { db: dbMock };
});

import {
  calculateSroiPreview,
  calculateAndPersistSroiRun,
  getSroiCalculationReadiness,
  runDeterministicCalc,
  listSroiCalculationRuns,
  detectRunInputDrift,
  upsertProjectInvestment,
  upsertSroiAssignmentInput,
  upsertSroiFilterSet,
  getFilterJustificationIssues,
  recordOutcomeMonetizationDisposition,
  getMonetizationCoverage,
  loadCalculationData,
} from '@/lib/pipeline/sroi-calculation';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  // FIBIU-02 — the run version identity triple's third leg (build_identity)
  // is resolved from the environment; stub it so calculateAndPersistSroiRun
  // resolves the full triple in these tests without depending on a real
  // Vercel deployment.
  vi.stubEnv('BUILD_IDENTITY', 'test-build-identity');
  Object.assign(mockDb, {
    projects: [{ id: PROJECT_ID, organizationId: ORG_ID }],
    outcomes: [],
    projectInvestments: [],
    outcomeProxyAssignments: [],
    sroiAssignmentInputs: [],
    sroiFilterSets: [],
    financialProxies: [],
    financialProxyVersions: [],
    sroiCalculationRuns: [],
    sroiCalculationLineItems: [],
    sroiRunReviews: [],
    outcomeMonetizationDispositions: [],
    evidenceItems: [],
    funders: [],
    outcomeFunderAllocations: [],
    domainObjectVersions: [],
    governedModelRegistry: [
      { modelId: 'PC01B_HUMAN_METHODOLOGY_AUTHORITY', version: '1.0.0', effectiveFrom: new Date('2026-01-01') },
      { modelId: 'SROI_CALCULATION_ENGINE', version: '1.0.0', effectiveFrom: new Date('2026-01-01') },
    ],
  });
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID },
    user: { id: USER_ID },
    membership: { role: 'analyst' },
  } as any);
  vi.mocked(hasRole).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedHappyData(overrides?: Partial<{ investment: any; proxy: any; proxyVersion: any; assignment: any; input: any; filter: any }>) {
  const investment = {
    id: 'inv-1',
    projectId: PROJECT_ID,
    organizationId: ORG_ID,
    funderId: 'funder-1',
    contributionType: 'cash',
    amount: '1000',
    currency: 'USD',
    status: 'active',
    ...overrides?.investment,
  } as any;
  // USD contributions freeze amount_usd = amount unless the override sets it.
  if (investment.amountUsd === undefined) {
    investment.amountUsd = investment.currency === 'USD' ? investment.amount : null;
  }
  const proxy = {
    id: 'proxy-1',
    organizationId: null,
    reviewStatus: 'approved',
    value: '100',
    currency: 'USD',
    ...overrides?.proxy,
  } as any;
  if (proxy.valueUsd === undefined) {
    proxy.valueUsd = proxy.currency === 'USD' ? proxy.value : null;
  }
  // FIBIU-08 (FIBDB-039) — the assignment binds to a proxy VERSION, not just
  // the live proxy row; a NULL/unapproved version is exactly as ineligible
  // as an unapproved live proxy. Mirrors proxy.reviewStatus by default so
  // every existing `{ proxy: { reviewStatus: ... } }` override keeps working
  // unchanged — override `proxyVersion` directly only when a test needs the
  // version's state to diverge from the live proxy's.
  // R-B2-05 (AG-B2-1) — the bound version is the SOLE monetary source, so
  // it mirrors the proxy's valueUsd by default (override `proxyVersion`
  // when a test needs the two to diverge — that divergence is exactly what
  // the historical-stability controls exercise).
  const proxyVersion = {
    id: 'proxy-version-1',
    financialProxyId: proxy.id,
    ordinal: 1,
    reviewStatus: proxy.reviewStatus,
    valueUsd: proxy.valueUsd,
    ...overrides?.proxyVersion,
  } as any;
  const assignment = {
    id: ASSIGNMENT_ID,
    projectId: PROJECT_ID,
    organizationId: ORG_ID,
    outcomeId: 'out-1',
    proxyId: proxy.id,
    financialProxyVersionId: proxyVersion.id,
    assignmentStatus: 'active',
    ...overrides?.assignment,
  };
  const input = {
    id: 'input-1',
    assignmentId: assignment.id,
    quantity: '10',
    unit: 'units',
    ...overrides?.input,
  };
  // W2-B3 completeness (AG-B3-4): the AUTHORITATIVE persisted path refuses a
  // NULL governed filter (FILTER_VALUE_UNKNOWN), so the happy fixture carries
  // explicit zeros — "justified 0" — which the engine reads as exactly 0;
  // tests that need an unknown filter override a value with null explicitly.
  const filter = {
    id: 'filter-1',
    assignmentId: assignment.id,
    deadweightPct: '0',
    attributionPct: '0',
    displacementPct: '0',
    dropoffPct: '0',
    durationYears: 1,
    ...overrides?.filter,
  };
  mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
  mockDb.outcomes.push({ id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID });
  mockDb.funders.push({ id: 'funder-1', organizationId: ORG_ID, name: 'Fundación Test', funderType: 'foundation' });
  mockDb.projectInvestments.push(investment);
  mockDb.financialProxies.push(proxy);
  mockDb.financialProxyVersions.push(proxyVersion);
  mockDb.outcomeProxyAssignments.push(assignment);
  mockDb.sroiAssignmentInputs.push(input);
  mockDb.sroiFilterSets.push(filter);
  // Evidence gate: the outcome that feeds the calculation must be backed by at
  // least one non-archived evidence item for readiness to pass.
  mockDb.evidenceItems.push({
    id: 'ev-1',
    projectId: PROJECT_ID,
    organizationId: ORG_ID,
    outcomeId: assignment.outcomeId,
    status: 'approved',
  });
  return { investment, proxy, proxyVersion, assignment, input, filter };
}

describe('Base formula happy path', () => {
  it('calculates gross, adjusted, net and sroiRatio = 1', async () => {
    seedHappyData();
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(true);
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.canCalculate).toBe(true);
    const result = preview.result!;
    expect(result.totalInvestment).toBe(1000);
    expect(result.grossSocialValue).toBe(1000);
    expect(result.netSocialValue).toBe(1000);
    expect(result.sroiRatio).toBeCloseTo(1);
    expect(result.lineItems).toHaveLength(1);
    const li = result.lineItems[0];
    expect(li.quantity).toBe(10);
    expect(li.proxyValue).toBe(100);
    expect(li.grossValue).toBe(1000);
    expect(li.adjustedValue).toBe(1000);
  });
});

describe('Filters effect on calculation', () => {
  it('deadweight reduces value', async () => {
    seedHappyData({ filter: { deadweightPct: '50' } });
    const preview = await calculateSroiPreview(PROJECT_ID);
    const li = preview.result!.lineItems[0];
    expect(li.adjustedValue).toBeCloseTo(500);
    expect(preview.result!.netSocialValue).toBeCloseTo(500);
    expect(preview.result!.sroiRatio).toBeCloseTo(0.5);
  });

  it('multiple filters combine multiplicatively', async () => {
    seedHappyData({
      filter: {
        deadweightPct: '20',
        attributionPct: '10',
        displacementPct: '30',
        dropoffPct: '0',
        durationYears: 1,
      },
    });
    const preview = await calculateSroiPreview(PROJECT_ID);
    const li = preview.result!.lineItems[0];
    const factor = (1 - 0.2) * (1 - 0.1) * (1 - 0.3);
    expect(li.adjustedValue).toBeCloseTo(1000 * factor);
    expect(preview.result!.sroiRatio).toBeCloseTo(factor);
  });
});

describe('Duration and dropoff handling', () => {
  it('duration >1 multiplies horizon and applies dropoff each year', async () => {
    seedHappyData({
      filter: { durationYears: 3, dropoffPct: '10' },
    });
    const preview = await calculateSroiPreview(PROJECT_ID);
    const li = preview.result!.lineItems[0];
    expect(li.grossValue).toBe(3000);
    const expectedAdjusted = 1000 + 1000 * 0.9 + 1000 * 0.9 * 0.9;
    expect(li.adjustedValue).toBeCloseTo(expectedAdjusted);
    expect(preview.result!.netSocialValue).toBeCloseTo(expectedAdjusted);
    expect(preview.result!.sroiRatio).toBeCloseTo(expectedAdjusted / 1000);
  });
});

describe('FIBIU-13 (FIBC-017) — filter justification gate', () => {
  describe('getFilterJustificationIssues (pure)', () => {
    it('P-5: a justified 0 on every filter is accepted -- no issues', () => {
      const issues = getFilterJustificationIssues({
        deadweightPct: '0', attributionPct: '0', displacementPct: '0', dropoffPct: '0', durationYears: 0,
        deadweightJustification: 'No deadweight observed in the comparison group.',
        attributionJustification: 'Sole funder, full attribution.',
        displacementJustification: 'No displacement identified.',
        dropoffJustification: 'No decay modelled for this horizon.',
        durationJustification: 'Single-year outcome window.',
      });
      expect(issues).toEqual([]);
    });

    it('N-3: a present value with no justification reports FILTER_JUSTIFICATION_MISSING, naming the filter', () => {
      const issues = getFilterJustificationIssues({
        deadweightPct: '25', attributionPct: null, displacementPct: null, dropoffPct: null, durationYears: null,
        deadweightJustification: null,
        attributionJustification: null, displacementJustification: null, dropoffJustification: null, durationJustification: null,
      });
      expect(issues).toContainEqual({ filter: 'deadweight', issue: 'FILTER_JUSTIFICATION_MISSING' });
    });

    it('N-3 / M-3: a NULL value reports FILTER_VALUE_MISSING, never silently treated as a justified 0', () => {
      const issues = getFilterJustificationIssues({
        deadweightPct: null, attributionPct: null, displacementPct: null, dropoffPct: null, durationYears: null,
        deadweightJustification: 'This would be irrelevant -- the value itself is unset.',
        attributionJustification: null, displacementJustification: null, dropoffJustification: null, durationJustification: null,
      });
      expect(issues).toContainEqual({ filter: 'deadweight', issue: 'FILTER_VALUE_MISSING' });
      // Presence of a justification does not paper over a missing value --
      // proves the null check runs before any parseNum-style coercion, not
      // after (a reintroduced parseNum(null) -> 0 would make this a
      // FILTER_JUSTIFICATION_MISSING-only outcome, or no issue at all).
      expect(issues.find((i) => i.filter === 'deadweight')?.issue).toBe('FILTER_VALUE_MISSING');
    });

    it('an empty-string value is treated as missing, the same as NULL', () => {
      const issues = getFilterJustificationIssues({
        deadweightPct: '', attributionPct: null, displacementPct: null, dropoffPct: null, durationYears: null,
        deadweightJustification: null, attributionJustification: null, displacementJustification: null, dropoffJustification: null, durationJustification: null,
      });
      expect(issues).toContainEqual({ filter: 'deadweight', issue: 'FILTER_VALUE_MISSING' });
    });

    it('a fully unset filter set reports FILTER_VALUE_MISSING for all five filters', () => {
      const issues = getFilterJustificationIssues(null);
      expect(issues).toHaveLength(5);
      expect(issues.every((i) => i.issue === 'FILTER_VALUE_MISSING')).toBe(true);
      expect(issues.map((i) => i.filter).sort()).toEqual(['attribution', 'deadweight', 'displacement', 'dropoff', 'duration']);
    });

    it('N-4: discount_rate_pct is not one of the five gated filters (structurally out of scope)', () => {
      const issues = getFilterJustificationIssues({
        deadweightPct: '0', attributionPct: '0', displacementPct: '0', dropoffPct: '0', durationYears: 1,
        deadweightJustification: 'x', attributionJustification: 'x', displacementJustification: 'x', dropoffJustification: 'x', durationJustification: 'x',
      });
      expect(issues.map((i) => i.filter)).not.toContain('discount_rate');
      expect(issues).toEqual([]);
    });
  });

  describe('upsertSroiFilterSet persistence', () => {
    it('persists all five discrete justification columns independently of the legacy shared column', async () => {
      seedHappyData();
      const saved = await upsertSroiFilterSet(PROJECT_ID, ASSIGNMENT_ID, {
        deadweightPct: '15',
        deadweightJustification: 'Comparison-group evidence.',
        justification: 'legacy free text, unrelated',
      } as any);
      expect(saved.deadweightJustification).toBe('Comparison-group evidence.');
      expect(saved.justification).toBe('legacy free text, unrelated');
      // The legacy column is never auto-distributed into the discrete ones.
      expect(saved.attributionJustification ?? null).toBeNull();
    });
  });
});

describe('Readiness edge cases', () => {
  it('fails when no investment', async () => {
    const proxy = { id: 'proxy-1', organizationId: null, reviewStatus: 'approved', value: '100', currency: 'USD' };
    const assignment = { id: ASSIGNMENT_ID, projectId: PROJECT_ID, organizationId: ORG_ID, outcomeId: 'out-1', proxyId: proxy.id, assignmentStatus: 'active' };
    const input = { id: 'input-1', assignmentId: assignment.id, quantity: '10', unit: 'units' };
    const filter = { id: 'filter-1', assignmentId: assignment.id, durationYears: 1 };
    mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
    mockDb.financialProxies.push(proxy);
    mockDb.outcomeProxyAssignments.push(assignment);
    mockDb.sroiAssignmentInputs.push(input);
    mockDb.sroiFilterSets.push(filter);
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Missing project investment');
  });

  it('fails when investment <= 0', async () => {
    seedHappyData({ investment: { amount: '0' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Investment amount must be > 0');
  });

  it('fails when no active assignments', async () => {
    mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
    mockDb.projectInvestments.push({ id: 'inv-1', projectId: PROJECT_ID, organizationId: ORG_ID, amount: '1000', currency: 'USD' });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('No active proxy assignments');
  });

  it('fails when quantity <= 0', async () => {
    seedHappyData({ input: { quantity: '0' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Invalid quantities in 1 item(s)');
  });

  it('fails when filter out of range', async () => {
    seedHappyData({ filter: { deadweightPct: '150' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Invalid filter values in 1 assignment(s)');
  });

  it('fails when the outcome has no supporting evidence (evidence gate)', async () => {
    seedHappyData();
    mockDb.evidenceItems = []; // remove the evidence seeded by seedHappyData
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.outcomesWithoutEvidence).toContain('out-1');
    expect(readiness.blockingReasons).toContain('1 outcome(s) with no supporting evidence');
  });

  it('fails when duration out of bounds', async () => {
    seedHappyData({ filter: { durationYears: 0 } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Invalid filter values in 1 assignment(s)');
  });

  it('fails when proxy not approved', async () => {
    seedHappyData({ proxy: { reviewStatus: 'suggested' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('1 unapproved proxy(ies)');
  });

  // FIBIU-08 (FIBC-012) — "eligibility binds to the exact reviewed version",
  // not merely to what the live proxy row currently claims. These three
  // prove the binding is load-bearing, not decorative: a divergent or
  // absent BOUND version fails closed even when the live proxy row alone
  // would look fully approved.
  it('fails when the assignment has NO bound version, even though the live proxy is approved', async () => {
    seedHappyData({ assignment: { financialProxyVersionId: null } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('1 unapproved proxy(ies)');
    // calculateAndPersistSroiRun checks readiness first, so the generic
    // aggregate rejection is what surfaces — the more specific
    // "assigned version is not approved" message lives one layer deeper,
    // in loadCalculationData's own enforceApproval path, and is exercised
    // directly by the two enforceApproval-path tests below.
    await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow(
      /Cannot calculate: 1 unapproved proxy\(ies\)/
    );
  });

  it('fails when the BOUND version is not approved, even though the live proxy row says approved', async () => {
    // Models a proxy that moved on to a newer, still-unapproved version
    // after this assignment was frozen against an older one — the exact
    // "stale binding" scenario FIBDB-039's immutable-per-run design exists
    // to catch.
    seedHappyData({ proxyVersion: { reviewStatus: 'pending_review' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('1 unapproved proxy(ies)');
    await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow(
      /Cannot calculate: 1 unapproved proxy\(ies\)/
    );
  });

  it('the double-assertion is preserved: BOTH the live proxy AND its bound version must independently read approved', async () => {
    // A stale proxy.reviewStatus with a freshly-approved version is exactly
    // as ineligible as the reverse — neither check alone is trusted.
    seedHappyData({ proxy: { reviewStatus: 'pending_review' }, proxyVersion: { reviewStatus: 'approved' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('1 unapproved proxy(ies)');
  });

  it('no longer blocks on mixed currencies — everything is normalized to USD', async () => {
    // Different source currencies, but both carry a frozen USD equivalent.
    seedHappyData({
      investment: { currency: 'COP', amountUsd: '1000' },
      proxy: { currency: 'EUR', valueUsd: '100' },
    });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(true);
    expect(readiness.currencyMismatch).toBe(false);
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.result!.currency).toBe('USD');
    expect(preview.result!.totalInvestment).toBe(1000);
    expect(preview.result!.sroiRatio).toBeCloseTo(1);
  });

  it('blocks when a contribution has no USD conversion', async () => {
    seedHappyData({ investment: { currency: 'COP', amountUsd: null } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons.some(r => r.includes('Falta conversión a USD'))).toBe(true);
  });

  // U3 (WS4) — remaining blocking classes, one test each.

  it('fails when an assignment has no quantity input', async () => {
    seedHappyData();
    mockDb.sroiAssignmentInputs = [];
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.missingInputs).toContain(ASSIGNMENT_ID);
    expect(readiness.blockingReasons).toContain('Missing inputs for 1 assignment(s)');
  });

  it('fails when an assignment has no SROI filter set', async () => {
    seedHappyData();
    mockDb.sroiFilterSets = [];
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.missingFilterSets).toContain(ASSIGNMENT_ID);
    expect(readiness.blockingReasons).toContain('Missing filter sets for 1 assignment(s)');
  });

  it('fails when an approved proxy has value <= 0', async () => {
    seedHappyData({ proxy: { value: '0', valueUsd: '0' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.invalidQuantities).toContain('proxy:proxy-1');
    expect(readiness.blockingReasons).toContain('Invalid quantities in 1 item(s)');
  });

  it('fails when an approved proxy has no USD conversion', async () => {
    seedHappyData({ proxy: { currency: 'EUR', valueUsd: null } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.proxiesMissingUsd).toContain('proxy-1');
    expect(readiness.blockingReasons.some(r => r.includes('Falta conversión a USD para 1 proxy(ies)'))).toBe(true);
  });

  it('fails when funder allocations for an outcome exceed 100%', async () => {
    seedHappyData();
    mockDb.outcomeFunderAllocations.push(
      { id: 'alloc-1', organizationId: ORG_ID, outcomeId: 'out-1', funderId: 'funder-1', allocationPct: '70', status: 'active' },
      { id: 'alloc-2', organizationId: ORG_ID, outcomeId: 'out-1', funderId: 'funder-2', allocationPct: '50', status: 'active' },
    );
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.overAllocatedOutcomes).toContain('out-1');
    expect(readiness.blockingReasons).toContain('1 resultado(s) con atribución de financiadores > 100%');
  });

  it('fails when a filter percentage is negative', async () => {
    seedHappyData({ filter: { attributionPct: '-5' } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Invalid filter values in 1 assignment(s)');
  });

  it('fails when duration exceeds the 50-year upper bound', async () => {
    seedHappyData({ filter: { durationYears: 51 } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.blockingReasons).toContain('Invalid filter values in 1 assignment(s)');
  });
});

describe('CL-2D (SROI-01) — calculation-time approval assertion', () => {
  it('approved proxy: calculation still succeeds normally', async () => {
    seedHappyData();
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.canCalculate).toBe(true);
    expect(preview.result!.lineItems).toHaveLength(1);
  });

  // One calculateSroiPreview() call reads financial_proxies THREE times:
  //   #1 inside getSroiCalculationReadiness's own internal loadCalculationData
  //      call (fetches investments/allocations only, enforceApproval=false);
  //   #2 getSroiCalculationReadiness's own dedicated proxiesRows query, which
  //      is the check that actually populates `unapprovedProxies`;
  //   #3 the DIRECT loadCalculationData(..., true) call made by
  //      calculateSroiPreview itself, once readiness has already passed.
  // This test simulates a concurrent revocation landing strictly AFTER
  // readiness finished (reads #1 and #2 still see 'approved', so readiness
  // reports canCalculate:true) but BEFORE the enforced load (#3) runs. Without
  // the CL-2D assert at that #3 boundary, the stale-but-cached proxy.valueUsd
  // would be silently consumed by the deterministic engine anyway.
  it('refuses the WHOLE calculation when the proxy loses approval between the readiness read and the enforced load read', async () => {
    const { proxy } = seedHappyData();

    let financialProxyReads = 0;
    const baseSelectImpl = (db.select as any).getMockImplementation();
    (db.select as any).mockImplementation((...args: any[]) => {
      const built = baseSelectImpl(...args);
      const originalFrom = built.from;
      built.from = (table: any) => {
        const result = originalFrom(table);
        if (table === financialProxies) {
          financialProxyReads += 1;
          if (financialProxyReads === 3) {
            // The THIRD financial_proxies read = the enforced load, made
            // AFTER readiness already passed. Simulate the row having been
            // revoked in the interim.
            const originalThen = result.then;
            result.then = (cb: any) =>
              originalThen((rows: any[]) =>
                cb(rows.map((r: any) => (r.id === proxy.id ? { ...r, reviewStatus: 'pending_review' } : r)))
              );
          }
        }
        return result;
      };
      return built;
    });

    try {
      await expect(calculateSroiPreview(PROJECT_ID)).rejects.toThrow(/not approved/i);
      expect(financialProxyReads).toBe(3);
    } finally {
      (db.select as any).mockImplementation(baseSelectImpl);
    }
  });

  it('never persists a run when the load-time approval assertion fails', async () => {
    const { proxy } = seedHappyData();
    let financialProxyReads = 0;
    const baseSelectImpl = (db.select as any).getMockImplementation();
    (db.select as any).mockImplementation((...args: any[]) => {
      const built = baseSelectImpl(...args);
      const originalFrom = built.from;
      built.from = (table: any) => {
        const result = originalFrom(table);
        if (table === financialProxies) {
          financialProxyReads += 1;
          if (financialProxyReads === 3) {
            const originalThen = result.then;
            result.then = (cb: any) =>
              originalThen((rows: any[]) =>
                cb(rows.map((r: any) => (r.id === proxy.id ? { ...r, reviewStatus: 'rejected' } : r)))
              );
          }
        }
        return result;
      };
      return built;
    });
    const insertSpy = vi.spyOn(db, 'insert');

    try {
      await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow(/not approved/i);
      expect(insertSpy).not.toHaveBeenCalled();
    } finally {
      (db.select as any).mockImplementation(baseSelectImpl);
    }
  });
});

describe('Skipped assignments are reported, never silently dropped (U3)', () => {
  const investment = [{ amountUsd: '1000', funderId: 'funder-1' }] as any;
  // R-B2-05 (AG-B2-1) — the engine reads monetary state from the BOUND
  // version only; the live proxy row carries a deliberately DIFFERENT figure
  // here so any fallback to it would change the pinned results.
  const goodLine = (id: string, outcomeId: string, quantity: string, valueUsd: string) => ({
    assignment: { id, outcomeId, proxyId: `proxy-${id}`, financialProxyVersionId: `version-${id}` },
    input: { quantity, unit: 'units' },
    filterSet: { deadweightPct: null, attributionPct: null, displacementPct: null, dropoffPct: null, durationYears: 1 },
    proxy: { id: `proxy-${id}`, valueUsd: '999999' },
    proxyVersion: { id: `version-${id}`, financialProxyId: `proxy-${id}`, reviewStatus: 'approved', valueUsd },
    outcome: { id: outcomeId },
  }) as any;

  it('reports a line skipped for non-positive quantity', () => {
    const result = runDeterministicCalc(
      investment,
      [goodLine('a1', 'out-1', '10', '100'), goodLine('a2', 'out-2', '0', '100')],
      [], [], null, { filterSemantics: 'preliminary' },
    );
    expect(result.lineItems).toHaveLength(1);
    expect(result.skippedAssignments).toEqual([
      { outcomeId: 'out-2', reason: 'non_positive_quantity' },
    ]);
    expect(result.netSocialValueExact).toBe('1000.0000');
  });

  it('reports a line skipped for non-positive proxy value', () => {
    const result = runDeterministicCalc(
      investment,
      [goodLine('a1', 'out-1', '10', '100'), goodLine('a2', 'out-2', '5', '0')],
      [], [], null, { filterSemantics: 'preliminary' },
    );
    expect(result.lineItems).toHaveLength(1);
    expect(result.skippedAssignments).toEqual([
      { outcomeId: 'out-2', reason: 'non_positive_proxy_value' },
    ]);
  });

  it('reports an empty list when nothing is skipped', () => {
    const result = runDeterministicCalc(investment, [goodLine('a1', 'out-1', '10', '100')], [], [], null, { filterSemantics: 'preliminary' });
    expect(result.skippedAssignments).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // W2-B2-R1 / R-B2-05 — AG-B2-1 VERSION_BOUND_MONETARY_RESOLUTION_REQUIRED
  // and HISTORICAL_PROJECTUSE_VERSION_STABILITY (NC-5). The bound version is
  // the SOLE monetary source; a NULL value_usd on an approved bound version
  // fails closed with a named error, never a zero substitution.
  // -------------------------------------------------------------------------
  it('AG-B2-1: the engine reads value_usd from the BOUND version, never from the live proxy row', () => {
    const line = goodLine('a1', 'out-1', '10', '100');
    line.proxy.valueUsd = '5'; // mutable live row disagrees
    const result = runDeterministicCalc(investment, [line], [], [], null, { filterSemantics: 'preliminary' });
    expect(result.netSocialValueExact).toBe('1000.0000');
  });

  it('AG-B2-1 FAIL CLOSED: an approved bound version with NULL value_usd aborts the run with a named error — no zero substitution, no skip', () => {
    const line = goodLine('a1', 'out-1', '10', '100');
    line.proxyVersion.valueUsd = null;
    line.proxy.valueUsd = '100'; // the live row would have "rescued" it — it must not
    expect(() => runDeterministicCalc(investment, [line], [], [], null, { filterSemantics: 'preliminary' })).toThrow(/carries no USD value — refusing to substitute zero/);
  });

  it('AG-B2-1 FAIL CLOSED: an assignment with no bound version aborts the run with a named error', () => {
    const line = goodLine('a1', 'out-1', '10', '100');
    line.proxyVersion = null;
    expect(() => runDeterministicCalc(investment, [line], [], [], null, { filterSemantics: 'preliminary' })).toThrow(/has no bound proxy version/);
  });

  it('NC-5: an assignment bound to approved V1 yields identical monetary output after V2 is created, after V2 is approved, and after the live row value_usd changes', async () => {
    // V1 approved with monetary state A (100), bound.
    seedHappyData({ proxy: { value: '100', valueUsd: '100' } });
    const before = await calculateSroiPreview(PROJECT_ID);
    expect(before.canCalculate).toBe(true);
    const nsvA = before.result!.netSocialValue;

    // Later material change opens V2 (under_review) with monetary state B.
    mockDb.financialProxyVersions.push({ id: 'proxy-version-2', financialProxyId: 'proxy-1', ordinal: 2, reviewStatus: 'under_review', supersedesVersionId: 'proxy-version-1', valueUsd: null });
    const afterV2 = await calculateSroiPreview(PROJECT_ID);
    expect(afterV2.result!.netSocialValue).toBe(nsvA);

    // V2 becomes current/approved with state B (250) and the live row follows.
    mockDb.financialProxyVersions[1].reviewStatus = 'approved';
    mockDb.financialProxyVersions[1].valueUsd = '250';
    mockDb.financialProxies[0].valueUsd = '250';
    mockDb.financialProxies[0].value = '250';
    const afterApproval = await calculateSroiPreview(PROJECT_ID);
    expect(afterApproval.result!.netSocialValue).toBe(nsvA);

    // Any authorised live-row monetary change (e.g. manual FX) still cannot touch it.
    mockDb.financialProxies[0].valueUsd = '9999';
    const afterLiveChange = await calculateSroiPreview(PROJECT_ID);
    expect(afterLiveChange.result!.netSocialValue).toBe(nsvA);
    expect(nsvA).toBe(1000);
  });

  it('readiness measures USD presence on the BOUND version, not the live row', async () => {
    seedHappyData({ proxy: { valueUsd: '100' }, proxyVersion: { valueUsd: null } });
    const readiness = await getSroiCalculationReadiness(PROJECT_ID);
    expect(readiness.canCalculate).toBe(false);
    expect(readiness.proxiesMissingUsd).toContain('proxy-1');
  });

  it('surfaces skippedAssignments through the preview result (additive field)', async () => {
    seedHappyData();
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.canCalculate).toBe(true);
    expect(preview.result!.skippedAssignments).toEqual([]);
  });

  it('persists skippedAssignments inside the run snapshot (additive key)', async () => {
    seedHappyData();
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    expect((run.snapshotJson as any).skippedAssignments).toEqual([]);
  });
});

describe('FIBIU-02 — run version identity triple', () => {
  it('every new run carries all three identities on the row and in the snapshot', async () => {
    seedHappyData();
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    expect(run.methodologyVersion).toBe('1.0.0');
    expect(run.calculationEngineVersion).toBe('1.0.0');
    expect(run.buildIdentity).toBe('test-build-identity');
    expect((run.snapshotJson as any).methodologyVersion).toBe('1.0.0');
    expect((run.snapshotJson as any).calculationEngineVersion).toBe('1.0.0');
    expect((run.snapshotJson as any).buildIdentity).toBe('test-build-identity');
  });

  it('rejects persisting a run when the governed model registry cannot resolve the identity (fail closed)', async () => {
    // The shared query-builder mock in this file does not filter by WHERE
    // predicate (see getTableData), so it cannot isolate "methodology row
    // missing" from "engine row missing" — that per-model granularity is
    // covered directly, with a real per-modelId mock, in
    // lib/pipeline/run-version-identity.test.ts. Here it is enough to prove
    // that an unresolvable registry blocks persistence end to end.
    seedHappyData();
    mockDb.governedModelRegistry = [];
    await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow(
      /Cannot persist a calculation run/
    );
    expect(mockDb.sroiCalculationRuns).toHaveLength(0);
  });

  it('rejects persisting a run when build_identity cannot be resolved (fail closed)', async () => {
    seedHappyData();
    vi.unstubAllEnvs();
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('BUILD_IDENTITY', '');
    await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow(
      /Cannot persist a calculation run/
    );
    expect(mockDb.sroiCalculationRuns).toHaveLength(0);
  });

  it('a legacy run (predating FIBIU-02) keeps a permanent NULL identity — it is never backfilled', async () => {
    const legacyRun = {
      id: 'legacy-run-1',
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      version: 1,
      methodologyVersion: null,
      calculationEngineVersion: null,
      buildIdentity: null,
      status: 'calculated',
    };
    mockDb.sroiCalculationRuns.push(legacyRun);
    const runs = await listSroiCalculationRuns(PROJECT_ID);
    const found = runs.find((r: any) => r.id === 'legacy-run-1');
    expect(found?.methodologyVersion).toBeNull();
    expect(found?.calculationEngineVersion).toBeNull();
    expect(found?.buildIdentity).toBeNull();
  });

  it('exposes no update function for a persisted run — the append-only trigger has no service-layer counterpart to bypass', async () => {
    const mod = await import('@/lib/pipeline/sroi-calculation');
    const updateLike = Object.keys(mod).filter((name) => /^update.*run/i.test(name));
    expect(updateLike).toEqual([]);
  });
});

describe('W1-05-RM1 R-6 (FIBIU-03) — investment/assignment-input lineage wiring', () => {
  it('upsertProjectInvestment versions the first (create) row', async () => {
    seedHappyData();
    mockDb.projectInvestments = []; // no existing investment — force the create branch
    await upsertProjectInvestment(PROJECT_ID, {
      amount: '500', currency: 'USD', funderId: '55555555-5555-4555-8555-555555555555',
    } as any);
    const created = mockDb.projectInvestments[0];
    expect(mockDb.domainObjectVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: 'project_investment', objectId: created.id, ordinal: 1 }),
      ])
    );
  });

  it('upsertProjectInvestment versions the row again on update — appends, never rewrites', async () => {
    const { investment } = seedHappyData();
    await upsertProjectInvestment(PROJECT_ID, {
      amount: '750', currency: 'USD', funderId: '55555555-5555-4555-8555-555555555555',
    } as any);
    const versionsForInvestment = mockDb.domainObjectVersions.filter(
      (v: any) => v.objectType === 'project_investment' && v.objectId === investment.id
    );
    expect(versionsForInvestment).toHaveLength(1);
    expect(versionsForInvestment[0].ordinal).toBe(1);
  });

  it('upsertSroiAssignmentInput versions the first (create) row', async () => {
    seedHappyData();
    mockDb.sroiAssignmentInputs = []; // force the create branch
    await upsertSroiAssignmentInput(PROJECT_ID, ASSIGNMENT_ID, { quantity: '20', unit: 'units' } as any);
    const created = mockDb.sroiAssignmentInputs[0];
    expect(mockDb.domainObjectVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: 'sroi_assignment_input', objectId: created.id, ordinal: 1 }),
      ])
    );
  });

  it('upsertSroiAssignmentInput versions the row again on update', async () => {
    const { input } = seedHappyData();
    await upsertSroiAssignmentInput(PROJECT_ID, ASSIGNMENT_ID, { quantity: '99', unit: 'units' } as any);
    const versionsForInput = mockDb.domainObjectVersions.filter(
      (v: any) => v.objectType === 'sroi_assignment_input' && v.objectId === input.id
    );
    expect(versionsForInput).toHaveLength(1);
  });
});

describe('W1-05-RM1 R-6 (FIBIU-03) — run input version fingerprint and drift', () => {
  it('a new run freezes the CURRENT version of every participating investment/outcome/assignment-input', async () => {
    const { investment, assignment, input } = seedHappyData();
    mockDb.domainObjectVersions.push(
      { id: 'v-inv-1', objectType: 'project_investment', objectId: investment.id, ordinal: 1, contentHash: 'h-inv-1' },
      { id: 'v-out-1', objectType: 'outcome', objectId: assignment.outcomeId, ordinal: 1, contentHash: 'h-out-1' },
      { id: 'v-input-1', objectType: 'sroi_assignment_input', objectId: input.id, ordinal: 1, contentHash: 'h-input-1' },
    );

    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    const inputVersions = (run.snapshotJson as any).inputVersions;

    expect(inputVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: 'project_investment', objectId: investment.id, versionId: 'v-inv-1', ordinal: 1 }),
        expect.objectContaining({ objectType: 'outcome', objectId: assignment.outcomeId, versionId: 'v-out-1', ordinal: 1 }),
        expect.objectContaining({ objectType: 'sroi_assignment_input', objectId: input.id, versionId: 'v-input-1', ordinal: 1 }),
      ])
    );
  });

  it('a legacy participating object with no version ever recorded fingerprints as versionId: null — never a fabricated v1', async () => {
    seedHappyData();
    // mockDb.domainObjectVersions stays empty — none of the three
    // participating objects has ever been versioned through FIBIU-03.
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    const inputVersions = (run.snapshotJson as any).inputVersions;
    expect(inputVersions.length).toBeGreaterThan(0);
    expect(inputVersions.every((v: any) => v.versionId === null)).toBe(true);
  });

  it('detects drift when a participating object gains a newer version after the run', async () => {
    const { investment, assignment, input } = seedHappyData();
    mockDb.domainObjectVersions.push(
      { id: 'v-inv-1', objectType: 'project_investment', objectId: investment.id, ordinal: 1, contentHash: 'h1' },
      { id: 'v-out-1', objectType: 'outcome', objectId: assignment.outcomeId, ordinal: 1, contentHash: 'h1' },
      { id: 'v-input-1', objectType: 'sroi_assignment_input', objectId: input.id, ordinal: 1, contentHash: 'h1' },
    );
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);

    // The investment gets a new version AFTER the run was calculated.
    mockDb.domainObjectVersions.push(
      { id: 'v-inv-2', objectType: 'project_investment', objectId: investment.id, ordinal: 2, contentHash: 'h2' }
    );

    const drift = await detectRunInputDrift(run);
    expect(drift.hasDrift).toBe(true);
    expect(drift.driftedObjects).toEqual([{ objectType: 'project_investment', objectId: investment.id }]);
  });

  it('reports no drift when nothing participating in the run has changed', async () => {
    const { investment, assignment, input } = seedHappyData();
    mockDb.domainObjectVersions.push(
      { id: 'v-inv-1', objectType: 'project_investment', objectId: investment.id, ordinal: 1, contentHash: 'h1' },
      { id: 'v-out-1', objectType: 'outcome', objectId: assignment.outcomeId, ordinal: 1, contentHash: 'h1' },
      { id: 'v-input-1', objectType: 'sroi_assignment_input', objectId: input.id, ordinal: 1, contentHash: 'h1' },
    );
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);

    const drift = await detectRunInputDrift(run);
    expect(drift.hasDrift).toBe(false);
    expect(drift.driftedObjects).toEqual([]);
  });

  it('a BRAND NEW object created after the run never causes drift by itself — it was never in the run\'s fingerprint', async () => {
    const { investment, assignment, input } = seedHappyData();
    mockDb.domainObjectVersions.push(
      { id: 'v-inv-1', objectType: 'project_investment', objectId: investment.id, ordinal: 1, contentHash: 'h1' },
      { id: 'v-out-1', objectType: 'outcome', objectId: assignment.outcomeId, ordinal: 1, contentHash: 'h1' },
      { id: 'v-input-1', objectType: 'sroi_assignment_input', objectId: input.id, ordinal: 1, contentHash: 'h1' },
    );
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);

    // A completely unrelated object versioned after the run — never part of
    // this run's fingerprint, so it must never register as drift.
    mockDb.domainObjectVersions.push(
      { id: 'v-new-1', objectType: 'outcome', objectId: 'out-never-part-of-this-run', ordinal: 1, contentHash: 'hx' }
    );

    const drift = await detectRunInputDrift(run);
    expect(drift.hasDrift).toBe(false);
  });

  it('a run predating this fingerprint (no inputVersions in its snapshot) reads as no drift — never fabricated', async () => {
    const legacyRun = { snapshotJson: { version: 1 } }; // no inputVersions key at all
    const drift = await detectRunInputDrift(legacyRun as any);
    expect(drift.hasDrift).toBe(false);
    expect(drift.driftedObjects).toEqual([]);
  });
});

describe('Per-funder breakdown (engine wiring)', () => {
  it('attributes net value to a funder via an active allocation', async () => {
    seedHappyData();
    mockDb.outcomeFunderAllocations.push({
      id: 'alloc-1', organizationId: ORG_ID, outcomeId: 'out-1', funderId: 'funder-1', allocationPct: '100', status: 'active',
    });
    const preview = await calculateSroiPreview(PROJECT_ID);
    const bd = preview.result!.fundersBreakdown;
    expect(bd).toHaveLength(1);
    expect(bd[0].funderId).toBe('funder-1');
    expect(bd[0].attributedNsvUsd).toBe('1000.0000');
    expect(bd[0].sroiRatio).toBe('1.000000'); // 1000 attributed / 1000 invested
    expect(preview.result!.unattributedNsvUsd).toBe('0.0000');
  });

  it('reports full net value as unattributed when there is no allocation', async () => {
    seedHappyData();
    const preview = await calculateSroiPreview(PROJECT_ID);
    // funder-1 invested but has no allocation → attributed 0, all unattributed.
    expect(preview.result!.fundersBreakdown[0].attributedNsvUsd).toBe('0.0000');
    expect(preview.result!.unattributedNsvUsd).toBe('1000.0000');
  });
});

describe('NPV / discount rate', () => {
  it('present-values a multi-year stream at the project discount rate', async () => {
    seedHappyData({ filter: { durationYears: 3, dropoffPct: '0' } });
    mockDb.projects.forEach((p) => { p.discountRatePct = '10'; });
    const preview = await calculateSroiPreview(PROJECT_ID);
    // 1000/1.1^0 + 1000/1.1^1 + 1000/1.1^2 = 2735.5372
    expect(preview.result!.netSocialValue).toBeCloseTo(2735.5372, 2);
    expect(preview.result!.sroiRatio).toBeCloseTo(2.7355, 3);
  });

  it('does not discount when the rate is null (zero regression)', async () => {
    seedHappyData({ filter: { durationYears: 3, dropoffPct: '0' } });
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.result!.netSocialValue).toBeCloseTo(3000);
    expect(preview.result!.sroiRatio).toBeCloseTo(3);
  });
});

// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — the uniform conservative/base/
// optimistic ±delta scenario band and calculateSroiScenarios are SUPERSEDED,
// not extended (NEG-18-1: absent from every lib/** and app/** path). This
// describe block tested that superseded function directly — it is removed as
// a mechanically forced consequence of the supersession, not a discretionary
// edit. The replacement's own controls live in
// tests/sensitivity-register.test.ts, tests/sensitivity-disposition.service.test.ts
// and tests/sensitivity-scenario.service.test.ts. The 46 readiness/
// blockingReasons fixtures below (SENT-APPROVAL-46) are untouched.

describe('Preview does not persist', () => {
  it('calculateSroiPreview returns result without inserting runs', async () => {
    const insertSpy = vi.spyOn(db, 'insert');
    seedHappyData();
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.canCalculate).toBe(true);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('Persist calculation run', () => {
  it('persists run with version increment and snapshot', async () => {
    const insertSpy = vi.spyOn(db, 'insert');
    seedHappyData();
    const result = await calculateAndPersistSroiRun(PROJECT_ID);
    expect(result.run).toBeDefined();
    expect(result.run.version).toBe(1);
    expect(result.run.snapshotJson).toBeDefined();
    expect(result.lineItems).toHaveLength(1);
    expect(insertSpy).toHaveBeenCalledTimes(2);
  });

  it('does not persist when readiness fails', async () => {
/* db imported */
    const insertSpy = vi.spyOn(db, 'insert');
    mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
    mockDb.projectInvestments.push({ id: 'inv-1', projectId: PROJECT_ID, organizationId: ORG_ID, amount: '1000', currency: 'USD' });
    await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('FIBIU-12 (FIBC-016) — monetization disposition and coverage', () => {
  describe('loadCalculationData itemizes assignments it cannot load (no silent drop)', () => {
    it("N-2: an assignment missing its input/filterSet/proxy/outcome is reported in loadSkipped, not dropped", async () => {
      const { proxy } = seedHappyData();
      // A second, deliberately incomplete assignment -- the readiness/load
      // TOCTOU race this simulates: readiness saw complete data a moment
      // ago, but by the time loadCalculationData actually reads it, the
      // filter set and outcome are both gone (e.g. concurrently archived).
      const incompleteAssignment = {
        id: 'assignment-incomplete',
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        outcomeId: 'out-missing',
        proxyId: proxy.id,
        financialProxyVersionId: null,
        assignmentStatus: 'active',
      };
      mockDb.outcomeProxyAssignments.push(incompleteAssignment);
      // Deliberately no matching sroiAssignmentInputs / sroiFilterSets row,
      // and 'out-missing' is not in mockDb.outcomes.

      const { loadSkipped, assignmentData } = await loadCalculationData(PROJECT_ID, ORG_ID);

      // The complete assignment still loads normally.
      expect(assignmentData).toHaveLength(1);
      // The incomplete one is itemized, once per missing piece, never silently dropped.
      expect(loadSkipped).toContainEqual({ outcomeId: 'out-missing', reason: 'missing_input' });
      expect(loadSkipped).toContainEqual({ outcomeId: 'out-missing', reason: 'missing_filter_set' });
      expect(loadSkipped).toContainEqual({ outcomeId: 'out-missing', reason: 'missing_outcome' });
      // proxy IS present here (same proxy as the happy assignment), so it must not be flagged missing.
      expect(loadSkipped.find((s: any) => s.reason === 'missing_proxy')).toBeUndefined();
    });

    it('a fully unresolvable assignment reports missing_proxy too', async () => {
      mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
      mockDb.outcomeProxyAssignments.push({
        id: 'assignment-orphan',
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        outcomeId: 'out-orphan',
        proxyId: 'proxy-does-not-exist',
        financialProxyVersionId: null,
        assignmentStatus: 'active',
      });
      const { loadSkipped, assignmentData } = await loadCalculationData(PROJECT_ID, ORG_ID);
      expect(assignmentData).toHaveLength(0);
      expect(loadSkipped).toContainEqual({ outcomeId: 'out-orphan', reason: 'missing_proxy' });
    });
  });

  describe('recordOutcomeMonetizationDisposition', () => {
    async function seedRun() {
      seedHappyData();
      const persisted = await calculateAndPersistSroiRun(PROJECT_ID);
      return persisted.run.id as string;
    }

    it('P-3: records a monetized disposition with no reason/justification required', async () => {
      const runId = await seedRun();
      const saved = await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'monetized' });
      expect(saved.disposition).toBe('monetized');
      expect(saved.reason).toBeNull();
    });

    it('P-3: records a not_monetized disposition with reason + justification, both persisted', async () => {
      const runId = await seedRun();
      // W2-B3 (AG-B3-2 consistency): not_monetized is only recordable for an
      // outcome the run did NOT monetize — out-2 has no line item in this run.
      mockDb.outcomes.push({ id: 'out-2', projectId: PROJECT_ID, organizationId: ORG_ID });
      const saved = await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, {
        disposition: 'not_monetized',
        reason: 'not_material',
        justification: 'Outcome classified not_material by the analyst.',
      });
      expect(saved.disposition).toBe('not_monetized');
      expect(saved.reason).toBe('not_material');
      expect(saved.justification).toBe('Outcome classified not_material by the analyst.');
    });

    it('rejects not_monetized with no reason', async () => {
      const runId = await seedRun();
      await expect(
        recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'not_monetized' } as any)
      ).rejects.toThrow();
    });

    it('rejects a reason with no justification', async () => {
      const runId = await seedRun();
      await expect(
        recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'not_monetized', reason: 'not_material' } as any)
      ).rejects.toThrow();
    });

    it('re-recording the same (outcome, run) updates the existing row rather than duplicating it', async () => {
      const runId = await seedRun();
      mockDb.outcomes.push({ id: 'out-2', projectId: PROJECT_ID, organizationId: ORG_ID });
      await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, {
        disposition: 'not_monetized',
        reason: 'proxy_not_approved',
        justification: 'Proxy still under review.',
      });
      await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, {
        disposition: 'not_monetized',
        reason: 'insufficient_evidence',
        justification: 'Evidence withdrawn after initial recording.',
      });
      expect(mockDb.outcomeMonetizationDispositions).toHaveLength(1);
      expect(mockDb.outcomeMonetizationDispositions[0].reason).toBe('insufficient_evidence');
    });

    it('M-2: refuses any write once the run has an approved review', async () => {
      const runId = await seedRun();
      mockDb.sroiRunReviews.push({ id: 'review-1', calculationRunId: runId, status: 'approved' });
      await expect(
        recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'monetized' })
      ).rejects.toThrow('already approved');
    });

    it('rejects when the outcome cannot be found for this project', async () => {
      const runId = await seedRun();
      // This suite's reflective db mock returns a table's full array regardless
      // of the where() clause content (only domain_object_versions gets real
      // filtering) -- emptying mockDb.outcomes after the run is already
      // persisted is how "no matching row" is reproduced under that mock.
      mockDb.outcomes = [];
      await expect(
        recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'monetized' })
      ).rejects.toThrow('Outcome not found for project');
    });
  });

  describe('getMonetizationCoverage (pure) — W2-B3 per-reason buckets', () => {
    it('P-COV-1 / N-COV-1 / M-COV-1: every outcome exactly once, each governed reason in its own bucket, missing disposition visible, hasDefensibleMonetization follows the engine', () => {
      const dispositions = [
        { outcomeId: 'out-monetized', disposition: 'monetized' as const, reason: null, justification: null },
        { outcomeId: 'out-ndp', disposition: 'not_monetized' as const, reason: 'no_defensible_proxy' as const, justification: 'j' },
        { outcomeId: 'out-pna', disposition: 'not_monetized' as const, reason: 'proxy_not_approved' as const, justification: 'j' },
        { outcomeId: 'out-ie', disposition: 'not_monetized' as const, reason: 'insufficient_evidence' as const, justification: 'j' },
        { outcomeId: 'out-nm', disposition: 'not_monetized' as const, reason: 'not_material' as const, justification: 'j' },
        { outcomeId: 'out-nye', disposition: 'not_monetized' as const, reason: 'not_yet_eligible' as const, justification: 'j' },
        { outcomeId: 'out-sv', disposition: 'not_monetized' as const, reason: 'superseded_version' as const, justification: 'j' },
        { outcomeId: 'out-other', disposition: 'not_monetized' as const, reason: 'other_governed_reason' as const, justification: 'j' },
      ];
      const materiality = new Map<string, string | null>([
        ['out-monetized', 'material'],
        ['out-ndp', 'material'],
        ['out-pna', null],
        ['out-nm', 'not_material'],
      ]);
      const coverage = getMonetizationCoverage(dispositions, materiality, ['out-monetized'], ['out-missing']);
      expect(coverage.outcomes).toHaveLength(9);
      expect(new Set(coverage.outcomes.map((o) => o.outcomeId)).size).toBe(9);
      expect(coverage.monetizedOutcomeIds).toEqual(['out-monetized']);
      // N-COV-1: seven distinct buckets, never a generic collapse.
      expect(coverage.notMonetizedByReason).toEqual({
        no_defensible_proxy: ['out-ndp'],
        proxy_not_approved: ['out-pna'],
        insufficient_evidence: ['out-ie'],
        not_material: ['out-nm'],
        not_yet_eligible: ['out-nye'],
        superseded_version: ['out-sv'],
        other_governed_reason: ['out-other'],
      });
      expect(coverage.outcomes.map((o) => o.bucket)).not.toContain('other_excluded');
      // N-COV-2: the outcome with no disposition is visible as missing.
      expect(coverage.missingDispositionOutcomeIds).toEqual(['out-missing']);
      expect(coverage.outcomes.find((o) => o.outcomeId === 'out-missing')?.bucket).toBe('missing_disposition');
      // Derived, visible views.
      expect(coverage.materialNotMonetizedOutcomeIds).toEqual(['out-ndp']);
      expect(coverage.unclassifiedOutcomeIds).toEqual(expect.arrayContaining(['out-pna', 'out-missing']));
      expect(coverage.hasDefensibleMonetization).toBe(true);
    });

    it('hasDefensibleMonetization is false when the run has no line items — a "monetized" disposition cannot fabricate it', () => {
      const coverage = getMonetizationCoverage(
        [{ outcomeId: 'out-1', disposition: 'monetized' as const, reason: null, justification: null }],
        new Map(),
        [],
      );
      expect(coverage.hasDefensibleMonetization).toBe(false);
      expect(coverage.monetizedOutcomeIds).toEqual(['out-1']);
      expect(coverage.outcomes[0].engineMonetized).toBe(false);
    });
  });
});

import { upsertProjectInvestmentAction } from '@/app/app/projects/[projectId]/pipeline/calculation/upsertProjectInvestment.action';
import { upsertSroiAssignmentInputAction } from '@/app/app/projects/[projectId]/pipeline/calculation/upsertSroiAssignmentInput.action';
import { upsertSroiFilterSetAction } from '@/app/app/projects/[projectId]/pipeline/calculation/upsertSroiFilterSet.action';
import { calculateSroiRunAction } from '@/app/app/projects/[projectId]/pipeline/calculation/calculateSroiRun.action';

describe('Action validation delegation', () => {
  it('upsertProjectInvestmentAction validates and delegates', async () => {
    seedHappyData();
    const formData = new FormData();
    formData.set('projectId', PROJECT_ID);
    formData.set('amount', '5000');
    formData.set('currency', 'USD');
    const result = await upsertProjectInvestmentAction(formData);
    expect(result.amount).toBe('5000');
  });

  it('upsertSroiAssignmentInputAction validates and delegates', async () => {
    seedHappyData();
    const formData = new FormData();
    formData.set('projectId', PROJECT_ID);
    formData.set('assignmentId', ASSIGNMENT_ID);
    formData.set('quantity', '20');
    formData.set('unit', 'units');
    const result = await upsertSroiAssignmentInputAction(formData);
    expect(result.quantity).toBe('20');
  });

  it('upsertSroiFilterSetAction validates and delegates', async () => {
    seedHappyData();
    const formData = new FormData();
    formData.set('projectId', PROJECT_ID);
    formData.set('assignmentId', ASSIGNMENT_ID);
    formData.set('deadweightPct', '10');
    const result = await upsertSroiFilterSetAction(formData);
    expect(result.deadweightPct).toBe('10');
  });

  it('upsertSroiFilterSetAction passes through the five discrete justification fields (FIBIU-13)', async () => {
    seedHappyData();
    const formData = new FormData();
    formData.set('projectId', PROJECT_ID);
    formData.set('assignmentId', ASSIGNMENT_ID);
    formData.set('deadweightPct', '10');
    formData.set('deadweightJustification', 'Benchmarked against a matched comparison group.');
    const result = await upsertSroiFilterSetAction(formData);
    expect(result.deadweightJustification).toBe('Benchmarked against a matched comparison group.');
  });

  it('calculateSroiRunAction delegates to persisting run', async () => {
/* db imported */
    const insertSpy = vi.spyOn(db, 'insert');
    seedHappyData();
    const formData = new FormData();
    formData.set('projectId', PROJECT_ID);
    const result = await calculateSroiRunAction(formData);
    expect(result.success).toBe(true);
    expect(result.runId).toBeDefined();
    expect(insertSpy).toHaveBeenCalled();
  });
});

// ── W2-B3 completeness (docs/ops/wave2/W2_B3_TEST_MANIFEST_v2.json) ──────────
// Service-layer controls: persisted materiality/no-ratio/filter semantics,
// SERVICE_ZERO_ROW_FAIL_CLOSED, disposition/engine consistency and coverage.

import { logAuditAction as mockedLogAuditAction } from '@/lib/audit/logger';
import { MONETIZATION_REASON_VALUES, getRunMonetizationCoverage, listOutcomeMonetizationDispositionsForRun } from '@/lib/pipeline/sroi-calculation';

describe('W2-B3 completeness — persisted semantics (AG-B3-1 / AG-B3-2 / AG-B3-4)', () => {
  it('P-RATIO-2: with a monetized line the run persists a numeric sroi_ratio and snapshot exactly as before', async () => {
    seedHappyData();
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    expect(run.sroiRatio).toBe('1.000000');
    const snapshot = run.snapshotJson as any;
    expect(snapshot.sroiRatio).toBe('1.000000');
    expect(snapshot.noRatioReason).toBeNull();
    expect(snapshot.monetizedOutcomeIds).toEqual(['out-1']);
  });

  it('N-MAT-2 / M-MAT-2: an unclassified outcome contributes but is itemized in the persisted snapshot (never silent)', async () => {
    seedHappyData();
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    const snapshot = run.snapshotJson as any;
    expect(snapshot.materialityUnclassifiedOutcomeIds).toEqual(['out-1']);
    expect(run.sroiRatio).toBe('1.000000');
  });

  it('N-MAT-3 / N-RATIO-1b: a not_material outcome is excluded from the persisted run, itemized with its reason, and — with nothing left to monetize — sroi_ratio persists NULL, never 0.000000', async () => {
    seedHappyData();
    mockDb.outcomes[0].materialityClassification = 'not_material';
    mockDb.outcomes[0].materialityClassificationJustification = 'Out of scope for this analysis.';
    const { run, lineItems } = await calculateAndPersistSroiRun(PROJECT_ID);
    expect(lineItems).toHaveLength(0);
    expect(run.sroiRatio).toBeNull();
    const snapshot = run.snapshotJson as any;
    expect(snapshot.sroiRatio).toBeNull();
    expect(snapshot.noRatioReason).toBe('NO_DEFENSIBLE_MONETIZATION');
    expect(snapshot.monetizedOutcomeIds).toEqual([]);
    expect(snapshot.skippedAssignments).toContainEqual({ outcomeId: 'out-1', reason: 'not_material' });
    expect(snapshot.fundersBreakdown).toEqual([]);
    // Results reporting still available: the run row exists with its totals.
    expect(run.totalInvestment).toBe('1000.0000');
    expect(run.netSocialValue).toBe('0.0000');
    expect(mockDb.sroiCalculationRuns).toHaveLength(1);
  });

  it('preview mirrors the no-ratio state (sroiRatio null, hasDefensibleMonetization false) instead of rendering 0', async () => {
    seedHappyData();
    mockDb.outcomes[0].materialityClassification = 'not_material';
    mockDb.outcomes[0].materialityClassificationJustification = 'j';
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.canCalculate).toBe(true);
    expect(preview.result!.sroiRatio).toBeNull();
    expect(preview.result!.noRatioReason).toBe('NO_DEFENSIBLE_MONETIZATION');
    expect(preview.result!.hasDefensibleMonetization).toBe(false);
    expect(preview.result!.skippedAssignments).toContainEqual({ outcomeId: 'out-1', reason: 'not_material' });
  });

  it('N-FILTER-2: calculateAndPersistSroiRun with a NULL governed filter throws FILTER_VALUE_UNKNOWN before any insert — no run row, no line items, no audit event', async () => {
    seedHappyData({ filter: { attributionPct: null } });
    vi.mocked(mockedLogAuditAction).mockClear();
    await expect(calculateAndPersistSroiRun(PROJECT_ID)).rejects.toThrow(/FILTER_VALUE_UNKNOWN: assignment .* has no attribution value/);
    expect(mockDb.sroiCalculationRuns).toHaveLength(0);
    expect(mockDb.sroiCalculationLineItems).toHaveLength(0);
    expect(vi.mocked(mockedLogAuditAction)).not.toHaveBeenCalled();
  });

  it('P-FILTER-2: the preview (labelled preliminary) coerces the same NULL filter AND itemizes the assumption', async () => {
    seedHappyData({ filter: { attributionPct: null } });
    const preview = await calculateSroiPreview(PROJECT_ID);
    expect(preview.canCalculate).toBe(true);
    expect(preview.result!.sroiRatio).toBe(1);
    expect(preview.result!.preliminaryFilterAssumptions).toEqual([
      { assignmentId: ASSIGNMENT_ID, outcomeId: 'out-1', filter: 'attribution', assumedValue: 0 },
    ]);
  });

  it('P-FILTER-1 (persisted): explicit 0 with justification persists exactly 0 — the same ratio the coercion path produced', async () => {
    seedHappyData({ filter: { deadweightPct: '0', deadweightJustification: 'No counterfactual effect expected.' } });
    const { run } = await calculateAndPersistSroiRun(PROJECT_ID);
    expect(run.sroiRatio).toBe('1.000000');
  });
});

describe('W2-B3 completeness — disposition/engine consistency, zero-row fail-closed and coverage', () => {
  async function seedRunWithSecondOutcome() {
    seedHappyData();
    mockDb.outcomes.push({ id: 'out-2', projectId: PROJECT_ID, organizationId: ORG_ID, materialityClassification: 'material' });
    const persisted = await calculateAndPersistSroiRun(PROJECT_ID);
    return persisted.run.id as string;
  }

  it('N-COV-3: recording "monetized" for an outcome the run did NOT monetize is refused (no fabricated coverage)', async () => {
    const runId = await seedRunWithSecondOutcome();
    await expect(
      recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, { disposition: 'monetized' })
    ).rejects.toThrow(/carries no line item for outcome out-2/);
    expect(mockDb.outcomeMonetizationDispositions).toHaveLength(0);
  });

  it('N-COV-3: recording "not_monetized" for an outcome the run DID monetize is refused (a new run is the only way to exclude it)', async () => {
    const runId = await seedRunWithSecondOutcome();
    await expect(
      recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'not_monetized', reason: 'insufficient_evidence', justification: 'j' })
    ).rejects.toThrow(/monetized outcome out-1 in its line items/);
  });

  it('P-COV-2 / P-SVC-1: monetized for a monetized outcome and not_monetized (reason + justification) for an excluded outcome are both recorded; the update path records the RETURNED row as afterJson', async () => {
    const runId = await seedRunWithSecondOutcome();
    const a = await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-1', runId, { disposition: 'monetized' });
    expect(a.disposition).toBe('monetized');
    const b = await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, { disposition: 'not_monetized', reason: 'proxy_not_approved', justification: 'Proxy still under review.' });
    expect(b.reason).toBe('proxy_not_approved');
    vi.mocked(mockedLogAuditAction).mockClear();
    const versionsBefore = mockDb.domainObjectVersions.length;
    const b2 = await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, { disposition: 'not_monetized', reason: 'insufficient_evidence', justification: 'Evidence withdrawn.' });
    expect(b2.reason).toBe('insufficient_evidence');
    expect(vi.mocked(mockedLogAuditAction)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mockedLogAuditAction).mock.calls[0][0] as any;
    expect(call.afterJson.reason).toBe('insufficient_evidence');
    expect(mockDb.domainObjectVersions.length).toBe(versionsBefore + 1);
  });

  it('N-SVC-1 / M-SVC-1: a zero-row UPDATE (RLS or the approved-run guard refused it) throws and records NO audit event and NO version row', async () => {
    const runId = await seedRunWithSecondOutcome();
    await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, { disposition: 'not_monetized', reason: 'proxy_not_approved', justification: 'j' });
    vi.mocked(mockedLogAuditAction).mockClear();
    const versionsBefore = mockDb.domainObjectVersions.length;
    const before = { ...mockDb.outcomeMonetizationDispositions[0] };
    // The database refused the write: UPDATE ... RETURNING yields no row.
    (db as any).update.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
    await expect(
      recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, { disposition: 'not_monetized', reason: 'insufficient_evidence', justification: 'j2' })
    ).rejects.toThrow(/affected no row/);
    expect(vi.mocked(mockedLogAuditAction)).not.toHaveBeenCalled();
    expect(mockDb.domainObjectVersions.length).toBe(versionsBefore);
    expect(mockDb.outcomeMonetizationDispositions[0]).toEqual(before);
  });

  it('P-COV-1 / N-COV-2: getRunMonetizationCoverage represents every outcome once — the monetized outcome with no disposition is visibly missing, never dropped', async () => {
    const runId = await seedRunWithSecondOutcome();
    await recordOutcomeMonetizationDisposition(PROJECT_ID, 'out-2', runId, { disposition: 'not_monetized', reason: 'no_defensible_proxy', justification: 'j' });
    const coverage = await getRunMonetizationCoverage(PROJECT_ID, runId);
    expect(coverage.hasDefensibleMonetization).toBe(true);
    expect(coverage.missingDispositionOutcomeIds).toEqual(['out-1']);
    expect(coverage.notMonetizedByReason.no_defensible_proxy).toEqual(['out-2']);
    expect(coverage.materialNotMonetizedOutcomeIds).toEqual(['out-2']);
    expect(coverage.outcomes.map((o) => [o.outcomeId, o.bucket, o.engineMonetized])).toEqual([
      ['out-1', 'missing_disposition', true],
      ['out-2', 'not_monetized:no_defensible_proxy', false],
    ]);
    const listed = await listOutcomeMonetizationDispositionsForRun(PROJECT_ID, runId);
    expect(listed).toHaveLength(1);
  });

  it('every governed reason is a distinct coverage bucket (N-COV-1) — the vocabulary is the seven frozen reasons', () => {
    expect([...MONETIZATION_REASON_VALUES]).toEqual([
      'no_defensible_proxy', 'proxy_not_approved', 'insufficient_evidence',
      'not_material', 'not_yet_eligible', 'superseded_version', 'other_governed_reason',
    ]);
  });
});
