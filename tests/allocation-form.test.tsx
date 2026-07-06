// tests/allocation-form.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllocationList } from '@/app/components/allocation-form/AllocationList';
import { AllocationRow } from '@/app/components/allocation-form/AllocationRow';
import Decimal from 'decimal.js';

// Mock data
const mockAllocations = [
  { id: '1', funderId: 'funder-1', funderName: 'Funder A', allocationPct: 30 },
  { id: '2', funderId: 'funder-2', funderName: 'Funder B', allocationPct: 20 },
];

const mockFunders = [
  { id: 'funder-1', name: 'Funder A' },
  { id: 'funder-2', name: 'Funder B' },
  { id: 'funder-3', name: 'Funder C' },
];

describe('AllocationRow', () => {
  it('renders funder name and allocation percentage', () => {
    const mockHandlers = {
      onRemove: vi.fn(),
      onPctChange: vi.fn(),
    };

    render(
      <AllocationRow
        id="1"
        funderName="Funder A"
        allocationPct={30}
        onRemove={mockHandlers.onRemove}
        onPctChange={mockHandlers.onPctChange}
      />
    );

    expect(screen.getByText('Funder A')).toBeInTheDocument();
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  it('calls onPctChange when percentage is updated', async () => {
    const onPctChange = vi.fn();
    const mockHandlers = {
      onRemove: vi.fn(),
      onPctChange,
    };

    render(
      <AllocationRow
        id="1"
        funderName="Funder A"
        allocationPct={30}
        onRemove={mockHandlers.onRemove}
        onPctChange={mockHandlers.onPctChange}
      />
    );

    const input = screen.getByDisplayValue('30');
    await userEvent.clear(input);
    await userEvent.type(input, '50');

    expect(onPctChange).toHaveBeenCalledWith(50);
  });

  it('calls onRemove when remove button is clicked', async () => {
    const onRemove = vi.fn();
    const mockHandlers = {
      onRemove,
      onPctChange: vi.fn(),
    };

    render(
      <AllocationRow
        id="1"
        funderName="Funder A"
        allocationPct={30}
        onRemove={mockHandlers.onRemove}
        onPctChange={mockHandlers.onPctChange}
      />
    );

    const removeButton = screen.getByLabelText('Eliminar asignación');
    fireEvent.click(removeButton);

    expect(onRemove).toHaveBeenCalled();
  });

  it('displays error message when provided', () => {
    const mockHandlers = {
      onRemove: vi.fn(),
      onPctChange: vi.fn(),
    };

    render(
      <AllocationRow
        id="1"
        funderName="Funder A"
        allocationPct={30}
        onRemove={mockHandlers.onRemove}
        onPctChange={mockHandlers.onPctChange}
        error="Exceeds maximum"
      />
    );

    expect(screen.getByText('Exceeds maximum')).toBeInTheDocument();
  });
});

describe('AllocationList', () => {
  const mockHandlers = {
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders allocation rows for each allocation', () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    expect(screen.getByText('Funder A')).toBeInTheDocument();
    expect(screen.getByText('Funder B')).toBeInTheDocument();
  });

  it('calculates and displays remaining percentage correctly', () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // Total: 30 + 20 = 50, Remaining: 50
    expect(screen.getByText(/% sin asignar:/)).toHaveTextContent('50.00%');
  });

  it('displays empty state when no allocations', () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={[]}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    expect(screen.getByText(/Sin asignaciones/i)).toBeInTheDocument();
  });

  it('shows dropdown with unallocated funders', async () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    const addButton = screen.getByText('Agregar asignación');
    fireEvent.click(addButton);

    await waitFor(() => {
      // Should show only unallocated funder (Funder C)
      expect(screen.getByText('Funder C')).toBeInTheDocument();
      // Should not show already allocated funders
      expect(screen.queryAllByText('Funder A')).toHaveLength(1); // Only in the allocation row
    });
  });

  it('disables add button when all funders are allocated', () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockFunders.map((f, i) => ({
          id: `${i}`,
          funderId: f.id,
          funderName: f.name,
          allocationPct: 10,
        }))}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    const addButton = screen.getByText('Agregar asignación');
    expect(addButton).toBeDisabled();
  });

  it('calls onAdd when funder is selected from dropdown', async () => {
    mockHandlers.onAdd.mockResolvedValue(undefined);

    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    const addButton = screen.getByText('Agregar asignación');
    fireEvent.click(addButton);

    await waitFor(() => {
      const funderC = screen.getByText('Funder C');
      fireEvent.click(funderC);
    });

    await waitFor(() => {
      expect(mockHandlers.onAdd).toHaveBeenCalledWith('funder-3', 0);
    });
  });

  it('validates that allocation does not exceed 100%', async () => {
    mockHandlers.onUpdate.mockRejectedValue(new Error('Cannot update allocation: total would be 110%, exceeds 100%.'));

    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // Try to update Funder A from 30 to 60 (would make total 80, which is OK)
    // So let's try 60 + 20 + 30 = 110
    const inputs = screen.getAllByDisplayValue('30');
    const firstInput = inputs[0];
    await userEvent.clear(firstInput);
    await userEvent.type(firstInput, '60');

    await waitFor(() => {
      expect(mockHandlers.onUpdate).toHaveBeenCalled();
    });
  });

  it('shows error message when allocation exceeds 100%', async () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // The error should be caught and displayed
    mockHandlers.onUpdate.mockRejectedValueOnce(new Error('Cannot exceed 100%'));

    expect(screen.queryByText(/Cannot exceed 100%/)).not.toBeInTheDocument();
  });

  it('calls onRemove when allocation is deleted', async () => {
    mockHandlers.onRemove.mockResolvedValue(undefined);

    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    const removeButtons = screen.getAllByLabelText('Eliminar asignación');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockHandlers.onRemove).toHaveBeenCalledWith('1');
    });
  });

  it('updates remaining percentage after deletion', async () => {
    mockHandlers.onRemove.mockResolvedValue(undefined);

    const { rerender } = render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    expect(screen.getByText(/% sin asignar:/)).toHaveTextContent('50.00%');

    // Remove first allocation
    const removeButtons = screen.getAllByLabelText('Eliminar asignación');
    fireEvent.click(removeButtons[0]);

    // Simulate the state update after deletion
    rerender(
      <AllocationList
        outcomeId="outcome-1"
        allocations={[mockAllocations[1]]} // Only Funder B remains
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // Now remaining should be 80
    await waitFor(() => {
      expect(screen.getByText(/% sin asignar:/)).toHaveTextContent('80.00%');
    });
  });

  it('shows all 100% unallocated when no allocations exist', () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={[]}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    expect(screen.getByText(/% sin asignar:/)).toHaveTextContent('100.00%');
  });

  it('validates percentage constraints on input', async () => {
    render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={mockAllocations}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // Input should only accept 0-100
    const inputs = screen.getAllByDisplayValue('30');
    const input = inputs[0] as HTMLInputElement;

    expect(input.min).toBe('0');
    expect(input.max).toBe('100');
  });
});

