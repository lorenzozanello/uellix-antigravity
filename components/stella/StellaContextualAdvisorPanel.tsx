'use client'
// components/stella/StellaContextualAdvisorPanel.tsx
// WS2 (Moonshot) — on-demand contextual advisor panel (U1/U2/U5/U6).
//
// - Never auto-invokes: the user triggers via "Consultar a Stella".
// - Renders summary, findings grouped by severity, suggestions with a full
//   client-side lifecycle (preview / accept / edit / reject / undo) and the
//   uncertainty surface (limitations + clarifying questions).
// - NO automatic writes and NO DOM hacks: applying a suggestion only fires
//   the `onApply` callback prop; pages without an editable target get a
//   copy-to-clipboard affordance instead.
// - Every decision is reported through the optional `onDecision` callback
//   (persistence hook — see decision-types.ts).
// - Availability is a server-passed prop (`enabled`); when false, or when the
//   action answers DISABLED post-click, the panel renders an inert
//   informative state instead of unmounting.
// - Accessibility: persistent live regions mounted at idle (assertive only
//   for errors), focus moves to the result on success and the error on
//   failure, Escape closes preview/edit/reject, headings adapt via
//   `headingLevel`.

import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  HelpCircle,
  Info,
  Pencil,
  Undo2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getStellaContextualAdvisor } from '@/app/actions/stella/advisor'
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import { StellaErrorNotice } from './StellaErrorNotice'
import type { AppliedSuggestionHistoryEntry, SuggestionDecisionRecord } from './decision-types'
import { sourceFieldLabel } from './source-field-label'

export type ContextualFinding = AdvisorContextualOutput['findings'][number]
export type ContextualSuggestion = AdvisorContextualOutput['suggestions'][number]

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AdvisorContextualOutput }
  | { status: 'error'; code: string; message: string }
  | { status: 'disabled' }

interface SuggestionUiState {
  mode: 'none' | 'preview' | 'edit' | 'reject'
  editedText: string
  rejectionReasonDraft: string
  rejected: boolean
  copied: boolean
}

const INITIAL_SUGGESTION_UI: SuggestionUiState = {
  mode: 'none',
  editedText: '',
  rejectionReasonDraft: '',
  rejected: false,
  copied: false,
}

const RESPONSE_TYPE_LABELS: Record<AdvisorContextualOutput['responseType'], string> = {
  explanation: 'Explicación',
  review: 'Revisión',
  reformulation: 'Reformulación',
  gap_analysis: 'Análisis de vacíos',
}

const SEVERITY_META = {
  warning: { label: 'Advertencia', badgeClass: 'bg-uellix-orange/10 text-uellix-orange-strong' },
  info: { label: 'Información', badgeClass: 'bg-muted text-muted-foreground' },
} as const

const ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const PRIMARY_ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export interface StellaContextualAdvisorPanelProps {
  projectId: string
  step: AdvisorPipelineStep
  /**
   * Server-passed availability (from lib/stella/config on the page). When
   * false the panel renders an inert informative state and never calls the
   * action. Defaults to true for pages that have not been wired yet.
   */
  enabled?: boolean
  title?: string
  className?: string
  /**
   * Heading level of the panel title; subsection headings use level + 1.
   * Pipeline pages mount the panel directly under their h1 → default 2.
   */
  headingLevel?: 2 | 3 | 4
  /**
   * Current value of the page's editable target. Enables the diff-style
   * "Vista previa" and is captured as `previousValue` for undo.
   */
  targetValue?: string
  /** Spanish label of the editable target (e.g. "Texto narrativo"). */
  targetLabel?: string
  /**
   * Apply hook: called with the suggestion and the exact text to place in
   * the target (accepted, edited or undo-restored). The page owns the write;
   * the panel never touches the DOM. When absent, "Aceptar" is replaced by a
   * copy-to-clipboard affordance.
   */
  onApply?: (suggestion: ContextualSuggestion, text: string) => void
  /** Decision persistence hook (default no-op) — see decision-types.ts. */
  onDecision?: (record: SuggestionDecisionRecord) => void
}

