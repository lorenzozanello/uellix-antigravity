// scripts/rotate-local-role-credentials.ts
//
// Mints LOGIN credentials for this worktree's `uellix_app`, `uellix_migrator`
// and `uellix_auditor` roles, then writes each one into the env file that the
// capability which needs it — and only that capability — reads.
//
// WHY A SCRIPT AND NOT A SQL FILE
//
// `db/prepared/stella_0005_runtime_cutover.sql` is committed, reviewed and
// replayable. A password in it would be a password in git. So the cutover SQL
// asserts that the roles CAN log in and never learns how; this script is the
// only thing that knows a password, holds it for the length of one process,
// and writes it to a gitignored file.
//
// WHY THE PASSWORD NEVER APPEARS IN A STATEMENT
//
// This stack runs with `log_statement = ddl`, and `ALTER ROLE ... PASSWORD` is
// DDL — issued from the client it would be written verbatim into the server
// log, password included. Two things prevent that here:
//
//   1. the password travels as a BOUND PARAMETER of a `set_config()` call,
//      which is not DDL and is not logged at this level;
//   2. the `ALTER ROLE` itself is built and run by `EXECUTE` inside a `DO`
//      block. `log_statement` only records statements received from a client,
//      never ones a PL/pgSQL body executes, so the log records the `DO` and
//      not what it did.
//
// The GUC is set with `is_local => true`, so it is discarded when the
// surrounding transaction ends even if the process dies mid-run.
//
// Nothing here prints a password, and nothing returns one to a caller. The
// only evidence emitted is a truncated SHA-256 fingerprint, which is enough to
// tell "the three roles got three DIFFERENT secrets" apart from "the same
// secret three times" without disclosing any of them.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLocalDatabaseClient } from '../db/client'
import {
  AUDITOR_DATABASE_ROLE,
  MIGRATOR_DATABASE_ROLE,
  RUNTIME_DATABASE_ROLE,
} from '../db/safety/database-role'
import {
  AUDITOR_DATABASE_URL_ENV_VAR,
  LEGACY_SHARED_DATABASE_URL_ENV_VAR,
  MIGRATOR_DATABASE_URL_ENV_VAR,
  RUNTIME_DATABASE_URL_ENV_VAR,
} from '../db/safety/resolve-capability-database-url'
import {
  LOCAL_CREDENTIAL_ROTATION_CONFIRMATION,
  LOCAL_DB_PORT,
  LOCAL_PROJECT_ID,
} from '../db/safety/local-stack'

/* -------------------------------------------------------------------------- */
/* Target files                                                               */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(import.meta.dirname, '..')

/**
 * Which file each credential lands in. The split is the control, not a
 * convention: Next.js loads `.env.local`, and does NOT load
 * `.env.migration.local` or `.env.audit.local` — those names are not in its
 * env-file list at all. So a rendering process cannot read the migration
 * credential even if some future code asks for it by name.
 */
const ROLE_TARGETS = [
  {
    role: RUNTIME_DATABASE_ROLE,
    envVar: RUNTIME_DATABASE_URL_ENV_VAR,
    file: '.env.local',
    loadedByNextJs: true,
  },
  {
    role: MIGRATOR_DATABASE_ROLE,
    envVar: MIGRATOR_DATABASE_URL_ENV_VAR,
    file: '.env.migration.local',
    loadedByNextJs: false,
  },
  {
    role: AUDITOR_DATABASE_ROLE,
    envVar: AUDITOR_DATABASE_URL_ENV_VAR,
    file: '.env.audit.local',
    loadedByNextJs: false,
  },
] as const

const FILE_HEADERS: Readonly<Record<string, string>> = {
  '.env.local':
    '# Local runtime configuration for this worktree. Gitignored (.env*).\n' +
    '# The database URL here authenticates as the LEAST-PRIVILEGE role and is the\n' +
    '# only database credential Next.js is allowed to load.\n',
  '.env.migration.local':
    '# Migration credential. Gitignored (.env*).\n' +
    '# NOT loaded by Next.js — this filename is not in its env-file list. Read only\n' +
    '# by the migration wrapper (pnpm db:migrate:local).\n',
  '.env.audit.local':
    '# Read-only audit credential. Gitignored (.env*).\n' +
    '# NOT loaded by Next.js. The role also carries default_transaction_read_only=on\n' +
    '# server-side, so read-only is enforced by the server and not by convention.\n',
}

/* -------------------------------------------------------------------------- */
/* Secret handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 32 bytes from the CSPRNG, base64url-encoded.
 *
 * base64url is chosen so the value survives placement in a URL's userinfo
 * without percent-encoding — a password that needs escaping is a password that
 * gets escaped WRONG somewhere down the line, and the failure mode is an
 * authentication error that looks like a permissions problem.
 */
function generatePassword(): string {
  return randomBytes(32).toString('base64url')
}

/** Truncated SHA-256. Enough to compare two secrets; not enough to be one. */
function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12)
}

function allDistinct(secrets: readonly string[]): boolean {
  for (let i = 0; i < secrets.length; i += 1) {
    for (let j = i + 1; j < secrets.length; j += 1) {
      const a = Buffer.from(secrets[i], 'utf8')
      const b = Buffer.from(secrets[j], 'utf8')
      if (a.length === b.length && timingSafeEqual(a, b)) return false
    }
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* Env file editing                                                           */
/* -------------------------------------------------------------------------- */

function upsertEnvVar(filePath: string, key: string, value: string, header: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : header
  const lines = existing.split(/\r?\n/)
  const assignment = `${key}=${value}`
  let replaced = false

  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true
      return assignment
    }
    return line
  })

  if (!replaced) {
    while (next.length > 0 && next[next.length - 1] === '') next.pop()
    next.push(assignment)
  }

  writeFileSync(filePath, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
}

