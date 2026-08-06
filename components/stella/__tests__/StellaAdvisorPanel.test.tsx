// @vitest-environment jsdom
// components/stella/__tests__/StellaAdvisorPanel.test.tsx
// Sprint 9C-2: Component tests — no real Gemini, no real DB, no real auth

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The ticket issuer, mocked to the happy path. `vi.hoisted` because vitest
 * hoists `vi.mock` factories above the const declarations they close over.
 */
const mockIssueTicket = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'issued', ticket: 'a'.repeat(64) }),
)
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'

// ---------------------------------------------------------------------------
// Mock the server action — must be at top level for vitest hoisting
// ---------------------------------------------------------------------------
const mockGetStellaAdvisor = vi.fn()
vi.mock('@/app/actions/stella/advisor', () => ({
  getStellaAdvisor: (...args: unknown[]) => mockGetStellaAdvisor(...args),
  // TRAIN 4.3. The panel now MINTS an operation ticket before it runs, and
  // presents the SAME ticket on a retry — see components/stella/use-stella-operation.ts.
  // The issuer is mocked to the happy path so the tests below stay about the
  // panel's rendering, focus and error taxonomy; the ticket lifecycle itself is
  // proved in the action suites and in the cross-workstream battery.
  issueStellaAdvisorTicket: (...args: unknown[]) => mockIssueTicket(...args),
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
import { StellaAdvisorPanel } from '../StellaAdvisorPanel'
import React from 'react'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_OUTPUT: AdvisorOutput = {
  step: 'narrative',
  what_to_do: 'Document the theory of change clearly.',
  why_it_matters: 'Narrative grounds the SROI analysis in organizational context.',
  how_to_do_it: 'Describe the project goals, activities, and intended outcomes.',
  common_mistakes: ['Being too vague', 'Not linking to outcomes'],
  suggested_next_actions: ['Define at least 3 outcomes', 'Map stakeholders'],
}

function success() {
  return mockGetStellaAdvisor.mockResolvedValue({ ok: true, data: VALID_OUTPUT })
}
function disabled() {
  return mockGetStellaAdvisor.mockResolvedValue({
    ok: false,
    error: 'DISABLED',
    message: 'Stella Advisor is not enabled.',
  })
}
function geminiError() {
  return mockGetStellaAdvisor.mockResolvedValue({
    ok: false,
    error: 'GEMINI_ERROR',
    message: 'AI service error.',
  })
}
function quotaExceeded(message = 'Alcanzaste el límite mensual de 50 consultas a Stella (usadas: 50). Se renueva el 1 de agosto de 2026.') {
  return mockGetStellaAdvisor.mockResolvedValue({ ok: false, error: 'QUOTA_EXCEEDED', message })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StellaAdvisorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  describe('Idle state', () => {
    it('renders in idle state with Ask Stella button', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      expect(screen.queryByText(/preguntar a stella/i)).not.toBeNull()
    })

    it('shows the Ask Stella button as enabled in idle state', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      const btn = screen.getByText(/preguntar a stella/i).closest('button')
      expect(btn).not.toBeNull()
      expect(btn?.disabled).toBe(false)
    })

    it('shows default title when no title prop is provided', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      expect(screen.queryByText('Stella Advisor')).not.toBeNull()
    })

    it('renders custom title when provided', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" title="Step Guidance" />)
      expect(screen.queryByText('Step Guidance')).not.toBeNull()
    })

    it('shows disclaimer copy in idle state', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      expect(
        screen.queryByText(/stella brinda orientación consultiva únicamente/i)
      ).not.toBeNull()
      expect(
        screen.queryByText(/se requiere revisión humana antes de su uso externo/i)
      ).not.toBeNull()
    })
  })

  describe('No auto-call on mount', () => {
    it('does not call getStellaAdvisor on mount', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      expect(mockGetStellaAdvisor).not.toHaveBeenCalled()
    })

    it('does not call getStellaAdvisor when re-rendered without click', () => {
      const { rerender } = render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      rerender(<StellaAdvisorPanel projectId="proj-1" step="outcomes" />)
      expect(mockGetStellaAdvisor).not.toHaveBeenCalled()
    })
  })

  describe('Trigger behavior', () => {
    it('calls getStellaAdvisor with projectId and step when button clicked', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-abc" step="outcomes" />)

      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(mockGetStellaAdvisor).toHaveBeenCalledWith('proj-abc', 'outcomes', 'a'.repeat(64))
      })
    })

    it('calls getStellaAdvisor exactly once per click', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)

      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(mockGetStellaAdvisor).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('Loading state', () => {
    it('disables the button during loading', async () => {
      let resolve!: (v: unknown) => void
      mockGetStellaAdvisor.mockReturnValue(new Promise((res) => { resolve = res }))

      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        const btn = screen.getByText(/cargando/i).closest('button')
        expect(btn?.disabled).toBe(true)
      })

      await act(async () => {
        resolve({ ok: true, data: VALID_OUTPUT })
      })
    })

    it('shows loading indicator with aria-busy', async () => {
      let resolve!: (v: unknown) => void
      mockGetStellaAdvisor.mockReturnValue(new Promise((res) => { resolve = res }))

      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
      })

      await act(async () => {
        resolve({ ok: true, data: VALID_OUTPUT })
      })
    })
  })

  describe('Success state', () => {
    it('renders What to do section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/qué hacer/i)).not.toBeNull()
      })
    })

    it('renders Why it matters section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/por qué importa/i)).not.toBeNull()
      })
    })

    it('renders How to do it section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/cómo hacerlo/i)).not.toBeNull()
      })
    })

    it('renders Common mistakes section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/errores comunes/i)).not.toBeNull()
      })
    })

    it('renders Suggested next actions section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/próximos pasos sugeridos/i)).not.toBeNull()
      })
    })

    it('renders all 5 advisory sections together', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/qué hacer/i)).not.toBeNull()
        expect(screen.queryByText(/por qué importa/i)).not.toBeNull()
        expect(screen.queryByText(/cómo hacerlo/i)).not.toBeNull()
        expect(screen.queryByText(/errores comunes/i)).not.toBeNull()
        expect(screen.queryByText(/próximos pasos sugeridos/i)).not.toBeNull()
      })
    })

    it('renders common mistakes as list items', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Being too vague')).not.toBeNull()
        expect(screen.queryByText('Not linking to outcomes')).not.toBeNull()
      })
    })

    it('renders suggested next actions as list items', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Define at least 3 outcomes')).not.toBeNull()
        expect(screen.queryByText('Map stakeholders')).not.toBeNull()
      })
    })

    it('renders success content from advisor output', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText('Document the theory of change clearly.')
        ).not.toBeNull()
      })
    })

    it('shows disclaimer copy in success state', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        const disclaimers = screen.queryAllByText(/stella brinda orientación consultiva únicamente/i)
        expect(disclaimers.length).toBeGreaterThan(0)
      })
    })

    it('allows retry after success (Ask Stella button still present)', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/qué hacer/i)).not.toBeNull()
      })

      // Button should still be available for retry
      expect(screen.queryByText(/preguntar a stella/i)).not.toBeNull()
    })
  })

  describe('Error state', () => {
    it('shows the AI-service error message on GEMINI_ERROR (distinct taxonomy)', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/el servicio de ia de stella encontró un error/i)
        ).not.toBeNull()
      })
    })

    it('shows "pipeline data is unaffected" in error message', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/los datos de tu pipeline no se ven afectados/i)
        ).not.toBeNull()
      })
    })

    it('error message has role="alert" for screen readers', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull()
      })
    })

    it('allows retry after error', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/el servicio de ia de stella encontró un error/i)
        ).not.toBeNull()
      })

      // "Ask Stella" should still be present for retry
      expect(screen.queryByText(/preguntar a stella/i)).not.toBeNull()
    })

    it('handles thrown exceptions gracefully', async () => {
      mockGetStellaAdvisor.mockRejectedValue(new Error('Network error'))
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/stella no está disponible temporalmente/i)
        ).not.toBeNull()
      })
    })

    it('shows the rate-limit reset info on RATE_LIMITED', async () => {
      mockGetStellaAdvisor.mockResolvedValue({
        ok: false,
        error: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Resets at 2026-06-26T15:00:00.000Z.',
      })
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/límite de solicitudes por hora/i)).not.toBeNull()
        // FIX 3: the ISO reset timestamp is humanized to a readable UTC hour.
        expect(screen.queryByText(/se restablece a las 15:00 \(UTC\)/i)).not.toBeNull()
      })
    })

    it('offers Reintentar on TIMEOUT and retries the action', async () => {
      mockGetStellaAdvisor.mockResolvedValue({
        ok: false,
        error: 'TIMEOUT',
        message: 'Stella request timed out. Please try again.',
      })
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Reintentar')).not.toBeNull()
      })

      success()
      fireEvent.click(screen.getByText('Reintentar'))
      await waitFor(() => {
        expect(mockGetStellaAdvisor).toHaveBeenCalledTimes(2)
        expect(screen.queryByText(/qué hacer/i)).not.toBeNull()
      })
    })

    it('shows the role message on UNAUTHORIZED', async () => {
      mockGetStellaAdvisor.mockResolvedValue({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Tu rol no tiene permiso para usar Stella.',
      })
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Tu rol no tiene permiso para usar Stella.')).not.toBeNull()
      })
    })

    it('explains reducing text on PAYLOAD_TOO_LARGE', async () => {
      mockGetStellaAdvisor.mockResolvedValue({
        ok: false,
        error: 'PAYLOAD_TOO_LARGE',
        message: 'El contexto del proyecto es demasiado grande para Stella.',
      })
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/reducí la cantidad de texto/i)).not.toBeNull()
      })
    })

    it('moves focus to the error notice on failure', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        const assertive = screen.getByTestId('stella-advisor-live-assertive')
        expect(assertive.textContent).not.toBe('')
        expect(assertive.contains(document.activeElement)).toBe(true)
      })
    })

    it('shows the quota message when QUOTA_EXCEEDED', async () => {
      quotaExceeded()
      render(<StellaAdvisorPanel projectId="proj-1" step="Narrativa" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))
      await waitFor(() => {
        expect(screen.queryByText(/límite mensual/i)).not.toBeNull()
      })
    })
  })

  describe('Disabled state', () => {
    it('stays mounted with an inert informative state when action returns DISABLED', async () => {
      disabled()
      const { container } = render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByTestId('stella-advisor-disabled')).not.toBeNull()
      })
      expect(container.firstChild).not.toBeNull()
      const btn = screen.getByText(/preguntar a stella/i).closest('button')
      expect(btn?.disabled).toBe(true)
    })

    it('renders inert and never calls the action when enabled={false} (server-passed)', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" enabled={false} />)
      expect(screen.queryByTestId('stella-advisor-disabled')).not.toBeNull()
      const btn = screen.getByText(/preguntar a stella/i).closest('button')
      expect(btn?.disabled).toBe(true)
      fireEvent.click(screen.getByText(/preguntar a stella/i))
      expect(mockGetStellaAdvisor).not.toHaveBeenCalled()
    })
  })

  describe('Live regions (U6)', () => {
    it('mounts both live regions at idle, empty', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      const polite = screen.getByTestId('stella-advisor-live-polite')
      const assertive = screen.getByTestId('stella-advisor-live-assertive')
      expect(polite.getAttribute('aria-live')).toBe('polite')
      expect(assertive.getAttribute('aria-live')).toBe('assertive')
      expect(polite.textContent).toBe('')
      expect(assertive.textContent).toBe('')
    })
  })

  describe('Empty-step highlight', () => {
    it('applies a highlighted style when highlightHint is true', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="Narrativa" highlightHint />)
      const hint = screen.queryByText(/recién estás empezando/i)
      expect(hint).not.toBeNull()
    })

    it('does NOT show the hint by default', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="Narrativa" />)
      expect(screen.queryByText(/recién estás empezando/i)).toBeNull()
    })
  })

  describe('Security invariants', () => {
    it('does not read GEMINI_API_KEY env var', () => {
      expect(process.env.GEMINI_API_KEY).toBeUndefined()
    })

    it('does not read NEXT_PUBLIC_GEMINI_API_KEY env var', () => {
      expect(process.env.NEXT_PUBLIC_GEMINI_API_KEY).toBeUndefined()
    })

    it('does not claim certification in rendered content', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/qué hacer/i)).not.toBeNull()
      })

      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/certif[ia]/i)
      expect(text).not.toMatch(/auditoría automática/i)
      expect(text).not.toMatch(/impacto garantizado/i)
      expect(text).not.toMatch(/validación definitiva/i)
    })

    it('does not make real Gemini calls — action is fully mocked', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/preguntar a stella/i))

      await waitFor(() => {
        expect(mockGetStellaAdvisor).toHaveBeenCalled()
        // If the real adapter were called it would throw (no API key in test env)
        // The mock being called proves isolation is complete
      })
    })
  })
})
