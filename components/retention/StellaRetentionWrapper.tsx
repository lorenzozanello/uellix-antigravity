// components/retention/StellaRetentionWrapper.tsx
// Etapa A2.4 (DR-004 aprobado) — server wrapper, same pattern as
// OutcomeSensitiveAggregationWrapper.tsx (Etapa A2.3.2): fetch server-side,
// pass plain data + a capability flag to the client panel.

import {
  getStellaRetentionOverview,
  listRetentionHoldsAction,
  listRecentStellaRetentionPurgeRunsAction,
  canManageStellaRetention,
} from '@/app/actions/stella/retention'
import { StellaRetentionPanel } from './StellaRetentionPanel'

export async function StellaRetentionWrapper() {
  const [overview, holds, runs, canManage] = await Promise.all([
    getStellaRetentionOverview(),
    listRetentionHoldsAction(),
    listRecentStellaRetentionPurgeRunsAction(5),
    canManageStellaRetention(),
  ])

  if (!overview.ok) return null

  return (
    <StellaRetentionPanel
      overview={overview.data}
      initialHolds={holds.ok ? holds.items : []}
      initialRuns={runs.ok ? runs.items : []}
      canManage={canManage}
    />
  )
}
