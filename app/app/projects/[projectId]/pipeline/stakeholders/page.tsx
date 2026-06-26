// app/app/projects/[projectId]/pipeline/stakeholders/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchStakeholders, addStakeholder } from '@/app/app/projects/[projectId]/pipeline/stakeholders.actions';
import { z } from 'zod';

const stakeholderSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
});

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

export default async function StakeholdersPage({ params }: { params: { projectId: string } }) {
  const stakeholders = await fetchStakeholders(params.projectId) as StakeholderRow[];
  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-2">Stakeholders</h2>
      <Stepper />
      <StellaAdvisorPanel projectId={params.projectId} step="Stakeholders" />
      <ul className="list-disc pl-5 mb-4">
        {stakeholders?.length ? (
          stakeholders.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> – {s.type ?? 'Sin tipo'}
              {s.description && <p className="text-sm">{s.description}</p>}
            </li>
          ))
        ) : (
          <p>No hay stakeholders aún.</p>
        )}
      </ul>
      <form action={action} className="space-y-3">
        <input type="hidden" name="projectId" value={params.projectId} />
        <label>
          Nombre:
          <input name="name" className="border rounded w-full" required />
        </label>
        <label>
          Descripción:
          <textarea name="description" className="border rounded w-full" rows={2} />
        </label>
        <label>
          Tipo:
          <input name="type" className="border rounded w-full" />
        </label>
        <button type="submit" className="bg-teal-600 text-white px-4 py-2 rounded">Agregar</button>
      </form>
    </div>
  );
}
