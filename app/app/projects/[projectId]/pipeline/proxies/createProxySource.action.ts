// app/app/projects/[projectId]/pipeline/proxies/createProxySource.action.ts
'use server';
import { z } from 'zod';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { createOrganizationProxySource } from '@/lib/pipeline/proxies';

export async function createProxySourceAction(projectId: string, input: unknown) {
  const data = proxySourceSchema.parse(input);
  // Auth + identity context in one step; the service reads the org from it.
  return runWithOrganizationAccess(() => createOrganizationProxySource(data));
}

const proxySourceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url().optional().or(z.literal('')),
});
