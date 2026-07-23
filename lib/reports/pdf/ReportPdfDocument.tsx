// lib/reports/pdf/ReportPdfDocument.tsx
// Fase 6a PoC — audit-ready SROI report as a real PDF via @react-pdf/renderer.
// Server-only: rendered by react-pdf's renderer inside the route handler (Node
// runtime), never bundled to the client. Mirrors the print page content and
// carries the mandatory methodological disclaimers verbatim.

import fs from 'node:fs'
import path from 'node:path'
import { Document, Page, View, Text, StyleSheet, Image } from '@react-pdf/renderer'
import type { FunderBreakdown, EvidenceManifestRow, FxTrail, LineItems, MethodologyReadinessRow } from './report-data'
import { getApprovedOrganizationLogoUrl } from '@/lib/organizations/logo-url'

// Uellix brand palette (mirrors app/globals.css).
const NARANJA_IMPACTO = '#FF6A00'
const AZUL_PROFUNDO = '#0F172A'

// Bundled Uellix horizontal logo, embedded as a base64 data URI so the
// audit-ready report carries Uellix branding by default (non white-label).
// Server-only fs read, cached across renders. Never throws: a missing asset
// simply omits the logo rather than breaking PDF generation.
let _uellixLogoDataUri: string | null | undefined
function uellixLogoDataUri(): string | null {
  if (_uellixLogoDataUri !== undefined) return _uellixLogoDataUri
  try {
    const p = path.join(process.cwd(), 'public', 'brand', 'uellix-logo-horizontal-from-guide.png')
    _uellixLogoDataUri = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
  } catch {
    _uellixLogoDataUri = null
  }
  return _uellixLogoDataUri
}

export type ReportPdfRun = {
  sroiRatio: string | null
  netSocialValue: string | null
  grossSocialValue: string | null
  totalInvestment: string | null
  currency: string | null
  version: number | null
}

export type ReportPdfSection = {
  id: string
  title: string
  content: string | null
}

export type ReportPdfStandard = {
  catalogName: string
  entries: string
}

export type ReportPdfProps = {
  organizationName: string
  projectName: string
  reportTitle: string
  statusLabel: string
  variantLabel: string
  calculationRunId: string
  run: ReportPdfRun | null
  sections: ReportPdfSection[]
  standards: ReportPdfStandard[]
  funderBreakdown: FunderBreakdown | null
  evidenceManifest: EvidenceManifestRow[]
  fxTrail: FxTrail | null
  lineItems: LineItems | null
  methodologyReadiness: MethodologyReadinessRow[] | null
  generatedAt: string
  whiteLabelEnabled?: boolean
  logoUrl?: string | null
  brandColor?: string | null
}

const styles = StyleSheet.create({
  page: {
    paddingVertical: 48,
    paddingHorizontal: 56,
    fontSize: 10,
    color: '#0f172a',
    fontFamily: 'Helvetica',
    lineHeight: 1.5,
  },
  eyebrow: { fontSize: 8, letterSpacing: 1.5, color: '#64748b', textTransform: 'uppercase' },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginTop: 4, color: '#0f172a' },
  headerRule: { borderBottomWidth: 1, borderBottomColor: '#cbd5e1', paddingBottom: 14, marginBottom: 18 },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  metaItem: { width: '33%', marginBottom: 6 },
  metaLabel: { fontSize: 7, color: '#64748b', textTransform: 'uppercase' },
  metaValue: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#334155' },
  sectionHeading: { fontSize: 8, letterSpacing: 1, color: '#64748b', textTransform: 'uppercase', marginBottom: 8 },
  figuresRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 18 },
  figureBox: {
    width: '25%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    padding: 8,
  },
  figureLabel: { fontSize: 8, color: '#64748b' },
  figureValue: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 2, color: '#0f172a' },
  // Hero SROI: the single most important number gets dominant visual weight.
  heroRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
  heroBox: {
    width: '36%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderLeftWidth: 3,
    borderRadius: 4,
    padding: 12,
    justifyContent: 'center',
  },
  heroLabel: { fontSize: 8, letterSpacing: 1, textTransform: 'uppercase' },
  heroValue: { fontSize: 30, fontFamily: 'Helvetica-Bold', color: AZUL_PROFUNDO, marginTop: 2 },
  heroCaption: { fontSize: 7.5, color: '#64748b', marginTop: 5, lineHeight: 1.3 },
  heroFigures: { width: '61%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  heroFigure: {
    width: '31%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    padding: 8,
    justifyContent: 'center',
  },
  disclaimer: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    borderRadius: 4,
    padding: 12,
    marginBottom: 18,
  },
  disclaimerTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#0f172a' },
  disclaimerBody: { fontSize: 9, color: '#475569', marginTop: 4 },
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#0f172a', marginBottom: 3 },
  tableHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 3,
    marginBottom: 2,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 3,
  },
  th: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#64748b' },
  td: { fontSize: 8.5, color: '#1e293b' },
  tdMono: { fontSize: 8, color: '#475569', fontFamily: 'Courier' },
  sectionBody: { fontSize: 9.5, color: '#1e293b' },
  sectionEmpty: { fontSize: 9.5, color: '#94a3b8', fontStyle: 'italic' },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 56,
    right: 56,
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    paddingTop: 8,
    fontSize: 7.5,
    color: '#64748b',
  },
})

