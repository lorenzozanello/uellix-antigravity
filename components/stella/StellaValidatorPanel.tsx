'use client'
// components/stella/StellaValidatorPanel.tsx
// Sprint 9D-3: On-demand Stella Validator panel for Calculation step.
// Never auto-invokes. User triggers via "Revisar con Stella" button.
// Read-only: no pipeline writes, no SROI recalculation, no certification claims.
// WS2 (Moonshot) U5/U6: shared error taxonomy, server-passed `enabled`
// availability (inert state instead of unmount), persistent live regions,
// focus management, fixed heading hierarchy.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaValidator, issueStellaValidatorTicket } from '@/app/actions/stella/validator'
import { useStellaOperation, type StellaOperationAttempt } from './use-stella-operation'
import type { ValidatorOutput } from '@/lib/stella/schemas/validator-output'
import { StellaErrorNotice } from './StellaErrorNotice'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ValidatorOutput }
  | { status: 'error'; code: string; message: string }
  | { status: 'disabled' }

interface StellaValidatorPanelProps {
  projectId: string
  step?: 'Calculation' | 'Cálculo'
  title?: string
  className?: string
  /** Server-passed availability — see StellaAdvisorPanel. */
  enabled?: boolean
}

const RISK_LEVEL_STYLES: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  high: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
}

const RISK_LEVEL_LABELS: Record<'low' | 'medium' | 'high', string> = {
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
}

export function StellaValidatorPanel({
  projectId,
  step = 'Calculation',
  title,
  className,
  enabled = true,
}: StellaValidatorPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const resultRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (panelState.status === 'success') resultRef.current?.focus()
    else if (panelState.status === 'error') errorRef.current?.focus()
  }, [panelState.status])

  // TRAIN 4.3 — two affordances, two functions. See
  // components/stella/use-stella-operation.ts for why the client, and only the
  // client, can tell a new submit from a retry.
  const operation = useStellaOperation(
    () => issueStellaValidatorTicket(projectId),
    (ticket) => getStellaValidator(projectId, step, ticket),
  )

  function applyAttempt(attempt: StellaOperationAttempt<Awaited<ReturnType<typeof getStellaValidator>>>) {
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
  async function handleReviewWithStella() {
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
      className={cn(
        'rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm',
        className
      )}
      aria-label={title ?? 'Stella Validator'}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title ?? 'Stella Validator'}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella Validator ofrece únicamente una revisión de riesgo consultiva. Se requiere
            revisión humana antes de su uso externo.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={isLoading || isInertDisabled ? undefined : handleReviewWithStella}
          disabled={isLoading || isInertDisabled}
          className="shrink-0"
        >
          {isLoading ? 'Cargando…' : 'Revisar con Stella'}
        </Button>
      </div>

      {/* U5: inert informative state (server-disabled or post-click DISABLED). */}
      {isInertDisabled && (
        <p className="mt-3 text-muted-foreground" data-testid="stella-validator-disabled">
          Stella no está habilitada para tu organización en este momento. Los datos de tu cálculo
          no se ven afectados.
        </p>
      )}

      {/* U6: persistent polite live region. */}
      <div aria-live="polite" data-testid="stella-validator-live-polite">
        {panelState.status === 'loading' && (
          <div
            aria-busy="true"
            data-testid="stella-validator-loading"
            className="mt-3 space-y-2"
          >
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
          </div>
        )}

        {/* Success — full validation output */}
        {panelState.status === 'success' && (
          <div ref={resultRef} tabIndex={-1} className="mt-3 space-y-3 focus-visible:outline-none">
            {/* Summary */}
            <ValidatorSection title="Resumen" content={panelState.data.summary} />

            {/* Risk level badge */}
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                Nivel de riesgo
              </h3>
              <span
                className={cn(
                  'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium',
                  RISK_LEVEL_STYLES[panelState.data.risk_level]
                )}
              >
                {RISK_LEVEL_LABELS[panelState.data.risk_level]}
              </span>
            </div>

            {/* Evidence gaps */}
            <ValidatorList
              title="Vacíos de evidencia"
              items={panelState.data.evidence_gaps}
              emptyText="No se identificaron vacíos de evidencia"
            />

            {/* Proxy risks */}
            <ValidatorList
              title="Riesgos de proxies"
              items={panelState.data.proxy_risks}
              emptyText="No se identificaron riesgos de proxies"
            />

            {/* Attribution risks */}
            <ValidatorList
              title="Riesgos de atribución"
              items={panelState.data.attribution_risks}
              emptyText="No se identificaron riesgos de atribución"
            />

            {/* Claim risks */}
            <ValidatorList
              title="Riesgos de afirmaciones"
              items={panelState.data.claim_risks}
              emptyText="No se identificaron riesgos de afirmaciones"
            />

            {/* Recommendations */}
            <ValidatorList
              title="Recomendaciones"
              items={panelState.data.recommendations}
              emptyText="Sin recomendaciones"
            />

            {/* Human review banner — requires_human_review is always true (z.literal) */}
            <div
              role="note"
              className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-900/20"
            >
              <p className="text-xs font-medium text-amber-800 dark:text-amber-400">
                Se requiere revisión humana
              </p>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-500">
                Se requiere revisión humana antes de su uso externo. Esta revisión no certifica,
                audita, aprueba ni garantiza el impacto.
              </p>
            </div>

            {/* Disclaimer footer */}
            <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
              Stella Validator ofrece únicamente una revisión de riesgo consultiva. Esta revisión no
              certifica, audita, aprueba ni garantiza el impacto.
            </p>
          </div>
        )}
      </div>

      {/* U6: persistent assertive live region — errors only. */}
      <div aria-live="assertive" data-testid="stella-validator-live-assertive">
        {panelState.status === 'error' && (
          <div ref={errorRef} tabIndex={-1} className="mt-3 focus-visible:outline-none">
            <StellaErrorNotice
              code={panelState.code}
              message={panelState.message}
              onRetry={handleRetry}
              footnote="Los datos de tu cálculo no se ven afectados."
            />
          </div>
        )}
      </div>
    </section>
  )
}

function ValidatorSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h3>
      <p className="text-muted-foreground">{content}</p>
    </div>
  )
}

function ValidatorList({
  title,
  items,
  emptyText,
}: {
  title: string
  items: string[]
  emptyText?: string
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h3>
      {items.length > 0 ? (
        <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : emptyText ? (
        <p className="text-xs text-muted-foreground/70">{emptyText}</p>
      ) : null}
    </div>
  )
}
