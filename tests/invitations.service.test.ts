/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/invitations.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  invitations: [] as any[],
  inserted: {} as any,
  updated: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
  getCurrentUser: vi.fn(),
  getCurrentMembership: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  canInviteUsers: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    INVITATION_SENT: 'invitation.sent',
    INVITATION_ACCEPTED: 'invitation.accepted',
    INVITATION_REVOKED: 'invitation.revoked',
    INVITATION_EXPIRED: 'invitation.expired',
    MEMBERSHIP_CREATED: 'membership.created',
  },
}));

vi.mock('@/lib/invitations/email', () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          const data = tableName === 'invitations' ? mockDbData.invitations : [];
          return {
            where: vi.fn().mockImplementation(() => ({
              then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(data))),
            })),
          };
        }),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.inserted])),
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

import {
  createInvitation,
  listInvitationsForCurrentOrganization,
  revokeInvitation,
  acceptInvitation,
} from '@/lib/invitations/service';
import { requireOrganizationAccess, getCurrentUser, getCurrentMembership } from '@/lib/auth/session';
import { canInviteUsers } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';
import { sendInvitationEmail } from '@/lib/invitations/email';

const ORG_CTX = {
  user: { id: 'user-1', email: 'admin@org.com', isSuperAdmin: false },
  organization: { id: 'org-1', name: 'Test Org' },
  membership: { role: 'organization_admin' },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.invitations = [];
  mockDbData.inserted = {};
  mockDbData.updated = {};
});

describe('createInvitation', () => {
  it('creates a pending invitation and returns the raw token', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);
    mockDbData.inserted = {
      id: 'inv-1',
      organizationId: 'org-1',
      email: 'new@user.com',
      role: 'analyst',
      status: 'pending',
    };

    const result = await createInvitation({ email: 'New@User.com', role: 'analyst' });
    expect(result.invitation.id).toBe('inv-1');
    expect(result.rawToken).toHaveLength(64); // 32 bytes hex
    expect(logAuditAction).toHaveBeenCalled();
    expect(sendInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@user.com', role: 'analyst', rawToken: result.rawToken }),
    );
  });

  it('rejects when caller lacks organization_admin+ role', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      ...ORG_CTX,
      membership: { role: 'analyst' },
    });
    vi.mocked(canInviteUsers).mockReturnValue(false);

    await expect(createInvitation({ email: 'x@y.com', role: 'viewer' })).rejects.toThrow(
      'Insufficient permissions to invite users'
    );
  });

  it('rejects inviting someone as super_admin', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);

    await expect(createInvitation({ email: 'x@y.com', role: 'super_admin' })).rejects.toThrow(
      'Cannot invite a user as super_admin'
    );
  });

  it('rejects a duplicate pending invitation for the same email', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);
    mockDbData.invitations = [
      { id: 'inv-existing', organizationId: 'org-1', email: 'dup@user.com', status: 'pending' },
    ];

    await expect(createInvitation({ email: 'dup@user.com', role: 'analyst' })).rejects.toThrow(
      'An active invitation already exists for this email'
    );
  });

  it('rejects an invalid role', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);

    await expect(createInvitation({ email: 'x@y.com', role: 'not_a_role' })).rejects.toThrow();
  });
});

describe('listInvitationsForCurrentOrganization', () => {
  it('returns only invitations scoped to the org query', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    mockDbData.invitations = [{ id: 'inv-1', organizationId: 'org-1' }];

    const result = await listInvitationsForCurrentOrganization();
    expect(result).toEqual([{ id: 'inv-1', organizationId: 'org-1' }]);
  });
});

