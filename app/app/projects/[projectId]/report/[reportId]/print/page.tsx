import './report-print.css'
import { notFound } from 'next/navigation'
import { getReportDraft, getCalculationRunDetail } from '@/lib/pipeline/sroi-results'
import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { SECTION_GROUPS, SECTION_META } from '@/lib/reports/report-sections'
import { PrintButton } from './PrintButton'
import { ReportSectionRenderer } from '@/components/report/ReportSectionRenderer'
import { listOutcomeMappingsForProject, groupMappingsByCatalog } from '@/lib/taxonomies/service'
import { listEvidenceForProject } from '@/lib/pipeline/evidence'
import {
  buildEvidenceManifest,
  extractFxTrail,
  extractLineItems,
  extractFunderBreakdown,
  extractSensitivityBand,
  buildMethodologyReadiness,
} from '@/lib/reports/pdf/report-data'
import { listMethodologyReviewsForProject } from '@/lib/pipeline/methodology-review'
import { getVariantAnnexes, REPORT_VARIANT_LABEL, isReportVariant } from '@/lib/reports/report-variants'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  under_review: 'En revisión',
  locked: 'Bloqueado',
  archived: 'Archivado',
}

const FUNDER_TYPE_ES: Record<string, string> = {
  public: 'Público', private: 'Privado', foundation: 'Fundación',
  multilateral: 'Multilateral', individual: 'Individual', other: 'Otro',
}
const EVIDENCE_STATUS_ES: Record<string, string> = {
  draft: 'Borrador', under_review: 'En revisión', approved: 'Aprobado',
  rejected: 'Rechazado', archived: 'Archivado',
}
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

