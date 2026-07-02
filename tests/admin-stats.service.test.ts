/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-stats.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockCounts = vi.hoisted(() => ({
  organizations: 3,
  users: 7,
  financialProxies: 2,
  auditLogs: 41,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          const value =
            tableName === 'organizations'
              ? mockCounts.organizations
              : tableName === 'users'
                ? mockCounts.users
                : tableName === 'financial_proxies'
                  ? mockCounts.financialProxies
                  : tableName === 'audit_logs'
                    ? mockCounts.auditLogs
                    : 0;
          return {
            where: vi.fn().mockResolvedValue([{ value }]),
            then: vi.fn().mockImplementation((cb) => Promise.resolve(cb([{ value }]))),
          };
        }),
      })),
    },
  };
});

import { getAdminStats } from '@/lib/admin/stats';
import { requireAdminAccess } from '@/lib/auth/session';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAdminStats', () => {
  it('returns counts for organizations, users, global proxies, and audit logs', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1', email: 'a@a.com', fullName: null, avatarUrl: null, isSuperAdmin: true } as any);

    const stats = await getAdminStats();
    expect(stats).toEqual({
      totalOrganizations: 3,
      totalUsers: 7,
      totalGlobalProxies: 2,
      totalAuditLogs: 41,
    });
  });

  it('requires admin access before querying', async () => {
    vi.mocked(requireAdminAccess).mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(getAdminStats()).rejects.toThrow('NEXT_REDIRECT');
  });
});