describe('revokeInvitation', () => {
  it('revokes a pending invitation', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);
    mockDbData.invitations = [{ id: 'inv-1', organizationId: 'org-1', status: 'pending' }];
    mockDbData.updated = { id: 'inv-1', organizationId: 'org-1', status: 'revoked' };

    const result = await revokeInvitation('inv-1');
    expect(result.status).toBe('revoked');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('rejects revoking an invitation belonging to a different organization (IDOR regression)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);
    mockDbData.invitations = [{ id: 'inv-1', organizationId: 'org-OTHER', status: 'pending' }];

    await expect(revokeInvitation('inv-1')).rejects.toThrow('Forbidden');
  });

  it('rejects revoking a non-pending invitation', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ORG_CTX);
    vi.mocked(canInviteUsers).mockReturnValue(true);
    mockDbData.invitations = [{ id: 'inv-1', organizationId: 'org-1', status: 'accepted' }];

    await expect(revokeInvitation('inv-1')).rejects.toThrow('Only pending invitations can be revoked');
  });
});

describe('acceptInvitation', () => {
  it('creates an active membership and marks the invitation accepted', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'user-2',
      email: 'invitee@user.com',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    });
    vi.mocked(getCurrentMembership).mockResolvedValue(null);
    mockDbData.invitations = [
      {
        id: 'inv-1',
        organizationId: 'org-1',
        email: 'invitee@user.com',
        role: 'analyst',
        status: 'pending',
        tokenHash: 'ANY_HASH_SINCE_QUERY_IS_MOCKED',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        invitedBy: 'user-1',
      },
    ];
    mockDbData.inserted = { id: 'mem-1', organizationId: 'org-1', userId: 'user-2', role: 'analyst' };
    mockDbData.updated = { id: 'inv-1', status: 'accepted' };

    const result = await acceptInvitation('raw-token-value');
    expect(result.membership.id).toBe('mem-1');
    expect(result.invitation.status).toBe('accepted');
    expect(logAuditAction).toHaveBeenCalledTimes(2);
  });

  it('rejects when the token does not match any invitation', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'user-2',
      email: 'invitee@user.com',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    });
    mockDbData.invitations = [];

    await expect(acceptInvitation('bad-token')).rejects.toThrow('Invalid invitation');
  });

  it('rejects an expired invitation and marks it expired', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'user-2',
      email: 'invitee@user.com',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    });
    mockDbData.invitations = [
      {
        id: 'inv-1',
        organizationId: 'org-1',
        email: 'invitee@user.com',
        role: 'analyst',
        status: 'pending',
        tokenHash: 'x',
        expiresAt: new Date(Date.now() - 1000),
        invitedBy: 'user-1',
      },
    ];

    await expect(acceptInvitation('raw-token')).rejects.toThrow('Invitation has expired');
  });

  it('rejects an invitation issued to a different email', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'user-2',
      email: 'someone-else@user.com',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    });
    mockDbData.invitations = [
      {
        id: 'inv-1',
        organizationId: 'org-1',
        email: 'invitee@user.com',
        role: 'analyst',
        status: 'pending',
        tokenHash: 'x',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        invitedBy: 'user-1',
      },
    ];

    await expect(acceptInvitation('raw-token')).rejects.toThrow(
      'This invitation was issued to a different email address'
    );
  });

  it('rejects when the invitee already has an active membership elsewhere', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'user-2',
      email: 'invitee@user.com',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    });
    vi.mocked(getCurrentMembership).mockResolvedValue({
      id: 'mem-existing',
      organizationId: 'org-OTHER',
      userId: 'user-2',
      role: 'viewer',
      status: 'active',
    });
    mockDbData.invitations = [
      {
        id: 'inv-1',
        organizationId: 'org-1',
        email: 'invitee@user.com',
        role: 'analyst',
        status: 'pending',
        tokenHash: 'x',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        invitedBy: 'user-1',
      },
    ];

    await expect(acceptInvitation('raw-token')).rejects.toThrow('You already belong to an organization');
  });

  it('rejects a revoked invitation', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'user-2',
      email: 'invitee@user.com',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    });
    mockDbData.invitations = [
      {
        id: 'inv-1',
        organizationId: 'org-1',
        email: 'invitee@user.com',
        role: 'analyst',
        status: 'revoked',
        tokenHash: 'x',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        invitedBy: 'user-1',
      },
    ];

    await expect(acceptInvitation('raw-token')).rejects.toThrow('Invitation is no longer valid');
  });
});
