// @vitest-environment jsdom
// components/stella/__tests__/StellaComposerPanel.test.tsx
// Sprint 9D: Component tests — no real Gemini, no real DB, no real auth

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

// ---------------------------------------------------------------------------
// Mock the server action — must be at top level for vitest hoisting
// ---------------------------------------------------------------------------
const mockGetStellaComposer = vi.fn()
vi.mock('@/app/actions/stella/composer', () => ({
  getStellaComposer: (...args: unknown[]) => mockGetStellaComposer(...args),
}))

// Mock Button component to avoid @base-ui/react jsdom compatibility issues
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    className?: string
  }) => (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}))

// Import component AFTER mocks are in place
import { StellaComposerPanel } from '../StellaComposerPanel'
import React from 'react'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_COMPOSER_OUTPUT: ComposerOutput = {
  section_key: 'executive_summary',
  draft_title: 'Resumen Ejecutivo',
  draft_content: 'Este proyecto generó un retorno social de 3.6x la inversión...',
  assumptions: ['Se asume que los beneficiarios reportados completaron el programa'],
  limitations: ['Datos de seguimiento a 12 meses aún no disponibles'],
  evidence_references: [
    { evidenceId: 'ev-1', title: 'Encuesta de seguimiento', context: 'Fuente de la tasa de empleo' },
  ],
  proxy_references: [
    { proxyId: 'proxy-1', name: 'Costo de tratar depresión', context: 'Usado para valorar el outcome de salud mental' },
  ],
}

const VALID_COMPOSER_OUTPUT_EMPTY_LISTS: ComposerOutput = {
  section_key: 'methodology',
  draft_title: 'Metodología',
  draft_content: 'Se utilizó el marco SROI estándar para el cálculo del retorno social.',
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
  titleInputId: 'title-section-1',
  contentInputId: 'content-section-1',
}

// The component writes the draft into sibling DOM inputs by ID (see
// titleInputId/contentInputId) rather than via a callback prop, since a
// Server Component cannot pass an event-handler function to this Client
// Component. Tests that exercise "Usar este borrador" render these inputs
// alongside the panel to observe the write.
function renderWithSectionInputs(props: Partial<typeof defaultProps> = {}) {
  const merged = { ...defaultProps, ...props }
  return render(
    <>
      <StellaComposerPanel {...merged} />
      <input id={merged.titleInputId} defaultValue="" />
      <textarea id={merged.contentInputId} defaultValue="" />
    </>
  )
}

