// @vitest-environment jsdom
// components/stella/__tests__/StellaEvidencePanel.test.tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaEvidencePanel } from '../StellaEvidencePanel'

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
