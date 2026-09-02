// app/app/projects/[projectId]/pipeline/proxies/createFinancialProxy.action.ts
'use server';
import { z } from 'zod';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { createOrganizationFinancialProxy } from '@/lib/pipeline/proxies';

const financialProxySchema = z.object({
  sourceId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  proxyType: z.string().optional(),
  country: z.string().length(2).optional(),
  territory: z.string().optional(),
  currency: z.string().min(1),
  value: z.string(),
  unit: z.string().min(1),
  referenceYear: z.number().int().positive(),
  thematicArea: z.string().optional(),
  methodology: z.string().optional(),
  confidenceLevel: z.enum(['high', 'medium', 'low']).optional(),
  methodologicalRisk: z.enum(['low', 'medium', 'high']).optional(),
});

export async function createFinancialProxyAction(projectId: string, input: unknown) {
  // Validate input
  const data = financialProxySchema.parse(input);
  // The underlying function reads the organisation from the context below.
  return runWithOrganizationAccess(() => createOrganizationFinancialProxy(data));
}
