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
  lastUpdateValues: null as any,
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
    FINANCIAL_PROXY_CREATED: 'financial_proxy_created',
    FINANCIAL_PROXY_UPDATED: 'financial_proxy_updated',
    FINANCIAL_PROXY_REVIEW_STATUS_CHANGED: 'financial_proxy_review_status_changed',
  },
}));

// Mock DB client using robust builder
vi.mock('@/db/client', () => {
  const database: any = {
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(database)),
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          let dataToReturn: any[] = [];
          if (tableName === 'proxy_sources') dataToReturn = mockDbData.proxySources;
          else if (tableName === 'financial_proxies') dataToReturn = mockDbData.financialProxies;
          else if (tableName === 'outcome_proxy_assignments') dataToReturn = mockDbData.outcomeProxyAssignments;
          else if (tableName === 'projects') dataToReturn = mockDbData.projects;
          else if (tableName === 'outcomes') dataToReturn = mockDbData.outcomes;

          const fromObj: any = {
            where: vi.fn().mockImplementation(() => {
              const whereObj: any = {
                then: vi.fn().mockImplementation((callback) => {
                  return Promise.resolve(callback(dataToReturn));
                }),
              };
              whereObj.for = vi.fn().mockImplementation(() => whereObj);
              return whereObj;
            }),
            then: vi.fn().mockImplementation((callback) => {
              return Promise.resolve(callback(dataToReturn));
            }),
          };
          fromObj.for = vi.fn().mockImplementation(() => fromObj);
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
        set: vi.fn().mockImplementation((values) => {
          mockDbData.lastUpdateValues = values;
          return {
            where: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.updated])),
            })),
          };
        }),
      })),
  };
  return { db: database };
});

import {
  listProxySources,
  createOrganizationProxySource,
  updateOrganizationProxySource,
  archiveProxySource,
  listFinancialProxies,
  createOrganizationFinancialProxy,
  updateOrganizationFinancialProxy,
  updateFinancialProxyReviewStatus,
  fingerprintFinancialProxyApprovalState,
  assignProxyToOutcome,
  archiveOutcomeProxyAssignment,
} from '@/lib/pipeline/proxies';

// Real RFC 4122 version 4 UUIDs for Zod schema validation
const SOURCE_UUID = '550e8400-e29b-41d4-a716-446655440001';
const PROXY_UUID = '550e8400-e29b-41d4-a716-446655440002';
const OUTCOME_UUID = '550e8400-e29b-41d4-a716-446655440003';
const PROJECT_UUID = '550e8400-e29b-41d4-a716-446655440004';
const ASSIGNMENT_UUID = '550e8400-e29b-41d4-a716-446655440005';

