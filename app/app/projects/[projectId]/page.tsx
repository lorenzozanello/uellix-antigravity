import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import Link from 'next/link';

export default async function ProjectDetailPage({ params }: { params: { projectId: string } }) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>Unauthenticated. Please log in.</p>;

  const project = await getProjectByIdForCurrentOrganization(params.projectId);
  if (!project) return <p>Project not found or access denied.</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">{project.name}</h1>
      <p>{project.description ?? 'Sin descripción'}</p>
      <ul className="list-disc pl-5">
        <li>Status: {project.status}</li>
        <li>Territorio: {project.territory ?? 'N/A'}</li>
        <li>País: {project.country ?? 'N/A'}</li>
        <li>Fecha de inicio: {project.startDate ? new Date(project.startDate).toLocaleDateString() : 'N/A'}</li>
        <li>Fecha de fin: {project.endDate ? new Date(project.endDate).toLocaleDateString() : 'N/A'}</li>
        <li>Portfolio: {project.portfolioId ? (
          <Link href={`/app/portfolios/${project.portfolioId}`} className="text-teal-300 underline">Ver Portafolio</Link>
        ) : 'Sin asignar'}</li>
      </ul>
      <Link href="/app/projects" className="text-teal-400 underline">← Volver a la lista</Link>
    </div>
  );
}
