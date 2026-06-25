// app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxyReviewStatus.action.ts
'use server';
import { z } from 'zod';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { updateFinancialProxyReviewStatus } from '@/lib/pipeline/proxies';

const reviewStatusSchema = z.object({
  proxyId: z.string().uuid(),
  newStatus: z.enum(['suggested', 'pending_review', 'approved', 'rejected', 'archived']),
});

export async function updateFinancialProxyReviewStatusAction(projectId: string, input: unknown) {
  // Ensure organization access
  await requireOrganizationAccess();
  const data = reviewStatusSchema.parse(input);
  // The underlying function checks permissions and status validity
  return await updateFinancialProxyReviewStatus(data.proxyId, data.newStatus);
}
