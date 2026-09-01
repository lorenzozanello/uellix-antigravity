// app/app/projects/[projectId]/pipeline/proxies/evaluateProxyRubric.action.ts
// FIBIU-09 (FIBC-011) — governed rubric evaluation. The projectId parameter
// is accepted for routing symmetry with the other actions on this page but
// is not otherwise used: a proxy is org-scoped, not project-scoped, exactly
// like updateFinancialProxyReviewStatusAction above it.
'use server';
import { z } from 'zod';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { recordProxyRubricEvaluation } from '@/lib/pipeline/financial-proxy-rubric';

const factor = z.coerce.number().int().min(0).max(3);

const rubricEvaluationSchema = z.object({
  proxyId: z.string().uuid(),
  c1SourceQualityVerifiability: factor,
  c2OutcomeCorrespondence: factor,
  c3StakeholderPopulationFit: factor,
  c4GeographicContextFit: factor,
  c5TemporalFit: factor,
  c6MethodologicalUnitComparability: factor,
  r1ProvenanceRisk: factor,
  r2SourceLimitationRisk: factor,
  r3ConceptualFitRisk: factor,
  r4GeographicPopulationTransferRisk: factor,
  r5TemporalObsolescenceRisk: factor,
  r6TransformationRisk: factor,
  r7MethodologicalUncertaintyRisk: factor,
  rationale: z.string().min(1),
  exceptionalDefendibilityDetermination: z.string().optional(),
});

export async function evaluateProxyRubricAction(_projectId: string, input: unknown) {
  const { proxyId, ...rest } = rubricEvaluationSchema.parse(input);
  // The underlying function checks permissions.
  return runWithOrganizationAccess(() => recordProxyRubricEvaluation(proxyId, rest));
}
