// app/app/projects/[projectId]/pipeline/evidence/requestEvidenceErasure.action.ts

'use server';

import { requestGovernedEvidenceErasure } from '@/lib/pipeline/evidence';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { z } from 'zod';

// Reuse the same schema defined in lib/pipeline/evidence.ts
const InputSchema = z.object({
  erasureReason: z.enum([
    'privacy_or_data_subject_request',
    'retention_policy',
    'unauthorized_or_erroneous_upload',
    'confidentiality_or_access_violation',
    'legal_or_contractual_requirement',
    'other_governed_reason',
  ] as const),
  rationale: z.string().min(1),
});

export async function requestEvidenceErasureAction(projectId: string, evidenceId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  return runWithOrganizationAccess(() =>
    requestGovernedEvidenceErasure(projectId, evidenceId, input)
  );
}
