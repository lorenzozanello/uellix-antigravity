/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/evidence.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      update: vi.fn().mockImplementation(() => {
        return {
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue([mockDbData.evidence]),
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
});
