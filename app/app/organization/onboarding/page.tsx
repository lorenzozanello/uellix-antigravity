import { requireOrganizationAccess } from '@/lib/auth/session'
import { canEditOrganization } from '@/lib/auth/permissions'
import { OrganizationOnboardingForm } from '@/components/onboarding/OrganizationOnboardingForm'
import { OrganizationOnboardingBlocked } from '@/components/onboarding/OrganizationOnboardingBlocked'

/**
 * RE-U4-CF-01: OnboardingCheck (components/auth/OnboardingCheck.tsx) routes
 * every member of an uncalibrated organisation here regardless of role — it
 * only looks at onboardingCompleted. completeOnboarding (app/actions/onboarding.ts)
 * is the actual authorization boundary and only accepts organization_admin+
 * (canEditOrganization — the same capability used elsewhere for organisation
 * settings writes). Rendering the form to a caller the action will always
 * reject was a dead end with no explanation and no way out. This branch does
 * not change that boundary; it just stops offering a form the server was
 * always going to refuse.
 */
export default async function OnboardingPage() {
  const { membership } = await requireOrganizationAccess()

  if (!canEditOrganization(membership.role)) {
    return <OrganizationOnboardingBlocked />
  }

  return <OrganizationOnboardingForm />
}
