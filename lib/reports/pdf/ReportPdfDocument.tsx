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

// Neutral greys reused across the layout.
const INK = '#1e293b'
const SLATE = '#64748b'
const HAIRLINE = '#e2e8f0'
const NIEBLA = '#f8fafc'
const NARANJA_WASH = '#FFF7F1'

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 60,
    paddingHorizontal: 52,
    fontSize: 10,
    color: AZUL_PROFUNDO,
    fontFamily: 'Helvetica',
    lineHeight: 1.5,
  },

  // ── Header ────────────────────────────────────────────────────────────────
  eyebrow: { fontSize: 8, letterSpacing: 1.5, color: SLATE, textTransform: 'uppercase' },
  title: { fontSize: 21, fontFamily: 'Helvetica-Bold', marginTop: 4, color: AZUL_PROFUNDO, lineHeight: 1.2 },
  headerRule: { borderBottomWidth: 2, borderBottomColor: '#cbd5e1', paddingBottom: 14, marginBottom: 20 },
  // Meta as an even 4-up strip that wraps cleanly.
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  metaItem: { width: '25%', marginBottom: 8, paddingRight: 8 },
  metaLabel: { fontSize: 6.5, letterSpacing: 0.5, color: SLATE, textTransform: 'uppercase' },
  metaValue: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#334155', marginTop: 1 },

  // ── Section heading (accent bar) ──────────────────────────────────────────
  eyebrowHeading: { fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 7 },
  sectionHeaderBar: { width: 3, height: 13, borderRadius: 2, marginRight: 7 },
  sectionHeaderText: { fontSize: 11.5, fontFamily: 'Helvetica-Bold', color: AZUL_PROFUNDO },

  // ── Hero SROI ─────────────────────────────────────────────────────────────
  heroBand: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: NARANJA_WASH,
    borderLeftWidth: 3,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  heroBandLeft: { width: '42%' },
  heroLabel: { fontSize: 8, letterSpacing: 1, textTransform: 'uppercase' },
  heroValue: { fontSize: 32, fontFamily: 'Helvetica-Bold', color: AZUL_PROFUNDO, marginTop: 3 },
  heroCaptionWrap: { width: '58%', paddingLeft: 18 },
  heroCaption: { fontSize: 10.5, color: '#475569', lineHeight: 1.4 },
  kpiRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 22 },
  kpiBox: { width: '32%', borderWidth: 1, borderColor: HAIRLINE, borderRadius: 4, padding: 10 },
  kpiLabel: { fontSize: 8, color: SLATE },
  kpiValue: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 3, color: AZUL_PROFUNDO },

  // ── Disclaimer ────────────────────────────────────────────────────────────
  disclaimer: {
    borderWidth: 1,
    borderColor: HAIRLINE,
    backgroundColor: '#fbfcfd',
    borderRadius: 4,
    padding: 12,
    marginBottom: 22,
  },
  disclaimerTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: AZUL_PROFUNDO },
  disclaimerBody: { fontSize: 9, color: '#475569', marginTop: 4 },

  // ── Content sections ──────────────────────────────────────────────────────
  section: { marginBottom: 16 },
  sectionBody: { fontSize: 9.5, color: INK },
  sectionEmpty: { fontSize: 9.5, color: '#94a3b8', fontStyle: 'italic' },
  sectionNote: { fontSize: 9, color: SLATE, marginBottom: 6 },

  // ── Annex page divider ────────────────────────────────────────────────────
  annexDivider: { marginBottom: 18, paddingBottom: 8, borderBottomWidth: 2, borderBottomColor: '#cbd5e1' },
  annexEyebrow: { fontSize: 8, letterSpacing: 1.5, textTransform: 'uppercase' },
  annexTitle: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: AZUL_PROFUNDO, marginTop: 3 },

  // ── Tables ────────────────────────────────────────────────────────────────
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#eef2f6',
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  tableRowAlt: { backgroundColor: NIEBLA },
  th: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#475569', textTransform: 'uppercase', letterSpacing: 0.3 },
  td: { fontSize: 8.5, color: INK },
  tdMono: { fontSize: 8, color: '#475569', fontFamily: 'Courier' },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 52,
    right: 52,
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    paddingTop: 8,
    fontSize: 7.5,
    color: SLATE,
  },
})

