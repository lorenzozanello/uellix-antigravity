// @vitest-environment jsdom
// components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx
// Etapa A2.3.2 (STL-A232-023, DR-002/DR-003) — component-level tests for the
// operative UI (no real DB, no real auth; server actions are fully mocked,
// mirroring components/stella/__tests__/StellaAdvisorPanel.test.tsx's
// pattern). Real DB-backed proof of the underlying business rules already
// lives in the aggregation/declaration-service and declaration-query test
// suites plus the integration transactions/E2E suites — this file only
// proves the PANEL renders the right controls for the right role and wires
// them to the right server action with the right arguments.

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EntityDeclarationHistoryItem } from '@/app/actions/stella/aggregation-declarations'

const mockCreate = vi.fn()
const mockVerify = vi.fn()
const mockRevoke = vi.fn()
const mockSupersede = vi.fn()
const mockList = vi.fn()

vi.mock('@/app/actions/stella/aggregation-declarations', () => ({
  createAggregationDeclaration: (...args: unknown[]) => mockCreate(...args),
  verifyAggregationDeclaration: (...args: unknown[]) => mockVerify(...args),
  revokeAggregationDeclaration: (...args: unknown[]) => mockRevoke(...args),
  supersedeAggregationDeclaration: (...args: unknown[]) => mockSupersede(...args),
  listEntityAggregationDeclarations: (...args: unknown[]) => mockList(...args),
}))

import { OutcomeSensitiveAggregationPanel } from '../OutcomeSensitiveAggregationPanel'

const PENDING_ITEM: EntityDeclarationHistoryItem = {
  id: 'decl-pending', organizationId: 'org-1', projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1',
  sensitiveCategory: 'minors', aggregationLevel: 'aggregate', groupSize: 40, groupSizeBucket: '10_49',
  dimensions: [], countSourceType: 'indicator_measurement', countSourceId: null, countSourceNote: null,
  verificationStatus: 'pending', declaredBy: 'user-a', verifiedBy: null, verifiedAt: null,
  policyVersion: 'v1', minimumGroupSizeApplied: 10, revokedBy: null, revokedAt: null, revocationReason: null,
  supersedesDeclarationId: null, supersededByDeclarationId: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
}

const VERIFIED_ITEM: EntityDeclarationHistoryItem = {
  ...PENDING_ITEM,
  id: 'decl-verified',
  verificationStatus: 'verified',
  verifiedBy: 'user-b',
  verifiedAt: new Date('2026-01-02'),
  groupSize: 60,
  groupSizeBucket: '50_249',
}

function baseProps(overrides: Partial<React.ComponentProps<typeof OutcomeSensitiveAggregationPanel>> = {}) {
  return {
    projectId: 'proj-1',
    outcomeId: 'o-1',
    initialItems: [] as EntityDeclarationHistoryItem[],
    canCreateOrSupersede: false,
    canVerifyOrRevoke: false,
    ...overrides,
  }
}

describe('OutcomeSensitiveAggregationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue({ ok: true, items: [] })
  })
  afterEach(() => cleanup())

  describe('Viewer (no create/verify rights)', () => {
    it('shows "sin declaración vigente" when there is no active declaration', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps()} />)
      expect(screen.queryByText(/sin declaración vigente/i)).not.toBeNull()
    })

    it('does not render the "Declarar agregado" button', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps()} />)
      expect(screen.queryByText(/declarar agregado/i)).toBeNull()
    })

    it('renders a status badge for an active declaration without any action buttons', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ initialItems: [VERIFIED_ITEM] })} />)
      expect(screen.queryByText(/verificada/i)).not.toBeNull()
      expect(screen.queryByText(/^verificar$/i)).toBeNull()
      expect(screen.queryByText(/^revocar$/i)).toBeNull()
      expect(screen.queryByText(/^sustituir$/i)).toBeNull()
    })
  })

  describe('Analyst (can create/supersede, cannot verify/revoke)', () => {
    it('renders the "Declarar agregado" button', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      expect(screen.queryByText(/declarar agregado/i)).not.toBeNull()
    })

    it('opening the form never pre-selects a "verified" outcome — create always yields pending', async () => {
      mockCreate.mockResolvedValue({ ok: true, id: 'new-decl' })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      fireEvent.click(screen.getByText(/declarar agregado/i))
      // No "estado"/"verificationStatus" selector exists anywhere in the form.
      expect(screen.queryByLabelText(/estado/i)).toBeNull()
      fireEvent.change(screen.getByPlaceholderText(/mín\. 10/i), { target: { value: '40' } })
      fireEvent.click(screen.getByText(/^declarar$/i))
      await waitFor(() => expect(mockCreate).toHaveBeenCalled())
      const [input] = mockCreate.mock.calls[0]
      expect(input).not.toHaveProperty('verificationStatus')
      expect(input).not.toHaveProperty('declaredByUserId') // never selectable — resolved server-side from the session
    })

    it('cannot verify or revoke a pending declaration (buttons absent)', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true, initialItems: [PENDING_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      expect(screen.queryByText(/^verificar$/i)).toBeNull()
      expect(screen.queryByText(/^revocar$/i)).toBeNull()
    })

    it('rejects a non-positive-integer group size client-side without calling the server action', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      fireEvent.click(screen.getByText(/declarar agregado/i))
      fireEvent.change(screen.getByPlaceholderText(/mín\. 10/i), { target: { value: '-3' } })
      fireEvent.click(screen.getByText(/^declarar$/i))
      expect(screen.queryByText(/entero positivo/i)).not.toBeNull()
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('limits dimension selection to MAX_AGGREGATION_DIMENSIONS (2) — a 3rd checkbox is disabled once 2 are checked', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      fireEvent.click(screen.getByText(/declarar agregado/i))
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
      fireEvent.click(checkboxes[0])
      fireEvent.click(checkboxes[1])
      expect(checkboxes[2].disabled).toBe(true)
    })

    it('shows the server-provided message verbatim on a below-threshold rejection (group 9)', async () => {
      mockCreate.mockResolvedValue({
        ok: false,
        error: 'GROUP_SIZE_BELOW_THRESHOLD',
        message: 'El tamaño de grupo declarado es menor al mínimo permitido. Agrupa categorías, amplía el período, o excluye este dato hasta contar con un grupo más grande.',
      })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      fireEvent.click(screen.getByText(/declarar agregado/i))
      fireEvent.change(screen.getByPlaceholderText(/mín\. 10/i), { target: { value: '9' } })
      fireEvent.click(screen.getByText(/^declarar$/i))
      await waitFor(() => {
        expect(screen.queryByText(/menor al mínimo permitido/i)).not.toBeNull()
      })
      // Never invents its own copy of a blocking reason — only ever echoes the server's non-leaky message.
      expect(screen.queryByText(/9/)).toBeNull()
    })

    it('a prohibited-dimension rejection surfaces the server message, not a client-invented one', async () => {
      mockCreate.mockResolvedValue({
        ok: false,
        error: 'INVALID_DIMENSIONS',
        message: 'La declaración incluye una dimensión no permitida.',
      })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      fireEvent.click(screen.getByText(/declarar agregado/i))
      fireEvent.change(screen.getByPlaceholderText(/mín\. 10/i), { target: { value: '40' } })
      fireEvent.click(screen.getByText(/^declarar$/i))
      await waitFor(() => {
        expect(screen.queryByText(/dimensión no permitida/i)).not.toBeNull()
      })
    })

    it('refreshes the list after a successful create (double-submit guard: refetch replaces stale state)', async () => {
      mockCreate.mockResolvedValue({ ok: true, id: 'new-decl' })
      mockList.mockResolvedValue({ ok: true, items: [PENDING_ITEM] })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true })} />)
      fireEvent.click(screen.getByText(/declarar agregado/i))
      fireEvent.change(screen.getByPlaceholderText(/mín\. 10/i), { target: { value: '40' } })
      fireEvent.click(screen.getByText(/^declarar$/i))
      await waitFor(() => {
        expect(mockList).toHaveBeenCalledWith('proj-1', 'outcome', 'o-1')
      })
    })

    it('a verified declaration shows "Sustituir" (never "Editar")', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true, initialItems: [VERIFIED_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      expect(screen.queryByText(/^sustituir$/i)).not.toBeNull()
      expect(screen.queryByText(/editar/i)).toBeNull()
    })

    it('supersede pre-fills the form from the previous declaration and calls supersedeAggregationDeclaration with its id', async () => {
      mockSupersede.mockResolvedValue({ ok: true, id: 'new-decl' })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canCreateOrSupersede: true, initialItems: [VERIFIED_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      fireEvent.click(screen.getAllByText(/^sustituir$/i)[0]) // opens the form (the row's trigger button)
      expect((screen.getByPlaceholderText(/mín\. 10/i) as HTMLInputElement).value).toBe('60')
      const submitButtons = screen.getAllByText(/^sustituir$/i)
      fireEvent.click(submitButtons[submitButtons.length - 1]) // the form's submit button, not the row trigger
      await waitFor(() => {
        expect(mockSupersede).toHaveBeenCalledWith('decl-verified', expect.objectContaining({ groupSize: 60 }))
      })
    })
  })

  describe('Organization admin (can verify/revoke, cannot create/supersede here)', () => {
    it('shows "Verificar" for a pending declaration and calls verifyAggregationDeclaration with its id', async () => {
      mockVerify.mockResolvedValue({ ok: true, id: 'decl-pending' })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canVerifyOrRevoke: true, initialItems: [PENDING_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      fireEvent.click(screen.getByText(/^verificar$/i))
      await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('decl-pending'))
    })

    it('does not render "Declarar agregado" or "Sustituir" (lacks create/supersede rights)', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canVerifyOrRevoke: true, initialItems: [VERIFIED_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      expect(screen.queryByText(/declarar agregado/i)).toBeNull()
      expect(screen.queryByText(/^sustituir$/i)).toBeNull()
    })

    it('revoke requires an explicit confirmation step (destructive action) — first click only reveals the confirm control', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canVerifyOrRevoke: true, initialItems: [VERIFIED_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      fireEvent.click(screen.getByText(/^revocar$/i))
      expect(mockRevoke).not.toHaveBeenCalled()
      expect(screen.queryByText(/confirmar revocación/i)).not.toBeNull()
    })

    it('revoke only fires after the confirm step, passing the reason typed in', async () => {
      mockRevoke.mockResolvedValue({ ok: true, id: 'decl-verified' })
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canVerifyOrRevoke: true, initialItems: [VERIFIED_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      fireEvent.click(screen.getByText(/^revocar$/i))
      fireEvent.change(screen.getByPlaceholderText(/motivo/i), { target: { value: 'grupo disuelto' } })
      fireEvent.click(screen.getByText(/confirmar revocación/i))
      await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('decl-verified', 'grupo disuelto'))
    })

    it('canceling the revoke confirmation never calls the server action', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ canVerifyOrRevoke: true, initialItems: [VERIFIED_ITEM] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      fireEvent.click(screen.getByText(/^revocar$/i))
      fireEvent.click(screen.getByText(/cancelar/i))
      expect(mockRevoke).not.toHaveBeenCalled()
      expect(screen.queryByText(/confirmar revocación/i)).toBeNull()
    })
  })

  describe('History visibility and outdated/inactive statuses', () => {
    const REVOKED_ITEM: EntityDeclarationHistoryItem = { ...VERIFIED_ITEM, id: 'decl-revoked', verificationStatus: 'revoked' }
    const SUPERSEDED_ITEM: EntityDeclarationHistoryItem = { ...VERIFIED_ITEM, id: 'decl-superseded', verificationStatus: 'superseded' }

    it('history is hidden by default (only the revoked/superseded rows, which never appear in the summary, are a clean absence check)', () => {
      render(
        <OutcomeSensitiveAggregationPanel
          {...baseProps({ initialItems: [PENDING_ITEM, VERIFIED_ITEM, REVOKED_ITEM, SUPERSEDED_ITEM] })}
        />,
      )
      expect(screen.queryByText(/^revocada$/i)).toBeNull()
      expect(screen.queryByText(/^sustituida$/i)).toBeNull()
    })

    it('toggling history shows every declaration, including revoked and superseded ones', () => {
      render(
        <OutcomeSensitiveAggregationPanel
          {...baseProps({ initialItems: [PENDING_ITEM, VERIFIED_ITEM, REVOKED_ITEM, SUPERSEDED_ITEM] })}
        />,
      )
      fireEvent.click(screen.getByText(/ver historial/i))
      expect(screen.queryAllByText(/pendiente de verificación/i).length).toBeGreaterThan(0)
      expect(screen.queryByText(/^revocada$/i)).not.toBeNull()
      expect(screen.queryByText(/^sustituida$/i)).not.toBeNull()
    })

    it('revoked/superseded declarations never show action buttons regardless of role', () => {
      render(
        <OutcomeSensitiveAggregationPanel
          {...baseProps({ canCreateOrSupersede: true, canVerifyOrRevoke: true, initialItems: [REVOKED_ITEM, SUPERSEDED_ITEM] })}
        />,
      )
      fireEvent.click(screen.getByText(/ver historial/i))
      expect(screen.queryByText(/^verificar$/i)).toBeNull()
      expect(screen.queryByText(/^revocar$/i)).toBeNull()
      expect(screen.queryByText(/^sustituir$/i)).toBeNull()
    })

    it('only active (pending/verified) declarations appear in the compact summary badges, never revoked/superseded', () => {
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ initialItems: [PENDING_ITEM, REVOKED_ITEM, SUPERSEDED_ITEM] })} />)
      // Summary (not history) shows only the active pending badge.
      expect(screen.queryByText(/pendiente de verificación/i)).not.toBeNull()
      const revokedBadges = screen.queryAllByText(/^revocada$/i)
      expect(revokedBadges).toHaveLength(0)
    })
  })

  describe('Non-leaky rendering', () => {
    it('never renders raw declaredBy/verifiedBy/revokedBy identifiers as visible text labels', () => {
      const trimmed = { ...VERIFIED_ITEM } as EntityDeclarationHistoryItem
      // Simulate the server action's viewer-trimmed shape (fields absent).
      const { declaredBy: _d, verifiedBy: _v, revokedBy: _r, revocationReason: _rr, ...rest } = trimmed as unknown as Record<string, unknown>
      render(<OutcomeSensitiveAggregationPanel {...baseProps({ initialItems: [rest as EntityDeclarationHistoryItem] })} />)
      fireEvent.click(screen.getByText(/ver historial/i))
      expect(screen.queryByText(/user-b/)).toBeNull()
      expect(screen.queryByText(/declarada/i)).toBeNull() // date/actor line only renders when actor fields are present
    })
  })
})
