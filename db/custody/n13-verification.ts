// db/custody/n13-verification.ts
//
// DAG NODE N13: THE FIRST AUTHENTICATED SESSION, KP-1, KP-2 AND TARGET
// IDENTITY ARM B — the production consumer of the delivered D-1 auditor
// credential.
//
// Under DAG amendment v1.0.4 this node also carries the USABILITY proof that
// N11's original exit condition asked for ("a connection opens as
// uellix_auditor using the new value and the SERVER reports current_user =
// session_user = 'uellix_auditor"). The assertion is the same one, KP-1, made
// by the same server; it moved to the first node at which a governed process
// can hold the value at all.
//
// WHAT THIS MODULE IS, AND WHAT IT IS NOT
//
//   - It reads the value ONLY from UELLIX_AUDITOR_DATABASE_URL, through
//     resolveAuditorDatabaseUrl, i.e. only as the N05 delivery path left it.
//   - It never takes the value as an argument, never logs it, never returns
//     it, and never writes it anywhere. The result it returns is booleans,
//     codes and the pinned statement texts.
//   - It decides the target identity from the URL's HOST before any socket is
//     opened, and again, completely, from the in-database sentinel after.
//   - It opens a session only through an injected transport. The default
//     transport REFUSES: a session is opened only by the entry point's
//     explicit execute mode, which a later, separately authorized lane runs.
//
// THE STATEMENTS ARE PINNED. Every text below is a verbatim member of
// AUTHORIZED_FUTURE_SQL.PHASE_P1_OBSERVATION_ONLY_READS (or the P1 transaction
// shape's BEGIN READ ONLY / ROLLBACK), and nothing is composed at run time.

import { resolveAuditorDatabaseUrl, CapabilityDatabaseUrlError } from '../safety/resolve-capability-database-url'
import { AUDITOR_DATABASE_ROLE } from '../safety/database-role'
import {
  KNOWN_STAGING_PROJECT_REF,
  deriveConnectionIdentity,
  verifyStagingTarget,
  KNOWN_PRODUCTION_IDENTIFIERS,
  type StagingSentinel,
} from '../hosted/target-identity'

export const N13_STATEMENTS = {
  BEGIN: 'BEGIN READ ONLY',
  KP1: 'SELECT current_user, session_user',
  KP2: "SELECT current_setting('transaction_read_only')",
  SENTINEL: 'SELECT environment, project_ref FROM uellix_bootstrap.staging_sentinel',
  ROLLBACK: 'ROLLBACK',
} as const

/** The exact order a passing N13 issues its statements in. */
export const N13_STATEMENT_ORDER = [
  N13_STATEMENTS.BEGIN,
  N13_STATEMENTS.KP1,
  N13_STATEMENTS.KP2,
  N13_STATEMENTS.SENTINEL,
  N13_STATEMENTS.ROLLBACK,
] as const

export type Row = Readonly<Record<string, unknown>>

export interface N13Transport {
  query(sql: string): Promise<readonly Row[]>
  close(): Promise<void>
}

/** Opens ONE session. Receives the URL; must never echo it. */
export type N13Connect = (url: string) => Promise<N13Transport>

export class N13ConnectRefused extends Error {
  readonly code = 'N13_CONNECT_NOT_AUTHORIZED_IN_THIS_MODE'
  constructor() {
    super('No session is opened in this mode. A session is opened only by the explicit execute mode of a separately authorized lane.')
  }
}

/** The default: never opens anything. */
export const refuseToConnect: N13Connect = async () => {
  throw new N13ConnectRefused()
}

export type N13Token = 'STOP_AUDITOR_AUTHENTICATION_FAILED' | 'STOP_TARGET_IDENTITY_CONTRADICTION'

export type N13FailedAt =
  | 'RESOLVE'
  | 'PRE_CONNECT_IDENTITY'
  | 'CONNECT'
  | 'BEGIN'
  | 'KP-1'
  | 'KP-2'
  | 'SENTINEL_SHAPE'
  | 'TARGET_IDENTITY_ARM_B'

