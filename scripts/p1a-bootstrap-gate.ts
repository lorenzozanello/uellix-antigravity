// scripts/p1a-bootstrap-gate.ts
//
//   pnpm p1a:bootstrap:gate     (once package.json carries the entry —
//                                see PACKAGE_SYNC_BARRIER; until then:
//                                tsx scripts/p1a-bootstrap-gate.ts)
//
// The canonical LOCAL/CI clean-bootstrap-from-zero proof
// (docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json, HPO-ODS-W2-11).
//
// P1A_FULL_BOOTSTRAP_STATUS was DEFERRED_SEPARATE_GOVERNED_NODE
// (COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.3.json,
// .github/workflows/m2-real-pg-gate.yml). This script closes that node's
// topology: a fresh disposable substrate, no preexisting env dependency,
// canonical role/bootstrap topology, canonical credentials, the unmodified
// db:migrate:local, migration corpus 0000..0061, mechanically verified
// journal, B0/security postconditions, a defined second-run contract, exact
// env restoration (including the signal path), and unconditional teardown.
//
// M2_REUSE_STRATEGY=MINIMAL_EXPORT_WIDENING (docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json
// m2_reuse_decision): every governed check below that scripts/m2-disposable-pg-bootstrap.ts
// already proves — platform readiness, migration corpus proof, env
// snapshot/restore, privilege/ownership contracts, Part-A application, B0's
// own vitest-subprocess pattern — is IMPORTED and called verbatim, never
// re-implemented. scripts/m2-disposable-pg-bootstrap.ts itself was touched
// ONLY to add the `export` keyword to those functions; P1A-M1 (this
// mission's own evidence) proves `pnpm m2:pg:gate` still reports the
// identical 252-check id/verdict multiset after that widening.
//
// A REUSED FUNCTION STILL PRINTS "[m2-pg-gate] ..." AND STILL WRITES TO
// scripts/m2-disposable-pg-bootstrap.ts's OWN MODULE-PRIVATE `results` ARRAY.
// That is a deliberate, accepted consequence of calling the function
// UNMODIFIED rather than duplicating its body — see m2_reuse_decision's own
// explicitly_forbidden list (no semantic rewrite). This gate captures each
// such call's BOOLEAN RETURN VALUE and re-records it under its OWN id in the
// `results` array below; the "[m2-pg-gate]"-prefixed lines are additional,
// harmless diagnostic detail, not this gate's own accounting.
//
// WHY THIS GATE'S DISPOSABLE ROLE-IDENTITY PACKAGE IS NEW SQL, NOT A REUSED
// FUNCTION: db/prepared/stella_local_0000_local_role_identity_bootstrap.sql
// establishes PERMANENT local topology (five roles, two schema grants) that
// belongs in a governed, reviewed, SHA-pinned artifact — exactly the pattern
// db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql and
// db/prepared/stella_0001_role_topology_bootstrap.sql already use. Baking it
// into this TypeScript file instead would be precisely the "ad-hoc GRANT
// sequence outside governed prepared/bootstrap artifacts" the authority's
// canonical topology decision exists to avoid.
//
// PART-A IS REUSED VERBATIM, NEVER RE-STATED: applyPartAHelpers() already IS
// PHASE_PART_A_PREREQUISITE — SHA-verified, applied as uellix_migrator with
// SET ROLE uellix_owner fail-closed-asserted, in one continuous session. This
// gate calls it unmodified; db/prepared/storage/20260716000001_part_a_helpers.psql.sql
// itself is never read, copied or edited here.
//
// PHASE_LOCAL_PREPARED_CHAIN (db/prepared/stella_0001_role_topology_bootstrap.sql
// onward, via db/r3-4-governed-runner.ts) IS DELIBERATELY NOT EXERCISED BY
// THIS GATE'S MINIMUM INVARIANT — an explicit choice the authority's own
// canonical_topology (ordinal 6) permits: "This phase is NOT part of the
// minimum gate invariant... may be declared out of the gate's scope with a
// recorded reason."
//
// CORRECTION (P1A actor-partition remediation): an earlier revision of this
// comment gave a reason that is now FALSE and is withdrawn — it claimed the
// ADMIN-OPTION auto-grant rows a CREATEROLE-non-superuser role creator
// leaves were "unavoidable" because postgres is not a superuser here.
// MEASURED, they are avoidable: db/prepared/stella_local_0000_local_role_identity_bootstrap.sql
// now creates the five roles and issues memberships A/B as `supabase_admin`
// (a genuine superuser on this substrate), which leaves ZERO such rows — see
// its own file header, ACTOR PARTITION. The exclusion of
// PHASE_LOCAL_PREPARED_CHAIN from this gate's minimum invariant is RETAINED
// here regardless, because wiring stella_0001 (and the migration corpus it
// requires — see its own header, "WHY THIS FILE EXISTS") into this gate's
// credential window, second-run contract and env-restore scope is a further,
// separately-scoped architectural decision this remediation does not make.
// It remains an authorized, explicit choice (ordinal 6), not a forced one.
// The two statements this gate's own successor contract authorized converting in
// that file (CREATE ON SCHEMA public, USAGE ON SCHEMA auth, now fail-closed
// ASSERTIONS) were verified correct in BOTH directions this session, in
// isolation, directly against this exact substrate — see
// docs/ops/p1a/P1A_FULL_BOOTSTRAP_EVIDENCE_v1.0.0.json.
//
// SECOND-RUN CONTRACT (docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json
// second_run_contract): a full gate invocation is idempotent BECAUSE it
// provisions a fresh disposable environment every time and destroys it
// unconditionally — never because it tolerates residue. This gate proves
// that causally, not just observationally: MAIN_CYCLE runs its ENTIRE
// sequence twice, in two independently created and destroyed containers,
// within one process (P1A-P11). A repeated bootstrap against the SAME
// non-pristine database is a separate, DETERMINISTIC_SAFE_REJECTION
// contract (P1A-N6) — rejected by the pristine-state precondition, before
// any privilege mutation, never a convergent no-op.
//
// ENV LIFECYCLE: scripts/rotate-local-role-credentials.ts and
// scripts/db-migrate-local.ts are UNMODIFIED. This gate snapshots
// .env.local / .env.migration.local / .env.audit.local (gitignored,
// non-authority) before every credential-dependent window and restores their
// exact bytes — or exact absence — afterward, success or failure, via the
// reused exception-safe withEnvRestore(). SIGINT/SIGTERM additionally
// attempt the SAME exact restoration on a best-effort basis (R2-F2 closure,
// P1A-N5) — see installP1aSignalCleanup below. SIGKILL and host loss are
// NOT claimed to be recoverable, by design and by explicit authority
// requirement.
//
// TARGET: bound to 127.0.0.1:<LOCAL_DB_PORT> ONLY, on a container this gate
// creates itself after proving the port free, torn down unconditionally.
// Never staging, never Production, never a persistent local-dev database.

