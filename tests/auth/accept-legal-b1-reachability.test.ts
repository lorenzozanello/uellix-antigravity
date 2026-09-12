// tests/auth/accept-legal-b1-reachability.test.ts
//
// CL-1 (HPO-ODS-W2-28) — independent-certification BLOCKING B-1:
// "The L0 acceptance destination is itself gated by L0."
//
// Drives the REAL app/(public)/accept-legal/{page.tsx,actions.ts} modules
// through the REAL lib/auth/identity.ts -> lib/auth/database-context.ts ->
// lib/auth/legal-acceptance.ts chain. Nothing in that chain is mocked away —
// assertPrincipalGates, requirePrincipal, deriveAccountAcceptanceCurrent and
// loadRequiredInstrumentsPendingAcceptance all run for real. Only the leaf
// I/O (Supabase auth, the raw SQL executor, the row-level table reads) is
// doubled, exactly the way tests/auth/email-verification-gate.test.ts
// doubles Packet B's own leaves.
//
// B-1's causal chain, reproduced here rather than asserted from prose:
//   AcceptLegalPage / acceptRequiredLegalInstruments
//     -> withAuthenticatedDatabaseContext
//       -> requirePrincipal
//         -> assertPrincipalGates
//           -> assertAccountAcceptanceCurrentPrincipal
//             -> throws AUTH_LEGAL_ACCEPTANCE_REQUIRED
// for the EXACT subject state (verified, unaccepted) the page and action
// exist to serve — a self-lock no subject could ever escape.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

/** The real digest of the fixture content — loadRequiredInstrumentsPendingAcceptance
 * re-verifies content_bytes against content_digest, so a fixture with a fake
 * digest is silently excluded from the presentable set rather than matched. */
const CONTENT_BYTES = 'contenido sintético'
const CONTENT_DIGEST = 'sha256:' + createHash('sha256').update(CONTENT_BYTES, 'utf8').digest('hex')

/* -------------------------------------------------------------------------- */
/* Fake cookie jar — lib/auth/selected-organization.ts's only dependency      */
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
}
const fakeCookieStore = new FakeCookieStore()
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => fakeCookieStore),
}))

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({
  redirect: (p: string) => mockRedirect(p),
}))

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
}))

// No organisation selection anywhere in this suite — RETURN SITE 1
// (TENANCY_NO_ORGANIZATION_SELECTED) every time, which needs no
// organizations/organization_members fixture at all.
vi.mock('@/lib/auth/selected-organization', () => ({
  getSelectedOrganizationId: vi.fn(async () => null),
  SELECTED_ORGANIZATION_COOKIE_NAME: 'uellix_selected_organization_id',
}))

vi.mock('@/lib/audit/tenancy-refusal', () => ({
  emitMembershipRevalidationRefused: vi.fn(async () => undefined),
}))

const mockLogAuditAction = vi.fn(async (_entry: unknown) => undefined)
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: (entry: unknown) => mockLogAuditAction(entry),
  AUDIT_ACTIONS: { LEGAL_ACCOUNT_INSTRUMENT_ACCEPTED: 'legal.account_instrument_accepted' },
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
/* drizzle-orm — real query-builder shape, tagged so the db.execute double    */
/* can tell the two raw SQL callers apart by their own literal SQL text.      */
/* -------------------------------------------------------------------------- */

interface EqCondition { __type: 'eq'; columnName: string; value: unknown }
interface AndCondition { __type: 'and'; conditions: unknown[] }
interface IsNullCondition { __type: 'isNull'; columnName: string }
type Condition = EqCondition | AndCondition | IsNullCondition
interface SqlChunk { __type: 'sql'; text: string }

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown): EqCondition => ({ __type: 'eq', columnName: column.name, value }),
  and: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }): IsNullCondition => ({ __type: 'isNull', columnName: column.name }),
  sql: Object.assign(
    (strings: TemplateStringsArray): SqlChunk => ({ __type: 'sql', text: strings.join(' ? ') }),
    { join: (parts: SqlChunk[], sep: SqlChunk): SqlChunk => ({ __type: 'sql', text: parts.map((p) => p.text).join(sep.text) }) }
  ),
}))

