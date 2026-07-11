'use client'
// components/stella/StellaReviewerPanel.tsx
// Fase 5b — on-demand panel for the reviewer roles (proxy_reviewer,
// evidence_reviewer, audit_assistant). Never auto-invokes. The output is a
// recommendation only: a human decides and acts through the normal review flows.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getStellaReviewer } from '@/app/actions/stella/reviewer'
import type { ReviewerRole } from '@/lib/stella/prompts/reviewer-system'
import type { ReviewerOutput } from '@/lib/stella/schemas/reviewer-output'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ReviewerOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'quota_exceeded'; message: string }

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
}

export function StellaReviewerPanel({ projectId, role, title, className }: Props) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })

  async function handleAsk() {
    setPanelState({ status: 'loading' })
    try {
      const result = await getStellaReviewer(projectId, role)
      if (result.ok) {
        setPanelState({ status: 'success', data: result.data })
      } else if (result.error === 'DISABLED') {
        setPanelState({ status: 'disabled' })
      } else if (result.error === 'QUOTA_EXCEEDED') {
        setPanelState({ status: 'quota_exceeded', message: result.message })
      } else {
        setPanelState({ status: 'error' })
      }
    } catch {
      setPanelState({ status: 'error' })
    }
  }

  if (panelState.status === 'disabled') return null

  const isLoading = panelState.status === 'loading'

  return (
    <section
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm', className)}
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella brinda una recomendación consultiva. Un humano decide y actúa mediante los flujos
            de revisión habituales.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleAsk} disabled={isLoading} className="shrink-0">
          {isLoading ? 'Analizando…' : 'Pedir revisión a Stella'}
        </Button>
      </div>

      {panelState.status === 'loading' && (
        <div aria-live="polite" aria-busy="true" className="mt-3 space-y-2">
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
        </div>
      )}

      {panelState.status === 'error' && (
        <p role="alert" className="mt-3 text-muted-foreground">
          La revisión de Stella no está disponible temporalmente. Los datos de tu pipeline no se ven afectados.
        </p>
      )}

      {panelState.status === 'quota_exceeded' && (
        <p role="alert" className="mt-3 text-muted-foreground">
          {panelState.message}
        </p>
      )}

      {panelState.status === 'success' && (
        <div aria-live="polite" className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant={riskVariant(panelState.data.risk_level)}>
              {RISK_LABEL[panelState.data.risk_level] ?? panelState.data.risk_level}
            </Badge>
          </div>
          <p className="text-muted-foreground">{panelState.data.summary}</p>

          {panelState.data.findings.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Hallazgos</h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.findings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {panelState.data.recommendations.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Recomendaciones</h4>
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
    </section>
  )
}
