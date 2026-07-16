// app/components/allocation-form/OutcomeAllocationSection.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { AllocationList } from './AllocationList';
import { ChevronDown } from 'lucide-react';

interface Funder {
  id: string;
  name: string;
}

interface OutcomeAllocationSectionProps {
  outcomeId: string;
  projectId: string;
  funders: Funder[];
  listAllocations: (outcomeId: string) => Promise<{ id: string; funderId: string; allocationPct: string | number }[]>;
  createAllocation: (outcomeId: string, funderId: string, pct: number) => Promise<unknown>;
  updateAllocation: (allocationId: string, pct: number) => Promise<unknown>;
  deleteAllocation: (allocationId: string) => Promise<unknown>;
}

interface Allocation {
  id: string;
  funderId: string;
  funderName: string;
  allocationPct: number;
}

export function OutcomeAllocationSection({
  outcomeId,
  projectId,
  funders,
  listAllocations,
  createAllocation,
  updateAllocation,
  deleteAllocation,
}: OutcomeAllocationSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAllocationsData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await listAllocations(outcomeId);
      setAllocations(
        results.map((alloc) => ({
          id: alloc.id,
          funderId: alloc.funderId,
          funderName: funders.find(f => f.id === alloc.funderId)?.name || alloc.funderId,
          allocationPct: parseFloat(alloc.allocationPct.toString()),
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading allocations');
    } finally {
      setIsLoading(false);
    }
  }, [outcomeId, funders, listAllocations]);

  useEffect(() => {
    if (isExpanded && allocations.length === 0 && !isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadAllocationsData();
    }
  }, [isExpanded, allocations.length, isLoading, loadAllocationsData]);

  const handleAddAllocation = async (funderId: string, pct: number) => {
    try {
      await createAllocation(outcomeId, funderId, pct);
      await loadAllocationsData();
    } catch (err) {
      throw err;
    }
  };

  const handleUpdateAllocation = async (allocationId: string, pct: number) => {
    try {
      await updateAllocation(allocationId, pct);
      // Reload to ensure consistency
      await loadAllocationsData();
    } catch (err) {
      throw err;
    }
  };

  const handleRemoveAllocation = async (allocationId: string) => {
    try {
      await deleteAllocation(allocationId);
      // Reload to ensure consistency
      await loadAllocationsData();
    } catch (err) {
      throw err;
    }
  };

  return (
    <div className="mt-4 space-y-3">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        Asignación de impacto por financiador
      </button>

      {isExpanded && (
        <div className="ml-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground italic">Cargando...</div>
          ) : (
            <AllocationList
              outcomeId={outcomeId}
              allocations={allocations}
              availableFunders={funders}
              onAdd={handleAddAllocation}
              onUpdate={handleUpdateAllocation}
              onRemove={handleRemoveAllocation}
            />
          )}
          {error && (
            <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/10 p-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
