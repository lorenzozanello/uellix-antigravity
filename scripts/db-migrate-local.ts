// scripts/db-migrate-local.ts
//
// The ONLY entry point that may change schema on the local stack.
//
//   pnpm db:migrate:local                      -- drizzle migrations
//   pnpm db:prepared:apply:local <file.sql>    -- one prepared script
//   pnpm db:prepared:verify:local <file.sql>   -- same, rolled back
//
// It loads `.env.migration.local` — a file Next.js does not read — and refuses
// to start unless the credential in it authenticates as `uellix_migrator`. The
// previous `pnpm db:migrate:local` ran drizzle-kit as `postgres`, which is why
// every table in `public` was owned by the application runtime until
// stella_0004 moved them.
//
// The migration credential never arrives as an argument. `ps`, shell history
// and CI logs all see argv; none of them ever sees this secret.

import { existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { config as loadEnvFile } from 'dotenv'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import {
  applyPreparedScript,
  assertMigratorSession,
  assertOwnerRoleActive,
  createMigratorClient,
  verifyOwnershipAndAcl,
  MigratorError,
} from '../db/migrator'
import { OWNER_DATABASE_ROLE } from '../db/safety/database-role'
import {
  MIGRATOR_DATABASE_URL_ENV_VAR,
  CapabilityDatabaseUrlError,
} from '../db/safety/resolve-capability-database-url'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const MIGRATION_ENV_FILE = resolve(REPO_ROOT, '.env.migration.local')
const PREPARED_DIR = resolve(REPO_ROOT, 'db', 'prepared')
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'db', 'migrations')

/**
 * Load the migration credential from its own file.
 *
 * `override: false` is the default and is what we want: an operator who has
 * deliberately exported the variable for a one-off keeps control, while the
 * file supplies it in every ordinary run.
 */
function loadMigrationEnv(): void {
  if (!existsSync(MIGRATION_ENV_FILE)) {
    console.error(
      `Missing ${basename(MIGRATION_ENV_FILE)}.\n\n` +
        'Mint the local role credentials first:\n' +
        '  pnpm tsx scripts/rotate-local-role-credentials.ts ' +
        'rotate-local-credentials:uellix-stella-g2-local-rehearsal\n'
    )
    process.exit(1)
  }
  loadEnvFile({ path: MIGRATION_ENV_FILE, quiet: true })
}

function usage(): never {
  console.error(
    'Usage:\n' +
      '  db-migrate-local.ts drizzle\n' +
      '  db-migrate-local.ts prepared <script.sql>\n' +
      '  db-migrate-local.ts verify   <script.sql>\n'
  )
  process.exit(1)
}

/** Resolve a prepared script name to a path, refusing anything outside db/prepared. */
function resolvePreparedScript(name: string | undefined): string {
  if (name === undefined || name.trim() === '') usage()
  // `basename` first: a caller-supplied "../../etc/passwd" collapses to
  // "passwd" and then fails the existence check, rather than escaping the
  // directory this command is scoped to.
  const file = resolve(PREPARED_DIR, basename(name.trim()))
  if (!file.endsWith('.sql') || !existsSync(file)) {
    console.error(`No such prepared script: ${basename(name)} (looked in db/prepared/)`)
    process.exit(1)
  }
  return file
}

/**
 * Run the drizzle migration chain as the owner.
 *
 * `SET ROLE` here is SESSION-scoped rather than `SET LOCAL`, and that is a
 * deliberate, narrow exception: `migrate()` opens and manages its OWN
 * transaction, so there is no outer transaction for a LOCAL setting to attach
 * to. The compensating controls are that the connection pool holds exactly one
 * connection (db/migrator.ts pins `max: 1`), that the process exits
 * immediately afterwards, and that `session_user` remains `uellix_migrator`
 * throughout — the role is borrowed, never authenticated as.
 */
async function runDrizzleMigrations(): Promise<void> {
  const client = createMigratorClient()
  try {
    await assertMigratorSession(client.sql)
    await client.sql.unsafe(`SET ROLE ${OWNER_DATABASE_ROLE}`)
    await assertOwnerRoleActive(client.sql)

    console.log(`[migrator] applying drizzle migrations from db/migrations as ${OWNER_DATABASE_ROLE}`)
    await migrate(client.db, { migrationsFolder: MIGRATIONS_DIR })

    const report = await verifyOwnershipAndAcl(client.sql)
    const problems = [
      ...report.tablesNotOwnedByOwner.map((n) => `table ${n}`),
      ...report.functionsNotOwnedByOwner.map((n) => `function ${n}`),
      ...report.sequencesNotOwnedByOwner.map((n) => `sequence ${n}`),
      ...report.typesNotOwnedByOwner.map((n) => `type ${n}`),
      ...report.publicExecutableFunctions.map((n) => `function ${n} executable by PUBLIC`),
      ...report.publicUsableTypes.map((n) => `type ${n} usable by PUBLIC`),
    ]

    if (problems.length > 0) {
      // Migrations have already committed by this point — `migrate()` commits
      // per file. Reporting loudly is all that is left, and it is worth doing:
      // the alternative is discovering months later that one migration created
      // a table owned by somebody else.
      throw new MigratorError(
        'DB_MIGRATOR_POSTCONDITION_FAILED',
        `Migrations applied but left public inconsistent — ${problems.join('; ')}`
      )
    }

    console.log('[migrator] drizzle migrations applied; ownership and ACLs verified')
  } finally {
    await client.sql.unsafe('RESET ROLE').catch(() => undefined)
    await client.close()
  }
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2)
  loadMigrationEnv()

  switch (command) {
    case 'drizzle':
      await runDrizzleMigrations()
      return

    case 'prepared': {
      const file = resolvePreparedScript(argument)
      const result = await applyPreparedScript(file)
      console.log(`[migrator] applied ${basename(result.file)} sha256=${result.sha256}`)
      return
    }

    case 'verify': {
      const file = resolvePreparedScript(argument)
      const result = await applyPreparedScript(file, { dryRun: true })
      console.log(`[migrator] verified ${basename(result.file)} sha256=${result.sha256} (rolled back)`)
      return
    }

    default:
      usage()
  }
}

void main().catch((error: unknown) => {
  if (error instanceof CapabilityDatabaseUrlError) {
    console.error(
      `[migrator] ${error.code}: ${error.message}\n` +
        `Set ${MIGRATOR_DATABASE_URL_ENV_VAR} in .env.migration.local (never in .env.local).`
    )
  } else if (error instanceof MigratorError) {
    console.error(`[migrator] ${error.code}: ${error.message}`)
  } else {
    console.error('[migrator] failed:', error instanceof Error ? error.message : 'unknown error')
  }
  process.exitCode = 1
})
