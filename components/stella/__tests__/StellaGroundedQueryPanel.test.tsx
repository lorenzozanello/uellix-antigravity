// @vitest-environment jsdom
// components/stella/__tests__/StellaGroundedQueryPanel.test.tsx
// PRODUCT TRAIN 3 — the real request/response loop, from asking a question
// to a GroundedAnswerView, through to the human decision.
//
// `runQuery` is always an injected `vi.fn()` here: this component never
// retrieves, never calls a provider and never validates scope on its own —
// see grounded-query.ts. Every fixture answer comes from grounded-fixtures.ts
// (the real adapter over real contract values), never a hand-written view.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaGroundedQueryPanel } from '../StellaGroundedQueryPanel'
import type { StellaGroundedQueryResult, StellaGroundedQueryRunner } from '../grounded-query'
import type { SuggestionDecisionRecord } from '../decision-types'
import {
  REPORT_TEXT,
  abstainedAnswerView,
  allClaimKindsAnswerView,
  contradictedAnswerView,
  groundedAnswerView,
  partiallyGroundedAnswerView,
  unresolvedAnswerView,
} from './grounded-fixtures'

async function ask(query = '¿Cuántos beneficiarios reporta el informe?') {
  const textbox = screen.getByRole('textbox', { name: 'Pregunta para Stella' })
  fireEvent.change(textbox, { target: { value: query } })
  fireEvent.click(screen.getByRole('button', { name: /Preguntar a Stella/ }))
}

function okResult(answer = groundedAnswerView(), answerId = 'answer-1'): StellaGroundedQueryResult {
  return { status: 'ok', answerId, answer }
}

describe('StellaGroundedQueryPanel — grounded states', () => {
  it('renders a grounded answer end to end from a real runQuery call', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult())
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)

    await ask()

    expect(runQuery).toHaveBeenCalledWith({ query: '¿Cuántos beneficiarios reporta el informe?' })
    expect(await screen.findByTestId('stella-grounded-answer-panel')).toHaveAttribute(
      'data-status',
      'grounded',
    )
    expect(screen.getByText(REPORT_TEXT)).toBeInTheDocument()
  })

  it('renders a partially grounded answer', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(partiallyGroundedAnswerView()))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    expect(await screen.findByTestId('stella-grounded-answer-panel')).toHaveAttribute(
      'data-status',
      'partially_grounded',
    )
  })

  it('renders an attributed contradiction', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(contradictedAnswerView()))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    expect(await screen.findByTestId('stella-contradiction-contra-1')).toBeInTheDocument()
  })

  it('renders an abstention with no evidence at all', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(abstainedAnswerView()))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    expect(await screen.findByTestId('stella-grounded-answer-abstention')).toHaveAttribute(
      'data-abstention-code',
      'no_matching_evidence',
    )
  })

  it('renders a citation whose passage is unavailable instead of inventing one', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(unresolvedAnswerView()))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    expect(await screen.findByTestId('stella-grounded-answer-unresolved')).toHaveTextContent(
      'Una cita no pudo mostrar su pasaje',
    )
  })

  it('shows a loading state while runQuery is pending', async () => {
    let resolve: (value: StellaGroundedQueryResult) => void = () => {}
    const runQuery: StellaGroundedQueryRunner = vi.fn(
      () => new Promise<StellaGroundedQueryResult>((res) => { resolve = res }),
    )
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    expect(screen.getByTestId('stella-grounded-query-loading')).toBeInTheDocument()
    resolve(okResult())
    await waitFor(() => expect(screen.queryByTestId('stella-grounded-query-loading')).not.toBeInTheDocument())
  })
})

