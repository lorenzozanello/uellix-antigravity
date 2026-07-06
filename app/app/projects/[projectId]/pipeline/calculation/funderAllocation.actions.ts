// app/app/projects/[projectId]/pipeline/calculation/funderAllocation.actions.ts
// Fase 1c — server actions for the funder catalog + funder↔outcome attribution.

'use server';

import { createFunderForCurrentOrganization } from '@/lib/pipeline/funders';
import { addOutcomeFunderAllocation, archiveOutcomeFunderAllocation } from '@/lib/pipeline/allocations';

export async function createFunderAction(formData: FormData) {
  const name = (formData.get('name') as string | null)?.trim();
  const funderType = formData.get('funderType') as string | null;
  if (!name) throw new Error('El nombre del financiador es obligatorio');
  return createFunderForCurrentOrganization({
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    funderType: (funderType || 'other') as any,
  });
}

export async function addAllocationAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  if (!projectId) throw new Error('projectId missing');
  return addOutcomeFunderAllocation(projectId, {
    outcomeId: formData.get('outcomeId') as string,
    funderId: formData.get('funderId') as string,
    allocationPct: formData.get('allocationPct') as string,
  });
}

export async function archiveAllocationAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const allocationId = formData.get('allocationId') as string;
  if (!projectId || !allocationId) throw new Error('Missing projectId or allocationId');
  return archiveOutcomeFunderAllocation(projectId, allocationId);
}
