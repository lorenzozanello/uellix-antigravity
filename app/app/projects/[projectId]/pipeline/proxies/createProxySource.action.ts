// app/app/projects/[projectId]/pipeline/proxies/createProxySource.action.ts
'use server';
import { z } from 'zod';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { createOrganizationProxySource } from '@/lib/pipeline/proxies';

export async function createProxySourceAction(projectId: string, input: unknown) {
  // Ensure the user has organization access
  await requireOrganizationAccess();
  const data = proxySourceSchema.parse(input);
  // Underlying function handles organization context
  return await createOrganizationProxySource(data);
}

const proxySourceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url().optional().or(z.literal('')),
});
