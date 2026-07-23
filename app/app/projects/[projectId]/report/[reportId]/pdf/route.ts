// app/app/projects/[projectId]/report/[reportId]/pdf/route.ts
// Fase 6a PoC — server-side PDF generation for an SROI report.
// Runs on the Node runtime (react-pdf needs Node, not Edge). Reuses the same
// authorized data path as the print page; renders the same audit-ready content.

import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { getReportDraft, getCalculationRunDetail } from '@/lib/pipeline/sroi-results'
import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { listOutcomeMappingsForProject, groupMappingsByCatalog } from '@/lib/taxonomies/service'
import { listEvidenceForProject } from '@/lib/pipeline/evidence'
import {
  extractFunderBreakdown,
  buildEvidenceManifest,
  extractFxTrail,
  extractLineItems,
  buildMethodologyReadiness,
} from '@/lib/reports/pdf/report-data'
import { getVariantAnnexes, REPORT_VARIANT_LABEL, isReportVariant } from '@/lib/reports/report-variants'
import { listMethodologyReviewsForProject } from '@/lib/pipeline/methodology-review'
import { ReportPdfDocument } from '@/lib/reports/pdf/ReportPdfDocument'
import { getApprovedOrganizationLogoUrl } from '@/lib/organizations/logo-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  under_review: 'En revisión',
  locked: 'Bloqueado',
  archived: 'Archivado',
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'reporte-sroi'
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; reportId: string }> }
) {
  const { projectId, reportId } = await params

  const ctx = await getCurrentOrganizationContext()
  if (!ctx) return new Response('No autenticado', { status: 401 })

  let report: Awaited<ReturnType<typeof getReportDraft>>
  try {
    report = await getReportDraft(projectId, reportId)
  } catch {
    return new Response('Reporte no encontrado', { status: 404 })
  }

  const [project, runDetail, mappings, evidence] = await Promise.all([
    getProjectByIdForCurrentOrganization(projectId),
    getCalculationRunDetail(projectId, report.calculationRunId).catch(() => null),
    listOutcomeMappingsForProject(projectId).catch(() => []),
    listEvidenceForProject(projectId).catch(() => []),
  ])
  const run = runDetail?.run ?? null

  // Variant governs which annexes render (in addition to the funder include flag).
  const variant = isReportVariant(report.reportVariant) ? report.reportVariant : 'audit'
  const annexes = getVariantAnnexes(variant)

  const funderBreakdown =
    annexes.funderBreakdown && report.includeFunderBreakdown
      ? extractFunderBreakdown(report.snapshotJson)
      : null
  const evidenceManifest = annexes.evidenceManifest
    ? buildEvidenceManifest(
        evidence.map((e) => ({
          title: e.title,
          type: e.type,
          status: e.status,
          contentHash: e.contentHash ?? null,
        }))
      )
    : []
  const fxTrail = annexes.fxTrail ? extractFxTrail(report.snapshotJson) : null
  const lineItems = annexes.lineItems ? extractLineItems(report.snapshotJson) : null
  const methodologyReadiness = annexes.methodologyReadiness
    ? buildMethodologyReadiness(await listMethodologyReviewsForProject(projectId).catch(() => []))
    : null

  // Dedupe codes within each catalog, then format one line per catalog.
  const seenByCatalog = new Map<string, Set<string>>()
  const dedupedMappings = mappings.filter((m) => {
    const seen = seenByCatalog.get(m.catalogCode) ?? new Set<string>()
    if (seen.has(m.code)) return false
    seen.add(m.code)
    seenByCatalog.set(m.catalogCode, seen)
    return true
  })
  const standards = annexes.standards
    ? groupMappingsByCatalog(dedupedMappings).map((g) => ({
        catalogName: g.catalogName,
        entries: g.items.map((i) => `${i.code} (${i.label})`).join(' · '),
      }))
    : []

  const generatedAt = new Date().toLocaleString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const element = createElement(ReportPdfDocument, {
    organizationName: ctx.organization.name,
    projectName: project?.name ?? '—',
    reportTitle: report.title,
    statusLabel: STATUS_LABEL[report.status] ?? report.status,
    variantLabel: REPORT_VARIANT_LABEL[variant],
    calculationRunId: report.calculationRunId,
    run: run
      ? {
          sroiRatio: run.sroiRatio,
          netSocialValue: run.netSocialValue,
          grossSocialValue: run.grossSocialValue,
          totalInvestment: run.totalInvestment,
          currency: run.currency,
          version: run.version,
        }
      : null,
    sections: report.sections.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.content,
    })),
    standards,
    funderBreakdown,
    evidenceManifest,
    fxTrail,
    lineItems,
    methodologyReadiness,
    generatedAt,
    whiteLabelEnabled: ctx.organization.whiteLabelEnabled,
    logoUrl: getApprovedOrganizationLogoUrl(ctx.organization.logoUrl),
    brandColor: ctx.organization.brandColor,
  })

  // renderToBuffer's type wants a ReactElement<DocumentProps>; our component
  // wraps <Document> so it's correct at runtime. Cast to the expected param type.
  const buffer = await renderToBuffer(element as unknown as Parameters<typeof renderToBuffer>[0])

  const filename = `${slugify(report.title)}.pdf`
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
