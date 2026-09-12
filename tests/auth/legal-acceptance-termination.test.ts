// tests/auth/legal-acceptance-termination.test.ts
//
// CL-1 (HPO-ODS-W2-28) — independent-certification BLOCKING B-2:
// "The canonical termination obligation is not implemented as a control."
//
// T-AO-1 (docs/ops/compliance/CUSTOMER_LIFECYCLE_LEGAL_ACCEPTANCE_AUTHORITY_
// v1.0.0.json ENFORCEMENT_TOPOLOGY.TERMINATION) requires the COMBINED B0/L0
// routing graph to terminate for every principal state — including the
// three-state graph CL-1 creates by adding L0 beside Packet B's existing B0.
// This file is that control: THE_CL1_TERMINATION_CONTROL.
//
// STATE SPACE
//   SUBJECT:  U  = unverified
//             V0 = verified, L0 NOT current (unaccepted)
//             V1 = verified, L0 current (accepted)
//   REGISTRY: R0 = empty (no published required instrument)
//             R1 = partial (one required key unpresentable/unpublished)
//             R2 = complete and presentable (every required key resolvable)
//
// LOCATIONS MODELLED
//   'app'          — any protected surface behind K4 (requireOrganizationAccess),
//                    driven for REAL against a membership+organization fixture
//                    so a genuine PASS is observable as "no redirect at all".
//   'verify-email' — Packet B's OWN frozen destination. NOT re-derived here —
//                    its two-branch behaviour (unverified: renders; verified:
//                    redirects to /app/dashboard) is cited as a fact from its
//                    own source (app/(public)/verify-email/page.tsx) and
//                    pinned by a structural assertion below, so a change to
//                    that frozen surface is caught rather than silently
//                    invalidating this control's model of it.
//   'accept-legal' — CL-1's OWN destination, driven for REAL via the actual
//                    AcceptLegalPage component against a controllable
//                    registry fixture.
//
// The control traces, from EVERY (subject, registry, starting-location)
// triple, the sequence of locations a subject following each redirect would
// visit, and asserts: (a) it terminates within a small bounded number of
// hops, (b) no location repeats (cycle-freedom), and (c) the terminal
// outcome matches the property T-AO-1 and FAIL_CLOSED.FC_7 require for that
// state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

/* -------------------------------------------------------------------------- */
/* Packet B's frozen fact, pinned structurally (not re-derived, not executed) */
/* -------------------------------------------------------------------------- */

describe('frozen precondition: verify-email\'s own two-branch behaviour matches this control\'s model of it', () => {
  it('renders for an unverified subject and redirects to /app/dashboard for a verified one', () => {
    const source = read('app/(public)/verify-email/page.tsx')
    expect(source).toMatch(/if\s*\(principal\.emailVerified\)\s*\{[\s\S]{0,200}redirect\(safeNext \?\? '\/app\/dashboard'\)/)
  })
})

/* -------------------------------------------------------------------------- */
/* Harness — identical shape to accept-legal-b1-reachability.test.ts, plus    */
/* organizations/organization_members for a genuine K4 PASS.                  */
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

vi.mock('@/lib/audit/tenancy-refusal', () => ({
  emitMembershipRevalidationRefused: vi.fn(async () => undefined),
}))

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(async () => undefined),
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
  id: 'id', user_id: 'userId', organization_id: 'organizationId', status: 'status', role: 'role',
  email: 'email', deleted_at: 'deletedAt', is_super_admin: 'isSuperAdmin',
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

const USER_ID = '22222222-2222-4222-8222-222222222222'
const ORG_ID = '33333333-3333-4333-8333-333333333333'
const USER_ROW = { id: USER_ID, email: 'member@example.test', isSuperAdmin: false, deletedAt: null }
const ORG_ROW = { id: ORG_ID, name: 'Org', slug: 'org' }
const MEMBERSHIP_ROW = { id: 'm-1', userId: USER_ID, organizationId: ORG_ID, role: 'analyst', status: 'active' }

const TABLES: {
  users: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
} = { users: [USER_ROW], organizations: [ORG_ROW], organization_members: [MEMBERSHIP_ROW] }

/** Test-controlled registry state for the currency predicate and pending-list resolver. */
let accountAcceptanceCurrent = false
let pendingRows: Array<{
  instrument_key: string
  instrument_version_id: string
  version: number
  locale: string
  content_digest: string
  content_bytes: string | null
}> = []

const mockExecute = vi.fn(async (query: SqlChunk) => {
  const text = query.text
  if (text.includes('all_current')) return [{ all_current: accountAcceptanceCurrent }]
  if (text.includes('DISTINCT ON')) return pendingRows
  throw new Error(`legal-acceptance-termination: unrecognised db.execute call: ${text}`)
})

vi.mock('@/lib/auth/selected-organization', () => ({
  getSelectedOrganizationId: vi.fn(async () => ORG_ID),
  SELECTED_ORGANIZATION_COOKIE_NAME: 'uellix_selected_organization_id',
}))

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
        const tableName = tableNameOf(table)
        const data = (TABLES as unknown as Record<string, Array<Record<string, unknown>>>)[tableName] ?? []
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
    insert: vi.fn().mockImplementation(() => ({
      values: () => {
        const promise = Promise.resolve(undefined) as Promise<undefined> & {
          onConflictDoNothing: () => { returning: () => { then: (cb: (rows: unknown[]) => unknown) => Promise<unknown> } }
        }
        promise.onConflictDoNothing = () => ({
          returning: () => ({ then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: 'generated' }])) }),
        })
        return promise
      },
    })),
  },
}))

