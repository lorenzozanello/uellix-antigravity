/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/evidence-sufficiency.service.test.ts
// FIBIU-06 — human evidence sufficiency determination (FIBC-008/FIBDB-014).
// W2-B1-R3 (R-B1-04, M-1) — every read/write here is bound to an explicit
// calculationRunId. The mock's WHERE-clause filtering is REAL (not a
// pass-through): it walks the actual Drizzle eq()/and() condition objects
// via extractEqValues (same technique as
// lib/stella/context/__tests__/build-composer-context.test.ts) so the run-
// binding negative controls below prove the query itself is scoped
// correctly, not just that the function accepts a parameter.
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
  run: { id: 'run-1', projectId: 'proj-1', organizationId: 'org-1' } as any | null,
  determinations: [] as any[],
};

function tableNameOf(table: any): string {
  return table?._?.name || table?.[Symbol.for('drizzle:Name')];
}

// Recursively walks a Drizzle eq()/and() condition object and returns every
// literal comparison value it embeds. Same technique proven in
// lib/stella/context/__tests__/build-composer-context.test.ts.
function extractEqValues(val: any): string[] {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val.flatMap(extractEqValues);
  const res: string[] = [];
  if (val.value !== undefined) {
    if (typeof val.value === 'string') res.push(val.value);
    else if (Array.isArray(val.value)) res.push(...val.value.flatMap(extractEqValues));
    else res.push(...extractEqValues(val.value));
  }
  if (val.right !== undefined) res.push(...extractEqValues(val.right));
  if (val.left !== undefined) res.push(...extractEqValues(val.left));
  if (Array.isArray(val.conditions)) res.push(...val.conditions.flatMap(extractEqValues));
  if (Array.isArray(val.queryChunks)) res.push(...val.queryChunks.flatMap(extractEqValues));
  return res;
}

