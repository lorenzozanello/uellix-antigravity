// app/app/projects/[projectId]/report/lockReportDraft.action.ts
'use server';

import { lockReportDraft } from '@/lib/pipeline/sroi-results';
import { revalidatePath } from 'next/cache';

export async function lockReportDraftAction(projectId: string, reportId: string) {
  const result = await lockReportDraft(projectId, reportId);
  // Revalidate reports page after lock
  revalidatePath(`/app/projects/${projectId}/report`);
  return result;
}
