// app/app/projects/[projectId]/pipeline/outcomes/page.tsx
import Stepper from '@/components/sroi/Stepper';
import StellaPlaceholder from '@/components/sroi/StellaPlaceholder';
import { fetchOutcomes, addOutcome } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { fetchStakeholders } from '@/app/app/projects/[projectId]/pipeline/stakeholders.actions';
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

export default async function OutcomesPage({ params }: { params: { projectId: string } }) {
  const outcomes = await fetchOutcomes(params.projectId) as OutcomeRow[];
  const stakeholders = await fetchStakeholders(params.projectId) as StakeholderRow[];

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-2">Outcomes</h2>
      <Stepper />
      <StellaPlaceholder step="Outcomes" />
      <ul className="list-disc pl-5 mb-4">
        {outcomes?.length ? (
          outcomes.map((o) => (
            <li key={o.id}>
              <strong>{o.title}</strong> – {o.outcomeType ?? 'Sin tipo'}
              {o.description && <p className="text-sm">{o.description}</p>}
            </li>
          ))
        ) : (
          <p>No hay outcomes aún.</p>
        )}
      </ul>
      <form action={action} className="space-y-3">
        <input type="hidden" name="projectId" value={params.projectId} />
        <label>
          Stakeholder Group:
          <select name="stakeholderGroupId" className="border rounded w-full" required>
            <option value="">Seleccione un grupo...</option>
            {stakeholders?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label>
          Título del Outcome:
          <input name="title" className="border rounded w-full" required />
        </label>
        <label>
          Descripción:
          <textarea name="description" className="border rounded w-full" rows={2} />
        </label>
        <label>
          Tipo de Outcome:
          <input name="outcomeType" className="border rounded w-full" />
        </label>
        <label>
          Notas de Materialidad:
          <textarea name="materialityNotes" className="border rounded w-full" rows={2} />
        </label>
        <label>
          Estado:
          <select name="status" defaultValue="active" className="border rounded w-full">
            <option value="active">Activo</option>
            <option value="inactive">Inactivo</option>
          </select>
        </label>
        <button type="submit" className="bg-teal-600 text-white px-4 py-2 rounded">Agregar</button>
      </form>
    </div>
  );
}
