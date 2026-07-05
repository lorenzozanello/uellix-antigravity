// tests/sroi-calculation.service.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '@/db/client';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';

// Mock authentication/session utilities
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
  getCurrentOrganizationContext: vi.fn(),
}));

// Mock permission checks
vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
}));

// Mock DB client with simple in‑memory structures
const mockDb = {
  projects: [] as any[],
  outcomes: [] as any[],
  projectInvestments: [] as any[],
  outcomeProxyAssignments: [] as any[],
  sroiAssignmentInputs: [] as any[],
  sroiFilterSets: [] as any[],
  financialProxies: [] as any[],
  sroiCalculationRuns: [] as any[],
  sroiCalculationLineItems: [] as any[],
  evidenceItems: [] as any[],
  funders: [] as any[],
  outcomeFunderAllocations: [] as any[],
};

function getTableData(table: any): any[] {
  const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
  if (!pgName) return [];
  const camelName = pgName.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase());
  return (mockDb as any)[camelName] ?? (mockDb as any)[pgName] ?? [];
}

vi.mock('@/db/client', () => {
  const dbMock: any = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table) => {
        const data = getTableData(table);
        const queryResult = {
          where: vi.fn().mockImplementation(() => queryResult),
          limit: vi.fn().mockImplementation(() => queryResult),
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
  calculateSroiScenarios,
} from '@/lib/pipeline/sroi-calculation';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mockDb, {
    projects: [{ id: PROJECT_ID, organizationId: ORG_ID }],
    outcomes: [],
    projectInvestments: [],
    outcomeProxyAssignments: [],
    sroiAssignmentInputs: [],
    sroiFilterSets: [],
    financialProxies: [],
    sroiCalculationRuns: [],
    sroiCalculationLineItems: [],
    evidenceItems: [],
    funders: [],
    outcomeFunderAllocations: [],
  });
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID },
    user: { id: USER_ID },
    membership: { role: 'analyst' },
  } as any);
  vi.mocked(hasRole).mockReturnValue(true);
});

function seedHappyData(overrides?: Partial<{ investment: any; proxy: any; assignment: any; input: any; filter: any }>) {
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
  const assignment = {
    id: ASSIGNMENT_ID,
    projectId: PROJECT_ID,
    organizationId: ORG_ID,
    outcomeId: 'out-1',
    proxyId: proxy.id,
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
  const filter = {
    id: 'filter-1',
    assignmentId: assignment.id,
    deadweightPct: null,
    attributionPct: null,
    displacementPct: null,
    dropoffPct: null,
    durationYears: 1,
    ...overrides?.filter,
  };
  mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
  mockDb.outcomes.push({ id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID });
  mockDb.funders.push({ id: 'funder-1', organizationId: ORG_ID, name: 'Fundación Test', funderType: 'foundation' });
  mockDb.projectInvestments.push(investment);
  mockDb.financialProxies.push(proxy);
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
  return { investment, proxy, assignment, input, filter };
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

describe('Sensitivity scenarios', () => {
  it('computes conservative < base < optimistic ratios (uniform ±delta shift)', async () => {
    seedHappyData({ filter: { deadweightPct: '20' } });
    const res = await calculateSroiScenarios(PROJECT_ID, 10);
    expect(res.canCalculate).toBe(true);
    const byName = Object.fromEntries(res.scenarios!.map((s) => [s.scenario, s.sroiRatio]));
    // ALL four filters shift uniformly by ±10pp (base others = 0):
    //   base:         (1-.20) = 0.80
    //   conservative: (1-.30)(1-.10)(1-.10) = 0.567
    //   optimistic:   (1-.10) = 0.90  (attribution/displacement/dropoff clamp at 0)
    expect(byName.conservative).toBeCloseTo(0.567);
    expect(byName.base).toBeCloseTo(0.8);
    expect(byName.optimistic).toBeCloseTo(0.9);
    expect(byName.conservative).toBeLessThan(byName.base);
    expect(byName.base).toBeLessThan(byName.optimistic);
  });

  it('returns canCalculate false (no scenarios) when readiness fails', async () => {
    // no data seeded → not ready
    mockDb.projects.push({ id: PROJECT_ID, organizationId: ORG_ID });
    const res = await calculateSroiScenarios(PROJECT_ID, 10);
    expect(res.canCalculate).toBe(false);
    expect(res.scenarios).toBeNull();
  });
});

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
