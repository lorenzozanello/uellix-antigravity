/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/fx-rates.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrCreateFxRate, createManualFxRate } from '@/lib/pipeline/fx-rates';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';
import Decimal from 'decimal.js';

vi.mock('@/lib/auth/session');
vi.mock('@/db/client');

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
