/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/public-verify.service.test.ts
// FIBIU-05 (FIBC-007) — "sensitive evidence is absent from ... the public
// surface". lib/reports/public-verify.ts is FIBIU-05's named public-surface
// authorized file; this covers its evidence-filtering composition.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPublicVerifiedReport } from '@/lib/reports/public-verify';
import { getLatestEvidenceVersionsByEvidenceIds } from '@/lib/pipeline/evidence-versions';

vi.mock('@/lib/pipeline/evidence-versions', () => ({
  getLatestEvidenceVersionsByEvidenceIds: vi.fn(),
}));

vi.mock('@/lib/taxonomies/service', () => ({
  listOutcomeMappingsForProject: vi.fn().mockResolvedValue([]),
}));

const reportRow = { id: 'report-1' };
const projectRow = { id: 'proj-1' };
const organizationRow = { id: 'org-1' };
const runRow = { id: 'run-1' };

const evidenceRows = [
  { id: 'ev-1', title: 'Sensitive item' },
  { id: 'ev-2', title: 'Cleared item' },
];

function tableNameOf(table: any): string {
  return table?._?.name || table?.[Symbol.for('drizzle:Name')];
}

function makeChain(data: any[]) {
  const chain: any = {
    innerJoin: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    then: vi.fn().mockImplementation((cb: (rows: any[]) => unknown) => Promise.resolve(cb(data))),
  };
  return chain;
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table) => {
        const tableName = tableNameOf(table);
        if (tableName === 'sroi_reports') {
          return makeChain([{ report: reportRow, project: projectRow, organization: organizationRow, run: runRow }]);
        }
        if (tableName === 'sroi_report_sections') return makeChain([]);
        if (tableName === 'evidence_items') return makeChain(evidenceRows);
        if (tableName === 'methodology_review_matrix') return makeChain([]);
        return makeChain([]);
      }),
    })),
  },
}));

describe('getPublicVerifiedReport — evidence sensitivity filtering (FIBIU-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes evidence not explicitly classified non_sensitive from the public surface', async () => {
    vi.mocked(getLatestEvidenceVersionsByEvidenceIds).mockResolvedValue(
      new Map([
        ['ev-1', { sensitivityClassification: 'personal_data' } as any],
        ['ev-2', { sensitivityClassification: 'non_sensitive' } as any],
      ])
    );

    const result = await getPublicVerifiedReport('hash-1');

    expect(result).not.toBeNull();
    expect(result!.evidence.map((e: any) => e.id)).toEqual(['ev-2']);
  });

  it('excludes unclassified evidence — a missing version row is never treated as an implicit pass', async () => {
    vi.mocked(getLatestEvidenceVersionsByEvidenceIds).mockResolvedValue(new Map());

    const result = await getPublicVerifiedReport('hash-1');

    expect(result!.evidence).toHaveLength(0);
  });

  it('returns null when no locked report matches the verification hash (fail-closed default, unchanged)', async () => {
    const { db } = await import('@/db/client');
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockImplementation(() => makeChain([])),
    }) as any);

    const result = await getPublicVerifiedReport('unknown-hash');
    expect(result).toBeNull();
  });
});
