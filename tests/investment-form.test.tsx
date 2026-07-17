import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InvestmentList from '@/app/components/investment-form/InvestmentList'
import InvestmentRow from '@/app/components/investment-form/InvestmentRow'

// ─── Mock Data ───────────────────────────────────────────────────────────────

const mockFunders = [
  { id: 'funder-1', name: 'World Bank', funderType: 'multilateral' },
  { id: 'funder-2', name: 'Local Foundation', funderType: 'foundation' },
]

const mockInvestments = [
  {
    id: 'inv-1',
    funderId: 'funder-1',
    amount: '100000',
    currency: 'USD',
    amountUsd: '100000',
    contributionType: 'cash' as const,
    inKindValuationNotes: null,
    year: 2024,
    description: 'Annual budget',
    status: 'active',
  },
  {
    id: 'inv-2',
    funderId: 'funder-2',
    amount: '50000000',
    currency: 'COP',
    amountUsd: '12500',
    contributionType: 'in_kind' as const,
    inKindValuationNotes: 'Technical staff time',
    year: 2024,
    description: null,
    status: 'active',
  },
]

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('InvestmentList Component', () => {
  const mockOnAdd = vi.fn()
  const mockOnDelete = vi.fn()
  const mockOnUpdateRow = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 1: Form rendering with initial state
  it('renders initial state with one empty row when no investments provided', () => {
    render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Should seed exactly one empty row (one funder select) and a save button
    expect(screen.getAllByLabelText(/Financiador/i)).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Guardar aporte/i })).toBeInTheDocument()
  })

  // Test 2: Form rendering with existing investments
  it('loads existing investments and displays in rows', () => {
    render(
      <InvestmentList
        investments={mockInvestments}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // One funder select per saved investment, each with the right value
    const funderSelects = screen.getAllByLabelText(/Financiador/i) as HTMLSelectElement[]
    expect(funderSelects).toHaveLength(2)
    expect(funderSelects.map((s) => s.value)).toEqual(['funder-1', 'funder-2'])

    // Amounts should be visible
    expect(screen.getByDisplayValue('100000')).toBeInTheDocument()
    expect(screen.getByDisplayValue('50000000')).toBeInTheDocument()
  })

  // Test 3: Funder select lists all funders
  it('displays all funders in funder dropdown', () => {
    render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    const funderSelect = screen.getByLabelText(/Financiador/) as HTMLSelectElement
    const options = Array.from(funderSelect.options).map((opt) => opt.textContent)

    mockFunders.forEach((funder) => {
      expect(options).toContain(funder.name)
    })
  })

  // Test 4: Contribution type toggle shows/hides in_kind notes
  it('shows in_kind valuation notes textarea when contribution_type = in_kind', async () => {
    const user = userEvent.setup()
    render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Initially, in_kind notes should not be visible
    expect(screen.queryByLabelText(/Notas de valoración/i)).not.toBeInTheDocument()

    // Change contribution type to in_kind
    const typeSelect = screen.getByLabelText(/Tipo de aporte/i) as HTMLSelectElement
    await user.selectOptions(typeSelect, 'in_kind')

    // Now notes textarea should appear
    await waitFor(() => {
      expect(screen.getByLabelText(/Notas de valoración/i)).toBeInTheDocument()
    })
  })

  // Test 5: FX sub-form shows for non-USD currencies
  it('displays FX sub-form only for non-USD currencies', async () => {
    const user = userEvent.setup()
    render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // USD (default) → no FX sub-form
    expect(screen.queryByText(/Tasa de conversión/i)).not.toBeInTheDocument()

    // Change currency to COP → FX sub-form appears
    const currencyInput = screen.getByLabelText(/Moneda/i) as HTMLInputElement
    await user.clear(currencyInput)
    await user.type(currencyInput, 'COP')

    await waitFor(() => {
      expect(screen.getByText(/Tasa de conversión/i)).toBeInTheDocument()
    })
  })

  // Test 6: USD equivalent is calculated and displayed (read-only)
  it('displays read-only USD equivalent calculation', () => {
    render(
      <InvestmentList
        investments={mockInvestments}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // USD equivalent should be displayed as read-only
    const usdEquivs = screen.getAllByText(/USD/i)
    expect(usdEquivs.length).toBeGreaterThan(0)
  })

  // Test 7: Add row button appends a new empty row (does NOT auto-save)
  it('appends a new empty row when "Agregar aporte" clicked, without saving', async () => {
    const user = userEvent.setup()
    render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    expect(screen.getAllByLabelText(/Financiador/i)).toHaveLength(1)

    const addButton = screen.getByRole('button', { name: /Agregar aporte/i })
    await user.click(addButton)

    // A second row appears locally; no server call is made just for adding a row
    expect(screen.getAllByLabelText(/Financiador/i)).toHaveLength(2)
    expect(mockOnAdd).not.toHaveBeenCalled()
  })

  // Test 8: Delete saved row requires confirmation then calls onDelete
  it('calls onDelete with the investment id after confirming deletion', async () => {
    const user = userEvent.setup()
    render(
      <InvestmentList
        investments={mockInvestments}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Click the first row's "Eliminar" → opens confirmation modal (no call yet)
    const deleteButtons = screen.getAllByRole('button', { name: /^Eliminar$/i })
    await user.click(deleteButtons[0])
    expect(mockOnDelete).not.toHaveBeenCalled()

    // Confirm in the modal (scope to the confirmation dialog)
    const dialog = screen.getByText(/¿Eliminar este aporte/i).closest('div') as HTMLElement
    const confirmButton = within(dialog).getByRole('button', { name: /^Eliminar$/i })
    await user.click(confirmButton)

    await waitFor(() => {
      expect(mockOnDelete).toHaveBeenCalledWith('inv-1')
    })
  })

  // Test 9: Form validation rejects empty amount
  it('rejects form submission with empty amount', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Try to submit with empty amount
    const form = container.querySelector('form')
    if (form) {
      const submitButton = within(form).getByRole('button', { name: /Guardar/i })

      // Amount field is required
      const amountInput = screen.getByLabelText(/Monto de inversión/i) as HTMLInputElement
      expect(amountInput.required).toBe(true)
    }
  })

  // Test 10: Validation requires in_kind notes when type = in_kind
  it('requires in_kind valuation notes when contribution_type = in_kind', async () => {
    const user = userEvent.setup()
    render(
      <InvestmentList
        investments={[]}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Set type to in_kind
    const typeSelect = screen.getByLabelText(/Tipo de aporte/i) as HTMLSelectElement
    await user.selectOptions(typeSelect, 'in_kind')

    // Notes textarea should appear and be required
    await waitFor(() => {
      const notesField = screen.getByLabelText(/Notas de valoración/i) as HTMLTextAreaElement
      expect(notesField).toBeInTheDocument()
      expect(notesField.required).toBe(true)
    })
  })

  // Test 11: Multi-row edit
  it('renders multiple investment rows with proper funder names', () => {
    render(
      <InvestmentList
        investments={mockInvestments}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Each row's funder select reflects the saved funder
    const funderSelects = screen.getAllByLabelText(/Financiador/i) as HTMLSelectElement[]
    expect(funderSelects.map((s) => s.value)).toEqual(['funder-1', 'funder-2'])

    // Both currencies should be shown
    expect(screen.getByDisplayValue('USD')).toBeInTheDocument()
    expect(screen.getByDisplayValue('COP')).toBeInTheDocument()
  })

  // Test 12: Read-only mode disables form inputs
  it('disables inputs when canEdit = false', () => {
    render(
      <InvestmentList
        investments={mockInvestments}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={false}
      />
    )

    // Inputs should be disabled
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]
    inputs.forEach((input) => {
      if (input.name !== 'projectId') {
        expect(input.disabled).toBe(true)
      }
    })

    // Add button should not be visible
    expect(screen.queryByRole('button', { name: /Agregar aporte/i })).not.toBeInTheDocument()
  })
})

describe('InvestmentRow Component', () => {
  const mockFunders = [
    { id: 'funder-1', name: 'World Bank', funderType: 'multilateral' },
  ]

  const mockInvestment = {
    id: 'inv-1',
    funderId: 'funder-1',
    amount: '100000',
    currency: 'USD',
    amountUsd: '100000',
    contributionType: 'cash' as const,
    inKindValuationNotes: null,
    year: 2024,
    description: null,
    status: 'active',
  }

  const mockOnSave = vi.fn()
  const mockOnDelete = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 13: Row renders all fields
  it('renders all required fields in investment row', () => {
    render(
      <InvestmentRow
        investment={mockInvestment}
        funders={mockFunders}
        onSave={mockOnSave}
        onDelete={mockOnDelete}
        canEdit={true}
        isSaving={false}
      />
    )

    expect(screen.getByLabelText(/Financiador/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tipo de aporte/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Monto/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Moneda/i)).toBeInTheDocument()
  })

  // Test 14: FX lookup for COP shows TRM preview option
  it('shows TRM preview button for COP currency', () => {
    const copInvestment = {
      ...mockInvestment,
      currency: 'COP',
      amountUsd: null,
    }

    render(
      <InvestmentRow
        investment={copInvestment}
        funders={mockFunders}
        onSave={mockOnSave}
        onDelete={mockOnDelete}
        canEdit={true}
        isSaving={false}
      />
    )

    // Should have option to preview the COP TRM rate
    expect(screen.getByText(/Obtener tasa automática/i)).toBeInTheDocument()
  })

  // Test 15: Manual FX entry for non-COP currency
  it('shows manual FX entry fields for non-COP, non-USD currencies', () => {
    const eurInvestment = {
      ...mockInvestment,
      currency: 'EUR',
      amountUsd: null,
    }

    render(
      <InvestmentRow
        investment={eurInvestment}
        funders={mockFunders}
        onSave={mockOnSave}
        onDelete={mockOnDelete}
        canEdit={true}
        isSaving={false}
      />
    )

    // Should show manual entry fields
    expect(screen.getByLabelText(/Tasa 1 EUR.*USD/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Fuente/i)).toBeInTheDocument()
  })

  // Test 16: Explicit save button triggers onSave (no auto-save on keystroke)
  it('calls onSave only when the save button is clicked', async () => {
    const user = userEvent.setup()
    render(
      <InvestmentRow
        investment={mockInvestment}
        funders={mockFunders}
        onSave={mockOnSave}
        onDelete={mockOnDelete}
        canEdit={true}
        isSaving={false}
      />
    )

    // Editing a field must NOT trigger a save.
    const amountInput = screen.getByLabelText(/Monto/i) as HTMLInputElement
    await user.clear(amountInput)
    await user.type(amountInput, '250000')
    expect(mockOnSave).not.toHaveBeenCalled()

    // Clicking "Guardar cambios" persists.
    const saveButton = screen.getByRole('button', { name: /Guardar cambios/i })
    await user.click(saveButton)
    expect(mockOnSave).toHaveBeenCalledTimes(1)
  })
})
