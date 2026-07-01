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
    const input = { sourceId: SOURCE_UUID, name: 'Proxy X', currency: 'USD', value: '100', unit: 'units', referenceYear: 2023 };
    const inserted = { id: PROXY_UUID, ...input, organizationId: 'org-2', reviewStatus: 'suggested' };
    mockDbData.inserted = inserted;

    const result = await createOrganizationFinancialProxy(input);
    expect(result.reviewStatus).toBe('suggested');
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
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
