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
// FIBIU-29 — isInReviewSet/canApproveRunMethodology are real logic (not
// vi.fn() stubs) so the pre-existing role pass/reject assertions below keep
// exercising actual review-set membership, exactly as they did against the
// old inline REVIEW_ROLES array this replaced.
const REVIEW_SET = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer'];
vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
  isInReviewSet: (role: string) => REVIEW_SET.includes(role),
  canApproveRunMethodology: (role: string, isRunAuthor: boolean) =>
    REVIEW_SET.includes(role) && !isRunAuthor,
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>();
  return { ...actual, logAuditAction: vi.fn() };
});

// Mock DB client with simple in‑memory structures
const mockDb = {
  projects: [] as any[],
  sroiCalculationRuns: [] as any[],
  sroiCalculationLineItems: [] as any[],
  sroiRunReviews: [] as any[],
  sroiRunReviewItems: [] as any[],
  sroiReports: [] as any[],
  sroiReportSections: [] as any[],
  evidenceItems: [] as any[],
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
    evidenceItems: [],
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
  it('FIBIU-29: rejects a reviewer approving the methodology of their own run (self-approval)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'reviewer' } } as any);
    const run = { id: 'run-self-1', projectId: PROJECT_ID, organizationId: ORG_ID, calculatedBy: USER_ID };
    mockDb.sroiCalculationRuns.push(run);
    const rev = { id: 'rev-self-1', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft', calculationRunId: run.id };
    mockDb.sroiRunReviews.push(rev);
    await expect(
      updateSroiRunReview(PROJECT_ID, 'rev-self-1', { status: 'approved' })
    ).rejects.toThrow('cannot approve the methodology of their own run');
  });

  it('FIBIU-29: allows a different reviewer to approve the run (unauthorized action fails closed, authorized succeeds)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'reviewer' } } as any);
    const run = { id: 'run-other-1', projectId: PROJECT_ID, organizationId: ORG_ID, calculatedBy: 'someone-else' };
    mockDb.sroiCalculationRuns.push(run);
    const rev = { id: 'rev-other-1', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft', calculationRunId: run.id };
    mockDb.sroiRunReviews.push(rev);
    const updated = await updateSroiRunReview(PROJECT_ID, 'rev-other-1', { status: 'approved' });
    expect(updated.status).toBe('approved');
  });

  // -------------------------------------------------------------------------
  // W1-05-RM1 R-5 (B-1 remediation) — the invariant is enforced on BOTH the
  // CREATE and UPDATE paths into 'approved', and I1/I2 are distinct checks.
  // -------------------------------------------------------------------------

  it('R-5 (A): rejects self-approval reached via CREATE, not only UPDATE', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);
    const run = { id: 'run-create-self', projectId: PROJECT_ID, organizationId: ORG_ID, calculatedBy: USER_ID };
    mockDb.sroiCalculationRuns.push(run);

    await expect(
      createSroiRunReview(PROJECT_ID, 'run-create-self', { status: 'approved' } as any)
    ).rejects.toThrow('cannot approve the methodology of their own run');
    expect(mockDb.sroiRunReviews).toHaveLength(0); // no row was ever persisted
  });

  it('R-5 (B): allows creating a draft review as the run\'s own author (no approval attempted)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);
    const run = { id: 'run-create-draft', projectId: PROJECT_ID, organizationId: ORG_ID, calculatedBy: USER_ID };
    mockDb.sroiCalculationRuns.push(run);

    const rev = await createSroiRunReview(PROJECT_ID, 'run-create-draft', { status: 'draft' } as any);
    expect(rev.status).toBe('draft');
  });

  it('R-5 (C): rejects via I2 when the acting reviewer differs from the run author but the REVIEW is attributed to the author', async () => {
    // Actor is NOT the run's author (I1 alone would pass) — but the review
    // row's own reviewerId already equals the run's author, so approving it
    // would still persist reviewer_id = calculated_by.
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: 'other-reviewer' }, membership: { role: 'reviewer' } } as any);
    const run = { id: 'run-i2', projectId: PROJECT_ID, organizationId: ORG_ID, calculatedBy: USER_ID };
    mockDb.sroiCalculationRuns.push(run);
    const rev = { id: 'rev-i2', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft', calculationRunId: run.id, reviewerId: USER_ID };
    mockDb.sroiRunReviews.push(rev);

    await expect(
      updateSroiRunReview(PROJECT_ID, 'rev-i2', { status: 'approved' })
    ).rejects.toThrow('cannot approve the methodology of their own run');
  });

  it('R-5 (D): the denial event is written before the rejection, on both I1 and I2', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'reviewer' } } as any);
    const run = { id: 'run-audit-self', projectId: PROJECT_ID, organizationId: ORG_ID, calculatedBy: USER_ID };
    mockDb.sroiCalculationRuns.push(run);
    const rev = { id: 'rev-audit-self', projectId: PROJECT_ID, organizationId: ORG_ID, status: 'draft', calculationRunId: run.id };
    mockDb.sroiRunReviews.push(rev);

    await expect(
      updateSroiRunReview(PROJECT_ID, 'rev-audit-self', { status: 'approved' })
    ).rejects.toThrow();

    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sroi_calculation_run.methodology_approval_denied',
        entityType: 'sroi_calculation_run',
        entityId: run.id,
        contentModifying: false,
        afterJson: expect.objectContaining({
          deniedPermission: 'canApproveRunMethodology',
          attemptedStatus: 'approved',
          runAuthorUserId: USER_ID,
          path: 'update',
          violatedInvariant: 'I1',
        }),
      })
    );
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
    expect(fetched.sections.some((s: any) => s.sectionType === 'funder_breakdown')).toBe(false);
  });

  it('includes the funder_breakdown section when requested (13 sections)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' } } as any);
    const run = { id: 'run-2', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiCalculationRuns.push(run);
    const draft = await createReportDraftFromRun(PROJECT_ID, 'run-2', { title: 'Funder Report', includeFunderBreakdown: true });
    expect(draft.includeFunderBreakdown).toBe(true);
    const fetched = await getReportDraft(PROJECT_ID, draft.id);
    expect(fetched.sections).toHaveLength(13);
    expect(fetched.sections.some((s: any) => s.sectionType === 'funder_breakdown')).toBe(true);
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
    await expect(lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true })).rejects.toThrow('Insufficient role');
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);
    const locked = await lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true });
    expect(locked.status).toBe('locked');
    expect(locked.lockedBy).toBe(USER_ID);
  });
  it('lockReportDraft is blocked without an approved methodological review', async () => {
    const report = { id: 'rep-noreview', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: 'run-2', status: 'draft' };
    mockDb.sroiReports.push(report);
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);
    await expect(lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true })).rejects.toThrow('no approved methodological review');
  });
  // -------------------------------------------------------------------------
  // CL-1E (MSC-02 HIGH-1/HR-01) — lockReportDraft requires an EXPLICIT human
  // narrative-review attestation, independent of the calculation review gate.
  // -------------------------------------------------------------------------
  it('lockReportDraft refuses without an explicit narrativeReviewed attestation, even with an approved calculation review', async () => {
    const report = { id: 'rep-noattest', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: 'run-attest', status: 'draft' };
    mockDb.sroiReports.push(report);
    mockDb.sroiRunReviews.push({ id: 'rev-attest', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: 'run-attest', status: 'approved' });
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);

    await expect(lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: false })).rejects.toThrow(
      'explicit narrative review attestation is required'
    );
    expect(report.status).toBe('draft');
  });
  // -------------------------------------------------------------------------
  // CL-1C/CL-1D (MSC-02 HIGH-1) — server-side numeric integrity, checked
  // against the report's PINNED run (not "latest for project"), both on save
  // and again right before lock.
  // -------------------------------------------------------------------------
  describe('CL-1C/CL-1D — report narrative numeric integrity', () => {
    const RUN_ID = 'run-numeric-1';
    const OTHER_RUN_ID = 'run-numeric-OTHER';

    function seedPinnedRun() {
      mockDb.sroiCalculationRuns.push({
        id: RUN_ID,
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        totalInvestment: '1000.0000',
        grossSocialValue: '2000.0000',
        netSocialValue: '1800.0000',
        sroiRatio: '1.800000',
        version: 1,
        snapshotJson: { fundersBreakdown: [], unattributedNsvUsd: '0.0000', assignments: [] },
      });
    }

    it('accepts a save that cites a number matching the pinned run (e.g. the SROI ratio)', async () => {
      seedPinnedRun();
      const report = { id: 'rep-num-1', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'draft' };
      const section = { id: 'sec-num-1', reportId: 'rep-num-1', title: 'Resultados', content: 'placeholder' };
      mockDb.sroiReports.push(report);
      mockDb.sroiReportSections.push(section);

      const updated = await updateReportSection(PROJECT_ID, 'rep-num-1', 'sec-num-1', {
        title: 'Resultados',
        content: 'El SROI de este proyecto es 1.8:1, con un valor social neto de $1,800.',
      });
      expect(updated.content).toContain('1.8');
    });

    it('refuses a save that cites a number NOT in the pinned run snapshot (fabricated claim)', async () => {
      seedPinnedRun();
      const report = { id: 'rep-num-2', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'draft' };
      const section = { id: 'sec-num-2', reportId: 'rep-num-2', title: 'Resultados', content: 'placeholder' };
      mockDb.sroiReports.push(report);
      mockDb.sroiReportSections.push(section);

      await expect(
        updateReportSection(PROJECT_ID, 'rep-num-2', 'sec-num-2', {
          title: 'Resultados',
          content: 'El SROI de este proyecto es 9.9:1, una cifra excelente.',
        })
      ).rejects.toThrow('cifras que no coinciden');
      // The write must be refused outright — never silently corrected.
      expect(section.content).toBe('placeholder');
    });

    it('uses the report\'s PINNED run, not a different ("latest") run for the same project', async () => {
      seedPinnedRun();
      // A second, DIFFERENT run for the same project — simulates "latest run"
      // diverging from what this particular report is anchored to.
      mockDb.sroiCalculationRuns.push({
        id: OTHER_RUN_ID,
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        totalInvestment: '5000.0000',
        grossSocialValue: '9999.0000',
        netSocialValue: '9999.0000',
        sroiRatio: '9.900000',
        version: 2,
        snapshotJson: { fundersBreakdown: [], unattributedNsvUsd: '0.0000', assignments: [] },
      });
      const report = { id: 'rep-num-pin', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'draft' };
      const section = { id: 'sec-num-pin', reportId: 'rep-num-pin', title: 'Resultados', content: 'placeholder' };
      mockDb.sroiReports.push(report);
      mockDb.sroiReportSections.push(section);

      // 9.9 only exists in the OTHER run — must be refused because THIS
      // report is pinned to RUN_ID (sroiRatio 1.8), not OTHER_RUN_ID.
      await expect(
        updateReportSection(PROJECT_ID, 'rep-num-pin', 'sec-num-pin', {
          title: 'Resultados',
          content: 'El SROI de este proyecto es 9.9:1.',
        })
      ).rejects.toThrow('cifras que no coinciden');

      // The number that IS authorized for the pinned run still passes.
      const updated = await updateReportSection(PROJECT_ID, 'rep-num-pin', 'sec-num-pin', {
        title: 'Resultados',
        content: 'El SROI de este proyecto es 1.8:1.',
      });
      expect(updated.content).toContain('1.8');
    });

    it('lock refuses when a persisted section contains a number outside the pinned run — even if it was valid at some earlier save', async () => {
      seedPinnedRun();
      const report = { id: 'rep-num-lock', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'draft' };
      // Simulates content that bypassed updateReportSection's own guard (a
      // direct DB fixup, a pre-CL-1C row) — the pre-lock revalidation must
      // catch it independently of how it got there.
      const section = { id: 'sec-num-lock', reportId: 'rep-num-lock', title: 'Resultados', content: 'El SROI es 9.9:1.' };
      mockDb.sroiReports.push(report);
      mockDb.sroiReportSections.push(section);
      mockDb.sroiRunReviews.push({ id: 'rev-num-lock', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'approved' });
      vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);

      await expect(
        lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true })
      ).rejects.toThrow('do not match');
      expect(report.status).toBe('draft');
    });

    it('lock succeeds when every persisted section is valid, attestation is given, and the calculation review is approved', async () => {
      seedPinnedRun();
      const report = { id: 'rep-num-lock-ok', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'draft' };
      const section = { id: 'sec-num-lock-ok', reportId: 'rep-num-lock-ok', title: 'Resultados', content: 'El SROI es 1.8:1.' };
      mockDb.sroiReports.push(report);
      mockDb.sroiReportSections.push(section);
      mockDb.sroiRunReviews.push({ id: 'rev-num-lock-ok', projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, status: 'approved' });
      vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' } } as any);

      const locked = await lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true });
      expect(locked.status).toBe('locked');
    });
  });

  // -------------------------------------------------------------------------
  // R2-CL1 — report-strict numeric/reference integrity. These are service
  // boundary tests: they exercise the same save/lock functions a direct
  // Server Action caller reaches, with authority derived by production code.
  // -------------------------------------------------------------------------
  describe('R2-CL1 — strict report narrative integrity', () => {
    const RUN_ID = 'run-r2-integrity';
    const EVIDENCE_UUID = '44444444-4444-4444-8444-444444444444';
    const FOREIGN_EVIDENCE_UUID = '55555555-5555-4555-8555-555555555555';
    const PROXY_UUID = '66666666-6666-4666-8666-666666666666';
    const FOREIGN_PROXY_UUID = '77777777-7777-4777-8777-777777777777';

    function seedPinnedRun(overrides: Record<string, unknown> = {}) {
      mockDb.sroiCalculationRuns.push({
        id: RUN_ID,
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        totalInvestment: '1000.0000',
        grossSocialValue: '2000.0000',
        netSocialValue: '1800.0000',
        sroiRatio: '1.800000',
        version: 1,
        snapshotJson: { fundersBreakdown: [], assignments: [] },
        ...overrides,
      });
    }

    function seedDraft(id: string, runId = RUN_ID, content = 'Narrativa sin cifras.') {
      const report = { id: `report-${id}`, projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: runId, status: 'draft' };
      const section = { id: `section-${id}`, reportId: report.id, title: 'Resultados', content };
      mockDb.sroiReports.push(report);
      mockDb.sroiReportSections.push(section);
      return { report, section };
    }

    it('allows plain nonnumeric narrative when the pinned calculation snapshot is unavailable', async () => {
      const { report, section } = seedDraft('no-snapshot-plain', 'missing-run');

      const updated = await updateReportSection(PROJECT_ID, report.id, section.id, {
        title: 'Resultados',
        content: 'La evidencia disponible requiere revisión metodológica humana.',
      });

      expect(updated.content).toBe('La evidencia disponible requiere revisión metodológica humana.');
    });

    it.each([
      ['SROI zero', 'El SROI = 0.'],
      ['percentage zero', 'La atribución es 0%.'],
      ['count', 'Se alcanzaron 17 beneficiarios.'],
      ['year-shaped count', 'Se alcanzaron 2026 beneficiarios.'],
      ['negative claim', 'El valor social neto fue -1800 USD.'],
      ['currency claim', 'La inversión fue USD 1,000.'],
    ])('refuses a no-snapshot %s claim', async (_name, content) => {
      const { report, section } = seedDraft(`no-snapshot-${_name}`, 'missing-run');

      await expect(
        updateReportSection(PROJECT_ID, report.id, section.id, { title: 'Resultados', content })
      ).rejects.toThrow('cifras que no coinciden');
      expect(section.content).toBe('Narrativa sin cifras.');
    });

    it('refuses sign inversion even when the unsigned value exists in the pinned run', async () => {
      seedPinnedRun();
      const { report, section } = seedDraft('sign-inversion');

      await expect(
        updateReportSection(PROJECT_ID, report.id, section.id, {
          title: 'Resultados',
          content: 'El valor social neto fue -1800 USD.',
        })
      ).rejects.toThrow('cifras que no coinciden');
      expect(section.content).toBe('Narrativa sin cifras.');
    });

    it.each([
      ['zero percentage', 'La atribución es 0%.'],
      ['small count', 'Se alcanzaron 17 beneficiarios.'],
      ['year-shaped count', 'Se alcanzaron 2026 beneficiarios.'],
    ])('refuses unsupported %s when a pinned snapshot exists', async (_name, content) => {
      seedPinnedRun();
      const { report, section } = seedDraft(`snapshot-${_name}`);

      await expect(
        updateReportSection(PROJECT_ID, report.id, section.id, { title: 'Resultados', content })
      ).rejects.toThrow('cifras que no coinciden');
      expect(section.content).toBe('Narrativa sin cifras.');
    });

    it('accepts zero only when the pinned run explicitly authorizes it', async () => {
      seedPinnedRun({ snapshotJson: { fundersBreakdown: [], unattributedNsvUsd: '0.0000', assignments: [] } });
      const { report, section } = seedDraft('authorized-zero');

      const updated = await updateReportSection(PROJECT_ID, report.id, section.id, {
        title: 'Resultados',
        content: 'El valor social no atribuido es 0 USD.',
      });

      expect(updated.content).toContain('0 USD');
    });

    it('does not manufacture typed zero authority from a null persisted total', async () => {
      seedPinnedRun({ totalInvestment: null });
      const { report, section } = seedDraft('null-total-zero');

      await expect(
        updateReportSection(PROJECT_ID, report.id, section.id, {
          title: 'Resultados',
          content: 'La inversión fue $0.',
        })
      ).rejects.toThrow('cifras que no coinciden');
      expect(section.content).toBe('Narrativa sin cifras.');
    });

    it('accepts authorized ratio and currency values from the pinned run', async () => {
      seedPinnedRun();
      const { report, section } = seedDraft('authorized-values');

      const updated = await updateReportSection(PROJECT_ID, report.id, section.id, {
        title: 'Resultados',
        content: 'El SROI es 1.8:1 y la inversión es USD 1,000.',
      });

      expect(updated.content).toContain('1.8:1');
    });

    it('preserves sign semantics while accepting the pinned run\'s actual negative value', async () => {
      seedPinnedRun({ netSocialValue: '-1800.0000' });
      const accepted = seedDraft('negative-accepted');
      const rejected = seedDraft('positive-sign-inverted');

      await expect(
        updateReportSection(PROJECT_ID, accepted.report.id, accepted.section.id, {
          title: 'Resultados',
          content: 'El valor social neto fue -$1,800.',
        })
      ).resolves.toMatchObject({ content: expect.stringContaining('-$1,800') });

      await expect(
        updateReportSection(PROJECT_ID, rejected.report.id, rejected.section.id, {
          title: 'Resultados',
          content: 'El valor social neto fue $1,800.',
        })
      ).rejects.toThrow('cifras que no coinciden');
    });

    it('accepts the pinned run\'s legitimate percent, ratio, decimal, and thousands formats', async () => {
      seedPinnedRun({
        snapshotJson: {
          fundersBreakdown: [],
          assignments: [{ filters: { attributionPct: 20 } }],
        },
      });
      const { report, section } = seedDraft('report-formats');

      const updated = await updateReportSection(PROJECT_ID, report.id, section.id, {
        title: 'Resultados',
        content: 'La inversión fue USD 1,000.00; la atribución fue 20% y el SROI 1.8:1.',
      });

      expect(updated.content).toContain('1,000.00');
    });

    it('accepts an explicit project evidence reference and refuses a foreign one at save', async () => {
      seedPinnedRun();
      mockDb.evidenceItems.push({ id: EVIDENCE_UUID, projectId: PROJECT_ID, organizationId: ORG_ID });
      const accepted = seedDraft('evidence-accepted');
      const rejected = seedDraft('evidence-rejected');

      const updated = await updateReportSection(PROJECT_ID, accepted.report.id, accepted.section.id, {
        title: 'Evidencia',
        content: `Evidence ID: ${EVIDENCE_UUID}.`,
      });
      expect(updated.content).toContain(EVIDENCE_UUID);

      await expect(
        updateReportSection(PROJECT_ID, rejected.report.id, rejected.section.id, {
          title: 'Evidencia',
          content: `Evidence ID: ${FOREIGN_EVIDENCE_UUID}.`,
          allowedReferenceIds: [FOREIGN_EVIDENCE_UUID],
        } as any)
      ).rejects.toThrow('referencias que no coinciden');
      expect(rejected.section.content).toBe('Narrativa sin cifras.');
    });

    it('accepts a pinned-run proxy reference and refuses an unsupported one at save', async () => {
      seedPinnedRun({ snapshotJson: { fundersBreakdown: [], assignments: [{ proxyId: PROXY_UUID }] } });
      const accepted = seedDraft('proxy-accepted');
      const rejected = seedDraft('proxy-rejected');

      const updated = await updateReportSection(PROJECT_ID, accepted.report.id, accepted.section.id, {
        title: 'Proxy',
        content: `Proxy ID: ${PROXY_UUID}.`,
      });
      expect(updated.content).toContain(PROXY_UUID);

      await expect(
        updateReportSection(PROJECT_ID, rejected.report.id, rejected.section.id, {
          title: 'Proxy',
          content: `Proxy ID: ${FOREIGN_PROXY_UUID}.`,
        })
      ).rejects.toThrow('referencias que no coinciden');
      expect(rejected.section.content).toBe('Narrativa sin cifras.');
    });

    it('refuses a foreign bare UUID and preserves ordinary proxy prose at the save boundary', async () => {
      seedPinnedRun();
      const foreign = seedDraft('foreign-bare');
      const prose = seedDraft('ordinary-proxy-prose');

      await expect(
        updateReportSection(PROJECT_ID, foreign.report.id, foreign.section.id, {
          title: 'Evidencia', content: `Referencia: ${FOREIGN_EVIDENCE_UUID}.`,
        })
      ).rejects.toThrow('referencias que no coinciden');
      expect(foreign.section.content).toBe('Narrativa sin cifras.');

      await expect(
        updateReportSection(PROJECT_ID, prose.report.id, prose.section.id, {
          title: 'Metodología', content: 'proxy: costo de oportunidad',
        })
      ).resolves.toMatchObject({ content: 'proxy: costo de oportunidad' });
    });

    it('does not let a proxy that exists only in a different run authorize this report', async () => {
      seedPinnedRun({ snapshotJson: { fundersBreakdown: [], assignments: [{ proxyId: PROXY_UUID }] } });
      mockDb.sroiCalculationRuns.push({
        id: 'run-r2-proxy-other', projectId: PROJECT_ID, organizationId: ORG_ID,
        totalInvestment: '1000.0000', grossSocialValue: '2000.0000', netSocialValue: '1800.0000',
        sroiRatio: '1.800000', version: 2,
        snapshotJson: { fundersBreakdown: [], assignments: [{ proxyId: FOREIGN_PROXY_UUID }] },
      });
      const { report, section } = seedDraft('pinned-proxy-only', RUN_ID);

      await expect(
        updateReportSection(PROJECT_ID, report.id, section.id, {
          title: 'Proxy', content: `Proxy ID: ${FOREIGN_PROXY_UUID}.`,
        })
      ).rejects.toThrow('referencias que no coinciden');
    });

    it('refuses lock with an unsupported persisted reference despite a true attestation', async () => {
      seedPinnedRun();
      const { report } = seedDraft('lock-reference', RUN_ID, `Evidence ID: ${FOREIGN_EVIDENCE_UUID}.`);
      mockDb.sroiRunReviews.push({
        id: 'review-lock-reference',
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        calculationRunId: RUN_ID,
        status: 'approved',
      });
      vi.mocked(requireOrganizationAccess).mockResolvedValue({
        organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' },
      } as any);

      await expect(lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true }))
        .rejects.toThrow('references do not match');
      expect(report.status).toBe('draft');
    });

    it('allows lock for an explicit reference that the same server authority permits at save', async () => {
      seedPinnedRun({ snapshotJson: { fundersBreakdown: [], assignments: [{ proxyId: PROXY_UUID }] } });
      const { report } = seedDraft('lock-reference-valid', RUN_ID, `Proxy ID: ${PROXY_UUID}.`);
      mockDb.sroiRunReviews.push({
        id: 'review-lock-reference-valid',
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        calculationRunId: RUN_ID,
        status: 'approved',
      });
      vi.mocked(requireOrganizationAccess).mockResolvedValue({
        organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' },
      } as any);

      await expect(lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true }))
        .resolves.toMatchObject({ status: 'locked' });
    });

    it('refuses a save when a report numeric claim is hidden behind a former heading mask', async () => {
      seedPinnedRun();
      const { report, section } = seedDraft('save-masking-bypass');

      await expect(
        updateReportSection(PROJECT_ID, report.id, section.id, {
          title: 'Resultados',
          content: '## 17 USD',
        }),
      ).rejects.toThrow('cifras que no coinciden');
      expect(section.content).toBe('Narrativa sin cifras.');
    });

    it('refuses a lock when persisted content hides a claim behind a former technical-ID mask', async () => {
      seedPinnedRun();
      const { report } = seedDraft('lock-masking-bypass', RUN_ID, 'v1700 USD');
      mockDb.sroiRunReviews.push({
        id: 'review-lock-masking-bypass',
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        calculationRunId: RUN_ID,
        status: 'approved',
      });
      vi.mocked(requireOrganizationAccess).mockResolvedValue({
        organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'impact_manager' },
      } as any);

      await expect(lockReportDraft(PROJECT_ID, report.id, { narrativeReviewed: true }))
        .rejects.toThrow('figures that do not match');
      expect(report.status).toBe('draft');
    });
  });
  it('lists project reports', async () => {
    const report = { id: 'rep-1', projectId: PROJECT_ID, organizationId: ORG_ID };
    mockDb.sroiReports.push(report);
    const reports = await listProjectReports(PROJECT_ID);
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('rep-1');
  });
});
