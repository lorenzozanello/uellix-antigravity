// tests/design-system/form-accessibility.test.tsx
//
// RE-U1 U1-F12. 27 htmlFor / 0 aria-describedby measured a real gap: field
// labels were wired, but the constraint hints and validation feedback sitting
// right next to those fields were never associated with them, so a
// screen-reader user heard the field name and nothing else.
//
// This is NOT a mechanical "add aria-describedby everywhere" pass. Of the ~26
// files with a labeled field, only three had genuine field-adjacent help or
// already-computed validation feedback to connect:
//   - app/components/fx-sub-form/FxSubForm.tsx — amount/rate/source already
//     compute a live valid/invalid message per field (Decimal.gt(0) checks,
//     a required-if-manual check); this wires that EXISTING state to
//     aria-describedby/aria-invalid, it invents no new rule.
//   - app/app/organization/settings/settings-form.tsx — brandColor and
//     logoUrl each have a static format-constraint hint directly below the
//     field; brandColor's aria-invalid reuses its own existing `pattern`
//     attribute, unchanged.
//   - app/(authenticated)/app/onboarding/page.tsx — invalid_name/invalid_slug/
//     slug_taken are genuinely about one field each; not_allowlisted is an
//     account-level allowlist rejection, not a field problem, and is
//     deliberately NOT attached to any input (see feedback rules on not
//     converting a server authorization failure into field validation).
//
// Everything else audited (login, forgot-password, reset-password, the
// members invite form, project/portfolio creation, DemoRequestForm, the
// pipeline pages) has no field-adjacent help or error text to connect —
// per the task's own instruction, they get no aria-describedby "merely to
// increase the count."

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/auth/session', () => ({
  requireAuth: vi.fn().mockResolvedValue({ id: 'u1', email: 'u1@example.test' }),
  getCurrentMembership: vi.fn().mockResolvedValue(null),
}))

describe('FxSubForm — live per-field validation feedback is wired to the field', () => {
  it('amount: aria-invalid/aria-describedby only appear once a value is entered, and track validity', async () => {
    const { FxSubForm } = await import('@/app/components/fx-sub-form/FxSubForm')
    render(<FxSubForm currency="EUR" />)
    const amount = screen.getByLabelText(/Cantidad/) as HTMLInputElement

    expect(amount).not.toHaveAttribute('aria-describedby')

    fireEvent.change(amount, { target: { value: '-5' } })
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(amount).toHaveAttribute('aria-describedby', 'fx-amount-feedback')
    expect(document.getElementById('fx-amount-feedback')).not.toBeNull()

    fireEvent.change(amount, { target: { value: '100' } })
    expect(amount).toHaveAttribute('aria-invalid', 'false')
  })

  it('source: required-if-manual-rate feedback is wired', async () => {
    const { FxSubForm } = await import('@/app/components/fx-sub-form/FxSubForm')
    render(<FxSubForm currency="EUR" referenceYear={2024} />)
    const rate = screen.getByLabelText(/Tasa de conversión/)
    fireEvent.change(rate, { target: { value: '1.1' } })

    const source = screen.getByLabelText(/Fuente/)
    expect(source).toHaveAttribute('aria-invalid', 'true')
    expect(source).toHaveAttribute('aria-describedby', 'fx-source-feedback')
    expect(screen.getByText('Requerida si se ingresa tasa manual').id).toBe('fx-source-feedback')

    fireEvent.change(source, { target: { value: 'Banco Central' } })
    expect(source).toHaveAttribute('aria-invalid', 'false')
  })
})

