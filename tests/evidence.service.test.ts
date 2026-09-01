/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/evidence.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  createFileEvidenceForProject,
  createUrlEvidenceForProject,
  createTextEvidenceForProject,
  updateEvidenceReviewStatus,
  archiveEvidenceForProject,
} from '@/lib/pipeline/evidence';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';
import { recalculateConfidenceScore } from '@/lib/pipeline/confidence-score';

vi.mock('@/lib/pipeline/confidence-score', () => ({
  recalculateConfidenceScore: vi.fn(),
}));

// Mock auth session
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}));

// createFileEvidenceForProject and verifyFileEvidenceIntegrity own their own
// contexts — the storage round trip sits BETWEEN them and must not run inside a
// transaction. Pass-through here: this suite is about hashing, permissions and
// path sanitisation. The contexts themselves are proved against a live database
// in tests/authenticated-database-context.test.ts.
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: () => unknown) => cb(),
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    ORGANIZATION_UPDATED: 'organization.updated',
    EVIDENCE_CREATED: 'evidence_item.created',
    EVIDENCE_REVIEW_STATUS_CHANGED: 'evidence_item.review_status_changed',
    EVIDENCE_ARCHIVED: 'evidence_item.archived',
    EVIDENCE_UPLOAD_FAILED: 'evidence_item.upload_failed',
    EVIDENCE_VERSION_CREATED: 'evidence_version.created',
    EVIDENCE_VERSION_INTEGRITY_VERIFIED: 'evidence_version.integrity_verified',
    EVIDENCE_VERSION_SENSITIVITY_CLASSIFIED: 'evidence_version.sensitivity_classified',
    EVIDENCE_VERSION_TREATMENT_RECORDED: 'evidence_version.treatment_recorded',
    EVIDENCE_TOMBSTONE_ERASURE_REQUESTED: 'evidence_tombstone.erasure_requested',
    EVIDENCE_TOMBSTONE_ERASURE_COMPLETED: 'evidence_tombstone.erasure_completed',
    EVIDENCE_TOMBSTONE_ERASURE_BLOCKED: 'evidence_tombstone.erasure_blocked',
  },
}));

// Mock permissions
vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
  canClassifyEvidenceSensitivity: vi.fn(),
  canEraseEvidenceContent: vi.fn(),
}));

// Mock Supabase Server Client
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockImplementation(() => {
    return Promise.resolve({
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ error: null }),
          download: vi.fn().mockResolvedValue({
            data: { arrayBuffer: () => Promise.resolve(Buffer.from('hello world')) },
            error: null,
          }),
        }),
      },
    });
  }),
}));

