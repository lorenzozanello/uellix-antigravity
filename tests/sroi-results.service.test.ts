// tests/sroi-results.service.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';
import {
  getCalculationRunDetail,
  compareCalculationRuns,
  createSroiRunReview,
  updateSroiRunReview,
  upsertSroiRunReviewItem,
  listSroiRunReviews,
  createReportDraftFromRun,
  getReportDraft,
  updateReportSection,
  lockReportDraft,
  listProjectReports,
} from '@/lib/pipeline/sroi-results';

// Mock authentication/session utilities
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
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
  sroiCalculationRuns: [] as any[],
  sroiCalculationLineItems: [] as any[],
  sroiRunReviews: [] as any[],
  sroiRunReviewItems: [] as any[],
  sroiReports: [] as any[],
  sroiReportSections: [] as any[],
};

function getTableData(table: any): any[] {
  const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
  if (!pgName) return [];
  const camelName = pgName.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase());
  return (mockDb as any)[camelName] ?? (mockDb as any)[pgName] ?? [];
}

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

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table) => {
        let data = [...getTableData(table)];
        const queryResult = {
          where: vi.fn().mockImplementation((cond) => {
            if (cond) {
              const eqValues = extractEqValues(cond);
              if (eqValues.length > 0) {
                const matchedById = data.filter(item => item.id !== undefined && eqValues.includes(String(item.id)));
                if (matchedById.length > 0) {
                  data = matchedById;
                } else {
                  data = data.filter(item => {
                    return Object.keys(item).some(key => eqValues.includes(String(item[key])));
                  });
                }
              }
            }
            return queryResult;
          }),
          orderBy: vi.fn().mockImplementation(() => queryResult),
          then: (cb: any) => Promise.resolve(cb(data)),
        };
        return queryResult;
      }),
    })),
    insert: vi.fn().mockImplementation((table) => ({
      values: vi.fn().mockImplementation((vals) => {
        const execute = () => {
          const valsArray = Array.isArray(vals) ? vals : [vals];
          const insertedArray = valsArray.map(v => ({ ...v, id: crypto.randomUUID() }));
          const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
          const camelName = pgName?.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase());
          const targetArray = (mockDb as any)[camelName] ?? (mockDb as any)[pgName];
          if (targetArray) {
            targetArray.push(...insertedArray);
          }
          return insertedArray;
        };

        const resultObj = {
          returning: vi.fn().mockImplementation(() => {
            return Promise.resolve(execute());
          }),
          then: (resolve: any) => {
            return Promise.resolve(execute()).then(resolve);
          }
        };
        return resultObj;
      }),
    })),
    update: vi.fn().mockImplementation((table) => ({
      set: vi.fn().mockImplementation((values) => ({
        where: vi.fn().mockImplementation((cond) => {
          const data = getTableData(table);
          const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')];
          let matched = data;
          // sroi_report_sections needs precise (id AND reportId) matching to
          // exercise the SEC-004 cross-report regression test below; every
          // other table keeps the original permissive "just use data[0]"
          // behavior other tests already rely on.
          if (pgName === 'sroi_report_sections' && cond) {
            // extractEqValues also picks up raw SQL syntax fragments
            // (e.g. "(", " = ", " and ") mixed in with real values from
            // queryChunks — keep only tokens that look like real ids/values.
            const SQL_NOISE = new Set(['and', 'or', 'not', 'select', 'from', 'where']);
            const eqValues = extractEqValues(cond).filter(
              (v) => /^[\w-]+$/.test(v.trim()) && !SQL_NOISE.has(v.trim().toLowerCase())
            );
            if (eqValues.length > 0) {
              matched = data.filter(item =>
                eqValues.every((v) => Object.values(item).some((val) => String(val) === v))
              );
            }
          } else {
            matched = data.length > 0 ? [data[0]] : [];
          }
          matched.forEach((item) => Object.assign(item, values));
          return { returning: vi.fn().mockImplementation(() => Promise.resolve(matched)) };
        }),
      })),
    })),
  },
}));

