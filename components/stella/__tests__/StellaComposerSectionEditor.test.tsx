// @vitest-environment jsdom
// components/stella/__tests__/StellaComposerSectionEditor.test.tsx
// WS2 (Moonshot) U4 — controlled apply flow: draft → (confirm) → fields,
// with a client-side undo stack. The composer server action is mocked.

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

const mockGetStellaComposer = vi.fn()
vi.mock('@/app/actions/stella/composer', () => ({
  getStellaComposer: (...args: unknown[]) => mockGetStellaComposer(...args),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
    type,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    className?: string
    type?: 'button' | 'submit'
  }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}))

import { StellaComposerSectionEditor } from '../StellaComposerSectionEditor'
import React from 'react'

const DRAFT_OUTPUT: ComposerOutput = {
  section_key: 'executive_summary',
  draft_title: 'Resumen Ejecutivo (Stella)',
  draft_content: 'Contenido redactado por Stella.',
  assumptions: [],
  limitations: [],
  evidence_references: [],
  proxy_references: [],
}

const defaultProps = {
  projectId: 'proj-1',
  reportId: 'report-1',
  sectionId: 'section-1',
  sectionType: 'executive_summary',
  initialTitle: 'Título original',
  initialContent: '',
  titleInputId: 'title-section-1',
  contentInputId: 'content-section-1',
}

function titleInput(): HTMLInputElement {
  return screen.getByLabelText('Título de la sección') as HTMLInputElement
}
function contentTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Contenido') as HTMLTextAreaElement
}

async function composeDraft() {
  mockGetStellaComposer.mockResolvedValue({ ok: true, data: DRAFT_OUTPUT })
  fireEvent.click(screen.getByText(/redactar con stella/i))
  await waitFor(() => {
    expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
  })
}

describe('StellaComposerSectionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders controlled fields seeded with the initial values (name attrs intact)', () => {
    render(<StellaComposerSectionEditor {...defaultProps} initialContent="contenido previo" />)
    expect(titleInput().value).toBe('Título original')
    expect(contentTextarea().value).toBe('contenido previo')
    expect(titleInput().getAttribute('name')).toBe('title')
    expect(contentTextarea().getAttribute('name')).toBe('content')
  })

  it('applies the draft directly when the content is empty (no confirmation)', async () => {
    render(<StellaComposerSectionEditor {...defaultProps} />)
    await composeDraft()

    fireEvent.click(screen.getByText(/usar este borrador/i))

    expect(screen.queryByTestId('stella-composer-overwrite-confirm')).toBeNull()
    expect(titleInput().value).toBe('Resumen Ejecutivo (Stella)')
    expect(contentTextarea().value).toBe('Contenido redactado por Stella.')
  })

  it('asks for confirmation before overwriting non-empty content', async () => {
    render(<StellaComposerSectionEditor {...defaultProps} initialContent="contenido escrito a mano" />)
    await composeDraft()

    fireEvent.click(screen.getByText(/usar este borrador/i))

    // Nothing applied yet — the confirmation gate is up.
    expect(contentTextarea().value).toBe('contenido escrito a mano')
    const confirm = screen.getByTestId('stella-composer-overwrite-confirm')
    expect(confirm.getAttribute('role')).toBe('alertdialog')

    fireEvent.click(screen.getByText('Reemplazar contenido'))
    expect(titleInput().value).toBe('Resumen Ejecutivo (Stella)')
    expect(contentTextarea().value).toBe('Contenido redactado por Stella.')
    expect(screen.queryByTestId('stella-composer-overwrite-confirm')).toBeNull()
  })

  it('Cancelar keeps the current content and dismisses the confirmation', async () => {
    render(<StellaComposerSectionEditor {...defaultProps} initialContent="contenido escrito a mano" />)
    await composeDraft()

    fireEvent.click(screen.getByText(/usar este borrador/i))
    fireEvent.click(screen.getByText('Cancelar'))

    expect(contentTextarea().value).toBe('contenido escrito a mano')
    expect(titleInput().value).toBe('Título original')
    expect(screen.queryByTestId('stella-composer-overwrite-confirm')).toBeNull()
    // No undo entry: nothing was applied.
    expect(screen.queryByTestId('stella-composer-undo')).toBeNull()
  })

  it('Escape dismisses the overwrite confirmation (U6 keyboard)', async () => {
    render(<StellaComposerSectionEditor {...defaultProps} initialContent="contenido escrito a mano" />)
    await composeDraft()

    fireEvent.click(screen.getByText(/usar este borrador/i))
    fireEvent.keyDown(screen.getByTestId('stella-composer-overwrite-confirm'), { key: 'Escape' })

    expect(screen.queryByTestId('stella-composer-overwrite-confirm')).toBeNull()
    expect(contentTextarea().value).toBe('contenido escrito a mano')
  })

  it('Deshacer restores the pre-apply title and content', async () => {
    render(<StellaComposerSectionEditor {...defaultProps} initialContent="contenido escrito a mano" />)
    await composeDraft()

    fireEvent.click(screen.getByText(/usar este borrador/i))
    fireEvent.click(screen.getByText('Reemplazar contenido'))
    expect(contentTextarea().value).toBe('Contenido redactado por Stella.')

    fireEvent.click(screen.getByTestId('stella-composer-undo'))
    expect(titleInput().value).toBe('Título original')
    expect(contentTextarea().value).toBe('contenido escrito a mano')
    // Stack consumed — the affordance disappears.
    expect(screen.queryByTestId('stella-composer-undo')).toBeNull()
  })

  it('undo restores user edits made after seeding (stack captures latest values)', async () => {
    render(<StellaComposerSectionEditor {...defaultProps} />)
    fireEvent.change(contentTextarea(), { target: { value: 'editado por la persona' } })
    await composeDraft()

    fireEvent.click(screen.getByText(/usar este borrador/i))
    // Non-empty content now → confirmation gate.
    fireEvent.click(screen.getByText('Reemplazar contenido'))
    expect(contentTextarea().value).toBe('Contenido redactado por Stella.')

    fireEvent.click(screen.getByTestId('stella-composer-undo'))
    expect(contentTextarea().value).toBe('editado por la persona')
  })

  it('never auto-applies and never auto-submits (no form submission occurs)', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <StellaComposerSectionEditor {...defaultProps} />
      </form>
    )
    await composeDraft()
    fireEvent.click(screen.getByText(/usar este borrador/i))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('passes enabled={false} through to an inert composer panel', () => {
    render(<StellaComposerSectionEditor {...defaultProps} enabled={false} />)
    expect(screen.queryByTestId('stella-composer-disabled')).not.toBeNull()
    fireEvent.click(screen.getByText(/redactar con stella/i))
    expect(mockGetStellaComposer).not.toHaveBeenCalled()
  })
})
