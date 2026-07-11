import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, FileDown } from 'lucide-react'
import { getReportDraft, getCalculationRunDetail } from '@/lib/pipeline/sroi-results'
import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { SECTION_GROUPS, SECTION_META } from '@/lib/reports/report-sections'
import { PrintButton } from './PrintButton'
import { ReportSectionRenderer } from '@/components/report/ReportSectionRenderer'
import { listOutcomeMappingsForProject, groupMappingsByCatalog } from '@/lib/taxonomies/service'
import { listEvidenceForProject } from '@/lib/pipeline/evidence'
import { buildEvidenceManifest } from '@/lib/reports/pdf/report-data'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  under_review: 'En revisión',
  locked: 'Bloqueado',
  archived: 'Archivado',
}

function fmt(value: string | null | undefined, currency?: string | null): string {
  if (!value) return '—'
  const n = parseFloat(value)
  if (isNaN(n)) return '—'
  const formatted = n.toLocaleString('es-MX', { maximumFractionDigits: 2 })
  return currency ? `${formatted} ${currency}` : formatted
}

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
  // Comparability crosswalks: dedupe codes within each catalog. Only rendered
  // when mappings exist — never invented.
  const mappings = await listOutcomeMappingsForProject(projectId).catch(() => [])
  const seenByCatalog = new Map<string, Set<string>>()
  const dedupedMappings = mappings.filter((m) => {
    const seen = seenByCatalog.get(m.catalogCode) ?? new Set<string>()
    if (seen.has(m.code)) return false
    seen.add(m.code)
    seenByCatalog.set(m.catalogCode, seen)
    return true
  })
  const mappingGroups = groupMappingsByCatalog(dedupedMappings)
  const evidenceManifest = buildEvidenceManifest(
    (await listEvidenceForProject(projectId).catch(() => [])).map((e) => ({
      title: e.title,
      type: e.type,
      status: e.status,
      contentHash: e.contentHash ?? null,
    }))
  )
  const snapshotJson = report.snapshotJson
  const currency = report.currency ?? 'USD'
  const sectionByType = new Map(report.sections.map((s) => [s.sectionType, s]))
  const generatedAt = new Date().toLocaleString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="mx-auto max-w-3xl bg-white text-slate-900 print:max-w-none">
      {/* Toolbar — excluded from print */}
      <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
        <Link
          href={`/app/projects/${projectId}/report/${reportId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Volver al editor
        </Link>
        <div className="flex items-center gap-2">
          <a
            href={`/app/projects/${projectId}/report/${reportId}/pdf`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
            Descargar PDF
          </a>
          <PrintButton />
        </div>
      </div>

      {/* Document */}
      <article className="space-y-8 leading-relaxed">
        {/* Title block */}
        <header className="border-b border-slate-300 pb-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Reporte de Impacto SROI
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900">{report.title}</h1>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">Organización</dt>
              <dd className="font-medium">{ctx.organization.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Proyecto</dt>
              <dd className="font-medium">{project?.name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Estado</dt>
              <dd className="font-medium">{STATUS_LABEL[report.status] ?? report.status}</dd>
            </div>
            {(project?.territory || project?.country) && (
              <div>
                <dt className="text-xs text-slate-500">Territorio</dt>
                <dd className="font-medium">
                  {[project?.territory, project?.country].filter(Boolean).join(' · ')}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-slate-500">Corrida de cálculo</dt>
              <dd className="font-medium font-mono text-xs">
                {report.calculationRunId.slice(0, 8)}
                {run ? ` · v${run.version}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Generado</dt>
              <dd className="font-medium">{generatedAt}</dd>
            </div>
          </dl>
        </header>

        {/* SROI headline figures */}
        {run && (
          <section aria-label="Resultados SROI">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Resultados SROI
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs text-slate-500">Ratio SROI</p>
                <p className="mt-0.5 text-xl font-bold text-slate-900 tabular-nums">
                  {run.sroiRatio ? `${parseFloat(run.sroiRatio).toFixed(2)}:1` : '—'}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs text-slate-500">Valor social neto</p>
                <p className="mt-0.5 text-base font-semibold text-slate-900 tabular-nums">
                  {fmt(run.netSocialValue, run.currency)}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs text-slate-500">Valor social bruto</p>
                <p className="mt-0.5 text-base font-semibold text-slate-900 tabular-nums">
                  {fmt(run.grossSocialValue, run.currency)}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs text-slate-500">Inversión total</p>
                <p className="mt-0.5 text-base font-semibold text-slate-900 tabular-nums">
                  {fmt(run.totalInvestment, run.currency)}
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Mandatory methodological disclaimer */}
        <section
          role="note"
          className="rounded-md border border-slate-300 bg-slate-50 p-4 text-sm text-slate-700 print:bg-white"
        >
          <p className="font-medium text-slate-900">Aviso metodológico</p>
          <p className="mt-1">
            Este reporte se ancla a una corrida de cálculo inmutable y constituye una base lista
            para auditoría. No constituye certificación automática de impacto ni aprobación de
            auditoría independiente. Requiere revisión metodológica humana antes de su uso externo.
          </p>
        </section>

        {/* Section groups */}
        {SECTION_GROUPS.map((group) => {
          const groupSections = group.types
            .map((type) => sectionByType.get(type))
            .filter((s): s is NonNullable<typeof s> => Boolean(s))
          if (groupSections.length === 0) return null

          return (
            <section key={group.id} className="break-inside-avoid">
              <h2 className="mb-3 border-b border-slate-200 pb-1 text-lg font-semibold text-slate-900">
                {group.label}
              </h2>
              <div className="space-y-5">
                {groupSections.map((section) => {
                  const meta = SECTION_META[section.sectionType] ?? {
                    label: section.title,
                    helper: '',
                  }
                  return (
                    <div key={section.id} className="break-inside-avoid">
                      <h3 className="text-sm font-semibold text-slate-900">{meta.label}</h3>
                      <div className="mt-1 text-sm text-slate-800">
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
            </section>
          )
        })}

        {/* Evidence hash manifest (audit annex) — only when evidence exists */}
        {evidenceManifest.length > 0 && (
          <section className="break-inside-avoid">
            <h2 className="mb-3 border-b border-slate-200 pb-1 text-lg font-semibold text-slate-900">
              Manifiesto de evidencia (hashes SHA-256)
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">Título</th>
                  <th className="py-1 pr-2 font-medium">Tipo</th>
                  <th className="py-1 pr-2 font-medium">Estado</th>
                  <th className="py-1 font-medium">Hash</th>
                </tr>
              </thead>
              <tbody>
                {evidenceManifest.map((e, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-1 pr-2 text-slate-800">{e.title}</td>
                    <td className="py-1 pr-2 text-slate-500">{e.type}</td>
                    <td className="py-1 pr-2 text-slate-700">{e.status}</td>
                    <td className="py-1 font-mono text-xs text-slate-600">
                      {e.hashShort ? `${e.hashShort}…` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Reference standards (comparability crosswalks) — only when they exist */}
        {mappingGroups.length > 0 && (
          <section className="break-inside-avoid">
            <h2 className="mb-1 border-b border-slate-200 pb-1 text-lg font-semibold text-slate-900">
              Estándares de referencia
            </h2>
            <p className="mb-3 text-xs text-slate-500">
              Los resultados de este proyecto se mapean a los siguientes marcos como referencia de
              comparabilidad. Esto no constituye certificación ni equivalencia oficial con dichos
              estándares.
            </p>
            <div className="space-y-2">
              {mappingGroups.map((group) => (
                <div key={group.catalogCode}>
                  <p className="text-sm font-semibold text-slate-900">{group.catalogName}</p>
                  <p className="text-sm text-slate-700">
                    {group.items.map((i) => `${i.code} (${i.label})`).join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Footer */}
        <footer className="border-t border-slate-300 pt-4 text-xs text-slate-500">
          <p>
            Uellix · Reporte SROI generado el {generatedAt}. Documento lista para auditoría —
            requiere revisión humana antes de su uso externo.
          </p>
        </footer>
      </article>
    </div>
  )
}
