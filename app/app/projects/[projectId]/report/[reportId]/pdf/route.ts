// app/app/projects/[projectId]/report/[reportId]/pdf/route.ts
// Fase 6a PoC — server-side PDF generation for an SROI report.
// Runs on the Node runtime (react-pdf needs Node, not Edge). Reuses the same
// authorized data path as the print page; renders the same audit-ready content.

import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { getReportDraft, getCalculationRunDetail } from '@/lib/pipeline/sroi-results'
import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { ReportPdfDocument } from '@/lib/reports/pdf/ReportPdfDocument'

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

  const [project, runDetail] = await Promise.all([
    getProjectByIdForCurrentOrganization(projectId),
    getCalculationRunDetail(projectId, report.calculationRunId).catch(() => null),
  ])
  const run = runDetail?.run ?? null

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
    generatedAt,
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
