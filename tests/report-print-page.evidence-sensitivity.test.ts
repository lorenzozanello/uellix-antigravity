/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/report-print-page.evidence-sensitivity.test.ts
// FIBIU-05 (FIBC-007, W2-B1-R2/R-B1-01, NC-1) — the print page renders a
// governed REPORT/ANNEX surface. This proves classified/unclassified
// evidence never reaches buildEvidenceManifest, the function that renders
// the printable evidence annex.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/link', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('lucide-react', () => ({ ArrowLeft: () => null, FileDown: () => null }));
vi.mock('./PrintButton', () => ({ PrintButton: () => null }));
vi.mock('@/components/report/ReportSectionRenderer', () => ({ ReportSectionRenderer: () => null }));

vi.mock('@/lib/pipeline/sroi-results', () => ({
  getReportDraft: vi.fn(),
  getCalculationRunDetail: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/projects/service', () => ({
  getProjectByIdForCurrentOrganization: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Project' }),
}));

vi.mock('@/lib/auth/session', () => ({
  runWithOptionalOrganizationAccess: vi.fn().mockImplementation((cb: any) =>
    cb({ organization: { id: 'org-1', name: 'Org' } })
  ),
}));

vi.mock('@/lib/taxonomies/service', () => ({
  listOutcomeMappingsForProject: vi.fn().mockResolvedValue([]),
  groupMappingsByCatalog: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/pipeline/evidence', () => ({
  listEvidenceForProject: vi.fn().mockResolvedValue([
    { id: 'ev-1', title: 'Sensitive item', type: 'file', status: 'approved', contentHash: 'abc' },
    { id: 'ev-2', title: 'Cleared item', type: 'file', status: 'approved', contentHash: 'def' },
  ]),
}));

vi.mock('@/lib/pipeline/evidence-versions', () => ({
  getLatestEvidenceVersionsByEvidenceIds: vi.fn().mockResolvedValue(
    new Map([
      ['ev-1', { sensitivityClassification: 'personal_data' }],
      ['ev-2', { sensitivityClassification: 'non_sensitive' }],
    ])
  ),
}));

vi.mock('@/lib/pipeline/methodology-review', () => ({
  listMethodologyReviewsForProject: vi.fn().mockResolvedValue([]),
}));

const buildEvidenceManifest = vi.fn().mockReturnValue([]);
vi.mock('@/lib/reports/pdf/report-data', () => ({
  buildEvidenceManifest: (...args: unknown[]) => buildEvidenceManifest(...args),
  extractFxTrail: vi.fn().mockReturnValue(null),
  extractLineItems: vi.fn().mockReturnValue(null),
  buildMethodologyReadiness: vi.fn().mockReturnValue(null),
}));

import ReportPrintPage from '@/app/app/projects/[projectId]/report/[reportId]/print/page';
import { getReportDraft } from '@/lib/pipeline/sroi-results';

describe('Report print page — evidence sensitivity filtering (FIBIU-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildEvidenceManifest.mockReturnValue([]);
    vi.mocked(getReportDraft).mockResolvedValue({
      id: 'report-1',
      title: 'Test Report',
      calculationRunId: 'run-1',
      reportVariant: 'audit',
      includeFunderBreakdown: false,
      snapshotJson: {},
      sections: [],
    } as any);
  });

  it('never passes classified-sensitive or unclassified evidence into the printable evidence manifest', async () => {
    await ReportPrintPage({
      params: Promise.resolve({ projectId: 'proj-1', reportId: 'report-1' }),
    } as any);

    expect(buildEvidenceManifest).toHaveBeenCalledTimes(1);
    const passedEvidence = buildEvidenceManifest.mock.calls[0][0] as Array<{ title: string }>;
    expect(passedEvidence).toHaveLength(1);
    expect(passedEvidence.map((e) => e.title)).toEqual(['Cleared item']);
    expect(passedEvidence.some((e) => e.title === 'Sensitive item')).toBe(false);
  });
});
