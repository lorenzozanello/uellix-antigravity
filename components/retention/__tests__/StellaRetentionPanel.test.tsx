// @vitest-environment jsdom
// components/retention/__tests__/StellaRetentionPanel.test.tsx
// Etapa A2.4 (DR-004) — component-level tests (no real DB, no real auth;
// server actions fully mocked). Mirrors
// components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx's
// pattern and scope: proves the panel renders the right controls for the
// right role and wires them to the right server action.

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RetentionOverview, RetentionHoldListItem, RecentPurgeRunItem } from '@/app/actions/stella/retention'

const mockUpdateSettings = vi.fn()
const mockPreviewImpact = vi.fn()
const mockCreateHold = vi.fn()
const mockReleaseHold = vi.fn()
const mockPreviewPurge = vi.fn()
const mockExecutePurge = vi.fn()
const mockListHolds = vi.fn()
const mockListRuns = vi.fn()

vi.mock('@/app/actions/stella/retention', () => ({
  updateRetentionSettingsAction: (...args: unknown[]) => mockUpdateSettings(...args),
  previewRetentionSettingsImpactAction: (...args: unknown[]) => mockPreviewImpact(...args),
  createRetentionHoldAction: (...args: unknown[]) => mockCreateHold(...args),
  releaseRetentionHoldAction: (...args: unknown[]) => mockReleaseHold(...args),
  previewStellaRetentionPurgeAction: (...args: unknown[]) => mockPreviewPurge(...args),
  executeStellaRetentionPurgeAction: (...args: unknown[]) => mockExecutePurge(...args),
  listRetentionHoldsAction: (...args: unknown[]) => mockListHolds(...args),
  listRecentStellaRetentionPurgeRunsAction: (...args: unknown[]) => mockListRuns(...args),
}))

import { StellaRetentionPanel } from '../StellaRetentionPanel'

const OVERVIEW: RetentionOverview = {
  policyVersion: 'v1',
  defaultResponseRetentionMonths: 24,
  minResponseRetentionMonths: 1,
  maxResponseRetentionMonths: 60,
  organizationResponseRetentionMonths: 24,
  isDefaultSetting: true,
  configuredAt: null,
  canManage: true,
}

const ACTIVE_HOLD: RetentionHoldListItem = {
  id: 'hold-1',
  projectId: null,
  interactionId: null,
  holdType: 'legal_hold',
  reasonCode: 'pending_legal_review',
  status: 'active',
  createdAt: new Date('2026-01-01'),
  expiresAt: null,
  releasedAt: null,
}

function baseProps(overrides: Partial<React.ComponentProps<typeof StellaRetentionPanel>> = {}) {
  return {
    overview: OVERVIEW,
    initialHolds: [] as RetentionHoldListItem[],
    initialRuns: [] as RecentPurgeRunItem[],
    canManage: false,
    ...overrides,
  }
}

