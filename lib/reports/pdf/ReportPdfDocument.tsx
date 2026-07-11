// lib/reports/pdf/ReportPdfDocument.tsx
// Fase 6a PoC — audit-ready SROI report as a real PDF via @react-pdf/renderer.
// Server-only: rendered by react-pdf's renderer inside the route handler (Node
// runtime), never bundled to the client. Mirrors the print page content and
// carries the mandatory methodological disclaimers verbatim.

import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

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
  calculationRunId: string
  run: ReportPdfRun | null
  sections: ReportPdfSection[]
  standards: ReportPdfStandard[]
  generatedAt: string
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
  figureLabel: { fontSize: 7, color: '#64748b' },
  figureValue: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 2, color: '#0f172a' },
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

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.figureBox}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={styles.figureValue}>{value}</Text>
    </View>
  )
}

export function ReportPdfDocument(props: ReportPdfProps) {
  const { run } = props
  return (
    <Document title={props.reportTitle} author="Uellix">
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRule}>
          <Text style={styles.eyebrow}>Reporte de Impacto SROI</Text>
          <Text style={styles.title}>{props.reportTitle}</Text>
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

        {/* SROI figures */}
        {run && (
          <View>
            <Text style={styles.sectionHeading}>Resultados SROI</Text>
            <View style={styles.figuresRow}>
              <Figure label="Ratio SROI" value={fmtRatio(run.sroiRatio)} />
              <Figure label="Valor social neto" value={fmtMoney(run.netSocialValue, run.currency)} />
              <Figure label="Valor social bruto" value={fmtMoney(run.grossSocialValue, run.currency)} />
              <Figure label="Inversión total" value={fmtMoney(run.totalInvestment, run.currency)} />
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
