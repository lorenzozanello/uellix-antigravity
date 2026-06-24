import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { getPortfolioByIdForCurrentOrganization } from '@/lib/portfolios/service';
import Link from 'next/link';

export default async function PortfolioDetailPage({ params }: { params: { portfolioId: string } }) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>Unauthenticated. Please log in.</p>;

  const portfolio = await getPortfolioByIdForCurrentOrganization(params.portfolioId);
  if (!portfolio) return <p>Portfolio not found or access denied.</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">{portfolio.name}</h1>
      <p>{portfolio.description ?? 'Sin descripción'}</p>
      <ul className="list-disc pl-5">
        <li>Status: {portfolio.status}</li>
        <li>Created at: {new Date(portfolio.createdAt).toLocaleDateString()}</li>
      </ul>
      <Link href="/app/portfolios" className="text-teal-400 underline">← Volver a la lista</Link>
    </div>
  );
}