describe('StellaRetentionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListHolds.mockResolvedValue({ ok: true, items: [] })
    mockListRuns.mockResolvedValue({ ok: true, items: [] })
  })
  afterEach(() => cleanup())

  describe('Viewer (canManage=false)', () => {
    it('shows the effective retention period', () => {
      render(<StellaRetentionPanel {...baseProps()} />)
      expect(screen.queryByText(/24 meses/)).not.toBeNull()
    })

    it('shows the A3 legal-review-pending disclaimer', () => {
      render(<StellaRetentionPanel {...baseProps()} />)
      expect(screen.queryByText(/pendiente de revisión legal/i)).not.toBeNull()
    })

    it('does not render management controls (dry-run, settings, hold creation)', () => {
      render(<StellaRetentionPanel {...baseProps()} />)
      expect(screen.queryByText(/ejecutar dry-run/i)).toBeNull()
      expect(screen.queryByText(/nueva preservación/i)).toBeNull()
    })

    it('shows an active hold badge even for a viewer (read-only)', () => {
      render(<StellaRetentionPanel {...baseProps({ initialHolds: [ACTIVE_HOLD] })} />)
      expect(screen.queryByText(/preservación activa/i)).not.toBeNull()
    })

    it('never renders a free-text/content field — only counts, dates, and fixed vocabulary', () => {
      render(<StellaRetentionPanel {...baseProps({ initialRuns: [{ id: 'run-1', mode: 'apply', status: 'completed', createdAt: new Date(), completedAt: new Date(), recordsPurged: 3, recordsEligible: 3, recordsScanned: 5, recordsSkippedHold: 0 }] })} />)
      // No <textarea> anywhere, and no prop/field carries arbitrary narrative text.
      expect(document.querySelectorAll('textarea')).toHaveLength(0)
    })
  })

  describe('Organization admin (canManage=true)', () => {
    it('renders the dry-run button', () => {
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      expect(screen.queryByText(/ejecutar dry-run/i)).not.toBeNull()
    })

    it('running a dry-run shows the summary but never an "aplicar" confirmation until eligible > 0', async () => {
      mockPreviewPurge.mockResolvedValue({
        ok: true,
        run: { id: 'run-1', organizationId: 'org-1', policyVersion: 'v1', mode: 'dry_run', status: 'completed', cutoffAt: new Date(), batchSize: 500, recordsScanned: 5, recordsEligible: 0, recordsPurged: 0, recordsSkippedHold: 0, recordsFailed: 0, errorCode: null },
      })
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      fireEvent.click(screen.getByText(/ejecutar dry-run/i))
      await waitFor(() => expect(screen.queryByText(/0 elegible/)).not.toBeNull())
      expect(screen.queryByText(/aplicar purga/i)).toBeNull()
    })

    it('a dry-run with eligible records shows "Aplicar purga", which requires a second confirm click before calling execute', async () => {
      mockPreviewPurge.mockResolvedValue({
        ok: true,
        run: { id: 'run-2', organizationId: 'org-1', policyVersion: 'v1', mode: 'dry_run', status: 'completed', cutoffAt: new Date(), batchSize: 500, recordsScanned: 5, recordsEligible: 2, recordsPurged: 0, recordsSkippedHold: 0, recordsFailed: 0, errorCode: null },
      })
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      fireEvent.click(screen.getByText(/ejecutar dry-run/i))
      await waitFor(() => expect(screen.queryByText(/aplicar purga/i)).not.toBeNull())

      fireEvent.click(screen.getByText(/aplicar purga/i))
      expect(mockExecutePurge).not.toHaveBeenCalled()
      expect(screen.queryByText(/confirmar purga/i)).not.toBeNull()

      mockExecutePurge.mockResolvedValue({
        ok: true,
        run: { id: 'run-2', organizationId: 'org-1', policyVersion: 'v1', mode: 'apply', status: 'completed', cutoffAt: new Date(), batchSize: 500, recordsScanned: 5, recordsEligible: 2, recordsPurged: 2, recordsSkippedHold: 0, recordsFailed: 0, errorCode: null },
        alreadyExisted: false,
      })
      fireEvent.click(screen.getByText(/^confirmar purga$/i))
      await waitFor(() => expect(mockExecutePurge).toHaveBeenCalledWith('run-2'))
    })

    it('shows the server-provided error message verbatim on a forbidden-role rejection', async () => {
      mockPreviewPurge.mockResolvedValue({ ok: false, error: 'FORBIDDEN_ROLE', message: 'Solo un administrador de organización puede ejecutar una purga de retención.' })
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      fireEvent.click(screen.getByText(/ejecutar dry-run/i))
      await waitFor(() => expect(screen.queryByText(/solo un administrador de organización/i)).not.toBeNull())
    })

    it('previews impact before saving a reduced retention value, without saving automatically', async () => {
      mockPreviewImpact.mockResolvedValue({ ok: true, newlyEligibleCount: 7 })
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      const input = screen.getByDisplayValue('24') as HTMLInputElement
      fireEvent.change(input, { target: { value: '12' } })
      fireEvent.click(screen.getByText(/ver impacto/i))
      await waitFor(() => expect(screen.queryByText(/7 respuesta/)).not.toBeNull())
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('saving settings calls updateRetentionSettingsAction with the numeric value', async () => {
      mockUpdateSettings.mockResolvedValue({ ok: true })
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      const input = screen.getByDisplayValue('24') as HTMLInputElement
      fireEvent.change(input, { target: { value: '18' } })
      fireEvent.click(screen.getByText(/^guardar$/i))
      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith(18))
    })

    it('creates a hold with only fixed-vocabulary fields (no free-text field exists in the form)', async () => {
      mockCreateHold.mockResolvedValue({ ok: true, id: 'hold-new' })
      render(<StellaRetentionPanel {...baseProps({ canManage: true })} />)
      fireEvent.click(screen.getByText(/nueva preservación/i))
      fireEvent.click(screen.getByText(/^crear$/i))
      await waitFor(() => {
        expect(mockCreateHold).toHaveBeenCalledWith(
          expect.objectContaining({ holdType: 'legal_hold', reasonCode: 'pending_legal_review' }),
        )
      })
      const [input] = mockCreateHold.mock.calls[0]
      expect(input).not.toHaveProperty('description')
      expect(input).not.toHaveProperty('note')
    })

    it('releases a hold by id', async () => {
      mockReleaseHold.mockResolvedValue({ ok: true })
      render(<StellaRetentionPanel {...baseProps({ canManage: true, initialHolds: [ACTIVE_HOLD] })} />)
      fireEvent.click(screen.getByText(/^liberar$/i))
      await waitFor(() => expect(mockReleaseHold).toHaveBeenCalledWith('hold-1'))
    })
  })
})
