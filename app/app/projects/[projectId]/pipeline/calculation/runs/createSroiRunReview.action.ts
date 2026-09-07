// app/app/projects/[projectId]/pipeline/calculation/runs/createSroiRunReview.action.ts
'use server';

import { z } from 'zod';
import { createSroiRunReview } from '@/lib/pipeline/sroi-results';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';

// FIBIU-17 (FIBC-021, W2-B5): readinessScore is REMOVED — .strict() rejects
// it explicitly rather than silently stripping it (NEG-17-1).
const ReviewInputSchema = z.object({
  status: z.enum(['draft', 'reviewed', 'approved', 'flagged']).default('draft'),
  overallNotes: z.string().optional(),
}).strict();
export async function createSroiRunReviewAction(projectId: string, runId: string, payload: unknown) {
  const parsed = ReviewInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid review payload');
  }
  const result = await runWithOrganizationAccess(() =>
    createSroiRunReview(projectId, runId, parsed.data)
  );
  // Revalidate UI path that shows reviews (if any)
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation`);
  return result;
}
