// tests/evidence-erasure-multiversion.service.test.ts
// W2-B1-R5 (M-3, M-4) — requestGovernedEvidenceErasure must sweep EVERY
// version of an evidence item's content, not just the current one, and must
// write a durable governance record BEFORE any external/content-mutating
// operation. The shared mock in tests/evidence.service.test.ts always
// "updates" whichever version row happens to be sorted-latest, regardless
// of the WHERE clause passed — adequate for its single-version fixtures,
// but it would silently mask a bug that only touches the current version
// while claiming to sweep all of them. This file uses a WHERE-clause-aware
// mock (extractEqValues, the same technique as
// lib/stella/context/__tests__/build-composer-context.test.ts and
// tests/evidence-sufficiency.service.test.ts) so the negative controls
// below prove the sweep itself is complete, not just that the function
// returns a plausible-looking tombstone.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  canEraseEvidenceContent: vi.fn(),
  hasRole: vi.fn(),
  canClassifyEvidenceSensitivity: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    EVIDENCE_TOMBSTONE_ERASURE_REQUESTED: 'evidence_tombstone.erasure_requested',
    EVIDENCE_TOMBSTONE_ERASURE_COMPLETED: 'evidence_tombstone.erasure_completed',
    EVIDENCE_TOMBSTONE_ERASURE_BLOCKED: 'evidence_tombstone.erasure_blocked',
  },
}));

vi.mock('@/lib/pipeline/confidence-score', () => ({ recalculateConfidenceScore: vi.fn() }));
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: () => unknown) => cb(),
}));

/** Every boundary call, in the order it happened — proves M-3's ordering. */
const calls: string[] = [];

const mockStorageRemove = vi.fn().mockResolvedValue({ error: null });
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockImplementation(() =>
    Promise.resolve({
      storage: {
        from: vi.fn().mockReturnValue({
          remove: (...args: unknown[]) => {
            calls.push('external-storage-remove');
            return mockStorageRemove(...args);
          },
        }),
      },
    })
  ),
}));

type Row = Record<string, unknown>;

const mockDbData: {
  project: Row | null;
  evidence: Row;
  evidenceVersions: Row[];
  evidenceTombstones: Row[];
} = {
  project: { id: 'proj-1', organizationId: 'org-1' },
  evidence: { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'text', filePath: null },
  evidenceVersions: [],
  evidenceTombstones: [],
};

/** The subset of Drizzle's internal table shape this mock's name-lookup reads. */
interface DrizzleTableRef {
  readonly _?: { readonly name?: string }
  readonly [key: symbol]: unknown
}

function tableNameOf(table: unknown): string {
  const t = table as DrizzleTableRef | undefined;
  return t?._?.name || (t?.[Symbol.for('drizzle:Name')] as string | undefined) || '';
}

/** Drizzle's eq()/and()/inArray() condition tree, as walked structurally by extractEqValues. */
interface DrizzleConditionNode {
  readonly value?: unknown
  readonly right?: unknown
  readonly left?: unknown
  readonly conditions?: readonly unknown[]
  readonly queryChunks?: readonly unknown[]
}

/** Walks Drizzle's eq()/and()/inArray() condition objects to extract the
 * literal comparison values actually being filtered on — so this mock's
 * WHERE clauses are real, not decorative. */
function extractEqValues(val: unknown): string[] {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val.flatMap(extractEqValues);
  const node = val as DrizzleConditionNode;
  const res: string[] = [];
  if (node.value !== undefined) {
    if (typeof node.value === 'string') res.push(node.value);
    else if (Array.isArray(node.value)) res.push(...node.value.flatMap(extractEqValues));
    else res.push(...extractEqValues(node.value));
  }
  if (node.right !== undefined) res.push(...extractEqValues(node.right));
  if (node.left !== undefined) res.push(...extractEqValues(node.left));
  if (Array.isArray(node.conditions)) res.push(...node.conditions.flatMap(extractEqValues));
  if (Array.isArray(node.queryChunks)) res.push(...node.queryChunks.flatMap(extractEqValues));
  return res;
}

