// @vitest-environment jsdom
// components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx
// WS2 (Moonshot) — component tests for the contextual advisor panel.
// No real Gemini, no real DB, no real auth: the server action is mocked.

import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The ticket issuer, mocked to the happy path. `vi.hoisted` because vitest
 * hoists `vi.mock` factories above the const declarations they close over.
 */
const mockIssueTicket = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'issued', ticket: 'a'.repeat(64) }),
)
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import type { SuggestionDecisionRecord } from '../decision-types'

const mockGetStellaContextualAdvisor = vi.fn()
vi.mock('@/app/actions/stella/advisor', () => ({
  getStellaContextualAdvisor: (...args: unknown[]) => mockGetStellaContextualAdvisor(...args),
  // TRAIN 4.3. The panel now MINTS an operation ticket before it runs, and
  // presents the SAME ticket on a retry — see components/stella/use-stella-operation.ts.
  // The issuer is mocked to the happy path so the tests below stay about the
  // panel's rendering, focus and error taxonomy; the ticket lifecycle itself is
  // proved in the action suites and in the cross-workstream battery.
  issueStellaAdvisorTicket: (...args: unknown[]) => mockIssueTicket(...args),
}))

import { StellaContextualAdvisorPanel } from '../StellaContextualAdvisorPanel'
import type { GroundedAnswerView } from '../grounding-adapter'
import { groundedAnswerView } from './grounded-fixtures'
import React from 'react'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_OUTPUT: AdvisorContextualOutput = {
  step: 'narrative',
  responseType: 'review',
  summary: 'La narrativa está incompleta en dos frentes.',
  findings: [
    {
      id: 'f-info',
      severity: 'info',
      title: 'La narrativa menciona actividades',
      explanation: 'Las actividades del grafo están reflejadas.',
      sourceFields: ['narrativeSummary'],
    },
    {
      id: 'f-warn',
      severity: 'warning',
      title: 'No hay resultados registrados',
      explanation: 'El paso de resultados está vacío.',
      sourceFields: ['outcomesSnapshot.empty'],
    },
  ],
  suggestions: [
    {
      id: 's-1',
      proposedText: 'Texto propuesto por Stella para la narrativa.',
      rationale: 'La narrativa actual no menciona la teoría de cambio.',
      missingInformation: [],
      sourceFields: ['narrativeSummary', 'outcomesSnapshot[0].name'],
    },
    {
      id: 's-null',
      proposedText: null,
      rationale: 'Faltan datos para proponer una redacción.',
      missingInformation: ['Cantidad de beneficiarios directos'],
      sourceFields: ['stakeholderCount'],
    },
  ],
  clarifyingQuestions: ['¿Cuántos beneficiarios directos tiene el programa?'],
  limitations: ['El análisis no incluye la evidencia adjunta.'],
  requiresHumanReview: true,
}

/** Two applyable suggestions sharing ONE target field — for the global-LIFO
 * undo regression (audit FIX 1). */
const TWO_SUGGESTIONS_OUTPUT: AdvisorContextualOutput = {
  ...VALID_OUTPUT,
  suggestions: [
    {
      id: 's-1',
      proposedText: 'Texto A',
      rationale: 'Primera propuesta.',
      missingInformation: [],
      sourceFields: ['narrativeSummary'],
    },
    {
      id: 's-2',
      proposedText: 'Texto B',
      rationale: 'Segunda propuesta.',
      missingInformation: [],
      sourceFields: ['narrativeSummary'],
    },
  ],
}

/**
 * Stateful harness mirroring how pages actually wire the panel (see
 * StellaContextualAdvisorField): one controlled field, onApply writes it,
 * targetValue reflects it — required so undo/staleness see real values.
 */
function TargetHarness({
  onDecision,
  initialValue = 'valor original',
  groundedAnswer,
}: {
  onDecision?: (record: SuggestionDecisionRecord) => void
  initialValue?: string
  groundedAnswer?: GroundedAnswerView
}) {
  const [value, setValue] = React.useState(initialValue)
  return (
    <>
      <textarea
        aria-label="Campo destino"
        data-testid="harness-target"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <StellaContextualAdvisorPanel
        projectId="proj-1"
        step="narrative"
        targetValue={value}
        onApply={(_suggestion, text) => setValue(text)}
        onDecision={onDecision}
        groundedAnswer={groundedAnswer}
      />
    </>
  )
}

