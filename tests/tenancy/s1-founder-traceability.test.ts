// tests/tenancy/s1-founder-traceability.test.ts
// Multi-org S1 — founder traceability (canonical node S1 of
// docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json, executed under
// HPO-ODS-W2-20 / HPO-ODS-W2-21 as refined by
// MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.2.json).
//
// DB-FREE controls over the frozen product contract. Everything that is a
// database semantic (the partial unique carrier under a real INSERT, the FK
// ON DELETE RESTRICT, the MO-11 backfill against real audit rows, the
// pre-existing RLS wall) is proven by tests/postgres/s1-founder-cardinality.pg.test.ts
// against a real PostgreSQL. This file proves the parts a static reading CAN
// prove, and it proves them against the LIVE bytes of the migration, the
// manifest, the schema and the onboarding action - never against a copy.
//
// Bound manifest controls: P-1 (shape), P-2 (backfill shape), N-9 / M-6 (PI-3,
// founded_by grants nothing), M-5 (no invited_by inference), M-8 (DROP_LAST:
// user_single_active_membership present), S1-1 (discriminator exists),
// S1-6 (founded_by written in the founding transaction), T-S1-GROWTH-2 (N+1
// by derivation), T-S1-GROWTH-3 (generated-artefact discipline), and the
// v1.0.2 POSITIVE EXIT CRITERION (failing gate-id set is exactly the
// registered rehearsal condition).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BASELINE_UNITS, baselineManifestDigest } from '@/db/hosted/baseline-manifest'
import { scanBaselineSql, splitSqlStatements, stripSqlComments } from '@/db/hosted/baseline-scanner'
import { organizationMembers, organizations } from '@/db/schema'
import {
  buildHostedBaselineGateEvidence,
  evaluateHostedBaselineGates,
} from '../eval/stella-release/hosted-baseline-gate'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const lf = (s: string) => s.split('\r\n').join('\n')

// The S1 unit is DERIVED from the live manifest, never named by ordinal here:
// the ordinal is a globally contested sequence and this file must keep
// proving the right unit even if the lane had to re-number.
const S1_UNIT = BASELINE_UNITS.find((u) => /^\d{4}_multiorg_s1_founder_traceability\.sql$/.test(u.id))
if (!S1_UNIT) throw new Error('the S1 founder-traceability baseline unit is not registered in db/hosted/baseline-manifest.ts')
const MIGRATION_SQL = read(S1_UNIT.file)
const MIGRATION_LF = lf(MIGRATION_SQL)
const STATEMENTS = splitSqlStatements(stripSqlComments(MIGRATION_LF))
const FACTS = scanBaselineSql(MIGRATION_SQL)
const BACKFILL = STATEMENTS.filter((s) => /^UPDATE\b/i.test(s))

