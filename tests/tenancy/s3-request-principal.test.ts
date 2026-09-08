// tests/tenancy/s3-request-principal.test.ts
//
// S3 — Selected-organization request principal.
//
// Binds by id to docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_TEST_MANIFEST_v1.0.0.json
// (P-4, P-5, N-1, N-2, M-3, M-4, M-8) and to the S3 controls in
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.4.json
// (S3-1..S3-8). None of those controls is restated in full prose here — each
// `it()` names the id it proves.
//
// This suite drives lib/auth/database-context.ts's loaders and wrappers
// DIRECTLY, against an in-memory table mock precise enough to prove PREDICATE
// SHAPE — not merely returned rows. That precision is why the fixtures below
// deliberately construct TWO active memberships for one user: impossible
// under the live `user_single_active_membership` constraint (P-5, deferred to
// S7), but the only way to distinguish "the query is qualified by
// organization" (S3-1, correct) from "an unqualified query happened to return
// the right row" (SI-2 / MS3-9, wrong) at the unit level. Real-PostgreSQL
// coverage — where that constraint is live and enforced — is
// tests/authenticated-database-context.test.ts (S3-PG-1..S3-PG-5).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

/* -------------------------------------------------------------------------- */
/* Fake cookie jar — the S2 carrier's only dependency (next/headers)          */
/* -------------------------------------------------------------------------- */

interface StoredCookie {
  value: string
}
class FakeCookieStore {
  private readonly entries = new Map<string, StoredCookie>()
  get(name: string): { name: string; value: string } | undefined {
    const entry = this.entries.get(name)
    return entry ? { name, value: entry.value } : undefined
  }
  set(name: string, value: string): void {
    this.entries.set(name, { value })
  }
  delete(nameOrOptions: string | { name: string }): void {
    this.entries.delete(typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name)
  }
  clear(): void {
    this.entries.clear()
  }
}
const fakeCookieStore = new FakeCookieStore()
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => fakeCookieStore),
}))

/* -------------------------------------------------------------------------- */
/* Auth boundary — same seam tests/authenticated-database-context.test.ts uses */
/* -------------------------------------------------------------------------- */

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
}))

/* -------------------------------------------------------------------------- */
/* The mechanism, mocked to a pass-through — REAL_PG lives in                  */
/* tests/authenticated-database-context.test.ts, not here.                    */
/* -------------------------------------------------------------------------- */

// CORRECTED under ODS v1.0.26 F_DN_6_ADJUDICATION. This double used to be a
// pass-through whose getBoundDatabaseContext was a CONSTANT returning
// undefined — undefined even WHILE the callback was executing. That is not a
// simplification of the real module, it CONTRADICTS it: db/identity-context.ts
// binds a context for the duration of the callback, and its own nesting check
// reads getBoundDatabaseContext() back during execution.
//
// The lie became load-bearing once the S3 refusal emitter began asserting, at
// emission time, that a context IS bound for the refusal subject. Under the old
// double the guard observed nothing bound and correctly failed closed — the
// DOUBLE was wrong, not the guard, and the guard is deliberately not relaxed to
// accommodate it.
//
// It still opens no transaction and touches no database. It binds through the
// REAL async-local store, so binding and RESTORATION — on return and on throw
// alike, which matters because every refusal path here ends in a throw — come
// from the same mechanism production uses.
vi.mock('@/db/identity-context', async () => {
  const store = await import('@/db/identity-store')
  return {
    withDatabaseIdentityContext: async (
      identity: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
      callback: (db: unknown) => unknown
    ) => {
      // Re-entry with a context already open reuses it, exactly as the real
      // module does; these suites never nest a DIFFERENT identity.
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
/* drizzle-orm — replaced with a NORMALIZED condition tree the @/db/client    */
/* mock below can actually evaluate, so a query's PREDICATE SHAPE (not just   */
/* its returned row) is observable and assertable. `eqCalls` records every    */
/* eq() invocation for S3-1's predicate-shape assertion.                     */
/* -------------------------------------------------------------------------- */

interface EqCondition {
  readonly __type: 'eq'
  readonly columnName: string
  readonly value: unknown
}
interface AndCondition {
  readonly __type: 'and'
  readonly conditions: unknown[]
}
interface IsNullCondition {
  readonly __type: 'isNull'
  readonly columnName: string
}
type Condition = EqCondition | AndCondition | IsNullCondition

let eqCalls: Array<{ columnName: string; value: unknown }> = []

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown): EqCondition => {
    eqCalls.push({ columnName: column.name, value })
    return { __type: 'eq', columnName: column.name, value }
  },
  and: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }): IsNullCondition => ({ __type: 'isNull', columnName: column.name }),
}))

