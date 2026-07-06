/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/confidence-score.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computeConfidenceScore } from '@/lib/pipeline/confidence-score';

describe('computeConfidenceScore', () => {
  it('scores a fully-approved, linked, integrity-verified file at 100', () => {
    expect(
      computeConfidenceScore({ type: 'file', status: 'approved', hasLinkage: true, integrityVerified: true })
    ).toBe(100);
  });

  it('scores an unlinked draft url with no integrity signal at 25', () => {
    expect(
      computeConfidenceScore({ type: 'url', status: 'draft', hasLinkage: false, integrityVerified: null })
    ).toBe(25); // 20 (url) + 5 (draft)
  });

  it('scores a linked, approved text statement at 55 (no integrity signal for text)', () => {
    expect(
      computeConfidenceScore({ type: 'text', status: 'approved', hasLinkage: true, integrityVerified: null })
    ).toBe(55); // 10 (text) + 35 (approved) + 10 (linked)
  });

  it('forces the score to 0 when file integrity verification fails, regardless of other signals', () => {
    expect(
      computeConfidenceScore({ type: 'file', status: 'approved', hasLinkage: true, integrityVerified: false })
    ).toBe(0);
  });

  it('ignores integrityVerified for non-file types even if set to true', () => {
    expect(
      computeConfidenceScore({ type: 'url', status: 'approved', hasLinkage: false, integrityVerified: true })
    ).toBe(55); // 20 (url) + 35 (approved), no +20 bonus — type is not 'file'
  });

  it('treats rejected and archived status identically at 0 points for that signal', () => {
    const rejected = computeConfidenceScore({ type: 'file', status: 'rejected', hasLinkage: false, integrityVerified: null });
    const archived = computeConfidenceScore({ type: 'file', status: 'archived', hasLinkage: false, integrityVerified: null });
    expect(rejected).toBe(35); // file=35, rejected=0
    expect(archived).toBe(35); // file=35, archived=0
  });

  it('scores the minimum plausible case (unlinked rejected text) at the type floor', () => {
    expect(
      computeConfidenceScore({ type: 'text', status: 'rejected', hasLinkage: false, integrityVerified: null })
    ).toBe(10);
  });
});
