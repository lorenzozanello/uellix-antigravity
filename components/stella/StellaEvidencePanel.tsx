'use client'
// components/stella/StellaEvidencePanel.tsx
// PRODUCT TRAIN 1 -- renders a claim's citations. Purely presentational: the
// panel never scrolls/highlights anything itself. When the caller supplies
// onNavigate, chips become buttons and the caller (the page, which knows the
// DOM layout) decides what "navigate to this source" means.
//
// PRODUCT TRAIN 2 -- the same panel now also renders GROUNDED citations
// (GroundedCitationView, produced only by grounding-adapter.ts). The two modes
// are deliberately the same component rather than two: they answer the same
// question for the reader ("what backs this claim?"), and forking them would
// fork the empty state, the navigation contract and the accessibility work.
//
// The grounded mode renders `source_unavailable` as a first-class state. A
// citation whose passage was not loaded is still verifiable -- it carries its
// ids, its hashes and its structured location -- so it is shown, labelled as
// unavailable, and NEVER filled in with substitute text (INTEGRATION-001 §4).

import { cn } from '@/lib/utils'
import type { EvidenceReference } from './grounding-model'
import type { CitationRelevanceBucket, GroundedCitationView } from './grounding-adapter'

const RELEVANCE_LABELS: Record<CitationRelevanceBucket, string> = {
  high: 'Relevancia alta',
  medium: 'Relevancia media',
  low: 'Relevancia baja',
}

const RELEVANCE_CLASSES: Record<CitationRelevanceBucket, string> = {
  high: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  medium: 'bg-uellix-orange/10 text-uellix-orange-strong',
  low: 'bg-muted text-muted-foreground',
}

export interface StellaEvidencePanelProps {
  /** Advisor-derived citations (canonical source-field paths). */
  references?: readonly EvidenceReference[]
  /**
   * Grounded citations, as produced by `adaptCitation`/`adaptGroundedAnswer`.
   * When present they render instead of `references`.
   */
  citations?: readonly GroundedCitationView[]
  /** Shown when there is nothing to render. Defaults to a neutral Spanish message. */
  emptyLabel?: string
  /** When provided, each chip becomes a button that calls this with the clicked reference. */
  onNavigate?: (reference: EvidenceReference) => void
  /** When provided, each grounded citation becomes a button that calls this. */
  onNavigateCitation?: (citation: GroundedCitationView) => void
  className?: string
}

export function StellaEvidencePanel({
  references = [],
  citations,
  emptyLabel,
  onNavigate,
  onNavigateCitation,
  className,
}: StellaEvidencePanelProps) {
  if (citations !== undefined) {
    if (citations.length === 0) return <EvidenceEmptyState emptyLabel={emptyLabel} className={className} />
    return (
      <ol aria-label="Citas fundamentadas" className={cn('space-y-2', className)}>
        {citations.map((citation) => (
          <li key={citation.key}>
            <GroundedCitationItem citation={citation} onNavigate={onNavigateCitation} />
          </li>
        ))}
      </ol>
    )
  }

  if (references.length === 0) return <EvidenceEmptyState emptyLabel={emptyLabel} className={className} />

  const chipClass =
    'inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground'

  return (
    <ul aria-label="Fuentes" className={cn('flex flex-wrap gap-1', className)}>
      {references.map((reference, i) => (
        <li key={`${reference.sourceField}-${i}`}>
          {onNavigate ? (
            <button
              type="button"
              title={reference.sourceField}
              className={cn(
                chipClass,
                'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              onClick={() => onNavigate(reference)}
            >
              {reference.label}
            </button>
          ) : (
            <span title={reference.sourceField} className={chipClass}>
              {reference.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function EvidenceEmptyState({ emptyLabel, className }: { emptyLabel?: string; className?: string }) {
  return (
    <p data-testid="stella-evidence-panel-empty" className={cn('text-xs text-muted-foreground italic', className)}>
      {emptyLabel ?? 'Stella no citó ninguna fuente para esta afirmación.'}
    </p>
  )
}

function GroundedCitationItem({
  citation,
  onNavigate,
}: {
  citation: GroundedCitationView
  onNavigate?: (citation: GroundedCitationView) => void
}) {
  const unavailable = citation.availability === 'source_unavailable'
  const sourceName = citation.sourceLabel ?? 'Fuente no disponible'
  // The accessible name has to identify the passage, not just the file: a
  // claim commonly cites three places in the same document, and "informe.pdf"
  // three times is unusable with a screen reader.
  const heading = `${sourceName} — ${citation.location.label}`

  return (
    <article
      data-testid={`stella-grounded-citation-${citation.key}`}
      data-availability={citation.availability}
      data-relevance={citation.relevance?.bucket ?? 'unknown'}
      className={cn(
        'rounded-md border border-border bg-background p-2.5',
        unavailable && 'border-dashed'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        {onNavigate ? (
          <button
            type="button"
            className="text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            onClick={() => onNavigate(citation)}
          >
            {heading}
          </button>
        ) : (
          <p className="text-xs font-medium text-foreground">{heading}</p>
        )}
        {citation.relevance !== null && (
          <span
            data-testid={`stella-citation-relevance-${citation.key}`}
            // The bucket is a reading aid; the score is the datum. Both are
            // shown, and the score is never replaced by the bucket
            // (INTEGRATION-001 §6).
            title={`score ${citation.relevance.score} · estrategia ${citation.relevance.strategy} · umbrales ${citation.relevance.thresholdsVersion}`}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              RELEVANCE_CLASSES[citation.relevance.bucket]
            )}
          >
            {RELEVANCE_LABELS[citation.relevance.bucket]}
            <span className="font-mono font-normal normal-case tracking-normal">
              {citation.relevance.score.toFixed(2)}
            </span>
          </span>
        )}
      </div>

      {citation.excerpt !== null ? (
        <blockquote className="mt-1.5 whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 text-xs text-foreground">
          {citation.excerpt.text}
        </blockquote>
      ) : (
        <p
          data-testid={`stella-citation-unavailable-${citation.key}`}
          className="mt-1.5 text-xs text-muted-foreground italic"
        >
          El pasaje citado no está cargado. La cita sigue siendo verificable por su ubicación y su
          huella de contenido.
        </p>
      )}

      {citation.excerpt?.truncated && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Extracto recortado para su lectura ({citation.excerpt.fullLength} caracteres en el pasaje
          completo).
        </p>
      )}
    </article>
  )
}