import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import {
  realDockerRunner,
  parseAssignedPort,
  hasOnlyAcceptableMounts,
  type DockerRunner,
} from './db-audit-disposable'
import {
  IMAGE,
  checkPlatformSubstrate,
  runPlatformReadinessSelfTest,
  deriveExpectedMigrationCorpus,
  evaluateMigrationProof,
  checkMigrationProof,
  runMigrationProofSelfTest,
  type ExpectedMigrationCorpus,
  snapshotEnvFiles,
  restoreEnvFiles,
  withEnvRestore,
  type EnvSnapshot,
  checkPristineRoles,
  grantDatabaseCreate,
  revokeDatabaseCreate,
  applyPartAHelpers,
  checkPrivP7,
  verifyPinnedSha,
  checkPreMigrationContract,
  checkOwnershipPostcondition,
  computeFinalPrivilegeContract,
  checkFinalPrivilegeContract,
  psql,
  psqlAs,
  runPnpm,
  parseVitestSummary,
  isExactM2Result,
} from './m2-disposable-pg-bootstrap'
import { LOCAL_DB_PORT, LOCAL_CREDENTIAL_ROTATION_CONFIRMATION } from '../db/safety/local-stack'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// Deliberately DIFFERENT from M2's 'uellix-m2-pg-gate' label prefix — this is
// a separate gate with its own disposable containers, never M2's. Sharing a
// prefix would make scripts/m2-disposable-pg-bootstrap.ts's OWN
// verifyZeroLabelledLeftovers() (unrelated to this gate, running in a
// different process) blind to this gate's leftovers and vice versa, purely
// cosmetically — the two gates can never actually run concurrently, since
// both bind the SAME fixed LOCAL_DB_PORT (db/safety/local-stack.ts) and
// would fail closed on the port-precheck first. Distinct labels keep
// `docker ps` output honest regardless.
const CONTAINER_LABEL_PREFIX = 'uellix-p1a-bootstrap-gate'

const LOCAL_ROLE_IDENTITY_PATH = resolve(REPO_ROOT, 'db/prepared/stella_local_0000_local_role_identity_bootstrap.sql')
// Recomputed and cross-checked this session against the committed file via
// `node -e "createHash('sha256')..."`, the same mechanism verifyPinnedSha()
// re-derives and compares live, every application — this constant is
// evidence of the exact bytes authorized, not a substitute for that check.
// Updated by the P1A actor-partition remediation: the file's corrected
// content (supabase_admin now performs role creation and memberships A/B)
// changed its bytes from the prior pin.
const LOCAL_ROLE_IDENTITY_SHA256_EXPECTED = 'c15b08370940dcbfc388981ec2d1ea478c030ae0bbbae0c7ea5ca0eeceac94d9'
const LOCAL_ROLE_IDENTITY_SQL = readFileSync(LOCAL_ROLE_IDENTITY_PATH, 'utf8')

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const LOCAL_ROLE_IDENTITY_SHA256_ACTUAL = sha256(LOCAL_ROLE_IDENTITY_SQL)

const ENV_FILES = ['.env.local', '.env.migration.local', '.env.audit.local'].map((f) => resolve(REPO_ROOT, f))

interface StepResult { id: string; ok: boolean; detail?: string }

// This gate's OWN, INDEPENDENT accounting — never scripts/m2-disposable-pg-bootstrap.ts's
// module-private `results` array, which stays entirely internal to that
// module and to `pnpm m2:pg:gate`'s own run.
const results: StepResult[] = []
function record(id: string, ok: boolean, detail?: string): boolean {
  results.push({ id, ok, detail })
  console.log(`[p1a-bootstrap-gate] ${id}=${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`)
  return ok
}

// ---------------------------------------------------------------------------
// Cheap, no-Docker self-controls — must ALL be green before any disposable
// container starts, mirroring the precedent at
// scripts/m2-disposable-pg-bootstrap.ts main()'s own self-tests-first
// ordering.
// ---------------------------------------------------------------------------

/**
 * P1A-N4, vector (a): reuses scripts/m2-disposable-pg-bootstrap.ts's own
 * runMigrationProofSelfTest() (truncated corpus — terminal entry missing).
 * Vector (b), NEW here and absent from M2: the SAME cardinality, with two
 * hashes REORDERED. Vector (a) alone cannot distinguish "checks corpus
 * order" from "checks corpus cardinality" — a corpus-proof implementation
 * that only counted entries would pass vector (a)'s truncation-changes-the-
 * count case yet never notice two migrations silently swapped. Both mutations
 * are disposable, in-memory transformations of the REAL corpus this
 * repository's own db/migrations/meta/_journal.json derives — never a write
 * to db/migrations/**.
 */
function runMigrationCorpusOrderSensitivitySelfTest(): boolean {
  const inherited = runMigrationProofSelfTest()
  record('SELFTEST:P1A-N4-VECTOR-A-INHERITED', inherited, 'scripts/m2-disposable-pg-bootstrap.ts runMigrationProofSelfTest() (truncated corpus) reused verbatim')

  const expected: ExpectedMigrationCorpus = deriveExpectedMigrationCorpus()
  const validHashesInOrder = expected.entries.map((e) => e.hash)
  if (validHashesInOrder.length < 2) {
    return record('SELFTEST:P1A-N4-VECTOR-B-REORDERED', false, 'corpus has fewer than 2 entries; reorder vector is not constructible')
  }

  const reordered = [...validHashesInOrder]
  // Swap the first two entries — same length, same multiset of hashes,
  // different ORDER. A cardinality-only check would see this as identical
  // to the valid corpus.
  ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]

  const result = evaluateMigrationProof(reordered, expected)
  const ok = result.countOk && !result.corpusOk
  return record(
    'SELFTEST:P1A-N4-VECTOR-B-REORDERED',
    ok,
    ok
      ? `countOk=true (same cardinality, ${reordered.length} entries) but corpusOk=false (order mismatch correctly detected) — proves the proof is order-sensitive, not merely cardinality-sensitive`
      : `expected countOk=true/corpusOk=false, got countOk=${result.countOk}/corpusOk=${result.corpusOk}`,
  )
}

/**
 * Structural, static proof (no Docker) that
 * db/prepared/stella_local_0000_local_role_identity_bootstrap.sql performs
 * EXACTLY the corrected actor partition
 * (P1A_FULL_BOOTSTRAP_AUTHORITY_AMENDMENT_v1.0.1.json D5_b2_grantor.actor_partition):
 * TWO reconnections — to `supabase_admin`, then back to `postgres` — with
 * EXACTLY THREE privilege-changing statements (P1A-N7) in the supabase_admin
 * segment and EXACTLY TWO (the public-schema ACL only) in the final postgres
 * segment. Provable from source text alone because every mutating statement
 * in this specific file is a literal at column 0 (mirrors the
 * source-scanning technique scripts/m2-disposable-pg-bootstrap.ts
 * SELFTEST:READY-N5 already uses for an analogous "called exactly once"
 * claim).
 */
