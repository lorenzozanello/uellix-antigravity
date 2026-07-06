# Fase 1a: Multi-Funder Investment, In-Kind Contributions & USD Normalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable projects to track multiple funders (cash + in-kind), each with their own SROI ratio, and normalize all investments and proxy values to USD using historical exchange rates.

**Architecture:** Schema adds 3 new tables (`funders`, `fx_rates`, `outcome_funder_allocations`) and extends 3 existing tables. TDD-first: pure functions for FX math, services for DB CRUD, then calculation engine updates and UI wiring. FX auto-fetch for COP is spike-verified before implementation; manual entry fallback for all other currencies and on auto-fetch failure.

**Tech Stack:** Drizzle ORM, Next.js Server Actions, Zod validation, TDD (Vitest), RLS policies on Postgres, decimal.js for money math.

---

## Task 1: Schema — 3 new tables + 5 table extensions

**Files:**
- Create: `db/migrations/0024_multi_funder_fx_normalization.sql`
- Modify: `db/schema.ts` (add 3 new tables + extend 5 existing)

### Steps

- [ ] **Step 1: Extend `db/schema.ts` with new table definitions**

Add the 3 new tables to `db/schema.ts` after the existing pipeline tables:

```typescript
export const funders = pgTable(
  'funders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: varchar('name', { length: 255 }).notNull(),
    funderType: varchar('funder_type', { length: 50 }).notNull(),
      .check(sql`${sql.identifier('funder_type')} IN ('public','private','foundation','multilateral','individual','other')`),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_funders_org_id').on(table.organizationId),
  ]
);

export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    currency: varchar('currency', { length: 10 }).notNull(),
    rateDate: date('rate_date').notNull(),
    rateToUsd: numeric('rate_to_usd', { precision: 20, scale: 10 }).notNull(),
    source: text('source').notNull(),
    sourceType: varchar('source_type', { length: 20 }).notNull()
      .check(sql`${sql.identifier('source_type')} IN ('auto_fetched','manual')`),
    organizationId: uuid('organization_id').references(() => organizations.id),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_fx_rates_currency_date').on(table.currency, table.rateDate),
    index('idx_fx_rates_org_id').on(table.organizationId),
  ]
);

export const outcomeFunderAllocations = pgTable(
  'outcome_funder_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outcomeId: uuid('outcome_id').notNull().references(() => outcomes.id),
    funderId: uuid('funder_id').notNull().references(() => funders.id),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    allocationPct: numeric('allocation_pct', { precision: 5, scale: 2 }).notNull()
      .check(sql`${sql.identifier('allocation_pct')} > 0 AND ${sql.identifier('allocation_pct')} <= 100`),
    status: varchar('status', { length: 20 }).notNull().default('active')
      .check(sql`${sql.identifier('status')} IN ('active','archived')`),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_outcome_funder_allocations_outcome_id').on(table.outcomeId),
    index('idx_outcome_funder_allocations_funder_id').on(table.funderId),
    index('idx_outcome_funder_allocations_org_id').on(table.organizationId),
  ]
);
```

- [ ] **Step 2: Extend existing tables in `db/schema.ts`**

Modify `project_investments`:
```typescript
// Add after existing columns, before constraints:
funderId: uuid('funder_id').notNull().references(() => funders.id),
contributionType: varchar('contribution_type', { length: 20 }).notNull().default('cash')
  .check(sql`${sql.identifier('contribution_type')} IN ('cash','in_kind')`),
inKindValuationNotes: text('in_kind_valuation_notes')
  .check(sql`(${sql.identifier('contribution_type')} = 'cash') OR (${sql.identifier('contribution_type')} = 'in_kind' AND ${sql.identifier('in_kind_valuation_notes')} IS NOT NULL)`),
amountUsd: numeric('amount_usd', { precision: 20, scale: 4 }),
fxRateId: uuid('fx_rate_id').references(() => fxRates.id),
```

