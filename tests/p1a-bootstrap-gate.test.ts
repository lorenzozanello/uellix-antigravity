// tests/p1a-bootstrap-gate.test.ts
//
// docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json (HPO-ODS-W2-11),
// docs/ops/p1a/P1A_FULL_BOOTSTRAP_TEST_MANIFEST_v1.0.0.json.
//
// Deliberately at tests/, NOT tests/integration/ — placing it there would
// mechanically require editing tests/database-entrypoint-safety.test.ts's
// closed-world integration-file inventory, which is outside this authority's
// surface (see P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json
// authorized_future_implementation_surface.test_placement_constraint).
//
// TWO CLASSES OF TEST HERE, KEPT SEPARATE ON PURPOSE:
//
//   1. Cheap, no-Docker, always-on (P1A-N4 both vectors, P1A-M3, the
//      structural single-admin-write proof). These run under an ordinary
//      `pnpm test` / `pnpm test:unit` — no real infrastructure needed, no
//      env var required.
//
//   2. Real-Docker (P1A-N5, the real-SIGTERM restoration proof), gated
//      behind P1A_GATE_REAL_DOCKER_TESTS=1 so an ordinary unit-test run
//      never silently starts a disposable container. .github/workflows/
//      p1a-bootstrap-gate.yml sets that variable explicitly; ci.yml's
//      "Run Unit Tests" step does not, so this describe block SKIPS there.
//
// The cheap tests import PURE functions already exported from
// scripts/m2-disposable-pg-bootstrap.ts (MINIMAL_EXPORT_WIDENING) rather
// than re-deriving the migration corpus or re-implementing the proof logic
// — this file is a second, independent EXERCISE of that logic (fast CI
// coverage, no Docker), not a duplicate implementation of it.

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { pathToFileURL } from 'node:url'
import {
  deriveExpectedMigrationCorpus,
  evaluateMigrationProof,
  withEnvRestore,
  IMAGE,
} from '../scripts/m2-disposable-pg-bootstrap'
import { R3_4_LOCAL_PHASES } from '../db/r3-4-governed-runner'
// Import-safe since the direct-execution guard: this import must NOT run
// the runner's main() — proven by the spawn-based control below, which
// observes the importing process's exitCode from the outside.
import { runR3_4PreMutationPreflight } from '../scripts/stella-r3-4-local-runner'

const REPO_ROOT = path.resolve(__dirname, '..')
const LOCAL_ROLE_IDENTITY_PATH = path.join(REPO_ROOT, 'db', 'prepared', 'stella_local_0000_local_role_identity_bootstrap.sql')
const ENV_FILES = ['.env.local', '.env.migration.local', '.env.audit.local'].map((f) => path.resolve(REPO_ROOT, f))

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('P1A-N4 — migration journal/corpus mutation is REJECTED (cheap, no Docker)', () => {
  const expected = deriveExpectedMigrationCorpus()

  it('sanity: the real repository corpus is non-empty and self-consistent', () => {
    expect(expected.count).toBeGreaterThan(0)
    const validHashesInOrder = expected.entries.map((e) => e.hash)
    const result = evaluateMigrationProof(validHashesInOrder, expected)
    expect(result.countOk).toBe(true)
    expect(result.corpusOk).toBe(true)
    expect(result.terminalOk).toBe(true)
  })

  it('vector (a): terminal entry removed — count, corpus and terminal checks ALL fail', () => {
    const validHashesInOrder = expected.entries.map((e) => e.hash)
    const truncated = validHashesInOrder.slice(0, -1)
    const result = evaluateMigrationProof(truncated, expected)
    expect(result.countOk).toBe(false)
    expect(result.corpusOk).toBe(false)
    expect(result.terminalOk).toBe(false)
  })

  it('vector (b): SAME cardinality, two hashes reordered — count PASSES, corpus-order check FAILS', () => {
    // This is the vector M2's own runMigrationProofSelfTest does NOT cover
    // (see docs/ops/p1a/P1A_FULL_BOOTSTRAP_TEST_MANIFEST_v1.0.0.json P1A-N4)
    // — it proves the proof is order-sensitive, not merely cardinality-
    // sensitive. A corpus-proof that only counted entries would pass this.
    const validHashesInOrder = expected.entries.map((e) => e.hash)
    expect(validHashesInOrder.length).toBeGreaterThanOrEqual(2)

    const reordered = [...validHashesInOrder]
    ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]

    const result = evaluateMigrationProof(reordered, expected)
    expect(result.countOk).toBe(true)
    expect(result.corpusOk).toBe(false)
  })

})

