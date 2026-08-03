// app/app/projects/[projectId]/pipeline/evidence/createTextEvidence.action.ts

'use server';

import { createTextEvidenceForProject } from '@/lib/pipeline/evidence';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { z } from 'zod';

const InputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  text: z.string().min(1),
});

export async function createTextEvidenceAction(projectId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  return runWithOrganizationAccess(() => createTextEvidenceForProject(projectId, input));
}