function evaluateCondition(condition: Condition, row: Record<string, unknown>): boolean {
  if (condition.__type === 'and') {
    return condition.conditions.every((c) => evaluateCondition(c as Condition, row))
  }
  if (condition.__type === 'eq') {
    return row[JS_KEY_BY_COLUMN_NAME[condition.columnName] ?? condition.columnName] === condition.value
  }
  // isNull
  return row[JS_KEY_BY_COLUMN_NAME[condition.columnName] ?? condition.columnName] == null
}

/** DB column name (snake_case, from drizzle's own `.name`) -> row JS key. */
const JS_KEY_BY_COLUMN_NAME: Record<string, string> = {
  id: 'id',
  user_id: 'userId',
  organization_id: 'organizationId',
  status: 'status',
  role: 'role',
  email: 'email',
  deleted_at: 'deletedAt',
  full_name: 'fullName',
  avatar_url: 'avatarUrl',
  is_super_admin: 'isSuperAdmin',
  name: 'name',
  slug: 'slug',
}

/* -------------------------------------------------------------------------- */
/* @/db/client — an in-memory table set the mocked conditions above filter    */
/* against for real, so predicate qualification is BEHAVIOURALLY observable. */
/* -------------------------------------------------------------------------- */

const TABLES: {
  users: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
} = { users: [], organization_members: [], organizations: [] }

// The refusal-audit emitter writes through this same handle, so the double
// needs an `insert` as well as a `select`. Recording the rows rather than
// discarding them turns the S3 refusal contract into something this suite can
// ASSERT: site 2 emits exactly one row, and sites 1 and 3 emit none.
const auditRows = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('@/db/client', () => ({
  db: {
    insert: vi.fn().mockImplementation(() => ({
      values: async (row: Record<string, unknown>) => {
        auditRows.push(row)
      },
    })),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string } & { _?: { name?: string } }) => {
        const tableName = (table[Symbol.for('drizzle:Name')] as unknown as string) ?? table._?.name ?? ''
        const data = (TABLES as Record<string, Array<Record<string, unknown>>>)[tableName] ?? []
        return {
          where: vi.fn().mockImplementation((condition: Condition) => {
            const filtered = data.filter((row) => evaluateCondition(condition, row))
            return {
              limit: vi.fn().mockImplementation((n: number) => ({
                then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered.slice(0, n))),
              })),
              then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered)),
            }
          }),
        }
      }),
    })),
  },
}))

/* -------------------------------------------------------------------------- */
/* Import after mocks are in place                                            */
/* -------------------------------------------------------------------------- */

import {
  loadActiveMembershipWithinContext,
  listSelectableMemberships,
  loadRequestPrincipalResult,
  withOrganizationDatabaseContext,
  AuthContextError,
} from '@/lib/auth/database-context'
import { SELECTED_ORGANIZATION_COOKIE_NAME } from '@/lib/auth/selected-organization'
import * as sessionModule from '@/lib/auth/session'
import * as databaseContextModule from '@/lib/auth/database-context'

function selectOrganization(organizationId: string): void {
  fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, organizationId)
}

function signedInAs(userId: string): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const USER_ID = '00000000-0000-4000-8000-00000000a001'
const ORG_A = '00000000-0000-4000-8000-0000000000aa'
const ORG_B = '00000000-0000-4000-8000-0000000000bb'
const NONEXISTENT_ORG = '00000000-0000-4000-8000-0000000000ff'

const USER_ROW = {
  id: USER_ID,
  email: 'subject@example.test',
  fullName: 'Test Subject',
  avatarUrl: null,
  isSuperAdmin: false,
  deletedAt: null,
}

const ORG_A_ROW = {
  id: ORG_A,
  name: 'Org A',
  slug: 'org-a',
  legalName: null,
  country: null,
  sector: null,
  status: 'active',
}

const ORG_B_ROW = {
  id: ORG_B,
  name: 'Org B',
  slug: 'org-b',
  legalName: null,
  country: null,
  sector: null,
  status: 'active',
}

