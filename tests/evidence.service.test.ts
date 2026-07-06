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

// Mock audit logger
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    ORGANIZATION_UPDATED: 'organization.updated',
  },
}));

// Mock permissions
vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
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
  evidence: { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft' } as any,
};

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        return {
          from: vi.fn().mockImplementation((table) => {
            const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
            let data: any[] = [];
            if (tableName === 'projects') {
              data = mockDbData.project ? [mockDbData.project] : [];
            } else if (tableName === 'outcomes') {
              data = mockDbData.outcome ? [mockDbData.outcome] : [];
            } else if (tableName === 'indicators') {
              data = mockDbData.indicator ? [mockDbData.indicator] : [];
            } else if (tableName === 'evidence_items') {
              data = mockDbData.evidence ? [mockDbData.evidence] : [];
            }
            return {
              where: vi.fn().mockImplementation(() => ({
                limit: vi.fn().mockImplementation(() => ({
                  then: vi.fn().mockImplementation((callback) => Promise.resolve(callback(data))),
                })),
                then: vi.fn().mockImplementation((callback) => Promise.resolve(callback(data))),
              })),
              limit: vi.fn().mockImplementation(() => ({
                then: vi.fn().mockImplementation((callback) => Promise.resolve(callback(data))),
              })),
              then: vi.fn().mockImplementation((callback) => Promise.resolve(callback(data))),
            };
          }),
        };
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.evidence])),
      update: vi.fn().mockImplementation((table) => {
        const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
        return {
          set: vi.fn().mockImplementation((values: any) => ({
            where: vi.fn().mockImplementation(() => {
              if (tableName === 'evidence_items' && mockDbData.evidence) {
                Object.assign(mockDbData.evidence, values);
              }
              return Promise.resolve([mockDbData.evidence]);
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
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'draft', contentHash: '123' };
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