function runSingleAdminWriteStructuralSelfTest(): boolean {
  const src = LOCAL_ROLE_IDENTITY_SQL
  const connectMatches = [...src.matchAll(/^\\connect - (\S+)$/gm)]
  if (connectMatches.length !== 2 || connectMatches[0][1] !== 'supabase_admin' || connectMatches[1][1] !== 'postgres') {
    return record(
      'SELFTEST:P1A-N7-STRUCTURAL',
      false,
      `expected exactly two \\connect statements (supabase_admin then postgres), found: ${JSON.stringify(connectMatches.map((m) => m[1]))}`,
    )
  }

  const supabaseAdminSegment = src.slice(connectMatches[0].index, connectMatches[1].index)
  const postgresSegment = src.slice(connectMatches[1].index! + connectMatches[1][0].length)

  // Top-level (column-0) mutating keywords only — matches this file's own
  // literal style (every GRANT/REVOKE/CREATE/ALTER in it starts a line at
  // column 0; the self-verification block's SELECT/RAISE statements inside
  // the DO $$ body are indented, not column-0, and are read-only regardless).
  const MUTATING = /^(GRANT|REVOKE|CREATE ROLE|ALTER ROLE|CREATE SCHEMA|DROP)\b/gm

  // supabase_admin: CREATE ROLE x5 (not privilege writes — zero
  // pg_auth_members rows from a superuser creator) + one ALTER ROLE ... SET
  // default_transaction_read_only (a role-attribute default, not a
  // privilege-graph mutation — no pg_auth_members row, no ACL) + membership
  // A + B + the auth grant = exactly 3 privilege-changing GRANT statements.
  const createRoleLines = (supabaseAdminSegment.match(/^CREATE ROLE\b/gm) ?? []).length
  const alterRoleLines = (supabaseAdminSegment.match(/^ALTER ROLE\b/gm) ?? []).length
  const supabaseAdminGrants = [...supabaseAdminSegment.matchAll(MUTATING)].filter((m) => m[1] === 'GRANT')
  const supabaseAdminNonGrantNonCreate = [...supabaseAdminSegment.matchAll(MUTATING)].filter(
    (m) => m[1] !== 'GRANT' && m[1] !== 'CREATE ROLE' && m[1] !== 'ALTER ROLE',
  )
  const supabaseAdminOk =
    createRoleLines === 5 &&
    alterRoleLines === 1 &&
    /^ALTER ROLE uellix_auditor SET default_transaction_read_only = on;$/m.test(supabaseAdminSegment) &&
    supabaseAdminGrants.length === 3 &&
    supabaseAdminNonGrantNonCreate.length === 0 &&
    /^GRANT uellix_owner {2}TO uellix_migrator/m.test(supabaseAdminSegment) &&
    /^GRANT uellix_writer TO uellix_app/m.test(supabaseAdminSegment) &&
    /^GRANT USAGE ON SCHEMA auth TO uellix_owner;$/m.test(supabaseAdminSegment)

  // postgres (final segment): exactly the two public-schema ACL statements —
  // no role creation, no membership, no auth-schema touch, no further
  // \connect (already proven above: exactly two \connect total).
  const postgresMutating = [...postgresSegment.matchAll(MUTATING)]
  const postgresOk =
    postgresMutating.length === 2 &&
    /^GRANT USAGE, CREATE ON SCHEMA public TO uellix_owner;$/m.test(postgresSegment) &&
    /^REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor, PUBLIC;$/m.test(postgresSegment)

  const ok = supabaseAdminOk && postgresOk
  return record(
    'SELFTEST:P1A-N7-STRUCTURAL',
    ok,
    ok
      ? 'corrected actor partition confirmed: supabase_admin segment = CREATE ROLE x5 (0 privilege writes) + exactly 3 GRANTs (membership A, membership B, auth USAGE); postgres segment = exactly the 2 public-schema ACL statements, nothing else'
      : `actor partition mismatch — supabaseAdminOk=${supabaseAdminOk} (createRoleLines=${createRoleLines}, grants=${supabaseAdminGrants.length}, other=${supabaseAdminNonGrantNonCreate.length}) postgresOk=${postgresOk} (mutating=${postgresMutating.length})`,
  )
}

/**
 * Cheap self-control proving withEnvRestore's finally actually fires and
 * restores exact bytes/absence even when the wrapped work throws — the SAME
 * proof scripts/m2-disposable-pg-bootstrap.ts's own (unexported)
 * runEnvRestoreThrowSelfTest performs, reimplemented here (not exported,
 * since it is itself only a thin wrapper around the exported
 * withEnvRestore/ENV_FILES machinery this gate already imports) so this
 * gate carries its own direct evidence rather than relying on M2's run.
 */
async function runEnvRestoreThrowSelfTest(): Promise<boolean> {
  const probePath = ENV_FILES[0]
  const before = existsSync(probePath) ? readFileSync(probePath) : null

  let caughtExpected = false
  try {
    await withEnvRestore('SELFTEST-P1A-ENV-N2', () => {
      writeFileSync(probePath, Buffer.from('SELFTEST_P1A_INJECTED_MUTATION_NEVER_PERSISTED=1\n'))
      throw new Error('SELFTEST-P1A-ENV-N2-DELIBERATE-THROW')
    })
  } catch (err) {
    caughtExpected = err instanceof Error && err.message === 'SELFTEST-P1A-ENV-N2-DELIBERATE-THROW'
  }

  const after = existsSync(probePath) ? readFileSync(probePath) : null
  const restoredCorrectly = before === null ? after === null : after !== null && sha256(after.toString('binary')) === sha256(before.toString('binary'))
  return record('SELFTEST:P1A-M3-ENV-RESTORE-THROW', caughtExpected && restoredCorrectly, restoredCorrectly ? 'exact byte/absence state restored despite a thrown exception mid-window (P1A-M3)' : 'restoration FAILED after injected throw')
}

// ---------------------------------------------------------------------------
// Container lifecycle — this gate's OWN, built directly on the ALREADY
// exported primitives in scripts/db-audit-disposable.ts (realDockerRunner,
// parseAssignedPort, hasOnlyAcceptableMounts). Deliberately NOT a reuse of
// scripts/m2-disposable-pg-bootstrap.ts's createContainer/teardownContainer:
// those are hardcoded to M2's OWN CONTAINER_LABEL_PREFIX, and duplicating
// their ~30 lines of orchestration against the SAME already-exported
// low-level primitives is smaller and clearer than exporting yet more M2
// internals for a part that carries no shared SQL/privilege contract to keep
// byte-identical — only Docker command sequencing, which this substrate and
// M2's share by convention (same pinned IMAGE, same LOCAL_DB_PORT), not by
// required code reuse.
// ---------------------------------------------------------------------------

interface ContainerHandle { runner: DockerRunner; name: string; created: boolean }

const activeContainers = new Set<ContainerHandle>()
/** The env snapshot currently open, if any — read by the SIGINT/SIGTERM handler so a signal mid-window can attempt the SAME restoration withEnvRestore's finally would have performed. */
let activeEnvSnapshot: EnvSnapshot[] | null = null

