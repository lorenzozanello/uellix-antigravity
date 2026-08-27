// lib/stella/schemas/composer-numeric-guard.test.ts
// U4 (WS4) — exhaustive tests for the pure Composer numeric-integrity guard.
import { describe, it, expect } from 'vitest'
import type { ComposerOutput } from './composer-output'
import {
  validateComposerNumbers,
  validateComposerReferences,
  validateNarrativeReferences,
  validateReportNarrativeAuthority,
  authorizedNumbersFromSnapshot,
  type AuthorizedNumbers,
  type ReportNumericAuthority,
} from './composer-numeric-guard'

// Authorized set mirroring a persisted run: investment 500000, gross 2000000,
// net 1600000, ratio 3.2, one funder row, unattributed 50000, deadweight 20.
const AUTHORIZED: AuthorizedNumbers = {
  totals: {
    totalInvestment: '500000.0000',
    grossSocialValue: '2000000.0000',
    netSocialValue: '1600000.0000',
  },
  ratio: '3.200000',
  funderBreakdown: [
    { investmentUsd: '500000.0000', attributedNsvUsd: '1550000.0000', sroiRatio: '3.100000' },
  ],
  additional: ['50000.0000', '20', '0.144724'],
}

function output(overrides: Partial<ComposerOutput> = {}): ComposerOutput {
  return {
    section_key: 'executive_summary',
    draft_title: 'Resumen ejecutivo',
    draft_content: 'El proyecto generó valor social.',
    assumptions: [],
    limitations: [],
    evidence_references: [],
    proxy_references: [],
    ...overrides,
  }
}

describe('validateComposerNumbers — hallucinated numbers are flagged', () => {
  it('flags a number that matches nothing in the authorized set', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'La inversión total fue de 750000 USD.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations).toEqual([{ token: '750000', field: 'draft_content' }])
  })

  it('flags a subtly-wrong ratio (3.4 when the run says 3.2)', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'Se alcanzó un SROI de 3.4 este periodo.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('3.4')
  })

  it('flags hallucinations in every free-text field, with field paths', () => {
    const res = validateComposerNumbers(
      output({
        draft_title: 'Retorno de 4.5x',
        assumptions: ['Se asume una tasa de 12.5%'],
        limitations: ['La muestra fue de 384 beneficiarios'],
        evidence_references: [
          { evidenceId: 'ev-1', title: 'Encuesta', context: 'Cubre 999 hogares' },
        ],
        proxy_references: [
          { proxyId: 'px-1', name: 'Salario 87500', context: 'Valor de 87500 USD por unidad' },
        ],
      }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    const fields = res.violations.map((v) => v.field)
    expect(fields).toContain('draft_title')
    expect(fields).toContain('assumptions[0]')
    expect(fields).toContain('limitations[0]')
    expect(fields).toContain('evidence_references[0].context')
    expect(fields).toContain('proxy_references[0].name')
    expect(fields).toContain('proxy_references[0].context')
  })

  it('flags a percentage that matches nothing even after /100', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'El deadweight aplicado fue 35%.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('35')
  })

  it('flags a wrong thousands-formatted amount', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'Un total de $1,650,000 en valor neto.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('1,650,000')
  })
})

