// app/app/projects/[projectId]/pipeline/calculation/runs/registerSensitivityCandidates.action.ts
'use server';

import { revalidatePath } from 'next/cache';
import { registerSensitivityCandidates } from '@/lib/pipeline/sroi-sensitivity';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — deterministically builds the
// candidate register from the run's actually-used inputs. Idempotent: an
// already-registered candidate (same run + candidate_key) is never
// duplicated or re-created.
export async function registerSensitivityCandidatesAction(projectId: string, calculationRunId: string) {
  const result = await runWithOrganizationAccess(() =>
    registerSensitivityCandidates(projectId, calculationRunId)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${calculationRunId}`);
  return result;
}
