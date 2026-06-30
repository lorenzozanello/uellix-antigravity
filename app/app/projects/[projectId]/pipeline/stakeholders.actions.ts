// app/app/projects/[projectId]/pipeline/stakeholders.actions.ts
import { createStakeholderForProject, listStakeholdersForProject } from '@/lib/pipeline/stakeholders';
import { z } from 'zod';

const stakeholderSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
});

export async function fetchStakeholders(projectId: string) {
  'use server';
  return await listStakeholdersForProject(projectId);
}

export async function addStakeholder(projectId: string, input: unknown) {
  'use server';
  const parsed = stakeholderSchema.parse(input);
  return await createStakeholderForProject(projectId, parsed);
}
