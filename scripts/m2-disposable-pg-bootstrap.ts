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

const MIGRATIONS_DIR = resolve(REPO_ROOT, 'db/migrations')
const MIGRATIONS_JOURNAL_PATH = resolve(MIGRATIONS_DIR, 'meta/_journal.json')

interface StepResult { id: string; ok: boolean; detail?: string }

const results: StepResult[] = []
function record(id: string, ok: boolean, detail?: string): boolean {
  results.push({ id, ok, detail })
  console.log(`[m2-pg-gate] ${id}=${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`)
  return ok
}

// ---------------------------------------------------------------------------
// AUTHORITY v1.0.4 / M2-F2-class hardening: ANSI-tolerant Vitest summary
// parsing. Measured live in PR #50 run 33709987615: GitHub Actions' runner
// makes vitest emit its summary with ANSI color escapes interleaved around
// the very tokens a naive `/\b4 passed\b/` regex expects adjacent
// ("\x1b[1m\x1b[32m4 passed\x1b[39m\x1b[22m"), which this repository's local
// (non-TTY, piped-to-file) runs never produce — causing a FALSE NEGATIVE
// (raw Vitest: 1 file/4 tests/4 passed/0 skip; gate's own check: FAIL).
// This normalizes decoration BEFORE interpreting the summary, rather than
// relying on NO_COLOR alone (CI environments are not guaranteed to honor it,
// and a parser that only works undecorated is still brittle).
// ---------------------------------------------------------------------------

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface VitestSummaryLine { failed: number; passed: number; skipped: number; total: number }

/** Order/decoration-agnostic: extracts each named count independently, defaulting an absent segment to 0, and reads the trailing "(<total>)". */
function parseSummaryLine(line: string): VitestSummaryLine | null {
  const totalMatch = line.match(/\((\d+)\)\s*$/)
  if (!totalMatch) return null
  const failed = Number(line.match(/(\d+)\s*failed/)?.[1] ?? 0)
  const passed = Number(line.match(/(\d+)\s*passed/)?.[1] ?? 0)
  const skipped = Number(line.match(/(\d+)\s*skipped/)?.[1] ?? 0)
  return { failed, passed, skipped, total: Number(totalMatch[1]) }
}

interface VitestSummary { testFiles: VitestSummaryLine; tests: VitestSummaryLine }

function parseVitestSummary(rawCombined: string): VitestSummary | null {
  const clean = stripAnsi(rawCombined)
  const lines = clean.split('\n')
  const testFilesLine = lines.find((l) => /^\s*Test Files\s/.test(l))
  const testsLine = lines.find((l) => /^\s*Tests\s/.test(l))
  if (!testFilesLine || !testsLine) return null
  const testFiles = parseSummaryLine(testFilesLine)
  const tests = parseSummaryLine(testsLine)
  if (!testFiles || !tests) return null
  return { testFiles, tests }
}

/** The exact M2 contract: 1 file, that file passed, 4 tests, all 4 passed, 0 failed, 0 skipped — for both files and tests. */
function isExactM2Result(summary: VitestSummary | null): boolean {
  if (!summary) return false
  const f = summary.testFiles
  const t = summary.tests
  return f.total === 1 && f.passed === 1 && f.failed === 0 && f.skipped === 0 && t.total === 4 && t.passed === 4 && t.failed === 0 && t.skipped === 0
}

/** Cheap, no-Docker self-controls (ANSI-P1/P2/N1/N2/N3) — must be green before any disposable container starts. */
function runAnsiParserSelfTest(): boolean {
  const plain = ' Test Files  1 passed (1)\n      Tests  4 passed (4)\n'
  const ansiDecorated =
    '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m\n' +
    '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m4 passed\x1b[39m\x1b[22m\x1b[90m (4)\x1b[39m\n'
  const threeOneFailed = ' Test Files  1 passed (1)\n      Tests  1 failed | 3 passed (4)\n'
  const threeOneSkipped = ' Test Files  1 passed (1)\n      Tests  3 passed | 1 skipped (4)\n'
  const zeroCollected = ' Test Files  0 passed (0)\n      Tests  no tests\n'

  const p1 = record('SELFTEST:ANSI-P1', isExactM2Result(parseVitestSummary(plain)), 'plain 1/4/4/0 output accepted')
  const p2 = record('SELFTEST:ANSI-P2', isExactM2Result(parseVitestSummary(ansiDecorated)), 'GitHub-ANSI-decorated 1/4/4/0 output accepted (the exact PR #50 run 33709987615 false-negative pattern)')
  const n1 = record('SELFTEST:ANSI-N1', !isExactM2Result(parseVitestSummary(threeOneFailed)), '3 passed / 1 failed correctly rejected')
  const n2 = record('SELFTEST:ANSI-N2', !isExactM2Result(parseVitestSummary(threeOneSkipped)), '3 passed / 1 skipped correctly rejected')
  const n3 = record('SELFTEST:ANSI-N3', !isExactM2Result(parseVitestSummary(zeroCollected)), 'zero/incorrect collection correctly rejected')
  return p1 && p2 && n1 && n2 && n3
}

