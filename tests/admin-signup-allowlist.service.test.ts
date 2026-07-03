/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-signup-allowlist.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  entries: [] as any[],
  created: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    SIGNUP_ALLOWLIST_CREATED: 'signup_allowlist.created',
    SIGNUP_ALLOWLIST_REMOVED: 'signup_allowlist.removed',
  },
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          orderBy: vi.fn().mockResolvedValue(mockDbData.entries),
          where: vi.fn().mockImplementation(() => ({
            then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(mockDbData.entries))),
          })),
          then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(mockDbData.entries))),
        })),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.created])),
        })),
      })),
      delete: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

import {
  listSignupAllowlist,
  createSignupAllowlistEntry,
  removeSignupAllowlistEntry,
  isEmailAllowlisted,
} from '@/lib/admin/signup-allowlist';
import { requireAdminAccess } from '@/lib/auth/session';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.entries = [];
  mockDbData.created = {};
});

describe('listSignupAllowlist', () => {
  it('requires admin access', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    await listSignupAllowlist();
    expect(requireAdminAccess).toHaveBeenCalled();
  });
});

describe('createSignupAllowlistEntry', () => {
  it('requires admin access and normalizes an email pattern to lowercase', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.created = { id: 'entry-1', type: 'email', pattern: 'user@acme.com' };

    const result = await createSignupAllowlistEntry({
      type: 'email',
      pattern: 'User@Acme.com',
    });

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result).toEqual(mockDbData.created);
  });

  it('strips a leading @ from a domain pattern instead of rejecting it', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.created = { id: 'entry-2', type: 'domain', pattern: 'acme.com' };

    const result = await createSignupAllowlistEntry({ type: 'domain', pattern: '@acme.com' });
    expect(result).toEqual(mockDbData.created);
  });

  it('rejects a domain pattern with an @ that is not a leading character', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);

    await expect(
      createSignupAllowlistEntry({ type: 'domain', pattern: 'acme@evil.com' })
    ).rejects.toThrow('Invalid domain pattern');
  });

  it('rejects an email pattern with no @', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);

    await expect(
      createSignupAllowlistEntry({ type: 'email', pattern: 'not-an-email' })
    ).rejects.toThrow('Invalid email pattern');
  });
});

describe('removeSignupAllowlistEntry', () => {
  it('rejects when the entry does not exist', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.entries = [];

    await expect(removeSignupAllowlistEntry('missing')).rejects.toThrow('Entry not found');
  });

  it('deletes an existing entry', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.entries = [{ id: 'entry-1', type: 'email', pattern: 'user@acme.com' }];

    await expect(removeSignupAllowlistEntry('entry-1')).resolves.toBeUndefined();
  });
});

describe('isEmailAllowlisted', () => {
  it('matches an exact email entry case-insensitively', async () => {
    mockDbData.entries = [{ type: 'email', pattern: 'user@acme.com' }];
    await expect(isEmailAllowlisted('User@Acme.com')).resolves.toBe(true);
  });

  it('matches a domain entry', async () => {
    mockDbData.entries = [{ type: 'domain', pattern: 'acme.com' }];
    await expect(isEmailAllowlisted('anyone@acme.com')).resolves.toBe(true);
  });

  it('returns false when nothing matches', async () => {
    mockDbData.entries = [{ type: 'domain', pattern: 'acme.com' }];
    await expect(isEmailAllowlisted('user@other.com')).resolves.toBe(false);
  });

  it('does not call requireAdminAccess (used by unauthenticated-org-context signup flow)', async () => {
    mockDbData.entries = [];
    await isEmailAllowlisted('user@acme.com');
    expect(requireAdminAccess).not.toHaveBeenCalled();
  });
});
