// app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxyReviewStatus.action.ts
'use server';
import { z } from 'zod';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { updateFinancialProxyReviewStatus } from '@/lib/pipeline/proxies';

const reviewStatusSchema = z.object({
  proxyId: z.string().uuid(),
  newStatus: z.enum(['suggested', 'pending_review', 'approved', 'rejected', 'archived']),
});

export async function updateFinancialProxyReviewStatusAction(projectId: string, input: unknown) {
  const data = reviewStatusSchema.parse(input);
  // The underlying function checks permissions and status validity
  return runWithOrganizationAccess(() =>
    updateFinancialProxyReviewStatus(data.proxyId, data.newStatus)
  );
}
