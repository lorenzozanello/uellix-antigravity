// app/app/projects/[projectId]/pipeline/narrative/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchNarrative, saveNarrative } from '@/app/app/projects/[projectId]/pipeline/narrative.actions';
import { z } from 'zod';

// Zod schema for client-side validation (mirrors server)
const narrativeSchema = z.object({
  version: z.string().min(1),
  narrativeText: z.string().optional(),
  theoryOfChangeSummary: z.string().optional(),
  assumptions: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
});

export const action = async (formData: FormData) => {
  'use server';
  const parsed = narrativeSchema.parse({
    version: formData.get('version'),
    narrativeText: formData.get('narrativeText'),
    theoryOfChangeSummary: formData.get('theoryOfChangeSummary'),
    assumptions: formData.get('assumptions'),
    status: formData.get('status'),
  });
  const projectId = formData.get('projectId') as string;
  await saveNarrative(projectId, parsed);
};

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'

export default async function NarrativePage({ params }: { params: { projectId: string } }) {
  const narrative = await fetchNarrative(params.projectId);
  const data = narrative ?? {};
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Narrativa</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Establece la narrativa de inicio del proyecto, teoría del cambio y supuestos metodológicos.
        </p>
      </div>
      <Stepper />
      <StellaAdvisorPanel projectId={params.projectId} step="Narrativa" />
      <form action={action} className="space-y-6">
        <input type="hidden" name="projectId" value={params.projectId} />
        <div>
          <label htmlFor="version" className="block text-sm font-medium text-foreground">
            Versión
          </label>
          <input
            id="version"
            name="version"
            defaultValue={data.version ?? ''}
            className={INPUT_CLASS}
            required
          />
        </div>
        <div>
          <label htmlFor="narrativeText" className="block text-sm font-medium text-foreground">
            Texto narrativo
          </label>
          <textarea
            id="narrativeText"
            name="narrativeText"
            defaultValue={data.narrativeText ?? ''}
            className={TEXTAREA_CLASS}
            rows={4}
          />
        </div>
        <div>
          <label htmlFor="theoryOfChangeSummary" className="block text-sm font-medium text-foreground">
            Resumen de teoría del cambio
          </label>
          <textarea
            id="theoryOfChangeSummary"
            name="theoryOfChangeSummary"
            defaultValue={data.theoryOfChangeSummary ?? ''}
            className={TEXTAREA_CLASS}
            rows={3}
          />
        </div>
        <div>
          <label htmlFor="assumptions" className="block text-sm font-medium text-foreground">
            Suposiciones
          </label>
          <textarea
            id="assumptions"
            name="assumptions"
            defaultValue={data.assumptions ?? ''}
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
            defaultValue={data.status ?? 'draft'}
            className={INPUT_CLASS}
          >
            <option value="draft">Borrador</option>
            <option value="active">Activo</option>
            <option value="completed">Completado</option>
            <option value="archived">Archivado</option>
          </select>
        </div>
        <button
          type="submit"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
        >
          Guardar
        </button>
      </form>
    </div>
  );
}