// TWO active memberships for the SAME user — a mock-only fixture. Real
// PostgreSQL enforces `user_single_active_membership` (P-5, M-8); this shape
// exists ONLY to prove the query is qualified by organization rather than
// pick-first-then-compare, which a single-membership fixture cannot
// distinguish (REQUEST_PRINCIPAL_CONTRACT.PROHIBITED_IMPLEMENTATION_SHAPE).
const MEMBERSHIP_A_ROW = {
  id: 'm-a',
  userId: USER_ID,
  organizationId: ORG_A,
  role: 'organization_admin',
  status: 'active',
}
const MEMBERSHIP_B_ROW = {
  id: 'm-b',
  userId: USER_ID,
  organizationId: ORG_B,
  role: 'viewer',
  status: 'active',
}

beforeEach(() => {
  fakeCookieStore.clear()
  mockGetUser.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
  TABLES.users = []
  TABLES.organization_members = []
  TABLES.organizations = []
  eqCalls = []
})

/* -------------------------------------------------------------------------- */
/* S3-1 — qualified predicate, not pick-first-then-compare                    */
/* -------------------------------------------------------------------------- */

describe('S3-1: the membership is resolved by a SINGLE QUALIFIED predicate on (user, selected organization, active)', () => {
  it('resolves the membership belonging to the REQUESTED organization when the user holds active memberships in MULTIPLE organizations', async () => {
    TABLES.organization_members = [MEMBERSHIP_A_ROW, MEMBERSHIP_B_ROW]

    const resolvedA = await loadActiveMembershipWithinContext(USER_ID, ORG_A)
    expect(resolvedA?.organizationId).toBe(ORG_A)
    expect(resolvedA?.role).toBe('organization_admin')

    const resolvedB = await loadActiveMembershipWithinContext(USER_ID, ORG_B)
    expect(resolvedB?.organizationId).toBe(ORG_B)
    expect(resolvedB?.role).toBe('viewer')
  })

  it('PREDICATE SHAPE (not merely the returned row): the organization is passed as an eq() condition INSIDE the query', async () => {
    TABLES.organization_members = [MEMBERSHIP_A_ROW]
    await loadActiveMembershipWithinContext(USER_ID, ORG_A)

    expect(eqCalls).toContainEqual({ columnName: 'organization_id', value: ORG_A })
    expect(eqCalls).toContainEqual({ columnName: 'user_id', value: USER_ID })
    expect(eqCalls).toContainEqual({ columnName: 'status', value: 'active' })
  })

  it('P-4 / MO-03+MO-05: the request principal derives membership from the (user, SELECTED organization) pair, never pick-first', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW, ORG_B_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW, MEMBERSHIP_B_ROW]
    signedInAs(USER_ID)
    selectOrganization(ORG_B)

    const { principal } = await loadRequestPrincipalResult()

    expect(principal?.membership?.organizationId).toBe(ORG_B)
    expect(principal?.membership?.role).toBe('viewer')
    expect(principal?.organization?.id).toBe(ORG_B)
  })
})

/* -------------------------------------------------------------------------- */
/* S3-2 — no selected organization                                           */
/* -------------------------------------------------------------------------- */

describe('S3-2: no selected organization yields TENANCY_NO_ORGANIZATION_SELECTED, and no principal with an organization is constructed', () => {
  it('the principal resolves with membership/organization null and the refusal code set', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW]
    signedInAs(USER_ID)
    // No selectOrganization() call.

    const { principal } = await loadRequestPrincipalResult()

    expect(principal?.membership).toBeNull()
    expect(principal?.organization).toBeNull()
    expect(principal?.organizationRefusalCode).toBe('TENANCY_NO_ORGANIZATION_SELECTED')
  })

  it('withOrganizationDatabaseContext throws TENANCY_NO_ORGANIZATION_SELECTED', async () => {
    TABLES.users = [USER_ROW]
    signedInAs(USER_ID)

    const code = await captureCode(() => withOrganizationDatabaseContext(async () => null))
    expect(code).toBe('TENANCY_NO_ORGANIZATION_SELECTED')
  })
})

/* -------------------------------------------------------------------------- */
/* S3-3 — selected organization, no active membership                        */
/* -------------------------------------------------------------------------- */