const JS_KEY_BY_COLUMN_NAME: Record<string, string> = {
  id: 'id', user_id: 'userId', email: 'email', deleted_at: 'deletedAt', is_super_admin: 'isSuperAdmin',
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

/* -------------------------------------------------------------------------- */
/* @/db/client double: table reads via .select(), the raw currency/pending    */
/* queries via .execute() (routed by the caller's OWN literal SQL text, never */
/* by call order), and .insert() for the acceptance + audit writes.           */
/* -------------------------------------------------------------------------- */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const USER_ROW = { id: USER_ID, email: 'member@example.test', isSuperAdmin: false, deletedAt: null }
const TABLES: { users: Array<Record<string, unknown>> } = { users: [USER_ROW] }

/** Test-controlled: what the currency predicate and the pending-list resolve to. */
let accountAcceptanceCurrent = false
let pendingRows: Array<{
  instrument_key: string
  instrument_version_id: string
  version: number
  locale: string
  content_digest: string
  content_bytes: string | null
}> = []

const PENDING_VERSION_ROW = {
  id: 'v-terms-1',
  instrumentKey: 'terms_of_service',
  version: 1,
  contentDigest: CONTENT_DIGEST,
}

const insertedRows: Array<{ table: string; row: Record<string, unknown> }> = []

const mockExecute = vi.fn(async (query: SqlChunk) => {
  const text = query.text
  if (text.includes('all_current')) return [{ all_current: accountAcceptanceCurrent }]
  if (text.includes('DISTINCT ON')) return pendingRows
  throw new Error(`accept-legal-b1-reachability: unrecognised db.execute call: ${text}`)
})

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation((_cols?: unknown) => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
        const tableName = tableNameOf(table)
        const data: Array<Record<string, unknown>> =
          tableName === 'users' ? TABLES.users : tableName === 'legal_instrument_versions' ? [PENDING_VERSION_ROW] : []
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
    execute: (query: SqlChunk) => mockExecute(query),
    insert: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
      const tableName = tableNameOf(table)
      return {
        values: (row: Record<string, unknown>) => {
          const recorded = { ...row }
          const promise = Promise.resolve(undefined) as Promise<undefined> & {
            onConflictDoNothing: (opts: unknown) => { returning: () => { then: (cb: (rows: unknown[]) => unknown) => Promise<unknown> } }
          }
          promise.onConflictDoNothing = () => {
            const generated = { id: `generated-${tableName}-${insertedRows.length}`, ...recorded }
            insertedRows.push({ table: tableName, row: generated })
            return { then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([generated])) } as never
          }
          return Object.assign(promise, {
            onConflictDoNothing: () => {
              const generated = { id: `generated-${tableName}-${insertedRows.length}`, ...recorded }
              insertedRows.push({ table: tableName, row: generated })
              return { returning: () => ({ then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([generated])) }) }
            },
          })
        },
      }
    }),
  },
}))

/* -------------------------------------------------------------------------- */
/* Import after mocks are in place                                            */
/* -------------------------------------------------------------------------- */

import AcceptLegalPage from '@/app/(public)/accept-legal/page'
import { acceptRequiredLegalInstruments } from '@/app/(public)/accept-legal/actions'
import { AuthContextError } from '@/lib/auth/database-context'

function signedInAs(userId: string, emailConfirmedAt: string | null): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email_confirmed_at: emailConfirmedAt } },
    error: null,
  })
}
const verified = () => signedInAs(USER_ID, '2024-01-01T00:00:00.000Z')
const unverified = () => signedInAs(USER_ID, null)

async function run(fn: () => Promise<unknown>): Promise<{ code?: string; location?: string; ok: boolean; value?: unknown }> {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (error) {
    if (error instanceof AuthContextError) return { ok: false, code: error.code }
    const message = (error as Error).message
    if (message.startsWith('REDIRECT:')) return { ok: false, location: message.slice('REDIRECT:'.length) }
    throw error
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRedirect.mockClear()
  TABLES.users = [USER_ROW]
  accountAcceptanceCurrent = false
  pendingRows = []
  insertedRows.length = 0
})

