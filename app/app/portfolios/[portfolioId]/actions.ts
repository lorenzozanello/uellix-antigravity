'use server'

// PORTFOLIO_PF2_EXECUTION_AUTHORITY_v1.0.0.json — the fourteenth authorized
// path (released by PORTFOLIO_PF2_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json).
// Every write runs inside runWithOrganizationAccess (a CONTEXT_OPENER); no
// logAuditAction call lives here — each governed write logs from inside its
// own service function in lib/portfolios/service.ts or lib/projects/service.ts,
// which are the two modules tests/audit-action-contract.test.ts's
// CORRESPONDENCE_SCAN_ROOTS already reaches (P2_SEMANTICS_FROZEN
// scan_root_extension).

import { revalidatePath } from 'next/cache'
import { runWithOrganizationAccess } from '@/lib/auth/session'
import {
  updatePortfolioForCurrentOrganization,
  archivePortfolioForCurrentOrganization,
} from '@/lib/portfolios/service'
import {
  assignProjectToPortfolioForCurrentOrganization,
  unassignProjectFromPortfolioForCurrentOrganization,
  moveProjectToPortfolioForCurrentOrganization,
} from '@/lib/projects/service'

function portfolioPath(portfolioId: string): string {
  return `/app/portfolios/${portfolioId}`
}

export async function updatePortfolioAction(portfolioId: string, formData: FormData) {
  const name = formData.get('name') as string
  const description = (formData.get('description') as string) || undefined

  await runWithOrganizationAccess(() =>
    updatePortfolioForCurrentOrganization(portfolioId, { name, description }),
  )

  revalidatePath(portfolioPath(portfolioId))
}

export async function archivePortfolioAction(portfolioId: string) {
  await runWithOrganizationAccess(() => archivePortfolioForCurrentOrganization(portfolioId))

  revalidatePath(portfolioPath(portfolioId))
  revalidatePath('/app/portfolios')
}

export async function assignProjectAction(portfolioId: string, formData: FormData) {
  const projectId = formData.get('projectId') as string

  await runWithOrganizationAccess(() =>
    assignProjectToPortfolioForCurrentOrganization(projectId, portfolioId),
  )

  revalidatePath(portfolioPath(portfolioId))
}

export async function unassignProjectAction(portfolioId: string, projectId: string) {
  await runWithOrganizationAccess(() =>
    unassignProjectFromPortfolioForCurrentOrganization(projectId, portfolioId),
  )

  revalidatePath(portfolioPath(portfolioId))
}

export async function moveProjectAction(
  sourcePortfolioId: string,
  projectId: string,
  formData: FormData,
) {
  const targetPortfolioId = formData.get('targetPortfolioId') as string

  await runWithOrganizationAccess(() =>
    moveProjectToPortfolioForCurrentOrganization(projectId, sourcePortfolioId, targetPortfolioId),
  )

  revalidatePath(portfolioPath(sourcePortfolioId))
  revalidatePath(portfolioPath(targetPortfolioId))
}
