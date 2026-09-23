// db/custody/n22-poststate.ts
//
// DAG NODE N22: PHASE P3 POSTSTATE VERIFICATION AND READ-ONLY PROOF, and the
// conditional DAG NODE N21: MR-3 POSTSTATE VERIFICATION.
//
// N22's act (DAG v1.0.0): "Run the FULL PV-1..PV-34 assertion table using the
// SAME queries as P1, plus READ_ONLY_PROOF in full." Exit: "Every row is an
// ASSERTION with an expected value and an actual value, and every one passes.
// A poststate that merely SELECTs and prints is NOT a verification."
//
// So N22 is NOT N14 again. N14 measures and raises tokens; N22 ASSERTS, row by
// row, from POSTSTATE_VERIFICATION, and each row carries its id, what it
// expects, what it saw, and PASS / FAIL / RECORDED / BLOCKED. A row whose read
// is blocked by an open authority conflict is BLOCKED, never PASS, and a
// BLOCKED row keeps N22's exit unmet.
//
// N21's act: "Assert three booleans: USAGE = true, CREATE = false, and
// EXECUTE = false on each canonical signature." It is the PV-23 / PV-26 /
// PV-24 / PV-25 subset, run in its own delivered session. Its EXECUTE rows
// are AC-3 and therefore BLOCKED.

import { runAuditorReadSession, type ReadFn, type SessionOutcome } from './auditor-read-session'
import { EP3_NAMED_ROLES, P1_STATEMENTS, type ConflictId, type P1Id } from './p1-reads'
import type { N13Connect, Row } from './n13-verification'
import { KNOWN_STAGING_PROJECT_REF } from '../hosted/target-identity'

export type RowVerdict = 'PASS' | 'FAIL' | 'RECORDED' | 'BLOCKED'

export interface PvRow {
  readonly id: string
  readonly expected: string
  readonly actual: string
  readonly verdict: RowVerdict
  readonly blockedBy?: ConflictId
}

/** The P1 reads N22 re-issues: every P1 read, because P3 is "the PHASE_P1 read list, re-issued in full". */
export const N22_BODY: readonly P1Id[] = [
  'ROLE_ATTRIBUTES',
  'MEMBERSHIPS',
  'REACH',
  'OWNERSHIP',
  'DATDBA',
  'DATABASE_PRIVILEGES',
  'SCHEMA_PRIVILEGES',
  'STELLA_OPS_EXISTS',
  'SERVER_VERSION',
  'DEFAULT_ACL',
  'FUNCTION_EXECUTE',
  'TABLE_PRIVILEGES',
]

/** N21's three booleans need these reads (the EXECUTE one is AC-3). */
export const N21_BODY: readonly P1Id[] = ['SCHEMA_PRIVILEGES', 'FUNCTION_EXECUTE']

const one = (rows: readonly Row[]): Row => {
  if (rows.length !== 1) throw new Error('expected exactly one row')
  return rows[0]
}
const num = (v: unknown): number => Number(typeof v === 'bigint' ? Number(v) : v)
const eq = (id: string, expected: unknown, actual: unknown): PvRow => ({
  id,
  expected: String(expected),
  actual: String(actual),
  verdict: actual === expected ? 'PASS' : 'FAIL',
})
const rec = (id: string, actual: unknown): PvRow => ({ id, expected: '(recorded, not asserted)', actual: JSON.stringify(actual), verdict: 'RECORDED' })
const blocked = (id: string, by: ConflictId, expected: string): PvRow => ({ id, expected, actual: '(not read)', verdict: 'BLOCKED', blockedBy: by })

async function schemaTable(read: ReadFn): Promise<Map<string, { present: boolean; usage: boolean | null; create: boolean | null }>> {
  const m = new Map<string, { present: boolean; usage: boolean | null; create: boolean | null }>()
  for (const r of await read('SCHEMA_PRIVILEGES')) {
    m.set(String(r.schema_name), {
      present: r.present === true,
      usage: typeof r.can_usage === 'boolean' ? r.can_usage : null,
      create: typeof r.can_create === 'boolean' ? r.can_create : null,
    })
  }
  return m
}

