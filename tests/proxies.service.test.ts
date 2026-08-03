/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/proxies.service.test.ts

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Use vi.hoisted to define mockDbData before vi.mock hoisting
const mockDbData = vi.hoisted(() => ({
  proxySources: [] as any[],
  financialProxies: [] as any[],
  outcomeProxyAssignments: [] as any[],
  projects: [] as any[],
  outcomes: [] as any[],
  inserted: {} as any,
  updated: {} as any,
  lastInsertValues: null as any,
}));

// Mock authentication/session utilities
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
  requireOrganizationAccess: vi.fn(),
}));

// Mock permission check
vi.mock('@/lib/auth/permissions', () => ({
  canApproveProxy: vi.fn(),
}));

// Mock audit logger
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    ORGANIZATION_UPDATED: 'organization_updated',
  },
}));

// Mock DB client using robust builder
vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          let dataToReturn: any[] = [];
          if (tableName === 'proxy_sources') dataToReturn = mockDbData.proxySources;
          else if (tableName === 'financial_proxies') dataToReturn = mockDbData.financialProxies;
          else if (tableName === 'outcome_proxy_assignments') dataToReturn = mockDbData.outcomeProxyAssignments;
          else if (tableName === 'projects') dataToReturn = mockDbData.projects;
          else if (tableName === 'outcomes') dataToReturn = mockDbData.outcomes;

          const fromObj = {
            where: vi.fn().mockImplementation(() => {
              const whereObj = {
                then: vi.fn().mockImplementation((callback) => {
                  return Promise.resolve(callback(dataToReturn));
                }),
              };
              return whereObj;
            }),
            then: vi.fn().mockImplementation((callback) => {
              return Promise.resolve(callback(dataToReturn));
            }),
          };
          return fromObj;
        }),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((values) => {
          mockDbData.lastInsertValues = values;
          return {
            returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.inserted])),
          };
        }),
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
  listProxySources,
  createOrganizationProxySource,
  archiveProxySource,
  listFinancialProxies,
  createOrganizationFinancialProxy,
  updateFinancialProxyReviewStatus,
  assignProxyToOutcome,
  archiveOutcomeProxyAssignment,
} from '@/lib/pipeline/proxies';

// Real RFC 4122 version 4 UUIDs for Zod schema validation
const SOURCE_UUID = '550e8400-e29b-41d4-a716-446655440001';
const PROXY_UUID = '550e8400-e29b-41d4-a716-446655440002';
const OUTCOME_UUID = '550e8400-e29b-41d4-a716-446655440003';
const PROJECT_UUID = '550e8400-e29b-41d4-a716-446655440004';
const ASSIGNMENT_UUID = '550e8400-e29b-41d4-a716-446655440005';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.proxySources = [];
  mockDbData.financialProxies = [];
  mockDbData.outcomeProxyAssignments = [];
  mockDbData.projects = [];
  mockDbData.outcomes = [];
  mockDbData.inserted = {};
  mockDbData.updated = {};
  mockDbData.lastInsertValues = null;
});

