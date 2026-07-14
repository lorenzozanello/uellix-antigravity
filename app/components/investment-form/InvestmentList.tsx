'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import InvestmentRow from './InvestmentRow'

interface Funder {
  id: string
  name: string
  funderType?: string
}

interface Investment {
  id: string
  funderId: string
  amount: string
  currency: string
  amountUsd: string | null
  contributionType: 'cash' | 'in_kind'
  inKindValuationNotes: string | null
  year?: number | null
  description?: string | null
  status: string
  fxRateId?: string | null
  createdAt?: Date
  updatedAt?: Date
}

export interface InvestmentFormData {
  funderId: string
  amount: string
  currency: string
  contributionType: 'cash' | 'in_kind'
  inKindValuationNotes?: string
  year?: number
  description?: string
  fxRate?: string
  fxSource?: string
}

interface InvestmentListProps {
  investments: Investment[]
  funders: Funder[]
  onAdd: (investmentData: InvestmentFormData) => void | Promise<void>
  onDelete: (investmentId: string) => void | Promise<void>
  onUpdateRow: (investmentId: string, data: Partial<InvestmentFormData>) => void | Promise<void>
  canEdit: boolean
}

function makeTempRow(): Investment {
  return {
    id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    funderId: '',
    amount: '',
    currency: 'USD',
    amountUsd: null,
    contributionType: 'cash',
    inKindValuationNotes: null,
    status: 'new',
  }
}

/**
 * InvestmentList: Multi-row investment form container.
 *
 * Saved rows always come straight from the `investments` prop (kept fresh by
 * the server after each revalidation), while unsaved "temp" rows live in local
 * state until the user clicks Guardar. This split is what keeps the per-row
 * FX preview state stable — saved rows never depend on fragile local state,
 * and there is no per-keystroke server round-trip.
 */
export default function InvestmentList({
  investments,
  funders,
  onAdd,
  onDelete,
  onUpdateRow,
  canEdit,
}: InvestmentListProps) {
  // Seed a single blank row only when the project has no saved investments yet.
  const [tempRows, setTempRows] = useState<Investment[]>(
    investments.length === 0 ? [makeTempRow()] : []
  )
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const handleAddRow = () => {
    setTempRows((prev) => [...prev, makeTempRow()])
  }

  const handleSave = async (rowId: string, data: InvestmentFormData) => {
    setSavingId(rowId)
    try {
      if (rowId.startsWith('temp-')) {
        await onAdd(data)
        // Success: drop the temp row. The saved investment now arrives via the
        // refreshed `investments` prop, so it won't disappear or duplicate.
        setTempRows((prev) => prev.filter((r) => r.id !== rowId))
      } else {
        await onUpdateRow(rowId, data)
      }
    } catch {
      // Error surfaced by InvestmentFormIntegration; keep the row so the user
      // can retry without re-entering everything.
    } finally {
      setSavingId(null)
    }
  }

  const requestDelete = (row: Investment) => {
    if (row.id.startsWith('temp-')) {
      // Unsaved rows can be discarded without a confirmation prompt.
      setTempRows((prev) => prev.filter((r) => r.id !== row.id))
      return
    }
    setDeleteConfirm(row.id)
  }

  const confirmDelete = async (investmentId: string) => {
    setDeleteConfirm(null)
    setSavingId(investmentId)
    try {
      await onDelete(investmentId)
    } finally {
      setSavingId(null)
    }
  }

  const allRows: Investment[] = [...investments, ...tempRows]

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {allRows.map((investment) => (
          <div key={investment.id} className="relative">
            <InvestmentRow
              investment={investment}
              funders={funders}
              onSave={(data) => handleSave(investment.id, data)}
              onDelete={() => requestDelete(investment)}
              canEdit={canEdit}
              isSaving={savingId === investment.id}
            />

            {deleteConfirm === investment.id && (
              <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center z-50">
                <div className="bg-white dark:bg-slate-900 rounded-lg p-4 shadow-lg space-y-4 max-w-xs">
                  <p className="text-sm font-medium text-foreground">
                    ¿Eliminar este aporte? Esta acción no se puede deshacer.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="px-3 py-1.5 text-sm font-medium text-foreground rounded-md border border-border hover:bg-muted transition-colors"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => confirmDelete(investment.id)}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {allRows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aún no hay aportes registrados. Agrega el primero para comenzar.
        </p>
      )}

      {canEdit && (
        <button
          onClick={handleAddRow}
          type="button"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-foreground border border-border rounded-md hover:bg-muted transition-colors"
        >
          <Plus className="h-4 w-4" />
          Agregar aporte
        </button>
      )}
    </div>
  )
}
