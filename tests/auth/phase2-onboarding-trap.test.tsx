// tests/auth/phase2-onboarding-trap.test.tsx
// RE-U4-CF-01 (NON_ADMIN_PHASE2_ONBOARDING_TRAP): OnboardingCheck
// (components/auth/OnboardingCheck.tsx) routes every member of an
// uncalibrated organisation to /app/organization/onboarding regardless of
// role — only completeOnboarding (app/actions/onboarding.ts) enforces who
// may actually complete it. Before this batch, the page rendered the setup
// form to everyone it was routed to, so a non-admin member reached a form
// that always server-rejected, with no explanation and no way out.
//
// This suite pins:
//   - the authorized branch renders the same form, unchanged (non-regression)
//   - the unauthorized branch renders NO form (not just a hidden one)
//   - the unauthorized branch renders a governed fail-closed explanation
//   - the unauthorized branch has at least one usable remediation CTA
//   - every remediation CTA is proven non-looping: neither points at a GET
//     /app/** route (which OnboardingCheck would immediately redirect back
//     to this same page) — sign-out is a POST to /auth/signout, support is
//     an external mailto: link.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireOrganizationAccess = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: mockRequireOrganizationAccess,
}))

vi.mock('@/app/actions/onboarding', () => ({
  completeOnboarding: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import OnboardingPage from '@/app/app/organization/onboarding/page'

function mockContext(role: string) {
  mockRequireOrganizationAccess.mockResolvedValue({
    organization: { id: 'org-1', onboardingCompleted: false },
    membership: { role },
    user: { id: 'user-1' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Phase-2 onboarding page — authorized roles', () => {
  it('organization_admin sees the functional setup form', async () => {
    mockContext('organization_admin')

    render(await OnboardingPage())

    expect(screen.getByRole('button', { name: 'Comenzar a usar Uellix' })).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
  })

  it('super_admin sees the functional setup form (non-regression)', async () => {
    mockContext('super_admin')

    render(await OnboardingPage())

    expect(screen.getByRole('button', { name: 'Comenzar a usar Uellix' })).toBeInTheDocument()
  })
})

describe('Phase-2 onboarding page — unauthorized roles (CF-01)', () => {
  for (const role of ['analyst', 'reviewer', 'viewer', 'impact_manager']) {
    it(`${role} does NOT see the setup form`, async () => {
      mockContext(role)

      render(await OnboardingPage())

      expect(screen.queryByRole('button', { name: 'Comenzar a usar Uellix' })).not.toBeInTheDocument()
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })

    it(`${role} sees a governed fail-closed explanation instead`, async () => {
      mockContext(role)

      render(await OnboardingPage())

      expect(screen.getByText('Configuración pendiente de un administrador')).toBeInTheDocument()
      expect(screen.getByText(/debe completarla una persona con rol de Administrador/)).toBeInTheDocument()
    })

    it(`${role} has a usable, non-looping remediation path`, async () => {
      mockContext(role)

      render(await OnboardingPage())

      // Support: external mailto link, never redirected by OnboardingCheck.
      const supportLink = screen.getByRole('link', { name: 'Contactar soporte' })
      expect(supportLink).toHaveAttribute('href', 'mailto:hola@uellix.com')

      // Sign-out: POST to /auth/signout — not a GET navigation to any
      // /app/** route, so OnboardingCheck's redirect-while-incomplete guard
      // never intercepts it.
      const signOutButton = screen.getByRole('button', { name: 'Cerrar sesión' })
      const form = signOutButton.closest('form')
      expect(form).toHaveAttribute('action', '/auth/signout')
      expect(form).toHaveAttribute('method', 'post')

      // Redirect-loop safety: neither CTA is a link into /app/**, the
      // exact class of CTA OnboardingCheck would bounce straight back here.
      const allLinks = screen.queryAllByRole('link')
      for (const link of allLinks) {
        expect(link.getAttribute('href')).not.toMatch(/^\/app\//)
      }
    })
  }
})
