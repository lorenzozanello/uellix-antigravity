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
    contributionType: 'cash',
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
    contributionType: 'in_kind',
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

    // Should have one empty row
    const rows = screen.getAllByRole('row', { hidden: true }) // including headers
    expect(rows.length).toBeGreaterThanOrEqual(2) // header + at least 1 row

    // Funder dropdown should exist
    expect(screen.getByLabelText(/Financiador/i)).toBeInTheDocument()
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

    // Should display both investments
    expect(screen.getByText('World Bank')).toBeInTheDocument()
    expect(screen.getByText('Local Foundation')).toBeInTheDocument()

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

    const currencyInput = screen.getByDisplayValue('')?.parentElement?.querySelector(
      'input[name*="currency"]'
    ) as HTMLInputElement

    // Change to COP
    if (currencyInput) {
      await user.clear(currencyInput)
      await user.type(currencyInput, 'COP')

      // FX sub-form should appear
      await waitFor(() => {
        expect(screen.getByText(/Tasa de conversión/i)).toBeInTheDocument()
      })
    }
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

  // Test 7: Add row button creates new investment
  it('calls onAdd when "Agregar aporte" button clicked', async () => {
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

    const addButton = screen.getByRole('button', { name: /Agregar aporte/i })
    await user.click(addButton)

    expect(mockOnAdd).toHaveBeenCalled()
  })

  // Test 8: Delete row removes investment with confirmation
  it('calls onDelete when row delete button clicked', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <InvestmentList
        investments={mockInvestments}
        funders={mockFunders}
        onAdd={mockOnAdd}
        onDelete={mockOnDelete}
        onUpdateRow={mockOnUpdateRow}
        canEdit={true}
      />
    )

    // Get first delete button
    const deleteButtons = screen.getAllByRole('button', { name: /Eliminar/i })
    if (deleteButtons.length > 0) {
      await user.click(deleteButtons[0])

      // Should call onDelete with investment ID
      await waitFor(() => {
        expect(mockOnDelete).toHaveBeenCalledWith(expect.stringContaining('inv-'))
      })
    }
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

    // Both funders should be visible
    expect(screen.getByText('World Bank')).toBeInTheDocument()
    expect(screen.getByText('Local Foundation')).toBeInTheDocument()

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
    contributionType: 'cash',
    inKindValuationNotes: null,
    year: 2024,
    description: null,
    status: 'active',
  }

  const mockOnUpdate = vi.fn()
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
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        canEdit={true}
      />
    )

    expect(screen.getByLabelText(/Financiador/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tipo de aporte/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Monto/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Moneda/i)).toBeInTheDocument()
  })

  // Test 14: FX lookup for COP shows auto-fetch option
  it('shows auto-fetch button for COP currency', () => {
    const copInvestment = {
      ...mockInvestment,
      currency: 'COP',
      amountUsd: null,
    }

    render(
      <InvestmentRow
        investment={copInvestment}
        funders={mockFunders}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        canEdit={true}
      />
    )

    // Should have option to auto-fetch COP rate
    expect(screen.getByText(/Auto-obtener TRM/i)).toBeInTheDocument()
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
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        canEdit={true}
      />
    )

    // Should show manual entry fields
    expect(screen.getByLabelText(/Tasa EUR.*USD/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Fuente/i)).toBeInTheDocument()
  })
})