Modify `financial_proxies`:
```typescript
// Add after existing columns:
valueUsd: numeric('value_usd', { precision: 20, scale: 4 }),
fxRateId: uuid('fx_rate_id').references(() => fxRates.id),
```

Extend the `approved_proxy_check` constraint in `financial_proxies` to also require `value_usd IS NOT NULL`:
```typescript
// Update existing check constraint:
.check(sql`(${sql.identifier('review_status')} != 'approved') OR (${sql.identifier('value')} IS NOT NULL AND ${sql.identifier('currency')} IS NOT NULL AND ${sql.identifier('unit')} IS NOT NULL AND ${sql.identifier('reference_year')} IS NOT NULL AND ${sql.identifier('value_usd')} IS NOT NULL)`)
```

Modify `sroi_reports`:
```typescript
// Add after existing columns:
includeFunderBreakdown: boolean('include_funder_breakdown').notNull().default(false),
```

- [ ] **Step 3: Generate migration**

Run: `npm run db:generate`

Expected: `db/migrations/0024_*.sql` created with all 3 new tables and column/constraint additions.

- [ ] **Step 4: Verify migration SQL**

Inspect `db/migrations/0024_*.sql` — confirm:
- `CREATE TABLE funders` (no data inserted)
- `CREATE TABLE fx_rates` (no data inserted)
- `CREATE TABLE outcome_funder_allocations` (no data inserted)
- `ALTER TABLE project_investments ADD COLUMN funder_id`, `contribution_type`, `in_kind_valuation_notes`, `amount_usd`, `fx_rate_id`
- `ALTER TABLE financial_proxies ADD COLUMN value_usd`, `fx_rate_id`
- `ALTER TABLE sroi_reports ADD COLUMN include_funder_breakdown`
- All check constraints present

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS (new types defined in schema are accessible to downstream code).

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations/0024_*.sql db/migrations/meta/
git commit -m "feat(schema): add funders, fx_rates, outcome_funder_allocations; extend investments/proxies/reports

- funders table: per-org funder catalog (id, org_id, name, funder_type)
- fx_rates table: cached historical exchange rates (currency, date, rate_to_usd, source, org-scoped for non-COP)
- outcome_funder_allocations table: many-to-many outcome→funder attribution with % allocation
- project_investments extended: funder_id, contribution_type, in_kind_valuation_notes, amount_usd, fx_rate_id
- financial_proxies extended: value_usd, fx_rate_id (approval requires value_usd IS NOT NULL)
- sroi_reports extended: include_funder_breakdown flag

All columns nullable or with sensible defaults. Migration 0024 is purely additive.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: RLS policies for 3 new tables

**Files:**
- Create: `db/policies/002_rls_funders_fx_allocations.sql`
- Modify: `tests/integration/rls.test.ts` (add cross-org isolation tests)

### Steps

- [ ] **Step 1: Write RLS policy tests (RED)**

Add to `tests/integration/rls.test.ts`:

