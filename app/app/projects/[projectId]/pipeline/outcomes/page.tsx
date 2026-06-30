// app/app/projects/[projectId]/pipeline/outcomes/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchOutcomes, addOutcome } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { fetchStakeholders } from '@/app/app/projects/[projectId]/pipeline/stakeholders.actions';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/states/EmptyState';
import { Target } from 'lucide-react';
import { z } from 'zod';

const outcomeSchema = z.object({
  stakeholderGroupId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeType: z.string().optional(),
  materialityNotes: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const action = async (formData: FormData) => {
  'use server';
  const parsed = outcomeSchema.parse({
    stakeholderGroupId: formData.get('stakeholderGroupId'),
    title: formData.get('title'),
    description: formData.get('description'),
    outcomeType: formData.get('outcomeType'),
    materialityNotes: formData.get('materialityNotes'),
    status: formData.get('status'),
  });
  const projectId = formData.get('projectId') as string;
  await addOutcome(projectId, parsed);
};
interface OutcomeRow {
  id: string;
  title: string;
  outcomeType: string | null;
  description: string | null;
}

interface StakeholderRow {
  id: string;
  name: string;
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export default async function OutcomesPage({ params }: { params: { projectId: string } }) {
  const outcomes = await fetchOutcomes(params.projectId) as OutcomeRow[];
  const stakeholders = await fetchStakeholders(params.projectId) as StakeholderRow[];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Outcomes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define los cambios esperados y observados que esta iniciativa busca lograr.
        </p>
      </div>
      <Stepper />
      <StellaAdvisorPanel projectId={params.projectId} step="Outcomes" />
      {outcomes?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Outcomes registrados ({outcomes.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {outcomes.map((o) => (
                <div key={o.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{o.title}</p>
                      {o.outcomeType && (
                        <p className="mt-0.5 text-xs text-muted-foreground">Tipo: {o.outcomeType}</p>
                      )}
                    </div>
                  </div>
                  {o.description && (
                    <p className="mt-2 text-sm text-muted-foreground">{o.description}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={<Target className="h-6 w-6 text-neutral-500" />}
          title="No hay outcomes registrados"
          description="Define los cambios esperados y observables que busca lograr esta iniciativa."
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agregar outcome</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <input type="hidden" name="projectId" value={params.projectId} />
            <div>
              <label htmlFor="stakeholderGroupId" className="block text-sm font-medium text-foreground">
                Stakeholder Group
              </label>
              <select
                id="stakeholderGroupId"
                name="stakeholderGroupId"
                className={INPUT_CLASS}
                required
              >
                <option value="">Seleccione un grupo...</option>
                {stakeholders?.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="title" className="block text-sm font-medium text-foreground">
                Título del Outcome
              </label>
              <input
                id="title"
                name="title"
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
              <label htmlFor="outcomeType" className="block text-sm font-medium text-foreground">
                Tipo de Outcome
              </label>
              <input
                id="outcomeType"
                name="outcomeType"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="materialityNotes" className="block text-sm font-medium text-foreground">
                Notas de Materialidad
              </label>
              <textarea
                id="materialityNotes"
                name="materialityNotes"
                className={TEXTAREA_CLASS}
                rows={2}
              />
            </div>
            <div>
              <label htmlFor="status" className="block text-sm font-medium text-foreground">
                Estado
              </label>
              <select
                id="status"
                name="status"
                defaultValue="active"
                className={INPUT_CLASS}
              >
                <option value="active">Activo</option>
                <option value="inactive">Inactivo</option>
              </select>
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
