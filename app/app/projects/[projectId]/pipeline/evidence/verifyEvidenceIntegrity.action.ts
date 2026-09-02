// app/app/projects/[projectId]/pipeline/evidence/verifyEvidenceIntegrity.action.ts

'use server';

import { verifyFileEvidenceIntegrity } from '@/lib/pipeline/evidence';

export async function verifyEvidenceIntegrityAction(projectId: string, evidenceId: string) {
  // NOT wrapped here: the service owns its contexts, with a full file download
  // and re-hash between them. See createFileEvidence.action.ts.
  return verifyFileEvidenceIntegrity(projectId, evidenceId);
}