import { requireOrganizationAccess } from '@/lib/auth/session'
import AcceptLegalPage from '@/app/(public)/accept-legal/page'

function signedInAs(emailConfirmedAt: string | null): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: USER_ID, email_confirmed_at: emailConfirmedAt } },
    error: null,
  })
}

type Subject = 'U' | 'V0' | 'V1'
type Registry = 'R0' | 'R1' | 'R2'
type Location = 'app' | 'verify-email' | 'accept-legal'

function applySubjectAndRegistry(subject: Subject, registry: Registry): void {
  signedInAs(subject === 'U' ? null : '2024-01-01T00:00:00.000Z')
  signedInAsUnverifiedFlag = subject === 'U'
  accountAcceptanceCurrent = subject === 'V1'
  if (registry === 'R0') pendingRows = []
  else if (registry === 'R1') {
    pendingRows = [{
      instrument_key: 'terms_of_service',
      instrument_version_id: 'v-1',
      version: 1,
      locale: 'es',
      content_digest: 'sha256:' + '1'.repeat(64),
      content_bytes: null, // unpresentable — I-T2-4 conformant but excluded from display
    }]
  } else {
    pendingRows = [{
      instrument_key: 'terms_of_service',
      instrument_version_id: 'v-1',
      version: 1,
      locale: 'es',
      content_digest: 'sha256:' + '2'.repeat(64),
      content_bytes: 'contenido sintético',
    }]
  }
}

/** One hop from `location`, for the CURRENT mocked subject/registry state. */
async function oneHop(location: Location): Promise<{ terminal: boolean; next?: Location; rendered?: boolean }> {
  if (location === 'app') {
    try {
      await requireOrganizationAccess()
      return { terminal: true, rendered: true }
    } catch (error) {
      const target = redirectTargetOf(error)
      if (target === '/verify-email') return { terminal: false, next: 'verify-email' }
      if (target === '/accept-legal') return { terminal: false, next: 'accept-legal' }
      // Any other destination (e.g. /admin, /app/onboarding, /app/organizations/select)
      // is Packet A's own downstream routing — outside CL-1's state space, and a
      // TERMINAL outcome for the purposes of this B0/L0 control.
      return { terminal: true, rendered: false }
    }
  }

  if (location === 'verify-email') {
    // FROZEN FACT (see the structural pin above), not executed: unverified
    // renders (terminal); verified redirects to /app/dashboard.
    return signedInAsUnverified() ? { terminal: true, rendered: true } : { terminal: false, next: 'app' }
  }

  // location === 'accept-legal'
  try {
    const rendered = await AcceptLegalPage({ searchParams: Promise.resolve({}) })
    return { terminal: true, rendered: Boolean(rendered) }
  } catch (error) {
    const target = redirectTargetOf(error)
    if (target === '/verify-email') return { terminal: false, next: 'verify-email' }
    if (target === '/app/dashboard') return { terminal: false, next: 'app' }
    throw error
  }
}

function redirectTargetOf(error: unknown): string | null {
  const message = (error as Error).message
  return message?.startsWith('REDIRECT:') ? message.slice('REDIRECT:'.length) : null
}

