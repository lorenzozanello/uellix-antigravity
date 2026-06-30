// app/app/projects/[projectId]/pipeline/calculation/upsertSroiAssignmentInput.action.ts

'use server';

import { z } from 'zod';
import { upsertSroiAssignmentInput } from '../../../../../../lib/pipeline/sroi-calculation';

// Validation schema for the incoming FormData
const AssignmentInputSchema = z.object({
  assignmentId: z.string().uuid(),
  quantity: z.string().min(1),
  unit: z.string().min(1),
  year: z.number().int().optional(),
  notes: z.string().optional(),
});

export async function upsertSroiAssignmentInputAction(formData: FormData) {
  const raw: Record<string, unknown> = {
    assignmentId: formData.get('assignmentId'),
    quantity: formData.get('quantity'),
    unit: formData.get('unit'),
    year: formData.get('year') ? Number(formData.get('year')) : undefined,
    notes: (formData.get('notes') as string | null) || undefined,
  };

  const parsed = AssignmentInputSchema.parse(raw);

  const projectId = formData.get('projectId') as string;
  if (!projectId) throw new Error('projectId missing');

  const result = await upsertSroiAssignmentInput(projectId, parsed.assignmentId, parsed);
  return result;
}
