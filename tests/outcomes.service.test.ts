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
    // Default: the stakeholder-group-ownership lookup finds a match, so
    // existing happy-path tests (which don't care about this check) pass.
    mockDbData.entities = [{ id: '550e8400-e29b-41d4-a716-446655440000', projectId: 'proj-1' }];
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

  it('rejects creation when the project belongs to a different organization (IDOR regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.project = { id: 'proj-1', organizationId: 'org-OTHER' };

    const input = { title: 'Cross-org attempt', stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000' };
    await expect(createOutcome('proj-1', input)).rejects.toThrow(
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

    await expect(listOutcomes('proj-1')).rejects.toThrow(
      'Project does not belong to your organization'
    );
  });

  it('rejects creation when stakeholderGroupId does not belong to this project (SEC-001 regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    // No stakeholder group matches (projectId, stakeholderGroupId) — simulates
    // a UUID belonging to another org's stakeholder group.
    mockDbData.entities = [];

    const input = { title: 'Cross-org group hijack', stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000' };
    await expect(createOutcome('proj-1', input)).rejects.toThrow(
      'Stakeholder group does not belong to this project'
    );
  });

  it('accepts creation with a valid materiality score + rationale', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Outcome with materiality',
      stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000',
      materialityScore: 4,
      materialityRationale: 'Directly tied to the primary funder mandate.',
    };
    const result = await createOutcome('proj-1', input);
    expect(result.id).toBe('out-1');
  });

  it('rejects a materiality score without a rationale', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Bad materiality',
      stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000',
      materialityScore: 3,
    };
    await expect(createOutcome('proj-1', input as any)).rejects.toThrow();
  });

  it('rejects a materiality rationale without a score', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Bad materiality 2',
      stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000',
      materialityRationale: 'Orphaned rationale',
    };
    await expect(createOutcome('proj-1', input as any)).rejects.toThrow();
  });

  it('rejects a materiality score outside 1-5', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Bad materiality 3',
      stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000',
      materialityScore: 6,
      materialityRationale: 'Out of range',
    };
    await expect(createOutcome('proj-1', input as any)).rejects.toThrow();
  });
});
