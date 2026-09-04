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
import {
  deriveExpectedMigrationCorpus,
  evaluateMigrationProof,
  withEnvRestore,
} from '../scripts/m2-disposable-pg-bootstrap'

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
