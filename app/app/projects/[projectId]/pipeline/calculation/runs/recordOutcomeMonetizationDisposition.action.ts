// app/app/projects/[projectId]/pipeline/calculation/runs/recordOutcomeMonetizationDisposition.action.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { MONETIZATION_REASON_VALUES, recordOutcomeMonetizationDisposition } from '@/lib/pipeline/sroi-calculation';
import { runWithOrganizationAccess } from '@/lib/auth/session';

// FIBIU-12 (FIBC-016, W2-B3 completeness) — the HUMAN per-outcome, per-run
// monetization disposition. Mirrors OutcomeMonetizationDispositionSchema in
// lib/pipeline/sroi-calculation.ts; the service re-validates, checks the
// approved-run state, and enforces disposition/engine consistency — this
// action only shapes form input. No Stella path reaches it (Stella explains
// exclusions, never decides them).
const InputSchema = z.object({
  disposition: z.enum(['monetized', 'not_monetized']),
  reason: z.enum(MONETIZATION_REASON_VALUES).optional(),
  justification: z.string().min(1).optional(),
});

export async function recordOutcomeMonetizationDispositionAction(
  projectId: string,
  outcomeId: string,
  calculationRunId: string,
  rawInput: unknown,
) {
  const input = InputSchema.parse(rawInput);
  const result = await runWithOrganizationAccess(() =>
    recordOutcomeMonetizationDisposition(projectId, outcomeId, calculationRunId, input)
  );
  revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${calculationRunId}`);
  return result;
}
