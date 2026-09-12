// tests/auth/accept-legal-submission-binding.test.ts
//
// CL-1 (HPO-ODS-W2-28) — independent-certification NON_BLOCKING D-1 repair:
// "No control proves a submitted instrumentVersionId is bound to the
// server-derived pending set." A client can submit ANY id in the
// `instrumentVersionId` hidden field it wants — this suite proves
// acceptRequiredLegalInstruments (app/(public)/accept-legal/actions.ts)
// trusts none of them except the ones the server itself, at submission time,
// derives via the REAL loadRequiredInstrumentsPendingAcceptance
// (lib/auth/legal-acceptance.ts) — the SAME resolver CL1-S3 used to render
// the form.
//
// Adversarial cases (Section 4 of the CL-1 certification remediation
// authority): historical/superseded version id, arbitrary forged UUID,
// valid-but-not-pending version, duplicate id in one submission, partial
// required set, stale-page-then-registry-changed, the fully correct set,
// a no-longer-presentable (digest-failing) version, and client-tampered
// auxiliary form values.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const CONTENT_BYTES = 'contenido sintético v1'
const CONTENT_DIGEST = 'sha256:' + createHash('sha256').update(CONTENT_BYTES, 'utf8').digest('hex')
const CONTENT_BYTES_V2 = 'contenido sintético v2'
const CONTENT_DIGEST_V2 = 'sha256:' + createHash('sha256').update(CONTENT_BYTES_V2, 'utf8').digest('hex')

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

vi.mock('@/lib/auth/selected-organization', () => ({
  getSelectedOrganizationId: vi.fn(async () => null),
  SELECTED_ORGANIZATION_COOKIE_NAME: 'uellix_selected_organization_id',
}))

vi.mock('@/lib/audit/tenancy-refusal', () => ({
  emitMembershipRevalidationRefused: vi.fn(async () => undefined),
}))

interface AuditEntry {
  actorUserId: string
  entityType: string
  entityId: string
  action: string
  afterJson: { instrumentKey: string; version: number; contentDigest: string }
}
const auditEntries: AuditEntry[] = []
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(async (entry: AuditEntry) => {
    auditEntries.push(entry)
  }),
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

interface SqlChunk { __type: 'sql'; text: string }

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown) => ({ __type: 'eq', columnName: column.name, value }),
  and: (...conditions: unknown[]) => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }) => ({ __type: 'isNull', columnName: column.name }),
  sql: Object.assign(
    (strings: TemplateStringsArray): SqlChunk => ({ __type: 'sql', text: strings.join(' ? ') }),
    {
      join: (parts: SqlChunk[], sep: SqlChunk): SqlChunk => ({
        __type: 'sql',
        text: parts.map((p) => p.text).join(sep.text),
      }),
    }
  ),
}))

interface EqCondition { __type: 'eq'; columnName: string; value: unknown }
interface AndCondition { __type: 'and'; conditions: unknown[] }
interface IsNullCondition { __type: 'isNull'; columnName: string }
type Condition = EqCondition | AndCondition | IsNullCondition

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

const USER_ID = '44444444-4444-4444-8444-444444444444'
const USER_ROW = { id: USER_ID, email: 'submitter@example.test', isSuperAdmin: false, deletedAt: null }
const TABLES: { users: Array<Record<string, unknown>> } = { users: [USER_ROW] }

/** The server-side truth at the moment the ACTION runs — set fresh per test,
 * deliberately independent of whatever a test's "page load" snapshot was. */
let accountAcceptanceCurrent = false
let pendingRows: Array<{
  instrument_key: string
  instrument_version_id: string
  version: number
  locale: string
  content_digest: string
  content_bytes: string | null
}> = []

/** Real conflict tracking, so onConflictDoNothing genuinely no-ops on a
 * second identical (userId, instrumentVersionId) pair — required to prove
 * the "duplicate id in one submission" case is idempotent, not double-audited. */
