/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-proxies.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  proxySources: [] as any[],
  financialProxies: [] as any[],
  inserted: {} as any,
  insertedGlobalSource: {} as any,
  insertedRows: [] as any[],
  updated: {} as any,
  insertedFxRate: {} as any,
  lastUpdateValues: null as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: { ORGANIZATION_UPDATED: 'organization_updated' },
}));

vi.mock('@/db/client', () => {
  const database: any = {
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(database)),
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          const data =
            tableName === 'proxy_sources'
              ? mockDbData.proxySources
              : tableName === 'financial_proxies'
                ? mockDbData.financialProxies
                : [];
          const query: any = {
            where: vi.fn().mockImplementation(() => ({
              then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(data))),
            })),
          };
          query.where.mockImplementation(() => query);
          query.then = (cb: (rows: any[]) => unknown) => Promise.resolve(cb(data));
          query.for = vi.fn().mockImplementation(() => query);
          return query;
        }),
      })),
      insert: vi.fn().mockImplementation((table) => {
        const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
        return {
          values: vi.fn().mockImplementation((values) => {
            mockDbData.insertedRows.push({ tableName, values });
            return ({
            returning: vi.fn().mockImplementation(() =>
              Promise.resolve([tableName === 'fx_rates'
                ? mockDbData.insertedFxRate
                : tableName === 'proxy_sources'
                  ? Object.keys(mockDbData.insertedGlobalSource).length > 0
                    ? mockDbData.insertedGlobalSource
                    : mockDbData.inserted
                  : mockDbData.inserted])
            ),
            });
          }),
        };
      }),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((values) => {
          mockDbData.lastUpdateValues = values;
          return ({
          where: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockImplementation(() => Promise.resolve([mockDbData.updated])),
          })),
          });
        }),
      })),
  };
  return { db: database };
});

import {
  listGlobalProxySources,
  listGlobalFinancialProxies,
  createGlobalProxySource,
  createGlobalFinancialProxy,
  updateGlobalProxyReviewStatus,
  setGlobalProxyManualFxRate,
  promoteProxyToGlobal,
} from '@/lib/admin/proxies';
import { requireAdminAccess } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';
import { fingerprintFinancialProxyApprovalState } from '@/lib/pipeline/proxies';

const ADMIN = { id: 'admin-1', email: 'admin@uellix.com', fullName: null, avatarUrl: null, isSuperAdmin: true } as any;

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
  mockDbData.inserted = {};
  mockDbData.insertedGlobalSource = {};
  mockDbData.insertedRows = [];
  mockDbData.updated = {};
  mockDbData.insertedFxRate = {};
  mockDbData.lastUpdateValues = null;
});

describe('listGlobalProxySources / listGlobalFinancialProxies', () => {
  it('requires admin access and returns data', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.proxySources = [{ id: 'src-1', organizationId: null }];
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: null }];

    expect(await listGlobalProxySources()).toEqual(mockDbData.proxySources);
    expect(await listGlobalFinancialProxies()).toEqual(mockDbData.financialProxies);
    expect(requireAdminAccess).toHaveBeenCalledTimes(2);
  });
});

describe('createGlobalProxySource', () => {
  it('creates a system-level source (organizationId: null)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.inserted = { id: 'src-1', organizationId: null, name: 'PNUD' };

    const result = await createGlobalProxySource({ name: 'PNUD' });
    expect(result.organizationId).toBeNull();
    expect(logAuditAction).toHaveBeenCalled();
  });
});

describe('createGlobalFinancialProxy', () => {
  it('creates a proxy with reviewStatus suggested', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const input = {
      sourceId: '550e8400-e29b-41d4-a716-446655440001',
      name: 'Salario mínimo',
      currency: 'USD',
      value: '100',
      unit: 'mes',
      referenceYear: 2024,
    };
    mockDbData.inserted = { id: 'proxy-1', ...input, organizationId: null, reviewStatus: 'suggested' };

    const result = await createGlobalFinancialProxy(input);
    expect(result.reviewStatus).toBe('suggested');
  });
});

describe('updateGlobalProxyReviewStatus', () => {
  it('refuses a global approval without an expected reviewed state', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = { id: 'proxy-1', organizationId: null, sourceId: 'source-1', reviewStatus: 'pending_review', value: '100', currency: 'USD', unit: 'mes', referenceYear: 2024, valueUsd: '100', fxRateId: null };
    mockDbData.financialProxies = [proxy];
    mockDbData.updated = { ...proxy, reviewStatus: 'approved' };

    await expect(
      updateGlobalProxyReviewStatus('proxy-1', 'approved', undefined as never)
    ).rejects.toThrow('Expected approval state is required');
    expect(mockDbData.lastUpdateValues).toBeNull();
  });

  it('rejects proxies that belong to an organization', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: 'org-1', reviewStatus: 'suggested' }];

    await expect(updateGlobalProxyReviewStatus('proxy-1', 'approved', reviewedStateOf(mockDbData.financialProxies[0]))).rejects.toThrow(
      'Not a global proxy'
    );
  });

  it('rejects approving without required fields', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [
      { id: 'proxy-1', organizationId: null, reviewStatus: 'suggested', value: null, currency: 'USD', unit: 'mes', referenceYear: 2024 },
    ];

    await expect(updateGlobalProxyReviewStatus('proxy-1', 'approved', reviewedStateOf(mockDbData.financialProxies[0]))).rejects.toThrow(
      'Cannot approve without value'
    );
  });

  it('approves a well-formed global proxy', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = { id: 'proxy-1', organizationId: null, reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'mes', referenceYear: 2024 };
    mockDbData.financialProxies = [proxy];
    mockDbData.updated = { ...proxy, reviewStatus: 'approved' };

    const result = await updateGlobalProxyReviewStatus('proxy-1', 'approved', reviewedStateOf(proxy));
    expect(result.reviewStatus).toBe('approved');
  });

  it('rejects an invalid status value', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: null, reviewStatus: 'suggested' }];

    await expect(updateGlobalProxyReviewStatus('proxy-1', 'not_a_status')).rejects.toThrow('Invalid status');
  });
});

