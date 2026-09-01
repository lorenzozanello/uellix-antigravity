// tests/auth/onboarding-escape-path.test.tsx
// RE-U1 U1-F01: app/(authenticated)/app/onboarding/page.tsx renders outside
// the organisation-gated shell (no Sidebar/TopBar — see app/app/layout.tsx),
// so a user rejected by the signup allowlist previously landed here with no
// link, no support contact and no way to sign out. This suite pins the
// minimal escape path: it must be present regardless of error state, and the
// fail-closed explanation for a blocked user must be preserved unweakened.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  requireAuth: vi.fn().mockResolvedValue({ id: 'u1', email: 'u1@example.test' }),
  getCurrentMembership: vi.fn().mockResolvedValue(null),
}))

import OnboardingPage from '@/app/(authenticated)/app/onboarding/page'

describe('onboarding blocked-state escape path', () => {
  it('always renders a sign-out control posting to /auth/signout', async () => {
    render(await OnboardingPage({ searchParams: Promise.resolve({}) }))
    const button = screen.getByRole('button', { name: 'Cerrar sesión' })
    const form = button.closest('form')
    expect(form).toHaveAttribute('action', '/auth/signout')
    expect(form).toHaveAttribute('method', 'post')
  })

  it('always renders a support contact affordance', async () => {
    render(await OnboardingPage({ searchParams: Promise.resolve({}) }))
    const link = screen.getByRole('link', { name: 'Contactar soporte' })
    expect(link).toHaveAttribute('href', 'mailto:hola@uellix.com')
  })

  it('preserves the fail-closed not_allowlisted explanation, unweakened', async () => {
    render(await OnboardingPage({ searchParams: Promise.resolve({ error: 'not_allowlisted' }) }))
    expect(screen.getByText('No se pudo crear la organización')).toBeInTheDocument()
    expect(
      screen.getByText(/Uellix está en acceso controlado/)
    ).toBeInTheDocument()
    // The escape path still coexists with the explanation — it doesn't replace it.
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
  })

  it('does not imply organisation creation succeeded or is unblocked when rejected', async () => {
    render(await OnboardingPage({ searchParams: Promise.resolve({ error: 'not_allowlisted' }) }))
    // The create-organization form and its submit button remain present (the
    // allowlist is not removed by this batch) but the page must not claim
    // success anywhere alongside the error.
    expect(screen.queryByText(/organización creada/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Crear organización' })).toBeInTheDocument()
  })
})