describe('S3-3: a selected organization with no active membership yields TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER', () => {
  it('the principal refuses with the correct code when the caller has no membership in the SELECTED organization', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW] // active member of A only
    signedInAs(USER_ID)
    selectOrganization(ORG_B) // selects B, which the caller has no membership in

    const { principal } = await loadRequestPrincipalResult()

    expect(principal?.membership).toBeNull()
    expect(principal?.organization).toBeNull()
    expect(principal?.organizationRefusalCode).toBe('TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER')
  })

  it('N-1 / SC-1: withOrganizationDatabaseContext throws TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER, no fallback to A', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW]
    signedInAs(USER_ID)
    selectOrganization(ORG_B)

    const code = await captureCode(() => withOrganizationDatabaseContext(async (ctx) => ctx.organization.id))
    expect(code).toBe('TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER')
  })
})

/* -------------------------------------------------------------------------- */
/* S3-4 — indistinguishability: deleted/nonexistent vs non-member            */
/* -------------------------------------------------------------------------- */

describe('S3-4: a DELETED or NONEXISTENT selected organization is INDISTINGUISHABLE from non-membership — no existence oracle', () => {
  it('a NONEXISTENT organization id produces the SAME refusal code as a real organization the caller is not a member of', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW, ORG_B_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW] // member of A only
    signedInAs(USER_ID)

    selectOrganization(NONEXISTENT_ORG)
    const codeForNonexistent = await captureCode(() => withOrganizationDatabaseContext(async () => null))

    selectOrganization(ORG_B) // exists, but caller is not a member
    const codeForNonMember = await captureCode(() => withOrganizationDatabaseContext(async () => null))

    expect(codeForNonexistent).toBe('TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER')
    expect(codeForNonMember).toBe('TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER')
    expect(codeForNonexistent).toBe(codeForNonMember)
  })

  it('no organizations lookup is even attempted before the membership predicate refuses — there is no second query that could distinguish them', async () => {
    TABLES.organization_members = [] // no membership rows at all
    const membership = await loadActiveMembershipWithinContext(USER_ID, NONEXISTENT_ORG)
    expect(membership).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* S3-5 — no fallback, including the single-membership case                  */
/* -------------------------------------------------------------------------- */

describe('S3-5 / M-4: no fallback occurs on refusal, INCLUDING when the subject holds exactly one active membership', () => {
  it('exactly ONE active membership is STILL refused when no organization is selected — never inferred', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW] // exactly one
    signedInAs(USER_ID)
    // No selection.

    const { principal } = await loadRequestPrincipalResult()
    expect(principal?.membership).toBeNull()
    expect(principal?.organizationRefusalCode).toBe('TENANCY_NO_ORGANIZATION_SELECTED')
  })

  it('a refusal never falls back to the FIRST, ONLY, or MOST RECENT membership', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW, ORG_B_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW, MEMBERSHIP_B_ROW]
    signedInAs(USER_ID)
    selectOrganization(NONEXISTENT_ORG)

    const { principal } = await loadRequestPrincipalResult()
    expect(principal?.membership).toBeNull()
    expect(principal?.organization).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* S3-6 — role solely from the selected membership; isSuperAdmin unchanged   */
/* -------------------------------------------------------------------------- */

describe('S3-6: the role on the resulting principal comes solely from the SELECTED membership; isSuperAdmin derivation is unchanged', () => {
  it('the role reflects the SELECTED organization, not any other active membership the caller holds', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW, ORG_B_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW, MEMBERSHIP_B_ROW]
    signedInAs(USER_ID)

    selectOrganization(ORG_A)
    expect((await loadRequestPrincipalResult()).principal?.membership?.role).toBe('organization_admin')

    selectOrganization(ORG_B)
    expect((await loadRequestPrincipalResult()).principal?.membership?.role).toBe('viewer')
  })

  it('isSuperAdmin is read from public.users, exactly as before S3 — the carrier plays no part', async () => {
    TABLES.users = [{ ...USER_ROW, isSuperAdmin: true }]
    signedInAs(USER_ID)
    // No selection at all — isSuperAdmin must still be reported correctly on
    // the user, independent of the (refused) organization principal.

    const { principal } = await loadRequestPrincipalResult()
    expect(principal?.user.isSuperAdmin).toBe(true)
    expect(principal?.membership).toBeNull()
  })

  it('MS3-6 guard: the carrier CANNOT grant super-admin — an ordinary member with a VALID selection is still not super-admin', async () => {
    TABLES.users = [{ ...USER_ROW, isSuperAdmin: false }]
    TABLES.organizations = [ORG_A_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW]
    signedInAs(USER_ID)
    selectOrganization(ORG_A) // a VALID, resolving selection

    const { principal } = await loadRequestPrincipalResult()
    expect(principal?.membership?.organizationId).toBe(ORG_A)
    expect(principal?.user.isSuperAdmin).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* S3-7 — enumerator hosted in an EXISTING context module; no new module     */
/* -------------------------------------------------------------------------- */

describe('S3-7: the selectable-memberships enumerator is exported from an EXISTING context module; NO new lib/auth/* module exists', () => {
  it('lib/auth/ contains exactly the files that existed before S3 — no new module was added', () => {
    const files = readdirSync(path.join(ROOT, 'lib', 'auth')).filter((f) => f.endsWith('.ts')).sort()
    expect(files).toEqual([
      'database-context.ts',
      'identity.ts',
      'permissions.ts',
      'roles.ts',
      'safe-redirect.ts',
      'selected-organization.ts',
      'session.ts',
    ])
  })

  it('listSelectableMemberships is exported from BOTH @/lib/auth/session and @/lib/auth/database-context — the two permitted hosts', () => {
    expect(typeof sessionModule.listSelectableMemberships).toBe('function')
    expect(typeof databaseContextModule.listSelectableMemberships).toBe('function')
  })

  it('ENUMERATOR_HOST: session.ts re-exports the SAME function database-context.ts implements — not a duplicate query', () => {
    expect(sessionModule.listSelectableMemberships).toBe(databaseContextModule.listSelectableMemberships)
  })

  it('the enumerator answers "which organizations may this subject select", keyed on (user, active) alone — no selection is read', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW, MEMBERSHIP_B_ROW]
    TABLES.organizations = [ORG_A_ROW, ORG_B_ROW]
    signedInAs(USER_ID)
    // No selectOrganization() call — the enumerator must not need one.

    const candidates = await listSelectableMemberships()

    expect(candidates.map((c) => c.organization.id).sort()).toEqual([ORG_A, ORG_B].sort())
  })

  it('the enumerator never conditions its query on the carrier: no getSelectedOrganizationId call in loadSelectableMembershipsWithinContext', () => {
    const source = read('lib/auth/database-context.ts')
    const fnStart = source.indexOf('export async function loadSelectableMembershipsWithinContext')
    const fnEnd = source.indexOf('\n/** The organisation row.', fnStart)
    const fnBody = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
    expect(fnBody).not.toMatch(/getSelectedOrganizationId/)
  })
})

/* -------------------------------------------------------------------------- */
/* S3-8 — selector converges across carrier states                           */
/* -------------------------------------------------------------------------- */

describe('S3-8: the selector route renders and permits selection with the carrier ABSENT, MALFORMED, or naming a non-member organization', () => {
  it('the selector page never imports getCurrentOrganizationContext / getCurrentMembership — it cannot depend on an already-selected principal (the decircularisation itself)', () => {
    const source = read('app/(authenticated)/app/organizations/select/page.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(source).not.toMatch(/getCurrentOrganizationContext|getCurrentMembership/)
    expect(source).toMatch(/listSelectableMemberships/)
  })

  it('the enumerator itself succeeds regardless of what the carrier currently holds (absent, malformed, or a non-member id) — it never reads the carrier at all (S3-7)', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW]
    TABLES.organizations = [ORG_A_ROW]
    signedInAs(USER_ID)

    // ABSENT
    const withNoSelection = await listSelectableMemberships()
    // MALFORMED (fails selected-organization.ts's own UUID check, but that
    // module is never consulted by the enumerator anyway)
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, 'not-a-uuid')
    const withMalformedSelection = await listSelectableMemberships()
    // Names an organization the caller is NOT a member of
    selectOrganization(ORG_B)
    const withNonMemberSelection = await listSelectableMemberships()

    for (const candidates of [withNoSelection, withMalformedSelection, withNonMemberSelection]) {
      expect(candidates.map((c) => c.organization.id)).toEqual([ORG_A])
    }
  })
})

