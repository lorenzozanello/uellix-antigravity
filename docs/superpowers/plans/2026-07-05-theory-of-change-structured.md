# Teoría de Cambio Estructurada (Fase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured theory-of-change graph (activity/output/outcome nodes with typed causal links) to the Narrativa pipeline step, coexisting with the existing free-text `theoryOfChangeSummary` field.

**Architecture:** Two new additive tables (`theory_of_change_nodes`, `theory_of_change_links`). Outcome-type nodes reference real `outcomes` rows via FK. Link validity (`activity→output` or `output→outcome` only) is enforced by a pure, unit-tested function in the service layer, not a DB constraint (would require a self-join CHECK, not portable). Tabular CRUD UI (no visual canvas), added as a new section on the existing Narrativa page — no new pipeline step.

**Tech Stack:** Drizzle ORM (Postgres), Zod validation, Next.js Server Actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-theory-of-change-structured-design.md`

**Branch:** This plan assumes you are already on `feature/fase-2a-theory-of-change` (created off `feature/pipeline-integrity-hardening`). Verify with `git branch --show-current` before Task 1.

**Deploy notes (read before Task 7):** This Vercel project does NOT auto-deploy on push — every push only creates a Preview build. Reaching production requires an explicit `vercel promote <deployment-url>`, which itself triggers a fresh build (~1 min), not just an alias swap. The migration in this plan is fully additive (two brand-new, empty tables — no existing table is altered), so unlike the Fase 1b migration it carries no ordering risk: it is safe to apply to production at any time relative to the code deploy. Task 7's production step still requires explicit user confirmation before running (this touches the real production database).

---

## File Structure

| File | Responsibility |
|---|---|
| `db/schema.ts` | Modify — add `theoryOfChangeNodes`, `theoryOfChangeLinks` table definitions |
| `db/policies/005_theory_of_change_rls.sql` | Create — RLS policies for the two new tables |
| `lib/pipeline/theory-of-change.ts` | Create — pure validation (`isValidLinkTransition`) + CRUD service functions |
| `tests/theory-of-change.service.test.ts` | Create — TDD tests for the above |
| `app/app/projects/[projectId]/pipeline/theoryOfChange.actions.ts` | Create — Server Action wrappers around the service |
| `app/app/projects/[projectId]/pipeline/narrative/page.tsx` | Modify — add the new UI section below the existing free-text form |

---

### Task 1: Schema — add the two new tables

**Files:**
- Modify: `db/schema.ts`

- [ ] **Step 1: Add the table definitions**

Open `db/schema.ts`. Find the `outcomeFunderAllocations` table definition (it ends with a closing `])` followed by a blank line, then `export const projectInvestments = pgTable(...)`). Insert the following two new table definitions immediately after `outcomeFunderAllocations`'s closing `])`, before `export const projectInvestments`:

```ts
// ─── Fase 2a: Structured theory of change ─────────────────────────────────────
// A simple activity → output → outcome graph with typed causal links and
// optional per-link assumptions. Coexists with (does not replace)
// impact_narratives.theoryOfChangeSummary. Outcome-type nodes reference real
// `outcomes` rows so the graph stays connected to the pipeline that actually
// feeds the SROI calculation.
// Design: docs/superpowers/specs/2026-07-05-theory-of-change-structured-design.md

export const theoryOfChangeNodes = pgTable('theory_of_change_nodes', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  nodeType: varchar('node_type', { length: 20 }).notNull(),
  // NOT NULL only when nodeType = 'outcome' (enforced by the check below);
  // that the referenced outcome belongs to this project is validated in the
  // service layer (an FK alone can't express cross-column project matching).
  outcomeId: uuid('outcome_id').references(() => outcomes.id),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('theory_of_change_nodes_type_check', sql`${table.nodeType} IN ('activity', 'output', 'outcome')`),
  check('theory_of_change_nodes_status_check', sql`${table.status} IN ('active', 'archived')`),
  check('theory_of_change_nodes_outcome_ref_check', sql`(${table.nodeType} = 'outcome' AND ${table.outcomeId} IS NOT NULL) OR (${table.nodeType} != 'outcome' AND ${table.outcomeId} IS NULL)`),
  // An active outcome-type node is unique per outcome per project — archiving
  // one frees the slot for a new node referencing the same outcome.
  uniqueIndex('theory_of_change_nodes_outcome_unique').on(table.projectId, table.outcomeId).where(sql`${table.outcomeId} IS NOT NULL AND ${table.status} = 'active'`),
  index('idx_toc_nodes_project_id').on(table.projectId),
  index('idx_toc_nodes_organization_id').on(table.organizationId),
  index('idx_toc_nodes_outcome_id').on(table.outcomeId),
])