describe('StellaGroundedQueryPanel — availability, permission, quota, provider failure', () => {
  it('renders permission denied without a retry affordance', async () => {
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValue({ status: 'error', code: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso.' })
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    const notice = await screen.findByTestId('stella-error-notice')
    expect(notice).toHaveAttribute('data-error-code', 'UNAUTHORIZED')
    expect(screen.queryByRole('button', { name: /Reintentar/ })).not.toBeInTheDocument()
  })

  it('renders quota reached with the server message verbatim', async () => {
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValue({ status: 'error', code: 'QUOTA_EXCEEDED', message: 'Cuota de 100 agotada.' })
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    const notice = await screen.findByTestId('stella-error-notice')
    expect(notice).toHaveAttribute('data-error-code', 'QUOTA_EXCEEDED')
    expect(notice).toHaveTextContent('Cuota de 100 agotada.')
  })

  it('renders a provider failure as retryable', async () => {
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValue({ status: 'error', code: 'GEMINI_ERROR', message: '' })
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    const notice = await screen.findByTestId('stella-error-notice')
    expect(notice).toHaveAttribute('data-error-code', 'GEMINI_ERROR')
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeInTheDocument()
  })

  it('renders the inert disabled state when the runner answers DISABLED post-click', async () => {
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValue({ status: 'error', code: 'DISABLED', message: '' })
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    expect(await screen.findByTestId('stella-grounded-query-disabled')).toBeInTheDocument()
    expect(screen.queryByTestId('stella-error-notice')).not.toBeInTheDocument()
  })

  it('never calls runQuery when the feature flag is off (enabled=false)', () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn()
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} enabled={false} />)
    expect(screen.getByTestId('stella-grounded-query-disabled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Preguntar a Stella/ })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Pregunta para Stella' }), {
      target: { value: 'hola' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Preguntar a Stella/ }))
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('StellaGroundedQueryPanel — retry', () => {
  it('resubmits the exact same last query on retry, not the current draft', async () => {
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValueOnce({ status: 'error', code: 'TIMEOUT', message: '' })
      .mockResolvedValueOnce(okResult())
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)

    await ask('primera pregunta')
    await screen.findByTestId('stella-error-notice')

    // The user edits the draft after the failure but before retrying.
    fireEvent.change(screen.getByRole('textbox', { name: 'Pregunta para Stella' }), {
      target: { value: 'una pregunta distinta sin enviar' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }))

    await screen.findByTestId('stella-grounded-answer-panel')
    expect(runQuery).toHaveBeenCalledTimes(2)
    expect(runQuery).toHaveBeenNthCalledWith(2, { query: 'primera pregunta' })
  })
})

describe('StellaGroundedQueryPanel — navigation', () => {
  it('forwards a citation click to the caller', async () => {
    const onNavigateCitation = vi.fn()
    const answer = groundedAnswerView()
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(answer))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} onNavigateCitation={onNavigateCitation} />)
    await ask()
    await screen.findByTestId('stella-grounded-answer-panel')

    fireEvent.click(screen.getByRole('button', { name: /informe-2025\.pdf/ }))
    expect(onNavigateCitation).toHaveBeenCalledWith(answer.claims[0].citations[0])
  })
})

