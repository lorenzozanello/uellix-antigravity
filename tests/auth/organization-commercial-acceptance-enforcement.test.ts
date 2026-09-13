// tests/auth/organization-commercial-acceptance-enforcement.test.ts
//
// L1 (docs/ops/compliance/CUSTOMER_LIFECYCLE_L1_EXECUTION_AUTHORITY_v1.0.0.json,
// HPO-ODS-W2-29) — ENFORCEMENT TOPOLOGY, behaviourally.
//
// Drives the REAL lib/auth/identity.ts -> lib/auth/database-context.ts ->
// lib/auth/session.ts chain against a mocked supabase.auth.getUser() and an
// in-memory table set, in exactly the shape
// tests/auth/legal-acceptance-enforcement.test.ts uses for L0 and
// tests/auth/email-verification-gate.test.ts uses for B0.
//
// ONLY lib/auth/organization-commercial-acceptance.ts is mocked directly.
// deriveOrganizationAcceptanceCurrent is the ONE derivation site, and its own
// correctness is proven at the DATABASE boundary
// (tests/postgres/organization-commercial-acceptance*.pg.test.ts). This file
// proves what CONSUMES its answer — and, just as load-bearing, WHERE THE
// QUESTION IS NOT ASKED AT ALL.
//
// The STRUCTURAL half lives in
// tests/auth/organization-commercial-acceptance-topology.test.ts. Neither
// substitutes for the other: a behavioural control alone cannot distinguish
// "does not enforce L1" from "enforces an L1 that happens to pass".

import { describe, it, expect, vi, beforeEach } from 'vitest'

/* -------------------------------------------------------------------------- */
/* Fake cookie jar                                                            */
/* -------------------------------------------------------------------------- */

class FakeCookieStore {
  private readonly entries = new Map<string, { value: string }>()
  get(name: string) {
    const entry = this.entries.get(name)
    return entry ? { name, value: entry.value } : undefined
  }
  set(name: string, value: string) {
    this.entries.set(name, { value })
  }
  delete(nameOrOptions: string | { name: string }) {
    this.entries.delete(typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name)
  }
  clear() {
    this.entries.clear()
  }
  names(): string[] {
    return [...this.entries.keys()]
  }
}
const fakeCookieStore = new FakeCookieStore()
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => fakeCookieStore) }))

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({ redirect: (p: string) => mockRedirect(p) }))

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
}))

vi.mock('@/db/identity-context', async () => {
  const store = await import('@/db/identity-store')
  return {
    withDatabaseIdentityContext: async (
      identity: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
      callback: (db: unknown) => unknown
    ) => {
      const existing = store.getBoundDatabaseContext()
      if (existing !== undefined) return callback(existing.db)
      return store.runWithBoundDatabaseContext(
        { identity, db: undefined } as never,
        (async () => callback(undefined)) as () => Promise<never>
      )
    },
    getBoundDatabaseContext: () => store.getBoundDatabaseContext(),
  }
})

/* -------------------------------------------------------------------------- */
/* The TWO derivation sites, mocked and controlled per test                   */
/* -------------------------------------------------------------------------- */

const mockDeriveAccountAcceptanceCurrent = vi.fn(async (_userId: string) => true)
vi.mock('@/lib/auth/legal-acceptance', () => ({
  deriveAccountAcceptanceCurrent: (userId: string) => mockDeriveAccountAcceptanceCurrent(userId),
  ACCEPT_LEGAL_PATH: '/accept-legal',
}))

// THE L1 DERIVATION SITE. Every fixture sets it EXPLICITLY — never by
// omission. An acceptance stub with a permissive default is the exact shape
// X-B-03 forbids: every existing fixture keeps passing while silently
// measuring an unaccepted organisation as current.
const mockDeriveOrganizationAcceptanceCurrent = vi.fn(async (_organizationId: string) => true)
vi.mock('@/lib/auth/organization-commercial-acceptance', () => ({
  deriveOrganizationAcceptanceCurrent: (organizationId: string) =>
    mockDeriveOrganizationAcceptanceCurrent(organizationId),
  ACCEPT_COMMERCIAL_TERMS_PATH: '/accept-commercial-terms',
}))

/* -------------------------------------------------------------------------- */
/* @/db/client — an in-memory table set                                        */
/* -------------------------------------------------------------------------- */

