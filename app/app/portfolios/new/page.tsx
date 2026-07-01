import { createPortfolioForCurrentOrganization } from '@/lib/portfolios/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/ErrorState';

const TEXTAREA_CLASS =
  'mt-1.5 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export default async function NewPortfolioPage() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>No autenticado. Por favor inicia sesión.</p>;

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(
    ctx.membership.role,
  );

  async function handleCreate(formData: FormData) {
    'use server';
    const input = {
      name: formData.get('name') as string,
      description: (formData.get('description') as string) || undefined,
    };
    await createPortfolioForCurrentOrganization(input);
    redirect('/app/portfolios');
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">Crear nuevo portafolio</h1>

      {canCreate ? (
        <Card>
          <CardContent className="pt-6">
            <form action={handleCreate} className="space-y-5">
              <div>
                <Label htmlFor="name">
                  Nombre <span className="text-danger">*</span>
                </Label>
                <Input id="name" name="name" type="text" required className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="description">Descripción</Label>
                <textarea id="description" name="description" rows={3} className={TEXTAREA_CLASS} />
              </div>
              <Button type="submit">Crear portafolio</Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <ErrorState
          title="Acceso denegado"
          message="No tienes permiso para crear portafolios."
        />
      )}
    </div>
  );
}
