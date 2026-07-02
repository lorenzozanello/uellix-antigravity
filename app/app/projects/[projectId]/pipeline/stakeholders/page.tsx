// app/app/projects/[projectId]/pipeline/stakeholders/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchStakeholders, addStakeholder } from '@/app/app/projects/[projectId]/pipeline/stakeholders.actions';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { z } from 'zod';
import { EmptyState } from '@/components/states/EmptyState';
import { Users } from 'lucide-react';

const stakeholderSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
});

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export const action = async (formData: FormData) => {
  'use server';
  const parsed = stakeholderSchema.parse({
    name: formData.get('name'),
    description: formData.get('description'),
    type: formData.get('type'),
  });
  const projectId = formData.get('projectId') as string;
  await addStakeholder(projectId, parsed);
};

interface StakeholderRow {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
}

export default async function StakeholdersPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const stakeholders = await fetchStakeholders(projectId) as StakeholderRow[];
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Grupos de interés</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Identifica los grupos afectados y participantes en esta iniciativa de impacto.
        </p>
      </div>
      <Stepper />
      <StellaAdvisorPanel projectId={projectId} step="Grupos de interés" />
      {stakeholders?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Grupos de interés registrados ({stakeholders.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stakeholders.map((s) => (
                <div key={s.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{s.name}</p>
                      {s.type && (
                        <p className="mt-0.5 text-xs text-muted-foreground">Tipo: {s.type}</p>
                      )}
                    </div>
                  </div>
                  {s.description && (
                    <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={<Users className="h-6 w-6 text-neutral-500" />}
          title="No hay grupos de interés registrados"
          description="Agrega grupos afectados y participantes para documentar el alcance de esta iniciativa."
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agregar grupo de interés</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <input type="hidden" name="projectId" value={projectId} />
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-foreground">
                Nombre
              </label>
              <input
                id="name"
                name="name"
                className={INPUT_CLASS}
                required
              />
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-foreground">
                Descripción
              </label>
              <textarea
                id="description"
                name="description"
                className={TEXTAREA_CLASS}
                rows={2}
              />
            </div>
            <div>
              <label htmlFor="type" className="block text-sm font-medium text-foreground">
                Tipo / Categoría
              </label>
              <input
                id="type"
                name="type"
                className={INPUT_CLASS}
              />
            </div>
            <button
              type="submit"
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
            >
              Agregar
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
