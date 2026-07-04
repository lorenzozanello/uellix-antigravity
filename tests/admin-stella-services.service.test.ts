/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-stella-services.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  orgs: [] as any[],
  usageCounts: {} as Record<string, number>,
  updated: {} as any,
  beforeOrg: null as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: { STELLA_SERVICE_UPDATED: 'stella_service.updated' },
}));

vi.mock('@/lib/stella/quota', () => ({
  startOfCurrentUtcMonth: vi.fn().mockImplementation(() => new Date(0)),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      // fields is the object passed to db.select({...}); its shape tells us
      // which query is being issued (mirrors tests/stella-quota.test.ts).
      select: vi.fn().mockImplementation((fields?: Record<string, unknown>) => ({
        from: vi.fn().mockImplementation(() => {
          const isOrgListQuery = fields && 'id' in fields && 'stellaMonthlyQuota' in fields;
          const isOrgBeforeQuery =
            fields &&
            !('id' in fields) &&
            'stellaMonthlyQuota' in fields &&
            'stellaPlanLabel' in fields;
          const isCountQuery = fields && 'value' in fields;

          return {
            then: (cb: (rows: unknown[]) => unknown) => {
              if (isOrgListQuery) return Promise.resolve(cb(mockDbData.orgs));
              return Promise.resolve(cb([]));
            },
            where: vi.fn().mockImplementation(() => ({
              then: (cb: (rows: unknown[]) => unknown) => {
                if (isOrgBeforeQuery) {
                  return Promise.resolve(
                    cb(mockDbData.beforeOrg ? [mockDbData.beforeOrg] : [])
                  );
                }
                if (isCountQuery) {
                  // organizationId isn't accessible here since `where` args aren't
                  // threaded through this mock; tests that need per-org usage counts
                  // use a single org id ('org-1') to keep this simple.
                  return Promise.resolve(
                    cb([{ value: mockDbData.usageCounts['org-1'] ?? 0 }])
                  );
                }
                return Promise.resolve(cb([]));
              },
            })),
          };
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.updated])),
          })),
        })),
      })),
    },
  };
});

import { listOrganizationsWithStellaUsage, updateOrganizationStellaService } from '@/lib/admin/stella-services';
import { requireAdminAccess } from '@/lib/auth/session';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.orgs = [];
  mockDbData.usageCounts = {};
  mockDbData.updated = {};
  mockDbData.beforeOrg = null;
});

describe('listOrganizationsWithStellaUsage', () => {
  it('requires admin access', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' }];
    mockDbData.usageCounts = { 'org-1': 12 };

    const result = await listOrganizationsWithStellaUsage();

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].usedThisMonth).toBe(12);
  });

  it('computes real usage via a direct count query even when quota is 0 (unassigned)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 0, stellaPlanLabel: null }];
    mockDbData.usageCounts = { 'org-1': 7 };

    const result = await listOrganizationsWithStellaUsage();

    expect(result[0].usedThisMonth).toBe(7);
  });

  it('computes real usage via a direct count query even when quota is null (unlimited)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: null, stellaPlanLabel: 'Internal' }];
    mockDbData.usageCounts = { 'org-1': 25 };

    const result = await listOrganizationsWithStellaUsage();

    expect(result[0].usedThisMonth).toBe(25);
  });
});

describe('updateOrganizationStellaService', () => {
  it('requires admin access and updates quota/label', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.beforeOrg = { stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' };
    mockDbData.updated = { id: 'org-1', stellaMonthlyQuota: 100, stellaPlanLabel: 'Enterprise' };

    const result = await updateOrganizationStellaService('org-1', {
      planLabel: 'Enterprise',
      monthlyQuota: 100,
    });

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result.stellaMonthlyQuota).toBe(100);
  });

  it('accepts null monthlyQuota (unlimited)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.beforeOrg = { stellaMonthlyQuota: 0, stellaPlanLabel: null };
    mockDbData.updated = { id: 'org-1', stellaMonthlyQuota: null, stellaPlanLabel: 'Internal' };

    const result = await updateOrganizationStellaService('org-1', {
      planLabel: 'Internal',
      monthlyQuota: null,
    });

    expect(result.stellaMonthlyQuota).toBeNull();
  });

  it('rejects a negative quota', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);

    await expect(
      updateOrganizationStellaService('org-1', { planLabel: 'Bad', monthlyQuota: -5 })
    ).rejects.toThrow();
  });

  it('records both stellaMonthlyQuota and stellaPlanLabel in the before/after audit snapshot', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.beforeOrg = { stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' };
    mockDbData.updated = { id: 'org-1', stellaMonthlyQuota: 100, stellaPlanLabel: 'Enterprise' };

    await updateOrganizationStellaService('org-1', {
      planLabel: 'Enterprise',
      monthlyQuota: 100,
    });

    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeJson: { stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' },
        afterJson: { stellaMonthlyQuota: 100, stellaPlanLabel: 'Enterprise' },
      })
    );
  });

  it('throws "Organization not found" when the organization does not exist', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.beforeOrg = null;

    await expect(
      updateOrganizationStellaService('org-missing', { planLabel: 'Pro', monthlyQuota: 100 })
    ).rejects.toThrow('Organization not found');
  });
});
