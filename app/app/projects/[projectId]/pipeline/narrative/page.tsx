// app/app/projects/[projectId]/pipeline/narrative/page.tsx
import Stepper from '@/components/sroi/Stepper';
import StellaPlaceholder from '@/components/sroi/StellaPlaceholder';
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

export default async function NarrativePage({ params }: { params: { projectId: string } }) {
  const narrative = await fetchNarrative(params.projectId);
  const data = narrative ?? {};
  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-2">Narrativa</h2>
      <Stepper />
      <StellaPlaceholder step="Narrativa" />
      <form action={action} className="space-y-4">
        <input type="hidden" name="projectId" value={params.projectId} />
        <label>
          Versión:
          <input name="version" defaultValue={data.version ?? ''} className="border rounded w-full" required />
        </label>
        <label>
          Texto narrativo:
          <textarea name="narrativeText" defaultValue={data.narrativeText ?? ''} className="border rounded w-full" rows={4} />
        </label>
        <label>
          Resumen de teoría del cambio:
          <textarea name="theoryOfChangeSummary" defaultValue={data.theoryOfChangeSummary ?? ''} className="border rounded w-full" rows={3} />
        </label>
        <label>
          Suposiciones:
          <textarea name="assumptions" defaultValue={data.assumptions ?? ''} className="border rounded w-full" rows={2} />
        </label>
        <label>
          Estado:
          <select name="status" defaultValue={data.status ?? 'draft'} className="border rounded w-full">
            <option value="draft">Borrador</option>
            <option value="active">Activo</option>
            <option value="completed">Completado</option>
            <option value="archived">Archivado</option>
          </select>
        </label>
        <button type="submit" className="bg-teal-600 text-white px-4 py-2 rounded">Guardar</button>
      </form>
    </div>
  );
}
