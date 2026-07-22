import React from 'react'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLE_LABELS } from '@/lib/auth/roles'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { OnboardingCheck } from '@/components/auth/OnboardingCheck'

export default async function PrivateLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { organization, membership } = await requireOrganizationAccess()
  const roleLabel = ROLE_LABELS[membership.role] ?? membership.role

  return (
    <div className="flex h-screen overflow-hidden bg-background font-manrope print:block print:h-auto print:overflow-visible">
      <Sidebar />

      <OnboardingCheck onboardingCompleted={Boolean(organization.onboardingCompleted)} />

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden print:overflow-visible">
        <TopBar orgName={organization.name} roleLabel={roleLabel} />
        <main className="flex-1 overflow-y-auto p-4 md:p-8 print:overflow-visible print:p-0">
          {children}
        </main>
      </div>
    </div>
  )
}
