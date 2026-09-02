// tests/design-system/stella-copy-and-color.test.ts
//
// RE-U1 U1-F13 / U1-F18 / U1-F19 / U1-F20 (RE-U6-D).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '__tests__') continue
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(rel, exts))
    else if (exts.includes(path.extname(entry.name))) out.push(rel)
  }
  return out
}

// ---------------------------------------------------------------------------
// U1-F13 — Stella action copy: three governed verbs (Analizar/Revisar/
// Consultar), each covering a genuinely distinct action, no fourth ad hoc verb.
// ---------------------------------------------------------------------------
describe('U1-F13 — Stella action copy uses the three governed verbs, each for its real action', () => {
  it('StellaContextualAdvisorPanel (findings + suggestions = analysis) says "Analizar con Stella"', () => {
    const src = read(path.join('components', 'stella', 'StellaContextualAdvisorPanel.tsx'))
    expect(src).toMatch(/'Analizar con Stella'/)
    expect(src).not.toMatch(/'Consultar a Stella'/)
    expect(src).not.toMatch(/'Preguntar a Stella'/)
  })

  it('StellaGroundedQueryPanel (ask a question, get a grounded answer) says "Consultar a Stella"', () => {
    const src = read(path.join('components', 'stella', 'StellaGroundedQueryPanel.tsx'))
    expect(src).toMatch(/'Consultar a Stella'/)
    expect(src).not.toMatch(/'Preguntar a Stella'/)
  })

  it('the query-panel server wrapper default title matches', () => {
    const src = read(
      path.join('app', 'app', 'projects', '[projectId]', 'pipeline', 'StellaGroundedQuerySection.tsx')
    )
    expect(src).toMatch(/'Consultar a Stella \(respuesta fundamentada\)'/)
  })

  it('StellaValidatorPanel (SROI calculation review) keeps "Revisar con Stella" — a genuine review action', () => {
    const src = read(path.join('components', 'stella', 'StellaValidatorPanel.tsx'))
    expect(src).toMatch(/'Revisar con Stella'/)
  })

  it('no "Preguntar a Stella" remains anywhere in app/ or components/', () => {
    const hits: string[] = []
    for (const root of ['app', 'components']) {
      for (const file of walkFiles(root, ['.tsx', '.ts'])) {
        if (/preguntar a stella/i.test(read(file))) hits.push(file)
      }
    }
    expect(hits).toEqual([])
  })

  it('no generic-chat or avatar wording was introduced (Stella stays governed, not a chat product)', () => {
    const files = [
      ...walkFiles(path.join('components', 'stella'), ['.tsx']),
      path.join('app', 'app', 'projects', '[projectId]', 'pipeline', 'StellaGroundedQuerySection.tsx'),
    ]
    const banned = /ask stella anything|chat with stella|stella (asistente|avatar)\b/i
    const hits = files.filter((f) => banned.test(read(f)))
    expect(hits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// U1-F18 — onboarding language register: voseo replaced with neutral tuteo.
// ---------------------------------------------------------------------------
describe('U1-F18 — onboarding not_allowlisted copy uses neutral LatAm register', () => {
  it('no voseo forms remain (esperás/pedile/contactá)', () => {
    const src = read(path.join('app', '(authenticated)', 'app', 'onboarding', 'page.tsx'))
    expect(src).not.toMatch(/esperás/)
    expect(src).not.toMatch(/pedile/)
    expect(src).not.toMatch(/contactá\b/)
  })

  it('the neutral tuteo replacements preserve the original meaning', () => {
    const src = read(path.join('app', '(authenticated)', 'app', 'onboarding', 'page.tsx'))
    expect(src).toMatch(/esperas una invitación/)
    expect(src).toMatch(/pídele a quien te invitó/)
    expect(src).toMatch(/contacta al equipo de Uellix/)
  })
})

// ---------------------------------------------------------------------------
// U1-F19 — Stella grammar: re-derived, not blindly replaced.
// ---------------------------------------------------------------------------
describe('U1-F19 — Stella gender agreement (re-derived, not blindly replaced)', () => {
  it('every direct "Stella ... habilitad[oa]" occurrence agrees with Stella (feminine)', () => {
    const sites = [
      path.join('components', 'stella', 'StellaComposerPanel.tsx'),
      path.join('components', 'stella', 'StellaContextualAdvisorPanel.tsx'),
      path.join('components', 'stella', 'StellaGroundedQueryPanel.tsx'),
      path.join('components', 'stella', 'StellaValidatorPanel.tsx'),
      path.join('components', 'stella', 'error-messages.ts'),
    ]
    for (const file of sites) {
      const src = read(file)
      expect(src, `${file}: expected "Stella no está habilitada"`).toMatch(/Stella no está habilitada/)
      expect(src, `${file}: must not regress to the masculine form`).not.toMatch(/Stella no está habilitado/)
    }
  })

  it('StellaReviewerPanel keeps "habilitado" deliberately — it agrees with "rol" (masculine), not Stella', () => {
    // "Este rol de revisión de Stella no está habilitado..." — the head noun of
    // the subject is "rol" (el rol), not "Stella". "habilitada" here would be
    // the actual grammar error. Re-derived by parsing the sentence, not by
    // pattern-matching "Stella" to a nearby adjective.
    const src = read(path.join('components', 'stella', 'StellaReviewerPanel.tsx'))
    expect(src).toMatch(/rol de revisión de Stella no está habilitado/)
  })
})

// ---------------------------------------------------------------------------
// U1-F20 — orphan/near-duplicate colors, judged individually.
// ---------------------------------------------------------------------------
describe('U1-F20 — orphan colors consolidated only where a governed token is demonstrably equivalent', () => {
  it('#e05e00 consolidates to the already-authorized uellix-orange-strong token (legal pages)', () => {
    for (const file of [
      path.join('app', '(public)', 'privacidad', 'page.tsx'),
      path.join('app', '(public)', 'privacy', 'page.tsx'),
      path.join('app', '(public)', 'terminos', 'page.tsx'),
      path.join('app', '(public)', 'terms', 'page.tsx'),
    ]) {
      const src = read(file)
      expect(src, file).not.toMatch(/#e05e00/i)
      expect(src, file).toMatch(/hover:\[&_a\]:text-uellix-orange-strong/)
    }
  })

  it('#e65f00 (a near-duplicate hover state, same role as orange-strong) consolidates too', () => {
    const src = read(path.join('app', 'components', 'investment-form', 'InvestmentRow.tsx'))
    expect(src).not.toMatch(/#e65f00/i)
    expect(src).toMatch(/hover:bg-uellix-orange-strong/)
  })

  it('the uellix-orange-strong token itself is untouched by this consolidation', () => {
    const css = read(path.join('app', 'globals.css'))
    expect(css).toMatch(/--color-uellix-orange-strong:\s*#e05e00;/)
  })

  it('#B85200 (the AA-safe orange for small text) is untouched — not merged for being "close"', () => {
    const hits: string[] = []
    for (const root of ['app', 'components']) {
      for (const file of walkFiles(root, ['.tsx', '.ts'])) {
        if (/#B85200/i.test(read(file))) hits.push(file)
      }
    }
    expect(hits.length).toBeGreaterThan(0)
  })

  it('#5B6472 is deliberately deferred — not force-mapped to canonical Slate', () => {
    // No frozen Tailwind theme utility exists for Slate/gray-mid (only a plain
    // --uellix-gray-mid CSS variable, not a --color-uellix-* theme entry), the
    // hex values are not close enough to assume equivalence without evidence,
    // and every consumer sits on a marketing surface under the Q5
    // evidence-recovery hold. Recorded as DEFERRED_VISUAL_TOKEN_MAPPING.
    const css = read(path.join('app', 'globals.css'))
    expect(css).not.toMatch(/--color-uellix-gray-mid/)
    const src = read(path.join('components', 'marketing', 'PipelineSection.tsx'))
    expect(src).toMatch(/#5B6472/)
  })

  it('#1E293B occurrences are either out-of-brand-scope or deliberately deferred', () => {
    // organization/settings: a tenant-configurable white-label default/example
    // value, not a Uellix brand token at all.
    expect(read(path.join('app', 'app', 'organization', 'settings', 'page.tsx'))).toMatch(/#1e293b/i)
    expect(
      read(path.join('app', 'app', 'organization', 'settings', 'settings-form.tsx'))
    ).toMatch(/#1e293b/i)
    // organization/onboarding hover: calibrated against the OLD #0F172A Navy;
    // no frozen "Navy hover" token exists (unlike Orange's orange-strong), so
    // recalibrating it against the new canonical Navy would be a new design
    // decision, not a token consolidation. Deferred. Relocated from
    // app/app/organization/onboarding/page.tsx into
    // components/onboarding/OrganizationOnboardingForm.tsx by ca30c2d's
    // server-component extraction — same button, same literal, same
    // rationale, new home.
    expect(
      read(path.join('components', 'onboarding', 'OrganizationOnboardingForm.tsx'))
    ).toMatch(/#1E293B/)
    // FAQSection: a contrast-calibrated dark-mode border against a near-black
    // background, on a marketing surface under the Q5 hold. Deferred.
    expect(read(path.join('components', 'marketing', 'FAQSection.tsx'))).toMatch(/#1E293B/)
  })

  it('ReportPdfDocument body-text color is a distinct role from governed brand Navy, left untouched', () => {
    const src = read(path.join('lib', 'reports', 'pdf', 'ReportPdfDocument.tsx'))
    // Headings/figures already use the governed Navy (#172b49, from RE-U6-B).
    expect(src).toMatch(/title:[\s\S]{0,80}color:\s*'#172b49'/)
    // Body/table text intentionally uses a distinct, slightly softer near-black.
    expect(src).toMatch(/td:[\s\S]{0,40}color:\s*'#1e293b'/)
  })
})