export const theoryOfChangeLinks = pgTable('theory_of_change_links', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  fromNodeId: uuid('from_node_id').references(() => theoryOfChangeNodes.id).notNull(),
  toNodeId: uuid('to_node_id').references(() => theoryOfChangeNodes.id).notNull(),
  assumption: text('assumption'),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('theory_of_change_links_status_check', sql`${table.status} IN ('active', 'archived')`),
  check('theory_of_change_links_no_self_check', sql`${table.fromNodeId} != ${table.toNodeId}`),
  // Link-type validity (activity->output, output->outcome only) is NOT a DB
  // constraint — it would require a self-join, not expressible as a portable
  // CHECK. Enforced in lib/pipeline/theory-of-change.ts's isValidLinkTransition.
  index('idx_toc_links_project_id').on(table.projectId),
  index('idx_toc_links_organization_id').on(table.organizationId),
  index('idx_toc_links_from_node_id').on(table.fromNodeId),
  index('idx_toc_links_to_node_id').on(table.toNodeId),
])
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (exit code 0).

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: output ending in `[✓] Your SQL migration file ➜ db\migrations\00NN_<name>.sql` — note the generated filename (it will be the next number after the highest existing migration in `db/migrations/`).

- [ ] **Step 4: Verify the migration is exactly the two new tables**

Run: `cat db/migrations/00NN_<name>.sql` (use the exact filename from Step 3)
Expected: two `CREATE TABLE` statements (`theory_of_change_nodes`, `theory_of_change_links`) plus their `CREATE INDEX`/`CREATE UNIQUE INDEX`/`ALTER TABLE ... ADD CONSTRAINT` statements. No `ALTER TABLE` on any pre-existing table (e.g. `outcomes`, `projects`) — if you see one, something in Step 1 is wrong; re-check the table definitions against Step 1 exactly before proceeding.

- [ ] **Step 5: Verify the chain is consistent**

Run: `npx drizzle-kit check`
Expected: `Everything's fine 🐶🔥`

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations/
git commit -m "feat(theory-of-change): add theory_of_change_nodes/links schema (Fase 2a)"
```

---

### Task 2: RLS policies

**Files:**
- Create: `db/policies/005_theory_of_change_rls.sql`

- [ ] **Step 1: Write the policy file**

```sql
-- db/policies/005_theory_of_change_rls.sql
-- RLS for the Fase 2a structured theory-of-change tables (theory_of_change_nodes,
-- theory_of_change_links). Mirrors the org-scoped pattern in
-- 001_initial_auth_rls.sql and reuses its SECURITY DEFINER helpers
-- (current_user_org_ids / current_user_is_super_admin / current_user_role_in_org).
-- Run in the Supabase SQL Editor. Idempotent: drops policies before recreating.