// ---------------------------------------------------------------------------
// AUTHORITY v1.0.4 / M2-F2-class hardening: mechanical migration-corpus
// proof. Previously MAIN:0061-APPLIED was `record(..., true)` unconditionally
// once `pnpm db:migrate:local` exited 0 — a real proof of "the process
// succeeded", but only a PROSE claim that all 62 migrations 0000..0061 were
// actually applied. This derives the expected corpus mechanically from the
// same db/migrations/meta/_journal.json and per-migration .sql files Drizzle
// 0.45.2's own migrator reads (db/migrations/meta/_journal.json entries +
// sha256(file content) per entry, exactly matching
// drizzle-orm/migrator.js's readMigrationFiles — verified by reading that
// file directly), then compares against drizzle.__drizzle_migrations's own
// `hash` column (drizzle-orm/pg-core/dialect.js's PgDialect.migrate: one row
// per applied migration, hash = that same sha256, in application order).
// ---------------------------------------------------------------------------

interface ExpectedMigrationEntry { tag: string; when: number; hash: string }
interface ExpectedMigrationCorpus { count: number; entries: ExpectedMigrationEntry[]; terminal: ExpectedMigrationEntry }

function deriveExpectedMigrationCorpus(): ExpectedMigrationCorpus {
  const journal = JSON.parse(readFileSync(MIGRATIONS_JOURNAL_PATH, 'utf8')) as { entries: { tag: string; when: number }[] }
  const entries = journal.entries.map((e) => ({
    tag: e.tag,
    when: e.when,
    hash: sha256(readFileSync(resolve(MIGRATIONS_DIR, `${e.tag}.sql`), 'utf8')),
  }))
  if (entries.length === 0) throw new Error('deriveExpectedMigrationCorpus: db/migrations/meta/_journal.json has zero entries')
  return { count: entries.length, entries, terminal: entries[entries.length - 1] }
}

interface MigrationProofResult { countOk: boolean; corpusOk: boolean; terminalOk: boolean }

/** Pure comparison, no recording — reused by both the live post-migration check and the cheap MIG-N1 self-test. */
function evaluateMigrationProof(actualHashesInOrder: string[], expected: ExpectedMigrationCorpus): MigrationProofResult {
  const expectedHashesInOrder = expected.entries.map((e) => e.hash)
  const countOk = actualHashesInOrder.length === expected.count
  const corpusOk = countOk && expectedHashesInOrder.every((h, i) => h === actualHashesInOrder[i])
  const terminalOk = actualHashesInOrder.includes(expected.terminal.hash)
  return { countOk, corpusOk, terminalOk }
}

function checkMigrationProof(runner: DockerRunner, container: string, phase: string): boolean {
  const expected = deriveExpectedMigrationCorpus()
  const q = psql(runner, container, `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at;`)
  const actualHashesInOrder = (q.stdout || '').trim().split('\n').filter(Boolean)
  const r = evaluateMigrationProof(actualHashesInOrder, expected)
  record(`${phase}:MIGRATION-JOURNAL-COUNT`, r.countOk, `expected=${expected.count} (mechanically derived from db/migrations/meta/_journal.json) actual=${actualHashesInOrder.length}`)
  record(`${phase}:MIGRATION-CORPUS-PROOF`, r.corpusOk, r.corpusOk ? `all ${expected.count} migration hashes match the repository corpus, in application order` : 'hash sequence mismatch between the repository corpus and drizzle.__drizzle_migrations')
  record(`${phase}:0061-APPLIED`, r.terminalOk, r.terminalOk ? `terminal migration ${expected.terminal.tag} hash mechanically confirmed present in drizzle.__drizzle_migrations` : `terminal migration hash NOT found (expected sha256=${expected.terminal.hash})`)
  return r.countOk && r.corpusOk && r.terminalOk
}

