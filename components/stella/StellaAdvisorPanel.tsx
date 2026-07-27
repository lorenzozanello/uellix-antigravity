'use client'
// components/stella/StellaAdvisorPanel.tsx
// Sprint 9C-2: On-demand Stella Advisor panel
// Never auto-invokes. User triggers via "Preguntar a Stella" button.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getStellaAdvisor } from '@/app/actions/stella/advisor'
import { acceptStellaPilotConfirmation } from '@/app/actions/stella/pilot-confirmation'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'
import type { StellaPilotConfirmationStatusValue } from '@/lib/stella/pilot/confirmation-service'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AdvisorOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'quota_exceeded'; message: string }
  | { status: 'pilot_blocked'; message: string }

interface StellaAdvisorPanelProps {
  projectId: string
  step: string
  title?: string
  className?: string
  highlightHint?: boolean
  /**
   * Etapa B0 (modo piloto restringido) — all three default to `undefined`/
   * `false` so every EXISTING call site (and its tests) renders exactly as
   * before. Only a caller that explicitly passes these (see
   * StellaAdvisorPanelWrapper.tsx) shows the pilot badge/notice/confirmation
   * gate. Never derived client-side — always server-resolved (see
   * app/actions/stella/pilot-status.ts), never allowlists/IDs/env vars.
   */
  pilotActive?: boolean
  pilotNoticeVersion?: string
  pilotConfirmationStatus?: StellaPilotConfirmationStatusValue
}

const PILOT_NOTICE_TEXT =
  'Stella está en fase piloto controlado. No cargues datos personales sensibles o identificables. Sus respuestas pueden contener errores y requieren revisión humana. Stella no certifica SROI ni sustituye el criterio profesional. La revisión jurídica y contractual definitiva está pendiente.'

export function StellaAdvisorPanel({
  projectId,
  step,
  title,
  className,
  highlightHint = false,
  pilotActive = false,
  pilotNoticeVersion,
  pilotConfirmationStatus,
}: StellaAdvisorPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const [confirmationStatus, setConfirmationStatus] = useState(pilotConfirmationStatus)
  const [confirming, setConfirming] = useState(false)

  const needsPilotConfirmation = pilotActive && confirmationStatus !== 'valid'

  async function handleConfirmPilot() {
    setConfirming(true)
    try {
      const result = await acceptStellaPilotConfirmation()
      if (result.ok) setConfirmationStatus(result.data.status)
    } finally {
      setConfirming(false)
    }
  }

  async function handleAskStella() {
    if (needsPilotConfirmation) return // the confirm button is the only action available in this state
    setPanelState({ status: 'loading' })
    try {
      const result = await getStellaAdvisor(projectId, step)
      if (result.ok) {
        setPanelState({ status: 'success', data: result.data })
      } else if (result.error === 'DISABLED') {
        setPanelState({ status: 'disabled' })
      } else if (result.error === 'QUOTA_EXCEEDED') {
        setPanelState({ status: 'quota_exceeded', message: result.message })
      } else if (typeof result.error === 'string' && result.error.startsWith('PILOT_')) {
        // Etapa B0: surface the specific, non-leaky pilot message instead of
        // the generic fallback below — e.g. "tu organización todavía no
        // forma parte del piloto", not a vague "try again".
        setPanelState({ status: 'pilot_blocked', message: result.message })
      } else {
        setPanelState({ status: 'error' })
      }
    } catch {
      setPanelState({ status: 'error' })
    }
  }

  if (panelState.status === 'disabled') {
    return null
  }

  const isLoading = panelState.status === 'loading'
  const canRetry =
    panelState.status === 'idle' ||
    panelState.status === 'error' ||
    panelState.status === 'success' ||
    panelState.status === 'quota_exceeded' ||
    panelState.status === 'pilot_blocked'

  return (
    <section
      className={cn(
        'rounded-lg border p-4 my-4 text-sm',
        highlightHint
          ? 'border-[#fc4c0d]/40 bg-[#fc4c0d]/5'
          : 'border-border bg-muted/20',
        className
      )}
      aria-label={title ?? 'Stella Advisor'}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-foreground">{title ?? 'Stella Advisor'}</p>
            {pilotActive && <Badge variant="warning">Piloto</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella brinda orientación consultiva únicamente. Se requiere revisión humana antes de su uso externo.
          </p>
          {pilotActive && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="stella-pilot-notice">
              {PILOT_NOTICE_TEXT}
            </p>
          )}
          {highlightHint && (
            <p className="mt-1 text-xs font-medium text-[#B85200]">
              <span aria-hidden="true">💡</span> Recién estás empezando este paso — Stella puede orientarte.
            </p>
          )}
        </div>
        {needsPilotConfirmation ? (
          <Button variant="outline" size="sm" onClick={handleConfirmPilot} disabled={confirming} className="shrink-0">
            {confirming ? 'Confirmando…' : 'Confirmar restricciones del piloto'}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={canRetry ? handleAskStella : undefined}
            disabled={isLoading}
            className="shrink-0"
          >
            {isLoading ? 'Cargando…' : 'Preguntar a Stella'}
          </Button>
        )}
      </div>

      {needsPilotConfirmation && (
        <p className="mt-2 text-xs text-muted-foreground" role="alert">
          Confirmo que no incluiré datos personales sensibles o identificables y que las salidas serán revisadas por una persona.
        </p>
      )}

      {/* Loading skeleton */}
      {panelState.status === 'loading' && (
        <div
          aria-live="polite"
          aria-busy="true"
          aria-label="Cargando asesoría de Stella…"
          data-testid="stella-loading"
          className="mt-3 space-y-2"
        >
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
        </div>
      )}

      {/* Error state */}
      {panelState.status === 'error' && (
        <p
          aria-live="assertive"
          role="alert"
          className="mt-3 text-muted-foreground"
        >
          La orientación de Stella no está disponible temporalmente. Los datos de tu pipeline no se ven afectados.
        </p>
      )}

      {/* Quota exceeded state */}
      {panelState.status === 'quota_exceeded' && (
        <div aria-live="assertive" role="alert" className="mt-3">
          <p className="text-muted-foreground">{panelState.message}</p>
        </div>
      )}

      {/* Etapa B0: pilot access blocked — the specific, non-leaky message from getStellaPilotAccess(), never a generic fallback. */}
      {panelState.status === 'pilot_blocked' && (
        <div aria-live="assertive" role="alert" className="mt-3">
          <p className="text-muted-foreground">{panelState.message}</p>
        </div>
      )}

      {/* Success state */}
      {panelState.status === 'success' && (
        <div aria-live="polite" className="mt-3 space-y-3">
          <AdvisorSection title="Qué hacer" content={panelState.data.what_to_do} />
          <AdvisorSection title="Por qué importa" content={panelState.data.why_it_matters} />
          <AdvisorSection title="Cómo hacerlo" content={panelState.data.how_to_do_it} />

          {panelState.data.common_mistakes.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                Errores comunes
              </h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.common_mistakes.map((mistake, i) => (
                  <li key={i}>{mistake}</li>
                ))}
              </ul>
            </div>
          )}

          {panelState.data.suggested_next_actions.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                Próximos pasos sugeridos
              </h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.suggested_next_actions.map((action, i) => (
                  <li key={i}>{action}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
            Stella brinda orientación consultiva únicamente. Se requiere revisión humana antes de su uso externo.
          </p>
        </div>
      )}
    </section>
  )
}

function AdvisorSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h4>
      <p className="text-muted-foreground">{content}</p>
    </div>
  )
}
