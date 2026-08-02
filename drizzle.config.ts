import { defineConfig } from 'drizzle-kit'
import { LOCAL_DATABASE_URL } from './db/safety/local-stack'

// drizzle.config.ts — SQL GENERATION ONLY (`pnpm db:generate`).
//
// This file used to read the ambient database environment variable with a
// localhost fallback, which made `pnpm db:migrate` an ambiguous command: it applied
// migrations to whatever database the ambient environment happened to name,
// with no classification and no confirmation. That command is now blocked
// (see scripts/blocked-command.ts); use `pnpm db:migrate:local` for the local
// stack, and the reviewed prepared-SQL packages plus the gate checklists in
// docs/ops/gates/ for anything remote.
//
// `drizzle-kit generate` diffs db/schema.ts against db/migrations/ and never
// opens a connection. `dbCredentials` is still required by the config schema,
// so it is pinned to the local stack — never to an environment variable.

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: LOCAL_DATABASE_URL,
  },
})