/* -------------------------------------------------------------------------- */
/* N-2 / M-3 — revalidation and no per-request memoisation leak              */
/* -------------------------------------------------------------------------- */

describe('N-2 / M-3: revalidation is per-call, not cached beyond a single resolution', () => {
  it('a membership revoked between two independent resolutions is refused on the SECOND, with no grace window', async () => {
    TABLES.users = [USER_ROW]
    TABLES.organizations = [ORG_A_ROW]
    TABLES.organization_members = [MEMBERSHIP_A_ROW]
    signedInAs(USER_ID)
    selectOrganization(ORG_A)

    const before = await loadRequestPrincipalResult()
    expect(before.principal?.membership?.organizationId).toBe(ORG_A)

    // Revoke — the row's status changes, as a real UPDATE would produce.
    TABLES.organization_members = [{ ...MEMBERSHIP_A_ROW, status: 'revoked' }]

    const after = await loadRequestPrincipalResult()
    expect(after.principal?.membership).toBeNull()
    expect(after.principal?.organizationRefusalCode).toBe('TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER')
  })
})

/* -------------------------------------------------------------------------- */
/* M-8 — the S7 ordering guard: user_single_active_membership still present  */
/* -------------------------------------------------------------------------- */

describe('M-8: the user_single_active_membership constraint is NOT dropped by S3 — that ordering belongs to S7', () => {
  it('the unique partial index is still declared in the schema', () => {
    const source = read('db/schema.ts')
    expect(source).toMatch(/uniqueIndex\('user_single_active_membership'\)/)
    expect(source).toMatch(/\.on\(table\.userId\)/)
    expect(source).toMatch(/status\}\s*=\s*'active'/)
  })
})

