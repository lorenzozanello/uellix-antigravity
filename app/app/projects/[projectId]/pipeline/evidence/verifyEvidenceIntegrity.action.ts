// app/app/projects/[projectId]/pipeline/evidence/verifyEvidenceIntegrity.action.ts

'use server';

import { verifyFileEvidenceIntegrity } from '@/lib/pipeline/evidence';

export async function verifyEvidenceIntegrityAction(projectId: string, evidenceId: string) {
  return await verifyFileEvidenceIntegrity(projectId, evidenceId);
}
