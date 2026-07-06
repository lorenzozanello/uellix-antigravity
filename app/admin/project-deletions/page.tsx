import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { isNotNull } from 'drizzle-orm';
import ProjectDeletionClient from './client';

interface DeletionRequest {
  id: string;
  name: string;
  organizationId: string;
  deletionRequestedAt: Date | null;
  deletionRequestedBy: string;
  deletionReason: string | null;
}

export default async function ProjectDeletionsPage() {
  let requests: DeletionRequest[] = [];
  let error: string | null = null;

  try {
    const records = await db
      .select()
      .from(projects)
      .where(isNotNull(projects.deletionRequestedAt));

    requests = records as unknown as DeletionRequest[];
  } catch (err) {
    error = 'No se pudieron cargar las solicitudes de eliminación.';
  }

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-3xl font-bold">Solicitudes de eliminación de proyectos</h1>
        <p className="text-muted-foreground mt-1">
          Solo SuperAdmin puede aprobar eliminaciones permanentes.
        </p>
      </div>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-center text-red-600">
            {error}
          </CardContent>
        </Card>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            No hay solicitudes de eliminación pendientes.
          </CardContent>
        </Card>
      ) : (
        <ProjectDeletionClient initialRequests={requests} />
      )}
    </div>
  );
}
