// components/layout/__tests__/nav-links.test.ts
// RE-U5-A (U1-F10): Sidebar and MobileNav previously each carried their own
// copy of NAV_LINKS, which let desktop and mobile drift out of sync. This
// suite pins the single shared source and its active-state semantics, and
// asserts neither consumer regressed back to a local copy.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NAV_LINKS, isNavLinkActive } from '../nav-links'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

describe('NAV_LINKS shared model', () => {
  it('every entry has a unique href', () => {
    const hrefs = NAV_LINKS.map((l) => l.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('every entry has a non-empty label and an icon component', () => {
    for (const link of NAV_LINKS) {
      expect(link.label.length).toBeGreaterThan(0)
      expect(link.icon).toBeTruthy()
    }
  })
})

describe('isNavLinkActive', () => {
  it('matches /app/dashboard only exactly', () => {
    expect(isNavLinkActive('/app/dashboard', '/app/dashboard')).toBe(true)
    expect(isNavLinkActive('/app/dashboard', '/app/dashboard/anything')).toBe(false)
  })

  it('matches other entries by subtree prefix', () => {
    expect(isNavLinkActive('/app/projects', '/app/projects')).toBe(true)
    expect(isNavLinkActive('/app/projects', '/app/projects/new')).toBe(true)
    expect(isNavLinkActive('/app/projects', '/app/projects/00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isNavLinkActive('/app/projects', '/app/trust-center')).toBe(false)
  })
})

describe('Sidebar and MobileNav consume the shared model, not a local copy', () => {
  it('Sidebar imports NAV_LINKS and isNavLinkActive from ./nav-links', () => {
    const src = read('components/layout/Sidebar.tsx')
    expect(src).toMatch(/import\s*\{\s*NAV_LINKS,\s*isNavLinkActive\s*\}\s*from\s*['"]\.\/nav-links['"]/)
    expect(src).not.toMatch(/const NAV_LINKS\s*=/)
    expect(src).not.toMatch(/function isActive\(/)
  })

  it('MobileNav imports NAV_LINKS and isNavLinkActive from ./nav-links', () => {
    const src = read('components/layout/MobileNav.tsx')
    expect(src).toMatch(/import\s*\{\s*NAV_LINKS,\s*isNavLinkActive\s*\}\s*from\s*['"]\.\/nav-links['"]/)
    expect(src).not.toMatch(/const NAV_LINKS\s*=/)
    expect(src).not.toMatch(/function isActive\(/)
  })
})
