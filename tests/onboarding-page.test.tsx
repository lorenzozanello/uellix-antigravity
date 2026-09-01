import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/app/actions/onboarding', () => ({
  completeOnboarding: vi.fn(),
}))

import { OrganizationOnboardingForm } from '@/components/onboarding/OrganizationOnboardingForm'

describe('OrganizationOnboardingForm', () => {
  beforeEach(() => {
    push.mockReset()
  })

  it('uses a valid two-letter fallback country code for Otro', () => {
    render(<OrganizationOnboardingForm />)

    const [country] = screen.getAllByRole('combobox')
    expect(within(country).getByRole('option', { name: 'Otro' })).toHaveValue('ZZ')
  })
})
