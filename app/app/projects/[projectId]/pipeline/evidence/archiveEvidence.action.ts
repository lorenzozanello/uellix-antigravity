// app/app/projects/[projectId]/pipeline/evidence/archiveEvidence.action.ts

'use server';

import { archiveEvidenceForProject } from '@/lib/pipeline/evidence';

export async function archiveEvidenceAction(projectId: string, evidenceId: string) {
  return await archiveEvidenceForProject(projectId, evidenceId);
}
