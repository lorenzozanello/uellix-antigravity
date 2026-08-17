// db/runtime-gate.ts
//
// THE OUT-OF-CONTEXT FALLBACK, GOVERNED — AND DENY-BY-DEFAULT.
//
// ---------------------------------------------------------------------------
// THE HOLE THIS CLOSES
// ---------------------------------------------------------------------------
// `ensureRuntimeIdentityVerified` had exactly ONE caller in application code:
// db/identity-context.ts, immediately before it opens the transaction that
// carries a request's claims. Every query issued INSIDE an identity context is
// therefore certified.
//
// The `db` proxy in db/client.ts has a second path. Outside a context it falls
// back to the pooled client, and that path reached the driver without ever
// asking the server who it had authenticated. The comment defending it argued
// that a claimless query as `uellix_app` returns zero rows and so fails closed.
// That is true, and it assumes the thing the gate exists to prove: `as
// uellix_app`. With `UELLIX_RUNTIME_DATABASE_URL` resolving to a role holding
// BYPASSRLS — the exact pre-cutover state, and the exact accident the reaudit
// found — a claimless query returns EVERY tenant's rows, and no gate fires,
// because the entry points that use this path are the ones that never open a
// context: the public verify-by-hash page among them.
//
// So the fallback is not given the raw handle any more. It is given this one.
//
// ---------------------------------------------------------------------------
// WHY A HANDLE WRAPPER AND NOT A CHECK IN THE PROXY
// ---------------------------------------------------------------------------
// The `get` trap in db/client.ts is SYNCHRONOUS and the certification is a
// round trip, so the check cannot live there. Three alternatives were weighed:
//
//   * DELETE the fallback (make `db` throw outside a context). Rejected: three
//     entry points are allowlisted precisely because they query outside one and
//     fail closed by design — `app/(public)/verify/[hash]/page.tsx` answers 404
//     today and would answer 500.
//   * ARM the gate eagerly at client construction and refuse once it is known
//     to have failed. Rejected: between construction and the first answer there
//     is a window in which a business query on a second pooled connection can
//     complete first. A race is not a security property.
//   * GATE THE DRIVER SURFACE. Taken. The guarantee is ordering rather than
//     timing: the statement is not handed to the driver until certification has
//     RESOLVED, and a rejected certification rejects the statement.
//
// The in-context path is untouched. It already awaits the same memoised gate
// one line before it opens its transaction, so nothing about a request that
// opens a context changes shape, cost or behaviour.
//
// ---------------------------------------------------------------------------
// WHAT THE ADAPTER ACTUALLY TOUCHES — drizzle-orm@0.45.2 over postgres@3.4.9
// ---------------------------------------------------------------------------
// Measured against the installed dependencies, not assumed. FOUR members of a
// postgres-js client are reached by the adapter, and they are not reached in
// the same place:
//
//   1. `unsafe`    — INTERCEPTED here. Every statement drizzle sends goes
//                    through it: session.cjs lines 58, 68, 90, 128 and 131,
//                    covering `.execute()`, `.all()`, `query()` and
//                    `queryObjects()`.
//   2. `begin`     — INTERCEPTED here. session.cjs line 134, the one entry to
//                    `db.transaction(...)`.
//   3. `options`   — EXPOSED to the adapter, by reference. driver.cjs
//                    `construct()` lines 49-53 MUTATE `options.parsers` and
//                    `options.serializers` to install its own transparent type
//                    handlers. A copy would leave the real handle without them
//                    and silently change how values are decoded, so this member
//                    is deliberately the real object. It is the adapter's only
//                    read of `options`: `this.options` in session.cjs is
//                    drizzle's OWN `{ logger, cache }`, not the client's.
//   4. `savepoint` — NOT IMPLEMENTED HERE, and correctly so. It exists in the
//                    dependency, but only on the SCOPED handle postgres-js
//                    creates inside `begin`: `sql.savepoint = savepoint` is
//                    assigned in `scope()` (postgres/src/index.js line 253) and
//                    the top-level `sql` never carries it. drizzle reaches it as
//                    `this.session.client.savepoint(...)` (session.cjs line
//                    156), where `this.session` was constructed around the
//                    scoped client `begin` handed to its callback — never
//                    around this wrapper. A nested transaction therefore runs
//                    on a handle that is already inside a certified `begin`,
//                    and a top-level `savepoint` would be meaningless anyway
//                    because there is no open transaction to mark.
//
// ---------------------------------------------------------------------------
// DENY BY DEFAULT — WHY THIS IS AN OBJECT AND NOT A PROXY
// ---------------------------------------------------------------------------
// The first version of this module was a `Proxy` with a `get` trap that fell
// through to the target for anything it did not intercept. That left every
// other capability of a postgres-js client ungated — `reserve()`, `file()`,
// `listen()`, `notify()`, `subscribe()`, `largeObject()`, `close()`, `end()` —
// each of which can drive the connection without the certification having
// resolved. Nothing in this repository calls them today (`$client` has no
// consumers, and the wrapper is only ever handed to the drizzle adapter), so it
// was a latent hole rather than a live one. It was still the wrong default.
//
// A `get` trap cannot fix it on its own, either: a Proxy only intercepts the
// traps it defines, so `Object.getOwnPropertyDescriptor(proxy, 'reserve').value`
// hands back the RAW function whatever `get` does. Closing that means trapping
// `getOwnPropertyDescriptor` and `ownKeys` too, and then satisfying the Proxy
// invariants for non-configurable target properties — a lot of machinery whose
// correctness is hard to see by reading it.
//
// So there is no proxy and no target. This is a PLAIN OBJECT that owns three
// members and closes over the raw handle. Deny-by-default is structural: an
// unlisted capability is not refused by a rule that could be edited, it simply
// does not exist on the value the caller holds, and the raw handle is
// unreachable from it — not as a property, not through a prototype, not through
// a trap.
//
// Two consequences worth stating rather than discovering:
//
//   * Every FUNCTION-valued member of the raw handle that is not permitted is
//     given a REFUSING stand-in, derived from the handle itself rather than
//     from a hand-written list. A future postgres-js release that adds a
//     capability gets a refusal automatically instead of a passthrough. The
//     refusal is loud (`RuntimeGateRefusalError`) rather than a
//     `TypeError: not a function`, which is what an absent member would give.
//   * Non-function members other than `options` are simply ABSENT. They carry
//     no execution path, and absent is the stronger answer than forwarded.
//
// `options` is the single by-reference member, because the adapter mutates it.
// It is the driver's configuration object — the same one the raw handle already
// exposed to whoever held it — and it carries no way back: there is no
// reference to the client on it, and no member of it opens or drives a
// connection. Narrowing it to `{ parsers, serializers }` would remove the
// connection settings from this surface too, and was NOT done here: if the
// measured read-set above were ever incomplete, a missing option would not
// throw, it would silently change how a value is decoded. That trade is
// recorded as a follow-up rather than taken quietly.
//
// ---------------------------------------------------------------------------
// WHAT IS NOT WRAPPED
// ---------------------------------------------------------------------------
// The RAW handle stays raw and stays exported as `DatabaseClient.sql`. It has
// to: `readRuntimeIdentity` runs ON it, and a gated handle would make the
// certification wait for itself. Its two consumers are the gate in
// db/identity-context.ts and the observability surface in
// db/runtime-identity-report.ts, both of which are the certification.