const mockDbData = {
  project: { id: 'proj-1', organizationId: 'org-1' } as any | null,
  outcome: { id: 'out-1', projectId: 'proj-1' } as any | null,
  indicator: { id: 'ind-1', projectId: 'proj-1' } as any | null,
  evidence: { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft', type: 'file' } as any,
  // FIBIU-04/05/07 — the current (latest-ordinal) version row for 'ev-1'.
  // Tests that need a different classification/erasure/content state
  // mutate this directly before calling the service function under test.
  evidenceVersions: [
    {
      id: 'ver-1',
      organizationId: 'org-1',
      evidenceId: 'ev-1',
      ordinal: 1,
      content: null,
      contentHash: '123',
      sensitivityClassification: 'non_sensitive',
      treatment: null,
      reviewStatus: 'draft',
      legacyContentUnverifiable: false,
      erasureState: null,
      supersedesVersionId: null,
      createdBy: 'u1',
      createdAt: new Date(),
    },
  ] as any[],
  evidenceTombstones: [] as any[],
};

/** A thenable Drizzle-select-chain stand-in: every builder method returns
 * the same chain, so any call order (.where().limit(), .where().orderBy()
 * .limit(), .where().then()) resolves against the same underlying `data`,
 * most-recently-set `limitCount` respected only at resolution time. */
function makeSelectChain(data: any[]) {
  let limitCount: number | null = null;
  const chain: any = {
    where: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation((n: number) => {
      limitCount = n;
      return chain;
    }),
    then: vi.fn().mockImplementation((callback: (rows: any[]) => unknown) => {
      const rows = limitCount === null ? data : data.slice(0, limitCount);
      return Promise.resolve(callback(rows));
    }),
    catch: vi.fn().mockImplementation(() => Promise.resolve()),
  };
  return chain;
}

function tableNameOf(table: any): string {
  return table?._?.name || table?.[Symbol.for('drizzle:Name')];
}

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = tableNameOf(table);
          let data: any[] = [];
          if (tableName === 'projects') data = mockDbData.project ? [mockDbData.project] : [];
          else if (tableName === 'outcomes') data = mockDbData.outcome ? [mockDbData.outcome] : [];
          else if (tableName === 'indicators') data = mockDbData.indicator ? [mockDbData.indicator] : [];
          else if (tableName === 'evidence_items') data = mockDbData.evidence ? [mockDbData.evidence] : [];
          else if (tableName === 'evidence_versions') {
            data = [...mockDbData.evidenceVersions].sort((a, b) => b.ordinal - a.ordinal);
          } else if (tableName === 'evidence_tombstones') data = [...mockDbData.evidenceTombstones];
          return makeSelectChain(data);
        }),
      })),
      insert: vi.fn().mockImplementation((table) => {
        const tableName = tableNameOf(table);
        return {
          values: vi.fn().mockImplementation((vals: any) => ({
            returning: vi.fn().mockImplementation(() => {
              if (tableName === 'evidence_versions') {
                const existingForEvidence = mockDbData.evidenceVersions.filter((v) => v.evidenceId === vals.evidenceId);
                const ordinal = existingForEvidence.length + 1;
                const supersedesVersionId =
                  existingForEvidence.sort((a, b) => b.ordinal - a.ordinal)[0]?.id ?? null;
                const row = {
                  id: `ver-${mockDbData.evidenceVersions.length + 1}`,
                  ordinal,
                  supersedesVersionId,
                  sensitivityClassification: null,
                  treatment: null,
                  erasureState: null,
                  legacyContentUnverifiable: false,
                  createdAt: new Date(),
                  ...vals,
                };
                mockDbData.evidenceVersions.push(row);
                return Promise.resolve([row]);
              }
              if (tableName === 'evidence_tombstones') {
                const row = { id: `tomb-${mockDbData.evidenceTombstones.length + 1}`, createdAt: new Date(), ...vals };
                mockDbData.evidenceTombstones.push(row);
                return Promise.resolve([row]);
              }
              return Promise.resolve([mockDbData.evidence]);
            }),
          })),
        };
      }),
      update: vi.fn().mockImplementation((table) => {
        const tableName = tableNameOf(table);
        return {
          set: vi.fn().mockImplementation((values: any) => ({
            where: vi.fn().mockImplementation(() => {
              let result: any[] = [];
              if (tableName === 'evidence_items' && mockDbData.evidence) {
                Object.assign(mockDbData.evidence, values);
                result = [mockDbData.evidence];
              } else if (tableName === 'evidence_versions') {
                const current = [...mockDbData.evidenceVersions].sort((a, b) => b.ordinal - a.ordinal)[0];
                if (current) Object.assign(current, values);
                result = current ? [current] : [];
              }
              return {
                returning: vi.fn().mockImplementation(() => Promise.resolve(result)),
                then: vi.fn().mockImplementation((callback: (rows: any[]) => unknown) => Promise.resolve(callback(result))),
              };
            }),
          })),
        };
      }),
    },
  };
});

