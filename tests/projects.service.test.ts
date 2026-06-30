// tests/projects.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock auth context
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

// Mock db client
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([
      {
        id: 'proj-new-id',
        name: 'New Project',
        description: null,
        status: 'draft',
        organizationId: 'org-1',
      },
    ]),
  },
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
}));

import { createProjectForCurrentOrganization } from '@/lib/projects/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';

describe('Project service - create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authorized roles to create a project', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'organization_admin', status: 'active' },
    });

    const input = {
      name: 'My Project',
      description: 'Test',
      status: 'draft',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createProjectForCurrentOrganization(input as any);
    expect(result.id).toBe('proj-new-id');
    expect(result.organizationId).toBe('org-1');
  });

  it('rejects roles without permission', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
    });
    const input = { name: 'Bad', status: 'draft' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createProjectForCurrentOrganization(input as any)).rejects.toThrow('Permission denied');
  });

  it('fails validation when required fields missing', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: true },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'super_admin', status: 'active' },
    });
    const input = { description: 'no name', status: 'draft' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createProjectForCurrentOrganization(input as any)).rejects.toThrow();
  });
});
