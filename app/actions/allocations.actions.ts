// app/actions/allocations.actions.ts
'use server';

import {
  createAllocation,
  updateAllocation,
  deleteAllocation,
  listAllocations,
} from '@/lib/pipeline/outcome-funder-allocations';
import { runWithOrganizationAccess } from '@/lib/auth/session';

export async function listAllocationsAction(outcomeId: string) {
  return runWithOrganizationAccess(() => listAllocations(outcomeId));
}

export async function createAllocationAction(
  outcomeId: string,
  funderId: string,
  allocationPct: number
) {
  return runWithOrganizationAccess(() =>
    createAllocation(outcomeId, funderId, allocationPct)
  );
}

export async function updateAllocationAction(
  allocationId: string,
  allocationPct: number
) {
  return runWithOrganizationAccess(() => updateAllocation(allocationId, allocationPct));
}

export async function deleteAllocationAction(allocationId: string) {
  return runWithOrganizationAccess(() => deleteAllocation(allocationId));
}