// es-CO money: '.' thousands, ',' decimals, currency BEFORE the amount.
function fmtMoney(value: string | null | undefined, currency?: string | null): string {
  if (!value) return '—'
  const n = parseFloat(value)
  if (isNaN(n)) return '—'
  const formatted = n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${currency} ${formatted}` : formatted
}
function fmtRatio(value: string | null | undefined): string {
  if (!value) return '—'
  const n = parseFloat(value)
  return isNaN(n) ? '—' : `${n.toFixed(2).replace('.', ',')} : 1`
}
function monthYear(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const date = new Date(d)
  if (isNaN(date.getTime())) return null
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}
function fmtPeriod(start: Date | string | null | undefined, end: Date | string | null | undefined): string {
  const s = monthYear(start)
  if (!s) return '—'
  return `${s} – ${monthYear(end) ?? 'actualidad'}`
}
function readinessColor(score: number | null): { bar: string; chip: 'rp-bad' | 'rp-warn' | 'rp-ok' } {
  if (score === null) return { bar: 'var(--rp-grey)', chip: 'rp-warn' }
  if (score < 34) return { bar: 'var(--rp-bad)', chip: 'rp-bad' }
  if (score < 67) return { bar: 'var(--rp-warn)', chip: 'rp-warn' }
  return { bar: 'var(--rp-ok)', chip: 'rp-ok' }
}
// Evidence confidence bands mirror the app's confidenceBadgeVariant.
function confidenceChip(score: number | null): 'rp-bad' | 'rp-warn' | 'rp-ok' {
  if (score === null || score < 40) return 'rp-bad'
  if (score < 70) return 'rp-warn'
  return 'rp-ok'
}
const SCENARIO_ES: Record<'conservative' | 'base' | 'optimistic', string> = {
  conservative: 'Conservador', base: 'Base', optimistic: 'Optimista',
}
const SCENARIO_ORDER = ['conservative', 'base', 'optimistic'] as const

export default async function ReportPrintPage({
  params,
}: {
  params: Promise<{ projectId: string; reportId: string }>
}) {
  const { projectId, reportId } = await params

  const ctx = await getCurrentOrganizationContext()
  if (!ctx) notFound()

  let report: Awaited<ReturnType<typeof getReportDraft>>
  try {
    report = await getReportDraft(projectId, reportId)
  } catch {
    notFound()
  }

  const [project, runDetail] = await Promise.all([
    getProjectByIdForCurrentOrganization(projectId),
    getCalculationRunDetail(projectId, report.calculationRunId).catch(() => null),
  ])
  const run = runDetail?.run ?? null

  const variant = isReportVariant(report.reportVariant) ? report.reportVariant : 'audit'
  const annexes = getVariantAnnexes(variant)

  // Comparability crosswalks — dedupe codes within each catalog.
  const mappings = await listOutcomeMappingsForProject(projectId).catch(() => [])
  const seenByCatalog = new Map<string, Set<string>>()
  const dedupedMappings = mappings.filter((m) => {
    const seen = seenByCatalog.get(m.catalogCode) ?? new Set<string>()
    if (seen.has(m.code)) return false
    seen.add(m.code)
    seenByCatalog.set(m.catalogCode, seen)
    return true
  })

  const funderBreakdown =
    annexes.funderBreakdown && report.includeFunderBreakdown
      ? extractFunderBreakdown(report.snapshotJson)
      : null
  const fxTrail = annexes.fxTrail ? extractFxTrail(report.snapshotJson) : null
  const lineItems = annexes.lineItems ? extractLineItems(report.snapshotJson) : null
  const methodologyReadiness = annexes.methodologyReadiness
    ? buildMethodologyReadiness(await listMethodologyReviewsForProject(projectId).catch(() => []))
    : null
  const mappingGroups = annexes.standards ? groupMappingsByCatalog(dedupedMappings) : []
  const evidenceManifest = annexes.evidenceManifest
    ? buildEvidenceManifest(
        (await listEvidenceForProject(projectId).catch(() => [])).map((e) => ({
          title: e.title,
          type: e.type,
          status: e.status,
          contentHash: e.contentHash ?? null,
          confidenceScore: e.confidenceScore ?? null,
        }))
      )
    : []
  // Sensitivity band is frozen in the run snapshot (null for older runs).
  const sensitivity = run ? extractSensitivityBand(report.snapshotJson) : null
  // Per-report toggle: show the evidence confidence score or not.
  const showConfidence = report.includeEvidenceConfidence !== false

  const snapshotJson = report.snapshotJson
  const currency = report.currency ?? 'USD'
  const sectionByType = new Map(report.sections.map((s) => [s.sectionType, s]))
  const generatedAt = new Date().toLocaleString('es-CO', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const isDraft = report.status === 'draft'
  const statusLabel = STATUS_LABEL[report.status] ?? report.status
  const period = fmtPeriod(project?.startDate, project?.endDate)
  const territory = [project?.territory, project?.country].filter(Boolean).join(' · ') || '—'
  const runIdShort = report.calculationRunId.slice(0, 8)
  const crumb = `${project?.name ?? '—'} · Reporte SROI${run ? ` v${run.version}` : ''}`
  const hasAnnexes = Boolean(
    methodologyReadiness || fxTrail || lineItems || funderBreakdown || evidenceManifest.length > 0 || mappingGroups.length > 0
  )
  const annexDividerTitle = variant === 'audit' ? 'Anexos de auditoría' : 'Fundamento metodológico'
  const annexDividerSub = variant === 'audit' ? 'Evidencia · Valoración · Trazabilidad' : 'Preparación · Supuestos · Referencias'

  return (
    <div className="rp-root">
      <div className="rp-screen">
        {/* Toolbar — screen only */}
        <div className="rp-toolbar">
          <a className="rp-back" href={`/app/projects/${projectId}/report/${reportId}`}>← Volver al editor</a>
          <span style={{ display: 'flex', gap: 8 }}>
            <a className="rp-back" href={`/app/projects/${projectId}/report/${reportId}/pdf`}>PDF clásico</a>
            <PrintButton />
          </span>
        </div>

        {/* ═══ COVER ═══ */}
        <section className="rp-sheet rp-cover">
          <div className="rp-cover-top">
            <div className="rp-logo-cover" role="img" aria-label="Uellix" />
            <div className="rp-cover-tag">Ledger Cívico<br />de Impacto Social</div>
          </div>
          <div className="rp-cover-hero">
            <p className="rp-cover-eyebrow">Reporte de Impacto · SROI · Variante <b>{REPORT_VARIANT_LABEL[variant]}</b></p>
            <h1 className="rp-cover-title">{report.title}</h1>
            <p className="rp-cover-org">Organización · <b>{ctx.organization.name}</b></p>
            <div className="rp-cover-meta">
              <div><div className="rp-k">Proyecto</div><div className="rp-v">{project?.name ?? '—'}</div></div>
              <div><div className="rp-k">Territorio</div><div className="rp-v">{territory}</div></div>
              <div><div className="rp-k">Periodo evaluado</div><div className="rp-v">{period}</div></div>
              <div><div className="rp-k">Área temática</div><div className="rp-v">{project?.thematicArea ?? '—'}</div></div>
            </div>
          </div>
          <div className="rp-cover-foot">
            <div>
              <span className={`rp-badge${isDraft ? '' : ' rp-neutral'}`}>
                <svg width="12" height="12" viewBox="0 0 40 40" aria-hidden="true"><polygon points="20,3 37,20 20,37 3,20" fill="#0b1420" /></svg>
                {isDraft ? 'Borrador técnico · No aprobado para uso externo' : `Estado: ${statusLabel}`}
              </span>
              <div className="rp-note">
                Reporte anclado a una corrida de cálculo inmutable. No constituye certificación de impacto ni auditoría
                independiente; requiere revisión metodológica humana antes de su circulación externa.
              </div>
            </div>
            <div className="rp-verify">
              Corrida&nbsp;<b>{runIdShort}{run ? ` · v${run.version}` : ''}</b><br />
              Generado&nbsp;<b>{generatedAt}</b><br />
              Verificación&nbsp;<b>uellix.com/verify</b>
            </div>
          </div>
        </section>

        {/* ═══ EXECUTIVE + SECTIONS ═══ */}
        <section className="rp-sheet">
          <div className="rp-pad">
            <div className="rp-head">
              <div className="rp-logo-head" role="img" aria-label="Uellix" />
              <div className="rp-crumb">{crumb} · Informe ejecutivo</div>
            </div>

            {isDraft && (
              <div className="rp-draftbar">
                <span className="rp-t">Borrador</span>
                <span className="rp-d">Análisis en construcción: la evidencia y los supuestos metodológicos pueden estar incompletos. Las cifras son preliminares.</span>
              </div>
            )}

            {run && (
              <>
                <p className="rp-eyebrow">Resultado principal</p>
                <div className="rp-hero">
                  <div>
                    <p className="rp-lab">Ratio SROI (estimado)</p>
                    <p className="rp-val">{fmtRatio(run.sroiRatio)}</p>
                  </div>
                  <p className="rp-cap">
                    Por cada <b>{run.currency ?? 'USD'} 1</b> invertido, se estima que el proyecto generó{' '}
                    <b>{run.currency ?? 'USD'} {run.sroiRatio ? parseFloat(run.sroiRatio).toFixed(2).replace('.', ',') : '—'}</b> de valor social.
                  </p>
                </div>
                <div className="rp-kpis">
                  <div className="rp-kpi"><div className="rp-k">Valor social neto</div><div className="rp-v">{fmtMoney(run.netSocialValue, run.currency)}</div></div>
                  <div className="rp-kpi"><div className="rp-k">Valor social bruto</div><div className="rp-v">{fmtMoney(run.grossSocialValue, run.currency)}</div></div>
                  <div className="rp-kpi"><div className="rp-k">Inversión total</div><div className="rp-v">{fmtMoney(run.totalInvestment, run.currency)}</div></div>
                  <div className="rp-kpi"><div className="rp-k">Tasa de descuento</div><div className="rp-v">{project?.discountRatePct ? `${parseFloat(project.discountRatePct).toFixed(2).replace('.', ',')} %` : '—'}</div></div>
                </div>

                {sensitivity && (
                  <div className="rp-block">
                    <div className="rp-shead"><span className="rp-bar" /><h2>Banda de sensibilidad</h2></div>
                    <p className="rp-snote">Ratio SROI con cada supuesto metodológico (peso muerto, atribución, desplazamiento, decrecimiento) desplazado ±{sensitivity.deltaPp} pp. Una banda comunica la incertidumbre mejor que un punto.</p>
                    <div className="rp-band">
                      {SCENARIO_ORDER.map((sc) => {
                        const row = sensitivity.rows.find((r) => r.scenario === sc)
                        if (!row) return null
                        return (
                          <div key={sc} className={`rp-scn${sc === 'base' ? ' rp-base' : ''}`}>
                            <div className="rp-sl">{SCENARIO_ES[sc]}</div>
                            <div className="rp-sv">{fmtRatio(row.sroiRatio)}</div>
                            <div className="rp-ss">Valor social neto {fmtMoney(row.netSocialValue, run.currency)}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Section groups — the authored narrative */}
            {SECTION_GROUPS.map((group) => {
              const groupSections = group.types
                .map((type) => sectionByType.get(type))
                .filter((s): s is NonNullable<typeof s> => Boolean(s))
              if (groupSections.length === 0) return null
              return (
                <div key={group.id} className="rp-group" style={{ breakInside: 'avoid' }}>
                  <div className="rp-gtitle">{group.label}</div>
                  {groupSections.map((section) => {
                    const meta = SECTION_META[section.sectionType] ?? { label: section.title, helper: '' }
                    return (
                      <div key={section.id} style={{ breakInside: 'avoid', marginBottom: 10 }}>
                        <div className="rp-subhead">{meta.label}</div>
                        <div className="rp-prose">
                          <ReportSectionRenderer
                            section={section}
                            snapshotJson={snapshotJson}
                            currency={currency}
                            isLocked={true}
                            sectionLabel={meta.label}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            <div className="rp-note-box">
              <div className="rp-t">Aviso metodológico</div>
              <div className="rp-b">
                Este reporte se ancla a una corrida de cálculo inmutable y constituye una base para revisión. No constituye
                certificación automática de impacto ni aprobación de auditoría independiente, y requiere revisión metodológica
                humana antes de su uso externo.
              </div>
            </div>

            <div className="rp-foot"><span>Uellix · {crumb}</span><span>Requiere revisión humana antes de su uso externo</span></div>
          </div>
        </section>

        {/* ═══ ANNEXES (variant-gated) ═══ */}
        {hasAnnexes && (
          <section className="rp-sheet">
            <div className="rp-pad">
              <div className="rp-head">
                <div className="rp-logo-head" role="img" aria-label="Uellix" />
                <div className="rp-crumb">{crumb} · Respaldo técnico</div>
              </div>

              <div className="rp-divider">
                <div className="rp-icon-rev" aria-hidden="true" />
                <div><div className="rp-n">{annexDividerSub}</div><div className="rp-tt">{annexDividerTitle}</div></div>
              </div>

              {methodologyReadiness && (
                <div className="rp-block">
                  <div className="rp-shead"><span className="rp-bar" /><h2>Preparación metodológica por paso</h2></div>
                  <p className="rp-snote">Puntaje de preparación de la revisión metodológica de cada paso del flujo (0–100).</p>
                  <div className="rp-ready">
                    {methodologyReadiness.map((r, i) => {
                      const c = readinessColor(r.readinessScore)
                      return (
                        <div key={i} className="rp-rrow">
                          <div className="rp-rl">{r.stepLabel}</div>
                          <div className="rp-rbar"><i style={{ width: `${r.readinessScore ?? 0}%`, background: c.bar }} /></div>
                          <div className="rp-rp">{r.readinessScore === null ? 'Sin evaluar' : `${r.readinessScore}%`} <span className={`rp-chip ${c.chip}`}>{r.statusLabel}</span></div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {fxTrail && (
                <div className="rp-block">
                  <div className="rp-shead"><span className="rp-bar" /><h2>Rastro de conversión a USD</h2></div>
                  <p className="rp-snote">Cada aporte se normalizó a USD al guardarse. Los aportes ya en USD no se convierten.</p>
                  <table>
                    <thead><tr><th className="rp-num">Monto original</th><th>Moneda</th><th className="rp-num">Monto USD</th><th className="rp-num">Año</th></tr></thead>
                    <tbody>
                      {fxTrail.rows.map((r, i) => (
                        <tr key={i}>
                          <td className="rp-num">{fmtMoney(r.amount)}</td>
                          <td>{r.currency}{r.converted ? ' (conv.)' : ''}</td>
                          <td className="rp-num">{fmtMoney(r.amountUsd)}</td>
                          <td className="rp-num">{r.year ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {funderBreakdown && (
                <div className="rp-block">
                  <div className="rp-shead"><span className="rp-bar" /><h2>Desglose por financiador</h2></div>
                  <table>
                    <thead><tr><th>Financiador</th><th>Tipo</th><th className="rp-num">Inversión</th><th className="rp-num">Valor neto atrib.</th><th className="rp-num">SROI</th></tr></thead>
                    <tbody>
                      {funderBreakdown.rows.map((r, i) => (
                        <tr key={i}>
                          <td className="rp-oc-name">{r.funderName}</td>
                          <td>{FUNDER_TYPE_ES[r.funderType] ?? r.funderType}</td>
                          <td className="rp-num">{fmtMoney(r.investmentUsd, 'USD')}</td>
                          <td className="rp-num">{fmtMoney(r.attributedNsvUsd, 'USD')}</td>
                          <td className="rp-num">{fmtRatio(r.sroiRatio)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {funderBreakdown.unattributedNsvUsd && (
                    <p className="rp-snote" style={{ marginTop: 6, marginBottom: 0 }}>
                      Valor social neto no atribuido: {fmtMoney(funderBreakdown.unattributedNsvUsd, 'USD')}
                    </p>
                  )}
                </div>
              )}

              {lineItems && (
                <div className="rp-block">
                  <div className="rp-shead"><span className="rp-bar" /><h2>Detalle de partidas del cálculo</h2></div>
                  <p className="rp-snote">Contribuciones crudas de la corrida inmutable. Referencias por ID de resultado del snapshot. Valores en USD.</p>
                  <table>
                    <thead><tr><th>Resultado</th><th className="rp-num">Cantidad</th><th className="rp-num">Valor proxy</th><th className="rp-num">Bruto</th><th>Ajustes</th><th className="rp-num">Ajustado</th></tr></thead>
                    <tbody>
                      {lineItems.rows.map((r, i) => (
                        <tr key={i}>
                          <td><span className="rp-oc-id">{r.outcomeRef}</span></td>
                          <td className="rp-num">{r.quantity}</td>
                          <td className="rp-num">{fmtMoney(r.proxyValue)}</td>
                          <td className="rp-num">{fmtMoney(r.grossValue)}</td>
                          <td className="rp-mono">{r.adjustments}</td>
                          <td className="rp-num">{fmtMoney(r.adjustedValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {lineItems.truncated && (
                    <p className="rp-snote" style={{ marginTop: 6, marginBottom: 0 }}>Mostrando {lineItems.rows.length} de {lineItems.total} partidas.</p>
                  )}
                </div>
              )}

              {evidenceManifest.length > 0 && (
                <div className="rp-block">
                  <div className="rp-shead"><span className="rp-bar" /><h2>Manifiesto de evidencia · huellas digitales SHA-256</h2></div>
                  <table>
                    <thead><tr><th>Evidencia</th><th>Tipo</th><th>Estado</th>{showConfidence && <th className="rp-num">Confianza</th>}<th>Huella</th></tr></thead>
                    <tbody>
                      {evidenceManifest.map((e, i) => (
                        <tr key={i}>
                          <td>{e.title}</td>
                          <td>{e.type}</td>
                          <td>{EVIDENCE_STATUS_ES[e.status] ?? e.status}</td>
                          {showConfidence && <td className="rp-num">{e.confidenceScore === null ? '—' : <span className={`rp-chip ${confidenceChip(e.confidenceScore)}`}>{e.confidenceScore}</span>}</td>}
                          <td className="rp-mono">{e.hashShort ? `${e.hashShort}…` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {showConfidence && (
                    <p className="rp-snote" style={{ marginTop: 6, marginBottom: 0 }}>
                      Confianza = puntaje calculado (0–100) por tipo, estado de revisión, vínculo a resultado y verificación de integridad.
                    </p>
                  )}
                </div>
              )}

              {mappingGroups.length > 0 && (
                <div className="rp-block">
                  <div className="rp-shead"><span className="rp-bar" /><h2>Estándares de referencia</h2></div>
                  <p className="rp-snote">Los resultados se mapean a los siguientes marcos como referencia de comparabilidad. No constituye certificación ni equivalencia oficial.</p>
                  <div className="rp-std">
                    {mappingGroups.map((group) => (
                      <div key={group.catalogCode} className="rp-g">
                        <div className="rp-cat">{group.catalogName}</div>
                        <div className="rp-items">{group.items.map((i) => `${i.code} (${i.label})`).join(' · ')}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rp-foot"><span>Uellix · {crumb} · Respaldo técnico</span><span>Requiere revisión humana antes de su uso externo</span></div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
