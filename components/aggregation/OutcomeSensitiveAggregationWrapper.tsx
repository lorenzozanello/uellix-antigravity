// components/aggregation/OutcomeSensitiveAggregationWrapper.tsx
// Etapa A2.3.2 (STL-A232-010/011) — server component wrapper, mirroring
// OutcomeAllocationWrapper.tsx's pattern: fetch server-side (auth + role +
// history), pass plain data and capability flags to the client panel.
//
// Role checks mirror declaration-service.ts's CREATE_ROLES/VERIFY_ROLES
// EXACTLY (literal set membership, not hasRole() hierarchy) — CREATE_ROLES
// deliberately excludes impact_manager/super_admin even though they outrank
// analyst in the hierarchy, and VERIFY_ROLES is organization_admin only, no
// super_admin bypass. A UI flag that used hasRole() here would show a
// button the server would then reject with FORBIDDEN_ROLE.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { listEntityAggregationDeclarations } from '@/app/actions/stella/aggregation-declarations'
import { OutcomeSensitiveAggregationPanel } from './OutcomeSensitiveAggregationPanel'

interface Props {
  projectId: string
  outcomeId: string
}

export async function OutcomeSensitiveAggregationWrapper({ projectId, outcomeId }: Props) {
  const { membership } = await requireOrganizationAccess()
  const result = await listEntityAggregationDeclarations(projectId, 'outcome', outcomeId)
  const items = result.ok ? result.items : []

  const canCreateOrSupersede = membership.role === 'organization_admin' || membership.role === 'analyst'
  const canVerifyOrRevoke = membership.role === 'organization_admin'

  return (
    <OutcomeSensitiveAggregationPanel
      projectId={projectId}
      outcomeId={outcomeId}
      initialItems={items}
      canCreateOrSupersede={canCreateOrSupersede}
      canVerifyOrRevoke={canVerifyOrRevoke}
    />
  )
}
