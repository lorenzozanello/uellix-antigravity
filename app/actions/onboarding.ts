'use server'

import { z } from 'zod'
import { db } from '@/db/client'
import { organizations } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLES } from '@/lib/auth/roles'

const onboardingSchema = z.object({
  country: z.string().min(2).max(2).regex(/^[A-Z]{2}$/, 'Country must be a 2-letter ISO code'),
  sector: z.string().min(1).max(255).trim(),
  baseCurrency: z.string().min(3).max(3).regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code'),
})

export async function completeOnboarding(formData: FormData) {
  const ctx = await requireOrganizationAccess()

  // F0-03: la interfaz ya no muestra este formulario a quien no puede enviarlo,
  // pero la comprobación se mantiene aquí porque es la autorización real — una
  // acción de servidor es un endpoint público. El mensaje pasa a español: antes
  // era la única cadena en inglés que un usuario podía ver en toda la aplicación.
  if (ctx.membership.role !== ROLES.SUPER_ADMIN && ctx.membership.role !== ROLES.ORGANIZATION_ADMIN) {
    throw new Error(
      'Sólo un administrador de la organización puede completar la configuración inicial.'
    )
  }

  const parsed = onboardingSchema.safeParse({
    country: formData.get('country'),
    sector: formData.get('sector'),
    baseCurrency: formData.get('baseCurrency'),
  })

  if (!parsed.success) {
    throw new Error('Revisa los datos de la organización: país, sector y moneda base son obligatorios.')
  }

  const { country, sector, baseCurrency } = parsed.data

  await db.update(organizations)
    .set({
      country,
      sector,
      baseCurrency,
      onboardingCompleted: true,
      updatedAt: new Date()
    })
    .where(eq(organizations.id, ctx.organization.id))

  return { success: true }
}
