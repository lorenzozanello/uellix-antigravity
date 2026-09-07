// app/app/projects/[projectId]/pipeline/narrative/createMethodologicalAssumption.action.ts
'use server';

import { revalidatePath } from 'next/cache';
import { MethodologicalAssumptionSchema, recordMethodologicalAssumption } from '@/lib/pipeline/narratives';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-15 (FIBC-019, W2-B4, HPO-ODS-W2-12) — create a first-class
// structured methodological assumption. The service re-validates and
// enforces the conditional provenanceReference requirement (FIBDB-047);
// this action only shapes form input. No Stella path reaches it — Stella
// may propose a formulation for human review, never create an authoritative
// assumption itself.
export async function createMethodologicalAssumptionAction(projectId: string, rawInput: unknown) {
  const input = MethodologicalAssumptionSchema.parse(rawInput)
  const result = await runWithOrganizationAccess(() => recordMethodologicalAssumption(projectId, input))
  revalidatePath(`/app/projects/${projectId}/pipeline/narrative`)
  return result
}