describe('Evidence service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1' };
    mockDbData.indicator = { id: 'ind-1', projectId: 'proj-1' };
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft', type: 'file', contentHash: '123' };
    mockDbData.evidenceVersions = [
      {
        id: 'ver-1',
        organizationId: 'org-1',
        evidenceId: 'ev-1',
        ordinal: 1,
        content: null,
        contentHash: '123',
        sensitivityClassification: 'non_sensitive',
        treatment: null,
        reviewStatus: 'draft',
        legacyContentUnverifiable: false,
        erasureState: null,
        supersedesVersionId: null,
        createdBy: 'u1',
        createdAt: new Date(),
      },
    ];
    mockDbData.evidenceTombstones = [];
  });

  it('allows createFileEvidenceForProject with analyst role and calculates SHA-256', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Evidence 1',
      file: {
        name: 'test.pdf',
        mimeType: 'application/pdf',
        size: 100,
        buffer: Buffer.from('hello world'),
      },
    };

    const result = await createFileEvidenceForProject('proj-1', input);
    expect(result.id).toBe('ev-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects createFileEvidenceForProject with a disallowed MIME type (SEC-003)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Evidence SVG',
      file: {
        name: 'payload.svg',
        mimeType: 'image/svg+xml',
        size: 100,
        buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
      },
    };

    await expect(createFileEvidenceForProject('proj-1', input)).rejects.toThrow();
  });

  it('rejects createFileEvidenceForProject with a file over the size limit (SEC-003)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Huge file',
      file: {
        name: 'huge.pdf',
        mimeType: 'application/pdf',
        size: 26 * 1024 * 1024, // 26 MB, over the 25 MB limit
        buffer: Buffer.from('irrelevant'),
      },
    };

    await expect(createFileEvidenceForProject('proj-1', input)).rejects.toThrow();
  });

  it('sanitizes a path-traversal filename before building the storage key (SEC-004)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const { createClient } = await import('@/lib/supabase/server');
    const uploadSpy = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({
      storage: {
        from: vi.fn().mockReturnValue({
          upload: uploadSpy,
          download: vi.fn().mockResolvedValue({
            data: { arrayBuffer: () => Promise.resolve(Buffer.from('hello world')) },
            error: null,
          }),
        }),
      },
    } as any);

    const input = {
      title: 'Traversal attempt',
      file: {
        name: '../../../etc/passwd',
        mimeType: 'application/pdf',
        size: 100,
        buffer: Buffer.from('hello world'),
      },
    };

    await createFileEvidenceForProject('proj-1', input);

    const uploadedPath = uploadSpy.mock.calls[0][0] as string;
    expect(uploadedPath).not.toContain('..');
    expect(uploadedPath).not.toContain('/etc/');
    expect(uploadedPath.endsWith('passwd')).toBe(true);
  });

  it('allows createUrlEvidenceForProject with analyst role and normalizes URL hash', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Evidence 2',
      url: 'https://example.com/Evidence ',
    };

    const result = await createUrlEvidenceForProject('proj-1', input);
    expect(result.id).toBe('ev-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('allows createTextEvidenceForProject and normalizes text hash', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Evidence 3',
      text: '   this is test evidence   ',
    };

    const result = await createTextEvidenceForProject('proj-1', input);
    expect(result.id).toBe('ev-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('allows updateEvidenceReviewStatus with impact_manager role', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => {
      return role === 'impact_manager' && required === 'impact_manager';
    });

    const result = await updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' });
    expect(result).toBeDefined();
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('allows archiveEvidenceForProject with analyst role', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => {
      return role === 'analyst' && required === 'analyst';
    });

    const result = await archiveEvidenceForProject('proj-1', 'ev-1');
    expect(result).toBeDefined();
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects createUrlEvidenceForProject when the project belongs to a different organization (IDOR regression)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.project = { id: 'proj-1', organizationId: 'org-OTHER' };

    const input = { title: 'Cross-org attempt', url: 'https://example.com/evidence' };
    await expect(createUrlEvidenceForProject('proj-1', input)).rejects.toThrow(
      'Project does not belong to your organization'
    );
  });

  it('rejects listEvidenceForProject when the project belongs to a different organization (IDOR regression)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    mockDbData.project = { id: 'proj-1', organizationId: 'org-OTHER' };

    const { listEvidenceForProject } = await import('@/lib/pipeline/evidence');
    await expect(listEvidenceForProject('proj-1')).rejects.toThrow(
      'Project does not belong to your organization'
    );
  });

  it('triggers a confidence score recalculation after creating file evidence', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Evidence 1',
      file: { name: 'test.pdf', mimeType: 'application/pdf', size: 100, buffer: Buffer.from('hello world') },
    };
    await createFileEvidenceForProject('proj-1', input);
    expect(recalculateConfidenceScore).toHaveBeenCalledWith('proj-1', 'ev-1');
  });

  it('triggers a confidence score recalculation after creating URL evidence', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await createUrlEvidenceForProject('proj-1', { title: 'Evidence 2', url: 'https://example.com/e' });
    expect(recalculateConfidenceScore).toHaveBeenCalledWith('proj-1', 'ev-1');
  });

  it('triggers a confidence score recalculation after creating text evidence', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await createTextEvidenceForProject('proj-1', { title: 'Evidence 3', text: 'a statement' });
    expect(recalculateConfidenceScore).toHaveBeenCalledWith('proj-1', 'ev-1');
  });

  it('triggers a confidence score recalculation after a review status change', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => role === 'impact_manager' && required === 'impact_manager');

    await updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' });
    expect(recalculateConfidenceScore).toHaveBeenCalledWith('proj-1', 'ev-1');
  });

  it('does NOT trigger a confidence score recalculation on archive', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => role === 'analyst' && required === 'analyst');

    await archiveEvidenceForProject('proj-1', 'ev-1');
    expect(recalculateConfidenceScore).not.toHaveBeenCalled();
  });

  it('verifyFileEvidenceIntegrity persists the result and triggers recalculation on a match', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => role === 'impact_manager' && required === 'impact_manager');
    mockDbData.evidence = {
      id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft',
      type: 'file', filePath: 'proj-1/ev-1/test.pdf',
      contentHash: crypto.createHash('sha256').update('hello world').digest('hex'),
    };

    const { verifyFileEvidenceIntegrity } = await import('@/lib/pipeline/evidence');
    const result = await verifyFileEvidenceIntegrity('proj-1', 'ev-1');

    expect(result.verified).toBe(true);
    expect(mockDbData.evidence.integrityVerified).toBe(true);
    expect(mockDbData.evidence.integrityVerifiedAt).toBeInstanceOf(Date);
    expect(recalculateConfidenceScore).toHaveBeenCalledWith('proj-1', 'ev-1');
  });

  it('verifyFileEvidenceIntegrity persists a mismatch without throwing', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => role === 'impact_manager' && required === 'impact_manager');
    mockDbData.evidence = {
      id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft',
      type: 'file', filePath: 'proj-1/ev-1/test.pdf',
      contentHash: 'a-hash-that-will-not-match',
    };

    const { verifyFileEvidenceIntegrity } = await import('@/lib/pipeline/evidence');
    const result = await verifyFileEvidenceIntegrity('proj-1', 'ev-1');

    expect(result.verified).toBe(false);
    expect(mockDbData.evidence.integrityVerified).toBe(false);
    expect(recalculateConfidenceScore).toHaveBeenCalledWith('proj-1', 'ev-1');
  });

  it('verifyFileEvidenceIntegrity does NOT persist anything for non-file evidence', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => role === 'impact_manager' && required === 'impact_manager');
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft', type: 'url', contentHash: 'x' };

    const { verifyFileEvidenceIntegrity } = await import('@/lib/pipeline/evidence');
    const result = await verifyFileEvidenceIntegrity('proj-1', 'ev-1');

    expect(result.verified).toBe(false);
    expect(mockDbData.evidence.integrityVerified).toBeUndefined();
    expect(recalculateConfidenceScore).not.toHaveBeenCalled();
  });

  it('rejects verifyFileEvidenceIntegrity for a role below impact_manager (SEC regression)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockImplementation((role, required) => role === 'impact_manager' && required === 'impact_manager');
    mockDbData.evidence = {
      id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft',
      type: 'file', filePath: 'proj-1/ev-1/test.pdf', contentHash: 'x',
    };

    const { verifyFileEvidenceIntegrity } = await import('@/lib/pipeline/evidence');
    await expect(verifyFileEvidenceIntegrity('proj-1', 'ev-1')).rejects.toThrow('Insufficient permissions');
    expect(recalculateConfidenceScore).not.toHaveBeenCalled();
  });
});

