// app/app/projects/[projectId]/pipeline/calculation/runs/dispositionSensitivityCandidate.action.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { dispositionSensitivityCandidate } from '@/lib/pipeline/sroi-sensitivity';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — the ONLY authorized transition
// out of 'pending': variation_required | no_additional_variation_required,
// always with rationale. The service re-validates and enforces the
// approved-run refusal — this action only shapes form input. No Stella path
// reaches it (Stella never dispositions a candidate).
const InputSchema = z.object({
  disposition: z.enum(['variation_required', 'no_additional_variation_required']),
  rationale: z.string().min(1),
});

export async function dispositionSensitivityCandidateAction(projectId: string, candidateId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  const result = await runWithOrganizationAccess(() =>
    dispositionSensitivityCandidate(projectId, candidateId, input)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${result.calculationRunId}`);
  return result;
}
