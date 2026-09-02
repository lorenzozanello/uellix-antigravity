'use client'
// components/stella/StellaAvailabilityNotice.tsx
// PRODUCT TRAIN 1 -- thin StellaAvailabilityState wrapper around the existing
// StellaErrorNotice/error-messages taxonomy, for reuse outside the big
// contextual advisor panel (future evidence/proxy review UIs). Copy is never
// duplicated: this maps the narrow 4-state union back to one representative
// StellaPanelErrorCode and delegates rendering to StellaErrorNotice.

import { StellaErrorNotice } from './StellaErrorNotice'
import type { StellaAvailabilityState } from './grounding-model'
import type { StellaPanelErrorCode } from './error-messages'

const REPRESENTATIVE_CODE: Record<StellaAvailabilityState, StellaPanelErrorCode> = {
  unavailable: 'DISABLED',
  permission_denied: 'UNAUTHORIZED',
  quota_reached: 'QUOTA_EXCEEDED',
  provider_failure: 'GEMINI_ERROR',
}

export interface StellaAvailabilityNoticeProps {
  state: StellaAvailabilityState
  /** Server message, when there is one (verbatim for quota_reached). */
  message: string
  onRetry?: () => void
  className?: string
}

export function StellaAvailabilityNotice({ state, message, onRetry, className }: StellaAvailabilityNoticeProps) {
  return (
    <StellaErrorNotice code={REPRESENTATIVE_CODE[state]} message={message} onRetry={onRetry} className={className} />
  )
}
