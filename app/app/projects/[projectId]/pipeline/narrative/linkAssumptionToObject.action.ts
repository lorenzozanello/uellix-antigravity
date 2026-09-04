// app/app/projects/[projectId]/pipeline/narrative/linkAssumptionToObject.action.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES, linkAssumptionToObject } from '@/lib/pipeline/narratives';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-15 (FIBC-019, FIBDB-013, W2-B4, HPO-ODS-W2-12) — records what an
// assumption affects. A material assumption with zero such links is
// UNRESOLVED (see getSroiCalculationReadiness's ASSUMPTION_UNRESOLVED
// signal). NOT reusable for any other purpose (FIBDB-054 discretion sweep).
const InputSchema = z.object({
  affectedObjectType: z.enum(ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES),
  affectedObjectId: z.string().uuid(),
});

export async function linkAssumptionToObjectAction(
  projectId: string,
  assumptionId: string,
  rawInput: unknown,
) {
  const input = InputSchema.parse(rawInput)
  const result = await runWithOrganizationAccess(() =>
    linkAssumptionToObject(projectId, assumptionId, input.affectedObjectType, input.affectedObjectId)
  )
  revalidatePath(`/app/projects/${projectId}/pipeline/narrative`)
  return result
}
