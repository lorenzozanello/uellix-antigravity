'use client'

import { useState, useCallback } from 'react'
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
 * InvestmentFormIntegration: Connects InvestmentList to the server actions.
 *
 * Each handler awaits its server action (which revalidates the page) so the
 * child can rely on resolution meaning "saved". On failure we surface the
 * message and re-throw so the child keeps the row for a retry.
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

  const handleAdd = useCallback(
    async (investmentData: InvestmentFormData) => {
      setError(null)
      try {
        await onCreateInvestment(investmentData)
        onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al crear la inversión')
        console.error('Create investment error:', err)
        throw err
      }
    },
    [onCreateInvestment, onSuccess]
  )

  const handleDelete = useCallback(
    async (investmentId: string) => {
      setError(null)
      try {
        await onDeleteInvestment(investmentId)
        onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al eliminar la inversión')
        console.error('Delete investment error:', err)
        throw err
      }
    },
    [onDeleteInvestment, onSuccess]
  )

  const handleUpdateRow = useCallback(
    async (investmentId: string, data: Partial<InvestmentFormData>) => {
      setError(null)
      try {
        await onUpdateInvestment(investmentId, data)
        onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al actualizar la inversión')
        console.error('Update investment error:', err)
        throw err
      }
    },
    [onUpdateInvestment, onSuccess]
  )

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-1">
          <p className="text-sm font-semibold text-red-800">No se pudo guardar la inversión</p>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <InvestmentList
        investments={investments}
        funders={funders}
        onAdd={handleAdd}
        onDelete={handleDelete}
        onUpdateRow={handleUpdateRow}
        canEdit={canEdit}
      />
    </div>
  )
}