/** Cheap, no-Docker self-controls (MIG-P1/P2/P3 positive, MIG-N1 negative) — must be green before any disposable container starts. */
function runMigrationProofSelfTest(): boolean {
  const expected = deriveExpectedMigrationCorpus()
  const p1 = record('SELFTEST:MIG-P1', expected.count > 0, `canonical migration count mechanically derived from db/migrations/meta/_journal.json = ${expected.count}`)

  const validHashesInOrder = expected.entries.map((e) => e.hash)
  const good = evaluateMigrationProof(validHashesInOrder, expected)
  const p2p3 = record('SELFTEST:MIG-P2-P3-POSITIVE', good.countOk && good.corpusOk && good.terminalOk, `valid full corpus (${expected.count} entries, terminal=${expected.terminal.tag}) correctly accepted`)

  const truncated = validHashesInOrder.slice(0, -1)
  const bad = evaluateMigrationProof(truncated, expected)
  const n1 = record('SELFTEST:MIG-N1', !bad.countOk && !bad.corpusOk && !bad.terminalOk, 'deliberately missing terminal migration correctly rejected by all three sub-checks')

  return p1 && p2p3 && n1
}

// ---------------------------------------------------------------------------
// AUTHORITY v1.0.4 / M2-F3-class hardening: exception-safe env restoration.
// Previously every phase called restoreEnvFiles(...) at each explicit
// `return` point after a rotation — correct for every code path THIS SCRIPT
// enumerates, but not exception-safe: a thrown error between rotation and
// the next explicit check would skip restoration entirely. withEnvRestore
// wraps the credential-writing window in a real try/finally so restoration
// is guaranteed on normal return, an ordinary (non-throwing) failure, AND a
// thrown exception — independent of, and never blocking, the container's
// own finally-guaranteed teardown.
// ---------------------------------------------------------------------------

async function withEnvRestore<T>(labelPrefix: string, fn: () => Promise<T> | T): Promise<T> {
  const snapshot = snapshotEnvFiles()
  let threw = false
  try {
    return await fn()
  } catch (err) {
    threw = true
    throw err
  } finally {
    const restored = restoreEnvFiles(snapshot, `${labelPrefix}-ENV-RESTORE`)
    record(`${labelPrefix}:ENV-RESTORE-EXCEPTION-SAFE`, restored, threw ? 'restored via finally after a thrown exception' : 'restored via finally after normal return')
  }
}

/** Cheap, no-Docker self-control (ENV-N2) proving withEnvRestore's finally actually fires and restores exact bytes/absence even when the wrapped work throws mid-window. Uses the real ENV_FILES snapshot/restore pipeline (the same one every phase relies on), not a synthetic stand-in. */
async function runEnvRestoreThrowSelfTest(): Promise<boolean> {
  const probePath = ENV_FILES[0]
  const before = existsSync(probePath) ? readFileSync(probePath) : null

  let caughtExpected = false
  try {
    await withEnvRestore('SELFTEST-ENV-N2', () => {
      writeFileSync(probePath, Buffer.from('SELFTEST_INJECTED_MUTATION_NEVER_PERSISTED=1\n'))
      throw new Error('SELFTEST-ENV-N2-DELIBERATE-THROW')
    })
  } catch (err) {
    caughtExpected = err instanceof Error && err.message === 'SELFTEST-ENV-N2-DELIBERATE-THROW'
  }

  const after = existsSync(probePath) ? readFileSync(probePath) : null
  const restoredCorrectly = before === null ? after === null : after !== null && fingerprint(after) === fingerprint(before)
  return record('SELFTEST:ENV-N2-INJECTED-THROW-RESTORE', caughtExpected && restoredCorrectly, restoredCorrectly ? 'exact byte/absence state restored despite a thrown exception mid-window' : 'restoration FAILED after injected throw')
}

