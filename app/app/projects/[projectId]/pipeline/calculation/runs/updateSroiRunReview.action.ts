// app/app/projects/[projectId]/pipeline/calculation/runs/updateSroiRunReview.action.ts
'use server';

import { z } from 'zod';
import { updateSroiRunReview } from '@/lib/pipeline/sroi-results';
import { revalidatePath } from 'next/cache';

const ReviewInputSchema = z.object({
  status: z.enum(['draft', 'reviewed', 'approved', 'flagged']).default('draft'),
  readinessScore: z.number().int().min(0).max(100).optional(),
  overallNotes: z.string().optional(),
});
export async function updateSroiRunReviewAction(projectId: string, reviewId: string, payload: unknown) {
  const parsed = ReviewInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid review payload');
  }
  const result = await updateSroiRunReview(projectId, reviewId, parsed.data);
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation`);
  return result;
}
