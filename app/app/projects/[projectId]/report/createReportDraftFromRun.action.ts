// app/app/projects/[projectId]/report/createReportDraftFromRun.action.ts
'use server';

import { z } from 'zod';
import { createReportDraftFromRun } from '@/lib/pipeline/sroi-results';
import { revalidatePath } from 'next/cache';

const ReportDraftInputSchema = z.object({
  title: z.string().min(1),
  includeFunderBreakdown: z.boolean().optional().default(false),
  includeEvidenceConfidence: z.boolean().optional().default(true),
  reportVariant: z.enum(['funder', 'methodological', 'audit']).optional().default('audit'),
});
export async function createReportDraftFromRunAction(projectId: string, runId: string, payload: unknown) {
  const parsed = ReportDraftInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid report draft payload');
  }
  const result = await createReportDraftFromRun(projectId, runId, parsed.data);
  // Revalidate the page showing reports for the project
  revalidatePath(`/app/projects/${projectId}/report`);
  return result;
}
