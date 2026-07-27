import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const push = vi.fn()
const refresh = vi.fn()
const redirect = vi.fn((path: string) => {
  // Next.js implementa redirect() lanzando; se imita para que el código que
  // sigue a la llamada no se ejecute, igual que en producción.
  throw new Error(`NEXT_REDIRECT:${path}`)
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/app/organization/onboarding',
  redirect: (path: string) => redirect(path),
}))

const completeOnboarding = vi.fn()
vi.mock('@/app/actions/onboarding', () => ({
  completeOnboarding: (...args: unknown[]) => completeOnboarding(...args),
}))

const requireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: () => requireOrganizationAccess(),
}))

const listOrganizationAdmins = vi.fn()
vi.mock('@/lib/organizations/members', () => ({
  listOrganizationAdminsForCurrentOrganization: () => listOrganizationAdmins(),
}))

import OnboardingPage from '@/app/app/organization/onboarding/page'
import { OnboardingForm } from '@/app/app/organization/onboarding/onboarding-form'
import { OnboardingPending } from '@/app/app/organization/onboarding/onboarding-pending'
import { OnboardingCheck } from '@/components/auth/OnboardingCheck'
import { ROLES } from '@/lib/auth/roles'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextFor(role: string, onboardingCompleted = false) {
  return {
    user: { id: 'u1', email: 'persona@ejemplo.org', fullName: 'Persona', avatarUrl: null, isSuperAdmin: false },
    membership: { id: 'm1', organizationId: 'org1', userId: 'u1', role, status: 'active' },
    organization: { id: 'org1', name: 'Fundación Ejemplo', slug: 'fundacion-ejemplo', legalName: null, country: null, sector: null, status: 'active', onboardingCompleted },
  }
}

/**
 * `OnboardingPage` es un Server Component asíncrono: se invoca directamente y
 * se inspecciona el elemento devuelto, en vez de renderizarlo. Así se verifica
 * la decisión de rol sin necesitar un runtime de RSC.
 */
async function renderPage(): Promise<
  React.ReactElement<{
    organizationName: string
    roleLabel: string
    admins: { email: string; fullName: string | null }[]
  }>
> {
  return (await OnboardingPage()) as React.ReactElement<{
    organizationName: string
    roleLabel: string
    admins: { email: string; fullName: string | null }[]
  }>
}

const NON_ADMIN_ROLES = [
  ROLES.IMPACT_MANAGER,
  ROLES.ANALYST,
  ROLES.REVIEWER,
  ROLES.VIEWER,
] as const

const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.ORGANIZATION_ADMIN] as const

beforeEach(() => {
  push.mockReset()
  refresh.mockReset()
  redirect.mockClear()
  completeOnboarding.mockReset()
  requireOrganizationAccess.mockReset()
  listOrganizationAdmins.mockReset()
  listOrganizationAdmins.mockResolvedValue([
    { email: 'admin@ejemplo.org', fullName: 'Admin Ejemplo' },
  ])
})

// ---------------------------------------------------------------------------
// F0-02 — ninguna ruta apunta a '/app'
// ---------------------------------------------------------------------------

