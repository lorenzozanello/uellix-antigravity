// app/app/projects/[projectId]/pipeline/calculation/runs/updateSroiRunReview.action.ts
'use server';

import { z } from 'zod';
import { updateSroiRunReview } from '@/lib/pipeline/sroi-results';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';

// FIBIU-17 (FIBC-021, W2-B5): readinessScore is REMOVED — .strict() rejects
// it explicitly rather than silently stripping it (NEG-17-1).
const ReviewInputSchema = z.object({
  status: z.enum(['draft', 'reviewed', 'approved', 'flagged']).default('draft'),
  overallNotes: z.string().optional(),
}).strict();
export async function updateSroiRunReviewAction(projectId: string, reviewId: string, payload: unknown) {
  const parsed = ReviewInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid review payload');
  }
  const result = await runWithOrganizationAccess(() =>
    updateSroiRunReview(projectId, reviewId, parsed.data)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation`);
  return result;
}
