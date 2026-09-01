// tests/design-system/navy-token.test.ts
//
// RE-U1 U1-F11 (RE-U6-A, Phase 1 — token adoption). 88 literal `#0F172A`
// occurrences across 17 implementation files bypassed the existing
// `--color-uellix-deep` / `--uellix-deep` tokens (app/globals.css:26/238),
// which exist for exactly this purpose (see the comment at globals.css:20-22).
// This suite is the regression gate: it fails the moment a NEW literal
// `#0F172A` consumer appears anywhere in app/, components/ or lib/, outside
// the two explicitly authorized locations.
//
// The RE-U1 count (86, case-sensitive `#0F172A`) undercounted: a
// case-insensitive re-scan at RE-U6 time (as the task explicitly required —
// "re-derive, don't rely on the historical count") found a 6th occurrence
// site with a lowercase `#0f172a`, bringing the true total to 94 across 18
// files, not 86 across ~17. That site is now the third authorized exception.
//
// The three authorized exceptions:
//   1. app/globals.css itself — the token DEFINITION sites. Their value is
//      still #0F172A after Phase 1 by design; Phase 2 (RE-U6-B) changes it to
//      the canonical #172B49 and this file's Phase-2 suite pins that.
//   2. lib/email/templates/invitation.ts — raw HTML email markup. CSS custom
//      properties (`var(--uellix-deep)`) are unreliably supported across
//      email clients (notably Outlook's Word rendering engine), so email
//      templates keep literal hex and are updated by hand whenever the
//      canonical value changes — never left to drift, but never tokenized
//      either. This is a documented, permanent exception, not deferred work.
//   3. lib/reports/pdf/ReportPdfDocument.tsx — @react-pdf/renderer's
//      StyleSheet.create() is a flat JS style-object system for its own PDF
//      layout engine (like React Native's StyleSheet), not CSS: it has no
//      cascade and does not resolve `var(--x)`. Same category as the email
//      exception, same handling — literal hex, updated by hand at Phase 2.
//
// docs/design/INTERNAL_BRAND_TOKENS.md is documentation, not implementation
// code, so it is out of this scan's scope — but it must stay in sync with the
// canonical value, which the Phase-2 suite below checks separately.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())

const SCAN_ROOTS = ['app', 'components', 'lib']
const SCAN_EXTENSIONS = new Set(['.tsx', '.ts', '.css'])
const SKIP_DIR_NAMES = new Set(['node_modules', '.next', '__tests__', 'dist'])

// The only files a literal #0F172A is authorized to appear in.
const AUTHORIZED_LITERAL_FILES = new Set([
  path.join('app', 'globals.css'),
  path.join('lib', 'email', 'templates', 'invitation.ts'),
  path.join('lib', 'reports', 'pdf', 'ReportPdfDocument.tsx'),
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      yield* walk(path.join(dir, entry.name))
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name)
    }
  }
}

function findLiteralConsumers(): Array<{ file: string; line: number; text: string }> {
  const findings: Array<{ file: string; line: number; text: string }> = []
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(ROOT, root)
    if (!statSync(absRoot, { throwIfNoEntry: false })) continue
    for (const absFile of walk(absRoot)) {
      const relFile = path.relative(ROOT, absFile)
      if (AUTHORIZED_LITERAL_FILES.has(relFile)) continue
      const lines = readFileSync(absFile, 'utf8').split('\n')
      lines.forEach((text, idx) => {
        if (/#0F172A/i.test(text)) {
          findings.push({ file: relFile, line: idx + 1, text: text.trim() })
        }
      })
    }
  }
  return findings
}

describe('Phase 1 — Navy literal consumers are migrated to the governed token', () => {
  it('no implementation-code file outside the authorized exceptions contains a literal #0F172A', () => {
    const findings = findLiteralConsumers()
    expect(
      findings,
      `Unexpected literal #0F172A consumer(s):\n${findings
        .map((f) => `  ${f.file}:${f.line}  ${f.text}`)
        .join('\n')}`
    ).toEqual([])
  })

  it('the two authorized exception files still exist at their expected paths', () => {
    for (const relFile of AUTHORIZED_LITERAL_FILES) {
      expect(statSync(path.join(ROOT, relFile), { throwIfNoEntry: false })).toBeTruthy()
    }
  })
})

describe('the governed token utility is in place for consumers to adopt', () => {
  it('app/globals.css declares both the Tailwind theme color and the plain CSS variable', () => {
    const css = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8')
    expect(css).toMatch(/--color-uellix-deep:\s*#[0-9A-Fa-f]{6};/)
    expect(css).toMatch(/--uellix-deep:\s*#[0-9A-Fa-f]{6};/)
  })

  it('representative consumers resolved to the named utility, not an arbitrary hex value', () => {
    const sample = readFileSync(
      path.join(ROOT, 'components', 'marketing', 'ProblemSection.tsx'),
      'utf8'
    )
    expect(sample).toMatch(/text-uellix-deep\b/)
    expect(sample).not.toMatch(/\[#0F172A\]/)
  })

  it('SVG presentation attributes resolved to var(--uellix-deep), not a class name', () => {
    const svgConsumer = readFileSync(
      path.join(ROOT, 'components', 'marketing', 'TrustLayerSection.tsx'),
      'utf8'
    )
    expect(svgConsumer).toMatch(/stroke="var\(--uellix-deep\)"/)
    expect(svgConsumer).toMatch(/fill="var\(--uellix-deep\)"/)
  })
})
