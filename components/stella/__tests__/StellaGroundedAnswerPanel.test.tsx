// @vitest-environment jsdom
// components/stella/__tests__/StellaGroundedAnswerPanel.test.tsx
// PRODUCT TRAIN 2 — the presentation half of INTEGRATION-001.
//
// Every fixture here is produced by running the real adapter over real
// GROUNDING contract values (see grounded-fixtures.ts), so a test that passes
// says the component renders something the adapter can actually produce.

import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaGroundedAnswerPanel } from '../StellaGroundedAnswerPanel'
import {
  REPORT_TEXT,
  abstainedAnswerView,
  contradictedAnswerView,
  groundedAnswerView,
  partiallyGroundedAnswerView,
  unresolvedAnswerView,
} from './grounded-fixtures'

describe('StellaGroundedAnswerPanel — support levels', () => {
  it('renders a grounded answer with its claim, its badge and its excerpt', () => {
    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} />)

    expect(screen.getByTestId('stella-grounded-answer-panel')).toHaveAttribute('data-status', 'grounded')
    expect(screen.getAllByTestId('stella-grounding-badge')[0]).toHaveAttribute(
      'data-support-level',
      'grounded',
    )
    expect(screen.getByText('El proyecto reporta 1.240 beneficiarios directos.')).toBeInTheDocument()
    expect(screen.getByText(REPORT_TEXT)).toBeInTheDocument()
  })

  it('renders partial evidence as partially_grounded and states what was not answered', () => {
    render(<StellaGroundedAnswerPanel answer={partiallyGroundedAnswerView()} />)

    expect(screen.getAllByTestId('stella-grounding-badge')[0]).toHaveAttribute(
      'data-support-level',
      'partially_grounded',
    )
    const abstention = screen.getByTestId('stella-grounded-answer-abstention')
    expect(abstention).toHaveAttribute('data-abstention-code', 'below_relevance_threshold')
    expect(abstention).toHaveTextContent('Evidencia insuficientemente relacionada')
    expect(abstention).toHaveTextContent('Candidatos inspeccionados: 6')
  })

  it('renders an abstention with no claims and no citations at all', () => {
    render(<StellaGroundedAnswerPanel answer={abstainedAnswerView()} />)

    expect(screen.getByTestId('stella-grounded-answer-panel')).toHaveAttribute('data-status', 'abstained')
    expect(screen.getAllByTestId('stella-grounding-badge')[0]).toHaveAttribute(
      'data-support-level',
      'insufficient_evidence',
    )
    expect(screen.queryByRole('list', { name: 'Afirmaciones' })).not.toBeInTheDocument()
    expect(screen.getByTestId('stella-grounded-answer-abstention')).toHaveAttribute(
      'data-abstention-code',
      'no_matching_evidence',
    )
  })

  it('renders an absence claim with its own abstention instead of a silent gap', () => {
    render(<StellaGroundedAnswerPanel answer={partiallyGroundedAnswerView()} />)

    const claim = screen.getByTestId('stella-grounded-claim-absence-1')
    expect(claim).toHaveAttribute('data-claim-kind', 'absence')
    expect(within(claim).getByTestId('stella-grounding-badge')).toHaveAttribute(
      'data-support-level',
      'insufficient_evidence',
    )
    expect(within(claim).getByTestId('stella-claim-abstention-absence-1')).toBeInTheDocument()
    expect(within(claim).getByTestId('stella-evidence-panel-empty')).toBeInTheDocument()
  })

  it('states how many citations could not show their passage', () => {
    render(<StellaGroundedAnswerPanel answer={unresolvedAnswerView()} />)

    expect(screen.getByTestId('stella-grounded-answer-unresolved')).toHaveTextContent(
      'Una cita no pudo mostrar su pasaje',
    )
    expect(screen.queryByText(REPORT_TEXT)).not.toBeInTheDocument()
  })
})

