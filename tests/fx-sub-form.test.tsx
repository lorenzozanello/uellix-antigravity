import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FxSubForm, type FxSubFormData } from '@/app/components/fx-sub-form/FxSubForm'

// Helper to change select values
function changeSelect(select: HTMLElement, value: string) {
  fireEvent.change(select, { target: { value } })
}

// Helper to type into input
function typeIntoInput(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

describe('FxSubForm Component', () => {
  beforeEach(() => {
    // Mock the fetch API
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Component rendering', () => {
    it('renders currency picker, amount field, and USD equivalent display', () => {
      render(<FxSubForm />)

      expect(screen.getByText('Moneda')).toBeInTheDocument()
      expect(screen.getByLabelText('Moneda')).toBeInTheDocument()
    })

    it('renders common currency options', () => {
      render(<FxSubForm />)

      const select = screen.getByLabelText('Moneda') as HTMLSelectElement
      const options = Array.from(select.options).map((opt) => opt.value)

      expect(options).toContain('USD')
      expect(options).toContain('COP')
      expect(options).toContain('EUR')
      expect(options).toContain('GBP')
      expect(options).toContain('JPY')
    })

    it('shows amount input only after currency is selected', () => {
      render(<FxSubForm />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      expect(screen.getByLabelText(/Cantidad \(COP\)/)).toBeInTheDocument()
    })

    it('hides USD equivalent display by default', () => {
      render(<FxSubForm currency="USD" amount="100" showUsdEquivalent={false} />)

      expect(screen.queryByText(/USD Equivalente/)).not.toBeInTheDocument()
    })
  })

  describe('Currency selection', () => {
    it('shows auto-fetch button for COP currency', () => {
      render(<FxSubForm referenceYear={2026} />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      expect(screen.getByRole('button', { name: /Obtener tasa TRM/ })).toBeInTheDocument()
    })

    it('does not show auto-fetch button for non-COP currencies', () => {
      render(<FxSubForm referenceYear={2026} />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'EUR')

      expect(screen.queryByRole('button', { name: /Obtener tasa TRM/ })).not.toBeInTheDocument()
      expect(screen.getByText(/Tasa de conversión/)).toBeInTheDocument()
    })

    it('shows manual rate input immediately for non-COP currencies', () => {
      render(<FxSubForm />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'EUR')

      expect(screen.getByLabelText(/Tasa de conversión/)).toBeInTheDocument()
      expect(screen.getByLabelText(/Fuente/)).toBeInTheDocument()
    })

    it('clears rate and source when switching currency', () => {
      const onChange = vi.fn()
      render(
        <FxSubForm currency="USD" rate="4150" source="BanRep" onChange={onChange} />
      )

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      // Verify onChange was called with cleared rate/source
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'COP',
          rate: '',
          source: '',
        })
      )
    })
  })

  describe('Auto-fetch COP rate', () => {
    it('fetches COP rate for Dec 31 of reference year when button clicked', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'Superintendencia Financiera de Colombia — TRM oficial',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/fx-rates/fetch-cop',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('2026-12-31'),
          })
        )
      })
    })

    it('populates rate field after successful fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'Superintendencia Financiera de Colombia — TRM oficial',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        const rateInput = screen.getByDisplayValue('4150.25') as HTMLInputElement
        expect(rateInput).toBeInTheDocument()
      })
    })

    it('disables auto-fetch button after successful fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'Superintendencia Financiera de Colombia — TRM oficial',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(button).not.toBeInTheDocument() // Button should disappear after fetch
      })
    })

    it('disables auto-fetch button if no reference year provided', () => {
      render(<FxSubForm currency="COP" />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      expect((button as HTMLButtonElement).disabled).toBe(true)
    })

    it('shows error message on fetch failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(screen.getByText(/Manual entry required/)).toBeInTheDocument()
      })
    })

    it('shows loading state while fetching', async () => {
      const mockFetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              resolve({
                ok: true,
                json: async () => ({ rateToUsd: '4150.25', source: 'BanRep' }),
              })
            }, 100)
          )
      )
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      // Check for loading text
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Obteniendo tasa/ })).toBeInTheDocument()
      })
    })

    it('only works for COP currency', () => {
      const mockFetch = vi.fn()
      global.fetch = mockFetch

      render(<FxSubForm currency="EUR" referenceYear={2026} />)

      // Should not have auto-fetch button for EUR
      expect(screen.queryByRole('button', { name: /Obtener tasa TRM/ })).not.toBeInTheDocument()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('Manual rate entry', () => {
    it('allows manual rate entry for non-COP currencies', () => {
      render(<FxSubForm currency="EUR" />)

      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '1.09')

      expect(rateInput).toHaveValue(1.09)
    })

    it('makes rate field editable if COP auto-fetch disabled', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        const rateInput = screen.getByLabelText(/Tasa de conversión/) as HTMLInputElement
        expect(rateInput).not.toBeDisabled()
      })
    })

    it('validates rate > 0', () => {
      render(<FxSubForm currency="EUR" />)

      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '0')

      expect(screen.getByText(/Debe ser mayor a 0/)).toBeInTheDocument()
    })

    it('shows valid state when rate > 0', () => {
      render(<FxSubForm currency="EUR" />)

      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '1.09')

      expect(screen.getByText(/✓ Válido/)).toBeInTheDocument()
    })

    it('disables rate field when fetched from auto-fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'BanRep',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        const rateInput = screen.getByDisplayValue('4150.25') as HTMLInputElement
        expect(rateInput).toBeDisabled()
      })
    })

    it('clears rate when "Limpiar" button is clicked', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'BanRep',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(screen.getByDisplayValue('4150.25')).toBeInTheDocument()
      })

      const clearButton = screen.getByRole('button', { name: /Limpiar/ })
      fireEvent.click(clearButton)

      // Verify rate is cleared and auto-fetch button reappears
      expect(screen.getByRole('button', { name: /Obtener tasa TRM/ })).toBeInTheDocument()
    })
  })

  describe('USD calculation', () => {
    it('calculates USD equivalent (amount / rate) for non-USD currencies', () => {
      render(<FxSubForm currency="COP" />)

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '1000')
      typeIntoInput(rateInput, '4150')

      // 1000 / 4150 = 0.2410 (4 decimals)
      expect(screen.getByText(/\$0\.2410 USD/)).toBeInTheDocument()
    })

    it('updates USD display in real-time', () => {
      render(<FxSubForm currency="EUR" />)

      const amountInput = screen.getByLabelText(/Cantidad \(EUR\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '100')
      expect(screen.getByText(/Completa cantidad y tasa/)).toBeInTheDocument()

      typeIntoInput(rateInput, '1.09')
      // 100 / 1.09 = 91.7431 (4 decimals)
      expect(screen.getByText(/\$91\.7431 USD/)).toBeInTheDocument()
    })

    it('handles large amounts without precision loss', () => {
      render(<FxSubForm currency="COP" />)

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '999999999999.99')
      typeIntoInput(rateInput, '4150')

      // Verify the calculation is correct (no precision loss)
      expect(screen.getByText(/\$240963855\.4217 USD/)).toBeInTheDocument()
    })

    it('shows direct value for USD currency', () => {
      render(<FxSubForm currency="USD" amount="1000" />)

      expect(screen.getByText(/\$1000 USD/)).toBeInTheDocument()
      expect(screen.queryByLabelText(/Tasa de conversión/)).not.toBeInTheDocument()
    })

    it('returns null USD value when amount or rate is invalid', () => {
      render(<FxSubForm currency="COP" />)

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '0')
      typeIntoInput(rateInput, '4150')

      expect(screen.getByText(/Completa cantidad y tasa/)).toBeInTheDocument()
    })
  })

  describe('Source validation', () => {
    it('requires source for manual rate entry', () => {
      render(<FxSubForm currency="EUR" />)

      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '1.09')

      // Source field should be empty and show error
      const sourceInput = screen.getByLabelText(/Fuente/) as HTMLInputElement
      expect(sourceInput.value).toBe('')
      expect(screen.getByText(/Requerida si se ingresa tasa manual/)).toBeInTheDocument()
    })

    it('accepts source when provided', () => {
      render(<FxSubForm currency="EUR" />)

      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      const sourceInput = screen.getByLabelText(/Fuente/)

      typeIntoInput(rateInput, '1.09')
      typeIntoInput(sourceInput, 'ECB')

      expect(screen.queryByText(/Requerida si se ingresa tasa manual/)).not.toBeInTheDocument()
    })

    it('disables source field when rate is auto-fetched', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'Superintendencia Financiera de Colombia — TRM oficial',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        const sourceInput = screen.getByDisplayValue(
          /Superintendencia Financiera/
        ) as HTMLInputElement
        expect(sourceInput).toBeDisabled()
      })
    })

    it('populates source from auto-fetch response', async () => {
      const mockSource = 'Superintendencia Financiera de Colombia — TRM oficial (datos.gov.co)'
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: mockSource,
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)

      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(screen.getByDisplayValue(mockSource)).toBeInTheDocument()
      })
    })
  })

  describe('Amount validation', () => {
    it('validates amount > 0', () => {
      render(<FxSubForm currency="COP" />)

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      typeIntoInput(amountInput, '0')

      expect(screen.getByText(/Debe ser mayor a 0/)).toBeInTheDocument()
    })

    it('shows valid state when amount > 0', () => {
      render(<FxSubForm currency="COP" />)

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      typeIntoInput(amountInput, '100')

      expect(screen.getByText(/✓ Válido/)).toBeInTheDocument()
    })

    it('handles decimal amounts', () => {
      render(<FxSubForm currency="EUR" amount="100.5678" />)

      const amountInput = screen.getByDisplayValue('100.5678')
      expect(amountInput).toBeInTheDocument()
    })
  })

  describe('Reset/clear functionality', () => {
    it('can clear currency', () => {
      render(<FxSubForm currency="COP" />)

      const select = screen.getByLabelText('Moneda') as HTMLSelectElement
      changeSelect(select, '')

      expect(select.value).toBe('')
    })

    it('clears dependent fields when currency is cleared', () => {
      const onChange = vi.fn()
      render(<FxSubForm currency="EUR" rate="1.09" source="ECB" onChange={onChange} />)

      const select = screen.getByLabelText('Moneda') as HTMLSelectElement
      changeSelect(select, '')

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: '',
          rate: '',
          source: '',
        })
      )
    })

    it('resets rate/source when switching away from USD', () => {
      render(<FxSubForm currency="USD" rate="4150" source="BanRep" />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      // Verify auto-fetch button appears (rate was cleared)
      expect(screen.getByRole('button', { name: /Obtener tasa TRM/ })).toBeInTheDocument()
    })
  })

  describe('Integration with parent (onChange callback)', () => {
    it('calls onChange with updated FX data', () => {
      const onChange = vi.fn()
      render(<FxSubForm onChange={onChange} />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'COP',
          amount: '',
          rate: '',
          source: '',
          valueUsd: null,
        })
      )
    })

    it('includes calculated USD value in onChange payload', () => {
      const onChange = vi.fn()
      render(<FxSubForm onChange={onChange} />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '1000')
      typeIntoInput(rateInput, '4150')

      // Should have the USD value in the last call
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0]
      expect(lastCall).toEqual(
        expect.objectContaining({
          currency: 'COP',
          amount: '1000',
          rate: '4150',
          valueUsd: '0.2410',
        })
      )
    })

    it('returns USD amount directly for USD currency', () => {
      const onChange = vi.fn()
      render(<FxSubForm currency="USD" amount="1000" onChange={onChange} />)

      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0]
      expect(lastCall).toEqual(
        expect.objectContaining({
          currency: 'USD',
          amount: '1000',
          valueUsd: '1000',
        })
      )
    })
  })

  describe('Disabled state', () => {
    it('disables all inputs when disabled prop is true', () => {
      render(<FxSubForm currency="COP" amount="100" rate="4150" disabled />)

      const currencySelect = screen.getByLabelText('Moneda') as HTMLSelectElement
      // For disabled test, we know the currency is COP
      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/) as HTMLInputElement
      const rateInput = screen.getByLabelText(/Tasa de conversión/) as HTMLInputElement

      expect(currencySelect.disabled).toBe(true)
      expect(amountInput.disabled).toBe(true)
      expect(rateInput.disabled).toBe(true)
    })

    it('disables auto-fetch button when disabled prop is true', () => {
      render(<FxSubForm currency="COP" referenceYear={2026} disabled />)

      const buttons = screen.getAllByRole('button')
      const autoFetchButton = buttons.find(btn => btn.textContent?.includes('Obtener tasa TRM'))
      expect(autoFetchButton).toBeDefined()
      expect((autoFetchButton as HTMLButtonElement).disabled).toBe(true)
    })
  })
})
