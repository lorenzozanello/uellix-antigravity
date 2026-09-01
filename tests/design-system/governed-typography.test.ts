// tests/design-system/governed-typography.test.ts
//
// RE-U1 U1-F09 (RE-U6-B). Governed metadata — hashes, IDs, version
// identifiers, timestamps, provenance/audit metadata, including the public
// verification hash at app/(public)/verify/[hash]/page.tsx:95 and every
// SROI/funder monetary figure in the audit-ready report tables — rendered in
// Geist Mono, an otherwise-unused fourth font family, instead of IBM Plex
// Mono. Re-derived at RE-U6 time: 27 `font-mono` occurrences across 12
// files, all consistent with the governed-metadata class (RE-U1's "13"
// counted distinct sites/files, not raw occurrences).
//
// The fix retargets the single --font-mono theme token so the generic
// `font-mono` utility resolves to IBM Plex Mono, rather than renaming 27
// call sites — see app/globals.css. Geist Mono's only consumer was that
// token, so its import/config is removed from app/layout.tsx entirely
// rather than left as a dead fourth family.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

describe('governed mono token resolves to IBM Plex Mono', () => {
  it('app/globals.css --font-mono points at --font-ibm-plex-mono, not Geist', () => {
    const css = read('app/globals.css')
    expect(css).toMatch(/--font-mono:\s*var\(--font-ibm-plex-mono\);/)
    expect(css).not.toMatch(/--font-mono:\s*var\(--font-geist-mono\)/)
  })

  it('the explicit .font-ibm-plex-mono utility is unchanged and still points at the same family', () => {
    const css = read('app/globals.css')
    expect(css).toMatch(/\.font-ibm-plex-mono\s*\{\s*font-family:\s*var\(--font-ibm-plex-mono\)/)
  })
})

describe('Geist Mono has no remaining runtime consumer', () => {
  it('app/layout.tsx no longer imports or configures Geist_Mono', () => {
    const src = read('app/layout.tsx')
    expect(src).not.toMatch(/Geist_Mono/)
    expect(src).not.toMatch(/geistMono/)
  })

  it('no file in app/, components/ or lib/ references --font-geist-mono', () => {
    const roots = ['app', 'components', 'lib']
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        const rel = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(rel)
        } else if (/\.(tsx|ts|css)$/.test(entry.name)) {
          if (read(rel).includes('geist-mono') || read(rel).includes('Geist_Mono')) hits.push(rel)
        }
      }
    }
    for (const root of roots) walk(root)
    expect(hits).toEqual([])
  })
})

describe('Source Serif remains retired', () => {
  it('no reference to Source Serif anywhere in app/, components/ or lib/', () => {
    const roots = ['app', 'components', 'lib']
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        const rel = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(rel)
        } else if (/\.(tsx|ts|css)$/.test(entry.name)) {
          if (/source[-_]?serif/i.test(read(rel))) hits.push(rel)
        }
      }
    }
    for (const root of roots) walk(root)
    expect(hits).toEqual([])
  })
})

describe('representative governed-metadata consumers use font-mono', () => {
  it('the public verification hash is font-mono', () => {
    const src = read(path.join('app', '(public)', 'verify', '[hash]', 'page.tsx'))
    expect(src).toMatch(/font-mono/)
  })

  it('the Stella grounded-answer assertion hash is font-mono', () => {
    const src = read(path.join('components', 'stella', 'StellaGroundedAnswerPanel.tsx'))
    expect(src).toMatch(/assertionHash[\s\S]{0,80}/)
    expect(src).toMatch(/font-mono/)
  })

  it('funder monetary breakdown columns are font-mono', () => {
    const src = read(path.join('components', 'calculation-results', 'FunderBreakdownTable.tsx'))
    expect(src).toMatch(/font-mono/)
  })
})
