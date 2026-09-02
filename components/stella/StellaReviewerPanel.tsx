'use client'
// components/stella/StellaReviewerPanel.tsx
// Fase 5b — on-demand panel for the reviewer roles (proxy_reviewer,
// evidence_reviewer, audit_assistant). Never auto-invokes. The output is a
// recommendation only: a human decides and acts through the normal review flows.
// WS2 (Moonshot) U5/U6: shared error taxonomy, server-passed `enabled`
// availability (inert state instead of unmount), persistent live regions,
// focus management, fixed heading hierarchy.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getStellaReviewer, issueStellaReviewerTicket } from '@/app/actions/stella/reviewer'
import { useStellaOperation, type StellaOperationAttempt } from './use-stella-operation'
import type { ReviewerRole } from '@/lib/stella/prompts/reviewer-system'
import type { ReviewerOutput } from '@/lib/stella/schemas/reviewer-output'
import { StellaErrorNotice } from './StellaErrorNotice'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ReviewerOutput }
  | { status: 'error'; code: string; message: string }
  | { status: 'disabled' }

const RISK_LABEL: Record<string, string> = { low: 'Riesgo bajo', medium: 'Riesgo medio', high: 'Riesgo alto' }
function riskVariant(level: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (level === 'low') return 'success'
  if (level === 'medium') return 'warning'
  if (level === 'high') return 'danger'
  return 'neutral'
}

interface Props {
  projectId: string
  role: ReviewerRole
  title: string
  className?: string
  /** Server-passed availability — see StellaContextualAdvisorPanel. */
  enabled?: boolean
}

export function StellaReviewerPanel({ projectId, role, title, className, enabled = true }: Props) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const resultRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (panelState.status === 'success') resultRef.current?.focus()
    else if (panelState.status === 'error') errorRef.current?.focus()
  }, [panelState.status])

  // TRAIN 4.3 — two affordances, two functions. See
  // components/stella/use-stella-operation.ts.
  //
  // `role` reaches issuance as a STRING and is narrowed there against the set
  // of reviewer roles whose feature flag is on. The panel cannot widen it: a
  // role the deployment has dark is refused exactly as an invented one is.
  const operation = useStellaOperation(
    () => issueStellaReviewerTicket(projectId, role),
    (ticket) => getStellaReviewer(projectId, role, ticket),
  )

  function applyAttempt(attempt: StellaOperationAttempt<Awaited<ReturnType<typeof getStellaReviewer>>>) {
    if (attempt.kind === 'disabled') {
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

  /** A NEW review. Mints a ticket, so the ledger charges a new unit. */
  async function handleAsk() {
    setPanelState({ status: 'loading' })
    try {
      applyAttempt(await operation.start())
    } catch {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
    }
  }

  /** A RETRY of the current review. Reuses the ticket; charges nothing. */
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
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm', className)}
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella brinda una recomendación consultiva. Un humano decide y actúa mediante los flujos
            de revisión habituales.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={isLoading || isInertDisabled ? undefined : handleAsk}
          disabled={isLoading || isInertDisabled}
          className="shrink-0"
        >
          {isLoading ? 'Analizando…' : 'Pedir revisión a Stella'}
        </Button>
      </div>

      {/* U5: inert informative state (server-disabled or post-click DISABLED). */}
      {isInertDisabled && (
        <p className="mt-3 text-muted-foreground" data-testid="stella-reviewer-disabled">
          Este rol de revisión de Stella no está habilitado para tu organización en este momento.
          Los datos de tu pipeline no se ven afectados.
        </p>
      )}

      {/* U6: persistent polite live region. */}
      <div aria-live="polite" data-testid="stella-reviewer-live-polite">
        {panelState.status === 'loading' && (
          <div aria-busy="true" className="mt-3 space-y-2">
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
          </div>
        )}

        {panelState.status === 'success' && (
          <div ref={resultRef} tabIndex={-1} className="mt-3 space-y-3 focus-visible:outline-none">
            <div className="flex items-center gap-2">
              <Badge variant={riskVariant(panelState.data.risk_level)}>
                {RISK_LABEL[panelState.data.risk_level] ?? panelState.data.risk_level}
              </Badge>
            </div>
            <p className="text-muted-foreground">{panelState.data.summary}</p>

            {panelState.data.findings.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Hallazgos</h3>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  {panelState.data.findings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {panelState.data.recommendations.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Recomendaciones</h3>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  {panelState.data.recommendations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
              Recomendación consultiva. Requiere revisión y acción humana; Stella nunca aprueba ni modifica datos.
            </p>
          </div>
        )}
      </div>

      {/* U6: persistent assertive live region — errors only. */}
      <div aria-live="assertive" data-testid="stella-reviewer-live-assertive">
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
