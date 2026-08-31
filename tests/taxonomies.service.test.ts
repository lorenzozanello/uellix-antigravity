/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/taxonomies.service.test.ts
// W1-05-RM1 R-6/G-1 (HPO-DEC-1) — createOutcomeMapping stamps
// governance_regime from the boundary, never derived from the parent
// project's own (possibly legacy) regime.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOutcomeMapping } from '@/lib/taxonomies/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: { TAXONOMY_MAPPING_CREATED: 'outcome_taxonomy_mapping.created' },
}));

const mockDbData = {
  project: { id: 'proj-1', organizationId: 'org-1', governanceRegime: 'pre_pc01b' } as any,
  outcome: { id: 'out-1' } as any,
  code: { id: 'code-1' } as any,
  existingMappings: [] as any[],
  inserted: { id: 'map-1' } as any,
  lastInsertValues: null as any,
};

vi.mock('@/db/client', () => {
  const queryBuilder = (data: any[]) => ({
    where: vi.fn().mockImplementation(() => ({
      then: (cb: any) => Promise.resolve(cb(data)),
    })),
    then: (cb: any) => Promise.resolve(cb(data)),
  });

  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: any) => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')];
          if (tableName === 'projects') return queryBuilder(mockDbData.project ? [mockDbData.project] : []);
          if (tableName === 'outcomes') return queryBuilder(mockDbData.outcome ? [mockDbData.outcome] : []);
          if (tableName === 'taxonomy_codes') return queryBuilder(mockDbData.code ? [mockDbData.code] : []);
          if (tableName === 'outcome_taxonomy_mappings') return queryBuilder(mockDbData.existingMappings);
          return queryBuilder([]);
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((values: any) => {
          mockDbData.lastInsertValues = values;
          return {
            returning: vi.fn().mockImplementation(() => Promise.resolve([{ ...mockDbData.inserted, ...values }])),
          };
        }),
      }),
    },
  };
});

const CTX = {
  user: { id: 'user-1' },
  organization: { id: 'org-1' },
  membership: { role: 'analyst' },
};

const OUTCOME_ID = '11111111-1111-4111-8111-111111111111';
const CODE_ID = '22222222-2222-4222-8222-222222222222';

describe('createOutcomeMapping — governance_regime stamping (W1-05-RM1 R-6/G-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(CTX as any);
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1', governanceRegime: 'pre_pc01b' };
    mockDbData.outcome = { id: OUTCOME_ID };
    mockDbData.code = { id: CODE_ID };
    mockDbData.existingMappings = [];
  });

  it('stamps governanceRegime pc01b on a new mapping even when the parent project is legacy/pre_pc01b', async () => {
    await createOutcomeMapping('proj-1', { outcomeId: OUTCOME_ID, taxonomyCodeId: CODE_ID });
    expect(mockDbData.lastInsertValues).toMatchObject({ governanceRegime: 'pc01b' });
  });

  it('never derives the mapping regime from the project.governanceRegime value', async () => {
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1', governanceRegime: 'pc01b' };
    await createOutcomeMapping('proj-1', { outcomeId: OUTCOME_ID, taxonomyCodeId: CODE_ID });
    expect(mockDbData.lastInsertValues.governanceRegime).toBe('pc01b');
    // Same result regardless of the project's own regime — proves the two
    // are independent facts, not one derived from the other.
  });

  it('still writes the governed audit event alongside the stamp', async () => {
    await createOutcomeMapping('proj-1', { outcomeId: OUTCOME_ID, taxonomyCodeId: CODE_ID });
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'outcome_taxonomy_mapping.created' })
    );
  });
});