ALTER TABLE theory_of_change_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE theory_of_change_links ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- THEORY OF CHANGE NODES (org-scoped; analyst+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "theory_of_change_nodes_select" ON theory_of_change_nodes;
CREATE POLICY "theory_of_change_nodes_select" ON theory_of_change_nodes FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_nodes_insert" ON theory_of_change_nodes;
CREATE POLICY "theory_of_change_nodes_insert" ON theory_of_change_nodes FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_nodes_update" ON theory_of_change_nodes;
CREATE POLICY "theory_of_change_nodes_update" ON theory_of_change_nodes FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- ============================================================
-- THEORY OF CHANGE LINKS (org-scoped; analyst+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "theory_of_change_links_select" ON theory_of_change_links;
CREATE POLICY "theory_of_change_links_select" ON theory_of_change_links FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_links_insert" ON theory_of_change_links;
CREATE POLICY "theory_of_change_links_insert" ON theory_of_change_links FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_links_update" ON theory_of_change_links;
CREATE POLICY "theory_of_change_links_update" ON theory_of_change_links FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)
```

- [ ] **Step 2: Commit**

```bash
git add db/policies/005_theory_of_change_rls.sql
git commit -m "feat(theory-of-change): add RLS policies (Fase 2a)"
```

---

### Task 3: Pure link-validation function (TDD)

**Files:**
- Create: `lib/pipeline/theory-of-change.ts`
- Test: `tests/theory-of-change.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/theory-of-change.service.test.ts` with this content:

```ts
// tests/theory-of-change.service.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { isValidLinkTransition } from '@/lib/pipeline/theory-of-change';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/theory-of-change.service.test.ts`
Expected: FAIL — `lib/pipeline/theory-of-change.ts` does not exist yet (module not found).

- [ ] **Step 3: Create the service file with the pure function**

Create `lib/pipeline/theory-of-change.ts` with this content:

```ts
// lib/pipeline/theory-of-change.ts
// Fase 2a — structured theory of change (activity/output/outcome graph with
// typed causal links). Coexists with the free-text theoryOfChangeSummary field
// on impact_narratives; does not replace it. Outcome-type nodes reference real
// `outcomes` rows so the graph stays connected to the pipeline that actually
// feeds the SROI calculation, instead of becoming a parallel narrative.
// Design: docs/superpowers/specs/2026-07-05-theory-of-change-structured-design.md

export type ToCNodeType = 'activity' | 'output' | 'outcome'

/**
 * A causal link is only valid activity->output or output->outcome — modeling
 * the standard theory-of-change chain. A direct activity->outcome jump (or any
 * same-type / reversed-order link) must instead be documented as an assumption
 * on the intermediate output->outcome link, not modeled as its own edge.
 */
export function isValidLinkTransition(fromType: ToCNodeType, toType: ToCNodeType): boolean {
  return (fromType === 'activity' && toType === 'output') || (fromType === 'output' && toType === 'outcome')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/theory-of-change.service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/theory-of-change.ts tests/theory-of-change.service.test.ts
git commit -m "feat(theory-of-change): add isValidLinkTransition pure function (TDD)"
```

---

### Task 4: Node service (create/list/archive) with tests

**Files:**
- Modify: `lib/pipeline/theory-of-change.ts`
- Modify: `tests/theory-of-change.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this to the TOP of `tests/theory-of-change.service.test.ts`, before the existing `import { isValidLinkTransition } ...` line (mocks must be hoisted above the import of the module under test):

```ts
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
```

Then replace the line `import { isValidLinkTransition } from '@/lib/pipeline/theory-of-change';` with:

```ts
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
```

Also change the `import { describe, it, expect } from 'vitest';` line to:

```ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
```

Then append these new `describe` blocks at the END of the file (after the existing `isValidLinkTransition` describe block):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/theory-of-change.service.test.ts`
Expected: FAIL — `listNodesForProject`, `createNode`, `archiveNode` are not exported from `@/lib/pipeline/theory-of-change` (or `undefined is not a function`).

- [ ] **Step 3: Implement the node service functions**

Add this to `lib/pipeline/theory-of-change.ts`, after the `isValidLinkTransition` function:

```ts
import { db } from '@/db/client'
import { theoryOfChangeNodes, theoryOfChangeLinks, outcomes } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction } from '@/lib/audit/logger'

const CreateNodeSchema = z.object({
  nodeType: z.enum(['activity', 'output', 'outcome']),
  outcomeId: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
})
export type CreateNodeInput = z.infer<typeof CreateNodeSchema>

async function authorizeWrite() {
  const ctx = await requireOrganizationAccess()
  if (!hasRole(ctx.membership.role as Role, 'analyst')) throw new Error('Insufficient role')
  return ctx
}

export async function listNodesForProject(projectId: string) {
  const ctx = await requireOrganizationAccess()
  return db
    .select()
    .from(theoryOfChangeNodes)
    .where(and(
      eq(theoryOfChangeNodes.projectId, projectId),
      eq(theoryOfChangeNodes.organizationId, ctx.organization.id),
      eq(theoryOfChangeNodes.status, 'active'),
    ))
}

export async function createNode(projectId: string, input: CreateNodeInput) {
  const ctx = await authorizeWrite()
  const validated = CreateNodeSchema.parse(input)

  if (validated.nodeType === 'outcome') {
    if (!validated.outcomeId) throw new Error('outcomeId is required for an outcome node')

    const outcome = await db.select().from(outcomes).where(eq(outcomes.id, validated.outcomeId)).then((r) => r[0])
    if (!outcome || outcome.projectId !== projectId) throw new Error('Outcome not found for project')

    const siblingNodes = await db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.projectId, projectId))
    const alreadyModeled = siblingNodes.some((n) => n.outcomeId === validated.outcomeId && n.status === 'active')
    if (alreadyModeled) throw new Error('This outcome is already modeled in the graph')
  } else if (validated.outcomeId) {
    throw new Error('outcomeId must not be set for activity/output nodes')
  }

  const inserted = await db.insert(theoryOfChangeNodes).values({
    projectId,
    organizationId: ctx.organization.id,
    nodeType: validated.nodeType,
    outcomeId: validated.nodeType === 'outcome' ? validated.outcomeId : null,
    title: validated.title,
    description: validated.description,
    createdBy: ctx.user.id,
  }).returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_node',
    entityId: inserted[0].id,
    action: 'theory_of_change_node.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

export async function archiveNode(projectId: string, nodeId: string) {
  const ctx = await authorizeWrite()
  const existing = await db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.id, nodeId)).then((r) => r[0])
  if (!existing || existing.organizationId !== ctx.organization.id) throw new Error('Node not found')

  await db.update(theoryOfChangeNodes).set({ status: 'archived', updatedAt: new Date() }).where(eq(theoryOfChangeNodes.id, nodeId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_node',
    entityId: nodeId,
    action: 'theory_of_change_node.archived',
    beforeJson: existing as unknown as Record<string, unknown>,
  })
  return { id: nodeId, status: 'archived' as const }
}
```

Note: `theoryOfChangeLinks` and `inArray` are imported now even though unused until Task 5 — this avoids a second edit to the import line later. If your editor/linter flags unused imports before Task 5 lands, that's expected and will resolve once Task 5 adds the code that uses them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/theory-of-change.service.test.ts`
Expected: PASS (all tests so far — 5 from Task 3 + 9 from this task).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `theoryOfChangeLinks`/`inArray` show as unused-import errors rather than warnings under this project's tsconfig, remove them from the import line for now and re-add in Task 5 instead of leaving them unused.)

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/theory-of-change.ts tests/theory-of-change.service.test.ts
git commit -m "feat(theory-of-change): add node CRUD service (create/list/archive) with tests"
```

---

### Task 5: Link service (create/list/archive) with tests

**Files:**
- Modify: `lib/pipeline/theory-of-change.ts`
- Modify: `tests/theory-of-change.service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/theory-of-change.service.test.ts`, change the service import to also include the link functions:

```ts
import {
  isValidLinkTransition,
  listNodesForProject,
  createNode,
  archiveNode,
  listLinksForProject,
  createLink,
  archiveLink,
} from '@/lib/pipeline/theory-of-change';
```

Then append these `describe` blocks at the end of the file:

```ts
describe('createLink', () => {
  it('creates a valid activity -> output link', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
      { id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'output', status: 'active' },
    ];
    const link = await createLink(PROJECT_ID, { fromNodeId: 'act-1', toNodeId: 'out-1', assumption: 'Asistencia mínima 80%' });
    expect(link.fromNodeId).toBe('act-1');
    expect(link.toNodeId).toBe('out-1');
    expect(link.assumption).toBe('Asistencia mínima 80%');
  });

  it('creates a valid output -> outcome link', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'output', status: 'active' },
      { id: 'oc-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'outcome', outcomeId: OUTCOME_ID, status: 'active' },
    ];
    const link = await createLink(PROJECT_ID, { fromNodeId: 'out-1', toNodeId: 'oc-1' });
    expect(link.toNodeId).toBe('oc-1');
  });

  it('rejects a direct activity -> outcome link', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
      { id: 'oc-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'outcome', outcomeId: OUTCOME_ID, status: 'active' },
    ];
    await expect(createLink(PROJECT_ID, { fromNodeId: 'act-1', toNodeId: 'oc-1' })).rejects.toThrow('Invalid link');
  });

  it('rejects a reversed-order link (output -> activity)', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
      { id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'output', status: 'active' },
    ];
    await expect(createLink(PROJECT_ID, { fromNodeId: 'out-1', toNodeId: 'act-1' })).rejects.toThrow('Invalid link');
  });

  it('rejects a self-link', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
    ];
    await expect(createLink(PROJECT_ID, { fromNodeId: 'act-1', toNodeId: 'act-1' })).rejects.toThrow('cannot link to itself');
  });

  it('rejects linking to a node from another project', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
      { id: 'out-1', projectId: 'other-project', organizationId: ORG_ID, nodeType: 'output', status: 'active' },
    ];
    await expect(createLink(PROJECT_ID, { fromNodeId: 'act-1', toNodeId: 'out-1' })).rejects.toThrow('To-node not found for project');
  });
});

