// app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxy.action.ts
// FIBIU-10 (FIBC-013) — the projectId parameter is accepted for routing
// symmetry with the other actions on this page but is not otherwise used: a
// proxy is org-scoped, not project-scoped.
//
// W2-B2-R1 / R-B2-02 (B2-AR-B2) — the patch schema accepts ALL ELEVEN
// FIBC-010 items (organization_provenance_requirements), so every one of
// them is patchable on the organization surface, not only the five legacy
// keys. Every key here is user_editable in the material-field registry;
// system-derived / system-sealed columns (value_usd, fx_rate_id,
// review_status, reviewer_id, reviewed_at, ...) are deliberately NOT
// accepted — the service layer additionally rejects them by name.
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
  geographicContextualScope: z.string().optional(),
  linkedOutcomeContext: z.string().optional(),
  recoverableReference: z.string().optional(),
  relevanceJustification: z.string().optional(),
  documentedTransformations: z.string().optional(),
  consultationDate: z.string().optional(),
});

export async function updateFinancialProxyAction(_projectId: string, proxyId: string, input: unknown) {
  const data = financialProxyPatchSchema.parse(input);
  return runWithOrganizationAccess(() => updateOrganizationFinancialProxy(proxyId, data));
}