describe('settings-form — static format hints are connected to their fields', () => {
  it('brandColor and logoUrl point aria-describedby at their existing hint text', async () => {
    const { SettingsForm } = await import('@/app/app/organization/settings/settings-form')
    render(
      <SettingsForm
        initialData={{ whiteLabelEnabled: true, brandColor: '#172B49', logoUrl: '' }}
        canEdit={true}
      />
    )
    const brandColor = screen.getByLabelText(/Color Principal/)
    expect(brandColor).toHaveAttribute('aria-describedby', 'brandColor-hint')
    expect(document.getElementById('brandColor-hint')?.textContent).toMatch(/Hex/)

    const logoUrl = screen.getByLabelText(/URL del Logotipo/)
    expect(logoUrl).toHaveAttribute('aria-describedby', 'logoUrl-hint')
    expect(document.getElementById('logoUrl-hint')?.textContent).toMatch(/HTTPS/)
  })

  it('brandColor aria-invalid reuses its own existing pattern, unmodified', () => {
    const src = read(path.join('app', 'app', 'organization', 'settings', 'settings-form.tsx'))
    const patternMatch = src.match(/pattern="([^"]+)"/)
    const invalidMatch = src.match(/aria-invalid=\{[^}]*?\/\^#\[0-9a-fA-F\]\{6\}\$\/[^}]*\}/)
    expect(patternMatch?.[1]).toBe('^#[0-9a-fA-F]{6}$')
    expect(invalidMatch).not.toBeNull()
  })
})

describe('onboarding page — field-specific errors are wired, account-level ones are not', () => {
  it('invalid_slug connects to the slug field, alongside its existing hint', async () => {
    const OnboardingPage = (await import('@/app/(authenticated)/app/onboarding/page')).default
    render(await OnboardingPage({ searchParams: Promise.resolve({ error: 'invalid_slug' }) }))

    const slug = screen.getByLabelText(/Identificador único/)
    expect(slug).toHaveAttribute('aria-invalid', 'true')
    expect(slug.getAttribute('aria-describedby')).toContain('slug-hint')
    expect(slug.getAttribute('aria-describedby')).toContain('org-creation-error')

    const name = screen.getByLabelText(/Nombre de la organización/)
    expect(name).not.toHaveAttribute('aria-invalid')
  })

  it('invalid_name connects to the name field only', async () => {
    const OnboardingPage = (await import('@/app/(authenticated)/app/onboarding/page')).default
    render(await OnboardingPage({ searchParams: Promise.resolve({ error: 'invalid_name' }) }))

    const name = screen.getByLabelText(/Nombre de la organización/)
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAttribute('aria-describedby', 'org-creation-error')

    const slug = screen.getByLabelText(/Identificador único/)
    expect(slug).not.toHaveAttribute('aria-invalid')
  })

  it('not_allowlisted (an account-level authorization failure) is attached to no field', async () => {
    const OnboardingPage = (await import('@/app/(authenticated)/app/onboarding/page')).default
    render(await OnboardingPage({ searchParams: Promise.resolve({ error: 'not_allowlisted' }) }))

    expect(screen.getByText(/Uellix está en acceso controlado/)).toBeInTheDocument()
    const name = screen.getByLabelText(/Nombre de la organización/)
    const slug = screen.getByLabelText(/Identificador único/)
    expect(name).not.toHaveAttribute('aria-invalid')
    expect(name).not.toHaveAttribute('aria-describedby')
    expect(slug).not.toHaveAttribute('aria-invalid')
    // slug keeps its own static hint id even with no error — that's not an error connection.
    expect(slug.getAttribute('aria-describedby')).toBe('slug-hint')
  })
})

describe('negative property: aria-describedby never references a nonexistent id', () => {
  const FILES = [
    path.join('app', 'components', 'fx-sub-form', 'FxSubForm.tsx'),
    path.join('app', 'app', 'organization', 'settings', 'settings-form.tsx'),
    path.join('app', '(authenticated)', 'app', 'onboarding', 'page.tsx'),
  ]

  it.each(FILES)('%s: every literal aria-describedby id is rendered somewhere in the same file', (relFile) => {
    const src = read(relFile)
    const describedByIds = [...src.matchAll(/aria-describedby=(?:\{`?)?'?"?([a-zA-Z0-9_\- ]+)'?"?`?\}?/g)]
      .map((m) => m[1])
      .flatMap((group) => group.split(' '))
      .filter((id) => /^[a-zA-Z][\w-]*$/.test(id)) // drop template-literal fragments / booleans

    // Every literal id referenced must have a matching id="..." (or id={...} to the same literal) in the file.
    for (const id of describedByIds) {
      const hasIdAttr = new RegExp(`id=(\\{?)['"\`]?${id}\\b`).test(src) || src.includes(`ERROR_ID = '${id}'`)
      expect(hasIdAttr, `${relFile}: aria-describedby references "${id}" with no matching id`).toBe(true)
    }
  })
})
