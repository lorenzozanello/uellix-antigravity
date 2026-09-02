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
  // W2-B2-R1 / R-B2-02 (B2-AR-B2) — the FIBC-010 provenance items are
  // recordable on the ORGANIZATION surface from creation. Optional here
  // because FIBC-010 conditions them on reaching 'approved', not on
  // creation or on entering review (organization_provenance_requirements
  // .must_be_present_before_review: no additional pre-review gate).
  geographicContextualScope: z.string().optional(),
  linkedOutcomeContext: z.string().optional(),
  recoverableReference: z.string().optional(),
  relevanceJustification: z.string().optional(),
  documentedTransformations: z.string().optional(),
  consultationDate: z.string().optional(),
});

export async function createFinancialProxyAction(projectId: string, input: unknown) {
  // Validate input
  const data = financialProxySchema.parse(input);
  // The underlying function reads the organisation from the context below.
  return runWithOrganizationAccess(() => createOrganizationFinancialProxy(data));
}
