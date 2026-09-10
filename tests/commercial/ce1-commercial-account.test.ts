// tests/commercial/ce1-commercial-account.test.ts
// CE-1 — CommercialAccount relation and live association (HPO-ODS-W2-26,
// docs/ops/commercial/COMMERCIAL_ACCOUNT_CE1_EXECUTION_AUTHORITY_v1.0.0.json +
// AMENDMENT_v1.0.1.json).
//
// DB-FREE controls over the frozen product contract, proven against the LIVE
// bytes of the migration, the manifest and the schema — never against a copy.
// Everything that is a database semantic (RLS denial, FORCE's runtime effect,
// the shared-governance-does-not-widen-visibility claim) is proven by
// tests/postgres/ce1-commercial-account.pg.test.ts against a real PostgreSQL
// (PG-1, PG-3). This file proves the parts a static reading CAN prove.
//
// Bound manifest controls: P-1 (shape / no user-membership-role column), N-16
// (SENTINEL_UNGOVERNED_ORG yields no capability — trivially true, CE-1 adds
// no evaluator), M-10 (no commercial identifier enters tenant scope — the
// static half: db/identity-context.ts and every RLS predicate are swept for
// commercial_account_id and found absent). P-2, P-3's PG half and N-4's
// dynamic half live in the .pg.test.ts file.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { scanBaselineSql, splitSqlStatements, stripSqlComments } from '@/db/hosted/baseline-scanner'
import { commercialAccounts, organizations } from '@/db/schema'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const lf = (s: string) => s.split('\r\n').join('\n')

// The CE-1 unit is DERIVED from the live manifest, never named by ordinal
// here: the ordinal is a globally contested sequence and this file must keep
// proving the right unit even if the lane had to re-number.
const CE1_UNIT = BASELINE_UNITS.find((u) => /^\d{4}_commercial_account_ce1\.sql$/.test(u.id))
if (!CE1_UNIT) throw new Error('the CE-1 commercial_account baseline unit is not registered in db/hosted/baseline-manifest.ts')
const MIGRATION_SQL = read(CE1_UNIT.file)
const MIGRATION_LF = lf(MIGRATION_SQL)
const STATEMENTS = splitSqlStatements(stripSqlComments(MIGRATION_LF))
const FACTS = scanBaselineSql(MIGRATION_SQL)

