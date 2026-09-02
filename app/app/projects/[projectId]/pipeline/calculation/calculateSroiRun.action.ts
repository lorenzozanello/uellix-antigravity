// app/app/projects/[projectId]/pipeline/calculation/calculateSroiRun.action.ts

'use server';

import { z } from 'zod';
import { calculateAndPersistSroiRun } from '../../../../../../lib/pipeline/sroi-calculation';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { AuthContextError } from '@/lib/auth/database-context';
import { rethrowNextControlFlow } from '@/lib/errors/next-control-flow';

const RunSchema = z.object({
  projectId: z.string().uuid(),
});

export async function calculateSroiRunAction(formData: FormData) {
  const raw: Record<string, unknown> = {
    projectId: formData.get('projectId'),
  };

  const parsed = RunSchema.parse(raw);

  try {
    const result = await runWithOrganizationAccess(() =>
      calculateAndPersistSroiRun(parsed.projectId)
    );
    return { success: true, runId: result.run.id, lineItemsCount: result.lineItems.length };
  } catch (err) {
    // `runWithOrganizationAccess` redirects an expired session to /login, and
    // `redirect()` throws. Without this the user would get a toast reading
    // "NEXT_REDIRECT" on a page that never navigates.
    rethrowNextControlFlow(err);

    // Authorisation refusals carry internal prose that is not for the UI.
    if (err instanceof AuthContextError) {
      return { success: false, error: 'No tenés acceso a esta organización.' };
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}
