// app/actions/allocations.actions.ts
'use server';

import {
  createAllocation,
  updateAllocation,
  deleteAllocation,
  listAllocations,
} from '@/lib/pipeline/outcome-funder-allocations';

export async function listAllocationsAction(outcomeId: string) {
  return listAllocations(outcomeId);
}

export async function createAllocationAction(
  outcomeId: string,
  funderId: string,
  allocationPct: number
) {
  return createAllocation(outcomeId, funderId, allocationPct);
}

export async function updateAllocationAction(
  allocationId: string,
  allocationPct: number
) {
  return updateAllocation(allocationId, allocationPct);
}

export async function deleteAllocationAction(allocationId: string) {
  return deleteAllocation(allocationId);
}