describe('archiveLink', () => {
  it('marks a link archived', async () => {
    mockDbData.theoryOfChangeLinks = [{ id: 'link-1', projectId: PROJECT_ID, organizationId: ORG_ID, fromNodeId: 'a', toNodeId: 'b', status: 'active' }];
    const result = await archiveLink(PROJECT_ID, 'link-1');
    expect(result.status).toBe('archived');
    expect(mockDbData.theoryOfChangeLinks[0].status).toBe('archived');
  });
});

describe('listLinksForProject', () => {
  it('returns an active link whose endpoints are both active', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
      { id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'output', status: 'active' },
    ];
    mockDbData.theoryOfChangeLinks = [{ id: 'link-1', projectId: PROJECT_ID, organizationId: ORG_ID, fromNodeId: 'act-1', toNodeId: 'out-1', status: 'active' }];
    const links = await listLinksForProject(PROJECT_ID);
    expect(links).toHaveLength(1);
  });

  it('excludes a link when one endpoint node has been archived', async () => {
    mockDbData.theoryOfChangeNodes = [
      { id: 'act-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'activity', status: 'active' },
      { id: 'out-1', projectId: PROJECT_ID, organizationId: ORG_ID, nodeType: 'output', status: 'archived' },
    ];
    mockDbData.theoryOfChangeLinks = [{ id: 'link-1', projectId: PROJECT_ID, organizationId: ORG_ID, fromNodeId: 'act-1', toNodeId: 'out-1', status: 'active' }];
    const links = await listLinksForProject(PROJECT_ID);
    expect(links).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/theory-of-change.service.test.ts`
Expected: FAIL — `listLinksForProject`, `createLink`, `archiveLink` are not exported from `@/lib/pipeline/theory-of-change`.

- [ ] **Step 3: Implement the link service functions**

Add this to `lib/pipeline/theory-of-change.ts`, after the `archiveNode` function:

```ts
const CreateLinkSchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  assumption: z.string().optional(),
})
export type CreateLinkInput = z.infer<typeof CreateLinkSchema>

export async function listLinksForProject(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const links = await db.select().from(theoryOfChangeLinks).where(and(
    eq(theoryOfChangeLinks.projectId, projectId),
    eq(theoryOfChangeLinks.organizationId, ctx.organization.id),
    eq(theoryOfChangeLinks.status, 'active'),
  ))
  if (links.length === 0) return []

  const nodeIds = [...new Set(links.flatMap((l) => [l.fromNodeId, l.toNodeId]))]
  const relatedNodes = await db.select().from(theoryOfChangeNodes).where(inArray(theoryOfChangeNodes.id, nodeIds))
  const activeNodeIds = new Set(relatedNodes.filter((n) => n.status === 'active').map((n) => n.id))

  return links.filter((l) => activeNodeIds.has(l.fromNodeId) && activeNodeIds.has(l.toNodeId))
}

export async function createLink(projectId: string, input: CreateLinkInput) {
  const ctx = await authorizeWrite()
  const validated = CreateLinkSchema.parse(input)

  if (validated.fromNodeId === validated.toNodeId) throw new Error('A node cannot link to itself')

  const [fromNode, toNode] = await Promise.all([
    db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.id, validated.fromNodeId)).then((r) => r[0]),
    db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.id, validated.toNodeId)).then((r) => r[0]),
  ])
  if (!fromNode || fromNode.projectId !== projectId) throw new Error('From-node not found for project')
  if (!toNode || toNode.projectId !== projectId) throw new Error('To-node not found for project')

  if (!isValidLinkTransition(fromNode.nodeType as ToCNodeType, toNode.nodeType as ToCNodeType)) {
    throw new Error(`Invalid link: ${fromNode.nodeType} -> ${toNode.nodeType} is not allowed (only activity->output or output->outcome)`)
  }

  const inserted = await db.insert(theoryOfChangeLinks).values({
    projectId,
    organizationId: ctx.organization.id,
    fromNodeId: validated.fromNodeId,
    toNodeId: validated.toNodeId,
    assumption: validated.assumption,
    createdBy: ctx.user.id,
  }).returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_link',
    entityId: inserted[0].id,
    action: 'theory_of_change_link.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