describe('FIBIU-04 — evidence version content persistence (FIBC-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1' };
    mockDbData.indicator = { id: 'ind-1', projectId: 'proj-1' };
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft', type: 'file', contentHash: '123' };
    mockDbData.evidenceVersions = [
      {
        id: 'ver-1', organizationId: 'org-1', evidenceId: 'ev-1', ordinal: 1,
        content: null, contentHash: '123', sensitivityClassification: 'non_sensitive', treatment: null,
        reviewStatus: 'draft', legacyContentUnverifiable: false, erasureState: null,
        supersedesVersionId: null, createdBy: 'u1', createdAt: new Date(),
      },
    ];
    mockDbData.evidenceTombstones = [];
  });

  it('persists the normalized text content on the version row — the defect FIBC-006 names is closed', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'analyst' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await createTextEvidenceForProject('proj-1', { title: 'Text ev', text: '  actual retained bytes  ' });

    const created = mockDbData.evidenceVersions.find((v) => v.ordinal === 2);
    expect(created).toBeDefined();
    expect(created!.content).toBe('actual retained bytes');
    expect(created!.contentHash).toBe(
      crypto.createHash('sha256').update('actual retained bytes').digest('hex')
    );
  });

  it('refuses to approve text evidence whose stored content does not re-hash to its recorded hash (tamper detection)', async () => {
    mockDbData.evidence.type = 'text';
    mockDbData.evidenceVersions[0].content = 'tampered content';
    mockDbData.evidenceVersions[0].contentHash = crypto.createHash('sha256').update('original content').digest('hex');
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await expect(updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' })).rejects.toThrow(
      'EVIDENCE_CONTENT_UNVERIFIABLE'
    );
  });

  it('refuses to approve legacy text evidence marked legacy_content_unverifiable — no reconstruction, ever', async () => {
    mockDbData.evidence.type = 'text';
    mockDbData.evidenceVersions[0].content = null;
    mockDbData.evidenceVersions[0].legacyContentUnverifiable = true;
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await expect(updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' })).rejects.toThrow(
      'EVIDENCE_CONTENT_UNVERIFIABLE'
    );
  });

  it('approves text evidence whose content correctly re-hashes and logs evidence_version.integrity_verified', async () => {
    const text = 'correct content';
    mockDbData.evidence.type = 'text';
    mockDbData.evidenceVersions[0].content = text;
    mockDbData.evidenceVersions[0].contentHash = crypto.createHash('sha256').update(text).digest('hex');
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' });

    const calls = vi.mocked(logAuditAction).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.action === 'evidence_version.integrity_verified')).toBe(true);
  });
});

