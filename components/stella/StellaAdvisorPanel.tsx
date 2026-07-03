'use client'
// components/stella/StellaAdvisorPanel.tsx
// Sprint 9C-2: On-demand Stella Advisor panel
// Never auto-invokes. User triggers via "Preguntar a Stella" button.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaAdvisor } from '@/app/actions/stella/advisor'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AdvisorOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'quota_exceeded'; message: string }

interface StellaAdvisorPanelProps {
  projectId: string
  step: string
  title?: string
  className?: string
  highlightHint?: boolean
}

export function StellaAdvisorPanel({
  projectId,
  step,
  title,
  className,
  highlightHint = false,
}: StellaAdvisorPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })

  async function handleAskStella() {
    setPanelState({ status: 'loading' })
    try {
      const result = await getStellaAdvisor(projectId, step)
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

  if (panelState.status === 'disabled') {
    return null
  }

  const isLoading = panelState.status === 'loading'
  const canRetry =
    panelState.status === 'idle' ||
    panelState.status === 'error' ||
    panelState.status === 'success' ||
    panelState.status === 'quota_exceeded'

  return (
    <section
      className={cn(
        'rounded-lg border p-4 my-4 text-sm',
        highlightHint
          ? 'border-[#FF6A00]/40 bg-[#FF6A00]/5'
          : 'border-border bg-muted/20',
        className
      )}
      aria-label={title ?? 'Stella Advisor'}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title ?? 'Stella Advisor'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella brinda orientación consultiva únicamente. Se requiere revisión humana antes de su uso externo.
          </p>
          {highlightHint && (
            <p className="mt-1 text-xs font-medium text-[#B85200]">
              💡 Recién estás empezando este paso — Stella puede orientarte.
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={canRetry ? handleAskStella : undefined}
          disabled={isLoading}
          className="shrink-0"
        >
          {isLoading ? 'Cargando…' : 'Preguntar a Stella'}
        </Button>
      </div>

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
