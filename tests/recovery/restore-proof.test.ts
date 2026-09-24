// @vitest-environment node
// tests/recovery/restore-proof.test.ts — the EVIDENCE GATE of finalizeRehearsal
// (a surviving mutant class in the recert of ec573e9b: removing the gate went
// unnoticed because nothing fed it bad evidence). Each case feeds one defect and
// requires the rehearsal to FAIL with the gate's reason.

import { describe, expect, it } from 'vitest'

import { finalizeRehearsal, type FinalizeInput, type RestoreProof } from '../../scripts/recovery/restore-proof'
import type { InvariantResult } from '../../scripts/recovery/post-restore-invariants'
import { sampleCensus, sampleCensusRecord, samplePacket, sampleRestoreProof } from './sample-evidence'

const pass = (id: string): InvariantResult => ({
  id,
  phase: id === 'PRI-2-CAP' ? 'MUTATING_PROBE' : 'READ_ONLY',
  predicate: id === 'PRI-5' ? 'PER_RELATION_ROW_COUNTS_EQUAL_AND_SOURCE_HAS_A_NON_EMPTY_RELATION' : 'RELATIONS_AND_FUNCTIONS_SET_EQUAL_AND_SOURCE_NON_EMPTY_AND_DECLARED_SCHEMAS_PRESENT_AND_NO_EXCLUDED_RELATION',
  predicate_sha256: 'a'.repeat(64),
  census_sql_sha256: 'b'.repeat(64),
  verdict: 'PASS',
  reason_code: null,
  expected: ['public.fixture_org:rows=3'],
  observed: ['public.fixture_org:rows=3'],
})

function input(over: Partial<FinalizeInput> = {}): FinalizeInput {
  const invariants = [{ ...pass('PRI-1') }, { ...pass('PRI-5') }]
  const proof = sampleRestoreProof(invariants)
  const destruction = proof['the target restored into'].destruction
  return {
    runId: 'abcdef0123456789',
    packet: samplePacket(),
    sourceCensus: sampleCensusRecord(),
    restoreProof: proof,
    captureRefusal: null,
    restore: { ok: true, refusal: null, refusal_detail: null, restore_database: 'd', restore_started_at: 'T', restore_finished_at: 'T', streamed_sha256: null, steps: [], roles_at_start: [], roles_after_restore: [], tool_refusals: [], target_observation: null, substrate_server_version_num: 170006 },
    invariants,
    acceptedUnknowns: [],
    destructions: [destruction, { ...destruction, role: 'source-fixture' }],
    otherDestructions: [{ ...destruction, role: 'source-fixture' }],
    expectedDestructions: 2,
    artifactDisposal: { artifact_sha256: 'a'.repeat(64), disposed_at: '2026-09-23T20:00:59.000Z', directory_absent: true, verdict: 'DISPOSED_AND_VERIFIED_ABSENT' },
    setupRefusal: null,
    secrets: ['throwaway-password-0f3c'],
    ...over,
  }
}

describe('finalizeRehearsal evidence gate', () => {
  it('a clean bundle passes: four documents, verdict PASS, no gate reason', () => {
    const { bundle, evidenceViolations, forbiddenHits } = finalizeRehearsal(input())
    expect(evidenceViolations).toEqual([])
    expect(forbiddenHits).toBe(0)
    expect(bundle.rehearsal_record.verdict).toBe('OFFLINE_REHEARSAL_PASS')
    expect(Object.keys(bundle)).toEqual(['backup_packet', 'source_census_record', 'restore_proof', 'rehearsal_record'])
  })

  it('an invariant fact carrying row-shaped text FAILS the run (fact grammar is enforced by the gate)', () => {
    const bad = { ...pass('PRI-5'), observed: ["Failing row contains (1, 'Ada')"] }
    const proof = sampleRestoreProof([pass('PRI-1'), bad])
    const out = finalizeRehearsal(input({ restoreProof: proof, invariants: [pass('PRI-1'), bad] }))
    expect(out.evidenceViolations.length).toBeGreaterThan(0)
    expect(out.bundle.rehearsal_record.verdict).toBe('OFFLINE_REHEARSAL_FAIL')
    expect(out.bundle.rehearsal_record.verdict_reasons).toContain('EVIDENCE_GRAMMAR_VIOLATION')
  })

  it('a substrate secret anywhere in the bundle FAILS the run', () => {
    const packet = samplePacket({ invocation: ['pg_dump', '--password=throwaway-password-0f3c'] })
    const out = finalizeRehearsal(input({ packet, sourceCensus: sampleCensusRecord() }))
    expect(out.forbiddenHits).toBe(1)
    expect(out.bundle.rehearsal_record.verdict_reasons).toContain('SECRET_IN_EVIDENCE')
  })

  it('a RESTORE_PROOF with a sixth top-level key FAILS the run', () => {
    const proof = { ...sampleRestoreProof([pass('PRI-1'), pass('PRI-5')]), engine_versions: {} } as unknown as RestoreProof
    const out = finalizeRehearsal(input({ restoreProof: proof }))
    expect(out.bundle.rehearsal_record.verdict_reasons).toContain('EVIDENCE_GRAMMAR_VIOLATION')
  })

  it('restore_outcome is unambiguous: RESTORED, RESTORE_REFUSED or NOT_ATTEMPTED (the frozen RESTORE_PROOF is not enlarged)', () => {
    expect(finalizeRehearsal(input()).bundle.rehearsal_record.restore_outcome).toBe('RESTORED')
    const refused = input()
    refused.restore = { ...refused.restore!, ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' }
    const out = finalizeRehearsal(refused)
    expect(out.bundle.rehearsal_record.restore_outcome).toBe('RESTORE_REFUSED')
    expect(out.bundle.rehearsal_record.verdict).toBe('OFFLINE_REHEARSAL_FAIL')
    expect(Object.keys(out.bundle.restore_proof!)).toHaveLength(5)
    expect(finalizeRehearsal(input({ restore: null, restoreProof: null })).bundle.rehearsal_record.restore_outcome).toBe('NOT_ATTEMPTED')
  })

  it('a packet without its census record, or with an unbound one, FAILS the run', () => {
    expect(finalizeRehearsal(input({ sourceCensus: null })).bundle.rehearsal_record.verdict_reasons).toContain('EVIDENCE_GRAMMAR_VIOLATION')
    const other = sampleCensus()
    other.row_counts[0].rows = 9
    expect(finalizeRehearsal(input({ sourceCensus: sampleCensusRecord(other) })).bundle.rehearsal_record.verdict_reasons).toContain('EVIDENCE_GRAMMAR_VIOLATION')
  })
})
