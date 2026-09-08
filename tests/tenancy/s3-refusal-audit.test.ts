// tests/tenancy/s3-refusal-audit.test.ts
//
// Multi-org S3 REFUSAL AUDIT (HPO-ODS-W2-25) — the DB-FREE half of the
// contract. The real-PostgreSQL half lives in
// tests/postgres/s3refusal-completeness.pg.test.ts and proves what the POLICY
// refuses. This file proves what the APPLICATION does and does not emit, which
// is the half no policy can check:
//
//   * the policy cannot prove that entity_id is THE organisation the caller
//     actually attempted — only that it is SOME uuid (RA-SUBJECT-8);
//   * the policy cannot see a row that is never written, so "site 1 and site 3
//     emit NOTHING" (RA-ACTION-2 / RA-ACTION-3) is application-level by
//     necessity;
//   * the policy cannot see WHICH TRANSACTION the write joined (RA-TXN-1).
//
// THE TRANSACTION DOUBLE IS THE POINT, NOT A CONVENIENCE. The fake below
// records BEGIN/COMMIT and stamps every insert with the transaction that was
// open when it happened. That is what turns "the audit must not run inside the
// principal-resolution transaction" from prose into a measurement.

import { describe, it, expect, beforeEach, vi } from 'vitest'

/* -------------------------------------------------------------------------- */
/* Fixture identities                                                         */
/* -------------------------------------------------------------------------- */

const USER_A = '0a300000-0000-4000-8000-0000000000a3'
const USER_B = '0b300000-0000-4000-8000-0000000000b3'
const ORG_A = '1a300000-0000-4000-8000-0000000001a3'
const ORG_B = '1b300000-0000-4000-8000-0000000001b3'
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/* -------------------------------------------------------------------------- */
/* The recording transaction double                                           */
/* -------------------------------------------------------------------------- */

interface RecordedInsert {
  readonly txId: string | null
  readonly values: Record<string, unknown>
}

const txLog: string[] = []
const inserts: RecordedInsert[] = []
let txCounter = 0
let currentTxId: string | null = null
/** Set by a test to make the NEXT insert throw — the fail-closed half of RA-TXN-1. */
let failNextInsert: Error | null = null

/**
 * A drizzle chain double covering exactly the shape the three loaders in
 * lib/auth/database-context.ts use: select().from(t).where(..).limit(1).then().
 * Keyed on the table object, so the module under test is untouched — the site
 * discrimination being measured lives inside it.
 */
function chainFor(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  chain.where = () => chain
  chain.limit = () => chain
  chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(resolve(rows))
  return chain
}

const fakeDb = {
  insert: () => ({
    values: async (values: Record<string, unknown>) => {
      if (failNextInsert) {
        const err = failNextInsert
        failNextInsert = null
        throw err
      }
      inserts.push({ txId: currentTxId, values })
    },
  }),
  select: () => ({
    from: (table: { id?: string }) => {
      if (table?.id === 'users.id') return chainFor(scenario.user ? [scenario.user] : [])
      if (table?.id === 'om.id') return chainFor(scenario.membership ? [scenario.membership] : [])
      if (table?.id === 'orgs.id') return chainFor(scenario.organization ? [scenario.organization] : [])
      return chainFor([])
    },
  }),
}

vi.mock('@/db/client', () => ({
  get db() {
    return fakeDb
  },
}))

// The identity context, faked over the REAL async-local store so that
// getBoundDatabaseContext() — which lib/audit/tenancy-refusal.ts calls to
// verify its own preconditions — sees exactly what the production store would.
vi.mock('@/db/identity-context', async () => {
  const store = await import('@/db/identity-store')
  return {
    getBoundDatabaseContext: store.getBoundDatabaseContext,
    withDatabaseIdentityContext: async (
      identity: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
      callback: (db: unknown) => Promise<unknown>,
    ) => {
      const existing = store.getBoundDatabaseContext()
      if (existing !== undefined) {
        // Mirrors the real module: same identity reuses the OPEN transaction
        // rather than starting a second one. This is precisely the reuse that
        // makes writing inside the principal transaction possible, so the
        // double must reproduce it or RA-TXN-1 would be vacuous.
        if (
          existing.identity.userId !== identity.userId ||
          existing.identity.organizationId !== identity.organizationId
        ) {
          throw new Error('DB_IDENTITY_NESTED_MISMATCH')
        }
        return callback(existing.db)
      }
      const txId = `tx${++txCounter}`
      txLog.push(`BEGIN ${txId}`)
      const previous = currentTxId
      currentTxId = txId
      try {
        return await store.runWithBoundDatabaseContext(
          { identity, db: fakeDb } as never,
          () => callback(fakeDb) as Promise<never>,
        )
      } finally {
        currentTxId = previous
        txLog.push(`COMMIT ${txId}`)
      }
    },
  }
})

