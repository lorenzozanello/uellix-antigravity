// app/components/allocation-form/AllocationRow.tsx
'use client';

import { Trash2 } from 'lucide-react';

interface AllocationRowProps {
  id: string;
  funderName: string;
  allocationPct: number;
  onRemove: () => void;
  onPctChange: (newPct: number) => void;
  error?: string;
}

export function AllocationRow({
  id,
  funderName,
  allocationPct,
  onRemove,
  onPctChange,
  error,
}: AllocationRowProps) {
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value) || 0;
    onPctChange(val);
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{funderName}</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          value={allocationPct}
          onChange={handleInputChange}
          className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          placeholder="0"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">%</span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Eliminar asignación"
          title="Eliminar asignación"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {error && (
        <div className="absolute top-full mt-1 text-xs text-destructive whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