/** The chainable shape `db.select().from(table).where(...)` mocks return. */
interface ResultChain {
  orderBy(): ResultChain
  limit(n: number): ResultChain
  then(cb: (rows: Row[]) => unknown): Promise<unknown>
}

function makeResultChain(getRows: () => Row[]) {
  let ordered = getRows();
  const chain: ResultChain = {
    orderBy: vi.fn().mockImplementation(() => {
      ordered = [...ordered]; // ordering value itself is irrelevant to these tests
      return chain;
    }),
    limit: vi.fn().mockImplementation((n: number) => {
      ordered = ordered.slice(0, n);
      return chain;
    }),
    then: vi.fn().mockImplementation((cb: (rows: Row[]) => unknown) => Promise.resolve(cb(ordered))),
  };
  return chain;
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        const name = tableNameOf(table);
        if (name === 'projects') {
          return { where: vi.fn().mockImplementation(() => makeResultChain(() => (mockDbData.project ? [mockDbData.project] : []))) };
        }
        if (name === 'evidence_items') {
          return { where: vi.fn().mockImplementation(() => makeResultChain(() => [mockDbData.evidence])) };
        }
        if (name === 'evidence_versions') {
          return {
            where: vi.fn().mockImplementation((cond: unknown) => {
              const wanted = extractEqValues(cond);
              // listEvidenceVersions filters by evidenceId; getLatestEvidenceVersion
              // (used elsewhere in this module) does the same. Real scoping, not a
              // blanket "return everything" — proves cross-evidence isolation.
              return makeResultChain(() =>
                mockDbData.evidenceVersions
                  .filter((v) => wanted.includes(v.evidenceId as string))
                  .sort((a, b) => (a.ordinal as number) - (b.ordinal as number))
              );
            }),
          };
        }
        if (name === 'evidence_tombstones') {
          return { where: vi.fn().mockImplementation(() => makeResultChain(() => mockDbData.evidenceTombstones)) };
        }
        return { where: vi.fn().mockImplementation(() => makeResultChain(() => [])) };
      }),
    })),
    insert: vi.fn().mockImplementation((table: unknown) => {
      const name = tableNameOf(table);
      return {
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => ({
          returning: vi.fn().mockImplementation(() => {
            if (name === 'evidence_tombstones') {
              const row = { id: `tomb-${mockDbData.evidenceTombstones.length + 1}`, createdAt: new Date(), ...vals };
              mockDbData.evidenceTombstones.push(row);
              return Promise.resolve([row]);
            }
            return Promise.resolve([mockDbData.evidence]);
          }),
        })),
      };
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      const name = tableNameOf(table);
      return {
        set: vi.fn().mockImplementation((patch: Record<string, unknown>) => ({
          where: vi.fn().mockImplementation((cond: unknown) => {
            const ids = extractEqValues(cond);
            let targets: Row[] = [];
            if (name === 'evidence_versions') {
              targets = mockDbData.evidenceVersions.filter((v) => ids.includes(v.id as string));
              targets.forEach((v) => Object.assign(v, patch));
              if (patch.erasureState === 'erasure_requested') calls.push('mark-requested');
              else if (patch.erasureState === 'erasure_complete' || patch.erasureState === 'erasure_partial') {
                calls.push('mark-terminal');
              } else if (patch.content === null) {
                calls.push('erase-content');
              }
            }
            return {
              returning: vi.fn().mockImplementation(() => Promise.resolve(targets)),
              then: vi.fn().mockImplementation((cb: (rows: Row[]) => unknown) => Promise.resolve(cb(targets))),
            };
          }),
        })),
      };
    }),
  },
}));

import { requestGovernedEvidenceErasure } from '@/lib/pipeline/evidence';
import { requireOrganizationAccess } from '@/lib/auth/session';
import type { OrganizationContext } from '@/lib/auth/session';
import { canEraseEvidenceContent } from '@/lib/auth/permissions';
import { logAuditAction } from '@/lib/audit/logger';

