'use server';

import { db } from '@/db/client';
import { organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getApprovedOrganizationLogoUrl } from '@/lib/organizations/logo-url';

const SettingsSchema = z.object({
  whiteLabelEnabled: z.boolean(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
});

export async function updateOrganizationSettings(input: z.infer<typeof SettingsSchema>) {
  const { membership, organization } = await requireOrganizationAccess();

  // Solamente super_admin o organization_admin pueden modificar la configuración
  if (!hasRole(membership.role, 'organization_admin')) {
    throw new Error('Insufficient permissions to update organization settings');
  }

  const data = SettingsSchema.parse(input);
  const approvedLogoUrl = getApprovedOrganizationLogoUrl(data.logoUrl);

  if (data.logoUrl && !approvedLogoUrl) {
    throw new Error('Logo must use the configured public Supabase Storage origin');
  }

  await db
    .update(organizations)
    .set({
      whiteLabelEnabled: data.whiteLabelEnabled,
      brandColor: data.brandColor || null,
      logoUrl: approvedLogoUrl,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organization.id));

  revalidatePath('/app/organization/settings');
  revalidatePath('/app/projects/[projectId]/report/[reportId]/pdf', 'page');
  
  return { success: true };
}
