// app/components/allocation-form/AllocationList.tsx
'use client';

import { useState, useCallback } from 'react';
import { AllocationRow } from './AllocationRow';
import { ChevronDown } from 'lucide-react';
import Decimal from 'decimal.js';

interface Allocation {
  id: string;
  funderId: string;
  funderName: string;
  allocationPct: number;
}

interface FunderOption {
  id: string;
  name: string;
}

interface AllocationListProps {
  outcomeId: string;
  allocations: Allocation[];
  availableFunders: FunderOption[];
  onAdd: (funderId: string, pct: number) => Promise<void>;
  onUpdate: (allocationId: string, pct: number) => Promise<void>;
  onRemove: (allocationId: string) => Promise<void>;
  isLoading?: boolean;
}

export function AllocationList({
  outcomeId,
  allocations,
  availableFunders,
  onAdd,
  onUpdate,
  onRemove,
  isLoading = false,
}: AllocationListProps) {
  const [localAllocations, setLocalAllocations] = useState<Allocation[]>(allocations);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Recalculate remaining % based on local state
  const totalPct = localAllocations.reduce((acc, a) => acc + a.allocationPct, 0);
  const remainingPct = 100 - totalPct;

  // Get funders not yet allocated
  const allocatedFunderIds = new Set(localAllocations.map(a => a.funderId));
  const unallocatedFunders = availableFunders.filter(f => !allocatedFunderIds.has(f.id));

  // Handle percentage change
  const handlePctChange = useCallback(
    async (allocationId: string, newPct: number) => {
      setError(null);

      // Validation: check if this would exceed 100%
      const allocationToUpdate = localAllocations.find(a => a.id === allocationId);
      if (!allocationToUpdate) return;

      const othersPct = localAllocations
        .filter(a => a.id !== allocationId)
        .reduce((acc, a) => acc + a.allocationPct, 0);

      if (newPct > 0 && othersPct + newPct > 100) {
        setError(`No se puede asignar ${newPct}%. Máximo disponible: ${new Decimal(100 - othersPct).toFixed(2)}%`);
        return;
      }

      // Update local state optimistically
      setLocalAllocations(prev =>
        prev.map(a => (a.id === allocationId ? { ...a, allocationPct: newPct } : a))
      );

      // Call the server action
      try {
        await onUpdate(allocationId, newPct);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error updating allocation');
        // Revert on error
        setLocalAllocations(allocations);
      }
    },
    [localAllocations, allocations, onUpdate]
  );

  // Handle remove
  const handleRemove = useCallback(
    async (allocationId: string) => {
      setError(null);
      const removedAllocation = localAllocations.find(a => a.id === allocationId);
      if (!removedAllocation) return;

      // Update local state optimistically
      setLocalAllocations(prev => prev.filter(a => a.id !== allocationId));

      try {
        await onRemove(allocationId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error removing allocation');
        // Revert on error
        setLocalAllocations(allocations);
      }
    },
    [localAllocations, allocations, onRemove]
  );

  // Handle add allocation
  const handleAddFunder = useCallback(
    async (funderId: string) => {
      setError(null);
      setIsAdding(true);
      setDropdownOpen(false);

      const funder = availableFunders.find(f => f.id === funderId);
      if (!funder) return;

      try {
        // Add with 0% default
        await onAdd(funderId, 0);
        // Update local state
        setLocalAllocations(prev => [
          ...prev,
          { id: '', funderId, funderName: funder.name, allocationPct: 0 },
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error adding allocation');
      } finally {
        setIsAdding(false);
      }
    },
    [availableFunders, onAdd]
  );

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-medium text-foreground mb-4">Asignación de impacto por financiador</h3>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/20 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Allocation rows */}
      <div className="space-y-2 mb-4">
        {localAllocations.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            Sin asignaciones. Haz clic en "Agregar financiador" para empezar.
          </p>
        ) : (
          localAllocations.map(alloc => (
            <AllocationRow
              key={alloc.id}
              id={alloc.id}
              funderName={alloc.funderName}
              allocationPct={alloc.allocationPct}
              onRemove={() => handleRemove(alloc.id)}
              onPctChange={(pct) => handlePctChange(alloc.id, pct)}
            />
          ))
        )}
      </div>

      {/* Remaining % indicator */}
      <div className="mb-4 flex items-center gap-2">
        <span className={`text-sm font-medium ${remainingPct > 0 ? 'text-muted-foreground' : remainingPct === 0 ? 'text-foreground' : 'text-destructive'}`}>
          % sin asignar: <span className="tabular-nums">{new Decimal(remainingPct).toFixed(2)}%</span>
        </span>
        {remainingPct < 0 && (
          <span className="text-xs text-destructive font-semibold">¡Excede 100%!</span>
        )}
      </div>

      {/* Add funder dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          disabled={isLoading || isAdding || unallocatedFunders.length === 0}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Agregar asignación
          <ChevronDown className={`h-4 w-4 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>

        {dropdownOpen && unallocatedFunders.length > 0 && (
          <div className="absolute top-full left-0 mt-1 w-48 rounded-md border border-border bg-card shadow-md z-10">
            {unallocatedFunders.map(funder => (
              <button
                key={funder.id}
                type="button"
                onClick={() => handleAddFunder(funder.id)}
                className="block w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted first:rounded-t-md last:rounded-b-md transition-colors"
              >
                {funder.name}
              </button>
            ))}
          </div>
        )}

        {unallocatedFunders.length === 0 && localAllocations.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Todos los financiadores están asignados.
          </p>
        )}
      </div>
    </div>
  );
}
