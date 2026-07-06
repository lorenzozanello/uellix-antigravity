/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/outcomes.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOutcome, listOutcomes, setOutcomeMateriality } from '@/lib/pipeline/outcomes';
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
    OUTCOME_MATERIALITY_UPDATED: 'outcome.materiality_updated',
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
  outcome: null as any,
  // Distinguishes "this test doesn't care about the setOutcomeMateriality
  // select-by-id path" (fall back to `entities`, used by listOutcomes tests)
  // from "this test explicitly wants the outcome lookup to miss" (outcome:
  // null with useOutcomeLookup: true, used by the IDOR regression test).
  // Without this flag, `outcome: null` is ambiguous between those two cases.
  useOutcomeLookup: false,
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
          if (tableName === 'outcomes' && mockDbData.useOutcomeLookup) {
            return {
              where: vi.fn().mockImplementation(() => ({
                limit: vi.fn().mockReturnThis(),
                then: vi.fn().mockImplementation((callback) => {
                  return Promise.resolve(callback(mockDbData.outcome ? [mockDbData.outcome] : []));
                }),
              })),
            };
          }
          return queryBuilder;
        }),
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.inserted])),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((values: any) => ({
          where: vi.fn().mockImplementation(() => {
            if (mockDbData.outcome) Object.assign(mockDbData.outcome, values);
            return Promise.resolve([mockDbData.outcome]);
          }),
        })),
      })),
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
    mockDbData.outcome = null;
    mockDbData.useOutcomeLookup = false;
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

  // Additional coverage (not from the plan): lower-bound rejection for
  // materialityScore, mirroring the existing upper-bound test above.
  it('rejects a materiality score below 1 (e.g. 0)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Bad materiality 4',
      stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000',
      materialityScore: 0,
      materialityRationale: 'Below range',
    };
    await expect(createOutcome('proj-1', input as any)).rejects.toThrow();
  });

  // Additional coverage (not from the plan): an empty-string rationale is
  // "present" (not undefined), so the .refine() pairing rule is satisfied;
  // this should instead fail Zod's .min(1) on the rationale string itself.
  it('rejects a materiality rationale that is present but empty', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);

    const input = {
      title: 'Bad materiality 5',
      stakeholderGroupId: '550e8400-e29b-41d4-a716-446655440000',
      materialityScore: 3,
      materialityRationale: '',
    };
    await expect(createOutcome('proj-1', input as any)).rejects.toThrow();
  });

  it('persists a materiality score and rationale via setOutcomeMateriality', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1', materialityScore: null, materialityRationale: null };
    mockDbData.useOutcomeLookup = true;

    const result = await setOutcomeMateriality('proj-1', 'out-1', {
      materialityScore: 5,
      materialityRationale: 'Highest-priority outcome for this cohort.',
    });

    expect(result.materialityScore).toBe(5);
    expect(result.materialityRationale).toBe('Highest-priority outcome for this cohort.');
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeJson: { materialityScore: null, materialityRationale: null },
        afterJson: { materialityScore: 5, materialityRationale: 'Highest-priority outcome for this cohort.' },
      })
    );
  });

  it('clears both fields when materialityScore is null, ignoring any rationale passed', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1', materialityScore: 3, materialityRationale: 'Old rationale' };
    mockDbData.useOutcomeLookup = true;

    const result = await setOutcomeMateriality('proj-1', 'out-1', {
      materialityScore: null,
      materialityRationale: 'This text should be ignored',
    } as any);

    expect(result.materialityScore).toBeNull();
    expect(result.materialityRationale).toBeNull();
  });

  it('rejects setOutcomeMateriality with a score but no rationale', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1', materialityScore: null, materialityRationale: null };
    mockDbData.useOutcomeLookup = true;

    await expect(
      setOutcomeMateriality('proj-1', 'out-1', { materialityScore: 2 } as any)
    ).rejects.toThrow();
  });

  it('rejects setOutcomeMateriality for an unauthorized role', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u2' },
      organization: { id: 'org-1' },
      membership: { role: 'viewer' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(false);
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1', materialityScore: null, materialityRationale: null };
    mockDbData.useOutcomeLookup = true;

    await expect(
      setOutcomeMateriality('proj-1', 'out-1', { materialityScore: 3, materialityRationale: 'x' })
    ).rejects.toThrow('Insufficient permissions');
  });

  it('rejects setOutcomeMateriality when the outcome does not belong to the project (IDOR regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1' },
      organization: { id: 'org-1' },
      membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(hasRole).mockReturnValue(true);
    mockDbData.outcome = null; // simulates no row matching (projectId, outcomeId)
    mockDbData.useOutcomeLookup = true;

    await expect(
      setOutcomeMateriality('proj-1', 'out-1', { materialityScore: 3, materialityRationale: 'x' })
    ).rejects.toThrow('Outcome not found for project');
  });
});