function success(output = VALID_COMPOSER_OUTPUT) {
  return mockGetStellaComposer.mockResolvedValue({ ok: true, data: output })
}
function disabled() {
  return mockGetStellaComposer.mockResolvedValue({
    ok: false,
    error: 'DISABLED',
    message: 'Stella Composer is not enabled.',
  })
}
function geminiError() {
  return mockGetStellaComposer.mockResolvedValue({
    ok: false,
    error: 'GEMINI_ERROR',
    message: 'AI service error.',
  })
}
function quotaExceeded(
  message = 'Alcanzaste el límite mensual de 50 consultas a Stella (usadas: 50). Se renueva el 1 de agosto de 2026.'
) {
  return mockGetStellaComposer.mockResolvedValue({ ok: false, error: 'QUOTA_EXCEEDED', message })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StellaComposerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  // -------------------------------------------------------------------------
  // Idle state
  // -------------------------------------------------------------------------
  describe('Idle state', () => {
    it('renders in idle state with Redactar con Stella button', () => {
      render(<StellaComposerPanel {...defaultProps} />)
      expect(screen.queryByText(/redactar con stella/i)).not.toBeNull()
    })

    it('shows the button as enabled in idle state', () => {
      render(<StellaComposerPanel {...defaultProps} />)
      const btn = screen.getByText(/redactar con stella/i).closest('button')
      expect(btn).not.toBeNull()
      expect(btn?.disabled).toBe(false)
    })

    it('does not show success content in idle state', () => {
      render(<StellaComposerPanel {...defaultProps} />)
      expect(screen.queryByText(/borrador propuesto/i)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // No auto-call on mount
  // -------------------------------------------------------------------------
  describe('No auto-call on mount', () => {
    it('does not call getStellaComposer on mount', () => {
      render(<StellaComposerPanel {...defaultProps} />)
      expect(mockGetStellaComposer).not.toHaveBeenCalled()
    })

    it('does not call getStellaComposer when re-rendered without click', () => {
      const { rerender } = render(<StellaComposerPanel {...defaultProps} />)
      rerender(<StellaComposerPanel {...defaultProps} projectId="proj-2" />)
      expect(mockGetStellaComposer).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Trigger behavior
  // -------------------------------------------------------------------------
  describe('Trigger behavior', () => {
    it('calls getStellaComposer with projectId, reportId, sectionId, sectionType', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)

      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(mockGetStellaComposer).toHaveBeenCalledWith(
          'proj-1',
          'report-1',
          'section-1',
          'executive_summary'
        )
      })
    })

    it('calls getStellaComposer exactly once per click', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)

      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(mockGetStellaComposer).toHaveBeenCalledTimes(1)
      })
    })
  })

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('disables the button and shows Redactando… during loading', async () => {
      let resolve!: (v: unknown) => void
      mockGetStellaComposer.mockReturnValue(new Promise((res) => { resolve = res }))

      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        const btn = screen.getByText(/redactando/i).closest('button')
        expect(btn?.disabled).toBe(true)
      })

      await act(async () => {
        resolve({ ok: true, data: VALID_COMPOSER_OUTPUT })
      })
    })

    it('shows loading skeleton with correct aria attributes', async () => {
      let resolve!: (v: unknown) => void
      mockGetStellaComposer.mockReturnValue(new Promise((res) => { resolve = res }))

      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        const el = screen.getByTestId('stella-composer-loading')
        expect(el.getAttribute('aria-busy')).toBe('true')
        expect(el.getAttribute('aria-live')).toBe('polite')
      })

      await act(async () => {
        resolve({ ok: true, data: VALID_COMPOSER_OUTPUT })
      })
    })
  })

  // -------------------------------------------------------------------------
  // Disabled state
  // -------------------------------------------------------------------------
  describe('Disabled state', () => {
    it('renders null when action returns DISABLED', async () => {
      disabled()
      const { container } = render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(container.firstChild).toBeNull()
      })
    })

    it('does not render any content when DISABLED', async () => {
      disabled()
      const { container } = render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })
    })
  })

  // -------------------------------------------------------------------------
  // Quota exceeded state
  // -------------------------------------------------------------------------
  describe('Quota exceeded state', () => {
    it('shows the quota message when QUOTA_EXCEEDED', async () => {
      quotaExceeded()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/límite mensual/i)).not.toBeNull()
      })
    })

    it('quota message has role="alert" for screen readers', async () => {
      quotaExceeded()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull()
      })
    })
  })

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows generic Spanish error message on GEMINI_ERROR', async () => {
      geminiError()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/la redacción de stella no está disponible temporalmente/i)
        ).not.toBeNull()
      })
    })

    it('error message has role="alert"', async () => {
      geminiError()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull()
      })
    })

    it('handles thrown exceptions gracefully', async () => {
      mockGetStellaComposer.mockRejectedValue(new Error('Network error'))
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/la redacción de stella no está disponible temporalmente/i)
        ).not.toBeNull()
      })
    })

    it('allows retry after error', async () => {
      geminiError()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/la redacción de stella no está disponible temporalmente/i)
        ).not.toBeNull()
      })

      expect(screen.queryByText(/redactar con stella/i)).not.toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Success state
  // -------------------------------------------------------------------------
  describe('Success state', () => {
    it('renders draft_title', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(VALID_COMPOSER_OUTPUT.draft_title)).not.toBeNull()
      })
    })

    it('renders draft_content', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(VALID_COMPOSER_OUTPUT.draft_content)).not.toBeNull()
      })
    })

    it('renders assumptions list', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/supuestos/i)).not.toBeNull()
        expect(
          screen.queryByText('Se asume que los beneficiarios reportados completaron el programa')
        ).not.toBeNull()
      })
    })

    it('renders limitations list', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/limitaciones/i)).not.toBeNull()
        expect(
          screen.queryByText('Datos de seguimiento a 12 meses aún no disponibles')
        ).not.toBeNull()
      })
    })

    it('renders "Usar este borrador" button', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })
    })

    it('shows human review disclaimer footer', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/requiere revisión humana antes de guardar o publicar/i)
        ).not.toBeNull()
      })
    })

    it('does not render Supuestos heading when assumptions is empty', async () => {
      success(VALID_COMPOSER_OUTPUT_EMPTY_LISTS)
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(VALID_COMPOSER_OUTPUT_EMPTY_LISTS.draft_title)).not.toBeNull()
      })

      expect(screen.queryByText(/supuestos/i)).toBeNull()
    })

    it('does not render Limitaciones heading when limitations is empty', async () => {
      success(VALID_COMPOSER_OUTPUT_EMPTY_LISTS)
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(VALID_COMPOSER_OUTPUT_EMPTY_LISTS.draft_title)).not.toBeNull()
      })

      expect(screen.queryByText(/limitaciones/i)).toBeNull()
    })

    it('allows retry after success (button still present)', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/borrador propuesto/i)).not.toBeNull()
      })

      expect(screen.queryByText(/redactar con stella/i)).not.toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // "Usar este borrador" — writes into sibling DOM inputs by ID
  // -------------------------------------------------------------------------
  describe('Usar este borrador', () => {
    it('does not modify the section inputs automatically on success', async () => {
      success()
      renderWithSectionInputs()
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })

      expect((document.getElementById(defaultProps.titleInputId) as HTMLInputElement).value).toBe('')
      expect((document.getElementById(defaultProps.contentInputId) as HTMLTextAreaElement).value).toBe('')
    })

    it('writes draft_title and draft_content into the section inputs when clicked', async () => {
      success()
      renderWithSectionInputs()
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })

      fireEvent.click(screen.getByText(/usar este borrador/i))

      expect((document.getElementById(defaultProps.titleInputId) as HTMLInputElement).value).toBe(
        VALID_COMPOSER_OUTPUT.draft_title
      )
      expect((document.getElementById(defaultProps.contentInputId) as HTMLTextAreaElement).value).toBe(
        VALID_COMPOSER_OUTPUT.draft_content
      )
    })

    it('does nothing if the target inputs are not present in the DOM', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })

      expect(() => fireEvent.click(screen.getByText(/usar este borrador/i))).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security invariants', () => {
    it('does not read GEMINI_API_KEY env var', () => {
      expect(process.env.GEMINI_API_KEY).toBeUndefined()
    })

    it('does not make real Gemini calls — action is fully mocked', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(mockGetStellaComposer).toHaveBeenCalled()
      })
    })

    it('does not auto-save: section inputs are only ever written from explicit click', async () => {
      success()
      renderWithSectionInputs()
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/borrador propuesto/i)).not.toBeNull()
      })

      // Wait an additional tick to ensure no deferred auto-write happens
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      expect((document.getElementById(defaultProps.titleInputId) as HTMLInputElement).value).toBe('')
    })
  })
})
