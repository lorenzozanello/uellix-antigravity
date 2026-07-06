/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/confidence-score.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    EVIDENCE_CONFIDENCE_SCORE_UPDATED: 'evidence_item.confidence_score_updated',
  },
}));

const mockDbData: { evidence: any } = {
  evidence: {},
};

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          then: (cb: any) => Promise.resolve(cb([mockDbData.evidence])),
        })),
      })),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: any) => ({
        where: vi.fn().mockImplementation(() => {
          Object.assign(mockDbData.evidence, values);
          return Promise.resolve([mockDbData.evidence]);
        }),
      })),
    })),
  },
}));

import { computeConfidenceScore, recalculateConfidenceScore } from '@/lib/pipeline/confidence-score';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';

describe('computeConfidenceScore', () => {
  it('scores a fully-approved, linked, integrity-verified file at 100', () => {
    expect(
      computeConfidenceScore({ type: 'file', status: 'approved', hasLinkage: true, integrityVerified: true })
    ).toBe(100);
  });

  it('scores an unlinked draft url with no integrity signal at 25', () => {
    expect(
      computeConfidenceScore({ type: 'url', status: 'draft', hasLinkage: false, integrityVerified: null })
    ).toBe(25);
  });

  it('scores a linked, approved text statement at 55 (no integrity signal for text)', () => {
    expect(
      computeConfidenceScore({ type: 'text', status: 'approved', hasLinkage: true, integrityVerified: null })
    ).toBe(55);
  });

  it('forces the score to 0 when file integrity verification fails, regardless of other signals', () => {
    expect(
      computeConfidenceScore({ type: 'file', status: 'approved', hasLinkage: true, integrityVerified: false })
    ).toBe(0);
  });

  it('ignores integrityVerified for non-file types even if set to true', () => {
    expect(
      computeConfidenceScore({ type: 'url', status: 'approved', hasLinkage: false, integrityVerified: true })
    ).toBe(55);
  });

  it('treats rejected and archived status identically at 0 points for that signal', () => {
    const rejected = computeConfidenceScore({ type: 'file', status: 'rejected', hasLinkage: false, integrityVerified: null });
    const archived = computeConfidenceScore({ type: 'file', status: 'archived', hasLinkage: false, integrityVerified: null });
    expect(rejected).toBe(35);
    expect(archived).toBe(35);
  });

  it('scores the minimum plausible case (unlinked rejected text) at the type floor', () => {
    expect(
      computeConfidenceScore({ type: 'text', status: 'rejected', hasLinkage: false, integrityVerified: null })
    ).toBe(10);
  });

  // --- Additional coverage tests (approved by controller, outside the literal plan text) ---
  // Gap 1: the most common production state — freshly-created approved file evidence that has
  // never been through integrity verification yet (integrityVerified: null, not false/true).
  it('scores an approved, unlinked file with unverified integrity at 70 (no bonus, no penalty)', () => {
    expect(
      computeConfidenceScore({ type: 'file', status: 'approved', hasLinkage: false, integrityVerified: null })
    ).toBe(70); // 35 (file) + 35 (approved), no +20 bonus — never verified
  });

  // Gap 2: no existing test exercised the 'under_review' status point value.
  it('scores an unlinked under_review url at 35', () => {
    expect(
      computeConfidenceScore({ type: 'url', status: 'under_review', hasLinkage: false, integrityVerified: null })
    ).toBe(35); // 20 (url) + 15 (under_review)
  });
});

describe('recalculateConfidenceScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.evidence = {
      id: 'ev-1',
      type: 'file',
      status: 'draft',
      outcomeId: null,
      indicatorId: null,
      integrityVerified: null,
      confidenceScore: null,
    };
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
    } as any);
  });

  it('persists the computed score and records audit when the score changes', async () => {
    await recalculateConfidenceScore('proj-1', 'ev-1');
    expect(mockDbData.evidence.confidenceScore).toBe(40); // file=35 + draft=5
    expect(mockDbData.evidence.confidenceCalculatedAt).toBeInstanceOf(Date);
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evidence_item.confidence_score_updated',
        beforeJson: { confidenceScore: null },
        afterJson: { confidenceScore: 40 },
      })
    );
  });

  it('treats outcomeId or indicatorId presence as linkage', async () => {
    mockDbData.evidence.outcomeId = 'out-1';
    await recalculateConfidenceScore('proj-1', 'ev-1');
    expect(mockDbData.evidence.confidenceScore).toBe(50); // file=35 + draft=5 + linked=10
  });

  it('does not write or audit when the recalculated score matches the stored value', async () => {
    mockDbData.evidence.confidenceScore = 40;
    await recalculateConfidenceScore('proj-1', 'ev-1');
    expect(logAuditAction).not.toHaveBeenCalled();
  });

  it('does nothing when the evidence row does not exist', async () => {
    mockDbData.evidence = undefined as any;
    await expect(recalculateConfidenceScore('proj-1', 'missing')).resolves.toBeUndefined();
    expect(logAuditAction).not.toHaveBeenCalled();
  });
});