describe('B-1 reproduction: the L0 discharge surface must not itself require L0', () => {
  it('REPRODUCES B-1 on the unpatched call path: verified+unaccepted throws AUTH_LEGAL_ACCEPTANCE_REQUIRED reaching PAGE data-loading via withAuthenticatedDatabaseContext (causal chain proof)', async () => {
    // This control targets the SPECIFIC helper the certification finding
    // names as the root cause. It must FAIL (i.e. this assertion must be
    // false) once B-1 is repaired, which is exactly why the behavioural
    // controls below assert the OPPOSITE outcome on the same subject state —
    // together they prove the causal chain named in B-1 and its repair.
    const { withAuthenticatedDatabaseContext } = await import('@/lib/auth/database-context')
    const { loadRequiredInstrumentsPendingAcceptance } = await import('@/lib/auth/legal-acceptance')
    verified()
    accountAcceptanceCurrent = false
    pendingRows = [{
      instrument_key: 'terms_of_service',
      instrument_version_id: PENDING_VERSION_ROW.id,
      version: 1,
      locale: 'es',
      content_digest: PENDING_VERSION_ROW.contentDigest,
      content_bytes: CONTENT_BYTES,
    }]
    const outcome = await run(() =>
      withAuthenticatedDatabaseContext((ctx) => loadRequiredInstrumentsPendingAcceptance(ctx.user.id))
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('AUTH_LEGAL_ACCEPTANCE_REQUIRED')
  })

  it('VERIFIED + UNACCEPTED: the PAGE renders the acceptance form instead of throwing', async () => {
    verified()
    accountAcceptanceCurrent = false
    pendingRows = [{
      instrument_key: 'terms_of_service',
      instrument_version_id: PENDING_VERSION_ROW.id,
      version: 1,
      locale: 'es',
      content_digest: PENDING_VERSION_ROW.contentDigest,
      content_bytes: CONTENT_BYTES,
    }]
    const outcome = await run(() => AcceptLegalPage({ searchParams: Promise.resolve({}) }))
    expect(outcome.ok, `expected the page to render, got ${JSON.stringify(outcome)}`).toBe(true)
    expect(outcome.value).toBeTruthy()
  })

  it('VERIFIED + UNACCEPTED: the ACTION persists the acceptance instead of throwing before it can write', async () => {
    verified()
    accountAcceptanceCurrent = false
    // D-1: the action re-derives its own server-side pending set — a
    // submission is honoured only when the id it names is a member of it.
    pendingRows = [{
      instrument_key: 'terms_of_service',
      instrument_version_id: PENDING_VERSION_ROW.id,
      version: 1,
      locale: 'es',
      content_digest: PENDING_VERSION_ROW.contentDigest,
      content_bytes: CONTENT_BYTES,
    }]
    const formData = new FormData()
    formData.set('instrumentVersionId', PENDING_VERSION_ROW.id)
    const outcome = await run(() => acceptRequiredLegalInstruments(formData))
    // The action always terminates in a redirect on success — that redirect
    // is the observable proof the write path was REACHED, not refused.
    expect(outcome.ok, `expected a redirect after a successful write, got ${JSON.stringify(outcome)}`).toBe(false)
    expect(outcome.code, 'must not be a gate refusal').toBeUndefined()
    expect(outcome.location).toBe('/app/dashboard')
    expect(insertedRows.some((r) => r.table === 'account_legal_acceptances')).toBe(true)
    expect(mockLogAuditAction).toHaveBeenCalled()
  })

  it('VERIFIED + ACCEPTED: the page exits to the application and never opens the discharge context at all', async () => {
    verified()
    accountAcceptanceCurrent = true
    const outcome = await run(() => AcceptLegalPage({ searchParams: Promise.resolve({}) }))
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBeUndefined()
    expect(outcome.location).toBe('/app/dashboard')
    // Never reached loadRequiredInstrumentsPendingAcceptance's own query.
    expect(mockExecute.mock.calls.some((c) => (c[0] as SqlChunk).text.includes('DISTINCT ON'))).toBe(false)
  })

  it('UNVERIFIED: the page redirects to VERIFY_EMAIL_PATH — B0 still gates the discharge surface', async () => {
    unverified()
    const outcome = await run(() => AcceptLegalPage({ searchParams: Promise.resolve({}) }))
    expect(outcome.ok).toBe(false)
    expect(outcome.location).toBe('/verify-email')
  })

  it('UNVERIFIED: the action refuses before writing anything — B0 still gates the mutation', async () => {
    unverified()
    const formData = new FormData()
    formData.set('instrumentVersionId', PENDING_VERSION_ROW.id)
    const outcome = await run(() => acceptRequiredLegalInstruments(formData))
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('AUTH_EMAIL_NOT_VERIFIED')
    expect(insertedRows).toHaveLength(0)
  })
})
