// app/app/projects/[projectId]/pipeline/evidence/archiveEvidence.action.ts

'use server';

import { archiveEvidenceForProject } from '@/lib/pipeline/evidence';
import { runWithOrganizationAccess } from '@/lib/auth/session';

export async function archiveEvidenceAction(projectId: string, evidenceId: string) {
  return runWithOrganizationAccess(() => archiveEvidenceForProject(projectId, evidenceId));
}
