/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-logs.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockLogs = vi.hoisted(() => [] as any[]);

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          leftJoin: vi.fn().mockImplementation(() => ({
            leftJoin: vi.fn().mockImplementation(() => ({
              orderBy: vi.fn().mockImplementation(() => ({
                limit: vi.fn().mockImplementation((n: number) => Promise.resolve(mockLogs.slice(0, n))),
              })),
            })),
          })),
        })),
      })),
    },
  };
});

import { listRecentAuditLogs } from '@/lib/admin/logs';
import { requireAdminAccess } from '@/lib/auth/session';

beforeEach(() => {
  vi.clearAllMocks();
  mockLogs.length = 0;
});

describe('listRecentAuditLogs', () => {
  it('requires admin access and respects the limit', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockLogs.push({ id: 'log-1' }, { id: 'log-2' }, { id: 'log-3' });

    const result = await listRecentAuditLogs(2);
    expect(result).toHaveLength(2);
    expect(requireAdminAccess).toHaveBeenCalled();
  });

  it('defaults to 100 when no limit is given', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockLogs.push({ id: 'log-1' });

    const result = await listRecentAuditLogs();
    expect(result).toEqual([{ id: 'log-1' }]);
  });
});