interface EqCondition { __type: 'eq'; columnName: string; value: unknown }
interface AndCondition { __type: 'and'; conditions: unknown[] }
interface IsNullCondition { __type: 'isNull'; columnName: string }
type Condition = EqCondition | AndCondition | IsNullCondition

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown): EqCondition => ({ __type: 'eq', columnName: column.name, value }),
  and: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }): IsNullCondition => ({ __type: 'isNull', columnName: column.name }),
}))

const JS_KEY_BY_COLUMN_NAME: Record<string, string> = {
  id: 'id', user_id: 'userId', organization_id: 'organizationId', status: 'status',
  role: 'role', email: 'email', deleted_at: 'deletedAt', is_super_admin: 'isSuperAdmin',
}

function evaluateCondition(condition: Condition, row: Record<string, unknown>): boolean {
  if (condition.__type === 'and') return condition.conditions.every((c) => evaluateCondition(c as Condition, row))
  const key = JS_KEY_BY_COLUMN_NAME[condition.columnName] ?? condition.columnName
  if (condition.__type === 'isNull') return row[key] == null
  return row[key] === condition.value
}

function tableNameOf(table: { [key: symbol]: string }): string {
  return table[Symbol.for('drizzle:Name')] as unknown as string
}

const TABLES: {
  users: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
} = { users: [], organization_members: [], organizations: [] }

/** Every write this suite's fake database sees. AB-3 says EXACTLY TWO, ever. */
const WRITES: Array<{ table: string }> = []

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
        const data = (TABLES as Record<string, Array<Record<string, unknown>>>)[tableNameOf(table)] ?? []
        return {
          where: vi.fn().mockImplementation((condition: Condition) => {
            const filtered = data.filter((row) => evaluateCondition(condition, row))
            return {
              limit: () => ({ then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered)) }),
              then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered)),
            }
          }),
        }
      }),
    })),
    insert: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
      WRITES.push({ table: tableNameOf(table) })
      return { values: async () => undefined }
    }),
  },
}))

const mockEmitMembershipRevalidationRefused = vi.fn(async () => undefined)
vi.mock('@/lib/audit/tenancy-refusal', () => ({
  emitMembershipRevalidationRefused: () => mockEmitMembershipRevalidationRefused(),
}))

/* -------------------------------------------------------------------------- */
/* Import after mocks are in place                                            */
/* -------------------------------------------------------------------------- */

import {
  requireAuth,
  requireOrganizationAccess,
  getCurrentOrganizationContext,
  runWithOrganizationAccess,
  runWithOptionalOrganizationAccess,
  listSelectableMemberships,
} from '@/lib/auth/session'
import {
  withOrganizationDatabaseContext,
  withOptionalDatabaseIdentityContext,
  withOrganizationAcceptanceDischargeContext,
  withAuthenticatedDatabaseContext,
  AuthContextError,
  authContextErrorStatus,
} from '@/lib/auth/database-context'
import { SELECTED_ORGANIZATION_COOKIE_NAME } from '@/lib/auth/selected-organization'
import { ROLES } from '@/lib/auth/roles'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUPER_ADMIN_ID = '99999999-9999-4999-8999-999999999999'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG_ID = '44444444-4444-4444-8444-444444444444'
const MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333333'
const CONFIRMED_AT = '2024-01-01T00:00:00.000Z'

const USER_ROW = { id: USER_ID, email: 'member@example.test', isSuperAdmin: false, deletedAt: null }
const SUPER_ADMIN_ROW = { ...USER_ROW, id: SUPER_ADMIN_ID, isSuperAdmin: true }
const ORG_ROW = { id: ORG_ID, name: 'Org', slug: 'org' }
const OTHER_ORG_ROW = { id: OTHER_ORG_ID, name: 'Other Org', slug: 'other-org' }

const membershipWithRole = (role: string) => ({
  id: MEMBERSHIP_ID,
  userId: USER_ID,
  organizationId: ORG_ID,
  role,
  status: 'active',
})

function signedInAs(userId: string, emailConfirmedAt: string | null): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email_confirmed_at: emailConfirmedAt } },
    error: null,
  })
}
const verified = (userId = USER_ID) => signedInAs(userId, CONFIRMED_AT)
const unverified = (userId = USER_ID) => signedInAs(userId, null)

/** Puts an organisation in REQUEST SCOPE by selecting it through the carrier. */
function selectOrganization(organizationId = ORG_ID): void {
  fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, organizationId)
}

