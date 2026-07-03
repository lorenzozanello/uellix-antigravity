# Stella completa + cuotas de uso por organización — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Stella's third role (Composer), fix a preexisting audit-logging gap in the Advisor, add an organization-level monthly usage quota for Stella (admin-assigned, no payment gateway), extend Advisor coverage to the Calculation step, and turn on all Stella flags in Vercel Preview and Production.

**Architecture:** Follows the codebase's existing Stella pattern exactly (`app/actions/stella/{advisor,validator}.ts` as the template for the new `composer.ts`; `lib/stella/context/build-{advisor,validator}-context.ts` as the template for `build-composer-context.ts`). Quota is enforced by counting existing `stella_interactions` audit rows for the current UTC calendar month against a new `organizations.stellaMonthlyQuota` column — no new usage-tracking table. All new organizations default to quota `0` (blocked) until a super_admin assigns a real value via a new `/admin/services` page.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM (Postgres/Supabase), Zod, Vitest, `@google/genai` (Gemini), Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-07-02-stella-complete-quotas-design.md`

---

## File Structure

**New files:**
- `db/migrations/00XX_<auto>.sql` + `db/migrations/meta/00XX_snapshot.json` — schema migration (auto-named by `drizzle-kit generate`)
- `lib/stella/quota.ts` — quota check logic
- `tests/stella-quota.test.ts`
- `lib/admin/stella-services.ts` — admin service/quota management
- `tests/admin-stella-services.service.test.ts`
- `app/admin/services/page.tsx`
- `app/admin/services/actions.ts`
- `lib/stella/context/build-composer-context.ts`
- `lib/stella/context/__tests__/build-composer-context.test.ts`
- `app/actions/stella/composer.ts`
- `app/actions/stella/__tests__/composer.test.ts`
- `components/stella/StellaComposerPanel.tsx`
- `components/stella/__tests__/StellaComposerPanel.test.tsx`

**Modified files:**
- `db/schema.ts` — add `stellaMonthlyQuota`, `stellaPlanLabel` to `organizations`
- `app/actions/stella/advisor.ts` — add `stella_interactions` insert (bug fix), add quota check
- `app/actions/stella/__tests__/advisor.test.ts`
- `app/actions/stella/validator.ts` — add quota check
- `app/actions/stella/__tests__/validator.test.ts`
- `lib/stella/context/build-advisor-context.ts` — remove Calculation-step rejection
- `lib/stella/context/__tests__/build-advisor-context.test.ts`
- `components/stella/StellaAdvisorPanel.tsx` — add `quota_exceeded` state + empty-step highlight
- `components/stella/StellaValidatorPanel.tsx` — add `quota_exceeded` state
- `components/stella/__tests__/StellaAdvisorPanel.test.tsx`
- `components/stella/__tests__/StellaValidatorPanel.test.tsx`
- `components/stella/index.ts` — export `StellaComposerPanel`
- `app/admin/layout.tsx` — add "Servicios Stella" nav link
- `lib/audit/logger.ts` — add `STELLA_SERVICE_UPDATED` action
- `app/app/projects/[projectId]/pipeline/calculation/page.tsx` — add `StellaAdvisorPanel`
- `app/app/projects/[projectId]/pipeline/{stakeholders,outcomes,indicators,evidence,proxies,narrative}/page.tsx` — pass empty-step highlight prop
- `app/app/projects/[projectId]/report/[reportId]/page.tsx` — add `StellaComposerPanel` per section

---

## Task 1: Add quota columns to `organizations`

**Files:**
- Modify: `db/schema.ts`

- [ ] **Step 1: Add the two new columns**

Find the `organizations` table definition near the top of `db/schema.ts`:

```ts
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  legalName: varchar('legal_name', { length: 255 }),
  country: varchar('country', { length: 2 }),
  sector: varchar('sector', { length: 255 }),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

Replace with:

```ts
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  legalName: varchar('legal_name', { length: 255 }),
  country: varchar('country', { length: 2 }),
  sector: varchar('sector', { length: 255 }),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  // Stella usage quota: null = unlimited (internal/Uellix use only); 0 = blocked
  // (default — no plan assigned yet); N = monthly cap on Stella calls. Assigned
  // manually by a super_admin via /admin/services — no payment gateway.
  stellaMonthlyQuota: integer('stella_monthly_quota').default(0),
  stellaPlanLabel: varchar('stella_plan_label', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

`integer` is already imported at the top of `db/schema.ts` (used elsewhere) — no import change needed.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: `[✓] Your SQL migration file ➜ db\migrations\00XX_<name>.sql 🚀` (drizzle-kit picks the number and name). Read the generated SQL file and confirm it contains exactly two `ALTER TABLE "organizations" ADD COLUMN` statements for `stella_monthly_quota` (integer, default 0) and `stella_plan_label` (varchar(100), nullable) — nothing else.

- [ ] **Step 3: Apply the migration to the real database**

Run: `pnpm db:migrate`
Expected: `[✓] migrations applied successfully!`

- [ ] **Step 4: Verify with typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/migrations/
git commit -m "feat: add Stella monthly quota columns to organizations"
```

---

## Task 2: `lib/stella/quota.ts` — quota check logic

**Files:**
- Create: `lib/stella/quota.ts`
- Test: `tests/stella-quota.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/stella-quota.test.ts`:

```ts
// tests/stella-quota.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDbData = vi.hoisted(() => ({
  org: null as { stellaMonthlyQuota: number | null } | null,
  interactionCount: 0,
}))

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation((fields?: Record<string, unknown>) => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => ({
            then: (cb: (rows: unknown[]) => unknown) => {
              const isOrgQuery = fields && 'stellaMonthlyQuota' in fields
              if (isOrgQuery) {
                return Promise.resolve(cb(mockDbData.org ? [mockDbData.org] : []))
              }
              return Promise.resolve(cb([]))
            },
          })),
          then: (cb: (rows: unknown[]) => unknown) => {
            // count query path (no .limit())
            return Promise.resolve(cb([{ value: mockDbData.interactionCount }]))
          },
        })),
      })),
    })),
  },
}))

import { checkStellaQuota } from '@/lib/stella/quota'

beforeEach(() => {
  vi.clearAllMocks()
  mockDbData.org = null
  mockDbData.interactionCount = 0
})