function makeSelectChain(data: any[], filterByWhere: boolean) {
  let limitCount: number | null = null;
  let filtered = data;
  const chain: any = {
    where: vi.fn().mockImplementation((cond: unknown) => {
      if (filterByWhere) {
        const values = new Set(extractEqValues(cond));
        filtered = data.filter(
          (row) =>
            (row.outcomeId === undefined || values.has(row.outcomeId)) &&
            (row.calculationRunId === undefined || values.has(row.calculationRunId))
        );
      }
      return chain;
    }),
    orderBy: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation((n: number) => {
      limitCount = n;
      return chain;
    }),
    then: vi.fn().mockImplementation((callback: (rows: any[]) => unknown) => {
      const rows = limitCount === null ? filtered : filtered.slice(0, limitCount);
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
        if (tableName === 'projects') return makeSelectChain(mockDbData.project ? [mockDbData.project] : [], false);
        if (tableName === 'outcomes') return makeSelectChain(mockDbData.outcome ? [mockDbData.outcome] : [], false);
        if (tableName === 'sroi_calculation_runs') return makeSelectChain(mockDbData.run ? [mockDbData.run] : [], false);
        if (tableName === 'evidence_sufficiency_determinations') {
          const sorted = [...mockDbData.determinations].sort((a, b) => b.ordinal - a.ordinal);
          return makeSelectChain(sorted, true);
        }
        return makeSelectChain([], false);
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
    mockDbData.run = { id: 'run-1', projectId: 'proj-1', organizationId: 'org-1' };
    mockDbData.determinations = [];
  });

  it('rejects an actor below impact_manager', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'analyst' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(false);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'sufficient', rationale: 'ok' })
    ).rejects.toThrow('Insufficient permissions');
  });

  it('rejects a determination with no rationale — never inferred, always explicit', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'sufficient', rationale: '' })
    ).rejects.toThrow();
  });

  it('records a governed determination with actor, rationale, run binding, and ordinal 1 for the first call', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    const result = await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', {
      determination: 'sufficient',
      rationale: 'Evidence set covers all indicators with approved items',
    });

    expect(result.ordinal).toBe(1);
    expect(result.determination).toBe('sufficient');
    expect(result.actorUserId).toBe('u1');
    expect(result.calculationRunId).toBe('run-1');
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'evidence_sufficiency_determination.recorded' })
    );
  });

  it('is append-only WITHIN one run: a re-determination for the same run is ordinal+1, never an edit', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'insufficient', rationale: 'gap in coverage' });
    const second = await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'sufficient', rationale: 'gap closed' });

    expect(mockDbData.determinations).toHaveLength(2);
    expect(second.ordinal).toBe(2);
    expect(mockDbData.determinations[0].determination).toBe('insufficient');

    const latest = await getLatestSufficiencyDetermination('out-1', 'run-1');
    expect(latest?.determination).toBe('sufficient');
    expect(latest?.ordinal).toBe(2);
  });

  it('a new run starts its own ordinal sequence for the same outcome, never continuing a prior run\'s', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'sufficient', rationale: 'run 1 determination' });

    mockDbData.run = { id: 'run-2', projectId: 'proj-1', organizationId: 'org-1' };
    const runTwoFirst = await recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-2', { determination: 'sufficient', rationale: 'run 2 determination' });

    expect(runTwoFirst.ordinal).toBe(1);
    expect(runTwoFirst.calculationRunId).toBe('run-2');
  });

  it('rejects an outcome that does not belong to the project (IDOR-style guard)', async () => {
    mockDbData.outcome = { id: 'out-1', projectId: 'proj-OTHER' };
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'sufficient', rationale: 'x' })
    ).rejects.toThrow('Outcome does not belong to the project');
  });

  it('rejects a calculation run that does not belong to the project (IDOR-style guard)', async () => {
    mockDbData.run = { id: 'run-1', projectId: 'proj-OTHER', organizationId: 'org-1' };
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'impact_manager' },
    } as any);
    vi.mocked(canDetermineEvidenceSufficiency).mockReturnValue(true);

    await expect(
      recordEvidenceSufficiencyDetermination('proj-1', 'out-1', 'run-1', { determination: 'sufficient', rationale: 'x' })
    ).rejects.toThrow('Calculation run does not belong to the project');
  });

  // -------------------------------------------------------------------------
  // NC-4 (R-B1-04, PRIMARY RUN-BINDING CONTROL) and NC-5.
  // -------------------------------------------------------------------------

  it('NC-4: a determination recorded for run R1 does NOT satisfy a lookup for run R2, same outcome', async () => {
    mockDbData.determinations = [
      { id: 'd1', outcomeId: 'out-1', calculationRunId: 'run-1', ordinal: 1, determination: 'sufficient' },
    ];

    const forRun1 = await getLatestSufficiencyDetermination('out-1', 'run-1');
    expect(forRun1?.determination).toBe('sufficient');

    const forRun2 = await getLatestSufficiencyDetermination('out-1', 'run-2');
    expect(forRun2).toBeNull();
  });

  it('NC-4 (batch form): a run-1 determination does not appear in a run-2 batch lookup for the same outcome', async () => {
    mockDbData.determinations = [
      { id: 'd1', outcomeId: 'out-1', calculationRunId: 'run-1', ordinal: 1, determination: 'sufficient' },
      { id: 'd2', outcomeId: 'out-2', calculationRunId: 'run-2', ordinal: 1, determination: 'sufficient' },
    ];

    const forRun2 = await getLatestSufficiencyDeterminationsByOutcomeIds(['out-1', 'out-2'], 'run-2');
    expect(forRun2.has('out-1')).toBe(false);
    expect(forRun2.get('out-2')?.determination).toBe('sufficient');
  });

  it('NC-5: an old/superseded determination for the CURRENT run does not substitute for the current one', async () => {
    mockDbData.determinations = [
      { id: 'd1', outcomeId: 'out-1', calculationRunId: 'run-1', ordinal: 1, determination: 'insufficient' },
      { id: 'd2', outcomeId: 'out-1', calculationRunId: 'run-1', ordinal: 2, determination: 'sufficient' },
    ];

    const latest = await getLatestSufficiencyDetermination('out-1', 'run-1');
    expect(latest?.ordinal).toBe(2);
    expect(latest?.determination).toBe('sufficient');
  });

  it('batch lookup returns only the latest ordinal per outcome, scoped to the given run', async () => {
    mockDbData.determinations = [
      { id: 'd1', outcomeId: 'out-1', calculationRunId: 'run-1', ordinal: 1, determination: 'insufficient' },
      { id: 'd2', outcomeId: 'out-1', calculationRunId: 'run-1', ordinal: 2, determination: 'sufficient' },
      { id: 'd3', outcomeId: 'out-2', calculationRunId: 'run-1', ordinal: 1, determination: 'sufficient' },
    ];

    const latest = await getLatestSufficiencyDeterminationsByOutcomeIds(['out-1', 'out-2'], 'run-1');
    expect(latest.get('out-1')?.determination).toBe('sufficient');
    expect(latest.get('out-1')?.ordinal).toBe(2);
    expect(latest.get('out-2')?.determination).toBe('sufficient');
  });
});
