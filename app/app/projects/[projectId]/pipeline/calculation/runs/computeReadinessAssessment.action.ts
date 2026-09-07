// app/app/projects/[projectId]/pipeline/calculation/runs/computeReadinessAssessment.action.ts
'use server';

import { revalidatePath } from 'next/cache';
import { computeAndPersistReadinessAssessment } from '@/lib/pipeline/sroi-readiness';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17) — triggers the deterministic,
// system-only readiness computation for a run. No input is accepted from the
// caller beyond identity: the score itself is never supplied by a human or
// by Stella (FIBC-021 invariant).
export async function computeReadinessAssessmentAction(projectId: string, calculationRunId: string) {
  const result = await runWithOrganizationAccess(() =>
    computeAndPersistReadinessAssessment(projectId, calculationRunId)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${calculationRunId}`);
  return result;
}