export interface N13Result {
  readonly ok: boolean
  readonly failedAt: N13FailedAt | null
  /** The node's own token, when the failure has one. KP-2 has none (declared, not invented). */
  readonly token: N13Token | null
  /** A stable code, never a message from the driver or the server. */
  readonly code: string | null
  readonly connected: boolean
  readonly kp1: boolean
  readonly kp2: boolean
  readonly sentinelOneRowTwoColumns: boolean
  readonly targetIdentityArmB: boolean
  readonly rolledBack: boolean
  /** The pinned statements actually issued, in order. Evidence, not secret. */
  readonly statementsIssued: readonly string[]
}

// ---------------------------------------------------------------------------
// PURE ROW ASSERTIONS. Exported so each is testable without a database.
// ---------------------------------------------------------------------------

const sameKeys = (row: Row, keys: readonly string[]): boolean => {
  const actual = Object.keys(row).sort()
  const wanted = [...keys].sort()
  return actual.length === wanted.length && actual.every((k, i) => k === wanted[i])
}

/** KP-1: exactly one row, exactly the two columns, both equal to the auditor role. */
export function assertKp1(rows: readonly Row[]): boolean {
  if (rows.length !== 1) return false
  const row = rows[0]
  if (!sameKeys(row, ['current_user', 'session_user'])) return false
  return row.current_user === AUDITOR_DATABASE_ROLE && row.session_user === AUDITOR_DATABASE_ROLE
}

/** KP-2: exactly one row, one column, the string 'on'. */
export function assertKp2(rows: readonly Row[]): boolean {
  if (rows.length !== 1) return false
  const values = Object.values(rows[0])
  return values.length === 1 && values[0] === 'on'
}

/**
 * N13's sentinel clause: "exactly two columns of exactly one row-set". Returns
 * the sentinel when the shape holds, null otherwise. The VALUES are judged by
 * verifyStagingTarget, not here.
 */
export function parseSentinel(rows: readonly Row[]): StagingSentinel | null {
  if (rows.length !== 1) return null
  const row = rows[0]
  if (!sameKeys(row, ['environment', 'project_ref'])) return null
  if (typeof row.environment !== 'string' || typeof row.project_ref !== 'string') return null
  return { environment: row.environment, projectRef: row.project_ref }
}

/** Host and port of the URL, never its userinfo. Null if unparseable. */
export function connectionEndpoint(url: string): { host: string; port: number | null } | null {
  try {
    const parsed = new URL(url)
    return { host: parsed.hostname, port: parsed.port === '' ? null : Number(parsed.port) }
  } catch {
    return null
  }
}

/**
 * Arm A, before any socket: the host must name the pinned staging project by
 * the DIRECT database endpoint, and nothing may name production. A synthetic
 * `.invalid` host fails here, which is how the topology demonstration proves
 * the consumer received the value without ever reaching a network.
 */
export function preConnectIdentity(url: string): string | null {
  const endpoint = connectionEndpoint(url)
  if (endpoint === null) return 'N13_URL_UNPARSEABLE'
  const identity = deriveConnectionIdentity({ connectionHost: endpoint.host, connectionPort: endpoint.port })
  if (!identity.ok) return identity.code
  if (KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(identity.projectRef)) return 'HOSTED_TARGET_IS_PRODUCTION'
  if (identity.mechanism !== 'direct-db') return 'N13_MECHANISM_NOT_DIRECT_DB'
  if (identity.projectRef !== KNOWN_STAGING_PROJECT_REF) return 'HOSTED_TARGET_NOT_EXPECTED_PROJECT'
  return null
}

// ---------------------------------------------------------------------------
// THE NODE.
// ---------------------------------------------------------------------------

