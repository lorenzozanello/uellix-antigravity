import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFunder, listFundersForOrganization } from '@/lib/pipeline/funders';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';
import { logAuditAction } from '@/lib/audit/logger';

vi.mock('@/lib/auth/session');
vi.mock('@/db/client');
vi.mock('@/lib/audit/logger');

describe('Funders service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a funder for the current organization', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

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
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    const mockFunders = [
      { id: 'funder-1', organizationId: 'org-1', name: 'Foundation', funderType: 'foundation' },
      { id: 'funder-2', organizationId: 'org-1', name: 'Private', funderType: 'private' },
    ];

    const mockExecute = vi.fn().mockResolvedValue(mockFunders);
    const mockWhere = vi.fn().mockReturnValue({ execute: mockExecute });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    vi.mocked(db).select = mockSelect;

    const result = await listFundersForOrganization();

    expect(result).toEqual(mockFunders);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('rejects invalid funder type', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    await expect(createFunder('Bad Funder', 'invalid_type' as any)).rejects.toThrow();
  });
});
