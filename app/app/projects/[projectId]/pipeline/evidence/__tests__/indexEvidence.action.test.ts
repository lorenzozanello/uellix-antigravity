// app/app/projects/[projectId]/pipeline/evidence/__tests__/indexEvidence.action.test.ts
// G-01 (product path) — the MANUAL retry, one row at a time.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// The authorization itself — session, organization, role threshold, and the
// scoped lookup that makes an evidence id of another project indistinguishable
// from one that does not exist — belongs to `ingestProjectEvidenceForProject`
// and is proved against the real module in
// `app/actions/grounding/__tests__/ingest-evidence.test.ts`. Re-asserting it
// here against a double would prove only that the double was written to agree.
//
// What is UNPROVEN until this file exists is the WIRING, and the wiring is
// where a retry button goes wrong:
//
//   * it must re-enter the authorizing action rather than reach the ingestion
//     core directly, because the core takes an already-authorized row;
//   * it must index ONE row — the selected one — and not walk the project;
//   * it must not invent an evidence id, a project, or a principal of its own.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT = '22222222-2222-4222-8222-222222222222'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'
const OTHER_EVIDENCE = '66666666-6666-4666-8666-666666666666'

const mockIngest = vi.fn()
vi.mock('@/app/actions/grounding/ingest-evidence', () => ({
  ingestProjectEvidenceForProject: (...args: unknown[]) => mockIngest(...args),
}))

import { indexEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action'

beforeEach(() => {
  vi.clearAllMocks()
  mockIngest.mockResolvedValue({ status: 'indexed', versionId: 'v1', chunkCount: 4, reingestion: 'first_ingestion' })
})

describe('the manual retry', () => {
  it('re-enters the authorizing ingestion action with the pair it was given', async () => {
    await indexEvidenceAction(PROJECT, EVIDENCE)
    expect(mockIngest).toHaveBeenCalledWith(PROJECT, { evidenceId: EVIDENCE })
  })

  it('indexes ONE row — never the project', async () => {
    // A retry that fanned out would spend the project's whole corpus budget on
    // one click, and would re-write versions for rows nobody asked about.
    await indexEvidenceAction(PROJECT, EVIDENCE)
    expect(mockIngest).toHaveBeenCalledTimes(1)
    expect(mockIngest.mock.calls[0][1]).toEqual({ evidenceId: EVIDENCE })
    expect(JSON.stringify(mockIngest.mock.calls[0])).not.toContain(OTHER_EVIDENCE)
  })

  it('returns the ingestion outcome verbatim', async () => {
    // The caller renders this. Re-shaping it here would create a second
    // vocabulary for the same outcomes.
    const outcome = { status: 'refused', reason: 'content_hash_mismatch' }
    mockIngest.mockResolvedValue(outcome)
    await expect(indexEvidenceAction(PROJECT, EVIDENCE)).resolves.toEqual(outcome)
  })

  it('passes an unauthorized answer through instead of throwing', async () => {
    // `unauthorized` is one answer for "not entitled", "not yours" and "does
    // not exist" — deliberately. Turning it into an exception here would let
    // the difference leak through a stack trace or an error boundary.
    mockIngest.mockResolvedValue({ status: 'unauthorized' })
    await expect(indexEvidenceAction(PROJECT, EVIDENCE)).resolves.toEqual({ status: 'unauthorized' })
  })

  it('does not open an identity context of its own', async () => {
    // `ingestProjectEvidenceForProject` opens three, and the middle one carries
    // register -> insert -> finalize as a single transaction (M-7). An outer
    // context here would be reused by all three and put the storage round trip
    // back inside one.
    const source = (await import('node:fs')).readFileSync(
      'app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action.ts',
      'utf8',
    )
    expect(source).not.toMatch(/runWithOrganizationAccess\s*\(/)
    expect(source).not.toMatch(/withOrganizationDatabaseContext\s*\(/)
  })
})
