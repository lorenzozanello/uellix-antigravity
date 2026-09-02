// app/app/projects/[projectId]/pipeline/calculation/runs/recordEvidenceSufficiencyDetermination.action.ts
'use server';

import { z } from 'zod';
import { recordEvidenceSufficiencyDetermination } from '@/lib/pipeline/evidence-sufficiency';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';

// Reuse the same schema defined in lib/pipeline/evidence-sufficiency.ts
const InputSchema = z.object({
  determination: z.enum(['sufficient', 'insufficient'] as const),
  rationale: z.string().min(1),
});

export async function recordEvidenceSufficiencyDeterminationAction(
  projectId: string,
  outcomeId: string,
  calculationRunId: string,
  rawInput: unknown
) {
  const input = InputSchema.parse(rawInput);
  const result = await runWithOrganizationAccess(() =>
    recordEvidenceSufficiencyDetermination(projectId, outcomeId, calculationRunId, input)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${calculationRunId}`);
  return result;
}
