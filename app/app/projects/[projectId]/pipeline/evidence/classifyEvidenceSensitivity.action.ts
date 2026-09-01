// app/app/projects/[projectId]/pipeline/evidence/classifyEvidenceSensitivity.action.ts

'use server';

import { classifyEvidenceSensitivity } from '@/lib/pipeline/evidence';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { z } from 'zod';

// Reuse the same schema defined in lib/pipeline/evidence.ts
const InputSchema = z
  .object({
    sensitivityClassification: z.enum([
      'non_sensitive',
      'personal_data',
      'identifiable_restricted',
      'confidential_third_party',
      'special_category',
    ] as const),
    treatment: z
      .enum(['not_required', 'anonymized', 'pseudonymized', 'identifiable_restricted_access'] as const)
      .optional(),
  })
  .refine((data) => data.sensitivityClassification === 'non_sensitive' || data.treatment !== undefined, {
    message: 'treatment is required when sensitivityClassification is not non_sensitive',
    path: ['treatment'],
  });

export async function classifyEvidenceSensitivityAction(projectId: string, evidenceId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  return runWithOrganizationAccess(() =>
    classifyEvidenceSensitivity(projectId, evidenceId, input)
  );
}
