// tests/sroi-results.actions.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/pipeline/sroi-results', () => ({
  createSroiRunReview: vi.fn(),
  updateSroiRunReview: vi.fn(),
  upsertSroiRunReviewItem: vi.fn(),
  createReportDraftFromRun: vi.fn(),
  updateReportSection: vi.fn(),
  lockReportDraft: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// These actions now open an identity context before delegating. The wrapper is
// a pass-through here: the suite is about input validation and delegation, and
// the wrapper itself is proved in tests/authenticated-database-context.test.ts.
vi.mock('@/lib/auth/session', () => ({
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) => cb(undefined),
}));

import {
  createSroiRunReview,
  updateSroiRunReview,
  upsertSroiRunReviewItem,
  createReportDraftFromRun,
  updateReportSection,
  lockReportDraft,
} from '@/lib/pipeline/sroi-results';

import { createSroiRunReviewAction } from '@/app/app/projects/[projectId]/pipeline/calculation/runs/createSroiRunReview.action';
import { updateSroiRunReviewAction } from '@/app/app/projects/[projectId]/pipeline/calculation/runs/updateSroiRunReview.action';
import { upsertSroiRunReviewItemAction } from '@/app/app/projects/[projectId]/pipeline/calculation/runs/upsertSroiRunReviewItem.action';
import { createReportDraftFromRunAction } from '@/app/app/projects/[projectId]/report/createReportDraftFromRun.action';
import { updateReportSectionAction } from '@/app/app/projects/[projectId]/report/updateReportSection.action';
import { lockReportDraftAction } from '@/app/app/projects/[projectId]/report/lockReportDraft.action';

const PROJECT_ID = 'proj-1111';
const RUN_ID = 'run-2222';
const REVIEW_ID = 'rev-3333';
const REPORT_ID = 'rep-4444';
const SECTION_ID = 'sec-5555';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSroiRunReviewAction', () => {
  it('validates input payload and delegates to service', async () => {
    const payload = { status: 'reviewed', overallNotes: 'Looks good' };
    vi.mocked(createSroiRunReview).mockResolvedValue({ id: 'new-rev' } as any);

    const result = await createSroiRunReviewAction(PROJECT_ID, RUN_ID, payload);
    expect(result).toEqual({ id: 'new-rev' });
    expect(createSroiRunReview).toHaveBeenCalledWith(PROJECT_ID, RUN_ID, payload);
  });

  it('fails validation on invalid status', async () => {
    const payload = { status: 'invalid_status' };
    await expect(createSroiRunReviewAction(PROJECT_ID, RUN_ID, payload)).rejects.toThrow('Invalid review payload');
    expect(createSroiRunReview).not.toHaveBeenCalled();
  });

  // NEG-17-1 (FIBIU-17, FIBC-021, W2-B5) — inverted: readinessScore is
  // REMOVED from the schema (.strict()), so no human path may write
  // authoritative readiness — any value is rejected as an unrecognized key.
  it('NEG-17-1: rejects the action schema when readinessScore is supplied at all', async () => {
    const payload = { status: 'reviewed', readinessScore: 80 };
    await expect(createSroiRunReviewAction(PROJECT_ID, RUN_ID, payload)).rejects.toThrow('Invalid review payload');
    expect(createSroiRunReview).not.toHaveBeenCalled();
  });
});

describe('updateSroiRunReviewAction', () => {
  it('validates and delegates', async () => {
    const payload = { status: 'approved' };
    vi.mocked(updateSroiRunReview).mockResolvedValue({ id: REVIEW_ID, status: 'approved' } as any);

    const result = await updateSroiRunReviewAction(PROJECT_ID, REVIEW_ID, payload);
    expect(result.status).toBe('approved');
    expect(updateSroiRunReview).toHaveBeenCalledWith(PROJECT_ID, REVIEW_ID, payload);
  });
});

describe('upsertSroiRunReviewItemAction', () => {
  it('validates and delegates', async () => {
    const payload = { itemKey: 'stakeholders_ok', status: 'pass', severity: 'low', notes: 'all clear' };
    vi.mocked(upsertSroiRunReviewItem).mockResolvedValue({ id: 'item-1', status: 'pass' } as any);

    const result = await upsertSroiRunReviewItemAction(PROJECT_ID, REVIEW_ID, payload);
    expect(result.status).toBe('pass');
    expect(upsertSroiRunReviewItem).toHaveBeenCalledWith(PROJECT_ID, REVIEW_ID, payload);
  });

  it('fails validation if itemKey is missing', async () => {
    const payload = { status: 'pass' };
    await expect(upsertSroiRunReviewItemAction(PROJECT_ID, REVIEW_ID, payload)).rejects.toThrow('Invalid review item payload');
  });
});

describe('createReportDraftFromRunAction', () => {
  it('validates and delegates, defaulting includeFunderBreakdown to false', async () => {
    const payload = { title: 'Annual SROI Report' };
    vi.mocked(createReportDraftFromRun).mockResolvedValue({ id: REPORT_ID, title: 'Annual SROI Report' } as any);

    const result = await createReportDraftFromRunAction(PROJECT_ID, RUN_ID, payload);
    expect(result.id).toBe(REPORT_ID);
    expect(createReportDraftFromRun).toHaveBeenCalledWith(PROJECT_ID, RUN_ID, { title: 'Annual SROI Report', includeFunderBreakdown: false, reportVariant: 'audit' });
  });

  it('passes includeFunderBreakdown through when true', async () => {
    const payload = { title: 'Multi-Funder Report', includeFunderBreakdown: true };
    vi.mocked(createReportDraftFromRun).mockResolvedValue({ id: REPORT_ID, title: 'Multi-Funder Report' } as any);

    await createReportDraftFromRunAction(PROJECT_ID, RUN_ID, payload);
    expect(createReportDraftFromRun).toHaveBeenCalledWith(PROJECT_ID, RUN_ID, { title: 'Multi-Funder Report', includeFunderBreakdown: true, reportVariant: 'audit' });
  });

  it('fails validation on empty title', async () => {
    const payload = { title: '' };
    await expect(createReportDraftFromRunAction(PROJECT_ID, RUN_ID, payload)).rejects.toThrow('Invalid report draft payload');
  });
});

describe('updateReportSectionAction', () => {
  it('validates and delegates', async () => {
    const payload = { title: 'Executive Summary Updated', content: 'New content', sortOrder: 1 };
    vi.mocked(updateReportSection).mockResolvedValue({ id: SECTION_ID, title: 'Executive Summary Updated' } as any);

    const result = await updateReportSectionAction(PROJECT_ID, REPORT_ID, SECTION_ID, payload);
    expect(result.title).toBe('Executive Summary Updated');
    expect(updateReportSection).toHaveBeenCalledWith(PROJECT_ID, REPORT_ID, SECTION_ID, payload);
  });
});

describe('lockReportDraftAction', () => {
  it('delegates to service directly, forwarding the narrative attestation', async () => {
    vi.mocked(lockReportDraft).mockResolvedValue({ id: REPORT_ID, status: 'locked' } as any);

    const result = await lockReportDraftAction(PROJECT_ID, REPORT_ID, { narrativeReviewed: true });
    expect(result.status).toBe('locked');
    expect(lockReportDraft).toHaveBeenCalledWith(PROJECT_ID, REPORT_ID, { narrativeReviewed: true });
  });
});
