// app/app/projects/[projectId]/pipeline/calculation/manageInvestment.action.ts

'use server'

import { z } from 'zod'
import { createInvestment, updateInvestment, deleteInvestment } from '@/lib/pipeline/investments'

const CreateInvestmentSchema = z.object({
  funderId: z.string().uuid('Debes seleccionar un financiador válido'),
  amount: z.string()
    .min(1, 'El monto es requerido')
    .refine((v) => {
      const num = parseFloat(v)
      return !isNaN(num) && num > 0
    }, 'El monto debe ser un número positivo'),
  currency: z.string()
    .min(1, 'Debes especificar una moneda')
    .regex(/^[A-Z]{3}$/, 'El código de moneda debe tener 3 letras (ej: USD, COP, EUR)'),
  year: z.number().int().optional(),
  description: z.string().optional(),
  contributionType: z.enum(['cash', 'in_kind']).default('cash'),
  inKindValuationNotes: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.contributionType === 'in_kind' && (!data.inKindValuationNotes || data.inKindValuationNotes.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inKindValuationNotes'],
      message: 'Las notas de valoración son requeridas para aportes en especie',
    })
  }
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

  try {
    const parsed = CreateInvestmentSchema.parse(raw)

    if (!projectId) throw new Error('ID del proyecto faltante')

    const result = await createInvestment(projectId, parsed)
    return result
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(e => e.message).join('; ')
      throw new Error(`Validación fallida: ${messages}`)
    }
    throw error
  }
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

  try {
    const parsed = UpdateInvestmentSchema.parse(raw)

    if (!investmentId) throw new Error('ID de inversión faltante')

    const result = await updateInvestment(investmentId, parsed)
    return result
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(e => e.message).join('; ')
      throw new Error(`Validación fallida: ${messages}`)
    }
    throw error
  }
}

/**
 * Delete an investment
 */
export async function deleteInvestmentAction(investmentId: string) {
  if (!investmentId) throw new Error('investmentId missing')

  const result = await deleteInvestment(investmentId)
  return result
}
