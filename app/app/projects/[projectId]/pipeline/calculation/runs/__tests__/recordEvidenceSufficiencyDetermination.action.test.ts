// app/app/projects/[projectId]/pipeline/calculation/runs/__tests__/recordEvidenceSufficiencyDetermination.action.test.ts
// W2-B1-R4 — plumbing-only contract for the run-bound sufficiency write
// (FIBIU-06). `calculationRunId` is always the third positional argument
// supplied by the caller (the route's own `runId`, never taken from the
// FormData payload) — that is what makes the panel run-unambiguous.

import { beforeEach, expect, it, vi } from 'vitest'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const OUTCOME = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

const mockRecord = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/evidence-sufficiency', () => ({
  recordEvidenceSufficiencyDetermination: mockRecord,
}))

const mockRunWithOrganizationAccess = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/session', () => ({
  runWithOrganizationAccess: mockRunWithOrganizationAccess,
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { recordEvidenceSufficiencyDeterminationAction } from '@/app/app/projects/[projectId]/pipeline/calculation/runs/recordEvidenceSufficiencyDetermination.action'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunWithOrganizationAccess.mockImplementation((cb: () => unknown) => cb())
  mockRecord.mockResolvedValue({ id: 'det-1', determination: 'sufficient' })
})

it('forwards outcomeId and calculationRunId as distinct positional arguments to the service', async () => {
  await recordEvidenceSufficiencyDeterminationAction(PROJECT, OUTCOME, RUN, {
    determination: 'sufficient',
    rationale: 'Tres fuentes corroboran el resultado.',
  })
  expect(mockRecord).toHaveBeenCalledWith(PROJECT, OUTCOME, RUN, {
    determination: 'sufficient',
    rationale: 'Tres fuentes corroboran el resultado.',
  })
})

it('rejects an empty rationale BEFORE calling the service — FIBC-008 never accepts an unreasoned determination', async () => {
  await expect(
    recordEvidenceSufficiencyDeterminationAction(PROJECT, OUTCOME, RUN, { determination: 'sufficient', rationale: '' })
  ).rejects.toThrow()
  expect(mockRecord).not.toHaveBeenCalled()
})

it('rejects a determination value outside {sufficient, insufficient}', async () => {
  await expect(
    recordEvidenceSufficiencyDeterminationAction(PROJECT, OUTCOME, RUN, {
      determination: 'probably',
      rationale: 'x',
    })
  ).rejects.toThrow()
  expect(mockRecord).not.toHaveBeenCalled()
})

it('propagates a cross-run rejection unmodified — a determination for another run must never appear to succeed here', async () => {
  mockRecord.mockRejectedValue(new Error('Calculation run does not belong to the project'))
  await expect(
    recordEvidenceSufficiencyDeterminationAction(PROJECT, OUTCOME, RUN, {
      determination: 'sufficient',
      rationale: 'x',
    })
  ).rejects.toThrow('Calculation run does not belong to the project')
})
