// components/evidence/EvidenceIndexStatus.tsx
// G-01 (product path) — one evidence row's place in the grounding corpus,
// rendered.
//
// ---------------------------------------------------------------------------
// A CELL, NOT A SECOND EVIDENCE PRODUCT
// ---------------------------------------------------------------------------
// This belongs in the row of the evidence table that already exists. Evidence
// management — upload, review, archive, integrity — is one surface, and moving
// indexing into a panel of its own would ask a reviewer to hold two mental
// models of the same list.
//
// It holds NO client state and is not a client component. Everything it renders
// comes from the read model, which derives it from durable facts; the only
// interaction is a form whose action is the server action the page passes in.
// "Indexing…" is therefore the browser's pending state for that submission and
// nothing else — there is no durable in-progress fact to render, because an
// in-flight ingestion holds an uncommitted transaction nobody else can see.
//
// ---------------------------------------------------------------------------
// WHY EVERY PHASE HAS ITS OWN WORD
// ---------------------------------------------------------------------------
// The distinction the whole feature exists for is STORED versus INDEXED, and it
// dies the moment two phases share a label. `not_indexable` must not read as
// "pending" (nothing is coming), `indexed_stale` must not read as "indexed"
// (the anchors no longer resolve), and `incomplete` must not read as either
// (the corpus holds a version with nothing in it).

import { Badge } from '@/components/ui/badge'
import type { EvidenceCorpusState, EvidenceIndexPhase } from '@/lib/grounding/corpus-state'

interface PhasePresentation {
  readonly variant: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  readonly label: string
}

const PHASE: Record<EvidenceIndexPhase, PhasePresentation> = {
  not_indexable: { variant: 'neutral', label: 'No indexable' },
  ready_to_index: { variant: 'info', label: 'Pendiente de indexar' },
  indexed: { variant: 'success', label: 'Indexado' },
  indexed_stale: { variant: 'warning', label: 'Índice desactualizado' },
  incomplete: { variant: 'warning', label: 'Índice incompleto' },
  failed_retryable: { variant: 'danger', label: 'Indexación falló' },
  failed_terminal: { variant: 'danger', label: 'Indexación falló' },
}

export interface EvidenceIndexStatusProps {
  readonly state: EvidenceCorpusState
  readonly projectId: string
  /** The page's `'use server'` form action. This component never calls it. */
  readonly retryAction: (formData: FormData) => void | Promise<void>
  /** For the control's accessible name in a table of many rows. */
  readonly evidenceTitle?: string
}

export function EvidenceIndexStatus({
  state,
  projectId,
  retryAction,
  evidenceTitle,
}: EvidenceIndexStatusProps) {
  const presentation = PHASE[state.phase]

  return (
    <div className="flex flex-col gap-1">
      <Badge variant={presentation.variant}>{presentation.label}</Badge>

      {state.chunkCount !== null && state.chunkCount > 0 && (
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {state.chunkCount} {state.chunkCount === 1 ? 'fragmento' : 'fragmentos'}
          {state.versionOrdinal !== null && ` · v${state.versionOrdinal}`}
        </span>
      )}

      {state.detail !== null && (
        // Wrapped rather than truncated: the detail is the whole reason a
        // reviewer can act on the verdict, and a title-only tooltip is
        // unreachable by keyboard and by a screen reader.
        <span className="text-[10px] leading-snug text-muted-foreground max-w-[220px]">
          {state.detail}
        </span>
      )}

      {state.canRetry && (
        <form action={retryAction}>
          {/* Both are re-verified server-side against the session. They
              identify the row; they do not authorize it. */}
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="evidenceId" value={state.evidenceId} />
          <button
            type="submit"
            className="text-left text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label={
              evidenceTitle === undefined
                ? 'Indexar para grounding'
                : `Indexar para grounding: ${evidenceTitle}`
            }
          >
            {state.phase === 'ready_to_index' ? 'Indexar' : 'Reintentar indexación'}
          </button>
        </form>
      )}
    </div>
  )
}
