/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-proxies.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  proxySources: [] as any[],
  financialProxies: [] as any[],
  inserted: {} as any,
  updated: {} as any,
  insertedFxRate: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: { ORGANIZATION_UPDATED: 'organization_updated' },
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          const data =
            tableName === 'proxy_sources'
              ? mockDbData.proxySources
              : tableName === 'financial_proxies'
                ? mockDbData.financialProxies
                : [];
          return {
            where: vi.fn().mockImplementation(() => ({
              then: vi.fn().mockImplementation((cb) => Promise.resolve(cb(data))),
            })),
          };
        }),
      })),
      insert: vi.fn().mockImplementation((table) => {
        const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
        return {
          values: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockImplementation(() =>
              Promise.resolve([tableName === 'fx_rates' ? mockDbData.insertedFxRate : mockDbData.inserted])
            ),
          })),
        };
      }),
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
  listGlobalProxySources,
  listGlobalFinancialProxies,
  createGlobalProxySource,
  createGlobalFinancialProxy,
  updateGlobalProxyReviewStatus,
  setGlobalProxyManualFxRate,
} from '@/lib/admin/proxies';
import { requireAdminAccess } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';

const ADMIN = { id: 'admin-1', email: 'admin@uellix.com', fullName: null, avatarUrl: null, isSuperAdmin: true } as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.proxySources = [];
  mockDbData.financialProxies = [];
  mockDbData.inserted = {};
  mockDbData.updated = {};
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
  it('rejects proxies that belong to an organization', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: 'org-1', reviewStatus: 'suggested' }];

    await expect(updateGlobalProxyReviewStatus('proxy-1', 'approved')).rejects.toThrow(
      'Not a global proxy'
    );
  });

  it('rejects approving without required fields', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [
      { id: 'proxy-1', organizationId: null, reviewStatus: 'suggested', value: null, currency: 'USD', unit: 'mes', referenceYear: 2024 },
    ];

    await expect(updateGlobalProxyReviewStatus('proxy-1', 'approved')).rejects.toThrow(
      'Cannot approve without value'
    );
  });

  it('approves a well-formed global proxy', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = { id: 'proxy-1', organizationId: null, reviewStatus: 'suggested', value: '100', currency: 'USD', unit: 'mes', referenceYear: 2024 };
    mockDbData.financialProxies = [proxy];
    mockDbData.updated = { ...proxy, reviewStatus: 'approved' };

    const result = await updateGlobalProxyReviewStatus('proxy-1', 'approved');
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

    await expect(setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '0.92', source: 'ECB' })).rejects.toThrow(
      'Not a global proxy'
    );
  });

  it('rejects a USD proxy (no conversion needed)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: null, value: '100', currency: 'USD' }];

    await expect(setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '1', source: 'n/a' })).rejects.toThrow(
      'do not need an FX rate'
    );
  });

  it('rejects a non-positive rate', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    mockDbData.financialProxies = [{ id: 'proxy-1', organizationId: null, value: '100', currency: 'EUR', referenceYear: 2024 }];

    await expect(setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '0', source: 'ECB' })).rejects.toThrow();
  });

  it('freezes value_usd using the manual rate and the reference-year Dec 31 date', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue(ADMIN);
    const proxy = { id: 'proxy-1', organizationId: null, value: '92', currency: 'EUR', referenceYear: 2024 };
    mockDbData.financialProxies = [proxy];
    mockDbData.insertedFxRate = { id: 'fxrate-1', currency: 'EUR', rateDate: '2024-12-31', rateToUsd: '0.92', source: 'ECB', sourceType: 'manual' };
    mockDbData.updated = { ...proxy, valueUsd: '100.0000', fxRateId: 'fxrate-1' };

    const result = await setGlobalProxyManualFxRate('proxy-1', { rateToUsd: '0.92', source: 'ECB' });
    expect(result.valueUsd).toBe('100.0000');
    expect(result.fxRateId).toBe('fxrate-1');
    expect(logAuditAction).toHaveBeenCalled();
  });
});
