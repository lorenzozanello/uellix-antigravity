/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-stella-services.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  orgs: [] as any[],
  usageCounts: {} as Record<string, number>,
  // SUM(tokens_used) mock: drizzle's sum() returns string | null from the
  // driver, so the mock stores it exactly like that.
  tokenSums: {} as Record<string, string | null>,
  updated: {} as any,
  beforeOrg: null as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

// The audit logger is NOT mocked any more, and the absence is the assertion:
// since RR-CAP-10-A the definer writes the change and its audit row in one
// transaction, so a `logAuditAction` call from this module would be a SECOND
// row for one decision. If the import came back, this file would fail to
// resolve it rather than quietly double-count.
vi.mock('@/lib/admin/organization-administration', () => ({
  callAdminSetStellaService: vi.fn(),
  OrganizationAdministrationError: class extends Error {},
}));

vi.mock('@/lib/stella/quota', () => ({
  startOfCurrentUtcMonth: vi.fn().mockImplementation(() => new Date(0)),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      // fields is the object passed to db.select({...}); its shape tells us
      // which query is being issued (mirrors tests/stella-quota.test.ts).
      select: vi.fn().mockImplementation((fields?: Record<string, unknown>) => ({
        from: vi.fn().mockImplementation(() => {
          const isOrgListQuery = fields && 'id' in fields && 'stellaMonthlyQuota' in fields;
          const isOrgBeforeQuery =
            fields &&
            !('id' in fields) &&
            'stellaMonthlyQuota' in fields &&
            'stellaPlanLabel' in fields;
          const isCountQuery = fields && 'value' in fields;

          return {
            then: (cb: (rows: unknown[]) => unknown) => {
              if (isOrgListQuery) return Promise.resolve(cb(mockDbData.orgs));
              return Promise.resolve(cb([]));
            },
            where: vi.fn().mockImplementation(() => ({
              then: (cb: (rows: unknown[]) => unknown) => {
                if (isOrgBeforeQuery) {
                  return Promise.resolve(
                    cb(mockDbData.beforeOrg ? [mockDbData.beforeOrg] : [])
                  );
                }
                // The read-back after the definer call: same field shape as the
                // list query, but reached through .where().
                if (isOrgListQuery) {
                  return Promise.resolve(
                    cb(mockDbData.updated && 'id' in mockDbData.updated ? [mockDbData.updated] : [])
                  );
                }
                if (isCountQuery) {
                  // organizationId isn't accessible here since `where` args aren't
                  // threaded through this mock; tests that need per-org usage counts
                  // use a single org id ('org-1') to keep this simple.
                  return Promise.resolve(
                    cb([
                      {
                        value: mockDbData.usageCounts['org-1'] ?? 0,
                        tokens: mockDbData.tokenSums['org-1'] ?? null,
                      },
                    ])
                  );
                }
                return Promise.resolve(cb([]));
              },
            })),
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

import { listOrganizationsWithStellaUsage, updateOrganizationStellaService } from '@/lib/admin/stella-services';
import { callAdminSetStellaService } from '@/lib/admin/organization-administration';
import { requireAdminAccess } from '@/lib/auth/session';
import { estimateCostUsd } from '@/lib/stella/cost-model';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.orgs = [];
  mockDbData.usageCounts = {};
  mockDbData.tokenSums = {};
  mockDbData.updated = {};
  mockDbData.beforeOrg = null;
});

describe('listOrganizationsWithStellaUsage', () => {
  it('requires admin access', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' }];
    mockDbData.usageCounts = { 'org-1': 12 };

    const result = await listOrganizationsWithStellaUsage();

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].usedThisMonth).toBe(12);
  });

  it('computes real usage via a direct count query even when quota is 0 (unassigned)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 0, stellaPlanLabel: null }];
    mockDbData.usageCounts = { 'org-1': 7 };

    const result = await listOrganizationsWithStellaUsage();

    expect(result[0].usedThisMonth).toBe(7);
  });

  it('computes real usage via a direct count query even when quota is null (unlimited)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: null, stellaPlanLabel: 'Internal' }];
    mockDbData.usageCounts = { 'org-1': 25 };

    const result = await listOrganizationsWithStellaUsage();

    expect(result[0].usedThisMonth).toBe(25);
  });

  it('aggregates tokensThisMonth from SUM(tokens_used) and derives estimatedCostUsd via the cost model', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' }];
    mockDbData.usageCounts = { 'org-1': 3 };
    // Drizzle SUM comes back as a string from the pg driver.
    mockDbData.tokenSums = { 'org-1': '1000000' };

    const result = await listOrganizationsWithStellaUsage();

    expect(result[0].tokensThisMonth).toBe(1_000_000);
    expect(result[0].estimatedCostUsd).toBeCloseTo(estimateCostUsd(1_000_000), 10);
    expect(result[0].estimatedCostUsd).toBeGreaterThan(0);
  });

  it('reports 0 tokens and 0 cost when SUM(tokens_used) is null (no rows / all-null tokens)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 0, stellaPlanLabel: null }];
    mockDbData.usageCounts = { 'org-1': 0 };
    mockDbData.tokenSums = { 'org-1': null };

    const result = await listOrganizationsWithStellaUsage();

    expect(result[0].tokensThisMonth).toBe(0);
    expect(result[0].estimatedCostUsd).toBe(0);
  });
});