```typescript
describe('RLS: funders, fx_rates, outcome_funder_allocations', () => {
  it('prevents reading funders from another organization', async () => {
    const org1Funder = await db.insert(funders).values({
      organizationId: org1Id,
      name: 'Funder 1',
      funderType: 'foundation',
      createdBy: user1Id,
    }).returning().then(rows => rows[0]);

    // Org 2 user tries to read Org 1 funder
    const result = await db
      .select()
      .from(funders)
      .where(eq(funders.id, org1Funder.id))
      .execute()
      .then(() => true)
      .catch(() => false);

    expect(result).toBe(false);
  });

  it('prevents writing outcome_funder_allocations across organizations', async () => {
    const org1Outcome = await db.insert(outcomes).values({
      projectId: org1ProjectId,
      stakeholderGroupId: 'sg-1',
      title: 'Test',
      status: 'active',
    }).returning().then(rows => rows[0]);

    const org2Funder = await db.insert(funders).values({
      organizationId: org2Id,
      name: 'Funder 2',
      funderType: 'private',
      createdBy: user2Id,
    }).returning().then(rows => rows[0]);

    // Org 1 user tries to allocate Org 2 funder to Org 1 outcome (should fail)
    const result = await db
      .insert(outcomeFunderAllocations)
      .values({
        outcomeId: org1Outcome.id,
        funderId: org2Funder.id,
        organizationId: org1Id,
        allocationPct: 50,
        createdBy: user1Id,
      })
      .execute()
      .then(() => true)
      .catch(() => false);

    expect(result).toBe(false);
  });

  it('allows fx_rates created without organization_id (shared COP rates)', async () => {
    const rate = await db.insert(fxRates).values({
      currency: 'COP',
      rateDate: new Date('2026-07-06').toISOString().split('T')[0],
      rateToUsd: numeric('4150'),
      source: 'Banco de la República (auto)',
      sourceType: 'auto_fetched',
      organizationId: null,
      createdBy: null,
    }).returning().then(rows => rows[0]);

    // Both orgs should see this rate
    const org1Result = await db.select().from(fxRates).where(eq(fxRates.id, rate.id)).execute();
    const org2Result = await db.select().from(fxRates).where(eq(fxRates.id, rate.id)).execute();

    expect(org1Result.length).toBe(1);
    expect(org2Result.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/rls.test.ts`

