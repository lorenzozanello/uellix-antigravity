'use client'
// components/stella/StellaComposerPanel.tsx
// On-demand Stella Composer panel — drafts one report section at a time.
// Never auto-invokes, never auto-saves. User reviews and explicitly loads
// the draft into the section's edit form.
//
// WS2 (Moonshot) U4: the old imperative getElementById writes are gone.
// The panel now emits the draft through the `onUseDraft` callback prop; the
// controlled section state lives in StellaComposerSectionEditor (a client
// wrapper mounted from the report page), which owns overwrite confirmation
// and the undo stack. U5/U6: shared error taxonomy, server-passed `enabled`
// availability, persistent live regions and focus management.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getStellaComposer, issueStellaComposerTicket } from '@/app/actions/stella/composer'
import { useStellaOperation, type StellaOperationAttempt } from './use-stella-operation'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'
import { StellaErrorNotice } from './StellaErrorNotice'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ComposerOutput }
  | { status: 'error'; code: string; message: string }
  | { status: 'disabled' }

export interface ComposerDraft {
  title: string
  content: string
}

interface StellaComposerPanelProps {
  projectId: string
  reportId: string
  sectionId: string
  sectionType: string
  /**
   * Called when the user explicitly clicks "Usar este borrador". The owner
   * (StellaComposerSectionEditor) decides how to place it — including the
   * overwrite confirmation and undo history. Without this callback the
   * button is not rendered (the draft remains visible, review-only).
   */
  onUseDraft?: (draft: ComposerDraft) => void
  /** Server-passed availability — see StellaAdvisorPanel. */
  enabled?: boolean
  /**
   * Heading level for the panel's subsection headings. The report page
   * mounts the panel inside a Card whose section heading is an h3 → 4.
   */
  headingLevel?: 3 | 4 | 5
  className?: string
}

export function StellaComposerPanel({
  projectId,
  reportId,
  sectionId,
  sectionType,
  onUseDraft,
  enabled = true,
  headingLevel = 4,
  className,
}: StellaComposerPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const resultRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  const SubheadingTag = `h${headingLevel}` as 'h3' | 'h4' | 'h5'

  useEffect(() => {
    if (panelState.status === 'success') resultRef.current?.focus()
    else if (panelState.status === 'error') errorRef.current?.focus()
  }, [panelState.status])

  // TRAIN 4.3 — two affordances, two functions. See
  // components/stella/use-stella-operation.ts.
  const operation = useStellaOperation(
    () => issueStellaComposerTicket(projectId),
    (ticket) => getStellaComposer(projectId, reportId, sectionId, sectionType, ticket),
  )

  function applyAttempt(attempt: StellaOperationAttempt<Awaited<ReturnType<typeof getStellaComposer>>>) {
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

  /** A NEW draft. Mints a ticket, so the ledger charges a new unit. */
  async function handleCompose() {
    setPanelState({ status: 'loading' })
    try {
      applyAttempt(await operation.start())
    } catch {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
    }
  }

  /** A RETRY of the current draft. Reuses the ticket; charges nothing. */
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
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-3 text-sm', className)}
      aria-label="Stella Composer"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Stella puede redactar un borrador de esta sección. Vos lo revisás y editás antes de guardar.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={isLoading || isInertDisabled ? undefined : handleCompose}
          disabled={isLoading || isInertDisabled}
          className="shrink-0"
        >
          {isLoading ? 'Redactando…' : 'Redactar con Stella'}
        </Button>
      </div>

      {/* U5: inert informative state (server-disabled or post-click DISABLED). */}
      {isInertDisabled && (
        <p className="mt-3 text-muted-foreground" data-testid="stella-composer-disabled">
          Stella no está habilitada para tu organización en este momento. El contenido de tu
          sección no se ve afectado.
        </p>
      )}

      {/* U6: persistent polite live region. */}
      <div aria-live="polite" data-testid="stella-composer-live-polite">
        {panelState.status === 'loading' && (
          <div
            aria-busy="true"
            aria-label="Redactando borrador con Stella…"
            data-testid="stella-composer-loading"
            className="mt-3 space-y-2"
          >
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
          </div>
        )}

        {panelState.status === 'success' && (
          <div ref={resultRef} tabIndex={-1} className="mt-3 space-y-3 focus-visible:outline-none">
            <div>
              <SubheadingTag className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                Borrador propuesto
              </SubheadingTag>
              <p className="font-medium text-foreground">{panelState.data.draft_title}</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{panelState.data.draft_content}</p>
            </div>

            {panelState.data.assumptions.length > 0 && (
              <div>
                <SubheadingTag className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                  Supuestos
                </SubheadingTag>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  {panelState.data.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}

            {panelState.data.limitations.length > 0 && (
              <div>
                <SubheadingTag className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                  Limitaciones
                </SubheadingTag>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  {panelState.data.limitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </div>
            )}

            {onUseDraft && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onUseDraft({
                    title: panelState.data.draft_title,
                    content: panelState.data.draft_content,
                  })
                }
              >
                Usar este borrador
              </Button>
            )}

            <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
              Este es un borrador generado por Stella. Requiere revisión humana antes de guardar o publicar.
            </p>
          </div>
        )}
      </div>

      {/* U6: persistent assertive live region — errors only. */}
      <div aria-live="assertive" data-testid="stella-composer-live-assertive">
        {panelState.status === 'error' && (
          <div ref={errorRef} tabIndex={-1} className="mt-3 focus-visible:outline-none">
            <StellaErrorNotice
              code={panelState.code}
              message={panelState.message}
              onRetry={handleRetry}
              footnote="El contenido de tu sección no se ve afectado."
            />
          </div>
        )}
      </div>
    </section>
  )
}
