// app/app/projects/[projectId]/pipeline/outcomes/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchOutcomes, addOutcome, updateOutcomeMateriality } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { fetchStakeholders } from '@/app/app/projects/[projectId]/pipeline/stakeholders.actions';
import { OutcomeAllocationWrapper } from '@/app/components/allocation-form/OutcomeAllocationWrapper';
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
  materialityScore: z.number().int().min(1).max(5).optional(),
  materialityRationale: z.string().min(1).optional(),
});

export const action = async (formData: FormData) => {
  'use server';
  const rawScore = formData.get('materialityScore');
  const parsed = outcomeSchema.parse({
    stakeholderGroupId: formData.get('stakeholderGroupId'),
    title: formData.get('title'),
    description: formData.get('description'),
    outcomeType: formData.get('outcomeType'),
    materialityNotes: formData.get('materialityNotes'),
    status: formData.get('status'),
    materialityScore: rawScore && rawScore !== '' ? Number(rawScore) : undefined,
    materialityRationale: (formData.get('materialityRationale') as string) || undefined,
  });
  const projectId = formData.get('projectId') as string;
  await addOutcome(projectId, parsed);
};

export const materialityAction = async (formData: FormData) => {
  'use server';
  const projectId = formData.get('projectId') as string;
  const outcomeId = formData.get('outcomeId') as string;
  const rawScore = formData.get('materialityScore') as string;
  const score = rawScore === '' ? null : Number(rawScore);
  await updateOutcomeMateriality(projectId, outcomeId, {
    materialityScore: score,
    materialityRationale: (formData.get('materialityRationale') as string) || undefined,
  });
};

interface OutcomeRow {
  id: string;
  title: string;
  outcomeType: string | null;
  description: string | null;
  materialityScore: number | null;
  materialityRationale: string | null;
}

interface StakeholderRow {
  id: string;
  name: string;
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export default async function OutcomesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const outcomes = await fetchOutcomes(projectId) as OutcomeRow[];
  const stakeholders = await fetchStakeholders(projectId) as StakeholderRow[];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Resultados</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define los cambios esperados y observados que esta iniciativa busca lograr.
        </p>
      </div>
      <Stepper />
      <StellaAdvisorPanel projectId={projectId} step="Resultados" highlightHint={!outcomes?.length} />
      {outcomes?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resultados registrados ({outcomes.length})</CardTitle>
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
                  <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-2">
                    <p className="text-xs font-medium text-foreground">
                      Materialidad:{' '}
                      {o.materialityScore === null ? (
                        <span className="text-muted-foreground">Sin evaluar</span>
                      ) : (
                        <span>{o.materialityScore}/5 — {o.materialityRationale}</span>
                      )}
                    </p>
                    <form action={materialityAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="outcomeId" value={o.id} />
                      <div>
                        <label htmlFor={`materiality-score-${o.id}`} className="block text-xs text-muted-foreground">
                          Score
                        </label>
                        <select
                          id={`materiality-score-${o.id}`}
                          name="materialityScore"
                          defaultValue={o.materialityScore ?? ''}
                          className={`${INPUT_CLASS} h-8 text-xs`}
                        >
                          <option value="">Sin evaluar</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className="flex-1 min-w-[160px]">
                        <label htmlFor={`materiality-rationale-${o.id}`} className="block text-xs text-muted-foreground">
                          Justificación
                        </label>
                        <input
                          id={`materiality-rationale-${o.id}`}
                          name="materialityRationale"
                          defaultValue={o.materialityRationale ?? ''}
                          className={`${INPUT_CLASS} h-8 text-xs`}
                        />
                      </div>
                      <button
                        type="submit"
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        Guardar
                      </button>
                    </form>
                  </div>
                  <OutcomeAllocationWrapper
                    outcomeId={o.id}
                    projectId={projectId}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={<Target className="h-6 w-6 text-neutral-500" />}
          title="No hay resultados registrados"
          description="Define los cambios esperados y observables que busca lograr esta iniciativa."
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agregar resultado</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <input type="hidden" name="projectId" value={projectId} />
            <div>
              <label htmlFor="stakeholderGroupId" className="block text-sm font-medium text-foreground">
                Grupo de interés
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
                Título del resultado
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
                Tipo de resultado
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
              <label htmlFor="materialityScore" className="block text-sm font-medium text-foreground">
                Score de materialidad (1-5)
              </label>
              <select
                id="materialityScore"
                name="materialityScore"
                defaultValue=""
                className={INPUT_CLASS}
              >
                <option value="">Sin evaluar</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
              </select>
            </div>
            <div>
              <label htmlFor="materialityRationale" className="block text-sm font-medium text-foreground">
                Justificación de materialidad
              </label>
              <textarea
                id="materialityRationale"
                name="materialityRationale"
                className={TEXTAREA_CLASS}
                rows={2}
                placeholder="Obligatoria si se asigna un score"
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
