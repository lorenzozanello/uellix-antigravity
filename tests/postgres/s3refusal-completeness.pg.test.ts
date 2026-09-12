// tests/postgres/s3refusal-completeness.pg.test.ts
// Multi-org S3 REFUSAL AUDIT (HPO-ODS-W2-25) — REAL PostgreSQL controls, run
// through the CANONICAL disposable harness scripts/db-audit-disposable.ts: a
// throwaway postgres container on 127.0.0.1, ephemeral port, no bind mounts,
// teardown in `finally`, leftover check. Never staging, never production,
// never the canonical local stack.
//
// WHAT A GREEN RUN HERE ACTUALLY PROVES, on a real cluster and not a mock:
//
//   * the additive policy exists BESIDE the two pre-existing ones (three, by
//     name) and RLS is still enabled on audit_logs. CL-1 (HPO-ODS-W2-28,
//     db/migrations/0070) later adds a FOURTH additive INSERT policy
//     (audit_logs_insert_legal_acceptance) beside these three, unedited —
//     SEC-ACL-1/2 below are re-measured for four total / three INSERT, and
//     this file's own write surface does not include that policy's own
//     correctness, which tests/postgres/legal-acceptance.pg.test.ts owns;
//   * all THREE authorised action/form combinations insert;
//   * `tenancy.membership.revalidation_refused` in FORM A shape is REFUSED BY
//     THE DATABASE (RA-ACTION-1) — the single row the predecessor's uncoupled
//     policy would have accepted;
//   * every reason/subject/action cross-product forgery is refused;
//   * a Form B row naming an organisation that does not exist is ACCEPTED,
//     which is what proves no existence lookup was added;
//   * an ordinary member — including a member of the organisation named in
//     entity_id — cannot read either NULL-organisation form, and a super
//     admin can, with NO change to the SELECT policy;
//   * removing the policy, gutting its action/form correlation, or widening
//     the SELECT policy each CHANGES a measured outcome (MUT-PG-1/2/3).
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). A real-PostgreSQL suite that
// silently SKIPS is indistinguishable from one that passes, so the gate self
// check below runs UNGATED and turns "skipped" into a FAILURE whenever
// UELLIX_S3_REFUSAL_PG_REQUIRED=1 — which is exactly what
// .github/workflows/s3-refusal-real-pg-gate.yml sets.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runDisposableHarness, DEFAULT_IMAGE, loadSetupManifest, loadProbeManifest, type HarnessOutcome } from '../../scripts/db-audit-disposable'
import { writeManifests } from './s3refusal-completeness-harness'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

/**
 * The frozen probe roster. Hand-listed rather than derived from the template
 * on purpose: a derived list would shrink silently with the template, so
 * deleting a probe would still show green. Deleting one here fails.
 */
const EXPECTED_PROBE_IDS = [
  'SEC-ACL-1-audit_logs-RLS-enabled-and-exactly-four-policies',
  'SEC-ACL-2-exactly-one-SELECT-policy-and-it-is-unchanged',
  'SEC-ACL-3-no-UPDATE-or-DELETE-policy-on-audit_logs',
  'PG-POS-1-selection_refused-FORM-A-accepted',
  'PG-POS-2-selection_refused-FORM-B-accepted',
  'PG-POS-3-revalidation_refused-FORM-B-accepted',
  'PG-POS-4-FORM-B-nonexistent-organization-accepted-NO-EXISTENCE-ORACLE',
  'PG-POS-5-FORM-B-own-organization-accepted-entity_id-confers-nothing',
  'RA-ACTION-1-revalidation_refused-FORM-A-REFUSED',
  'XPROD-R-N-o-revalidation_refused-FORM-A-reason-with-organization-subject-REFUSED',
  'XPROD-R-M-u-revalidation_refused-FORM-B-reason-with-user-subject-REFUSED',
  'RA-SUBJECT-5-FORM-A-carrying-organization-entity_type-REFUSED',
  'RA-SUBJECT-7-FORM-B-carrying-user-entity_type-REFUSED',
  'RA-SUBJECT-6-FORM-A-entity_id-not-auth-uid-REFUSED',
  'INV-1-organization_id-NOT-NULL-REFUSED',
  'INV-2-project_id-NOT-NULL-REFUSED',
  'INV-3-before_json-NOT-NULL-REFUSED',
  'INV-4-after_json-NOT-NULL-REFUSED',
  'INV-5-ip_address-NOT-NULL-REFUSED',
  'INV-6-user_agent-NOT-NULL-REFUSED',
  'INV-7-actor_user_id-not-auth-uid-REFUSED',
  'VOCAB-1-unauthorized-reason-REFUSED',
  'VOCAB-2-NULL-reason-REFUSED',
  'VOCAB-3-unauthorized-action-cannot-ride-the-refusal-policy-REFUSED',
  'VOCAB-4-arbitrary-generic-event-with-NULL-organization-REFUSED',
  'GENERIC-1-sibling-policy-still-refuses-a-foreign-tenant-row',
  'GENERIC-2-sibling-policy-still-accepts-an-own-tenant-row',
  'FIXTURE-1-super-admin-principal-is-really-super-admin',
  'RA-SUBJECT-9-ordinary-member-cannot-read-either-NULL-org-refusal-form',
  'RA-SUBJECT-10-superadmin-can-read-both-NULL-org-refusal-forms',
  'MUT-PG-1-refusal-policy-removal-is-caught',
  'MUT-PG-2-dropping-the-action-form-correlation-is-caught',
  'MUT-PG-3-widening-the-SELECT-policy-is-caught',
]

// UNGATED. Runs whether or not Docker is present, because its whole job is to
// make a SKIPPED real-PostgreSQL suite observable.
describe('real-PostgreSQL gate self-check (never skipped)', () => {
  it('is not silently skipped when the governed gate demands it, and the roster is non-empty', () => {
    if (process.env.UELLIX_S3_REFUSAL_PG_REQUIRED === '1') {
      expect(
        PG_TESTS_ENABLED,
        'UELLIX_S3_REFUSAL_PG_REQUIRED=1 but UELLIX_PG_TESTS is not 1: the real-PostgreSQL ' +
          'refusal contract would have been skipped, and a skipped suite is not evidence.',
      ).toBe(true)
    }
    expect(EXPECTED_PROBE_IDS.length).toBeGreaterThan(0)
    expect(new Set(EXPECTED_PROBE_IDS).size).toBe(EXPECTED_PROBE_IDS.length)
  })
})

describe.skipIf(!PG_TESTS_ENABLED)('S3 refusal audit — real PostgreSQL (canonical disposable harness)', { timeout: 900_000 }, () => {
  let outDir = ''
  let outcome: HarnessOutcome

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'uellix-s3refusal-pg-'))
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

  it('the harness provisioned the full baseline (including 0067) and tore itself down with zero leftovers', () => {
    expect(outcome.setupStatus).toBe('SUCCESS')
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
})