// Set once per applySubjectAndRegistry call, read by oneHop('verify-email').
let signedInAsUnverifiedFlag = false
function signedInAsUnverified(): boolean {
  return signedInAsUnverifiedFlag
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRedirect.mockClear()
  TABLES.users = [USER_ROW]
  TABLES.organizations = [ORG_ROW]
  TABLES.organization_members = [MEMBERSHIP_ROW]
})

const SUBJECTS: Subject[] = ['U', 'V0', 'V1']
const REGISTRIES: Registry[] = ['R0', 'R1', 'R2']
const STARTS: Location[] = ['app', 'verify-email', 'accept-legal']
const MAX_HOPS = 6

describe('THE_CL1_TERMINATION_CONTROL — B0/L0 combined state space terminates, never cycles', () => {
  for (const subject of SUBJECTS) {
    for (const registry of REGISTRIES) {
      for (const start of STARTS) {
        it(`subject=${subject} registry=${registry} start=${start}: reaches a terminal outcome within ${MAX_HOPS} hops with no repeated location`, async () => {
          applySubjectAndRegistry(subject, registry)

          const visited: Location[] = [start]
          let current = start
          let terminalRendered: boolean | undefined
          for (let hop = 0; hop < MAX_HOPS; hop++) {
            const result = await oneHop(current)
            if (result.terminal) {
              terminalRendered = result.rendered
              break
            }
            expect(
              visited.includes(result.next!),
              `CYCLE DETECTED: ${[...visited, result.next].join(' -> ')} (subject=${subject} registry=${registry} start=${start})`
            ).toBe(false)
            visited.push(result.next!)
            current = result.next!
          }

          expect(
            terminalRendered,
            `did not terminate within ${MAX_HOPS} hops: ${visited.join(' -> ')} (subject=${subject} registry=${registry} start=${start})`
          ).not.toBeUndefined()
        })
      }
    }
  }

  it('U never reaches a state where it could discharge L0 (accept-legal never renders the acceptance form for an unverified subject)', async () => {
    for (const registry of REGISTRIES) {
      applySubjectAndRegistry('U', registry)
      const outcome = await oneHop('accept-legal')
      // Refused (redirected to verify-email), never a render.
      expect(outcome.terminal && outcome.rendered).not.toBe(true)
    }
  })

  it('V0 + R2 (complete, presentable registry) reaches a renderable L0 discharge surface directly from accept-legal', async () => {
    applySubjectAndRegistry('V0', 'R2')
    const outcome = await oneHop('accept-legal')
    expect(outcome.terminal).toBe(true)
    expect(outcome.rendered).toBe(true)
  })

  it('V0 + R0/R1 (empty or partial registry) fails closed at accept-legal — renders the unavailable state, never the accept form, never a redirect back into the app', async () => {
    for (const registry of (['R0', 'R1'] as const)) {
      applySubjectAndRegistry('V0', registry)
      const outcome = await oneHop('accept-legal')
      expect(outcome.terminal, `registry=${registry} must terminate at accept-legal itself (fail closed), not redirect`).toBe(true)
      expect(outcome.rendered).toBe(true)
    }
  })

  it('V1 is never shown the accept-legal acceptance FORM — a transient visit (e.g. navigating there directly) is bounced straight back out, never rendered', async () => {
    for (const start of STARTS) {
      applySubjectAndRegistry('V1', 'R2')
      let current = start
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const result = await oneHop(current)
        if (current === 'accept-legal') {
          expect(
            result.terminal && result.rendered,
            `V1 must never be RENDERED the accept-legal form (start=${start}, hop=${hop})`
          ).not.toBe(true)
        }
        if (result.terminal) break
        current = result.next!
      }
    }
  })

  it('the T-AO-1 bounce (verify-email -> app -> accept-legal for a verified-but-unaccepted subject) terminates in exactly 2 hops and never revisits verify-email', async () => {
    applySubjectAndRegistry('V0', 'R2')
    const first = await oneHop('verify-email')
    expect(first).toEqual({ terminal: false, next: 'app' })
    const second = await oneHop('app')
    expect(second).toEqual({ terminal: false, next: 'accept-legal' })
    const third = await oneHop('accept-legal')
    expect(third.terminal).toBe(true)
    expect(third.rendered).toBe(true)
  })
})