const ORG = '11111111-1111-4111-8111-111111111111';

describe('updateOrganizationStellaService', () => {
  it('requires admin access and moves the quota through the capability, not the ORM', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.updated = { id: ORG, name: 'Acme', stellaMonthlyQuota: 100, stellaPlanLabel: 'Enterprise' };

    const result = await updateOrganizationStellaService(ORG, {
      planLabel: 'Enterprise',
      monthlyQuota: 100,
    });

    expect(requireAdminAccess).toHaveBeenCalled();
    // The point of RR-CAP-10-A: the write goes through the definer. Since
    // stella_0011 the ORM cannot reach these columns at all, so a db.update()
    // here would be refused by the ACL for every caller, super_admin included.
    expect(callAdminSetStellaService).toHaveBeenCalledWith(ORG, {
      monthlyQuota: 100,
      planLabel: 'Enterprise',
    });
    expect(result.stellaMonthlyQuota).toBe(100);
  });

  it('never issues a direct UPDATE on organizations', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.updated = { id: ORG, name: 'Acme', stellaMonthlyQuota: 10, stellaPlanLabel: 'Pro' };

    const { db } = await import('@/db/client');
    await updateOrganizationStellaService(ORG, { planLabel: 'Pro', monthlyQuota: 10 });

    expect(db.update).not.toHaveBeenCalled();
  });

  it('writes no audit row of its own: the definer already wrote one', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.updated = { id: ORG, name: 'Acme', stellaMonthlyQuota: 10, stellaPlanLabel: 'Pro' };

    await updateOrganizationStellaService(ORG, { planLabel: 'Pro', monthlyQuota: 10 });

    // Read from the module source rather than a spy: a spy can only prove the
    // mock was not called, and the risk here is that somebody re-adds the
    // import. This proves the call site is gone.
    const { readFileSync } = await import('node:fs');
    // Comments stripped first: this file's own prose EXPLAINS why the ORM call
    // is gone, and a naive match would find the explanation and call it the
    // defect. The assertion is about code, so it has to read code.
    const src = readFileSync('lib/admin/stella-services.ts', 'utf8')
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join(String.fromCharCode(10));
    expect(src).not.toMatch(/logAuditAction\(/);
    expect(src).not.toMatch(/\.update\(organizations\)/);
  });

  it('accepts null monthlyQuota, which the runtime reads as unlimited', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.updated = { id: ORG, name: 'Acme', stellaMonthlyQuota: null, stellaPlanLabel: 'Internal' };

    const result = await updateOrganizationStellaService(ORG, {
      planLabel: 'Internal',
      monthlyQuota: null,
    });

    expect(callAdminSetStellaService).toHaveBeenCalledWith(ORG, {
      monthlyQuota: null,
      planLabel: 'Internal',
    });
    expect(result.stellaMonthlyQuota).toBeNull();
  });

  it('rejects a negative quota before reaching the capability', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);

    await expect(
      updateOrganizationStellaService(ORG, { planLabel: 'Bad', monthlyQuota: -5 })
    ).rejects.toThrow();
    expect(callAdminSetStellaService).not.toHaveBeenCalled();
  });

  it('propagates the capability refusal for an organisation that does not exist', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    vi.mocked(callAdminSetStellaService).mockRejectedValueOnce(
      new Error('Organization administration refused: stella service')
    );

    // Uniform refusal by design: "no such organisation" is indistinguishable
    // from "you are not a super_admin", so this endpoint cannot enumerate ids.
    await expect(
      updateOrganizationStellaService('99999999-9999-4999-8999-999999999999', {
        planLabel: 'Pro',
        monthlyQuota: 100,
      })
    ).rejects.toThrow('Organization administration refused');
  });
});