describe('validateComposerNumbers — legit reformattings pass', () => {
  it.each([
    ['plain exact strings', 'Inversión: 500000.0000, neto: 1600000.0000, SROI 3.200000.'],
    ['integers without decimals', 'La inversión de 500000 produjo 1600000 de valor neto.'],
    ['en-US thousands separators', 'Se invirtieron $500,000 y se generaron $1,600,000.'],
    ['es-LA thousands separators', 'Se invirtieron $500.000 y se generaron $1.600.000.'],
    ['mixed grouping with decimals', 'Total: 1,600,000.00 USD (1.600.000,00 en formato local).'],
    ['ratio short form and X:1', 'Un SROI de 3.2:1 confirma el retorno.'],
    ['ratio with decimal comma', 'Un SROI de 3,2 veces la inversión.'],
    ['funder row values', 'El financiador aportó 500000 y capturó 1550000 (SROI 3.1).'],
    ['additional authorized values', 'Quedaron 50000 sin atribuir; deadweight del 20%.'],
    ['percentage of an authorized fraction', 'La razón equivale al 14.47% de retorno unitario.'],
    ['truncations from 2 to 6 decimals', 'Ratio 3.20, o bien 3.200, 3.2000, 3.20000, 3.200000.'],
  ])('%s', (_name, draft_content) => {
    const res = validateComposerNumbers(output({ draft_content }), AUTHORIZED)
    expect(res.violations).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('accepts rounded (not just truncated) representations', () => {
    // authorized additional 0.144724 → 0.1447 (trunc) and 0.14 (round) both fine
    const res = validateComposerNumbers(
      output({ draft_content: 'Aproximadamente 0.1447, es decir 0.14.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(true)
  })
})

describe('validateComposerNumbers — documented allowlist', () => {
  it('allows calendar years 1900-2100 but not out-of-range 4-digit integers', () => {
    const ok = validateComposerNumbers(
      output({ draft_content: 'Entre 2024 y 2026, como en 1998.' }),
      AUTHORIZED,
    )
    expect(ok.ok).toBe(true)

    const bad = validateComposerNumbers(
      output({ draft_content: 'Se registraron 4750 beneficiarios.' }),
      AUTHORIZED,
    )
    expect(bad.ok).toBe(false)
    expect(bad.violations[0].token).toBe('4750')
  })

  it('allows list ordinals and small integers up to 20, flags 21+', () => {
    const ok = validateComposerNumbers(
      output({ draft_content: 'Fase 1, paso 2, con 3 resultados y 20 indicadores.' }),
      AUTHORIZED,
    )
    expect(ok.ok).toBe(true)

    const bad = validateComposerNumbers(
      output({ draft_content: 'Se midieron 21 indicadores.' }),
      AUTHORIZED,
    )
    expect(bad.ok).toBe(false)
    expect(bad.violations[0].token).toBe('21')
  })

  it('allows section numbers at line start or after "sección"', () => {
    const res = validateComposerNumbers(
      output({
        draft_content: '2.1 Metodología\nComo se explica en la sección 3.4.1, el análisis...',
      }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(true)
  })

  it('does NOT treat a line-start ratio-like "4.9:1" as a section number', () => {
    const res = validateComposerNumbers(
      output({ draft_content: '4.9:1 fue el retorno estimado.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('4.9')
  })

  it('treats digits attached to identifiers as references, not numeric claims', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'Ver evidencia ev-123 y el ODS8; detalle en v2.3.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(true)
  })
})

describe('validateComposerNumbers — value-claiming context disables exemptions (audit fixes)', () => {
  // FIX 1: small integers in ratio/currency claims are validated, not exempted.
  it('flags a bare-integer wrong ratio ("el SROI es 7" vs authorized 3.2)', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'El SROI es 7.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations).toEqual([{ token: '7', field: 'draft_content' }])
  })

  it('flags a small integer followed by "veces"', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'Logramos un retorno de 4 veces.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('4')
  })

  it('flags a small integer with a currency symbol', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'El costo unitario fue de $15.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('15')
  })

  it('still passes a claimed small integer that IS authorized ("total de 20")', () => {
    // 20 is in AUTHORIZED.additional — claimed context requires a match, and gets one.
    const res = validateComposerNumbers(
      output({ draft_content: 'Se aplicó un deadweight total de 20.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(true)
  })

  // FIX 2: year-shaped tokens in currency/quantity claims are validated.
  it('flags "$2050" — currency context beats the year exemption', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'El fondo recibió $2050 al cierre.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations).toEqual([{ token: '2050', field: 'draft_content' }])
  })

  it('flags "recibió 2019 adicionales" — quantity context beats the year exemption', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'Se entregaron 2019 adicionales al programa.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('2019')
  })

  it('flags a year-shaped token followed by a currency word', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'La reparación costó 2026 USD.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('2026')
  })

  it('keeps genuine year usage passing ("en 2026", "2025-2026")', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'En 2026 se ejecutó el programa; el periodo 2025-2026 cerró bien.' }),
      AUTHORIZED,
    )
    expect(res.violations).toEqual([])
    expect(res.ok).toBe(true)
  })

  // FIX 3: line-start decimals followed by value markers are not headings.
  it('flags a paragraph-start "7.7 veces la inversión" (not a section heading)', () => {
    const res = validateComposerNumbers(
      output({ draft_content: '7.7 veces la inversión fue el resultado del periodo.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations).toEqual([{ token: '7.7', field: 'draft_content' }])
  })

  it('passes a paragraph-start "3.2 veces" because 3.2 is authorized, not exempted', () => {
    const res = validateComposerNumbers(
      output({ draft_content: '3.2 veces la inversión fue el resultado verificado.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(true)
  })

  it('flags a line-start decimal followed by lowercase prose even without markers', () => {
    const res = validateComposerNumbers(
      output({ draft_content: '4.8 resultó ser la cifra del periodo.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(false)
    expect(res.violations[0].token).toBe('4.8')
  })

  it('still exempts a real heading ("2.1 Metodología") after the tightening', () => {
    const res = validateComposerNumbers(
      output({ draft_content: '2.1 Metodología\nEl análisis sigue la guía SROI.' }),
      AUTHORIZED,
    )
    expect(res.ok).toBe(true)
  })
})

describe('validateComposerNumbers — edges', () => {
  it('passes a draft with no numbers at all', () => {
    const res = validateComposerNumbers(output(), AUTHORIZED)
    expect(res.ok).toBe(true)
    expect(res.violations).toEqual([])
  })

  it('reports every occurrence of repeated hallucinated tokens', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'Cifra 777 aquí y 777 allá.' }),
      AUTHORIZED,
    )
    expect(res.violations).toHaveLength(2)
  })

  it('works with numeric (non-string) authorized inputs', () => {
    const res = validateComposerNumbers(
      output({ draft_content: 'SROI de 2.02 sobre 10000 invertidos.' }),
      {
        totals: { totalInvestment: 10000, grossSocialValue: 40062.5, netSocialValue: 20150.8209 },
        ratio: 2.015082,
      },
    )
    expect(res.ok).toBe(true)
  })
})

describe('validateComposerReferences', () => {
  const context = {
    evidenceMetadata: [{ id: 'ev-1' }, { id: 'ev-2' }],
    proxySummary: [{ id: 'px-1' }],
  }

  it('passes when every referenced id exists in the context', () => {
    const res = validateComposerReferences(
      output({
        evidence_references: [
          { evidenceId: 'ev-1', title: 'Encuesta', context: 'citada' },
          { evidenceId: 'ev-2', title: 'Informe', context: 'citado' },
        ],
        proxy_references: [{ proxyId: 'px-1', name: 'Salario', context: 'citado' }],
      }),
      context,
    )
    expect(res.ok).toBe(true)
    expect(res.violations).toEqual([])
  })

  it('flags a hallucinated evidence id with its field path', () => {
    const res = validateComposerReferences(
      output({
        evidence_references: [
          { evidenceId: 'ev-1', title: 'Encuesta', context: 'citada' },
          { evidenceId: 'ev-999', title: 'Inventado', context: 'no existe' },
        ],
      }),
      context,
    )
    expect(res.ok).toBe(false)
    expect(res.violations).toEqual([
      { id: 'ev-999', field: 'evidence_references[1].evidenceId' },
    ])
  })

  it('flags a hallucinated proxy id', () => {
    const res = validateComposerReferences(
      output({ proxy_references: [{ proxyId: 'px-404', name: 'Fantasma', context: 'x' }] }),
      context,
    )
    expect(res.ok).toBe(false)
    expect(res.violations).toEqual([{ id: 'px-404', field: 'proxy_references[0].proxyId' }])
  })

  it('treats an absent context list as empty (everything referenced is a violation)', () => {
    const res = validateComposerReferences(
      output({ evidence_references: [{ evidenceId: 'ev-1', title: 't', context: 'c' }] }),
      {},
    )
    expect(res.ok).toBe(false)
  })
})

describe('authorizedNumbersFromSnapshot', () => {
  it('collects totals, ratio, funder rows and metadata extras from a snapshot', () => {
    const authorized = authorizedNumbersFromSnapshot(
      {
        totalInvestment: 500000,
        grossSocialValue: 2000000,
        netSocialValue: 1600000,
        sroiRatio: 3.2,
        lineItemCount: 4,
        version: 7,
        unattributedNsvUsd: 50000,
        fundersBreakdown: [{ investmentUsd: 500000, attributedNsvUsd: 1550000, sroiRatio: 3.1 }],
      },
      ['20'],
    )
    const res = validateComposerNumbers(
      output({
        draft_content:
          'Corrida v7 con 4 líneas: 500,000 invertidos, 1,600,000 netos (SROI 3.2), ' +
          '1,550,000 atribuidos (3.1), 50,000 sin atribuir, deadweight 20%.',
      }),
      authorized,
    )
    expect(res.violations).toEqual([])
    expect(res.ok).toBe(true)
  })
})

// R3-CL1 — the report boundary is deliberately more restrictive than Composer
// drafting. These cases are the red baseline for the finite product grammar.
describe('R3-CL1 — report authority grammar', () => {
  const REPORT_AUTHORITY: ReportNumericAuthority = {
    money: [
      { kind: 'money', currency: 'USD', value: '1800.5000' },
      { kind: 'money', currency: 'USD', value: '-1800.5000' },
      { kind: 'money', currency: 'USD', value: '17.0000' },
    ],
    percentages: [{ kind: 'percent', percentagePoints: '17.0000' }],
    sroiRatios: [{ kind: 'sroi_ratio', numerator: '2.400000', denominator: '1' }],
  }

  const validate = (content: string) => validateReportNarrativeAuthority({
    title: 'Resultados',
    content,
    numericAuthority: REPORT_AUTHORITY,
    referenceAuthority: { evidenceIds: [], proxyIds: [] },
  })

  it.each([
    '>17',
    '<17',
    '1-2',
    '1–2',
    '1,800',
    '1.800',
    '(1800)',
    '1e3',
    'USD1,800',
    '1800',
    '-1800',
    '2026 beneficiaries',
    '-0 USD',
  ])('refuses unsupported report numeric syntax as a complete token: %s', (claim) => {
    const result = validate(`Resultado: ${claim}.`)

    expect(result.ok).toBe(false)
    expect(result.numeric.violations[0]?.token).toBe(claim)
  })

  it('does not let a money authority authorize a percentage or a ratio', () => {
    const moneyOnly: ReportNumericAuthority = {
      money: [{ kind: 'money', currency: 'USD', value: '17.0000' }],
      percentages: [],
      sroiRatios: [],
    }
    const percent = validateReportNarrativeAuthority({
      title: 'Resultados', content: 'La atribución fue 17%.', numericAuthority: moneyOnly,
      referenceAuthority: { evidenceIds: [], proxyIds: [] },
    })
    const ratio = validateReportNarrativeAuthority({
      title: 'Resultados', content: 'El SROI fue 17:1.', numericAuthority: moneyOnly,
      referenceAuthority: { evidenceIds: [], proxyIds: [] },
    })

    expect(percent.ok).toBe(false)
    expect(ratio.ok).toBe(false)
  })

  it('accepts only canonical same-kind money, percent, and SROI forms', () => {
    const result = validate('La inversión fue USD 1,800.50; la atribución fue 17 % y el SROI fue 2.4:1.')

    expect(result.ok).toBe(true)
  })

  it.each([
    '-$1,800.50',
    '$1,800.50',
    'USD 1,800.50',
    '-1,800.50 USD',
    '1,800.50 USD',
  ])('accepts the canonical money form %s only for money authority', (money) => {
    const result = validate(`La cifra fue ${money}.`)

    expect(result.ok).toBe(true)
  })

  it('preserves an explicitly authorized negative money sign', () => {
    const result = validate('El valor social neto fue -$1,800.50.')

    expect(result.ok).toBe(true)
  })

  it('permits only established structural nonclaims', () => {
    const result = validateReportNarrativeAuthority({
      title: '# 2.1 Metodología',
      content: '1. Validación\nFecha: 2026-08-27. Versión v2.3 para SDG8.',
      numericAuthority: { money: [], percentages: [], sroiRatios: [] },
      referenceAuthority: { evidenceIds: [], proxyIds: [] },
    })

    expect(result.ok).toBe(true)
  })
})

describe('R3-CL1 — UUID narrative references', () => {
  const evidenceId = '11111111-1111-4111-8111-111111111111'
  const proxyId = '22222222-2222-4222-8222-222222222222'
  const foreignId = '33333333-3333-4333-8333-333333333333'
  const authority = { evidenceIds: [evidenceId], proxyIds: [proxyId] }

  it('accepts valid bare, quoted, Markdown-wrapped, and labelled UUID references', () => {
    const result = validateNarrativeReferences([
      { field: 'content', text: `"${evidenceId}", [${proxyId}](#ref), Evidence ID: ${evidenceId}; Proxy ID: ${proxyId}.` },
    ], authority)

    expect(result.ok).toBe(true)
  })

  it.each([
    ['bare', foreignId],
    ['Markdown', `[${foreignId}](#ref)`],
  ])('refuses a foreign %s UUID anywhere in prose', (_kind, citation) => {
    const result = validateNarrativeReferences([{ field: 'content', text: `Referencia: ${citation}.` }], authority)

    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([{ id: foreignId, field: 'content' }])
  })

  it('enforces exact type labels and rejects legacy citation prefixes', () => {
    const wrongType = validateNarrativeReferences(
      [{ field: 'content', text: `Evidence ID: ${proxyId}.` }],
      authority,
    )
    const legacy = validateNarrativeReferences(
      [{ field: 'content', text: 'La fuente cita ev-legacy y px-legacy.' }],
      authority,
    )

    expect(wrongType.ok).toBe(false)
    expect(legacy.ok).toBe(false)
  })

  it('keeps keyword-only proxy prose out of citation validation', () => {
    const result = validateNarrativeReferences(
      [{ field: 'content', text: 'proxy: costo de oportunidad' }],
      authority,
    )

    expect(result.ok).toBe(true)
  })
})
