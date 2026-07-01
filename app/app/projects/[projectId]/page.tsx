import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Calendar, MapPin, FolderKanban } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type ProjectStatus = 'draft' | 'active' | 'completed' | 'archived';

const STATUS_CONFIG: Record<ProjectStatus, { variant: 'neutral' | 'accent' | 'success'; label: string }> = {
  draft: { variant: 'neutral', label: 'Borrador' },
  active: { variant: 'accent', label: 'Activo' },
  completed: { variant: 'success', label: 'Completado' },
  archived: { variant: 'neutral', label: 'Archivado' },
};

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>No autenticado. Por favor inicia sesión.</p>;

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) return <p>Proyecto no encontrado o acceso denegado.</p>;

  const statusConfig = STATUS_CONFIG[project.status as ProjectStatus] ?? {
    variant: 'neutral' as const,
    label: project.status,
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/app/projects"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Volver a proyectos
        </Link>
        <div className="mt-3 flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{project.name}</h1>
          <Badge variant={statusConfig.variant} className="shrink-0">
            {statusConfig.label}
          </Badge>
        </div>
        {project.description && (
          <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detalles del proyecto</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                Territorio
              </dt>
              <dd className="mt-1 text-sm text-foreground">{project.territory ?? 'No especificado'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">País</dt>
              <dd className="mt-1 text-sm text-foreground">{project.country ?? 'No especificado'}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                Fecha de inicio
              </dt>
              <dd className="mt-1 text-sm text-foreground">
                {project.startDate ? new Date(project.startDate).toLocaleDateString('es-MX') : 'No especificada'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Fecha de fin</dt>
              <dd className="mt-1 text-sm text-foreground">
                {project.endDate ? new Date(project.endDate).toLocaleDateString('es-MX') : 'No especificada'}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FolderKanban className="h-3.5 w-3.5" aria-hidden="true" />
                Portafolio
              </dt>
              <dd className="mt-1 text-sm">
                {project.portfolioId ? (
                  <Link
                    href={`/app/portfolios/${project.portfolioId}`}
                    className="font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    Ver portafolio
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Sin asignar</span>
                )}
              </dd>
            </div>
            {project.targetPopulationDescription && (
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-muted-foreground">Población objetivo</dt>
                <dd className="mt-1 text-sm text-foreground">{project.targetPopulationDescription}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      <Link
        href={`/app/projects/${project.id}/pipeline`}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
      >
        Abrir pipeline SROI
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