import type postgres from 'postgres'
import { ensureRuntimeIdentityVerified } from './runtime-bootstrap'

/* -------------------------------------------------------------------------- */
/* The permitted surface                                                      */
/* -------------------------------------------------------------------------- */

/** Statement-issuing members. Every one is intercepted and gated. */
export const GATE_INTERCEPTED_MEMBERS = Object.freeze(['unsafe', 'begin'] as const)

/**
 * Members exposed to the adapter as-is.
 *
 * `options` only, and by REFERENCE — drizzle's `construct()` writes into
 * `options.parsers` and `options.serializers`, and those writes have to land on
 * the real handle.
 */
export const GATE_EXPOSED_MEMBERS = Object.freeze(['options'] as const)

/** Everything a caller may reach. Anything else is refused or absent. */
export const GATE_PERMITTED_MEMBERS: ReadonlySet<string> = Object.freeze(
  new Set<string>([...GATE_INTERCEPTED_MEMBERS, ...GATE_EXPOSED_MEMBERS])
) as ReadonlySet<string>

export class RuntimeGateRefusalError extends Error {
  readonly name = 'RuntimeGateRefusalError'
  readonly code = 'DB_RUNTIME_GATE_MEMBER_REFUSED' as const
  readonly member: string

  constructor(member: string) {
    super(
      `"${member}" is not part of the governed runtime database surface. Only ` +
        `[${[...GATE_PERMITTED_MEMBERS].join(', ')}] and the tagged-template form are reachable ` +
        'through the identity gate, because every other postgres-js capability can drive the ' +
        'connection without the runtime identity having been certified. Use ' +
        'db/identity-context.ts, or take the raw handle deliberately from DatabaseClient.sql.'
    )
    this.member = member
  }
}

/* -------------------------------------------------------------------------- */
/* Deferral                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The subset of postgres-js's `PendingQuery` that drizzle actually uses.
 *
 * `unsafe()` cannot simply return a promise: drizzle calls `.values()` on the
 * result and awaits THAT (session.cjs, `PostgresJsSession.query`). So the gated
 * form returns a deferred stand-in that records the modifiers, and only builds
 * the real query once certification has resolved.
 */