const PROJECT_ID = 'proj-1111';
const ORG_ID = 'org-2222';
const USER_ID = 'user-3333';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mockDb, {
    projects: [{ id: PROJECT_ID, organizationId: ORG_ID }],
    sroiCalculationRuns: [],
    sroiCalculationLineItems: [],
    sroiRunReviews: [],
    sroiRunReviewItems: [],
    sroiReports: [],
    sroiReportSections: [],
  });
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID },
    user: { id: USER_ID },
    membership: { role: 'analyst' },
  } as any);
  vi.mocked(hasRole).mockReturnValue(true);
});

describe('getCalculationRunDetail', () => {
  it('returns run, line items and snapshot', async () => {
    const run = { id: 'run-1', projectId: PROJECT_ID, organizationId: ORG_ID, snapshotJson: { foo: 'bar' } };
    const line = { id: 'line-1', runId: 'run-1', some: 'data' };
    mockDb.sroiCalculationRuns.push(run);
    mockDb.sroiCalculationLineItems.push(line);
    const result = await getCalculationRunDetail(PROJECT_ID, 'run-1');
    expect(result.run).toBe(run);
    expect(result.lineItems).toContain(line);
    expect(result.snapshotJson).toEqual({ foo: 'bar' });
    expect(result.projectContext).toEqual({ id: PROJECT_ID, organizationId: ORG_ID });
  });
  it('throws if run not found or not owned', async () => {
    await expect(getCalculationRunDetail(PROJECT_ID, 'missing')).rejects.toThrow('Calculation run not found');
  });
});

describe('compareCalculationRuns', () => {
  it('computes diff and warns on currency mismatch', async () => {
    const runA = { id: 'a', projectId: PROJECT_ID, organizationId: ORG_ID, totalInvestment: '100', grossSocialValue: '200', netSocialValue: '150', sroiRatio: '1.5', version: 1, currency: 'USD' };
    const runB = { id: 'b', projectId: PROJECT_ID, organizationId: ORG_ID, totalInvestment: '50', grossSocialValue: '80', netSocialValue: '70', sroiRatio: '0.9', version: 1, currency: 'EUR' };
    mockDb.sroiCalculationRuns.push(runA, runB);
    const diff = await compareCalculationRuns(PROJECT_ID, 'a', 'b');
    expect(diff.totalInvestment).toBe(50);
    expect(diff.grossSocialValue).toBe(120);
    expect(diff.currency).toBe('USD');
    expect(diff.warning).toEqual({ currencyMismatch: true, message: 'Different currencies – no FX conversion' });
  });
});

describe('review services', () => {
  it('allows reviewer role to create review', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'reviewer' } } as any);
    const run = { id: 'run-1', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiCalculationRuns.push(run);
    const input = { status: 'draft', readinessScore: 80 } as any;
    const rev = await createSroiRunReview(PROJECT_ID, 'run-1', input);
    expect(rev.projectId).toBe(PROJECT_ID);
    expect(rev.id).toBeDefined();
    expect(vi.mocked(logAuditAction)).toHaveBeenCalled();
  });
  it('rejects analyst from creating review', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' } } as any);
    const run = { id: 'run-1', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiCalculationRuns.push(run);
    const input = { status: 'draft' } as any;
    await expect(createSroiRunReview(PROJECT_ID, 'run-1', input)).rejects.toThrow('Insufficient role');
  });
  it('updates review and rejects if archived', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'reviewer' } } as any);
    const rev = { id: 'rev-1', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft' };
    mockDb.sroiRunReviews.push(rev);
    const updated = await updateSroiRunReview(PROJECT_ID, 'rev-1', { status: 'reviewed', readinessScore: 90 });
    expect(updated.status).toBe('reviewed');

    // Archive it and try to update
    updated.status = 'archived';
    await expect(updateSroiRunReview(PROJECT_ID, 'rev-1', { status: 'approved' })).rejects.toThrow('Cannot modify archived review');
  });
  it('upserts review item (create then update)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'reviewer' } } as any);
    const rev = { id: 'rev-1', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiRunReviews.push(rev);
    const itemInput = { itemKey: 'key1', status: 'pass', severity: 'low' } as any;
    const created = await upsertSroiRunReviewItem(PROJECT_ID, rev.id, itemInput);
    expect(created.itemKey).toBe('key1');
    const updated = await upsertSroiRunReviewItem(PROJECT_ID, rev.id, { ...itemInput, status: 'fail' } as any);
    expect(updated.status).toBe('fail');
  });
  it('lists reviews with nested items', async () => {
    const rev = { id: 'rev-1', projectId: PROJECT_ID, calculationRunId: 'run-1', organizationId: ORG_ID };
    const item = { id: 'item-1', reviewId: 'rev-1', itemKey: 'key1', status: 'pass' };
    mockDb.sroiRunReviews.push(rev);
    mockDb.sroiRunReviewItems.push(item);
    const list = await listSroiRunReviews(PROJECT_ID, 'run-1');
    expect(list).toHaveLength(1);
    expect(list[0].items).toHaveLength(1);
    expect(list[0].items[0].id).toBe('item-1');
  });
});