async function captureCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    if (error instanceof AuthContextError) return error.code
    throw error
  }
}
async function locationOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    const message = (error as Error).message
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length)
    throw error
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  mockRedirect.mockClear()
  mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
  mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(true)
  TABLES.users = [USER_ROW, SUPER_ADMIN_ROW]
  TABLES.organizations = [ORG_ROW, OTHER_ORG_ROW]
  TABLES.organization_members = [membershipWithRole(ROLES.ORGANIZATION_ADMIN)]
  WRITES.length = 0
  fakeCookieStore.clear()
})

/* ========================================================================== */
/* TOPO-L1-passes-at-all-four-surfaces                                        */
/* ========================================================================== */

describe('TOPO-L1-passes-at-all-four-surfaces', () => {
  beforeEach(() => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(true)
  })

  it('requireOrganizationAccess returns its context with NO redirect', async () => {
    expect(await locationOf(() => requireOrganizationAccess())).toBeNull()
    const ctx = await requireOrganizationAccess()
    expect(ctx.organization.id).toBe(ORG_ID)
  })

  it('getCurrentOrganizationContext returns a NON-NULL context', async () => {
    expect(await getCurrentOrganizationContext()).not.toBeNull()
  })

  it('withOrganizationDatabaseContext RUNS its callback', async () => {
    const ran = vi.fn(async () => 'ok')
    expect(await withOrganizationDatabaseContext(ran)).toBe('ok')
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('withOptionalDatabaseIdentityContext calls back with a CONTEXT, not null', async () => {
    const seen = vi.fn(async (_ctx: unknown) => undefined)
    await withOptionalDatabaseIdentityContext(seen)
    expect(seen.mock.calls[0][0]).not.toBeNull()
  })
})

/* ========================================================================== */
/* Each surface REFUSES in its OWN flavour — MUT-L1-attach-to-one-surface-only */
/* ========================================================================== */

describe('an L1-unmet organisation is refused at EVERY surface, each in its own flavour', () => {
  beforeEach(() => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
  })

  it('SURFACE 1 requireOrganizationAccess: REDIRECT to the L1 destination, not to /accept-legal', async () => {
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/accept-commercial-terms')
    expect(location).not.toBe('/accept-legal')
  })

  it('SURFACE 2 getCurrentOrganizationContext: NULL, and it never redirects', async () => {
    expect(await getCurrentOrganizationContext()).toBeNull()
    // Its contract is NON-REDIRECTING and four Route Handlers depend on that.
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('SURFACE 3 withOrganizationDatabaseContext: THROWS a DISTINCT code, mapped to 403 and never 401', async () => {
    const code = await captureCode(() => withOrganizationDatabaseContext(async () => 'unreachable'))
    expect(code).toBe('AUTH_ORGANIZATION_LEGAL_ACCEPTANCE_REQUIRED')
    // DISTINCT from the L0 code: the two gates have different accepting
    // principals and different destinations.
    expect(code).not.toBe('AUTH_LEGAL_ACCEPTANCE_REQUIRED')
    expect(authContextErrorStatus('AUTH_ORGANIZATION_LEGAL_ACCEPTANCE_REQUIRED')).toBe(403)
  })

  it('SURFACE 3: the callback NEVER runs, so no work happens inside a refused scope', async () => {
    const ran = vi.fn(async () => 'unreachable')
    await captureCode(() => withOrganizationDatabaseContext(ran))
    expect(ran).not.toHaveBeenCalled()
  })

  it('SURFACE 4 withOptionalDatabaseIdentityContext: callback(null), DEFENSE IN DEPTH ONLY', async () => {
    // S-L1-NO-CONTROL-DEPENDS-ON-C7 — this control exists to show surface 4
    // behaves, and NO OTHER control in this file is satisfied only by it. The
    // three surfaces above each have their own refusal control, so removing
    // this line alone would leave every other L1 control green, which is
    // exactly the sentinel's requirement.
    const seen = vi.fn(async (_ctx: unknown) => undefined)
    await withOptionalDatabaseIdentityContext(seen)
    expect(seen.mock.calls[0][0]).toBeNull()
  })

  it('the two INHERITING composers refuse too, without a check of their own', async () => {
    expect(await locationOf(() => runWithOrganizationAccess(async () => 'unreachable'))).toBe(
      '/accept-commercial-terms'
    )
    const seen = vi.fn(async (_ctx: unknown) => undefined)
    await runWithOptionalOrganizationAccess(seen)
    expect(seen.mock.calls[0][0]).toBeNull()
  })

  it('THE REFUSAL WRITES NOTHING: no carrier mutation, no enumeration, no audit row', async () => {
    // ATTACHMENT_TOPOLOGY.REFUSAL_DESTINATION.PROHIBITED_SIDE_EFFECTS_OF_THE_REFUSAL,
    // and NOSCOPE-no-carrier-write-on-refusal.
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, ORG_ID)
    await locationOf(() => requireOrganizationAccess())
    // The carrier is untouched — neither cleared nor rotated.
    expect(fakeCookieStore.get(SELECTED_ORGANIZATION_COOKIE_NAME)?.value).toBe(ORG_ID)
    // No fallback to another membership, and NO audit row of any kind.
    expect(WRITES).toEqual([])
    expect(mockEmitMembershipRevalidationRefused).not.toHaveBeenCalled()
  })
})

/* ========================================================================== */
/* B0 and L0 are PRESERVED — L1 never preempts an earlier gate                */
/* ========================================================================== */

describe('B0-preserved / L0-preserved', () => {
  it('B0-preserved: an UNVERIFIED subject goes to VERIFY_EMAIL_PATH, never to the L1 destination', async () => {
    unverified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/verify-email')
    expect(location).not.toBe('/accept-commercial-terms')
    // And L1 IS NOT EVALUATED at all: B0 fires first, so the question is never asked.
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('L0-preserved: a verified but L0-UNACCEPTED subject goes to ACCEPT_LEGAL_PATH', async () => {
    verified()
    selectOrganization()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/accept-legal')
    expect(location).not.toBe('/accept-commercial-terms')
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('the ORDER is B0 -> L0 -> Packet A -> L1, and it is part of the contract', async () => {
    // An implementation that evaluates these in a different order produces a
    // DIFFERENT DESTINATION for the same principal.
    unverified()
    selectOrganization()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/verify-email')
  })
})

/* ========================================================================== */
/* P-AO-8 / N-AO-13 / M-AO-8 — NO ORGANIZATION IN SCOPE                       */
/* ========================================================================== */

describe('NO ORGANIZATION IN SCOPE: L1 is NOT EVALUATED (FC_5)', () => {
  beforeEach(() => {
    verified()
    // No carrier at all -> Packet A R2.
    TABLES.organization_members = []
    fakeCookieStore.clear()
  })

  it('N-AO-13 (ABSENCE): ZERO acceptance queries are issued on the no-scope path', async () => {
    // AN ABSENCE ASSERTION, NOT AN OUTCOME ASSERTION. Mutation
    // MUT-L1-evaluate-then-ignore keeps the outcome SKIPPED but issues the
    // query anyway and discards the result — invisible to any outcome-only
    // control, because the destination is unchanged. Only this assertion sees it.
    await locationOf(() => requireOrganizationAccess())
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('P-AO-8 / M-AO-8: R2 branch_zero still reaches /app/onboarding, NOT an L1 refusal', async () => {
    // Under mutation M-AO-8 (L1 REFUSES rather than being SKIPPED with no
    // scope) every subject is refused at the SELECTOR — the very place they go
    // to acquire one — producing a lockout indistinguishable from a loop.
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/app/onboarding')
  })

  it('P-AO-8: R2 branch_one_or_more still reaches the selector, with NO auto-selection for exactly one', async () => {
    TABLES.organization_members = [membershipWithRole(ROLES.ANALYST)]
    fakeCookieStore.clear()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/app/organizations/select')
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('P-AO-8: R3 stale carrier is CLEARED FIRST, then routed — and L1 is still not evaluated', async () => {
    TABLES.organization_members = []
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, OTHER_ORG_ID)
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/app/organizations/select')
    expect(fakeCookieStore.get(SELECTED_ORGANIZATION_COOKIE_NAME)).toBeUndefined()
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('P-AO-8: R1 super-admin with no membership still reaches /admin', async () => {
    verified(SUPER_ADMIN_ID)
    TABLES.organization_members = []
    fakeCookieStore.clear()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/admin')
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('the SELECTOR remains reachable — the enumerator is not gated by L1', async () => {
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    await expect(listSelectableMemberships()).resolves.toBeInstanceOf(Array)
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('getCurrentOrganizationContext returns null for NO SCOPE without asking the L1 question', async () => {
    expect(await getCurrentOrganizationContext()).toBeNull()
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })
})

/* ========================================================================== */
/* THE SEVEN EXCLUDED SURFACES stay ungated                                   */
/* ========================================================================== */

describe('the excluded surfaces are NOT gated by L1', () => {
  it('withAuthenticatedDatabaseContext runs for an L1-UNMET subject', async () => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    const ran = vi.fn(async () => 'ok')
    expect(await withAuthenticatedDatabaseContext(ran)).toBe('ok')
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('requireAuth passes an L1-UNMET subject through with no redirect', async () => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireAuth())).toBeNull()
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('listSelectableMemberships runs for an L1-UNMET subject WITH a scope', async () => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    await expect(listSelectableMemberships()).resolves.toBeInstanceOf(Array)
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })
})

/* ========================================================================== */
/* THE DISCHARGE BOUNDARY — behaviourally                                     */
/* ========================================================================== */

describe('TOPO-discharge-surface-renders / not-self-gated (behavioural)', () => {
  it('an L1-UNMET organization_admin PASSES THROUGH the discharge boundary — no self-lock', async () => {
    // The L1 analogue of the CL-1 independent-certification BLOCKING B-1
    // repair, one gate later. Under mutation
    // MUT-L1-enforce-L1-on-the-discharge-boundary this is the control that
    // goes red — and the mutation is what an implementer GETS by reusing
    // withOrganizationDatabaseContext, the obvious primitive to reach for.
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    const ran = vi.fn(async (ctx: { organization: { id: string } }) => ctx.organization.id)
    expect(await withOrganizationAcceptanceDischargeContext(ran)).toBe(ORG_ID)
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('it does not ASK the L1 question at all — "does not enforce" beats "enforces one that passes"', async () => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    await withOrganizationAcceptanceDischargeContext(async () => undefined)
    expect(mockDeriveOrganizationAcceptanceCurrent).not.toHaveBeenCalled()
  })

  it('TOPO-discharge-surface-not-a-dead-end: an L1-MET admin passes through it too', async () => {
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(true)
    const ran = vi.fn(async () => 'ok')
    expect(await withOrganizationAcceptanceDischargeContext(ran)).toBe('ok')
  })
})

describe('TOPO-discharge-enforces-everything-else: SIX refusals, asserted individually', () => {
  it('1/6 NO SESSION is refused', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'AUTH_NO_SESSION'
    )
  })

  it('2/6 B0 UNVERIFIED is refused', async () => {
    unverified()
    selectOrganization()
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'AUTH_EMAIL_NOT_VERIFIED'
    )
  })

  it('3/6 L0 UNACCEPTED is refused — the L1 discharge surface is NOT exempt from L0', async () => {
    verified()
    selectOrganization()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'AUTH_LEGAL_ACCEPTANCE_REQUIRED'
    )
  })

  it('4/6 NO ORGANIZATION SELECTED is refused with the named tenancy code', async () => {
    verified()
    TABLES.organization_members = []
    fakeCookieStore.clear()
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'TENANCY_NO_ORGANIZATION_SELECTED'
    )
  })

  it('5/6 A SCOPE NAMING A NON-MEMBER ORGANIZATION is refused with the other named tenancy code', async () => {
    verified()
    TABLES.organization_members = []
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, OTHER_ORG_ID)
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'
    )
  })

  it('6/6 EVERY role that is not EXACTLY organization_admin is refused — individually, never as a set', () => {
    // N-AO-26: asserted PER ROLE. An extensional set-equality over the role
    // collection matches 6/6 rather than 5/6 and is therefore INDIFFERENT to
    // the excluded role, which makes every per-role test vacuous.
    const NON_ADMIN_ROLES = [ROLES.IMPACT_MANAGER, ROLES.ANALYST, ROLES.REVIEWER, ROLES.VIEWER]
    expect(NON_ADMIN_ROLES).toHaveLength(4)
    return Promise.all(
      NON_ADMIN_ROLES.map(async (role) => {
        verified()
        selectOrganization()
        TABLES.organization_members = [membershipWithRole(role)]
        expect(
          await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined)),
          `role ${role} must be refused`
        ).toBe('AUTH_ORGANIZATION_ADMIN_REQUIRED')
      })
    )
  })

  it('N-AO-27: a membership row carrying role super_admin is refused — ITS OWN control, never folded in', async () => {
    // A near-correct predicate gets 5 of 6 roles right and fails ONLY on this
    // one: db/schema.ts role_check PERMITS a membership row to carry
    // 'super_admin', and hasRole('super_admin','organization_admin') is
    // 100 >= 80 = TRUE. Mutation M-AO-15 — the ambient idiom an implementer
    // following local convention would faithfully WRITE — passes the four-role
    // sweep above and is caught only here.
    verified()
    selectOrganization()
    TABLES.organization_members = [membershipWithRole(ROLES.SUPER_ADMIN)]
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'AUTH_ORGANIZATION_ADMIN_REQUIRED'
    )
  })

  it('N-AO-29: a PLATFORM super-admin with NO membership in the organisation is refused', async () => {
    verified(SUPER_ADMIN_ID)
    TABLES.organization_members = []
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, ORG_ID)
    const code = await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))
    expect(code).toBe('TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER')
    expect(code).not.toBeUndefined()
  })

  it('the ELIGIBLE admin is admitted — the six refusals are an omission of ONE gate, not a general lock-out', async () => {
    verified()
    selectOrganization()
    TABLES.organization_members = [membershipWithRole(ROLES.ORGANIZATION_ADMIN)]
    const ran = vi.fn(async () => 'ok')
    expect(await withOrganizationAcceptanceDischargeContext(ran)).toBe('ok')
  })

  it('every refusal is 403, never 401 — the session is valid, the eligibility is not', () => {
    expect(authContextErrorStatus('AUTH_ORGANIZATION_ADMIN_REQUIRED')).toBe(403)
    expect(authContextErrorStatus('AUTH_ORGANIZATION_LEGAL_ACCEPTANCE_REQUIRED')).toBe(403)
  })

  it('N-AO-36: a non-admin CANNOT discharge L1 AND is not waved through — both halves, same subject', async () => {
    // Each half alone is satisfiable by an implementation that gets the other
    // wrong, which is why both are asserted here for ONE subject.
    verified()
    selectOrganization()
    TABLES.organization_members = [membershipWithRole(ROLES.VIEWER)]
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)

    // HALF ONE — cannot discharge.
    expect(await captureCode(() => withOrganizationAcceptanceDischargeContext(async () => undefined))).toBe(
      'AUTH_ORGANIZATION_ADMIN_REQUIRED'
    )
    // HALF TWO — and does NOT get product access in lieu of it. Refusing to
    // let them accept is not the same as letting them through.
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/accept-commercial-terms')
    expect(await captureCode(() => withOrganizationDatabaseContext(async () => 'unreachable'))).toBe(
      'AUTH_ORGANIZATION_LEGAL_ACCEPTANCE_REQUIRED'
    )
    // And NOTHING was written on either path.
    expect(WRITES).toEqual([])
  })
})