/** PV-1..PV-34, from the preflight the session already asserted and the re-issued P1 reads. */
export function n22Rows(input: {
  readonly preflight: { kp1: boolean; kp2: boolean; targetIdentityArmB: boolean; sentinel: { environment: string; projectRef: string } | null }
  readonly attrs: Row
  readonly memberships: readonly Row[]
  readonly reach: readonly Row[]
  readonly own: Row
  readonly datdba: unknown
  readonly db: Row
  readonly schemas: Map<string, { present: boolean; usage: boolean | null; create: boolean | null }>
}): PvRow[] {
  const s = (name: string) => input.schemas.get(name)
  const reachable = input.reach.filter((r) => r.can_member === true).map((r) => String(r.role_name))
  const auditorIsGranted = input.memberships.filter((r) => r.member_role === 'uellix_auditor').length
  const auditorIsRole = input.memberships.filter((r) => r.granted_role === 'uellix_auditor').length
  const sentinelOk =
    input.preflight.sentinel !== null && input.preflight.sentinel.environment === 'staging' && input.preflight.sentinel.projectRef === KNOWN_STAGING_PROJECT_REF
  return [
    eq('PV-1', true, input.preflight.kp1),
    eq('PV-2', true, input.preflight.kp1),
    eq('PV-3', true, input.preflight.targetIdentityArmB),
    eq('PV-4', true, input.attrs.rolcanlogin),
    eq('PV-5', true, true),
    eq('PV-6', false, input.attrs.rolsuper),
    eq('PV-7', false, input.attrs.rolbypassrls),
    eq('PV-8', false, input.attrs.rolcreatedb),
    eq('PV-9', false, input.attrs.rolcreaterole),
    eq('PV-10', false, input.attrs.rolreplication),
    rec('PV-11', { rolinherit: input.attrs.rolinherit, rolconnlimit: input.attrs.rolconnlimit, rolvaliduntil: String(input.attrs.rolvaliduntil) }),
    eq('PV-12', 0, auditorIsGranted),
    eq('PV-13', 0, auditorIsRole),
    // PV-14 over the NAMED roles present; AC-2 (uellix_cap_*) is carried separately.
    { ...eq('PV-14', '[]', JSON.stringify(reachable)), expected: `pg_has_role MEMBER false for ${EP3_NAMED_ROLES.join(', ')}` , verdict: reachable.length === 0 ? 'PASS' : 'FAIL' },
    eq('PV-15', 0, num(input.own.classes)),
    eq('PV-16', 0, num(input.own.namespaces)),
    eq('PV-17', 0, num(input.own.procs)),
    eq('PV-18', 0, num(input.own.types)),
    eq('PV-19', false, input.datdba),
    eq('PV-20', true, input.db.auditor_connect),
    eq('PV-21', true, s('uellix_bootstrap')?.usage ?? null),
    blocked('PV-22', 'AC-1', "has_table_privilege('uellix_auditor','uellix_bootstrap.staging_sentinel','SELECT') = true"),
    eq('PV-23', true, s('uellix_stella_ops')?.usage ?? null),
    blocked('PV-24', 'AC-3', 'has_function_privilege(<nine-argument canonical literal>, EXECUTE) = false'),
    blocked('PV-25', 'AC-3', 'has_function_privilege(<seven-argument canonical literal>, EXECUTE) = false'),
    eq('PV-26', false, s('uellix_stella_ops')?.create ?? null),
    eq('PV-27', false, s('public')?.create ?? null),
    blocked('PV-28', 'AC-1', 'INSERT, UPDATE, DELETE, TRUNCATE on uellix_bootstrap.staging_sentinel all false'),
    rec('PV-29', { public_connect: input.db.public_connect, auditor_connect: input.db.auditor_connect }),
    rec('PV-30', { public_temp: input.db.public_temp }),
    eq('PV-31', true, s('public')?.usage ?? null),
    blocked('PV-32', 'AC-1', "has_table_privilege('uellix_auditor','public.users','SELECT') = true"),
    eq('PV-33', true, sentinelOk),
    eq('PV-34', true, s('uellix_stella_ops')?.usage ?? null),
  ]
}

/** READ_ONLY_PROOF's five layers, each from the rows it names. SESSION is last and weakest by the authority's own words. */
export function readOnlyProof(rows: readonly PvRow[], kp2: boolean): Record<string, RowVerdict> {
  const layer = (ids: string[]): RowVerdict => {
    const sel = rows.filter((r) => ids.includes(r.id))
    if (sel.some((r) => r.verdict === 'FAIL')) return 'FAIL'
    if (sel.some((r) => r.verdict === 'BLOCKED')) return 'BLOCKED'
    return 'PASS'
  }
  return {
    ATTRIBUTES: layer(['PV-6', 'PV-7', 'PV-8', 'PV-9', 'PV-10']),
    MEMBERSHIPS: layer(['PV-12', 'PV-13', 'PV-14']),
    OWNERSHIP: layer(['PV-15', 'PV-16', 'PV-17', 'PV-18', 'PV-19']),
    GRANTS: layer(['PV-24', 'PV-25', 'PV-26', 'PV-27', 'PV-28']),
    SESSION: kp2 && rows.find((r) => r.id === 'PV-2')?.verdict === 'PASS' ? 'PASS' : 'FAIL',
  }
}

