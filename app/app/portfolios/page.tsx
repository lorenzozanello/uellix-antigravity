import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { listPortfoliosForCurrentOrganization } from '@/lib/portfolios/service';
import Link from 'next/link';

export default async function PortfoliosPage() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>Unauthenticated. Please log in.</p>;

  const portfolios = await listPortfoliosForCurrentOrganization();

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Portafolios</h1>
        {canCreate && (
          <Link href="/app/portfolios/new" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400">
            Nuevo Portafolio
          </Link>
        )}
      </div>
      {portfolios.length === 0 ? (
        <p className="text-slate-400">No hay portafolios registrados.</p>
      ) : (
        <ul className="space-y-2">
          {portfolios.map((p) => (
            <li key={p.id}>
              <Link href={`/app/portfolios/${p.id}`} className="text-teal-300 underline">
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