function removeEnvVar(filePath: string, key: string): boolean {
  if (!existsSync(filePath)) return false
  const existing = readFileSync(filePath, 'utf8')
  const lines = existing.split(/\r?\n/)
  const kept = lines.filter((line) => !line.startsWith(`${key}=`))
  if (kept.length === lines.length) return false
  writeFileSync(filePath, `${kept.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
  return true
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const confirmation = process.argv[2]

  // The guard checks this too. Checking it here first means the operator gets
  // the usage line instead of a stack trace from inside the safety layer.
  if (confirmation !== LOCAL_CREDENTIAL_ROTATION_CONFIRMATION) {
    console.error(
      'Refusing to rotate credentials without the exact confirmation token.\n\n' +
        `  pnpm tsx scripts/rotate-local-role-credentials.ts ${LOCAL_CREDENTIAL_ROTATION_CONFIRMATION}\n\n` +
        'The token names the project id on purpose: several local stacks run on this host, ' +
        'and rotating the wrong one locks its runtime out.'
    )
    process.exitCode = 1
    return
  }

  const client = createLocalDatabaseClient({
    capability: 'local_role_credential_rotation',
    expectedLocalPort: LOCAL_DB_PORT,
    expectedProjectId: LOCAL_PROJECT_ID,
    confirmation,
  })

  for (const warning of client.warnings) console.warn(`[rotate] ${warning}`)
  console.log(`[rotate] ${client.decision.auditLine}`)

  const secrets = ROLE_TARGETS.map(() => generatePassword())
  if (!allDistinct(secrets)) {
    // Astronomically unlikely; a hard stop anyway, because "the migrator and
    // the runtime happen to share a password" silently collapses the whole
    // separation this cutover exists to create.
    throw new Error('Generated credentials were not distinct. Aborting without writing anything.')
  }

  const written: { role: string; file: string; fingerprint: string }[] = []

  try {
    for (const [index, target] of ROLE_TARGETS.entries()) {
      const password = secrets[index]

      // One transaction per role. `is_local => true` on both GUCs means the
      // secret is dropped from the session the moment this COMMIT lands, and
      // is never reachable by a later statement on the same pooled connection.
      await client.sql.begin(async (tx) => {
        await tx`SELECT set_config('uellix.rotating_role', ${target.role}, true)`
        await tx`SELECT set_config('uellix.rotating_password', ${password}, true)`
        await tx.unsafe(`
          DO $rotate$
          BEGIN
            EXECUTE format(
              'ALTER ROLE %I LOGIN PASSWORD %L',
              current_setting('uellix.rotating_role'),
              current_setting('uellix.rotating_password')
            );
          END
          $rotate$
        `)
      })

      // Proof of possession, not proof of configuration: open a REAL
      // connection with the credential just minted and ask the server which
      // role it authenticated. A rotation that "succeeded" but left the role
      // unable to log in would otherwise surface much later, as a runtime
      // outage rather than as a failed rotation.
      const url =
        `postgresql://${encodeURIComponent(target.role)}:${encodeURIComponent(password)}` +
        `@127.0.0.1:${LOCAL_DB_PORT}/postgres`

      const verifier = createLocalDatabaseClient({
        capability: 'local_role_credential_rotation',
        expectedLocalPort: LOCAL_DB_PORT,
        expectedProjectId: LOCAL_PROJECT_ID,
        confirmation,
        env: { ...process.env, UELLIX_LOCAL_DATABASE_URL: url },
      })
      try {
        const [row] = await verifier.sql<{ session_user: string }[]>`SELECT session_user`
        if (row?.session_user !== target.role) {
          throw new Error(
            `Rotation for "${target.role}" verified as a different role. Nothing was written.`
          )
        }
      } finally {
        await verifier.close()
      }

      const filePath = resolve(REPO_ROOT, target.file)
      upsertEnvVar(filePath, target.envVar, url, FILE_HEADERS[target.file] ?? '')
      written.push({ role: target.role, file: target.file, fingerprint: fingerprint(password) })
    }
  } finally {
    await client.close()
  }

  // The administrative URL must stop being loadable by Next.js. Leaving it in
  // place would mean the cutover changed which variable the runtime PREFERS
  // while keeping the over-privileged one within arm's reach.
  const removed = removeEnvVar(
    resolve(REPO_ROOT, '.env.local'),
    LEGACY_SHARED_DATABASE_URL_ENV_VAR
  )

  console.log('\n[rotate] credentials rotated (values never printed):')
  for (const entry of written) {
    console.log(`  ${entry.role.padEnd(16)} -> ${entry.file.padEnd(22)} sha256:${entry.fingerprint}…`)
  }
  if (removed) {
    console.log(
      `\n[rotate] removed ${LEGACY_SHARED_DATABASE_URL_ENV_VAR} from .env.local — the runtime no ` +
        'longer has an administrative connection string available to it.'
    )
  }
}

void main().catch((error: unknown) => {
  console.error('[rotate] failed:', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
})
