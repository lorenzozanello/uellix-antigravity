// components/layout/__tests__/breadcrumbs.test.tsx
// RE-U5-B (U1-F08 / U1-F14): Breadcrumbs used to link every intermediate path
// segment, including 'organization' — which has no route of its own (only
// its children do), producing a dead /app/organization link on every
// organization sub-page. This suite pins the fix and the label additions.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const mockUsePathname = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}))

import { Breadcrumbs } from '../Breadcrumbs'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

describe('breadcrumbs never link the non-routable /app/organization segment', () => {
  it.each([
    '/app/organization/settings',
    '/app/organization/members',
    '/app/organization/billing',
    '/app/organization/onboarding',
  ])('%s produces no link to /app/organization', (pathname) => {
    mockUsePathname.mockReturnValue(pathname)
    render(<Breadcrumbs />)
    const links = screen.queryAllByRole('link').map((el) => el.getAttribute('href'))
    expect(links).not.toContain('/app/organization')
  })
})

describe('breadcrumbs on deeper, genuinely multi-segment paths', () => {
  it('/app/portfolios/[id] links Portafolios and shows a Detalle current crumb', () => {
    mockUsePathname.mockReturnValue('/app/portfolios/00000000-0000-4000-8000-000000000001')
    render(<Breadcrumbs />)
    const portfoliosLink = screen.getByRole('link', { name: 'Portafolios' })
    expect(portfoliosLink).toHaveAttribute('href', '/app/portfolios')
    expect(screen.getByText('Detalle')).toHaveAttribute('aria-current', 'page')
  })

  it('a pipeline evidence path still renders its existing crumb chain (regression)', () => {
    mockUsePathname.mockReturnValue(
      '/app/projects/00000000-0000-4000-8000-000000000002/pipeline/evidence'
    )
    render(<Breadcrumbs />)
    expect(screen.getByRole('link', { name: 'Proyectos SROI' })).toHaveAttribute('href', '/app/projects')
    expect(screen.getByRole('link', { name: 'Proyecto' })).toHaveAttribute(
      'href',
      '/app/projects/00000000-0000-4000-8000-000000000002'
    )
    expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute(
      'href',
      '/app/projects/00000000-0000-4000-8000-000000000002/pipeline'
    )
    expect(screen.getByText('Evidencia')).toHaveAttribute('aria-current', 'page')
  })
})

describe('SEGMENT_LABELS source additions (U1-F14)', () => {
  it('defines labels for settings, members and billing', () => {
    const src = read('components/layout/Breadcrumbs.tsx')
    expect(src).toMatch(/settings:\s*'Configuración'/)
    expect(src).toMatch(/members:\s*'Miembros'/)
    expect(src).toMatch(/billing:\s*'Facturación'/)
  })

  it("SKIP_SEGMENTS includes 'organization'", () => {
    const src = read('components/layout/Breadcrumbs.tsx')
    expect(src).toMatch(/SKIP_SEGMENTS\s*=\s*new Set\(\[[^\]]*'organization'[^\]]*\]\)/)
  })
})
