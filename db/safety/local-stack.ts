// db/safety/local-stack.ts
//
// Single source of truth for THIS worktree's isolated local Supabase stack.
//
// Every local-only entry point (seeds, local migrations, local reset,
// integration tests, read-only audit) resolves its target from here instead
// of from an environment variable, so that no value loaded from `.env`,
// `.env.local`, a shell export or a CI secret can redirect a local operation
// at a remote database.
//
// These constants are asserted against supabase/config.toml by
// tests/database-target-safety.test.ts — if the stack's ports or project id
// ever change, that test fails instead of the guard silently drifting.
//
// The credentials below are the Supabase CLI's fixed local development
// credentials (`postgres`/`postgres`, published in Supabase's own docs). They
// are not secrets: they only ever authenticate against a container bound to
// this host's loopback interface.

/** `project_id` in supabase/config.toml — the Docker resource namespace. */
export const LOCAL_PROJECT_ID = 'uellix-stella-g2-local-rehearsal'

/** `[api].port` in supabase/config.toml — PostgREST / GoTrue / Storage. */
export const LOCAL_API_PORT = 56321

/** `[db].port` in supabase/config.toml — the Postgres container. */
export const LOCAL_DB_PORT = 56322

/** Loopback-only Postgres URL for this worktree's stack. */
export const LOCAL_DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`

/** Loopback-only Supabase API URL for this worktree's stack. */
export const LOCAL_SUPABASE_API_URL = `http://127.0.0.1:${LOCAL_API_PORT}`

/**
 * Container hostnames that count as `local_container`.
 *
 * Deliberately EMPTY by default. A bare hostname such as `db` or `postgres`
 * is only "local" inside a specific compose network; on a developer laptop or
 * in CI the same name may resolve to something else entirely. Callers that
 * genuinely run inside a container network must pass their own allow-list to
 * `classifyDatabaseTarget` / `assertDatabaseOperationAllowed`; anything not
 * listed classifies as `unknown` and therefore fails closed.
 */
export const LOCAL_CONTAINER_HOSTS: readonly string[] = Object.freeze([])

/** Exact confirmation token required by the `local_reset` capability. */
export const LOCAL_RESET_CONFIRMATION = `reset-local:${LOCAL_PROJECT_ID}`
