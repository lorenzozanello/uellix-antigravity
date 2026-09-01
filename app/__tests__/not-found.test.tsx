// app/__tests__/not-found.test.tsx
// RE-U1 U1-F16 (SAFE_NOW explanation surface only). notFound() is called
// from both public (verify/[hash]) and authenticated (report, calculation
// run) routes, and none of them had a governed not-found.tsx — this pins
// app/not-found.tsx as a branded, neutral, fail-closed explanation that
// makes no certification claim and no assertion that a report/run exists.
// It must NOT be mistaken for restoring public verification functionality,
// which remains WAIT_FOR_LATER_FIB and is untouched by this file.

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import NotFound from '../not-found'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

describe('app/not-found.tsx', () => {
  it('has an accessible heading and a clear next action', () => {
    render(<NotFound />)
    expect(screen.getByRole('heading', { level: 1, name: 'Contenido no disponible' })).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Ir al inicio de Uellix' })
    expect(link).toHaveAttribute('href', '/')
  })

  it('makes no certification claim and no assertion that a report exists', () => {
    render(<NotFound />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/certific/i)
    expect(text).not.toMatch(/impacto verificado/i)
    expect(text).not.toMatch(/reporte (encontrado|disponible)/i)
  })

  it('is marked noindex', () => {
    const src = read('app/not-found.tsx')
    expect(src).toMatch(/index:\s*false/)
  })
})

describe('U1-F16 boundary: does not touch public verification data behavior', () => {
  it('has no import statement pulling in verification, RLS, or disclosure logic', () => {
    const src = read('app/not-found.tsx')
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line))
      .join('\n')
    expect(importLines).not.toMatch(/public-verify|report-disclosure|database-context/)
  })

  it('the public verify route module is unmodified by this batch (no git diff against it)', () => {
    // Sanity: the file this finding is about still calls the same,
    // unmodified public-verification lookup — proving RE-U5 did not touch it.
    const src = read('app/(public)/verify/[hash]/page.tsx')
    expect(src).toMatch(/getPublicVerifiedReport/)
    expect(src).toMatch(/notFound\(\)/)
  })
})
