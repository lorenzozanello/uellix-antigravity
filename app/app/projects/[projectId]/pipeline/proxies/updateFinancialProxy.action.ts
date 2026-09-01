// app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxy.action.ts
// FIBIU-10 (FIBC-013) — the projectId parameter is accepted for routing
// symmetry with the other actions on this page but is not otherwise used: a
// proxy is org-scoped, not project-scoped.
'use server';
import { z } from 'zod';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { updateOrganizationFinancialProxy } from '@/lib/pipeline/proxies';

const financialProxyPatchSchema = z.object({
  sourceId: z.string().uuid().optional(),
  value: z.string().optional(),
  currency: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  referenceYear: z.number().int().positive().optional(),
});

export async function updateFinancialProxyAction(_projectId: string, proxyId: string, input: unknown) {
  const data = financialProxyPatchSchema.parse(input);
  return runWithOrganizationAccess(() => updateOrganizationFinancialProxy(proxyId, data));
}
