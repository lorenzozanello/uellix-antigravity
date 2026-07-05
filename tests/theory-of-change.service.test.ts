// tests/theory-of-change.service.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  outcomes: [] as any[],
  theoryOfChangeNodes: [] as any[],
  theoryOfChangeLinks: [] as any[],
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  hasRole: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
}));

// Extracts every literal value embedded in a drizzle eq()/and() condition tree
// (walks .value/.right/.left/.conditions/.queryChunks) — same helper already
// proven in tests/sroi-results.service.test.ts. Needed so a by-id select can
// correctly resolve ONE specific row even when several rows of that table are
// present in the mock array (e.g. createLink fetching two different nodes).
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

vi.mock('@/db/client', () => {
  function tableName(table: any): string {
    return table?._?.name || table?.[Symbol.for('drizzle:Name')];
  }
  function dataFor(table: any): any[] {
    const name = tableName(table);
    if (name === 'outcomes') return mockDbData.outcomes;
    if (name === 'theory_of_change_nodes') return mockDbData.theoryOfChangeNodes;
    if (name === 'theory_of_change_links') return mockDbData.theoryOfChangeLinks;
    return [];
  }
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table) => {
          let data = [...dataFor(table)];
          const queryResult = {
            where: vi.fn().mockImplementation((cond: any) => {
              if (cond) {
                const eqValues = extractEqValues(cond);
                if (eqValues.length > 0) {
                  const matchedById = data.filter((item) => item.id !== undefined && eqValues.includes(String(item.id)));
                  if (matchedById.length > 0) data = matchedById;
                }
              }
              return queryResult;
            }),
            then: (cb: any) => Promise.resolve(cb(data)),
          };
          return queryResult;
        }),
      })),
      insert: vi.fn().mockImplementation((table) => ({
        values: vi.fn().mockImplementation((vals: any) => ({
          returning: vi.fn().mockImplementation(() => {
            const row = { ...vals, id: crypto.randomUUID(), status: vals.status ?? 'active', createdAt: new Date(), updatedAt: new Date() };
            dataFor(table).push(row);
            return Promise.resolve([row]);
          }),
        })),
      })),
      update: vi.fn().mockImplementation((table) => ({
        set: vi.fn().mockImplementation((values: any) => ({
          where: vi.fn().mockImplementation(() => {
            const data = dataFor(table);
            if (data.length > 0) Object.assign(data[0], values);
            return Promise.resolve([data[0]]);
          }),
        })),
      })),
    },
  };
});

import {
  isValidLinkTransition,
  listNodesForProject,
  createNode,
  archiveNode,
} from '@/lib/pipeline/theory-of-change';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OUTCOME_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.outcomes = [];
  mockDbData.theoryOfChangeNodes = [];
  mockDbData.theoryOfChangeLinks = [];
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID },
    user: { id: USER_ID },
    membership: { role: 'analyst' },
  } as any);
  vi.mocked(hasRole).mockReturnValue(true);
});

describe('isValidLinkTransition', () => {
  it('allows activity -> output', () => {
    expect(isValidLinkTransition('activity', 'output')).toBe(true);
  });
  it('allows output -> outcome', () => {
    expect(isValidLinkTransition('output', 'outcome')).toBe(true);
  });
  it('rejects reverse order (output -> activity)', () => {
    expect(isValidLinkTransition('output', 'activity')).toBe(false);
  });
  it('rejects same-type links', () => {
    expect(isValidLinkTransition('activity', 'activity')).toBe(false);
    expect(isValidLinkTransition('output', 'output')).toBe(false);
    expect(isValidLinkTransition('outcome', 'outcome')).toBe(false);
  });
  it('rejects a direct activity -> outcome jump', () => {
    expect(isValidLinkTransition('activity', 'outcome')).toBe(false);
  });
});

describe('createNode', () => {
  it('creates an activity node without an outcomeId', async () => {
    const node = await createNode(PROJECT_ID, { nodeType: 'activity', title: 'Capacitación' });
    expect(node.nodeType).toBe('activity');
    expect(node.outcomeId).toBeNull();
  });

  it('creates an outcome node referencing a real project outcome', async () => {
    mockDbData.outcomes = [{ id: OUTCOME_ID, projectId: PROJECT_ID, title: 'Empleo mejorado' }];
    const node = await createNode(PROJECT_ID, { nodeType: 'outcome', outcomeId: OUTCOME_ID, title: 'Empleo mejorado' });
    expect(node.nodeType).toBe('outcome');
    expect(node.outcomeId).toBe(OUTCOME_ID);
  });

  it('rejects an outcome node without outcomeId', async () => {
    await expect(createNode(PROJECT_ID, { nodeType: 'outcome', title: 'X' } as any)).rejects.toThrow('outcomeId is required');
  });

  it('rejects an outcome node referencing an outcome from another project', async () => {
    mockDbData.outcomes = [{ id: OUTCOME_ID, projectId: 'other-project' }];
    await expect(createNode(PROJECT_ID, { nodeType: 'outcome', outcomeId: OUTCOME_ID, title: 'X' })).rejects.toThrow('Outcome not found for project');
  });

  it('rejects a second active node for an already-modeled outcome', async () => {
    mockDbData.outcomes = [{ id: OUTCOME_ID, projectId: PROJECT_ID }];
    mockDbData.theoryOfChangeNodes = [{ id: 'existing-node', projectId: PROJECT_ID, outcomeId: OUTCOME_ID, nodeType: 'outcome', status: 'active' }];
    await expect(createNode(PROJECT_ID, { nodeType: 'outcome', outcomeId: OUTCOME_ID, title: 'Duplicado' })).rejects.toThrow('already modeled');
  });

  it('allows modeling an outcome whose only prior node is archived', async () => {
    mockDbData.outcomes = [{ id: OUTCOME_ID, projectId: PROJECT_ID }];
    mockDbData.theoryOfChangeNodes = [{ id: 'old-node', projectId: PROJECT_ID, outcomeId: OUTCOME_ID, nodeType: 'outcome', status: 'archived' }];
    const node = await createNode(PROJECT_ID, { nodeType: 'outcome', outcomeId: OUTCOME_ID, title: 'Empleo mejorado v2' });
    expect(node.outcomeId).toBe(OUTCOME_ID);
  });

  it('rejects setting outcomeId on an activity node', async () => {
    await expect(createNode(PROJECT_ID, { nodeType: 'activity', outcomeId: OUTCOME_ID, title: 'X' })).rejects.toThrow('must not be set');
  });
});

describe('archiveNode', () => {
  it('marks a node archived', async () => {
    mockDbData.theoryOfChangeNodes = [{ id: 'node-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' }];
    const result = await archiveNode(PROJECT_ID, 'node-1');
    expect(result.status).toBe('archived');
    expect(mockDbData.theoryOfChangeNodes[0].status).toBe('archived');
  });

  it('rejects archiving a node from another organization', async () => {
    mockDbData.theoryOfChangeNodes = [{ id: 'node-1', projectId: PROJECT_ID, organizationId: 'other-org', nodeType: 'activity', status: 'active' }];
    await expect(archiveNode(PROJECT_ID, 'node-1')).rejects.toThrow('Node not found');
  });
});

describe('listNodesForProject', () => {
  it('returns only active nodes', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'n1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
    ];
    const nodes = await listNodesForProject(PROJECT_ID);
    expect(nodes).toHaveLength(1);
  });
});