function fmtMoney(value: string | null, currency?: string | null): string {
  if (!value) return '—'
  const n = parseFloat(value)
  if (isNaN(n)) return '—'
  const formatted = n.toLocaleString('es-MX', { maximumFractionDigits: 2 })
  return currency ? `${formatted} ${currency}` : formatted
}

function fmtRatio(value: string | null): string {
  if (!value) return '—'
  const n = parseFloat(value)
  return isNaN(n) ? '—' : `${n.toFixed(2)}:1`
}

// Plain-language gloss under the hero ratio so the headline number is legible
// to non-specialist readers (funders, community), not just analysts.
function sroiCaption(value: string | null, currency?: string | null): string {
  if (!value) return ''
  const n = parseFloat(value)
  if (isNaN(n)) return ''
  const cur = currency ?? 'USD'
  return `Por cada 1 ${cur} invertido se generan ${n.toFixed(2)} ${cur} de valor social.`
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

export function ReportPdfDocument(props: ReportPdfProps) {
  const { run } = props
  const approvedLogoUrl = getApprovedOrganizationLogoUrl(props.logoUrl)
  // Accent = the org's brand color under white-label, otherwise Naranja Impacto.
  const accent = props.whiteLabelEnabled && props.brandColor ? props.brandColor : NARANJA_IMPACTO
  // The Uellix wordmark leads the header only when NOT white-labeled, so a
  // client-branded report never shows a competing Uellix logo.
  const uellixLogo = props.whiteLabelEnabled ? null : uellixLogoDataUri()
  return (
    <Document title={props.reportTitle} author="Uellix">
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={[styles.headerRule, { borderBottomColor: accent }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              {uellixLogo ? (
                <Image src={uellixLogo} style={{ width: 92, height: 24, objectFit: 'contain', marginBottom: 8 }} />
              ) : null}
              <Text style={[styles.eyebrow, { color: accent }]}>Reporte de Impacto SROI · Variante {props.variantLabel}</Text>
              <Text style={styles.title}>{props.reportTitle}</Text>
            </View>
            {props.whiteLabelEnabled && approvedLogoUrl ? (
              <Image src={approvedLogoUrl} style={{ width: 60, height: 60, objectFit: 'contain' }} />
            ) : null}
          </View>
          <View style={styles.metaGrid}>
            <MetaItem label="Organización" value={props.organizationName} />
            <MetaItem label="Proyecto" value={props.projectName} />
            <MetaItem label="Estado" value={props.statusLabel} />
            <MetaItem
              label="Corrida de cálculo"
              value={`${props.calculationRunId.slice(0, 8)}${run?.version ? ` · v${run.version}` : ''}`}
            />
            <MetaItem label="Generado" value={props.generatedAt} />
          </View>
        </View>

        {/* SROI figures — hero ratio + three supporting figures */}
        {run && (
          <View>
            <Text style={styles.sectionHeading}>Resultados SROI</Text>
            <View style={styles.heroRow}>
              <View style={[styles.heroBox, { borderLeftColor: accent }]}>
                <Text style={[styles.heroLabel, { color: accent }]}>Ratio SROI</Text>
                <Text style={styles.heroValue}>{fmtRatio(run.sroiRatio)}</Text>
                <Text style={styles.heroCaption}>{sroiCaption(run.sroiRatio, run.currency)}</Text>
              </View>
              <View style={styles.heroFigures}>
                <View style={styles.heroFigure}>
                  <Text style={styles.figureLabel}>Valor social neto</Text>
                  <Text style={styles.figureValue}>{fmtMoney(run.netSocialValue, run.currency)}</Text>
                </View>
                <View style={styles.heroFigure}>
                  <Text style={styles.figureLabel}>Valor social bruto</Text>
                  <Text style={styles.figureValue}>{fmtMoney(run.grossSocialValue, run.currency)}</Text>
                </View>
                <View style={styles.heroFigure}>
                  <Text style={styles.figureLabel}>Inversión total</Text>
                  <Text style={styles.figureValue}>{fmtMoney(run.totalInvestment, run.currency)}</Text>
                </View>
              </View>
            </View>
          </View>
        )}

        {/* Mandatory methodological disclaimer — verbatim from the print page */}
        <View style={styles.disclaimer}>
          <Text style={styles.disclaimerTitle}>Aviso metodológico</Text>
          <Text style={styles.disclaimerBody}>
            Este reporte se ancla a una corrida de cálculo inmutable y constituye una base lista para
            auditoría. No constituye certificación automática de impacto ni aprobación de auditoría
            independiente. Requiere revisión metodológica humana antes de su uso externo.
          </Text>
        </View>

        {/* Sections */}
        {props.sections.map((section) => (
          <View key={section.id} style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            {section.content && section.content.trim().length > 0 ? (
              <Text style={styles.sectionBody}>{section.content}</Text>
            ) : (
              <Text style={styles.sectionEmpty}>Sin contenido.</Text>
            )}
          </View>
        ))}

        {/* Methodology review readiness (methodological/audit annex) */}
        {props.methodologyReadiness && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Preparación metodológica por paso</Text>
            <Text style={[styles.sectionBody, { color: '#64748b', marginBottom: 4 }]}>
              Puntaje de preparación de la revisión metodológica de cada paso del pipeline (0–100).
            </Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '50%' }]}>Paso</Text>
              <Text style={[styles.th, { width: '25%', textAlign: 'right', paddingRight: 8 }]}>Preparación</Text>
              <Text style={[styles.th, { width: '25%' }]}>Estado</Text>
            </View>
            {props.methodologyReadiness.map((r, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={[styles.td, { width: '50%' }]}>{r.stepLabel}</Text>
                <Text style={[styles.td, { width: '25%', textAlign: 'right', paddingRight: 8 }]}>
                  {r.readinessScore === null ? 'Sin evaluar' : `${r.readinessScore}%`}
                </Text>
                <Text style={[styles.td, { width: '25%', color: '#64748b' }]}>{r.statusLabel}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Funder breakdown table (audit annex) — only when present */}
        {props.funderBreakdown && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Desglose por financiador (USD)</Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '34%' }]}>Financiador</Text>
              <Text style={[styles.th, { width: '20%' }]}>Tipo</Text>
              <Text style={[styles.th, { width: '16%', textAlign: 'right' }]}>Inversión</Text>
              <Text style={[styles.th, { width: '18%', textAlign: 'right' }]}>Valor neto atrib.</Text>
              <Text style={[styles.th, { width: '12%', textAlign: 'right' }]}>SROI</Text>
            </View>
            {props.funderBreakdown.rows.map((r, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={[styles.td, { width: '34%' }]}>{r.funderName}</Text>
                <Text style={[styles.td, { width: '20%', color: '#64748b' }]}>{r.funderType}</Text>
                <Text style={[styles.td, { width: '16%', textAlign: 'right' }]}>{fmtMoney(r.investmentUsd)}</Text>
                <Text style={[styles.td, { width: '18%', textAlign: 'right' }]}>{fmtMoney(r.attributedNsvUsd)}</Text>
                <Text style={[styles.td, { width: '12%', textAlign: 'right' }]}>{fmtRatio(r.sroiRatio)}</Text>
              </View>
            ))}
            {props.funderBreakdown.unattributedNsvUsd && (
              <Text style={[styles.sectionBody, { color: '#64748b', marginTop: 3 }]}>
                Valor social neto no atribuido: {fmtMoney(props.funderBreakdown.unattributedNsvUsd)} USD
              </Text>
            )}
          </View>
        )}

        {/* FX conversion trail (audit annex) — only when present */}
        {props.fxTrail && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Rastro de conversión a USD</Text>
            <Text style={[styles.sectionBody, { color: '#64748b', marginBottom: 4 }]}>
              Cada aporte se normalizó a USD al guardarse. Los aportes ya en USD no se convierten.
            </Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '28%', textAlign: 'right', paddingRight: 8 }]}>Monto original</Text>
              <Text style={[styles.th, { width: '22%' }]}>Moneda</Text>
              <Text style={[styles.th, { width: '28%', textAlign: 'right', paddingRight: 8 }]}>Monto USD</Text>
              <Text style={[styles.th, { width: '22%' }]}>Año</Text>
            </View>
            {props.fxTrail.rows.map((r, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={[styles.td, { width: '28%', textAlign: 'right', paddingRight: 8 }]}>{fmtMoney(r.amount)}</Text>
                <Text style={[styles.td, { width: '22%' }]}>{r.currency}{r.converted ? ' (conv.)' : ''}</Text>
                <Text style={[styles.td, { width: '28%', textAlign: 'right', paddingRight: 8 }]}>{fmtMoney(r.amountUsd)}</Text>
                <Text style={[styles.td, { width: '22%', color: '#64748b' }]}>{r.year ?? '—'}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Evidence hash manifest (audit annex) — only when present */}
        {props.evidenceManifest.length > 0 && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Manifiesto de evidencia (hashes SHA-256)</Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '46%' }]}>Título</Text>
              <Text style={[styles.th, { width: '14%' }]}>Tipo</Text>
              <Text style={[styles.th, { width: '20%' }]}>Estado</Text>
              <Text style={[styles.th, { width: '20%' }]}>Hash</Text>
            </View>
            {props.evidenceManifest.map((e, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={[styles.td, { width: '46%' }]}>{e.title}</Text>
                <Text style={[styles.td, { width: '14%', color: '#64748b' }]}>{e.type}</Text>
                <Text style={[styles.td, { width: '20%' }]}>{e.status}</Text>
                <Text style={[styles.tdMono, { width: '20%' }]}>{e.hashShort ? `${e.hashShort}…` : '—'}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Raw calculation line items (audit annex) — only when present */}
        {props.lineItems && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Line items del cálculo</Text>
            <Text style={[styles.sectionBody, { color: '#64748b', marginBottom: 4 }]}>
              Contribuciones crudas de la corrida inmutable. Referencias por ID de resultado/proxy
              del snapshot (no por nombre, que podría haber cambiado). Valores en USD.
            </Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '14%' }]}>Resultado</Text>
              <Text style={[styles.th, { width: '12%', textAlign: 'right', paddingRight: 6 }]}>Cantidad</Text>
              <Text style={[styles.th, { width: '14%', textAlign: 'right', paddingRight: 6 }]}>Valor proxy</Text>
              <Text style={[styles.th, { width: '15%', textAlign: 'right', paddingRight: 6 }]}>Bruto</Text>
              <Text style={[styles.th, { width: '30%' }]}>Ajustes</Text>
              <Text style={[styles.th, { width: '15%', textAlign: 'right' }]}>Ajustado</Text>
            </View>
            {props.lineItems.rows.map((r, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={[styles.tdMono, { width: '14%' }]}>{r.outcomeRef}</Text>
                <Text style={[styles.td, { width: '12%', textAlign: 'right', paddingRight: 6 }]}>{r.quantity}</Text>
                <Text style={[styles.td, { width: '14%', textAlign: 'right', paddingRight: 6 }]}>{fmtMoney(r.proxyValue)}</Text>
                <Text style={[styles.td, { width: '15%', textAlign: 'right', paddingRight: 6 }]}>{fmtMoney(r.grossValue)}</Text>
                <Text style={[styles.td, { width: '30%', color: '#64748b' }]}>{r.adjustments}</Text>
                <Text style={[styles.td, { width: '15%', textAlign: 'right' }]}>{fmtMoney(r.adjustedValue)}</Text>
              </View>
            ))}
            {props.lineItems.truncated && (
              <Text style={[styles.sectionBody, { color: '#64748b', marginTop: 3 }]}>
                Mostrando {props.lineItems.rows.length} de {props.lineItems.total} line items.
              </Text>
            )}
          </View>
        )}

        {/* Reference standards (comparability crosswalks) — only when present */}
        {props.standards.length > 0 && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Estándares de referencia</Text>
            <Text style={[styles.sectionBody, { color: '#64748b', marginBottom: 4 }]}>
              Los resultados se mapean a los siguientes marcos como referencia de comparabilidad. No
              constituye certificación ni equivalencia oficial con dichos estándares.
            </Text>
            {props.standards.map((s) => (
              <View key={s.catalogName} style={{ marginBottom: 3 }}>
                <Text style={{ fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: '#0f172a' }}>
                  {s.catalogName}
                </Text>
                <Text style={styles.sectionBody}>{s.entries}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Footer on every page */}
        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `Uellix · Reporte SROI generado el ${props.generatedAt} · Documento lista para auditoría, requiere revisión humana antes de su uso externo · Página ${pageNumber} de ${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  )
}
