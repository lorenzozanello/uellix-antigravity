'use client'
// components/stella/StellaComposerSectionEditor.tsx
// WS2 (Moonshot) U4 — controlled owner of one report section's title/content.
//
// Mounted from the report page INSIDE the section's server-action <form>:
// the inputs carry name="title" / name="content", so the existing
// updateReportSection server action keeps receiving the values on submit.
// The Stella Composer panel hands drafts to this component via `onUseDraft`;
// nothing ever writes to the DOM imperatively and nothing auto-saves.
//
// - Overwrite confirmation: applying a draft over non-empty content asks
//   for explicit confirmation first (Escape cancels).
// - Undo: every apply pushes the previous {title, content} onto a client
//   history stack; "Deshacer" restores the most recent entry.

import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { StellaComposerPanel, type ComposerDraft } from './StellaComposerPanel'

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y'

interface SectionHistoryEntry {
  title: string
  content: string
  /** ISO-8601 timestamp of the apply that displaced this state. */
  at: string
}

interface StellaComposerSectionEditorProps {
  projectId: string
  reportId: string
  sectionId: string
  sectionType: string
  /** Server-passed Stella Composer availability (lib/stella/config). */
  enabled?: boolean
  initialTitle: string
  initialContent: string
  /** Ids kept from the page so existing label/anchor semantics survive. */
  titleInputId: string
  contentInputId: string
  /** Optional helper copy shown under the content field. */
  helper?: string
}

export function StellaComposerSectionEditor({
  projectId,
  reportId,
  sectionId,
  sectionType,
  enabled = true,
  initialTitle,
  initialContent,
  titleInputId,
  contentInputId,
  helper,
}: StellaComposerSectionEditorProps) {
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [history, setHistory] = useState<SectionHistoryEntry[]>([])
  const [pendingDraft, setPendingDraft] = useState<ComposerDraft | null>(null)

  function applyDraft(draft: ComposerDraft) {
    setHistory((prev) => [...prev, { title, content, at: new Date().toISOString() }])
    setTitle(draft.title)
    setContent(draft.content)
    setPendingDraft(null)
  }

  function handleUseDraft(draft: ComposerDraft) {
    // Overwrite confirmation only when the user would lose non-empty content.
    if (content.trim().length > 0) {
      setPendingDraft(draft)
    } else {
      applyDraft(draft)
    }
  }

  function handleUndo() {
    setHistory((prev) => {
      const entry = prev[prev.length - 1]
      if (!entry) return prev
      setTitle(entry.title)
      setContent(entry.content)
      return prev.slice(0, -1)
    })
  }

  return (
    <div className="space-y-3">
      <StellaComposerPanel
        projectId={projectId}
        reportId={reportId}
        sectionId={sectionId}
        sectionType={sectionType}
        enabled={enabled}
        onUseDraft={handleUseDraft}
      />

      {/* Overwrite confirmation — explicit, keyboard-dismissable. */}
      {pendingDraft && (
        <div
          role="alertdialog"
          aria-label="Confirmar reemplazo de contenido"
          data-testid="stella-composer-overwrite-confirm"
          className="rounded-md border border-uellix-orange/30 bg-uellix-orange/5 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setPendingDraft(null)
            }
          }}
        >
          <p className="text-sm font-medium text-foreground">
            Esta sección ya tiene contenido.
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Al usar el borrador de Stella se reemplazará el título y el contenido actuales. Podés
            deshacer el reemplazo después.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applyDraft(pendingDraft)}
              className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reemplazar contenido
            </button>
            <button
              type="button"
              onClick={() => setPendingDraft(null)}
              className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div>
        <label htmlFor={titleInputId} className="block text-xs font-medium text-foreground">
          Título de la sección
        </label>
        <input
          id={titleInputId}
          name="title"
          type="text"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor={contentInputId} className="block text-xs font-medium text-foreground">
          Contenido
        </label>
        <textarea
          id={contentInputId}
          name="content"
          rows={5}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={helper || 'Documentación metodológica para esta sección…'}
          className={TEXTAREA_CLASS}
        />
        {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
      </div>

      {history.length > 0 && (
        <button
          type="button"
          onClick={handleUndo}
          data-testid="stella-composer-undo"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Undo2 className="h-3 w-3" aria-hidden="true" />
          Deshacer borrador aplicado
        </button>
      )}
    </div>
  )
}
