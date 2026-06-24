// app/app/projects/[projectId]/pipeline/evidence/createUrlEvidence.action.ts

'use server';

import { createUrlEvidenceForProject } from '@/lib/pipeline/evidence';
import { z } from 'zod';

const InputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  url: z.string().url(),
});

export async function createUrlEvidenceAction(projectId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  return await createUrlEvidenceForProject(projectId, input);
}