describe('P1A-M3 — finally-guaranteed env restoration survives a thrown exception (cheap, no Docker)', () => {
  it('withEnvRestore restores exact bytes/absence even when the wrapped work throws mid-window', async () => {
    const probePath = ENV_FILES[0]
    const before = existsSync(probePath) ? readFileSync(probePath) : null

    class DeliberateThrow extends Error {}
    let caught: unknown
    try {
      await withEnvRestore('TEST-P1A-M3', () => {
        writeFileSync(probePath, Buffer.from('TEST_P1A_M3_INJECTED_MUTATION_NEVER_PERSISTED=1\n'))
        throw new DeliberateThrow('TEST-P1A-M3-DELIBERATE-THROW')
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(DeliberateThrow)

    const after = existsSync(probePath) ? readFileSync(probePath) : null
    if (before === null) {
      expect(after).toBeNull()
    } else {
      expect(after).not.toBeNull()
      expect(sha256(after!.toString('binary'))).toBe(sha256(before.toString('binary')))
    }
  })
})

describe('P1A-N7 — structural proof: the corrected actor partition (cheap, no Docker)', () => {
  // Actor-partition remediation: the file now reconnects TWICE — to
  // supabase_admin first (role creation, memberships A/B, the auth grant),
  // then BACK to postgres (the public-schema ACL only) — superseding the
  // prior single-reconnect shape these assertions pinned.
  const src = readFileSync(LOCAL_ROLE_IDENTITY_PATH, 'utf8')

  it('the file reconnects exactly twice: to supabase_admin, then back to postgres', () => {
    const connectMatches = [...src.matchAll(/^\\connect - (\S+)$/gm)]
    expect(connectMatches).toHaveLength(2)
    expect(connectMatches.map((m) => m[1])).toEqual(['supabase_admin', 'postgres'])
  })

  it('exactly three privilege-changing GRANTs follow the supabase_admin reconnection: membership A, membership B, the auth grant', () => {
    const connectMatches = [...src.matchAll(/^\\connect - (\S+)$/gm)]
    const supabaseAdminSegment = src.slice(connectMatches[0].index!, connectMatches[1].index!)
    const mutatingLines = supabaseAdminSegment.match(/^(GRANT|REVOKE|CREATE ROLE|ALTER ROLE|CREATE SCHEMA|DROP)\b/gm) ?? []
    // 5x CREATE ROLE (zero privilege writes — a superuser creator leaves no
    // pg_auth_members row), 1x ALTER ROLE (auditor read-only default, not a
    // privilege-graph mutation), 3x GRANT (membership A, membership B, the
    // auth grant — P1A-N7's exactly-three invariant) = 9 mutating lines,
    // exactly 3 of which are GRANT.
    expect(mutatingLines).toHaveLength(9)
    expect(mutatingLines.filter((l) => l === 'GRANT')).toHaveLength(3)
    expect(supabaseAdminSegment).toMatch(/^GRANT uellix_owner {2}TO uellix_migrator/m)
    expect(supabaseAdminSegment).toMatch(/^GRANT uellix_writer TO uellix_app/m)
    expect(supabaseAdminSegment).toMatch(/^GRANT USAGE ON SCHEMA auth TO uellix_owner;$/m)
  })

  it('exactly two mutating statements follow the postgres reconnection: the public-schema ACL only', () => {
    const connectMatches = [...src.matchAll(/^\\connect - (\S+)$/gm)]
    const postgresSegment = src.slice(connectMatches[1].index! + connectMatches[1][0].length)
    const mutatingLines = postgresSegment.match(/^(GRANT|REVOKE|CREATE ROLE|ALTER ROLE|CREATE SCHEMA|DROP)\b/gm) ?? []
    expect(mutatingLines).toEqual(['GRANT', 'REVOKE'])
    expect(postgresSegment).toMatch(/^GRANT USAGE, CREATE ON SCHEMA public TO uellix_owner;$/m)
    expect(postgresSegment).toMatch(/^REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor, PUBLIC;$/m)
  })

  it('no mutating statement precedes the first reconnection (the connecting identity performs no privilege write of its own)', () => {
    const connectIndex = src.search(/^\\connect - /m)
    const beforeConnect = src.slice(0, connectIndex)
    const mutatingLines = beforeConnect.match(/^(GRANT|REVOKE|CREATE ROLE|ALTER ROLE|CREATE SCHEMA|DROP)\b/gm) ?? []
    expect(mutatingLines).toEqual([])
  })
})

const REAL_DOCKER = process.env.P1A_GATE_REAL_DOCKER_TESTS === '1'

// PLATFORM NOTE, measured directly this session on Windows (win32): Node's
// child_process `.kill('SIGTERM')` (and `'SIGINT'`) on Windows calls
// TerminateProcess() — an unconditional forced termination that a child
// process's `process.on('SIGTERM', ...)` handler never observes (confirmed
// with a minimal isolated repro: the child exits with `code=null,
// signal='SIGTERM'` and never reaches its own handler, for BOTH SIGTERM and
// SIGINT). Windows has no POSIX signal delivery at all; this is a Node/OS
// platform limitation, not a defect in scripts/p1a-bootstrap-gate.ts's
// signal handling, which is ordinary, portable `process.on(...)`. This test
// is therefore validated by the REAL target CI environment
// (.github/workflows/p1a-bootstrap-gate.yml, ubuntu-latest — genuine POSIX
// signals) rather than by this Windows development session. The test itself
// is NOT weakened, mocked, or platform-branched to fake a pass here — it
// asserts the real, portable contract and will correctly fail on any
// platform (Windows included) where the signal was not actually delivered.
describe.skipIf(!REAL_DOCKER)('P1A-N5 — a REAL SIGTERM during the credential window restores env exactly (real Docker; P1A_GATE_REAL_DOCKER_TESTS=1)', () => {
  it(
    'SIGTERM delivered right after credential rotation results in exact env restoration and zero leftover containers',
    async () => {
      for (const p of ENV_FILES) {
        expect(existsSync(p), `${p} must be absent before this test starts`).toBe(false)
      }

      const child = spawn('node', ['--import', 'tsx', 'scripts/p1a-bootstrap-gate.ts', 'sigterm-probe'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdoutBuf = ''
      let sawReady = false
      const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error('timed out waiting for P1A_SIGTERM_PROBE_READY')), 60000)
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8')
          if (!sawReady && stdoutBuf.includes('P1A_SIGTERM_PROBE_READY')) {
            sawReady = true
            clearTimeout(timeout)
            resolveReady()
          }
        })
        child.on('exit', () => {
          if (!sawReady) {
            clearTimeout(timeout)
            rejectReady(new Error(`probe exited before signalling ready; stdout so far:\n${stdoutBuf}`))
          }
        })
      })

      await readyPromise

      // Real signal, real process, real env files — not a mock.
      child.kill('SIGTERM')

      const exitPromise = new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code))
      })
      await exitPromise

      for (const p of ENV_FILES) {
        expect(existsSync(p), `${p} must be restored to absent after SIGTERM restoration`).toBe(false)
      }

      const leftover = spawnSync('docker', ['ps', '-a', '--filter', 'name=uellix-p1a-bootstrap-gate-SIGTERM-PROBE', '--format', '{{.Names}}'], { encoding: 'utf8' })
      const leftoverNames = (leftover.stdout ?? '').trim()
      expect(leftoverNames, `expected zero leftover SIGTERM-PROBE containers, found: ${leftoverNames}`).toBe('')
    },
    90000,
  )
})