describe('checkStellaQuota', () => {
  it('allows unlimited access when quota is null', async () => {
    mockDbData.org = { stellaMonthlyQuota: null }
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(true)
  })

  it('blocks with reason no_quota when quota is 0', async () => {
    mockDbData.org = { stellaMonthlyQuota: 0 }
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('no_quota')
  })

  it('allows when usage is below a positive quota', async () => {
    mockDbData.org = { stellaMonthlyQuota: 10 }
    mockDbData.interactionCount = 3
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.used).toBe(3)
      expect(result.quota).toBe(10)
    }
  })

  it('blocks with reason quota_exceeded when usage equals quota', async () => {
    mockDbData.org = { stellaMonthlyQuota: 10 }
    mockDbData.interactionCount = 10
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe('quota_exceeded')
      expect(result.used).toBe(10)
      expect(result.quota).toBe(10)
    }
  })

  it('blocks with reason quota_exceeded when usage is over quota', async () => {
    mockDbData.org = { stellaMonthlyQuota: 10 }
    mockDbData.interactionCount = 15
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('quota_exceeded')
  })

  it('treats a missing organization as no_quota (fails closed)', async () => {
    mockDbData.org = null
    const result = await checkStellaQuota('org-missing')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('no_quota')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stella-quota.test.ts`
Expected: FAIL — `Cannot find module '@/lib/stella/quota'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/stella/quota.ts`:

```ts
// lib/stella/quota.ts
// Org-level monthly quota on Stella usage. No payment gateway — quotas are
// assigned manually by a super_admin via /admin/services. Every organization
// defaults to quota 0 (blocked) until explicitly assigned. Usage is measured
// by counting existing stella_interactions audit rows for the current UTC
// calendar month — no separate usage-tracking table.

import { db } from '@/db/client'
import { organizations, stellaInteractions } from '@/db/schema'
import { eq, and, gte, count } from 'drizzle-orm'

export type StellaQuotaResult =
  | { allowed: true; used: number; quota: number | null }
  | { allowed: false; used: number; quota: number; reason: 'no_quota' | 'quota_exceeded' }

function startOfCurrentUtcMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

export async function checkStellaQuota(organizationId: string): Promise<StellaQuotaResult> {
  const org = await db
    .select({ stellaMonthlyQuota: organizations.stellaMonthlyQuota })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  const quota = org?.stellaMonthlyQuota ?? 0

  if (quota === null) {
    return { allowed: true, used: 0, quota: null }
  }

  if (quota === 0) {
    return { allowed: false, used: 0, quota: 0, reason: 'no_quota' }
  }

  const used = await db
    .select({ value: count() })
    .from(stellaInteractions)
    .where(
      and(
        eq(stellaInteractions.organizationId, organizationId),
        gte(stellaInteractions.createdAt, startOfCurrentUtcMonth())
      )
    )
    .then((rows) => rows[0]?.value ?? 0)

  if (used >= quota) {
    return { allowed: false, used, quota, reason: 'quota_exceeded' }
  }

  return { allowed: true, used, quota }
}

/** First day of next UTC month, ISO string — for user-facing "resets on" messages. */
export function nextQuotaResetIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/stella-quota.test.ts`
Expected: PASS, 6/6 tests.

If the mock's dual `.limit()`/no-`.limit()` branching is fragile against the real query shapes, simplify by giving each query its own dedicated mock path keyed off the table argument instead of the `fields` argument — the goal is just that the org lookup and the count lookup resolve independently.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors. (`stellaInteractions` is already exported from `db/schema.ts`.)

- [ ] **Step 6: Commit**

```bash
git add lib/stella/quota.ts tests/stella-quota.test.ts
git commit -m "feat: add checkStellaQuota for org-level monthly usage limits"
```

---

## Task 3: Fix the Advisor's missing audit-log insert

**Files:**
- Modify: `app/actions/stella/advisor.ts`
- Modify: `app/actions/stella/__tests__/advisor.test.ts`

Today only `validator.ts` writes to `stella_interactions`. This must be fixed before quota enforcement can measure Advisor usage at all.

- [ ] **Step 1: Read the current test file's mock setup**

Open `app/actions/stella/__tests__/advisor.test.ts` and confirm it does **not** currently mock `@/db/client` (since advisor.ts doesn't import it yet). You'll add that mock in this step.

- [ ] **Step 2: Write the failing test**

Add to `app/actions/stella/__tests__/advisor.test.ts`, near the top with the other `vi.mock` calls (mirror the exact mock shape used in `app/actions/stella/__tests__/validator.test.ts`):

```ts
const mockInsertValues = vi.fn().mockResolvedValue([])
const mockDbInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))
```

Then add a new `describe` block (mirror `validator.test.ts`'s "Audit insert" block), after the existing "Gemini integration" block:

```ts
  describe('Audit insert', () => {
    it('inserts into stellaInteractions after successful parse', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      expect(mockDbInsert).toHaveBeenCalled()
      expect(mockInsertValues).toHaveBeenCalled()
    })

    it('inserts with advisor role', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.stellaRole).toBe('advisor')
    })

    it('inserts with organization.id from auth context', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.organizationId).toBe('org-uuid-001')
    })

    it('inserts with the given step as pipelineStep', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.pipelineStep).toBe('Narrativa')
    })

    it('returns AUDIT_ERROR when insert fails', async () => {
      setupSuccessfulCall()
      mockInsertValues.mockRejectedValue(new Error('DB connection error'))
      const result = await getStellaAdvisor('proj-1', 'Narrativa')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
    })
  })
```

Check the file's existing `setupSuccessfulCall()` helper (or equivalent per-test setup) — it must call `mockInsertValues.mockResolvedValue([])` too, matching the pattern in `validator.test.ts`. If `advisor.test.ts` doesn't have a shared `setupSuccessfulCall()` helper yet, add one mirroring `validator.test.ts`'s, or inline the four mock calls (`mockCheckStellaRateLimit`, `mockRequireOrganizationAccess`, `mockBuildAdvisorContext`, `mockAdapterGenerate`/`mockAdapterParseResponse`, `mockInsertValues`) at the top of each new test the way the file's existing tests already do.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/actions/stella/__tests__/advisor.test.ts`
Expected: FAIL on the new "Audit insert" tests — `mockDbInsert` never called (advisor.ts doesn't insert yet), and no `AUDIT_ERROR` error code exists yet on `StellaAdvisorErrorCode`.

- [ ] **Step 4: Implement — add the insert to advisor.ts**

Modify `app/actions/stella/advisor.ts`. Add imports at the top:

```ts
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
```

Add `'AUDIT_ERROR'` to the error code union:

```ts
export type StellaAdvisorErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'RATE_LIMITED'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'
```

Inside the `try` block, right after `const data = await adapter.parseResponse(response.rawOutput, AdvisorOutputSchema)` and before `return { ok: true, data }`, insert:

```ts
    // Audit insert — required for compliance and for quota measurement;
    // surface failure rather than swallow (mirrors validator.ts).
    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: 'advisor',
        pipelineStep: step,
        contextHash: '',
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
      })
    } catch {
      return {
        ok: false,
        error: 'AUDIT_ERROR',
        message: 'Failed to record Stella interaction. Please try again.',
      }
    }

    return { ok: true, data }
```

(This replaces the existing bare `return { ok: true, data }` line.) Note `contextHash: ''` — unlike Validator, Advisor doesn't currently compute a context hash; passing an empty string satisfies the `stellaInteractions.contextHash` NOT NULL column without inventing a hashing scheme out of scope for this task. `riskLevel`/`riskFlags` are omitted (nullable columns, validator-only).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/actions/stella/__tests__/advisor.test.ts`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add app/actions/stella/advisor.ts app/actions/stella/__tests__/advisor.test.ts
git commit -m "fix: Advisor now logs to stella_interactions (was silently not auditing)"
```

---

## Task 4: Quota enforcement in `advisor.ts` and `validator.ts`

**Files:**
- Modify: `app/actions/stella/advisor.ts`
- Modify: `app/actions/stella/__tests__/advisor.test.ts`
- Modify: `app/actions/stella/validator.ts`
- Modify: `app/actions/stella/__tests__/validator.test.ts`

- [ ] **Step 1: Write the failing tests (advisor)**

Add to `app/actions/stella/__tests__/advisor.test.ts`, near the other `vi.mock` calls:

```ts
const mockCheckStellaQuota = vi.fn()
vi.mock('@/lib/stella/quota', () => ({
  checkStellaQuota: (...args: unknown[]) => mockCheckStellaQuota(...args),
  nextQuotaResetIso: () => '2026-08-01T00:00:00.000Z',
}))
```

Update the shared `setupSuccessfulCall()` helper (or equivalent) to also call:

```ts
mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 2, quota: 50 })
```

Add a new `describe` block after "Rate limiting":

```ts
  describe('Quota enforcement', () => {
    it('returns QUOTA_EXCEEDED when org has no quota assigned', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 0, quota: 0, reason: 'no_quota' })

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
    })

    it('returns QUOTA_EXCEEDED when org used up its monthly quota', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('QUOTA_EXCEEDED')
        expect(result.message).toContain('50')
      }
    })

    it('does NOT call Gemini when quota exceeded', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })

      await getStellaAdvisor('proj-1', 'Narrativa')

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('checks quota with organization.id', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      expect(mockCheckStellaQuota).toHaveBeenCalledWith('org-uuid-001')
    })

    it('allows unlimited orgs (quota: null) through', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: null })
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'advisor', rawOutput: JSON.stringify(VALID_ADVISOR_OUTPUT), parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_ADVISOR_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(true)
    })
  })
```

Adjust the fixture names (`VALID_ADVISOR_OUTPUT`, `MOCK_CONTEXT`, `MOCK_ORG_CONTEXT`) to whatever the existing file already calls them — check the top of `advisor.test.ts` for the actual fixture names before pasting.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/actions/stella/__tests__/advisor.test.ts`
Expected: FAIL — `checkStellaQuota` mock never invoked (not yet called from `advisor.ts`), no `QUOTA_EXCEEDED` error code.

- [ ] **Step 3: Implement — advisor.ts**

Add import:

```ts
import { checkStellaQuota, nextQuotaResetIso } from '@/lib/stella/quota'
```

Add `'QUOTA_EXCEEDED'` to `StellaAdvisorErrorCode`.

Insert the quota check right after the rate-limit check block and before the `try` block that builds context:

```ts
  // Quota check — enforced per org, per calendar month, DB-backed.
  // Every org defaults to quota 0 (blocked) until a super_admin assigns one.
  const quotaCheck = await checkStellaQuota(ctx.organization.id)
  if (!quotaCheck.allowed) {
    const message =
      quotaCheck.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${nextQuotaResetIso()}.`
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/actions/stella/__tests__/advisor.test.ts`
Expected: PASS.

- [ ] **Step 5: Repeat Steps 1–4 for `validator.ts`**

Same pattern, mirrored exactly: add the `@/lib/stella/quota` mock to `app/actions/stella/__tests__/validator.test.ts`, add the "Quota enforcement" describe block (same 5 tests, calling `getStellaValidator('proj-1', 'calculation')` instead), add `'QUOTA_EXCEEDED'` to `StellaValidatorErrorCode`, add the same import and the same quota-check block to `validator.ts` (placed identically — after the rate-limit check, before the context-build `try`).

- [ ] **Step 6: Run both test files**

Run: `npx vitest run app/actions/stella/__tests__/advisor.test.ts app/actions/stella/__tests__/validator.test.ts`
Expected: both PASS.

- [ ] **Step 7: Run full test suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all green (this also catches any other test files that construct `StellaAdvisorResult`/`StellaValidatorResult` unions exhaustively and would need the new variant).

- [ ] **Step 8: Commit**

```bash
git add app/actions/stella/advisor.ts app/actions/stella/validator.ts app/actions/stella/__tests__/advisor.test.ts app/actions/stella/__tests__/validator.test.ts
git commit -m "feat: enforce Stella monthly quota in Advisor and Validator actions"
```

---

## Task 5: Allow the Advisor on the Calculation step

**Files:**
- Modify: `lib/stella/context/build-advisor-context.ts`
- Modify: `lib/stella/context/__tests__/build-advisor-context.test.ts`

- [ ] **Step 1: Update the test file**

In `lib/stella/context/__tests__/build-advisor-context.test.ts`, delete the entire `describe('UNSUPPORTED_STEP: calculation', ...)` block (both its `it` blocks) — this behavior is being removed on purpose.

Add a replacement test in its place, in a `describe('Calculation step support')` block, using whatever mock-DB helper (`makeChain`, etc.) the rest of the file already uses for a project-found happy path:

```ts
  describe('Calculation step support', () => {
    it('does NOT throw for "calculation" — Advisor now supports this step', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValue(makeChain([MOCK_PROJECT]) as never)

      await expect(
        buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')
      ).resolves.toBeDefined()
    })

    it('does NOT throw for "Cálculo" (Spanish label)', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValue(makeChain([MOCK_PROJECT]) as never)

      await expect(
        buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'Cálculo')
      ).resolves.toBeDefined()
    })
  })
```

Check the top of the test file for the actual name of the project-fixture constant (likely `MOCK_PROJECT` or similar) and the exact shape `makeChain` (or equivalent) expects — reuse whatever the file's other "Project ownership boundary" tests already use for a found-project happy path, since `buildAdvisorContext` makes several sequential `db.select()` calls (project, narrative, stakeholders, outcomes, indicators, evidence, assignments) that all need non-throwing mock responses. If the existing mock helper only returns one canned response for every `db.select()` call regardless of table, that's sufficient — the two new tests only assert the promise resolves, not its exact shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/stella/context/__tests__/build-advisor-context.test.ts`
Expected: the two new tests FAIL (function still throws `UNSUPPORTED_STEP` for calculation), while the two old tests you deleted no longer run.

- [ ] **Step 3: Implement**

In `lib/stella/context/build-advisor-context.ts`, delete this block entirely:

```ts
  // Reject calculation step — Stella Advisor is not used there (Validator role, Sprint 9D)
  const stepLower = step.toLowerCase()
  if (stepLower === 'calculation' || stepLower === 'cálculo') {
    throw new StellaBuildContextError(
      'UNSUPPORTED_STEP',
      'Stella Advisor does not support the Calculation step. Use Stella Validator instead (Sprint 9D).'
    )
  }
```

The function now proceeds straight to the project-ownership check. (`stepLower` isn't used anywhere else in the function — confirm with a search before deleting, since removing an unused variable is fine but leaving a dangling unused one would fail lint.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/stella/context/__tests__/build-advisor-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Run lint and full test suite**

Run: `pnpm lint && pnpm test`
Expected: clean; no other test in the repo depended on Advisor rejecting Calculation (the only other reference was the pass-through error-handling test in `advisor.test.ts` at the `UNSUPPORTED_STEP` describe block, which mocks the context builder directly and doesn't exercise the real implementation — leave it unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/stella/context/build-advisor-context.ts lib/stella/context/__tests__/build-advisor-context.test.ts
git commit -m "feat: allow Stella Advisor on the Calculation step (was Validator-only)"
```

---

## Task 6: `lib/admin/stella-services.ts` — admin quota management

**Files:**
- Create: `lib/admin/stella-services.ts`
- Test: `tests/admin-stella-services.service.test.ts`
- Modify: `lib/audit/logger.ts`

- [ ] **Step 1: Add the audit action constant**

In `lib/audit/logger.ts`, inside `AUDIT_ACTIONS`, after the `SIGNUP_ALLOWLIST_REMOVED` entry:

```ts
  // Stella service/quota management
  STELLA_SERVICE_UPDATED: 'stella_service.updated',
} as const
```

(This replaces the existing closing `} as const` — just add the new line before it.)

- [ ] **Step 2: Write the failing test**

Create `tests/admin-stella-services.service.test.ts`:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-stella-services.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockDbData = vi.hoisted(() => ({
  orgs: [] as any[],
  usageCounts: {} as Record<string, number>,
  updated: {} as any,
}));

vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: vi.fn(),
}));

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: { STELLA_SERVICE_UPDATED: 'stella_service.updated' },
}));

vi.mock('@/lib/stella/quota', () => ({
  checkStellaQuota: vi.fn().mockImplementation((orgId: string) =>
    Promise.resolve({ allowed: true, used: mockDbData.usageCounts[orgId] ?? 0, quota: null })
  ),
}));

vi.mock('@/db/client', () => {
  return {
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(mockDbData.orgs)),
          where: vi.fn().mockImplementation(() => ({
            then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(mockDbData.orgs)),
          })),
        })),
      })),
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

import { listOrganizationsWithStellaUsage, updateOrganizationStellaService } from '@/lib/admin/stella-services';
import { requireAdminAccess } from '@/lib/auth/session';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbData.orgs = [];
  mockDbData.usageCounts = {};
  mockDbData.updated = {};
});

describe('listOrganizationsWithStellaUsage', () => {
  it('requires admin access', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({} as any);
    mockDbData.orgs = [{ id: 'org-1', name: 'Acme', stellaMonthlyQuota: 50, stellaPlanLabel: 'Pro' }];
    mockDbData.usageCounts = { 'org-1': 12 };

    const result = await listOrganizationsWithStellaUsage();

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].usedThisMonth).toBe(12);
  });
});

describe('updateOrganizationStellaService', () => {
  it('requires admin access and updates quota/label', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.updated = { id: 'org-1', stellaMonthlyQuota: 100, stellaPlanLabel: 'Enterprise' };

    const result = await updateOrganizationStellaService('org-1', {
      planLabel: 'Enterprise',
      monthlyQuota: 100,
    });

    expect(requireAdminAccess).toHaveBeenCalled();
    expect(result.stellaMonthlyQuota).toBe(100);
  });

  it('accepts null monthlyQuota (unlimited)', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);
    mockDbData.updated = { id: 'org-1', stellaMonthlyQuota: null, stellaPlanLabel: 'Internal' };

    const result = await updateOrganizationStellaService('org-1', {
      planLabel: 'Internal',
      monthlyQuota: null,
    });

    expect(result.stellaMonthlyQuota).toBeNull();
  });

  it('rejects a negative quota', async () => {
    vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1' } as any);

    await expect(
      updateOrganizationStellaService('org-1', { planLabel: 'Bad', monthlyQuota: -5 })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/admin-stella-services.service.test.ts`
Expected: FAIL — `Cannot find module '@/lib/admin/stella-services'`.

- [ ] **Step 4: Implement**

Create `lib/admin/stella-services.ts`, following the exact pattern of `lib/admin/organizations.ts`:

```ts
// lib/admin/stella-services.ts
// SuperAdmin management of per-organization Stella usage quotas.
// No payment gateway — plans/quotas are assigned manually. See
// lib/stella/quota.ts for how the quota is enforced at call time.

import { db } from '@/db/client'
import { organizations, stellaInteractions } from '@/db/schema'
import { eq, and, gte, count } from 'drizzle-orm'
import { z } from 'zod'
import { requireAdminAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

const StellaServiceInput = z.object({
  planLabel: z.string().max(100).optional(),
  monthlyQuota: z.number().int().min(0).nullable(),
})

function startOfCurrentUtcMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/** All organizations with their current Stella plan/quota and this month's usage. */
export async function listOrganizationsWithStellaUsage() {
  await requireAdminAccess()

  const orgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      stellaMonthlyQuota: organizations.stellaMonthlyQuota,
      stellaPlanLabel: organizations.stellaPlanLabel,
    })
    .from(organizations)

  const results = []
  for (const org of orgs) {
    const usedThisMonth = await db
      .select({ value: count() })
      .from(stellaInteractions)
      .where(
        and(
          eq(stellaInteractions.organizationId, org.id),
          gte(stellaInteractions.createdAt, startOfCurrentUtcMonth())
        )
      )
      .then((rows) => rows[0]?.value ?? 0)

    results.push({ ...org, usedThisMonth })
  }

  return results
}

/** Assign or update an organization's Stella plan label and monthly quota. */
export async function updateOrganizationStellaService(
  organizationId: string,
  input: unknown
) {
  const admin = await requireAdminAccess()
  const data = StellaServiceInput.parse(input)

  const org = await db.select().from(organizations).where(eq(organizations.id, organizationId)).then((r) => r[0])
  if (!org) throw new Error('Organization not found')

  const [updated] = await db
    .update(organizations)
    .set({
      stellaMonthlyQuota: data.monthlyQuota,
      stellaPlanLabel: data.planLabel,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId))
    .returning()

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'organization',
    entityId: organizationId,
    action: AUDIT_ACTIONS.STELLA_SERVICE_UPDATED,
    beforeJson: { stellaMonthlyQuota: org.stellaMonthlyQuota, stellaPlanLabel: org.stellaPlanLabel },
    afterJson: { stellaMonthlyQuota: updated.stellaMonthlyQuota, stellaPlanLabel: updated.stellaPlanLabel },
  })

  return updated
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/admin-stella-services.service.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/admin/stella-services.ts tests/admin-stella-services.service.test.ts lib/audit/logger.ts
git commit -m "feat: add admin service for assigning per-org Stella quotas"
```

---

## Task 7: `/admin/services` page

**Files:**
- Create: `app/admin/services/actions.ts`
- Create: `app/admin/services/page.tsx`
- Modify: `app/admin/layout.tsx`

- [ ] **Step 1: Create the server actions**

Create `app/admin/services/actions.ts`, following the exact pattern of `app/admin/organizations/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { updateOrganizationStellaService } from '@/lib/admin/stella-services'

const SERVICES_PATH = '/admin/services'

export async function updateOrganizationStellaServiceAction(formData: FormData) {
  const organizationId = formData.get('organizationId') as string | null
  const planLabel = (formData.get('planLabel') as string | null)?.trim() || undefined
  const monthlyQuotaRaw = (formData.get('monthlyQuota') as string | null)?.trim()

  if (!organizationId) {
    redirect(`${SERVICES_PATH}?error=invalid_input`)
  }

  const monthlyQuota = monthlyQuotaRaw === '' || monthlyQuotaRaw === undefined
    ? null
    : Number(monthlyQuotaRaw)

  if (monthlyQuota !== null && (Number.isNaN(monthlyQuota) || monthlyQuota < 0)) {
    redirect(`${SERVICES_PATH}?error=invalid_input`)
  }

  try {
    await updateOrganizationStellaService(organizationId, { planLabel, monthlyQuota })
  } catch {
    redirect(`${SERVICES_PATH}?error=update_failed`)
  }

  revalidatePath(SERVICES_PATH)
  redirect(`${SERVICES_PATH}?success=updated`)
}
```

- [ ] **Step 2: Create the page**

Create `app/admin/services/page.tsx`, following the visual pattern of `app/admin/organizations/page.tsx`:

```tsx
import { listOrganizationsWithStellaUsage } from '@/lib/admin/stella-services'
import { updateOrganizationStellaServiceAction } from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: 'Datos inválidos. La cuota debe ser un número entero mayor o igual a 0, o vacía para ilimitado.',
  update_failed: 'No se pudo actualizar el servicio de esta organización.',
}

export default async function AdminServicesPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const searchParams = await props.searchParams
  const orgs = await listOrganizationsWithStellaUsage()

  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error.' : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Servicios Stella</h1>
        <p className="text-slate-400 mt-2">
          No hay pasarela de pago en la plataforma. Asigná manualmente el plan y la cuota mensual
          de Stella de cada organización — todas arrancan en cuota 0 (bloqueadas) hasta que las
          habilites acá.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-red-900/40 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </div>
      )}
      {searchParams?.success === 'updated' && (
        <div className="rounded-md border border-green-900/40 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          Servicio actualizado correctamente.
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Organización</th>
              <th className="text-left px-4 py-3 font-medium">Plan</th>
              <th className="text-left px-4 py-3 font-medium">Cuota mensual</th>
              <th className="text-left px-4 py-3 font-medium">Uso este mes</th>
              <th className="text-right px-4 py-3 font-medium">Actualizar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {orgs.map((org) => (
              <tr key={org.id}>
                <td className="px-4 py-3 text-white">{org.name}</td>
                <td className="px-4 py-3 text-slate-400">{org.stellaPlanLabel ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">
                  {org.stellaMonthlyQuota === null ? 'Ilimitado' : org.stellaMonthlyQuota}
                </td>
                <td className="px-4 py-3 text-slate-400">{org.usedThisMonth}</td>
                <td className="px-4 py-3 text-right">
                  <form action={updateOrganizationStellaServiceAction} className="flex items-center justify-end gap-2">
                    <input type="hidden" name="organizationId" value={org.id} />
                    <input
                      type="text"
                      name="planLabel"
                      defaultValue={org.stellaPlanLabel ?? ''}
                      placeholder="Plan"
                      className="w-24 rounded-md bg-slate-950 border border-slate-800 text-xs text-white px-2 py-1"
                    />
                    <input
                      type="number"
                      name="monthlyQuota"
                      min={0}
                      defaultValue={org.stellaMonthlyQuota ?? ''}
                      placeholder="Ilimitado"
                      className="w-24 rounded-md bg-slate-950 border border-slate-800 text-xs text-white px-2 py-1"
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-red-600 hover:bg-red-500 transition-colors text-xs font-medium text-white px-3 py-1.5"
                    >
                      Guardar
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add the nav link**

In `app/admin/layout.tsx`, after the existing "Acceso (Signup)" `<Link>` and before `</nav>`:

```tsx
          <Link
            href="/admin/services"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Servicios Stella
          </Link>
```

- [ ] **Step 4: Run typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: clean; build output lists `/admin/services` as a route.

- [ ] **Step 5: Verify live in the browser**

Start the dev server (`preview_start` if using the Claude Preview tools, or `pnpm dev`), sign in as the super_admin test account, navigate to `/admin/services`, confirm the table renders with real organizations, submit a quota change for one org, confirm it round-trips (page reload shows the new value) and the success banner appears.

- [ ] **Step 6: Commit**

```bash
git add app/admin/services/ app/admin/layout.tsx
git commit -m "feat: add /admin/services page for assigning per-org Stella quotas"
```

---

## Task 8: `QUOTA_EXCEEDED` UI state in Advisor and Validator panels

**Files:**
- Modify: `components/stella/StellaAdvisorPanel.tsx`
- Modify: `components/stella/StellaValidatorPanel.tsx`
- Modify: `components/stella/__tests__/StellaAdvisorPanel.test.tsx`
- Modify: `components/stella/__tests__/StellaValidatorPanel.test.tsx`

- [ ] **Step 1: Write the failing test (Advisor panel)**

In `components/stella/__tests__/StellaAdvisorPanel.test.tsx`, add a helper (mirroring the file's existing `success()`/`disabled()` helpers) and a test, in whatever `describe` block groups error-state tests:

```ts
function quotaExceeded(message = 'Alcanzaste el límite mensual de 50 consultas a Stella (usadas: 50). Se renueva el 2026-08-01T00:00:00.000Z.') {
  return mockGetStellaAdvisor.mockResolvedValue({ ok: false, error: 'QUOTA_EXCEEDED', message })
}
```

```ts
  it('shows the quota message when QUOTA_EXCEEDED', async () => {
    quotaExceeded()
    render(<StellaAdvisorPanel projectId="proj-1" step="Narrativa" />)
    fireEvent.click(screen.getByText(/preguntar a stella/i))
    await waitFor(() => {
      expect(screen.queryByText(/límite mensual/i)).not.toBeNull()
    })
  })
```

(Match the exact button text and `render`/`fireEvent`/`waitFor` idioms already used elsewhere in this file — check its imports and an existing async test for the precise pattern, since the file may already import `waitFor` or may use `act` instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/stella/__tests__/StellaAdvisorPanel.test.tsx`
Expected: FAIL — panel falls through to the generic `error` state, not a quota-specific message.

- [ ] **Step 3: Implement — StellaAdvisorPanel.tsx**

Add `'quota_exceeded'` to the `PanelState` union:

```ts
type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AdvisorOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'quota_exceeded'; message: string }
```

In `handleAskStella`, add a branch before the generic `else`:

```ts
      } else if (result.error === 'DISABLED') {
        setPanelState({ status: 'disabled' })
      } else if (result.error === 'QUOTA_EXCEEDED') {
        setPanelState({ status: 'quota_exceeded', message: result.message })
      } else {
```

Add a render branch, next to the existing "Error state" block:

```tsx
      {panelState.status === 'quota_exceeded' && (
        <div aria-live="assertive" role="alert" className="mt-3">
          <p className="text-muted-foreground">{panelState.message}</p>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/stella/__tests__/StellaAdvisorPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Repeat Steps 1–4 for `StellaValidatorPanel.tsx`**

Same pattern: add `'quota_exceeded'` (with `message: string`) to its `PanelState` union, branch in `handleReviewWithStella` on `result.error === 'QUOTA_EXCEEDED'`, add the render block (can reuse the same visual treatment as the existing `rate_limited` branch in that file, swapping the copy). Mirror the test in `StellaValidatorPanel.test.tsx`.

- [ ] **Step 6: Run both component test files and typecheck**

Run: `npx vitest run components/stella/__tests__/StellaAdvisorPanel.test.tsx components/stella/__tests__/StellaValidatorPanel.test.tsx && pnpm typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add components/stella/StellaAdvisorPanel.tsx components/stella/StellaValidatorPanel.tsx components/stella/__tests__/StellaAdvisorPanel.test.tsx components/stella/__tests__/StellaValidatorPanel.test.tsx
git commit -m "feat: show quota-exceeded message in Advisor and Validator panels"
```

---

## Task 9: Advisor on the Calculation page + empty-step highlight

**Files:**
- Modify: `app/app/projects/[projectId]/pipeline/calculation/page.tsx`
- Modify: `components/stella/StellaAdvisorPanel.tsx`
- Modify: `components/stella/__tests__/StellaAdvisorPanel.test.tsx`
- Modify: `app/app/projects/[projectId]/pipeline/stakeholders/page.tsx`
- Modify: `app/app/projects/[projectId]/pipeline/outcomes/page.tsx`
- Modify: `app/app/projects/[projectId]/pipeline/indicators/page.tsx`
- Modify: `app/app/projects/[projectId]/pipeline/evidence/page.tsx`
- Modify: `app/app/projects/[projectId]/pipeline/proxies/page.tsx`
- Modify: `app/app/projects/[projectId]/pipeline/narrative/page.tsx`

- [ ] **Step 1: Add the Advisor to the Calculation page**

In `app/app/projects/[projectId]/pipeline/calculation/page.tsx`, change the import:

```tsx
import { StellaValidatorPanel } from '@/components/stella'
```

to:

```tsx
import { StellaAdvisorPanel, StellaValidatorPanel } from '@/components/stella'
```

Right before the existing `<StellaValidatorPanel projectId={projectId} step="Cálculo" />` line, add:

```tsx
      <StellaAdvisorPanel projectId={projectId} step="Cálculo" />
