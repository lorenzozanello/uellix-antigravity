// app/app/projects/[projectId]/pipeline/indicators.actions.ts
import { createIndicatorForProject, listIndicatorsForProject } from '@/lib/pipeline/indicators';
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

export async function fetchIndicators(projectId: string) {
  'use server';
  return await listIndicatorsForProject(projectId);
}

export async function addIndicator(projectId: string, input: unknown) {
  'use server';
  const parsed = indicatorSchema.parse(input);
  return await createIndicatorForProject(projectId, parsed);
}