describe('FIBIU-05 — evidence sensitivity and treatment governance (FIBC-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1' };
    mockDbData.indicator = { id: 'ind-1', projectId: 'proj-1' };
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft', type: 'file', contentHash: '123' };
    mockDbData.evidenceVersions = [
      {
        id: 'ver-1', organizationId: 'org-1', evidenceId: 'ev-1', ordinal: 1,
        content: null, contentHash: '123', sensitivityClassification: null, treatment: null,
        reviewStatus: 'draft', legacyContentUnverifiable: false, erasureState: null,
        supersedesVersionId: null, createdBy: 'u1', createdAt: new Date(),
      },
    ];
    mockDbData.evidenceTombstones = [];
  });

  it('refuses to approve unclassified evidence — automatic detection never declares non-sensitive by omission', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await expect(updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' })).rejects.toThrow(
      'EVIDENCE_SENSITIVITY_UNEVALUATED'
    );
  });

  it('refuses to approve classified-sensitive evidence with no documented treatment', async () => {
    mockDbData.evidenceVersions[0].sensitivityClassification = 'personal_data';
    mockDbData.evidenceVersions[0].treatment = null;
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await expect(updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' })).rejects.toThrow(
      'EVIDENCE_TREATMENT_UNDETERMINED'
    );
  });

  it('approves sensitive evidence once classification AND treatment are both recorded', async () => {
    mockDbData.evidenceVersions[0].sensitivityClassification = 'personal_data';
    mockDbData.evidenceVersions[0].treatment = 'anonymized';
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const result = await updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' });
    expect(result.status).toBe('approved');
  });

  it('rejects classifyEvidenceSensitivity for an actor below impact_manager', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'analyst' },
    } as any);
    const { canClassifyEvidenceSensitivity } = await import('@/lib/auth/permissions');
    vi.mocked(canClassifyEvidenceSensitivity).mockReturnValue(false);

    const { classifyEvidenceSensitivity } = await import('@/lib/pipeline/evidence');
    await expect(
      classifyEvidenceSensitivity('proj-1', 'ev-1', { sensitivityClassification: 'non_sensitive' })
    ).rejects.toThrow('Insufficient permissions');
  });

  it('classifyEvidenceSensitivity records both governed actions and updates the version row', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    const { canClassifyEvidenceSensitivity } = await import('@/lib/auth/permissions');
    vi.mocked(canClassifyEvidenceSensitivity).mockReturnValue(true);

    const { classifyEvidenceSensitivity } = await import('@/lib/pipeline/evidence');
    const result = await classifyEvidenceSensitivity('proj-1', 'ev-1', {
      sensitivityClassification: 'confidential_third_party',
      treatment: 'pseudonymized',
    });

    expect(result.sensitivityClassification).toBe('confidential_third_party');
    expect(result.treatment).toBe('pseudonymized');
    const actions = vi.mocked(logAuditAction).mock.calls.map((c) => c[0].action);
    expect(actions).toContain('evidence_version.sensitivity_classified');
    expect(actions).toContain('evidence_version.treatment_recorded');
  });

  it('rejects classifyEvidenceSensitivity when a sensitive classification omits the required treatment', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    const { canClassifyEvidenceSensitivity } = await import('@/lib/auth/permissions');
    vi.mocked(canClassifyEvidenceSensitivity).mockReturnValue(true);

    const { classifyEvidenceSensitivity } = await import('@/lib/pipeline/evidence');
    await expect(
      classifyEvidenceSensitivity('proj-1', 'ev-1', { sensitivityClassification: 'special_category' })
    ).rejects.toThrow();
  });
});

