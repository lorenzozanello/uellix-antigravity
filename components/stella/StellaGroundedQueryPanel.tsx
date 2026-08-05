'use client'
// components/stella/StellaGroundedQueryPanel.tsx
// PRODUCT TRAIN 3 — the real request/response loop for a grounded Stella
// query: from asking a question to a GroundedAnswerView, through to the
// human decision that governs whether it gets used.
//
// This is the runtime container train 2 anticipated but did not build:
// StellaGroundedAnswerPanel is a pure renderer with no fetch cycle, and
// StellaContextualAdvisorPanel takes `groundedAnswer` as a prop supplied
// from outside its own request lifecycle (by design — see the comment at
// its mount site). Neither one asks a question and waits for an answer.
// This one does — but it still does not retrieve, does not validate scope
// and does not call a model: `runQuery` is supplied by the caller (see
// grounded-query.ts / docs/ops/contracts/PRODUCT-002) and is the ONLY seam
// through which any answer, evidence or error reaches this file. No
// fixture and no default implementation is wired here as runtime.
//
// Human decision (accept / edit / reject / undo) mirrors the vocabulary
// StellaContextualAdvisorPanel already uses for suggestions
// (decision-types.ts), reused rather than reinvented. It differs in one
// respect the two flows are genuinely different in: a suggestion proposes
// text meant to overwrite a report field, so "edit" changes that text. A
// grounded answer's claims are verified, hash-backed evidence — editing
// their wording would silently detach them from the citations that back
// them, exactly what grounding-adapter.ts exists to prevent. So here,
// "accept with edits" attaches the reviewer's own comment alongside an
// unmodified answer; it never rewrites a claim or a citation.

import { useId, useRef, useState } from 'react'
import { Check, Pencil, Undo2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StellaGroundedAnswerPanel } from './StellaGroundedAnswerPanel'
import { StellaErrorNotice } from './StellaErrorNotice'
import { decisionStatusFromAction } from './grounding-model'
import type { StellaDecisionStatus } from './grounding-model'
import type { GroundedAnswerView, GroundedCitationView } from './grounding-adapter'
import type { StellaGroundedQueryRunner } from './grounded-query'
import type { SuggestionDecisionRecord, SuggestionDecisionAction } from './decision-types'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { StellaPanelErrorCode } from './error-messages'

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; answerId: string; answer: GroundedAnswerView }
  | { status: 'error'; code: StellaPanelErrorCode; message: string }
  | { status: 'disabled' }

type DecisionMode = 'none' | 'edit' | 'reject'

const ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const PRIMARY_ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export interface StellaGroundedQueryPanelProps {
  /** Pipeline step the human was reviewing when they asked — carried into the decision record, same as the advisor panel. */
  step: AdvisorPipelineStep
  /**
   * The only way an answer, an error or evidence reaches this component.
   * There is no built-in implementation and no fixture wired as a
   * fallback — see docs/ops/contracts/PRODUCT-002.
   */
  runQuery: StellaGroundedQueryRunner
  /** Server-passed availability (from lib/stella/config on the page). When false the panel never calls runQuery. */
  enabled?: boolean
  title?: string
  className?: string
  headingLevel?: 2 | 3 | 4
  onNavigateCitation?: (citation: GroundedCitationView) => void
  /** Decision persistence hook (default no-op) — see decision-types.ts. */
  onDecision?: (record: SuggestionDecisionRecord) => void
}

