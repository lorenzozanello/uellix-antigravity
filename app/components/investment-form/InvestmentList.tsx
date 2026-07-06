'use client'

import { useState } from 'react'
import { Trash2, Plus } from 'lucide-react'
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

/**
 * InvestmentList: Multi-row investment form container
 * - Renders a row for each existing investment
 * - Allows adding/removing rows
 * - Handles per-row updates
 */
export default function InvestmentList({
  investments,
  funders,
  onAdd,
  onDelete,
  onUpdateRow,
  canEdit,
}: InvestmentListProps) {
  const [rows, setRows] = useState<Investment[]>(
    investments && investments.length > 0 ? investments : [
      {
        id: `temp-${Date.now()}`,
        funderId: '',
        amount: '',
        currency: 'USD',
        amountUsd: null,
        contributionType: 'cash',
        inKindValuationNotes: null,
        status: 'new',
      },
    ]
  )

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const handleAddRow = () => {
    const newRow: Investment = {
      id: `temp-${Date.now()}`,
      funderId: '',
      amount: '',
      currency: 'USD',
      amountUsd: null,
      contributionType: 'cash',
      inKindValuationNotes: null,
      status: 'new',
    }
    setRows([...rows, newRow])
  }

  const handleDeleteRow = async (investmentId: string) => {
    const row = rows.find((r) => r.id === investmentId)

    // If row has data, ask for confirmation
    if (row && (row.funderId || row.amount)) {
      setDeleteConfirm(investmentId)
      return
    }

    // Otherwise delete immediately
    await performDelete(investmentId)
  }

  const performDelete = async (investmentId: string) => {
    setDeleteConfirm(null)

    // If it's a temp row, just remove it from UI
    if (investmentId.startsWith('temp-')) {
      setRows(rows.filter((r) => r.id !== investmentId))
    } else {
      // Call server action to delete
      await onDelete(investmentId)
      setRows(rows.filter((r) => r.id !== investmentId))
    }
  }

  const handleRowChange = async (investmentId: string, data: Partial<InvestmentFormData>) => {
    // Update local state
    setRows(
      rows.map((row) =>
        row.id === investmentId
          ? {
              ...row,
              funderId: data.funderId ?? row.funderId,
              amount: data.amount ?? row.amount,
              currency: data.currency ?? row.currency,
              contributionType: data.contributionType ?? row.contributionType,
              inKindValuationNotes: data.inKindValuationNotes ?? row.inKindValuationNotes,
              year: data.year ?? row.year,
              description: data.description ?? row.description,
            }
          : row
      )
    )

    // If it's a temp row (new), don't call server action yet
    if (!investmentId.startsWith('temp-')) {
      await onUpdateRow(investmentId, data)
    }
  }

  return (
    <div className="space-y-4">
      {/* Rows */}
      <div className="space-y-3">
        {rows.map((investment, idx) => (
          <div key={investment.id} className="relative">
            <InvestmentRow
              investment={investment}
              funders={funders}
              onUpdate={(data) => handleRowChange(investment.id, data)}
              onDelete={() => handleDeleteRow(investment.id)}
              canEdit={canEdit}
            />

            {/* Delete confirmation modal */}
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
                      onClick={() => performDelete(investment.id)}
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

      {/* Add row button */}
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
