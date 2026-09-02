// components/layout/__tests__/authenticated-shell-accessibility.test.ts
// RE-U1 U1-F07: the public shell (app/(public)/layout.tsx) already has a
// keyboard-bypass skip link; the authenticated shell (app/app/layout.tsx)
// had none, failing WCAG 2.4.1 for every page reached via the sidebar.
//
// app/app/layout.tsx is an async Server Component gated by
// requireOrganizationAccess(), so a full render here would duplicate the
// mocking already owned by tests/auth/route-authorization-boundary.test.ts.
// This is a source-level contract test instead — same convention as that
// suite — asserting the skip link targets an id that actually exists on the
// element wrapping {children}.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

describe('authenticated shell skip link (app/app/layout.tsx)', () => {
  const src = read('app/app/layout.tsx')

  it('renders a skip link to #main-content', () => {
    expect(src).toMatch(/href="#main-content"/)
    expect(src).toMatch(/Saltar al contenido/)
  })

  it('the main element wrapping {children} carries id="main-content" and is focusable', () => {
    const mainMatch = src.match(/<main[\s\S]*?>[\s\S]*?\{children\}/)
    expect(mainMatch, 'expected a <main> element wrapping {children}').not.toBeNull()
    const mainTag = mainMatch![0]
    expect(mainTag).toMatch(/id="main-content"/)
    expect(mainTag).toMatch(/tabIndex=\{-1\}/)
  })

  it('the skip link appears before the main content region in source order', () => {
    const skipIndex = src.indexOf('href="#main-content"')
    const mainIndex = src.indexOf('id="main-content"')
    expect(skipIndex).toBeGreaterThan(-1)
    expect(mainIndex).toBeGreaterThan(skipIndex)
  })
})