/* -------------------------------------------------------------------------- */
/* The auth + carrier boundary                                                */
/* -------------------------------------------------------------------------- */

const mockIdentity = vi.fn()
vi.mock('@/lib/auth/identity', () => ({
  getVerifiedAuthIdentityResult: () => mockIdentity(),
}))

const mockSelectedOrganizationId = vi.fn()
vi.mock('@/lib/auth/selected-organization', () => ({
  getSelectedOrganizationId: () => mockSelectedOrganizationId(),
}))

/* -------------------------------------------------------------------------- */
/* What the principal read finds in the database                              */
/* -------------------------------------------------------------------------- */

interface Scenario {
  user: Record<string, unknown> | null
  membership: Record<string, unknown> | null
  organization: Record<string, unknown> | null
}
const scenario: Scenario = { user: null, membership: null, organization: null }

// The three loaders in lib/auth/database-context.ts read through drizzle
// chains. Faking the CHAIN rather than the module keeps the module under test
// intact — the site discrimination being measured lives in that module.
vi.mock('@/db/schema', () => ({
  users: { id: 'users.id' },
  organizationMembers: { id: 'om.id', organizationId: 'om.org', userId: 'om.user', status: 'om.status', deletedAt: 'om.deleted' },
  organizations: { id: 'orgs.id' },
  auditLogs: { id: 'audit.id' },
}))

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, and: (...a: unknown[]) => a, eq: (a: unknown, b: unknown) => [a, b], isNull: (a: unknown) => a }
})

import { runWithBoundDatabaseContext } from '@/db/identity-store'
import {
  emitOrganizationSelectionRefused,
  emitMembershipRevalidationRefused,
  TenancyRefusalAuditError,
} from '@/lib/audit/tenancy-refusal'
import { AUDIT_ACTIONS } from '@/lib/audit/logger'

const SELECTION = 'tenancy.organization.selection_refused'
const REVALIDATION = 'tenancy.membership.revalidation_refused'
const REASON_A = 'TENANCY_NO_ORGANIZATION_SELECTED'
const REASON_B = 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'

/** Run `fn` inside a fake unscoped context for `userId`, as a caller would. */
async function inUnscopedContext(userId: string, fn: () => Promise<void>): Promise<void> {
  await runWithBoundDatabaseContext(
    { identity: { userId, organizationId: null, isSuperAdmin: false }, db: fakeDb } as never,
    fn as () => Promise<never>,
  )
}

beforeEach(() => {
  txLog.length = 0
  inserts.length = 0
  txCounter = 0
  currentTxId = null
  failNextInsert = null
  scenario.user = null
  scenario.membership = null
  scenario.organization = null
  vi.clearAllMocks()
})

/* -------------------------------------------------------------------------- */

describe('the two audit verbs are registered, and nothing else was added', () => {
  it('AUDIT_ACTIONS carries exactly the two refusal verbs, spelled as the policy expects', () => {
    expect(AUDIT_ACTIONS.TENANCY_ORGANIZATION_SELECTION_REFUSED).toBe(SELECTION)
    expect(AUDIT_ACTIONS.TENANCY_MEMBERSHIP_REVALIDATION_REFUSED).toBe(REVALIDATION)
    const refusalVerbs = Object.values(AUDIT_ACTIONS).filter((a) => String(a).endsWith('_refused'))
    expect(refusalVerbs.sort()).toEqual([REVALIDATION, SELECTION].sort())
  })
})

