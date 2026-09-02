// @vitest-environment jsdom
// components/stella/__tests__/StellaComposerPanel.test.tsx
// Sprint 9D component tests, reworked for WS2 (Moonshot) U4: the panel no
// longer writes into the DOM by element id — it emits drafts through the
// `onUseDraft` callback prop. No real Gemini, no real DB, no real auth.

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The ticket issuer, mocked to the happy path. `vi.hoisted` because vitest
 * hoists `vi.mock` factories above the const declarations they close over.
 */
const mockIssueTicket = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'issued', ticket: 'a'.repeat(64) }),
)
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

// ---------------------------------------------------------------------------
// Mock the server action — must be at top level for vitest hoisting
// ---------------------------------------------------------------------------
const mockGetStellaComposer = vi.fn()
vi.mock('@/app/actions/stella/composer', () => ({
  getStellaComposer: (...args: unknown[]) => mockGetStellaComposer(...args),
  // TRAIN 4.3. The panel now MINTS an operation ticket before it runs, and
  // presents the SAME ticket on a retry — see components/stella/use-stella-operation.ts.
  // The issuer is mocked to the happy path so the tests below stay about the
  // panel's rendering, focus and error taxonomy; the ticket lifecycle itself is
  // proved in the action suites and in the cross-workstream battery.
  issueStellaComposerTicket: (...args: unknown[]) => mockIssueTicket(...args),
}))

// Mock Button component to avoid @base-ui/react jsdom compatibility issues
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

    it('mounts both live regions at idle, empty (U6)', () => {
      render(<StellaComposerPanel {...defaultProps} />)
      const polite = screen.getByTestId('stella-composer-live-polite')
      const assertive = screen.getByTestId('stella-composer-live-assertive')
      expect(polite.getAttribute('aria-live')).toBe('polite')
      expect(assertive.getAttribute('aria-live')).toBe('assertive')
      expect(polite.textContent).toBe('')
      expect(assertive.textContent).toBe('')
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
          'executive_summary',
          // TRAIN 4.3 — the opaque operation ticket, a SEPARATE argument from the
          // functional payload so neither has anywhere to put the other.
          'a'.repeat(64)
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
        expect(screen.getByTestId('stella-composer-live-polite').contains(el)).toBe(true)
      })

      await act(async () => {
        resolve({ ok: true, data: VALID_COMPOSER_OUTPUT })
      })
    })
  })

  // -------------------------------------------------------------------------
  // Disabled availability (U5)
  // -------------------------------------------------------------------------
  describe('Disabled state', () => {
    it('stays mounted with an inert informative state when action returns DISABLED', async () => {
      disabled()
      const { container } = render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByTestId('stella-composer-disabled')).not.toBeNull()
      })
      expect(container.firstChild).not.toBeNull()
      const btn = screen.getByText(/redactar con stella/i).closest('button')
      expect(btn?.disabled).toBe(true)
    })

    it('renders inert and never calls the action when enabled={false} (server-passed)', () => {
      render(<StellaComposerPanel {...defaultProps} enabled={false} />)
      expect(screen.queryByTestId('stella-composer-disabled')).not.toBeNull()
      fireEvent.click(screen.getByText(/redactar con stella/i))
      expect(mockGetStellaComposer).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Quota exceeded state
  // -------------------------------------------------------------------------
  describe('Quota exceeded state', () => {
    it('shows the quota message verbatim when QUOTA_EXCEEDED', async () => {
      quotaExceeded()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/límite mensual de 50 consultas/i)).not.toBeNull()
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
  // Error state (U5 taxonomy)
  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows the AI-service error message on GEMINI_ERROR (distinct taxonomy)', async () => {
      geminiError()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/el servicio de ia de stella encontró un error/i)
        ).not.toBeNull()
      })
    })

    it('shows the section-unaffected footnote on errors', async () => {
      geminiError()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/el contenido de tu sección no se ve afectado/i)).not.toBeNull()
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
        expect(screen.queryByText(/stella no está disponible temporalmente/i)).not.toBeNull()
      })
    })

    it('offers Reintentar on TIMEOUT and retries the action', async () => {
      mockGetStellaComposer.mockResolvedValue({
        ok: false,
        error: 'TIMEOUT',
        message: 'Stella request timed out. Please try again.',
      })
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Reintentar')).not.toBeNull()
      })

      success()
      fireEvent.click(screen.getByText('Reintentar'))
      await waitFor(() => {
        expect(mockGetStellaComposer).toHaveBeenCalledTimes(2)
        expect(screen.queryByText(/borrador propuesto/i)).not.toBeNull()
      })
    })

    it('allows retry after error', async () => {
      geminiError()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/el servicio de ia de stella encontró un error/i)
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

    it('renders "Usar este borrador" button when onUseDraft is provided', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} onUseDraft={vi.fn()} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })
    })

    it('does NOT render "Usar este borrador" without an onUseDraft callback', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/borrador propuesto/i)).not.toBeNull()
      })
      expect(screen.queryByText(/usar este borrador/i)).toBeNull()
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
  // "Usar este borrador" — U4: callback contract, no DOM writes
  // -------------------------------------------------------------------------
  describe('Usar este borrador (onUseDraft callback)', () => {
    it('does not call onUseDraft automatically on success', async () => {
      success()
      const onUseDraft = vi.fn()
      render(<StellaComposerPanel {...defaultProps} onUseDraft={onUseDraft} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })

      // Wait an additional tick to ensure no deferred auto-apply happens
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(onUseDraft).not.toHaveBeenCalled()
    })

    it('fires onUseDraft with the draft title and content on explicit click', async () => {
      success()
      const onUseDraft = vi.fn()
      render(<StellaComposerPanel {...defaultProps} onUseDraft={onUseDraft} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })

      fireEvent.click(screen.getByText(/usar este borrador/i))

      expect(onUseDraft).toHaveBeenCalledTimes(1)
      expect(onUseDraft).toHaveBeenCalledWith({
        title: VALID_COMPOSER_OUTPUT.draft_title,
        content: VALID_COMPOSER_OUTPUT.draft_content,
      })
    })

    it('performs no imperative DOM writes: sibling inputs remain untouched', async () => {
      success()
      const onUseDraft = vi.fn()
      render(
        <>
          <StellaComposerPanel {...defaultProps} onUseDraft={onUseDraft} />
          <input id="title-section-1" defaultValue="" />
          <textarea id="content-section-1" defaultValue="" />
        </>
      )
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/usar este borrador/i)).not.toBeNull()
      })

      fireEvent.click(screen.getByText(/usar este borrador/i))

      expect((document.getElementById('title-section-1') as HTMLInputElement).value).toBe('')
      expect((document.getElementById('content-section-1') as HTMLTextAreaElement).value).toBe('')
      expect(onUseDraft).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security invariants', () => {
    // Note: the old "does not read GEMINI_API_KEY env var" test was removed
    // (audit FIX 5) — asserting the var is undefined in the test env proved
    // nothing about the component. Isolation is proven by the mocked-action
    // test below: the real adapter would throw without a key.
    it('does not make real Gemini calls — action is fully mocked', async () => {
      success()
      render(<StellaComposerPanel {...defaultProps} />)
      fireEvent.click(screen.getByText(/redactar con stella/i))

      await waitFor(() => {
        expect(mockGetStellaComposer).toHaveBeenCalled()
      })
    })
  })
})
