// tests/postgres/b5-completeness.pg.test.ts
// W2-B5 completeness — REAL PostgreSQL controls PG-POS-1/2/3, SEC-N1..N4,
// SEC-ACL-1, MUT-PG-1..4, run through the CANONICAL disposable harness
// scripts/db-audit-disposable.ts: a throwaway postgres container on
// 127.0.0.1, ephemeral port, no bind mounts, teardown in `finally`, leftover
// check. Never staging, never production, never the canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise. The setup/probe manifests are the ones
// tests/postgres/b5-completeness-harness.ts emits.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runDisposableHarness, DEFAULT_IMAGE, loadSetupManifest, loadProbeManifest, type HarnessOutcome } from '../../scripts/db-audit-disposable'
import { writeManifests } from './b5-completeness-harness'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const EXPECTED_PROBE_IDS = [
  'PG-POS-1-same-tenant-SELECT',
  'PG-POS-1-same-tenant-INSERT',
  'PG-POS-2-CHECK-range-global_score',
  'PG-POS-2-CHECK-vocabulary-band',
  'PG-POS-2-CHECK-vocabulary-candidate_kind',
  'PG-POS-2-CHECK-vocabulary-disposition',
  'PG-POS-2-CHECK-vocabulary-scenario_kind',
  'PG-POS-3-same-tenant-UPDATE-sensitivity_candidates',
  'SEC-N1-cross-tenant-SELECT-readiness_assessments',
  'SEC-N1-cross-tenant-SELECT-sensitivity_candidates',
  'SEC-N1-cross-tenant-SELECT-sensitivity_scenarios',
  'SEC-N2-cross-tenant-INSERT-readiness_assessments',
  'SEC-N2-cross-tenant-INSERT-sensitivity_candidates',
  'SEC-N2-cross-tenant-INSERT-sensitivity_scenarios',
  'SEC-N3-cross-tenant-UPDATE-sensitivity_candidates',
  'SEC-N3-readiness_assessments-has-no-UPDATE-policy-at-all',
  'SEC-N3-sensitivity_scenarios-has-no-UPDATE-policy-at-all',
  'SEC-N4-no-new-function-surface-VACUOUS-BY-ABSENCE',
  'SEC-ACL-1-RLS-enabled-and-policies-exist-per-table',
  'MUT-PG-1-SELECT-policy-removal-caught-readiness_assessments',
  'MUT-PG-1-SELECT-policy-removal-caught-sensitivity_candidates',
  'MUT-PG-1-SELECT-policy-removal-caught-sensitivity_scenarios',
  'MUT-PG-1-UPDATE-policy-removal-caught-sensitivity_candidates',
  'MUT-PG-2-CHECK-removal-caught-global_score',
  'MUT-PG-2-CHECK-removal-caught-band',
  'MUT-PG-2-CHECK-removal-caught-candidate_kind',
  'MUT-PG-2-CHECK-removal-caught-disposition',
  'MUT-PG-2-CHECK-removal-caught-scenario_kind',
  'MUT-PG-3-conditional-NOT-NULL-removal-caught-rationale',
  'MUT-PG-3-conditional-NOT-NULL-removal-caught-combination_description',
  'MUT-PG-4-EXECUTE-revocation-VACUOUS-BY-ABSENCE',
]

describe.skipIf(!PG_TESTS_ENABLED)('W2-B5 completeness — real PostgreSQL (canonical disposable harness)', { timeout: 900_000 }, () => {
  let outDir = ''
  let outcome: HarnessOutcome

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'uellix-b5-pg-'))
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

  it('the harness provisioned the full baseline (78 units, including 0064/0065) and tore itself down with zero leftovers', () => {
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
