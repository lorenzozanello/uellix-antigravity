import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MeasureProgressBadge } from './MeasureProgressBadge'
import type { MeasureProgress } from '@/lib/projects/service'

const NAVIGABLE_PROGRESS: MeasureProgress = {
  state: 'listo_para_revision',
  label: 'Listo para revisión',
  variant: 'accent',
  nextActionLabel: 'Revisar cálculo',
  nextActionPath: '/pipeline/calculation',
}

const BLOCKED_PROGRESS: MeasureProgress = {
  state: 'bloqueado',
  label: 'Bloqueado',
  variant: 'warning',
  nextActionLabel: 'Proyecto en pausa — reanudar para continuar',
  nextActionPath: '',
}

describe('MeasureProgressBadge — showNextAction', () => {
  it('renders the next-action link by default (no override, matches both live call sites)', () => {
    render(
      <MeasureProgressBadge projectId="proj-1" projectName="Test Project" progress={NAVIGABLE_PROGRESS} />
    )
    expect(screen.getByRole('link', { name: /Revisar cálculo/ })).toBeInTheDocument()
  })

  it('omits the next-action link and text when showNextAction={false}', () => {
    render(
      <MeasureProgressBadge
        projectId="proj-1"
        projectName="Test Project"
        progress={NAVIGABLE_PROGRESS}
        showNextAction={false}
      />
    )
    expect(screen.queryByRole('link', { name: /Revisar cálculo/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Revisar cálculo')).not.toBeInTheDocument()
    // The state badge itself must still render — only the next-action row is gated.
    expect(screen.getByText('Listo para revisión')).toBeInTheDocument()
  })

  it('omits the non-navigable next-action paragraph too when showNextAction={false}', () => {
    render(
      <MeasureProgressBadge
        projectId="proj-1"
        projectName="Test Project"
        progress={BLOCKED_PROGRESS}
        showNextAction={false}
      />
    )
    expect(screen.queryByText(/reanudar para continuar/)).not.toBeInTheDocument()
  })
})
