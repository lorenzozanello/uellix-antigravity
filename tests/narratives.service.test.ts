/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/narratives.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { upsertNarrativeForProject, getNarrativeForProject } from '@/lib/pipeline/narratives';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';
import { hasRole } from '@/lib/auth/permissions';

// Mock auth context
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    ORGANIZATION_CREATED: 'organization_created',
    ORGANIZATION_UPDATED: 'organization_updated',
  },
}));

// Mock permissions
vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
}));

// Global mock configuration for DB queries
const mockDbData = {
  project: { id: 'proj-1', organizationId: 'org-1' } as any | null,
  entities: [] as any[],
  inserted: { id: 'narr-1', projectId: 'proj-1', version: 'v1' } as any,
};

vi.mock('@/db/client', () => {
  const queryBuilder = {
    where: vi.fn().mockImplementation(() => {
      return {
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((callback) => {
          return Promise.resolve(callback(mockDbData.entities));
        }),
      };
    }),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((callback) => {
      return Promise.resolve(callback(mockDbData.entities));
    }),
  };

  const updateBuilder = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => Promise.resolve([])),
  };

  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          if (tableName === 'projects') {
            return {
              where: vi.fn().mockImplementation(() => ({
                limit: vi.fn().mockReturnThis(),
                then: vi.fn().mockImplementation((callback) => {
                  return Promise.resolve(callback(mockDbData.project ? [mockDbData.project] : []));
                }),
              })),
              limit: vi.fn().mockReturnThis(),
              then: vi.fn().mockImplementation((callback) => {
                return Promise.resolve(callback(mockDbData.project ? [mockDbData.project] : []));
              }),
            };
          }
          return queryBuilder;
        }),
      }),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnValue(updateBuilder),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.inserted])),
    },
  };
});

describe('Narrative service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.entities = [];
    mockDbData.inserted = { id: 'narr-1', projectId: 'proj-1', version: 'v1' };
  });

  it('allows upsert with permitted role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'u@test.com', isSuperAdmin: false },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = { version: 'v2', narrativeText: 'text' };
    const result = await upsertNarrativeForProject('proj-1', input);
    expect(result.id).toBe('narr-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects upsert with unauthorized role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-2', email: 'u2@test.com', isSuperAdmin: false },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(false);

    const input = { version: 'v2' };
    await expect(upsertNarrativeForProject('proj-1', input)).rejects.toThrow('Insufficient permissions');
  });

  it('fails validation on bad input', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'u@test.com', isSuperAdmin: false },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const badInput = { version: '' }; // fails min(1) constraint
    await expect(upsertNarrativeForProject('proj-1', badInput)).rejects.toThrow();
  });

  it('retrieves narrative read‑only', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    mockDbData.entities = [{ id: 'narr-1', projectId: 'proj-1' }];

    const narrative = await getNarrativeForProject('proj-1');
    expect(narrative?.id).toBe('narr-1');
  });
});