describe('S1 schema — the frozen shape (P-1, S1-1)', () => {
  const schema = lf(read('db/schema.ts'))

  it('organizations.founded_by is a NULLABLE uuid referencing users(id) ON DELETE RESTRICT — traceability only', () => {
    expect(schema).toMatch(/foundedBy: uuid\('founded_by'\)\.references\(\(\) => users\.id, \{ onDelete: 'restrict' \}\),/)
    // MO-11: NULL is the honest record. No NOT NULL, no default, no sentinel.
    const line = schema.split('\n').find((l) => l.includes("uuid('founded_by')"))!
    expect(line).not.toMatch(/notNull|default\(/)
    expect(Object.keys(organizations)).toContain('foundedBy')
    expect(organizations.foundedBy.notNull).toBe(false)
    expect(organizations.foundedBy.hasDefault).toBe(false)
  })

  it('organizations.founding_provenance is the durable self-service DISCRIMINATOR, defaulting to the honest unknown', () => {
    expect(schema).toMatch(/foundingProvenance: varchar\('founding_provenance', \{ length: 20 \}\)\.default\('unknown'\)\.notNull\(\),/)
    expect(organizations.foundingProvenance.notNull).toBe(true)
    // The domain admits self-service, non-self-service (platform) and UNKNOWN.
    expect(schema).toMatch(/organizations_founding_provenance_check.*IN \('self_service', 'platform', 'unknown'\)/)
    // A self-service founding without a founder is incoherent and is refused.
    expect(schema).toMatch(/organizations_self_service_requires_founder_check.*<> 'self_service' OR .*IS NOT NULL/)
  })

  it('the MO-01 carrier binds the SELF-SERVICE founding act, never founded_by globally (the naive-index defect is absent)', () => {
    const idx = schema.slice(schema.indexOf("uniqueIndex('organizations_self_service_founder_unique')"))
    const where = idx.slice(0, idx.indexOf(']'))
    expect(where).toMatch(/\.on\(table\.foundedBy\)/)
    expect(where).toMatch(/\.where\(sql`\$\{table\.foundedBy\} IS NOT NULL AND \$\{table\.foundingProvenance\} = 'self_service'`\)/)
    // No global uniqueness on founded_by anywhere: a platform-created
    // organization naming the same subject must not consume the slot.
    expect(schema).not.toMatch(/uuid\('founded_by'\)[^\n]*\.unique\(\)/)
    expect(schema).not.toMatch(/unique\('organizations_founded_by[^\n]*/)
  })

  it('DROP_LAST (M-8): user_single_active_membership is present and unmodified by S1', () => {
    expect(schema).toContain("uniqueIndex('user_single_active_membership').on(table.userId).where(sql`${table.status} = 'active'`)")
    expect(schema).toContain("unique('organization_members_org_user_unique').on(table.organizationId, table.userId)")
    expect(Object.keys(organizationMembers)).toEqual(
      expect.arrayContaining(['organizationId', 'userId', 'role', 'status', 'invitedBy', 'joinedAt']),
    )
  })
})

describe('S1 migration — exactly the authorized DDL, one scanner-visible structural backfill', () => {
  // FINAL-UNIT DISPLACEMENT (HPO-ODS-W2-25, then HPO-ODS-W2-26 /
  // COMMERCIAL_ACCOUNT_CE1_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2). S1 was the
  // highest migration when it landed; 0067_tenancy_refusal_audit_insert_policy.sql
  // was appended above it first, 0068_commercial_account_ce1.sql was appended
  // above THAT, 0069_fib_fibdb052_p1_indexes.sql (FIBDB-052 P1, HPO-FIBP1-01)
  // was appended above THAT, 0070_customer_lifecycle_cl1_legal_acceptance.sql
  // (CL-1, HPO-ODS-W2-28) was appended above THAT, and
  // 0071_customer_lifecycle_cl1_content_bytes.sql (CL-1 presentation-binding
  // repair) has since been appended above THAT. What this control actually
  // protects is that S1's own journal row and snapshot exist and stay
  // consistent — being LAST was only ever how that was expressed while nothing
  // followed it. The pin is RETARGETED to S1's own position with ALL FIVE
  // displacing units NAMED, so a SIXTH, unannounced displacement still fails
  // here. It is not relaxed into "somewhere in the list".
  it('has its journal entry and snapshot, and is displaced from the top by exactly the S3 refusal unit, then exactly the CE-1 unit, then exactly the FIBDB-052 P1 index unit, then exactly the CL-1 legal-acceptance unit, then exactly the CL-1 content-bytes unit', () => {
    const S3_UNIT_ID = '0067_tenancy_refusal_audit_insert_policy.sql'
    const CE1_UNIT_ID = '0068_commercial_account_ce1.sql'
    const P1_UNIT_ID = '0069_fib_fibdb052_p1_indexes.sql'
    const CL1_UNIT_ID = '0070_customer_lifecycle_cl1_legal_acceptance.sql'
    const CL1B_UNIT_ID = '0071_customer_lifecycle_cl1_content_bytes.sql'
    const files = readdirSync(path.join(ROOT, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort()
    expect(files[files.length - 6]).toBe(S1_UNIT.id)
    expect(files[files.length - 5]).toBe(S3_UNIT_ID)
    expect(files[files.length - 4]).toBe(CE1_UNIT_ID)
    expect(files[files.length - 3]).toBe(P1_UNIT_ID)
    expect(files[files.length - 2]).toBe(CL1_UNIT_ID)
    expect(files[files.length - 1]).toBe(CL1B_UNIT_ID)
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] }
    const own = journal.entries.find((e) => `${e.tag}.sql` === S1_UNIT.id)
    expect(own).toBeDefined()
    expect(existsSync(path.join(ROOT, `db/migrations/meta/${String(own!.idx).padStart(4, '0')}_snapshot.json`))).toBe(true)
    const last = journal.entries[journal.entries.length - 1]
    expect(`${last.tag}.sql`).toBe(CL1B_UNIT_ID)
    expect(last.idx).toBe(journal.entries.length - 1)
    expect(existsSync(path.join(ROOT, `db/migrations/meta/${String(last.idx).padStart(4, '0')}_snapshot.json`))).toBe(true)
  })

  it('carries the six S1 DDL statements and no other schema object', () => {
    const ddl = STATEMENTS.filter((s) => !/^UPDATE\b/i.test(s))
    expect(ddl).toHaveLength(6)
    expect(ddl[0]).toMatch(/^ALTER TABLE "organizations" ADD COLUMN "founded_by" uuid;?$/)
    expect(ddl[1]).toMatch(/^ALTER TABLE "organizations" ADD COLUMN "founding_provenance" varchar\(20\) DEFAULT 'unknown' NOT NULL;?$/)
    expect(ddl[2]).toMatch(/ADD CONSTRAINT "organizations_founded_by_users_id_fk" FOREIGN KEY \("founded_by"\) REFERENCES "public"\."users"\("id"\) ON DELETE restrict ON UPDATE no action/)
    expect(ddl[3]).toMatch(/^CREATE UNIQUE INDEX "organizations_self_service_founder_unique" ON "organizations" USING btree \("founded_by"\) WHERE "organizations"\."founded_by" IS NOT NULL AND "organizations"\."founding_provenance" = 'self_service'/)
    expect(ddl[4]).toMatch(/ADD CONSTRAINT "organizations_founding_provenance_check" CHECK \("organizations"\."founding_provenance" IN \('self_service', 'platform', 'unknown'\)\)/)
    expect(ddl[5]).toMatch(/ADD CONSTRAINT "organizations_self_service_requires_founder_check" CHECK \("organizations"\."founding_provenance" <> 'self_service' OR "organizations"\."founded_by" IS NOT NULL\)/)
    // CHECKPOINT_B0_DISPOSITION is conditional on this: S1 creates NO table.
    expect(FACTS.tablesCreated).toEqual([])
    expect(FACTS.policiesCreated).toEqual([])
    expect(FACTS.functionsCreated).toEqual([])
    expect(FACTS.triggersCreated).toEqual([])
    expect(FACTS.superuserDependencies).toEqual([])
    expect(FACTS.roleStatements).toEqual([])
    expect(FACTS.ownershipStatements).toEqual([])
    expect(FACTS.extensionStatements).toEqual([])
  })

  it('the MO-11 backfill is ONE top-level UPDATE the scanner classifies (no DO block, no CTE wrap, no EXECUTE) with zero literal row sources', () => {
    expect(BACKFILL).toHaveLength(1)
    expect(FACTS.dmlStatements).toHaveLength(1)
    expect(FACTS.literalRowSources).toEqual([])
    // Scanner-evasion forms are PROHIBITED (v1.0.2 SCANNER_VISIBILITY_REQUIREMENT).
    expect(MIGRATION_LF).not.toMatch(/\bDO\s+\$/i)
    expect(MIGRATION_LF).not.toMatch(/^\s*WITH\b/im)
    expect(MIGRATION_LF).not.toMatch(/\bEXECUTE\b/i)
    expect(MIGRATION_LF).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|PROCEDURE)/i)
    expect(MIGRATION_LF).not.toMatch(/\bVALUES\s*\(/i)
  })

  it('the backfill attributes ONLY from exactly one organization.created row with a non-null actor, leaving every other case NULL (P-2, T-S1-BACKFILL-1/2)', () => {
    const [u] = BACKFILL
    expect(u).toMatch(/^UPDATE "organizations" AS o\s+SET "founded_by" = q\.actor_user_id/)
    expect(u).toMatch(/FROM "audit_logs"/)
    expect(u).toMatch(/"action" = 'organization\.created' AND "entity_type" = 'organization'/)
    expect(u).toMatch(/GROUP BY "entity_id"/)
    // Exactly one row AND that row's actor is non-null. Both conjuncts are
    // load-bearing: dropping the first accepts >1 rows, dropping the second
    // promotes a NULL actor (min() over a single NULL row is NULL, so the
    // second conjunct is what refuses it).
    expect(u).toMatch(/HAVING count\(\*\) = 1 AND count\("actor_user_id"\) = 1/)
    expect(u).toMatch(/WHERE o\."id" = q\.organization_id AND o\."founded_by" IS NULL/)
    // Only founded_by is written. founding_provenance keeps the column
    // DEFAULT 'unknown' for EVERY historical row (T-S1-BACKFILL-3).
    expect(u).not.toMatch(/founding_provenance/)
    expect(u).not.toMatch(/self_service/)
  })

  it('never infers founding from heuristics: no invited_by, joined_at, created_at ordering, role or lowest-id predicate (M-5, MS1-2)', () => {
    for (const forbidden of [/invited_by/i, /joined_at/i, /ORDER BY/i, /LIMIT\s+1/i, /organization_admin/i, /organization_members/i, /min\("id"\)/i, /created_at/i]) {
      expect(BACKFILL[0]).not.toMatch(forbidden)
    }
    // The prohibition is stated in the migration's own prose, next to the code.
    expect(MIGRATION_LF).toMatch(/PROHIBITED and absent: invited_by IS NULL/)
  })

  // FINAL-UNIT DISPLACEMENT (HPO-ODS-W2-25): S1 is no longer the last unit, so
  // its ordinal is pinned to the EXACT literal it was assigned rather than to
  // a moving BASELINE_UNITS.length, and its position in the array is derived
  // FROM that ordinal. Exact equality both ways — an ordinal that drifted, or
  // a unit that moved out from under its ordinal, still fails.
  it('is registered at its own fixed ordinal with the sha256 of its own bytes, structural-backfill, dmlStatementCount measured by the scanner, and zero literal row sources', () => {
    expect(S1_UNIT.ordinal).toBe(79)
    expect(BASELINE_UNITS[S1_UNIT.ordinal - 1]).toBe(S1_UNIT)
    expect(S1_UNIT.kind).toBe('drizzle-migration')
    expect(S1_UNIT.sha256).toBe(createHash('sha256').update(MIGRATION_LF, 'utf8').digest('hex'))
    expect(S1_UNIT.dml).toBe('structural-backfill')
    expect(S1_UNIT.expect.dmlStatementCount).toBe(FACTS.dmlStatements.length)
    expect(S1_UNIT.expect.literalRowSourceCount ?? 0).toBe(0)
    expect(FACTS.literalRowSources).toHaveLength(0)
    expect(S1_UNIT.dependsOn).toEqual(expect.arrayContaining(['0065_fib_sensitivity_model.sql', '0000_quick_husk.sql']))
    expect(S1_UNIT.managed).toBe('A-hosted-compatible')
    expect(S1_UNIT.reapply).toBe('destructive-on-reapply')
  })

  it('the DML whitelist id is byte-identical across the three governed controls and is the manifest id (v1.0.2 THE_APPENDED_ID)', () => {
    const needle = `'${S1_UNIT.id}',`
    for (const host of [
      'tests/hosted/baseline-manifest.test.ts',
      'tests/eval/stella-release/hosted-baseline-gate.test.ts',
      'tests/eval/stella-release/hosted-baseline-gate.ts',
    ]) {
      const occurrences = lf(read(host)).split(needle).length - 1
      expect(occurrences, `${host} must carry the S1 unit id exactly once in its DML list`).toBe(1)
    }
  })

  it('the generated journal wrapper exists for the unit with the live denominator, and is never hand-written (JOURNAL_CONSEQUENCE)', () => {
    const wrappers = readdirSync(path.join(ROOT, 'db/prepared/journal')).sort()
    const own = wrappers.find((w) => w.endsWith(`_${S1_UNIT.id}`))
    expect(own).toBeDefined()
    const header = lf(read(`db/prepared/journal/${own}`))
    // The NUMERATOR is S1's own ordinal and the DENOMINATOR is the live unit
    // count: appending a unit rewrites the denominator of every wrapper, which
    // is exactly the amplification that makes db/prepared/journal/** a family
    // rather than a single file in this node's ceiling.
    expect(header).toContain(`GENERATED — DO NOT EDIT. Unit ${S1_UNIT.ordinal}/${BASELINE_UNITS.length}: ${S1_UNIT.id}`)
    expect(header).toContain(`Source SHA256: ${S1_UNIT.sha256}`)
    // One wrapper per unit plus the bootstrap.
    expect(wrappers).toHaveLength(BASELINE_UNITS.length + 1)
  })
})

describe('S1 live self-service founding (S1-6, S1_BOOTSTRAP_INTERSECTION)', () => {
  const actions = lf(read('app/(authenticated)/app/onboarding/actions.ts'))

  it('writes founded_by = the founder and the self-service provenance value in the SAME organizations insert, inside withAuthenticatedDatabaseContext', () => {
    const insert = actions.slice(actions.indexOf('.insert(organizations)'), actions.indexOf('.returning()'))
    expect(insert).toMatch(/foundedBy: authUser\.id,/)
    expect(insert).toMatch(/foundingProvenance: 'self_service',/)
    const tx = actions.slice(actions.indexOf('withAuthenticatedDatabaseContext(async () => {'))
    expect(tx.indexOf('.insert(organizations)')).toBeGreaterThan(-1)
    expect(tx.indexOf('.insert(organizationMembers)')).toBeGreaterThan(tx.indexOf('.insert(organizations)'))
    // The qualifying audit row still records the founding act (the MO-11
    // deterministic source), now also carrying the provenance value.
    expect(actions).toMatch(/action: 'organization\.created',\s*afterJson: \{ name, slug, sector, country, foundedBy: authUser\.id, foundingProvenance: 'self_service' \}/)
  })

  it('preserves the allowlist gate (SS-01 is S6), the single-membership check and the fail-closed context; consumes no selected-org carrier (S2/S3 boundary)', () => {
    expect(actions).toMatch(/isEmailAllowlisted/)
    expect(actions).toMatch(/not_allowlisted/)
    expect(actions).toMatch(/getCurrentMembership\(authUser\.id\)/)
    expect(actions).toMatch(/withAuthenticatedDatabaseContext/)
    expect(actions).not.toMatch(/withSuperAdminDatabaseContext|runWithOrganizationAccess/)
    expect(actions).not.toMatch(/selected-organization|selectedOrg|cookies\(\)/)
    // No platform provenance can be minted from the self-service path.
    expect(actions).not.toMatch(/'platform'|'unknown'/)
  })
})

describe('S1 live self-service founding — behaviour under mocks (S1-6 atomicity, gate preserved)', () => {
  const inserts = vi.hoisted(() => [] as { table: unknown; values: Record<string, unknown>; insideContext: boolean }[])
  const state = vi.hoisted(() => ({ insideContext: false, allowlisted: true }))

  vi.mock('next/navigation', () => ({
    redirect: vi.fn((to: string) => {
      throw new Error(`REDIRECT:${to}`)
    }),
  }))
  vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(async () => ({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: '11111111-1111-4111-8111-111111111111', email: 'founder@example.org' } } })) },
    })),
  }))
  vi.mock('@/lib/auth/session', () => ({
    syncUserProfile: vi.fn(async () => undefined),
    getCurrentMembership: vi.fn(async () => null),
    // TENANCY-S3-SELECTOR-REACHABILITY (Packet A): createFirstOrganization
    // now also calls the enumerator. Zero candidates preserves both the
    // POSITIVE founding test (a 0-candidate subject still proceeds to found)
    // and the NEGATIVE allowlist test unchanged.
    listSelectableMemberships: vi.fn(async () => []),
    // PACKET B — createFirstOrganization now reads loadRequestPrincipal
    // directly for its B0 routing check (routing-only; the real refusal for
    // an unverified subject lives in requirePrincipal/C6, reached through
    // withAuthenticatedDatabaseContext, mocked below). This suite is about
    // S1 founding, not Packet B, so the founder is pinned verified.
    //
    // CL-1 — the same action now also reads accountAcceptanceCurrent for its
    // L0 routing check (equally routing-only). This suite is about S1
    // founding, not CL-1, so the founder is pinned acceptance-current.
    loadRequestPrincipal: vi.fn(async () => ({ emailVerified: true, accountAcceptanceCurrent: true })),
  }))
  vi.mock('@/lib/admin/signup-allowlist', () => ({
    isEmailAllowlisted: vi.fn(async () => state.allowlisted),
  }))
  vi.mock('@/lib/audit/logger', () => ({
    logAuditAction: vi.fn(async () => undefined),
  }))
  vi.mock('@/lib/auth/database-context', () => ({
    withAuthenticatedDatabaseContext: vi.fn(async (cb: () => Promise<unknown>) => {
      state.insideContext = true
      try {
        return await cb()
      } finally {
        state.insideContext = false
      }
    }),
  }))
  vi.mock('@/db/client', () => ({
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })) })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserts.push({ table, values, insideContext: state.insideContext })
          return { returning: vi.fn(async () => [{ id: `row-${inserts.length}`, ...values }]) }
        }),
      })),
    },
  }))

  beforeEach(() => {
    inserts.length = 0
    state.allowlisted = true
  })

  function form(): FormData {
    const f = new FormData()
    f.set('name', 'Founded Org')
    f.set('slug', 'founded-org')
    return f
  }

  it('POSITIVE: the organizations insert carries foundedBy = the founder and foundingProvenance = self_service, and the membership insert lands in the same context', async () => {
    const { createFirstOrganization } = await import('@/app/(authenticated)/app/onboarding/actions')
    await expect(createFirstOrganization(form())).rejects.toThrow('REDIRECT:/app/dashboard')
    const org = inserts.find((i) => i.table === organizations)
    const member = inserts.find((i) => i.table === organizationMembers)
    expect(org).toBeDefined()
    expect(member).toBeDefined()
    expect(org!.values.foundedBy).toBe('11111111-1111-4111-8111-111111111111')
    expect(org!.values.foundingProvenance).toBe('self_service')
    expect(org!.insideContext).toBe(true)
    expect(member!.insideContext).toBe(true)
    expect(inserts.indexOf(org!)).toBeLessThan(inserts.indexOf(member!))
    const { logAuditAction } = await import('@/lib/audit/logger')
    const created = vi.mocked(logAuditAction).mock.calls.map((c) => c[0]).find((e) => e.action === 'organization.created')
    expect(created?.actorUserId).toBe('11111111-1111-4111-8111-111111111111')
    expect(created?.afterJson).toMatchObject({ foundedBy: '11111111-1111-4111-8111-111111111111', foundingProvenance: 'self_service' })
  })

  it('NEGATIVE: a non-allowlisted subject is redirected before any insert — S1 did not weaken the pre-existing gate', async () => {
    state.allowlisted = false
    const { createFirstOrganization } = await import('@/app/(authenticated)/app/onboarding/actions')
    await expect(createFirstOrganization(form())).rejects.toThrow('REDIRECT:/app/onboarding?error=not_allowlisted')
    expect(inserts).toHaveLength(0)
  })
})

