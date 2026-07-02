/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/members.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  members: [] as any[],
  updated: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  canManageUsers: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    MEMBERSHIP_REMOVED: 'membership.removed',
  },
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          innerJoin: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => Promise.resolve(mockDbData.members)),
          })),
          where: vi.fn().mockImplementation(() => ({
            then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(mockDbData.members))),
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

import { listMembersForCurrentOrganization, removeMemberFromCurrentOrganization } from '@/lib/organizations/members';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { canManageUsers } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';

const ORG_CTX = {
  user: { id: 'user-1', email: 'admin@org.com' },
  organization: { id: 'org-1' },
  membership: { role: 'organization_admin' },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.members = [];
  mockDbData.updated = {};
});

describe('listMembersForCurrentOrganization', () => {
  it('returns members scoped to the current organization', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    mockDbData.members = [{ id: 'mem-1', userId: 'user-1', role: 'organization_admin', email: 'admin@org.com' }];

    const result = await listMembersForCurrentOrganization();
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('admin@org.com');
  });
});

describe('removeMemberFromCurrentOrganization', () => {
  it('removes a member and logs audit', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canManageUsers).mockReturnValue(true);
    mockDbData.members = [{ id: 'mem-2', organizationId: 'org-1', userId: 'user-2', status: 'active' }];
    mockDbData.updated = { id: 'mem-2', organizationId: 'org-1', userId: 'user-2', status: 'removed' };

    const result = await removeMemberFromCurrentOrganization('mem-2');
    expect(result.status).toBe('removed');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects when caller lacks organization_admin+ role', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({ ...ORG_CTX, membership: { role: 'analyst' } });
    vi.mocked(canManageUsers).mockReturnValue(false);

    await expect(removeMemberFromCurrentOrganization('mem-2')).rejects.toThrow(
      'Insufficient permissions to remove members'
    );
  });

  it('rejects removing a member from a different organization (IDOR regression)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canManageUsers).mockReturnValue(true);
    mockDbData.members = [{ id: 'mem-2', organizationId: 'org-OTHER', userId: 'user-2', status: 'active' }];

    await expect(removeMemberFromCurrentOrganization('mem-2')).rejects.toThrow('Forbidden');
  });

  it('rejects removing yourself', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canManageUsers).mockReturnValue(true);
    mockDbData.members = [{ id: 'mem-1', organizationId: 'org-1', userId: 'user-1', status: 'active' }];

    await expect(removeMemberFromCurrentOrganization('mem-1')).rejects.toThrow('You cannot remove yourself');
  });
});