describe('FORM A / FORM B classification is the emitter’s job, not the caller’s', () => {
  it('RA-SUBJECT-1: an explicit attempt with NO value emits FORM A, subject = the caller', async () => {
    await inUnscopedContext(USER_A, () =>
      emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: null }),
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0].values).toMatchObject({
      action: SELECTION,
      reason: REASON_A,
      entityType: 'user',
      entityId: USER_A,
      actorUserId: USER_A,
    })
  })

  it('RA-SUBJECT-2 / RA-SUBJECT-8: a VALID uuid emits FORM B whose entity_id is the EXACT attempted uuid', async () => {
    await inUnscopedContext(USER_A, () =>
      emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: ORG_B }),
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0].values).toMatchObject({
      action: SELECTION,
      reason: REASON_B,
      entityType: 'organization',
      entityId: ORG_B,
      actorUserId: USER_A,
    })
    // RA-SUBJECT-8 is exact-equality, never "some uuid": the attempted value
    // is the only thing that may appear, and RA-SUBJECT-4's sentinel is
    // excluded by the same assertion.
    expect(inserts[0].values.entityId).not.toBe(USER_A)
    expect(inserts[0].values.entityId).not.toBe(ORG_A)
    expect(inserts[0].values.entityId).not.toBe(NIL_UUID)
  })

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['not a uuid', 'not-a-uuid'],
    ['sql-ish bytes', "'; DROP TABLE audit_logs; --"],
    ['uuid-like but short', '1a300000-0000-4000-8000-0000000001a'],
    ['undefined', undefined],
  ])('RA-SUBJECT-3: malformed input (%s) classifies as FORM A and never reaches a uuid column', async (_label, value) => {
    await inUnscopedContext(USER_A, () =>
      emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: value as string | undefined }),
    )
    expect(inserts).toHaveLength(1)
    const row = inserts[0].values
    expect(row.entityType).toBe('user')
    expect(row.entityId).toBe(USER_A)
    expect(row.reason).toBe(REASON_A)
    // AND THE RAW BYTES LEAK NOWHERE — not into entity_id, not into reason,
    // not into a payload. Checked across every field rather than at the one
    // column an author would remember.
    if (typeof value === 'string' && value.trim() !== '') {
      expect(JSON.stringify(row)).not.toContain(value.trim())
    }
  })

  it('RA-SUBJECT-4: no sentinel uuid is ever manufactured for a FORM A row', async () => {
    await inUnscopedContext(USER_A, () =>
      emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: 'garbage' }),
    )
    expect(inserts[0].values.entityId).not.toBe(NIL_UUID)
    expect(inserts[0].values.entityType).not.toBe('organization')
  })

  it('every emitted row carries NO organization, NO project and NO payload', async () => {
    await inUnscopedContext(USER_A, async () => {
      await emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: null })
      await emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: ORG_B })
      await emitMembershipRevalidationRefused({ userId: USER_A, selectedOrganizationId: ORG_B })
    })
    expect(inserts).toHaveLength(3)
    for (const { values } of inserts) {
      expect(values.organizationId).toBeUndefined()
      expect(values.projectId).toBeUndefined()
      expect(values.beforeJson).toBeUndefined()
      expect(values.afterJson).toBeUndefined()
      expect(values.ipAddress).toBeUndefined()
      expect(values.userAgent).toBeUndefined()
    }
  })
})

describe('the revalidation verb admits FORM B only', () => {
  it('emits FORM B with the exact selected organisation uuid', async () => {
    await inUnscopedContext(USER_A, () =>
      emitMembershipRevalidationRefused({ userId: USER_A, selectedOrganizationId: ORG_B }),
    )
    expect(inserts[0].values).toMatchObject({
      action: REVALIDATION,
      reason: REASON_B,
      entityType: 'organization',
      entityId: ORG_B,
    })
  })

  it('RA-ACTION-1 (application half): a FORM A revalidation row is INEXPRESSIBLE, not merely rejected', async () => {
    // There is no parameter that produces one. The nearest a caller can get is
    // a malformed organisation id, and that is refused rather than silently
    // downgraded to FORM A — which is what a generic emitter would have done.
    await expect(
      inUnscopedContext(USER_A, () =>
        emitMembershipRevalidationRefused({ userId: USER_A, selectedOrganizationId: 'not-a-uuid' }),
      ),
    ).rejects.toBeInstanceOf(TenancyRefusalAuditError)
    expect(inserts).toHaveLength(0)
  })
})

describe('the emitter refuses the wrong context instead of writing a row the policy would reject', () => {
  it('throws when no database context is open at all', async () => {
    await expect(
      emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: null }),
    ).rejects.toBeInstanceOf(TenancyRefusalAuditError)
    expect(inserts).toHaveLength(0)
  })

  it('throws when the open context belongs to a different user', async () => {
    await expect(
      inUnscopedContext(USER_B, () =>
        emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: null }),
      ),
    ).rejects.toBeInstanceOf(TenancyRefusalAuditError)
    expect(inserts).toHaveLength(0)
  })

  it('throws when the open context is ORGANISATION-SCOPED — a refusal cannot be recorded from inside a proven membership', async () => {
    await expect(
      runWithBoundDatabaseContext(
        { identity: { userId: USER_A, organizationId: ORG_A, isSuperAdmin: false }, db: fakeDb } as never,
        (() => emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: null })) as () => Promise<never>,
      ),
    ).rejects.toBeInstanceOf(TenancyRefusalAuditError)
    expect(inserts).toHaveLength(0)
  })

  it('is FAIL-CLOSED: a failing insert propagates and is never swallowed', async () => {
    failNextInsert = new Error('insert refused by policy')
    await expect(
      inUnscopedContext(USER_A, () =>
        emitOrganizationSelectionRefused({ userId: USER_A, attemptedOrganizationId: null }),
      ),
    ).rejects.toThrow('insert refused by policy')
  })
})

