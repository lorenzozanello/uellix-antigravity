// app/app/projects/[projectId]/pipeline/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service';

export default async function PipelineHome({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>Unauthenticated. Please log in.</p>;
  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) return <p>Project not found or access denied.</p>;

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-2">{project.name} – SROI Pipeline</h1>
      <Stepper />
      <p className="mt-4">Seleccione el paso del pipeline para comenzar.</p>
    </div>
  );
}
