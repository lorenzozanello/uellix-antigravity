/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/fx-rates.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrCreateFxRate, createManualFxRate } from '@/lib/pipeline/fx-rates';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';
import Decimal from 'decimal.js';

vi.mock('@/lib/auth/session');

// Explicit factory instead of `vi.mock('@/db/client')` automock.
//
// db/client.ts no longer builds its client at import time — `db` is a lazy
// proxy, so there is no live drizzle instance for the automocker to walk and
// turn into mock methods. This suite calls `vi.mocked(db).select
// .mockReturnValue(...)`, i.e. it needs the methods to already exist, so it
// declares them. (tests/funders.service.test.ts and
// tests/outcome-funder-allocations.service.test.ts assign their own mocks
// onto `db` instead and are unaffected.) See docs/ops/DATABASE_TARGET_SAFETY.md.
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

describe('FX rates service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing rate for the date', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    const mockRate = {
      id: 'rate-1',
      currency: 'COP',
      rateDate: '2026-07-01',
      rateToUsd: new Decimal('4150'),
      source: 'datos.gov.co',
      sourceType: 'auto_fetched',
      organizationId: null,
      createdBy: 'user-1',
      createdAt: new Date(),
    };

    vi.mocked(db).select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue(mockRate),
        }),
      }),
    } as any);

    const result = await getOrCreateFxRate('COP', '2026-07-01');

    expect(result).toBeDefined();
    expect(result.rateToUsd).toEqual(new Decimal('4150'));
  });

  it('creates a manual entry when rate does not exist', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    // First call: no existing rate
    let callCount = 0;
    vi.mocked(db).select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn(() => {
            callCount++;
            return Promise.resolve(null);
          }),
        }),
      }),
    } as any);

    // Second call: insert manual entry
    const newRate = {
      id: 'rate-2',
      currency: 'USD',
      rateDate: '2026-07-01',
      rateToUsd: new Decimal('1'),
      source: 'manual_entry',
      sourceType: 'manual',
      organizationId: 'org-1',
      createdBy: 'user-1',
      createdAt: new Date(),
    };

    vi.mocked(db).insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue(newRate),
        }),
      }),
    } as any);

    const result = await getOrCreateFxRate('USD', '2026-07-01', new Decimal('1'), 'manual_entry');

    expect(result).toBeDefined();
    expect(result.rateToUsd).toEqual(new Decimal('1'));
  });

  it('rejects invalid currency', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    await expect(getOrCreateFxRate('INVALID', '2026-07-01')).rejects.toThrow();
  });
});
