/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/evidence-sufficiency.service.test.ts
// FIBIU-06 — human evidence sufficiency determination (FIBC-008/FIBDB-014).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordEvidenceSufficiencyDetermination,
  getLatestSufficiencyDetermination,
  getLatestSufficiencyDeterminationsByOutcomeIds,
} from '@/lib/pipeline/evidence-sufficiency';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { canDetermineEvidenceSufficiency } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    EVIDENCE_SUFFICIENCY_DETERMINATION_RECORDED: 'evidence_sufficiency_determination.recorded',
  },
}));

vi.mock('@/lib/auth/permissions', () => ({
  canDetermineEvidenceSufficiency: vi.fn(),
}));

const mockDbData = {
  project: { id: 'proj-1', organizationId: 'org-1' } as any | null,
  outcome: { id: 'out-1', projectId: 'proj-1' } as any | null,
  determinations: [] as any[],
};

function tableNameOf(table: any): string {
  return table?._?.name || table?.[Symbol.for('drizzle:Name')];
}

function makeSelectChain(data: any[]) {
  let limitCount: number | null = null;
  const chain: any = {
    where: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation((n: number) => {
      limitCount = n;
      return chain;
    }),
    then: vi.fn().mockImplementation((callback: (rows: any[]) => unknown) => {
      const rows = limitCount === null ? data : data.slice(0, limitCount);
      return Promise.resolve(callback(rows));
    }),
  };
  return chain;
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table) => {
        const tableName = tableNameOf(table);
        let data: any[] = [];
        if (tableName === 'projects') data = mockDbData.project ? [mockDbData.project] : [];
        else if (tableName === 'outcomes') data = mockDbData.outcome ? [mockDbData.outcome] : [];
        else if (tableName === 'evidence_sufficiency_determinations') {
          data = [...mockDbData.determinations].sort((a, b) => b.ordinal - a.ordinal);
        }
        return makeSelectChain(data);
      }),
    })),
    insert: vi.fn().mockImplementation((table) => {
      const tableName = tableNameOf(table);
      return {
        values: vi.fn().mockImplementation((vals: any) => ({
          returning: vi.fn().mockImplementation(() => {
            if (tableName === 'evidence_sufficiency_determinations') {
              const row = { id: `det-${mockDbData.determinations.length + 1}`, createdAt: new Date(), ...vals };
              mockDbData.determinations.push(row);
              return Promise.resolve([row]);
            }
            return Promise.resolve([]);
          }),
        })),
      };
    }),
  },
}));

describe('Evidence sufficiency determination service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-1' };
    mockDbData.determinations = [];
  });

  it('rejects an actor below impact_manager', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'analyst' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(false);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', { determination: 'sufficient', rationale: 'ok' })
    ).rejects.toThrow('Insufficient permissions');
  });

  it('rejects a determination with no rationale — never inferred, always explicit', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', { determination: 'sufficient', rationale: '' })
    ).rejects.toThrow();
  });

  it('records a governed determination with actor, rationale, and ordinal 1 for the first call', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    const result = await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', {
      determination: 'sufficient',
      rationale: 'Evidence set covers all indicators with approved items',
    });

    expect(result.ordinal).toBe(1);
    expect(result.determination).toBe('sufficient');
    expect(result.actorUserId).toBe('u1');
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'evidence_sufficiency_determination.recorded' })
    );
  });

  it('is append-only: a re-determination is a new row (ordinal+1), never an edit of the prior one', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', { determination: 'insufficient', rationale: 'gap in coverage' });
    const second = await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', { determination: 'sufficient', rationale: 'gap closed' });

    expect(mockDbData.determinations).toHaveLength(2);
    expect(second.ordinal).toBe(2);
    expect(mockDbData.determinations[0].determination).toBe('insufficient');

    const latest = await getLatestSufficiencyDetermination('out-1');
    expect(latest?.determination).toBe('sufficient');
    expect(latest?.ordinal).toBe(2);
  });

  it('rejects an outcome that does not belong to the project (IDOR-style guard)', async () => {
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-OTHER' };
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', { determination: 'sufficient', rationale: 'x' })
    ).rejects.toThrow('Outcome does not belong to the project');
  });

  it('batch lookup returns only the latest ordinal per outcome', async () => {
    mockDbData.determinations = [
      { id: 'd1', outcomeId: 'out-1', ordinal: 1, determination: 'insufficient' },
      { id: 'd2', outcomeId: 'out-1', ordinal: 2, determination: 'sufficient' },
      { id: 'd3', outcomeId: 'out-2', ordinal: 1, determination: 'sufficient' },
    ];

    const latest = await getLatestSufficiencyDeterminationsByOutcomeIds(['out-1', 'out-2']);
    expect(latest.get('out-1')?.determination).toBe('sufficient');
    expect(latest.get('out-1')?.ordinal).toBe(2);
    expect(latest.get('out-2')?.determination).toBe('sufficient');
  });
});