// ---------------------------------------------------------------------------
// R3.4 runner — import safety and CLI invariants (cheap, no Docker).
// P1A_FULL_BOOTSTRAP_AUTHORITY_AMENDMENT_v1.0.1.json D2/D3: plan:local must
// stay env-free and DB-free; the pre-mutation preflight lives on the apply
// path only; importing the module for testing must not execute main().
// ---------------------------------------------------------------------------

const RUNNER_PATH = path.join(REPO_ROOT, 'scripts', 'stella-r3-4-local-runner.ts')

describe('R3.4 runner — import-safe, plan is env/DB-free, CLI unchanged (cheap, no Docker)', () => {
  it('importing the module does NOT execute main(): no argv parse, no exitCode side effect, preflight is exported', () => {
    // MEASURED (CI, ubuntu): with package type=commonjs, tsx emits the runner as
    // CJS there and the named export is reachable only through `default` from a
    // CJS `-e` context, while on Windows it surfaced on the namespace directly.
    // The witness resolves both so the check is platform-independent; the
    // load-bearing fact is exitCode=undefined (main() did not run).
    const script = `import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)}).then((m) => { const f = m.runR3_4PreMutationPreflight ?? (m.default && m.default.runR3_4PreMutationPreflight); console.log('IMPORT_OK exitCode=' + process.exitCode + ' preflight=' + typeof f) })`
    const r = spawnSync('node', ['--import', 'tsx', '-e', script], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('IMPORT_OK exitCode=undefined preflight=function')
    expect(r.stdout + r.stderr).not.toMatch(/\[r3\.4\] failed/)
  })

  it('plan:local reads no env and opens no database: succeeds with every UELLIX_*/PG* variable stripped and no governed env file present', () => {
    for (const p of ENV_FILES) expect(existsSync(p), `${p} must be absent`).toBe(false)
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('UELLIX_') && !k.startsWith('PG'))) as NodeJS.ProcessEnv
    const r = spawnSync('node', ['--import', 'tsx', RUNNER_PATH, 'plan'], { cwd: REPO_ROOT, encoding: 'utf8', env })
    expect(r.status).toBe(0)
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('[r3.4] '))
    expect(lines).toHaveLength(R3_4_LOCAL_PHASES.length)
    for (const phase of R3_4_LOCAL_PHASES) expect(r.stdout).toContain(`file=${phase.file} sha256=`)
    expect(r.stdout + r.stderr).not.toMatch(/preflight|UELLIX_LOCAL_ADMIN_DATABASE_URL|\.env\.migration\.local/)
  })

  it('apply without the governed env file fails closed BEFORE the preflight and before any connection', () => {
    for (const p of ENV_FILES) expect(existsSync(p), `${p} must be absent`).toBe(false)
    const r = spawnSync('node', ['--import', 'tsx', RUNNER_PATH, 'apply'], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/Missing \.env\.migration\.local/)
    expect(r.stdout + r.stderr).not.toMatch(/preflight/)
  })

  it('the preflight is wired on the apply path only, before the phase loop, on its own closed connection', () => {
    const src = readFileSync(RUNNER_PATH, 'utf8')
    const main = src.slice(src.indexOf('async function main('))
    const planReturn = main.indexOf('printPlan()')
    const preflight = main.indexOf('runR3_4PreMutationPreflight(preflightClient.sql)')
    const loop = main.indexOf('for (const phase of R3_4_LOCAL_PHASES)')
    expect(planReturn).toBeGreaterThan(-1)
    expect(preflight).toBeGreaterThan(planReturn)
    expect(loop).toBeGreaterThan(preflight)
    expect(main).toMatch(/await preflightClient\.close\(\)/)
    expect(src).toMatch(/if \(isDirectExecution\(\)\) \{\s*void main\(\)/)
  })
})

