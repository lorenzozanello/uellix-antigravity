import { createElement } from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { getPublicVerifiedReport } from '@/lib/reports/public-verify';
import {
  extractFunderBreakdown,
  buildEvidenceManifest,
  extractFxTrail,
  extractLineItems,
  buildMethodologyReadiness,
} from '@/lib/reports/pdf/report-data';
import { getVariantAnnexes, REPORT_VARIANT_LABEL, isReportVariant } from '@/lib/reports/report-variants';
import { groupMappingsByCatalog } from '@/lib/taxonomies/service';
import { ReportPdfDocument } from '@/lib/reports/pdf/ReportPdfDocument';
import { getApprovedOrganizationLogoUrl } from '@/lib/organizations/logo-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  under_review: 'En revisión',
  locked: 'Bloqueado',
  archived: 'Archivado',
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'reporte-sroi';
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;

  const data = await getPublicVerifiedReport(hash);

  if (!data) {
    return new Response('Reporte no encontrado o no autorizado', { status: 404 });
  }

  const { report, project, organization, run, sections, evidence, methodologyReviews, mappings } = data;

  const variant = isReportVariant(report.reportVariant) ? report.reportVariant : 'audit';
  const annexes = getVariantAnnexes(variant);

  const funderBreakdown =
    annexes.funderBreakdown && report.includeFunderBreakdown
      ? extractFunderBreakdown(run.snapshotJson)
      : null;

  const evidenceManifest = annexes.evidenceManifest
    ? buildEvidenceManifest(
        evidence.map((e) => ({
          title: e.title,
          type: e.type,
          status: e.status,
          contentHash: e.contentHash ?? null,
        }))
      )
    : [];

  const fxTrail = annexes.fxTrail ? extractFxTrail(run.snapshotJson) : null;
  const lineItems = annexes.lineItems ? extractLineItems(run.snapshotJson) : null;
  const methodologyReadiness = annexes.methodologyReadiness
    ? buildMethodologyReadiness(methodologyReviews)
    : null;

  const seenByCatalog = new Map<string, Set<string>>();
  const dedupedMappings = mappings.filter((m) => {
    const seen = seenByCatalog.get(m.catalogCode) ?? new Set<string>();
    if (seen.has(m.code)) return false;
    seen.add(m.code);
    seenByCatalog.set(m.catalogCode, seen);
    return true;
  });

  const standards = annexes.standards
    ? groupMappingsByCatalog(dedupedMappings).map((g) => ({
        catalogName: g.catalogName,
        entries: g.items.map((i) => `${i.code} (${i.label})`).join(' · '),
      }))
    : [];

  const generatedAt = new Date().toLocaleString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const element = createElement(ReportPdfDocument, {
    organizationName: organization.name,
    projectName: project.name ?? '—',
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
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.content ?? '',
    })),
    standards,
    funderBreakdown,
    evidenceManifest,
    fxTrail,
    lineItems,
    methodologyReadiness,
    generatedAt,
    // White Label info
    whiteLabelEnabled: organization.whiteLabelEnabled,
    logoUrl: getApprovedOrganizationLogoUrl(organization.logoUrl),
    brandColor: organization.brandColor,
  });

  const buffer = await renderToBuffer(element as unknown as Parameters<typeof renderToBuffer>[0]);

  const filename = `${slugify(report.title)}.pdf`;
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
