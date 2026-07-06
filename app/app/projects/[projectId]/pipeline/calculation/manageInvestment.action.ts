// app/app/projects/[projectId]/pipeline/calculation/manageInvestment.action.ts

'use server'

import { z } from 'zod'
import { createInvestment, updateInvestment, deleteInvestment } from '@/lib/pipeline/investments'

const CreateInvestmentSchema = z.object({
  funderId: z.string().uuid(),
  amount: z.string().min(1),
  currency: z.string().min(1),
  year: z.number().int().optional(),
  description: z.string().optional(),
  contributionType: z.enum(['cash', 'in_kind']).default('cash'),
  inKindValuationNotes: z.string().optional(),
})

const UpdateInvestmentSchema = z.object({
  amount: z.string().optional(),
  currency: z.string().optional(),
  year: z.number().int().optional(),
  description: z.string().optional(),
  contributionType: z.enum(['cash', 'in_kind']).optional(),
  inKindValuationNotes: z.string().optional(),
})

/**
 * Create a new investment for a project
 */
export async function createInvestmentAction(projectId: string, formData: FormData) {
  const raw = {
    funderId: formData.get('funderId'),
    amount: formData.get('amount'),
    currency: formData.get('currency'),
    year: formData.get('year') ? Number(formData.get('year')) : undefined,
    description: (formData.get('description') as string | null) || undefined,
    contributionType: (formData.get('contributionType') as string | null) || 'cash',
    inKindValuationNotes: (formData.get('inKindValuationNotes') as string | null) || undefined,
  }

  const parsed = CreateInvestmentSchema.parse(raw)

  if (!projectId) throw new Error('projectId missing')

  const result = await createInvestment(projectId, parsed)
  return result
}

/**
 * Update an existing investment
 */
export async function updateInvestmentAction(investmentId: string, formData: FormData) {
  const raw = {
    amount: (formData.get('amount') as string | null) || undefined,
    currency: (formData.get('currency') as string | null) || undefined,
    year: formData.get('year') ? Number(formData.get('year')) : undefined,
    description: (formData.get('description') as string | null) || undefined,
    contributionType: (formData.get('contributionType') as string | null) || undefined,
    inKindValuationNotes: (formData.get('inKindValuationNotes') as string | null) || undefined,
  }

  const parsed = UpdateInvestmentSchema.parse(raw)

  if (!investmentId) throw new Error('investmentId missing')

  const result = await updateInvestment(investmentId, parsed)
  return result
}

/**
 * Delete an investment
 */
export async function deleteInvestmentAction(investmentId: string) {
  if (!investmentId) throw new Error('investmentId missing')

  const result = await deleteInvestment(investmentId)
  return result
}
