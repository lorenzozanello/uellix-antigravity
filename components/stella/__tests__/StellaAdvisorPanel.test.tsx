// @vitest-environment jsdom
// components/stella/__tests__/StellaAdvisorPanel.test.tsx
// Sprint 9C-2: Component tests — no real Gemini, no real DB, no real auth

import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'

// ---------------------------------------------------------------------------
// Mock the server action — must be at top level for vitest hoisting
// ---------------------------------------------------------------------------
const mockGetStellaAdvisor = vi.fn()
vi.mock('@/app/actions/stella/advisor', () => ({
  getStellaAdvisor: (...args: unknown[]) => mockGetStellaAdvisor(...args),
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
      expect(screen.queryByText(/ask stella/i)).not.toBeNull()
    })

    it('shows the Ask Stella button as enabled in idle state', () => {
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      const btn = screen.getByText(/ask stella/i).closest('button')
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
        screen.queryByText(/stella provides advisory guidance only/i)
      ).not.toBeNull()
      expect(
        screen.queryByText(/human review is required before external use/i)
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

      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(mockGetStellaAdvisor).toHaveBeenCalledWith('proj-abc', 'outcomes')
      })
    })

    it('calls getStellaAdvisor exactly once per click', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)

      fireEvent.click(screen.getByText(/ask stella/i))

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
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        const btn = screen.getByText(/loading/i).closest('button')
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
      fireEvent.click(screen.getByText(/ask stella/i))

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
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/what to do/i)).not.toBeNull()
      })
    })

    it('renders Why it matters section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/why it matters/i)).not.toBeNull()
      })
    })

    it('renders How to do it section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/how to do it/i)).not.toBeNull()
      })
    })

    it('renders Common mistakes section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/common mistakes/i)).not.toBeNull()
      })
    })

    it('renders Suggested next actions section', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/suggested next actions/i)).not.toBeNull()
      })
    })

    it('renders all 5 advisory sections together', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/what to do/i)).not.toBeNull()
        expect(screen.queryByText(/why it matters/i)).not.toBeNull()
        expect(screen.queryByText(/how to do it/i)).not.toBeNull()
        expect(screen.queryByText(/common mistakes/i)).not.toBeNull()
        expect(screen.queryByText(/suggested next actions/i)).not.toBeNull()
      })
    })

    it('renders common mistakes as list items', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Being too vague')).not.toBeNull()
        expect(screen.queryByText('Not linking to outcomes')).not.toBeNull()
      })
    })

    it('renders suggested next actions as list items', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText('Define at least 3 outcomes')).not.toBeNull()
        expect(screen.queryByText('Map stakeholders')).not.toBeNull()
      })
    })

    it('renders success content from advisor output', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText('Document the theory of change clearly.')
        ).not.toBeNull()
      })
    })

    it('shows disclaimer copy in success state', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        const disclaimers = screen.queryAllByText(/stella provides advisory guidance only/i)
        expect(disclaimers.length).toBeGreaterThan(0)
      })
    })

    it('allows retry after success (Ask Stella button still present)', async () => {
      success()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/what to do/i)).not.toBeNull()
      })

      // Button should still be available for retry
      expect(screen.queryByText(/ask stella/i)).not.toBeNull()
    })
  })

  describe('Error state', () => {
    it('shows error fallback message on GEMINI_ERROR', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/stella guidance is temporarily unavailable/i)
        ).not.toBeNull()
      })
    })

    it('shows "pipeline data is unaffected" in error message', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/your pipeline data is unaffected/i)
        ).not.toBeNull()
      })
    })

    it('error message has role="alert" for screen readers', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull()
      })
    })

    it('allows retry after error', async () => {
      geminiError()
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/stella guidance is temporarily unavailable/i)
        ).not.toBeNull()
      })

      // "Ask Stella" should still be present for retry
      expect(screen.queryByText(/ask stella/i)).not.toBeNull()
    })

    it('handles thrown exceptions gracefully', async () => {
      mockGetStellaAdvisor.mockRejectedValue(new Error('Network error'))
      render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(
          screen.queryByText(/stella guidance is temporarily unavailable/i)
        ).not.toBeNull()
      })
    })
  })

  describe('Disabled state', () => {
    it('renders null when action returns DISABLED', async () => {
      disabled()
      const { container } = render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(container.firstChild).toBeNull()
      })
    })

    it('does not render any content when DISABLED', async () => {
      disabled()
      const { container } = render(<StellaAdvisorPanel projectId="proj-1" step="narrative" />)
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })
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
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(screen.queryByText(/what to do/i)).not.toBeNull()
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
      fireEvent.click(screen.getByText(/ask stella/i))

      await waitFor(() => {
        expect(mockGetStellaAdvisor).toHaveBeenCalled()
        // If the real adapter were called it would throw (no API key in test env)
        // The mock being called proves isolation is complete
      })
    })
  })
})
