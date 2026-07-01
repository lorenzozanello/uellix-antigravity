import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { listPortfoliosForCurrentOrganization } from '@/lib/portfolios/service';
import Link from 'next/link';
import { Plus, Layers, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/states/EmptyState';

const STATUS_CONFIG: Record<string, { variant: 'success' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Activo' },
  archived: { variant: 'neutral', label: 'Archivado' },
};

export default async function PortfoliosPage() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>No autenticado. Por favor inicia sesión.</p>;

  const portfolios = await listPortfoliosForCurrentOrganization();

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Portafolios</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {portfolios.length} portafolio{portfolios.length !== 1 ? 's' : ''} en {ctx.organization.name}
          </p>
        </div>
        {canCreate && (
          <Link
            href="/app/portfolios/new"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nuevo portafolio
          </Link>
        )}
      </div>

      {portfolios.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon={<Layers className="h-6 w-6 text-neutral-500" />}
            title="Aún no hay portafolios"
            description="Agrupa tus proyectos SROI en portafolios para organizar el trabajo de tu equipo."
          />
          {canCreate && (
            <div className="flex justify-center">
              <Link
                href="/app/portfolios/new"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Crear primer portafolio
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {portfolios.map((p) => {
            const statusConfig = STATUS_CONFIG[p.status] ?? { variant: 'neutral' as const, label: p.status };
            return (
              <Card key={p.id} className="flex flex-col hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base leading-snug line-clamp-2">{p.name}</CardTitle>
                    <Badge variant={statusConfig.variant} className="shrink-0">
                      {statusConfig.label}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-1.5 pb-3">
                  {p.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">{p.description}</p>
                  )}
                  <Link
                    href={`/app/portfolios/${p.id}`}
                    className="mt-3 flex items-center gap-1 text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    Ver detalles
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
