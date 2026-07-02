/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-organizations.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  orgs: [] as any[],
  updated: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          leftJoin: vi.fn().mockImplementation(() => ({
            groupBy: vi.fn().mockResolvedValue(mockDbData.orgs),
          })),
          where: vi.fn().mockImplementation(() => ({
            then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(mockDbData.orgs))),
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

import { listAllOrganizations, setOrganizationStatus } from '@/lib/admin/organizations';
import { requireAdminAccess } from '@/lib/auth/session';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.orgs = [];
  mockDbData.updated = {};
});

describe('listAllOrganizations', () => {
  it('requires admin access and returns orgs with member counts', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', memberCount: 3 }];

    const result = await listAllOrganizations();
    expect(result).toEqual([{ id: 'org-1', name: 'Acme', memberCount: 3 }]);
    expect(requireAdminAccess).toHaveBeenCalled();
  });
});

describe('setOrganizationStatus', () => {
  it('rejects when the organization does not exist', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [];

    await expect(setOrganizationStatus('org-missing', 'suspended')).rejects.toThrow(
      'Organization not found'
    );
  });

  it('updates the organization status', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', status: 'active' }];
    mockDbData.updated = { id: 'org-1', status: 'suspended' };

    const result = await setOrganizationStatus('org-1', 'suspended');
    expect(result.status).toBe('suspended');
  });
});
