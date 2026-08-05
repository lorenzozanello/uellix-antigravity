// @vitest-environment jsdom
// components/stella/__tests__/StellaEvidencePanel.test.tsx
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaEvidencePanel } from '../StellaEvidencePanel'
import { ANNEX_TEXT, REPORT_TEXT, loadedCitationView, unavailableCitationView } from './grounded-fixtures'

describe('StellaEvidencePanel', () => {
  it('renders one item per reference with its label', () => {
    render(
      <StellaEvidencePanel
        references={[
          { sourceField: 'outcomesSnapshot[0].name', label: 'Resultados › n.º 1 › nombre' },
          { sourceField: 'narrativeSummary', label: 'Resumen narrativo' },
        ]}
      />
    )
    expect(screen.getByText('Resultados › n.º 1 › nombre')).toBeInTheDocument()
    expect(screen.getByText('Resumen narrativo')).toBeInTheDocument()
  })

  it('renders a graceful empty state instead of an empty list when there are no references', () => {
    render(<StellaEvidencePanel references={[]} />)
    expect(screen.getByTestId('stella-evidence-panel-empty')).toBeInTheDocument()
  })

  it('renders plain (non-interactive) chips when onNavigate is not provided', () => {
    render(<StellaEvidencePanel references={[{ sourceField: 'narrativeSummary', label: 'Resumen narrativo' }]} />)
    expect(screen.queryByRole('button', { name: /Resumen narrativo/ })).not.toBeInTheDocument()
  })

  it('renders navigable buttons and calls onNavigate with the clicked reference when onNavigate is provided', () => {
    const onNavigate = vi.fn()
    const ref = { sourceField: 'narrativeSummary', label: 'Resumen narrativo' }
    render(<StellaEvidencePanel references={[ref]} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: /Resumen narrativo/ }))
    expect(onNavigate).toHaveBeenCalledWith(ref)
  })

  it('renders a malformed/nonexistent citation path gracefully without crashing', () => {
    render(<StellaEvidencePanel references={[{ sourceField: 'not.a.real.path!!', label: 'not.a.real.path!!' }]} />)
    expect(screen.getByText('not.a.real.path!!')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// TRAIN 2 — grounded citations (INTEGRATION-001)
// ---------------------------------------------------------------------------

describe('StellaEvidencePanel — grounded citations', () => {
  it('renders the excerpt derived from the chunk, the source label and the rendered location', () => {
    const citation = loadedCitationView()
    render(<StellaEvidencePanel citations={[citation]} />)

    expect(screen.getByText(REPORT_TEXT)).toBeInTheDocument()
    expect(screen.getByText(/informe-2025\.pdf/)).toBeInTheDocument()
    expect(screen.getByText(/p\. 4 · Metodología · líneas 12–18/)).toBeInTheDocument()
  })

  it('shows the relevance bucket WITH the numeric score, never the bucket alone', () => {
    const citation = loadedCitationView(REPORT_TEXT, 0.82)
    render(<StellaEvidencePanel citations={[citation]} />)

    const badge = screen.getByTestId(`stella-citation-relevance-${citation.key}`)
    expect(badge).toHaveTextContent('Relevancia alta')
    expect(badge).toHaveTextContent('0.82')
    expect(badge.getAttribute('title')).toContain('score 0.82')
    expect(badge.getAttribute('title')).toContain('estrategia hybrid')
  })

  it('renders a citation without a loaded passage as unavailable instead of inventing text', () => {
    const citation = unavailableCitationView()
    render(<StellaEvidencePanel citations={[citation]} />)

    expect(screen.getByTestId(`stella-citation-unavailable-${citation.key}`)).toBeInTheDocument()
    expect(screen.queryByText(REPORT_TEXT)).not.toBeInTheDocument()
    expect(screen.getByTestId(`stella-grounded-citation-${citation.key}`)).toHaveAttribute(
      'data-availability',
      'source_unavailable',
    )
  })

  it('does not render an interactive control when no navigation handler is supplied', () => {
    render(<StellaEvidencePanel citations={[loadedCitationView()]} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('calls onNavigateCitation with the clicked citation', () => {
    const onNavigateCitation = vi.fn()
    const citation = loadedCitationView()
    render(<StellaEvidencePanel citations={[citation]} onNavigateCitation={onNavigateCitation} />)

    fireEvent.click(screen.getByRole('button', { name: /informe-2025\.pdf/ }))
    expect(onNavigateCitation).toHaveBeenCalledWith(citation)
  })

  it('gives the navigation control an accessible name that identifies the PASSAGE, not just the file', () => {
    // A claim commonly cites three places in one document; three buttons all
    // named "informe-2025.pdf" would be unusable with a screen reader.
    render(<StellaEvidencePanel citations={[loadedCitationView()]} onNavigateCitation={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'informe-2025.pdf — p. 4 · Metodología · líneas 12–18' }),
    ).toBeInTheDocument()
  })

  it('exposes grounded citations as a named, ordered list', () => {
    render(<StellaEvidencePanel citations={[loadedCitationView(), unavailableCitationView(ANNEX_TEXT)]} />)
    const list = screen.getByRole('list', { name: 'Citas fundamentadas' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  it('falls back to the empty state for an empty grounded citation list', () => {
    render(<StellaEvidencePanel citations={[]} emptyLabel="Sin citas." />)
    expect(screen.getByTestId('stella-evidence-panel-empty')).toHaveTextContent('Sin citas.')
  })

  it('announces that a long excerpt was shortened, and states the full passage length', () => {
    const long = 'x'.repeat(400)
    const citation = loadedCitationView(long)
    render(<StellaEvidencePanel citations={[citation]} />)

    expect(citation.excerpt?.truncated).toBe(true)
    expect(screen.getByText(/Extracto recortado para su lectura \(400 caracteres/)).toBeInTheDocument()
  })
})
