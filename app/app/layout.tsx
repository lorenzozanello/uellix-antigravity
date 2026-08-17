import React from 'react'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLE_LABELS } from '@/lib/auth/roles'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { OnboardingCheck } from '@/components/auth/OnboardingCheck'

/**
 * The ORGANIZATION_REQUIRED boundary. Everything under `app/app/` is gated by
 * it, and that default is deliberate: a route added here is organisation-gated
 * because of where it sits, not because someone remembered to gate it.
 *
 * THE ONE EXCEPTION IS `/app/onboarding`, and it is not under this directory.
 * It lives at `app/(authenticated)/app/onboarding/`, whose layout requires a
 * session and nothing else. It has to: `requireOrganizationAccess()` sends a
 * member-less user THERE, so a version of that page gated by this layout would
 * redirect to itself forever — which is exactly what the hosted preview
 * measured before the route group existed. See `app/(authenticated)/layout.tsx`
 * for the full argument, and `tests/auth/route-authorization-boundary.test.ts`
 * for the check that keeps the exception to exactly one route.
 */
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