// ---------------------------------------------------------------------------
// AUTHORITY v1.0.4: best-effort SIGINT/SIGTERM container cleanup. This is
// EXCEPTION_SAFE=YES for JS-level throws (via withEnvRestore/try-finally
// above) but explicitly NOT a HARD_PROCESS_TERMINATION_GUARANTEE — a SIGKILL
// or host failure cannot run any userland handler, Node or otherwise, and
// this script never claims otherwise.
// ---------------------------------------------------------------------------

const activeContainers = new Set<{ runner: DockerRunner; name: string; created: boolean }>()

let signalCleanupInProgress = false
function installSignalCleanup(): void {
  const handler = (signal: string) => {
    if (signalCleanupInProgress) return
    signalCleanupInProgress = true
    console.error(`[m2-pg-gate] received ${signal} — best-effort container cleanup (EXCEPTION_SAFE=YES for in-process throws; this signal path is HARD_PROCESS_TERMINATION_GUARANTEE=NO)`)
    const pending = [...activeContainers]
    void (async () => {
      for (const handle of pending) {
        try {
          handle.runner.run(['rm', '-f', '-v', handle.name])
        } catch {
          // best-effort only — see comment above.
        }
      }
      process.exit(130)
    })()
  }
  process.on('SIGINT', () => handler('SIGINT'))
  process.on('SIGTERM', () => handler('SIGTERM'))
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
  activeContainers.add(handle)
  if (!record(`${phase}:CONTAINER-CREATE`, created.status === 0, created.status === 0 ? name : created.stderr || created.stdout)) return handle

  const mounts = runner.run(['inspect', '-f', '{{json .Mounts}}', name])
  if (!record(`${phase}:MOUNT-CHECK`, mounts.status === 0 && hasOnlyAcceptableMounts(mounts.stdout), 'anonymous volume mount only, no bind mount')) return handle

  let ready = false
  for (let i = 0; i < 60; i++) {
    if (runner.run(['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!record(`${phase}:CONTAINER-READY`, ready)) return handle
  // AUTHORITY v1.0.5: the fixed 750ms settle margin that used to sit here is
  // no longer load-bearing. It was a fixed-delay guess at how long
  // pg_isready-true takes to become "every catalog query succeeds" —
  // measured live (PR #50 run 33712706673) to be insufficient under
  // GitHub Actions runner load on 5 of 9 disposable containers in one run,
  // while the very same unmodified logic passed 9/9 on an earlier run.
  // Readiness is now established by the bounded SEMANTIC probe in
  // checkPlatformSubstrate() itself (waitForPlatformReadiness), which polls
  // the fixture's actual preconditions instead of guessing a delay.

  const portResult = runner.run(['port', name, '5432/tcp'])
  const assignedPort = portResult.status === 0 ? parseAssignedPort(portResult.stdout) : null
  if (!record(`${phase}:PORT-BOUND-CHECK`, assignedPort === LOCAL_DB_PORT, `bound to 127.0.0.1:${LOCAL_DB_PORT} exactly`)) return handle

  return handle
}

async function teardownContainer(handle: ContainerHandle, phase: string): Promise<void> {
  activeContainers.delete(handle)
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

// ---------------------------------------------------------------------------
// AUTHORITY v1.0.5: bounded semantic platform-readiness probe. Replaces the
// fixed-delay assumption with a real predicate over the fixture's actual
// preconditions, polled with a bound — measured live (PR #50 run
// 33712706673) to be necessary: the previous fixed 750ms settle sleep after
// pg_isready passed 9/9 on one GitHub run and failed 5/9 on another,
// against byte-identical container-lifecycle code.
// ---------------------------------------------------------------------------

interface PlatformReadinessProbeResult {
  ready: boolean
  psqlOk: boolean
  missingSchemas: string[]
  authUidPresent: boolean
}

/** Non-mutating: only observes the pinned image's native platform substrate. Never creates schemas/functions to force a pass. */
function probePlatformReadiness(runner: DockerRunner, container: string): PlatformReadinessProbeResult {
  const substrate = psql(runner, container, `SELECT string_agg(s.name, ',' ORDER BY s.name) FROM (VALUES ('auth'),('storage'),('extensions')) AS s(name) WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s.name);`)
  if (substrate.status !== 0) return { ready: false, psqlOk: false, missingSchemas: [], authUidPresent: false }

  const missingSchemas = (substrate.stdout || '').trim().split(',').filter(Boolean)
  if (missingSchemas.length > 0) return { ready: false, psqlOk: true, missingSchemas, authUidPresent: false }

  const authUid = psql(runner, container, `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth' AND p.proname = 'uid';`)
  const authUidPresent = authUid.status === 0 && (authUid.stdout || '').trim() === '1'
  return { ready: authUidPresent, psqlOk: true, missingSchemas: [], authUidPresent }
}

/** Truthful diagnostic — never claims "present natively" when the probe itself failed to run. */
function diagnosePlatformReadinessFailure(r: PlatformReadinessProbeResult): string {
  const parts: string[] = []
  if (!r.psqlOk) parts.push('PSQL_NONZERO')
  for (const schema of r.missingSchemas) parts.push(`MISSING_SCHEMA_${schema}`)
  if (r.psqlOk && r.missingSchemas.length === 0 && !r.authUidPresent) parts.push('AUTH_UID_MISSING')
  return parts.length > 0 ? parts.join(',') : 'UNKNOWN'
}

interface ReadinessClock { now: () => number; sleep: (ms: number) => Promise<void> }
const REAL_READINESS_CLOCK: ReadinessClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

const PLATFORM_READINESS_TIMEOUT_MS = 20000
const PLATFORM_READINESS_POLL_MS = 300
const PLATFORM_READINESS_REQUIRED_CONSECUTIVE_SUCCESSES = 2

interface WaitForReadinessResult { ready: boolean; lastResult: PlatformReadinessProbeResult; consecutiveReached: number }

/**
 * Bounded poll: requires REQUIRED_CONSECUTIVE_SUCCESSES consecutive ready
 * probes before declaring readiness (a single lucky sample sandwiched
 * between transient failures does not count), and never loops past
 * timeoutMs. `probe` and `clock` are injectable so the self-controls below
 * exercise this exact logic deterministically, with no real Docker and no
 * real multi-second waits.
 */
async function waitForPlatformReadiness(
  probe: () => PlatformReadinessProbeResult,
  clock: ReadinessClock = REAL_READINESS_CLOCK,
  timeoutMs = PLATFORM_READINESS_TIMEOUT_MS,
  pollMs = PLATFORM_READINESS_POLL_MS,
  requiredConsecutive = PLATFORM_READINESS_REQUIRED_CONSECUTIVE_SUCCESSES,
): Promise<WaitForReadinessResult> {
  const deadline = clock.now() + timeoutMs
  let consecutive = 0
  let lastResult: PlatformReadinessProbeResult = { ready: false, psqlOk: false, missingSchemas: [], authUidPresent: false }
  while (clock.now() < deadline) {
    lastResult = probe()
    consecutive = lastResult.ready ? consecutive + 1 : 0
    if (consecutive >= requiredConsecutive) return { ready: true, lastResult, consecutiveReached: consecutive }
    await clock.sleep(pollMs)
  }
  return { ready: false, lastResult, consecutiveReached: consecutive }
}

async function checkPlatformSubstrate(runner: DockerRunner, container: string, phase: string): Promise<boolean> {
  const { ready, lastResult } = await waitForPlatformReadiness(() => probePlatformReadiness(runner, container))
  return record(`${phase}:PLATFORM-READINESS`, ready, ready ? `auth/storage/extensions present, auth.uid() present, ${PLATFORM_READINESS_REQUIRED_CONSECUTIVE_SUCCESSES} consecutive successful probes` : diagnosePlatformReadinessFailure(lastResult))
}

/** Cheap, no-Docker self-controls (READY-P1..P4, READY-N1..N4) for waitForPlatformReadiness — a fake clock + scripted/cycling probe sequence, no real Docker and no real multi-second waits. */
async function runPlatformReadinessSelfTest(): Promise<boolean> {
  const OK: PlatformReadinessProbeResult = { ready: true, psqlOk: true, missingSchemas: [], authUidPresent: true }
  const PSQL_DOWN: PlatformReadinessProbeResult = { ready: false, psqlOk: false, missingSchemas: [], authUidPresent: false }
  const MISSING_AUTH: PlatformReadinessProbeResult = { ready: false, psqlOk: true, missingSchemas: ['auth'], authUidPresent: false }
  const MISSING_STORAGE: PlatformReadinessProbeResult = { ready: false, psqlOk: true, missingSchemas: ['storage'], authUidPresent: false }
  const MISSING_EXT: PlatformReadinessProbeResult = { ready: false, psqlOk: true, missingSchemas: ['extensions'], authUidPresent: false }
  const NO_AUTH_UID: PlatformReadinessProbeResult = { ready: false, psqlOk: true, missingSchemas: [], authUidPresent: false }

  function fakeClock(): ReadinessClock {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }

  /** Cycles through `sequence` forever — lets a bounded-timeout test prove the loop terminates even against a probe that never settles. */
  function cyclingProbe(sequence: PlatformReadinessProbeResult[]): () => PlatformReadinessProbeResult {
    let i = 0
    return () => sequence[(i++) % sequence.length]
  }

  const p1 = record('SELFTEST:READY-P1', (await waitForPlatformReadiness(cyclingProbe([OK]), fakeClock(), 20000, 300, 2)).ready, 'immediate semantic readiness (2 consecutive OK samples right away) accepted')

  const p2 = record('SELFTEST:READY-P2', (await waitForPlatformReadiness(cyclingProbe([PSQL_DOWN, PSQL_DOWN, OK, OK, OK]), fakeClock(), 20000, 300, 2)).ready, 'transient psql failures followed by full readiness within the bound accepted')

  const p3 = record('SELFTEST:READY-P3', (await waitForPlatformReadiness(cyclingProbe([MISSING_AUTH, MISSING_STORAGE, MISSING_EXT, NO_AUTH_UID, OK, OK, OK]), fakeClock(), 20000, 300, 2)).ready, 'progressively available schemas/auth.uid(), then 2 consecutive successes, accepted')

  // READY-P4: OK immediately followed by a transient failure, forever cycling — must NEVER satisfy the 2-consecutive contract (a lone success never short-circuits it), and must correctly time out FAIL.
  const p4Result = await waitForPlatformReadiness(cyclingProbe([OK, PSQL_DOWN]), fakeClock(), 20000, 300, 2)
  const p4 = record('SELFTEST:READY-P4', !p4Result.ready, 'a lone success immediately followed by a transient failure, repeated, never satisfies 2-consecutive-success — correctly does not declare readiness early')

  const n1 = record('SELFTEST:READY-N1', !(await waitForPlatformReadiness(cyclingProbe([PSQL_DOWN]), fakeClock(), 20000, 300, 2)).ready, 'persistent psql nonzero until the deadline correctly FAILs')

  const n2Result = await waitForPlatformReadiness(cyclingProbe([MISSING_AUTH]), fakeClock(), 20000, 300, 2)
  const n2 = record('SELFTEST:READY-N2', !n2Result.ready && diagnosePlatformReadinessFailure(n2Result.lastResult) === 'MISSING_SCHEMA_auth', 'persistent missing schema until the deadline correctly FAILs with a truthful diagnostic (never "present natively")')

  const n3Result = await waitForPlatformReadiness(cyclingProbe([NO_AUTH_UID]), fakeClock(), 20000, 300, 2)
  const n3 = record('SELFTEST:READY-N3', !n3Result.ready && diagnosePlatformReadinessFailure(n3Result.lastResult) === 'AUTH_UID_MISSING', 'persistent auth.uid() missing until the deadline correctly FAILs with a truthful diagnostic')

  // READY-N4: a probe that never resolves must still terminate at the bound, in a finite, expected number of samples.
  let sampleCount = 0
  const boundedProbe = () => { sampleCount++; return PSQL_DOWN }
  const n4Result = await waitForPlatformReadiness(boundedProbe, fakeClock(), 20000, 300, 2)
  const expectedMaxSamples = Math.ceil(20000 / 300) + 1
  const n4 = record('SELFTEST:READY-N4', !n4Result.ready && sampleCount > 0 && sampleCount <= expectedMaxSamples, `bounded poll terminated after ${sampleCount} samples (bound: ${expectedMaxSamples}) — never loops forever`)

  // READY-N5: structural — in PRODUCTION code (excluding this self-test's own
  // deliberately-repeated test invocations below), waitForPlatformReadiness
  // must be CALLED exactly once — from checkPlatformSubstrate — proving
  // retry scope never leaked into any other phase (a migration check, a
  // negative-control mutation, etc. re-treating its own failure as
  // "startup readiness" and retrying it).
  const selfPath = resolve(import.meta.dirname, 'm2-disposable-pg-bootstrap.ts')
  const source = readFileSync(selfPath, 'utf8')
  const selfTestMarker = '/** Cheap, no-Docker self-controls (READY-P1..P4, READY-N1..N4) for waitForPlatformReadiness'
  const markerIndex = source.indexOf(selfTestMarker)
  const productionSource = markerIndex >= 0 ? source.slice(0, markerIndex) : source
  const productionCallSites = (productionSource.match(/await waitForPlatformReadiness\(/g) || []).length
  const n5 = record('SELFTEST:READY-N5', markerIndex >= 0 && productionCallSites === 1, markerIndex >= 0 && productionCallSites === 1 ? 'waitForPlatformReadiness is called exactly once in production code (checkPlatformSubstrate) — retry scope confirmed limited to the readiness probe' : `expected exactly 1 production call site, found ${productionCallSites} (marker found: ${markerIndex >= 0})`)

  return p1 && p2 && p3 && p4 && n1 && n2 && n3 && n4 && n5
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
    if (!(await checkPlatformSubstrate(runner, handle.name, phase))) return
    if (!checkPristineRoles(runner, handle.name, phase)) return
    if (!applyHostedRoleIdentity(runner, handle.name, phase)) return
    if (!narrowMigrator(runner, handle.name, phase)) return
    if (!grantDatabaseCreate(runner, handle.name, phase)) return
    if (!grantPublicSchemaCreate(runner, handle.name, phase)) return
    if (!grantAuthSchemaUsage(runner, handle.name, phase)) return
    if (!applyPartAHelpers(runner, handle.name, phase)) return
    if (!checkPrivP7(runner, handle.name, phase)) return
    if (!checkPreMigrationContract(runner, handle.name, phase)) return

    // The whole credential-dependent window — rotate, migrate, the mechanical
    // migration proof, ownership/privilege postconditions, and the real M2
    // vitest test (which itself reads .env.local/.env.migration.local for
    // its connection string) — must stay INSIDE one withEnvRestore window.
    // Restoring the env files right after migrate() (an earlier version of
    // this refactor did exactly that) leaves the M2 test running against the
    // pre-rotation credentials and fails with "password authentication
    // failed for user uellix_migrator" — measured directly in this session.
    await withEnvRestore(phase, () => {
      const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
      if (!record(`${phase}:ROTATE-CREDENTIALS`, rotate.status === 0, 'scripts/rotate-local-role-credentials.ts (unchanged); credentials never printed')) return

      const stillNarrow = psql(runner, handle.name, `SELECT rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator';`)
      record(`${phase}:NARROWING-SURVIVES-ROTATION`, (stillNarrow.stdout || '').trim() === 'f')

      const migrate = runPnpm(['db:migrate:local'])
      if (!record(`${phase}:MIGRATE`, migrate.status === 0, migrate.status === 0 ? 'pnpm db:migrate:local (unchanged): assertMigratorSession PASS, SET ROLE uellix_owner, migration run exited 0 — see MIGRATION-JOURNAL-COUNT/CORPUS-PROOF/0061-APPLIED below for the mechanical proof of what was actually applied' : 'pnpm db:migrate:local exited non-zero')) return

      if (!checkMigrationProof(runner, handle.name, phase)) return
      if (!checkOwnershipPostcondition(runner, handle.name, phase)) return
      if (!revokeDatabaseCreate(runner, handle.name, phase)) return
      if (!checkFinalPrivilegeContract(runner, handle.name, phase)) return

      // --- Real M2 test execution: the actual vitest integration test, ------
      // against this disposable database, via the unmodified guard/config
      // path — still using the rotated credentials this window holds.
      const m2Test = runPnpm(['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'tests/integration/function-execute-acl-guard.test.ts'])
      const summary = parseVitestSummary(m2Test.combined)
      const exact = isExactM2Result(summary)
      record(`${phase}:M2-TEST-EXECUTION`, m2Test.status === 0 && exact, m2Test.status === 0 && exact ? '1 file, 4 tests, 4 executed, 4 PASS, 0 skip (ANSI-tolerant parse)' : `did not match the required 1-file/4-test/4-pass/0-skip result${summary ? ` (parsed: files=${JSON.stringify(summary.testFiles)} tests=${JSON.stringify(summary.tests)})` : ' (summary lines not found)'}`)
    })
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
    if (!(await checkPlatformSubstrate(realDockerRunner, handle.name, id))) return
    if (!checkPristineRoles(realDockerRunner, handle.name, id)) return
    if (!applyHostedRoleIdentity(realDockerRunner, handle.name, id)) return
    if (!narrowMigrator(realDockerRunner, handle.name, id)) return
    if (!build(realDockerRunner, handle.name, id)) return
    if (!proveGapAbsent(realDockerRunner, handle.name, id)) return

    await withEnvRestore(id, () => {
      const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
      if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) return

      const migrate = runPnpm(['db:migrate:local'])
      record(id, migrate.status !== 0, migrate.status !== 0 ? 'db:migrate:local correctly refused (deterministic privilege gap already proven absent above)' : 'db:migrate:local unexpectedly SUCCEEDED despite the proven-absent privilege')
    })
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
          if ((await checkPlatformSubstrate(realDockerRunner, handle.name, id)) && checkPristineRoles(realDockerRunner, handle.name, id) && applyHostedRoleIdentity(realDockerRunner, handle.name, id) && narrowMigrator(realDockerRunner, handle.name, id)) {
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
          if ((await checkPlatformSubstrate(realDockerRunner, handle.name, id)) && checkPristineRoles(realDockerRunner, handle.name, id) && applyHostedRoleIdentity(realDockerRunner, handle.name, id) && narrowMigrator(realDockerRunner, handle.name, id)) {
            const g1 = grantDatabaseCreate(realDockerRunner, handle.name, id)
            const g2 = grantPublicSchemaCreate(realDockerRunner, handle.name, id)
            const g3 = grantAuthSchemaUsage(realDockerRunner, handle.name, id)
            const g4 = applyPartAHelpers(realDockerRunner, handle.name, id)
            const regrant = psql(realDockerRunner, handle.name, 'ALTER ROLE uellix_migrator CREATEROLE;')
            if (g1 && g2 && g3 && g4 && record(`${id}:REGRANT-CREATEROLE`, regrant.status === 0)) {
              await withEnvRestore(id, () => {
                const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
                if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) return
                const migrate = runPnpm(['db:migrate:local'])
                const matched = /DB_MIGRATOR_OVERPRIVILEGED/.test(migrate.combined)
                record(id, migrate.status !== 0 && matched, matched ? 'correctly refused: DB_MIGRATOR_OVERPRIVILEGED' : `expected DB_MIGRATOR_OVERPRIVILEGED, got exit ${migrate.status}`)
              })
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
          if ((await checkPlatformSubstrate(realDockerRunner, handle.name, id)) && checkPristineRoles(realDockerRunner, handle.name, id) && applyHostedRoleIdentity(realDockerRunner, handle.name, id) && narrowMigrator(realDockerRunner, handle.name, id)) {
            const g1 = grantDatabaseCreate(realDockerRunner, handle.name, id)
            const g2 = grantPublicSchemaCreate(realDockerRunner, handle.name, id)
            const g3 = grantAuthSchemaUsage(realDockerRunner, handle.name, id)
            const g4 = applyPartAHelpers(realDockerRunner, handle.name, id)
            if (g1 && g2 && g3 && g4) {
              await withEnvRestore(id, () => {
                const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
                if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) return
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
              })
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
  installSignalCleanup()
  console.log(`[m2-pg-gate] image tag=${IMAGE_TAG} immutable-ref=${IMAGE}`)

  // AUTHORITY v1.0.4: cheap, no-Docker self-controls first. All must be
  // green before any of the 9 disposable containers start — a broken parser
  // or migration-proof helper must never be discovered only after minutes of
  // real container work.
  const selfTestsOk = runAnsiParserSelfTest() && runMigrationProofSelfTest() && (await runEnvRestoreThrowSelfTest()) && (await runPlatformReadinessSelfTest())
  if (!selfTestsOk) {
    console.log(`\n[m2-pg-gate] OVERALL=FAIL (${results.filter((r) => r.ok).length}/${results.length} checks) — cheap self-controls failed; refusing to start any disposable container`)
    process.exitCode = 1
    return
  }

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
