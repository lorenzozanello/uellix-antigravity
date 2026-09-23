// db/custody/auditor-read-session.ts
//
// ONE READ-ONLY SESSION AS uellix_auditor, FOR N14, N21 AND N22.
//
// Each of these nodes is a SEPARATE delivery (DAG v1.0.4
// HOSTED_SQL_SESSION_DELIVERY_RULE), so each opens its own session, and a new
// session proves nothing it has not proved itself. The P1 preflight is
// "KP-1..KP-6, in order" (FUTURE_EXECUTION_PHASES.PHASE_P1.preflight); every
// session here therefore re-runs the identity preflight N13 established for
// its own session — KP-1, KP-2, and the sentinel with verifyStagingTarget
// (required) — before its body reads anything.
//
// It reuses N13's pure pieces (arm A before any socket, the KP parsers, the
// refusing default transport) rather than restating them, so a change to what
// "identity" means cannot drift between the nodes.
//
// THE STATEMENT ALLOWLIST IS ENFORCED AT RUN TIME. The body receives a `read`
// that accepts only statements registered in P1_STATEMENTS, not blocked by an
// open authority conflict, and named by the node. Anything else throws before
// it reaches the transport, so an unauthorized statement is not merely absent
// from the source: it cannot be sent.

import { CapabilityDatabaseUrlError, resolveAuditorDatabaseUrl } from '../safety/resolve-capability-database-url'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF, verifyStagingTarget } from '../hosted/target-identity'
import {
  N13ConnectRefused,
  assertKp1,
  assertKp2,
  connectionEndpoint,
  parseSentinel,
  preConnectIdentity,
  refuseToConnect,
  type N13Connect,
  type N13Transport,
  type Row,
} from './n13-verification'
import { P1_STATEMENTS, type P1Id } from './p1-reads'

export const BEGIN_READ_ONLY = 'BEGIN READ ONLY'
export const ROLLBACK = 'ROLLBACK'

export type SessionFailedAt =
  | 'RESOLVE'
  | 'PRE_CONNECT_IDENTITY'
  | 'CONNECT'
  | 'BEGIN'
  | 'KP-1'
  | 'KP-2'
  | 'SENTINEL_SHAPE'
  | 'TARGET_IDENTITY_ARM_B'
  | 'BODY'

export interface SessionPreflight {
  readonly connected: boolean
  readonly kp1: boolean
  readonly kp2: boolean
  readonly targetIdentityArmB: boolean
  readonly sentinel: { environment: string; projectRef: string } | null
}

export type ReadFn = (id: P1Id) => Promise<readonly Row[]>

export interface SessionOutcome<T> {
  readonly failedAt: SessionFailedAt | null
  readonly token: 'STOP_AUDITOR_AUTHENTICATION_FAILED' | 'STOP_TARGET_IDENTITY_CONTRADICTION' | null
  readonly code: string | null
  readonly preflight: SessionPreflight
  readonly body: T | null
  readonly rolledBack: boolean
  readonly statementsIssued: readonly string[]
}

export class UnauthorizedStatement extends Error {
  readonly code = 'SESSION_UNAUTHORIZED_STATEMENT'
}