describe('setGlobalProxyManualFxRate', () => {
  it('rejects proxies that belong to an organization', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: 'org-1', value: '100', currency: 'EUR' }];

    await expect(setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '0.92', source: 'ECB' }, reviewedStateOf(mockDbData.financialProxies[0]))).rejects.toThrow(
      'Not a global proxy'
    );
  });

  it('rejects a USD proxy (no conversion needed)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: null, value: '100', currency: 'USD' }];

    await expect(setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '1', source: 'n/a' }, reviewedStateOf(mockDbData.financialProxies[0]))).rejects.toThrow(
      'do not need an FX rate'
    );
  });

  it('rejects a non-positive rate', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: null, value: '100', currency: 'EUR', referenceYear: 2024 }];

    await expect(
      setGlobalProxyManualFxRate(
        'proxy-1',
        { rateToUsd: '0', source: 'ECB' },
        reviewedStateOf(mockDbData.financialProxies[0]),
      )
    ).rejects.toThrow();
  });

  it('freezes value_usd using the manual rate and the reference-year Dec 31 date', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = { id: 'proxy-1', organizationId: null, value: '92', currency: 'EUR', referenceYear: 2024 };
    mockDbData.financialProxies = [proxy];
    mockDbData.insertedFxRate = { id: 'fxrate-1', currency: 'EUR', rateDate: '2024-12-31', rateToUsd: '0.92', source: 'ECB', sourceType: 'manual' };
    mockDbData.updated = { ...proxy, valueUsd: '100.0000', fxRateId: 'fxrate-1' };

    const result = await setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '0.92', source: 'ECB' }, reviewedStateOf(proxy));
    expect(result.valueUsd).toBe('100.0000');
    expect(result.fxRateId).toBe('fxrate-1');
    expect(logAuditAction).toHaveBeenCalled();
  });

  it('invalidates a prior approval when manual FX changes monetary authority', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = { id: 'proxy-1', organizationId: null, sourceId: 'source-1', reviewStatus: 'approved', value: '92', currency: 'EUR', unit: 'mes', referenceYear: 2024, valueUsd: '100.0000', fxRateId: 'old-fx' };
    mockDbData.financialProxies = [proxy];
    mockDbData.insertedFxRate = { id: 'fxrate-2', currency: 'EUR', rateDate: '2024-12-31', rateToUsd: '0.90', source: 'ECB', sourceType: 'manual' };
    mockDbData.updated = { ...proxy, valueUsd: '102.2222', fxRateId: 'fxrate-2', reviewStatus: 'pending_review' };

    await setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '0.90', source: 'ECB' }, reviewedStateOf(proxy));

    expect(mockDbData.lastUpdateValues.reviewStatus).toBe('pending_review');
  });
});

describe('promoteProxyToGlobal', () => {
  it('refuses a malformed reviewed-state fingerprint before cloning or approving', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{
      id: 'proxy-1', organizationId: 'org-1', sourceId: 'source-1', reviewStatus: 'pending_review',
      value: '100', currency: 'USD', unit: 'mes', referenceYear: 2024, valueUsd: '100', fxRateId: null,
    }];
    mockDbData.proxySources = [{ id: 'source-1', organizationId: 'org-1', name: 'DANE', status: 'active' }];

    await expect(promoteProxyToGlobal('proxy-1', 'not-a-fingerprint' as never))
      .rejects.toThrow('Expected approval state is malformed');
    expect(mockDbData.inserted).toEqual({});
    expect(mockDbData.lastUpdateValues).toBeNull();
  });

  it('clones the reviewed source and proxy, then approves the original in the same transaction', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = {
      id: 'proxy-1', organizationId: 'org-1', sourceId: 'source-1', reviewStatus: 'pending_review',
      name: 'Costo mensual', description: null, proxyType: 'cost', country: 'CO', territory: null,
      value: '100', currency: 'USD', unit: 'mes', referenceYear: 2024, valueUsd: '100', fxRateId: null,
      thematicArea: null, methodology: null, confidenceLevel: null, methodologicalRisk: null,
    };
    mockDbData.financialProxies = [proxy];
    mockDbData.proxySources = [{ id: 'source-1', organizationId: 'org-1', name: 'DANE', description: null, url: null, status: 'active' }];
    mockDbData.insertedGlobalSource = { id: 'global-source-1' };
    mockDbData.inserted = { id: 'global-proxy-1', reviewStatus: 'approved' };

    const promoted = await promoteProxyToGlobal('proxy-1', reviewedStateOf(proxy));

    expect(promoted).toEqual({ id: 'global-proxy-1', reviewStatus: 'approved' });
    expect(mockDbData.insertedRows).toHaveLength(2);
    expect(mockDbData.insertedRows[0]).toMatchObject({
      tableName: 'proxy_sources',
      values: { organizationId: null, name: 'DANE', status: 'active' },
    });
    expect(mockDbData.insertedRows[1]).toMatchObject({
      tableName: 'financial_proxies',
      values: { organizationId: null, sourceId: 'global-source-1', reviewStatus: 'approved', valueUsd: '100' },
    });
    expect(mockDbData.lastUpdateValues).toMatchObject({ reviewStatus: 'approved', valueUsd: '100' });
  });
});
