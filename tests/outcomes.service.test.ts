/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/outcomes.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOutcome, listOutcomes } from '@/lib/pipeline/outcomes';
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
  inserted: { id: 'out-1', projectId: 'proj-1', stakeholderGroupId: 'sg-1' } as any,
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

describe('Outcome service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.entities = [];
    mockDbData.inserted = { id: 'out-1', projectId: 'proj-1', stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000' };
  });

  it('allows creation with permitted role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = { title: 'Outcome 1', stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000' };
    const result = await createOutcome('proj-1', input);
    expect(result.id).toBe('out-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects creation with unauthorized role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u2' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(false);

    const input = { title: 'Bad', stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000' };
    await expect(createOutcome('proj-1', input)).rejects.toThrow('Insufficient permissions');
  });

  it('fails validation on bad input', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const badInput = { title: '' }; // fails validation
    await expect(createOutcome('proj-1', badInput as any)).rejects.toThrow();
  });

  it('lists outcomes filtered by project', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    mockDbData.entities = [{ id: 'out-1', projectId: 'proj-1' }];

    const outcomes = await listOutcomes('proj-1');
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0].projectId).toBe('proj-1');
  });
});
