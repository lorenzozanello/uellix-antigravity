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
// row, from POSTSTATE_VERIFICATION.
//
// DAG v1.0.6 rulings, as they reach this file:
//   AC-1  PV-22, PV-28 and PV-32 are real assertions over the successor-pinned
//         TABLE_PRIVILEGES read (owner decision), re-issued here, never copied
//         from N14.
//   AC-2  PV-14 passes only if the NAMED roles are unreachable AND the
//         structural proof holds (rolsuper false, no membership edge with the
//         auditor as member, datdba not the auditor). No enumeration.
//   AC-3  PV-24 and PV-25 carry DEFERRED_TO_PRECHECK_R2. It is NOT a pass: it
//         is a fourth verdict, allowed only on the rows the ruling names, and
//         N22's exit neither requires nor counts it.
//
// THE VERDICT VOCABULARY IS CLOSED: PASS, FAIL, RECORDED, DEFERRED_TO_PRECHECK_R2.
//
// N21's act: "Assert three booleans: USAGE = true, CREATE = false, and
// EXECUTE = false on each canonical signature." Under AC-3 the EXECUTE rows are
// DEFERRED_TO_PRECHECK_R2 and N21's exit is USAGE and CREATE.

import { runAuditorReadSession, type ReadFn, type SessionOutcome, type SessionPreflight } from './auditor-read-session'
import { AUDITOR, EP3_NAMED_ROLES, P1_STATEMENTS, ac2ReachabilityProof, type P1Id } from './p1-reads'
import type { N13Connect, Row } from './n13-verification'
import { KNOWN_STAGING_PROJECT_REF } from '../hosted/target-identity'

export type RowVerdict = 'PASS' | 'FAIL' | 'RECORDED' | 'DEFERRED_TO_PRECHECK_R2'

/** The ONLY rows AC-3 lets carry DEFERRED_TO_PRECHECK_R2. */
export const AC3_DEFERRED_ROWS: readonly string[] = ['PV-24', 'PV-25', 'N21-EXECUTE-NINE (PV-24)', 'N21-EXECUTE-SEVEN (PV-25)']

export interface PvRow {
  readonly id: string
  readonly expected: string
  readonly actual: string
  readonly verdict: RowVerdict
}

/** N22's tokens (DAG v1.0.0 N22.tokens), by the rows whose failure the authority names them for. */
export type N22Token =
  | 'STOP_DANGEROUS_ROLE_ATTRIBUTE'
  | 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP'
  | 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP'
  | 'STOP_CONNECT_PRIVILEGE_ABSENT'
  | 'STOP_PRE_EXISTING_SURFACE_CHANGED'
  | 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'

const TOKEN_FOR_ROW: Readonly<Record<string, N22Token>> = {
  'PV-6': 'STOP_DANGEROUS_ROLE_ATTRIBUTE',
  'PV-7': 'STOP_DANGEROUS_ROLE_ATTRIBUTE',
  'PV-8': 'STOP_DANGEROUS_ROLE_ATTRIBUTE',
  'PV-9': 'STOP_DANGEROUS_ROLE_ATTRIBUTE',
  'PV-10': 'STOP_DANGEROUS_ROLE_ATTRIBUTE',
  'PV-12': 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP',
  'PV-13': 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP',
  'PV-14': 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP',
  'PV-15': 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP',
  'PV-16': 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP',
  'PV-17': 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP',
  'PV-18': 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP',
  'PV-19': 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP',
  'PV-20': 'STOP_CONNECT_PRIVILEGE_ABSENT',
  'PV-26': 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE',
  'PV-27': 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE',
  'PV-28': 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE',
  'PV-31': 'STOP_PRE_EXISTING_SURFACE_CHANGED',
  'PV-32': 'STOP_PRE_EXISTING_SURFACE_CHANGED',
}

/**
 * The tokens a set of rows raises, in row order. A FAIL row with no token in
 * N22's list is reported by row id with token null — no token is invented.
 */