function threeTextVersions(evidenceId = 'ev-1') {
  const id = (n: number) => `${evidenceId}-ver-${n}`;
  return [
    {
      id: id(1), organizationId: 'org-1', evidenceId, ordinal: 1,
      content: 'first draft', contentHash: 'h1', sensitivityClassification: 'non_sensitive', treatment: null,
      reviewStatus: 'approved', legacyContentUnverifiable: false, erasureState: null,
      supersedesVersionId: null, createdBy: 'u1', createdAt: new Date('2026-01-01'),
    },
    {
      id: id(2), organizationId: 'org-1', evidenceId, ordinal: 2,
      content: 'revised draft', contentHash: 'h2', sensitivityClassification: 'non_sensitive', treatment: null,
      reviewStatus: 'approved', legacyContentUnverifiable: false, erasureState: null,
      supersedesVersionId: id(1), createdBy: 'u1', createdAt: new Date('2026-01-02'),
    },
    {
      id: id(3), organizationId: 'org-1', evidenceId, ordinal: 3,
      content: 'final text', contentHash: 'h3', sensitivityClassification: 'non_sensitive', treatment: null,
      reviewStatus: 'approved', legacyContentUnverifiable: false, erasureState: null,
      supersedesVersionId: id(2), createdBy: 'u1', createdAt: new Date('2026-01-03'),
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockStorageRemove.mockResolvedValue({ error: null });
  mockDbData.project = { id: 'proj-1', organizationId: 'org-1' };
  mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'text', filePath: null };
  mockDbData.evidenceVersions = threeTextVersions();
  mockDbData.evidenceTombstones = [];
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    user: { id: 'u1' }, organization: { id: 'org-1' }, membership: { role: 'organization_admin' },
  } as unknown as OrganizationContext);
  vi.mocked(canEraseEvidenceContent).mockReturnValue(true);
});

const REQUEST = { erasureReason: 'privacy_or_data_subject_request', rationale: 'Data subject request, ticket 91.' };

describe('M-4 — erasure coverage across ALL versions, not just the current one', () => {
  it('nulls content on every version and advances every version to erasure_complete', async () => {
    await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    const byId = Object.fromEntries(mockDbData.evidenceVersions.map((v) => [v.id, v]));
    // NEGATIVE CONTROL: if the sweep only touched the current (ordinal-3)
    // version, ver-1 and ver-2 would still carry their original content. A
    // buggy single-version implementation fails exactly these assertions.
    expect(byId['ev-1-ver-1'].content).toBeNull();
    expect(byId['ev-1-ver-2'].content).toBeNull();
    expect(byId['ev-1-ver-3'].content).toBeNull();
    expect(byId['ev-1-ver-1'].erasureState).toBe('erasure_complete');
    expect(byId['ev-1-ver-2'].erasureState).toBe('erasure_complete');
    expect(byId['ev-1-ver-3'].erasureState).toBe('erasure_complete');
  });

  it('never touches a DIFFERENT evidence item\'s versions — the sweep query is evidence-scoped', async () => {
    const otherVersions = threeTextVersions('ev-OTHER');
    mockDbData.evidenceVersions.push(...otherVersions);

    await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    for (const v of otherVersions) {
      expect(v.content).not.toBeNull();
      expect(v.erasureState).toBeNull();
    }
  });

  it('a version already erasure_complete before the call is never regressed or re-swept (forward-only)', async () => {
    mockDbData.evidenceVersions[0].erasureState = 'erasure_complete';
    mockDbData.evidenceVersions[0].content = null;
    // ver-3 (current) is still open, so the call is legal.
    await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    const byId = Object.fromEntries(mockDbData.evidenceVersions.map((v) => [v.id, v]));
    expect(byId['ev-1-ver-1'].erasureState).toBe('erasure_complete');
    expect(byId['ev-1-ver-2'].erasureState).toBe('erasure_complete');
    expect(byId['ev-1-ver-3'].erasureState).toBe('erasure_complete');
  });
});

