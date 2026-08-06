'use client'
// components/stella/StellaAdvisorPanel.tsx
// Sprint 9C-2: On-demand Stella Advisor panel
// Never auto-invokes. User triggers via "Preguntar a Stella" button.
// WS2 (Moonshot) U5/U6: full error taxonomy (see error-messages.ts),
// server-passed `enabled` availability (inert informative state instead of
// unmount), persistent live regions mounted at idle, focus management and
// design-token classes (no hardcoded hex).

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaAdvisor, issueStellaAdvisorTicket } from '@/app/actions/stella/advisor'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'
import { StellaErrorNotice } from './StellaErrorNotice'
import { useStellaOperation, type StellaOperationAttempt } from './use-stella-operation'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AdvisorOutput }
  | { status: 'error'; code: string; message: string }
  | { status: 'disabled' }

interface StellaAdvisorPanelProps {
  projectId: string
  step: string
  title?: string
  className?: string
  highlightHint?: boolean
  /**
   * Server-passed availability (from lib/stella/config on the page). When
   * false the panel renders an inert informative state and never calls the
   * action. Defaults to true for call sites that have not been wired yet.
   */
  enabled?: boolean
}

export function StellaAdvisorPanel({
  projectId,
  step,
  title,
  className,
  highlightHint = false,
  enabled = true,
}: StellaAdvisorPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const resultRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  // U6: focus the result on success, the error on failure.
  useEffect(() => {
    if (panelState.status === 'success') resultRef.current?.focus()
    else if (panelState.status === 'error') errorRef.current?.focus()
  }, [panelState.status])

  // TRAIN 4.3 — two affordances, two functions. `start` mints a ticket (a new
  // operation, a new unit); `retry` presents the one already in hand (the same
  // operation, zero units). See use-stella-operation.ts.
  const operation = useStellaOperation(
    () => issueStellaAdvisorTicket(projectId),
    (ticket) => getStellaAdvisor(projectId, step, ticket),
  )

  function applyAttempt(attempt: StellaOperationAttempt<Awaited<ReturnType<typeof getStellaAdvisor>>>) {
    if (attempt.kind === 'disabled') {
      // U5: inert informative state — never unmount post-click.
      setPanelState({ status: 'disabled' })
      return
    }
    if (attempt.kind === 'issue_error') {
      setPanelState({ status: 'error', code: attempt.code, message: attempt.message })
      return
    }
    if (attempt.kind === 'no_operation') {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
      return
    }
    const result = attempt.result
    if (result.ok) {
      setPanelState({ status: 'success', data: result.data })
    } else if (result.error === 'DISABLED') {
      setPanelState({ status: 'disabled' })
    } else {
      setPanelState({ status: 'error', code: result.error, message: result.message })
    }
  }

  /** A NEW question. Mints a ticket, so the ledger charges a new unit. */
  async function handleAskStella() {
    setPanelState({ status: 'loading' })
    try {
      applyAttempt(await operation.start())
    } catch {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
    }
  }

  /**
   * A RETRY OF THE CURRENT OPERATION. Reuses the ticket, so a re-delivery
   * charges no additional unit — `complete_operation_ticket` answers `replayed`.
   * No ticket is minted here, and that omission is the whole point.
   */
  async function handleRetry() {
    setPanelState({ status: 'loading' })
    try {
      applyAttempt(await operation.retry())
    } catch {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
    }
  }

  const isLoading = panelState.status === 'loading'
  const isInertDisabled = !enabled || panelState.status === 'disabled'

  return (
    <section
      className={cn(
        'rounded-lg border p-4 my-4 text-sm',
        highlightHint
          ? 'border-uellix-orange/40 bg-uellix-orange/5'
          : 'border-border bg-muted/20',
        className
      )}
      aria-label={title ?? 'Stella Advisor'}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title ?? 'Stella Advisor'}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella brinda orientación consultiva únicamente. Se requiere revisión humana antes de su uso externo.
          </p>
          {highlightHint && !isInertDisabled && (
            <p className="mt-1 text-xs font-medium text-uellix-orange-strong">
              <span aria-hidden="true">💡</span> Recién estás empezando este paso — Stella puede orientarte.
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={isLoading || isInertDisabled ? undefined : handleAskStella}
          disabled={isLoading || isInertDisabled}
          className="shrink-0"
        >
          {isLoading ? 'Cargando…' : 'Preguntar a Stella'}
        </Button>
      </div>

      {/* U5: inert informative state (server-disabled or post-click DISABLED). */}
      {isInertDisabled && (
        <p className="mt-3 text-muted-foreground" data-testid="stella-advisor-disabled">
          Stella no está habilitada para tu organización en este momento. Los datos de tu pipeline
          no se ven afectados.
        </p>
      )}

      {/* U6: persistent polite live region — mounted at idle. */}
      <div aria-live="polite" data-testid="stella-advisor-live-polite">
        {panelState.status === 'loading' && (
          <div
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

        {panelState.status === 'success' && (
          <div ref={resultRef} tabIndex={-1} className="mt-3 space-y-3 focus-visible:outline-none">
            <AdvisorSection title="Qué hacer" content={panelState.data.what_to_do} />
            <AdvisorSection title="Por qué importa" content={panelState.data.why_it_matters} />
            <AdvisorSection title="Cómo hacerlo" content={panelState.data.how_to_do_it} />

            {panelState.data.common_mistakes.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                  Errores comunes
                </h3>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  {panelState.data.common_mistakes.map((mistake, i) => (
                    <li key={i}>{mistake}</li>
                  ))}
                </ul>
              </div>
            )}

            {panelState.data.suggested_next_actions.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                  Próximos pasos sugeridos
                </h3>
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
      </div>

      {/* U6: persistent assertive live region — errors only. */}
      <div aria-live="assertive" data-testid="stella-advisor-live-assertive">
        {panelState.status === 'error' && (
          <div ref={errorRef} tabIndex={-1} className="mt-3 focus-visible:outline-none">
            <StellaErrorNotice
              code={panelState.code}
              message={panelState.message}
              onRetry={handleRetry}
              footnote="Los datos de tu pipeline no se ven afectados."
            />
          </div>
        )}
      </div>
    </section>
  )
}

function AdvisorSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h3>
      <p className="text-muted-foreground">{content}</p>
    </div>
  )
}