export function n22Tokens(rows: readonly PvRow[]): { tokens: N22Token[]; failedWithoutToken: string[] } {
  const tokens: N22Token[] = []
  const failedWithoutToken: string[] = []
  for (const r of rows.filter((x) => x.verdict === 'FAIL')) {
    const t = TOKEN_FOR_ROW[r.id]
    if (t === undefined) failedWithoutToken.push(r.id)
    else if (!tokens.includes(t)) tokens.push(t)
  }
  return { tokens, failedWithoutToken }
}

/** The P1 reads N22 re-issues: every ISSUABLE P1 read, because P3 is "the PHASE_P1 read list, re-issued in full". */
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
  'TABLE_PRIVILEGES',
]

/** N21's reads: only what USAGE and CREATE need (EXECUTE is deferred by AC-3). */
export const N21_BODY: readonly P1Id[] = ['SCHEMA_PRIVILEGES']

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
const deferred = (id: string, expected: string): PvRow => {
  if (!AC3_DEFERRED_ROWS.includes(id)) throw new Error(`${id} is not a row AC-3 defers`)
  return { id, expected, actual: '(not read in this DAG: DEFERRED_TO_PRECHECK_R2 by AC-3)', verdict: 'DEFERRED_TO_PRECHECK_R2' }
}

type SchemaTable = Map<string, { present: boolean; usage: boolean | null; create: boolean | null }>

async function schemaTable(read: ReadFn): Promise<SchemaTable> {
  const m: SchemaTable = new Map()
  for (const r of await read('SCHEMA_PRIVILEGES')) {
    m.set(String(r.schema_name), {
      present: r.present === true,
      usage: typeof r.can_usage === 'boolean' ? r.can_usage : null,
      create: typeof r.can_create === 'boolean' ? r.can_create : null,
    })
  }
  return m
}

/** PV-1..PV-34, from the preflight the session asserted and the re-issued reads. */
export function n22Rows(input: {
  readonly preflight: Pick<SessionPreflight, 'connected' | 'kp1' | 'targetIdentityArmB' | 'sentinel' | 'identity'>
  readonly attrs: Row
  readonly memberships: readonly Row[]
  readonly reach: readonly Row[]
  readonly own: Row
  readonly datdba: unknown
  readonly db: Row
  readonly schemas: SchemaTable
  readonly tables: Row
}): PvRow[] {
  const s = (name: string) => input.schemas.get(name)
  const reachable = input.reach.filter((r) => r.can_member === true || r.can_usage === true || r.can_set === true).map((r) => String(r.role_name))
  const asMember = input.memberships.filter((r) => r.member_role === AUDITOR).length
  const asRole = input.memberships.filter((r) => r.granted_role === AUDITOR).length
  const proof = ac2ReachabilityProof({ rolsuper: input.attrs.rolsuper, membershipEdgesAsMember: asMember, datdbaIsAuditor: input.datdba })
  const sentinelOk =
    input.preflight.sentinel !== null && input.preflight.sentinel.environment === 'staging' && input.preflight.sentinel.projectRef === KNOWN_STAGING_PROJECT_REF
  const t = input.tables
  return [
    eq('PV-1', AUDITOR, input.preflight.identity?.currentUser ?? null),
    eq('PV-2', AUDITOR, input.preflight.identity?.sessionUser ?? null),
    eq('PV-3', true, input.preflight.targetIdentityArmB),
    eq('PV-4', true, input.attrs.rolcanlogin),
    // PV-5 is a FACT distinct from PV-4: a session was opened AND the server answered KP-1 for it.
    eq('PV-5', true, input.preflight.connected && input.preflight.identity !== null),
    eq('PV-6', false, input.attrs.rolsuper),
    eq('PV-7', false, input.attrs.rolbypassrls),
    eq('PV-8', false, input.attrs.rolcreatedb),
    eq('PV-9', false, input.attrs.rolcreaterole),
    eq('PV-10', false, input.attrs.rolreplication),
    rec('PV-11', { rolinherit: input.attrs.rolinherit, rolconnlimit: input.attrs.rolconnlimit, rolvaliduntil: String(input.attrs.rolvaliduntil) }),
    eq('PV-12', 0, asMember),
    eq('PV-13', 0, asRole),
    {
      id: 'PV-14',
      expected: `pg_has_role false for ${EP3_NAMED_ROLES.join(', ')} AND the AC-2 structural proof holds (so false for every other role)`,
      actual: JSON.stringify({ reachableNamedRoles: reachable, ac2ProofFailed: proof.failed }),
      verdict: reachable.length === 0 && proof.holds ? 'PASS' : 'FAIL',
    },
    eq('PV-15', 0, num(input.own.classes)),
    eq('PV-16', 0, num(input.own.namespaces)),
    eq('PV-17', 0, num(input.own.procs)),
    eq('PV-18', 0, num(input.own.types)),
    eq('PV-19', false, input.datdba),
    eq('PV-20', true, input.db.auditor_connect),
    eq('PV-21', true, s('uellix_bootstrap')?.usage ?? null),
    eq('PV-22', true, t.sentinel_select),
    eq('PV-23', true, s('uellix_stella_ops')?.usage ?? null),
    deferred('PV-24', 'has_function_privilege(<nine-argument canonical literal>, EXECUTE) = false'),
    deferred('PV-25', 'has_function_privilege(<seven-argument canonical literal>, EXECUTE) = false'),
    eq('PV-26', false, s('uellix_stella_ops')?.create ?? null),
    eq('PV-27', false, s('public')?.create ?? null),
    {
      id: 'PV-28',
      expected: 'INSERT, UPDATE, DELETE, TRUNCATE on uellix_bootstrap.staging_sentinel all false',
      actual: JSON.stringify({ insert: t.sentinel_insert, update: t.sentinel_update, delete: t.sentinel_delete, truncate: t.sentinel_truncate }),
      verdict: [t.sentinel_insert, t.sentinel_update, t.sentinel_delete, t.sentinel_truncate].every((v) => v === false) ? 'PASS' : 'FAIL',
    },
    rec('PV-29', { public_connect: input.db.public_connect, auditor_connect: input.db.auditor_connect }),
    rec('PV-30', { public_temp: input.db.public_temp }),
    eq('PV-31', true, s('public')?.usage ?? null),
    eq('PV-32', true, t.users_select),
    eq('PV-33', true, sentinelOk),
    eq('PV-34', true, s('uellix_stella_ops')?.usage ?? null),
  ]
}

