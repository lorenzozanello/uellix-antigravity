// scripts/stella-r3-4-local-runner.ts
//
// The only R3.4 local prepared-chain executor. Its manifest is fixed in
// db/r3-4-governed-runner.ts; callers cannot select SQL, paths, order, or a
// database identity. This runner never targets a remote database.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { config as loadEnvFile } from 'dotenv'
import type postgres from 'postgres'
import { createDatabaseClient, type DatabaseClient } from '../db/client'
import { applyPreparedScript } from '../db/migrator'
import {
  parseR3_4RunnerMode,
  R3_4_LOCAL_PHASES,
  type R3_4LocalPhase,
} from '../db/r3-4-governed-runner'
import { LOCAL_DB_PORT } from '../db/safety/local-stack'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PREPARED_DIR = resolve(REPO_ROOT, 'db', 'prepared')
const MIGRATION_ENV_FILE = resolve(REPO_ROOT, '.env.migration.local')
const LOCAL_ADMIN_DATABASE_URL_ENV_VAR = 'UELLIX_LOCAL_ADMIN_DATABASE_URL'

function loadMigrationEnv(): void {
  if (!existsSync(MIGRATION_ENV_FILE)) {
    throw new Error(
      `Missing ${basename(MIGRATION_ENV_FILE)}. R3.4 requires separately governed local credentials ` +
        'for the administrative and uellix_migrator phases.'
    )
  }
  loadEnvFile({ path: MIGRATION_ENV_FILE, quiet: true })
}

function phaseFile(phase: R3_4LocalPhase): string {
  // `phase.file` originates only from the frozen manifest above. There is no
  // caller input in this resolution path.
  const file = resolve(PREPARED_DIR, phase.file)
  if (!existsSync(file)) throw new Error(`R3.4 manifest file is missing: ${phase.file}`)
  return file
}

function createAdministrativeClient(): DatabaseClient {
  const url = process.env[LOCAL_ADMIN_DATABASE_URL_ENV_VAR]
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(
      `${LOCAL_ADMIN_DATABASE_URL_ENV_VAR} is required for the fixed administrative phases. ` +
        'It is read only from .env.migration.local and is never accepted as an argument.'
    )
  }

  return createDatabaseClient({
    connectionString: url.trim(),
    capability: 'local_migration',
    expectedLocalPort: LOCAL_DB_PORT,
    env: process.env,
    postgresOptions: { max: 1 },
  })
}

async function assertAdministrativeSession(sql: postgres.Sql): Promise<void> {
  const [identity] = await sql<
    { session_user: string; current_user: string; is_superuser: boolean }[]
  >`
    SELECT
      session_user::text AS session_user,
      current_user::text AS current_user,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false) AS is_superuser
  `

  if (!identity?.is_superuser) {
    throw new Error(
      `R3.4 administrative phase requires a local PostgreSQL superuser session; ` +
        `session_user is "${identity?.session_user ?? '<unknown>'}".`
    )
  }
}

async function runAdministrativePhase(phase: R3_4LocalPhase): Promise<void> {
  const file = phaseFile(phase)
  const source = readFileSync(file, 'utf8')
  const client = createAdministrativeClient()
  try {
    await assertAdministrativeSession(client.sql)
    await client.sql.begin(async (tx) => {
      await assertAdministrativeSession(tx as unknown as postgres.Sql)
      await tx.unsafe(source).simple()
    })
    console.log(`[r3.4] committed administrative phase ${phase.id}: ${phase.file}`)
  } finally {
    await client.close()
  }
}

async function runMigratorPhase(phase: R3_4LocalPhase): Promise<void> {
  const file = phaseFile(phase)
  const result = await applyPreparedScript(file, {
    verifyOwnershipAndAcl: phase.verifyOwnershipAfterApply,
  })
  console.log(`[r3.4] committed migrator phase ${phase.id}: ${phase.file} sha256=${result.sha256}`)
}

function printPlan(): void {
  for (const phase of R3_4_LOCAL_PHASES) {
    const source = readFileSync(phaseFile(phase), 'utf8')
    const sha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    console.log(
      `[r3.4] ${phase.id} identity=${phase.identity} transaction=one file=${phase.file} sha256=${sha256}`
    )
  }
}

async function main(): Promise<void> {
  const mode = parseR3_4RunnerMode(process.argv.slice(2))
  if (mode === 'plan') {
    printPlan()
    return
  }

  loadMigrationEnv()
  for (const phase of R3_4_LOCAL_PHASES) {
    if (phase.identity === 'admin') {
      await runAdministrativePhase(phase)
    } else {
      await runMigratorPhase(phase)
    }
  }
}

void main().catch((error: unknown) => {
  console.error('[r3.4] failed:', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
})
