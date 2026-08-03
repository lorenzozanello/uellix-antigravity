// @vitest-environment jsdom
// components/stella/__tests__/NarrativePage.contextual.integration.test.tsx
// WS2 (Moonshot) U7 — integration-style test: the contextual advisor panel
// mounted inside the REAL narrative pipeline page module, with every server
// dependency mocked. Proves the page wiring end-to-end: server-passed
// availability, on-demand invoke, and Aceptar applying the proposed text
// into the page's actual narrativeText field (controlled, form-compatible).

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'

// ---------------------------------------------------------------------------
// Server-dependency mocks (hoisted)
// ---------------------------------------------------------------------------
const mockGetStellaContextualAdvisor = vi.fn()
const mockGetStellaAdvisor = vi.fn()
vi.mock('@/app/actions/stella/advisor', () => ({
  getStellaContextualAdvisor: (...args: unknown[]) => mockGetStellaContextualAdvisor(...args),
  getStellaAdvisor: (...args: unknown[]) => mockGetStellaAdvisor(...args),
}))

// Stella availability read server-side by the page (READ-ONLY module mocked
// here so the panel mounts as enabled without env vars).
vi.mock('@/lib/stella/config', () => ({
  stellaConfig: { isEnabled: true, isAdvisorEnabled: true },
  stellaState: { canUseStella: true },
}))

const ORGANIZATION_CONTEXT = vi.hoisted(() => ({
  membership: { role: 'analyst' },
  organization: { id: 'org-1' },
  user: { id: 'user-1' },
}))

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn().mockResolvedValue(ORGANIZATION_CONTEXT),
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) => cb(ORGANIZATION_CONTEXT),
}))

vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: (ctx: unknown) => unknown) =>
    cb(ORGANIZATION_CONTEXT),
}))

const mockFetchNarrative = vi.fn()
vi.mock('@/app/app/projects/[projectId]/pipeline/narrative.actions', () => ({
  fetchNarrative: (...args: unknown[]) => mockFetchNarrative(...args),
  saveNarrative: vi.fn(),
}))

vi.mock('@/lib/pipeline/outcomes', () => ({
  listOutcomesForProject: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/app/app/projects/[projectId]/pipeline/theoryOfChange.actions', () => ({
  fetchToCNodes: vi.fn().mockResolvedValue([]),
  fetchToCLinks: vi.fn().mockResolvedValue([]),
  createToCNodeAction: vi.fn(),
  archiveToCNodeAction: vi.fn(),
  createToCLinkAction: vi.fn(),
  archiveToCLinkAction: vi.fn(),
}))

vi.mock('@/lib/pipeline/methodology-review', () => ({
  canReviewMethodology: () => false,
}))

vi.mock('@/components/methodology/MethodologyReviewPanel', () => ({
  MethodologyReviewPanel: () => null,
}))

vi.mock('@/components/sroi/Stepper', () => ({
  default: () => <nav data-testid="stepper-stub" />,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
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

// Import the REAL page module AFTER the mocks are in place.
import NarrativePage from '@/app/app/projects/[projectId]/pipeline/narrative/page'
import React from 'react'

const OUTPUT: AdvisorContextualOutput = {
  step: 'narrative',
  responseType: 'reformulation',
  summary: 'La narrativa puede reforzarse con la teoría de cambio registrada.',
  findings: [],
  suggestions: [
    {
      id: 'sug-1',
      proposedText: 'Narrativa propuesta por Stella, basada en los datos del proyecto.',
      rationale: 'El texto actual no menciona resultados.',
      missingInformation: [],
      sourceFields: ['narrativeSummary'],
    },
  ],
  clarifyingQuestions: [],
  limitations: [],
  requiresHumanReview: true,
}

async function renderNarrativePage() {
  const jsx = await NarrativePage({ params: Promise.resolve({ projectId: 'proj-1' }) })
  return render(jsx)
}

describe('NarrativePage × StellaContextualAdvisorPanel (integration-style)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchNarrative.mockResolvedValue({
      version: '1',
      narrativeText: 'Texto narrativo original.',
      theoryOfChangeSummary: '',
      assumptions: '',
      status: 'draft',
    })
  })
  afterEach(() => {
    cleanup()
  })

  it('mounts both the legacy advisor and the contextual panel (DP-03)', async () => {
    await renderNarrativePage()
    expect(screen.queryByText('Stella Advisor')).not.toBeNull()
    expect(screen.queryByTestId('stella-contextual-advisor-panel')).not.toBeNull()
  })

  it('does not invoke any Stella action on page render (on-demand only)', async () => {
    await renderNarrativePage()
    expect(mockGetStellaContextualAdvisor).not.toHaveBeenCalled()
    expect(mockGetStellaAdvisor).not.toHaveBeenCalled()
  })

  it('invokes the contextual action with the canonical step on demand', async () => {
    mockGetStellaContextualAdvisor.mockResolvedValue({ ok: true, data: OUTPUT })
    await renderNarrativePage()

    fireEvent.click(screen.getByText(/consultar a stella/i))

    await waitFor(() => {
      expect(mockGetStellaContextualAdvisor).toHaveBeenCalledWith('proj-1', 'narrative')
      expect(screen.queryByTestId('stella-contextual-result')).not.toBeNull()
    })
  })

  it('Aceptar applies the proposed text into the page narrativeText field, and Deshacer restores it', async () => {
    mockGetStellaContextualAdvisor.mockResolvedValue({ ok: true, data: OUTPUT })
    await renderNarrativePage()

    const textarea = screen.getByLabelText('Texto narrativo') as HTMLTextAreaElement
    expect(textarea.value).toBe('Texto narrativo original.')
    expect(textarea.getAttribute('name')).toBe('narrativeText')

    fireEvent.click(screen.getByText(/consultar a stella/i))
    await waitFor(() => {
      expect(screen.queryByText('Aceptar')).not.toBeNull()
    })

    fireEvent.click(screen.getByText('Aceptar'))
    expect(textarea.value).toBe('Narrativa propuesta por Stella, basada en los datos del proyecto.')

    fireEvent.click(screen.getByText('Deshacer'))
    expect(textarea.value).toBe('Texto narrativo original.')
  })

  it('renders the always-visible human-review note inside the page', async () => {
    await renderNarrativePage()
    const note = screen.getByTestId('stella-human-review-note')
    expect(note.getAttribute('role')).toBe('note')
  })
})
