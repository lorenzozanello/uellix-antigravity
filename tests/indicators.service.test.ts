/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/indicators.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createIndicator, listIndicators } from '@/lib/pipeline/indicators';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';

// Mock auth context
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    ORGANIZATION_CREATED: 'organization_created',
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
  inserted: { id: 'ind-1', outcomeId: 'out-1', projectId: 'proj-1' } as any,
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
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.inserted])),
    },
  };
});

describe('Indicator service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    // Default: the outcome-ownership lookup finds a match, so existing
    // happy-path tests (which don't care about this check) pass.
    mockDbData.entities = [{ id: '550e8400-e29b-41d4-a716-446655440000', projectId: 'proj-1' }];
    mockDbData.inserted = { id: 'ind-1', outcomeId: '550e8400-e29b-41d4-a716-446655440000', projectId: 'proj-1' };
  });

  it('allows creation with permitted role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = { name: 'Indicator 1', outcomeId: '550e8400-e29b-41d4-a716-446655440000' };
    const result = await createIndicator('proj-1', input);
    expect(result.id).toBe('ind-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects creation with unauthorized role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u2' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(false);

    const input = { name: 'Bad', outcomeId: '550e8400-e29b-41d4-a716-446655440000' };
    await expect(createIndicator('proj-1', input)).rejects.toThrow('Insufficient permissions');
  });

  it('fails validation on bad input', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const badInput = { name: '' }; // fails validation
    await expect(createIndicator('proj-1', badInput as any)).rejects.toThrow();
  });

  it('lists indicators filtered by project', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    mockDbData.entities = [{ id: 'ind-1', projectId: 'proj-1' }];

    const indicators = await listIndicators('proj-1');
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0].projectId).toBe('proj-1');
  });

  it('rejects creation when the project belongs to a different organization (IDOR regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.project = { id: 'proj-1', organizationId: 'org-OTHER' };

    const input = { name: 'Cross-org attempt', outcomeId: '550e8400-e29b-41d4-a716-446655440000' };
    await expect(createIndicator('proj-1', input)).rejects.toThrow(
      'Project does not belong to your organization'
    );
  });

  it('rejects listing when the project belongs to a different organization (IDOR regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    mockDbData.project = { id: 'proj-1', organizationId: 'org-OTHER' };

    await expect(listIndicators('proj-1')).rejects.toThrow(
      'Project does not belong to your organization'
    );
  });

  it('rejects creation when outcomeId does not belong to this project (SEC-002 regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    // No outcome matches (projectId, outcomeId) — simulates a UUID
    // belonging to another org's outcome.
    mockDbData.entities = [];

    const input = { name: 'Cross-org outcome hijack', outcomeId: '550e8400-e29b-41d4-a716-446655440000' };
    await expect(createIndicator('proj-1', input)).rejects.toThrow(
      'Outcome does not belong to this project'
    );
  });
});
