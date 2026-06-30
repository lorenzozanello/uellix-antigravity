// app/app/projects/[projectId]/pipeline/calculation/calculateSroiRun.action.ts

'use server';

import { z } from 'zod';
import { calculateAndPersistSroiRun } from '../../../../../../lib/pipeline/sroi-calculation';

const RunSchema = z.object({
  projectId: z.string().uuid(),
});

export async function calculateSroiRunAction(formData: FormData) {
  const raw: Record<string, unknown> = {
    projectId: formData.get('projectId'),
  };

  const parsed = RunSchema.parse(raw);

  try {
    const result = await calculateAndPersistSroiRun(parsed.projectId);
    return { success: true, runId: result.run.id, lineItemsCount: result.lineItems.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}
