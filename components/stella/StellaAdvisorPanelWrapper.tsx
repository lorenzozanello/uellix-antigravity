// components/stella/StellaAdvisorPanelWrapper.tsx
// Etapa B0 (modo piloto restringido) — server wrapper, same pattern as
// components/aggregation/OutcomeSensitiveAggregationWrapper.tsx: fetch
// pilot status server-side (never client-derived), pass it as props to the
// existing StellaAdvisorPanel. Drop-in replacement for every
// <StellaAdvisorPanel projectId=... step=... .../> call site — same props,
// plus the pilot badge/notice/confirmation gate.

import { getStellaPilotUiStatusAction } from '@/app/actions/stella/pilot-status'
import { StellaAdvisorPanel } from './StellaAdvisorPanel'

interface Props {
  projectId: string
  step: string
  title?: string
  className?: string
  highlightHint?: boolean
}

export async function StellaAdvisorPanelWrapper(props: Props) {
  const status = await getStellaPilotUiStatusAction()
  const pilot = status.ok ? status.data : null

  return (
    <StellaAdvisorPanel
      {...props}
      pilotActive={pilot?.pilotActive ?? false}
      pilotNoticeVersion={pilot?.noticeVersion}
      pilotConfirmationStatus={pilot?.confirmationStatus}
    />
  )
}
