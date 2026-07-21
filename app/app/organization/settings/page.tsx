import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';
import { organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { SettingsForm } from './settings-form';
import { hasRole } from '@/lib/auth/permissions';

export default async function OrganizationSettingsPage() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) redirect('/login');

  const org = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, ctx.organization.id))
    .then(r => r[0]);

  if (!org) redirect('/login');

  const canEdit = hasRole(ctx.membership.role, 'organization_admin');

  return (
    <div className="flex-1 space-y-6 p-6 pb-12 overflow-y-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Configuración de Organización</h1>
        <p className="text-sm text-slate-500 mt-1">
          Gestiona las preferencias globales de la plataforma y el diseño en marca blanca para los reportes de impacto.
        </p>
      </div>

      <div className="border-t border-slate-200" />

      <SettingsForm
        initialData={{
          whiteLabelEnabled: org.whiteLabelEnabled,
          brandColor: org.brandColor || '#1e293b',
          logoUrl: org.logoUrl || '',
        }}
        canEdit={canEdit}
      />
    </div>
  );
}