function reviewedStateOf(proxy: Record<string, unknown>) {
  return fingerprintFinancialProxyApprovalState({
    id: String(proxy.id),
    organizationId: (proxy.organizationId as string | null | undefined) ?? null,
    sourceId: (proxy.sourceId as string | null | undefined) ?? null,
    value: (proxy.value as string | null | undefined) ?? null,
    currency: (proxy.currency as string | null | undefined) ?? null,
    unit: (proxy.unit as string | null | undefined) ?? null,
    referenceYear: (proxy.referenceYear as number | null | undefined) ?? null,
    valueUsd: (proxy.valueUsd as string | null | undefined) ?? null,
    fxRateId: (proxy.fxRateId as string | null | undefined) ?? null,
    reviewStatus: (proxy.reviewStatus as string | null | undefined) ?? null,
  } as any);
}

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
  mockDbData.lastUpdateValues = null;
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

  it('W1-05-RM1 R-2: updateOrganizationProxySource records a content-modifying update with real prior state', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-1' }, user: { id: 'user-2' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    const source = { id: SOURCE_UUID, organizationId: 'org-1', status: 'active', name: 'Old name' };
    mockDbData.proxySources = [source];
    mockDbData.updated = { ...source, name: 'New name' };

    await updateOrganizationProxySource(SOURCE_UUID, { name: 'New name' });

    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        contentModifying: true,
        beforeJson: source,
      })
    );
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

  it('W1-05-RM1 R-2: updateOrganizationFinancialProxy records a content-modifying update with real prior state', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const ctx = { organization: { id: 'org-2' }, user: { id: 'user-3' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    const proxy = {
      id: PROXY_UUID,
      organizationId: 'org-2',
      sourceId: SOURCE_UUID,
      name: 'Old name',
      currency: 'USD',
      value: '100',
      unit: 'units',
      referenceYear: 2023,
      reviewStatus: 'suggested',
    };
    mockDbData.financialProxies = [proxy];
    mockDbData.updated = { ...proxy, name: 'New name' };

    await updateOrganizationFinancialProxy(PROXY_UUID, { name: 'New name' });

    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        contentModifying: true,
        beforeJson: proxy,
      })
    );
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

  // ---------------------------------------------------------------------------
  // updateOrganizationFinancialProxy — precondition 2 of the capability-design
  // unit. The export had NO call site and NO dedicated test, so two invariants
  // it carries were unpinned: the RC-12 source-ownership gate applied again on
  // re-pointing, and the re-review reset that stops an approved proxy from
  // keeping its "approved" label after a material field changes.
  //
  // Keeping the export unreferenced is deliberate (see the capability model:
  // the proxy edit surface is not wired yet). Pinning it here means that when
  // it IS wired, the gates cannot have silently rotted in the meantime.
  //
  // The mocked select ignores WHERE clauses, so each case seeds exactly the row
  // the id would resolve to; an empty table IS the nonexistent id.
  // ---------------------------------------------------------------------------
  describe('updateOrganizationFinancialProxy — ownership and re-review gates', () => {
    const CALLER_ORG = 'org-upd';
    const approvedProxy = {
      id: PROXY_UUID,
      organizationId: CALLER_ORG,
      reviewStatus: 'approved',
      value: '100',
      currency: 'USD',
      unit: 'units',
      referenceYear: 2023,
      name: 'Proxy U',
      sourceId: SOURCE_UUID,
    };

    async function asCallerOrg() {
      const { requireOrganizationAccess } = await import('@/lib/auth/session');
      vi.mocked(requireOrganizationAccess).mockResolvedValue(
        { organization: { id: CALLER_ORG }, user: { id: 'user-upd' } } as any
      );
    }

    it('rejects a nonexistent proxy', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [];
      await expect(updateOrganizationFinancialProxy(PROXY_UUID, { name: 'New' }))
        .rejects.toThrow('Proxy not found');
    });

    it("rejects another organisation's proxy", async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [{ ...approvedProxy, organizationId: 'other-org' }];
      await expect(updateOrganizationFinancialProxy(PROXY_UUID, { name: 'New' }))
        .rejects.toThrow('Forbidden');
    });

    it('rejects re-pointing at another organisation\'s source (RC-12 applies on update, not only on create)', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: 'other-org', status: 'active' }];
      await expect(updateOrganizationFinancialProxy(PROXY_UUID, { sourceId: SOURCE_UUID }))
        .rejects.toThrow('Source not found');
      // The refusal happens BEFORE any write.
      expect(mockDbData.lastUpdateValues).toBeNull();
    });

    it('allows re-pointing at an active global source', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.proxySources = [{ id: SOURCE_UUID, organizationId: null, status: 'active' }];
      mockDbData.updated = { ...approvedProxy };
      await expect(updateOrganizationFinancialProxy(PROXY_UUID, { sourceId: SOURCE_UUID }))
        .resolves.toBeDefined();
    });

    it('treats sourceId reattachment as material and resets an existing approval', async () => {
      await asCallerOrg();
      const replacementSourceId = '550e8400-e29b-41d4-a716-446655440099';
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.proxySources = [{ id: replacementSourceId, organizationId: null, status: 'active' }];
      mockDbData.updated = { ...approvedProxy, sourceId: replacementSourceId, reviewStatus: 'pending_review' };

      await updateOrganizationFinancialProxy(PROXY_UUID, { sourceId: replacementSourceId });

      expect(mockDbData.lastUpdateValues.reviewStatus).toBe('pending_review');
    });

    it('resets an APPROVED proxy to pending_review when a material field changes', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.updated = { ...approvedProxy, value: '250', reviewStatus: 'pending_review' };

      await updateOrganizationFinancialProxy(PROXY_UUID, { value: '250' });

      expect(mockDbData.lastUpdateValues.reviewStatus).toBe('pending_review');
      const { logAuditAction } = await import('@/lib/audit/logger');
      expect(logAuditAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'financial_proxy_review_status_changed',
          reason: expect.stringContaining('Approval reset'),
        })
      );
    });

    it('does NOT reset when a non-material field changes', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.updated = { ...approvedProxy, name: 'Renamed' };

      await updateOrganizationFinancialProxy(PROXY_UUID, { name: 'Renamed' });

      expect(mockDbData.lastUpdateValues.reviewStatus).toBeUndefined();
      const { logAuditAction } = await import('@/lib/audit/logger');
      expect(logAuditAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'financial_proxy_updated' })
      );
    });

    it('does NOT reset a proxy that was never approved — the gate protects an approval, and there is none', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [{ ...approvedProxy, reviewStatus: 'suggested' }];
      mockDbData.updated = { ...approvedProxy, reviewStatus: 'suggested', value: '250' };

      await updateOrganizationFinancialProxy(PROXY_UUID, { value: '250' });

      expect(mockDbData.lastUpdateValues.reviewStatus).toBeUndefined();
    });

    it('a material field re-submitted with the SAME value is not a change — no spurious reset', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.updated = { ...approvedProxy };

      await updateOrganizationFinancialProxy(PROXY_UUID, { value: '100', referenceYear: 2023 });

      expect(mockDbData.lastUpdateValues.reviewStatus).toBeUndefined();
    });

    it('a client-supplied organizationId cannot move the row to another tenant', async () => {
      await asCallerOrg();
      mockDbData.financialProxies = [approvedProxy];
      mockDbData.updated = { ...approvedProxy };

      // Not in the Zod schema — partial().parse() drops it, so it never
      // reaches the SET clause.
      await updateOrganizationFinancialProxy(PROXY_UUID, { name: 'X', organizationId: 'attacker-org' });

      expect(mockDbData.lastUpdateValues.organizationId).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // CL-2B/CL-2C (PROX-01) — a material value/currency/referenceYear edit on
    // an approved proxy must invalidate the previously frozen valueUsd/fxRateId,
    // not just reset reviewStatus. Otherwise resolveProxyValueUsd's
    // `if (proxy.valueUsd) return ...` short-circuit lets re-approval reuse a
    // USD figure derived from the OLD value/currency — a deterministic SROI
    // calculation would then silently consume a number the reviewer never saw.
    // -------------------------------------------------------------------------
    describe('CL-2B — material USD-derivation edits invalidate the frozen valueUsd/fxRateId', () => {
      const frozenProxy = {
        ...approvedProxy,
        value: '100',
        currency: 'USD',
        valueUsd: '100',
        fxRateId: null,
      };

      it('a `value` edit invalidates the frozen valueUsd and fxRateId', async () => {
        await asCallerOrg();
        mockDbData.financialProxies = [{ ...frozenProxy, fxRateId: 'fx-1' }];
        mockDbData.updated = { ...frozenProxy, value: '250', reviewStatus: 'pending_review', valueUsd: null, fxRateId: null };

        await updateOrganizationFinancialProxy(PROXY_UUID, { value: '250' });

        expect(mockDbData.lastUpdateValues.valueUsd).toBeNull();
        expect(mockDbData.lastUpdateValues.fxRateId).toBeNull();
        expect(mockDbData.lastUpdateValues.reviewStatus).toBe('pending_review');
      });

      it('a `currency` edit invalidates the frozen valueUsd and fxRateId', async () => {
        await asCallerOrg();
        mockDbData.financialProxies = [{ ...frozenProxy, fxRateId: 'fx-1' }];
        mockDbData.updated = { ...frozenProxy, currency: 'COP' };

        await updateOrganizationFinancialProxy(PROXY_UUID, { currency: 'COP' });

        expect(mockDbData.lastUpdateValues.valueUsd).toBeNull();
        expect(mockDbData.lastUpdateValues.fxRateId).toBeNull();
      });

      it('a `referenceYear` edit invalidates the frozen valueUsd (COP TRM lookup date depends on it)', async () => {
        await asCallerOrg();
        const copProxy = { ...frozenProxy, currency: 'COP', referenceYear: 2022, fxRateId: 'fx-1' };
        mockDbData.financialProxies = [copProxy];
        mockDbData.updated = { ...copProxy, referenceYear: 2023 };

        await updateOrganizationFinancialProxy(PROXY_UUID, { referenceYear: 2023 });

        expect(mockDbData.lastUpdateValues.valueUsd).toBeNull();
        expect(mockDbData.lastUpdateValues.fxRateId).toBeNull();
      });

      it('a `unit`-only edit does NOT invalidate valueUsd — unit does not feed the FX derivation', async () => {
        await asCallerOrg();
        mockDbData.financialProxies = [frozenProxy];
        mockDbData.updated = { ...frozenProxy, unit: 'per household', reviewStatus: 'pending_review' };

        await updateOrganizationFinancialProxy(PROXY_UUID, { unit: 'per household' });

        // Material (resets review — unit IS in PROXY_MATERIAL_FIELDS)...
        expect(mockDbData.lastUpdateValues.reviewStatus).toBe('pending_review');
        // ...but not a USD-derivation field, so valueUsd/fxRateId are left alone.
        expect(mockDbData.lastUpdateValues.valueUsd).toBeUndefined();
        expect(mockDbData.lastUpdateValues.fxRateId).toBeUndefined();
      });

      it('re-submitting the SAME value/currency/referenceYear does not spuriously invalidate valueUsd', async () => {
        await asCallerOrg();
        mockDbData.financialProxies = [frozenProxy];
        mockDbData.updated = { ...frozenProxy };

        await updateOrganizationFinancialProxy(PROXY_UUID, { value: '100', currency: 'USD', referenceYear: 2023 });

        expect(mockDbData.lastUpdateValues.valueUsd).toBeUndefined();
        expect(mockDbData.lastUpdateValues.fxRateId).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    // CL-2C (PROX-01) — re-approval after a material edit must DERIVE from the
    // CURRENT value/currency, not reuse a stale frozen figure. Once CL-2B nulls
    // valueUsd on the material edit, resolveProxyValueUsd's short-circuit can no
    // longer fire, so this is really a consequence test of the same fix, run
    // through the review-status path instead of the update path.
    // -------------------------------------------------------------------------
    describe('CL-2C — re-approval derives the USD value from the CURRENT proxy state', () => {
      it('re-approving a proxy whose valueUsd was invalidated by CL-2B derives fresh USD from the new value', async () => {
        const { requireOrganizationAccess } = await import('@/lib/auth/session');
        const { canApproveProxy } = await import('@/lib/auth/permissions');
        const ctx = { organization: { id: 'org-3' }, user: { isSuperAdmin: false }, membership: { role: 'organization_admin' } } as any;
        vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
        vi.mocked(canApproveProxy).mockReturnValue(true);

        // Post-CL-2B state: material value edit already nulled valueUsd/fxRateId.
        const editedProxy = {
          id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'pending_review',
          value: '250', currency: 'USD', unit: 'unit', referenceYear: 2023,
          valueUsd: null, fxRateId: null,
        };
        mockDbData.financialProxies = [editedProxy];
        mockDbData.updated = { ...editedProxy, reviewStatus: 'approved', valueUsd: '250' };

        await updateFinancialProxyReviewStatus(
          PROXY_UUID,
          'approved',
          reviewedStateOf(editedProxy)
        );

        // USD derives from the CURRENT value (250), never the stale prior one.
        expect(mockDbData.lastUpdateValues.valueUsd).toBe('250');
      });
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

    const result = await updateFinancialProxyReviewStatus(
      PROXY_UUID,
      'approved',
      reviewedStateOf(proxy)
    );
    expect(result.reviewStatus).toBe('approved');
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(logAuditAction).toHaveBeenCalled();
  });

  describe('R3-CL2 — expected approval state', () => {
    const approvalProxy = {
      id: PROXY_UUID,
      organizationId: 'org-3',
      sourceId: SOURCE_UUID,
      reviewStatus: 'pending_review',
      value: '100.0000',
      currency: 'USD',
      unit: 'unit',
      referenceYear: 2023,
      valueUsd: '100.0000',
      fxRateId: null,
      name: 'Metadata ignored by approval fingerprint',
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };

    async function asApprover() {
      const { requireOrganizationAccess } = await import('@/lib/auth/session');
      const { canApproveProxy } = await import('@/lib/auth/permissions');
      vi.mocked(requireOrganizationAccess).mockResolvedValue({
        organization: { id: 'org-3' },
        user: { id: 'reviewer-1' },
        membership: { role: 'organization_admin' },
      } as any);
      vi.mocked(canApproveProxy).mockReturnValue(true);
    }

    it('creates a deterministic material-only fingerprint', () => {
      const first = fingerprintFinancialProxyApprovalState(approvalProxy);
      const proxyWithMetadataOnlyChange = {
        ...approvalProxy,
        updatedAt: new Date('2025-02-01T00:00:00.000Z'),
        name: 'Different display metadata',
      };
      const metadataOnlyChange = fingerprintFinancialProxyApprovalState(proxyWithMetadataOnlyChange);
      const materialChange = fingerprintFinancialProxyApprovalState({ ...approvalProxy, value: '101.0000' });

      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(metadataOnlyChange).toBe(first);
      expect(materialChange).not.toBe(first);
    });

    it('refuses an approval request without the reviewed-state fingerprint', async () => {
      await asApprover();
      mockDbData.financialProxies = [approvalProxy];
      mockDbData.updated = { ...approvalProxy, reviewStatus: 'approved' };

      await expect(
        updateFinancialProxyReviewStatus(PROXY_UUID, 'approved', undefined as never)
      ).rejects.toThrow('Expected approval state is required');
      expect(mockDbData.lastUpdateValues).toBeNull();
    });

    it('refuses a stale V1 fingerprint after V2 has committed', async () => {
      await asApprover();
      const v1 = fingerprintFinancialProxyApprovalState(approvalProxy);
      const v2 = { ...approvalProxy, value: '200.0000', valueUsd: '200.0000' };
      mockDbData.financialProxies = [v2];
      mockDbData.updated = { ...v2, reviewStatus: 'approved' };

      await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved', v1))
        .rejects.toThrow('Approval state is stale');
      expect(mockDbData.lastUpdateValues).toBeNull();
    });

    it('approves only when the current locked state matches the reviewed fingerprint', async () => {
      await asApprover();
      mockDbData.financialProxies = [approvalProxy];
      mockDbData.updated = { ...approvalProxy, reviewStatus: 'approved', reviewerId: 'reviewer-1' };

      const result = await updateFinancialProxyReviewStatus(
        PROXY_UUID,
        'approved',
        fingerprintFinancialProxyApprovalState(approvalProxy)
      );

      expect(result.reviewStatus).toBe('approved');
    });
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

    await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved', reviewedStateOf(proxy))).rejects.toThrow('Forbidden');
  });

  it('updateFinancialProxyReviewStatus rejects a non-super-admin acting on a system (org-less) proxy', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session');
    const { canApproveProxy } = await import('@/lib/auth/permissions');
    const ctx = { organization: { id: 'org-1' }, user: { isSuperAdmin: false }, membership: { role: 'organization_admin' } } as any;
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctx);
    vi.mocked(canApproveProxy).mockReturnValue(true);
    const proxy = { id: PROXY_UUID, organizationId: null, reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'unit', referenceYear: 2023 };
    mockDbData.financialProxies = [proxy];

    await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved', reviewedStateOf(proxy))).rejects.toThrow('Forbidden');
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

    await expect(updateFinancialProxyReviewStatus(PROXY_UUID, 'approved', reviewedStateOf(proxy))).rejects.toThrow('Forbidden');
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