describe('report foundation', () => {
  it('analyst can create draft and receives 12 sections', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' } } as any);
    const run = { id: 'run-1', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiCalculationRuns.push(run);
    const draft = await createReportDraftFromRun(PROJECT_ID, 'run-1', { title: 'My Report' });
    expect(draft.title).toBe('My Report');
    const fetched = await getReportDraft(PROJECT_ID, draft.id);
    expect(fetched.sections).toHaveLength(12);
  });
  it('updates report section if not locked', async () => {
    const report = { id: 'rep-1', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft' };
    const section = { id: 'sec-1', reportId: 'rep-1', title: 'Old Title', content: 'Old content' };
    mockDb.sroiReports.push(report);
    mockDb.sroiReportSections.push(section);

    const updated = await updateReportSection(PROJECT_ID, 'rep-1', 'sec-1', { title: 'New Title', content: 'New content' });
    expect(updated.title).toBe('New Title');

    // lock report and try updating section
    report.status = 'locked';
    await expect(updateReportSection(PROJECT_ID, 'rep-1', 'sec-1', { title: 'No' })).rejects.toThrow('Report is locked');
  });
  it('rejects updating a section that belongs to a different report (SEC-004 regression)', async () => {
    const report = { id: 'rep-1', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft' };
    const otherReportSection = { id: 'sec-OTHER', reportId: 'rep-OTHER', title: 'Not yours', content: 'Not yours' };
    mockDb.sroiReports.push(report);
    mockDb.sroiReportSections.push(otherReportSection);

    await expect(
      updateReportSection(PROJECT_ID, 'rep-1', 'sec-OTHER', { title: 'Hijacked' })
    ).rejects.toThrow('Report section not found for this report');
    expect(otherReportSection.title).toBe('Not yours');
  });
  it('lockReportDraft restricts to manager role', async () => {
    const report = { id: 'rep-1', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: 'run-1', status: 'draft' };
    mockDb.sroiReports.push(report);
    // Human-review gate: an approved methodological review must exist for the run.
    mockDb.sroiRunReviews.push({ id: 'rev-lock', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: 'run-1', status: 'approved' });
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' } } as any);
    await expect(lockReportDraft(PROJECT_ID, report.id)).rejects.toThrow('Insufficient role');
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);
    const locked = await lockReportDraft(PROJECT_ID, report.id);
    expect(locked.status).toBe('locked');
    expect(locked.lockedBy).toBe(USER_ID);
  });
  it('lockReportDraft is blocked without an approved methodological review', async () => {
    const report = { id: 'rep-noreview', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: 'run-2', status: 'draft' };
    mockDb.sroiReports.push(report);
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);
    await expect(lockReportDraft(PROJECT_ID, report.id)).rejects.toThrow('no approved methodological review');
  });
  it('lists project reports', async () => {
    const report = { id: 'rep-1', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiReports.push(report);
    const reports = await listProjectReports(PROJECT_ID);
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('rep-1');
  });
});