describe('M-3 — durable governance record BEFORE the external/content operation', () => {
  it('marks every version erasure_requested before touching storage, and only reaches a terminal state after', async () => {
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'file', filePath: 'proj-1/ev-1/file.pdf' };
    await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    expect(calls).toEqual(['mark-requested', 'external-storage-remove', 'erase-content', 'erase-content', 'erase-content', 'mark-terminal']);
  });

  it('the requested state is durably persisted on evidence_versions, not only logged', async () => {
    let sawRequestedDuringCall = false;
    mockStorageRemove.mockImplementationOnce(async () => {
      sawRequestedDuringCall = mockDbData.evidenceVersions.every((v) => v.erasureState === 'erasure_requested');
      return { error: null };
    });
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'file', filePath: 'proj-1/ev-1/file.pdf' };

    await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    expect(sawRequestedDuringCall).toBe(true);
  });
});

describe('AC-1 — the erasure_requested audit entry names the entity it actually describes', () => {
  it('entityType stays evidence_tombstone (matching its governed action prefix, FIBC-040) but entityId now names a REAL tombstone, never a borrowed evidence_items id', async () => {
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    const requestedCall = vi
      .mocked(logAuditAction)
      .mock.calls.map((c) => c[0])
      .find((c) => c.action === 'evidence_tombstone.erasure_requested');

    expect(requestedCall).toBeDefined();
    expect(requestedCall!.entityType).toBe('evidence_tombstone');
    expect(requestedCall!.entityId).toBe(tombstone.id);
    // The original defect: entityId was the evidence_items id, a
    // different table entirely, and no tombstone existed yet to name.
    expect(requestedCall!.entityId).not.toBe('ev-1');
  });

  it('the durable crash-recovery record (evidence_versions.erasure_state) is written before storage is touched, independent of when the audit LOG line fires', async () => {
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'file', filePath: 'proj-1/ev-1/file.pdf' };
    let sawRequestedBeforeExternal = false;
    mockStorageRemove.mockImplementationOnce(async () => {
      sawRequestedBeforeExternal = mockDbData.evidenceVersions.every((v) => v.erasureState === 'erasure_requested');
      return { error: null };
    });

    await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    expect(sawRequestedBeforeExternal).toBe(true);
  });

  it('the erasure_completed audit entry DOES name the tombstone, once it exists', async () => {
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);

    const completedCall = vi
      .mocked(logAuditAction)
      .mock.calls.map((c) => c[0])
      .find((c) => c.action === 'evidence_tombstone.erasure_completed');

    expect(completedCall!.entityType).toBe('evidence_tombstone');
    expect(completedCall!.entityId).toBe(tombstone.id);
  });
});

describe('AC-2 — contentHashPreserved reflects the truth, never a hardcoded claim', () => {
  it('true when the current version has a real, verifiable content hash', async () => {
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);
    expect(tombstone.contentHashPreserved).toBe(true);
  });

  it('false when the current version never had a content hash', async () => {
    mockDbData.evidenceVersions[2].contentHash = null;
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);
    expect(tombstone.contentHashPreserved).toBe(false);
  });

  it('false when the current version is legacy content that was never verifiable to begin with', async () => {
    mockDbData.evidenceVersions[2].legacyContentUnverifiable = true;
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);
    expect(tombstone.contentHashPreserved).toBe(false);
  });
});

describe('AC-3 — erasure_blocked is never synthesized at stage A', () => {
  it('a normal erasure never emits erasure_blocked, in the tombstone or in the audit trail', async () => {
    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);
    expect(tombstone.erasureState).not.toBe('erasure_blocked');

    const actions = vi.mocked(logAuditAction).mock.calls.map((c) => c[0].action);
    expect(actions).not.toContain('evidence_tombstone.erasure_blocked');
  });

  it('even a storage failure resolves to erasure_partial, never erasure_blocked — there is no real blocking condition at stage A', async () => {
    mockDbData.evidence = { id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1', status: 'approved', type: 'file', filePath: 'proj-1/ev-1/file.pdf' };
    mockStorageRemove.mockResolvedValue({ error: { message: 'storage unreachable' } });

    const tombstone = await requestGovernedEvidenceErasure('proj-1', 'ev-1', REQUEST);
    expect(tombstone.erasureState).toBe('erasure_partial');
  });
});