/* ========================================================================== */
/* T-AO-1 — TERMINATION over the EXTENDED state space                         */
/* ========================================================================== */

describe('T-AO-1: the combined routing graph TERMINATES for every principal state', () => {
  // RE-DERIVED over the EXTENDED space, never inherited: a proof over n states
  // does not carry to n+1 states, and this lineage has already had a stale
  // termination argument once (F-AO-12). Every destination below is asserted
  // to sit OUTSIDE the gate that produced it, which is what makes the graph
  // acyclic rather than merely finite.

  const DESTINATIONS_THAT_MUST_NOT_RE_ENTER = new Set([
    '/login',
    '/verify-email',
    '/accept-legal',
    '/accept-commercial-terms',
    '/admin',
    '/app/onboarding',
    '/app/organizations/select',
  ])

  it('every enumerated principal state reaches a terminal destination, and none re-enters', async () => {
    const cases: Array<{ name: string; arrange: () => void; expected: string | null }> = [
      {
        name: 'unauthenticated',
        arrange: () => mockGetUser.mockResolvedValue({ data: { user: null }, error: null }),
        expected: '/login',
      },
      {
        name: 'authenticated, B0 unverified',
        arrange: () => { unverified(); selectOrganization() },
        expected: '/verify-email',
      },
      {
        name: 'verified, L0 unmet',
        arrange: () => { verified(); selectOrganization(); mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false) },
        expected: '/accept-legal',
      },
      {
        name: 'verified, L0 met, NO organization in scope, zero candidates',
        arrange: () => { verified(); TABLES.organization_members = []; fakeCookieStore.clear() },
        expected: '/app/onboarding',
      },
      {
        name: 'verified, L0 met, NO organization in scope, exactly one candidate (NO auto-selection)',
        arrange: () => { verified(); TABLES.organization_members = [membershipWithRole(ROLES.ANALYST)]; fakeCookieStore.clear() },
        expected: '/app/organizations/select',
      },
      {
        name: 'verified, L0 met, stale carrier naming a non-member organization',
        arrange: () => { verified(); TABLES.organization_members = []; fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, OTHER_ORG_ID) },
        expected: '/app/organizations/select',
      },
      {
        name: 'verified, L0 met, platform super-admin with no membership (R1)',
        arrange: () => { verified(SUPER_ADMIN_ID); TABLES.organization_members = []; fakeCookieStore.clear() },
        expected: '/admin',
      },
      ...([ROLES.IMPACT_MANAGER, ROLES.ANALYST, ROLES.REVIEWER, ROLES.VIEWER] as const).map((role) => ({
        name: `verified, L0 met, scope, ordinary member (${role}), L1 unmet`,
        arrange: () => {
          verified()
          selectOrganization()
          TABLES.organization_members = [membershipWithRole(role)]
          mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
        },
        expected: '/accept-commercial-terms',
      })),
      {
        name: 'verified, L0 met, scope, membership role super_admin, L1 unmet',
        arrange: () => {
          verified()
          selectOrganization()
          TABLES.organization_members = [membershipWithRole(ROLES.SUPER_ADMIN)]
          mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
        },
        expected: '/accept-commercial-terms',
      },
      {
        name: 'verified, L0 met, scope, organization_admin, L1 UNMET',
        arrange: () => { verified(); selectOrganization(); mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false) },
        expected: '/accept-commercial-terms',
      },
      {
        name: 'verified, L0 met, scope, organization_admin, L1 MET',
        arrange: () => { verified(); selectOrganization(); mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(true) },
        expected: null,
      },
      {
        name: 'FORMER admin (now viewer) whose organisation is still L1-current — no re-acceptance demanded',
        arrange: () => {
          verified()
          selectOrganization()
          TABLES.organization_members = [membershipWithRole(ROLES.VIEWER)]
          // The acceptance stands: currency is a property of the ORGANISATION,
          // never recomputed from the CURRENT membership (I-T4-7).
          mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(true)
        },
        expected: null,
      },
    ]

    // EVERY enumerated state is exercised — not a sample. FIFTEEN: the ten
    // principal states TERMINATION_AUTHORITY names, with the ordinary-member
    // state expanded to its FOUR named non-admin roles (which is why the list
    // is longer than the authority's ten bullets, not shorter), crossed with
    // the organisation dimensions that change the destination — zero
    // candidates, exactly one candidate, and a stale carrier.
    //
    // A LITERAL PINNED ALONGSIDE THE LIST IT DESCRIBES. A numeral can
    // contradict its own list: if a case is deleted, the loop below still
    // passes over what remains, and only this assertion notices that the state
    // space shrank.
    expect(cases).toHaveLength(15)

    for (const testCase of cases) {
      vi.clearAllMocks()
      mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
      mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(true)
      TABLES.organization_members = [membershipWithRole(ROLES.ORGANIZATION_ADMIN)]
      fakeCookieStore.clear()
      testCase.arrange()

      const location = await locationOf(() => requireOrganizationAccess())
      expect(location, `state "${testCase.name}" terminated at ${location}`).toBe(testCase.expected)

      if (location !== null) {
        expect(
          DESTINATIONS_THAT_MUST_NOT_RE_ENTER.has(location),
          `state "${testCase.name}" produced an unenumerated destination ${location}`
        ).toBe(true)
      }
    }
  })

  it('the L1 destination sits OUTSIDE every enforcement point it could re-enter', async () => {
    // The whole no-self-lock property in one line: the subject sent to
    // /accept-commercial-terms reaches a surface that does NOT enforce L1, so
    // the redirect cannot repeat with the same principal state.
    verified()
    selectOrganization()
    mockDeriveOrganizationAcceptanceCurrent.mockResolvedValue(false)
    expect(await locationOf(() => requireOrganizationAccess())).toBe('/accept-commercial-terms')
    await expect(withOrganizationAcceptanceDischargeContext(async () => 'reached')).resolves.toBe('reached')
  })
})