// es-CO number format: '.' thousands, ',' decimals. Currency is placed BEFORE
// the amount (USD 116.940,00) per Colombian/institutional convention.
function fmtMoney(value: string | null, currency?: string | null): string {
  if (!value) return '—'
  const n = parseFloat(value)
  if (isNaN(n)) return '—'
  const formatted = n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${currency} ${formatted}` : formatted
}

function fmtRatio(value: string | null): string {
  if (!value) return '—'
  const n = parseFloat(value)
  return isNaN(n) ? '—' : `${n.toFixed(2).replace('.', ',')} : 1`
}

// Plain-language gloss under the hero ratio so the headline number is legible
// to non-specialist readers (funders, community), not just analysts. Framed as
// an estimate, never a certified measurement.
function sroiCaption(value: string | null, currency?: string | null): string {
  if (!value) return ''
  const n = parseFloat(value)
  if (isNaN(n)) return ''
  const cur = currency ?? 'USD'
  return `Por cada ${cur} 1 invertido, se estima que el proyecto generó ${cur} ${n.toFixed(2).replace('.', ',')} de valor social.`
}

// Spanish labels for enum values that arrive from the data layer in English.
const FUNDER_TYPE_ES: Record<string, string> = {
  public: 'Público', private: 'Privado', foundation: 'Fundación',
  multilateral: 'Multilateral', individual: 'Individual', other: 'Otro',
}
const EVIDENCE_STATUS_ES: Record<string, string> = {
  draft: 'Borrador', under_review: 'En revisión', approved: 'Aprobado',
  rejected: 'Rechazado', archived: 'Archivado',
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

// Section heading with a brand accent bar — used for both narrative sections
// and audit-annex titles so hierarchy reads consistently.
function SectionHeader({ title, accent }: { title: string; accent: string }) {
  return (
    <View style={styles.sectionHeaderRow}>
      <View style={[styles.sectionHeaderBar, { backgroundColor: accent }]} />
      <Text style={styles.sectionHeaderText}>{title}</Text>
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
  // Audit annexes are grouped onto their own page(s) after the narrative.
  const hasAnnexes = Boolean(
    props.methodologyReadiness ||
      props.funderBreakdown ||
      props.fxTrail ||
      props.evidenceManifest.length > 0 ||
      props.lineItems ||
      props.standards.length > 0
  )
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

        {/* SROI figures — full-width hero band + three supporting KPIs */}
        {run && (
          <View>
            <Text style={[styles.eyebrowHeading, { color: accent }]}>Resultados SROI</Text>
            <View style={[styles.heroBand, { borderLeftColor: accent }]}>
              <View style={styles.heroBandLeft}>
                <Text style={[styles.heroLabel, { color: accent }]}>Ratio SROI</Text>
                <Text style={styles.heroValue}>{fmtRatio(run.sroiRatio)}</Text>
              </View>
              <View style={styles.heroCaptionWrap}>
                <Text style={styles.heroCaption}>{sroiCaption(run.sroiRatio, run.currency)}</Text>
              </View>
            </View>
            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Valor social neto</Text>
                <Text style={styles.kpiValue}>{fmtMoney(run.netSocialValue, run.currency)}</Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Valor social bruto</Text>
                <Text style={styles.kpiValue}>{fmtMoney(run.grossSocialValue, run.currency)}</Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Inversión total</Text>
                <Text style={styles.kpiValue}>{fmtMoney(run.totalInvestment, run.currency)}</Text>
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
            <SectionHeader title={section.title} accent={accent} />
            {section.content && section.content.trim().length > 0 ? (
              <Text style={styles.sectionBody}>{section.content}</Text>
            ) : (
              <Text style={styles.sectionEmpty}>Sin contenido.</Text>
            )}
          </View>
        ))}

        {/* Audit annexes — start on a fresh page, under one divider */}
        {hasAnnexes && (
          <View break style={styles.annexDivider}>
            <Text style={[styles.annexEyebrow, { color: accent }]}>Respaldo técnico</Text>
            <Text style={styles.annexTitle}>Anexos de auditoría</Text>
          </View>
        )}

        {/* Methodology review readiness (methodological/audit annex) */}
        {props.methodologyReadiness && (
          <View style={styles.section} wrap={false}>
            <SectionHeader title="Preparación metodológica por paso" accent={accent} />
            <Text style={styles.sectionNote}>
              Puntaje de preparación de la revisión metodológica de cada paso del pipeline (0–100).
            </Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '50%' }]}>Paso</Text>
              <Text style={[styles.th, { width: '25%', textAlign: 'right', paddingRight: 8 }]}>Preparación</Text>
              <Text style={[styles.th, { width: '25%' }]}>Estado</Text>
            </View>
            {props.methodologyReadiness.map((r, i) => (
              <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
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
            <SectionHeader title="Desglose por financiador (USD)" accent={accent} />
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '34%' }]}>Financiador</Text>
              <Text style={[styles.th, { width: '20%' }]}>Tipo</Text>
              <Text style={[styles.th, { width: '16%', textAlign: 'right' }]}>Inversión</Text>
              <Text style={[styles.th, { width: '18%', textAlign: 'right' }]}>Valor neto atrib.</Text>
              <Text style={[styles.th, { width: '12%', textAlign: 'right' }]}>SROI</Text>
            </View>
            {props.funderBreakdown.rows.map((r, i) => (
              <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                <Text style={[styles.td, { width: '34%' }]}>{r.funderName}</Text>
                <Text style={[styles.td, { width: '20%', color: '#64748b' }]}>{FUNDER_TYPE_ES[r.funderType] ?? r.funderType}</Text>
                <Text style={[styles.td, { width: '16%', textAlign: 'right' }]}>{fmtMoney(r.investmentUsd)}</Text>
                <Text style={[styles.td, { width: '18%', textAlign: 'right' }]}>{fmtMoney(r.attributedNsvUsd)}</Text>
                <Text style={[styles.td, { width: '12%', textAlign: 'right' }]}>{fmtRatio(r.sroiRatio)}</Text>
              </View>
            ))}
            {props.funderBreakdown.unattributedNsvUsd && (
              <Text style={[styles.sectionNote, { marginTop: 5, marginBottom: 0 }]}>
                Valor social neto no atribuido: {fmtMoney(props.funderBreakdown.unattributedNsvUsd)} USD
              </Text>
            )}
          </View>
        )}

        {/* FX conversion trail (audit annex) — only when present */}
        {props.fxTrail && (
          <View style={styles.section} wrap={false}>
            <SectionHeader title="Rastro de conversión a USD" accent={accent} />
            <Text style={styles.sectionNote}>
              Cada aporte se normalizó a USD al guardarse. Los aportes ya en USD no se convierten.
            </Text>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '28%', textAlign: 'right', paddingRight: 8 }]}>Monto original</Text>
              <Text style={[styles.th, { width: '22%' }]}>Moneda</Text>
              <Text style={[styles.th, { width: '28%', textAlign: 'right', paddingRight: 8 }]}>Monto USD</Text>
              <Text style={[styles.th, { width: '22%' }]}>Año</Text>
            </View>
            {props.fxTrail.rows.map((r, i) => (
              <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
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
            <SectionHeader title="Manifiesto de evidencia (huellas digitales SHA-256)" accent={accent} />
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.th, { width: '46%' }]}>Título</Text>
              <Text style={[styles.th, { width: '14%' }]}>Tipo</Text>
              <Text style={[styles.th, { width: '20%' }]}>Estado</Text>
              <Text style={[styles.th, { width: '20%' }]}>Hash</Text>
            </View>
            {props.evidenceManifest.map((e, i) => (
              <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                <Text style={[styles.td, { width: '46%' }]}>{e.title}</Text>
                <Text style={[styles.td, { width: '14%', color: '#64748b' }]}>{e.type}</Text>
                <Text style={[styles.td, { width: '20%' }]}>{EVIDENCE_STATUS_ES[e.status] ?? e.status}</Text>
                <Text style={[styles.tdMono, { width: '20%' }]}>{e.hashShort ? `${e.hashShort}…` : '—'}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Raw calculation line items (audit annex) — only when present */}
        {props.lineItems && (
          <View style={styles.section} wrap={false}>
            <SectionHeader title="Detalle de partidas del cálculo" accent={accent} />
            <Text style={styles.sectionNote}>
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
              <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                <Text style={[styles.tdMono, { width: '14%' }]}>{r.outcomeRef}</Text>
                <Text style={[styles.td, { width: '12%', textAlign: 'right', paddingRight: 6 }]}>{r.quantity}</Text>
                <Text style={[styles.td, { width: '14%', textAlign: 'right', paddingRight: 6 }]}>{fmtMoney(r.proxyValue)}</Text>
                <Text style={[styles.td, { width: '15%', textAlign: 'right', paddingRight: 6 }]}>{fmtMoney(r.grossValue)}</Text>
                <Text style={[styles.td, { width: '30%', color: '#64748b' }]}>{r.adjustments}</Text>
                <Text style={[styles.td, { width: '15%', textAlign: 'right' }]}>{fmtMoney(r.adjustedValue)}</Text>
              </View>
            ))}
            {props.lineItems.truncated && (
              <Text style={[styles.sectionNote, { marginTop: 5, marginBottom: 0 }]}>
                Mostrando {props.lineItems.rows.length} de {props.lineItems.total} line items.
              </Text>
            )}
          </View>
        )}

        {/* Reference standards (comparability crosswalks) — only when present */}
        {props.standards.length > 0 && (
          <View style={styles.section} wrap={false}>
            <SectionHeader title="Estándares de referencia" accent={accent} />
            <Text style={styles.sectionNote}>
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
            `Uellix · ${props.projectName} · Reporte SROI${run?.version ? ` v${run.version}` : ''} · Generado ${props.generatedAt} · Requiere revisión humana antes de su uso externo · Página ${pageNumber}/${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  )
}
