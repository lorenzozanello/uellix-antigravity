'use client'
// components/stella/StellaAdvisorPanel.tsx
// Sprint 9C-2: On-demand Stella Advisor panel
// Never auto-invokes. User triggers via "Ask Stella" button.

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

interface StellaAdvisorPanelProps {
  projectId: string
  step: string
  title?: string
  className?: string
}

export function StellaAdvisorPanel({
  projectId,
  step,
  title,
  className,
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
    panelState.status === 'success'

  return (
    <section
      className={cn(
        'rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm',
        className
      )}
      aria-label={title ?? 'Stella Advisor'}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title ?? 'Stella Advisor'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stella provides advisory guidance only. Human review is required before external use.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={canRetry ? handleAskStella : undefined}
          disabled={isLoading}
          className="shrink-0"
        >
          {isLoading ? 'Loading…' : 'Ask Stella'}
        </Button>
      </div>

      {/* Loading skeleton */}
      {panelState.status === 'loading' && (
        <div
          aria-live="polite"
          aria-busy="true"
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
          Stella guidance is temporarily unavailable. Your pipeline data is unaffected.
        </p>
      )}

      {/* Success state */}
      {panelState.status === 'success' && (
        <div aria-live="polite" className="mt-3 space-y-3">
          <AdvisorSection title="What to do" content={panelState.data.what_to_do} />
          <AdvisorSection title="Why it matters" content={panelState.data.why_it_matters} />
          <AdvisorSection title="How to do it" content={panelState.data.how_to_do_it} />

          {panelState.data.common_mistakes.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                Common mistakes
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
                Suggested next actions
              </h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.suggested_next_actions.map((action, i) => (
                  <li key={i}>{action}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
            Stella provides advisory guidance only. Human review is required before external use.
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
