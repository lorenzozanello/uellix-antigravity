// app/components/allocation-form/OutcomeAllocationWrapper.tsx

import { OutcomeAllocationSection } from './OutcomeAllocationSection';
import { listAllocationsAction, createAllocationAction, updateAllocationAction, deleteAllocationAction } from '@/app/actions/allocations.actions';
import { listFundersForCurrentOrganization } from '@/lib/pipeline/funders';

interface Funder {
  id: string;
  name: string;
}

interface OutcomeAllocationWrapperProps {
  outcomeId: string;
  projectId: string;
}

export async function OutcomeAllocationWrapper({
  outcomeId,
  projectId,
}: OutcomeAllocationWrapperProps) {
  // Fetch funders server-side
  const fundersData = await listFundersForCurrentOrganization();
  const funders = fundersData.map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));

  if (!funders || funders.length === 0) {
    return null;
  }

  return (
    <OutcomeAllocationSection
      outcomeId={outcomeId}
      projectId={projectId}
      funders={funders}
      listAllocations={listAllocationsAction}
      createAllocation={createAllocationAction}
      updateAllocation={updateAllocationAction}
      deleteAllocation={deleteAllocationAction}
    />
  );
}