const existingAcceptances = new Set<string>()
const insertedRows: Array<{ userId: string; instrumentVersionId: string; contentDigest: string }> = []

const mockExecute = vi.fn(async (query: SqlChunk) => {
  const text = query.text
  if (text.includes('all_current')) return [{ all_current: accountAcceptanceCurrent }]
  if (text.includes('DISTINCT ON')) return pendingRows
  throw new Error(`accept-legal-submission-binding: unrecognised db.execute call: ${text}`)
})

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
        const tableName = tableNameOf(table)
        const data = tableName === 'users' ? TABLES.users : []
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
      values: (row: { userId: string; instrumentVersionId: string; contentDigest: string }) => ({
        onConflictDoNothing: () => ({
          returning: () => ({
            then: (cb: (rows: unknown[]) => unknown) => {
              const key = `${row.userId}:${row.instrumentVersionId}`
              if (existingAcceptances.has(key)) return Promise.resolve(cb([]))
              existingAcceptances.add(key)
              insertedRows.push({ ...row })
              return Promise.resolve(cb([{ id: `generated-${insertedRows.length}` }]))
            },
          }),
        }),
      }),
    })),
  },
}))

import { acceptRequiredLegalInstruments } from '@/app/(public)/accept-legal/actions'

function signedInVerified(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: USER_ID, email_confirmed_at: '2024-01-01T00:00:00.000Z' } },
    error: null,
  })
}

async function submit(instrumentVersionIds: string[], extraFields?: Record<string, string>): Promise<string> {
  const formData = new FormData()
  for (const id of instrumentVersionIds) formData.append('instrumentVersionId', id)
  if (extraFields) for (const [k, v] of Object.entries(extraFields)) formData.set(k, v)
  try {
    await acceptRequiredLegalInstruments(formData)
    throw new Error('expected a redirect')
  } catch (error) {
    const message = (error as Error).message
    if (!message.startsWith('REDIRECT:')) throw error
    return message.slice('REDIRECT:'.length)
  }
}

const TERMS_V1_ID = 'v-terms-1'
const TERMS_V2_ID = 'v-terms-2'
const PRIVACY_V1_ID = 'v-privacy-1'
const UNPRESENTABLE_ID = 'v-terms-unpresentable'

function termsCandidate(id: string, version: number, digest: string, bytes: string | null) {
  return {
    instrument_key: 'terms_of_service',
    instrument_version_id: id,
    version,
    locale: 'es',
    content_digest: digest,
    content_bytes: bytes,
  }
}
function privacyCandidate(id: string, version: number, digest: string, bytes: string | null) {
  return {
    instrument_key: 'privacy_policy',
    instrument_version_id: id,
    version,
    locale: 'es',
    content_digest: digest,
    content_bytes: bytes,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRedirect.mockClear()
  TABLES.users = [USER_ROW]
  accountAcceptanceCurrent = false
  pendingRows = []
  existingAcceptances.clear()
  insertedRows.length = 0
  auditEntries.length = 0
  signedInVerified()
})

