import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { getPortfolioByIdForCurrentOrganization } from '@/lib/portfolios/service';
import { listProjectsForPortfolio } from '@/lib/projects/service';
import Link from 'next/link';
import { ArrowLeft, FolderKanban } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { EmptyState } from '@/components/states/EmptyState';

const STATUS_CONFIG: Record<string, { variant: 'success' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Activo' },
  archived: { variant: 'neutral', label: 'Archivado' },
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
