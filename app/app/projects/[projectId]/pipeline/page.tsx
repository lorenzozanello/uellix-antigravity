// app/app/projects/[projectId]/pipeline/page.tsx
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Stepper from '@/components/sroi/Stepper';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { getProjectByIdForCurrentOrganization } from '@/lib/projects/service';

export default async function PipelineHome({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>No autenticado. Por favor inicia sesión.</p>;
  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) return <p>Proyecto no encontrado o acceso denegado.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{project.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pipeline SROI</p>
      </div>
      <Stepper />
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Selecciona un paso del pipeline arriba para comenzar, o empieza por el principio.
        </p>
        <Link
          href={`/app/projects/${projectId}/pipeline/narrative`}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
        >
          Comenzar con Narrativa
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