```

- [ ] **Step 2: Write the failing test for the highlight prop**

In `components/stella/__tests__/StellaAdvisorPanel.test.tsx`, add:

```ts
  it('applies a highlighted style when highlightHint is true', () => {
    render(<StellaAdvisorPanel projectId="proj-1" step="Narrativa" highlightHint />)
    const hint = screen.queryByText(/recién estás empezando/i)
    expect(hint).not.toBeNull()
  })

  it('does NOT show the hint by default', () => {
    render(<StellaAdvisorPanel projectId="proj-1" step="Narrativa" />)
    expect(screen.queryByText(/recién estás empezando/i)).toBeNull()
  })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run components/stella/__tests__/StellaAdvisorPanel.test.tsx`
Expected: FAIL — no `highlightHint` prop exists yet.

- [ ] **Step 4: Implement**

In `components/stella/StellaAdvisorPanel.tsx`, add the prop to the interface:

```ts
interface StellaAdvisorPanelProps {
  projectId: string
  step: string
  title?: string
  className?: string
  highlightHint?: boolean
}
```

Destructure it in the component signature:

```ts
export function StellaAdvisorPanel({
  projectId,
  step,
  title,
  className,
  highlightHint = false,
}: StellaAdvisorPanelProps) {
```

Change the `<section>`'s className to switch styles when `highlightHint` is true (this does NOT change trigger behavior — the Gemini call still only fires on button click):

```tsx
    <section
      className={cn(
        'rounded-lg border p-4 my-4 text-sm',
        highlightHint
          ? 'border-[#FF6A00]/40 bg-[#FF6A00]/5'
          : 'border-border bg-muted/20',
        className
      )}
      aria-label={title ?? 'Stella Advisor'}
    >
```

Add the hint text inside the header block, right after the existing disclaimer `<p>`:

```tsx
          {highlightHint && (
            <p className="mt-1 text-xs font-medium text-[#B85200]">
              💡 Recién estás empezando este paso — Stella puede orientarte.
            </p>
          )}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run components/stella/__tests__/StellaAdvisorPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Wire `highlightHint` into each pipeline page**

For each of the six pages below, find where `<StellaAdvisorPanel projectId={projectId} step="..." />` is currently rendered and add `highlightHint={<empty-check>}`, using whatever data the page already fetched to determine emptiness. Read each file first to find the exact variable name holding the fetched list before editing — do not guess.

- `stakeholders/page.tsx`: `highlightHint={!stakeholders?.length}`
- `outcomes/page.tsx`: check the fetched outcomes array's variable name, use `highlightHint={outcomesList.length === 0}` (substitute the real variable name)
- `indicators/page.tsx`: same pattern with the indicators list
- `evidence/page.tsx`: same pattern with the evidence list
- `proxies/page.tsx`: same pattern with the assigned-proxies list
- `narrative/page.tsx`: same pattern, likely `highlightHint={!narrative}` (narrative is probably a single record, not a list — check the page's actual data shape)

For the Calculation page (Task 9, Step 1), use the readiness data already fetched on that page, e.g. `highlightHint={!readiness.hasInvestment}` or equivalent — check `getSroiCalculationReadiness`'s return shape (already imported on that page) for the most sensible "just started" signal.

- [ ] **Step 7: Run full test suite, typecheck, lint, build**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all clean.

- [ ] **Step 8: Verify live in the browser**

Open a project with an empty pipeline step (e.g. zero stakeholders) and confirm the Advisor panel shows the orange-highlighted hint; open a step with data already entered and confirm it shows the neutral style with no hint. Confirm clicking "Preguntar a Stella" still requires an explicit click in both cases (no auto-fire on page load) — check the Network tab or console for zero Stella calls before clicking.

- [ ] **Step 9: Commit**

```bash
git add app/app/projects/[projectId]/pipeline/calculation/page.tsx components/stella/StellaAdvisorPanel.tsx components/stella/__tests__/StellaAdvisorPanel.test.tsx app/app/projects/[projectId]/pipeline/stakeholders/page.tsx app/app/projects/[projectId]/pipeline/outcomes/page.tsx app/app/projects/[projectId]/pipeline/indicators/page.tsx app/app/projects/[projectId]/pipeline/evidence/page.tsx app/app/projects/[projectId]/pipeline/proxies/page.tsx app/app/projects/[projectId]/pipeline/narrative/page.tsx
git commit -m "feat: add Advisor to Calculation step, highlight Stella on empty steps"
```

---

## Task 10: `lib/stella/context/build-composer-context.ts`

**Files:**
- Create: `lib/stella/context/build-composer-context.ts`
- Test: `lib/stella/context/__tests__/build-composer-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/stella/context/__tests__/build-composer-context.test.ts`. Copy the mock-DB setup and fixture style used in `lib/stella/context/__tests__/build-validator-context.test.ts` verbatim (read that file first for its exact `db.select` mocking approach — it will differ in shape from the simpler `build-advisor-context.test.ts` since Validator's builder issues more distinct queries). Adapt fixtures for a report/section-scoped call:

```ts
// lib/stella/context/__tests__/build-composer-context.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildComposerContext, StellaBuildComposerContextError } from '../build-composer-context'

// Mirror the exact db mock pattern from build-validator-context.test.ts here —
// reuse its makeChain-style helper if that file exports/defines one, or copy
// the inline mock shape verbatim. The report/section-specific tests below
// assume a `mockReport` and `mockSection` fixture analogous to that file's
// `MOCK_PROJECT` fixture.

describe('buildComposerContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws NOT_FOUND when the report does not exist', async () => {
    // Arrange: mock db.select for sroiReports to return []
    await expect(
      buildComposerContext('proj-1', 'org-1', 'report-missing', 'executive_summary')
    ).rejects.toThrow(StellaBuildComposerContextError)
  })

  it('throws UNAUTHORIZED when the report belongs to a different organization', async () => {
    // Arrange: mock db.select for sroiReports to return a row with organizationId !== 'org-1'
    let thrown: StellaBuildComposerContextError | null = null
    try {
      await buildComposerContext('proj-1', 'org-1', 'report-1', 'executive_summary')
    } catch (e) {
      thrown = e as StellaBuildComposerContextError
    }
    expect(thrown).toBeInstanceOf(StellaBuildComposerContextError)
    expect(thrown?.code).toBe('UNAUTHORIZED')
  })

  it('populates reportSections from the report\'s existing sections', async () => {
    // Arrange: mock a found report + two existing sections
    const ctx = await buildComposerContext('proj-1', 'org-1', 'report-1', 'executive_summary')
    expect(ctx.reportSections.length).toBeGreaterThan(0)
  })

  it('includes calculationSnapshot when a calculated run exists', async () => {
    const ctx = await buildComposerContext('proj-1', 'org-1', 'report-1', 'executive_summary')
    expect(ctx.calculationSnapshot).not.toBeNull()
  })
})
```

Flesh out each test's `db.select` mock return sequence to match the actual call order your implementation makes (written in Step 3) — since this test is written test-first, come back and fill in the exact mock chain per test once the implementation's query order is fixed, the same iterative way `build-validator-context.test.ts` was necessarily built against its own implementation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/stella/context/__tests__/build-composer-context.test.ts`
Expected: FAIL — `Cannot find module '../build-composer-context'`.

- [ ] **Step 3: Implement**

Create `lib/stella/context/build-composer-context.ts`. Start from `lib/stella/context/build-validator-context.ts` verbatim (same rich data: narrative, outcomes, indicators, evidence, proxies with confidence/risk, filter sets, calculation snapshot — Composer needs the same breadth to cite evidence/proxies and reference the SROI ratio in its draft), with these differences:

```ts
// lib/stella/context/build-composer-context.ts
// Build StellaProjectContext for Composer, scoped to a specific report/section.
// Security: metadata only, no raw files, no PII, no full snapshotJson, no cross-org data.

import { db } from '@/db/client'
import {
  projects,
  impactNarratives,
  stakeholderGroups,
  outcomes,
  indicators,
  evidenceItems,
  outcomeProxyAssignments,
  financialProxies,
  proxySources,
  sroiFilterSets,
  sroiCalculationRuns,
  sroiCalculationLineItems,
  sroiRunReviews,
  sroiReports,
  sroiReportSections,
} from '@/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { sanitizeString, sanitizeNarrative, hasForbiddenPattern } from './sanitize'
import type {
  StellaProjectContext,
  OutcomeRef,
  IndicatorRef,
  EvidenceMeta,
  ProxyRef,
  FilterRef,
  CalculationSnapshot,
  SectionRef,
} from './types'

export class StellaBuildComposerContextError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'UNAUTHORIZED',
    message: string
  ) {
    super(message)
    this.name = 'StellaBuildComposerContextError'
  }
}

export async function buildComposerContext(
  projectId: string,
  organizationId: string,
  reportId: string,
  _sectionType: string
): Promise<StellaProjectContext> {
  // Project ownership check
  const project = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!project) {
    throw new StellaBuildComposerContextError('NOT_FOUND', 'Project not found')
  }
  if (project.organizationId !== organizationId) {
    throw new StellaBuildComposerContextError('UNAUTHORIZED', 'Project does not belong to your organization')
  }

  // Report ownership check — must belong to this project and organization
  const report = await db
    .select({ id: sroiReports.id, organizationId: sroiReports.organizationId, projectId: sroiReports.projectId })
    .from(sroiReports)
    .where(eq(sroiReports.id, reportId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report) {
    throw new StellaBuildComposerContextError('NOT_FOUND', 'Report not found')
  }
  if (report.organizationId !== organizationId || report.projectId !== projectId) {
    throw new StellaBuildComposerContextError('UNAUTHORIZED', 'Report does not belong to this project/organization')
  }

  // --- The following blocks are copied verbatim from build-validator-context.ts: ---
  // narrative, stakeholderCount, outcomesSnapshot, indicatorsSnapshot, evidenceMetadata,
  // proxySummary (+ sourcesMap resolution), filterSetsSummary, calculationSnapshot,
  // readinessScore (latestReview). Copy that entire middle section unchanged, using the
  // same `projectId`/`organizationId` variables already in scope here.

  // Existing report sections — gives Composer awareness of what's already drafted,
  // to avoid duplicating content across sections.
  const rawSections = await db
    .select({
      id: sroiReportSections.id,
      sectionType: sroiReportSections.sectionType,
      title: sroiReportSections.title,
      content: sroiReportSections.content,
    })
    .from(sroiReportSections)
    .where(eq(sroiReportSections.reportId, reportId))

  const reportSections: SectionRef[] = rawSections.map((s) => ({
    id: s.id,
    sectionType: s.sectionType,
    title: sanitizeString(s.title, 200),
    contentLength: s.content?.length ?? 0,
    status: s.content && s.content.length > 0 ? 'in_progress' : 'draft',
  }))

  return {
    projectId,
    organizationId,
    narrativeSummary, // from the copied block
    outcomesSnapshot,
    indicatorsSnapshot,
    stakeholderCount,
    evidenceMetadata,
    evidenceTotal: rawEvidence.length,
    proxySummary,
    filterSetsSummary,
    calculationSnapshot,
    reportSections,
    readinessScore: latestReview?.readinessScore ?? undefined,
    projectCreatedAt: project.createdAt.toISOString(),
    lastUpdatedAt: project.updatedAt.toISOString(),
  }
}
```

The comment block marks exactly what to copy from `build-validator-context.ts` (lines computing `narrative`, `stakeholderCount`, `outcomesSnapshot`, `indicatorsSnapshot`, `evidenceMetadata`/`rawEvidence`, `proxySummary`/`sourcesMap`, `filterSetsSummary`, `calculationSnapshot`/`latestRun`, `latestReview`) — paste that logic in between the report-ownership check and the `reportSections` block above, unchanged. `_sectionType` is intentionally unused in context-building (it only matters to the prompt, built separately) — prefix with `_` to satisfy lint's no-unused-vars rule, or remove the parameter entirely and have the caller (composer.ts) pass it only to the prompt builder, not the context builder. Prefer removing the parameter if lint flags the underscore-prefixed version anyway — check `eslint.config.mjs` for the project's exact unused-args rule before deciding.

- [ ] **Step 4: Fill in the test mocks and run**

Go back to Step 1's test file and complete each test's `db.select` mock sequence to match this implementation's actual call order (project → report → narrative → stakeholders → outcomes → indicators → evidence → assignments → sources → filter sets → calculation run → line items → review → report sections).

Run: `npx vitest run lib/stella/context/__tests__/build-composer-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/stella/context/build-composer-context.ts lib/stella/context/__tests__/build-composer-context.test.ts
git commit -m "feat: add buildComposerContext for report-section-scoped Stella context"
```

---

## Task 11: `app/actions/stella/composer.ts`

**Files:**
- Create: `app/actions/stella/composer.ts`
- Test: `app/actions/stella/__tests__/composer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/actions/stella/__tests__/composer.test.ts` by copying `app/actions/stella/__tests__/validator.test.ts` structure verbatim and adapting: replace all `Validator`/`validator` references with `Composer`/`composer`, replace `buildValidatorContext` mock with `buildComposerContext`, replace `ValidatorOutputSchema`/`ValidatorOutput` with `ComposerOutputSchema`/`ComposerOutput`, replace the call signature `getStellaValidator(projectId, step)` with `getStellaComposer(projectId, reportId, sectionId, sectionType)`, and add the quota-check mock from Task 4. Use this fixture for the composer output:

```ts
const VALID_COMPOSER_OUTPUT: ComposerOutput = {
  section_key: 'executive_summary',
  draft_title: 'Resumen Ejecutivo',
  draft_content: 'Este proyecto generó un retorno social de 3.6x la inversión...',
  assumptions: ['Se asume que los beneficiarios reportados completaron el programa'],
  limitations: ['Datos de seguimiento a 12 meses aún no disponibles'],
  evidence_references: [{ evidenceId: 'ev-1', title: 'Encuesta de seguimiento', context: 'Fuente de la tasa de empleo' }],
  proxy_references: [{ proxyId: 'proxy-1', name: 'Costo de tratar depresión', context: 'Usado para valorar el outcome de salud mental' }],
}
```

Include, in addition to the standard flag/auth/rate-limit/quota/Gemini/parse describe blocks (mirrored from validator.test.ts), a "Context builder integration" test confirming `getStellaComposer` passes `(projectId, organization.id, reportId, sectionType)` to `buildComposerContext`, and an "Audit insert" describe block confirming the `stella_interactions` insert has `stellaRole: 'composer'` and `pipelineStep: sectionType` (or `'Report'` — decide when writing `composer.ts` in Step 3 and keep the test consistent with that choice).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/actions/stella/__tests__/composer.test.ts`
Expected: FAIL — `Cannot find module '../composer'`.

- [ ] **Step 3: Implement**

Create `app/actions/stella/composer.ts`, mirroring `app/actions/stella/validator.ts` exactly, with these substitutions:

```ts
'use server'
// app/actions/stella/composer.ts
// Stella Composer server action — drafts one report section at a time.
// Security: feature-flagged, auth-gated, quota-enforced, rate-limited,
// metadata-only context, no automatic saves (draft returned to UI only).

import { requireOrganizationAccess } from '@/lib/auth/session'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { buildComposerContext, StellaBuildComposerContextError } from '@/lib/stella/context/build-composer-context'
import { buildComposerSystemPrompt, buildComposerUserMessage } from '@/lib/stella/prompts/composer-system'
import { getGeminiAdapter } from '@/lib/stella/adapter/gemini-client'
import { ComposerOutputSchema } from '@/lib/stella/schemas/composer-output'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import { checkStellaRateLimit, recordStellaRequest } from '@/lib/stella/rate-limit'
import { checkStellaQuota, nextQuotaResetIso } from '@/lib/stella/quota'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

export type StellaComposerErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

export type StellaComposerResult =
  | { ok: true; data: ComposerOutput }
  | { ok: false; error: StellaComposerErrorCode; message: string }

export async function getStellaComposer(
  projectId: string,
  reportId: string,
  sectionId: string,
  sectionType: string
): Promise<StellaComposerResult> {
  if (!stellaConfig.isEnabled || !stellaConfig.isComposerEnabled || !stellaState.canUseStella) {
    return { ok: false, error: 'DISABLED', message: 'Stella Composer is not enabled.' }
  }

  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const rateLimit = checkStellaRateLimit(ctx.organization.id)
  if (!rateLimit.allowed) {
    return { ok: false, error: 'RATE_LIMITED', message: `Rate limit exceeded. Resets at ${rateLimit.resetAtHourUtc}.` }
  }

  const quotaCheck = await checkStellaQuota(ctx.organization.id)
  if (!quotaCheck.allowed) {
    const message =
      quotaCheck.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quotaCheck.quota} consultas a Stella (usadas: ${quotaCheck.used}). Se renueva el ${nextQuotaResetIso()}.`
    return { ok: false, error: 'QUOTA_EXCEEDED', message }
  }

  try {
    const context = await buildComposerContext(projectId, ctx.organization.id, reportId, sectionType)

    recordStellaRequest(ctx.organization.id)

    const systemPrompt = buildComposerSystemPrompt(sectionType)
    const userMessage = buildComposerUserMessage(sectionType, context)

    const adapter = getGeminiAdapter()
    const response = await adapter.generate({
      role: 'composer',
      systemPrompt,
      userMessage,
    })

    const data = await adapter.parseResponse(response.rawOutput, ComposerOutputSchema)

    try {
      await db.insert(stellaInteractions).values({
        organizationId: ctx.organization.id,
        projectId,
        createdBy: ctx.user.id,
        stellaRole: 'composer',
        pipelineStep: sectionType,
        contextHash: '',
        responseJson: data as unknown,
        modelUsed: response.modelUsed,
        tokensUsed: response.tokensUsed,
      })
    } catch {
      return { ok: false, error: 'AUDIT_ERROR', message: 'Failed to record Stella interaction. Please try again.' }
    }

    return { ok: true, data }
  } catch (error) {
    if (error instanceof StellaBuildComposerContextError) {
      return { ok: false, error: 'UNAUTHORIZED', message: 'Report or project access denied.' }
    }
    if (error instanceof StellaTimeoutError) {
      return { ok: false, error: 'TIMEOUT', message: 'Stella request timed out. Please try again.' }
    }
    if (error instanceof StellaParseError) {
      return { ok: false, error: 'PARSE_ERROR', message: 'Stella returned an unexpected response format.' }
    }
    if (error instanceof StellaGeminiError) {
      return { ok: false, error: 'GEMINI_ERROR', message: 'Stella AI service encountered an error.' }
    }
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.' }
  }
}
```

Note: `sectionId` is accepted as a parameter (matching the design's per-section trigger) but not currently used inside the action body — it's implicitly validated by `buildComposerContext` scoping to `reportId` (all sections of that report belong to the same project/org boundary already checked). Keep the parameter for the call signature the UI panel expects and for future section-specific context narrowing, but if lint flags it as unused, prefix with `_sectionId` or reference it in a comment explaining why it's accepted-but-unused today.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/actions/stella/__tests__/composer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/actions/stella/composer.ts app/actions/stella/__tests__/composer.test.ts
git commit -m "feat: add getStellaComposer server action"
```

