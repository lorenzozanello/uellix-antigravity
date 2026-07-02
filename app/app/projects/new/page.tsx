import { createProjectForCurrentOrganization } from '@/lib/projects/service';
import { listPortfoliosForCurrentOrganization } from '@/lib/portfolios/service';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

const TEXTAREA_CLASS =
  'mt-1.5 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export default async function NewProjectPage() {
  const portfolios = await listPortfoliosForCurrentOrganization();

  async function handleCreate(formData: FormData) {
    'use server';
    const input = {
      name: formData.get('name') as string,
      description: (formData.get('description') as string) || undefined,
      thematicArea: (formData.get('thematicArea') as string) || undefined,
      territory: (formData.get('territory') as string) || undefined,
      country: (formData.get('country') as string) || undefined,
      startDate: (formData.get('startDate') as string) || undefined,
      endDate: (formData.get('endDate') as string) || undefined,
      targetPopulationDescription: (formData.get('targetPopulationDescription') as string) || undefined,
      status: ((formData.get('status') as string) || 'draft') as 'draft' | 'active' | 'completed' | 'archived',
      portfolioId: (formData.get('portfolioId') as string) || undefined,
    };
    await createProjectForCurrentOrganization(input);
    redirect('/app/projects');
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Crear nuevo proyecto</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cada proyecto guía a tu equipo por el pipeline SROI completo — desde la teoría del cambio hasta un ratio de impacto defendible.
        </p>
      </div>

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

            <div>
              <Label htmlFor="thematicArea">Área temática</Label>
              <Input id="thematicArea" name="thematicArea" type="text" className="mt-1.5" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="territory">Territorio</Label>
                <Input id="territory" name="territory" type="text" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="country">País (código ISO)</Label>
                <Input id="country" name="country" type="text" maxLength={2} placeholder="MX" className="mt-1.5 uppercase" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="startDate">Fecha de inicio</Label>
                <Input id="startDate" name="startDate" type="date" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="endDate">Fecha de fin</Label>
                <Input id="endDate" name="endDate" type="date" className="mt-1.5" />
              </div>
            </div>

            <div>
              <Label htmlFor="targetPopulationDescription">Población objetivo</Label>
              <textarea id="targetPopulationDescription" name="targetPopulationDescription" rows={2} className={TEXTAREA_CLASS} />
            </div>

            <div>
              <Label htmlFor="portfolioId">Portafolio</Label>
              <Select id="portfolioId" name="portfolioId" className="mt-1.5">
                <option value="">Sin asignar</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="status">Estado</Label>
              <Select id="status" name="status" className="mt-1.5">
                <option value="draft">Borrador</option>
                <option value="active">Activo</option>
                <option value="completed">Completado</option>
                <option value="archived">Archivado</option>
              </Select>
            </div>

            <Button type="submit">Crear proyecto</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
