import { createProjectForCurrentOrganization } from '@/lib/projects/service';
import { redirect } from 'next/navigation';

export default async function NewProjectPage() {
  async function handleCreate(formData: FormData) {
    'use server';
    const input = {
  name: formData.get('name') as string,
  description: (formData.get('description') as string) ?? undefined,
  thematicArea: (formData.get('thematicArea') as string) ?? undefined,
  territory: (formData.get('territory') as string) ?? undefined,
  country: (formData.get('country') as string) ?? undefined,
  startDate: (formData.get('startDate') as string) ?? undefined,
  endDate: (formData.get('endDate') as string) ?? undefined,
  targetPopulationDescription: (formData.get('targetPopulationDescription') as string) ?? undefined,
  status: ((formData.get('status') as string) ?? 'draft') as 'draft' | 'active' | 'completed' | 'archived',
  portfolioId: (formData.get('portfolioId') as string) ?? undefined,
    };
    await createProjectForCurrentOrganization(input);
    redirect('/app/projects');
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Crear Nuevo Proyecto</h1>
      <form action={handleCreate} className="flex flex-col gap-4 max-w-lg">
        <label className="flex flex-col">
          <span className="text-slate-300">Nombre *</span>
          <input name="name" type="text" required className="rounded border p-2" />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-300">Descripción</span>
          <textarea name="description" rows={3} className="rounded border p-2" />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-300">Estado</span>
          <select name="status" className="rounded border p-2">
            <option value="draft">Borrador</option>
            <option value="active">Activo</option>
            <option value="completed">Completado</option>
            <option value="archived">Archivado</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400">
          Crear
        </button>
      </form>
    </div>
  );
}