export function StellaGroundedQueryPanel({
  step,
  runQuery,
  enabled = true,
  title,
  className,
  headingLevel = 2,
  onNavigateCitation,
  onDecision,
}: StellaGroundedQueryPanelProps) {
  const [queryDraft, setQueryDraft] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const [decisionStatus, setDecisionStatus] = useState<StellaDecisionStatus>('user_approval_required')
  const [decisionMode, setDecisionMode] = useState<DecisionMode>('none')
  const [commentDraft, setCommentDraft] = useState('')
  const [rejectionReasonDraft, setRejectionReasonDraft] = useState('')
  const [hasDecision, setHasDecision] = useState(false)
  const resultRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const idPrefix = useId()

  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const panelTitle = title ?? 'Preguntar a Stella'
  const isLoading = panelState.status === 'loading'
  const isInertDisabled = !enabled || panelState.status === 'disabled'

  function resetDecisionState() {
    setDecisionStatus('user_approval_required')
    setDecisionMode('none')
    setCommentDraft('')
    setRejectionReasonDraft('')
    setHasDecision(false)
  }

  async function runAndHandle(query: string) {
    setPanelState({ status: 'loading' })
    resetDecisionState()
    try {
      const result = await runQuery({ query })
      if (result.status === 'ok') {
        setPanelState({ status: 'ok', answerId: result.answerId, answer: result.answer })
      } else if (result.code === 'DISABLED') {
        setPanelState({ status: 'disabled' })
      } else {
        setPanelState({ status: 'error', code: result.code, message: result.message })
      }
    } catch {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
    }
  }

  async function handleSubmit() {
    const query = queryDraft.trim()
    if (query.length === 0 || isLoading || isInertDisabled) return
    setLastQuery(query)
    await runAndHandle(query)
  }

  async function handleRetry() {
    if (lastQuery.length === 0) return
    await runAndHandle(lastQuery)
  }

  function emitDecision(answerId: string, action: SuggestionDecisionAction, extra: Partial<SuggestionDecisionRecord> = {}) {
    const record: SuggestionDecisionRecord = {
      suggestionId: answerId,
      step,
      action,
      proposedText: null,
      decidedAt: new Date().toISOString(),
      ...extra,
    }
    setDecisionStatus(decisionStatusFromAction(action))
    setDecisionMode('none')
    setHasDecision(action !== 'undone')
    onDecision?.(record)
  }

  function handleAccept(answerId: string) {
    emitDecision(answerId, 'accepted')
  }

  function handleConfirmEdit(answerId: string) {
    const comment = commentDraft.trim()
    if (comment.length === 0) return
    emitDecision(answerId, 'accepted_edited', { appliedText: comment })
  }

  function handleConfirmReject(answerId: string) {
    const reason = rejectionReasonDraft.trim()
    emitDecision(answerId, 'rejected', reason.length > 0 ? { rejectionReason: reason } : {})
  }

  function handleUndo(answerId: string) {
    emitDecision(answerId, 'undone')
  }

  return (
    <section
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm', className)}
      aria-label={panelTitle}
      data-testid="stella-grounded-query-panel"
    >
      <div className="min-w-0">
        <HeadingTag className="text-sm font-semibold text-foreground">{panelTitle}</HeadingTag>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Escribí una pregunta y Stella responderá con evidencia citada, cuando esté disponible. Stella
          brinda orientación consultiva únicamente.
        </p>
      </div>

      <div className="mt-3 space-y-1.5">
        <label htmlFor={`${idPrefix}-query`} className="sr-only">
          Pregunta para Stella
        </label>
        <textarea
          id={`${idPrefix}-query`}
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          disabled={isLoading || isInertDisabled}
          rows={2}
          placeholder="¿Qué querés preguntarle a Stella sobre este proyecto?"
          className="block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isLoading || isInertDisabled || queryDraft.trim().length === 0}
          className={cn(PRIMARY_ACTION_BUTTON_CLASS, 'px-3 py-1.5 text-sm')}
        >
          {isLoading ? 'Consultando…' : 'Preguntar a Stella'}
        </button>
      </div>

      {isInertDisabled && (
        <p className="mt-3 text-muted-foreground" data-testid="stella-grounded-query-disabled">
          Stella no está habilitada para tu organización en este momento.
        </p>
      )}

      <div aria-live="polite" data-testid="stella-grounded-query-live-polite">
        {panelState.status === 'loading' && (
          <div
            aria-busy="true"
            aria-label="Consultando a Stella…"
            data-testid="stella-grounded-query-loading"
            className="mt-3 space-y-2"
          >
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
          </div>
        )}

        {panelState.status === 'ok' && (
          <div ref={resultRef} tabIndex={-1} className="mt-3 space-y-3 focus-visible:outline-none">
            <StellaGroundedAnswerPanel
              answer={{ ...panelState.answer, decisionStatus }}
              onNavigateCitation={onNavigateCitation}
              headingLevel={Math.min(headingLevel + 1, 4) as 2 | 3 | 4}
            />

            <div
              className="rounded-md border border-border bg-background p-2.5"
              data-testid="stella-grounded-query-decision-actions"
            >
              {decisionMode === 'edit' ? (
                <div className="space-y-1.5">
                  <label
                    htmlFor={`${idPrefix}-comment`}
                    className="block text-xs font-medium text-foreground"
                  >
                    Comentario del revisor (obligatorio para aceptar con cambios)
                  </label>
                  <textarea
                    id={`${idPrefix}-comment`}
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    rows={3}
                    className="block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={PRIMARY_ACTION_BUTTON_CLASS}
                      disabled={commentDraft.trim().length === 0}
                      onClick={() => handleConfirmEdit(panelState.answerId)}
                    >
                      <Check className="h-3 w-3" aria-hidden="true" />
                      Aceptar con comentario
                    </button>
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      onClick={() => setDecisionMode('none')}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : decisionMode === 'reject' ? (
                <div className="space-y-1.5">
                  <label
                    htmlFor={`${idPrefix}-reject-reason`}
                    className="block text-xs font-medium text-foreground"
                  >
                    Motivo del rechazo (opcional)
                  </label>
                  <input
                    id={`${idPrefix}-reject-reason`}
                    type="text"
                    value={rejectionReasonDraft}
                    onChange={(event) => setRejectionReasonDraft(event.target.value)}
                    className="block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      onClick={() => handleConfirmReject(panelState.answerId)}
                    >
                      Confirmar rechazo
                    </button>
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      onClick={() => setDecisionMode('none')}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={PRIMARY_ACTION_BUTTON_CLASS}
                    disabled={hasDecision}
                    onClick={() => handleAccept(panelState.answerId)}
                  >
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Aceptar
                  </button>
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    disabled={hasDecision}
                    onClick={() => setDecisionMode('edit')}
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    Aceptar con comentario
                  </button>
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    disabled={hasDecision}
                    onClick={() => setDecisionMode('reject')}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    Rechazar
                  </button>
                  {hasDecision && (
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      onClick={() => handleUndo(panelState.answerId)}
                    >
                      <Undo2 className="h-3 w-3" aria-hidden="true" />
                      Deshacer
                    </button>
                  )}
                </div>
              )}

              {/* INTEGRATION, TRAIN 3. `decisionStatus` flips to "Aceptada" /
                  "Rechazada" the moment the button is pressed, and
                  StellaGroundedAnswerPanel paints that badge exactly as it does
                  for flows whose decisions ARE written by recordStellaDecision.
                  With no `onDecision` wired, nothing receives the record and it
                  dies on unmount — so the badge alone would tell a reviewer
                  their decision was filed when it was not.

                  There is no canonical decision key for a grounded answer yet
                  (contract INT-PR-001: recordStellaDecision keys on
                  `suggestionKey`, and a grounded answer is not a suggestion),
                  so the honest thing is to SAY SO rather than to hide the
                  affordance or to invent a key. */}
              {hasDecision && onDecision === undefined && (
                <p
                  role="note"
                  data-testid="stella-grounded-query-decision-not-persisted"
                  className="mt-2 text-xs text-muted-foreground"
                >
                  Esta decisión no se guardó: queda sólo en esta sesión y se pierde al recargar.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div aria-live="assertive" data-testid="stella-grounded-query-live-assertive">
        {panelState.status === 'error' && (
          <div ref={errorRef} tabIndex={-1} className="mt-3 focus-visible:outline-none">
            <StellaErrorNotice code={panelState.code} message={panelState.message} onRetry={handleRetry} />
          </div>
        )}
      </div>
    </section>
  )
}
