// app/app/projects/[projectId]/pipeline/proxies/archiveOutcomeProxyAssignment.action.ts
'use server';
import { z } from 'zod';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { archiveOutcomeProxyAssignment } from '@/lib/pipeline/proxies';

const archiveSchema = z.object({
  assignmentId: z.string().uuid()
});

export async function archiveOutcomeProxyAssignmentAction(projectId: string, input: unknown) {
  // Ensure the user has organization access
  await requireOrganizationAccess();
  const data = archiveSchema.parse(input);
  // Delegate to the core service which handles ownership checks and logical archiving
  return await archiveOutcomeProxyAssignment(projectId, data.assignmentId);
}