describe('PI-3 — founded_by is traceability, never authorization (N-9, M-6, MS1-3)', () => {
  const AUTH_SURFACES = [
    'db/identity-context.ts',
    'lib/auth/database-context.ts',
    'lib/auth/session.ts',
    'lib/auth/permissions.ts',
    'lib/auth/roles.ts',
  ]

  it('no authorization surface reads founded_by or founding_provenance', () => {
    for (const file of AUTH_SURFACES) {
      expect(lf(read(file)), `${file} must not read founder traceability`).not.toMatch(/founded_by|foundedBy|founding_provenance|foundingProvenance/)
    }
  })

  it('no RLS policy, helper function or trigger in the corpus predicates on founded_by or founding_provenance', () => {
    const sqlFiles = [
      ...readdirSync(path.join(ROOT, 'db/migrations')).filter((f) => f.endsWith('.sql')).map((f) => `db/migrations/${f}`),
      ...readdirSync(path.join(ROOT, 'db/policies')).filter((f) => f.endsWith('.sql')).map((f) => `db/policies/${f}`),
    ]
    for (const file of sqlFiles) {
      const facts = scanBaselineSql(read(file))
      for (const surface of facts.securitySurface) {
        expect(surface, `${file} carries founder traceability inside an access-control surface`).not.toMatch(/founded_by|founding_provenance/)
      }
    }
    // And the S1 unit itself contributes no security surface at all.
    expect(FACTS.securitySurface).toEqual([])
  })
})