export async function archiveLink(projectId: string, linkId: string) {
  const ctx = await authorizeWrite()
  const existing = await db.select().from(theoryOfChangeLinks).where(eq(theoryOfChangeLinks.id, linkId)).then((r) => r[0])
  if (!existing || existing.organizationId !== ctx.organization.id) throw new Error('Link not found')

  await db.update(theoryOfChangeLinks).set({ status: 'archived', updatedAt: new Date() }).where(eq(theoryOfChangeLinks.id, linkId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_link',
    entityId: linkId,
    action: 'theory_of_change_link.archived',
    beforeJson: existing as unknown as Record<string, unknown>,
  })
  return { id: linkId, status: 'archived' as const }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/theory-of-change.service.test.ts`
Expected: PASS (all tests — 5 + 9 + 8 = 22 total).

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint lib/pipeline/theory-of-change.ts tests/theory-of-change.service.test.ts`
Expected: no errors (warnings acceptable only if pre-existing elsewhere in the codebase; do not introduce new ones).

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/theory-of-change.ts tests/theory-of-change.service.test.ts
git commit -m "feat(theory-of-change): add link CRUD service (create/list/archive) with tests"
```

---

### Task 6: Server actions

**Files:**
- Create: `app/app/projects/[projectId]/pipeline/theoryOfChange.actions.ts`

- [ ] **Step 1: Write the actions file**

```ts
// app/app/projects/[projectId]/pipeline/theoryOfChange.actions.ts
// Fase 2a — server actions for the structured theory-of-change graph.

'use server';

import {
  listNodesForProject,
  createNode,
  archiveNode,
  listLinksForProject,
  createLink,
  archiveLink,
} from '@/lib/pipeline/theory-of-change';

export async function fetchToCNodes(projectId: string) {
  return listNodesForProject(projectId);
}

export async function fetchToCLinks(projectId: string) {
  return listLinksForProject(projectId);
}

export async function createToCNodeAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const nodeType = formData.get('nodeType') as 'activity' | 'output' | 'outcome';
  const outcomeId = (formData.get('outcomeId') as string | null) || undefined;
  const title = formData.get('title') as string;
  const description = (formData.get('description') as string | null) || undefined;
  return createNode(projectId, { nodeType, outcomeId, title, description });
}

