// components/stella/__tests__/decision-adapter.test.ts
// WS3c U4 (D-007): SuggestionDecisionRecord → recordStellaDecision mapping.
// The adapter never throws, skips 'copied', swallows DISABLED silently, and
// warns (without throwing) on any other failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SuggestionDecisionRecord } from '../decision-types'

const mockRecordStellaDecision = vi.fn()
vi.mock('@/app/actions/stella/decisions', () => ({
  recordStellaDecision: (...args: unknown[]) => mockRecordStellaDecision(...args),
}))

import { persistStellaDecision } from '../decision-adapter'

const PROJECT_ID = 'b7e5b0f0-0000-4000-8000-000000000001'
const INTERACTION_ID = 'b7e5b0f0-0000-4000-8000-000000000002'

function record(overrides: Partial<SuggestionDecisionRecord> = {}): SuggestionDecisionRecord {
  return {
    suggestionId: 'sug-1',
    step: 'narrative',
    action: 'accepted',
    proposedText: 'Texto propuesto',
    appliedText: 'Texto propuesto',
    decidedAt: '2026-07-31T12:00:00.000Z',
    ...overrides,
  }
}

describe('persistStellaDecision (D-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRecordStellaDecision.mockResolvedValue({ ok: true, data: { id: 'dec-1' } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("maps 'accepted' 1:1 — suggestionId→suggestionKey, no editedText", async () => {
    await persistStellaDecision(record({ action: 'accepted', previousValue: 'antes' }), {
      projectId: PROJECT_ID,
    })

    expect(mockRecordStellaDecision).toHaveBeenCalledTimes(1)
    expect(mockRecordStellaDecision).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      suggestionKey: 'sug-1',
      decision: 'accepted',
      previousValue: 'antes',
    })
  })

  it("maps 'accepted_edited' with appliedText→editedText", async () => {
    await persistStellaDecision(
      record({ action: 'accepted_edited', appliedText: 'Texto editado', previousValue: 'antes' }),
      { projectId: PROJECT_ID },
    )

    expect(mockRecordStellaDecision).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      suggestionKey: 'sug-1',
      decision: 'accepted_edited',
      editedText: 'Texto editado',
      previousValue: 'antes',
    })
  })

  it("does NOT map appliedText to editedText for 'accepted' or 'undone'", async () => {
    await persistStellaDecision(record({ action: 'accepted', appliedText: 'X' }), { projectId: PROJECT_ID })
    await persistStellaDecision(record({ action: 'undone', appliedText: 'X' }), { projectId: PROJECT_ID })

    for (const call of mockRecordStellaDecision.mock.calls) {
      expect(call[0]).not.toHaveProperty('editedText')
    }
  })

  it("maps 'rejected' with rejectionReason passthrough", async () => {
    await persistStellaDecision(
      record({ action: 'rejected', appliedText: undefined, rejectionReason: 'No aplica' }),
      { projectId: PROJECT_ID },
    )

    expect(mockRecordStellaDecision).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      suggestionKey: 'sug-1',
      decision: 'rejected',
      rejectionReason: 'No aplica',
    })
  })

  it("maps 'undone' 1:1 with previousValue passthrough", async () => {
    await persistStellaDecision(
      record({ action: 'undone', appliedText: 'restaurado', previousValue: 'lo que el undo pisó' }),
      { projectId: PROJECT_ID },
    )

    expect(mockRecordStellaDecision).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      suggestionKey: 'sug-1',
      decision: 'undone',
      previousValue: 'lo que el undo pisó',
    })
  })

  it('forwards interactionId when the caller provides one', async () => {
    await persistStellaDecision(record(), { projectId: PROJECT_ID, interactionId: INTERACTION_ID })

    expect(mockRecordStellaDecision).toHaveBeenCalledWith(
      expect.objectContaining({ interactionId: INTERACTION_ID }),
    )
  })

  it("skips 'copied' entirely — never calls the server action", async () => {
    await persistStellaDecision(record({ action: 'copied' }), { projectId: PROJECT_ID })

    expect(mockRecordStellaDecision).not.toHaveBeenCalled()
  })

  it('swallows the DISABLED result silently (expected pre-G2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRecordStellaDecision.mockResolvedValue({
      ok: false,
      error: 'DISABLED',
      message: 'Stella decision persistence is not enabled.',
    })

    await expect(persistStellaDecision(record(), { projectId: PROJECT_ID })).resolves.toBeUndefined()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns with the [stella-decisions] prefix on non-DISABLED errors, without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRecordStellaDecision.mockResolvedValue({
      ok: false,
      error: 'DB_ERROR',
      message: 'Failed to record decision.',
    })

    await expect(persistStellaDecision(record(), { projectId: PROJECT_ID })).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('[stella-decisions]')
  })

  it('never throws even when the server action itself rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRecordStellaDecision.mockRejectedValue(new Error('network down'))

    await expect(persistStellaDecision(record(), { projectId: PROJECT_ID })).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('[stella-decisions]')
  })
})
