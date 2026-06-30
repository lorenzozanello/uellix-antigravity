// app/app/projects/[projectId]/report/updateReportSection.action.ts
'use server';

import { z } from 'zod';
import { updateReportSection } from '@/lib/pipeline/sroi-results';
import { revalidatePath } from 'next/cache';

const ReportSectionInputSchema = z.object({
  title: z.string().min(1),
  content: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export async function updateReportSectionAction(projectId: string, reportId: string, sectionId: string, payload: unknown) {
  const parsed = ReportSectionInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid report section payload');
  }
  const result = await updateReportSection(projectId, reportId, sectionId, parsed.data);
  revalidatePath(`/app/projects/${projectId}/report`);
  return result;
}