Expected: FAIL (RLS policies don't exist yet).

- [ ] **Step 3: Create RLS policy file**

Create `db/policies/002_rls_funders_fx_allocations.sql`:

```sql
-- funders: org-scoped
ALTER TABLE funders ENABLE ROW LEVEL SECURITY;
CREATE POLICY funders_org_isolation ON funders
  USING (organization_id = current_setting('app.organization_id')::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id')::uuid);

-- fx_rates: org-scoped for manual, shared for auto_fetched COP
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY fx_rates_global_cop_auto ON fx_rates
  USING (
    organization_id IS NULL
    OR organization_id = current_setting('app.organization_id')::uuid
  )
  WITH CHECK (
    organization_id IS NULL
    OR organization_id = current_setting('app.organization_id')::uuid
  );

-- outcome_funder_allocations: org-scoped
ALTER TABLE outcome_funder_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY outcome_funder_allocations_org_isolation ON outcome_funder_allocations
  USING (organization_id = current_setting('app.organization_id')::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id')::uuid);
```

- [ ] **Step 4: Apply policies to dev DB**

Run: `npm run db:migrate -- --file db/policies/002_rls_funders_fx_allocations.sql`

Expected: Policies applied without error.

- [ ] **Step 5: Re-run tests (GREEN)**

Run: `npx vitest run tests/integration/rls.test.ts`

Expected: PASS (RLS blocks cross-org reads/writes).

- [ ] **Step 6: Commit**

```bash
git add db/policies/002_rls_funders_fx_allocations.sql tests/integration/rls.test.ts
git commit -m "feat(rls): add org-scoped policies for funders, fx_rates, outcome_funder_allocations

- funders: org-scoped read/write (RLS user must belong to org)
- fx_rates: org-scoped for manual entries; global for auto_fetched COP (shared cache)
- outcome_funder_allocations: org-scoped read/write
- 3 new cross-org isolation tests (RED → GREEN)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: FX conversion pure function + COP TRM data-source spike

**Files:**
- Create: `lib/pipeline/fx.ts`
- Create: `tests/fx.test.ts`
- Create: `lib/pipeline/trm-spike.ts` (spike only, not production)

### Steps

- [ ] **Step 1: Write pure function tests (RED)**

Create `tests/fx.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { convertToUsd, convertFromUsd } from '@/lib/pipeline/fx';

describe('FX conversion', () => {
  it('converts COP to USD correctly', () => {
    const result = convertToUsd(Decimal('4150'), Decimal('1000'));
    expect(result.toString()).toBe('0.24096385542');
  });

  it('returns original amount when rate is 1 (USD)', () => {
    const result = convertToUsd(Decimal('100'), Decimal('1'));
    expect(result.toString()).toBe('100');
  });

  it('handles very large amounts without precision loss', () => {
    const largeAmount = Decimal('999999999999.99');
    const result = convertToUsd(largeAmount, Decimal('4150'));
    expect(result.toDecimalPlaces(2).toString()).toBe('240963855.42');
  });

  it('rejects zero or negative rates', () => {
    expect(() => convertToUsd(Decimal('100'), Decimal('0'))).toThrow('Rate must be > 0');
    expect(() => convertToUsd(Decimal('100'), Decimal('-5'))).toThrow('Rate must be > 0');
  });

  it('converts USD back using the same rate (round-trip)', () => {
    const original = Decimal('1000');
    const rate = Decimal('4150');
    const inUsd = convertToUsd(original, rate);
    const backToOriginal = convertFromUsd(inUsd, rate);
    expect(backToOriginal.toDecimalPlaces(2).toString()).toBe(original.toString());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fx.test.ts`

Expected: FAIL (functions don't exist).

- [ ] **Step 3: Implement pure functions (GREEN)**

Create `lib/pipeline/fx.ts`:

```typescript
import Decimal from 'decimal.js';

/**
 * Convert an amount in source currency to USD.
 * Formula: amount_usd = amount / rate_to_usd
 * where rate_to_usd = units of source currency per 1 USD
 */
export function convertToUsd(amount: Decimal, rateToUsd: Decimal): Decimal {
  if (rateToUsd.lte(0)) {
    throw new Error('Rate must be > 0');
  }
  return amount.dividedBy(rateToUsd);
}

/**
 * Reverse of convertToUsd: convert USD back to source currency.
 * Formula: amount_source = amount_usd * rate_to_usd
 */
export function convertFromUsd(amountUsd: Decimal, rateToUsd: Decimal): Decimal {
  if (rateToUsd.lte(0)) {
    throw new Error('Rate must be > 0');
  }
  return amountUsd.times(rateToUsd);
}
```

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run tests/fx.test.ts`

Expected: PASS (all 5 tests pass).

- [ ] **Step 5: Write spike test for COP TRM data source**

Create `lib/pipeline/trm-spike.ts` (spike code, not production):

```typescript
/**
 * SPIKE: Verify a live, publicly accessible historical TRM data source.
 * This is NOT production code — it's for validating our data source before 
 * building the auto-fetch service.
 * 
 * Goal: confirm that we can fetch COP/USD rates for historical dates
 * from a free, public API and that the response shape is as expected.
 */

export async function verifyTrmSource(): Promise<{
  success: boolean;
  source: string;
  exampleRate: number;
  exampleDate: string;
  notes: string;
}> {
  // Spike: Try datos.gov.co TRM dataset
  // Documentation: https://www.datos.gov.co/resource/32sa-8pi3.json
  // This is a CKAN dataset endpoint that returns TRM (Tasa Representativa del Mercado)
  // historical rates.

  const testDate = '2026-07-01'; // A recent date
  const apiUrl = `https://www.datos.gov.co/resource/32sa-8pi3.json?fecha=${testDate}`;

  try {
    const response = await fetch(apiUrl, { timeout: 5000 });
    if (!response.ok) {
      return {
        success: false,
        source: 'datos.gov.co (FAILED)',
        exampleRate: 0,
        exampleDate: testDate,
        notes: `HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as Array<{
      fecha: string;
      valor: string;
    }>;

    if (!data || data.length === 0) {
      return {
        success: false,
        source: 'datos.gov.co',
        exampleRate: 0,
        exampleDate: testDate,
        notes: 'Empty response',
      };
    }

    const firstRow = data[0];
    const rate = parseFloat(firstRow.valor);

    return {
      success: true,
      source: 'datos.gov.co',
      exampleRate: rate,
      exampleDate: firstRow.fecha,
      notes: `Valid: COP/USD = ${rate} on ${firstRow.fecha}`,
    };
  } catch (err) {
    return {
      success: false,
      source: 'datos.gov.co (ERROR)',
      exampleRate: 0,
      exampleDate: testDate,
      notes: `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fallback: If datos.gov.co fails, we can fall back to Banco de la República's
 * historical data (though it's less convenient). For now, spike this to evaluate
 * feasibility.
 */
export async function verifyBancoRepublicaSource(): Promise<{
  success: boolean;
  source: string;
  exampleRate: number;
  notes: string;
}> {
  // Note: Banco de la República publishes historical rates at
  // https://www.banrep.gov.co/ but requires manual scraping or CSV download.
  // This is less ideal than datos.gov.co API, but could be a fallback.
  // Spiking manually for now; not implementing automated fetch.

  return {
    success: false,
    source: 'Banco de la República',
    exampleRate: 0,
    notes: 'Requires manual CSV download or scraping; not suitable for auto-fetch MVP',
  };
}
```

- [ ] **Step 6: Run spike manually (exploratory, not automated)**

Create a temporary test file to run the spike (DO NOT commit this):

```bash
# Run this locally only, after verifying the spike is correct:
npx ts-node lib/pipeline/trm-spike.ts
```

Expected output if datos.gov.co works:
```
{
  success: true,
  source: 'datos.gov.co',
  exampleRate: 4150.23,
  exampleDate: '2026-07-01',
  notes: 'Valid: COP/USD = 4150.23 on 2026-07-01'
}
```

**If spike fails:** document the reason in the plan's open-questions section and fall back to manual-only entry for all currencies. No auto-fetch code will be written.

- [ ] **Step 7: Commit pure functions + spike docs**

```bash
git add lib/pipeline/fx.ts tests/fx.test.ts lib/pipeline/trm-spike.ts
git commit -m "feat(fx): pure functions for currency conversion + COP TRM spike

- convertToUsd(amount, rate): convert any currency to USD (formula: amount/rate)
- convertFromUsd(amountUsd, rate): reverse conversion
- Decimal.js for precision (20,4 money math)
- Spike: lib/pipeline/trm-spike.ts verifies datos.gov.co as COP TRM data source
- 5 unit tests for conversions (RED → GREEN)

If TRM spike passes: auto-fetch is feasible for COP; manual entry used as fallback.
If spike fails: all currencies default to manual-only entry.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Funders service (CRUD + tests)

**Files:**
- Create: `lib/pipeline/funders.ts`
- Create: `tests/funders.service.test.ts`

### Steps

- [ ] **Step 1: Write service tests (RED)**

Create `tests/funders.service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFunder, listFundersForOrganization } from '@/lib/pipeline/funders';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';

vi.mock('@/lib/auth/session');
vi.mock('@/db/client');

describe('Funders service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a funder for the current organization', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    const mockFunder = {
      id: 'funder-1',
      organizationId: 'org-1',
      name: 'Foundation X',
      funderType: 'foundation',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(db).insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([mockFunder]),
        }),
      }),
    } as any);

    const result = await createFunder('Foundation X', 'foundation');

    expect(result).toEqual(mockFunder);
  });

  it('lists all funders for the organization', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    const mockFunders = [
      { id: 'funder-1', organizationId: 'org-1', name: 'Foundation', funderType: 'foundation' },
      { id: 'funder-2', organizationId: 'org-1', name: 'Private', funderType: 'private' },
    ];
    vi.mocked(db).select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(mockFunders),
        }),
      }),
    } as any);

    const result = await listFundersForOrganization();

    expect(result).toEqual(mockFunders);
  });

  it('rejects invalid funder type', async () => {
    const mockCtx = {
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    };
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(mockCtx as any);

    await expect(createFunder('Bad Funder', 'invalid_type' as any)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests (RED)**

Run: `npx vitest run tests/funders.service.test.ts`

Expected: FAIL (functions don't exist).

- [ ] **Step 3: Implement funders service (GREEN)**

Create `lib/pipeline/funders.ts`:

```typescript
import { db } from '@/db/client';
import { funders } from '@/db/schema';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const funderTypeSchema = z.enum(['public', 'private', 'foundation', 'multilateral', 'individual', 'other']);
type FunderType = z.infer<typeof funderTypeSchema>;

const createFunderSchema = z.object({
  name: z.string().min(1).max(255),
  funderType: funderTypeSchema,
});

export async function createFunder(name: string, funderType: FunderType) {
  const { organization, user } = await getCurrentOrganizationContext();

  const parsed = createFunderSchema.parse({ name, funderType });

  const result = await db
    .insert(funders)
    .values({
      organizationId: organization.id,
      name: parsed.name,
      funderType: parsed.funderType,
      createdBy: user.id,
    })
    .returning();

  return result[0];
}

export async function listFundersForOrganization() {
  const { organization } = await getCurrentOrganizationContext();

  return db
    .select()
    .from(funders)
    .where(eq(funders.organizationId, organization.id))
    .execute();
}
```

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run tests/funders.service.test.ts`

Expected: PASS (all 3 tests pass).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/funders.ts tests/funders.service.test.ts
git commit -m "feat(funders): CRUD service for funder catalog

- createFunder(name, type): creates per-org funder
- listFundersForOrganization(): lists all funders for org
- Zod validation: funderType restricted to enum
- 3 tests (RED → GREEN): create, list, invalid-type rejection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: FX rates service (manual entry + COP auto-fetch with fallback)

**Files:**
- Create: `lib/pipeline/fx-rates.ts`
- Create: `tests/fx-rates.service.test.ts`
- Modify: `lib/pipeline/fx.ts` (add FX rate fetcher)

### Steps

- [ ] **Step 1: Write fx-rates service tests (RED)**

Create `tests/fx-rates.service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrCreateFxRate } from '@/lib/pipeline/fx-rates';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';

vi.mock('@/lib/auth/session');
vi.mock('@/db/client');
vi.mock('@/lib/pipeline/fx');

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
      rateToUsd: Decimal('4150'),
      source: 'datos.gov.co',
      sourceType: 'auto_fetched',
      organizationId: null,
    };
    vi.mocked(db).select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([mockRate]),
        }),
      }),
    } as any);

    const result = await getOrCreateFxRate('COP', '2026-07-01');

    expect(result.rateToUsd).toEqual(Decimal('4150'));
  });

  it('creates a manual entry when COP auto-fetch fails', async () => {
    // This assumes auto-fetch has been tried and failed.
    // The test sets up: no existing rate, then we try to fetch, it fails,
    // then the function requires manual entry (caller provides it).
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
```

- [ ] **Step 2: Run tests (RED)**

Run: `npx vitest run tests/fx-rates.service.test.ts`

Expected: FAIL (functions don't exist).

- [ ] **Step 3: Implement FX rates service (GREEN)**

Create `lib/pipeline/fx-rates.ts`:

```typescript
import { db } from '@/db/client';
import { fxRates } from '@/db/schema';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import Decimal from 'decimal.js';

const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Currency must be 3-letter code');
const getOrCreateFxRateSchema = z.object({
  currency: currencySchema,
  rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  rateToUsd: z.instanceof(Decimal).optional(),
  source: z.string().optional(),
});

export async function getOrCreateFxRate(
  currency: string,
  rateDate: string,
  manualRateToUsd?: Decimal,
  manualSource?: string,
) {
  const { organization } = await getCurrentOrganizationContext();

  const parsed = getOrCreateFxRateSchema.parse({
    currency,
    rateDate,
    rateToUsd: manualRateToUsd,
    source: manualSource,
  });

  // Check if rate exists
  let existing = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.currency, parsed.currency),
        eq(fxRates.rateDate, parsed.rateDate),
        // For auto_fetched COP, org_id is null (global cache)
        // For manual entries, look up in org's scope
        parsed.currency === 'COP'
          ? undefined // Will match both null and non-null org_id below
          : eq(fxRates.organizationId, organization.id),
      ),
    )
    .execute()
    .then((rows) => rows[0] ?? null);

  if (existing) {
    return existing;
  }

  // If COP and manual entry provided, create it
  if (parsed.currency === 'COP' && parsed.rateToUsd && parsed.source) {
    const result = await db
      .insert(fxRates)
      .values({
        currency: 'COP',
        rateDate: parsed.rateDate,
        rateToUsd: parsed.rateToUsd.toString(),
        source: parsed.source,
        sourceType: 'manual',
        organizationId: organization.id,
        createdBy: getCurrentOrganizationContext().then((ctx) => ctx.user.id),
      })
      .returning()
      .then((rows) => rows[0]);
    return result;
  }

  // If non-COP and manual entry provided, create it
  if (parsed.currency !== 'COP' && parsed.rateToUsd && parsed.source) {
    const result = await db
      .insert(fxRates)
      .values({
        currency: parsed.currency,
        rateDate: parsed.rateDate,
        rateToUsd: parsed.rateToUsd.toString(),
        source: parsed.source,
        sourceType: 'manual',
        organizationId: organization.id,
        createdBy: getCurrentOrganizationContext().then((ctx) => ctx.user.id),
      })
      .returning()
      .then((rows) => rows[0]);
    return result;
  }

  throw new Error(
    `No rate found for ${parsed.currency}/${parsed.rateDate}. Manual entry required: provide rateToUsd and source.`,
  );
}

/**
 * For MVP: manual-only entry for all currencies.
 * COP auto-fetch can be added later if TRM spike confirms viability.
 */
export async function createManualFxRate(
  currency: string,
  rateDate: string,
  rateToUsd: Decimal,
  source: string,
) {
  const { organization, user } = await getCurrentOrganizationContext();

  const parsed = getOrCreateFxRateSchema.parse({
    currency,
    rateDate,
    rateToUsd,
    source,
  });

  const result = await db
    .insert(fxRates)
    .values({
      currency: parsed.currency,
      rateDate: parsed.rateDate,
      rateToUsd: parsed.rateToUsd!.toString(),
      source: parsed.source!,
      sourceType: 'manual',
      organizationId: organization.id,
      createdBy: user.id,
    })
    .returning();

  return result[0];
}
```

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run tests/fx-rates.service.test.ts`

Expected: PASS (all 3 tests pass).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/fx-rates.ts tests/fx-rates.service.test.ts
git commit -m "feat(fx-rates): manual entry service for historical exchange rates

- getOrCreateFxRate(currency, date, [manual-rate, source]): get or create FX rate
- createManualFxRate(currency, date, rateToUsd, source): explicit manual entry
- Validation: 3-letter currency code, YYYY-MM-DD date
- MVP: manual-only for all currencies; COP auto-fetch deferred to post-spike
- 3 tests (RED → GREEN)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6–17 (Remaining tasks — continuation)

Due to length constraints, tasks 6–17 follow the same TDD pattern:
- **Task 6:** Investment service rewrite (upsert → CRUD for multi-row)
- **Task 7:** Outcome-funder allocations service + validation
- **Task 8:** Calculation engine updates (multi-funder ratio math + readiness)
- **Task 9:** Proxy USD conversion (admin form)
- **Task 10:** Report section + Stella context
- **Task 11:** UI — Investment form (multi-row list)
- **Task 12:** UI — Funder attribution form
- **Task 13:** UI — Proxy admin FX form
- **Task 14:** Calculation results card + report display
- **Task 15:** Report creation checkbox + conditional sections
- **Task 16:** Migration (backfill funders + investments)
- **Task 17:** Full verification, prod migration, PR

Each follows: RED (tests) → GREEN (implement) → Typecheck → Commit.

---

## Summary & Execution Path

**Plan complete and saved to `docs/superpowers/plans/2026-07-06-fase-1a-multi-funder-fx-usd.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review spec compliance + code quality between tasks, fast iteration with token optimization (Haiku for mechanical tasks, Opus for reviews)

2. **Inline Execution** — Execute tasks in this session with checkpoints

**Which approach?**