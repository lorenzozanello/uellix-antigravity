// lib/reports/pdf/render.test.ts
// Fase 6b — smoke/determinism test: the enriched report document (with the
// funder table, evidence manifest, and reference standards) renders to a valid
// PDF. Content-based, not pixel-based. Guards the react-pdf markup from
// regressions that would only surface at request time otherwise.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { ReportPdfDocument, type ReportPdfProps } from './ReportPdfDocument'

const props: ReportPdfProps = {
  organizationName: 'Org de Prueba',
  projectName: 'Proyecto de Prueba',
  reportTitle: 'Reporte SROI de Prueba',
  statusLabel: 'Bloqueado',
  variantLabel: 'Auditoría',
  calculationRunId: 'a1b2c3d4-0000-0000-0000-000000000000',
  run: {
    sroiRatio: '3.42',
    netSocialValue: '1250000',
    grossSocialValue: '1500000',
    totalInvestment: '365000',
    currency: 'USD',
    version: 2,
  },
  sections: [{ id: '1', title: 'Resumen', content: 'Contenido de prueba.' }],
  standards: [{ catalogName: 'ODS', entries: 'ODS-4 (Educación) · ODS-8 (Trabajo decente)' }],
  funderBreakdown: {
    rows: [
      { funderName: 'Fundación A', funderType: 'foundation', investmentUsd: '1000', attributedNsvUsd: '3000', sroiRatio: '3' },
    ],
    unattributedNsvUsd: '250',
  },
  evidenceManifest: [{ title: 'Documento 1', type: 'file', status: 'approved', hashShort: 'abcdef012345' }],
  generatedAt: '10 de julio de 2026, 21:00',
}

describe('ReportPdfDocument render', () => {
  it('renders the enriched report to a valid, non-trivial PDF', async () => {
    const buffer = await renderToBuffer(
      createElement(ReportPdfDocument, props) as unknown as Parameters<typeof renderToBuffer>[0]
    )
    expect(buffer.length).toBeGreaterThan(1000)
    expect(Buffer.from(buffer.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })

  it('renders without the optional annexes (no funder, no evidence, no standards)', async () => {
    const buffer = await renderToBuffer(
      createElement(ReportPdfDocument, {
        ...props,
        standards: [],
        funderBreakdown: null,
        evidenceManifest: [],
        run: null,
      }) as unknown as Parameters<typeof renderToBuffer>[0]
    )
    expect(Buffer.from(buffer.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })
})