// ---------------------------------------------------------------------------
// P1A-M1 — M2 MINIMAL_EXPORT_WIDENING regression control (cheap, no Docker).
// docs/ops/p1a/P1A_FULL_BOOTSTRAP_TEST_MANIFEST_v1.0.0.json recorded
// test_file=UNKNOWN; this is the implemented witness.
//
// BASELINE PROVENANCE (never rebaselined): the record-id inventory below was
// extracted from the IMMUTABLE predecessor object
//   integration/commercial-v1 @ 696243f702f0feab155b1bd7411bb211f50f5a89
//   scripts/m2-disposable-pg-bootstrap.ts blob 70a52b0ea3a729493e676d3f2081559a52b6875b
// i.e. the script BEFORE the export widening, with exactly the extractor
// used here. The runtime witness for the same predecessor (M2 Real
// PostgreSQL Gate, CI run 33827389877 on that blob) is OVERALL=PASS
// (252/252 checks) — recorded in docs/ops/p1a/P1A_FULL_BOOTSTRAP_EVIDENCE_v1.0.0.json.
// ---------------------------------------------------------------------------

const M2_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'm2-disposable-pg-bootstrap.ts')
const M2_PREDECESSOR_RECORD_SITES = 79
const M2_PREDECESSOR_RECORD_IDS: readonly string[] = [
  '${id}:INJECT-UNAUTHORIZED-ESCALATION',
  '${id}:REGRANT-CREATEROLE',
  '${id}:ROTATE-FOR-NEGATIVE-PROBE',
  '${labelPrefix}:ENV-RESTORE-EXCEPTION-SAFE',
  '${label}:${snap.path.split(/[\\\\/]/).pop()}',
  '${phase}:${id}',
  '${phase}:0061-APPLIED',
  '${phase}:0061-FUNCTIONS-OWNED-BY-OWNER',
  '${phase}:APPLY-ROLE-IDENTITY',
  '${phase}:CONTAINER-CREATE',
  '${phase}:CONTAINER-READY',
  '${phase}:CREATEROLE-AFTER',
  '${phase}:CREATEROLE-BEFORE',
  '${phase}:DATABASE-CREATE-REVOKED-VERIFIED',
  '${phase}:DRIZZLE-MIGRATIONS-TABLE-OWNED-BY-OWNER',
  '${phase}:DRIZZLE-SCHEMA-OWNED-BY-OWNER',
  '${phase}:FINAL-CONTRACT-MIGRATOR',
  '${phase}:FINAL-CONTRACT-OTHERS',
  '${phase}:FINAL-CONTRACT-OWNER',
  '${phase}:FINAL-PRIVILEGE-CONTRACT',
  '${phase}:M2-TEST-EXECUTION',
  '${phase}:MIGRATE',
  '${phase}:MIGRATION-CORPUS-PROOF',
  '${phase}:MIGRATION-JOURNAL-COUNT',
  '${phase}:MOUNT-CHECK',
  '${phase}:NARROWING-SURVIVES-ROTATION',
  '${phase}:PLATFORM-READINESS',
  '${phase}:PORT-BOUND-CHECK',
  '${phase}:PORT-FREE-AFTER-TEARDOWN',
  '${phase}:PORT-PRECHECK',
  '${phase}:PRISTINE-STATE-ASSERTION',
  '${phase}:PRIV-P1-DATABASE-CREATE',
  '${phase}:PRIV-P2-PUBLIC-USAGE-CREATE',
  '${phase}:PRIV-P3-AUTH-USAGE',
  '${phase}:PRIV-P4-MIGRATOR-NOT-OVERPRIVILEGED',
  '${phase}:PRIV-P5-OWNER-MEMBERSHIP',
  '${phase}:PRIV-P6-OWNERSHIP-POSTCONDITION',
  '${phase}:PRIV-P7',
  '${phase}:ROLE-NARROWING',
  '${phase}:ROTATE-CREDENTIALS',
  '${phase}:STEP3-DATABASE-CREATE-GRANT',
  '${phase}:STEP4-PUBLIC-CREATE-GRANT',
  '${phase}:STEP5-AUTH-USAGE-GRANT',
  '${phase}:STEP6-PART-A-APPLIED',
  '${phase}:STEP9-DATABASE-CREATE-REVOKE',
  '${phase}:SUPABASE-ADMIN-SINGLE-WRITE-INVARIANT',
  '${phase}:TEARDOWN',
  '${p}:GAP-PROOF',
  '${p}:STEP3-VARIANT-GRANT-TO-MIGRATOR-ONLY',
  'FINAL:LABELLED-LEFTOVER-COUNT',
  'SELFTEST:ANSI-N1',
  'SELFTEST:ANSI-N2',
  'SELFTEST:ANSI-N3',
  'SELFTEST:ANSI-P1',
  'SELFTEST:ANSI-P2',
  'SELFTEST:ENV-N2-INJECTED-THROW-RESTORE',
  'SELFTEST:MIG-N1',
  'SELFTEST:MIG-P1',
  'SELFTEST:MIG-P2-P3-POSITIVE',
  'SELFTEST:READY-N1',
  'SELFTEST:READY-N2',
  'SELFTEST:READY-N3',
  'SELFTEST:READY-N4',
  'SELFTEST:READY-N5',
  'SELFTEST:READY-P1',
  'SELFTEST:READY-P2',
  'SELFTEST:READY-P3',
  'SELFTEST:READY-P4',
  'UNEXPECTED-ERROR',
]

