import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { getPortfolioByIdForCurrentOrganization } from '@/lib/portfolios/service';
import { getPortfolioAnalytics } from '@/lib/portfolios/analytics';
import { listProjectsForPortfolio } from '@/lib/projects/service';
import Link from 'next/link';
import { ArrowLeft, FolderKanban, TrendingUp, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { EmptyState } from '@/components/states/EmptyState';

const STATUS_CONFIG: Record<string, { variant: 'success' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Activo' },
  archived: { variant: 'neutral', label: 'Archivado' },
};

const usdFormatter = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function readinessBadgeVariant(score: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (score === null) return 'neutral';
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

const EXCLUSION_REASON_LABEL: Record<string, string> = {
  no_run: 'sin cálculo SROI',
  non_usd_currency: 'cálculo en moneda distinta a USD (no comparable)',
};

export default async function PortfolioDetailPage({
  params,
}: {
  params: Promise<{ portfolioId: string }>;
}) {
  const { portfolioId } = await params;
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>No autenticado. Por favor inicia sesión.</p>;

  const portfolio = await getPortfolioByIdForCurrentOrganization(portfolioId);
  if (!portfolio) return <p>Portafolio no encontrado o acceso denegado.</p>;

  const projects = await listProjectsForPortfolio(portfolioId);
  const analytics = await getPortfolioAnalytics(portfolioId);
  const agg = analytics?.aggregate ?? null;

  const statusConfig = STATUS_CONFIG[portfolio.status] ?? { variant: 'neutral' as const, label: portfolio.status };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <Link
          href="/app/portfolios"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Volver a portafolios
        </Link>
        <div className="mt-3 flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{portfolio.name}</h1>
          <Badge variant={statusConfig.variant} className="shrink-0">
            {statusConfig.label}
          </Badge>
        </div>
        {portfolio.description && (
          <p className="mt-1 text-sm text-muted-foreground">{portfolio.description}</p>
        )}
      </div>

      {agg && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
              <CardTitle className="text-base">Análisis de portafolio</CardTitle>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              SROI agregado de {agg.includedCount} de {agg.projectCount} proyecto
              {agg.projectCount === 1 ? '' : 's'} con cálculo en USD. El ratio del portafolio se
              calcula como valor social neto total ÷ inversión total, no como promedio de ratios.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <dt className="text-xs font-medium text-muted-foreground">SROI del portafolio</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                  {agg.portfolioSroiRatio === null
                    ? '—'
                    : `${agg.portfolioSroiRatio.toFixed(2)}×`}
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <dt className="text-xs font-medium text-muted-foreground">Valor social neto (USD)</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                  {usdFormatter.format(agg.totalNetSocialValueUsd)}
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <dt className="text-xs font-medium text-muted-foreground">Inversión total (USD)</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                  {usdFormatter.format(agg.totalInvestmentUsd)}
                </dd>
              </div>
            </dl>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Preparación metodológica promedio:</span>
              <Badge variant={readinessBadgeVariant(agg.averageReadinessScore)}>
                {agg.averageReadinessScore === null
                  ? 'Sin evaluar'
                  : `${Math.round(agg.averageReadinessScore)}%`}
              </Badge>
              {agg.averageReadinessScore !== null && (
                <span className="text-xs text-muted-foreground/70">
                  ({agg.readinessCoverage} de {agg.includedCount} con revisión)
                </span>
              )}
            </div>

            {agg.excluded.length > 0 && (
              <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-950/30">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-yellow-700 dark:text-yellow-500" aria-hidden="true" />
                  <p className="text-xs font-medium text-yellow-900 dark:text-yellow-200">
                    {agg.excluded.length} proyecto{agg.excluded.length === 1 ? '' : 's'} excluido
                    {agg.excluded.length === 1 ? '' : 's'} del agregado
                  </p>
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {agg.excluded.map((ex) => (
                    <li key={ex.projectId} className="text-xs text-yellow-800 dark:text-yellow-300">
                      {ex.projectName} — {EXCLUSION_REASON_LABEL[ex.reason] ?? ex.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detalles</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Creado</dt>
              <dd className="mt-1 text-sm text-foreground">
                {new Date(portfolio.createdAt).toLocaleDateString('es-MX')}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold tracking-tight text-foreground mb-3">
          Proyectos SROI ({projects.length})
        </h2>
        {projects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban className="h-6 w-6 text-neutral-500" />}
            title="Sin proyectos en este portafolio"
            description="Los proyectos SROI se asocian a un portafolio al crearlos."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                id={project.id}
                name={project.name}
                description={project.description}
                status={project.status}
                territory={project.territory}
                country={project.country}
                startDate={project.startDate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
