// app/components/allocation-form/OutcomeAllocationWrapper.tsx
//
// Pure presentational wrapper: funders are loaded by the page inside its
// already-open identity context and arrive as props. This component must not
// touch the database — as a streamed server component it would render outside
// any identity context and RLS would silently return zero rows.

import { OutcomeAllocationSection } from './OutcomeAllocationSection';
import { listAllocationsAction, createAllocationAction, updateAllocationAction, deleteAllocationAction } from '@/app/actions/allocations.actions';

interface Funder {
  id: string;
  name: string;
}

interface OutcomeAllocationWrapperProps {
  outcomeId: string;
  projectId: string;
  funders: Funder[];
}

export function OutcomeAllocationWrapper({
  outcomeId,
  projectId,
  funders,
}: OutcomeAllocationWrapperProps) {
  if (funders.length === 0) {
    return (
      <div className="mt-3 rounded-md border border-dashed border-border/60 bg-muted/20 p-3">
        <p className="text-xs font-medium text-foreground">Asignación por financiador</p>
        <p className="mt-1 text-xs text-muted-foreground">
          No hay financiadores registrados en la organización. Registra al menos un
          financiador para asignar porcentajes de este resultado.
        </p>
      </div>
    );
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
