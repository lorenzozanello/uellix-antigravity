// db/identity-store.ts
//
// The ambient slot that binds "which request am I serving" to "which database
// handle must this query use".
//
// It lives in its own module, importing nothing from db/client.ts or
// db/identity-context.ts, purely to keep the dependency graph acyclic: the
// client needs to READ the current binding on every property access, and the
// context module needs to WRITE it. Putting the storage in either of them
// would make the two import each other.
//
// WHY ASYNC LOCAL STORAGE AND NOT A PARAMETER
//
// 115 modules in this repository import `{ db }` and call it directly. Under
// the pre-cutover runtime that was safe in the narrow sense that `postgres`
// bypassed RLS, so a query with no identity attached still returned rows —
// the wrong safety, but a consistent one.
//
// After the cutover a query with no identity attached returns NOTHING, because
// `current_user_org_ids()` is empty without claims. Threading a handle through
// 115 modules' call graphs would be a mechanical change to thousands of lines
// with a silent failure mode at every site that was missed. Binding the handle
// to the async context instead means the existing call sites keep working
// inside a context and fail CLOSED outside one, which is the behaviour we
// want in both directions.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from './schema'

export interface DatabaseIdentity {
  /** Supabase Auth user id. Server-validated before it ever reaches here. */
  readonly userId: string
  /** The organisation the request operates in, or null when not org-scoped. */
  readonly organizationId: string | null
  /** Claimed super-admin status. VERIFIED against the database, never trusted. */
  readonly isSuperAdmin: boolean
}

export interface BoundDatabaseContext {
  readonly identity: DatabaseIdentity
  /** A drizzle handle bound to the transaction that carries the identity. */
  readonly db: PostgresJsDatabase<typeof schema>
}

const storage = new AsyncLocalStorage<BoundDatabaseContext>()

/** The context for the current async execution, or undefined outside one. */
export function getBoundDatabaseContext(): BoundDatabaseContext | undefined {
  return storage.getStore()
}

/** Run `callback` with `context` bound for the duration of its async tree. */
export function runWithBoundDatabaseContext<T>(
  context: BoundDatabaseContext,
  callback: () => Promise<T>
): Promise<T> {
  return storage.run(context, callback)
}
