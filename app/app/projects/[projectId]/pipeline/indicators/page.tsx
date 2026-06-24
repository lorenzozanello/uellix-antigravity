// app/app/projects/[projectId]/pipeline/indicators/page.tsx
import Stepper from '@/components/sroi/Stepper';
import StellaPlaceholder from '@/components/sroi/StellaPlaceholder';
import { fetchIndicators, addIndicator } from '@/app/app/projects/[projectId]/pipeline/indicators.actions';
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
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

export default async function IndicatorsPage({ params }: { params: { projectId: string } }) {
  const indicators = await fetchIndicators(params.projectId) as IndicatorRow[];
  const outcomes = await fetchOutcomes(params.projectId) as OutcomeRow[];

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-2">Indicadores</h2>
      <Stepper />
      <StellaPlaceholder step="Indicadores" />
      <ul className="list-disc pl-5 mb-4">
        {indicators?.length ? (
          indicators.map((i) => (
            <li key={i.id}>
              <strong>{i.name}</strong> – {i.unit ?? 'Sin unidad'} (Línea base: {i.baselineValue ?? 'N/A'}, Meta: {i.targetValue ?? 'N/A'}, Actual: {i.actualValue ?? 'N/A'})
              {i.description && <p className="text-sm">{i.description}</p>}
            </li>
          ))
        ) : (
          <p>No hay indicadores aún.</p>
        )}
      </ul>
      <form action={action} className="space-y-3">
        <input type="hidden" name="projectId" value={params.projectId} />
        <label>
          Outcome:
          <select name="outcomeId" className="border rounded w-full" required>
            <option value="">Seleccione un outcome...</option>
            {outcomes?.map((o) => (
              <option key={o.id} value={o.id}>{o.title}</option>
            ))}
          </select>
        </label>
        <label>
          Nombre del Indicador:
          <input name="name" className="border rounded w-full" required />
        </label>
        <label>
          Descripción:
          <textarea name="description" className="border rounded w-full" rows={2} />
        </label>
        <label>
          Tipo de Indicador:
          <input name="indicatorType" className="border rounded w-full" />
        </label>
        <label>
          Unidad de Medida:
          <input name="unit" className="border rounded w-full" />
        </label>
        <label>
          Valor Línea Base:
          <input name="baselineValue" className="border rounded w-full" />
        </label>
        <label>
          Valor Meta:
          <input name="targetValue" className="border rounded w-full" />
        </label>
        <label>
          Valor Actual:
          <input name="actualValue" className="border rounded w-full" />
        </label>
        <label>
          Fuente de Datos:
          <input name="dataSource" className="border rounded w-full" />
        </label>
        <label>
          Período de Medición:
          <input name="measurementPeriod" className="border rounded w-full" />
        </label>
        <label>
          Nivel de Confianza:
          <input name="confidenceLevel" className="border rounded w-full" />
        </label>
        <button type="submit" className="bg-teal-600 text-white px-4 py-2 rounded">Agregar</button>
      </form>
    </div>
  );
}
