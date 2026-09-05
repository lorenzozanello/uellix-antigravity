// tests/portfolios.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock context
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'new-id', name: 'Test', description: null, status: 'active' }]),
  },
}));

vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>();
  return { ...actual, logAuditAction: vi.fn() };
});

import { createPortfolioForCurrentOrganization } from '@/lib/portfolios/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';

describe('Portfolio service - create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authorized roles to create', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'impact_manager', status: 'active' },
    });

    const input = { name: 'My Portfolio', description: 'desc' };
    const result = await createPortfolioForCurrentOrganization(input);
    expect(result.id).toBe('new-id');
    expect(result.name).toBe('Test');
  });

  it('rejects roles without permission', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
    });
    const input = { name: 'Bad', description: '' };
    await expect(createPortfolioForCurrentOrganization(input)).rejects.toThrow('Permission denied');
  });

  it('fails validation when name missing', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: true },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'super_admin', status: 'active' },
    });
    const input = { description: 'no name' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createPortfolioForCurrentOrganization(input as any)).rejects.toThrow();
  });
});

// FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17) — this file's own readiness-
// adjacent control: the portfolio-level readiness statistic
// getPortfolioAnalytics surfaces is explicitly labelled
// LEGACY_NON_AUTHORITATIVE, never presented as canonical FIBC-021 readiness.
// aggregatePortfolioSroi is pure and needs no DB mock beyond this file's own.
describe('Portfolio service - readiness disposition', () => {
  it('the readiness statistic is presented as LEGACY_NON_AUTHORITATIVE, never canonical readiness', async () => {
    const { aggregatePortfolioSroi } = await import('@/lib/portfolios/analytics');
    const result = aggregatePortfolioSroi([]);
    expect(result.readinessSource).toBe('LEGACY_NON_AUTHORITATIVE');
  });
});