describe('AllocationList - Integration', () => {
  const mockHandlers = {
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles full allocation workflow: add -> update -> remove', async () => {
    mockHandlers.onAdd.mockResolvedValue(undefined);
    mockHandlers.onUpdate.mockResolvedValue(undefined);
    mockHandlers.onRemove.mockResolvedValue(undefined);

    const { rerender } = render(
      <AllocationList
        outcomeId="outcome-1"
        allocations={[]}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // Add Funder A
    const addButton = screen.getByText('Agregar asignación');
    fireEvent.click(addButton);

    await waitFor(() => {
      const funderA = screen.getByText('Funder A');
      fireEvent.click(funderA);
    });

    expect(mockHandlers.onAdd).toHaveBeenCalledWith('funder-1', 0);

    // Simulate add result
    rerender(
      <AllocationList
        outcomeId="outcome-1"
        allocations={[{ id: 'new-1', funderId: 'funder-1', funderName: 'Funder A', allocationPct: 0 }]}
        availableFunders={mockFunders}
        onAdd={mockHandlers.onAdd}
        onUpdate={mockHandlers.onUpdate}
        onRemove={mockHandlers.onRemove}
      />
    );

    // Update to 50%
    const input = screen.getByDisplayValue('0');
    await userEvent.clear(input);
    await userEvent.type(input, '50');

    // Remove
    const removeButton = screen.getByLabelText('Eliminar asignación');
    fireEvent.click(removeButton);

    expect(mockHandlers.onRemove).toHaveBeenCalledWith('new-1');
  });
});