interface DeferredQuery<T> extends PromiseLike<T> {
  values(): DeferredQuery<T>
  raw(): DeferredQuery<T>
  execute(): Promise<T>
  catch<R>(onRejected: (reason: unknown) => R | PromiseLike<R>): Promise<T | R>
  finally(onFinally: () => void): Promise<T>
}

type QueryModifier = 'values' | 'raw'

/**
 * Defer `build` until `gate` resolves, preserving postgres-js's fluent
 * modifiers.
 *
 * The real query is built ONCE and only on first settle — `then` may be called
 * more than once on a promise-like, and building twice would send the statement
 * twice. Building it lazily is also what makes the ordering guarantee real: no
 * statement exists, so none can be dispatched, until the gate has passed.
 */
function deferUntilVerified<T>(
  gate: () => Promise<unknown>,
  build: () => unknown
): DeferredQuery<T> {
  const modifiers: QueryModifier[] = []
  let started: Promise<T> | null = null

  const settle = (): Promise<T> => {
    started ??= gate().then(() => {
      let query = build() as Record<QueryModifier, () => unknown>
      for (const modifier of modifiers) query = query[modifier]() as typeof query
      return query as unknown as Promise<T>
    })
    return started
  }

  const deferred: DeferredQuery<T> = {
    values() {
      modifiers.push('values')
      return deferred
    },
    raw() {
      modifiers.push('raw')
      return deferred
    },
    execute: () => settle(),
    then: (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected),
    catch: (onRejected) => settle().catch(onRejected),
    finally: (onFinally) => settle().finally(onFinally),
  }

  return deferred
}

/* -------------------------------------------------------------------------- */
/* The gated handle                                                           */
/* -------------------------------------------------------------------------- */

type AnyFunction = (...args: unknown[]) => unknown

/**
 * A postgres-js handle that executes nothing until
 * `ensureRuntimeIdentityVerified` has passed on the handle underneath it, and
 * that exposes nothing beyond the surface the drizzle adapter needs.
 */
export function gateSqlOnRuntimeIdentity(sql: postgres.Sql): postgres.Sql {
  const gate = () => ensureRuntimeIdentityVerified(sql)
  const raw = sql as unknown as Record<string | symbol, unknown>

  // The tagged-template form. Nothing in drizzle uses it, but it is the primary
  // way a postgres-js handle is driven and an ungated callable on a handle
  // whose whole purpose is to be gated would read as an oversight.
  //
  // It gates the QUERY form. postgres-js overloads the same call for SQL
  // FRAGMENTS — `sql('ident')` builds an Identifier, `sql({…})` a Builder — and
  // those are consumed synchronously inside another query rather than awaited,
  // so through this wrapper they come back as a deferred and are unusable. That
  // is the correct direction for a surface only the adapter holds: fragments
  // belong to the raw handle, and a fragment that silently became a deferred
  // query would be the failure worth avoiding.
  const gated = function gatedSql(...args: unknown[]) {
    return deferUntilVerified(gate, () => (raw as unknown as AnyFunction)(...args))
  } as unknown as Record<string | symbol, unknown>

  Object.defineProperty(gated, 'unsafe', {
    value: (...args: unknown[]) =>
      deferUntilVerified(gate, () => (raw.unsafe as AnyFunction)(...args)),
    enumerable: true,
  })

  // `begin` already returns a plain promise, so it needs no stand-in: the gate
  // is chained in front of it. Everything drizzle does inside a transaction —
  // including `savepoint` for a nested one — runs on the SCOPED handle
  // postgres-js passes to the callback, which is correct: re-certifying inside
  // an open transaction would issue a second identity query mid-transaction to
  // prove something the enclosing gate has already proven about the same
  // connection.
  Object.defineProperty(gated, 'begin', {
    value: (...args: unknown[]) => gate().then(() => (raw.begin as AnyFunction)(...args)),
    enumerable: true,
  })

  Object.defineProperty(gated, 'options', {
    get: () => raw.options,
    enumerable: true,
  })

  // DENY BY DEFAULT, derived from the handle rather than from a list that could
  // fall behind the dependency. A capability postgres-js adds tomorrow lands
  // here as a refusal, not as a passthrough.
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === 'string' && GATE_PERMITTED_MEMBERS.has(key)) continue

    const descriptor = Reflect.getOwnPropertyDescriptor(raw, key)
    // Accessors are NOT invoked to classify them: reading a getter to find out
    // what it returns is itself a call into the dependency. They are left
    // absent, which is the same refusal by a quieter route.
    if (descriptor === undefined || typeof descriptor.value !== 'function') continue

    const member = typeof key === 'symbol' ? (key.description ?? 'symbol') : key
    Object.defineProperty(gated, key, {
      value: () => {
        throw new RuntimeGateRefusalError(member)
      },
      enumerable: descriptor.enumerable,
    })
  }

  return gated as unknown as postgres.Sql
}
