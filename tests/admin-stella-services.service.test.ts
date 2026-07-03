/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-stella-services.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  orgs: [] as any[],
  usageCounts: {} as Record<string, number>,
  updated: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: { STELLA_SERVICE_UPDATED: 'stella_service.updated' },
}));

vi.mock('@/lib/stella/quota', () => ({
  checkStellaQuota: vi.fn().mockImplementation((orgId: string) =>
    Promise.resolve({ allowed: true, used: mockDbData.usageCounts[orgId] ?? 0, quota: null })
  ),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(mockDbData.orgs)),
          where: vi.fn().mockImplementation(() => ({
            then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(mockDbData.orgs)),
          })),
        })),
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
});

describe('updateOrganizationStellaService', () => {
  it('requires admin access and updates quota/label', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
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
});