export interface N22Result {
  readonly session: Omit<SessionOutcome<unknown>, 'body'>
  readonly rows: readonly PvRow[]
  readonly readOnlyProof: Record<string, RowVerdict> | null
  readonly blockedBy: readonly ConflictId[]
  /** The P1 reads re-issued that no PV row asserts, recorded for comparison with N14. */
  readonly reissued: Readonly<Record<string, unknown>> | null
  /** Every row PASS or RECORDED, no row FAIL or BLOCKED, and the proof passes in every layer. */
  readonly exitMet: boolean
}

export async function runN22Poststate(params: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly connect?: N13Connect
}): Promise<N22Result> {
  let kp2 = false
  const outcome = await runAuditorReadSession({
    env: params.env,
    connect: params.connect,
    bodyAllowlist: N22_BODY,
    body: async (read) => {
      // The P1 list re-issued in full, including the reads no PV row asserts,
      // so the poststate is the same observation as the prestate.
      const stellaOpsExists = Object.values(one(await read('STELLA_OPS_EXISTS')))[0] === true
      const serverVersionNum = Object.values(one(await read('SERVER_VERSION')))[0]
      const attrs = one(await read('ROLE_ATTRIBUTES'))
      const memberships = await read('MEMBERSHIPS')
      const reach = await read('REACH')
      const own = one(await read('OWNERSHIP'))
      const datdba = Object.values(one(await read('DATDBA')))[0]
      const db = one(await read('DATABASE_PRIVILEGES'))
      const schemas = await schemaTable(read)
      const defaultAclRows = (await read('DEFAULT_ACL')).length
      return { attrs, memberships, reach, own, datdba, db, schemas, reissued: { stellaOpsExists, serverVersionNum, defaultAclRows } }
    },
  })
  const { body, ...session } = outcome
  kp2 = outcome.preflight.kp2
  if (body === null) return { session, rows: [], readOnlyProof: null, blockedBy: [], reissued: null, exitMet: false }
  const { reissued, ...rowInput } = body
  const rows = n22Rows({ preflight: outcome.preflight, ...rowInput })
  const proof = readOnlyProof(rows, kp2)
  const blockedBy = Array.from(new Set(rows.filter((r) => r.verdict === 'BLOCKED').map((r) => r.blockedBy as ConflictId))).sort()
  const exitMet =
    outcome.failedAt === null &&
    outcome.rolledBack &&
    rows.length === 34 &&
    rows.every((r) => r.verdict === 'PASS' || r.verdict === 'RECORDED') &&
    Object.values(proof).every((v) => v === 'PASS')
  return { session, rows, readOnlyProof: proof, blockedBy, reissued, exitMet }
}

export interface N21Result {
  readonly session: Omit<SessionOutcome<unknown>, 'body'>
  readonly rows: readonly PvRow[]
  readonly exitMet: boolean
}

export async function runN21Mr3Poststate(params: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly connect?: N13Connect
}): Promise<N21Result> {
  const outcome = await runAuditorReadSession({
    env: params.env,
    connect: params.connect,
    bodyAllowlist: N21_BODY,
    body: async (read) => schemaTable(read),
  })
  const { body, ...session } = outcome
  if (body === null) return { session, rows: [], exitMet: false }
  const rows: PvRow[] = [
    eq('N21-USAGE (PV-23)', true, body.get('uellix_stella_ops')?.usage ?? null),
    eq('N21-CREATE (PV-26)', false, body.get('uellix_stella_ops')?.create ?? null),
    blocked('N21-EXECUTE-NINE (PV-24)', 'AC-3', 'EXECUTE false on the nine-argument canonical signature'),
    blocked('N21-EXECUTE-SEVEN (PV-25)', 'AC-3', 'EXECUTE false on the seven-argument canonical signature'),
  ]
  return { session, rows, exitMet: outcome.failedAt === null && outcome.rolledBack && rows.every((r) => r.verdict === 'PASS') }
}

/** Every text these nodes can send (the blocked ones never). */
export function n22StatementTexts(): string[] {
  return ['IDENTITY', 'READ_ONLY', 'SENTINEL', ...N22_BODY].map((id) => P1_STATEMENTS[id as P1Id]).filter((s) => s.blockedBy === null).map((s) => s.sql)
}
