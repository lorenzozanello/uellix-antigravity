'use client'
// components/stella/StellaValidatorPanel.tsx
// Sprint 9D-3: On-demand Stella Validator panel for Calculation step.
// Never auto-invokes. User triggers via "Review with Stella" button.
// Read-only: no pipeline writes, no SROI recalculation, no certification claims.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaValidator } from '@/app/actions/stella/validator'
import type { ValidatorOutput } from '@/lib/stella/schemas/validator-output'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ValidatorOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'rate_limited'; message: string }

interface StellaValidatorPanelProps {
  projectId: string
  step?: 'Calculation' | 'Cálculo'
  title?: string
  className?: string
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
}: StellaValidatorPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })

  async function handleReviewWithStella() {
    setPanelState({ status: 'loading' })
    try {
      const result = await getStellaValidator(projectId, step)
      if (result.ok) {
        setPanelState({ status: 'success', data: result.data })
      } else if (result.error === 'DISABLED') {
        setPanelState({ status: 'disabled' })
      } else if (result.error === 'RATE_LIMITED') {
        setPanelState({ status: 'rate_limited', message: result.message })
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
          <p className="font-medium text-foreground">{title ?? 'Stella Validator'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella Validator ofrece únicamente una revisión de riesgo consultiva. Se requiere
            revisión humana antes de su uso externo.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={isLoading ? undefined : handleReviewWithStella}
          disabled={isLoading}
          className="shrink-0"
        >
          {isLoading ? 'Cargando…' : 'Revisar con Stella'}
        </Button>
      </div>

      {/* Loading skeleton */}
      {panelState.status === 'loading' && (
        <div
          aria-live="polite"
          aria-busy="true"
          data-testid="stella-validator-loading"
          className="mt-3 space-y-2"
        >
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
        </div>
      )}

      {/* Rate limited — non-blocking, calculation unaffected */}
      {panelState.status === 'rate_limited' && (
        <div aria-live="assertive" role="alert" className="mt-3">
          <p className="text-muted-foreground">
            Se alcanzó el límite de solicitudes a Stella Validator por esta hora. {panelState.message}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Los datos de tu cálculo no se ven afectados.
          </p>
        </div>
      )}

      {/* Error — non-blocking, pipeline unaffected */}
      {panelState.status === 'error' && (
        <p aria-live="assertive" role="alert" className="mt-3 text-muted-foreground">
          La revisión de Stella no está disponible temporalmente. Los datos de tu pipeline no se ven afectados.
        </p>
      )}

      {/* Success — full validation output */}
      {panelState.status === 'success' && (
        <div aria-live="polite" className="mt-3 space-y-3">
          {/* Summary */}
          <ValidatorSection title="Resumen" content={panelState.data.summary} />

          {/* Risk level badge */}
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
              Nivel de riesgo
            </h4>
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
    </section>
  )
}

function ValidatorSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h4>
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
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h4>
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
