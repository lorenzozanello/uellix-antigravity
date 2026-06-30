// app/app/projects/[projectId]/pipeline/narrative.actions.ts
// No additional auth actions needed
import { upsertNarrativeForProject, getNarrativeForProject } from '@/lib/pipeline/narratives';
import { z } from 'zod';

// Zod for server action input (mirrors service schema)
const narrativeInputSchema = z.object({
  version: z.string().min(1),
  narrativeText: z.string().optional(),
  theoryOfChangeSummary: z.string().optional(),
  assumptions: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
});

/** Server Action: fetch narrative */
export async function fetchNarrative(projectId: string) {
  'use server';
  return await getNarrativeForProject(projectId);
}

/** Server Action: upsert narrative */
export async function saveNarrative(projectId: string, input: unknown) {
  'use server';
  const parsed = narrativeInputSchema.parse(input);
  return await upsertNarrativeForProject(projectId, parsed);
}
