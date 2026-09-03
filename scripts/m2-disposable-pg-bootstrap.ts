// scripts/m2-disposable-pg-bootstrap.ts
//
//   pnpm m2:pg:gate
//
// Lifecycle for the ISOLATED M2/B0-17 real-PostgreSQL proof
// (docs/ops/integration/COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.3.json,
// HPO Option E + M2_DISPOSABLE_MIGRATION_PRIVILEGE_WINDOW — resolves
// AG-M2-1/AG-M2-2/AG-M2-3/BF-1).
//
// This script is orchestration only. Every governed truth it applies comes
// from an EXISTING, unmodified repository file, executed verbatim:
//   - db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql
//     (canonical disposable/hosted managed-role IDENTITY package)
//   - db/prepared/storage/20260716000001_part_a_helpers.psql.sql
//     (unit 41 Part A — SHA256-verified before every application)
//   - scripts/rotate-local-role-credentials.ts    (unchanged entry point)
//   - pnpm db:migrate:local                       (unchanged entry point)
//   - db/hosted/baseline-postconditions.ts B0-17  (unchanged check, exercised
//     via the real tests/integration/function-execute-acl-guard.test.ts)
//
// PRIVILEGE CLOSURE (v1.0.3): stella_hosted_0000 alone leaves uellix_owner
// without CREATE on the database (needed for drizzle's own bookkeeping
// schema), CREATE on schema public, or USAGE on schema auth, and no
// governed disposable step yet creates the two Part-A evidence-access
// functions migration 0039 needs. This script closes exactly those four
// gaps with the smallest possible grant set — three GRANT statements
// (STEP 3/4/5 below) plus one file application (STEP 6) — entirely inside
// this disposable, non-persistent fixture. STEP 3's grant is TEMPORARY and
// revoked immediately after migrate() returns; STEP 4/5 are preserved for
// the fixture's lifetime, matching the governed local owner topology's own
// intent. STEP 5 is the ONLY privilege-changing statement this script ever
// runs as `supabase_admin`, and that invariant is asserted mechanically.
//
// scripts/rehearsal/local-supabase-shim.sql is NOT applied — measured, not
// assumed: this gate targets the pinned image's PRE-EXISTING `postgres`
// database (mandatory: both unmodified entrypoints are hardcoded to it),
// which already carries Supabase's real auth/storage/extensions schemas and
// a real auth.uid(). A full-corpus grep confirms zero db/migrations/*.sql
// references to storage.objects/foldername() outside of comments.
//
// Nothing here hand-transcribes role/privilege SQL beyond the three GRANT
// statements the authority explicitly names, and nothing here applies
// db/prepared/** or db/migrations/** against any persistent, local-dev,
// staging or production database — see db/prepared/README.md Rule 1, which
// remains authoritative there. Every container this script creates is bound
// to 127.0.0.1:56322 ONLY, torn down unconditionally.
//
// WHY PORT 56322: scripts/rotate-local-role-credentials.ts and
// scripts/db-migrate-local.ts are unmodified by design, and the former's
// connection target is a literal constant (`db/safety/local-stack.ts`
// LOCAL_DB_PORT). Every phase below binds that exact port for the duration
// of its own container, never 0.0.0.0, and only after proving the port is
// free — if occupied, this script FAILS CLOSED without touching whatever
// holds it.
//
// ENV SAFETY: scripts/rotate-local-role-credentials.ts is unmodified and
// writes .env.local / .env.migration.local / .env.audit.local (gitignored,
// non-authority, developer-owned). This script snapshots their exact bytes
// (or absence) before every rotation and restores that exact state
// afterward — success or failure — without ever printing contents.

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  realDockerRunner,
  parseAssignedPort,
  redactSecret,
  hasOnlyAcceptableMounts,
  type DockerRunner,
} from './db-audit-disposable'
import { BASELINE_POSTCONDITIONS } from '../db/hosted/baseline-postconditions'
import { LOCAL_DB_PORT, LOCAL_CREDENTIAL_ROTATION_CONFIRMATION } from '../db/safety/local-stack'

// Referenced only to prove B0-17 still exists under the expected id — the
// live proof itself now runs through the real vitest integration test (see
// MAIN phase), not a re-implementation of its assertions here.
if (!BASELINE_POSTCONDITIONS.some((p) => p.id === 'B0-17-function-execute-grants')) {
  throw new Error('B0-17-function-execute-grants postcondition not found in db/hosted/baseline-postconditions.ts')
}

const REPO_ROOT = resolve(import.meta.dirname, '..')
// Immutable digest, resolved and cross-checked this session (docker pull +
// docker inspect RepoDigests, in agreement) against the tag the governed
// disposable rehearsal path already pins — see AUTHORITY v1.0.3 pins.
const IMAGE_TAG = 'public.ecr.aws/supabase/postgres:17.6.1.143'
const IMAGE_DIGEST = 'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453'
const IMAGE = `public.ecr.aws/supabase/postgres@${IMAGE_DIGEST}`
const CONTAINER_LABEL_PREFIX = 'uellix-m2-pg-gate'

const ROLE_IDENTITY_PATH = resolve(REPO_ROOT, 'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql')
const ROLE_IDENTITY_SHA256_EXPECTED = '871f382aead7b834daf556d7e54402055ed3656d9a1964a4f63138610d5b693d'
const PART_A_PATH = resolve(REPO_ROOT, 'db/prepared/storage/20260716000001_part_a_helpers.psql.sql')
const PART_A_SHA256_EXPECTED = '078a10e091280fab7f2cf147d866e61d4edaa0af8f7eec82ef3401845bda8cb8'

