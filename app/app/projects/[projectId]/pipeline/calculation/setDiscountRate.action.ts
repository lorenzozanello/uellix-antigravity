// app/app/projects/[projectId]/pipeline/calculation/setDiscountRate.action.ts
// Fase 1e — set the project-level annual discount rate for present-valuing
// multi-year outcomes.

'use server';

import { setProjectDiscountRate } from '@/lib/pipeline/sroi-calculation';

export async function setDiscountRateAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  if (!projectId) throw new Error('projectId missing');
  const raw = (formData.get('discountRatePct') as string | null)?.trim() ?? '';
  return setProjectDiscountRate(projectId, raw === '' ? null : raw);
}
