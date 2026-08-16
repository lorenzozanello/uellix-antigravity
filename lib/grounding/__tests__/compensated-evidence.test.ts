// lib/grounding/__tests__/compensated-evidence.test.ts
//
// M2-COMP-01 x G-01 — what the grounding side sees of a row whose upload
// stored no bytes.
//
// The compensation withdraws such a row by moving it to `archived` and leaving
// `file_path` NULL (lib/pipeline/evidence.ts, `compensateFailedFileUpload`).
// The claim these tests pin is that BOTH halves of that state independently
// keep the row out of the corpus, so neither one has to be trusted alone:
//
//   file_path IS NULL   ->  never indexable, whatever the status says
//   status = archived   ->  no retry offered, whatever the path says
//
// The point of the redundancy is that the two are decided in different layers.
// If a later change ever un-archives such a row — a reviewer moving it back
// through the review states, say — the missing path still refuses it; and if a
// row somehow acquired a path, the archived status still withholds the action.

import { describe, expect, it } from 'vitest'

import { classifyEvidenceIndexability } from '@/lib/grounding/indexability'
import { deriveEvidenceCorpusState, type EvidenceRowFact } from '@/lib/grounding/corpus-state'

const EVIDENCE = '55555555-5555-4555-8555-555555555555'
const MANAGER = { mayManage: true }

/** Exactly what `compensateFailedFileUpload` leaves behind. */
function compensatedRow(overrides: Partial<EvidenceRowFact> = {}): EvidenceRowFact {
  return {
    id: EVIDENCE,
    status: 'archived',
    type: 'file',
    description: null,
    // The upload failed, so phase 3 never ran and no path was ever recorded.
    filePath: null,
    fileSize: 42,
    mimeType: 'text/plain',
    contentHash: 'a'.repeat(64),
    ...overrides,
  }
}

describe('a compensated upload can never become corpus content', () => {
  it('is refused as missing_bytes on the row alone', () => {
    expect(classifyEvidenceIndexability(compensatedRow())).toMatchObject({
      kind: 'not_indexable',
      blocker: 'missing_bytes',
    })
  })

  it('stays refused even if the status is moved back out of archived', () => {
    // `updateEvidenceReviewStatus` can put any evidence row into
    // under_review / approved / rejected. None of that invents a file.
    for (const status of ['draft', 'under_review', 'approved', 'rejected']) {
      expect(classifyEvidenceIndexability(compensatedRow({ status }))).toMatchObject({
        blocker: 'missing_bytes',
      })
    }
  })

  it('is shown as not_indexable and offers no retry', () => {
    // `missing_bytes` is a RETRYABLE refusal when it comes from an ATTEMPT —
    // the bucket may have been briefly unreadable. Here it comes from the ROW,
    // which is the stronger fact: there is no object to re-read, and offering
    // the action would be offering to fail.
    const state = deriveEvidenceCorpusState(compensatedRow(), null, null, MANAGER)

    expect(state).toMatchObject({
      phase: 'not_indexable',
      reason: 'missing_bytes',
      canRetry: false,
      chunkCount: null,
      versionOrdinal: null,
      indexedAt: null,
    })
  })

  it('offers no retry even when the row is un-archived', () => {
    const state = deriveEvidenceCorpusState(compensatedRow({ status: 'draft' }), null, null, MANAGER)
    expect(state.canRetry).toBe(false)
  })

  it('withholds the retry on an archived row that DOES have bytes', () => {
    // The other half of the redundancy: real evidence, archived by a reviewer.
    const state = deriveEvidenceCorpusState(
      compensatedRow({ filePath: 'p/e/encuesta.txt' }),
      null,
      null,
      MANAGER,
    )
    expect(state.canRetry).toBe(false)
  })
})

describe('the state is distinguishable from evidence that was merely archived', () => {
  it('separates "withdrawn because the upload failed" from "archived by a reviewer"', () => {
    // No column says which is which, and none is needed: the PAIR is the
    // signature. A reviewer archives a row that has a path; the compensation
    // only ever reaches rows that do not.
    const withdrawn = compensatedRow()
    const archivedByReviewer = compensatedRow({ filePath: 'p/e/encuesta.txt' })

    expect(classifyEvidenceIndexability(withdrawn).kind).toBe('not_indexable')
    expect(classifyEvidenceIndexability(archivedByReviewer).kind).toBe('indexable')
  })
})
