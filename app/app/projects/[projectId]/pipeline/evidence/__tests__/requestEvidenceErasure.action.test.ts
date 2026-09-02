// app/app/projects/[projectId]/pipeline/evidence/__tests__/requestEvidenceErasure.action.test.ts
// W2-B1-R4 — same plumbing-only contract as classifyEvidenceSensitivity.
// action.test.ts, for the governed erasure route (FIBIU-07).

import { beforeEach, expect, it, vi } from 'vitest'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const EVIDENCE = '22222222-2222-4222-8222-222222222222'

const mockErase = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/evidence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pipeline/evidence')>()
  return { ...original, requestGovernedEvidenceErasure: mockErase }
})

const mockRunWithOrganizationAccess = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/session', () => ({
  runWithOrganizationAccess: mockRunWithOrganizationAccess,
}))

import { requestEvidenceErasureAction } from '@/app/app/projects/[projectId]/pipeline/evidence/requestEvidenceErasure.action'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunWithOrganizationAccess.mockImplementation((cb: () => unknown) => cb())
  mockErase.mockResolvedValue({ id: 'tombstone-1', erasureState: 'erasure_complete' })
})

it('forwards a valid erasure request with reason and rationale', async () => {
  await requestEvidenceErasureAction(PROJECT, EVIDENCE, {
    erasureReason: 'privacy_or_data_subject_request',
    rationale: 'Solicitud del titular de datos, ticket #482.',
  })
  expect(mockErase).toHaveBeenCalledWith(PROJECT, EVIDENCE, {
    erasureReason: 'privacy_or_data_subject_request',
    rationale: 'Solicitud del titular de datos, ticket #482.',
  })
})

it('rejects a request with an empty rationale BEFORE calling the service', async () => {
  await expect(
    requestEvidenceErasureAction(PROJECT, EVIDENCE, { erasureReason: 'retention_policy', rationale: '' })
  ).rejects.toThrow()
  expect(mockErase).not.toHaveBeenCalled()
})

it('rejects an unrecognized erasure reason — vocabulary matches the governed CHECK exactly', async () => {
  await expect(
    requestEvidenceErasureAction(PROJECT, EVIDENCE, { erasureReason: 'because_i_felt_like_it', rationale: 'x' })
  ).rejects.toThrow()
  expect(mockErase).not.toHaveBeenCalled()
})

it('propagates the service permission error unmodified', async () => {
  mockErase.mockRejectedValue(new Error('Insufficient permissions to erase evidence content'))
  await expect(
    requestEvidenceErasureAction(PROJECT, EVIDENCE, {
      erasureReason: 'retention_policy',
      rationale: 'x',
    })
  ).rejects.toThrow('Insufficient permissions to erase evidence content')
})

it('propagates an already-erased rejection unmodified — the UI never masks a fail-closed re-erasure block', async () => {
  mockErase.mockRejectedValue(new Error('Evidence content has already been erased'))
  await expect(
    requestEvidenceErasureAction(PROJECT, EVIDENCE, {
      erasureReason: 'retention_policy',
      rationale: 'x',
    })
  ).rejects.toThrow('Evidence content has already been erased')
})
