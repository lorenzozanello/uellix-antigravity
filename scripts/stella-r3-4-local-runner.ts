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

// R3.4 pre-mutation preflight — P1A_FULL_BOOTSTRAP_AUTHORITY_AMENDMENT_v1.0.1.json
// D3_r3_4_apply_local.minimal_preflight_facts. Because each phase in
// R3_4_LOCAL_PHASES commits independently (no enclosing transaction across
// phases — see runAdministrativePhase/runMigratorPhase, each opens and
// closes its own client), a stella_0001 failure caused by an absent or
// wrong-actor successor precondition would occur AFTER two prepared phases
// have already committed. This probe runs BEFORE the phase loop begins —
// before the FIRST prepared mutation of ANY phase — and is READ ONLY: on any
// violation it throws and performs no repair, re-grant or provision of any
// kind. It selects exactly the row set stella_0001's own canonical
// membership precondition selects, so it fails on precisely the condition
// that precondition would otherwise reject much later in the chain.
const R3_4_PREFLIGHT_BOOTSTRAP_SUPERUSER_OID = 10

export async function runR3_4PreMutationPreflight(sql: postgres.Sql): Promise<void> {
  // Fact 1: the five uellix_* roles exist.
  const [roleCheck] = await sql<{ missing: string | null }[]>`
    SELECT string_agg(r.name, ', ' ORDER BY r.name) AS missing
    FROM (VALUES ('uellix_owner'), ('uellix_migrator'), ('uellix_app'), ('uellix_writer'), ('uellix_auditor')) AS r(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name)
  `
  if (roleCheck?.missing) {
    throw new Error(
      `R3.4 preflight FAILED (fact 1): missing uellix_* role(s): ${roleCheck.missing}. ` +
        'db/prepared/stella_local_0000_local_role_identity_bootstrap.sql has not run, or did not succeed.'
    )
  }

  // Facts 2 and 3: no relevant pg_auth_members row has a grantor other than
  // the fixed bootstrap-superuser oid (10), and none carries admin_option.
  // RELEVANT mirrors stella_0001's own precondition selection exactly:
  // member IN (app, writer, migrator) OR roleid IN (app, writer, owner, migrator).
  const badRows = await sql<
    { member: string; role: string; grantor: number; grantorName: string; adminOption: boolean }[]
  >`
    SELECT m.rolname AS member, r.rolname AS role, a.grantor, g.rolname AS "grantorName", a.admin_option AS "adminOption"
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE (m.rolname IN ('uellix_app', 'uellix_writer', 'uellix_migrator')
        OR r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator'))
      AND (a.grantor <> ${R3_4_PREFLIGHT_BOOTSTRAP_SUPERUSER_OID} OR a.admin_option)
  `
  if (badRows.length > 0) {
    const detail = badRows
      .map((r) => `${r.member}->${r.role} granted-by=${r.grantorName}(oid=${r.grantor}) admin=${r.adminOption}`)
      .join(', ')
    throw new Error(
      `R3.4 preflight FAILED (facts 2/3): unexpected relevant membership row(s) (wrong grantor or ADMIN escalation): ${detail}. ` +
        'This indicates role creation or membership A/B ran under the wrong actor (must be supabase_admin, oid 10), or an unauthorized ADMIN grant exists.'
    )
  }

  // Fact 4: uellix_owner has CREATE on schema public.
  const [publicCheck] = await sql<{ hasCreate: boolean }[]>`
    SELECT has_schema_privilege('uellix_owner', 'public', 'CREATE') AS "hasCreate"
  `
  if (!publicCheck?.hasCreate) {
    throw new Error(
      'R3.4 preflight FAILED (fact 4): uellix_owner lacks CREATE on schema public. ' +
        'db/prepared/stella_local_0000_local_role_identity_bootstrap.sql has not run, or did not succeed.'
    )
  }

  // Fact 5: uellix_owner has USAGE on schema auth.
  const [authCheck] = await sql<{ hasUsage: boolean }[]>`
    SELECT has_schema_privilege('uellix_owner', 'auth', 'USAGE') AS "hasUsage"
  `
  if (!authCheck?.hasUsage) {
    throw new Error(
      'R3.4 preflight FAILED (fact 5): uellix_owner lacks USAGE on schema auth. ' +
        'db/prepared/stella_local_0000_local_role_identity_bootstrap.sql has not run, or did not succeed.'
    )
  }

  console.log('[r3.4] pre-mutation preflight PASS: five roles present, grantor/ADMIN clean, public CREATE and auth USAGE present.')
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

  // Read-only, BEFORE the first prepared mutation of ANY phase — see
  // runR3_4PreMutationPreflight. A dedicated, closed connection: this probe
  // never shares a session with a phase.
  const preflightClient = createAdministrativeClient()
  try {
    await runR3_4PreMutationPreflight(preflightClient.sql)
  } finally {
    await preflightClient.close()
  }

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