describe('F0-02 — destino tras completar el onboarding', () => {
  it('la página redirige a /app/dashboard cuando el onboarding ya está completo', async () => {
    requireOrganizationAccess.mockResolvedValue(
      contextFor(ROLES.ORGANIZATION_ADMIN, true),
    )

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/app/dashboard')
    expect(redirect).toHaveBeenCalledWith('/app/dashboard')
  })

  it('el formulario navega a /app/dashboard, nunca a /app', async () => {
    completeOnboarding.mockResolvedValue({ success: true })
    render(<OnboardingForm />)

    const form = document.querySelector('form') as HTMLFormElement
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.submit(form)

    await vi.waitFor(() => expect(push).toHaveBeenCalled())
    expect(push).toHaveBeenCalledWith('/app/dashboard')
    expect(push).not.toHaveBeenCalledWith('/app')
  })

  it('OnboardingCheck envía a /app/dashboard, nunca a /app', () => {
    render(<OnboardingCheck onboardingCompleted={true} />)

    expect(push).toHaveBeenCalledWith('/app/dashboard')
    expect(push).not.toHaveBeenCalledWith('/app')
  })

  it('OnboardingCheck no redirige cuando falta el onboarding y ya se está en la ruta', () => {
    render(<OnboardingCheck onboardingCompleted={false} />)

    // Evita el bucle: la ruta actual ya es /app/organization/onboarding.
    expect(push).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// F0-03 — qué ve cada rol
// ---------------------------------------------------------------------------

describe('F0-03 — administrador', () => {
  it.each(ADMIN_ROLES)('%s ve el formulario de configuración', async (role) => {
    requireOrganizationAccess.mockResolvedValue(contextFor(role))

    const element = await renderPage()

    expect(element.type).toBe(OnboardingForm)
    expect(listOrganizationAdmins).not.toHaveBeenCalled()
  })

  it('el formulario usa el código ISO válido ZZ para "Otro"', () => {
    render(<OnboardingForm />)

    const [country] = screen.getAllByRole('combobox')
    expect(within(country).getByRole('option', { name: 'Otro' })).toHaveValue('ZZ')
  })
})

describe('F0-03 — miembros no administradores', () => {
  it.each(NON_ADMIN_ROLES)('%s NO ve el formulario, ve la pantalla de espera', async (role) => {
    requireOrganizationAccess.mockResolvedValue(contextFor(role))

    const element = await renderPage()

    expect(element.type).toBe(OnboardingPending)
    expect(element.type).not.toBe(OnboardingForm)
  })

  it.each(NON_ADMIN_ROLES)('a %s se le pasan los administradores a contactar', async (role) => {
    requireOrganizationAccess.mockResolvedValue(contextFor(role))

    const element = await renderPage()

    expect(element.props.admins).toEqual([
      { email: 'admin@ejemplo.org', fullName: 'Admin Ejemplo' },
    ])
    expect(element.props.organizationName).toBe('Fundación Ejemplo')
  })
})

// ---------------------------------------------------------------------------
// F0-03 — contenido de la pantalla de espera
// ---------------------------------------------------------------------------

describe('F0-03 — pantalla de espera', () => {
  const admins = [{ email: 'admin@ejemplo.org', fullName: 'Admin Ejemplo' }]

  function renderPending(overrides: Partial<Parameters<typeof OnboardingPending>[0]> = {}) {
    return render(
      <OnboardingPending
        organizationName="Fundación Ejemplo"
        roleLabel="Analista"
        admins={admins}
        {...overrides}
      />,
    )
  }

  it('explica que un administrador debe completar la configuración', () => {
    renderPending()

    expect(screen.getByText('Configuración pendiente')).toBeInTheDocument()
    expect(
      screen.getByText(/Sólo un administrador puede completarla/i),
    ).toBeInTheDocument()
  })

  it('nombra a la organización y al rol del usuario', () => {
    renderPending()

    expect(screen.getByText('Fundación Ejemplo')).toBeInTheDocument()
    expect(screen.getByText('Analista')).toBeInTheDocument()
  })

  it('ofrece contacto con el administrador', () => {
    renderPending()

    const link = screen.getByRole('link', { name: 'admin@ejemplo.org' })
    expect(link).toHaveAttribute('href', 'mailto:admin@ejemplo.org')
  })

  it('permite cerrar sesión mediante POST a /auth/signout', () => {
    renderPending()

    const button = screen.getByRole('button', { name: 'Cerrar sesión' })
    expect(button).toBeInTheDocument()

    const form = button.closest('form') as HTMLFormElement
    expect(form).toHaveAttribute('action', '/auth/signout')
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post')
  })

  it('no muestra ningún formulario de configuración', () => {
    renderPending()

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Comenzar a usar Uellix/i })).not.toBeInTheDocument()
  })

  it('cubre el caso sin administradores activos con una vía de soporte', () => {
    renderPending({ admins: [] })

    expect(screen.getByText(/No hay ningún administrador activo/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'soporte@uellix.com' })).toBeInTheDocument()
  })

  it('no contiene texto en inglés', () => {
    const { container } = renderPending()
    const text = container.textContent ?? ''

    for (const word of ['Something went wrong', 'Try again', 'Only organization admins', 'Loading', 'Back to']) {
      expect(text).not.toContain(word)
    }
  })
})
