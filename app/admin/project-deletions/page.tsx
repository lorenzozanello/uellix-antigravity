import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { isNotNull } from 'drizzle-orm';
import ProjectDeletionClient from './client';
import { requireAdminAccess } from '@/lib/auth/session';
import { withSuperAdminDatabaseContext } from '@/lib/auth/database-context';

interface DeletionRequest {
  id: string;
  name: string;
  organizationId: string;
  deletionRequestedAt: Date | null;
  deletionRequestedBy: string;
  deletionReason: string | null;
}

export default async function ProjectDeletionsPage() {
  // This page previously queried with no identity context AND no auth call of
  // its own — it relied entirely on app/admin/layout.tsx redirecting. The
  // super-admin check now happens here, and OUTSIDE the try: `redirect()`
  // throws, and the catch below would swallow it into an error banner.
  await requireAdminAccess();

  let requests: DeletionRequest[] = [];
  let error: string | null = null;

  try {
    const records = await withSuperAdminDatabaseContext(() =>
      db.select().from(projects).where(isNotNull(projects.deletionRequestedAt))
    );

    requests = records as unknown as DeletionRequest[];
  } catch {
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