export async function runN13Verification(params: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly connect?: N13Connect
}): Promise<N13Result> {
  const connect = params.connect ?? refuseToConnect
  const issued: string[] = []
  const base = {
    connected: false,
    kp1: false,
    kp2: false,
    sentinelOneRowTwoColumns: false,
    targetIdentityArmB: false,
    rolledBack: false,
  }
  const fail = (
    failedAt: N13FailedAt,
    token: N13Token | null,
    code: string,
    extra: Partial<typeof base> = {}
  ): N13Result => ({ ok: false, failedAt, token, code, ...base, ...extra, statementsIssued: [...issued] })

  // 1. The value, from the delivered variable only. The resolver's role check
  //    is the pre-check; KP-1 is the guarantee.
  let url: string
  try {
    url = resolveAuditorDatabaseUrl(params.env as NodeJS.ProcessEnv).url
  } catch (e) {
    return fail('RESOLVE', null, e instanceof CapabilityDatabaseUrlError ? e.code : 'N13_RESOLVE_UNEXPECTED')
  }

  // 2. Arm A, before a socket exists.
  const armA = preConnectIdentity(url)
  if (armA !== null) return fail('PRE_CONNECT_IDENTITY', 'STOP_TARGET_IDENTITY_CONTRADICTION', armA)

  // 3. One session.
  let transport: N13Transport
  try {
    transport = await connect(url)
  } catch (e) {
    if (e instanceof N13ConnectRefused) return fail('CONNECT', null, e.code)
    return fail('CONNECT', 'STOP_AUDITOR_AUTHENTICATION_FAILED', 'N13_CONNECT_FAILED')
  }

  const state = { ...base, connected: true }
  let began = false
  let step: N13FailedAt = 'BEGIN'
  const run = async (sql: string): Promise<readonly Row[]> => {
    issued.push(sql)
    return transport.query(sql)
  }
  let outcome: N13Result | null = null
  try {
    try {
      await run(N13_STATEMENTS.BEGIN)
      began = true
    } catch {
      outcome = fail('BEGIN', null, 'N13_BEGIN_FAILED', state)
    }
    if (outcome === null) {
      step = 'KP-1'
      state.kp1 = assertKp1(await run(N13_STATEMENTS.KP1))
      if (!state.kp1) outcome = fail('KP-1', 'STOP_AUDITOR_AUTHENTICATION_FAILED', 'N13_KP1_IDENTITY_NOT_AUDITOR', state)
    }
    if (outcome === null) {
      step = 'KP-2'
      state.kp2 = assertKp2(await run(N13_STATEMENTS.KP2))
      if (!state.kp2) outcome = fail('KP-2', null, 'N13_KP2_NOT_READ_ONLY', state)
    }
    if (outcome === null) {
      step = 'SENTINEL_SHAPE'
      const sentinel = parseSentinel(await run(N13_STATEMENTS.SENTINEL))
      state.sentinelOneRowTwoColumns = sentinel !== null
      if (sentinel === null) {
        outcome = fail('SENTINEL_SHAPE', 'STOP_TARGET_IDENTITY_CONTRADICTION', 'N13_SENTINEL_NOT_ONE_ROW_TWO_COLUMNS', state)
      } else {
        const endpoint = connectionEndpoint(url)
        const verdict = verifyStagingTarget(
          {
            declaredEnvironment: 'staging',
            declaredProjectRef: KNOWN_STAGING_PROJECT_REF,
            connectionHost: endpoint?.host ?? '',
            connectionPort: endpoint?.port ?? null,
            sentinel,
          },
          KNOWN_PRODUCTION_IDENTIFIERS,
          'required'
        )
        state.targetIdentityArmB = verdict.ok
        if (!verdict.ok) outcome = fail('TARGET_IDENTITY_ARM_B', 'STOP_TARGET_IDENTITY_CONTRADICTION', verdict.code, state)
      }
    }
  } catch {
    // A server error on a pinned read is a failure AT that step, reported by
    // code only. Its message is never carried: it can quote the statement's
    // context, and nothing here is allowed to relay what the server says.
    outcome = outcome ?? fail(step, step === 'KP-1' ? 'STOP_AUDITOR_AUTHENTICATION_FAILED' : null, 'N13_QUERY_FAILED', state)
  } finally {
    // ROLLBACK UNCONDITIONALLY, including on the success path: the read-only
    // property is structural, not circumstantial.
    if (began) {
      try {
        await run(N13_STATEMENTS.ROLLBACK)
        state.rolledBack = true
      } catch {
        state.rolledBack = false
      }
    }
    try {
      await transport.close()
    } catch {
      // Closing is best effort; the session ends with the process regardless.
    }
  }
  if (outcome !== null) return { ...outcome, rolledBack: state.rolledBack, statementsIssued: [...issued] }
  if (!state.rolledBack) return fail('TARGET_IDENTITY_ARM_B', null, 'N13_ROLLBACK_FAILED', state)
  return { ok: true, failedAt: null, token: null, code: null, ...state, statementsIssued: [...issued] }
}
