// app/app/projects/[projectId]/report/lockReportDraft.action.ts
'use server';

import { lockReportDraft, type LockReportAttestation } from '@/lib/pipeline/sroi-results';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';

export async function lockReportDraftAction(
  projectId: string,
  reportId: string,
  attestation: LockReportAttestation,
) {
  const result = await runWithOrganizationAccess(() => lockReportDraft(projectId, reportId, attestation));
  // Revalidate reports page after lock
  revalidatePath(`/app/projects/${projectId}/report`);
  return result;
}