describe('StellaGroundedQueryPanel — human decision workflow', () => {
  function setup(step: Parameters<typeof StellaGroundedQueryPanel>[0]['step'] = 'evidence') {
    const onDecision = vi.fn<(record: SuggestionDecisionRecord) => void>()
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(groundedAnswerView(), 'answer-42'))
    render(<StellaGroundedQueryPanel step={step} runQuery={runQuery} onDecision={onDecision} />)
    return { onDecision, runQuery }
  }

  it('never presents a fresh answer as already approved', async () => {
    setup()
    await ask()
    expect(await screen.findByTestId('stella-grounded-answer-decision')).toHaveTextContent(
      'Requiere aprobación humana',
    )
  })

  it('accept marks the answer accepted and reports the decision', async () => {
    const { onDecision } = setup()
    await ask()
    await screen.findByTestId('stella-grounded-answer-decision')

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }))

    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent('Aceptada')
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ suggestionId: 'answer-42', step: 'evidence', action: 'accepted' }),
    )
  })

  it('accept with comment requires a non-empty comment and carries it as appliedText', async () => {
    const { onDecision } = setup()
    await ask()
    await screen.findByTestId('stella-grounded-answer-decision')

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar con comentario' }))
    // Entering edit mode replaces the action row: the toggle is gone, the
    // confirm button is disabled until a comment is typed.
    expect(screen.getByRole('button', { name: /Aceptar con comentario/ })).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Comentario del revisor/), {
      target: { value: 'Verificado contra el anexo físico.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Aceptar con comentario/ }))

    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent('Aceptada con ediciones')
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'accepted_edited',
        appliedText: 'Verificado contra el anexo físico.',
      }),
    )
  })

  it('reject captures an optional reason', async () => {
    const { onDecision } = setup()
    await ask()
    await screen.findByTestId('stella-grounded-answer-decision')

    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Motivo del rechazo/ }), {
      target: { value: 'La cifra no coincide con el corte de mes.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar rechazo' }))

    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent('Rechazada')
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rejected', rejectionReason: 'La cifra no coincide con el corte de mes.' }),
    )
  })

  it('undo records the reversal, shows it honestly (not as "pending") and re-enables the actions', async () => {
    const { onDecision } = setup()
    await ask()
    await screen.findByTestId('stella-grounded-answer-decision')

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }))
    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent('Aceptada')
    expect(screen.getByRole('button', { name: 'Aceptar' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))

    // decisionStatusFromAction('undone') is its own terminal status ('Deshecha'),
    // not a reset to unreviewed — same rule the suggestion-lifecycle already uses.
    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent('Deshecha')
    expect(screen.getByRole('button', { name: 'Aceptar' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Deshacer' })).not.toBeInTheDocument()
    expect(onDecision).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'undone' }))
  })

  it('does nothing when onDecision is not supplied', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult())
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    await screen.findByTestId('stella-grounded-answer-decision')
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }))).not.toThrow()
  })
})

describe('StellaGroundedQueryPanel — what a claim shows', () => {
  it('shows excerpt, source, location, support level and score for the citation backing a claim', async () => {
    const answer = groundedAnswerView()
    const citation = answer.claims[0]!.citations[0]!
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(answer))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()

    const claim = await screen.findByTestId(`stella-grounded-claim-${answer.claims[0]!.key}`)
    const cited = within(claim).getByTestId(`stella-grounded-citation-${citation.key}`)

    // Excerpt — derived from the chunk text, never invented (INTEGRATION-001 §4).
    expect(cited).toHaveTextContent(REPORT_TEXT)
    // Source and structured location, rendered from the citation's own values.
    expect(cited).toHaveTextContent('informe-2025.pdf')
    expect(cited).toHaveTextContent(citation.location.label)
    // Support level of the claim.
    expect(claim).toHaveAttribute('data-claim-kind', 'evidence')
    expect(within(claim).getByTestId('stella-grounding-badge')).toBeInTheDocument()
    // Score — shown next to the bucket, never replaced by it (INTEGRATION-001 §6).
    expect(cited).toHaveAttribute('data-relevance', citation.relevance!.bucket)
    expect(cited).toHaveTextContent(citation.relevance!.score.toFixed(2))
  })

  it('distinguishes evidence, inference, recommendation and absence of evidence', async () => {
    const answer = allClaimKindsAnswerView()
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(answer))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    await screen.findByTestId('stella-grounded-answer-panel')

    const kinds = answer.claims.map(
      (claim) => screen.getByTestId(`stella-grounded-claim-${claim.key}`).getAttribute('data-claim-kind'),
    )
    expect(kinds).toEqual(['evidence', 'inference', 'recommendation', 'absence'])

    // Each kind carries the thing that makes it that kind, visibly.
    expect(screen.getByText('Evidencia')).toBeInTheDocument()
    expect(screen.getByTestId('stella-claim-inference-basis-inference-1')).toHaveTextContent(
      'Paso de razonamiento:',
    )
    expect(screen.getByText('Recomendación')).toBeInTheDocument()
    expect(screen.getByTestId('stella-claim-abstention-absence-3')).toHaveAttribute(
      'data-abstention-code',
      'below_relevance_threshold',
    )
  })

  it('keeps the human decision outside the claims: a decision is not a fifth kind of claim', async () => {
    const answer = allClaimKindsAnswerView()
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult(answer))
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask()
    await screen.findByTestId('stella-grounded-answer-panel')

    const actions = screen.getByTestId('stella-grounded-query-decision-actions')
    for (const claim of answer.claims) {
      expect(screen.getByTestId(`stella-grounded-claim-${claim.key}`)).not.toContainElement(actions)
    }
    // …and the answer still says the decision has not been taken.
    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent(
      'Requiere aprobación humana',
    )
  })
})

