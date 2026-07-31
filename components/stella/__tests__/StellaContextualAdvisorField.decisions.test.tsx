// @vitest-environment jsdom
// components/stella/__tests__/StellaContextualAdvisorField.decisions.test.tsx
// WS3c U4 (D-007): the field wrapper composes persistStellaDecision into its
// onDecision forwarding — decisions are persisted with the field's projectId
// AND still reach the page-provided hook.

import { render, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import type { SuggestionDecisionRecord } from '../decision-types'

const mockPersistStellaDecision = vi.fn().mockResolvedValue(undefined)
vi.mock('../decision-adapter', () => ({
  persistStellaDecision: (...args: unknown[]) => mockPersistStellaDecision(...args),
}))

// Mock the panel: capture its props so the test can invoke onDecision exactly
// as the real panel would after a user decision.
type PanelProps = { onDecision?: (record: SuggestionDecisionRecord) => void }
let capturedPanelProps: PanelProps | null = null
vi.mock('../StellaContextualAdvisorPanel', () => ({
  StellaContextualAdvisorPanel: (props: PanelProps) => {
    capturedPanelProps = props
    return <div data-testid="mock-panel" />
  },
}))

import { StellaContextualAdvisorField } from '../StellaContextualAdvisorField'

const PROJECT_ID = 'b7e5b0f0-0000-4000-8000-000000000001'

function decisionRecord(): SuggestionDecisionRecord {
  return {
    suggestionId: 'sug-1',
    step: 'narrative',
    action: 'accepted',
    proposedText: 'Texto propuesto',
    appliedText: 'Texto propuesto',
    previousValue: 'anterior',
    decidedAt: '2026-07-31T12:00:00.000Z',
  }
}

function renderField(onDecision?: (record: SuggestionDecisionRecord) => void) {
  return render(
    <StellaContextualAdvisorField
      projectId={PROJECT_ID}
      step="narrative"
      fieldName="narrativeText"
      fieldId="narrativeText"
      fieldLabel="Texto narrativo"
      initialValue=""
      onDecision={onDecision}
    />,
  )
}

describe('StellaContextualAdvisorField decision wiring (D-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedPanelProps = null
  })

  afterEach(() => {
    cleanup()
  })

  it('persists every decision with the field projectId', () => {
    renderField()
    const record = decisionRecord()

    capturedPanelProps?.onDecision?.(record)

    expect(mockPersistStellaDecision).toHaveBeenCalledTimes(1)
    expect(mockPersistStellaDecision).toHaveBeenCalledWith(record, { projectId: PROJECT_ID })
  })

  it('still forwards the record to the page-provided onDecision hook', () => {
    const pageHook = vi.fn()
    renderField(pageHook)
    const record = decisionRecord()

    capturedPanelProps?.onDecision?.(record)

    expect(pageHook).toHaveBeenCalledTimes(1)
    expect(pageHook).toHaveBeenCalledWith(record)
    expect(mockPersistStellaDecision).toHaveBeenCalledTimes(1)
  })

  it('persists even when the page provides no onDecision hook', () => {
    renderField(undefined)

    capturedPanelProps?.onDecision?.(decisionRecord())

    expect(mockPersistStellaDecision).toHaveBeenCalledTimes(1)
  })
})