/* -------------------------------------------------------------------------- */
/* Site discrimination and transaction isolation                              */
/* -------------------------------------------------------------------------- */

import { loadRequestPrincipalResult } from '@/lib/auth/database-context'

const USER_ROW = {
  id: USER_A,
  email: 'ua@pg.local',
  fullName: null,
  avatarUrl: null,
  isSuperAdmin: false,
  deletedAt: null,
}
const MEMBERSHIP_ROW = {
  id: '2a300000-0000-4000-8000-0000000002a3',
  organizationId: ORG_B,
  userId: USER_A,
  role: 'analyst',
  status: 'active',
}

/** The insert log restricted to the two refusal verbs. */
const refusalInserts = () =>
  inserts.filter((i) => i.values.action === SELECTION || i.values.action === REVALIDATION)

describe('the emitter is chosen BY RETURN SITE, never by refusal code', () => {
  beforeEach(() => {
    mockIdentity.mockResolvedValue({ identity: { userId: USER_A }, failure: null })
    scenario.user = USER_ROW
  })

  it('RA-ACTION-2: the routine no-selected-organisation state emits ZERO rows — the common case is not a refusal', async () => {
    mockSelectedOrganizationId.mockResolvedValue(null)

    const before = inserts.length
    const { principal } = await loadRequestPrincipalResult()

    // The site really was reached — otherwise this control would pass
    // vacuously by never exercising it at all.
    expect(principal?.organizationRefusalCode).toBe(REASON_A)
    expect(principal?.membership).toBeNull()
    // ROW COUNT UNCHANGED ACROSS THE RESOLUTION, which is the assertion the
    // authority asks for — not merely "nothing threw".
    expect(inserts.length).toBe(before)
    expect(refusalInserts()).toHaveLength(0)
  })

  it('RA-ACTION-3: the third site — membership PRESENT, organisation row unreadable — emits ZERO rows despite carrying the NOT_A_MEMBER code', async () => {
    mockSelectedOrganizationId.mockResolvedValue(ORG_B)
    scenario.membership = MEMBERSHIP_ROW
    scenario.organization = null // unreadable

    const before = inserts.length
    const { principal } = await loadRequestPrincipalResult()

    // THE TRAP, MADE EXPLICIT: the refusal code here is the SAME string site 2
    // returns, and a naive emitter keyed on it would write a FALSE row saying
    // the membership is absent — while the very same object carries it.
    expect(principal?.organizationRefusalCode).toBe(REASON_B)
    expect(principal?.membership).not.toBeNull()
    expect(principal?.organization).toBeNull()
    expect(inserts.length).toBe(before)
    expect(refusalInserts()).toHaveLength(0)
  })

  it('RA-TXN-1: site 2 DOES emit, and the write lands in a SECOND transaction opened after the principal transaction committed', async () => {
    mockSelectedOrganizationId.mockResolvedValue(ORG_B)
    scenario.membership = null // membership genuinely absent

    const { principal } = await loadRequestPrincipalResult()
    expect(principal?.organizationRefusalCode).toBe(REASON_B)
    expect(principal?.membership).toBeNull()

    // The row was written, in FORM B, naming the exact selected organisation.
    expect(refusalInserts()).toHaveLength(1)
    const row = refusalInserts()[0]
    expect(row.values).toMatchObject({
      action: REVALIDATION,
      reason: REASON_B,
      entityType: 'organization',
      entityId: ORG_B,
      actorUserId: USER_A,
    })

    // ISOLATION, MEASURED. Two transactions were opened, the principal one
    // COMMITTED BEFORE the second began, and the insert carries the SECOND
    // transaction's id. An implementation that wrote inside the principal
    // transaction would stamp the insert with tx1 and log only one BEGIN.
    expect(txLog).toEqual(['BEGIN tx1', 'COMMIT tx1', 'BEGIN tx2', 'COMMIT tx2'])
    expect(row.txId).toBe('tx2')
    expect(row.txId).not.toBe('tx1')
    expect(txLog.indexOf('COMMIT tx1')).toBeLessThan(txLog.indexOf('BEGIN tx2'))
  })

  it('RA-TXN-1 (second half): when the audit write fails, the REQUEST fails — the refusal path never completes without its row', async () => {
    mockSelectedOrganizationId.mockResolvedValue(ORG_B)
    scenario.membership = null
    failNextInsert = new Error('audit insert refused')

    await expect(loadRequestPrincipalResult()).rejects.toThrow('audit insert refused')

    // And the principal transaction had already committed before the failure,
    // so the audit could not have rolled the authorization read back.
    expect(txLog.slice(0, 2)).toEqual(['BEGIN tx1', 'COMMIT tx1'])
  })
})