describe('FIBIU-07 — governed evidence erasure substrate, stage A only (FIBC-009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1' };
    mockDbData.indicator = { id: 'ind-1', projectId: 'proj-1' };
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'text', contentHash: '123' };
    mockDbData.evidenceVersions = [
      {
        id: 'ver-1', organizationId: 'org-1', evidenceId: 'ev-1', ordinal: 1,
        content: 'sensitive text', contentHash: '123', sensitivityClassification: 'non_sensitive', treatment: null,
        reviewStatus: 'approved', legacyContentUnverifiable: false, erasureState: null,
        supersedesVersionId: null, createdBy: 'u1', createdAt: new Date(),
      },
    ];
    mockDbData.evidenceTombstones = [];
  });

  it('rejects an actor below organization_admin', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    const { canEraseEvidenceContent } = await import('@/lib/auth/permissions');
    vi.mocked(canEraseEvidenceContent).mockReturnValue(false);

    const { requestGovernedEvidenceErasure } = await import('@/lib/pipeline/evidence');
    await expect(
      requestGovernedEvidenceErasure('proj-1', 'ev-1', {
        erasureReason: 'privacy_or_data_subject_request',
        rationale: 'Data subject requested erasure',
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  it('erases text content, writes an append-only tombstone, and reaches erasure_complete', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'organization_admin' },
    } as any);
    const { canEraseEvidenceContent } = await import('@/lib/auth/permissions');
    vi.mocked(canEraseEvidenceContent).mockReturnValue(true);

    const { requestGovernedEvidenceErasure } = await import('@/lib/pipeline/evidence');
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', {
      erasureReason: 'privacy_or_data_subject_request',
      rationale: 'Data subject requested erasure',
    });

    expect(tombstone.erasureState).toBe('erasure_complete');
    expect(mockDbData.evidenceVersions[0].content).toBeNull();
    expect(mockDbData.evidenceVersions[0].erasureState).toBe('erasure_complete');
    expect(mockDbData.evidenceTombstones).toHaveLength(1);

    const actions = vi.mocked(logAuditAction).mock.calls.map((c) => c[0].action);
    expect(actions).toContain('evidence_tombstone.erasure_requested');
    expect(actions).toContain('evidence_tombstone.erasure_completed');
  });

  it('reaches erasure_partial, never a false erasure_complete, when the storage sweep fails for file evidence', async () => {
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'file', filePath: 'proj-1/ev-1/file.pdf', contentHash: '123' };
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'organization_admin' },
    } as any);
    const { canEraseEvidenceContent } = await import('@/lib/auth/permissions');
    vi.mocked(canEraseEvidenceContent).mockReturnValue(true);
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValue({
      storage: {
        from: vi.fn().mockReturnValue({
          remove: vi.fn().mockResolvedValue({ error: { message: 'storage unreachable' } }),
        }),
      },
    } as any);

    const { requestGovernedEvidenceErasure } = await import('@/lib/pipeline/evidence');
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', {
      erasureReason: 'unauthorized_or_erroneous_upload',
      rationale: 'File must be swept but storage failed',
    });

    expect(tombstone.erasureState).toBe('erasure_partial');
    expect(mockDbData.evidenceVersions[0].erasureState).toBe('erasure_partial');
  });

  it('refuses to erase content that was already erased', async () => {
    mockDbData.evidenceVersions[0].erasureState = 'erasure_complete';
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'organization_admin' },
    } as any);
    const { canEraseEvidenceContent } = await import('@/lib/auth/permissions');
    vi.mocked(canEraseEvidenceContent).mockReturnValue(true);

    const { requestGovernedEvidenceErasure } = await import('@/lib/pipeline/evidence');
    await expect(
      requestGovernedEvidenceErasure('proj-1', 'ev-1', {
        erasureReason: 'retention_policy',
        rationale: 'Already erased once',
      })
    ).rejects.toThrow('already been erased');
  });

  it('never lets erased evidence return to approved or under_review', async () => {
    mockDbData.evidenceVersions[0].erasureState = 'erasure_complete';
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    await expect(updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'approved' })).rejects.toThrow(
      'Erased evidence cannot return'
    );
    await expect(updateEvidenceReviewStatus('proj-1', 'ev-1', { status: 'under_review' })).rejects.toThrow(
      'Erased evidence cannot return'
    );
  });
});
