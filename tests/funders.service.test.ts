import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFunder, listFundersForOrganization } from '@/lib/pipeline/funders';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';
import { logAuditAction } from '@/lib/audit/logger';
import type { OrganizationContext } from '@/lib/auth/session';

vi.mock('@/lib/auth/session');
vi.mock('@/db/client');
vi.mock('@/lib/audit/logger');

function createMockContext(): OrganizationContext {
  return {
    organization: {
      id: 'org-1',
      name: 'Test Org',
      slug: 'test-org',
      legalName: null,
      country: null,
      sector: null,
      status: 'active',
    },
    user: {
      id: 'user-1',
      email: 'test@example.com',
      fullName: 'Test User',
      avatarUrl: null,
      isSuperAdmin: false,
    },
    membership: {
      id: 'mem-1',
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'analyst',
      status: 'active',
    },
  };
}

describe('Funders service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a funder for the current organization', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(createMockContext());

    const mockFunder = {
      id: 'funder-1',
      organizationId: 'org-1',
      name: 'Foundation X',
      funderType: 'foundation',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockReturning = vi.fn().mockResolvedValue([mockFunder]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    vi.mocked(db).insert = mockInsert;

    vi.mocked(logAuditAction).mockResolvedValue(undefined);

    const result = await createFunder('Foundation X', 'foundation');

    expect(result).toEqual(mockFunder);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('lists all funders for the organization', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(createMockContext());

    const mockFunders = [
      { id: 'funder-1', organizationId: 'org-1', name: 'Foundation', funderType: 'foundation' },
      { id: 'funder-2', organizationId: 'org-1', name: 'Private', funderType: 'private' },
    ];

    const mockWhere = vi.fn().mockReturnValue({ execute: vi.fn().mockResolvedValue(mockFunders) });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    vi.mocked(db).select = mockSelect;

    const result = await listFundersForOrganization();

    expect(result).toEqual(mockFunders);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('rejects invalid funder type', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(createMockContext());

    // @ts-expect-error - Testing runtime validation with invalid string type
    await expect(createFunder('Bad Funder', 'invalid_type')).rejects.toThrow();
  });
});
