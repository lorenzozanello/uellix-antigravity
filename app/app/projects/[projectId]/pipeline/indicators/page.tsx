// app/app/projects/[projectId]/pipeline/indicators/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchIndicators, addIndicator } from '@/app/app/projects/[projectId]/pipeline/indicators.actions';
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/states/EmptyState';
import { Activity } from 'lucide-react';
import { z } from 'zod';

const indicatorSchema = z.object({
  outcomeId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  indicatorType: z.string().optional(),
  unit: z.string().optional(),
  baselineValue: z.string().optional(),
  targetValue: z.string().optional(),
  actualValue: z.string().optional(),
  dataSource: z.string().optional(),
  measurementPeriod: z.string().optional(),
  confidenceLevel: z.string().optional(),
});

export const action = async (formData: FormData) => {
  'use server';
  const parsed = indicatorSchema.parse({
    outcomeId: formData.get('outcomeId'),
    name: formData.get('name'),
    description: formData.get('description'),
    indicatorType: formData.get('indicatorType'),
    unit: formData.get('unit'),
    baselineValue: formData.get('baselineValue'),
    targetValue: formData.get('targetValue'),
    actualValue: formData.get('actualValue'),
    dataSource: formData.get('dataSource'),
    measurementPeriod: formData.get('measurementPeriod'),
    confidenceLevel: formData.get('confidenceLevel'),
  });
  const projectId = formData.get('projectId') as string;
  await addIndicator(projectId, parsed);
};

interface IndicatorRow {
  id: string;
  name: string;
  unit: string | null;
  baselineValue: string | null;
  targetValue: string | null;
  actualValue: string | null;
  description: string | null;
}

interface OutcomeRow {
  id: string;
  title: string;
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export default async function IndicatorsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const indicators = await fetchIndicators(projectId) as IndicatorRow[];
  const outcomes = await fetchOutcomes(projectId) as OutcomeRow[];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Indicadores</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define indicadores medibles vinculados a cada resultado para verificar y cuantificar el cambio.
        </p>
      </div>
      <Stepper />
      <StellaAdvisorPanel projectId={projectId} step="Indicadores" highlightHint={!indicators?.length} />

      {indicators?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Indicadores registrados ({indicators.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {indicators.map((i) => (
                <div key={i.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{i.name}</p>
                      {i.unit && (
                        <p className="mt-0.5 text-xs text-muted-foreground">Unidad: {i.unit}</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span>
                      Línea base:{' '}
                      <span
                        className="tabular-nums text-foreground"
                        style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                      >
                        {i.baselineValue ?? 'N/A'}
                      </span>
                    </span>
                    <span>
                      Meta:{' '}
                      <span
                        className="tabular-nums text-foreground"
                        style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                      >
                        {i.targetValue ?? 'N/A'}
                      </span>
                    </span>
                    <span>
                      Actual:{' '}
                      <span
                        className="tabular-nums text-foreground"
                        style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                      >
                        {i.actualValue ?? 'N/A'}
                      </span>
                    </span>
                  </div>
                  {i.description && (
                    <p className="mt-2 text-sm text-muted-foreground">{i.description}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={<Activity className="h-6 w-6 text-neutral-500" />}
          title="No hay indicadores registrados"
          description="Define indicadores medibles vinculados a cada resultado para verificar el cambio."
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agregar indicador</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <input type="hidden" name="projectId" value={projectId} />
            <div>
              <label htmlFor="outcomeId" className="block text-sm font-medium text-foreground">
                Resultado
              </label>
              <select id="outcomeId" name="outcomeId" className={INPUT_CLASS} required>
                <option value="">Seleccione un resultado...</option>
                {outcomes?.map((o) => (
                  <option key={o.id} value={o.id}>{o.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-foreground">
                Nombre del Indicador
              </label>
              <input id="name" name="name" className={INPUT_CLASS} required />
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-foreground">
                Descripción
              </label>
              <textarea id="description" name="description" className={TEXTAREA_CLASS} rows={2} />
            </div>
            <div>
              <label htmlFor="indicatorType" className="block text-sm font-medium text-foreground">
                Tipo de Indicador
              </label>
              <input id="indicatorType" name="indicatorType" className={INPUT_CLASS} />
            </div>
            <div>
              <label htmlFor="unit" className="block text-sm font-medium text-foreground">
                Unidad de Medida
              </label>
              <input id="unit" name="unit" className={INPUT_CLASS} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="baselineValue" className="block text-sm font-medium text-foreground">
                  Valor Línea Base
                </label>
                <input id="baselineValue" name="baselineValue" className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="targetValue" className="block text-sm font-medium text-foreground">
                  Valor Meta
                </label>
                <input id="targetValue" name="targetValue" className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="actualValue" className="block text-sm font-medium text-foreground">
                  Valor Actual
                </label>
                <input id="actualValue" name="actualValue" className={INPUT_CLASS} />
              </div>
            </div>
            <div>
              <label htmlFor="dataSource" className="block text-sm font-medium text-foreground">
                Fuente de Datos
              </label>
              <input id="dataSource" name="dataSource" className={INPUT_CLASS} />
            </div>
            <div>
              <label htmlFor="measurementPeriod" className="block text-sm font-medium text-foreground">
                Período de Medición
              </label>
              <input id="measurementPeriod" name="measurementPeriod" className={INPUT_CLASS} />
            </div>
            <div>
              <label htmlFor="confidenceLevel" className="block text-sm font-medium text-foreground">
                Nivel de Confianza
              </label>
              <input id="confidenceLevel" name="confidenceLevel" className={INPUT_CLASS} />
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
