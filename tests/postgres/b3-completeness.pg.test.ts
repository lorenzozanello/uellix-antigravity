// tests/postgres/b3-completeness.pg.test.ts
// W2-B3 completeness — REAL PostgreSQL controls PG-1..PG-16 + MUT-PG-1..3
// (docs/ops/wave2/W2_B3_TEST_MANIFEST_v2.json, postgres_requirements), run
// through the CANONICAL disposable harness scripts/db-audit-disposable.ts
// (AG-B3-5): a throwaway postgres container on 127.0.0.1, ephemeral port, no
// bind mounts, teardown in `finally`, leftover check. Never staging, never
// production, never the canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise. The setup/probe manifests are the ones
// tests/postgres/b3-completeness-harness.ts emits (so this file, the CLI
// path `pnpm db:audit:disposable -- --setup … --probe …`, and audit:batch's
// --postgres-manifest all exercise the same bytes).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runDisposableHarness, DEFAULT_IMAGE, loadSetupManifest, loadProbeManifest, type HarnessOutcome } from '../../scripts/db-audit-disposable'
import { writeManifests } from './b3-completeness-harness'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const EXPECTED_PROBE_IDS = [
  'PG-1-0057-applied',
  'PG-2-0058-applied',
  'PG-3-0059-applied',
  'PG-4-materiality-vocabulary-CHECK',
  'PG-5-materiality-pair-CHECK',
  'PG-6-disposition-reason-vocabulary-CHECK',
  'PG-7-not_monetized-requires-reason',
  'PG-8-reason-requires-justification',
  'PG-9-unique-outcome-run',
  'PG-10-RLS-SELECT-same-and-cross-tenant',
  'PG-11-RLS-INSERT-created_by-auth-role',
  'PG-12-preapproved-UPDATE-runtime-identity-after-0060',
  'PG-13-DELETE-runtime-denied-owner-allowed-preapproved',
  'PG-14-approved-run-immutability-DB-level',
  'PG-14b-advisory-lock-protocol-measured-in-pg_locks',
  'PG-14c-TOCTOU-closed-two-sessions-dblink',
  'PG-15-successor-rollback-reapply-safety',
  'PG-16-manifest-reconciliation-against-applied-state',
  'MUT-PG-1-UPDATE-policy-removal-caught',
  'MUT-PG-2-approved-guard-removal-caught',
  'MUT-PG-3-cross-tenant-predicate-removal-caught',
]

describe.skipIf(!PG_TESTS_ENABLED)('W2-B3 completeness — real PostgreSQL (canonical disposable harness)', { timeout: 900_000 }, () => {
  let outDir = ''
  let outcome: HarnessOutcome

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'uellix-b3-pg-'))
    const { setupPath, probePath } = writeManifests(outDir)
    outcome = runDisposableHarness({
      image: DEFAULT_IMAGE,
      setup: loadSetupManifest(setupPath),
      probe: loadProbeManifest(probePath),
    })
  }, 900_000)

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  it('the harness provisioned the full baseline (0000..0060) and tore itself down with zero leftovers', () => {
    expect(outcome.setupStatus).toBe('SUCCESS')
    expect(outcome.teardownStatus).toBe('SUCCESS')
    expect(outcome.leftoverDatabaseCount).toBe(0)
    expect(outcome.lifecycleState).toBe('VERIFIED_GONE')
    expect(outcome.targetLocality).toBe('LOCAL')
  })

  it('ran every frozen probe, in the frozen order', () => {
    expect(outcome.probeResults.map((p) => p.id)).toEqual(EXPECTED_PROBE_IDS)
  })

  it.each(EXPECTED_PROBE_IDS)('%s', (id) => {
    const probe = outcome.probeResults.find((p) => p.id === id)
    expect(probe, `probe ${id} did not run`).toBeDefined()
    expect(probe!.detail ?? '').toBe('')
    expect(probe!.ok).toBe(true)
  })

  it('POSTGRES_FAILURES=0 (harness verdict)', () => {
    expect(outcome.probeFailureCount).toBe(0)
    expect(outcome.harnessStatus).toBe('SUCCESS')
  })
})