describe('D-1: instrumentVersionId submission binding — server-derived pending set is the ONLY authority', () => {
  it('accepts the fully correct set: every submitted id is in the server-derived pending set', async () => {
    pendingRows = [
      termsCandidate(TERMS_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES),
      privacyCandidate(PRIVACY_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES),
    ]
    const location = await submit([TERMS_V1_ID, PRIVACY_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(2)
    expect(insertedRows.map((r) => r.instrumentVersionId).sort()).toEqual([PRIVACY_V1_ID, TERMS_V1_ID].sort())
    expect(auditEntries).toHaveLength(2)
  })

  it('refuses a historical/superseded version id — DISTINCT ON only ever surfaces the latest version per key', async () => {
    // The registry has moved on: v2 is now the only candidate for
    // terms_of_service. v1 no longer appears in the server-derived set at
    // all, exactly as a real superseded version would not.
    pendingRows = [termsCandidate(TERMS_V2_ID, 2, CONTENT_DIGEST_V2, CONTENT_BYTES_V2)]
    const location = await submit([TERMS_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(0)
    expect(auditEntries).toHaveLength(0)
  })

  it('refuses an arbitrary forged UUID with no basis in the registry at all', async () => {
    pendingRows = [termsCandidate(TERMS_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES)]
    const location = await submit(['ffffffff-ffff-4fff-8fff-ffffffffffff'])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(0)
    expect(auditEntries).toHaveLength(0)
  })

  it('refuses a valid-but-not-pending version (already accepted, or otherwise absent from the server-derived set)', async () => {
    // terms_of_service is already current for this subject — the resolver's
    // own NOT EXISTS(account_legal_acceptances) clause excludes it, so it is
    // simply absent from pendingRows, exactly like an already-accepted row.
    pendingRows = [privacyCandidate(PRIVACY_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES)]
    const location = await submit([TERMS_V1_ID, PRIVACY_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].instrumentVersionId).toBe(PRIVACY_V1_ID)
    expect(auditEntries).toHaveLength(1)
  })

  it('a duplicate id within one submission is idempotent: exactly one insert, exactly one audit entry', async () => {
    pendingRows = [termsCandidate(TERMS_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES)]
    const location = await submit([TERMS_V1_ID, TERMS_V1_ID, TERMS_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(1)
    expect(auditEntries).toHaveLength(1)
  })

  it('a partial required set is honoured exactly: only the submitted, pending id is recorded', async () => {
    pendingRows = [
      termsCandidate(TERMS_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES),
      privacyCandidate(PRIVACY_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES),
    ]
    const location = await submit([TERMS_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].instrumentVersionId).toBe(TERMS_V1_ID)
  })

  it('stale-page-then-registry-changed: a v1 id valid when the page was rendered is refused once the server-derived set has moved to v2', async () => {
    // Simulates the page having been rendered against v1 (never read here —
    // the action re-derives independently), then the registry publishing v2
    // BEFORE the submission reaches the server.
    pendingRows = [termsCandidate(TERMS_V2_ID, 2, CONTENT_DIGEST_V2, CONTENT_BYTES_V2)]
    const location = await submit([TERMS_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(0)
    expect(auditEntries).toHaveLength(0)
  })

  it('refuses a no-longer-presentable version — one whose retained bytes fail digest re-verification is excluded from the pending set it never trusted', async () => {
    // content_bytes present but does NOT match content_digest — exactly the
    // fail-closed case loadRequiredInstrumentsPendingAcceptance already
    // excludes for display; the action inherits that same exclusion because
    // it consumes the SAME resolver, not a parallel one.
    pendingRows = [termsCandidate(UNPRESENTABLE_ID, 1, CONTENT_DIGEST, 'tampered bytes that do not hash to the digest')]
    const location = await submit([UNPRESENTABLE_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(0)
    expect(auditEntries).toHaveLength(0)
  })

  it('ignores client-tampered auxiliary form values — the persisted audit record is always the SERVER-derived instrumentKey/version/contentDigest, never a client-supplied one', async () => {
    pendingRows = [termsCandidate(TERMS_V1_ID, 1, CONTENT_DIGEST, CONTENT_BYTES)]
    const location = await submit([TERMS_V1_ID], {
      instrumentKey: 'privacy_policy',
      version: '999',
      contentDigest: 'sha256:' + '0'.repeat(64),
    })
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].contentDigest).toBe(CONTENT_DIGEST)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0].afterJson).toEqual({
      instrumentKey: 'terms_of_service',
      version: 1,
      contentDigest: CONTENT_DIGEST,
    })
  })

  it('an empty server-derived pending set (already current, or registry emptied between page load and submission) refuses every submitted id', async () => {
    pendingRows = []
    const location = await submit([TERMS_V1_ID, PRIVACY_V1_ID])
    expect(location).toBe('/app/dashboard')
    expect(insertedRows).toHaveLength(0)
    expect(auditEntries).toHaveLength(0)
  })
})