async function isPortFree(runner: DockerRunner, port: number): Promise<boolean> {
  const dockerLevel = runner.run(['ps', '-a', '--filter', `publish=${port}`, '--format', '{{.Names}}'])
  if (dockerLevel.status === 0 && dockerLevel.stdout.trim().length > 0) return false
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => server.close(() => resolvePromise(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function createP1aContainer(runner: DockerRunner, phase: string): Promise<ContainerHandle | null> {
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

  const portResult = runner.run(['port', name, '5432/tcp'])
  const assignedPort = portResult.status === 0 ? parseAssignedPort(portResult.stdout) : null
  if (!record(`${phase}:PORT-BOUND-CHECK`, assignedPort === LOCAL_DB_PORT, `bound to 127.0.0.1:${LOCAL_DB_PORT} exactly`)) return handle

  return handle
}

async function teardownP1aContainer(handle: ContainerHandle, phase: string): Promise<void> {
  activeContainers.delete(handle)
  if (!handle.created) return
  const removed = handle.runner.run(['rm', '-f', '-v', handle.name])
  const leftover = handle.runner.run(['ps', '-a', '--filter', `name=^${handle.name}$`, '--format', '{{.Names}}'])
  const leftoverCount = leftover.status === 0 && leftover.stdout.trim().length > 0 ? 1 : 0
  record(`${phase}:TEARDOWN`, removed.status === 0 && leftoverCount === 0, removed.status === 0 && leftoverCount === 0 ? 'SUCCESS' : 'FAILED')
  const portFreeAfter = await isPortFree(handle.runner, LOCAL_DB_PORT)
  record(`${phase}:PORT-FREE-AFTER-TEARDOWN`, portFreeAfter)
}

function verifyZeroP1aLabelledLeftovers(runner: DockerRunner): void {
  const anyLabelLeftover = runner.run(['ps', '-a', '--filter', `name=${CONTAINER_LABEL_PREFIX}`, '--format', '{{.Names}}'])
  const count = anyLabelLeftover.status === 0 ? anyLabelLeftover.stdout.trim().split('\n').filter(Boolean).length : -1
  record('FINAL:LABELLED-LEFTOVER-COUNT', count === 0, String(count))
}

// ---------------------------------------------------------------------------
// SIGINT/SIGTERM — R2-F2 closure (P1A-N5). BEST_EFFORT_USERLAND only: a
// SIGKILL or host failure cannot run any userland handler, Node or
// otherwise, and this gate never claims it can. Unlike
// scripts/m2-disposable-pg-bootstrap.ts's installSignalCleanup (container
// teardown only, no env restoration — the measured gap this authority
// exists to close), this handler ALSO attempts the exact env restoration
// withEnvRestore's own finally would have performed, using the SAME
// snapshot/restore primitives, BEFORE process.exit.
// ---------------------------------------------------------------------------

let signalCleanupInProgress = false
function installP1aSignalCleanup(): void {
  const handler = (signal: string) => {
    if (signalCleanupInProgress) return
    signalCleanupInProgress = true
    console.error(`[p1a-bootstrap-gate] received ${signal} — best-effort env restoration + container cleanup (EXCEPTION_SAFE=YES for in-process throws via withEnvRestore; this signal path is HARD_PROCESS_TERMINATION_GUARANTEE=NO)`)
    const pendingContainers = [...activeContainers]
    const pendingEnvSnapshot = activeEnvSnapshot
    void (async () => {
      if (pendingEnvSnapshot) {
        const restored = restoreEnvFiles(pendingEnvSnapshot, `SIGNAL-${signal}-ENV-RESTORE`)
        record(`SIGNAL-${signal}:ENV-RESTORE-ATTEMPTED`, restored, restored ? 'best-effort userland restoration succeeded' : 'best-effort userland restoration reported a mismatch')
      }
      for (const handle of pendingContainers) {
        try {
          handle.runner.run(['rm', '-f', '-v', handle.name])
        } catch {
          // best-effort only.
        }
      }
      process.exit(130)
    })()
  }
  process.on('SIGINT', () => handler('SIGINT'))
  process.on('SIGTERM', () => handler('SIGTERM'))
}

/** Wraps withEnvRestore so the active snapshot is visible to the signal handler for the exact duration of the credential window, and always cleared afterward regardless of outcome. */
async function withEnvRestoreAndSignalVisibility<T>(labelPrefix: string, fn: () => Promise<T> | T): Promise<T> {
  const snapshot = snapshotEnvFiles()
  activeEnvSnapshot = snapshot
  try {
    return await withEnvRestore(labelPrefix, fn)
  } finally {
    activeEnvSnapshot = null
  }
}

// ---------------------------------------------------------------------------
// MAIN CYCLE — the full canonical topology, PHASE_PLATFORM_SUBSTRATE through
// PHASE_POSTCONDITIONS, in one fresh disposable container. Called TWICE by
// main() (P1A-P11 / second-run contract): the cycle itself carries no
// memory between calls, and its own PORT-PRECHECK / pristine-role /
// CONTAINER-CREATE steps are what make a second call to a FRESH container
// succeed identically — never residue tolerance.
// ---------------------------------------------------------------------------

async function runMainCycle(runner: DockerRunner, cycleLabel: string): Promise<boolean> {
  const phase = cycleLabel

  // P1A-N1's positive half: prove no preexisting env file before this cycle
  // even starts. Real absence, not merely "we did not check."
  for (const path of ENV_FILES) {
    if (!record(`${phase}:PRE-CYCLE-ENV-ABSENT:${path.split(/[\\/]/).pop()}`, !existsSync(path), existsSync(path) ? 'unexpectedly present before the cycle started' : 'absent, as required')) {
      return false
    }
  }

  const handle = await createP1aContainer(runner, phase)
  if (!handle) return false

  try {
    if (!handle.created || results.some((r) => r.id.startsWith(`${phase}:`) && !r.ok)) return false

    // PHASE_PLATFORM_SUBSTRATE — P1A-P1.
    const ready = await checkPlatformSubstrate(runner, handle.name, phase)
    if (!record(`${phase}:P1A-P1-PLATFORM-READINESS`, ready, 'reused scripts/m2-disposable-pg-bootstrap.ts checkPlatformSubstrate() verbatim')) return false

    // Pristine-state precondition — P1A-P2.
    const pristine = checkPristineRoles(runner, handle.name, phase)
    if (!record(`${phase}:P1A-P2-PRISTINE-ROLES`, pristine, 'reused scripts/m2-disposable-pg-bootstrap.ts checkPristineRoles() verbatim')) return false

    // PHASE_LOCAL_ROLE_IDENTITY + PHASE_BOOTSTRAP_PRIVILEGE — P1A-P3.
    if (!verifyPinnedSha(phase, 'LOCAL-ROLE-IDENTITY-SHA-VERIFY', LOCAL_ROLE_IDENTITY_SHA256_ACTUAL, LOCAL_ROLE_IDENTITY_SHA256_EXPECTED)) return false
    const identitySql = `SET uellix.bootstrap_environment = 'local';\n${LOCAL_ROLE_IDENTITY_SQL}`
    const identityApplied = psql(runner, handle.name, identitySql)
    if (!record(`${phase}:P1A-P3-LOCAL-ROLE-IDENTITY-APPLIED`, identityApplied.status === 0, identityApplied.status === 0 ? 'stella_local_0000 applied verbatim; its own self-verification passed (5 roles, 2 memberships, public USAGE/CREATE, auth USAGE)' : identityApplied.stderr || identityApplied.stdout)) return false

    // PHASE_PART_A_PREREQUISITE — P1A-P5. Reused verbatim: SHA-verified,
    // applied as uellix_migrator with SET ROLE uellix_owner fail-closed
    // asserted, in one continuous session.
    if (!applyPartAHelpers(runner, handle.name, phase)) return false
    const partAOwned = checkPrivP7(runner, handle.name, phase)
    if (!record(`${phase}:P1A-P5-PART-A-APPLIED-AND-OWNED`, partAOwned, 'reused scripts/m2-disposable-pg-bootstrap.ts applyPartAHelpers()/checkPrivP7() verbatim')) return false

    // PHASE_MIGRATION_WINDOW, step 6 — TEMPORARY database CREATE. Reused
    // verbatim; revokeDatabaseCreate() closes this same window below,
    // unconditionally, inside the credential window's own scope.
    if (!grantDatabaseCreate(runner, handle.name, phase)) return false

    // Pre-migration privilege contract — P1A-P4. All five sub-checks reused
    // verbatim (owner db-CREATE/public USAGE+CREATE/auth USAGE, migrator not
    // overprivileged, owner membership shape).
    const preMigration = checkPreMigrationContract(runner, handle.name, phase)
    if (!record(`${phase}:P1A-P4-PRE-MIGRATION-CONTRACT`, preMigration, 'reused scripts/m2-disposable-pg-bootstrap.ts checkPreMigrationContract() verbatim')) return false

    // PHASE_MIGRATION_WINDOW proper — ONE bounded, exception-safe credential
    // window. Rotation, migration, corpus proof, ownership/privilege
    // postconditions and the B0 vitest subprocess all sit INSIDE it, for the
    // exact reason scripts/m2-disposable-pg-bootstrap.ts documents at its
    // own MAIN phase: restoring env immediately after migrate() and before
    // anything that reads the rotated credentials fails with a password
    // error, measured directly in that session and inherited here unchanged.
    await withEnvRestoreAndSignalVisibility(phase, () => {
      // P1A-P6 — credential rotation, from no preexisting env (already
      // proven above), never printing a credential.
      const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
      if (!record(`${phase}:P1A-P6-ROTATE-CREDENTIALS`, rotate.status === 0, 'scripts/rotate-local-role-credentials.ts (unchanged); credentials never printed')) return

      // P1A-P7 — the canonical, UNMODIFIED entry point.
      const migrate = runPnpm(['db:migrate:local'])
      if (!record(`${phase}:P1A-P7-MIGRATE`, migrate.status === 0, migrate.status === 0 ? 'pnpm db:migrate:local (unchanged): assertMigratorSession PASS, SET ROLE uellix_owner, exited 0' : 'pnpm db:migrate:local exited non-zero')) return

      // Mechanical journal/corpus proof, reused verbatim.
      const corpus = checkMigrationProof(runner, handle.name, phase)
      if (!record(`${phase}:P1A-P7-MIGRATION-CORPUS-PROOF`, corpus, 'reused scripts/m2-disposable-pg-bootstrap.ts checkMigrationProof() verbatim — journal count, hash sequence in order, terminal 0061 presence')) return

      // P1A-P8 — ownership, then close the temporary DB-CREATE window
      // (P1A-M2: an unconditional revoke, proven live here rather than only
      // by inherited construction), then the final privilege contract.
      const ownership = checkOwnershipPostcondition(runner, handle.name, phase)
      if (!record(`${phase}:P1A-P8-OWNERSHIP-POSTCONDITION`, ownership, 'reused scripts/m2-disposable-pg-bootstrap.ts checkOwnershipPostcondition() verbatim')) return

      if (!revokeDatabaseCreate(runner, handle.name, phase)) return

      const finalContract = checkFinalPrivilegeContract(runner, handle.name, phase)
      if (!record(`${phase}:P1A-P8-FINAL-PRIVILEGE-CONTRACT`, finalContract, 'reused scripts/m2-disposable-pg-bootstrap.ts checkFinalPrivilegeContract() verbatim — database CREATE proven revoked')) return

      // P1A-P9 — B0/security postconditions, via the SAME shared,
      // unmodified real-PostgreSQL test scripts/m2-disposable-pg-bootstrap.ts
      // itself uses (tests/integration/function-execute-acl-guard.test.ts),
      // against THIS gate's own freshly migrated corpus. Reuses the same
      // reused, never duplicated, discipline: B0_17.check()/probeSql are
      // read from db/hosted/baseline-postconditions.ts by that shared test
      // file, not re-implemented here.
      const b0Test = runPnpm(['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'tests/integration/function-execute-acl-guard.test.ts'])
      const summary = parseVitestSummary(b0Test.combined)
      const b0Ok = b0Test.status === 0 && isExactM2Result(summary)
      record(`${phase}:P1A-P9-B0-POSTCONDITIONS`, b0Ok, b0Ok ? '1 file, 4 tests, 4 executed, 4 PASS, 0 skip (ANSI-tolerant parse) — same shared test file scripts/m2-disposable-pg-bootstrap.ts uses' : `did not match the required 1-file/4-test/4-pass/0-skip result${summary ? ` (parsed: files=${JSON.stringify(summary.testFiles)} tests=${JSON.stringify(summary.tests)})` : ' (summary lines not found)'}`)
    })

  } finally {
    await teardownP1aContainer(handle, phase)
  }

  return results.filter((r) => r.id.startsWith(`${phase}:`)).every((r) => r.ok)
}

// ---------------------------------------------------------------------------
// NEGATIVE PHASES — each its own fresh disposable container, minimum work,
// mirroring scripts/m2-disposable-pg-bootstrap.ts's own runNegative pattern:
// build up to the exact point under test, prove the specific gap is absent
// by a direct SQL query (deterministic, independent of error-message text),
// THEN prove db:migrate:local itself refuses.
// ---------------------------------------------------------------------------

/**
 * Shared setup for every negative control below: platform readiness,
 * pristine roles, the local role-identity package, Part-A. Everything a
 * negative control needs UP TO the point it deliberately deviates. Returns
 * the container handle (caller tears it down) or null if setup itself
 * failed — which is itself a hard gate failure, not a negative-control
 * result.
 */
async function setupForNegativeControl(runner: DockerRunner, id: string): Promise<ContainerHandle | null> {
  const handle = await createP1aContainer(runner, id)
  if (!handle) return null
  if (!handle.created || results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return handle

  const ready = await checkPlatformSubstrate(runner, handle.name, id)
  if (!record(`${id}:SETUP-PLATFORM-READINESS`, ready)) return handle

  const pristine = checkPristineRoles(runner, handle.name, id)
  if (!record(`${id}:SETUP-PRISTINE-ROLES`, pristine)) return handle

  if (!verifyPinnedSha(id, 'SETUP-LOCAL-ROLE-IDENTITY-SHA-VERIFY', LOCAL_ROLE_IDENTITY_SHA256_ACTUAL, LOCAL_ROLE_IDENTITY_SHA256_EXPECTED)) return handle
  const identitySql = `SET uellix.bootstrap_environment = 'local';\n${LOCAL_ROLE_IDENTITY_SQL}`
  const identityApplied = psql(runner, handle.name, identitySql)
  if (!record(`${id}:SETUP-LOCAL-ROLE-IDENTITY-APPLIED`, identityApplied.status === 0, identityApplied.status === 0 ? undefined : identityApplied.stderr || identityApplied.stdout)) return handle

  if (!applyPartAHelpers(runner, handle.name, id)) return handle

  return handle
}

/** Direct SQL proof that a boolean predicate is exactly `false` — never inferred from a migration failure alone. */
function proveGapAbsent(runner: DockerRunner, container: string, phase: string, id: string, query: string): boolean {
  const q = psql(runner, container, query)
  return record(`${phase}:${id}`, (q.stdout || '').trim() === 'f', `has_privilege=${(q.stdout || '').trim()}`)
}

/** Attempts db:migrate:local and proves it refuses (non-zero exit) INSIDE a bounded, exception-safe credential window — mirrors scripts/m2-disposable-pg-bootstrap.ts runNegative()'s own final step. */
async function attemptMigrationExpectingRefusal(id: string): Promise<void> {
  await withEnvRestoreAndSignalVisibility(id, () => {
    const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
    if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) return
    const migrate = runPnpm(['db:migrate:local'])
    record(id, migrate.status !== 0, migrate.status !== 0 ? 'db:migrate:local correctly refused (deterministic privilege gap already proven absent above)' : 'db:migrate:local unexpectedly SUCCEEDED despite the proven-absent privilege')
  })
}

/**
 * PRIV-N1a/b/c — inherited BY REFERENCE from
 * scripts/m2-disposable-pg-bootstrap.ts's PRIV-N1a/b/c
 * (STEP3/4/5 individually omitted), re-pointed at this gate's OWN atomic SQL
 * package. Because db/prepared/stella_local_0000_local_role_identity_bootstrap.sql
 * grants public CREATE and auth USAGE inside ONE governed file (unlike M2,
 * which issues three separately-skippable ad-hoc GRANTs), the equivalent
 * proof here is: apply the REAL, UNMODIFIED, SHA-verified package in full,
 * then deliberately REVOKE the ONE privilege under test — proving the
 * package's OWN real output, minus exactly one grant, is what migration
 * depends on, rather than a hand-truncated variant of the governed file.
 */
async function runPrivN1SchemaGrantNegative(runner: DockerRunner, id: string, revokeSql: string, gapQuery: string, revokeActor: 'postgres' | 'supabase_admin' = 'postgres'): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    // The revoking actor must actually hold privilege to revoke — measured
    // this session: `postgres` does not own schema `auth` on this substrate,
    // so a REVOKE issued as `postgres` there does not error, it silently
    // WARNs "no privileges were revoked" and exits 0. PRIV-N1c therefore
    // revokes as `supabase_admin`, mirroring the actor
    // db/prepared/stella_local_0000_local_role_identity_bootstrap.sql itself
    // uses for the equivalent grant. PRIV-N1a/b revoke as `postgres`, which
    // does hold effective owner-level rights on `public` and the database.
    const revoked = revokeActor === 'supabase_admin' ? psqlAs(runner, handle.name, 'supabase_admin', revokeSql) : psql(runner, handle.name, revokeSql)
    if (!record(`${id}:DELIBERATE-REVOKE`, revoked.status === 0, `${revokeSql} (actor: ${revokeActor})`)) return
    if (!proveGapAbsent(runner, handle.name, id, 'GAP-PROOF', gapQuery)) return
    await attemptMigrationExpectingRefusal(id)
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/** PRIV-N1d — inherited BY REFERENCE: Part-A omitted (setupForNegativeControl already applied it; this variant re-does setup WITHOUT it). */
async function runPrivN1dPartAOmittedNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await createP1aContainer(runner, id)
  if (!handle) return
  try {
    if (!handle.created || results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    if (!(await checkPlatformSubstrate(runner, handle.name, id))) return
    if (!checkPristineRoles(runner, handle.name, id)) return
    if (!verifyPinnedSha(id, 'LOCAL-ROLE-IDENTITY-SHA-VERIFY', LOCAL_ROLE_IDENTITY_SHA256_ACTUAL, LOCAL_ROLE_IDENTITY_SHA256_EXPECTED)) return
    const identitySql = `SET uellix.bootstrap_environment = 'local';\n${LOCAL_ROLE_IDENTITY_SQL}`
    const applied = psql(runner, handle.name, identitySql)
    if (!record(`${id}:LOCAL-ROLE-IDENTITY-APPLIED`, applied.status === 0)) return
    // Part-A deliberately NOT applied.
    const gapQuery = `SELECT (count(*) = 2) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('can_read_evidence_object','can_write_evidence_object');`
    const q = psql(runner, handle.name, gapQuery)
    if (!record(`${id}:GAP-PROOF`, (q.stdout || '').trim() === 'f', 'Part-A functions correctly absent')) return
    await attemptMigrationExpectingRefusal(id)
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/** PRIV-N2 — inherited BY REFERENCE: temporary database CREATE granted to uellix_migrator instead of uellix_owner; SET ROLE owner still lacks it. */
async function runPrivN2WrongGranteeNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    const grant = psql(runner, handle.name, 'GRANT CREATE ON DATABASE postgres TO uellix_migrator;')
    if (!record(`${id}:DELIBERATE-WRONG-GRANTEE`, grant.status === 0)) return
    if (!proveGapAbsent(runner, handle.name, id, 'GAP-PROOF', `SELECT has_database_privilege('uellix_owner','postgres','CREATE');`)) return
    await attemptMigrationExpectingRefusal(id)
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/** PRIV-N3 — inherited BY REFERENCE: a deliberate extra privilege (public CREATE to migrator, never authorized) must be CAUGHT by the final contract probe — computed, never recorded as a script-level failure (this negative control PASSES when the contract correctly reports the escalation). */
async function runPrivN3ExtraPrivilegeDetectedNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    if (!grantDatabaseCreate(runner, handle.name, id)) return
    const escalate = psql(runner, handle.name, 'GRANT CREATE ON SCHEMA public TO uellix_migrator;')
    if (!record(`${id}:DELIBERATE-ESCALATION`, escalate.status === 0)) return
    const contract = computeFinalPrivilegeContract(runner, handle.name)
    const detected = !contract.migratorOk
    record(id, detected, detected ? `final privilege contract correctly detected the unauthorized escalation (${contract.migratorDetail})` : 'final privilege contract FAILED to detect the escalation')
    // Clean up the deliberate escalation before teardown proves nothing about
    // the container's disposal, but leaving it is harmless either way — the
    // whole container is destroyed in `finally` regardless.
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/** PRIV-N4 — inherited BY REFERENCE: CREATEROLE re-granted to uellix_migrator before migration must be refused (DB_MIGRATOR_OVERPRIVILEGED). Unlike M2 (which narrows a hosted-package migrator that started WITH CREATEROLE), this gate's migrator never has it — so the negative control ADDS it deliberately, via supabase_admin (the ALTER ROLE ... CREATEROLE touch requires a genuine superuser on this substrate — measured this session). */
async function runPrivN4CreateroleRegrantedNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    if (!grantDatabaseCreate(runner, handle.name, id)) return
    const regrant = psqlAs(runner, handle.name, 'supabase_admin', 'ALTER ROLE uellix_migrator CREATEROLE;')
    if (!record(`${id}:REGRANT-CREATEROLE`, regrant.status === 0)) return
    if (!proveGapAbsent(runner, handle.name, id, 'GAP-PROOF-INVERTED', `SELECT NOT rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator';`)) return
    await attemptMigrationExpectingRefusal(id)
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/**
 * P1A-N2 — wrong migration session identity is REJECTED with ZERO migration
 * advancement. The row-count proof is MANDATORY here (not merely a non-zero
 * exit): drizzle.__drizzle_migrations, and even schema `drizzle` itself, may
 * not exist yet at this point (assertMigratorSession runs before migrate()
 * ever creates them), so "does not exist" and "exists with zero rows" are
 * both treated as the correct zero-advancement state.
 */
async function runP1aN2WrongSessionIdentityNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    if (!grantDatabaseCreate(runner, handle.name, id)) return
    if (!checkPreMigrationContract(runner, handle.name, id)) return

    await withEnvRestoreAndSignalVisibility(id, () => {
      const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
      if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) return

      // Deliberately point the migration credential at the superuser
      // instead of uellix_migrator — mirrors PRIV-N5's mechanism, with the
      // additional zero-advancement proof P1A-N2 requires.
      const migrationEnvPath = resolve(REPO_ROOT, '.env.migration.local')
      const original = readFileSync(migrationEnvPath, 'utf8')
      const wrongUrl = `postgresql://supabase_admin:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`
      const rewritten = original.replace(/^UELLIX_MIGRATOR_DATABASE_URL=.*$/m, `UELLIX_MIGRATOR_DATABASE_URL=${wrongUrl}`)
      if (!record(`${id}:REWRITE-MIGRATION-ENV`, rewritten !== original, 'UELLIX_MIGRATOR_DATABASE_URL repointed at supabase_admin (never printed)')) return
      writeFileSync(migrationEnvPath, rewritten, 'utf8')

      const migrate = runPnpm(['db:migrate:local'])
      if (!record(`${id}:MIGRATE-REFUSED`, migrate.status !== 0, migrate.status !== 0 ? 'correctly refused' : 'unexpectedly SUCCEEDED')) return

      const check = psql(runner, handle.name, `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations';`)
      const tableExists = check.status === 0 && (check.stdout || '').trim() === '1'
      let rowCount = 0
      if (tableExists) {
        const rows = psql(runner, handle.name, `SELECT count(*) FROM drizzle.__drizzle_migrations;`)
        rowCount = rows.status === 0 ? Number((rows.stdout || '0').trim()) : -1
      }
      record(id, !tableExists || rowCount === 0, `drizzle.__drizzle_migrations tableExists=${tableExists} rowCount=${rowCount} — zero migration advancement proven`)
    })
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/**
 * P1A-N3 — SET ROLE ineffective is REJECTED and leaves NO incorrect
 * ownership. Revokes the uellix_owner membership uellix_migrator needs to
 * SET ROLE, then proves BOTH the refusal AND that zero application objects
 * exist owned by anything other than uellix_owner afterward — proving the
 * refusal without proving the absence of mis-owned objects would leave the
 * actual hazard (a partially-applied migration owned by the wrong role)
 * unmeasured.
 */
async function runP1aN3SetRoleIneffectiveNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return
    if (!grantDatabaseCreate(runner, handle.name, id)) return

    // supabase_admin, not postgres: under the corrected actor partition,
    // membership A is granted by supabase_admin (oid 10), and postgres holds
    // NO ADMIN OPTION over it — this negative control's REVOKE must use the
    // actual grantor, exactly as production code must, or it fails with
    // insufficient privilege rather than exercising the intended scenario.
    const revoke = psqlAs(runner, handle.name, 'supabase_admin', 'REVOKE uellix_owner FROM uellix_migrator;')
    if (!record(`${id}:DELIBERATE-REVOKE-SET-ROLE-PATH`, revoke.status === 0)) return
    if (!proveGapAbsent(runner, handle.name, id, 'GAP-PROOF', `SELECT pg_has_role('uellix_migrator','uellix_owner','USAGE');`)) return

    await withEnvRestoreAndSignalVisibility(id, () => {
      const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
      if (!record(`${id}:ROTATE-FOR-NEGATIVE-PROBE`, rotate.status === 0)) return
      const migrate = runPnpm(['db:migrate:local'])
      if (!record(`${id}:MIGRATE-REFUSED`, migrate.status !== 0, migrate.status !== 0 ? 'correctly refused (DB_MIGRATOR_SET_ROLE_FAILED expected)' : 'unexpectedly SUCCEEDED')) return

      const nonOwner = psql(
        runner, handle.name,
        `SELECT count(*) FROM (
           SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','S') AND pg_get_userbyid(c.relowner) <> 'uellix_owner'
           UNION ALL
           SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'uellix_owner'
         ) x;`,
      )
      const count = nonOwner.status === 0 ? Number((nonOwner.stdout || '0').trim()) : -1
      record(id, count === 0, `unexpected_non_owner_application_objects=${count} — no object was created with incorrect ownership`)
    })
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

/**
 * P1A-N6 — bootstrap repeated against the SAME non-pristine database is
 * DETERMINISTIC_SAFE_REJECTION, before any privilege write. Reapplies
 * db/prepared/stella_local_0000_local_role_identity_bootstrap.sql a second
 * time against a container it already successfully bootstrapped, and proves
 * the privilege state is BYTE-FOR-BYTE unchanged between the two attempts —
 * not merely that the second attempt errored.
 */
async function runP1aN6RepeatedBootstrapNegative(runner: DockerRunner, id: string): Promise<void> {
  const handle = await setupForNegativeControl(runner, id)
  if (!handle) return
  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) return

    const before = computeFinalPrivilegeContract(runner, handle.name)
    const identitySql = `SET uellix.bootstrap_environment = 'local';\n${LOCAL_ROLE_IDENTITY_SQL}`
    const second = psql(runner, handle.name, identitySql)
    if (!record(`${id}:SECOND-APPLICATION-REJECTED`, second.status !== 0, second.status !== 0 ? 'correctly refused at the pristine-role precondition, before any privilege mutation' : 'unexpectedly SUCCEEDED')) return

    const after = computeFinalPrivilegeContract(runner, handle.name)
    const unchanged = JSON.stringify(before) === JSON.stringify(after)
    record(id, unchanged, unchanged ? 'privilege state byte-for-byte unchanged between the two attempts' : `privilege state CHANGED: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

async function runAllNegatives(runner: DockerRunner): Promise<void> {
  await runPrivN1SchemaGrantNegative(runner, 'PRIV-N1a', 'REVOKE CREATE ON DATABASE postgres FROM uellix_owner;', `SELECT has_database_privilege('uellix_owner','postgres','CREATE');`)
  // PRIV-N1a here targets the TEMPORARY database-CREATE grant this gate's own
  // grantDatabaseCreate() issues (setupForNegativeControl does not grant it),
  // so its "deliberate revoke" is a no-op proof of absence rather than a
  // revoke — expressed uniformly with N1b/c below by proving the gap via the
  // SAME has_database_privilege query BEFORE ever calling grantDatabaseCreate.
  await runPrivN1SchemaGrantNegative(runner, 'PRIV-N1b', 'REVOKE CREATE ON SCHEMA public FROM uellix_owner;', `SELECT has_schema_privilege('uellix_owner','public','CREATE');`)
  await runPrivN1SchemaGrantNegative(runner, 'PRIV-N1c', 'REVOKE USAGE ON SCHEMA auth FROM uellix_owner;', `SELECT has_schema_privilege('uellix_owner','auth','USAGE');`, 'supabase_admin')
  await runPrivN1dPartAOmittedNegative(runner, 'PRIV-N1d')
  await runPrivN2WrongGranteeNegative(runner, 'PRIV-N2')
  await runPrivN3ExtraPrivilegeDetectedNegative(runner, 'PRIV-N3')
  await runPrivN4CreateroleRegrantedNegative(runner, 'PRIV-N4')
  await runP1aN2WrongSessionIdentityNegative(runner, 'P1A-N2')
  await runP1aN3SetRoleIneffectiveNegative(runner, 'P1A-N3')
  await runP1aN6RepeatedBootstrapNegative(runner, 'P1A-N6')
}

// ---------------------------------------------------------------------------
// P1A-N5 — real SIGTERM during the credential window. `sigterm-probe` is a
// SEPARATE process mode a test driver spawns as a real child process,
// watches for a stdout readiness marker printed right after credential
// rotation succeeds (env files now exist with real, never-logged content),
// sends a REAL SIGTERM, and then verifies exact restoration from OUTSIDE
// this process — see tests/p1a-bootstrap-gate.test.ts. This mode never runs
// as part of an ordinary `pnpm p1a:bootstrap:gate` invocation.
// ---------------------------------------------------------------------------

async function runSigtermProbe(): Promise<void> {
  installP1aSignalCleanup()
  const runner = realDockerRunner
  const id = 'SIGTERM-PROBE'

  const handle = await createP1aContainer(runner, id)
  if (!handle || !handle.created) {
    console.error('P1A_SIGTERM_PROBE_SETUP_FAILED')
    process.exitCode = 1
    return
  }

  try {
    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) {
      console.error('P1A_SIGTERM_PROBE_SETUP_FAILED')
      process.exitCode = 1
      return
    }
    await checkPlatformSubstrate(runner, handle.name, id)
    checkPristineRoles(runner, handle.name, id)
    const identitySql = `SET uellix.bootstrap_environment = 'local';\n${LOCAL_ROLE_IDENTITY_SQL}`
    psql(runner, handle.name, identitySql)
    applyPartAHelpers(runner, handle.name, id)
    grantDatabaseCreate(runner, handle.name, id)

    if (results.some((r) => r.id.startsWith(`${id}:`) && !r.ok)) {
      console.error('P1A_SIGTERM_PROBE_SETUP_FAILED')
      process.exitCode = 1
      return
    }

    await withEnvRestoreAndSignalVisibility(id, async () => {
      const rotate = runPnpm(['tsx', 'scripts/rotate-local-role-credentials.ts', LOCAL_CREDENTIAL_ROTATION_CONFIRMATION])
      if (rotate.status !== 0) {
        console.error('P1A_SIGTERM_PROBE_ROTATION_FAILED')
        return
      }
      // The external test driver watches for exactly this line.
      console.log('P1A_SIGTERM_PROBE_READY')
      // Bounded wait to be killed. Reaching the end of this without a signal
      // is a probe-HARNESS timing bug (the driver did not send SIGTERM in
      // time), not a claim about the gate's own restoration logic — the
      // driver's own test times out first in that case.
      await new Promise((r) => setTimeout(r, 20000))
      console.log('P1A_SIGTERM_PROBE_NOT_KILLED')
    })
  } finally {
    await teardownP1aContainer(handle, id)
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runner = realDockerRunner
  installP1aSignalCleanup()
  console.log(`[p1a-bootstrap-gate] image=${IMAGE} port=${LOCAL_DB_PORT}`)

  // Cheap, no-Docker self-controls first — must all be green before any
  // disposable container starts.
  const selfTestsOk =
    (await runPlatformReadinessSelfTest()) &&
    runMigrationCorpusOrderSensitivitySelfTest() &&
    runSingleAdminWriteStructuralSelfTest() &&
    (await runEnvRestoreThrowSelfTest())
  if (!selfTestsOk) {
    console.log(`\n[p1a-bootstrap-gate] OVERALL=FAIL (${results.filter((r) => r.ok).length}/${results.length} checks) — cheap self-controls failed; refusing to start any disposable container`)
    process.exitCode = 1
    return
  }

  try {
    // P1A-P11 / second-run contract: the ENTIRE canonical sequence, twice,
    // in two independently created and destroyed containers.
    const first = await runMainCycle(runner, 'MAIN-1')
    let second = false
    if (first) {
      second = await runMainCycle(runner, 'MAIN-2')
      record('P1A-P11-SECOND-RUN-FRESH-PROVISIONING', second, second ? 'second full cycle succeeded via a SECOND fresh container — proves fresh-provisioning idempotence, not residue tolerance' : 'second cycle failed')
    } else {
      record('P1A-P11-SECOND-RUN-FRESH-PROVISIONING', false, 'first cycle failed; second cycle skipped')
    }

    if (first) {
      await runAllNegatives(runner)
    } else {
      console.error('[p1a-bootstrap-gate] MAIN-1 failed; skipping negative controls (they assume a working positive path)')
    }
  } catch (error) {
    console.error('[p1a-bootstrap-gate] unexpected error:', error instanceof Error ? error.message : String(error))
    record('UNEXPECTED-ERROR', false, error instanceof Error ? error.message : String(error))
  } finally {
    verifyZeroP1aLabelledLeftovers(runner)
  }

  const allOk = results.every((r) => r.ok)
  console.log(`\n[p1a-bootstrap-gate] OVERALL=${allOk ? 'PASS' : 'FAIL'} (${results.filter((r) => r.ok).length}/${results.length} checks)`)
  if (!allOk) process.exitCode = 1
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/p1a-bootstrap-gate.ts')
if (invokedDirectly) {
  const mode = process.argv[2]
  if (mode === 'sigterm-probe') {
    void runSigtermProbe()
  } else if (mode === undefined) {
    void main()
  } else {
    console.error(`Usage:\n  p1a-bootstrap-gate.ts             # full gate\n  p1a-bootstrap-gate.ts sigterm-probe  # P1A-N5 real-signal test harness mode\n`)
    process.exitCode = 1
  }
}