export function StellaContextualAdvisorPanel({
  projectId,
  step,
  enabled = true,
  title,
  className,
  headingLevel = 2,
  targetValue,
  targetLabel,
  onApply,
  onDecision,
}: StellaContextualAdvisorPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'idle' })
  const [suggestionUi, setSuggestionUi] = useState<Record<string, SuggestionUiState>>({})
  // GLOBAL LIFO stack for the single shared target field: applies from ALL
  // suggestions interleave on one field, so only the most recent apply is
  // safely undoable — undoing an older entry would silently clobber the
  // newer apply (audit FIX 1).
  const [history, setHistory] = useState<AppliedSuggestionHistoryEntry[]>([])
  // Suggestion id awaiting a stale-undo confirmation (field changed after apply).
  const [pendingUndoId, setPendingUndoId] = useState<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const undoConfirmRef = useRef<HTMLDivElement>(null)
  const idPrefix = useId()

  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const SubheadingTag = `h${Math.min(headingLevel + 1, 6)}` as 'h3' | 'h4' | 'h5'

  // U6: focus the result container on success and the error on failure.
  useEffect(() => {
    if (panelState.status === 'success') resultRef.current?.focus()
    else if (panelState.status === 'error') errorRef.current?.focus()
  }, [panelState.status])

  // Focus the stale-undo confirmation when it opens so Escape works without
  // tabbing (keyboard parity with the composer overwrite confirm).
  useEffect(() => {
    if (pendingUndoId !== null) undoConfirmRef.current?.focus()
  }, [pendingUndoId])

  function uiFor(id: string): SuggestionUiState {
    return suggestionUi[id] ?? INITIAL_SUGGESTION_UI
  }

  function patchUi(id: string, patch: Partial<SuggestionUiState>) {
    setSuggestionUi((prev) => ({ ...prev, [id]: { ...(prev[id] ?? INITIAL_SUGGESTION_UI), ...patch } }))
  }

  async function handleAskStella() {
    setPanelState({ status: 'loading' })
    setSuggestionUi({})
    setHistory([])
    setPendingUndoId(null)
    try {
      const result = await getStellaContextualAdvisor(projectId, step)
      if (result.ok) {
        setPanelState({ status: 'success', data: result.data })
      } else if (result.error === 'DISABLED') {
        // U5: inert informative state, never unmount post-click.
        setPanelState({ status: 'disabled' })
      } else {
        setPanelState({ status: 'error', code: result.error, message: result.message })
      }
    } catch {
      setPanelState({ status: 'error', code: 'UNKNOWN_ERROR', message: '' })
    }
  }

  function emitDecision(record: SuggestionDecisionRecord) {
    onDecision?.(record)
  }

  function applySuggestion(suggestion: ContextualSuggestion, text: string, edited: boolean) {
    if (!onApply) return
    const previousValue = targetValue ?? ''
    onApply(suggestion, text)
    setHistory((prev) => [
      ...prev,
      { suggestionId: suggestion.id, previousValue, appliedValue: text, at: new Date().toISOString() },
    ])
    setPendingUndoId(null)
    patchUi(suggestion.id, { mode: 'none' })
    emitDecision({
      suggestionId: suggestion.id,
      step,
      action: edited ? 'accepted_edited' : 'accepted',
      proposedText: suggestion.proposedText,
      appliedText: text,
      previousValue,
      decidedAt: new Date().toISOString(),
    })
  }

  /**
   * Executes the undo of the TOP stack entry (global LIFO — audit FIX 1).
   * The emitted record reflects reality: `previousValue` is the field value
   * the undo actually displaced (the current value at undo time) and
   * `appliedText` is the value restored into the field.
   */
  function performUndo(suggestion: ContextualSuggestion) {
    if (!onApply) return
    const entry = history[history.length - 1]
    if (!entry || entry.suggestionId !== suggestion.id) return
    const displacedValue = targetValue ?? ''
    onApply(suggestion, entry.previousValue)
    setHistory((prev) => prev.slice(0, -1))
    setPendingUndoId(null)
    emitDecision({
      suggestionId: suggestion.id,
      step,
      action: 'undone',
      proposedText: suggestion.proposedText,
      appliedText: entry.previousValue,
      previousValue: displacedValue,
      decidedAt: new Date().toISOString(),
    })
  }

  /**
   * Undo entry point: only the top of the global stack is undoable. If the
   * field changed after the apply (the user typed over it), undoing would
   * destroy that edit — require an explicit confirmation first.
   */
  function requestUndo(suggestion: ContextualSuggestion) {
    const entry = history[history.length - 1]
    if (!entry || entry.suggestionId !== suggestion.id) return
    if ((targetValue ?? '') !== entry.appliedValue) {
      setPendingUndoId(suggestion.id)
    } else {
      performUndo(suggestion)
    }
  }

  async function copySuggestion(suggestion: ContextualSuggestion, text: string) {
    try {
      await navigator.clipboard?.writeText(text)
    } catch {
      // Clipboard may be unavailable (permissions, jsdom) — the visible text
      // block remains selectable, so this is a soft failure.
    }
    patchUi(suggestion.id, { copied: true })
    emitDecision({
      suggestionId: suggestion.id,
      step,
      action: 'copied',
      proposedText: suggestion.proposedText,
      appliedText: text,
      decidedAt: new Date().toISOString(),
    })
  }

  function rejectSuggestion(suggestion: ContextualSuggestion, reason: string) {
    patchUi(suggestion.id, { rejected: true, mode: 'none' })
    emitDecision({
      suggestionId: suggestion.id,
      step,
      action: 'rejected',
      proposedText: suggestion.proposedText,
      rejectionReason: reason.trim() ? reason.trim() : undefined,
      decidedAt: new Date().toISOString(),
    })
  }

  const isLoading = panelState.status === 'loading'
  const isInertDisabled = !enabled || panelState.status === 'disabled'
  const panelTitle = title ?? 'Stella — Asesoría contextual'

  return (
    <section
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm', className)}
      aria-label={panelTitle}
      data-testid="stella-contextual-advisor-panel"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <HeadingTag className="text-sm font-semibold text-foreground">{panelTitle}</HeadingTag>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Análisis del contenido real de este paso, con fuentes citadas. Stella brinda orientación
            consultiva únicamente.
          </p>
        </div>
        <button
          type="button"
          onClick={isLoading || isInertDisabled ? undefined : handleAskStella}
          disabled={isLoading || isInertDisabled}
          className={cn(ACTION_BUTTON_CLASS, 'shrink-0 px-3 py-1.5 text-sm')}
        >
          {isLoading ? 'Analizando…' : 'Consultar a Stella'}
        </button>
      </div>

      {/* U1: human-review banner — always visible, independent of state. */}
      <div
        role="note"
        className="mt-3 rounded-md border border-uellix-orange/30 bg-uellix-orange/5 p-2.5"
        data-testid="stella-human-review-note"
      >
        <p className="text-xs font-medium text-uellix-orange-strong">Se requiere revisión humana</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Ninguna sugerencia se aplica ni se guarda automáticamente. Se requiere revisión humana
          antes de su uso externo.
        </p>
      </div>

      {/* U5: inert informative state (server-disabled or post-click DISABLED). */}
      {isInertDisabled && (
        <p className="mt-3 text-muted-foreground" data-testid="stella-contextual-disabled">
          Stella no está habilitada para tu organización en este momento. Los datos de tu pipeline
          no se ven afectados.
        </p>
      )}

      {/* U6: persistent polite live region — mounted at idle, empty until it
          has something to announce. */}
      <div aria-live="polite" data-testid="stella-contextual-live-polite">
        {panelState.status === 'loading' && (
          <div
            aria-busy="true"
            aria-label="Analizando el paso con Stella…"
            data-testid="stella-contextual-loading"
            className="mt-3 space-y-2"
          >
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
          </div>
        )}

        {panelState.status === 'success' && (
          <div
            ref={resultRef}
            tabIndex={-1}
            data-testid="stella-contextual-result"
            className="mt-3 space-y-4 focus-visible:outline-none"
          >
            {/* Summary */}
            <div>
              <div className="flex items-center gap-2">
                <SubheadingTag className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  Resumen
                </SubheadingTag>
                <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {RESPONSE_TYPE_LABELS[panelState.data.responseType]}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">{panelState.data.summary}</p>
            </div>

            {/* Findings grouped by severity: warnings first. */}
            {panelState.data.findings.length > 0 && (
              <div>
                <SubheadingTag className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                  Hallazgos
                </SubheadingTag>
                <ul className="space-y-2">
                  {(['warning', 'info'] as const).flatMap((severity) =>
                    panelState.data.findings
                      .filter((f) => f.severity === severity)
                      .map((finding) => (
                        <li
                          key={finding.id}
                          className="rounded-md border border-border bg-background p-2.5"
                          data-severity={finding.severity}
                        >
                          <div className="flex items-start gap-2">
                            {finding.severity === 'warning' ? (
                              <AlertTriangle
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-uellix-orange-strong"
                                aria-hidden="true"
                              />
                            ) : (
                              <Info
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">
                                <span
                                  className={cn(
                                    'mr-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                    SEVERITY_META[finding.severity].badgeClass
                                  )}
                                >
                                  {SEVERITY_META[finding.severity].label}
                                </span>
                                {finding.title}
                              </p>
                              <p className="mt-1 text-muted-foreground">{finding.explanation}</p>
                              <SourceChips sourceFields={finding.sourceFields} />
                            </div>
                          </div>
                        </li>
                      ))
                  )}
                </ul>
              </div>
            )}

            {/* Suggestions with lifecycle (U2). */}
            {panelState.data.suggestions.length > 0 && (
              <div>
                <SubheadingTag className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                  Sugerencias
                </SubheadingTag>
                <ul className="space-y-3">
                  {panelState.data.suggestions.map((suggestion) => {
                    const ui = uiFor(suggestion.id)
                    const applied = history.some((e) => e.suggestionId === suggestion.id)
                    const topEntry = history[history.length - 1]
                    const isTopOfStack = topEntry?.suggestionId === suggestion.id
                    const canApply = Boolean(onApply)
                    const effectiveText = ui.mode === 'edit' ? ui.editedText : suggestion.proposedText ?? ''

                    return (
                      <li
                        key={suggestion.id}
                        className="rounded-md border border-border bg-background p-3"
                        data-testid={`stella-suggestion-${suggestion.id}`}
                        onKeyDown={(event) => {
                          // U6: Escape closes preview / edit / reject / undo-confirm.
                          if (
                            event.key === 'Escape' &&
                            (ui.mode !== 'none' || pendingUndoId === suggestion.id)
                          ) {
                            event.stopPropagation()
                            patchUi(suggestion.id, { mode: 'none' })
                            if (pendingUndoId === suggestion.id) setPendingUndoId(null)
                          }
                        }}
                      >
                        <p className="text-muted-foreground">{suggestion.rationale}</p>

                        {suggestion.proposedText !== null ? (
                          <blockquote className="mt-2 whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 text-foreground">
                            {suggestion.proposedText}
                          </blockquote>
                        ) : (
                          <div className="mt-2 rounded border border-dashed border-border p-2">
                            <p className="text-xs font-medium text-foreground">
                              Stella no tiene información suficiente para proponer un texto.
                            </p>
                            {suggestion.missingInformation.length > 0 && (
                              <ul className="mt-1 list-disc list-inside text-xs text-muted-foreground">
                                {suggestion.missingInformation.map((item, i) => (
                                  <li key={i}>{item}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}

                        <SourceChips sourceFields={suggestion.sourceFields} />

                        {ui.rejected ? (
                          <p className="mt-2 text-xs text-muted-foreground italic" data-testid={`stella-suggestion-rejected-${suggestion.id}`}>
                            Sugerencia rechazada. No se aplicó ningún cambio.
                          </p>
                        ) : (
                          <>
                            {/* Diff-style preview — only when the page supplies a target value. */}
                            {ui.mode === 'preview' && targetValue !== undefined && suggestion.proposedText !== null && (
                              <div
                                className="mt-2 space-y-1.5 rounded border border-border p-2"
                                data-testid={`stella-suggestion-preview-${suggestion.id}`}
                              >
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {targetLabel ? `Vista previa — ${targetLabel}` : 'Vista previa'}
                                </p>
                                <del className="block whitespace-pre-wrap rounded bg-danger-light/50 p-1.5 text-xs text-foreground/80 no-underline">
                                  {targetValue.length > 0 ? targetValue : '(sin contenido actual)'}
                                </del>
                                <ins className="block whitespace-pre-wrap rounded bg-uellix-orange/10 p-1.5 text-xs text-foreground no-underline">
                                  {suggestion.proposedText}
                                </ins>
                              </div>
                            )}

                            {/* Inline edit — controlled textarea seeded with proposedText. */}
                            {ui.mode === 'edit' && (
                              <div className="mt-2 space-y-1.5">
                                <label
                                  htmlFor={`${idPrefix}-edit-${suggestion.id}`}
                                  className="block text-xs font-medium text-foreground"
                                >
                                  Editar propuesta
                                </label>
                                <textarea
                                  id={`${idPrefix}-edit-${suggestion.id}`}
                                  value={ui.editedText}
                                  onChange={(event) => patchUi(suggestion.id, { editedText: event.target.value })}
                                  rows={4}
                                  className="block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                                />
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    className={PRIMARY_ACTION_BUTTON_CLASS}
                                    disabled={ui.editedText.trim().length === 0}
                                    onClick={() => applySuggestion(suggestion, ui.editedText, true)}
                                  >
                                    <Check className="h-3 w-3" aria-hidden="true" />
                                    Aplicar edición
                                  </button>
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    onClick={() => patchUi(suggestion.id, { mode: 'none' })}
                                  >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                    Cancelar
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Reject with optional reason. */}
                            {ui.mode === 'reject' && (
                              <div className="mt-2 space-y-1.5">
                                <label
                                  htmlFor={`${idPrefix}-reject-${suggestion.id}`}
                                  className="block text-xs font-medium text-foreground"
                                >
                                  Motivo del rechazo (opcional)
                                </label>
                                <input
                                  id={`${idPrefix}-reject-${suggestion.id}`}
                                  type="text"
                                  value={ui.rejectionReasonDraft}
                                  onChange={(event) =>
                                    patchUi(suggestion.id, { rejectionReasonDraft: event.target.value })
                                  }
                                  className="block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    onClick={() => rejectSuggestion(suggestion, ui.rejectionReasonDraft)}
                                  >
                                    Confirmar rechazo
                                  </button>
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    onClick={() => patchUi(suggestion.id, { mode: 'none' })}
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Action row. */}
                            {ui.mode !== 'edit' && ui.mode !== 'reject' && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {canApply && targetValue !== undefined && (
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    disabled={suggestion.proposedText === null}
                                    aria-expanded={ui.mode === 'preview'}
                                    onClick={() =>
                                      patchUi(suggestion.id, {
                                        mode: ui.mode === 'preview' ? 'none' : 'preview',
                                      })
                                    }
                                  >
                                    {ui.mode === 'preview' ? 'Cerrar vista previa' : 'Vista previa'}
                                  </button>
                                )}
                                {canApply ? (
                                  <>
                                    <button
                                      type="button"
                                      className={PRIMARY_ACTION_BUTTON_CLASS}
                                      disabled={suggestion.proposedText === null}
                                      onClick={() =>
                                        suggestion.proposedText !== null &&
                                        applySuggestion(suggestion, suggestion.proposedText, false)
                                      }
                                    >
                                      <Check className="h-3 w-3" aria-hidden="true" />
                                      Aceptar
                                    </button>
                                    <button
                                      type="button"
                                      className={ACTION_BUTTON_CLASS}
                                      disabled={suggestion.proposedText === null}
                                      onClick={() =>
                                        patchUi(suggestion.id, {
                                          mode: 'edit',
                                          editedText:
                                            uiFor(suggestion.id).editedText.length > 0
                                              ? uiFor(suggestion.id).editedText
                                              : suggestion.proposedText ?? '',
                                        })
                                      }
                                    >
                                      <Pencil className="h-3 w-3" aria-hidden="true" />
                                      Editar
                                    </button>
                                  </>
                                ) : (
                                  suggestion.proposedText !== null && (
                                    <button
                                      type="button"
                                      className={ACTION_BUTTON_CLASS}
                                      onClick={() => copySuggestion(suggestion, effectiveText)}
                                    >
                                      <Copy className="h-3 w-3" aria-hidden="true" />
                                      {ui.copied ? 'Copiado' : 'Copiar texto propuesto'}
                                    </button>
                                  )
                                )}
                                <button
                                  type="button"
                                  className={ACTION_BUTTON_CLASS}
                                  onClick={() => patchUi(suggestion.id, { mode: 'reject' })}
                                >
                                  <X className="h-3 w-3" aria-hidden="true" />
                                  Rechazar
                                </button>
                                {applied && (
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    // Global LIFO: only the most recent apply on the
                                    // shared field is undoable (audit FIX 1).
                                    disabled={!isTopOfStack}
                                    title={
                                      isTopOfStack
                                        ? undefined
                                        : 'Solo se puede deshacer la aplicación más reciente sobre este campo.'
                                    }
                                    onClick={() => requestUndo(suggestion)}
                                  >
                                    <Undo2 className="h-3 w-3" aria-hidden="true" />
                                    Deshacer
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Stale-undo confirmation: the field changed after
                                this apply — undoing would discard that edit. */}
                            {pendingUndoId === suggestion.id && (
                              <div
                                ref={undoConfirmRef}
                                tabIndex={-1}
                                role="alertdialog"
                                aria-label="Confirmar deshacer"
                                data-testid={`stella-undo-confirm-${suggestion.id}`}
                                className="mt-2 rounded-md border border-uellix-orange/30 bg-uellix-orange/5 p-2.5 focus-visible:outline-none"
                              >
                                <p className="text-xs font-medium text-foreground">
                                  El texto del campo cambió después de aplicar esta sugerencia.
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  Al deshacer se reemplazará el contenido actual por el valor previo a
                                  la aplicación y se perderán esos cambios.
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    className={PRIMARY_ACTION_BUTTON_CLASS}
                                    onClick={() => performUndo(suggestion)}
                                  >
                                    Confirmar deshacer
                                  </button>
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    onClick={() => setPendingUndoId(null)}
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {/* Uncertainty surface: clarifying questions vs. limitations,
                rendered distinctly (U1). */}
            {panelState.data.clarifyingQuestions.length > 0 && (
              <div className="rounded-md border border-border bg-background p-2.5">
                <SubheadingTag className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Preguntas para aclarar
                </SubheadingTag>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  {panelState.data.clarifyingQuestions.map((question, i) => (
                    <li key={i}>{question}</li>
                  ))}
                </ul>
              </div>
            )}

            {panelState.data.limitations.length > 0 && (
              <div>
                <SubheadingTag className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
                  <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Limitaciones
                </SubheadingTag>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-muted-foreground">
                  {panelState.data.limitations.map((limitation, i) => (
                    <li key={i}>{limitation}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="border-t border-border pt-2 text-xs text-muted-foreground/70">
              Stella brinda orientación consultiva únicamente. Se requiere revisión humana antes de
              su uso externo.
            </p>
          </div>
        )}
      </div>

      {/* U6: persistent assertive live region — errors only. */}
      <div aria-live="assertive" data-testid="stella-contextual-live-assertive">
        {panelState.status === 'error' && (
          <div ref={errorRef} tabIndex={-1} className="mt-3 focus-visible:outline-none">
            <StellaErrorNotice
              code={panelState.code}
              message={panelState.message}
              onRetry={handleAskStella}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function SourceChips({ sourceFields }: { sourceFields: readonly string[] }) {
  if (sourceFields.length === 0) return null
  return (
    <ul aria-label="Fuentes" className="mt-1.5 flex flex-wrap gap-1">
      {sourceFields.map((path, i) => (
        <li
          key={`${path}-${i}`}
          className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground"
          title={path}
        >
          {sourceFieldLabel(path)}
        </li>
      ))}
    </ul>
  )
}
