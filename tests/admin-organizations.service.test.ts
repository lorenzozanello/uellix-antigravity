/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-organizations.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  orgs: [] as any[],
  readBack: [] as any[],
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/admin/organization-administration', () => ({
  callAdminSetOrganizationStatus: vi.fn(),
  OrganizationAdministrationError: class extends Error {},
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          leftJoin: vi.fn().mockImplementation(() => ({
            groupBy: vi.fn().mockResolvedValue(mockDbData.orgs),
          })),
          where: vi.fn().mockImplementation(() => Promise.resolve(mockDbData.readBack)),
        })),
      })),
      // Present but must never be called: `status` left the runtime UPDATE
      // grant in stella_0011, so a db.update() here would be refused by the
      // ACL for every caller.
      update: vi.fn(),
    },
  };
});

import { listAllOrganizations, setOrganizationStatus } from '@/lib/admin/organizations';
import { callAdminSetOrganizationStatus } from '@/lib/admin/organization-administration';
import { requireAdminAccess } from '@/lib/auth/session';

const ORG = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.orgs = [];
  mockDbData.readBack = [];
});

describe('listAllOrganizations', () => {
  it('requires admin access and returns orgs with member counts', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: ORG, name: 'Acme', slug: 'acme', memberCount: 3 }];

    const result = await listAllOrganizations();

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(3);
  });
});

describe('setOrganizationStatus', () => {
  it('requires admin access and moves status through the capability, not the ORM', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.readBack = [{ id: ORG, name: 'Acme', slug: 'acme', status: 'suspended' }];

    const result = await setOrganizationStatus(ORG, 'suspended');

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(callAdminSetOrganizationStatus).toHaveBeenCalledWith(ORG, 'suspended');
    expect(result.status).toBe('suspended');
  });

  it('never issues a direct UPDATE on organizations', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.readBack = [{ id: ORG, name: 'Acme', slug: 'acme', status: 'active' }];

    const { db } = await import('@/db/client');
    await setOrganizationStatus(ORG, 'active');

    expect(db.update).not.toHaveBeenCalled();

    // …and the call site is gone from the source, not merely unexercised.
    const { readFileSync } = await import('node:fs');
    // Comments stripped: the file's own prose explains why the ORM call is
    // gone, and matching prose would report the explanation as the defect.
    const src = readFileSync('lib/admin/organizations.ts', 'utf8')
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join(String.fromCharCode(10));
    expect(src).not.toMatch(/\.update\(organizations\)/);
  });

  it('propagates the capability refusal without disclosing which case it was', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    vi.mocked(callAdminSetOrganizationStatus).mockRejectedValueOnce(
      new Error('Organization administration refused: organization status')
    );

    await expect(
      setOrganizationStatus('99999999-9999-4999-8999-999999999999', 'suspended')
    ).rejects.toThrow('Organization administration refused');
  });
});
