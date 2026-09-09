import { runWithOptionalOrganizationAccess } from '@/lib/auth/session';
import { canManagePortfolio } from '@/lib/auth/permissions';
import {
  getPortfolioByIdForCurrentOrganization,
  listPortfoliosForCurrentOrganization,
} from '@/lib/portfolios/service';
import { getPortfolioAnalytics } from '@/lib/portfolios/analytics';
import { listProjectsForPortfolio, listActiveProjectsForCurrentOrganization } from '@/lib/projects/service';
import { getPortfolioReadModel } from '@/lib/portfolios/read-model';
import { getPortfolioEvidenceHealth } from '@/lib/portfolios/evidence-health';
import { getPortfolioTransversalIntelligence } from '@/lib/portfolios/intelligence';
import {
  updatePortfolioAction,
  archivePortfolioAction,
  assignProjectAction,
  unassignProjectAction,
  moveProjectAction,
} from './actions';
import Link from 'next/link';
import { ArrowLeft, FolderKanban, TrendingUp, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { EmptyState } from '@/components/states/EmptyState';
import { ComparisonTable } from '@/components/portfolios/ComparisonTable';
import { EvidenceHealthPanel } from '@/components/portfolios/EvidenceHealthPanel';
import { TransversalIntelligencePanel } from '@/components/portfolios/TransversalIntelligencePanel';

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

const TEXTAREA_CLASS =
  'mt-1.5 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export default async function PortfolioDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ portfolioId: string }>;
  searchParams?: Promise<{ page?: string }>;
}) {
  const { portfolioId } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const requestedPage = Number.parseInt(resolvedSearchParams.page ?? '1', 10);
  const comparisonPageNumber = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const data = await runWithOptionalOrganizationAccess(async (ctx) => {
    if (!ctx) return { state: 'unauthenticated' as const };
    const portfolio = await getPortfolioByIdForCurrentOrganization(portfolioId);
    if (!portfolio) return { state: 'not-found' as const };
    const [projects, analytics, allPortfolios, activeProjects, readModel, evidenceHealth, transversalIntelligence] =
      await Promise.all([
        listProjectsForPortfolio(portfolioId),
        getPortfolioAnalytics(portfolioId),
        listPortfoliosForCurrentOrganization(),
        listActiveProjectsForCurrentOrganization(),
        getPortfolioReadModel(portfolioId, { page: comparisonPageNumber }),
        getPortfolioEvidenceHealth(portfolioId),
        getPortfolioTransversalIntelligence(portfolioId),
      ]);
    return {
      state: 'ok' as const,
      canManage: canManagePortfolio(ctx.membership.role),
      portfolio,
      projects,
      analytics,
      readModel,
      evidenceHealth,
      transversalIntelligence,
      otherPortfolios: allPortfolios.filter((p) => p.id !== portfolioId && p.status !== 'archived'),
      assignableProjects: activeProjects.filter((p) => p.portfolioId === null),
    };
  });

  if (data.state === 'unauthenticated') return <p>No autenticado. Por favor inicia sesión.</p>;
  if (data.state === 'not-found') return <p>Portafolio no encontrado o acceso denegado.</p>;

  const {
    portfolio,
    projects,
    analytics,
    canManage,
    otherPortfolios,
    assignableProjects,
    readModel,
    evidenceHealth,
    transversalIntelligence,
  } = data;
  const agg = analytics?.aggregate ?? null;
  const isArchived = portfolio.status === 'archived';

  const statusConfig = STATUS_CONFIG[portfolio.status] ?? { variant: 'neutral' as const, label: portfolio.status };

  const updateActionWithId = updatePortfolioAction.bind(null, portfolioId);
  const archiveActionWithId = archivePortfolioAction.bind(null, portfolioId);
  const assignActionWithId = assignProjectAction.bind(null, portfolioId);

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
              {/* FIBIU-17 (FIBC-021, W2-B5): legacy manual score, never the
                  canonical readiness (readiness_assessments), and never
                  presented without this label. FIBIU-27 (Wave 5) switches
                  the source; frozen for B5. */}
              <span className="text-xs text-muted-foreground">Score manual heredado (no autoritativo) promedio:</span>
              <Badge variant={readinessBadgeVariant(agg.averageLegacyManualReadinessScore)}>
                {agg.averageLegacyManualReadinessScore === null
                  ? 'Sin evaluar'
                  : `${Math.round(agg.averageLegacyManualReadinessScore)}%`}
              </Badge>
              {agg.averageLegacyManualReadinessScore !== null && (
                <span className="text-xs text-muted-foreground/70">
                  ({agg.legacyManualReadinessCoverage} de {agg.includedCount} con revisión)
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

      {readModel && (
        <ComparisonTable basePath={`/app/portfolios/${portfolioId}`} comparisonPage={readModel.comparisonPage} />
      )}

      {evidenceHealth && <EvidenceHealthPanel evidenceHealth={evidenceHealth} />}

      {transversalIntelligence && <TransversalIntelligencePanel intelligence={transversalIntelligence} />}

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

      {canManage && !isArchived && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Editar portafolio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <form action={updateActionWithId} className="space-y-4">
              <div>
                <Label htmlFor="name">Nombre</Label>
                <Input id="name" name="name" type="text" defaultValue={portfolio.name} required className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="description">Descripción</Label>
                <textarea
                  id="description"
                  name="description"
                  rows={3}
                  defaultValue={portfolio.description ?? ''}
                  className={TEXTAREA_CLASS}
                />
              </div>
              <Button type="submit">Guardar cambios</Button>
            </form>

            <form action={archiveActionWithId}>
              <Button type="submit" variant="outline">
                Archivar portafolio
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canManage && !isArchived && assignableProjects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Asignar proyecto</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={assignActionWithId} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <Label htmlFor="projectId">Proyecto sin portafolio</Label>
                <Select id="projectId" name="projectId" required className="mt-1.5" defaultValue="">
                  <option value="" disabled>
                    -- Selecciona un proyecto --
                  </option>
                  {assignableProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit">Asignar</Button>
            </form>
          </CardContent>
        </Card>
      )}

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
            {projects.map((project) => {
              const unassignActionForProject = unassignProjectAction.bind(null, portfolioId, project.id);
              const moveActionForProject = moveProjectAction.bind(null, portfolioId, project.id);
              return (
                <div key={project.id} className="space-y-2">
                  <ProjectCard
                    id={project.id}
                    name={project.name}
                    description={project.description}
                    status={project.status}
                    territory={project.territory}
                    country={project.country}
                    startDate={project.startDate}
                  />
                  {canManage && !isArchived && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/10 p-2">
                      <form action={unassignActionForProject}>
                        <Button type="submit" variant="outline" size="sm">
                          Quitar del portafolio
                        </Button>
                      </form>
                      {otherPortfolios.length > 0 && (
                        <form action={moveActionForProject} className="flex items-center gap-1.5">
                          <Select name="targetPortfolioId" required defaultValue="" className="w-40 text-xs">
                            <option value="" disabled>
                              Mover a...
                            </option>
                            {otherPortfolios.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </Select>
                          <Button type="submit" variant="outline" size="sm">
                            Mover
                          </Button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
