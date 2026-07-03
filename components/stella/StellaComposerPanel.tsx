'use client'
// components/stella/StellaComposerPanel.tsx
// On-demand Stella Composer panel — drafts one report section at a time.
// Never auto-invokes, never auto-saves. User reviews and explicitly loads
// the draft into the section's edit form via onUseDraft.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaComposer } from '@/app/actions/stella/composer'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ComposerOutput }
  | { status: 'error' }
  | { status: 'disabled' }
  | { status: 'quota_exceeded'; message: string }

interface StellaComposerPanelProps {
  projectId: string
  reportId: string
  sectionId: string
  sectionType: string
  onUseDraft: (draft: { title: string; content: string }) => void
  className?: string
}

export function StellaComposerPanel({
  projectId,
  reportId,
  sectionId,
  sectionType,
  onUseDraft,
  className,
}: StellaComposerPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })

  async function handleCompose() {
    setPanelState({ status: 'loading' })
    try {
      const result = await getStellaComposer(projectId, reportId, sectionId, sectionType)
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

  return (
    <section
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-3 text-sm', className)}
      aria-label="Stella Composer"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Stella puede redactar un borrador de esta sección. Vos lo revisás y editás antes de guardar.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={isLoading ? undefined : handleCompose}
          disabled={isLoading}
          className="shrink-0"
        >
          {isLoading ? 'Redactando…' : 'Redactar con Stella'}
        </Button>
      </div>

      {panelState.status === 'loading' && (
        <div
          aria-live="polite"
          aria-busy="true"
          aria-label="Redactando borrador con Stella…"
          data-testid="stella-composer-loading"
          className="mt-3 space-y-2"
        >
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
        </div>
      )}

      {panelState.status === 'quota_exceeded' && (
        <div aria-live="assertive" role="alert" className="mt-3">
          <p className="text-muted-foreground">{panelState.message}</p>
        </div>
      )}

      {panelState.status === 'error' && (
        <p aria-live="assertive" role="alert" className="mt-3 text-muted-foreground">
          La redacción de Stella no está disponible temporalmente. El contenido de tu sección no se ve afectado.
        </p>
      )}

      {panelState.status === 'success' && (
        <div aria-live="polite" className="mt-3 space-y-3">
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
              Borrador propuesto
            </h4>
            <p className="font-medium text-foreground">{panelState.data.draft_title}</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{panelState.data.draft_content}</p>
          </div>

          {panelState.data.assumptions.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Supuestos</h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}

          {panelState.data.limitations.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">Limitaciones</h4>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {panelState.data.limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onUseDraft({ title: panelState.data.draft_title, content: panelState.data.draft_content })
            }
          >
            Usar este borrador
          </Button>

          <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
            Este es un borrador generado por Stella. Requiere revisión humana antes de guardar o publicar.
          </p>
        </div>
      )}
    </section>
  )
}