function harnessTarget(): HTMLTextAreaElement {
  return screen.getByTestId('harness-target') as HTMLTextAreaElement
}

function undoButtonIn(suggestionId: string): HTMLButtonElement {
  const scope = within(screen.getByTestId(`stella-suggestion-${suggestionId}`))
  return scope.getByText('Deshacer').closest('button') as HTMLButtonElement
}

function success(output: AdvisorContextualOutput = VALID_OUTPUT) {
  return mockGetStellaContextualAdvisor.mockResolvedValue({ ok: true, data: output })
}
function failure(error: string, message: string) {
  return mockGetStellaContextualAdvisor.mockResolvedValue({ ok: false, error, message })
}

function askStella() {
  fireEvent.click(screen.getByText(/analizar con stella/i))
}

async function renderSuccess(
  props: Partial<React.ComponentProps<typeof StellaContextualAdvisorPanel>> = {},
  output: AdvisorContextualOutput = VALID_OUTPUT
) {
  success(output)
  const utils = render(
    <StellaContextualAdvisorPanel projectId="proj-1" step="narrative" {...props} />
  )
  askStella()
  await waitFor(() => {
    expect(screen.queryByTestId('stella-contextual-result')).not.toBeNull()
  })
  return utils
}

describe('StellaContextualAdvisorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
  })

  // -------------------------------------------------------------------------
  // Idle / on-demand invariants
  // -------------------------------------------------------------------------
  describe('Idle state', () => {
    it('never calls the action on mount or re-render', () => {
      const { rerender } = render(
        <StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />
      )
      rerender(<StellaContextualAdvisorPanel projectId="proj-1" step="outcomes" />)
      expect(mockGetStellaContextualAdvisor).not.toHaveBeenCalled()
    })

    it('shows the human-review note at idle (role="note", always visible)', () => {
      render(<StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />)
      const note = screen.getByTestId('stella-human-review-note')
      expect(note.getAttribute('role')).toBe('note')
      expect(note.textContent).toMatch(/se requiere revisión humana/i)
    })

    it('mounts both live regions at idle (empty persistent containers)', () => {
      render(<StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />)
      const polite = screen.getByTestId('stella-contextual-live-polite')
      const assertive = screen.getByTestId('stella-contextual-live-assertive')
      expect(polite.getAttribute('aria-live')).toBe('polite')
      expect(assertive.getAttribute('aria-live')).toBe('assertive')
      expect(polite.textContent).toBe('')
      expect(assertive.textContent).toBe('')
    })

    it('calls the action with projectId and step on click', async () => {
      success()
      render(<StellaContextualAdvisorPanel projectId="proj-abc" step="outcomes" />)
      askStella()
      await waitFor(() => {
        expect(mockGetStellaContextualAdvisor).toHaveBeenCalledWith('proj-abc', 'outcomes', 'a'.repeat(64))
        expect(mockGetStellaContextualAdvisor).toHaveBeenCalledTimes(1)
      })
    })
  })

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('disables the trigger and shows an aria-busy skeleton', async () => {
      let resolve!: (v: unknown) => void
      mockGetStellaContextualAdvisor.mockReturnValue(new Promise((res) => (resolve = res)))
      render(<StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />)
      askStella()
      await waitFor(() => {
        const skeleton = screen.getByTestId('stella-contextual-loading')
        expect(skeleton.getAttribute('aria-busy')).toBe('true')
        const btn = screen.getByText(/analizando…/i).closest('button')
        expect(btn?.disabled).toBe(true)
      })
      resolve({ ok: true, data: VALID_OUTPUT })
      await waitFor(() => {
        expect(screen.queryByTestId('stella-contextual-loading')).toBeNull()
      })
    })
  })

  // -------------------------------------------------------------------------
  // Success rendering (U1)
  // -------------------------------------------------------------------------
  describe('Success state', () => {
    it('renders summary and response type', async () => {
      await renderSuccess()
      expect(screen.queryByText('La narrativa está incompleta en dos frentes.')).not.toBeNull()
      expect(screen.queryByText('Revisión')).not.toBeNull()
    })

    it('groups findings by severity, warnings first, with accessible labels', async () => {
      await renderSuccess()
      const items = Array.from(document.querySelectorAll('[data-severity]'))
      expect(items.map((el) => el.getAttribute('data-severity'))).toEqual(['warning', 'info'])
      expect(screen.queryByText('Advertencia')).not.toBeNull()
      expect(screen.queryByText('Información')).not.toBeNull()
    })

    it('renders sources as human-readable Spanish labels', async () => {
      await renderSuccess()
      // '.empty' sentinel
      expect(screen.queryByText('sin datos registrados en Resultados')).not.toBeNull()
      // indexed path
      expect(screen.queryByText('Resultados › n.º 1 › nombre')).not.toBeNull()
      // scalar root appears in finding + suggestion chips
      expect(screen.queryAllByText('Resumen narrativo').length).toBeGreaterThan(0)
    })

    it('renders a grounded badge on the finding whose sourceFields cite a real context path', async () => {
      await renderSuccess()
      const groundedFinding = screen.getByText('La narrativa menciona actividades').closest('li')
      expect(groundedFinding).not.toBeNull()
      expect(within(groundedFinding as HTMLElement).getByTestId('stella-grounding-badge')).toHaveAttribute(
        'data-support-level',
        'grounded'
      )
    })

    it('renders an insufficient_evidence badge on the finding whose only sourceField is an .empty sentinel', async () => {
      await renderSuccess()
      const emptyFinding = screen.getByText('No hay resultados registrados').closest('li')
      expect(emptyFinding).not.toBeNull()
      expect(within(emptyFinding as HTMLElement).getByTestId('stella-grounding-badge')).toHaveAttribute(
        'data-support-level',
        'insufficient_evidence'
      )
    })

    it('renders a grounded badge on the fully-sourced suggestion', async () => {
      await renderSuccess()
      const scope = within(screen.getByTestId('stella-suggestion-s-1'))
      expect(scope.getByTestId('stella-grounding-badge')).toHaveAttribute('data-support-level', 'grounded')
    })

    it('renders an insufficient_evidence badge on the abstained suggestion (proposedText: null)', async () => {
      await renderSuccess()
      const scope = within(screen.getByTestId('stella-suggestion-s-null'))
      expect(scope.getByTestId('stella-grounding-badge')).toHaveAttribute('data-support-level', 'insufficient_evidence')
    })

    it('renders limitations and clarifying questions distinctly', async () => {
      await renderSuccess()
      expect(screen.queryByText('Limitaciones')).not.toBeNull()
      expect(screen.queryByText('El análisis no incluye la evidencia adjunta.')).not.toBeNull()
      expect(screen.queryByText('Preguntas para aclarar')).not.toBeNull()
      expect(
        screen.queryByText('¿Cuántos beneficiarios directos tiene el programa?')
      ).not.toBeNull()
    })

    it('keeps the human-review note visible in success', async () => {
      await renderSuccess()
      expect(screen.getByTestId('stella-human-review-note')).not.toBeNull()
    })

    it('moves focus to the result container on success', async () => {
      await renderSuccess()
      const result = screen.getByTestId('stella-contextual-result')
      expect(result.getAttribute('tabindex')).toBe('-1')
      await waitFor(() => {
        expect(document.activeElement).toBe(result)
      })
    })
  })

  // -------------------------------------------------------------------------
  // Suggestion lifecycle (U2)
  // -------------------------------------------------------------------------
  describe('Suggestion lifecycle', () => {
    it('never applies automatically: onApply not called on success', async () => {
      const onApply = vi.fn()
      await renderSuccess({ onApply, targetValue: 'texto actual' })
      expect(onApply).not.toHaveBeenCalled()
    })

    it('Aceptar fires onApply with the suggestion and proposed text', async () => {
      const onApply = vi.fn()
      const onDecision = vi.fn()
      await renderSuccess({ onApply, onDecision, targetValue: 'texto actual' })

      fireEvent.click(screen.getAllByText('Aceptar')[0]!)

      expect(onApply).toHaveBeenCalledTimes(1)
      const [suggestion, text] = onApply.mock.calls[0]!
      expect(suggestion.id).toBe('s-1')
      expect(text).toBe('Texto propuesto por Stella para la narrativa.')

      const record: SuggestionDecisionRecord = onDecision.mock.calls[0]![0]
      expect(record.action).toBe('accepted')
      expect(record.suggestionId).toBe('s-1')
      expect(record.step).toBe('narrative')
      expect(record.previousValue).toBe('texto actual')
      expect(record.appliedText).toBe('Texto propuesto por Stella para la narrativa.')
      expect(typeof record.decidedAt).toBe('string')
    })

    it('disables Aceptar and shows missing information when proposedText is null', async () => {
      await renderSuccess({ onApply: vi.fn(), targetValue: '' })
      const nullSuggestion = screen.getByTestId('stella-suggestion-s-null')
      const acceptBtn = Array.from(nullSuggestion.querySelectorAll('button')).find((b) =>
        /aceptar/i.test(b.textContent ?? '')
      )
      expect(acceptBtn).toBeDefined()
      expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
      expect(nullSuggestion.textContent).toMatch(/información suficiente/i)
      expect(nullSuggestion.textContent).toMatch(/Cantidad de beneficiarios directos/)
    })

    it('Vista previa shows a diff of current vs proposed text and Escape closes it', async () => {
      await renderSuccess({ onApply: vi.fn(), targetValue: 'texto viejo' })
      fireEvent.click(screen.getAllByText('Vista previa')[0]!)
      const preview = screen.getByTestId('stella-suggestion-preview-s-1')
      expect(preview.querySelector('del')?.textContent).toBe('texto viejo')
      expect(preview.querySelector('ins')?.textContent).toBe(
        'Texto propuesto por Stella para la narrativa.'
      )
      fireEvent.keyDown(screen.getByTestId('stella-suggestion-s-1'), { key: 'Escape' })
      expect(screen.queryByTestId('stella-suggestion-preview-s-1')).toBeNull()
    })

    it('does not offer Vista previa when the page supplies no target value', async () => {
      await renderSuccess({ onApply: vi.fn() })
      expect(screen.queryByText('Vista previa')).toBeNull()
    })

    it('Editar seeds a controlled textarea with proposedText and applies the edit', async () => {
      const onApply = vi.fn()
      const onDecision = vi.fn()
      await renderSuccess({ onApply, onDecision, targetValue: 'previo' })

      fireEvent.click(screen.getAllByText('Editar')[0]!)
      const textarea = screen.getByLabelText('Editar propuesta') as HTMLTextAreaElement
      expect(textarea.value).toBe('Texto propuesto por Stella para la narrativa.')

      fireEvent.change(textarea, { target: { value: 'Versión editada por la persona.' } })
      fireEvent.click(screen.getByText('Aplicar edición'))

      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's-1' }),
        'Versión editada por la persona.'
      )
      const record: SuggestionDecisionRecord = onDecision.mock.calls[0]![0]
      expect(record.action).toBe('accepted_edited')
      expect(record.appliedText).toBe('Versión editada por la persona.')
    })

    it('Escape closes the edit form without applying', async () => {
      const onApply = vi.fn()
      await renderSuccess({ onApply, targetValue: 'previo' })
      fireEvent.click(screen.getAllByText('Editar')[0]!)
      expect(screen.queryByLabelText('Editar propuesta')).not.toBeNull()
      fireEvent.keyDown(screen.getByTestId('stella-suggestion-s-1'), { key: 'Escape' })
      expect(screen.queryByLabelText('Editar propuesta')).toBeNull()
      expect(onApply).not.toHaveBeenCalled()
    })

    it('Rechazar captures an optional reason and reports the decision', async () => {
      const onApply = vi.fn()
      const onDecision = vi.fn()
      await renderSuccess({ onApply, onDecision, targetValue: '' })

      const suggestion = screen.getByTestId('stella-suggestion-s-1')
      fireEvent.click(
        Array.from(suggestion.querySelectorAll('button')).find((b) =>
          /rechazar/i.test(b.textContent ?? '')
        )!
      )
      fireEvent.change(screen.getByLabelText(/motivo del rechazo/i), {
        target: { value: 'No refleja el programa' },
      })
      fireEvent.click(screen.getByText('Confirmar rechazo'))

      expect(onApply).not.toHaveBeenCalled()
      expect(screen.getByTestId('stella-suggestion-rejected-s-1')).not.toBeNull()
      const record: SuggestionDecisionRecord = onDecision.mock.calls[0]![0]
      expect(record.action).toBe('rejected')
      expect(record.rejectionReason).toBe('No refleja el programa')
      expect(record.appliedText).toBeUndefined()
    })

    it('Deshacer restores the previous value and reports "undone" with real displaced/restored values', async () => {
      const onDecision = vi.fn()
      success()
      render(<TargetHarness onDecision={onDecision} />)
      askStella()
      await waitFor(() => {
        expect(screen.queryAllByText('Aceptar').length).toBeGreaterThan(0)
      })

      fireEvent.click(screen.getAllByText('Aceptar')[0]!)
      expect(harnessTarget().value).toBe('Texto propuesto por Stella para la narrativa.')

      fireEvent.click(screen.getByText('Deshacer'))
      expect(harnessTarget().value).toBe('valor original')
      // Undo consumed the history entry — the affordance disappears.
      expect(screen.queryByText('Deshacer')).toBeNull()

      const undoneRecord: SuggestionDecisionRecord = onDecision.mock.calls[1]![0]
      expect(undoneRecord.action).toBe('undone')
      // appliedText = restored value; previousValue = value the undo displaced.
      expect(undoneRecord.appliedText).toBe('valor original')
      expect(undoneRecord.previousValue).toBe('Texto propuesto por Stella para la narrativa.')
    })

    it('REGRESSION (audit FIX 1): interleaved cross-suggestion applies undo as a global LIFO', async () => {
      // Repro from the audit: orig → apply s1(A) → apply s2(B). The old
      // per-suggestion undo restored `orig` from s1 (losing B) and could
      // then resurrect A from s2.
      const onDecision = vi.fn()
      success(TWO_SUGGESTIONS_OUTPUT)
      render(<TargetHarness onDecision={onDecision} initialValue="orig" />)
      askStella()
      await waitFor(() => {
        expect(screen.queryAllByText('Aceptar').length).toBe(2)
      })

      // apply s1(A), then apply s2(B)
      fireEvent.click(within(screen.getByTestId('stella-suggestion-s-1')).getByText('Aceptar'))
      expect(harnessTarget().value).toBe('Texto A')
      fireEvent.click(within(screen.getByTestId('stella-suggestion-s-2')).getByText('Aceptar'))
      expect(harnessTarget().value).toBe('Texto B')

      // s1 is NOT the top of the stack: its undo is disabled and explains why.
      const undoS1 = undoButtonIn('s-1')
      expect(undoS1.disabled).toBe(true)
      expect(undoS1.getAttribute('title')).toMatch(/aplicación más reciente/i)

      // Undoing s2 (top) restores A — it must NOT restore `orig`.
      fireEvent.click(undoButtonIn('s-2'))
      expect(harnessTarget().value).toBe('Texto A')
      const undoneS2: SuggestionDecisionRecord = onDecision.mock.calls[2]![0]
      expect(undoneS2.action).toBe('undone')
      expect(undoneS2.suggestionId).toBe('s-2')
      expect(undoneS2.previousValue).toBe('Texto B') // value actually displaced
      expect(undoneS2.appliedText).toBe('Texto A') // value actually restored

      // Now s1 is the top: undoing it restores the original value.
      const undoS1After = undoButtonIn('s-1')
      expect(undoS1After.disabled).toBe(false)
      fireEvent.click(undoS1After)
      expect(harnessTarget().value).toBe('orig')

      // Stack empty — no undo affordances remain.
      expect(screen.queryByText('Deshacer')).toBeNull()
    })

    it('stale undo (field edited after apply) requires an explicit confirmation', async () => {
      const onDecision = vi.fn()
      success()
      render(<TargetHarness onDecision={onDecision} />)
      askStella()
      await waitFor(() => {
        expect(screen.queryAllByText('Aceptar').length).toBeGreaterThan(0)
      })

      fireEvent.click(screen.getAllByText('Aceptar')[0]!)
      expect(harnessTarget().value).toBe('Texto propuesto por Stella para la narrativa.')

      // The user edits the field AFTER the apply.
      fireEvent.change(harnessTarget(), { target: { value: 'editado a mano' } })

      // Undo now requires confirmation — nothing changes yet.
      fireEvent.click(screen.getByText('Deshacer'))
      const confirm = screen.getByTestId('stella-undo-confirm-s-1')
      expect(confirm.getAttribute('role')).toBe('alertdialog')
      expect(harnessTarget().value).toBe('editado a mano')
      // Dialog receives focus so Escape works without tabbing.
      await waitFor(() => {
        expect(document.activeElement).toBe(confirm)
      })

      // Escape cancels without undoing.
      fireEvent.keyDown(confirm, { key: 'Escape' })
      expect(screen.queryByTestId('stella-undo-confirm-s-1')).toBeNull()
      expect(harnessTarget().value).toBe('editado a mano')

      // Confirmed undo restores the pre-apply value and records reality.
      fireEvent.click(screen.getByText('Deshacer'))
      fireEvent.click(screen.getByText('Confirmar deshacer'))
      expect(harnessTarget().value).toBe('valor original')
      const undone: SuggestionDecisionRecord = onDecision.mock.calls
        .map((c) => c[0] as SuggestionDecisionRecord)
        .find((r) => r.action === 'undone')!
      expect(undone.previousValue).toBe('editado a mano') // displaced user edit
      expect(undone.appliedText).toBe('valor original') // restored value
    })

    it('shows a copy-to-clipboard affordance instead of Aceptar when no onApply is wired', async () => {
      const onDecision = vi.fn()
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })

      await renderSuccess({ onDecision })
      expect(screen.queryByText('Aceptar')).toBeNull()
      expect(screen.queryByText('Editar')).toBeNull()

      fireEvent.click(screen.getByText('Copiar texto propuesto'))
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('Texto propuesto por Stella para la narrativa.')
        const record: SuggestionDecisionRecord = onDecision.mock.calls[0]![0]
        expect(record.action).toBe('copied')
      })
    })
  })

  // -------------------------------------------------------------------------
  // Error taxonomy (U5)
  // -------------------------------------------------------------------------
  describe('Error states', () => {
    async function renderError(code: string, message: string) {
      failure(code, message)
      render(<StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />)
      askStella()
      await waitFor(() => {
        expect(screen.queryByTestId('stella-error-notice')).not.toBeNull()
      })
      return screen.getByTestId('stella-error-notice')
    }

    it('QUOTA_EXCEEDED shows the server message verbatim', async () => {
      const message =
        'Alcanzaste el límite mensual de 50 consultas a Stella (usadas: 50). Se renueva el 1 de agosto de 2026.'
      const notice = await renderError('QUOTA_EXCEEDED', message)
      expect(notice.textContent).toContain(message)
      expect(notice.textContent).toMatch(/cuota mensual agotada/i)
    })

    it('RATE_LIMITED humanizes the ISO reset timestamp the server emits', async () => {
      // Real server format: rate-limit.ts always emits Date#toISOString().
      const notice = await renderError(
        'RATE_LIMITED',
        'Rate limit exceeded. Resets at 2026-06-26T15:00:00.000Z.'
      )
      expect(notice.textContent).toMatch(/límite de solicitudes por hora/i)
      expect(notice.textContent).toMatch(/se restablece a las 15:00 \(UTC\)/i)
      // The raw ISO string is no longer shown verbatim.
      expect(notice.textContent).not.toContain('2026-06-26T15:00:00.000Z')
    })

    it('RATE_LIMITED falls back gracefully when the reset info is not parseable', async () => {
      const notice = await renderError('RATE_LIMITED', 'Rate limit exceeded. Resets at soon-ish.')
      expect(notice.textContent).toMatch(/límite de solicitudes por hora/i)
      expect(notice.textContent).toContain('soon-ish')
    })

    it('TIMEOUT offers Reintentar and retry re-invokes the action', async () => {
      await renderError('TIMEOUT', 'Stella request timed out. Please try again.')
      expect(screen.queryByText(/tardó demasiado/i)).not.toBeNull()
      success()
      fireEvent.click(screen.getByText('Reintentar'))
      await waitFor(() => {
        expect(mockGetStellaContextualAdvisor).toHaveBeenCalledTimes(2)
        expect(screen.queryByTestId('stella-contextual-result')).not.toBeNull()
      })
    })

    it('RATE_LIMIT_UNAVAILABLE offers Reintentar', async () => {
      await renderError('RATE_LIMIT_UNAVAILABLE', 'Stella rate limit service is temporarily unavailable.')
      expect(screen.queryByText('Reintentar')).not.toBeNull()
    })

    it('PAYLOAD_TOO_LARGE explains reducing text', async () => {
      const notice = await renderError('PAYLOAD_TOO_LARGE', 'El contexto del proyecto es demasiado grande para Stella.')
      expect(notice.textContent).toMatch(/reducí la cantidad de texto/i)
    })

    it('UNAUTHORIZED shows the role message', async () => {
      const notice = await renderError('UNAUTHORIZED', 'Tu rol no tiene permiso para usar Stella.')
      expect(notice.textContent).toContain('Tu rol no tiene permiso para usar Stella.')
    })

    it('distinct codes render distinct messages (GEMINI_ERROR vs PARSE_ERROR vs AUDIT_ERROR)', async () => {
      const gemini = await renderError('GEMINI_ERROR', 'x')
      const geminiText = gemini.textContent
      cleanup()
      const parse = await renderError('PARSE_ERROR', 'x')
      const parseText = parse.textContent
      cleanup()
      const audit = await renderError('AUDIT_ERROR', 'x')
      expect(geminiText).not.toBe(parseText)
      expect(parseText).not.toBe(audit.textContent)
    })

    it('errors render inside the assertive live region with role="alert" and receive focus', async () => {
      const notice = await renderError('GEMINI_ERROR', 'x')
      expect(notice.getAttribute('role')).toBe('alert')
      const assertive = screen.getByTestId('stella-contextual-live-assertive')
      expect(assertive.contains(notice)).toBe(true)
      await waitFor(() => {
        expect((document.activeElement as HTMLElement | null)?.contains(notice)).toBe(true)
      })
    })

    it('handles thrown exceptions as UNKNOWN_ERROR', async () => {
      mockGetStellaContextualAdvisor.mockRejectedValue(new Error('boom'))
      render(<StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />)
      askStella()
      await waitFor(() => {
        expect(screen.getByTestId('stella-error-notice').getAttribute('data-error-code')).toBe(
          'UNKNOWN_ERROR'
        )
      })
    })
  })

  // -------------------------------------------------------------------------
  // Availability (U5)
  // -------------------------------------------------------------------------
  describe('Disabled availability', () => {
    it('renders an inert informative state when enabled={false} and never calls the action', () => {
      render(<StellaContextualAdvisorPanel projectId="proj-1" step="narrative" enabled={false} />)
      expect(screen.queryByTestId('stella-contextual-disabled')).not.toBeNull()
      const btn = screen.getByText(/analizar con stella/i).closest('button')
      expect(btn?.disabled).toBe(true)
      fireEvent.click(screen.getByText(/analizar con stella/i))
      expect(mockGetStellaContextualAdvisor).not.toHaveBeenCalled()
    })

    it('stays mounted with an informative state when the action returns DISABLED post-click', async () => {
      failure('DISABLED', 'Stella Advisor is not enabled.')
      const { container } = render(
        <StellaContextualAdvisorPanel projectId="proj-1" step="narrative" />
      )
      askStella()
      await waitFor(() => {
        expect(screen.queryByTestId('stella-contextual-disabled')).not.toBeNull()
      })
      expect(container.firstChild).not.toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Heading hierarchy (U6)
  // -------------------------------------------------------------------------
  describe('Heading hierarchy', () => {
    it('uses h2 for the title and h3 for subsections by default', async () => {
      await renderSuccess()
      const panel = screen.getByTestId('stella-contextual-advisor-panel')
      expect(panel.querySelector('h2')?.textContent).toMatch(/stella/i)
      const h3s = Array.from(panel.querySelectorAll('h3')).map((h) => h.textContent)
      expect(h3s.some((t) => /resumen/i.test(t ?? ''))).toBe(true)
      expect(panel.querySelector('h4')).toBeNull()
    })

    it('respects headingLevel={3}', async () => {
      await renderSuccess({ headingLevel: 3 })
      const panel = screen.getByTestId('stella-contextual-advisor-panel')
      expect(panel.querySelector('h3')?.textContent).toMatch(/stella/i)
      expect(panel.querySelector('h2')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security invariants', () => {
    it('does not claim certification in rendered content', async () => {
      await renderSuccess()
      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/certific/i)
      expect(text).not.toMatch(/impacto garantizado/i)
    })

    it('all lifecycle buttons are type="button" (safe inside forms)', async () => {
      await renderSuccess({ onApply: vi.fn(), targetValue: 'x' })
      const panel = screen.getByTestId('stella-contextual-advisor-panel')
      for (const button of Array.from(panel.querySelectorAll('button'))) {
        expect(button.getAttribute('type')).toBe('button')
      }
    })
  })

  // -------------------------------------------------------------------------
  // TRAIN 2 — grounded evidence seam (INTEGRATION-001)
  // -------------------------------------------------------------------------
  describe('Grounded evidence seam', () => {
    it('renders nothing grounded unless a caller supplies an adapted answer', async () => {
      await renderSuccess()
      expect(screen.queryByTestId('stella-grounded-answer-panel')).not.toBeInTheDocument()
    })

    it('renders the grounded answer a caller hands it', () => {
      render(
        <StellaContextualAdvisorPanel
          projectId="proj-1"
          step="narrative"
          groundedAnswer={groundedAnswerView()}
        />
      )
      expect(screen.getByTestId('stella-grounded-answer-panel')).toHaveAttribute(
        'data-status',
        'grounded'
      )
    })

    it('does not tie grounded evidence to the advisor request — it does not come from that action', () => {
      // The contextual advisor action does not consume retrieval. Showing the
      // grounded panel only after "Analizar con Stella" would imply it did.
      render(
        <StellaContextualAdvisorPanel
          projectId="proj-1"
          step="narrative"
          groundedAnswer={groundedAnswerView()}
        />
      )
      expect(screen.getByTestId('stella-grounded-answer-panel')).toBeInTheDocument()
      expect(mockGetStellaContextualAdvisor).not.toHaveBeenCalled()
    })

    it('forwards grounded citation navigation to the caller', () => {
      const onNavigateCitation = vi.fn()
      const answer = groundedAnswerView()
      render(
        <StellaContextualAdvisorPanel
          projectId="proj-1"
          step="narrative"
          groundedAnswer={answer}
          onNavigateCitation={onNavigateCitation}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /informe-2025\.pdf/ }))
      expect(onNavigateCitation).toHaveBeenCalledWith(answer.claims[0].citations[0])
    })

    it('leaves the accept / edit / reject / undo workflow untouched while grounded evidence is mounted', async () => {
      const onDecision = vi.fn()
      success(TWO_SUGGESTIONS_OUTPUT)
      render(
        <TargetHarness
          onDecision={onDecision}
          initialValue="valor inicial"
          groundedAnswer={groundedAnswerView()}
        />
      )
      askStella()
      await waitFor(() => expect(screen.queryByTestId('stella-contextual-result')).not.toBeNull())
      expect(screen.getByTestId('stella-grounded-answer-panel')).toBeInTheDocument()

      fireEvent.click(within(screen.getByTestId('stella-suggestion-s-1')).getByText('Aceptar'))
      expect(harnessTarget().value).toBe('Texto A')

      fireEvent.click(undoButtonIn('s-1'))
      expect(harnessTarget().value).toBe('valor inicial')

      fireEvent.click(within(screen.getByTestId('stella-suggestion-s-2')).getByText('Rechazar'))
      fireEvent.click(screen.getByText('Confirmar rechazo'))

      expect(onDecision.mock.calls.map((call) => call[0].action)).toEqual([
        'accepted',
        'undone',
        'rejected',
      ])
    })
  })
})
