// app/app/projects/[projectId]/pipeline/evidence/updateEvidenceReviewStatus.action.ts

'use server';

import { updateEvidenceReviewStatus } from '@/lib/pipeline/evidence';
import { z } from 'zod';

// Reuse the same schema defined in lib/pipeline/evidence.ts
const InputSchema = z.object({
  status: z.enum(['under_review', 'approved', 'rejected'] as const),
  reviewNotes: z.string().optional(),
});

export async function updateEvidenceReviewStatusAction(projectId: string, evidenceId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  return await updateEvidenceReviewStatus(projectId, evidenceId, input);
}
