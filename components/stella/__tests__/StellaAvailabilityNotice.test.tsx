// @vitest-environment jsdom
// components/stella/__tests__/StellaAvailabilityNotice.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaAvailabilityNotice } from '../StellaAvailabilityNotice'

describe('StellaAvailabilityNotice', () => {
  it('renders the DISABLED presentation for unavailable', () => {
    render(<StellaAvailabilityNotice state="unavailable" message="" />)
    expect(screen.getByText('Stella no está habilitada')).toBeInTheDocument()
  })

  it('renders the UNAUTHORIZED presentation for permission_denied', () => {
    render(<StellaAvailabilityNotice state="permission_denied" message="Tu rol no tiene permiso para usar Stella." />)
    expect(screen.getByText('Sin permiso para usar Stella')).toBeInTheDocument()
  })

  it('renders the QUOTA_EXCEEDED presentation verbatim for quota_reached', () => {
    render(<StellaAvailabilityNotice state="quota_reached" message="Alcanzaste el límite mensual de 50 consultas." />)
    expect(screen.getByText('Alcanzaste el límite mensual de 50 consultas.')).toBeInTheDocument()
  })

  it('renders the GEMINI_ERROR presentation for provider_failure and offers retry', () => {
    const onRetry = vi.fn()
    render(<StellaAvailabilityNotice state="provider_failure" message="" onRetry={onRetry} />)
    expect(screen.getByText('Error del servicio de IA')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeInTheDocument()
  })

  it('exposes role="alert" for basic accessibility', () => {
    render(<StellaAvailabilityNotice state="unavailable" message="" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