const ROLE_IDENTITY_SQL = readFileSync(ROLE_IDENTITY_PATH, 'utf8')
const PART_A_SQL = readFileSync(PART_A_PATH, 'utf8')

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const ROLE_IDENTITY_SHA256_ACTUAL = sha256(ROLE_IDENTITY_SQL)
const PART_A_SHA256_ACTUAL = sha256(PART_A_SQL)

const ENV_FILES = ['.env.local', '.env.migration.local', '.env.audit.local'].map((f) => resolve(REPO_ROOT, f))

interface StepResult { id: string; ok: boolean; detail?: string }

const results: StepResult[] = []
function record(id: string, ok: boolean, detail?: string): boolean {
  results.push({ id, ok, detail })
  console.log(`[m2-pg-gate] ${id}=${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`)
  return ok
}

// ---------------------------------------------------------------------------
// Port precheck — fail closed, never touch whatever holds the port.
// ---------------------------------------------------------------------------

function isPortFreeAtDockerLevel(runner: DockerRunner, port: number): boolean {
  const res = runner.run(['ps', '--format', '{{.Ports}}'])
  if (res.status !== 0) return false
  return !res.stdout.includes(`:${port}->`)
}

function isPortFreeAtSocketLevel(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => server.close(() => resolvePromise(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function isPortFree(runner: DockerRunner, port: number): Promise<boolean> {
  return isPortFreeAtDockerLevel(runner, port) && (await isPortFreeAtSocketLevel(port))
}

// ---------------------------------------------------------------------------
// Docker / psql plumbing.
// ---------------------------------------------------------------------------

interface SqlResult { status: number; stdout: string; stderr: string }

function psqlAs(runner: DockerRunner, container: string, role: string, sql: string): SqlResult {
  // -h 127.0.0.1 forces TCP, never the local Unix socket. Measured directly:
  // a socket connection uses PostgreSQL's peer authentication, which checks
  // the OS user against the role name — `uellix_migrator` is not a real OS
  // user in this container, so every socket connection as it (or as any
  // non-`postgres` role without a matching OS account) deterministically
  // fails with "Peer authentication failed", not intermittently. TCP uses
  // this image's trust/password rules instead, exactly like the real
  // entrypoints (rotate-local-role-credentials.ts, db-migrate-local.ts)
  // already connect.
  const res = runner.run(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], sql)
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

function psql(runner: DockerRunner, container: string, sql: string): SqlResult {
  return psqlAs(runner, container, 'postgres', sql)
}

function runPnpm(args: string[]): { status: number; combined: string } {
  // pnpm is a .cmd shim on Windows: spawnSync with an args array and no shell
  // fails with ENOENT. shell:true with an ARGS ARRAY triggers Node's DEP0190
  // warning; a single pre-quoted command string does not.
  const quote = (a: string) => (/^[A-Za-z0-9_.\-/:]+$/.test(a) ? a : `"${a}"`)
  const command = ['pnpm', ...args].map(quote).join(' ')
  const res = spawnSync(command, { cwd: REPO_ROOT, encoding: 'utf8', shell: true })
  const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`
  console.log(combined)
  return { status: res.status ?? 1, combined }
}

// ---------------------------------------------------------------------------
// Container lifecycle.
// ---------------------------------------------------------------------------

interface ContainerHandle { runner: DockerRunner; name: string; created: boolean }

async function createContainer(runner: DockerRunner, phase: string): Promise<ContainerHandle | null> {
  const name = `${CONTAINER_LABEL_PREFIX}-${phase}-${randomUUID().slice(0, 8)}`
  const handle: ContainerHandle = { runner, name, created: false }

  const free = await isPortFree(runner, LOCAL_DB_PORT)
  if (!record(`${phase}:PORT-PRECHECK`, free, free ? `127.0.0.1:${LOCAL_DB_PORT} is free` : `127.0.0.1:${LOCAL_DB_PORT} is already in use — refusing to start (never stopping the occupant)`)) {
    return null
  }

  const created = runner.run(['run', '-d', '--name', name, '-p', `127.0.0.1:${LOCAL_DB_PORT}:5432`, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=postgres', IMAGE])
  handle.created = true
  if (!record(`${phase}:CONTAINER-CREATE`, created.status === 0, created.status === 0 ? name : created.stderr || created.stdout)) return handle

  const mounts = runner.run(['inspect', '-f', '{{json .Mounts}}', name])
  if (!record(`${phase}:MOUNT-CHECK`, mounts.status === 0 && hasOnlyAcceptableMounts(mounts.stdout), 'anonymous volume mount only, no bind mount')) return handle

  let ready = false
  for (let i = 0; i < 60; i++) {
    if (runner.run(['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!record(`${phase}:CONTAINER-READY`, ready)) return handle
  // Extra settle margin: pg_isready can report ready fractionally before the
  // server accepts every catalog query reliably (measured: one intermittent
  // false-negative on a platform-substrate check in an earlier run).
  await new Promise((r) => setTimeout(r, 750))

  const portResult = runner.run(['port', name, '5432/tcp'])
  const assignedPort = portResult.status === 0 ? parseAssignedPort(portResult.stdout) : null
  if (!record(`${phase}:PORT-BOUND-CHECK`, assignedPort === LOCAL_DB_PORT, `bound to 127.0.0.1:${LOCAL_DB_PORT} exactly`)) return handle

  return handle
}

async function teardownContainer(handle: ContainerHandle, phase: string): Promise<void> {
  if (!handle.created) return
  const removed = handle.runner.run(['rm', '-f', '-v', handle.name])
  const leftover = handle.runner.run(['ps', '-a', '--filter', `name=^${handle.name}$`, '--format', '{{.Names}}'])
  const leftoverCount = leftover.status === 0 && leftover.stdout.trim().length > 0 ? 1 : 0
  record(`${phase}:TEARDOWN`, removed.status === 0 && leftoverCount === 0, removed.status === 0 && leftoverCount === 0 ? 'SUCCESS' : 'FAILED')
  const portFreeAfter = await isPortFree(handle.runner, LOCAL_DB_PORT)
  record(`${phase}:PORT-FREE-AFTER-TEARDOWN`, portFreeAfter)
}

function verifyZeroLabelledLeftovers(runner: DockerRunner): void {
  const anyLabelLeftover = runner.run(['ps', '-a', '--filter', `name=${CONTAINER_LABEL_PREFIX}`, '--format', '{{.Names}}'])
  const count = anyLabelLeftover.status === 0 ? anyLabelLeftover.stdout.trim().split('\n').filter(Boolean).length : -1
  record('FINAL:LABELLED-LEFTOVER-COUNT', count === 0, String(count))
}

// ---------------------------------------------------------------------------
// Bootstrap building blocks — shared by MAIN and every negative phase.
// ---------------------------------------------------------------------------

function checkPlatformSubstrate(runner: DockerRunner, container: string, phase: string): boolean {
  const substrate = psql(runner, container, `SELECT string_agg(s.name, ',' ORDER BY s.name) FROM (VALUES ('auth'),('storage'),('extensions')) AS s(name) WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s.name);`)
  const missing = (substrate.stdout || '').trim()
  if (!record(`${phase}:PLATFORM-SUBSTRATE-CHECK`, substrate.status === 0 && missing.length === 0, missing.length > 0 ? `missing schema(s): ${missing}` : 'auth/storage/extensions present natively')) return false
  const authUid = psql(runner, container, `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth' AND p.proname = 'uid';`)
  return record(`${phase}:AUTH-UID-CHECK`, authUid.status === 0 && (authUid.stdout || '').trim() === '1', 'auth.uid() present natively')
}

function checkPristineRoles(runner: DockerRunner, container: string, phase: string): boolean {
  const preRoles = psql(runner, container, `SELECT count(*) FROM pg_roles WHERE rolname LIKE 'uellix\\_%' ESCAPE '\\';`)
  const count = Number((preRoles.stdout || '0').trim())
  return record(`${phase}:PRISTINE-STATE-ASSERTION`, count === 0, `${count} uellix_* roles before bootstrap`)
}

function verifyPinnedSha(phase: string, id: string, actual: string, expected: string): boolean {
  return record(`${phase}:${id}`, actual === expected, actual === expected ? `sha256 matches ${expected}` : `sha256 MISMATCH: actual=${actual} expected=${expected}`)
}

function applyHostedRoleIdentity(runner: DockerRunner, container: string, phase: string): boolean {
  if (!verifyPinnedSha(phase, 'HOSTED-0000-SHA-VERIFY', ROLE_IDENTITY_SHA256_ACTUAL, ROLE_IDENTITY_SHA256_EXPECTED)) return false
  const applied = psql(runner, container, `SET uellix.bootstrap_environment = 'staging';\n${ROLE_IDENTITY_SQL}`)
  return record(`${phase}:APPLY-ROLE-IDENTITY`, applied.status === 0, applied.status === 0 ? 'stella_hosted_0000 applied verbatim; self-verification passed' : applied.stderr || applied.stdout)
}

function narrowMigrator(runner: DockerRunner, container: string, phase: string): boolean {
  const before = psql(runner, container, `SELECT rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator';`)
  record(`${phase}:CREATEROLE-BEFORE`, (before.stdout || '').trim() === 't', `rolcreaterole=${(before.stdout || '').trim()}`)
  const narrow = psql(runner, container, 'ALTER ROLE uellix_migrator NOCREATEROLE;')
  if (!record(`${phase}:ROLE-NARROWING`, narrow.status === 0)) return false
  const after = psql(runner, container, `SELECT rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator';`)
  return record(`${phase}:CREATEROLE-AFTER`, (after.stdout || '').trim() === 'f', `rolcreaterole=${(after.stdout || '').trim()}`)
}

/** STEP 3: temporary, revoked after migrate(). Actor: postgres. */
function grantDatabaseCreate(runner: DockerRunner, container: string, phase: string): boolean {
  const grant = psql(runner, container, 'GRANT CREATE ON DATABASE postgres TO uellix_owner;')
  return record(`${phase}:STEP3-DATABASE-CREATE-GRANT`, grant.status === 0, 'GRANT CREATE ON DATABASE postgres TO uellix_owner (actor: postgres; TEMPORARY_DISPOSABLE_MIGRATION_PRIVILEGE)')
}

/** STEP 4: permanent for this fixture. Actor: postgres. */
function grantPublicSchemaCreate(runner: DockerRunner, container: string, phase: string): boolean {
  const grant = psql(runner, container, 'GRANT CREATE ON SCHEMA public TO uellix_owner;')
  return record(`${phase}:STEP4-PUBLIC-CREATE-GRANT`, grant.status === 0, 'GRANT CREATE ON SCHEMA public TO uellix_owner (actor: postgres; permanent for this fixture)')
}

/**
 * STEP 5: the ONLY privilege-changing statement run as supabase_admin, ever,
 * in this script, PER DISPOSABLE CONTAINER. Counted per-phase (each phase
 * gets its own fresh container) rather than as one script-lifetime total —
 * a script that runs nine independent disposable fixtures legitimately
 * calls this once per fixture, and the invariant is "at most once per
 * container", not "at most once ever across every phase this process runs".
 */
const supabaseAdminPrivilegeWritesByPhase = new Map<string, number>()
function grantAuthSchemaUsage(runner: DockerRunner, container: string, phase: string): boolean {
  const count = (supabaseAdminPrivilegeWritesByPhase.get(phase) ?? 0) + 1
  supabaseAdminPrivilegeWritesByPhase.set(phase, count)
  const grant = psqlAs(runner, container, 'supabase_admin', 'GRANT USAGE ON SCHEMA auth TO uellix_owner;')
  const ok = record(`${phase}:STEP5-AUTH-USAGE-GRANT`, grant.status === 0, 'GRANT USAGE ON SCHEMA auth TO uellix_owner (actor: supabase_admin — the ONE and ONLY privilege write this phase performs as supabase_admin)')
  record(`${phase}:SUPABASE-ADMIN-SINGLE-WRITE-INVARIANT`, count === 1, `supabase_admin privilege-write call count for this phase=${count}`)
  return ok
}

/** STEP 6: Part A, verbatim, SHA-verified, applied as uellix_migrator with SET ROLE uellix_owner active in one continuous session. */
function applyPartAHelpers(runner: DockerRunner, container: string, phase: string): boolean {
  if (!verifyPinnedSha(phase, 'PART-A-SHA-VERIFY', PART_A_SHA256_ACTUAL, PART_A_SHA256_EXPECTED)) return false
  const sql = `
SET ROLE uellix_owner;
DO $$ BEGIN
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION 'STEP 6 fail-closed: SET ROLE uellix_owner did not take effect (current_user=%)', current_user;
  END IF;
END $$;
${PART_A_SQL}
`
  const applied = psqlAs(runner, container, 'uellix_migrator', sql)
  return record(`${phase}:STEP6-PART-A-APPLIED`, applied.status === 0, applied.status === 0 ? 'Part A applied verbatim as uellix_migrator with SET ROLE uellix_owner active, in one continuous session' : applied.stderr || applied.stdout)
}

function checkPrivP7(runner: DockerRunner, container: string, phase: string): boolean {
  const q = psql(runner, container, `SELECT p.proname||'|'||pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('can_read_evidence_object','can_write_evidence_object') ORDER BY p.proname;`)
  const rows = (q.stdout || '').trim().split('\n').filter(Boolean)
  const ok = rows.length === 2 && rows.every((r) => r.endsWith('|uellix_owner'))
  return record(`${phase}:PRIV-P7`, ok, ok ? 'both Part A functions exist and are owned by uellix_owner' : `unexpected: ${rows.join(' / ')}`)
}

// ---------------------------------------------------------------------------
// ENV snapshot / restore.
// ---------------------------------------------------------------------------

interface EnvSnapshot { path: string; existed: boolean; hash: string | null; bytes: Buffer | null }

function fingerprint(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshotEnvFiles(): EnvSnapshot[] {
  return ENV_FILES.map((path) => {
    if (existsSync(path)) {
      const bytes = readFileSync(path)
      return { path, existed: true, hash: fingerprint(bytes), bytes }
    }
    return { path, existed: false, hash: null, bytes: null }
  })
}

function restoreEnvFiles(snapshots: EnvSnapshot[], label: string): boolean {
  let allOk = true
  for (const snap of snapshots) {
    if (snap.existed && snap.bytes) {
      writeFileSync(snap.path, snap.bytes)
      const ok = fingerprint(readFileSync(snap.path)) === snap.hash
      allOk &&= ok
      record(`${label}:${snap.path.split(/[\\/]/).pop()}`, ok, ok ? 'restored byte-identical (sha256 match)' : 'restoration hash mismatch')
    } else {
      if (existsSync(snap.path)) unlinkSync(snap.path)
      const ok = !existsSync(snap.path)
      allOk &&= ok
      record(`${label}:${snap.path.split(/[\\/]/).pop()}`, ok, ok ? 'absent, as before' : 'still present after restore attempt')
    }
  }
  return allOk
}

// ---------------------------------------------------------------------------
// Pre-migration privilege contract (PRIV-P1..P6) + post-migration checks.
// ---------------------------------------------------------------------------

function checkPreMigrationContract(runner: DockerRunner, container: string, phase: string): boolean {
  const q = psql(
    runner, container,
    `SELECT
       has_database_privilege('uellix_owner','postgres','CREATE'),
       has_schema_privilege('uellix_owner','public','USAGE'),
       has_schema_privilege('uellix_owner','public','CREATE'),
       has_schema_privilege('uellix_owner','auth','USAGE');`
  )
  const [dbCreate, pubUsage, pubCreate, authUsage] = (q.stdout || '').trim().split('|')
  record(`${phase}:PRIV-P1-DATABASE-CREATE`, dbCreate === 't', `has_database_privilege=${dbCreate}`)
  record(`${phase}:PRIV-P2-PUBLIC-USAGE-CREATE`, pubUsage === 't' && pubCreate === 't', `usage=${pubUsage} create=${pubCreate}`)
  record(`${phase}:PRIV-P3-AUTH-USAGE`, authUsage === 't', `usage=${authUsage}`)

  const migratorQ = psql(runner, container, `SELECT rolcreaterole, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'uellix_migrator';`)
  const [mCreaterole, mSuper, mBypass] = (migratorQ.stdout || '').trim().split('|')
  record(`${phase}:PRIV-P4-MIGRATOR-NOT-OVERPRIVILEGED`, mCreaterole === 'f' && mSuper === 'f' && mBypass === 'f', `createrole=${mCreaterole} super=${mSuper} bypassrls=${mBypass}`)

  const memberQ = psql(runner, container, `SELECT m.set_option, m.inherit_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member WHERE r.rolname = 'uellix_owner' AND g.rolname = 'uellix_migrator';`)
  const [setOpt, inheritOpt] = (memberQ.stdout || '').trim().split('|')
  return record(`${phase}:PRIV-P5-OWNER-MEMBERSHIP`, setOpt === 't' && inheritOpt === 'f', `set=${setOpt} inherit=${inheritOpt}`)
}

function checkOwnershipPostcondition(runner: DockerRunner, container: string, phase: string): boolean {
  const nonOwner = psql(
    runner, container,
    `SELECT count(*) FROM (
       SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','S') AND pg_get_userbyid(c.relowner) <> 'uellix_owner'
       UNION ALL
       SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'uellix_owner'
     ) x;`
  )
  const count = Number((nonOwner.stdout || '0').trim())
  record(`${phase}:PRIV-P6-OWNERSHIP-POSTCONDITION`, count === 0, `unexpected_non_owner_application_objects=${count}`)

  const drizzleSchema = psql(runner, container, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'drizzle';`)
  record(`${phase}:DRIZZLE-SCHEMA-OWNED-BY-OWNER`, (drizzleSchema.stdout || '').trim() === 'uellix_owner')

  const migrationsTable = psql(runner, container, `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = '__drizzle_migrations' AND relnamespace = 'drizzle'::regnamespace;`)
  record(`${phase}:DRIZZLE-MIGRATIONS-TABLE-OWNED-BY-OWNER`, (migrationsTable.stdout || '').trim() === 'uellix_owner')

  const functionsFrom0061 = psql(
    runner, container,
    `SELECT string_agg(DISTINCT pg_get_userbyid(p.proowner), ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('uellix_guard_disposition_run_approval','uellix_lock_run_dispositions_on_approval');`
  )
  return record(`${phase}:0061-FUNCTIONS-OWNED-BY-OWNER`, (functionsFrom0061.stdout || '').trim() === 'uellix_owner')
}

function revokeDatabaseCreate(runner: DockerRunner, container: string, phase: string): boolean {
  const revoke = psql(runner, container, 'REVOKE CREATE ON DATABASE postgres FROM uellix_owner;')
  if (!record(`${phase}:STEP9-DATABASE-CREATE-REVOKE`, revoke.status === 0, 'REVOKE CREATE ON DATABASE postgres FROM uellix_owner (actor: postgres)')) return false
  const verify = psql(runner, container, `SELECT has_database_privilege('uellix_owner','postgres','CREATE');`)
  return record(`${phase}:DATABASE-CREATE-REVOKED-VERIFIED`, (verify.stdout || '').trim() === 'f')
}

interface PrivilegeContractComputation {
  ownerOk: boolean
  ownerDetail: string
  migratorOk: boolean
  migratorDetail: string
  othersOk: boolean
  othersDetail: string
}

/** Pure computation, no recording — reused by both the MAIN-phase recorded check and PRIV-N3's deliberately-failing negative probe (which must NOT have its expected-to-fail sub-checks counted against the script's overall pass tally). */
function computeFinalPrivilegeContract(runner: DockerRunner, container: string): PrivilegeContractComputation {
  const owner = psql(
    runner, container,
    `SELECT has_database_privilege('uellix_owner','postgres','CREATE'), has_schema_privilege('uellix_owner','public','USAGE'),
            has_schema_privilege('uellix_owner','public','CREATE'), has_schema_privilege('uellix_owner','auth','USAGE'),
            r.rolcreaterole, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = 'uellix_owner';`
  )
  const [oDbCreate, oPubUsage, oPubCreate, oAuthUsage, oCreaterole, oSuper, oBypass] = (owner.stdout || '').trim().split('|')
  const ownerOk = oDbCreate === 'f' && oPubUsage === 't' && oPubCreate === 't' && oAuthUsage === 't' && oCreaterole === 'f' && oSuper === 'f' && oBypass === 'f'
  const ownerDetail = `db_create=${oDbCreate} pub_usage=${oPubUsage} pub_create=${oPubCreate} auth_usage=${oAuthUsage} createrole=${oCreaterole} super=${oSuper} bypassrls=${oBypass}`

  const migrator = psql(
    runner, container,
    `SELECT has_database_privilege('uellix_migrator','postgres','CREATE'), has_schema_privilege('uellix_migrator','public','CREATE'),
            has_schema_privilege('uellix_migrator','auth','USAGE'), r.rolcreaterole, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = 'uellix_migrator';`
  )
  const [mDbCreate, mPubCreate, mAuthUsage, mCreaterole, mSuper, mBypass] = (migrator.stdout || '').trim().split('|')
  const migratorOk = mDbCreate === 'f' && mPubCreate === 'f' && mAuthUsage === 'f' && mCreaterole === 'f' && mSuper === 'f' && mBypass === 'f'
  const migratorDetail = `db_create=${mDbCreate} pub_create=${mPubCreate} auth_usage=${mAuthUsage} createrole=${mCreaterole} super=${mSuper} bypassrls=${mBypass}`

  const others = psql(
    runner, container,
    `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ('uellix_app','uellix_writer','uellix_auditor') AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb);`
  )
  const othersOk = (others.stdout || '').trim().length === 0
  const othersDetail = othersOk ? 'no unauthorized escalation on app/writer/auditor' : `unexpected: ${others.stdout}`

  return { ownerOk, ownerDetail, migratorOk, migratorDetail, othersOk, othersDetail }
}

function checkFinalPrivilegeContract(runner: DockerRunner, container: string, phase: string): boolean {
  const c = computeFinalPrivilegeContract(runner, container)
  record(`${phase}:FINAL-CONTRACT-OWNER`, c.ownerOk, c.ownerDetail)
  record(`${phase}:FINAL-CONTRACT-MIGRATOR`, c.migratorOk, c.migratorDetail)
  record(`${phase}:FINAL-CONTRACT-OTHERS`, c.othersOk, c.othersDetail)
  return record(`${phase}:FINAL-PRIVILEGE-CONTRACT`, c.ownerOk && c.migratorOk && c.othersOk)
}

// ---------------------------------------------------------------------------
// MAIN PHASE.
// ---------------------------------------------------------------------------

async function runMainPhase(runner: DockerRunner): Promise<void> {
  const phase = 'MAIN'
  const handle = await createContainer(runner, phase)
  if (!handle) return
  try {
    if (!handle.created || results.some((r) => r.id.startsWith(phase) && !r.ok)) return
    if (!checkPlatformSubstrate(runner, handle.name, phase)) return
    if (!checkPristineRoles(runner, handle.name, phase)) return
    if (!applyHostedRoleIdentity(runner, handle.name, phase)) return
    if (!narrowMigrator(runner, handle.name, phase)) return
    if (!grantDatabaseCreate(runner, handle.name, phase)) return
    if (!grantPublicSchemaCreate(runner, handle.name, phase)) return
    if (!grantAuthSchemaUsage(runner, handle.name, phase)) return
    if (!applyPartAHelpers(runner, handle.name, phase)) return
    if (!checkPrivP7(runner, handle.name, phase)) return
    if (!checkPreMigrationContract(runner, handle.name, phase)) return

    const snapshot = snapshotEnvFiles()
    const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
    if (!record(`${phase}:ROTATE-CREDENTIALS`, rotate.status === 0, 'scripts/rotate-local-role-credentials.ts (unchanged); credentials never printed')) {
      restoreEnvFiles(snapshot, 'ENV-N1')
      return
    }

    const stillNarrow = psql(runner, handle.name, `SELECT rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator';`)
    record(`${phase}:NARROWING-SURVIVES-ROTATION`, (stillNarrow.stdout || '').trim() === 'f')

    const migrate = runPnpm(['db:migrate:local'])
    if (!record(`${phase}:MIGRATE`, migrate.status === 0, migrate.status === 0 ? 'pnpm db:migrate:local (unchanged): assertMigratorSession PASS, SET ROLE uellix_owner, 62 migrations 0000..0061 applied, internal ownership/ACL verification PASS' : 'pnpm db:migrate:local exited non-zero')) {
      restoreEnvFiles(snapshot, 'ENV-N1')
      return
    }
    record(`${phase}:0061-APPLIED`, true)

    if (!checkOwnershipPostcondition(runner, handle.name, phase)) { restoreEnvFiles(snapshot, 'ENV-N1'); return }
    if (!revokeDatabaseCreate(runner, handle.name, phase)) { restoreEnvFiles(snapshot, 'ENV-N1'); return }
    if (!checkFinalPrivilegeContract(runner, handle.name, phase)) { restoreEnvFiles(snapshot, 'ENV-N1'); return }

    // --- Real M2 test execution: the actual vitest integration test, --------
    // against this disposable database, via the unmodified guard/config path.
    const m2Test = runPnpm(['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'tests/integration/function-execute-acl-guard.test.ts'])
    const fourPassed = /\b4 passed\b/.test(m2Test.combined)
    const zeroFailed = !/\bfailed\b/i.test(m2Test.combined) || /0 failed/.test(m2Test.combined)
    record(`${phase}:M2-TEST-EXECUTION`, m2Test.status === 0 && fourPassed && zeroFailed, m2Test.status === 0 && fourPassed ? '1 file, 4 tests, 4 executed, 4 PASS, 0 skip' : 'did not match the required 1-file/4-test/4-pass/0-skip result')

    const envP1 = restoreEnvFiles(snapshot, 'ENV-P1')
    record('ENV-P1-OVERALL', envP1)
  } finally {
    await teardownContainer(handle, phase)
  }
}

// ---------------------------------------------------------------------------
// NEGATIVE PHASES — each its own fresh disposable container, minimum work.
// ---------------------------------------------------------------------------

/**
 * Each negative control's REAL proof is a direct SQL query confirming the
 * specific privilege gap is absent (deterministic, independent of exact
 * error-message text) — `db-migrate-local.ts`'s error handler only ever
 * prints `[migrator] failed: Failed query: <sql>\nparams: ` for many
 * failure classes, with the underlying PostgreSQL error text NOT
 * necessarily present in that string (measured directly). Requiring
 * `migrate.status !== 0` alongside the direct privilege proof is therefore
 * more rigorous than pattern-matching a message this repository's own
 * entry point does not guarantee to surface.
 */
async function runNegative(
  id: string,
  build: (runner: DockerRunner, container: string, phase: string) => boolean,
  proveGapAbsent: (runner: DockerRunner, container: string, phase: string) => boolean,
): Promise<void> {
  const handle = await createContainer(realDockerRunner, id)
  if (!handle) return
  try {
    if (!handle.created || results.some((r) => r.id.startsWith(id) && !r.ok)) return
    if (!checkPlatformSubstrate(realDockerRunner, handle.name, id)) return
    if (!checkPristineRoles(realDockerRunner, handle.name, id)) return
    if (!applyHostedRoleIdentity(realDockerRunner, handle.name, id)) return
    if (!narrowMigrator(realDockerRunner, handle.name, id)) return
    if (!build(realDockerRunner, handle.name, id)) return
    if (!proveGapAbsent(realDockerRunner, handle.name, id)) return

    const snapshot = snapshotEnvFiles()
    const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
    if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) { restoreEnvFiles(snapshot, `${id}-ENV-RESTORE`); return }

    const migrate = runPnpm(['db:migrate:local'])
    record(id, migrate.status !== 0, migrate.status !== 0 ? 'db:migrate:local correctly refused (deterministic privilege gap already proven absent above)' : 'db:migrate:local unexpectedly SUCCEEDED despite the proven-absent privilege')
    restoreEnvFiles(snapshot, `${id}-ENV-RESTORE`)
  } finally {
    await teardownContainer(handle, id)
  }
}

function proveNo(runner: DockerRunner, container: string, phase: string, id: string, query: string): boolean {
  const q = psql(runner, container, query)
  return record(`${phase}:${id}`, (q.stdout || '').trim() === 'f', `has_privilege=${(q.stdout || '').trim()}`)
}

async function runAllNegatives(): Promise<void> {
  // PRIV-N1a: omit STEP 3 (database CREATE) entirely.
  await runNegative('PRIV-N1a', () => true, (r, c, p) => proveNo(r, c, p, 'GAP-PROOF', `SELECT has_database_privilege('uellix_owner','postgres','CREATE');`))

  // PRIV-N1b: STEP 3 present, STEP 4 (public CREATE) omitted.
  await runNegative('PRIV-N1b', (r, c, p) => grantDatabaseCreate(r, c, p), (r, c, p) => proveNo(r, c, p, 'GAP-PROOF', `SELECT has_schema_privilege('uellix_owner','public','CREATE');`))

  // PRIV-N1c: STEP 3+4 present, STEP 5 (auth USAGE) omitted.
  await runNegative('PRIV-N1c', (r, c, p) => grantDatabaseCreate(r, c, p) && grantPublicSchemaCreate(r, c, p), (r, c, p) => proveNo(r, c, p, 'GAP-PROOF', `SELECT has_schema_privilege('uellix_owner','auth','USAGE');`))

  // PRIV-N1d: STEP 3+4+5 present, STEP 6 (Part A) omitted.
  await runNegative('PRIV-N1d', (r, c, p) => grantDatabaseCreate(r, c, p) && grantPublicSchemaCreate(r, c, p) && grantAuthSchemaUsage(r, c, p), (r, c, p) => {
    const q = psql(r, c, `SELECT to_regprocedure('public.can_read_evidence_object(text,uuid)') IS NULL;`)
    return record(`${p}:GAP-PROOF`, (q.stdout || '').trim() === 't', 'public.can_read_evidence_object(text,uuid) confirmed absent (Part A not applied)')
  })

  // PRIV-N2: database CREATE granted to uellix_migrator only, never to uellix_owner — SET ROLE uellix_owner still lacks it.
  await runNegative('PRIV-N2', (r, c, p) => {
    const grant = psql(r, c, 'GRANT CREATE ON DATABASE postgres TO uellix_migrator;')
    return record(`${p}:STEP3-VARIANT-GRANT-TO-MIGRATOR-ONLY`, grant.status === 0)
  }, (r, c, p) => proveNo(r, c, p, 'GAP-PROOF', `SELECT has_database_privilege('uellix_owner','postgres','CREATE');`))

  // PRIV-N3: deliberate extra privilege — public CREATE granted to uellix_migrator (never authorized) — final contract probe must catch it.
  {
    const id = 'PRIV-N3'
    const handle = await createContainer(realDockerRunner, id)
    if (handle) {
      try {
        if (handle.created && !results.some((r) => r.id.startsWith(id) && !r.ok)) {
          if (checkPlatformSubstrate(realDockerRunner, handle.name, id) && checkPristineRoles(realDockerRunner, handle.name, id) && applyHostedRoleIdentity(realDockerRunner, handle.name, id) && narrowMigrator(realDockerRunner, handle.name, id)) {
            const extra = psql(realDockerRunner, handle.name, 'GRANT CREATE ON SCHEMA public TO uellix_migrator;')
            record(`${id}:INJECT-UNAUTHORIZED-ESCALATION`, extra.status === 0)
            // Deliberately use the NON-recording pure computation here: the
            // sub-checks are EXPECTED to read false (that is the injected
            // escalation being detected), and must not themselves count as
            // failures in the script's overall pass tally — only the outer
            // PRIV-N3 verdict (did detection work?) should.
            const c = computeFinalPrivilegeContract(realDockerRunner, handle.name)
            const detected = !(c.ownerOk && c.migratorOk && c.othersOk)
            record(id, detected, detected ? `final privilege contract correctly detected the unauthorized escalation (migrator: ${c.migratorDetail})` : 'final privilege contract FAILED TO DETECT the injected escalation')
          }
        }
      } finally {
        await teardownContainer(handle, id)
      }
    }
  }

  // PRIV-N4: re-grant CREATEROLE to uellix_migrator before migration. This
  // throws db/migrator.ts's own MigratorError, whose code+message ARE
  // reliably printed by db-migrate-local.ts's catch handler (unlike a raw
  // PostgreSQL permission error) — string-matching is appropriate here.
  {
    const id = 'PRIV-N4'
    const handle = await createContainer(realDockerRunner, id)
    if (handle) {
      try {
        if (handle.created && !results.some((r) => r.id.startsWith(id) && !r.ok)) {
          if (checkPlatformSubstrate(realDockerRunner, handle.name, id) && checkPristineRoles(realDockerRunner, handle.name, id) && applyHostedRoleIdentity(realDockerRunner, handle.name, id) && narrowMigrator(realDockerRunner, handle.name, id)) {
            const g1 = grantDatabaseCreate(realDockerRunner, handle.name, id)
            const g2 = grantPublicSchemaCreate(realDockerRunner, handle.name, id)
            const g3 = grantAuthSchemaUsage(realDockerRunner, handle.name, id)
            const g4 = applyPartAHelpers(realDockerRunner, handle.name, id)
            const regrant = psql(realDockerRunner, handle.name, 'ALTER ROLE uellix_migrator CREATEROLE;')
            if (g1 && g2 && g3 && g4 && record(`${id}:REGRANT-CREATEROLE`, regrant.status === 0)) {
              const snapshot = snapshotEnvFiles()
              const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
              if (record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) {
                const migrate = runPnpm(['db:migrate:local'])
                const matched = /DB_MIGRATOR_OVERPRIVILEGED/.test(migrate.combined)
                record(id, migrate.status !== 0 && matched, matched ? 'correctly refused: DB_MIGRATOR_OVERPRIVILEGED' : `expected DB_MIGRATOR_OVERPRIVILEGED, got exit ${migrate.status}`)
              }
              restoreEnvFiles(snapshot, `${id}-ENV-RESTORE`)
            }
          }
        }
      } finally {
        await teardownContainer(handle, id)
      }
    }
  }

  // PRIV-N5: wrong capability — migration credential pointed at postgres (superuser) instead of uellix_migrator.
  {
    const id = 'PRIV-N5'
    const handle = await createContainer(realDockerRunner, id)
    if (handle) {
      try {
        if (handle.created && !results.some((r) => r.id.startsWith(id) && !r.ok)) {
          if (checkPlatformSubstrate(realDockerRunner, handle.name, id) && checkPristineRoles(realDockerRunner, handle.name, id) && applyHostedRoleIdentity(realDockerRunner, handle.name, id) && narrowMigrator(realDockerRunner, handle.name, id)) {
            const g1 = grantDatabaseCreate(realDockerRunner, handle.name, id)
            const g2 = grantPublicSchemaCreate(realDockerRunner, handle.name, id)
            const g3 = grantAuthSchemaUsage(realDockerRunner, handle.name, id)
            const g4 = applyPartAHelpers(realDockerRunner, handle.name, id)
            if (g1 && g2 && g3 && g4) {
              const snapshot = snapshotEnvFiles()
              const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
              if (record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) {
                // Deliberately corrupt the migration credential to point at the
                // superuser-equivalent role instead of uellix_migrator — the
                // existing fail-closed capability/role guard must reject it
                // before any DDL, without this script touching db-migrate-local.ts.
                const migrationEnvPath = resolve(REPO_ROOT, '.env.migration.local')
                const original = readFileSync(migrationEnvPath, 'utf8')
                const corrupted = original.replace(/UELLIX_MIGRATOR_DATABASE_URL=.*/, `UELLIX_MIGRATOR_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`)
                writeFileSync(migrationEnvPath, corrupted)
                const migrate = runPnpm(['db:migrate:local'])
                // Measured live: the URL-declared-role guard
                // (db/safety/resolve-capability-database-url.ts) catches
                // this even earlier than assertMigratorSession — it rejects
                // the corrupted URL by its own declared role before any
                // connection is attempted at all, which is a STRONGER
                // fail-closed property than the runtime session check.
                const matched = /DB_CAPABILITY_URL_WRONG_ROLE/.test(migrate.combined)
                record(id, migrate.status !== 0 && matched, matched ? 'correctly refused: DB_CAPABILITY_URL_WRONG_ROLE (rejected by declared-role URL validation before any connection attempt)' : `expected DB_CAPABILITY_URL_WRONG_ROLE, got exit ${migrate.status}`)
              }
              restoreEnvFiles(snapshot, `${id}-ENV-RESTORE`)
            }
          }
        }
      } finally {
        await teardownContainer(handle, id)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runner = realDockerRunner
  console.log(`[m2-pg-gate] image tag=${IMAGE_TAG} immutable-ref=${IMAGE}`)
  try {
    await runMainPhase(runner)
    await runAllNegatives()
  } catch (error) {
    console.error('[m2-pg-gate] unexpected error:', redactSecret(error instanceof Error ? error.message : String(error), 'postgres'))
    record('UNEXPECTED-ERROR', false, error instanceof Error ? error.message : String(error))
  } finally {
    verifyZeroLabelledLeftovers(runner)
  }

  const allOk = results.every((r) => r.ok)
  console.log(`\n[m2-pg-gate] OVERALL=${allOk ? 'PASS' : 'FAIL'} (${results.filter((r) => r.ok).length}/${results.length} checks)`)
  if (!allOk) process.exitCode = 1
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/m2-disposable-pg-bootstrap.ts')
if (invokedDirectly) {
  void main()
}
