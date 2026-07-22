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

  if (ctx.membership.role !== ROLES.SUPER_ADMIN && ctx.membership.role !== ROLES.ORGANIZATION_ADMIN) {
    throw new Error('Only organization admins can complete onboarding')
  }

  const parsed = onboardingSchema.safeParse({
    country: formData.get('country'),
    sector: formData.get('sector'),
    baseCurrency: formData.get('baseCurrency'),
  })

  if (!parsed.success) {
    throw new Error(`Invalid onboarding data: ${parsed.error.issues.map(i => i.message).join(', ')}`)
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