describe('StellaGroundedQueryPanel — no decision is emitted while the backend is unavailable', () => {
  it('offers no decision surface and never emits a decision when the flag is off', () => {
    const onDecision = vi.fn()
    const runQuery: StellaGroundedQueryRunner = vi.fn()
    render(
      <StellaGroundedQueryPanel step="evidence" runQuery={runQuery} enabled={false} onDecision={onDecision} />,
    )
    expect(screen.queryByTestId('stella-grounded-query-decision-actions')).not.toBeInTheDocument()
    expect(onDecision).not.toHaveBeenCalled()
  })

  it('offers no decision surface when the runner answers DISABLED', async () => {
    const onDecision = vi.fn()
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValue({ status: 'error', code: 'DISABLED', message: '' })
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} onDecision={onDecision} />)
    await ask()
    await screen.findByTestId('stella-grounded-query-disabled')
    expect(screen.queryByTestId('stella-grounded-query-decision-actions')).not.toBeInTheDocument()
    expect(onDecision).not.toHaveBeenCalled()
  })

  it('offers no decision surface on a provider failure, and a retry does not carry one over', async () => {
    const onDecision = vi.fn()
    const runQuery: StellaGroundedQueryRunner = vi
      .fn()
      .mockResolvedValueOnce(okResult(groundedAnswerView(), 'answer-7'))
      .mockResolvedValueOnce({ status: 'error', code: 'GEMINI_ERROR', message: '' })
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} onDecision={onDecision} />)

    await ask()
    await screen.findByTestId('stella-grounded-answer-decision')
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }))
    expect(onDecision).toHaveBeenCalledTimes(1)

    // The second call fails: the accepted answer is gone, and so is its decision.
    fireEvent.click(screen.getByRole('button', { name: /Preguntar a Stella/ }))
    await screen.findByTestId('stella-error-notice')
    expect(screen.queryByTestId('stella-grounded-query-decision-actions')).not.toBeInTheDocument()
    expect(onDecision).toHaveBeenCalledTimes(1)
  })
})

