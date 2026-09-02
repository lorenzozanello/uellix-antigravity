import { defineConfig } from 'drizzle-kit'
import { assertDatabaseOperationAllowed } from './db/safety/database-access'
import { LOCAL_DATABASE_URL, LOCAL_DB_PORT } from './db/safety/local-stack'

// drizzle.local.config.ts — local migrations only (`pnpm db:migrate:local`).
//
// The connection target comes from db/safety/local-stack.ts, the single
// source of truth for this worktree's isolated stack, and is validated by the
// central `local_migration` capability guard rather than by a hand-rolled
// hostname allow-list. That matters here for a reason the old check missed:
// several local Supabase stacks run side by side on this host, so a loopback
// URL on the wrong port is NOT a safe target. The guard pins the port.

const decision = assertDatabaseOperationAllowed({
  url: LOCAL_DATABASE_URL,
  capability: 'local_migration',
  expectedLocalPort: LOCAL_DB_PORT,
})

console.log(`[drizzle:local] ${decision.auditLine}`)

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: LOCAL_DATABASE_URL,
  },
})
