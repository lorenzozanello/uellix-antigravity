// db/custody/n14-observation.ts
//
// DAG NODE N14: PHASE P1 PRESTATE OBSERVATION.
//
// Authority (DAG v1.0.0 N14): "KP-3: to_regnamespace('uellix_stella_ops') IS
// NOT NULL, BEFORE any has_schema_privilege call. KP-4: if false, STOP. KP-5:
// if true, record has_schema_privilege for USAGE as a boolean. KP-6: if KP-5
// true, REQ-2 is not performed. Then measure every OTHER prestate: role
// attributes, memberships, ownership, required privileges, prohibited
// privileges, PUBLIC-derived privileges and the pre-existing surface."
// Transaction: ONE BEGIN READ ONLY, closed by an UNCONDITIONAL ROLLBACK.
// Exit: every prestate except MR-2's is MEASURED and recorded.
// It may NOT evaluate SQ-6 or SQ-7 (the PRECHECK; mutant M20).
//
// DAG v1.0.6 rulings: the AC-1 table privileges ARE measured (successor-
// authorized, pinned); the function EXECUTE prestate is DEFERRED_TO_PRECHECK_R2
// by AC-3 and is neither issued nor required for N14's exit; AC-2's structural
// proof (rolsuper false, no membership edge as member, datdba not the auditor)
// is recorded, and its failure is already a token below.

import { runAuditorReadSession, type ReadFn, type SessionOutcome } from './auditor-read-session'
import { EP3_NAMED_ROLES, P1_STATEMENTS, ac2ReachabilityProof, issuable, type P1Id } from './p1-reads'
import type { N13Connect, Row } from './n13-verification'

export type N14Token =
  | 'STOP_STELLA_OPS_SCHEMA_ABSENT'
  | 'STOP_DANGEROUS_ROLE_ATTRIBUTE'
  | 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP'
  | 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP'
  | 'STOP_CONNECT_PRIVILEGE_ABSENT'
  | 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'

/** The body reads, in the order N14's act names them. STELLA_OPS_EXISTS (KP-3) is first. */
export const N14_BODY: readonly P1Id[] = [
  'STELLA_OPS_EXISTS',
  'SERVER_VERSION',
  'ROLE_ATTRIBUTES',
  'MEMBERSHIPS',
  'REACH',
  'OWNERSHIP',
  'DATDBA',
  'DATABASE_PRIVILEGES',
  'SCHEMA_PRIVILEGES',
  'DEFAULT_ACL',
  'TABLE_PRIVILEGES',
]

/** Named by N14's act in v1.0.0, deferred by AC-3: reported, never issued, never required. */
export const N14_DEFERRED: readonly P1Id[] = ['FUNCTION_EXECUTE']

export interface N14Prestate {
  readonly kp3StellaOpsExists: boolean
  readonly kp5StellaOpsUsage: boolean | null
  readonly kp6Req2NotPerformed: boolean | null
  readonly serverVersionNum: string | null
  readonly roleAttributes: Readonly<Record<string, unknown>> | null
  readonly membershipEdges: number
  readonly membershipEdgesAsMember: number | null
  readonly ac2Proof: { holds: boolean; failed: readonly string[] } | null
  /** AC-1: the six authorized (relation, privilege) booleans. */
  readonly tablePrivileges: Readonly<Record<string, boolean>> | null
  readonly reachableNamedRoles: readonly string[]
  readonly namedRolesPresent: readonly string[]
  readonly ownership: Readonly<Record<string, number>>
  readonly datdbaIsAuditor: boolean | null
  readonly databasePrivileges: Readonly<Record<string, boolean>> | null
  readonly schemaPrivileges: readonly { schema: string; present: boolean; usage: boolean | null; create: boolean | null }[]
  readonly defaultAclRows: number
}

export interface N14Result {
  readonly session: Omit<SessionOutcome<unknown>, 'body'>
  readonly prestate: N14Prestate | null
  readonly token: N14Token | null
  /** Named by v1.0.0 and deferred by AC-3: reported, never issued, never required. */
  readonly deferredToPrecheckR2: readonly P1Id[]
  /** N14's exit (v1.0.6): every prestate except MR-2's and the deferred EXECUTE one measured, no token, rolled back. */
  readonly exitMet: boolean
}

const one = (rows: readonly Row[]): Row => {
  if (rows.length !== 1) throw new Error('expected exactly one row')
  return rows[0]
}
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(String(v)))

/** Pure: the token N14 raises from what it measured, or null. Order follows N14's token list. */
export function n14Token(p: N14Prestate): N14Token | null {
  if (!p.kp3StellaOpsExists) return 'STOP_STELLA_OPS_SCHEMA_ABSENT'
  const a = p.roleAttributes ?? {}
  if ([a.rolsuper, a.rolbypassrls, a.rolcreatedb, a.rolcreaterole, a.rolreplication].some((v) => v !== false)) return 'STOP_DANGEROUS_ROLE_ATTRIBUTE'
  if (p.membershipEdges !== 0 || p.reachableNamedRoles.length > 0) return 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP'
  if (Object.values(p.ownership).some((n) => n !== 0) || p.datdbaIsAuditor !== false) return 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP'
  if (p.databasePrivileges?.auditor_connect !== true) return 'STOP_CONNECT_PRIVILEGE_ABSENT'
  const create = (s: string): boolean | null | undefined => p.schemaPrivileges.find((x) => x.schema === s)?.create
  if (create('uellix_stella_ops') !== false || create('public') !== false) return 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'
  const t = p.tablePrivileges
  if (t === null || ['sentinel_insert', 'sentinel_update', 'sentinel_delete', 'sentinel_truncate'].some((k) => t[k] !== false)) {
    return 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'
  }
  return null
}