export interface ProofLayer {
  readonly verdict: 'PASS' | 'FAIL'
  readonly deferredRows: readonly string[]
}

/** READ_ONLY_PROOF's five layers. A deferred row is listed, never counted as a pass or a failure. SESSION is last and weakest. */
export function readOnlyProof(rows: readonly PvRow[], kp2: boolean): Record<string, ProofLayer> {
  const layer = (ids: string[]): ProofLayer => {
    const sel = rows.filter((r) => ids.includes(r.id))
    const asserted = sel.filter((r) => r.verdict !== 'DEFERRED_TO_PRECHECK_R2')
    const ok = sel.length === ids.length && asserted.length > 0 && asserted.every((r) => r.verdict === 'PASS')
    return { verdict: ok ? 'PASS' : 'FAIL', deferredRows: sel.filter((r) => r.verdict === 'DEFERRED_TO_PRECHECK_R2').map((r) => r.id) }
  }
  return {
    ATTRIBUTES: layer(['PV-6', 'PV-7', 'PV-8', 'PV-9', 'PV-10']),
    MEMBERSHIPS: layer(['PV-12', 'PV-13', 'PV-14']),
    OWNERSHIP: layer(['PV-15', 'PV-16', 'PV-17', 'PV-18', 'PV-19']),
    GRANTS: layer(['PV-24', 'PV-25', 'PV-26', 'PV-27', 'PV-28']),
    SESSION: { verdict: kp2 && rows.find((r) => r.id === 'PV-2')?.verdict === 'PASS' ? 'PASS' : 'FAIL', deferredRows: [] },
  }
}

