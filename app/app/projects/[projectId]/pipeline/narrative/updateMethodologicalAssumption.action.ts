// app/app/projects/[projectId]/pipeline/narrative/updateMethodologicalAssumption.action.ts
'use server';

import { revalidatePath } from 'next/cache';
import { MethodologicalAssumptionSchema, updateMethodologicalAssumption } from '@/lib/pipeline/narratives';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-15 (FIBC-019, W2-B4, HPO-ODS-W2-12) — a material modification. The
// service refuses the write (never silently re-points) when the assumption
// affects the inputs of an already-APPROVED calculation run — a new run is
// required instead. No Stella path reaches it — Stella never modifies or
// declares an assumption sufficiently defensible; only a human action does.
export async function updateMethodologicalAssumptionAction(
  projectId: string,
  assumptionId: string,
  rawInput: unknown,
) {
  const input = MethodologicalAssumptionSchema.parse(rawInput)
  const result = await runWithOrganizationAccess(() =>
    updateMethodologicalAssumption(projectId, assumptionId, input)
  )
  revalidatePath(`/app/projects/${projectId}/pipeline/narrative`)
  return result
}
