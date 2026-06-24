import { createPortfolioForCurrentOrganization } from '@/lib/portfolios/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

export default async function NewPortfolioPage() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>Unauthenticated. Please log in.</p>;

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(
    ctx.membership.role,
  );

  async function handleCreate(formData: FormData) {
    'use server';
    const input = {
      name: formData.get('name') as string,
      description: (formData.get('description') as string) ?? undefined,
    };
    try {
      await createPortfolioForCurrentOrganization(input);
      redirect('/app/portfolios');
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Error creating portfolio');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Crear Nuevo Portafolio</h1>
      {canCreate ? (
        <form action={handleCreate} className="flex flex-col gap-4 max-w-lg">
          <label className="flex flex-col">
            <span className="text-slate-300">Nombre *</span>
            <input name="name" type="text" required className="rounded border p-2" />
          </label>
          <label className="flex flex-col">
            <span className="text-slate-300">Descripción</span>
            <textarea name="description" rows={3} className="rounded border p-2" />
          </label>
          <button
            type="submit"
            className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400"
          >
            Crear
          </button>
        </form>
      ) : (
        <p className="text-red-500">Acceso denegado: no tienes permiso para crear portafolios.</p>
      )}
    </div>
  );
}
