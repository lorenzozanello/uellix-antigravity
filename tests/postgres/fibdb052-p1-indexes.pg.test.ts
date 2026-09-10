// tests/postgres/fibdb052-p1-indexes.pg.test.ts
// FIBDB-052 P1 (FIBDB052_P1_EXECUTION_AUTHORITY_v1.0.0.json, HPO-FIBP1-02) —
// REAL PostgreSQL controls over the eight governed indexes, run through the
// CANONICAL disposable harness scripts/db-audit-disposable.ts: a throwaway
// postgres container on 127.0.0.1, ephemeral port, no bind mounts, teardown in
// `finally`, leftover check. NEVER staging, NEVER production, NEVER the
// canonical local Supabase stack (DEPLOYMENT_BOUNDARY).
//
// WHAT A GREEN RUN HERE ACTUALLY PROVES, on a real cluster and not a mock:
//
//   * each of the eight governed indexes EXISTS under exactly its governed
//     name, on exactly its governed relation, with exactly its key columns in
//     exactly their key ORDER (read from pg_index.indkey WITH ORDINALITY, so a
//     reversed pair is caught — which is the entire reason I-6/I-7/I-8 exist);
//   * the three partial indexes carry a real pg_index.indpred and the five
//     non-partial ones carry NONE;
//   * every one is btree and indisvalid;
//   * NEGATIVES the migration text alone cannot establish: no retired name
//     resolves to any object, the four verification-only objects were not
//     duplicated, no GIN or other non-btree index appeared on a P1 relation,
//     and exactly eight governed names exist — no ninth;
//   * F-A1: the three subsumed single-column prefix indexes are STILL PRESENT.
//     The redundancy is recorded; the cleanup is NOT authorized, so their
//     ABSENCE is a failure here.
//
// The unit reaches the cluster only because db/hosted/baseline-manifest.ts
// claims it and the harness applies every manifest unit in order. It is never
// spliced in by hand, so a green run is ALSO evidence that 0069 is registered.
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). A real-PostgreSQL suite that
// silently SKIPS is indistinguishable from one that passes, so the gate self
// check below runs UNGATED and turns "skipped" into a FAILURE whenever
// UELLIX_FIBDB052_P1_PG_REQUIRED=1.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  runDisposableHarness,
  DEFAULT_IMAGE,
  loadSetupManifest,
  loadProbeManifest,
  type HarnessOutcome,
} from '../../scripts/db-audit-disposable'
import { writeManifests, PROBES_TEMPLATE } from './fibdb052-p1-indexes-harness'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/**
 * The frozen probe roster. Hand-listed rather than derived from the template on
 * purpose: a derived list would shrink silently with the template, so deleting
 * a probe would still show green. Deleting one here fails.
 */
const EXPECTED_PROBE_IDS = [
  'IDX-I-3-idx_evidence_versions_evidence_id_approved-exact',
  'IDX-I-5-idx_financial_proxy_versions_financial_proxy_id_approved-exact',
  'IDX-I-6-idx_outcome_monetization_dispositions_run_id_outcome_id-exact',
  'IDX-I-7-idx_evidence_sufficiency_determinations_run_id_outcome_id-exact',
  'IDX-I-8-idx_counterfactual_assessments_run_id_outcome_id-exact',
  'IDX-I-9-idx_sensitivity_candidates_run_id_disposition-exact',
  'IDX-I-12-idx_methodological_assumptions_project_id_materiality_flag-exact',
  'IDX-I-13-idx_sroi_run_reviews_calculation_run_id_approved-exact',
  'NEG-N1-all-three-retired-names-absent-from-the-catalog',
  'NEG-N6-subsumed-prefix-indexes-still-present-NOT-dropped',
  'NEG-N2-four-verification-only-objects-not-duplicated',
  'NEG-N4-zero-GIN-or-other-non-btree-on-the-eight-relations',
  'NEG-N8-exactly-the-eight-governed-names-present-no-ninth',
]

// UNGATED. Runs whether or not Docker is present, because its whole job is to
// make a SKIPPED real-PostgreSQL suite observable.
describe('real-PostgreSQL gate self-check (never skipped)', () => {
  it('is not silently skipped when the governed gate demands it, and the roster is non-empty', () => {
    if (process.env.UELLIX_FIBDB052_P1_PG_REQUIRED === '1') {
      expect(
        PG_TESTS_ENABLED,
        'UELLIX_FIBDB052_P1_PG_REQUIRED=1 but UELLIX_PG_TESTS is not 1: the real-PostgreSQL ' +
          'index contract would have been skipped, and a skipped suite is not evidence.',
      ).toBe(true)
    }
    expect(EXPECTED_PROBE_IDS.length).toBeGreaterThan(0)
    expect(new Set(EXPECTED_PROBE_IDS).size).toBe(EXPECTED_PROBE_IDS.length)
  })

  it('the committed probe template carries exactly the frozen roster, in the frozen order', () => {
    const template = JSON.parse(readFileSync(path.join(ROOT, PROBES_TEMPLATE), 'utf8')) as {
      probes: { id: string }[]
    }
    expect(template.probes.map((p) => p.id)).toEqual(EXPECTED_PROBE_IDS)
  })
})

describe.skipIf(!PG_TESTS_ENABLED)(
  'FIBDB-052 P1 indexes — real PostgreSQL (canonical disposable harness)',
  { timeout: 900_000 },
  () => {
    let outDir = ''
    let outcome: HarnessOutcome

    beforeAll(() => {
      outDir = mkdtempSync(path.join(tmpdir(), 'uellix-fibdb052-p1-pg-'))
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

    it('the harness provisioned the full baseline (including 0069) and tore itself down with zero leftovers', () => {
      // setupStatus is INITIALISED to 'SKIPPED' and there are seven bail-outs
      // BEFORE setup runs, each of which records a failureReason that no
      // assertion message would otherwise surface. Reporting it here is what
      // separates "the contract failed" from "the harness never started" — the
      // difference between a real defect and an environmental one.
      expect(
        outcome.setupStatus,
        `harness failureReason=${JSON.stringify(outcome.failureReason)} lifecycleState=${outcome.lifecycleState}`,
      ).toBe('SUCCESS')
      expect(outcome.teardownStatus).toBe('SUCCESS')
      expect(outcome.leftoverDatabaseCount).toBe(0)
      expect(outcome.lifecycleState).toBe('VERIFIED_GONE')
      expect(outcome.targetLocality).toBe('LOCAL')
    })

    it('ran every frozen probe, in the frozen order, and ran a NON-ZERO number of them', () => {
      expect(outcome.probeResults.length).toBeGreaterThan(0)
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
  },
)