describe('StellaGroundedQueryPanel — zero scope logic, zero retrieval in the UI', () => {
  // Strips block comments and whole-line `//` comments — nothing more. That is
  // enough for what these scans assert: every mention they must tolerate (the
  // adapter naming `validateAnswerCitations` to explain why it does NOT call
  // it, grounded-query.ts naming organizationId to forbid it) lives in a
  // comment. A real tokenizer here would be a second parser to keep correct.
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  }

  const FLOW_FILES = ['grounded-query.ts', 'StellaGroundedQueryPanel.tsx'] as const

  it('sends the query and nothing else: scope never travels from the client', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult())
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    await ask('una pregunta')

    // Not `toHaveBeenCalledWith`: that would pass for a request carrying an
    // extra organizationId alongside the query. The KEY SET is the assertion.
    const request = vi.mocked(runQuery).mock.calls[0]![0]
    expect(Object.keys(request)).toEqual(['query'])
  })

  it('names no organization and no project anywhere in the grounded-query flow', () => {
    for (const file of FLOW_FILES) {
      const code = stripComments(readFileSync(path.join(process.cwd(), 'components/stella', file), 'utf8'))
      expect(code, file).not.toMatch(/\borganizationId\b/)
      expect(code, file).not.toMatch(/\bprojectId\b/)
      expect(code, file).not.toMatch(/\bscope\b/)
    }
  })

  it('performs no retrieval, no provider call and no I/O in ANY Stella component', () => {
    // Scoped to the whole package, not to this flow: the guarantee is worth
    // nothing if the panel stays clean while a sibling starts retrieving and
    // hands it the result. `components/stella/**` is a presentation layer.
    const dir = path.join(process.cwd(), 'components/stella')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(5)

    const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
      [/\bretrieveGroundedChunks\b/, 'retrieval'],
      [/\bbuildGroundedAnswer\b/, 'answer construction'],
      [/\bvalidateAnswerCitations\b/, 'citation validation (a scope gate)'],
      [/\bscopeContains\b/, 'scope containment'],
      [/\bfetch\s*\(/, 'network I/O'],
      [/\bXMLHttpRequest\b/, 'network I/O'],
      [/'use server'/, 'a server action defined inside a component'],
      [/from '@\/db\//, 'a database import'],
    ]

    const offenders: string[] = []
    for (const file of files) {
      const code = stripComments(readFileSync(path.join(dir, file), 'utf8'))
      for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${file}: ${what}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('StellaGroundedQueryPanel — accessibility', () => {
  it('is a labelled landmark region with live regions for loading/result and errors', () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult())
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} />)
    expect(screen.getByRole('region', { name: 'Preguntar a Stella' })).toBeInTheDocument()
    expect(screen.getByTestId('stella-grounded-query-live-polite')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('stella-grounded-query-live-assertive')).toHaveAttribute('aria-live', 'assertive')
  })

  it('adapts the panel heading level and passes level+1 down to the grounded answer panel', async () => {
    const runQuery: StellaGroundedQueryRunner = vi.fn().mockResolvedValue(okResult())
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runQuery} headingLevel={2} title="Título" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Título' })).toBeInTheDocument()
    await ask()
    await screen.findByTestId('stella-grounded-answer-panel')
    expect(screen.getByRole('heading', { level: 3, name: 'Respuesta fundamentada de Stella' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ADVERSARIAL REVIEW, TRAIN 3 (reviewer B, #12) — a decision nobody receives
// must not LOOK like a decision that was filed.
// ---------------------------------------------------------------------------
//
// `decisionStatus` flips to "Aceptada" / "Rechazada" the instant the button is
// pressed, and StellaGroundedAnswerPanel paints that badge exactly as it does
// for flows whose decisions ARE written by recordStellaDecision. With no
// `onDecision` wired the record dies on unmount, so the badge alone would tell
// a reviewer their decision was saved when it was not.

describe('StellaGroundedQueryPanel — a decision with no sink says so', () => {
  const okAnswer = groundedAnswerView()
  const runOk: StellaGroundedQueryRunner = async () => ({
    status: 'ok',
    answerId: 'ans-persistence',
    answer: okAnswer,
  })

  async function askAndAccept(onDecision?: (record: SuggestionDecisionRecord) => void) {
    render(<StellaGroundedQueryPanel step="evidence" runQuery={runOk} onDecision={onDecision} />)
    await ask()
    await screen.findByTestId('stella-grounded-answer-panel')
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }))
  }

  it('states that the decision was not saved when no onDecision is wired', async () => {
    await askAndAccept()
    const note = await screen.findByTestId('stella-grounded-query-decision-not-persisted')
    expect(note).toHaveTextContent(/no se guardó/i)
    expect(note).toHaveTextContent(/sólo en esta sesión/i)
  })

  it('does NOT state it when a sink IS wired — the note is about absence, not about grounded answers', async () => {
    await askAndAccept(vi.fn())
    expect(screen.queryByTestId('stella-grounded-query-decision-not-persisted')).toBeNull()
  })

  it('the note appears alongside the decision badge, not instead of it', async () => {
    // The affordance is not hidden and the outcome is not faked: the reviewer
    // sees both what they decided and that it was not filed.
    await askAndAccept()
    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent('Aceptada')
    expect(screen.getByTestId('stella-grounded-query-decision-not-persisted')).toBeTruthy()
  })
})
