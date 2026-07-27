'use server'
// app/actions/stella/pilot-status.ts
// Etapa B0 (modo piloto restringido) — minimal, UI-safe pilot status for
// rendering the visible notice/badge/confirmation gate. NEVER exposes
// allowlists, IDs, env var names, or billing detail — only what the UI
// needs to decide what to show.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { getStellaPilotConfig } from '@/lib/stella/pilot/config'
import { getStellaPilotConfirmationStatus } from '@/lib/stella/pilot/confirmation-service'
import type { StellaPilotConfirmationStatusValue } from '@/lib/stella/pilot/confirmation-service'

export interface StellaPilotUiStatus {
  /** True when the master pilot switch (STELLA_PILOT_MODE) is on — independent of allowlist/kill-switch/confirmation state, which are never exposed here. */
  pilotActive: boolean
  noticeVersion: string
  confirmationStatus: StellaPilotConfirmationStatusValue
}

export async function getStellaPilotUiStatusAction(): Promise<{ ok: true; data: StellaPilotUiStatus } | { ok: false; error: 'UNAUTHORIZED' }> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }

  const config = getStellaPilotConfig()
  const confirmation = await getStellaPilotConfirmationStatus(ctx.organization.id, ctx.user.id)

  return {
    ok: true,
    data: {
      pilotActive: config.enabled,
      noticeVersion: config.noticeVersion,
      confirmationStatus: confirmation.status,
    },
  }
}
