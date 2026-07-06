// app/app/projects/[projectId]/pipeline/outcomes.actions.ts
import { createOutcomeForProject, listOutcomesForProject, setOutcomeMateriality } from '@/lib/pipeline/outcomes';
import { z } from 'zod';

const outcomeSchema = z.object({
  stakeholderGroupId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeType: z.string().optional(),
  materialityNotes: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  materialityScore: z.number().int().min(1).max(5).optional(),
  materialityRationale: z.string().min(1).optional(),
});

const materialitySchema = z.object({
  materialityScore: z.number().int().min(1).max(5).nullable(),
  materialityRationale: z.string().min(1).optional(),
});

export async function fetchOutcomes(projectId: string) {
  'use server';
  return await listOutcomesForProject(projectId);
}

export async function addOutcome(projectId: string, input: unknown) {
  'use server';
  const parsed = outcomeSchema.parse(input);
  return await createOutcomeForProject(projectId, parsed);
}

export async function updateOutcomeMateriality(projectId: string, outcomeId: string, input: unknown) {
  'use server';
  const parsed = materialitySchema.parse(input);
  return await setOutcomeMateriality(projectId, outcomeId, parsed);
}
