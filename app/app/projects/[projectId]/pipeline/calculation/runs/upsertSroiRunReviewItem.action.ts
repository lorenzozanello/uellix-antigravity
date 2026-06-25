// app/app/projects/[projectId]/pipeline/calculation/runs/upsertSroiRunReviewItem.action.ts
'use server';

import { z } from 'zod';
import { upsertSroiRunReviewItem } from '@/lib/pipeline/sroi-results';
import { revalidatePath } from 'next/cache';

const ReviewItemInputSchema = z.object({
  itemKey: z.string().min(1),
  status: z.enum(['pass', 'warning', 'fail', 'not_applicable']).default('warning'),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  notes: z.string().optional(),
});
export async function upsertSroiRunReviewItemAction(projectId: string, reviewId: string, payload: unknown) {
  const parsed = ReviewItemInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid review item payload');
  }
  const result = await upsertSroiRunReviewItem(projectId, reviewId, parsed.data);
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation`);
  return result;
}
