// app/app/projects/[projectId]/pipeline/proxies/assignProxyToOutcome.action.ts
'use server';
import { z } from 'zod';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { assignProxyToOutcome } from '@/lib/pipeline/proxies';

// Validation schema matching ProxyAssignmentInput in proxies.ts
const proxyAssignmentSchema = z.object({
  outcomeId: z.string().uuid(),
  proxyId: z.string().uuid(),
  justification: z.string().min(1),
  territorialAdjustmentNotes: z.string().optional(),
});

export async function assignProxyToOutcomeAction(projectId: string, input: unknown) {
  // Ensure the user has access to the organization
  await requireOrganizationAccess();
  const data = proxyAssignmentSchema.parse(input);
  // Delegate to the core service function which handles ownership and visibility checks
  return await assignProxyToOutcome(projectId, data);
}