export async function runAuditorReadSession<T>(params: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly connect?: N13Connect
  /** The P1 statements this node's BODY may issue. Blocked ones are refused regardless. */
  readonly bodyAllowlist: readonly P1Id[]
  readonly body: (read: ReadFn) => Promise<T>
}): Promise<SessionOutcome<T>> {
  const connect = params.connect ?? refuseToConnect
  const issued: string[] = []
  const pre = { connected: false, kp1: false, kp2: false, targetIdentityArmB: false, sentinel: null as SessionPreflight['sentinel'] }
  const out = (
    failedAt: SessionFailedAt | null,
    token: SessionOutcome<T>['token'],
    code: string | null,
    body: T | null,
    rolledBack: boolean
  ): SessionOutcome<T> => ({ failedAt, token, code, preflight: { ...pre }, body, rolledBack, statementsIssued: [...issued] })

  let url: string
  try {
    url = resolveAuditorDatabaseUrl(params.env as NodeJS.ProcessEnv).url
  } catch (e) {
    return out('RESOLVE', null, e instanceof CapabilityDatabaseUrlError ? e.code : 'SESSION_RESOLVE_UNEXPECTED', null, false)
  }
  const armA = preConnectIdentity(url)
  if (armA !== null) return out('PRE_CONNECT_IDENTITY', 'STOP_TARGET_IDENTITY_CONTRADICTION', armA, null, false)

  let transport: N13Transport
  try {
    transport = await connect(url)
  } catch (e) {
    if (e instanceof N13ConnectRefused) return out('CONNECT', null, e.code, null, false)
    return out('CONNECT', 'STOP_AUDITOR_AUTHENTICATION_FAILED', 'SESSION_CONNECT_FAILED', null, false)
  }
  pre.connected = true

  const send = async (sql: string): Promise<readonly Row[]> => {
    issued.push(sql)
    return transport.query(sql)
  }
  const allowed = new Set(params.bodyAllowlist.filter((id) => P1_STATEMENTS[id].blockedBy === null))
  const read: ReadFn = async (id) => {
    if (!allowed.has(id)) throw new UnauthorizedStatement(`statement ${id} is not in this node's allowlist or is blocked by an open authority conflict`)
    return send(P1_STATEMENTS[id].sql)
  }

  let began = false
  let result: SessionOutcome<T> | null = null
  let step: SessionFailedAt = 'BEGIN'
  try {
    await send(BEGIN_READ_ONLY)
    began = true
    step = 'KP-1'
    pre.kp1 = assertKp1(await send(P1_STATEMENTS.IDENTITY.sql))
    if (!pre.kp1) result = out('KP-1', 'STOP_AUDITOR_AUTHENTICATION_FAILED', 'SESSION_KP1_IDENTITY_NOT_AUDITOR', null, false)
    if (result === null) {
      step = 'KP-2'
      pre.kp2 = assertKp2(await send(P1_STATEMENTS.READ_ONLY.sql))
      if (!pre.kp2) result = out('KP-2', null, 'SESSION_KP2_NOT_READ_ONLY', null, false)
    }
    if (result === null) {
      step = 'SENTINEL_SHAPE'
      const sentinel = parseSentinel(await send(P1_STATEMENTS.SENTINEL.sql))
      pre.sentinel = sentinel
      if (sentinel === null) {
        result = out('SENTINEL_SHAPE', 'STOP_TARGET_IDENTITY_CONTRADICTION', 'SESSION_SENTINEL_NOT_ONE_ROW_TWO_COLUMNS', null, false)
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
        pre.targetIdentityArmB = verdict.ok
        if (!verdict.ok) result = out('TARGET_IDENTITY_ARM_B', 'STOP_TARGET_IDENTITY_CONTRADICTION', verdict.code, null, false)
      }
    }
    if (result === null) {
      step = 'BODY'
      const body = await params.body(read)
      result = out(null, null, null, body, false)
    }
  } catch (e) {
    // A server error, or a refused statement, is reported at its step by code
    // only; the driver's or server's message is never carried.
    const code = e instanceof UnauthorizedStatement ? e.code : 'SESSION_QUERY_FAILED'
    result = out(step, step === 'KP-1' ? 'STOP_AUDITOR_AUTHENTICATION_FAILED' : null, code, null, false)
  } finally {
    let rolledBack = false
    if (began) {
      try {
        await send(ROLLBACK)
        rolledBack = true
      } catch {
        rolledBack = false
      }
    }
    try {
      await transport.close()
    } catch {
      /* the session ends with the process regardless */
    }
    result = { ...(result as SessionOutcome<T>), rolledBack, statementsIssued: [...issued] }
  }
  return result
}
