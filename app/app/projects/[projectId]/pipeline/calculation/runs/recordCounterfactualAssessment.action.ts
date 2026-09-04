// app/app/projects/[projectId]/pipeline/calculation/runs/recordCounterfactualAssessment.action.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  COUNTERFACTUAL_BASELINE_AVAILABILITY_VALUES,
  COUNTERFACTUAL_BASIS_KIND_VALUES,
  DEADWEIGHT_SUPPORT_STATE_VALUES,
  recordCounterfactualAssessment,
} from '@/lib/pipeline/sroi-calculation';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-14 (FIBC-018, W2-B4, HPO-ODS-W2-12) — the counterfactual/deadweight
// basis per monetized outcome per run. Mirrors CounterfactualAssessmentSchema
// in lib/pipeline/sroi-calculation.ts; the service re-validates, checks the
// approved-run state, and enforces the conditional baseline-field
// requirement — this action only shapes form input. No Stella path reaches
// it (Stella analyzes and proposes, never sets or approves deadweight).
const InputSchema = z.object({
  baselineAvailability: z.enum(COUNTERFACTUAL_BASELINE_AVAILABILITY_VALUES),
  basisKind: z.enum(COUNTERFACTUAL_BASIS_KIND_VALUES),
  baselineValue: z.string().min(1).optional(),
  baselinePeriod: z.string().min(1).optional(),
  baselineSource: z.string().min(1).optional(),
  baselineContext: z.string().min(1).optional(),
  deadweightSupportState: z.enum(DEADWEIGHT_SUPPORT_STATE_VALUES),
  sources: z.string().optional(),
  rationale: z.string().min(1),
});

export async function recordCounterfactualAssessmentAction(
  projectId: string,
  outcomeId: string,
  calculationRunId: string,
  rawInput: unknown,
) {
  const input = InputSchema.parse(rawInput);
  const result = await runWithOrganizationAccess(() =>
    recordCounterfactualAssessment(projectId, outcomeId, calculationRunId, input)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${calculationRunId}`);
  return result;
}
