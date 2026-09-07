// tests/postgres/b4-completeness.pg.test.ts
// W2-B4 completeness — REAL PostgreSQL controls PG-POS-1/2, SEC-N1..N4,
// SEC-ACL-1, MUT-PG-1..4 (docs/ops/wave2/W2_B4_TEST_MANIFEST_v1.json,
// postgres_requirements), run through the CANONICAL disposable harness
// scripts/db-audit-disposable.ts: a throwaway postgres container on
// 127.0.0.1, ephemeral port, no bind mounts, teardown in `finally`, leftover
// check. Never staging, never production, never the canonical local stack.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently
// passed — otherwise. The setup/probe manifests are the ones
// tests/postgres/b4-completeness-harness.ts emits.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runDisposableHarness, DEFAULT_IMAGE, loadSetupManifest, loadProbeManifest, type HarnessOutcome } from '../../scripts/db-audit-disposable'
import { writeManifests } from './b4-completeness-harness'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const EXPECTED_PROBE_IDS = [
  'PG-POS-1-same-tenant-SELECT',
  'PG-POS-1-same-tenant-INSERT',
  'PG-POS-2-CHECK-vocabulary-baseline_availability',
  'PG-POS-2-CHECK-vocabulary-basis_kind',
  'PG-POS-2-CHECK-vocabulary-deadweight_support_state',
  'PG-POS-2-CHECK-vocabulary-basis_type',
  'PG-POS-2-CHECK-vocabulary-materiality_flag',
  'SEC-N1-cross-tenant-SELECT-methodological_assumptions',
  'SEC-N1-cross-tenant-SELECT-assumption_object_links',
  'SEC-N1-cross-tenant-SELECT-counterfactual_assessments',
  'SEC-N2-cross-tenant-INSERT-methodological_assumptions',
  'SEC-N2-cross-tenant-INSERT-assumption_object_links',
  'SEC-N2-cross-tenant-INSERT-counterfactual_assessments',
  'SEC-N3-cross-tenant-UPDATE-methodological_assumptions',
  'SEC-N3-cross-tenant-UPDATE-counterfactual_assessments',
  'SEC-N3-assumption_object_links-has-no-UPDATE-policy-at-all',
  'SEC-N4-no-new-function-surface-VACUOUS-BY-ABSENCE',
  'SEC-ACL-1-RLS-enabled-and-policies-exist-per-table',
  'MUT-PG-1-SELECT-policy-removal-caught-methodological_assumptions',
  'MUT-PG-1-SELECT-policy-removal-caught-assumption_object_links',
  'MUT-PG-1-SELECT-policy-removal-caught-counterfactual_assessments',
  'MUT-PG-2-CHECK-removal-caught-baseline_availability',
  'MUT-PG-2-CHECK-removal-caught-basis_kind',
  'MUT-PG-2-CHECK-removal-caught-deadweight_support_state',
  'MUT-PG-2-CHECK-removal-caught-basis_type',
  'MUT-PG-2-CHECK-removal-caught-materiality_flag',
  'MUT-PG-3-conditional-NOT-NULL-removal-caught-baseline-available-fields',
  'MUT-PG-3-conditional-NOT-NULL-removal-caught-provenance-reference',
  'MUT-PG-4-EXECUTE-revocation-VACUOUS-BY-ABSENCE',
]

describe.skipIf(!PG_TESTS_ENABLED)('W2-B4 completeness — real PostgreSQL (canonical disposable harness)', { timeout: 900_000 }, () => {
  let outDir = ''
  let outcome: HarnessOutcome

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'uellix-b4-pg-'))
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

  it('the harness provisioned the full baseline (76 units, including 0062/0063) and tore itself down with zero leftovers', () => {
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