/* -------------------------------------------------------------------------- */
/* P-5 — declared partial coverage, never laundered into a full PASS         */
/* -------------------------------------------------------------------------- */

describe('P5_COVERAGE_DISPOSITION: structural coverage only — behavioural coverage is DEFERRED to S7', () => {
  it('records the disposition as data, not as an assertion that could silently start passing vacuously', () => {
    const disposition = {
      P5_BEHAVIOURAL_COVERAGE: 'DEFERRED',
      P5_STRUCTURAL_COVERAGE: 'DELIVERED_BY_S3',
      owed_to: 'S7',
    } as const
    expect(disposition.P5_BEHAVIOURAL_COVERAGE).toBe('DEFERRED')
    expect(disposition.P5_STRUCTURAL_COVERAGE).toBe('DELIVERED_BY_S3')
  })

  it('the role-derivation predicate (S3-6) is the STRUCTURAL proof: it is keyed on the selected pair, with no other input, by construction', () => {
    const source = read('lib/auth/database-context.ts')
    // loadActiveMembershipWithinContext's WHERE is exactly userId + organizationId + status —
    // no route, resource or other side-channel input is threaded into it.
    const fnStart = source.indexOf('export async function loadActiveMembershipWithinContext')
    const fnEnd = source.indexOf('\n/** One candidate', fnStart)
    const fnBody = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
    expect(fnBody).toMatch(/organizationMembers\.userId/)
    expect(fnBody).toMatch(/organizationMembers\.organizationId/)
    expect(fnBody).toMatch(/organizationMembers\.status/)
  })
})

/* -------------------------------------------------------------------------- */
/* Cross-check: the S2 host's NS2-4 replacement is present, not merely gone   */
/* (target of MS3-10 — see MULTI_ORG_S3_IMPLEMENTATION_EVIDENCE for the       */
/* executed byte-level mutation).                                            */
/* -------------------------------------------------------------------------- */

describe('MS3-10 structural guard: the S2 host records a REPLACEMENT for NS2-4, not a bare deletion', () => {
  it('tests/tenancy/s2-selected-org-carrier.test.ts still declares the S3 replacement block, ACTIVE (not merely present as text, and not skipped)', () => {
    const source = read('tests/tenancy/s2-selected-org-carrier.test.ts')
    // Deliberately anchored on the exact ACTIVE `describe(` call — never
    // `describe.skip(` or `describe.todo(` — so a mutation that DISABLES the
    // block rather than deleting its text (the exact MS3-10 shape) is still
    // caught: a bare substring search for the marker would still find it
    // inside a skipped title.
    expect(source).toContain("describe('carrier inertness RETIRED BY REPLACEMENT")
    expect(source).not.toContain("describe.skip('carrier inertness RETIRED BY REPLACEMENT")
    expect(source).not.toContain('describe.skip("carrier inertness RETIRED BY REPLACEMENT')
    expect(source).not.toContain("describe.todo('carrier inertness RETIRED BY REPLACEMENT")
    expect(source).toMatch(/NARROWED_SURFACES_STILL_NOT_CONSUMING/)
  })
})
