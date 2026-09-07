// app/app/projects/[projectId]/pipeline/calculation/runs/recordSensitivityScenario.action.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { recordSensitivityScenario, SCENARIO_KIND_VALUES } from '@/lib/pipeline/sroi-sensitivity';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — records a governed scenario
// for one or more variation_required candidates, executed through the same
// deterministic engine the base run used. The service re-validates
// scenario-kind cardinality, requires combination_description for
// 'combined', and enforces the approved-run refusal.
const InputSchema = z.object({
  scenarioKind: z.enum(SCENARIO_KIND_VALUES),
  substitutions: z.array(z.object({ candidateId: z.string().uuid(), alternativeValue: z.string().min(1) })).min(1),
  reason: z.string().min(1),
  sources: z.string().optional(),
  combinationDescription: z.string().optional(),
});

export async function recordSensitivityScenarioAction(projectId: string, calculationRunId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput);
  const result = await runWithOrganizationAccess(() =>
    recordSensitivityScenario(projectId, calculationRunId, input)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${calculationRunId}`);
  return result;
}