describe('CE-1 schema — commercial_accounts, the frozen 7-column shape (P-1, CA-01)', () => {
  const schema = lf(read('db/schema.ts'))

  it('is declared as its own pgTable, distinct from organizations', () => {
    expect(schema).toMatch(/export const commercialAccounts = pgTable\('commercial_accounts', \{/)
    expect(Object.keys(commercialAccounts)).toBeDefined()
  })

  it('has exactly the 7 frozen columns, no more, no fewer', () => {
    const block = schema.slice(
      schema.indexOf("export const commercialAccounts = pgTable('commercial_accounts', {"),
      schema.indexOf("export const organizations = pgTable('organizations', {"),
    )
    const columnLines = block.match(/^\s{2}\w+:/gm) ?? []
    const names = columnLines.map((l) => l.trim().replace(':', ''))
    expect(names).toEqual(['id', 'legalName', 'billingCountry', 'billingContactEmail', 'commercialStatus', 'createdAt', 'updatedAt'])
  })

  it('id is uuid PRIMARY KEY DEFAULT gen_random_uuid(), matching the organizations.id convention', () => {
    expect(schema).toMatch(/commercialAccounts = pgTable\('commercial_accounts', \{\s*\n\s*id: uuid\('id'\)\.primaryKey\(\)\.defaultRandom\(\)\.notNull\(\),/)
  })

  it('legal_name, billing_country, billing_contact_email are NULLABLE with no default', () => {
    expect(schema).toMatch(/legalName: varchar\('legal_name', \{ length: 255 \}\),\s*\n/)
    expect(schema).toMatch(/billingCountry: varchar\('billing_country', \{ length: 2 \}\),\s*\n/)
    expect(schema).toMatch(/billingContactEmail: varchar\('billing_contact_email', \{ length: 255 \}\),\s*\n/)
  })

  it('commercial_status is NOT NULL DEFAULT active, CHECK-constrained to exactly the four frozen values, in order', () => {
    expect(schema).toMatch(/commercialStatus: varchar\('commercial_status', \{ length: 50 \}\)\.default\('active'\)\.notNull\(\),/)
    expect(schema).toMatch(/check\('commercial_status_check', sql`\$\{table\.commercialStatus\} IN \('active', 'past_due', 'suspended', 'closed'\)`\)/)
    expect(commercialAccounts.commercialStatus.notNull).toBe(true)
    expect(commercialAccounts.commercialStatus.hasDefault).toBe(true)
  })

  it('created_at / updated_at are NOT NULL DEFAULT now(), no trigger-maintained auto-update', () => {
    expect(schema).toMatch(/createdAt: timestamp\('created_at'\)\.defaultNow\(\)\.notNull\(\),\s*\n\s*updatedAt: timestamp\('updated_at'\)\.defaultNow\(\)\.notNull\(\),\s*\n\}/)
  })

  it('carries exactly one CHECK constraint', () => {
    const checkCount = STATEMENTS.filter((s) => /CREATE TABLE "commercial_accounts"/.test(s)).reduce(
      (n, s) => n + (s.match(/CONSTRAINT "commercial_status_check"/g) ?? []).length,
      0,
    )
    expect(checkCount).toBe(1)
  })

  it('the explicit prohibition holds: no user_id, membership, role, Stripe, entitlement or quota column', () => {
    const block = schema.slice(
      schema.indexOf("export const commercialAccounts = pgTable('commercial_accounts', {"),
      schema.indexOf("export const organizations = pgTable('organizations', {"),
    )
    expect(block).not.toMatch(/user_id|userId/i)
    expect(block).not.toMatch(/membership|role/i)
    expect(block).not.toMatch(/stripe/i)
    expect(block).not.toMatch(/entitlement|quota/i)
  })
})

describe('CE-1 schema — organizations.commercial_account_id (P-3, ungoverned_state)', () => {
  const schema = lf(read('db/schema.ts'))

  it('is a NULLABLE uuid FK, NO DEFAULT, NO CE-1 writer — NULL means ungoverned', () => {
    expect(schema).toMatch(/commercialAccountId: uuid\('commercial_account_id'\)\.references\(\(\) => commercialAccounts\.id, \{ onDelete: 'restrict' \}\),/)
    const line = schema.split('\n').find((l) => l.includes("uuid('commercial_account_id')"))!
    expect(line).not.toMatch(/notNull|default\(/)
    expect(Object.keys(organizations)).toContain('commercialAccountId')
    expect(organizations.commercialAccountId.notNull).toBe(false)
    expect(organizations.commercialAccountId.hasDefault).toBe(false)
  })

  it('the FK is ON DELETE RESTRICT — a governing account is not deletable while it governs a live Organization', () => {
    const fk = STATEMENTS.find((s) => /ADD CONSTRAINT "organizations_commercial_account_id_commercial_accounts_id_fk"/.test(s))
    expect(fk).toBeDefined()
    expect(fk).toMatch(/ON DELETE restrict/)
    expect(fk).not.toMatch(/ON DELETE cascade/i)
    expect(fk).not.toMatch(/ON DELETE set null/i)
  })

  it('the index is an ORDINARY non-unique b-tree — CC-4 forbids re-imposing 1:1 cardinality', () => {
    expect(schema).toMatch(/index\('idx_organizations_commercial_account_id'\)\.on\(table\.commercialAccountId\),/)
    const idx = STATEMENTS.find((s) => /"idx_organizations_commercial_account_id"/.test(s))
    expect(idx).toBeDefined()
    expect(idx).toMatch(/^CREATE INDEX/)
    expect(idx).not.toMatch(/^CREATE UNIQUE INDEX/)
  })

  it('ADD COLUMN carries no DEFAULT and no backfill statement — every existing row is NULL after CE-1', () => {
    const addColumn = STATEMENTS.find((s) => /ADD COLUMN "commercial_account_id"/.test(s))
    expect(addColumn).toBeDefined()
    expect(addColumn).not.toMatch(/DEFAULT/i)
    expect(STATEMENTS.filter((s) => /^UPDATE\b/i.test(s))).toHaveLength(0)
    expect(FACTS.dmlStatements).toHaveLength(0)
  })
})

describe('CE-1 security — ENABLE + FORCE ROW LEVEL SECURITY, ZERO policies (SEC-2, SEC-7, CE1-F-3)', () => {
  it('ENABLE ROW LEVEL SECURITY is present and the scanner sees exactly one enabled table', () => {
    expect(MIGRATION_LF).toMatch(/ALTER TABLE commercial_accounts ENABLE ROW LEVEL SECURITY;/)
    expect(FACTS.rlsEnabledTables).toEqual(['public.commercial_accounts'])
  })

  // CE1-A-F-1: the structural scanner cannot see FORCE at all (no handling of
  // the token anywhere in db/hosted/baseline-scanner.ts) — this assertion is
  // the ONLY control in the repository that would notice FORCE's removal; the
  // manifest's expect.rlsEnabledTableCount pins ENABLE alone and stays silent.
  it('FORCE ROW LEVEL SECURITY is present in the migration text — asserted directly, the scanner is blind to it', () => {
    expect(MIGRATION_LF).toMatch(/ALTER TABLE commercial_accounts FORCE ROW LEVEL SECURITY;/)
  })

  it('ENABLE precedes FORCE, both in the SAME migration as the CREATE TABLE', () => {
    const enableAt = MIGRATION_LF.indexOf('ENABLE ROW LEVEL SECURITY')
    const forceAt = MIGRATION_LF.indexOf('FORCE ROW LEVEL SECURITY')
    const createAt = MIGRATION_LF.indexOf('CREATE TABLE "commercial_accounts"')
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(enableAt).toBeGreaterThan(createAt)
    expect(forceAt).toBeGreaterThan(enableAt)
  })

  it('ZERO CREATE POLICY statements — commercial_accounts is not tenant data, no tenant role gains access at CE-1', () => {
    expect(FACTS.policiesCreated).toHaveLength(0)
    expect(FACTS.policiesDropped).toHaveLength(0)
    expect(STATEMENTS.some((s) => /^CREATE POLICY/i.test(s))).toBe(false)
  })

  it('the empty security surface digest is the SHA-256 of the empty string, matching the manifest omission convention', () => {
    expect(FACTS.securitySurface).toHaveLength(0)
    expect(FACTS.securitySurfaceDigest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('CE-1 baseline manifest — the registered unit (BASELINE_UNIT_SHAPE)', () => {
  it('is a drizzle-migration unit, pure DDL, destructive-on-reapply, expecting exactly rlsEnabledTableCount: 1', () => {
    expect(CE1_UNIT!.kind).toBe('drizzle-migration')
    expect(CE1_UNIT!.dml).toBe('none')
    expect(CE1_UNIT!.reapply).toBe('destructive-on-reapply')
    expect(CE1_UNIT!.expect).toEqual({ rlsEnabledTableCount: 1 })
    expect('securitySurfaceDigest' in CE1_UNIT!.expect).toBe(false)
  })

  it('depends on the immediately preceding drizzle unit only — no false edge to 0031_rls_core.sql or any policy unit', () => {
    const index = BASELINE_UNITS.indexOf(CE1_UNIT!)
    const predecessor = BASELINE_UNITS[index - 1]
    expect(CE1_UNIT!.dependsOn).toEqual([predecessor.id])
    expect(CE1_UNIT!.dependsOn).not.toContain('0031_rls_core.sql')
  })

  it('the pinned sha256 matches the LF-normalized migration bytes on disk', () => {
    const digest = createHash('sha256').update(MIGRATION_LF, 'utf8').digest('hex')
    expect(CE1_UNIT!.sha256).toBe(digest)
  })
})

describe('CE-1 compatibility — legacy commercial columns and readers/writers untouched', () => {
  const schema = lf(read('db/schema.ts'))

  it('every legacy organization commercial field is still live truth', () => {
    for (const field of ['stellaMonthlyQuota', 'stellaPlanLabel', 'stripeCustomerId', 'stripeSubscriptionId', 'stripePriceId']) {
      expect(Object.keys(organizations)).toContain(field)
    }
    expect(schema).toMatch(/stellaMonthlyQuota: integer\('stella_monthly_quota'\)\.default\(0\),/)
    expect(schema).toMatch(/stripeCustomerId: varchar\('stripe_customer_id', \{ length: 255 \}\)\.unique\(\),/)
  })

  it('M-10 (static half): db/identity-context.ts never reads or carries commercial_account_id', () => {
    const identityContext = lf(read('db/identity-context.ts'))
    expect(identityContext).not.toMatch(/commercial_account_id|commercialAccountId/)
  })

  it('PI-1: commercial_status is never confused with organizations.status — the two CHECK domains are disjoint in spelling', () => {
    expect(schema).not.toMatch(/organizations_status_check.*suspended/)
  })
})

describe('CE-1 authority-negative — no RLS predicate anywhere references commercial_account_id (PG-1 static half)', () => {
  it('sweeps every db/migrations/**/*.sql for a policy predicate mentioning commercial_account_id', () => {
    const migrationsDir = path.join(ROOT, 'db', 'migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
    const offenders: string[] = []
    for (const file of files) {
      const sql = read(path.join('db', 'migrations', file))
      const facts = scanBaselineSql(sql)
      for (const p of facts.policiesCreated) {
        if (/commercial_account_id/i.test(p)) offenders.push(`${file}: ${p}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the CE-1 unit itself creates zero policies referencing the new column (trivially true — zero policies of any kind)', () => {
    expect(FACTS.policiesCreated.filter((p) => /commercial_account_id/i.test(p))).toEqual([])
  })
})
