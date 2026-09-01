/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/report-pdf-route.evidence-sensitivity.test.ts
// FIBIU-05 (FIBC-007, W2-B1-R2/R-B1-01, NC-1) — the PDF export route is a
// governed EXPORT surface. This proves classified/unclassified evidence
// never reaches buildEvidenceManifest, the function that renders the PDF
// evidence annex.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
}));

vi.mock('@/lib/pipeline/sroi-results', () => ({
  getReportDraft: vi.fn(),
  getCalculationRunDetail: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/projects/service', () => ({
  getProjectByIdForCurrentOrganization: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Project' }),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn().mockResolvedValue({ organization: { id: 'org-1' } }),
  runWithOptionalOrganizationAccess: vi.fn().mockImplementation((cb: any) => cb({ organization: { id: 'org-1' } })),
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

vi.mock('@/lib/organizations/logo-url', () => ({
  getApprovedOrganizationLogoUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/reports/pdf/ReportPdfDocument', () => ({
  ReportPdfDocument: () => null,
}));

const buildEvidenceManifest = vi.fn().mockReturnValue([]);
vi.mock('@/lib/reports/pdf/report-data', () => ({
  extractFunderBreakdown: vi.fn().mockReturnValue(null),
  buildEvidenceManifest: (...args: unknown[]) => buildEvidenceManifest(...args),
  extractFxTrail: vi.fn().mockReturnValue(null),
  extractLineItems: vi.fn().mockReturnValue(null),
  buildMethodologyReadiness: vi.fn().mockReturnValue(null),
}));

import { GET } from '@/app/app/projects/[projectId]/report/[reportId]/pdf/route';
import { getReportDraft } from '@/lib/pipeline/sroi-results';

describe('PDF export route — evidence sensitivity filtering (FIBIU-05)', () => {
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

  it('never passes classified-sensitive or unclassified evidence into the PDF evidence manifest', async () => {
    await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ projectId: 'proj-1', reportId: 'report-1' }),
    });

    expect(buildEvidenceManifest).toHaveBeenCalledTimes(1);
    const passedEvidence = buildEvidenceManifest.mock.calls[0][0] as Array<{ title: string }>;
    expect(passedEvidence).toHaveLength(1);
    expect(passedEvidence.map((e) => e.title)).toEqual(['Cleared item']);
    expect(passedEvidence.some((e) => e.title === 'Sensitive item')).toBe(false);
  });
});
