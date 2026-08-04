// @vitest-environment jsdom
// components/stella/__tests__/StellaGroundingBadge.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StellaGroundingBadge } from '../StellaGroundingBadge'

describe('StellaGroundingBadge', () => {
  it('renders the Spanish label for grounded', () => {
    render(<StellaGroundingBadge level="grounded" />)
    expect(screen.getByText('Fundamentado')).toBeInTheDocument()
  })

  it('renders the Spanish label for partially_grounded', () => {
    render(<StellaGroundingBadge level="partially_grounded" />)
    expect(screen.getByText('Parcialmente fundamentado')).toBeInTheDocument()
  })

  it('renders the Spanish label for insufficient_evidence', () => {
    render(<StellaGroundingBadge level="insufficient_evidence" />)
    expect(screen.getByText('Evidencia insuficiente')).toBeInTheDocument()
  })

  it('renders the Spanish label for contradictory_evidence', () => {
    render(<StellaGroundingBadge level="contradictory_evidence" />)
    expect(screen.getByText('Evidencia contradictoria')).toBeInTheDocument()
  })

  it('exposes the level as a data attribute for styling/testing hooks', () => {
    render(<StellaGroundingBadge level="grounded" />)
    expect(screen.getByTestId('stella-grounding-badge')).toHaveAttribute('data-support-level', 'grounded')
  })
})
