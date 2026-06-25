// app/app/projects/[projectId]/pipeline/calculation/upsertSroiFilterSet.action.ts

'use server';

import { z } from 'zod';
import { upsertSroiFilterSet } from '../../../../../../lib/pipeline/sroi-calculation';

// Validation schema for the incoming FormData
const FilterSetSchema = z.object({
  assignmentId: z.string().uuid(),
  deadweightPct: z.string().optional(),
  displacementPct: z.string().optional(),
  attributionPct: z.string().optional(),
  dropoffPct: z.string().optional(),
  durationYears: z.number().int().optional(),
  justification: z.string().optional(),
});

export async function upsertSroiFilterSetAction(formData: FormData) {
  const raw: Record<string, unknown> = {
    assignmentId: formData.get('assignmentId'),
    deadweightPct: (formData.get('deadweightPct') as string | null) || undefined,
    displacementPct: (formData.get('displacementPct') as string | null) || undefined,
    attributionPct: (formData.get('attributionPct') as string | null) || undefined,
    dropoffPct: (formData.get('dropoffPct') as string | null) || undefined,
    durationYears: formData.get('durationYears') ? Number(formData.get('durationYears')) : undefined,
    justification: (formData.get('justification') as string | null) || undefined,
  };

  const parsed = FilterSetSchema.parse(raw);

  const projectId = formData.get('projectId') as string;
  if (!projectId) throw new Error('projectId missing');

  const result = await upsertSroiFilterSet(projectId, parsed.assignmentId, parsed);
  return result;
}