export async function archiveToCNodeAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const nodeId = formData.get('nodeId') as string;
  return archiveNode(projectId, nodeId);
}

export async function createToCLinkAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const fromNodeId = formData.get('fromNodeId') as string;
  const toNodeId = formData.get('toNodeId') as string;
  const assumption = (formData.get('assumption') as string | null) || undefined;
  return createLink(projectId, { fromNodeId, toNodeId, assumption });
}

export async function archiveToCLinkAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const linkId = formData.get('linkId') as string;
  return archiveLink(projectId, linkId);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "app/app/projects/[projectId]/pipeline/theoryOfChange.actions.ts"
git commit -m "feat(theory-of-change): add server actions"
```

---

### Task 7: UI — add the section to the Narrativa page

**Files:**
- Modify: `app/app/projects/[projectId]/pipeline/narrative/page.tsx`

- [ ] **Step 1: Add imports**

At the top of `app/app/projects/[projectId]/pipeline/narrative/page.tsx`, after the existing `import { z } from 'zod';` line, add:

```ts
import { listOutcomesForProject } from '@/lib/pipeline/outcomes';
import {
  fetchToCNodes,
  fetchToCLinks,
  createToCNodeAction,
  archiveToCNodeAction,
  createToCLinkAction,
  archiveToCLinkAction,
} from '../theoryOfChange.actions';
import { revalidatePath } from 'next/cache';
```

- [ ] **Step 2: Fetch data in the page component**

Inside `NarrativePage`, immediately after the line `const data = narrative ?? {};`, add:

```ts
  const [outcomes, nodes, links] = await Promise.all([
    listOutcomesForProject(projectId),
    fetchToCNodes(projectId),
    fetchToCLinks(projectId),
  ]);

  const activities = nodes.filter((n) => n.nodeType === 'activity');
  const outputs = nodes.filter((n) => n.nodeType === 'output');
  const outcomeNodes = nodes.filter((n) => n.nodeType === 'outcome');
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outcomeById = new Map(outcomes.map((o) => [o.id, o]));
  const modeledOutcomeIds = new Set(outcomeNodes.map((n) => n.outcomeId));
  const availableOutcomes = outcomes.filter((o) => !modeledOutcomeIds.has(o.id));
  const linksByFromNode = new Map<string, typeof links>();
  for (const l of links) {
    const list = linksByFromNode.get(l.fromNodeId) ?? [];
    list.push(l);
    linksByFromNode.set(l.fromNodeId, list);
  }

  async function handleCreateNode(formData: FormData) {
    'use server';
    await createToCNodeAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  async function handleArchiveNode(formData: FormData) {
    'use server';
    await archiveToCNodeAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  async function handleCreateLink(formData: FormData) {
    'use server';
    await createToCLinkAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  async function handleArchiveLink(formData: FormData) {
    'use server';
    await archiveToCLinkAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }
```

- [ ] **Step 3: Add the UI section**

Find the closing `</form>` tag that ends the existing narrative form (right before the final `</div>\n  );\n}` of the component). Insert the following JSX immediately after that `</form>` and before the final `</div>`:

```tsx
      <div className="border-t border-border pt-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Teoría de cambio estructurada</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Modela actividades, productos y resultados como un grafo simple, con supuestos
            explícitos por enlace. Es opcional y complementa (no reemplaza) el resumen de arriba.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Activities */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Actividades</h3>
            <ul className="space-y-2">
              {activities.map((n) => (
                <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{n.title}</span>
                    <form action={handleArchiveNode}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="nodeId" value={n.id} />
                      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Quitar</button>
                    </form>
                  </div>
                  {(linksByFromNode.get(n.id) ?? []).map((l) => (
                    <p key={l.id} className="mt-1 text-xs text-muted-foreground">
                      → {nodeById.get(l.toNodeId)?.title ?? '—'}
                      {l.assumption && <span className="italic"> ({l.assumption})</span>}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            <form action={handleCreateNode} className="space-y-1">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="nodeType" value="activity" />
              <input name="title" type="text" required placeholder="Nueva actividad" className={INPUT_CLASS} />
              <button type="submit" className="text-xs font-medium text-primary">Agregar</button>
            </form>
          </div>

          {/* Outputs */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Productos</h3>
            <ul className="space-y-2">
              {outputs.map((n) => (
                <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{n.title}</span>
                    <form action={handleArchiveNode}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="nodeId" value={n.id} />
                      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Quitar</button>
                    </form>
                  </div>
                  {(linksByFromNode.get(n.id) ?? []).map((l) => (
                    <p key={l.id} className="mt-1 text-xs text-muted-foreground">
                      → {nodeById.get(l.toNodeId)?.title ?? '—'}
                      {l.assumption && <span className="italic"> ({l.assumption})</span>}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            <form action={handleCreateNode} className="space-y-1">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="nodeType" value="output" />
              <input name="title" type="text" required placeholder="Nuevo producto" className={INPUT_CLASS} />
              <button type="submit" className="text-xs font-medium text-primary">Agregar</button>
            </form>
          </div>

          {/* Outcomes */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Resultados</h3>
            <ul className="space-y-2">
              {outcomeNodes.map((n) => (
                <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{outcomeById.get(n.outcomeId ?? '')?.title ?? n.title}</span>
                    <form action={handleArchiveNode}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="nodeId" value={n.id} />
                      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Quitar</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
            {availableOutcomes.length > 0 && (
              <form action={handleCreateNode} className="space-y-1">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="nodeType" value="outcome" />
                <select name="outcomeId" required className={INPUT_CLASS}>
                  <option value="">— Seleccionar resultado —</option>
                  {availableOutcomes.map((o) => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </select>
                <input type="hidden" name="title" value="_" />
                <button type="submit" className="text-xs font-medium text-primary">Agregar al grafo</button>
              </form>
            )}
          </div>
        </div>

        {/* Link creation */}
        {(activities.length > 0 || outputs.length > 0) && (
          <div className="rounded-md border border-border p-4 space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Nuevo enlace causal</h3>
            <form action={handleCreateLink} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="projectId" value={projectId} />
              <div>
                <label className="block text-xs text-muted-foreground">Desde</label>
                <select name="fromNodeId" required className={INPUT_CLASS}>
                  {[...activities, ...outputs].map((n) => (
                    <option key={n.id} value={n.id}>{n.title} ({n.nodeType})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-muted-foreground">Hacia</label>
                <select name="toNodeId" required className={INPUT_CLASS}>
                  {[...outputs, ...outcomeNodes].map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.nodeType === 'outcome' ? outcomeById.get(n.outcomeId ?? '')?.title ?? n.title : n.title} ({n.nodeType})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-muted-foreground">Supuesto (opcional)</label>
                <input name="assumption" type="text" className={INPUT_CLASS} />
              </div>
              <button type="submit" className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
                Enlazar
              </button>
            </form>
            <p className="text-xs text-muted-foreground">
              Solo se permiten enlaces actividad→producto o producto→resultado.
            </p>
          </div>
        )}
      </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `npx eslint "app/app/projects/[projectId]/pipeline/narrative/page.tsx" "app/app/projects/[projectId]/pipeline/theoryOfChange.actions.ts"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "app/app/projects/[projectId]/pipeline/narrative/page.tsx"
git commit -m "feat(theory-of-change): add structured graph UI to Narrativa page"
```

---

### Task 8: Full verification, production migration, PR

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full lint**

Run: `npx eslint .`
Expected: no new errors (pre-existing warnings elsewhere in the repo are not your concern).

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the 22 new theory-of-change tests. Note the total count before this task started (655 as of the last verified state) and confirm the new total is `655 + 22 = 677`.

- [ ] **Step 4: Verify drizzle chain**

Run: `npx drizzle-kit check`
Expected: `Everything's fine 🐶🔥`

Run: `npx drizzle-kit generate`
Expected: `No schema changes, nothing to migrate 😴` (confirms Task 1's migration already captured everything in `schema.ts`).

- [ ] **Step 5: Apply migration + RLS to production — CONFIRM WITH THE USER FIRST**

This is the only step in this plan that touches the real production database. The migration is purely additive (two brand-new, empty tables, no alteration of any existing table), so unlike Fase 1b there is no code/schema ordering hazard — but do not run this without the user's explicit go-ahead in that session, matching how every prior production DB write in this project was gated.

Once confirmed:

Run: `npx drizzle-kit migrate`
Expected: `[✓] migrations applied successfully!`

Then apply the RLS file. Read `db/policies/005_theory_of_change_rls.sql` and run its contents against the production database (the established method in this project is executing the SQL via a short-lived script using the `postgres` package and `process.env.DATABASE_URL`, mirroring how `db/policies/004_fx_tables_rls.sql` was applied — see that commit's approach if unsure).

Verify read-only afterward: confirm `theory_of_change_nodes` and `theory_of_change_links` exist with `rowsecurity = true` and the expected policies, e.g.:

```sql
SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relname IN ('theory_of_change_nodes','theory_of_change_links');
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename IN ('theory_of_change_nodes','theory_of_change_links');
```

Expected: both tables `rowsecurity=true`, 3 policies each (select/insert/update, no delete).

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feature/fase-2a-theory-of-change
gh pr create --base feature/pipeline-integrity-hardening --head feature/fase-2a-theory-of-change --title "Fase 2a: teoría de cambio estructurada" --body "$(cat <<'EOF'
## Fase 2a — Teoría de cambio estructurada

Implementa el diseño en docs/superpowers/specs/2026-07-05-theory-of-change-structured-design.md: un grafo simple de actividades → productos → resultados con enlaces causales tipados y supuestos opcionales por enlace. Coexiste con (no reemplaza) el campo de texto libre `theoryOfChangeSummary` existente.

### Modelo de datos
- `theory_of_change_nodes` — nodos tipados (activity/output/outcome); los nodos de tipo `outcome` referencian una fila real de `outcomes`, únicos por proyecto mientras estén activos.
- `theory_of_change_links` — enlaces con orden causal fijo (activity→output, output→outcome únicamente), validado en el servicio (`isValidLinkTransition`, TDD).

### UI
Nueva sección en la página de Narrativa existente — tabular (listas + formularios), sin editor visual. No agrega paso nuevo al Stepper.

### Verificación
- 22 tests nuevos (suite total: 677), typecheck + lint + drizzle-check limpios.
- Migración puramente aditiva (2 tablas nuevas y vacías) — sin riesgo de secuencia con el deploy de código, a diferencia de Fase 1b.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR created against `feature/pipeline-integrity-hardening`.

---

## Self-review notes

- Spec coverage: data model (Task 1), RLS (Task 2), link-validity pure function (Task 3), node service (Task 4), link service (Task 5), server actions (Task 6), UI inside Narrativa (Task 7) — every spec section has a task.
- Deliberately deferred per spec's Non-goals: no report-section wiring, no visual canvas, no "complete graph" validation — none of these appear as tasks (correct, matches spec).
- Type/name consistency checked: `ToCNodeType`, `isValidLinkTransition`, `listNodesForProject`, `createNode`, `archiveNode`, `listLinksForProject`, `createLink`, `archiveLink` are spelled identically across Tasks 3–7 (schema field names `nodeType`/`outcomeId`/`fromNodeId`/`toNodeId`/`assumption` also consistent throughout).
- Production write (Task 8 Step 5) explicitly gated behind user confirmation, consistent with this project's established practice this session.
