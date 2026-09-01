// app/app/projects/[projectId]/pipeline/evidence/__tests__/classifyEvidenceSensitivity.action.test.ts
// W2-B1-R4 — the UI action must be pure plumbing to the governed service:
// it parses FormData-shaped input and forwards it, never re-implements or
// weakens classifyEvidenceSensitivity's own permission gate or vocabulary.

import { beforeEach, expect, it, vi } from 'vitest'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const EVIDENCE = '22222222-2222-4222-8222-222222222222'

const mockClassify = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/evidence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pipeline/evidence')>()
  return { ...original, classifyEvidenceSensitivity: mockClassify }
})

const mockRunWithOrganizationAccess = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/session', () => ({
  runWithOrganizationAccess: mockRunWithOrganizationAccess,
}))

import { classifyEvidenceSensitivityAction } from '@/app/app/projects/[projectId]/pipeline/evidence/classifyEvidenceSensitivity.action'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunWithOrganizationAccess.mockImplementation((cb: () => unknown) => cb())
  mockClassify.mockResolvedValue({ id: 'v1', sensitivityClassification: 'non_sensitive' })
})

it('forwards a valid non_sensitive classification with no treatment required', async () => {
  await classifyEvidenceSensitivityAction(PROJECT, EVIDENCE, { sensitivityClassification: 'non_sensitive' })
  expect(mockClassify).toHaveBeenCalledWith(PROJECT, EVIDENCE, { sensitivityClassification: 'non_sensitive' })
})

it('forwards a sensitive classification together with its required treatment', async () => {
  await classifyEvidenceSensitivityAction(PROJECT, EVIDENCE, {
    sensitivityClassification: 'personal_data',
    treatment: 'anonymized',
  })
  expect(mockClassify).toHaveBeenCalledWith(PROJECT, EVIDENCE, {
    sensitivityClassification: 'personal_data',
    treatment: 'anonymized',
  })
})

it('rejects a sensitive classification with no treatment BEFORE calling the service — the UI must not forward an invalid governed write', async () => {
  await expect(
    classifyEvidenceSensitivityAction(PROJECT, EVIDENCE, { sensitivityClassification: 'special_category' })
  ).rejects.toThrow()
  expect(mockClassify).not.toHaveBeenCalled()
})

it('rejects an unrecognized classification value — the UI vocabulary matches the governed CHECK exactly, no wider set', async () => {
  await expect(
    classifyEvidenceSensitivityAction(PROJECT, EVIDENCE, { sensitivityClassification: 'top_secret' })
  ).rejects.toThrow()
  expect(mockClassify).not.toHaveBeenCalled()
})

it('propagates the service permission error unmodified — the UI never converts or swallows a fail-closed rejection', async () => {
  mockClassify.mockRejectedValue(new Error('Insufficient permissions to classify evidence sensitivity'))
  await expect(
    classifyEvidenceSensitivityAction(PROJECT, EVIDENCE, { sensitivityClassification: 'non_sensitive' })
  ).rejects.toThrow('Insufficient permissions to classify evidence sensitivity')
})

it('opens organization access before calling the service, exactly once', async () => {
  await classifyEvidenceSensitivityAction(PROJECT, EVIDENCE, { sensitivityClassification: 'non_sensitive' })
  expect(mockRunWithOrganizationAccess).toHaveBeenCalledTimes(1)
})