/*** Proxy Sources ***/
describe('Proxy Sources Service', () => {
  it('listProxySources returns system sources when no org context', async () => {
    const { getCurrentOrganizationContext } = await import('@/lib/auth/session');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(null);
    mockDbData.proxySources = [];
    const result = await listProxySources();
    expect(result).toEqual([]);
  });

  it('createOrganizationProxySource inserts a row and logs audit', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-1' }, user: { id: 'user-1' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    const input = { name: 'Source A', description: 'Desc', url: 'https://example.com' };
    const inserted = { id: SOURCE_UUID, ...input, organizationId: 'org-1', status: 'active', createdBy: 'user-1' };
    mockDbData.inserted = inserted;

    const result = await createOrganizationProxySource(input);
    expect(result).toMatchObject(inserted);
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('archiveProxySource performs logical archive and logs audit', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-1' }, user: { id: 'user-2' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    const source = { id: SOURCE_UUID, organizationId: 'org-1', status: 'active' };
    mockDbData.proxySources = [source];

    const updated = { ...source, status: 'archived' };
    mockDbData.updated = updated;

    const result = await archiveProxySource(SOURCE_UUID);
    expect(result).toMatchObject(updated);
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('archiveProxySource rejects a system (org-less) source even for isSuperAdmin=true (admin-only via lib/admin/proxies.ts)', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-1' }, user: { id: 'user-2', isSuperAdmin: true } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    const source = { id: SOURCE_UUID, organizationId: null, status: 'active' };
    mockDbData.proxySources = [source];

    await expect(archiveProxySource(SOURCE_UUID)).rejects.toThrow('Forbidden');
  });
});

/*** Financial Proxies ***/
describe('Financial Proxies Service', () => {
  it('listFinancialProxies returns only approved system proxies when no org', async () => {
    const { getCurrentOrganizationContext } = await import('@/lib/auth/session');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(null);
    mockDbData.financialProxies = [];
    const result = await listFinancialProxies();
    expect(result).toEqual([]);
  });

  it('createOrganizationFinancialProxy sets status to suggested and logs audit', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-2' }, user: { id: 'user-3' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    // RC-12: the named source must be usable by the caller's organisation.
    mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: 'org-2', status: 'active' }];
    const input = { sourceId: SOURCE_UUID, name: 'Proxy X', currency: 'USD', value: '100', unit: 'units', referenceYear: 2023 };
    const inserted = { id: PROXY_UUID, ...input, organizationId: 'org-2', reviewStatus: 'suggested' };
    mockDbData.inserted = inserted;

    const result = await createOrganizationFinancialProxy(input);
    expect(result.reviewStatus).toBe('suggested');
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // RC-12 / reaudit M5 — sourceId ownership gate on financial proxy creation.
  // The mocked select ignores WHERE clauses, so each case seeds exactly the
  // row the id would resolve to; an empty table IS the nonexistent id.
  // -------------------------------------------------------------------------
  describe('createOrganizationFinancialProxy — source ownership (RC-12)', () => {
    const CALLER_ORG = 'org-2';
    const baseInput = { sourceId: SOURCE_UUID, name: 'Proxy X', currency: 'USD', value: '100', unit: 'units', referenceYear: 2023 };

    async function asCallerOrg() {
      const { requireOrganizationAccess } = await import('@/lib/auth/session');
      vi.mocked(requireOrganizationAccess).mockResolvedValue(
        { organization: { id: CALLER_ORG }, user: { id: 'user-3' } } as any
      );
    }

    it('allows a source owned by the caller organisation', async () => {
      await asCallerOrg();
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: CALLER_ORG, status: 'active' }];
      mockDbData.inserted = { id: PROXY_UUID, reviewStatus: 'suggested' };
      await expect(createOrganizationFinancialProxy(baseInput)).resolves.toBeDefined();
    });

    it('allows an ACTIVE global source (organizationId null)', async () => {
      await asCallerOrg();
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: null, status: 'active' }];
      mockDbData.inserted = { id: PROXY_UUID, reviewStatus: 'suggested' };
      await expect(createOrganizationFinancialProxy(baseInput)).resolves.toBeDefined();
    });

    it('rejects an archived global source', async () => {
      await asCallerOrg();
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: null, status: 'archived' }];
      await expect(createOrganizationFinancialProxy(baseInput)).rejects.toThrow('Source not found');
    });

    it("rejects another organisation's source", async () => {
      await asCallerOrg();
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: 'other-org', status: 'active' }];
      await expect(createOrganizationFinancialProxy(baseInput)).rejects.toThrow('Source not found');
    });

    it('a nonexistent id is INDISTINGUISHABLE from a foreign one — same uniform error', async () => {
      await asCallerOrg();
      mockDbData.proxySources = []; // the id resolves to nothing
      const nonexistent = createOrganizationFinancialProxy(baseInput).catch((e: Error) => e.message);
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: 'other-org', status: 'active' }];
      const foreign = createOrganizationFinancialProxy(baseInput).catch((e: Error) => e.message);
      expect(await nonexistent).toBe('Source not found');
      expect(await foreign).toBe(await nonexistent);
    });

    it('a client-supplied organizationId neither widens the scope nor lands in the row', async () => {
      await asCallerOrg();
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: CALLER_ORG, status: 'active' }];
      mockDbData.inserted = { id: PROXY_UUID, reviewStatus: 'suggested' };
      // The extra field is not in the Zod schema — parse() drops it — and the
      // insert always carries the SESSION organisation.
      await createOrganizationFinancialProxy({ ...baseInput, organizationId: 'attacker-org' });
      expect(mockDbData.lastInsertValues.organizationId).toBe(CALLER_ORG);
    });

    it('the inserted row carries the session organisation and creator', async () => {
      await asCallerOrg();
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: CALLER_ORG, status: 'active' }];
      mockDbData.inserted = { id: PROXY_UUID, reviewStatus: 'suggested' };
      await createOrganizationFinancialProxy(baseInput);
      expect(mockDbData.lastInsertValues.organizationId).toBe(CALLER_ORG);
      expect(mockDbData.lastInsertValues.createdBy).toBe('user-3');
      expect(mockDbData.lastInsertValues.sourceId).toBe(SOURCE_UUID);
    });
  });

  it('updateFinancialProxyReviewStatus only allows permitted roles', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const { canApproveProxy } = await import('@/lib/auth/permissions');
    const ctx = { organization: { id: 'org-3' }, user: { isSuperAdmin: false }, membership: { role: 'organization_admin' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    vi.mocked(canApproveProxy).mockReturnValue(true);
    const proxy = { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'unit', referenceYear: 2023 };
    mockDbData.financialProxies = [proxy];

    const updated = { ...proxy, reviewStatus: 'approved' };
    mockDbData.updated = updated;

    const result = await updateFinancialProxyReviewStatus(PROXY_UUID, 'approved');
    expect(result.reviewStatus).toBe('approved');
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('updateFinancialProxyReviewStatus rejects a proxy owned by a different organization (IDOR regression)', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const { canApproveProxy } = await import('@/lib/auth/permissions');
    // Caller belongs to org-99, but the proxy belongs to org-3
    const ctx = { organization: { id: 'org-99' }, user: { isSuperAdmin: false }, membership: { role: 'organization_admin' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    vi.mocked(canApproveProxy).mockReturnValue(true);
    const proxy = { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'unit', referenceYear: 2023 };
    mockDbData.financialProxies = [proxy];

    await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved')).rejects.toThrow('Forbidden');
  });

  it('updateFinancialProxyReviewStatus rejects a non-super-admin acting on a system (org-less) proxy', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const { canApproveProxy } = await import('@/lib/auth/permissions');
    const ctx = { organization: { id: 'org-1' }, user: { isSuperAdmin: false }, membership: { role: 'organization_admin' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    vi.mocked(canApproveProxy).mockReturnValue(true);
    const proxy = { id: PROXY_UUID, organizationId: null, reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'unit', referenceYear: 2023 };
    mockDbData.financialProxies = [proxy];

    await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved')).rejects.toThrow('Forbidden');
  });

  it('updateFinancialProxyReviewStatus rejects a system (org-less) proxy even for isSuperAdmin=true (system proxies are admin-only via lib/admin/proxies.ts)', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const { canApproveProxy } = await import('@/lib/auth/permissions');
    // Caller is flagged isSuperAdmin, but is also an org member (the only
    // way this org-scoped function is reachable at all — a pure super_admin
    // with no membership is redirected away by requireOrganizationAccess()
    // before this function body runs). Even so, system proxies must not be
    // approvable through this path; lib/admin/proxies.ts is the only route.
    const ctx = { organization: { id: 'org-1' }, user: { isSuperAdmin: true }, membership: { role: 'organization_admin' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    vi.mocked(canApproveProxy).mockReturnValue(true);
    const proxy = { id: PROXY_UUID, organizationId: null, reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'unit', referenceYear: 2023 };
    mockDbData.financialProxies = [proxy];

    await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved')).rejects.toThrow('Forbidden');
  });
});

/*** Proxy Assignments ***/
describe('Proxy Assignment Service', () => {
  it('assignProxyToOutcome validates project, outcome and proxy visibility', async () => {
    const { requireOrganizationAccess, getCurrentOrganizationContext } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-4' }, user: { id: 'user-4' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctx);

    const project = { id: PROJECT_UUID, organizationId: 'org-4' };
    const outcome = { id: OUTCOME_UUID, projectId: PROJECT_UUID };
    const proxy = { id: PROXY_UUID, organizationId: null, reviewStatus: 'approved', value: '100', currency: 'USD', unit: 'unit', referenceYear: 2023 };

    mockDbData.projects = [project];
    mockDbData.outcomes = [outcome];
    mockDbData.financialProxies = [proxy];

    const inserted = { id: ASSIGNMENT_UUID, projectId: PROJECT_UUID, outcomeId: OUTCOME_UUID, proxyId: PROXY_UUID };
    mockDbData.inserted = inserted;

    const input = { outcomeId: OUTCOME_UUID, proxyId: PROXY_UUID, justification: 'test' };
    const result = await assignProxyToOutcome(PROJECT_UUID, input);
    expect(result).toMatchObject(inserted);
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('archiveOutcomeProxyAssignment performs logical archive', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-5' }, user: { id: 'user-5' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    const assignment = { id: ASSIGNMENT_UUID, projectId: PROJECT_UUID, organizationId: 'org-5' };
    mockDbData.outcomeProxyAssignments = [assignment];

    const updated = { ...assignment, assignmentStatus: 'archived', archivedBy: 'user-5' };
    mockDbData.updated = updated;

    const result = await archiveOutcomeProxyAssignment(PROJECT_UUID, ASSIGNMENT_UUID);
    expect(result).toBe(true);
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });
});