/** Static record-id inventory: every `record('...'` / `record(\`...\`` first argument. */
function extractM2RecordIds(src: string): string[] {
  const ids = new Set<string>()
  const re = /record\(\s*(?:'([^']+)'|`([^`]+)`)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) ids.add(m[1] !== undefined ? m[1] : m[2])
  return [...ids].sort()
}
function countM2RecordSites(src: string): number {
  return (src.match(/\brecord\(/g) ?? []).length
}
function m2InventoryMatches(src: string, expectedIds: readonly string[], expectedSites: number): boolean {
  const ids = extractM2RecordIds(src)
  const exp = [...expectedIds].sort()
  return ids.length === exp.length && ids.every((v, i) => v === exp[i]) && countM2RecordSites(src) === expectedSites
}

describe('P1A-M1 — after MINIMAL_EXPORT_WIDENING, scripts/m2-disposable-pg-bootstrap.ts keeps the IDENTICAL check-id set and record-site count as the immutable predecessor (cheap, no Docker)', () => {
  const src = readFileSync(M2_SCRIPT_PATH, 'utf8')

  it('identical check-id SET: every predecessor id present, nothing added, nothing removed', () => {
    const ids = extractM2RecordIds(src)
    const expected = [...M2_PREDECESSOR_RECORD_IDS].sort()
    expect(ids.filter((x) => !expected.includes(x)), 'ids ADDED by the widening').toEqual([])
    expect(expected.filter((x) => !ids.includes(x)), 'ids REMOVED by the widening').toEqual([])
    expect(ids).toEqual(expected)
  })

  it('identical record-site COUNT: exactly the predecessor number of record() call sites', () => {
    expect(countM2RecordSites(src)).toBe(M2_PREDECESSOR_RECORD_SITES)
  })

  it('the widening is export-only: no non-export, non-comment line of the predecessor was changed (diff reduces to `export ` prefixes)', () => {
    // Every line that is not an `export`-prefixed declaration must exist in
    // the same form as before; we approximate by requiring that stripping
    // the `export ` keyword yields a script whose record inventory and site
    // count are unchanged — i.e. the widening added no record() and no
    // control flow.
    const stripped = src.replace(/^export (const|function|async function|interface|type) /gm, '$1 ')
    expect(m2InventoryMatches(stripped, M2_PREDECESSOR_RECORD_IDS, M2_PREDECESSOR_RECORD_SITES)).toBe(true)
  })

  it('MUTATION CONTROL (non-vacuous): a removed id, an added id, or a changed site count is DETECTED — never a rebaseline', () => {
    expect(m2InventoryMatches(src, M2_PREDECESSOR_RECORD_IDS, M2_PREDECESSOR_RECORD_SITES)).toBe(true)
    expect(m2InventoryMatches(src, M2_PREDECESSOR_RECORD_IDS.filter((x) => x !== 'SELFTEST:READY-P1'), M2_PREDECESSOR_RECORD_SITES)).toBe(false)
    expect(m2InventoryMatches(src, [...M2_PREDECESSOR_RECORD_IDS, 'SELFTEST:INVENTED-ID'], M2_PREDECESSOR_RECORD_SITES)).toBe(false)
    expect(m2InventoryMatches(src, M2_PREDECESSOR_RECORD_IDS, M2_PREDECESSOR_RECORD_SITES + 1)).toBe(false)
    const mutatedSrc = src + "\nrecord('SELFTEST:INJECTED-EXTRA', true)\n"
    expect(m2InventoryMatches(mutatedSrc, M2_PREDECESSOR_RECORD_IDS, M2_PREDECESSOR_RECORD_SITES)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Durable adversarial witnesses — real Docker, P1A_GATE_REAL_DOCKER_TESTS=1.
// These replace an ephemeral probe that was previously run once and deleted;
// every claim below is now re-provable by anyone with Docker.
//
// PORT: a fixed port distinct from LOCAL_DB_PORT (56322) so these tests can
// never collide with the canonical gate's own container, and can never be
// mistaken for it.
// ---------------------------------------------------------------------------

const WITNESS_PORT = 56399
const N7_APPNAME = 'p1a-n7-witness'

interface WitnessContainer { name: string }

function sh(cmd: string, args: string[], input?: string) {
  return spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
}

function witnessPsql(c: WitnessContainer, role: string, sql: string, extraEnv: Record<string, string> = {}) {
  const envArgs = Object.entries(extraEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  return sh('docker', ['exec', '-i', ...envArgs, c.name, 'psql', '-h', '127.0.0.1', '-U', role, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-tA'], sql)
}

async function startWitnessContainer(label: string): Promise<WitnessContainer> {
  const name = `uellix-p1a-witness-${label}-${Math.random().toString(16).slice(2, 10)}`
  const run = sh('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${WITNESS_PORT}:5432`, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=postgres', IMAGE])
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const c = { name }
  // Semantic readiness, not just pg_isready: the Supabase image creates the
  // auth/storage/extensions schemas asynchronously after accepting
  // connections; two consecutive successes, as the gate itself requires.
  let ok = 0
  for (let i = 0; i < 60 && ok < 2; i++) {
    const r = witnessPsql(c, 'postgres', "SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','storage','extensions') HAVING count(*) = 3;")
    if (r.status === 0 && /1/.test(r.stdout)) ok++
    else { ok = 0; await new Promise((res) => setTimeout(res, 2000)) }
  }
  if (ok < 2) { sh('docker', ['rm', '-f', name]); throw new Error('witness container never reached semantic readiness') }
  return c
}

function stopWitnessContainer(c: WitnessContainer | undefined): void {
  if (c) sh('docker', ['rm', '-f', c.name])
}

function applyLocalIdentity(c: WitnessContainer, sqlOverride?: string, extraEnv: Record<string, string> = {}) {
  const sql = sqlOverride ?? readFileSync(LOCAL_ROLE_IDENTITY_PATH, 'utf8')
  return witnessPsql(c, 'postgres', `SET uellix.bootstrap_environment = 'local';\n${sql}`, extraEnv)
}

function witnessClient() {
  return postgres(`postgresql://postgres:postgres@127.0.0.1:${WITNESS_PORT}/postgres`, { max: 1 })
}

async function expectPreflightThrows(sql: ReturnType<typeof witnessClient>, pattern: RegExp): Promise<string> {
  let message = ''
  try {
    await runR3_4PreMutationPreflight(sql)
  } catch (e) {
    message = (e as Error).message
  }
  expect(message, 'preflight was expected to THROW').not.toBe('')
  expect(message).toMatch(pattern)
  return message
}

describe.skipIf(!REAL_DOCKER)('P1A durable witnesses — R3.4 preflight negatives, RR-02, N7 runtime, membership C (real Docker; P1A_GATE_REAL_DOCKER_TESTS=1)', () => {
  it(
    'R3.4 preflight: PASS on the corrected topology; THROWS on each injected regression — missing public CREATE (fact 4), missing auth USAGE (fact 5), admin_option (fact 3), wrong grantor (fact 2), missing role (fact 1)',
    async () => {
      let c: WitnessContainer | undefined
      let sql: ReturnType<typeof witnessClient> | undefined
      try {
        c = await startWitnessContainer('r34')
        const applied = applyLocalIdentity(c)
        expect(applied.status, applied.stderr).toBe(0)
        sql = witnessClient()

        // POSITIVE
        await expect(runR3_4PreMutationPreflight(sql)).resolves.toBeUndefined()

        // fact 4 — public CREATE absent (postgres holds owner-level rights on public via database ownership)
        expect(witnessPsql(c, 'postgres', 'REVOKE CREATE ON SCHEMA public FROM uellix_owner;').status).toBe(0)
        await expectPreflightThrows(sql, /R3\.4 preflight FAILED \(fact 4\).*lacks CREATE on schema public/)
        expect(witnessPsql(c, 'postgres', 'GRANT CREATE ON SCHEMA public TO uellix_owner;').status).toBe(0)
        await expect(runR3_4PreMutationPreflight(sql)).resolves.toBeUndefined()

        // fact 5 — auth USAGE absent (only supabase_admin, the auth owner, can revoke it)
        expect(witnessPsql(c, 'supabase_admin', 'REVOKE USAGE ON SCHEMA auth FROM uellix_owner;').status).toBe(0)
        await expectPreflightThrows(sql, /R3\.4 preflight FAILED \(fact 5\).*lacks USAGE on schema auth/)
        expect(witnessPsql(c, 'supabase_admin', 'GRANT USAGE ON SCHEMA auth TO uellix_owner;').status).toBe(0)
        await expect(runR3_4PreMutationPreflight(sql)).resolves.toBeUndefined()

        // fact 3 — admin_option=true on a relevant row (grantor still oid 10)
        expect(witnessPsql(c, 'supabase_admin', 'REVOKE uellix_writer FROM uellix_app; GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE, ADMIN TRUE;').status).toBe(0)
        const m3 = await expectPreflightThrows(sql, /R3\.4 preflight FAILED \(facts 2\/3\)/)
        expect(m3).toMatch(/uellix_app->uellix_writer granted-by=supabase_admin\(oid=10\) admin=true/)
        expect(witnessPsql(c, 'supabase_admin', 'REVOKE uellix_writer FROM uellix_app; GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;').status).toBe(0)
        await expect(runR3_4PreMutationPreflight(sql)).resolves.toBeUndefined()

        // fact 2 — wrong grantor: reproduce "membership A routed back to postgres"
        expect(witnessPsql(c, 'supabase_admin', 'GRANT uellix_owner TO postgres WITH ADMIN OPTION; REVOKE uellix_owner FROM uellix_migrator;').status).toBe(0)
        expect(witnessPsql(c, 'postgres', 'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;').status).toBe(0)
        const m2 = await expectPreflightThrows(sql, /R3\.4 preflight FAILED \(facts 2\/3\)/)
        expect(m2).toMatch(/uellix_migrator->uellix_owner granted-by=postgres\(oid=16384\)/)

        // fact 1 — a governed role missing (checked FIRST by the probe, so injected LAST)
        expect(witnessPsql(c, 'supabase_admin', 'DROP ROLE uellix_auditor;').status).toBe(0)
        await expectPreflightThrows(sql, /R3\.4 preflight FAILED \(fact 1\).*uellix_auditor/)
      } finally {
        await sql?.end()
        stopWitnessContainer(c)
      }
    },
    240000,
  )

  it(
    'RR-02 + membership C catalog: after the corrected partition, postgres holds NO membership over uellix_* and cannot reconstruct the creator/admin-option escalation; uellix_writer->postgres is absent',
    async () => {
      let c: WitnessContainer | undefined
      try {
        c = await startWitnessContainer('rr02')
        expect(applyLocalIdentity(c).status).toBe(0)

        const countPostgresRows = () =>
          witnessPsql(c!, 'postgres', "SELECT count(*) FROM pg_auth_members a JOIN pg_roles m ON m.oid=a.member JOIN pg_roles r ON r.oid=a.roleid WHERE m.rolname='postgres' AND r.rolname LIKE 'uellix\\_%';").stdout.trim()

        // Membership C absent; zero postgres memberships over governed roles.
        expect(countPostgresRows()).toBe('0')
        const cRow = witnessPsql(c, 'postgres', "SELECT count(*) FROM pg_auth_members a JOIN pg_roles m ON m.oid=a.member JOIN pg_roles r ON r.oid=a.roleid WHERE m.rolname='postgres' AND r.rolname='uellix_writer';").stdout.trim()
        expect(cRow).toBe('0')

        // RR-02 (a): postgres cannot grant itself SET on uellix_owner.
        const selfGrant = witnessPsql(c, 'postgres', 'GRANT uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE;')
        expect(selfGrant.status).not.toBe(0)
        expect(selfGrant.stderr).toMatch(/permission denied to grant role "uellix_owner"/)

        // RR-02 (b): postgres cannot SET ROLE uellix_owner.
        const setRole = witnessPsql(c, 'postgres', 'SET ROLE uellix_owner;')
        expect(setRole.status).not.toBe(0)
        expect(setRole.stderr).toMatch(/permission denied to set role "uellix_owner"/)

        // RR-02 (c): postgres cannot route the escalation through a role it DOES create.
        expect(witnessPsql(c, 'postgres', 'CREATE ROLE rr02_probe NOLOGIN;').status).toBe(0)
        const viaProbe = witnessPsql(c, 'postgres', 'GRANT uellix_owner TO rr02_probe;')
        expect(viaProbe.status).not.toBe(0)
        expect(viaProbe.stderr).toMatch(/permission denied to grant role "uellix_owner"/)

        // Catalog unchanged by every refused attempt; no SET path exists.
        expect(countPostgresRows()).toBe('0')
        expect(witnessPsql(c, 'postgres', "SELECT pg_has_role('postgres','uellix_owner','SET');").stdout.trim()).toBe('f')
        expect(witnessPsql(c, 'postgres', "SELECT pg_has_role('postgres','uellix_owner','USAGE');").stdout.trim()).toBe('f')
      } finally {
        stopWitnessContainer(c)
      }
    },
    240000,
  )

  // N7 RUNTIME — execution-level statement accounting from the PostgreSQL
  // statement log, isolated to the applying session by application_name.
  // Privilege write = GRANT/REVOKE (pg_auth_members row or object ACL).
  // CREATE ROLE / ALTER ROLE are recorded but excluded, per the amendment's
  // SUPABASE_ADMIN_PRIVILEGE_WRITE definition.
  interface N7Ledger { supabaseAdmin: string[]; postgres: string[]; supabaseAdminNonPrivilege: string[]; postgresNonPrivilege: string[] }

  function enableStatementLogging(c: WitnessContainer): void {
    // MEASURED on the pinned image: its init runs
    //   alter role supabase_admin set log_statement = none;
    // a ROLE-level GUC that overrides ALTER SYSTEM, so a witness that only
    // set the system value would count 0 supabase_admin statements and be
    // vacuous. Both actors are pinned to 'all' at role level explicitly.
    const r = witnessPsql(
      c,
      'supabase_admin',
      [
        "ALTER SYSTEM SET log_statement = 'all';",
        "ALTER ROLE supabase_admin SET log_statement = 'all';",
        "ALTER ROLE postgres SET log_statement = 'all';",
        "ALTER SYSTEM SET log_line_prefix = '%u %a ';",
        'SELECT pg_reload_conf();',
      ].join('\n'),
    )
    expect(r.status, r.stderr).toBe(0)
    // Prove the override took effect for BOTH actors before measuring.
    for (const role of ['supabase_admin', 'postgres'] as const) {
      const shown = witnessPsql(c, role, 'SHOW log_statement;')
      expect(shown.status).toBe(0)
      expect(shown.stdout.trim(), `log_statement for ${role}`).toBe('all')
    }
  }

  function readN7Ledger(c: WitnessContainer): N7Ledger {
    const logs = sh('docker', ['logs', c.name])
    const text = (logs.stdout ?? '') + (logs.stderr ?? '')
    const ledger: N7Ledger = { supabaseAdmin: [], postgres: [], supabaseAdminNonPrivilege: [], postgresNonPrivilege: [] }
    const re = new RegExp(`^(supabase_admin|postgres) ${N7_APPNAME} LOG:\\s+statement: (.*)$`, 'gm')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const user = m[1]
      const stmt = m[2].trim()
      const isPrivilegeWrite = /^(GRANT|REVOKE)\b/i.test(stmt)
      const isRoleCatalog = /^(CREATE ROLE|ALTER ROLE)\b/i.test(stmt)
      if (isPrivilegeWrite) (user === 'supabase_admin' ? ledger.supabaseAdmin : ledger.postgres).push(stmt)
      else if (isRoleCatalog) (user === 'supabase_admin' ? ledger.supabaseAdminNonPrivilege : ledger.postgresNonPrivilege).push(stmt)
    }
    return ledger
  }

  async function measureN7(label: string, sqlOverride?: string): Promise<{ applyStatus: number; applyStderr: string; ledger: N7Ledger }> {
    let c: WitnessContainer | undefined
    try {
      c = await startWitnessContainer(label)
      enableStatementLogging(c)
      const applied = applyLocalIdentity(c, sqlOverride, { PGAPPNAME: N7_APPNAME })
      return { applyStatus: applied.status ?? 1, applyStderr: applied.stderr ?? '', ledger: readN7Ledger(c) }
    } finally {
      stopWitnessContainer(c)
    }
  }

  const MEMBERSHIP_A = 'GRANT uellix_owner  TO uellix_migrator WITH INHERIT FALSE, SET TRUE,  ADMIN FALSE;'
  const MEMBERSHIP_B = 'GRANT uellix_writer TO uellix_app      WITH INHERIT TRUE,  SET FALSE, ADMIN FALSE;'
  const AUTH_GRANT = 'GRANT USAGE ON SCHEMA auth TO uellix_owner;'
  const PUBLIC_REVOKE = 'REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor, PUBLIC;'

  function moveIntoPostgresSegment(sql: string, statement: string): string {
    expect(sql).toContain(statement)
    expect(sql).toContain(PUBLIC_REVOKE)
    return sql.replace(statement, '').replace(PUBLIC_REVOKE, `${PUBLIC_REVOKE}\n${statement}`)
  }

  it(
    'N7 runtime: the applying session issues EXACTLY 3 privilege writes as supabase_admin (A, B, auth USAGE) and EXACTLY 2 as postgres (public ACL); CREATE ROLE x5 + ALTER ROLE x1 occur under supabase_admin, none under postgres',
    async () => {
      const { applyStatus, ledger } = await measureN7('n7pos')
      expect(applyStatus).toBe(0)
      expect(ledger.supabaseAdmin).toHaveLength(3)
      expect(ledger.supabaseAdmin[0]).toBe(MEMBERSHIP_A)
      expect(ledger.supabaseAdmin[1]).toBe(MEMBERSHIP_B)
      expect(ledger.supabaseAdmin[2]).toBe(AUTH_GRANT)
      expect(ledger.postgres).toHaveLength(2)
      expect(ledger.postgres[0]).toBe('GRANT USAGE, CREATE ON SCHEMA public TO uellix_owner;')
      expect(ledger.postgres[1]).toBe(PUBLIC_REVOKE)
      expect(ledger.supabaseAdminNonPrivilege.filter((s) => /^CREATE ROLE/i.test(s))).toHaveLength(5)
      expect(ledger.supabaseAdminNonPrivilege.filter((s) => /^ALTER ROLE/i.test(s))).toHaveLength(1)
      expect(ledger.postgresNonPrivilege).toEqual([])
    },
    240000,
  )

  it(
    'N7 mutation (membership A moved to postgres): the contract breaks at execution level — supabase_admin drops to 2 writes, postgres attempts the membership GRANT and PostgreSQL refuses it (no ADMIN OPTION: RR-02)',
    async () => {
      const mutated = moveIntoPostgresSegment(readFileSync(LOCAL_ROLE_IDENTITY_PATH, 'utf8'), MEMBERSHIP_A)
      const { applyStatus, applyStderr, ledger } = await measureN7('n7mutA', mutated)
      expect(ledger.supabaseAdmin).toHaveLength(2)
      expect(ledger.postgres).toContain(MEMBERSHIP_A)
      // MEASURED: the mutated package never reaches its own §6 self-verification —
      // postgres created none of the uellix_* roles, so it holds no ADMIN OPTION
      // on uellix_owner and PostgreSQL refuses the GRANT itself (RR-02 at
      // execution level). The exact server refusal is asserted, not just a
      // non-zero exit.
      expect(applyStatus).not.toBe(0)
      expect(applyStderr).toMatch(/permission denied to grant role "uellix_owner"/)
      expect(applyStderr).toMatch(/Only roles with the ADMIN option on role "uellix_owner" may grant this role\./)
    },
    240000,
  )

  it(
    'N7 mutation (auth USAGE moved to postgres): supabase_admin drops to 2 writes, postgres issues the auth GRANT as a silent no-op, and the package fails closed on the absent privilege',
    async () => {
      const mutated = moveIntoPostgresSegment(readFileSync(LOCAL_ROLE_IDENTITY_PATH, 'utf8'), AUTH_GRANT)
      const { applyStatus, applyStderr, ledger } = await measureN7('n7mutAuth', mutated)
      expect(ledger.supabaseAdmin).toHaveLength(2)
      expect(ledger.postgres).toContain(AUTH_GRANT)
      // postgres does not own schema auth: its GRANT is a WARNING no-op, and §6 catches the absent privilege by exact message.
      expect(applyStatus).not.toBe(0)
      expect(applyStderr).toMatch(/stella_local_0000 FAILED verification: uellix_owner lacks USAGE on schema auth\./)
    },
    240000,
  )

  it(
    'N7 mutation (fourth supabase_admin write = membership C injected locally): the execution ledger shows 4 — this is exactly the write the file\'s own self-verification would NOT catch, which is why the runtime ledger exists',
    async () => {
      const sql = readFileSync(LOCAL_ROLE_IDENTITY_PATH, 'utf8')
      const FOURTH = 'GRANT uellix_writer TO postgres WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;'
      expect(sql).not.toContain(FOURTH)
      const mutated = sql.replace(MEMBERSHIP_B, `${MEMBERSHIP_B}\n${FOURTH}`)
      expect(mutated).not.toBe(sql)
      const { ledger } = await measureN7('n7mut4', mutated)
      expect(ledger.supabaseAdmin).toHaveLength(4)
      expect(ledger.supabaseAdmin).toContain(FOURTH)
    },
    240000,
  )
})
