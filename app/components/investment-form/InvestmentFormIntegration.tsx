'use client'

import { useState, useCallback } from 'react'
import { useTransition } from 'react'
import InvestmentList from './InvestmentList'
import type { InvestmentFormData } from './InvestmentList'

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
}

interface InvestmentFormIntegrationProps {
  investments: Investment[]
  funders: Funder[]
  canEdit: boolean
  onCreateInvestment: (data: InvestmentFormData) => Promise<void>
  onUpdateInvestment: (investmentId: string, data: Partial<InvestmentFormData>) => Promise<void>
  onDeleteInvestment: (investmentId: string) => Promise<void>
  onSuccess?: () => void
}

/**
 * InvestmentFormIntegration: Connects InvestmentList component to server actions
 * - Handles create/update/delete operations
 * - Shows loading states and errors
 * - Calls onSuccess after operations complete
 */
export default function InvestmentFormIntegration({
  investments,
  funders,
  canEdit,
  onCreateInvestment,
  onUpdateInvestment,
  onDeleteInvestment,
  onSuccess,
}: InvestmentFormIntegrationProps) {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleAdd = useCallback(
    async (investmentData: InvestmentFormData) => {
      setError(null)

      startTransition(async () => {
        try {
          await onCreateInvestment(investmentData)
          onSuccess?.()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error creating investment')
          console.error('Create investment error:', err)
        }
      })
    },
    [onCreateInvestment, onSuccess]
  )

  const handleDelete = useCallback(
    async (investmentId: string) => {
      setError(null)

      startTransition(async () => {
        try {
          await onDeleteInvestment(investmentId)
          onSuccess?.()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error deleting investment')
          console.error('Delete investment error:', err)
        }
      })
    },
    [onDeleteInvestment, onSuccess]
  )

  const handleUpdateRow = useCallback(
    async (investmentId: string, data: Partial<InvestmentFormData>) => {
      setError(null)

      // Don't call server action for temp rows
      if (investmentId.startsWith('temp-')) return

      startTransition(async () => {
        try {
          await onUpdateInvestment(investmentId, data)
          onSuccess?.()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error updating investment')
          console.error('Update investment error:', err)
        }
      })
    },
    [onUpdateInvestment, onSuccess]
  )

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <InvestmentList
        investments={investments}
        funders={funders}
        onAdd={handleAdd}
        onDelete={handleDelete}
        onUpdateRow={handleUpdateRow}
        canEdit={canEdit && !isPending}
      />

      {isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          Guardando cambios…
        </div>
      )}
    </div>
  )
}