---

## Task 12: `StellaComposerPanel` component

**Files:**
- Create: `components/stella/StellaComposerPanel.tsx`
- Test: `components/stella/__tests__/StellaComposerPanel.test.tsx`
- Modify: `components/stella/index.ts`

- [ ] **Step 1: Write the failing test**

Create `components/stella/__tests__/StellaComposerPanel.test.tsx`, copying the structure and mocking approach of `components/stella/__tests__/StellaValidatorPanel.test.tsx` verbatim (mock `@/app/actions/stella/composer`, mock `@/components/ui/button`), adapted for the Composer's props and output shape. Additionally test the "use this draft" callback:

```tsx
  it('calls onUseDraft with title and content when "Usar este borrador" is clicked', async () => {
    success()
    const onUseDraft = vi.fn()
    render(
      <StellaComposerPanel
        projectId="proj-1"
        reportId="rep-1"
        sectionId="sec-1"
        sectionType="executive_summary"
        onUseDraft={onUseDraft}
      />
    )
    fireEvent.click(screen.getByText(/redactar con stella/i))
    await waitFor(() => {
      expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
    })
    fireEvent.click(screen.getByText(/usar este borrador/i))
    expect(onUseDraft).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String), content: expect.any(String) })
    )
  })
```

Include the standard idle/loading/error/disabled/quota_exceeded state tests mirrored from the Validator panel's test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/stella/__tests__/StellaComposerPanel.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `components/stella/StellaComposerPanel.tsx`, following the structure of `StellaValidatorPanel.tsx`:

```tsx
'use client'
// components/stella/StellaComposerPanel.tsx
// On-demand Stella Composer panel — drafts one report section at a time.
// Never auto-invokes, never auto-saves. User reviews and explicitly loads
// the draft into the section's edit form via onUseDraft.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaComposer } from '@/app/actions/stella/composer'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ComposerOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'quota_exceeded'; message: string }

interface StellaComposerPanelProps {
  projectId: string
  reportId: string
  sectionId: string
  sectionType: string
  onUseDraft: (draft: { title: string; content: string }) => void
  className?: string
}

export function StellaComposerPanel({
  projectId,
  reportId,
  sectionId,
  sectionType,
  onUseDraft,
  className,
}: StellaComposerPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })

  async function handleCompose() {
    setPanelState({ status: 'loading' })
    try {
      const result = await getStellaComposer(projectId, reportId, sectionId, sectionType)
      if (result.ok) {
        setPanelState({ status: 'success', data: result.data })
      } else if (result.error === 'DISABLED') {
        setPanelState({ status: 'disabled' })
      } else if (result.error === 'QUOTA_EXCEEDED') {
        setPanelState({ status: 'quota_exceeded', message: result.message })
      } else {
        setPanelState({ status: 'error' })
      }
    } catch {
      setPanelState({ status: 'error' })
    }
  }

  if (panelState.status === 'disabled') {
    return null
  }

  const isLoading = panelState.status === 'loading'

  return (
    <section
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-3 text-sm', className)}
      aria-label="Stella Composer"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Stella puede redactar un borrador de esta sección. Vos lo revisás y editás antes de guardar.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={isLoading ? undefined : handleCompose}
          disabled={isLoading}
          className="shrink-0"
        >
          {isLoading ? 'Redactando…' : 'Redactar con Stella'}
        </Button>
      </div>

      {panelState.status === 'loading' && (
        <div
          aria-live="polite"
          aria-busy="true"
          aria-label="Redactando borrador con Stella…"
          data-testid="stella-composer-loading"
          className="mt-3 space-y-2"
        >
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
        </div>
      )}

      {panelState.status === 'quota_exceeded' && (
        <div aria-live="assertive" role="alert" className="mt-3">
          <p className="text-muted-foreground">{panelState.message}</p>
        </div>
      )}

      {panelState.status === 'error' && (
        <p aria-live="assertive" role="alert" className="mt-3 text-muted-foreground">
          La redacción de Stella no está disponible temporalmente. El contenido de tu sección no se ve afectado.
        </p>
      )}

      {panelState.status === 'success' && (
        <div aria-live="polite" className="mt-3 space-y-3">
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
              Borrador propuesto
            </h4>
            <p className="font-medium text-foreground">{panelState.data.draft_title}</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{panelState.data.draft_content}</p>
          </div>

          {panelState.data.assumptions.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Supuestos</h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}

          {panelState.data.limitations.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Limitaciones</h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onUseDraft({ title: panelState.data.draft_title, content: panelState.data.draft_content })
            }
          >
            Usar este borrador
          </Button>

          <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
            Este es un borrador generado por Stella. Requiere revisión humana antes de guardar o publicar.
          </p>
        </div>
      )}
    </section>
  )
}
```

