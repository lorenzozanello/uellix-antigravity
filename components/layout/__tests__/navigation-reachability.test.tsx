// components/layout/__tests__/navigation-reachability.test.tsx
// RE-U5-B (U1-F02 / U1-F05): Portfolio and Organization Settings were built
// and role-gated server-side, but had zero inbound links from primary
// navigation. This suite pins that both are reachable, exactly once, from
// both the desktop Sidebar and the MobileNav drawer, with correct
// active-state highlighting on their subtrees.

import { render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const mockUsePathname = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}))

import { Sidebar } from '../Sidebar'
import { MobileNav } from '../MobileNav'
import { NAV_LINKS } from '../nav-links'

describe('NAV_LINKS contains Portfolio and Organization Settings exactly once', () => {
  it('/app/portfolios appears exactly once', () => {
    expect(NAV_LINKS.filter((l) => l.href === '/app/portfolios')).toHaveLength(1)
  })

  it('/app/organization/settings appears exactly once', () => {
    expect(NAV_LINKS.filter((l) => l.href === '/app/organization/settings')).toHaveLength(1)
  })
})

describe('Sidebar', () => {
  it('renders a Portafolios link to /app/portfolios', () => {
    mockUsePathname.mockReturnValue('/app/dashboard')
    render(<Sidebar />)
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' })
    expect(within(nav).getByRole('link', { name: /Portafolios/ })).toHaveAttribute('href', '/app/portfolios')
  })

  it('renders a Configuración link to /app/organization/settings', () => {
    mockUsePathname.mockReturnValue('/app/dashboard')
    render(<Sidebar />)
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' })
    expect(within(nav).getByRole('link', { name: /Configuración/ })).toHaveAttribute(
      'href',
      '/app/organization/settings'
    )
  })

  it.each([
    '/app/portfolios',
    '/app/portfolios/new',
    '/app/portfolios/00000000-0000-4000-8000-000000000001',
  ])('marks Portafolios active on %s', (pathname) => {
    mockUsePathname.mockReturnValue(pathname)
    render(<Sidebar />)
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' })
    expect(within(nav).getByRole('link', { name: /Portafolios/ })).toHaveAttribute('aria-current', 'page')
  })

  it('does not mark Portafolios active on an unrelated route', () => {
    mockUsePathname.mockReturnValue('/app/projects')
    render(<Sidebar />)
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' })
    expect(within(nav).getByRole('link', { name: /Portafolios/ })).not.toHaveAttribute('aria-current')
  })
})

describe('MobileNav', () => {
  it('exposes the same Portfolio and Settings links as Sidebar once opened', () => {
    mockUsePathname.mockReturnValue('/app/dashboard')
    render(<MobileNav />)
    fireEvent.click(screen.getByRole('button', { name: /Abrir menú de navegación/ }))
    const drawer = screen.getByRole('dialog', { name: 'Menú de navegación' })
    expect(within(drawer).getByRole('link', { name: /Portafolios/ })).toHaveAttribute('href', '/app/portfolios')
    expect(within(drawer).getByRole('link', { name: /Configuración/ })).toHaveAttribute(
      'href',
      '/app/organization/settings'
    )
  })
})
