import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FxSubForm } from '@/app/components/fx-sub-form/FxSubForm'

// Tag this test file to run with jsdom environment
/** @vitest environment jsdom */

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
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Component rendering', () => {
    it('renders currency picker', () => {
      render(<FxSubForm />)
      expect(screen.getByLabelText('Moneda')).toBeTruthy()
    })

    it('renders common currency options', () => {
      render(<FxSubForm />)
      const select = screen.getByLabelText('Moneda') as HTMLSelectElement
      const options = Array.from(select.options).map((opt) => opt.value)

      expect(options).toContain('USD')
      expect(options).toContain('COP')
      expect(options).toContain('EUR')
    })

    it('shows amount input only after currency is selected', () => {
      render(<FxSubForm />)
      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      expect(screen.getByLabelText(/Cantidad \(COP\)/)).toBeTruthy()
    })
  })

  describe('Currency selection', () => {
    it('shows auto-fetch button for COP currency', () => {
      render(<FxSubForm referenceYear={2026} />)
      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      expect(screen.getByRole('button', { name: /Obtener tasa automática/ })).toBeTruthy()
    })

    it('shows auto-fetch button for non-COP currencies too', () => {
      render(<FxSubForm />)
      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'EUR')

      expect(screen.getByRole('button', { name: /Obtener tasa automática/ })).toBeTruthy()
    })
  })

  describe('Auto-fetch rate', () => {
    it('fetches rate when button clicked', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rateToUsd: '4150.25',
          source: 'Superintendencia Financiera de Colombia — TRM oficial',
        }),
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)
      const button = screen.getByRole('button', { name: /Obtener tasa automática/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/fx-rates/fetch',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('2026-12-31'),
          })
        )
      })
    })

    it('populates rate field after fetch success', async () => {
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
        expect(screen.getByDisplayValue('4150.25')).toBeTruthy()
      })
    })

    it('disables button if no reference year', () => {
      render(<FxSubForm currency="COP" />)
      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })

    it('shows error on fetch failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
      global.fetch = mockFetch

      render(<FxSubForm currency="COP" referenceYear={2026} />)
      const button = screen.getByRole('button', { name: /Obtener tasa TRM/ })
      fireEvent.click(button)

      await waitFor(() => {
        expect(screen.getByText(/Manual entry required/)).toBeTruthy()
      })
    })
  })

  describe('Manual rate entry', () => {
    it('allows manual rate for non-COP currencies', () => {
      render(<FxSubForm currency="EUR" />)
      const rateInput = screen.getByLabelText(/Tasa de conversión/) as HTMLInputElement
      typeIntoInput(rateInput, '1.09')

      expect(rateInput.value).toBe('1.09')
    })

    it('validates rate > 0', () => {
      render(<FxSubForm currency="EUR" />)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '0')

      expect(screen.getAllByText(/Debe ser mayor a 0/).length).toBeGreaterThan(0)
    })

    it('shows valid state when rate valid', () => {
      render(<FxSubForm currency="EUR" />)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '1.09')

      expect(screen.getAllByText(/✓ Válido/).length).toBeGreaterThan(0)
    })
  })

  describe('USD calculation', () => {
    it('calculates USD equivalent correctly', () => {
      render(<FxSubForm currency="COP" />)
      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '1000')
      typeIntoInput(rateInput, '4150')

      // 1000 / 4150 = 0.2410
      expect(screen.getByText(/\$0\.2410 USD/)).toBeTruthy()
    })

    it('displays USD direct for USD currency', () => {
      render(<FxSubForm currency="USD" amount="1000" />)
      expect(screen.getByText(/\$1000 USD/)).toBeTruthy()
    })

    it('handles large amounts without precision loss', () => {
      render(<FxSubForm currency="COP" />)
      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '999999999999.99')
      typeIntoInput(rateInput, '4150')

      expect(screen.getByText(/\$240963855\.4217 USD/)).toBeTruthy()
    })
  })

  describe('Source validation', () => {
    it('requires source for manual entry', () => {
      render(<FxSubForm currency="EUR" />)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      typeIntoInput(rateInput, '1.09')

      expect(screen.getByText(/Requerida si se ingresa tasa manual/)).toBeTruthy()
    })

    it('accepts when source provided', () => {
      render(<FxSubForm currency="EUR" />)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)
      const sourceInput = screen.getByLabelText(/Fuente/)

      typeIntoInput(rateInput, '1.09')
      typeIntoInput(sourceInput, 'ECB')

      const elements = screen.queryAllByText(/Requerida si se ingresa tasa manual/)
      expect(elements.length).toBe(0)
    })
  })

  describe('Amount validation', () => {
    it('validates amount > 0', () => {
      render(<FxSubForm currency="COP" />)
      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      typeIntoInput(amountInput, '0')

      expect(screen.getAllByText(/Debe ser mayor a 0/).length).toBeGreaterThan(0)
    })

    it('shows valid state when amount valid', () => {
      render(<FxSubForm currency="COP" />)
      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      typeIntoInput(amountInput, '100')

      expect(screen.getAllByText(/✓ Válido/).length).toBeGreaterThan(0)
    })
  })

  describe('Reset/clear functionality', () => {
    it('can clear currency', () => {
      render(<FxSubForm currency="COP" />)
      const select = screen.getByLabelText('Moneda') as HTMLSelectElement
      changeSelect(select, '')

      expect(select.value).toBe('')
    })

    it('clears dependent fields when resetting currency', () => {
      const onChange = vi.fn()
      render(<FxSubForm currency="EUR" rate="1.09" source="ECB" onChange={onChange} />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, '')

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: '',
          rate: '',
          source: '',
        })
      )
    })
  })

  describe('onChange callback', () => {
    it('calls onChange with FX data', () => {
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

    it('includes USD value in onChange', () => {
      const onChange = vi.fn()
      render(<FxSubForm onChange={onChange} />)

      const select = screen.getByLabelText('Moneda')
      changeSelect(select, 'COP')

      const amountInput = screen.getByLabelText(/Cantidad \(COP\)/)
      const rateInput = screen.getByLabelText(/Tasa de conversión/)

      typeIntoInput(amountInput, '1000')
      typeIntoInput(rateInput, '4150')

      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0]
      expect(lastCall.valueUsd).toBe('0.2410')
    })

    it('returns USD amount for USD currency', () => {
      const onChange = vi.fn()
      render(<FxSubForm currency="USD" amount="1000" onChange={onChange} />)

      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0]
      expect(lastCall.valueUsd).toBe('1000')
    })
  })

  describe('Disabled state', () => {
    it('disables inputs when disabled prop true', () => {
      render(<FxSubForm currency="EUR" amount="100" rate="1.09" disabled />)

      const currencySelect = screen.getByLabelText('Moneda') as HTMLSelectElement
      const amountInput = screen.getByLabelText(/Cantidad \(EUR\)/) as HTMLInputElement
      const rateInput = screen.getByLabelText(/Tasa de conversión/) as HTMLInputElement

      expect(currencySelect.disabled).toBe(true)
      expect(amountInput.disabled).toBe(true)
      expect(rateInput.disabled).toBe(true)
    })

    it('disables auto-fetch button when disabled', () => {
      render(<FxSubForm currency="COP" referenceYear={2026} disabled />)
      const buttons = screen.getAllByRole('button')
      const button = buttons.find(b => b.textContent?.includes('Obtener tasa TRM')) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })
  })
})