describe('DETERMINISTIC_BASELINE_GROWTH — the pins are derived, the exit criterion is met (T-S1-GROWTH-1/2, v1.0.2 POSITIVE_EXIT_CRITERION)', () => {
  it('firstProvisioning.steps.length is BASELINE_UNITS.length + 1 and the gate literal equals it (N+1 by derivation, not grep)', () => {
    const gate = lf(read('tests/eval/stella-release/hosted-baseline-gate.ts'))
    const m = gate.match(/firstProvisioning\.steps\.length === (\d+) &&/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(BASELINE_UNITS.length + 1)
    const c = gate.match(/evidence\.unitCount === (\d+)/)
    expect(Number(c![1])).toBe(BASELINE_UNITS.length)
  })

  it('every one of the 11 governed count pins is an EXACT-equality literal carrying the measured cardinality, and the unforced kind pins are untouched (T-S1-GROWTH-1/5)', () => {
    const n = BASELINE_UNITS.length
    const drizzle = BASELINE_UNITS.filter((u) => u.kind === 'drizzle-migration').length
    const has = (file: string, needle: string) => {
      const count = lf(read(file)).split(needle).length - 1
      expect(count, `${file} must carry the exact pin ${JSON.stringify(needle)} exactly once`).toBe(1)
    }
    // HOST_1 — four forced pins + the two UNFORCED kind pins byte-unchanged.
    has('tests/hosted/baseline-manifest.test.ts', `expect(BASELINE_UNITS).toHaveLength(${n})`)
    has('tests/hosted/baseline-manifest.test.ts', `expect(byKind('drizzle-migration')).toBe(${drizzle})`)
    has('tests/hosted/baseline-manifest.test.ts', `Array.from({ length: ${n} }, (_, i) => i + 1)`)
    has('tests/hosted/baseline-manifest.test.ts', `expect(new Set(BASELINE_ORDER).size).toBe(${n})`)
    has('tests/hosted/baseline-manifest.test.ts', "expect(byKind('supabase-migration')).toBe(2)")
    has('tests/hosted/baseline-manifest.test.ts', "expect(byKind('policy')).toBe(10)")
    // HOST_2 — two forced pins; the derived BASELINE_UNITS.length + 1 forms stay derived.
    has('tests/hosted/baseline-journal-wrapper.test.ts', `expect(BASELINE_UNITS).toHaveLength(${n})`)
    has('tests/hosted/baseline-journal-wrapper.test.ts', `expect(BASELINE_ORDER).toHaveLength(${n})`)
    expect(lf(read('tests/hosted/baseline-journal-wrapper.test.ts')).split('toHaveLength(BASELINE_UNITS.length + 1)').length - 1).toBe(3)
    // HOST_3 — one forced pin.
    has('tests/hosted/operator-runner.test.ts', `expect(BASELINE_UNITS).toHaveLength(${n})`)
    // HOST_4 — two forced pins; literalRowSources stays 4.
    has('tests/eval/stella-release/hosted-baseline-gate.test.ts', `expect(evidence.unitCount).toBe(${n})`)
    has('tests/eval/stella-release/hosted-baseline-gate.test.ts', `expect(evidence.superuserFreeUnits).toBe(${n})`)
    has('tests/eval/stella-release/hosted-baseline-gate.test.ts', 'expect(evidence.literalRowSources).toBe(4)')
    // HOST_5 — two forced pins (the N+1 asserted above by derivation); literalRowSources guard stays 4.
    has('tests/eval/stella-release/hosted-baseline-gate.ts', `evidence.unitCount === ${n}`)
    has('tests/eval/stella-release/hosted-baseline-gate.ts', `firstProvisioning.steps.length === ${n + 1} &&`)
    has('tests/eval/stella-release/hosted-baseline-gate.ts', 'evidence.literalRowSources !== 4')
    // No pin was weakened into a bound or a range in any of the five hosts.
    for (const host of [
      'tests/hosted/baseline-manifest.test.ts',
      'tests/hosted/baseline-journal-wrapper.test.ts',
      'tests/hosted/operator-runner.test.ts',
      'tests/eval/stella-release/hosted-baseline-gate.test.ts',
    ]) {
      expect(lf(read(host)), `${host} weakened a count pin`).not.toMatch(/BASELINE_UNITS(\.length)?\)?\)\.toBeGreaterThan|unitCount\)\.toBeGreaterThan|toHaveLength\(expect\.any/)
    }
    expect(lf(read('tests/eval/stella-release/hosted-baseline-gate.ts'))).not.toMatch(/evidence\.unitCount >=|steps\.length >=/)
  })

  // v1.0.2 froze the INTERMEDIATE post-growth state (failing set exactly the
  // registered rehearsal condition). v1.0.3 (HPO-ODS-W2-23) authorises the
  // repository-native regeneration of artifacts/baseline-rehearsal/latest.json
  // and revises the FINAL exit to the empty set: every hosted baseline gate
  // passes, and the two registered KTCs are dormant because their condition
  // no longer occurs. Exact set equality - never a bound, never a filter.
  it('the failing gate-id set is EXACTLY [] — every hosted baseline gate passes against the regenerated rehearsal artefact', () => {
    const evidence = buildHostedBaselineGateEvidence()
    const failed = evaluateHostedBaselineGates(evidence).filter((g) => !g.passed).map((g) => g.id)
    expect(failed).toEqual([])
    expect(evidence.rehearsalFresh).toBe(true)
    expect(evidence.rehearsalAppliedAll).toBe(true)
    expect(evidence.rehearsalReproducedDefect).toBe(true)
    expect(evidence.rehearsalPostconditionsClean).toBe(true)
    // The artefact is CURRENT-STATE GENERATED (v1.0.3 NEW_PATH_DISPOSITION):
    // the relation, not a copied digest, is what binds.
    const rehearsal = JSON.parse(read('artifacts/baseline-rehearsal/latest.json')) as { manifestDigest: string; manifestApplied: number }
    expect(rehearsal.manifestApplied).toBe(BASELINE_UNITS.length)
    expect(rehearsal.manifestDigest).toBe(baselineManifestDigest())
    // Self-form guard: this exit assertion must stay an EXACT empty-set
    // equality. A weakening to a bound, a filter or a singleton is refused here
    // as well as by tests/eval/stella-release/hosted-baseline-gate.test.ts.
    const self = lf(read('tests/tenancy/s1-founder-traceability.test.ts'))
    // The needle is assembled at runtime so this guard cannot match itself.
    const exactEmptySet = ['expect(failed)', '.toEqual([])'].join('')
    expect(self.split(exactEmptySet).length - 1).toBe(1)
    const weakenedForms = new RegExp(['expect\\(failed(\\.length)?\\)', '\\.(toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toContain|toEqual\\(expect\\.arrayContaining)'].join(''))
    expect(self).not.toMatch(weakenedForms)
    // ... and the failing set must be derived from the gates UNFILTERED: no
    // gate id may be excluded before the comparison (a KTC is never a filter).
    const derivation = ['.filter((g) => !g.passed)', '.map((g) => g.id)'].join('')
    expect(self.split(derivation).length - 1).toBe(1)
    const filteredDerivation = new RegExp(['\\.map\\(\\(g\\) => g\\.id\\)', '\\s*\\.filter'].join(''))
    expect(self).not.toMatch(filteredDerivation)
    expect(self).not.toMatch(/failed\s*=\s*[^\n]*hosted-baseline-rehearsal-ready/)
    expect(evidence.unitCount).toBe(BASELINE_UNITS.length)
    expect(evidence.superuserFreeUnits).toBe(BASELINE_UNITS.length)
    expect(evidence.dmlUnits[evidence.dmlUnits.length - 1]).toBe(S1_UNIT.id)
    expect(evidence.literalRowSources).toBe(4)
    expect(evidence.firstProvisioningPlannable).toBe(true)
  })
})
