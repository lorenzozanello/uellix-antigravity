import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { getPortfolioByIdForCurrentOrganization } from '@/lib/portfolios/service';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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

  const statusConfig = STATUS_CONFIG[portfolio.status] ?? { variant: 'neutral' as const, label: portfolio.status };

  return (
    <div className="space-y-6 max-w-2xl">
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
    </div>
  );
}