describe('StellaGroundedAnswerPanel — contradiction (INTEGRATION-001 §7)', () => {
  it('renders both sides of a ContradictionMarker and refuses to resolve it', () => {
    render(<StellaGroundedAnswerPanel answer={contradictedAnswerView()} />)

    expect(screen.getAllByTestId('stella-grounding-badge')[0]).toHaveAttribute(
      'data-support-level',
      'contradictory_evidence',
    )
    const contradiction = screen.getByTestId('stella-contradiction-contra-1')
    expect(contradiction).toHaveAttribute('data-severity', 'warning')
    expect(contradiction).toHaveTextContent('Lado A')
    expect(contradiction).toHaveTextContent('Lado B')
    expect(contradiction).toHaveTextContent('Requiere resolución humana')
  })

  it('shows no contradiction section when no marker exists, however incompatible the claims read', () => {
    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} />)
    expect(screen.queryByTestId('stella-grounded-answer-contradictions')).not.toBeInTheDocument()
  })
})

describe('StellaGroundedAnswerPanel — human decision workflow', () => {
  it('always states that human approval is still required', () => {
    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} />)

    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent(
      'Requiere aprobación humana',
    )
    expect(screen.getByText(/Se requiere revisión humana antes de su uso externo/)).toBeInTheDocument()
  })

  it('says so even for an answer that abstained — an abstention is not an approval', () => {
    render(<StellaGroundedAnswerPanel answer={abstainedAnswerView()} />)
    expect(screen.getByTestId('stella-grounded-answer-decision')).toHaveTextContent(
      'Requiere aprobación humana',
    )
  })
})

describe('StellaGroundedAnswerPanel — navigation', () => {
  it('forwards a citation click to the caller, which owns what "go there" means', () => {
    const onNavigateCitation = vi.fn()
    const answer = groundedAnswerView()
    render(<StellaGroundedAnswerPanel answer={answer} onNavigateCitation={onNavigateCitation} />)

    fireEvent.click(screen.getByRole('button', { name: /informe-2025\.pdf/ }))
    expect(onNavigateCitation).toHaveBeenCalledWith(answer.claims[0].citations[0])
  })

  it('forwards clicks from both sides of a contradiction', () => {
    const onNavigateCitation = vi.fn()
    render(
      <StellaGroundedAnswerPanel
        answer={contradictedAnswerView()}
        onNavigateCitation={onNavigateCitation}
      />,
    )

    const contradiction = screen.getByTestId('stella-contradiction-contra-1')
    const buttons = within(contradiction).getAllByRole('button')
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    expect(onNavigateCitation).toHaveBeenCalledTimes(2)
    expect(onNavigateCitation.mock.calls[0][0].chunkId).not.toBe(
      onNavigateCitation.mock.calls[1][0].chunkId,
    )
  })

  it('renders no interactive control when the caller supplies no navigation handler', () => {
    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('StellaGroundedAnswerPanel — accessibility', () => {
  it('is a labelled landmark region', () => {
    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} />)
    expect(
      screen.getByRole('region', { name: 'Respuesta fundamentada de Stella' }),
    ).toBeInTheDocument()
  })

  it('adapts its heading levels to the host page instead of hardcoding h3', () => {
    const { unmount } = render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Respuesta fundamentada de Stella' })).toBeInTheDocument()
    unmount()

    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} headingLevel={4} />)
    expect(screen.getByRole('heading', { level: 4, name: 'Respuesta fundamentada de Stella' })).toBeInTheDocument()
  })

  it('names every list it renders', () => {
    render(<StellaGroundedAnswerPanel answer={groundedAnswerView()} />)
    expect(screen.getByRole('list', { name: 'Afirmaciones' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Citas fundamentadas' })).toBeInTheDocument()
  })

  it('exposes the abstention and the unresolved-source warning as notes, not as decoration', () => {
    render(<StellaGroundedAnswerPanel answer={unresolvedAnswerView()} />)
    const notes = screen.getAllByRole('note')
    expect(notes.length).toBeGreaterThan(0)
  })

  it('hides decorative icons from the accessibility tree', () => {
    const { container } = render(<StellaGroundedAnswerPanel answer={contradictedAnswerView()} />)
    const icons = container.querySelectorAll('svg')
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
