// app/app/projects/[projectId]/pipeline/outcomes.actions.ts
import { createOutcomeForProject, listOutcomesForProject } from '@/lib/pipeline/outcomes';
import { z } from 'zod';

const outcomeSchema = z.object({
  stakeholderGroupId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeType: z.string().optional(),
  materialityNotes: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
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