/**
 * N22's exit, from its rows alone (pure, so a control can feed it any row set):
 * all 34 rows present; every row PASS or RECORDED, except that the rows AC-3
 * names may be DEFERRED_TO_PRECHECK_R2; no FAIL; every proof layer PASS.
 */
export function n22ExitFromRows(rows: readonly PvRow[], kp2: boolean): boolean {
  if (rows.length !== 34) return false
  const rowsOk = rows.every((r) => r.verdict === 'PASS' || r.verdict === 'RECORDED' || (r.verdict === 'DEFERRED_TO_PRECHECK_R2' && AC3_DEFERRED_ROWS.includes(r.id)))
  return rowsOk && Object.values(readOnlyProof(rows, kp2)).every((l) => l.verdict === 'PASS')
}

export interface N22Result {
  readonly session: Omit<SessionOutcome<unknown>, 'body'>
  readonly rows: readonly PvRow[]
  readonly readOnlyProof: Record<string, ProofLayer> | null
  readonly tokens: readonly N22Token[]
  readonly failedWithoutToken: readonly string[]
  readonly deferredToPrecheckR2: readonly string[]
  /** The P1 reads re-issued that no PV row asserts, recorded for comparison with N14. */
  readonly reissued: Readonly<Record<string, unknown>> | null
  readonly exitMet: boolean
}

export async function runN22Poststate(params: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly connect?: N13Connect
}): Promise<N22Result> {
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
      const tables = one(await read('TABLE_PRIVILEGES'))
      return { attrs, memberships, reach, own, datdba, db, schemas, tables, reissued: { stellaOpsExists, serverVersionNum, defaultAclRows } }
    },
  })
  const { body, ...session } = outcome
  if (body === null) return { session, rows: [], readOnlyProof: null, tokens: [], failedWithoutToken: [], deferredToPrecheckR2: [], reissued: null, exitMet: false }
  const { reissued, ...rowInput } = body
  const rows = n22Rows({ preflight: outcome.preflight, ...rowInput })
  const { tokens, failedWithoutToken } = n22Tokens(rows)
  return {
    session,
    rows,
    readOnlyProof: readOnlyProof(rows, outcome.preflight.kp2),
    tokens,
    failedWithoutToken,
    deferredToPrecheckR2: rows.filter((r) => r.verdict === 'DEFERRED_TO_PRECHECK_R2').map((r) => r.id),
    reissued,
    exitMet: outcome.failedAt === null && outcome.rolledBack && n22ExitFromRows(rows, outcome.preflight.kp2),
  }
}

export interface N21Result {
  readonly session: Omit<SessionOutcome<unknown>, 'body'>
  readonly rows: readonly PvRow[]
  readonly exitMet: boolean
}

/** N21's exit from its rows: USAGE and CREATE PASS; the EXECUTE rows exactly DEFERRED_TO_PRECHECK_R2. */
export function n21ExitFromRows(rows: readonly PvRow[]): boolean {
  const by = (id: string) => rows.find((r) => r.id === id)?.verdict
  return (
    rows.length === 4 &&
    by('N21-USAGE (PV-23)') === 'PASS' &&
    by('N21-CREATE (PV-26)') === 'PASS' &&
    by('N21-EXECUTE-NINE (PV-24)') === 'DEFERRED_TO_PRECHECK_R2' &&
    by('N21-EXECUTE-SEVEN (PV-25)') === 'DEFERRED_TO_PRECHECK_R2'
  )
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
    deferred('N21-EXECUTE-NINE (PV-24)', 'EXECUTE false on the nine-argument canonical signature'),
    deferred('N21-EXECUTE-SEVEN (PV-25)', 'EXECUTE false on the seven-argument canonical signature'),
  ]
  return { session, rows, exitMet: outcome.failedAt === null && outcome.rolledBack && n21ExitFromRows(rows) }
}

/** Every text these nodes can send (only ISSUABLE ones). */
export function n22StatementTexts(): string[] {
  return ['IDENTITY', 'READ_ONLY', 'SENTINEL', ...N22_BODY].map((id) => P1_STATEMENTS[id as P1Id]).filter((s) => s.disposition === 'ISSUABLE').map((s) => s.sql)
}
