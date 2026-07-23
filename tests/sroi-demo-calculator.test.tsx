import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SroiDemoCalculator } from '@/components/marketing/SroiDemoCalculator'

describe('SroiDemoCalculator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not report success when lead storage rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )))

    render(<SroiDemoCalculator />)
    fireEvent.change(screen.getByPlaceholderText('Tu correo corporativo'), {
      target: { value: 'pilot@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /obtener/i }))

    expect(await screen.findByText('No pudimos registrar tu solicitud. Intenta nuevamente.')).toBeInTheDocument()
    expect(screen.queryByText(/solicitud recibida/i)).not.toBeInTheDocument()
  })
})