Add the export to `components/stella/index.ts`:

```ts
export { StellaComposerPanel } from './StellaComposerPanel'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/stella/__tests__/StellaComposerPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/stella/StellaComposerPanel.tsx components/stella/__tests__/StellaComposerPanel.test.tsx components/stella/index.ts
git commit -m "feat: add StellaComposerPanel UI component"
```

---

## Task 13: Wire the Composer into the report page

**Files:**
- Modify: `app/app/projects/[projectId]/report/[reportId]/page.tsx`

The report page is currently a Server Component rendering an uncontrolled `<form>` per section with `id={titleInputId}`/`id={contentInputId}` inputs (`title-${section.id}` / `content-${section.id}`). `StellaComposerPanel` is a Client Component; it populates those uncontrolled inputs directly via the DOM using the same ids, avoiding a full restructure into a client-managed form.

- [ ] **Step 1: Add the import**

```tsx
import { StellaComposerPanel } from '@/components/stella'
```

- [ ] **Step 2: Render the panel above each non-locked section's form**

Inside the section-rendering loop, in the `!isLocked` branch (right before the existing `<form action={handleUpdateSection} ...>`), add:

```tsx
                          {!isLocked && (
                            <StellaComposerPanel
                              projectId={projectId}
                              reportId={reportId}
                              sectionId={section.id}
                              sectionType={section.sectionType}
                              onUseDraft={({ title, content }) => {
                                const titleEl = document.getElementById(titleInputId) as HTMLInputElement | null
                                const contentEl = document.getElementById(contentInputId) as HTMLTextAreaElement | null
                                if (titleEl) titleEl.value = title
                                if (contentEl) contentEl.value = content
                              }}
                            />
                          )}
```

This goes inside the existing `{isLocked ? (...) : ( <form>...</form> )}` ternary's `else` branch, as a sibling immediately before the `<form>` element (both stay inside the same parenthesized JSX fragment — wrap them in a `<>...</>` fragment if the ternary branch currently returns a single `<form>` element directly).

`onUseDraft` is a plain inline function passed from a Server Component into a Client Component — this is allowed in Next.js only if it doesn't try to close over server-only values and is defined as a plain closure (not itself marked `'use server'`); since it only manipulates `document` (client-only DOM APIs), confirm this compiles and runs correctly in Step 4 rather than assuming — if Next.js rejects passing a plain closure as a prop to a Client Component from a Server Component (it does allow this for event-handler-shaped props, but verify), the fallback is to make `StellaComposerPanel` itself take `titleInputId`/`contentInputId` strings as props instead of a callback, and do the `document.getElementById` lookup inside the component itself.

- [ ] **Step 3: Run typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: clean. If Step 2's inline closure prop causes a Server/Client boundary error, apply the fallback described above (pass `titleInputId`/`contentInputId` strings instead of a callback) and rebuild.

- [ ] **Step 4: Verify live in the browser**

Navigate to a project's report detail page (not locked), click "Redactar con Stella" on one section, confirm the draft renders, click "Usar este borrador", confirm the section's title and content `<textarea>` are populated with the draft text, then click "Guardar sección" and confirm it persists (reload the page, confirm the saved content matches).

- [ ] **Step 5: Commit**

```bash
git add "app/app/projects/[projectId]/report/[reportId]/page.tsx"
git commit -m "feat: wire StellaComposerPanel into report sections"
```

---

## Task 14: Full validation and PR

**Files:** none (validation only)

- [ ] **Step 1: Run the full validation suite**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all green. Fix anything that fails before proceeding — do not skip.

- [ ] **Step 2: Manual end-to-end check in the browser**

With `STELLA_ENABLED=true`, `STELLA_ADVISOR_ENABLED=true`, `STELLA_VALIDATOR_ENABLED=true`, `STELLA_COMPOSER_ENABLED=true`, and a real `GEMINI_API_KEY` set locally (or via the dev server's `.env`), and the test organization assigned a non-zero quota via `/admin/services`:
- Advisor: ask Stella on a step with no data (confirm highlight) and one with data (confirm neutral style); confirm real guidance renders.
- Validator: run a review on the Calculation step; confirm risk output renders.
- Composer: draft a report section, use the draft, save it.
- Set the test org's quota to 0 via `/admin/services`, confirm all three panels now show the "no tenés plan asignado" message instead of calling Gemini.

- [ ] **Step 3: Commit any final fixes, then push and open a PR**

```bash
git push origin <branch-name>
gh pr create --base main --title "feat: complete Stella (Composer) + org-level usage quotas" --body "$(cat <<'EOF'
## Summary
- Adds Stella's third role, Composer: per-report-section drafting (server action + UI), completing the Advisor/Validator/Composer trio the product spec always called for.
- Fixes a preexisting bug: the Advisor never wrote to the stella_interactions audit table (only Validator did).
- Adds an organization-level monthly Stella usage quota, enforced across all three roles by counting existing stella_interactions rows for the current calendar month — no new usage table. No payment gateway: every org defaults to quota 0 (blocked) until a super_admin assigns one manually via a new /admin/services page.
- Extends Advisor coverage to the Calculation step (previously Validator-only).
- Adds a visual (non-network) highlight on Stella panels when a pipeline step looks empty/just-started — the Gemini call still only fires on an explicit user click.

See docs/superpowers/specs/2026-07-02-stella-complete-quotas-design.md for the full design and the trade-offs Lorenzo chose (hard block on quota exhaustion, one combined quota across all three roles, no automatic Gemini calls).

## Test plan
- [x] pnpm test / typecheck / lint / build all clean
- [x] Manually verified Advisor, Validator, and Composer live in the browser with a real Gemini key and an assigned quota
- [x] Manually verified quota exhaustion blocks all three roles with a clear message
EOF
)"
```

- [ ] **Step 4: Do NOT merge yet**

Stop here — merging this PR and flipping the Vercel flags is Task 15, done only after Lorenzo reviews.

---

## Task 15: Enable Stella flags in Vercel Preview and Production

**Files:** none (Vercel configuration only)

This task requires explicit confirmation before running — it changes live production configuration, distinct from the local code changes in Tasks 1–14.

- [ ] **Step 1: Confirm the PR from Task 14 is merged to `main`**

Do not proceed until it's merged — flipping flags before the code lands would enable nothing.

- [ ] **Step 2: Set the four flags in Preview**

```bash
echo "true" | vercel env add STELLA_ADVISOR_ENABLED preview
echo "true" | vercel env add STELLA_COMPOSER_ENABLED preview
```

(`STELLA_ENABLED` and `STELLA_VALIDATOR_ENABLED` already exist in Preview per the session's earlier `vercel env ls` check — verify with `vercel env ls preview` before adding, since `vercel env add` fails if the key already exists; use `vercel env rm <name> preview` first only if you need to change an existing value, which shouldn't be the case here.)

- [ ] **Step 3: Set all four flags in Production**

```bash
echo "true" | vercel env add STELLA_ENABLED production
echo "true" | vercel env add STELLA_ADVISOR_ENABLED production
echo "true" | vercel env add STELLA_VALIDATOR_ENABLED production
echo "true" | vercel env add STELLA_COMPOSER_ENABLED production
```

`GEMINI_API_KEY` already exists in Preview per the earlier session check but not Production — this task also requires copying that key to Production. Since its value can't be read back via `vercel env ls` (encrypted), get the actual key value directly from Lorenzo (or from wherever it was originally sourced) rather than attempting to extract it — do not run `vercel env pull` to materialize production secrets to disk without Lorenzo's explicit sign-off in the moment, per this session's established practice.

```bash
echo "<the real Gemini API key>" | vercel env add GEMINI_API_KEY production
```

- [ ] **Step 4: Trigger a Production redeploy**

Environment variable changes require a new deployment to take effect. Either push an empty commit to `main` or use `vercel --prod` / the Vercel dashboard's "Redeploy" action.

- [ ] **Step 5: Verify live on the production URL**

Confirm `/admin/services` is reachable and shows the real org list, confirm all three Stella panels still correctly show "no tenés plan asignado" for every org (since none have been assigned a quota yet in production), then assign a real quota to one organization and confirm Stella responds for it.

- [ ] **Step 6: Update project memory**

This step has no code — after confirming Step 5, note in the ongoing session (or the project's persistent memory file, if used) that Stella is now live in Production with all orgs at quota 0, and that quotas must be assigned per-org via `/admin/services` before any customer can use it.