async function measure(read: ReadFn): Promise<N14Prestate> {
  // KP-3 FIRST, and KP-4: an absent schema stops before anything else is read.
  const kp3 = Object.values(one(await read('STELLA_OPS_EXISTS')))[0] === true
  const empty: N14Prestate = {
    kp3StellaOpsExists: kp3,
    kp5StellaOpsUsage: null,
    kp6Req2NotPerformed: null,
    serverVersionNum: null,
    roleAttributes: null,
    membershipEdges: 0,
    membershipEdgesAsMember: null,
    ac2Proof: null,
    tablePrivileges: null,
    reachableNamedRoles: [],
    namedRolesPresent: [],
    ownership: {},
    datdbaIsAuditor: null,
    databasePrivileges: null,
    schemaPrivileges: [],
    defaultAclRows: 0,
  }
  if (!kp3) return empty

  const version = Object.values(one(await read('SERVER_VERSION')))[0]
  const attrs = one(await read('ROLE_ATTRIBUTES'))
  const memberships = await read('MEMBERSHIPS')
  const reach = await read('REACH')
  const own = one(await read('OWNERSHIP'))
  const datdba = Object.values(one(await read('DATDBA')))[0]
  const db = one(await read('DATABASE_PRIVILEGES'))
  const schemas = await read('SCHEMA_PRIVILEGES')
  const acl = await read('DEFAULT_ACL')
  const tables = one(await read('TABLE_PRIVILEGES'))

  const schemaPrivileges = schemas.map((r) => ({
    schema: String(r.schema_name),
    present: r.present === true,
    usage: typeof r.can_usage === 'boolean' ? r.can_usage : null,
    create: typeof r.can_create === 'boolean' ? r.can_create : null,
  }))
  const stellaUsage = schemaPrivileges.find((s) => s.schema === 'uellix_stella_ops')?.usage ?? null
  return {
    ...empty,
    kp5StellaOpsUsage: stellaUsage,
    kp6Req2NotPerformed: stellaUsage === true,
    serverVersionNum: typeof version === 'string' ? version : null,
    roleAttributes: attrs,
    membershipEdges: memberships.length,
    membershipEdgesAsMember: memberships.filter((r) => r.member_role === 'uellix_auditor').length,
    ac2Proof: ac2ReachabilityProof({
      rolsuper: attrs.rolsuper,
      membershipEdgesAsMember: memberships.filter((r) => r.member_role === 'uellix_auditor').length,
      datdbaIsAuditor: datdba,
    }),
    tablePrivileges: Object.fromEntries(
      ['sentinel_select', 'sentinel_insert', 'sentinel_update', 'sentinel_delete', 'sentinel_truncate', 'users_select'].map((k) => [k, tables[k] === true ? true : tables[k] === false ? false : (null as unknown as boolean)])
    ),
    reachableNamedRoles: reach.filter((r) => r.can_member === true || r.can_usage === true || r.can_set === true).map((r) => String(r.role_name)),
    namedRolesPresent: reach.map((r) => String(r.role_name)).filter((n) => (EP3_NAMED_ROLES as readonly string[]).includes(n)),
    ownership: { classes: num(own.classes), namespaces: num(own.namespaces), procs: num(own.procs), types: num(own.types) },
    datdbaIsAuditor: typeof datdba === 'boolean' ? datdba : null,
    databasePrivileges: {
      auditor_connect: db.auditor_connect === true,
      auditor_temp: db.auditor_temp === true,
      public_connect: db.public_connect === true,
      public_temp: db.public_temp === true,
    },
    schemaPrivileges,
    defaultAclRows: acl.length,
  }
}

export async function runN14Observation(params: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly connect?: N13Connect
}): Promise<N14Result> {
  const { deferred } = issuable([...N14_BODY, ...N14_DEFERRED])
  if (deferred.some((d) => N14_BODY.includes(d.id))) throw new Error('N14_BODY names a statement that is not ISSUABLE.')
  const outcome = await runAuditorReadSession({ env: params.env, connect: params.connect, bodyAllowlist: N14_BODY, body: measure })
  const { body, ...session } = outcome
  const prestate = body
  const token = prestate === null ? null : n14Token(prestate)
  return {
    session,
    prestate,
    token,
    deferredToPrecheckR2: deferred.map((d) => d.id),
    exitMet:
      outcome.failedAt === null &&
      prestate !== null &&
      prestate.kp3StellaOpsExists &&
      prestate.tablePrivileges !== null &&
      Object.values(prestate.tablePrivileges).every((v) => typeof v === 'boolean') &&
      token === null &&
      outcome.rolledBack,
  }
}

/** Exported for the statement-provenance test: every text this node can send. */
export function n14StatementTexts(): string[] {
  return ['IDENTITY', 'READ_ONLY', 'SENTINEL', ...N14_BODY].map((id) => P1_STATEMENTS[id as P1Id]).filter((s) => s.disposition === 'ISSUABLE').map((s) => s.sql)
}
